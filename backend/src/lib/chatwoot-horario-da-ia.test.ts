/**
 * A Sofia do CRM respeita o horário da clínica (expediente, janela, feriado) como a do Kommo, e Parauapebas (sem `business_hours_enabled`)
 * segue 24 h, byte a byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { ConversaLida } from './chatwoot-porta.js';
import type { ResultadoDaSofia } from './chatwoot-sofia.js';
import { foraDoHorarioDaIa } from './chatwoot-horario-da-ia.js';
import { novaMemoriaDaIa, rodarSofia, type PortasDaIa } from './chatwoot-ia.js';

const EXPEDIENTE = { mon: { start: '06:30', end: '18:00' }, tue: { start: '06:30', end: '18:00' }, wed: { start: '06:30', end: '18:00' }, thu: { start: '06:30', end: '18:00' }, fri: { start: '06:30', end: '18:00' } };
const emSP = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-03:00`);
const unidade = (o: Partial<Unit> = {}): Unit =>
  ({
    slug: 'doutor-hernia-parauapebas',
    businessHoursEnabled: false,
    businessHoursTimezone: 'America/Sao_Paulo',
    businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    businessHoursStart: 9,
    businessHoursEnd: 18,
    businessHoursByDay: null,
    businessHoursExpediente: null,
    iaTodosAte: null,
    ...o,
  }) as unknown as Unit;
const comExpediente = (o: Partial<Unit> = {}) => unidade({ businessHoursEnabled: true, businessHoursStart: 18, businessHoursEnd: 6, businessHoursDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], businessHoursExpediente: EXPEDIENTE, ...o });

// 2026-11-25 quarta · 20 sexta (Consciência Negra, feriado nacional) · 28 sábado · 29 domingo
test('modo «só fora do expediente»: calada no expediente, atende à noite, de madrugada, no fim de semana e no feriado', () => {
  const u = comExpediente();
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-25', '10:00')), true, 'quarta 10h: a equipe atende');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-25', '06:29')), false, 'quarta 6h29: ainda fechada');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-25', '06:30')), true, 'quarta 6h30: a equipe abre');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-25', '18:00')), false, 'quarta 18h: assume');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-28', '10:00')), false, 'sábado 10h');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-29', '07:34')), false, 'domingo 7h34');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-20', '10:00')), false, 'feriado nacional em dia útil: atende');
});

test('janela comum 9h–18h: atende dentro, cala fora e no feriado; «Sofia atende todos» vence', () => {
  const u = unidade({ businessHoursEnabled: true });
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-25', '10:00')), false);
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-25', '20:00')), true);
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-28', '10:00')), true, 'sábado fora dos dias');
  assert.equal(foraDoHorarioDaIa(u, emSP('2026-11-20', '10:00')), true, 'feriado fecha a janela comum');
  assert.equal(foraDoHorarioDaIa(unidade({ businessHoursEnabled: true, iaTodosAte: new Date('2026-11-26T00:00:00Z') }), emSP('2026-11-25', '20:00')), false);
});

test('SEM configuração (business_hours_enabled = false): nunca calada, a qualquer hora, dia ou feriado (Parauapebas idêntica)', () => {
  const u = unidade();
  for (const [dia, h] of [['2026-11-25', '03:00'], ['2026-11-25', '10:00'], ['2026-11-28', '23:30'], ['2026-11-29', '12:00'], ['2026-11-20', '10:00'], ['2026-12-25', '10:00']] as const) {
    assert.equal(foraDoHorarioDaIa(u, emSP(dia, h)), false, `${dia} ${h}`);
  }
  // mesmo com expediente gravado, se a chave geral está desligada nada muda (é o que o Kommo faz)
  assert.equal(foraDoHorarioDaIa(unidade({ businessHoursExpediente: EXPEDIENTE }), emSP('2026-11-25', '10:00')), false);
});

// ── a rodada ───────────────────────────────────────────────────────────────────────────────────────

const lida: ConversaLida = { id: 12, nome: 'Maria da Silva', telefone: '+5594999990000', attrs: {}, etiquetas: [], grupo: false, interno: false };
const resposta: ResultadoDaSofia = { resposta: 'Oi! Posso ajudar?', acoes: [], pix: null, cartao: null, passouParaEquipe: false };
const M = { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };

function portas(u: Unit, agora: Date, estado: 'seco' | 'ligado' = 'ligado') {
  const publicas: string[] = [];
  const encerradas: number[] = [];
  const abertas: number[] = [];
  const registros: Array<{ nome?: string | null; detalhe?: string | null }> = [];
  let sofias = 0;
  const p: PortasDaIa = {
    estado: () => estado,
    unidade: async () => u,
    mensagens: async () => [{ message_type: 0, content: 'oi', private: false }],
    nota: async () => {},
    publica: async (_c, t) => {
      publicas.push(t);
      return { usuario: 3 };
    },
    registrarEvento: async (e) => void registros.push({ nome: e.nome, detalhe: e.detalhe }),
    agendaReal: async () => [],
    passarParaEquipe: async () => {},
    transcrever: async () => '',
    conversa: async () => lida,
    cartaoNoKommo: async () => null,
    sofia: async () => {
      sofias++;
      return resposta;
    },
    agendar: (fn) => fn,
    cancelar: () => {},
    hoje: () => '2026-11-25',
    agora: () => agora,
    abrirParaEquipe: async (c) => void abertas.push(c),
    encerrarAtendimento: async (c) => void encerradas.push(c),
  };
  return { p, publicas, encerradas, abertas, registros, sofias: () => sofias };
}

test('rodada: dentro do expediente a Sofia NÃO responde (nem roda), a conversa vai para a equipe e o Registro diz por quê', async () => {
  const a = portas(comExpediente(), emSP('2026-11-25', '10:00'));
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'fora-do-horario');
  assert.equal(a.sofias(), 0);
  assert.deepEqual(a.publicas, []);
  assert.deepEqual(a.abertas, [12]);
  assert.deepEqual(a.encerradas, [12]);
  assert.deepEqual(a.registros, [{ nome: 'fora-do-horario', detalhe: 'fora do horário da IA' }]);
});

test('rodada: noite, fim de semana e feriado a Sofia responde', async () => {
  for (const [dia, h] of [['2026-11-25', '19:00'], ['2026-11-28', '15:39'], ['2026-11-29', '07:34'], ['2026-11-20', '10:00']] as const) {
    const a = portas(comExpediente(), emSP(dia, h));
    assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'enviada', `${dia} ${h}`);
    assert.deepEqual(a.publicas, ['Oi! Posso ajudar?']);
  }
});

test('rodada: unidade SEM configuração responde a qualquer hora (Parauapebas, quarta 03h, quarta 10h, domingo, feriado)', async () => {
  for (const [dia, h] of [['2026-11-25', '03:00'], ['2026-11-25', '10:00'], ['2026-11-29', '12:00'], ['2026-11-20', '10:00']] as const) {
    const a = portas(unidade(), emSP(dia, h));
    assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'enviada', `${dia} ${h}`);
    assert.equal(a.sofias(), 1);
  }
});

test('o horário acaba enquanto a Sofia pensa: a resposta NÃO sai por cima da equipe (e, se ela já gravou, a nota avisa)', async () => {
  const u = comExpediente();
  // 1ª leitura do relógio (início da rodada) = 06:29, as seguintes (na hora de mandar) = 06:30: a equipe abriu
  const relogio = [emSP('2026-11-25', '06:29'), emSP('2026-11-25', '06:30'), emSP('2026-11-25', '06:30')];
  const a = portas(u, relogio[0]!);
  let leituras = 0;
  a.p.agora = () => relogio[Math.min(leituras++, relogio.length - 1)]!;
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'fora-do-horario');
  assert.deepEqual(a.publicas, []);
});

test('Registro: uma linha por conversa por hora, não uma por mensagem do expediente', async () => {
  const u = comExpediente();
  const a = portas(u, emSP('2026-11-25', '10:00'));
  const mem = novaMemoriaDaIa();
  for (let i = 0; i < 5; i++) await rodarSofia(M, a.p, mem);
  assert.equal(a.registros.length, 1);
});
