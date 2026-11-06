import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { _interno, camposDaConta, type ResumoSync } from './franquia-sync-worker.js';
import { _semearParaTeste } from './automacoes-estado.js';
import {
  consultaEhHoje, decidirValorDaConsulta, emCentavos, epochDaConsulta, formaDoCartao, precosDaUnidade, sinaisDoCartao, temSinalDeConvenio, valorDaConsultaVemDoRobo,
  type EntradaValorDaConsulta,
} from './valor-consulta.js';
import { valorDaConsultaAoAgendar } from './valor-consulta-agendar.js';
import type { MarcaDoValor, MarcasDoValor } from './valor-consulta-marca.js';

// Salto-like: R$ 250 no dia, R$ 200 antecipado (Pix). Timbó: só no dia.
const FONTES_ANTECIPADO = 'CONSULTA particular: R$ 250,00 no dia, ou R$ 200,00 se pago antecipado via Pix.';
const FONTES_TIMBO = 'CONSULTA presencial com o especialista: R$ 250,00, pago no dia. Tratamento sob avaliação.';

const AGORA = 1_800_000_000;
const AMANHA = AGORA + 86_400 + 3 * 3600; // outro dia, em qualquer fuso brasileiro
const HOJE_MAIS_TARDE = AGORA + 600;
const consulta = { categoryName: 'AVALIAÇÃO', idStatus: SPINE_STATUS.AGENDADO as number | null };

const base = (over: Partial<EntradaValorDaConsulta> = {}): EntradaValorDaConsulta => ({
  estado: 'ligado', consulta, consultaEpoch: AMANHA, agoraEpoch: AGORA, tipoDoCampo: 'monetary', noCartao: null, preco: '250,00',
  precoAntecipado: '200,00', forma: 'vazio', consultaHoje: false, ...over,
});
const valorGravado = (d: ReturnType<typeof decidirValorDaConsulta>) => (d.acao === 'nada' ? d.motivo : `${d.acao}:${d.valor}`);

// ── a regra pura ───────────────────────────────────────────────────────────────
test('forma Sim → grava o preço ANTECIPADO', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim' }))), 'gravar:200');
});

test('forma Não → grava o preço no dia', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'nao' }))), 'gravar:250');
});

test('forma vazia → espera; no DIA da consulta, ainda vazia → preço no dia', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'vazio' }))), 'espera-forma');
  const hoje = decidirValorDaConsulta(base({ forma: 'vazio', consultaHoje: true, consultaEpoch: HOJE_MAIS_TARDE }));
  assert.equal(valorGravado(hoje), 'gravar:250');
  // e se no dia da consulta o paciente já escolheu Sim, o dia da consulta não rebaixa o preço
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', consultaHoje: true }))), 'gravar:200');
});

test('Não→Sim: o robô troca o que ELE gravou (cartão tem exatamente a marca)', () => {
  const d = decidirValorDaConsulta(base({ forma: 'sim', noCartao: '250', marcaCentavos: 25000 }));
  assert.equal(d.acao, 'gravar');
  assert.equal(d.acao === 'gravar' && d.valor, 200);
  assert.equal(d.acao === 'gravar' && d.troca, true);
  // o Kommo devolve monetário com casas: "250.0000" continua sendo o mesmo número
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', noCartao: '250.0000', marcaCentavos: 25000 }))), 'gravar:200');
  // e o caminho de volta (Sim→Não) também, pela mesma regra
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'nao', noCartao: '200', marcaCentavos: 20000 }))), 'gravar:250');
});

test('valor de PESSOA nunca é trocado: sem marca, marca de outro número, ou 0 da cortesia', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', noCartao: '250', marcaCentavos: null }))), 'ja-preenchido', 'sem marca = digitado');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', noCartao: '300', marcaCentavos: 25000 }))), 'ja-preenchido', 'alguém mudou depois do robô');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', noCartao: '0', marcaCentavos: 25000 }))), 'ja-preenchido', 'cortesia');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', noCartao: '0', marcaCentavos: 0 }))), 'ja-preenchido', 'marca de 0 não existe, mas se existisse o 0 é de gente');
});

