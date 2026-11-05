import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { _interno, camposDaConta, type ResumoSync } from './franquia-sync-worker.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { decidirValorDaConsulta, precoEmNumero, type EntradaValorDaConsulta } from './valor-consulta.js';

const consulta = (over: Partial<Pick<SpineSchedule, 'categoryName' | 'idStatus'>> = {}) => ({ categoryName: 'AVALIAÇÃO', idStatus: SPINE_STATUS.AGENDADO as number | null, ...over });

const AGORA = 1_800_000_000;
const AMANHA = AGORA + 86_400;

const base = (over: Partial<EntradaValorDaConsulta> = {}): EntradaValorDaConsulta => ({
  estado: 'ligado', consulta: consulta(), consultaEpoch: AMANHA, agoraEpoch: AGORA, tipoDoCampo: 'monetary', noCartao: null, preco: '250,00', ...over,
});

// ── a regra pura ───────────────────────────────────────────────────────────────
test('campo vazio + avaliação marcada + preço nas fontes: grava', () => {
  assert.deepEqual(decidirValorDaConsulta(base()), { acao: 'gravar', valor: 250, motivo: 'avaliação marcada e campo vazio (preço das fontes da unidade)' });
});

test('o valor é o das fontes, não um número do código', () => {
  const d = decidirValorDaConsulta(base({ preco: '180,50' }));
  assert.equal(d.acao === 'gravar' && d.valor, 180.5);
});

test('campo já preenchido: não toca (valor digitado, inclusive 0 da cortesia)', () => {
  for (const noCartao of ['250', '300', '0', '120.5']) {
    assert.deepEqual(decidirValorDaConsulta(base({ noCartao })), { acao: 'nada', motivo: 'ja-preenchido' }, noCartao);
  }
});

test('sem preço nas fontes: não grava (e diz o motivo, para o worker logar)', () => {
  for (const preco of [null, '', '0,00', 'abc']) {
    assert.deepEqual(decidirValorDaConsulta(base({ preco })), { acao: 'nada', motivo: 'sem-preco' }, String(preco));
  }
});

test('seco: decide "gravaria" e não "gravar" — também quando é o sincronizador inteiro que está em seco', () => {
  assert.equal(decidirValorDaConsulta(base({ estado: 'seco' })).acao, 'gravaria');
  assert.equal(decidirValorDaConsulta(base({ estado: 'ligado', secoGlobal: true })).acao, 'gravaria');
});

test('desligado: não faz nada, nem olha o resto', () => {
  assert.deepEqual(decidirValorDaConsulta(base({ estado: 'desligado' })), { acao: 'nada', motivo: 'desligado' });
});

test('só avaliação por vir: retorno, sessão, atendida, falta, desmarcada e sem consulta não recebem', () => {
  const nao = [
    consulta({ categoryName: 'Retorno' }),
    consulta({ categoryName: 'Sessão' }),
    consulta({ idStatus: SPINE_STATUS.ATENDIDO }),
    consulta({ idStatus: SPINE_STATUS.NAO_COMPARECEU }),
    consulta({ idStatus: SPINE_STATUS.DESMARCADO }),
    consulta({ idStatus: null }),
    null,
  ];
  for (const c of nao) assert.deepEqual(decidirValorDaConsulta(base({ consulta: c })), { acao: 'nada', motivo: 'sem-consulta-por-vir' }, JSON.stringify(c));
  for (const idStatus of [SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO]) {
    assert.equal(decidirValorDaConsulta(base({ consulta: consulta({ idStatus }) })).acao, 'gravar', String(idStatus));
  }
});

test('avaliação que já passou (ainda "Agendado" por falta de baixa) não ganha valor depois do fato', () => {
  for (const consultaEpoch of [AGORA - 3600, AGORA - 2 * 86_400, AGORA, null]) {
    assert.deepEqual(decidirValorDaConsulta(base({ consultaEpoch })), { acao: 'nada', motivo: 'sem-consulta-por-vir' }, String(consultaEpoch));
  }
});

