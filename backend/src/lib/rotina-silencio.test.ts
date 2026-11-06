/**
 * O motor do silêncio da rotina diária (06/11/2026): o degrau da vez (puro) e o laço de varredura — degraus por PESSOA, atalho do último
 * degrau pronto, teto do dia parando o laço, âncoras (entrada na etapa), trava extra, travas que custam chamada.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AGORA, COM, DIA, H, chamadas, conversas, ctx, escritas, franquiaFalsa, leadsComTag, novo, pausados, poeMarca, SEM_FRANQUIA, simulacoes, tagsPostas, tracos, zerar } from './rotina-teste-util.js';
import { idDaMarca, pessoaDoCartao, resumoNovo } from './rotina-nucleo.js';
import { cartoesDaEtapa, decidirToque, prazos, varrerSilencio, type EntradaDoToque, type ParamsDoSilencio } from './rotina-silencio.js';

beforeEach(zerar);

const RETOMADA = ['▶ Retomada', '▶ Retomada 2', '▶ Retomada 3'];

// ─── o degrau da vez (puro) ───────────────────────────────────────────────────────────────────────

const entrada = (silencioDias: number, extra: Partial<EntradaDoToque> = {}): EntradaDoToque => ({
  agora: AGORA,
  dias: [2, 4, 7],
  etiquetas: RETOMADA,
  prontos: 3,
  ultimaDoPaciente: AGORA - silencioDias * DIA,
  marcas: [],
  entradaAteDias: 30,
  ...extra,
});

test('cada prazo dispara no dia dele, nem meio dia antes', () => {
  for (const dias of [[2, 4, 7], [1, 3, 6], [2, 5, 9]]) {
    assert.equal(decidirToque(entrada(dias[0] - 0.5, { dias })).tipo, 'espera', `faltando meio dia (${dias})`);
    const no = decidirToque(entrada(dias[0], { dias }));
    assert.equal(no.tipo === 'toca' && no.toque, 1);
    assert.equal(no.tipo === 'toca' && no.etiqueta, '▶ Retomada');
  }
});

test('sem mensagem do paciente na janela não é esquecido; estoque antigo sem nenhum toque não entra', () => {
  assert.equal(decidirToque(entrada(5, { ultimaDoPaciente: null })).tipo, 'fora');
  assert.equal(decidirToque(entrada(45)).tipo, 'fora');
});

test('a régua anda na ordem, sem repetir e sem pular: o 2º só com 4 dias E o espaço do desenho depois do 1º', () => {
  const primeiro = { toque: 1, em: AGORA - 2 * DIA };
  const dois = decidirToque(entrada(4, { marcas: [primeiro] }));
  assert.equal(dois.tipo === 'toca' && dois.toque, 2);
  assert.equal(dois.tipo === 'toca' && dois.etiqueta, '▶ Retomada 2');
  assert.equal(decidirToque(entrada(5, { marcas: [{ toque: 1, em: AGORA - DIA }] })).tipo, 'espera', 'o 1º saiu ontem: espera o espaço');
  assert.equal(decidirToque(entrada(3, { marcas: [primeiro] })).tipo, 'espera');
  const tarde = decidirToque(entrada(8, { marcas: [{ toque: 1, em: AGORA - 6 * DIA }] }));
  assert.equal(tarde.tipo === 'toca' && tarde.toque, 2, 'nunca pula pro 3º');
});

test('quem chega atrasado leva o 1º hoje e o 2º só no espaço certo: nunca dois no mesmo dia', () => {
  const hoje = decidirToque(entrada(9));
  assert.equal(hoje.tipo === 'toca' && hoje.toque, 1);
  assert.equal(hoje.tipo === 'toca' && hoje.atrasado, true);
  assert.equal(decidirToque(entrada(10, { marcas: [{ toque: 1, em: AGORA - DIA }] })).tipo, 'espera');
});

test('acabou a régua sem resposta: não manda mais nada', () => {
  const todas = [1, 2, 3].map((toque) => ({ toque, em: AGORA - (4 - toque) * DIA }));
  assert.equal(decidirToque(entrada(20, { marcas: todas })).tipo, 'esgotada');
});

test('degrau sem robô/gatilho confirmado na conta aparece como «sem gatilho» e não sai', () => {
  const d = decidirToque(entrada(5, { prontos: 1, marcas: [{ toque: 1, em: AGORA - 3 * DIA }] }));
  assert.equal(d.tipo, 'sem-gatilho');
  assert.equal(d.tipo === 'sem-gatilho' && d.etiqueta, '▶ Retomada 2');
});

test('ex-lead 30/60/90: o 1º só entra na janela [30, 60); o 2º e o 3º no espaço do desenho', () => {
  const base = { dias: [30, 60, 90], etiquetas: ['▶ Reativação', '▶ Reativação 2', '▶ Reativação 3'], entradaAteDias: 60 };
  assert.equal(decidirToque(entrada(29, base)).tipo, 'espera');
  assert.equal(decidirToque(entrada(75, base)).tipo, 'fora');
  const sessenta = decidirToque(entrada(61, { ...base, marcas: [{ toque: 1, em: AGORA - 31 * DIA }] }));
  assert.equal(sessenta.tipo === 'toca' && sessenta.etiqueta, '▶ Reativação 2');
});

test('prazos: padrão, ambiente e unidade; os que não crescem voltam ao padrão e ficam anotados', () => {
  const inv: string[] = [];
  assert.deepEqual(prazos([2, 4, 7], {}, 'rotina_x', undefined, inv), [2, 4, 7]);
  assert.deepEqual(prazos([2, 4, 7], { rotina_x_d1: 3, rotina_x_d2: 5 }, 'rotina_x', undefined, inv), [3, 5, 7]);
  assert.deepEqual(prazos([2, 4, 7], { rotina_x_d3: 12 }, 'rotina_x', '3,6,10', inv), [3, 6, 12], 'a unidade manda por cima do ambiente');
  assert.equal(inv.length, 0);
  assert.deepEqual(prazos([1, 3, 6], { rotina_y_d2: 1 }, 'rotina_y', undefined, inv), [1, 3, 6]);
  assert.equal(inv.length, 1);
});

// ─── o laço ───────────────────────────────────────────────────────────────────────────────────────

const params = (extra: Partial<ParamsDoSilencio> = {}): ParamsDoSilencio => ({
  automacao: 'rotina-robos',
  chave: 'qualificacao',
  etapa: 'EM QUALIFICAÇÃO',
  dias: [2, 4, 7],
  etiquetas: RETOMADA,
  prontos: 1,
  entradaAteDias: 30,
  janelaOlhadaDias: 37,
  opcoesDoCartao: {},
  ...extra,
});
const ETAPA_Q = { pipelineId: COM, statusId: 11 };
async function varrer(c: ReturnType<typeof ctx>, seco: boolean, p: ParamsDoSilencio = params()) {
  const r = resumoNovo();
  await varrerSilencio(c, seco, p, await cartoesDaEtapa(c.kommo, ETAPA_Q), r);
  return r;
}

test('travas que custam chamada: equipe nas últimas 48 h, qualquer fala nas últimas 24 h, franquia com consulta futura, cartão pausado pela recepção', async () => {
  const equipe = novo({ falas: [{ autor: 'user', em: AGORA - 30 * H }] });
  const hoje = novo({ falas: [{ autor: 'bot', em: AGORA - 5 * H }] });
  const futura = novo();
  const emTrat = novo();
  const pausado = novo();
  const livre = novo();
  franquiaFalsa.por = (id) => (id === futura.lead.id ? { ...SEM_FRANQUIA, conhecido: true, consultaFutura: true } : id === emTrat.lead.id ? { ...SEM_FRANQUIA, conhecido: true, emAndamento: true } : SEM_FRANQUIA);
  pausados.add(pausado.lead.id);
  const r = await varrer(ctx(), false);
  assert.deepEqual(leadsComTag(), [livre.lead.id]);
  assert.equal(r.seguradas['equipe-conversando'], 1);
  assert.equal(r.seguradas['falaram-hoje'], 1);
  assert.equal(r.seguradas['franquia-segura'], 2);
  assert.equal(r.seguradas['lead-pausado'], 1);
  assert.ok(equipe && hoje);
});

test('conversa com mensagem nas últimas 24 h no banco nem gasta chamada; o paciente que escreveu no meio tempo não recebe', async () => {
  const recente = novo({ silencioDias: 3 });
  conversas.set(String(recente.lead.id), AGORA - 3 * H);
  const escreveu = novo({ silencioDias: 3 });
  escreveu.falas.push({ autor: 'external', em: AGORA - 600 });
  await varrer(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.ok(!chamadas.includes(`mensagem:${recente.contato}`), 'a peneira do banco poupou a chamada');
});

test('quem nunca escreveu e o estoque antigo ficam de fora (foraDaJanela)', async () => {
  novo({ silencioDias: null });
  novo({ silencioDias: 40 });
  const r = await varrer(ctx(), false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.foraDaJanela, 2);
});

test('DEGRAUS POR PESSOA: o 1º degrau que um cartão da pessoa recebeu vale para o outro cartão dela (mesma régua)', async () => {
  const a = novo({ contato: 321, silencioDias: 3 });
  const b = novo({ contato: 321, silencioDias: 3 });
  const c = ctx();
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 1, a.paciente as number), c.unit.id, a.lead.id, 30);
  // b: 3 dias de silêncio, o 1º degrau (da pessoa) saiu há 30 h → o 2º ainda não venceu; NÃO manda o 1º de novo
  const r = await varrer(c, false);
  assert.equal(tagsPostas().length, 0);
  assert.equal(r.esgotadas + r.esperando + (r.seguradas['aguarda-proximo-degrau-pronto'] ?? 0) >= 1, true);
  assert.ok(b);
});

test('duas pessoas iguais em cartões do mesmo dia: só um recebe hoje', async () => {
  novo({ contato: 654, silencioDias: 3 });
  novo({ contato: 654, silencioDias: 3 });
  await varrer(ctx(), false);
  assert.equal(tagsPostas().length, 1, 'a mesma pessoa não recebe dois modelos no mesmo dia');
});

test('ATALHO: quem já recebeu o ÚLTIMO degrau PRONTO sai da fila sem gastar chamada, e não volta enquanto ninguém falar', async () => {
  // 1 degrau pronto (o padrão): os 5 cartões já receberam o 1º. Não podem consumir as 40 avaliações nem ficar na frente.
  const c = ctx();
  const recebidos = [1, 2, 3, 4, 5].map(() => novo({ silencioDias: 5 }));
  for (const x of recebidos) poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(x.lead), 'qualificacao', 1, x.paciente as number), c.unit.id, x.lead.id, 70);
  const novoLead = novo({ silencioDias: 3 });
  const r = await varrer(c, false);
  assert.equal(chamadas.filter((x) => x.startsWith('mensagem')).length, 1, 'só o cartão novo gastou chamada');
  assert.deepEqual(leadsComTag(), [novoLead.lead.id]);
  assert.equal(r.seguradas['aguarda-proximo-degrau-pronto'], 5);
  // e uma 2ª varredura (memória zerada, como depois de um deploy) continua sem gastar chamada com eles
  chamadas.length = 0;
  const c2 = { ...ctx(), unit: c.unit };
  await varrer(c2, false);
  assert.equal(chamadas.filter((x) => x.startsWith('mensagem')).length, 0);
});

test('ATALHO: se o paciente voltou a escrever (conversa no banco depois do último degrau), o cartão é reavaliado', async () => {
  const c = ctx();
  const x = novo({ silencioDias: 3 });
  poeMarca(idDaMarca(c.unit.id, pessoaDoCartao(x.lead), 'qualificacao', 1, AGORA - 30 * DIA), c.unit.id, x.lead.id, 70);
  conversas.set(String(x.lead.id), AGORA - 30 * H); // escreveu depois do degrau (há 30 h), mas nada nas últimas 24 h
  await varrer(c, false);
  assert.ok(chamadas.includes(`mensagem:${x.contato}`), 'foi reavaliado: o atalho só vale enquanto ninguém falou depois do último degrau');
});

test('o laço PARA quando o teto do dia acaba: o resto nem gasta a chamada de mensagem', async () => {
  for (let i = 0; i < 8; i++) novo({ silencioDias: 3 });
  const c = ctx({ intents: { rotina_teto_dia: 2 } });
  const r = await varrer(c, false);
  assert.equal(tagsPostas().length, 2);
  assert.equal(r.paradoPeloTeto, true);
  assert.equal(chamadas.filter((x) => x.startsWith('mensagem')).length, 2 + 0, 'só os dois que couberam foram avaliados');
});

test('o laço do SECO também para no teto do dia (o papel mostra o corte, não avalia o resto)', async () => {
  for (let i = 0; i < 6; i++) novo({ silencioDias: 3 });
  const r = await varrer(ctx({ intents: { rotina_teto_dia: 2 } }), true);
  assert.equal(simulacoes.filter((s) => s.acao === 'etiquetaria').length, 2);
  assert.equal(r.paradoPeloTeto, true);
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
});

test('âncora na ENTRADA da etapa (NÃO COMPARECEU): a última mensagem é de semanas atrás, mas faltou ontem — o relógio conta da falta', async () => {
  const faltouOntem = novo({ silencioDias: 20, entrou: AGORA - 1 * DIA });
  const faltouHaDois = novo({ silencioDias: 20, entrou: AGORA - 2.1 * DIA });
  const semData = novo({ silencioDias: 20, entrou: null });
  const p = params({ chave: 'naocompareceu', etapa: 'NÃO COMPARECEU', dias: [2, 4, 6], ancorarNaEntrada: true });
  const r = await varrer(ctx(), false, p);
  assert.deepEqual(leadsComTag(), [faltouHaDois.lead.id], 'ontem: ainda é cedo (2 dias de silêncio contados da falta); sem data de entrada: não arrisca');
  assert.equal(r.seguradas['sem-data-de-entrada-na-etapa'], 1);
  assert.ok(faltouOntem && semData);
  // e a marca usa a âncora (a entrada), não a mensagem velha: o paciente voltar a escrever depois a zera
  assert.ok([...tracos.keys()].some((k) => k.endsWith(`-naocompareceu-1-${Math.floor(AGORA - 2.1 * DIA)}`)));
});

test('sem a âncora na entrada (QUALIFICAÇÃO) vale a última mensagem, mesmo que o cartão tenha acabado de entrar', async () => {
  const x = novo({ silencioDias: 3, entrou: AGORA - 1 * H });
  await varrer(ctx(), false);
  assert.deepEqual(leadsComTag(), [x.lead.id]);
});

test('a trava extra da régua segura o cartão (ex-lead: as do etiquetas-auto), com o motivo no papel', async () => {
  const x = novo({ silencioDias: 3 });
  const r = await varrer(ctx(), true, params({ travaExtra: async () => ({ codigo: 'voltou-em-outro-cartao', texto: 'voltou em outro cartão (1)' }) }));
  assert.equal(r.seguradas['voltou-em-outro-cartao'], 1);
  assert.ok(simulacoes.some((s) => s.kommoLeadId === x.lead.id && s.acao === 'pularia' && /outro cartão/.test(s.motivo ?? '')));
  assert.equal(simulacoes.filter((s) => s.acao === 'etiquetaria').length, 0);
});

test('o que foi decidido «no papel» não segura a mesma decisão depois que a régua é ligada', async () => {
  novo({ silencioDias: 3 });
  const c = ctx();
  await varrer(c, true);
  assert.equal(tagsPostas().length, 0);
  await varrer(c, false);
  assert.equal(tagsPostas().length, 1);
});

test('erro do Kommo num cartão pula o cartão (nunca vira «pode mandar») e não derruba a varredura', async () => {
  const ruim = novo({ silencioDias: 3 });
  const bom = novo({ silencioDias: 3 });
  const original = (await import('./rotina-teste-util.js')).kommo.ultimaMensagemDoContatoDesde;
  const util = await import('./rotina-teste-util.js');
  (util.kommo as { ultimaMensagemDoContatoDesde: unknown }).ultimaMensagemDoContatoDesde = async (contato: number, desde: number) => {
    if (contato === ruim.contato) throw new Error('Kommo 500');
    return original(contato, desde);
  };
  try {
    const r = await varrer(ctx(), false);
    assert.equal(r.erros, 1);
    assert.deepEqual(leadsComTag(), [bom.lead.id]);
  } finally {
    (util.kommo as { ultimaMensagemDoContatoDesde: unknown }).ultimaMensagemDoContatoDesde = original;
  }
});