test('o valor já é o certo: não grava de novo (nada de regravação)', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', noCartao: '200', marcaCentavos: 20000 }))), 'ja-preenchido');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'nao', noCartao: '250', marcaCentavos: 25000 }))), 'ja-preenchido');
});

test('plano/convênio e taxa de reserva: não grava, com o motivo', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', comConvenio: true }))), 'convenio');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'nao', comConvenio: true }))), 'convenio');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', taxaDeReserva: true }))), 'taxa-de-reserva');
  // a taxa vale mesmo sem antecipado legível: na dúvida, não grava
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'vazio', taxaDeReserva: true, precoAntecipado: null }))), 'taxa-de-reserva');
  // e nem a correção passa por cima do convênio
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', comConvenio: true, noCartao: '250', marcaCentavos: 25000 }))), 'convenio');
});

test('seco decide "gravaria" (também a troca); desligado nem olha', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', estado: 'seco' }))), 'gravaria:200');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', estado: 'ligado', secoGlobal: true, noCartao: '250', marcaCentavos: 25000 }))), 'gravaria:200');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ forma: 'sim', estado: 'desligado' }))), 'desligado');
});

test('Timbó (sem preço antecipado): a regra de sempre, qualquer que seja a forma, o convênio ou a marca', () => {
  for (const extra of [{ forma: 'sim' as const }, { forma: 'nao' as const }, { forma: 'vazio' as const }, { comConvenio: true }, { marcaCentavos: 25000 }]) {
    const d = decidirValorDaConsulta(base({ precoAntecipado: null, ...extra }));
    assert.equal(valorGravado(d), 'gravar:250', JSON.stringify(extra));
  }
  assert.equal(valorGravado(decidirValorDaConsulta(base({ precoAntecipado: null, noCartao: '250', marcaCentavos: 25000, forma: 'sim' }))), 'ja-preenchido');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ precoAntecipado: null, preco: null }))), 'sem-preco');
});

test('antecipado que não é menor que o do dia (fontes se contradizem): trata como sem antecipado', () => {
  assert.equal(valorGravado(decidirValorDaConsulta(base({ precoAntecipado: '250,00', forma: 'sim' }))), 'gravar:250');
  assert.equal(valorGravado(decidirValorDaConsulta(base({ precoAntecipado: '300,00', forma: 'vazio' }))), 'gravar:250');
});

// ── leitura do cartão ──────────────────────────────────────────────────────────
test('formaDoCartao: Sim/Não, o pagamento comprovado vale mais, valor estranho espera', () => {
  assert.equal(formaDoCartao('Sim', null), 'sim');
  assert.equal(formaDoCartao('Não', null), 'nao');
  assert.equal(formaDoCartao('Nao', null), 'nao');
  assert.equal(formaDoCartao(null, null), 'vazio');
  assert.equal(formaDoCartao('talvez', null), 'vazio');
  assert.equal(formaDoCartao('Não', 'Sim'), 'sim', 'o dinheiro entrou: pagou o preço de antes');
  assert.equal(formaDoCartao('Não', true), 'sim');
  assert.equal(formaDoCartao('Não', 'Não'), 'nao');
});

test('temSinalDeConvenio: campo Plano de saúde com algo, ou etiqueta de convênio; negação e vazio não contam', () => {
  assert.equal(temSinalDeConvenio('Unimed', []), true);
  assert.equal(temSinalDeConvenio('sim', []), true);
  assert.equal(temSinalDeConvenio('', ['CONVÊNIO']), true);
  assert.equal(temSinalDeConvenio(null, ['Plano de saúde']), true);
  assert.equal(temSinalDeConvenio('Não', []), false);
  assert.equal(temSinalDeConvenio('particular', []), false);
  assert.equal(temSinalDeConvenio(null, ['▶ AGENDADO', 'CURRÍCULO']), false);
});

