import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTADO_VAZIO,
  OK_PARA_RESOLVER,
  avancar,
  avisoDeTeste,
  decidirSaude,
  observar,
  umaLinha,
  type Estado,
  type LinhaDoProvedor,
  type Observacao,
} from './watchdog-decisao.js';

const linha = (o: Partial<LinhaDoProvedor>): LinhaDoProvedor => ({
  escopo: 'rede',
  total: 0,
  erros: 0,
  unidadesComErro: 0,
  maiorUnidade: 0,
  errosCredito: 0,
  errosChave: 0,
  errosLimite: 0,
  errosIndisponivel: 0,
  minutosSemSucesso: null,
  ...o,
});

// ── decidirSaude ────────────────────────────────────────────────────────────────────────────────────────────────────

test('a noite de 26/11: 1.000 erros de crédito em 1.000 chamadas é FORA, com a causa', () => {
  const s = decidirSaude([
    linha({ total: 1000, erros: 1000, unidadesComErro: 39, errosCredito: 1000 }),
    linha({ escopo: 'anthropic', total: 1000, erros: 1000, unidadesComErro: 39, errosCredito: 1000 }),
  ]);
  assert.equal(s.estado, 'fora');
  assert.equal(s.causa, 'credito');
  assert.match(s.motivo, /100% das chamadas à IA falhando \(1000 de 1000\)/);
});

test('uma unidade só NÃO é FORA, nem com crédito ou chave (cada unidade pode ter a própria chave)', () => {
  assert.equal(decidirSaude([linha({ total: 6, erros: 6, unidadesComErro: 1, errosCredito: 6 })]).estado, 'ok');
  assert.equal(decidirSaude([linha({ total: 30, erros: 30, unidadesComErro: 1, errosChave: 30 })]).estado, 'ok');
});

test('a causa «outra» conta: 19 erros sem causa + 1 de crédito é FORA por causa «outra», não por crédito', () => {
  const s = decidirSaude([linha({ total: 20, erros: 20, unidadesComErro: 4, errosCredito: 1 })]);
  assert.equal(s.estado, 'fora');
  assert.equal(s.causa, 'outra');
});

test('uma unidade em laço (100 erros) + outra com 1 erro NÃO é FORA, mas erros espalhados são', () => {
  assert.equal(decidirSaude([linha({ total: 111, erros: 101, unidadesComErro: 2, maiorUnidade: 100, errosIndisponivel: 101 })]).estado, 'ok');
  assert.equal(decidirSaude([linha({ total: 111, erros: 101, unidadesComErro: 5, maiorUnidade: 60, errosIndisponivel: 101 })]).estado, 'fora');
  // madrugada, 2 unidades falando (8 + 2 erros), crédito: sem volume para ser «laço», é FORA
  assert.equal(decidirSaude([linha({ total: 10, erros: 10, unidadesComErro: 2, maiorUnidade: 8, errosCredito: 10 })]).estado, 'fora');
});

test('404 em texto puro do Traefik (rota sumiu) é servidor INACESSÍVEL; 404 com o JSON do app é vigia CEGO', () => {
  assert.equal(observar({ status: 404, corpo: null }).tipo, 'inacessivel');
  assert.equal(observar({ status: 404, corpo: 'page not found' }).tipo, 'inacessivel');
  assert.equal(observar({ status: 404, corpo: { error: 'not_found' } }).tipo, 'cego');
  assert.equal(observar({ status: 404, corpo: { error: 'url_invalida' } }).tipo, 'cego');
  assert.equal(observar({ status: 401, corpo: { error: 'unauthorized' } }).tipo, 'cego');
});

test('incidente que NENHUM canal anunciou termina em silêncio (sem «voltou» do nada)', () => {
  // estado como o script o deixa quando a entrega falha: incidente aberto, mas sem aviso registrado
  const aberto = { ...ESTADO_VAZIO, desde: T0, ultimoAviso: {}, ultimaObservacao: FORA, abertura: FORA, okSeguidos: 1 };
  const r = avancar(aberto, OK, T0 + 20 * MIN);
  assert.equal(r.avisos.length, 0);
  assert.equal(r.estado.desde, null);
});

test('o lembrete de 30 min não atrasa 10 min por jitter do cron (rodada a 29m50s do último aviso já é devida)', () => {
  const e1 = avancar(null, FORA, T0);
  const r = avancar(e1.estado, FORA, T0 + 29 * MIN + 50_000);
  assert.deepEqual(r.avisos.map((a) => a.tipo), ['lembrete']);
  assert.equal(avancar(e1.estado, FORA, T0 + 27 * MIN).avisos.length, 0);
});

