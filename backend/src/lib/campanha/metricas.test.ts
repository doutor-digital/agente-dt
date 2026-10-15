import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compararNomes,
  finalDoTelefone,
  grupoDaEtiqueta,
  lerConversa,
  mediana,
  pediuParaSair,
  resultadoNaAgenda,
  somarTransmissoes,
  type GrupoDeEtiqueta,
} from './metricas.js';
import { CAMPANHAS } from './campanhas.js';

const OR = CAMPANHAS.find((c) => c.id === 'outubro-rosa-2026')!;
const T = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

test('etiquetas viram grupos: as 3 ondas são a 1ª rodada, cada Dia é um grupo', () => {
  for (const n of [1, 2, 3]) assert.equal(grupoDaEtiqueta(`Outubro Rosa · Onda ${n}`, OR.grupos)?.chave, 'rodada-1');
  assert.equal(grupoDaEtiqueta('Outubro Rosa · Dia 1', OR.grupos)?.chave, 'dia-1');
  assert.equal(grupoDaEtiqueta('Outubro Rosa · Dia 12', OR.grupos)?.rotulo, 'Dia 12');
  assert.equal(grupoDaEtiqueta('Outubro Rosa · Revisar nome', OR.grupos), null);
  assert.equal(grupoDaEtiqueta('Outubro Rosa · Mulheres 15/10', OR.grupos), null);
});

test('SAIR do rodapé conta; "cancelar" e frases com "sair" no meio não', () => {
  for (const t of ['Sair', 'sair', 'SAIR.', ' "Sair" ', 'Pare', 'não quero mais receber essas mensagens', 'me tira dessa lista']) {
    assert.equal(pediuParaSair(t), true, t);
  }
  for (const t of ['Sai até do serviço', 'Quero sair da dor', 'cancelar', 'Pode cancelar minha consulta', 'Boa tarde', '']) {
    assert.equal(pediuParaSair(t), false, t);
  }
});

test('nomes: data no nome do Kommo não atrapalha; homônimo de "Maria … Silva" não casa', () => {
  assert.equal(compararNomes('Maria Teresa de Aguiar Sousa 14/03/26', 'MARIA TERESA DE AGUIAR SOUSA'), 'exato');
  assert.equal(compararNomes('Helena Zavarize', 'HELENA ZAVARIZE'), 'exato');
  assert.equal(compararNomes('Maria Do Carmo', 'MARIA DO CARMO DAS NEVES DA SILVA'), 'parcial');
  // os dois falsos positivos do cruzamento manual de 15/10
  assert.equal(compararNomes('MARIA DO CARMO DAS NEVES DA SILVA', 'MARIA ELNICE ALVES DA SILVA'), null);
  assert.equal(compararNomes('Maria Teresa de Aguiar Sousa', 'MARIA DA CONCEIÇÃO BRITO SOUSA'), null);
  assert.equal(compararNomes('Ana', 'ANA LÚCIA'), null);
  assert.equal(compararNomes('', 'ANA LÚCIA'), null);
});

test('telefone casa pelos 8 últimos dígitos, com ou sem o nono dígito', () => {
  assert.equal(finalDoTelefone('+55 99 98128-7970'), finalDoTelefone('559981287970'));
  assert.equal(finalDoTelefone('123'), null);
});

test('conversa da Gilvania (Marabá, 13/10): recepção respondeu em 2 minutos', () => {
  const ev = [
    { leadId: 1, tipo: 'saida' as const, em: T('2026-10-13T12:32:05-03:00'), por: 0 },
    { leadId: 1, tipo: 'entrada' as const, em: T('2026-10-13T12:32:30-03:00'), por: 0 },
    { leadId: 1, tipo: 'saida' as const, em: T('2026-10-13T12:34:30-03:00'), por: 15314223 },
  ];
  const c = lerConversa(T('2026-10-13T12:30:00-03:00'), ev, []);
  assert.equal(c.respondeuEm, T('2026-10-13T12:32:30-03:00'));
  assert.equal(c.equipeMin, 2);
  assert.equal(c.sofiaMin, null);
  assert.equal(c.saiu, false);
});

test('conversa da Maria do Socorro (Marabá, 14/10): "Sair" conta como descadastro', () => {
  const ev = [
    { leadId: 2, tipo: 'saida' as const, em: T('2026-10-13T16:32:00-03:00'), por: 0 },
    { leadId: 2, tipo: 'entrada' as const, em: T('2026-10-14T08:44:00-03:00'), por: 0 },
    { leadId: 2, tipo: 'saida' as const, em: T('2026-10-14T08:44:40-03:00'), por: 0 },
  ];
  const msgs = [
    { leadId: 2, papel: 'user' as const, texto: 'Sair', em: T('2026-10-14T08:44:00-03:00') },
    { leadId: 2, papel: 'assistant' as const, texto: 'Tudo bem, vou deixar de te enviar mensagens por aqui', em: T('2026-10-14T08:44:40-03:00') },
  ];
  const c = lerConversa(T('2026-10-13T16:30:00-03:00'), ev, msgs);
  assert.equal(c.saiu, true);
  assert.equal(c.sofiaMin, 1);
  assert.equal(c.equipeMin, null);
});