test('conta sem o campo, ou com o campo de tipo que não aceita número: não grava', () => {
  assert.deepEqual(decidirValorDaConsulta(base({ tipoDoCampo: null })), { acao: 'nada', motivo: 'sem-campo' });
  for (const t of ['text', 'select', 'date']) assert.deepEqual(decidirValorDaConsulta(base({ tipoDoCampo: t })), { acao: 'nada', motivo: 'campo-sem-numero' }, t);
  assert.equal(decidirValorDaConsulta(base({ tipoDoCampo: 'numeric' })).acao, 'gravar');
});

test('precoEmNumero: "250,00" → 250; lixo e zero → null', () => {
  assert.equal(precoEmNumero('250,00'), 250);
  assert.equal(precoEmNumero('1.250,00'), 1250);
  for (const x of ['0,00', '', null, undefined, 'R$']) assert.equal(precoEmNumero(x as string), null, String(x));
});

// ── o worker, com um Kommo falso ───────────────────────────────────────────────
const SLUG = 'doutor-hernia-timbo';
const FONTES_TIMBO = 'CONSULTA presencial com o especialista: R$ 250,00, pago no dia. Tratamento sob avaliação.';
const CAMPOS = camposDaConta([{ id: 77, name: '¤ Valor da Consulta', type: 'monetary' }, { id: 78, name: '¤ Valor do tratamento', type: 'monetary' }]);

interface Escrita { leadId: number; campo: number; tipo: string; valor: unknown }

const resumoVazio = (): ResumoSync => ({ unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 });

/** `relido` = o que o Kommo devolve quando a varredura relê o cartão antes de escrever (padrão: continua vazio). */
function kommoFalso(escritas: Escrita[], relido: unknown = cartaoCom()) {
  return {
    getLead: async () => relido,
    setLeadCustomFieldValue: async (leadId: number, campo: number, tipo: string, valor: unknown) => { escritas.push({ leadId, campo, tipo, valor }); },
  };
}

function ctxDe(escritas: Escrita[], extra: Record<string, unknown> = {}, sourceProdutos: string | null = FONTES_TIMBO) {
  return {
    unit: { id: 'u-timbo', slug: SLUG, sourceProdutos } as never,
    kommo: kommoFalso(escritas) as never,
    resumo: resumoVazio(),
    camposPorNome: CAMPOS,
    agoraEpoch: AGORA,
    ...extra,
  } as unknown as Parameters<typeof _interno.espelharValorDaConsulta>[0];
}

const cartaoCom = (valores: Array<[number, unknown]> = []) => ({
  id: 5, name: 'Paciente', status_id: 1, pipeline_id: 1,
  custom_fields_values: valores.map(([field_id, value]) => ({ field_id, values: [{ value }] })),
}) as never;

const AGENDADA = { idSchedule: 1, idStatus: SPINE_STATUS.AGENDADO, categoryName: 'AVALIAÇÃO', dateAttendanceUtc: new Date((AMANHA) * 1000).toISOString() } as SpineSchedule;

async function rodar(estado: 'ligado' | 'seco' | 'desligado' | null, f: () => Promise<void>) {
  _semearParaTeste(estado ? [{ slug: SLUG, automacao: 'valor-consulta', estado }] : []);
  try { await f(); } finally { _semearParaTeste([]); }
}

test('worker, ligado: cartão com avaliação marcada e campo vazio recebe 250 no formato monetário do Kommo', async () => {
  const escritas: Escrita[] = [];
  const ctx = ctxDe(escritas);
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctx, 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 250 }]);
  assert.equal(ctx.resumo.escritas, 1);
});

test('worker, ligado: campo já preenchido (mesmo com outro valor) não é tocado; o Valor do tratamento não conta como vazio/preenchido do outro', async () => {
  const escritas: Escrita[] = [];
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom([[77, 300]]), AGENDADA));
  assert.deepEqual(escritas, []);
  // só o campo do tratamento preenchido: o da consulta segue vazio e é gravado
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom([[78, 1500]]), AGENDADA));
  assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 250 }]);
});