test('temSinalDeConvenio: "sem convênio", "-" e etiqueta que nega o convênio NÃO são convênio', () => {
  for (const campo of ['Sem convênio', 'sem plano', '-', '--', 'Não tem', 'Nenhum']) assert.equal(temSinalDeConvenio(campo, []), false, campo);
  for (const tag of ['SEM CONVÊNIO', 'Particular - sem plano de saúde', 'não tem convênio']) assert.equal(temSinalDeConvenio(null, [tag]), false, tag);
  assert.equal(temSinalDeConvenio('Unimed Nacional', []), true);
});

test('emCentavos: vazio não é R$ 0 (a cortesia)', () => {
  assert.equal(emCentavos(''), null);
  assert.equal(emCentavos(null), null);
  assert.equal(emCentavos('0'), 0);
  assert.equal(emCentavos('250.0000'), 25000);
  assert.equal(emCentavos('250,5'), 25050);
});

test('sinaisDoCartao lê por NOME do campo e etiquetas; a forma decidida pela Sofia vale mais que a do cartão', () => {
  const lead = {
    custom_fields_values: [
      { field_id: 1, field_name: '¤ Pagamento antecipado', values: [{ value: 'Não' }] },
      { field_id: 2, field_name: '✓ Consulta pg antecipado', values: [{ value: false }] },
      { field_id: 3, field_name: '⬢ Plano de saúde', values: [{ value: 'Unimed' }] },
    ],
    _embedded: { tags: [{ name: 'X' }] },
  };
  assert.deepEqual(sinaisDoCartao(lead), { forma: 'nao', comConvenio: true });
  assert.equal(sinaisDoCartao(lead, undefined, 'Sim').forma, 'sim');
  // cartão do guia sem field_name: o nome vem do esquema
  const semNome = { custom_fields_values: [{ field_id: 9, values: [{ value: 'Sim' }] }] };
  assert.equal(sinaisDoCartao(semNome, (id) => (id === 9 ? '¤ Pagamento antecipado' : undefined)).forma, 'sim');
});

test('consultaEhHoje usa o fuso da unidade; epochDaConsulta lê a data da Sofia no relógio da unidade', () => {
  const e = epochDaConsulta('2026-11-07', '14:30', 'America/Sao_Paulo')!;
  assert.equal(new Date(e * 1000).toISOString(), '2026-11-07T17:30:00.000Z');
  assert.equal(new Date(epochDaConsulta('2026-11-07', '14:30', 'America/Boa_Vista')! * 1000).toISOString(), '2026-11-07T18:30:00.000Z');
  assert.equal(epochDaConsulta('lixo', '14:30', 'America/Sao_Paulo'), null);
  const agora = Date.parse('2026-11-07T02:00:00Z') / 1000; // 23h de 06/11 em São Paulo
  assert.equal(consultaEhHoje(Date.parse('2026-11-07T01:00:00Z') / 1000, agora, 'America/Sao_Paulo'), true);
  assert.equal(consultaEhHoje(Date.parse('2026-11-07T13:00:00Z') / 1000, agora, 'America/Sao_Paulo'), false, 'amanhã de manhã não é hoje');
  assert.equal(consultaEhHoje(null, agora, 'America/Sao_Paulo'), false);
});

test('precosDaUnidade: o antecipado vem das fontes (as mesmas da Sofia); Timbó e taxa de reserva não têm', () => {
  assert.deepEqual(precosDaUnidade({ sourceProdutos: FONTES_ANTECIPADO }), { noDia: '250,00', antecipado: '200,00' });
  assert.deepEqual(precosDaUnidade({ sourceProdutos: FONTES_TIMBO }), { noDia: '250,00', antecipado: null });
  assert.deepEqual(precosDaUnidade({ sourceProdutos: FONTES_ANTECIPADO, acceptsAdvancePayment: false }), { noDia: '250,00', antecipado: null });
  // o R$ do plano não é o antecipado particular
  const serraLike = 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado por PIX. Com plano de saúde: R$ 220.';
  assert.equal(precosDaUnidade({ sourceProdutos: serraLike }).antecipado, '250,00');
  assert.deepEqual(precosDaUnidade({ sourceProdutos: null }), { noDia: null, antecipado: null });
});