test('sem mensagem de saída depois do início, o cartão não recebeu: nada conta', () => {
  const ev = [{ leadId: 3, tipo: 'entrada' as const, em: T('2026-10-13T10:00:00-03:00'), por: 0 }];
  const c = lerConversa(T('2026-10-13T12:00:00-03:00'), ev, []);
  assert.deepEqual([c.enviadaEm, c.respondeuEm], [null, null]);
});

test('agenda: remarcação de quem já tinha consulta não conta (Helena, Açailândia)', () => {
  const rodada1 = grupoDaEtiqueta('Outubro Rosa · Onda 3', OR.grupos)!;
  const helena = [
    { idSchedule: 3750517, nome: 'HELENA ZAVARIZE', status: 'DESMARCADO', dia: '2026-10-15' },
    { idSchedule: 3767965, nome: 'HELENA ZAVARIZE', status: 'CONFIRMADO', dia: '2026-10-16' },
  ];
  assert.deepEqual(resultadoNaAgenda(helena, rodada1, '2026-10-13'), { agendou: false, compareceu: false, jaTinha: true });
  const nova = [{ idSchedule: 3770420, nome: 'X', status: 'AGENDADO', dia: '2026-10-21' }];
  assert.deepEqual(resultadoNaAgenda(nova, rodada1, '2026-10-13'), { agendou: true, compareceu: false, jaTinha: false });
});

test('agenda nos dias novos: sem corte; desmarcada não conta, atendida conta como compareceu', () => {
  const dia1: GrupoDeEtiqueta = grupoDaEtiqueta('Outubro Rosa · Dia 1', OR.grupos)!;
  assert.equal(resultadoNaAgenda([{ idSchedule: 1, nome: 'X', status: 'DESMARCADO', dia: '2026-10-20' }], dia1, '2026-10-16').agendou, false);
  assert.deepEqual(resultadoNaAgenda([{ idSchedule: 2, nome: 'X', status: 'ATENDIDO', dia: '2026-10-20' }], dia1, '2026-10-16'), { agendou: true, compareceu: true, jaTinha: false });
  // avaliação antes do envio é história, não resultado
  assert.equal(resultadoNaAgenda([{ idSchedule: 3, nome: 'X', status: 'AGENDADO', dia: '2026-10-10' }], dia1, '2026-10-16').agendou, false);
});

test('transmissões: soma só as do segmento do grupo; sem leitura do Kommo fica em branco, não zero', () => {
  const trans = [
    { tagIds: [200408], enviadas: 5, entregues: 4, lidas: 1, respondidas: 1, falhas: 0, custoUsd: 0.3125 },
    { tagIds: [999], enviadas: 50, entregues: 50, lidas: 50, respondidas: 9, falhas: 0, custoUsd: 3 },
  ];
  const s = somarTransmissoes(trans, [200408]);
  assert.deepEqual([s.enviadas, s.entregues, s.lidas, s.respondidasKommo, s.custoUsd], [5, 4, 1, 1, 0.3125]);
  assert.equal(somarTransmissoes(null, [200408]).enviadas, null);
});

test('mediana', () => {
  assert.equal(mediana([]), null);
  assert.equal(mediana([0, 2, 843]), 2);
  assert.equal(mediana([1, 3]), 2);
});

test('rajada: a transmissão das 9h em Canaã conta; mensagem avulsa da Sofia e da recepção não', async () => {
  const { envioPorRajada } = await import('./metricas.js');
  const nove = T('2026-10-13T09:00:10-03:00');
  const ev = [
    ...[1, 2, 3, 4, 5].map((id, i) => ({ leadId: id, tipo: 'saida' as const, em: nove + i * 3, por: 0 })),
    { leadId: 6, tipo: 'saida' as const, em: T('2026-10-13T15:10:00-03:00'), por: 0 }, // Sofia, sozinha na hora
    { leadId: 7, tipo: 'saida' as const, em: nove + 20, por: 15314223 }, // recepção na mesma hora
    { leadId: 1, tipo: 'saida' as const, em: T('2026-10-13T14:30:00-03:00'), por: 0 }, // conversa depois
  ];
  const m = envioPorRajada(ev, T('2026-10-13T00:00:00-03:00'), 8);
  // Dia 1 de Balsas antes do envio (15/10): 2 cartões com mensagem da régua na mesma hora não são transmissão
  const regua = [10, 11].map((id) => ({ leadId: id, tipo: 'saida' as const, em: T('2026-10-15T10:00:00-03:00') + id, por: 0 }));
  assert.equal(envioPorRajada(regua, T('2026-10-13T00:00:00-03:00'), 20).size, 0);
  assert.deepEqual([...m.keys()].sort(), [1, 2, 3, 4, 5]);
  assert.equal(m.get(1), nove);
});