test('degradado na rede também exige erro em 2 unidades ou mais', () => {
  assert.equal(decidirSaude([linha({ total: 100, erros: 30, unidadesComErro: 1, errosIndisponivel: 30 })]).estado, 'ok');
  assert.equal(decidirSaude([linha({ total: 100, erros: 30, unidadesComErro: 2, errosIndisponivel: 30 })]).estado, 'degradado');
});

test('um provedor caído, com a rede só diluída, é DEGRADADO (com provedor e causa), nunca «Sofia fora do ar»', () => {
  const s = decidirSaude([
    linha({ total: 200, erros: 42, unidadesComErro: 12, errosChave: 40 }),
    linha({ escopo: 'anthropic', total: 40, erros: 40, unidadesComErro: 12, errosChave: 40 }),
    linha({ escopo: 'openai', total: 160, erros: 2, unidadesComErro: 2 }),
  ]);
  assert.equal(s.estado, 'degradado');
  assert.equal(s.escopo, 'anthropic');
  assert.equal(s.causa, 'autenticacao');
  assert.match(s.motivo, /provedor anthropic/);
});

test('chave de reserva atendendo: provedor a 100% de erro mas a rede ~50% NÃO é FORA', () => {
  const s = decidirSaude([
    linha({ total: 40, erros: 20, unidadesComErro: 2, errosChave: 20 }),
    linha({ escopo: 'anthropic', total: 20, erros: 20, unidadesComErro: 2, errosChave: 20 }),
    linha({ escopo: 'anthropic-reserva', total: 20, erros: 0 }),
  ]);
  assert.notEqual(s.estado, 'fora');
});

test('uma unidade só com a chave quebrada num provedor NÃO é FORA (5 de 5, 401, 1 unidade)', () => {
  const s = decidirSaude([
    linha({ total: 20, erros: 5, unidadesComErro: 1, errosChave: 5 }),
    linha({ escopo: 'anthropic', total: 5, erros: 5, unidadesComErro: 1, errosChave: 5 }),
  ]);
  assert.notEqual(s.estado, 'fora');
});

test('NÃO é queda: silêncio, amostra minúscula, 89%, ou uma conversa quebrada sozinha', () => {
  assert.equal(decidirSaude([]).estado, 'ok');
  assert.equal(decidirSaude([linha({})]).estado, 'ok', 'sem chamada nenhuma (madrugada) não é queda');
  assert.equal(decidirSaude([linha({ total: 4, erros: 4, unidadesComErro: 4, errosCredito: 4 })]).estado, 'ok', 'amostra < 5');
  assert.notEqual(decidirSaude([linha({ total: 100, erros: 89, unidadesComErro: 20, errosCredito: 89 })]).estado, 'fora', '89% < 90%');
  assert.equal(decidirSaude([linha({ total: 8, erros: 8, unidadesComErro: 1 })]).estado, 'ok', 'uma unidade só, erro sem causa de conta');
});

test('DEGRADADO: um quarto da rede falhando com amostra decente, ou metade de um provedor', () => {
  const a = decidirSaude([linha({ total: 100, erros: 30, unidadesComErro: 10, errosIndisponivel: 30 })]);
  assert.equal(a.estado, 'degradado');
  assert.equal(a.causa, 'indisponivel');
  const b = decidirSaude([linha({ total: 200, erros: 10 }), linha({ escopo: 'anthropic', total: 10, erros: 6, unidadesComErro: 2 })]);
  assert.equal(b.estado, 'degradado');
  // mas metade de um provedor só em UMA unidade (chave dela revogada, lote do juiz falhando) não é a IA degradada
  assert.equal(decidirSaude([linha({ total: 200, erros: 10 }), linha({ escopo: 'openai', total: 10, erros: 6, unidadesComErro: 1 })]).estado, 'ok');
  assert.equal(decidirSaude([linha({ total: 100, erros: 10, unidadesComErro: 5 })]).estado, 'ok', '10% é ruído');
});

// ── observar ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('observar: servidor mudo ou 5xx sem corpo é INACESSÍVEL; 401/403/404 é vigia CEGO (e também avisa)', () => {
  assert.equal(observar({ status: null, corpo: null }).tipo, 'inacessivel');
  assert.equal(observar({ status: 502, corpo: '<html>bad gateway</html>' }).tipo, 'inacessivel');
  assert.equal(observar({ status: 404, corpo: { error: 'not_found' } }).tipo, 'cego');
  assert.equal(observar({ status: 401, corpo: { error: 'unauthorized' } }).tipo, 'cego');
  assert.equal(observar({ status: 200, corpo: 'lixo' }).tipo, 'cego');
});