test('guia: taxa de reserva (Boa Vista) tira a unidade da lista de "o robô preenche"', () => {
  _semearParaTeste([{ slug: 'u-guia', automacao: 'valor-consulta', estado: 'ligado' }, { slug: 'u-guia', automacao: 'franquia-sync', estado: 'ligado' }]);
  try {
    assert.equal(valorDaConsultaVemDoRobo({ slug: 'u-guia', sourceProdutos: FONTES_ANTECIPADO }), true);
    assert.equal(valorDaConsultaVemDoRobo({ slug: 'u-guia', sourceProdutos: FONTES_TIMBO }), true);
    assert.equal(valorDaConsultaVemDoRobo({ slug: 'u-guia', sourceProdutos: FONTES_ANTECIPADO, spineBookingRequiresPayment: true }), false);
  } finally { _semearParaTeste([]); }
});

// ── o worker, com Kommo e marcas falsos ────────────────────────────────────────
const SLUG = 'doutor-hernia-salto';
const CAMPOS = camposDaConta([{ id: 77, name: '¤ Valor da Consulta', type: 'monetary' }]);
const resumoVazio = (): ResumoSync => ({ unit: SLUG, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 });

interface Escrita { leadId: number; campo: number; tipo: string; valor: unknown }

function marcasFalsas(inicial: Record<number, MarcaDoValor> = {}) {
  const mapa = new Map<number, MarcaDoValor>(Object.entries(inicial).map(([k, v]) => [Number(k), v]));
  const guardadas: Array<{ leadId: number; m: MarcaDoValor; origem: string }> = [];
  const marcas: MarcasDoValor = {
    ler: async (_u, leadId) => mapa.get(leadId) ?? null,
    guardar: async (_u, leadId, m, origem) => { mapa.set(leadId, m); guardadas.push({ leadId, m, origem }); },
  };
  return { marcas, guardadas };
}

function cartao(over: { forma?: string; pago?: unknown; plano?: string; valor?: unknown; tags?: string[] } = {}) {
  const cf: Array<{ field_id: number; field_name: string; values: Array<{ value: unknown }> }> = [];
  if (over.forma !== undefined) cf.push({ field_id: 11, field_name: '¤ Pagamento antecipado', values: [{ value: over.forma }] });
  if (over.pago !== undefined) cf.push({ field_id: 12, field_name: '✓ Consulta pg antecipado', values: [{ value: over.pago }] });
  if (over.plano !== undefined) cf.push({ field_id: 13, field_name: '⬢ Plano de saúde', values: [{ value: over.plano }] });
  if (over.valor !== undefined) cf.push({ field_id: 77, field_name: '¤ Valor da Consulta', values: [{ value: over.valor }] });
  return { id: 5, name: 'Paciente', status_id: 1, pipeline_id: 1, custom_fields_values: cf, _embedded: { tags: (over.tags ?? []).map((name, id) => ({ id, name })) } } as never;
}

function kommoFalso(escritas: Escrita[], relido: unknown, autor: number | null = 0) {
  return {
    getLead: async () => relido,
    setLeadCustomFieldValue: async (leadId: number, campo: number, tipo: string, valor: unknown) => { escritas.push({ leadId, campo, tipo, valor }); },
    autorDaUltimaMudancaDoCampo: async () => autor ?? undefined,
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [{ id: 77, name: '¤ Valor da Consulta', type: 'monetary', enums: null }] } }),
  };
}

const UNIT = (extra: Record<string, unknown> = {}, sourceProdutos: string | null = FONTES_ANTECIPADO) => ({ id: 'u-salto', slug: SLUG, sourceProdutos, systemPrompt: '', ...extra }) as never;

