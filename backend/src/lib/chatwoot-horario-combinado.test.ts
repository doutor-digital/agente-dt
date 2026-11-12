/**
 * «A equipe já combinou o horário na conversa»: o que conta como combinado, quando diverge da agenda da franquia e o contato interno.
 * Caso real (conversa 19): a equipe disse «às 08:00», o paciente respondeu 👍, a franquia diz 14/11 09:30.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combinadoPelaEquipe,
  consultaDosAtributos,
  consultasReaisDoPaciente,
  diaEHoraNoFuso,
  divergenciaDoCombinado,
  horariosDaFala,
  idsDaIntegracao,
  type PortasDaFranquia,
} from './chatwoot-horario-combinado.js';
import { conversaLidaDoChatwoot } from './chatwoot-porta.js';
import { motivoDeNaoResponder } from './chatwoot-sofia.js';

const equipe = (content: string, o: Record<string, unknown> = {}) => ({ message_type: 1, private: false, content, sender: { id: 9, type: 'user' }, ...o });

test('horas e dias que uma fala menciona, normalizados', () => {
  assert.deepEqual(horariosDaFala('Sua consulta é às 08:00'), { horas: ['08:00'], dias: [] });
  assert.deepEqual(horariosDaFala('te espero dia 14/11 às 9h30'), { horas: ['09:30'], dias: ['11-14'] });
  assert.deepEqual(horariosDaFala('às 8'), { horas: ['08:00'], dias: [] });
  assert.deepEqual(horariosDaFala('às 14h'), { horas: ['14:00'], dias: [] });
  assert.deepEqual(horariosDaFala('às 8 e às 10:30'), { horas: ['08:00', '10:30'], dias: [] });
  // data sozinha não vira hora; número solto também não
  assert.deepEqual(horariosDaFala('é dia 14/11, são 350 reais'), { horas: [], dias: ['11-14'] });
  assert.deepEqual(horariosDaFala('tudo bem?'), { horas: [], dias: [] });
});

test('o combinado é a ÚLTIMA fala de gente da equipe que fala de horário', () => {
  const m = [equipe('Boa tarde! Consulta às 08:00'), { message_type: 0, content: 'ok' }, equipe('Corrigindo: às 10:30, tá?'), equipe('Qualquer dúvida é só chamar')];
  const c = combinadoPelaEquipe(m);
  assert.deepEqual(c?.horas, ['10:30']);
  assert.match(c!.trecho, /Corrigindo/);
  // horário solto numa frase que não é de agendamento não vale
  assert.equal(combinadoPelaEquipe([equipe('Funcionamos 7h30 até 17h30, de segunda a sexta')]), null);
  // nota privada, fala do paciente e bot não são combinado da equipe
  assert.equal(combinadoPelaEquipe([equipe('às 08:00', { private: true }), { message_type: 0, content: 'às 09:00' }, equipe('às 07:00', { sender: { id: 1, type: 'agent_bot' } })]), null);
});

test('as falas da integração (Sofia, régua) não são combinado da equipe — o usuário dela se acha pelas nossas notas privadas', () => {
  const m = [
    equipe('Tenho 09:00 ou 10:00', { sender: { id: 3, type: 'user' } }),
    { message_type: 1, private: true, content: '🧪 [SECO] Sofia responderia:\n\nTenho 09:00', sender: { id: 3, type: 'user' } },
    { message_type: 1, private: true, content: 'ligar para ele amanhã às 9', sender: { id: 9, type: 'user' } },
  ];
  assert.deepEqual([...idsDaIntegracao(m)], [3]);
  assert.equal(combinadoPelaEquipe(m), null);
});

test('divergência: bate só se a hora E o dia (quando a equipe falou dele) existem numa consulta real', () => {
  const real = [{ dia: '2026-11-14', hora: '09:30' }];
  assert.equal(divergenciaDoCombinado({ horas: ['09:30'], dias: [], trecho: '' }, real), null);
  assert.equal(divergenciaDoCombinado({ horas: ['09:30'], dias: ['11-14'], trecho: '' }, real), null);
  assert.match(divergenciaDoCombinado({ horas: ['08:00'], dias: [], trecho: '' }, real)!, /combinou «08:00» na conversa, mas a agenda da franquia diz 14\/11 09:30/);
  assert.match(divergenciaDoCombinado({ horas: ['09:30'], dias: ['11-15'], trecho: '' }, real)!, /«09:30, 15\/11».*14\/11 09:30/);
  assert.match(divergenciaDoCombinado({ horas: [], dias: ['11-15'], trecho: '' }, real)!, /15\/11/);
  assert.match(divergenciaDoCombinado({ horas: ['08:00'], dias: [], trecho: '' }, [])!, /não há consulta de pé/);
  assert.match(divergenciaDoCombinado({ horas: ['08:00'], dias: [], trecho: '' }, null)!, /não consegui conferir/);
  // mais de uma consulta de pé: basta uma bater
  assert.equal(divergenciaDoCombinado({ horas: ['08:00'], dias: [], trecho: '' }, [...real, { dia: '2026-11-20', hora: '08:00' }]), null);
});

test('a consulta de verdade: dia e hora no relógio da clínica (a franquia manda UTC), só de pé, só com o telefone do paciente', async () => {
  // 14/11 09:30 em Belém (UTC-3) = 12:30Z
  assert.deepEqual(diaEHoraNoFuso('2026-11-14T12:30:00Z', 'America/Belem'), { dia: '2026-11-14', hora: '09:30' });
  assert.deepEqual(diaEHoraNoFuso('2026-11-14T01:30:00Z', 'America/Belem'), { dia: '2026-11-13', hora: '22:30' });
  assert.equal(diaEHoraNoFuso('lixo', 'America/Belem'), null);
  const chamadas: string[] = [];
  const franquia = (o: { clientes?: Array<{ idClient: number; name: string; whatsapp: string }> | null; agendamentos?: Record<number, Array<{ idStatus: number | null; dateAttendanceUtc: string | null }> | null> }): PortasDaFranquia => ({
    buscarPorNome: async (nome) => {
      chamadas.push(`busca ${nome}`);
      return o.clientes === undefined ? [] : o.clientes;
    },
    agendamentos: async (id) => {
      chamadas.push(`ag ${id}`);
      return o.agendamentos && id in o.agendamentos ? o.agendamentos[id]! : [];
    },
  });
  const agora = new Date('2026-11-12T12:00:00Z');
  const a = { nome: 'Maria da Silva', telefone: '+55 94 99999-0000', fuso: 'America/Belem', agora };
  const ok = await consultasReaisDoPaciente(
    franquia({
      clientes: [
        { idClient: 1, name: 'Maria da Silva', whatsapp: '94999990000' },
        { idClient: 2, name: 'Maria da Silva', whatsapp: '94988887777' }, // homônima de outro telefone: não é ela
      ],
      agendamentos: {
        1: [
          { idStatus: 1, dateAttendanceUtc: '2026-11-14T12:30:00Z' },
          { idStatus: 57, dateAttendanceUtc: '2026-11-15T12:30:00Z' }, // desmarcada
          { idStatus: 1, dateAttendanceUtc: '2026-11-01T12:30:00Z' }, // já passou
        ],
        2: [{ idStatus: 1, dateAttendanceUtc: '2026-11-16T12:30:00Z' }],
      },
    }),
    a,
  );
  assert.deepEqual(ok, [{ dia: '2026-11-14', hora: '09:30' }]);
  assert.ok(!chamadas.includes('ag 2'), 'não lê a agenda de quem tem outro telefone');
  // a franquia não respondeu = não deu para conferir; nenhum cadastro com o telefone = sem consulta
  assert.equal(await consultasReaisDoPaciente(franquia({ clientes: null }), a), null);
  assert.deepEqual(await consultasReaisDoPaciente(franquia({ clientes: [{ idClient: 2, name: 'Maria', whatsapp: '94988887777' }] }), a), []);
  assert.equal(await consultasReaisDoPaciente(franquia({ clientes: [{ idClient: 1, name: 'Maria', whatsapp: '94999990000' }], agendamentos: { 1: null } }), a), null);
});

test('o que o Chatwoot guardou da consulta só vale se for de pé e no futuro', () => {
  assert.deepEqual(consultaDosAtributos({ data_consulta: '2026-11-14', hora_consulta: '09:30', situacao_consulta: 'Agendado' }, '2026-11-12'), { dia: '2026-11-14', hora: '09:30' });
  assert.deepEqual(consultaDosAtributos({ data_consulta: '2026-11-14T00:00:00Z', hora_consulta: '9h30' }, '2026-11-12'), { dia: '2026-11-14', hora: '09:30' });
  assert.equal(consultaDosAtributos({ data_consulta: '2026-11-10', hora_consulta: '09:30' }, '2026-11-12'), null);
  assert.equal(consultaDosAtributos({ data_consulta: '2026-11-14', hora_consulta: '09:30', situacao_consulta: 'Desmarcado' }, '2026-11-12'), null);
  assert.equal(consultaDosAtributos({}, '2026-11-12'), null);
});

test('contato INTERNO: etiqueta «interno» na conversa ou atributo «interno» no contato; a Sofia fica calada', () => {
  const cru = (o: Record<string, unknown> = {}) => ({ id: 28, labels: [], custom_attributes: {}, meta: { sender: { name: 'Equipe', phone_number: '+5594999990001', custom_attributes: {} } }, ...o });
  assert.equal(conversaLidaDoChatwoot(cru())!.interno, false);
  assert.equal(conversaLidaDoChatwoot(cru({ labels: ['Interno'] }))!.interno, true);
  for (const v of [true, 'true', 'Sim', 1]) {
    const c = cru({ meta: { sender: { phone_number: '+55', custom_attributes: { interno: v } } } });
    assert.equal(conversaLidaDoChatwoot(c)!.interno, true, String(v));
  }
  assert.equal(conversaLidaDoChatwoot(cru({ meta: { sender: { phone_number: '+55', custom_attributes: { interno: false } } } }))!.interno, false);
  assert.equal(motivoDeNaoResponder(conversaLidaDoChatwoot(cru({ labels: ['interno'] }))!), 'interno');
});