test('worker: se a recepção preencheu o campo enquanto a varredura rodava, o robô relê e não sobrescreve', async () => {
  const escritas: Escrita[] = [];
  const ctx = ctxDe(escritas, { kommo: kommoFalso(escritas, cartaoCom([[77, 0]])) });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctx, 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, [], 'o 0 da cortesia digitado depois do início da varredura fica');
  // sem conseguir reler o cartão, também não escreve
  const semLeitura = ctxDe(escritas, { kommo: { ...kommoFalso(escritas), getLead: async () => { throw new Error('429'); } } });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(semLeitura, 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);
  assert.equal(semLeitura.resumo.erros, 1);
});

test('worker: avaliação de ontem ainda "Agendada" não recebe', async () => {
  const escritas: Escrita[] = [];
  const ontem = { ...AGENDADA, dateAttendanceUtc: new Date((AGORA - 86_400) * 1000).toISOString() } as SpineSchedule;
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom(), ontem));
  assert.deepEqual(escritas, []);
});

test('worker: unidade sem preço nas fontes não grava', async () => {
  const escritas: Escrita[] = [];
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, {}, 'Tratamento sob avaliação. Convênio: não atendemos.'), 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, {}, null), 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker, seco: não escreve no Kommo (nem com a chave ligada, se o sincronizador está em seco)', async () => {
  const escritas: Escrita[] = [];
  await rodar('seco', () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, { seco: true }), 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker, desligado (e o padrão da rede, sem linha na tela): não escreve', async () => {
  const escritas: Escrita[] = [];
  await rodar('desligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom(), AGENDADA));
  await rodar(null, () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker: consulta atendida/desmarcada/retorno, ou cartão sem consulta, não recebe', async () => {
  const escritas: Escrita[] = [];
  for (const c of [{ ...AGENDADA, idStatus: SPINE_STATUS.ATENDIDO }, { ...AGENDADA, idStatus: SPINE_STATUS.DESMARCADO }, { ...AGENDADA, categoryName: 'Retorno' }, null]) {
    await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas), 5, cartaoCom(), c as SpineSchedule | null));
  }
  assert.deepEqual(escritas, []);
});

test('worker: conta sem o campo não escreve; falha do Kommo conta erro e não derruba a varredura', async () => {
  const escritas: Escrita[] = [];
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, { camposPorNome: camposDaConta([{ id: 99, name: '✎ Queixa', type: 'text' }]) }), 5, cartaoCom(), AGENDADA));
  assert.deepEqual(escritas, []);

  const quebrado = ctxDe(escritas, { kommo: { ...kommoFalso(escritas), setLeadCustomFieldValue: async () => { throw new Error('400'); } } });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(quebrado, 5, cartaoCom(), AGENDADA));
  assert.equal(quebrado.resumo.erros, 1);
  assert.equal(quebrado.resumo.escritas, 0);
});

test('worker: teto por varredura é próprio da chave (o das outras não o segura)', async () => {
  const escritas: Escrita[] = [];
  const ctx = ctxDe(escritas);
  ctx.resumo.camposSdrCartoes = 9999; // o teto do campos-sdr estourado não pode segurar este
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctx, 5, cartaoCom(), AGENDADA));
  assert.equal(escritas.length, 1);
  ctx.resumo.valorConsultaCartoes = 60;
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctx, 6, cartaoCom(), AGENDADA));
  assert.equal(escritas.length, 1, 'no teto da própria chave, para');
});

test('catálogo: a automação existe, escreve campo, tem seco e nasce desligada', async () => {
  const { automacaoPorId, verificarCatalogo, AUTOMACOES } = await import('./automacoes.js');
  const a = automacaoPorId('valor-consulta');
  assert.ok(a);
  assert.equal(a.chave, 'VALOR_CONSULTA_SLUGS');
  assert.equal(a.risco, 'escreve-campo');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);
});