function ctxDe(escritas: Escrita[], relido: unknown, extra: Record<string, unknown> = {}, unit = UNIT(), autor: number | null = 0) {
  return {
    unit,
    kommo: kommoFalso(escritas, relido, autor) as never,
    resumo: resumoVazio(),
    camposPorNome: CAMPOS,
    agoraEpoch: AGORA,
    ...extra,
  } as unknown as Parameters<typeof _interno.espelharValorDaConsulta>[0];
}

const AGENDADA = { idSchedule: 1, idStatus: SPINE_STATUS.AGENDADO, categoryName: 'AVALIAÇÃO', dateAttendanceUtc: new Date(AMANHA * 1000).toISOString() } as SpineSchedule;
const AGENDADA_HOJE = { ...AGENDADA, dateAttendanceUtc: new Date(HOJE_MAIS_TARDE * 1000).toISOString() } as SpineSchedule;

async function rodar(estado: 'ligado' | 'seco' | 'desligado', f: () => Promise<void>) {
  _semearParaTeste([{ slug: SLUG, automacao: 'valor-consulta', estado }]);
  try { await f(); } finally { _semearParaTeste([]); }
}

test('worker: Sim grava o antecipado e guarda a marca; Não grava o do dia', async () => {
  for (const [forma, esperado, qual] of [['Sim', 200, 'antecipado'], ['Não', 250, 'no-dia']] as const) {
    const escritas: Escrita[] = [];
    const { marcas, guardadas } = marcasFalsas();
    const lead = cartao({ forma });
    await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA));
    assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: esperado }], forma);
    assert.deepEqual(guardadas, [{ leadId: 5, m: { centavos: esperado * 100, qual }, origem: 'sincronizador' }], forma);
  }
});

test('worker: forma vazia espera (não escreve, não marca); no dia da consulta grava o preço no dia', async () => {
  const escritas: Escrita[] = [];
  const { marcas, guardadas } = marcasFalsas();
  const lead = cartao();
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
  assert.deepEqual(guardadas, []);
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA_HOJE));
  assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 250 }]);
});

test('worker: comprovante muda a forma Não→Sim (✓ pago) e o robô troca o valor que ELE gravou', async () => {
  const escritas: Escrita[] = [];
  const { marcas, guardadas } = marcasFalsas({ 5: { centavos: 25000, qual: 'no-dia' } });
  const lead = cartao({ forma: 'Não', pago: 'Sim', valor: 250 });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA));
  assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 200 }]);
  assert.deepEqual(guardadas.map((g) => g.m), [{ centavos: 20000, qual: 'antecipado' }]);
});

test('worker: a segunda varredura, com o valor já certo, não grava de novo (sem regravação)', async () => {
  const escritas: Escrita[] = [];
  const { marcas } = marcasFalsas({ 5: { centavos: 20000, qual: 'antecipado' } });
  const lead = cartao({ forma: 'Sim', valor: 200 });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker: valor digitado por pessoa (sem marca, ou 0 da cortesia) nunca é trocado, mesmo com Sim', async () => {
  for (const valor of [250, 0, 180]) {
    const escritas: Escrita[] = [];
    const { marcas } = marcasFalsas();
    const lead = cartao({ forma: 'Sim', valor });
    await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA));
    assert.deepEqual(escritas, [], String(valor));
  }
});