test('observar: lê o estado do endpoint, inclusive o 503 com estado fora (banco caído)', () => {
  assert.deepEqual(observar({ status: 200, corpo: { estado: 'ok', causa: null, motivo: 'IA respondendo' } }), { tipo: 'ok', causa: null, resumo: 'IA respondendo' });
  // banco fora: 503 SEM `estado` é inacessível (e só avisa na 2ª rodada), nunca «Sofia fora do ar» na 1ª
  assert.equal(observar({ status: 503, corpo: { error: 'db_unavailable' } }).tipo, 'inacessivel');
  const o = observar({ status: 200, corpo: { estado: 'fora', causa: 'indisponivel', motivo: 'x' } });
  assert.equal(o.tipo, 'fora');
  assert.equal(o.causa, 'indisponivel');
  // causa desconhecida não passa (o corpo vem da rede)
  assert.equal(observar({ status: 200, corpo: { estado: 'fora', causa: 'hackeado' } }).causa, null);
});

// ── avancar: throttle e «voltou ao normal» ──────────────────────────────────────────────────────────────────────────

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 3, 0, 0);
const FORA: Observacao = { tipo: 'fora', causa: 'credito', resumo: '100% das chamadas à IA falhando (500 de 500)' };
const OK: Observacao = { tipo: 'ok', causa: null, resumo: '' };

/** Roda uma lista de [minutoDaRodada, observação] e devolve o que foi avisado, na ordem. */
function simular(passos: Array<[number, Observacao]>, inicio: Estado | null = null) {
  let e = inicio;
  const avisos: Array<{ min: number; tipo: string; texto: string }> = [];
  for (const [m, obs] of passos) {
    const r = avancar(e, obs, T0 + m * MIN);
    e = r.estado;
    for (const a of r.avisos) avisos.push({ min: m, tipo: a.tipo, texto: a.texto });
  }
  return { avisos, estado: e! };
}

test('throttle por TIPO: a causa dominante mudando de rodada para rodada não vira alerta novo a cada troca', () => {
  const com = (causa: Observacao['causa']): Observacao => ({ tipo: 'fora', causa, resumo: 'x' });
  const { avisos } = simular([[0, com('credito')], [10, com('limite')], [20, com('outra')], [30, com('credito')]]);
  assert.deepEqual(avisos.map((a) => [a.min, a.tipo]), [[0, 'novo'], [30, 'lembrete']]);
});

test('throttle: 15 h de queda a cada 10 min NÃO vira 90 mensagens: 1 aviso, depois lembretes a cada 30 min e, após 2 h, a cada 2 h', () => {
  const passos: Array<[number, Observacao]> = [];
  for (let m = 0; m <= 15 * 60; m += 10) passos.push([m, FORA]);
  const { avisos } = simular(passos);
  assert.equal(avisos[0].tipo, 'novo');
  assert.equal(avisos[0].min, 0);
  // 30, 60 e 90 min: meia em meia hora enquanto o incidente tem menos de 2 h ...
  assert.deepEqual(avisos.slice(1, 4).map((a) => a.min), [30, 60, 90]);
  // ... a partir de 2 h de incidente o espaçamento vira 2 h, contado do último aviso (90 + 120 = 210 ...)
  assert.deepEqual(avisos.slice(4).map((a) => a.min), [210, 330, 450, 570, 690, 810]);
  // nunca dois avisos do mesmo tipo a menos de 30 min um do outro
  for (let i = 1; i < avisos.length; i++) assert.ok(avisos[i].min - avisos[i - 1].min >= 30);
  assert.ok(avisos.length < 15, `15 h geraram ${avisos.length} avisos`);
});

test('throttle: rodada logo depois do aviso fica quieta (10 min < 30 min)', () => {
  const { avisos } = simular([[0, FORA], [10, FORA], [20, FORA]]);
  assert.equal(avisos.length, 1);
});

test('tipos diferentes têm throttles independentes: degradado → fora avisa na hora', () => {
  const DEGRADADO: Observacao = { tipo: 'degradado', causa: 'indisponivel', resumo: '30% falhando' };
  const { avisos } = simular([[0, DEGRADADO], [10, FORA]]);
  assert.deepEqual(avisos.map((a) => a.min), [0, 10]);
  assert.match(avisos[1].texto, /FORA DO AR/);
});

test('«voltou ao normal»: só depois de 2 rodadas OK seguidas, uma vez, com a duração', () => {
  const { avisos } = simular([[0, FORA], [10, FORA], [20, OK], [30, OK], [40, OK]]);
  assert.deepEqual(avisos.map((a) => a.tipo), ['novo', 'voltou']);
  assert.equal(avisos[1].min, 30);
  assert.match(avisos[1].texto, /VOLTOU AO NORMAL/);
  assert.match(avisos[1].texto, /por cerca de 30 min/);
});

test('um respiro no meio da queda (1 OK) não encerra nem manda «voltou»', () => {
  const { avisos } = simular([[0, FORA], [5, OK], [10, FORA], [15, FORA]]);
  assert.deepEqual(avisos.map((a) => a.tipo), ['novo']);
});

