import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assinaturaDoQuadro,
  devePendenciar,
  diasParado,
  faltam,
  ordenarAltas,
  ordenarParados,
  resumoDoCandidato,
  type CandidatoBruto,
} from './fila-de-alta.js';

const AGORA = new Date('2026-09-16T12:00:00-03:00');
const c = (p: Partial<CandidatoBruto> & { leadId: number }): CandidatoBruto => ({
  nome: 'Paciente',
  classe: 'PAROU',
  realizadas: 10,
  previstas: 24,
  ultimaSessao: '2026-08-01T13:00:00.000Z',
  ...p,
});

test('nunca visto entra na fila', () => {
  assert.equal(devePendenciar(c({ leadId: 1 }), null), true);
});

test('já pendente continua pendente', () => {
  assert.equal(devePendenciar(c({ leadId: 1 }), { estado: 'pendente', assinatura: 'x' }), true);
});

test('recusado NÃO volta enquanto o quadro for o mesmo', () => {
  // sem isto, o mesmo nome reaparece a cada varredura e a lista vira ruído
  const cand = c({ leadId: 1 });
  const atual = { estado: 'recusado' as const, assinatura: assinaturaDoQuadro(cand) };
  assert.equal(devePendenciar(cand, atual), false);
});

test('recusado VOLTA quando o paciente faz nova sessão', () => {
  const antes = c({ leadId: 1, realizadas: 10 });
  const atual = { estado: 'recusado' as const, assinatura: assinaturaDoQuadro(antes) };
  const depois = c({ leadId: 1, realizadas: 11, ultimaSessao: '2026-09-15T13:00:00.000Z' });
  assert.equal(devePendenciar(depois, atual), true);
});

test('aprovado também volta se o quadro mudar', () => {
  const antes = c({ leadId: 1, classe: 'ALTA', realizadas: 24, previstas: 24 });
  const atual = { estado: 'aprovado' as const, assinatura: assinaturaDoQuadro(antes) };
  const depois = c({ leadId: 1, classe: 'ALTA', realizadas: 25, previstas: 24 });
  assert.equal(devePendenciar(depois, atual), true);
});

test('a assinatura ignora a hora — só a data da sessão importa', () => {
  const manha = c({ leadId: 1, ultimaSessao: '2026-08-01T11:00:00.000Z' });
  const tarde = c({ leadId: 1, ultimaSessao: '2026-08-01T20:00:00.000Z' });
  assert.equal(assinaturaDoQuadro(manha), assinaturaDoQuadro(tarde));
});

test('faltam nunca é negativo', () => {
  assert.equal(faltam({ realizadas: 30, previstas: 24 }), 0);
  assert.equal(faltam({ realizadas: 21, previstas: 24 }), 3);
});

test('parados: quem está mais perto de concluir aparece primeiro', () => {
  // a Balbina fez 47 de 48 e sumiu — tem que ser a primeira da lista, não a última
  const lista = [
    c({ leadId: 1, nome: 'longe', realizadas: 5, previstas: 24 }),
    c({ leadId: 2, nome: 'balbina', realizadas: 47, previstas: 48 }),
    c({ leadId: 3, nome: 'meio', realizadas: 20, previstas: 24 }),
  ];
  assert.deepEqual(ordenarParados(lista, AGORA).map((x) => x.nome), ['balbina', 'meio', 'longe']);
});

test('empate em quantas faltam: quem parou há menos tempo vem antes', () => {
  const lista = [
    c({ leadId: 1, nome: 'antigo', realizadas: 23, previstas: 24, ultimaSessao: '2026-01-10T13:00:00.000Z' }),
    c({ leadId: 2, nome: 'recente', realizadas: 23, previstas: 24, ultimaSessao: '2026-09-01T13:00:00.000Z' }),
  ];
  assert.deepEqual(ordenarParados(lista, AGORA).map((x) => x.nome), ['recente', 'antigo']);
});

test('altas: quem terminou há mais tempo aparece primeiro', () => {
  const lista = [
    c({ leadId: 1, nome: 'ontem', classe: 'ALTA', ultimaSessao: '2026-09-15T13:00:00.000Z' }),
    c({ leadId: 2, nome: 'antigo', classe: 'ALTA', ultimaSessao: '2025-10-18T13:00:00.000Z' }),
  ];
  assert.deepEqual(ordenarAltas(lista).map((x) => x.nome), ['antigo', 'ontem']);
});

test('dias parado conta em dias corridos', () => {
  assert.equal(diasParado('2026-09-06T12:00:00-03:00', AGORA), 10);
  assert.equal(diasParado(null, AGORA), null);
});

test('o resumo do parado diz quanto falta — é o que decide a ligação', () => {
  const t = resumoDoCandidato(c({ leadId: 1, realizadas: 47, previstas: 48, ultimaSessao: '2026-06-29T13:00:00.000Z' }), AGORA);
  assert.match(t, /47\/48/);
  assert.match(t, /falta 1/);
  assert.match(t, /parado há \d+ dias/);
});

test('singular e plural não saem errados', () => {
  const um = resumoDoCandidato(c({ leadId: 1, realizadas: 23, previstas: 24, ultimaSessao: '2026-09-15T13:00:00.000Z' }), AGORA);
  assert.match(um, /falta 1 /);
  assert.match(um, /parado há 1 dia\b/);
  const varios = resumoDoCandidato(c({ leadId: 2, realizadas: 20, previstas: 24 }), AGORA);
  assert.match(varios, /faltam 4/);
});

test('sem data de última sessão o resumo não inventa prazo', () => {
  const t = resumoDoCandidato(c({ leadId: 1, ultimaSessao: null }), AGORA);
  assert.doesNotMatch(t, /parado h[áa]/);
});