test('worker: a marca bate mas a última mudança do campo foi de uma PESSOA: não troca (nem no seco)', async () => {
  const lead = cartao({ forma: 'Sim', valor: 250 });
  for (const estado of ['ligado', 'seco'] as const) {
    const escritas: Escrita[] = [];
    const { marcas } = marcasFalsas({ 5: { centavos: 25000, qual: 'no-dia' } });
    await rodar(estado, () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }, UNIT(), 12345), 5, lead, AGENDADA));
    assert.deepEqual(escritas, [], estado);
  }
  // e sem conseguir perguntar ao Kommo, também não
  const escritas: Escrita[] = [];
  const { marcas } = marcasFalsas({ 5: { centavos: 25000, qual: 'no-dia' } });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }, UNIT(), null), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker: a pessoa mexeu no campo entre a leitura e a troca: o robô relê e desiste', async () => {
  const escritas: Escrita[] = [];
  const { marcas } = marcasFalsas({ 5: { centavos: 25000, qual: 'no-dia' } });
  const lead = cartao({ forma: 'Sim', valor: 250 });
  const mudou = cartao({ forma: 'Sim', valor: 230 });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, mudou, { marcas }), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker: paciente com plano/convênio (campo ou etiqueta) não recebe valor', async () => {
  for (const lead of [cartao({ forma: 'Sim', plano: 'Unimed' }), cartao({ forma: 'Não', tags: ['CONVÊNIO'] })]) {
    const escritas: Escrita[] = [];
    await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas: marcasFalsas().marcas }), 5, lead, AGENDADA));
    assert.deepEqual(escritas, []);
  }
});

test('worker: unidade com taxa de reserva (Boa Vista) não grava nada', async () => {
  const escritas: Escrita[] = [];
  const lead = cartao({ forma: 'Sim' });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas: marcasFalsas().marcas }, UNIT({ spineBookingRequiresPayment: true })), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
});

test('worker, seco: nada no Kommo e nenhuma marca (a marca só existe para o que foi gravado de verdade)', async () => {
  const escritas: Escrita[] = [];
  const { marcas, guardadas } = marcasFalsas();
  const lead = cartao({ forma: 'Sim' });
  await rodar('seco', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas }), 5, lead, AGENDADA));
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas, seco: true }), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
  assert.deepEqual(guardadas, []);
});

test('worker, Timbó (sem antecipado): idêntico ao de sempre — grava 250 no vazio, sem olhar forma/convênio, sem marca nem banco', async () => {
  const unit = UNIT({ acceptsAdvancePayment: false }, FONTES_TIMBO);
  const semBanco: MarcasDoValor = { ler: async () => { throw new Error('não deveria ler marca'); }, guardar: async () => { throw new Error('não deveria guardar marca'); } };
  for (const lead of [cartao(), cartao({ forma: 'Sim' }), cartao({ plano: 'Unimed' })]) {
    const escritas: Escrita[] = [];
    const ctx = ctxDe(escritas, cartao(), { marcas: semBanco }, unit);
    await rodar('ligado', () => _interno.espelharValorDaConsulta(ctx, 5, lead, AGENDADA));
    assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 250 }]);
  }
  // campo já preenchido (qualquer coisa) fica
  const escritas: Escrita[] = [];
  const lead = cartao({ valor: 250 });
  await rodar('ligado', () => _interno.espelharValorDaConsulta(ctxDe(escritas, lead, { marcas: semBanco }, unit), 5, lead, AGENDADA));
  assert.deepEqual(escritas, []);
});

// ── a Sofia, ao agendar ────────────────────────────────────────────────────────
const agendar = (over: Record<string, unknown>, estado: 'ligado' | 'seco' | 'desligado' = 'ligado', sync: 'ligado' | 'seco' | 'desligado' = 'ligado') => {
  const escritas: Escrita[] = [];
  const marcas = marcasFalsas();
  const lead = (over.leadAtual ?? cartao()) as never;
  const args = { unit: UNIT(), kommo: kommoFalso(escritas, lead) as never, leadId: 5, leadAtual: lead, data: '2026-11-20', hora: '14:00', pagamento: 'Sim' as 'Sim' | 'Não' | null, ehRetorno: false, marcas: marcas.marcas, agoraEpoch: Date.parse('2026-11-06T12:00:00Z') / 1000, ...over };
  _semearParaTeste([{ slug: SLUG, automacao: 'valor-consulta', estado }, { slug: SLUG, automacao: 'franquia-sync', estado: sync }]);
  return valorDaConsultaAoAgendar(args).finally(() => _semearParaTeste([])).then((r) => ({ r, escritas, ...marcas }));
};