test('queda nova logo depois do «voltou» avisa como QUEDA (ALERTA, tipo novo), não como LEMBRETE', () => {
  const { avisos } = simular([[0, FORA], [10, OK], [20, OK], [25, FORA]]);
  assert.deepEqual(avisos.map((a) => [a.min, a.tipo]), [[0, 'novo'], [20, 'voltou'], [25, 'novo']]);
  assert.match(avisos[2].texto, /^ALERTA/);
  assert.doesNotMatch(avisos[2].texto, /LEMBRETE/);
  // e a repetição do MESMO incidente aberto continua sendo LEMBRETE
  assert.match(simular([[0, FORA], [30, FORA]]).avisos[1].texto, /^LEMBRETE/);
});

test('«voltou» cita a leitura que ABRIU o incidente, mesmo que a última seja outra (degradado → fora)', () => {
  const DEGRADADO: Observacao = { tipo: 'degradado', causa: 'indisponivel', resumo: '30% falhando' };
  const { avisos } = simular([[0, DEGRADADO], [10, FORA], [20, OK], [30, OK]]);
  const volta = avisos.find((a) => a.tipo === 'voltou')!;
  assert.match(volta.texto, /a IA está DEGRADADA \(30% falhando\)/);
});

test('solavanco de rede no meio de uma queda aberta NÃO dispara um 2º alerta («NÃO RESPONDE») nem encerra a queda', () => {
  const MUDO: Observacao = { tipo: 'inacessivel', causa: null, resumo: 'x' };
  const { avisos } = simular([[0, FORA], [5, MUDO], [10, FORA], [15, MUDO], [20, MUDO]]);
  assert.deepEqual(avisos.map((a) => [a.min, a.tipo]), [[0, 'novo'], [20, 'novo']], 'só a 2ª rodada seguida de servidor mudo vira alerta');
});

test('tudo ok o tempo todo nunca avisa nada', () => {
  assert.equal(simular([[0, OK], [10, OK], [20, OK]]).avisos.length, 0);
});

test('servidor inacessível: 1 rodada ruim NÃO avisa (deploy de 1 min); 2 seguidas avisam uma vez; volta com «voltou»', () => {
  const MUDO: Observacao = { tipo: 'inacessivel', causa: null, resumo: 'o servidor não respondeu' };
  const { avisos } = simular([[0, MUDO], [10, MUDO], [20, MUDO], [30, OK], [40, OK]]);
  assert.deepEqual(avisos.map((a) => [a.min, a.tipo]), [[10, 'novo'], [40, 'voltou']]);
  assert.match(avisos[0].texto, /NÃO RESPONDE/);
  assert.match(avisos[0].texto, /Aberto há 10 min/, 'a duração conta desde a 1ª rodada ruim');
});

test('um solavanco de rede (1 rodada ruim e volta) não manda NADA: nem alerta, nem «voltou»', () => {
  const MUDO: Observacao = { tipo: 'inacessivel', causa: null, resumo: 'x' };
  const { avisos } = simular([[0, OK], [10, MUDO], [20, OK], [30, OK], [40, MUDO], [50, OK]]);
  assert.equal(avisos.length, 0);
});

test('vigia cego também espera a 2ª rodada; «fora» não espera (já vem de 10 min de dados)', () => {
  const CEGO: Observacao = { tipo: 'cego', causa: null, resumo: 'o endpoint respondeu 404' };
  assert.deepEqual(simular([[0, CEGO], [10, CEGO]]).avisos.map((a) => a.min), [10]);
  assert.deepEqual(simular([[0, FORA]]).avisos.map((a) => a.min), [0]);
});

test('o estado antigo (cache sem campos novos) não quebra a rodada', () => {
  const r = avancar({ desde: null } as unknown as Estado, FORA, T0);
  assert.equal(r.avisos.length, 1);
  assert.equal(r.estado.okSeguidos, 0);
  assert.equal(r.estado.abertura?.tipo, 'fora');
});

test('o texto vai para um modelo de WhatsApp: uma linha só, sem 4 espaços, com teto', () => {
  assert.equal(umaLinha('a\n\n b\t\tc    d'), 'a b c d');
  assert.ok(umaLinha('x'.repeat(2000)).length <= 600);
  const a = avancar(ESTADO_VAZIO, { tipo: 'fora', causa: 'credito', resumo: 'linha 1\nlinha 2' }, T0).avisos[0];
  assert.ok(!/[\n\t]/.test(a.texto));
  assert.match(a.texto, /saldo de crédito esgotado/);
  assert.match(avisoDeTeste('manual').texto, /TESTE do vigia externo/);
  assert.equal(OK_PARA_RESOLVER, 2);
});