test('Sofia ao agendar: Sim grava o antecipado (e a marca) ANTES de o modelo de WhatsApp ler o campo; Não grava o do dia', async () => {
  const sim = await agendar({ pagamento: 'Sim' });
  assert.equal(sim.r, 'gravou');
  assert.deepEqual(sim.escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 200 }]);
  assert.deepEqual(sim.guardadas.map((g) => [g.m, g.origem]), [[{ centavos: 20000, qual: 'antecipado' }, 'sofia']]);
  const nao = await agendar({ pagamento: 'Não' });
  assert.deepEqual(nao.escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 250 }]);
});

test('Sofia ao agendar: respeita a chave (desligado nada; seco só registra), convênio, retorno, forma não decidida e Timbó', async () => {
  assert.equal((await agendar({}, 'desligado')).r, 'desligado');
  const seco = await agendar({}, 'seco');
  assert.equal(seco.r, 'gravaria');
  assert.deepEqual(seco.escritas, []);
  assert.deepEqual(seco.guardadas, []);
  assert.equal((await agendar({ leadAtual: cartao({ plano: 'Unimed' }) })).r, 'convenio');
  assert.equal((await agendar({ ehRetorno: true })).r, 'sem-avaliacao-ou-forma');
  assert.equal((await agendar({ ehAvaliacao: false })).r, 'sem-avaliacao-ou-forma', 'categoria que não é a avaliação');
  // o sincronizador manda: desligado, o robô nem existe (o guia não esconde o campo); em seco inteiro, nada grava
  assert.equal((await agendar({}, 'ligado', 'desligado')).r, 'franquia-sync-desligado');
  const syncSeco = await agendar({}, 'ligado', 'seco');
  assert.equal(syncSeco.r, 'gravaria');
  assert.deepEqual(syncSeco.escritas, []);
  assert.equal((await agendar({ pagamento: null })).r, 'sem-avaliacao-ou-forma');
  assert.equal((await agendar({ unit: UNIT({ spineBookingRequiresPayment: true }) })).r, 'taxa-de-reserva');
  const timbo = await agendar({ unit: UNIT({ acceptsAdvancePayment: false }, FONTES_TIMBO) });
  assert.equal(timbo.r, 'sem-antecipado');
  assert.deepEqual(timbo.escritas, []);
});

test('Sofia ao agendar, remarcação Não→Sim: troca o que o robô gravou; o que a pessoa digitou fica', async () => {
  const { marcas } = marcasFalsas({ 5: { centavos: 25000, qual: 'no-dia' } });
  const escritas: Escrita[] = [];
  const lead = cartao({ forma: 'Não', valor: 250 });
  _semearParaTeste([{ slug: SLUG, automacao: 'valor-consulta', estado: 'ligado' }, { slug: SLUG, automacao: 'franquia-sync', estado: 'ligado' }]);
  try {
    const r = await valorDaConsultaAoAgendar({ unit: UNIT(), kommo: kommoFalso(escritas, lead) as never, leadId: 5, leadAtual: lead, data: '2026-11-20', hora: '14:00', pagamento: 'Sim', ehRetorno: false, marcas, agoraEpoch: Date.parse('2026-11-06T12:00:00Z') / 1000 });
    assert.equal(r, 'gravou');
    assert.deepEqual(escritas, [{ leadId: 5, campo: 77, tipo: 'monetary', valor: 200 }]);
    const digitado = cartao({ forma: 'Não', valor: 250 });
    const e2: Escrita[] = [];
    const r2 = await valorDaConsultaAoAgendar({ unit: UNIT(), kommo: kommoFalso(e2, digitado) as never, leadId: 6, leadAtual: digitado, data: '2026-11-20', hora: '14:00', pagamento: 'Sim', ehRetorno: false, marcas, agoraEpoch: Date.parse('2026-11-06T12:00:00Z') / 1000 });
    assert.equal(r2, 'ja-preenchido');
    assert.deepEqual(e2, []);
  } finally { _semearParaTeste([]); }
});
