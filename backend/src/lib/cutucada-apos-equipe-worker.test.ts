/**
 * A varredura da cutucada ponta a ponta com Kommo, banco, franquia e modelo FALSOS (16/11/2026).
 *
 * Prova: «só no papel» decide e guarda o TEXTO sem enviar nem gravar nada; ligado manda UMA vez (duas varreduras, uma mensagem; a
 * segunda réplica perde a corrida da marca); cada exclusão do pedido barra ANTES de gastar o modelo ou o envio; e o que mudou
 * enquanto o texto era escrito (o paciente respondeu, o cartão foi pausado) derruba o envio.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import type { Funis } from './franquia-sync-worker.js';
import type { KommoLead, KommoTalkMessage } from '../services/kommo.service.js';
import { MAX_ENVIOS, _limparMemoriaDaCutucada, cartoesDaJanela, porQueAFranquiaSeguraComDeps, varrerCutucada, type DepsDaCutucada, type DepsDaFranquia } from './cutucada-apos-equipe-worker.js';
import { LIMITE_COBRANCAS_POR_DIA } from './cobrancas-do-dia.js';
import { CAMPO_UNIDADE } from './unidade-por-canal.js';

// ── banco falso (só o que o «só no papel» grava) ──
const simulacoes: Array<{ kommoLeadId: number; acao: string; alvo: string; valor: string | null; motivo: string | null }> = [];
Object.defineProperty(prisma, 'automacaoSimulacao', {
  value: { upsert: async (a: { create: (typeof simulacoes)[number] }) => void simulacoes.push(a.create), deleteMany: async () => ({}) },
  configurable: true,
});

Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });

// ── tempo: segunda 16/11/2026, 12h40 em Brasília (a unidade abre 9h–19h, segunda a sábado) ──
const AGORA = new Date('2026-11-16T15:40:00Z');
const S = Math.floor(AGORA.getTime() / 1000);
const H = 3600;

const PIPE = 14475223;
const ENTRADA = 111806395;
const QUALIF = 111915771;
const ESPERA = 111915775;
const NOMES: Record<string, string> = { [`${PIPE}:${ENTRADA}`]: 'Incoming leads', [`${PIPE}:${QUALIF}`]: 'EM QUALIFICAÇÃO', [`${PIPE}:${ESPERA}`]: 'EM ESPERA', [`${PIPE}:111915779`]: 'AGENDADO', [`${PIPE}:143`]: 'PERDIDO', '14488799:111915803': 'EM TRATAMENTO' };
const funis = {
  comercialId: PIPE,
  tratamentoId: 14488799,
  status: new Map([
    ['COMERCIAL:incoming leads', { id: ENTRADA, nome: 'Incoming leads' }],
    ['COMERCIAL:em qualificacao', { id: QUALIF, nome: 'EM QUALIFICAÇÃO' }],
    ['COMERCIAL:em espera', { id: ESPERA, nome: 'EM ESPERA' }],
    ['COMERCIAL:agendado', { id: 111915779, nome: 'AGENDADO' }],
    ['COMERCIAL:perdido', { id: 143, nome: 'PERDIDO' }],
    ['TRATAMENTO:em tratamento', { id: 111915803, nome: 'EM TRATAMENTO' }],
  ]),
  nomeDe: (p: number, s: number) => (NOMES[`${p}:${s}`] ? { funil: p === 14488799 ? 'TRATAMENTO' : 'COMERCIAL', status: NOMES[`${p}:${s}`] } : null),
  idDe: () => null,
} as unknown as Funis;

const unit = (extra: Partial<Unit> = {}): Unit =>
  ({
    id: 'u-petropolis',
    slug: 'doutor-hernia-petropolis',
    spineTimezone: 'America/Sao_Paulo',
    spineAgendaDays: [1, 2, 3, 4, 5, 6],
    spineAgendaStart: '09:00',
    spineAgendaEnd: '19:00',
    spineEnabled: true,
    spineDayHours: { '6': { start: '07:30', end: '13:00', lunchStart: null, lunchEnd: null } },
    businessHoursTimezone: null,
    pipelineIntents: null,
    kommoPausedFieldId: 246730,
    kommoReplyFieldId: 244632,
    kommoSalesbotId: 6438,
    kommoBypassSalesbot: false,
    pausaDesde: null,
    pausaAte: null,
    ...extra,
  }) as unknown as Unit;

// ── conversa e Kommo falsos ──
interface Cenario {
  lead: KommoLead;
  msgs: KommoTalkMessage[];
}
let cartoes: Cenario[] = [];
let n = 0;
const msg = (tipo: 'in' | 'sofia' | 'lite' | 'robo', em: number, text: string): KommoTalkMessage => ({
  id: `m${++n}`,
  type: tipo === 'in' ? 'incoming' : 'outgoing',
  text,
  created_at: em,
  author: tipo === 'in' ? { type: 'external', name: 'Alex' } : tipo === 'lite' ? { type: 'bot', name: 'WhatsApp Lite' } : { type: 'bot', name: 'Salesbot' },
});
let idSeq = 5_900_000;
function lead(over: { status?: number; pipeline?: number; tags?: string[]; campos?: Array<{ field_id?: number; field_name: string; value: unknown }>; atualizado?: number } = {}): KommoLead {
  const id = ++idSeq;
  return {
    id,
    name: `Lead ${id}`,
    status_id: over.status ?? QUALIF,
    pipeline_id: over.pipeline ?? PIPE,
    updated_at: over.atualizado ?? S - 3 * H,
    _embedded: { tags: (over.tags ?? []).map((name, i) => ({ id: i + 1, name })), contacts: [{ id: id + 1, is_main: true }] },
    custom_fields_values: (over.campos ?? []).map((c) => ({ field_id: c.field_id ?? 9, field_name: c.field_name, values: [{ value: c.value }] })) as KommoLead['custom_fields_values'],
  } as KommoLead;
}
/** A equipe (pelo celular, «WhatsApp Lite») falou há `haHoras` e o paciente não respondeu. */
const equipeFalou = (haHoras = 3, texto = 'Olá, bom dia! Me chamo Natalia, da Clínica Doutor Hérnia. Para que eu possa te ajudar, qual é a sua dor?') =>
  [msg('in', S - (haHoras + 1) * H, 'Quero saber sobre o tratamento'), msg('lite', S - haHoras * H, texto)];

// ── os efeitos, para conferir o que NÃO aconteceu ──
const efeitos = { enviados: [] as string[], marcas: new Set<number>(), mensagens: [] as Array<{ texto: string; contato: string | null; meta: Record<string, unknown> }>, textosPedidos: 0, contatos: [] as Array<string | null>, leituras: 0 };

function montar(over: Partial<DepsDaCutucada> & { enviar?: () => Promise<{ via: string }> } = {}): DepsDaCutucada {
  const kommo = {
    // o filtro de etapa vai na consulta, como no Kommo: cartão de outra etapa/funil nem chega ao worker
    listLeadsDasEtapasDesde: async (etapas: Array<{ pipelineId: number; statusId: number }>) =>
      cartoes.filter((c) => etapas.some((e) => e.pipelineId === c.lead.pipeline_id && e.statusId === c.lead.status_id)).map((c) => c.lead),
    getLead: async (id: number) => cartoes.find((c) => c.lead.id === id)!.lead,
    listTalks: async (id: number) => (cartoes.find((c) => c.lead.id === id) ? [{ talk_id: id }] : []),
    listTalkMessages: async (talkId: number) => {
      efeitos.leituras++;
      return cartoes.find((c) => c.lead.id === talkId)?.msgs ?? [];
    },
    getContactPhone: async () => '5524999990000',
    sendChatReply: over.enviar ?? (async ({ text }: { text: string }) => {
      efeitos.enviados.push(text);
      return { via: 'salesbot' };
    }),
  };
  return {
    agora: () => AGORA,
    kommo: kommo as unknown as DepsDaCutucada['kommo'],
    funis,
    grupo: null,
    jaCutucados: async (_u, ids) => new Set(ids.filter((i) => efeitos.marcas.has(i))),
    gravarMarca: async (_u, leadId) => {
      if (efeitos.marcas.has(leadId)) return 'ja_existia';
      efeitos.marcas.add(leadId);
      return 'criada';
    },
    enviosDaSofia: async () => [],
    leadPausadoPorJanela: async () => false,
    caixinhaMarcada: async () => false,
    unidadeEmPausaAgora: async () => false,
    chaveLigadaAgora: async () => true,
    porQueAFranquiaSegura: async () => null,
    tetoDoDiaAtingido: async () => false,
    escrever: async (a) => {
      efeitos.textosPedidos++;
      efeitos.contatos.push(a.contato);
      return { texto: 'Oi! Aqui é a Sofia, da Doutor Hérnia Petrópolis. Conseguiu ver a pergunta da nossa atendente sobre a sua dor?', conversa: '' };
    },
    gravarMensagem: async (_u, _l, texto, contato, meta) => void efeitos.mensagens.push({ texto, contato, meta }),
    esperar: async () => undefined,
    ...over,
  };
}

beforeEach(() => {
  cartoes = [];
  simulacoes.length = 0;
  efeitos.enviados = [];
  efeitos.marcas = new Set();
  efeitos.mensagens = [];
  efeitos.textosPedidos = 0;
  efeitos.contatos = [];
  efeitos.leituras = 0;
  _limparMemoriaDaCutucada();
});

const aguardar = () => new Promise((r) => setImmediate(r));

// ─── «só no papel»: decide, guarda o texto, não toca em ninguém ──────────────────────────────────

test('SECO: gera o texto e registra «mandaria» com ele; NÃO envia, NÃO grava marca nem mensagem', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit(), 'seco', montar());
  await aguardar();
  assert.equal(r.mandaria, 1);
  assert.equal(r.enviadas, 0);
  assert.deepEqual(efeitos.enviados, []);
  assert.equal(efeitos.marcas.size, 0);
  assert.deepEqual(efeitos.mensagens, []);
  const s = simulacoes.find((x) => x.acao === 'mandaria');
  assert.equal(s?.kommoLeadId, l.id);
  assert.match(s?.valor ?? '', /Conseguiu ver a pergunta/);
  assert.match(s?.motivo ?? '', /equipe falou por último/);
});

test('SECO: a mesma fala da equipe não gera o texto de novo a cada varredura (não gasta o modelo de 5 em 5 minutos)', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  await varrerCutucada(unit(), 'seco', montar());
  await varrerCutucada(unit(), 'seco', montar());
  assert.equal(efeitos.textosPedidos, 1);
});

test('SECO sem rota de envio ainda mostra os textos; LIGADO sem rota não envia nada (cairia numa nota no cartão)', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  const semRota = unit({ kommoSalesbotId: null, kommoReplyFieldId: null } as Partial<Unit>);
  assert.equal((await varrerCutucada(semRota, 'seco', montar())).mandaria, 1);
  _limparMemoriaDaCutucada();
  const r = await varrerCutucada(semRota, 'ligado', montar());
  assert.equal(r.barrados['sem-rota-de-envio-pelo-salesbot'], 1);
  assert.deepEqual(efeitos.enviados, []);
});

// ─── ligado: uma vez por lead ────────────────────────────────────────────────────────────────────

test('LIGADO: manda UMA mensagem, grava a marca ANTES, grava a fala como assistant e a marca do teto do dia', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit(), 'ligado', montar());
  assert.equal(r.enviadas, 1);
  assert.equal(efeitos.enviados.length, 1);
  assert.ok(efeitos.marcas.has(l.id));
  assert.equal(efeitos.mensagens.length, 1);
  assert.deepEqual(efeitos.mensagens[0].meta, { via: 'salesbot', cutucada: 1 });
});

test('o NOME DE PERFIL do WhatsApp (autor das falas do paciente) chega ao modelo e ao banco — é ele que a trava «Oi, Tricolor!» da régua precisa', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  await varrerCutucada(unit(), 'ligado', montar());
  assert.deepEqual(efeitos.contatos, ['Alex']);
  assert.equal(efeitos.mensagens[0].contato, 'Alex');
});

test('LIGADO: a varredura roda 2× e sai UMA mensagem (a marca persiste; idempotente)', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  await varrerCutucada(unit(), 'ligado', montar());
  _limparMemoriaDaCutucada(); // deploy no meio: a memória se perde, a marca não
  const segunda = await varrerCutucada(unit(), 'ligado', montar());
  assert.equal(efeitos.enviados.length, 1);
  assert.equal(segunda.enviadas, 0);
  assert.equal(segunda.barrados['ja-cutucado'], 1);
});

test('LIGADO: duas réplicas varrendo ao mesmo tempo — quem perde a corrida da marca NÃO envia', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  const [a, b] = await Promise.all([varrerCutucada(unit(), 'ligado', montar()), varrerCutucada(unit(), 'ligado', montar())]);
  assert.equal(efeitos.enviados.length, 1);
  assert.equal(a.enviadas + b.enviadas, 1);
});

test('LIGADO: se o envio dá ERRO, a marca FICA (exceção depois de o pedido partir não prova que nada saiu: não repete) e a mensagem não é gravada', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit(), 'ligado', montar({ enviar: async () => { throw new Error('Kommo 500'); } }));
  assert.equal(r.erros, 1);
  assert.equal(efeitos.marcas.has(l.id), true);
  assert.deepEqual(efeitos.mensagens, []);
  _limparMemoriaDaCutucada();
  const depois = await varrerCutucada(unit(), 'ligado', montar({ enviar: async () => { throw new Error('não podia nem ser chamado'); } }));
  assert.equal(depois.barrados['ja-cutucado'], 1);
});

test('LIGADO: se a mensagem virou NOTA (sem rota de chat), não conta como enviada e a marca FICA (repetir empilharia nota)', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit(), 'ligado', montar({ enviar: async () => ({ via: 'lead_note' }) }));
  assert.equal(r.enviadas, 0);
  assert.equal(r.erros, 1);
  assert.ok(efeitos.marcas.has(l.id));
  assert.deepEqual(efeitos.mensagens, []);
});

test(`LIGADO: no máximo ${MAX_ENVIOS} envios por varredura (ligar não despeja 30 mensagens de uma vez)`, async () => {
  cartoes = Array.from({ length: MAX_ENVIOS + 3 }, () => ({ lead: lead(), msgs: equipeFalou(3) }));
  const r = await varrerCutucada(unit(), 'ligado', montar());
  assert.equal(r.enviadas, MAX_ENVIOS);
  assert.equal(efeitos.enviados.length, MAX_ENVIOS);
});

// ─── quem falou por último e o prazo ─────────────────────────────────────────────────────────────

test('equipe há 1 h (dentro do prazo): não lê o modelo; depois, enquanto o cartão não mexer, nem relê a conversa', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(1) }];
  const r1 = await varrerCutucada(unit(), 'seco', montar());
  assert.equal(r1.naoEhCaso.dentro_do_prazo, 1);
  assert.equal(efeitos.textosPedidos, 0);
  const lidas = efeitos.leituras;
  const r2 = await varrerCutucada(unit(), 'seco', montar());
  assert.equal(r2.barrados['conversa-ja-lida-sem-novidade'], 1);
  assert.equal(efeitos.leituras, lidas);
});

test('paciente por último, Sofia por último e robô (Salesbot que não é nosso) por último: nada sai', async () => {
  const paciente = [...equipeFalou(5), msg('in', S - 3 * H, 'Na lombar')];
  const sofia = [...equipeFalou(5), msg('sofia', S - 3 * H, 'Entendi!')];
  const robo = [...equipeFalou(5), msg('robo', S - 3 * H, 'Oi, Maria! Aqui é , da Doutor Hérnia. Tentei te ligar agora há pouco')];
  cartoes = [{ lead: lead(), msgs: paciente }, { lead: lead(), msgs: sofia }, { lead: lead(), msgs: robo }];
  // a «Sofia» só vale se casa com um envio que o nosso agente registrou (só o 2º cartão tem esse envio no banco)
  const r = await varrerCutucada(unit(), 'ligado', montar({ enviosDaSofia: async (_u, leadId) => (leadId === cartoes[1].lead.id ? [new Date((S - 3 * H) * 1000)] : []) }));
  assert.equal(r.naoEhCaso.paciente_falou_por_ultimo, 1);
  assert.equal(r.naoEhCaso.sofia_falou_por_ultimo, 1);
  assert.equal(r.naoEhCaso.robo_falou_por_ultimo, 1);
  assert.deepEqual(efeitos.enviados, []);
});

// ─── as exclusões do pedido: nenhuma gasta modelo nem envio ──────────────────────────────────────

async function naoCutuca(c: Cenario, deps: Partial<DepsDaCutucada> = {}, u: Unit = unit(), agoraDeps: Partial<DepsDaCutucada> = {}) {
  cartoes = [c];
  const r = await varrerCutucada(u, 'ligado', montar({ ...deps, ...agoraDeps }));
  assert.deepEqual(efeitos.enviados, [], 'não pode enviar');
  assert.equal(efeitos.marcas.size, 0, 'não pode nem marcar');
  assert.equal(r.enviadas, 0);
  return r;
}

test('NÃO cutuca: etiquetas NO_FOLLOW_UP, NAO_PERTURBAR e CURRÍCULO; opt-out; «Pausar IA»', async () => {
  for (const tag of ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'CURRÍCULO']) {
    const r = await naoCutuca({ lead: lead({ tags: [tag] }), msgs: equipeFalou(3) });
    assert.equal(r.barrados['nao-contatar'], 1, tag);
    assert.equal(efeitos.textosPedidos, 0);
  }
  const optout = await naoCutuca({ lead: lead({ campos: [{ field_name: '✓ Opt-out WhatsApp', value: 'Sim' }] }), msgs: equipeFalou(3) });
  assert.equal(optout.barrados['opt-out'], 1);
  const pausa = await naoCutuca({ lead: lead({ campos: [{ field_id: 246730, field_name: 'Pausar IA', value: true }] }), msgs: equipeFalou(3) });
  assert.equal(pausa.barrados['pausar-ia'], 1);
  assert.equal(efeitos.textosPedidos, 0);
});

test('NÃO cutuca: ◷ Retomar em de hoje em diante, consulta futura no cartão, pausa com data do widget', async () => {
  const retomar = await naoCutuca({ lead: lead({ campos: [{ field_name: '◷ Retomar em', value: S + 2 * 86_400 }] }), msgs: equipeFalou(3) });
  assert.equal(retomar.barrados['retomar-em'], 1);
  const hoje = await naoCutuca({ lead: lead({ campos: [{ field_name: '◷ Retomar em', value: S }] }), msgs: equipeFalou(3) });
  assert.equal(hoje.barrados['retomar-em'], 1);
  const consulta = await naoCutuca({
    lead: lead({ campos: [{ field_name: '◷ Data da Consulta', value: S + 86_400 }, { field_name: '✓ Situação da consulta', value: 'Agendado' }] }),
    msgs: equipeFalou(3),
  });
  assert.equal(consulta.barrados['consulta-futura-cartao'], 1);
  const janela = await naoCutuca({ lead: lead(), msgs: equipeFalou(3) }, { leadPausadoPorJanela: async () => true });
  assert.equal(janela.barrados['pausa-com-data'], 1);
  assert.equal(efeitos.textosPedidos, 0);
});

test('NÃO cutuca: unidade em pausa, fora do horário comercial (noite, domingo, feriado)', async () => {
  const pausada = await naoCutuca({ lead: lead(), msgs: equipeFalou(3) }, {}, unit({ pausaDesde: new Date('2026-11-16T10:00:00Z'), pausaAte: new Date('2026-11-16T22:00:00Z') } as Partial<Unit>));
  assert.equal(pausada.barrados['unidade-em-pausa'], 1);
  const noite = await naoCutuca({ lead: lead(), msgs: equipeFalou(3) }, { agora: () => new Date('2026-11-17T01:30:00Z') }); // 22h30 em Brasília
  assert.equal(noite.barrados['fora-do-horario'], 1);
  const domingo = await naoCutuca({ lead: lead(), msgs: equipeFalou(3) }, { agora: () => new Date('2026-11-15T16:00:00Z') });
  assert.equal(domingo.barrados['fora-do-horario'], 1);
  const feriado = await naoCutuca({ lead: lead(), msgs: equipeFalou(3) }, { agora: () => new Date('2026-11-20T16:00:00Z') }); // Consciência Negra, sexta
  assert.equal(feriado.barrados['fora-do-horario'], 1);
  assert.equal(efeitos.textosPedidos, 0);
});

test('NÃO cutuca: cartão fora da entrada/qualificação (EM ESPERA, AGENDADO, PERDIDO) nem do funil TRATAMENTO', async () => {
  for (const [status, pipeline] of [[ESPERA, PIPE], [111915779, PIPE], [143, PIPE], [111915803, 14488799]] as const) {
    const r = await naoCutuca({ lead: lead({ status, pipeline }), msgs: equipeFalou(3) });
    assert.equal(r.candidatos, 0, `${pipeline}:${status}`);
  }
  assert.equal(efeitos.textosPedidos, 0);
  assert.equal(efeitos.leituras, 0, 'nem lê a conversa');
});

test('NÃO cutuca: paciente em tratamento / consulta futura na franquia / número interno / franquia fora do ar — vira «pularia» com o motivo', async () => {
  for (const motivo of [
    'paciente em tratamento na franquia: paciente da franquia (idClient 12) com tratamento ativo',
    'consulta futura na franquia',
    'tratamento em andamento na franquia',
    'número interno da rede (NUMEROS_INTERNOS)',
    'a franquia não respondeu (timeout): na dúvida, não cutuca',
  ]) {
    simulacoes.length = 0;
    const l = lead();
    const r = await naoCutuca({ lead: l, msgs: equipeFalou(3) }, { porQueAFranquiaSegura: async () => motivo });
    await aguardar();
    assert.equal(efeitos.textosPedidos, 0, motivo);
    assert.equal(Object.values(r.seguradas).reduce((a, b) => a + b, 0), 1, motivo);
    const p = simulacoes.find((x) => x.acao === 'pularia' && x.kommoLeadId === l.id);
    assert.equal(p?.motivo, motivo);
  }
});

test(`NÃO cutuca: quem já recebeu ${LIMITE_COBRANCAS_POR_DIA} cobranças hoje (teto do dia)`, async () => {
  const r = await naoCutuca({ lead: lead(), msgs: equipeFalou(3) }, { tetoDoDiaAtingido: async () => true });
  assert.equal(efeitos.textosPedidos, 0);
  assert.equal(Object.keys(r.seguradas).some((k) => /cobran/.test(k)), true);
});

test('o texto reprovado pelas travas não sai; tenta no máximo 2× por fala da equipe e registra «pularia»', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  const deps = montar({ escrever: async () => { efeitos.textosPedidos++; return { texto: null, porque: 'texto reprovado: fala de valor, Pix ou pagamento' }; } });
  await varrerCutucada(unit(), 'ligado', deps);
  const logo = await varrerCutucada(unit(), 'ligado', deps);
  assert.equal(logo.barrados['conversa-ja-lida-sem-novidade'], 1, 'depois de reprovar, a 2ª tentativa só vem daqui a 30 min');
  assert.equal(efeitos.textosPedidos, 1);
  const depois = (): DepsDaCutucada => ({ ...deps, agora: () => new Date(AGORA.getTime() + 31 * 60_000) });
  await varrerCutucada(unit(), 'ligado', depois());
  const terceira = await varrerCutucada(unit(), 'ligado', { ...depois(), agora: () => new Date(AGORA.getTime() + 70 * 60_000) });
  await aguardar();
  assert.equal(efeitos.textosPedidos, 2);
  assert.equal(terceira.barrados['texto-reprovado-duas-vezes'], 1);
  assert.deepEqual(efeitos.enviados, []);
  assert.match(simulacoes.find((x) => x.acao === 'pularia')?.motivo ?? '', /não saiu/);
});

// ─── o que mudou enquanto o texto era escrito (o modelo leva segundos) ───────────────────────────

test('LIGADO: o paciente respondeu enquanto o texto era escrito → não envia e não marca', async () => {
  const l = lead();
  const c: Cenario = { lead: l, msgs: equipeFalou(3) };
  cartoes = [c];
  const r = await varrerCutucada(unit(), 'ligado', montar({
    escrever: async () => {
      c.msgs = [...c.msgs, msg('in', S - 60, 'Tenho dor na lombar')];
      return { texto: 'Oi! Aqui é a Sofia, da Doutor Hérnia Petrópolis. Conseguiu ver a pergunta da nossa atendente sobre a sua dor?', conversa: '' };
    },
  }));
  assert.deepEqual(efeitos.enviados, []);
  assert.equal(efeitos.marcas.size, 0);
  assert.equal(r.enviadas, 0);
  assert.match(Object.keys(r.seguradas).join(), /conversa mudou/);
});

test('LIGADO: «Pausar IA» marcado, ou a unidade pausada, enquanto o texto era escrito → não envia', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  await varrerCutucada(unit(), 'ligado', montar({ caixinhaMarcada: async () => true }));
  await varrerCutucada(unit(), 'ligado', montar({ unidadeEmPausaAgora: async () => true }));
  // o cartão ganhou a etiqueta NO_FOLLOW_UP no meio: o getLead fresco já vem com ela
  const c: Cenario = { lead: lead(), msgs: equipeFalou(3) };
  cartoes = [c];
  await varrerCutucada(unit(), 'ligado', montar({
    escrever: async () => {
      c.lead = { ...c.lead, _embedded: { ...c.lead._embedded, tags: [{ id: 1, name: 'NO_FOLLOW_UP' }] } };
      return { texto: 'Oi! Aqui é a Sofia, da Doutor Hérnia Petrópolis. Conseguiu ver a pergunta da nossa atendente sobre a sua dor?', conversa: '' };
    },
  }));
  assert.deepEqual(efeitos.enviados, []);
  assert.equal(efeitos.marcas.size, 0);
});

test('LIGADO: a equipe falou DE NOVO enquanto o texto era escrito → a fala já é outra, não envia por cima', async () => {
  const c: Cenario = { lead: lead(), msgs: equipeFalou(3) };
  cartoes = [c];
  await varrerCutucada(unit(), 'ligado', montar({
    escrever: async () => {
      c.msgs = [...c.msgs, msg('lite', S - 30, 'Só confirmando: qual a sua dor?')];
      return { texto: 'Oi! Aqui é a Sofia, da Doutor Hérnia Petrópolis. Conseguiu ver a pergunta da nossa atendente sobre a sua dor?', conversa: '' };
    },
  }));
  assert.deepEqual(efeitos.enviados, []);
});

test('Kommo dividido entre duas unidades: cartão de outra unidade (ou sem unidade) não é cutucado por esta', async () => {
  const grupo = {
    contaUnitId: 'u-caxias',
    membros: [
      { unitId: 'u-petropolis', contaUnitId: 'u-caxias', rotulo: 'Petrópolis' },
      { unitId: 'u-caxias', contaUnitId: 'u-caxias', rotulo: 'Caxias' },
    ],
  };
  const comUnidade = (valor: string | null) => {
    const l = lead();
    return valor ? ({ ...l, custom_fields_values: [{ field_id: 77, field_name: CAMPO_UNIDADE, values: [{ value: valor }] }] } as KommoLead) : l;
  };
  cartoes = [{ lead: comUnidade('Caxias'), msgs: equipeFalou(3) }, { lead: comUnidade(null), msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit(), 'ligado', montar({ grupo }));
  assert.deepEqual(efeitos.enviados, []);
  assert.equal(r.deOutraUnidade, 1);
  assert.equal(r.semUnidade, 1);
  cartoes = [{ lead: comUnidade('Petrópolis'), msgs: equipeFalou(3) }];
  assert.equal((await varrerCutucada(unit(), 'ligado', montar({ grupo }))).enviadas, 1);
});

test('SECO: depois de simulada, a conversa só é relida se o cartão mexer (não martela o Kommo nem a franquia de 5 em 5 minutos)', async () => {
  const c: Cenario = { lead: lead(), msgs: equipeFalou(3) };
  cartoes = [c];
  await varrerCutucada(unit(), 'seco', montar());
  const lidas = efeitos.leituras;
  const r = await varrerCutucada(unit(), 'seco', montar());
  assert.equal(efeitos.leituras, lidas);
  assert.equal(r.barrados['conversa-ja-lida-sem-novidade'], 1);
  c.lead = { ...c.lead, updated_at: (c.lead.updated_at ?? 0) + 60 }; // o cartão mexeu: relê
  await varrerCutucada(unit(), 'seco', montar());
  assert.ok(efeitos.leituras > lidas);
});

test('a janela de cartões anda pela data do ÚLTIMO lido (o Kommo vem do mais antigo ao mais novo), sem repetir, e avisa quando bate no teto', async () => {
  const chamadas: number[] = [];
  let id = 1;
  const pagina = (n: number, de: number) => Array.from({ length: n }, (_, i) => ({ id: id++, updated_at: de + i + 1 }) as KommoLead);
  const kommo = (cheia: boolean) => ({
    listLeadsDasEtapasDesde: async (_e: unknown, desde: number) => {
      chamadas.push(desde);
      return cheia || desde < 250 ? pagina(250, desde) : pagina(100, desde);
    },
  }) as unknown as DepsDaCutucada['kommo'];
  const etapas = [{ pipelineId: PIPE, statusId: QUALIF }];

  const curta = await cartoesDaJanela(kommo(false), etapas, 0);
  assert.deepEqual(chamadas, [0, 250]);
  assert.equal(curta.cartoes.length, 350);
  assert.equal(curta.truncado, false);

  chamadas.length = 0;
  const cheia = await cartoesDaJanela(kommo(true), etapas, 0);
  assert.equal(chamadas.length, 8, 'para no teto de leituras');
  assert.equal(cheia.truncado, true, 'o que ficou de fora são os mais novos: tem de ser dito');

  const parada = await cartoesDaJanela({ listLeadsDasEtapasDesde: async () => Array.from({ length: 250 }, () => ({ id: 1, updated_at: 5 }) as KommoLead) } as unknown as DepsDaCutucada['kommo'], etapas, 5);
  assert.equal(parada.truncado, true, '250 no mesmo segundo: não anda, não repete para sempre');
});

test('LIGADO não roda onde a régua (follow-up) está ligada — as duas mexeriam na mesma conversa; o papel segue', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  const comRegua = unit({ followUpEnabled: true } as Partial<Unit>);
  const r = await varrerCutucada(comRegua, 'ligado', montar());
  assert.equal(r.barrados['follow-up-ligado-na-unidade'], 1);
  assert.deepEqual(efeitos.enviados, []);
  assert.equal((await varrerCutucada(comRegua, 'seco', montar())).mandaria, 1);
});

test('falha do MODELO (ou conta no teto) não é texto reprovado: não gasta as 2 tentativas daquela fala da equipe', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  const deps = montar({ escrever: async () => { efeitos.textosPedidos++; return { texto: null, porque: 'o modelo falhou', transitorio: true }; } });
  for (const min of [0, 31, 62, 93]) await varrerCutucada(unit(), 'ligado', { ...deps, agora: () => new Date(AGORA.getTime() + min * 60_000) });
  assert.equal(efeitos.textosPedidos, 4, 'quatro tentativas, nenhuma bloqueada por «reprovado duas vezes»');
});

test('um «pularia» posterior NÃO apaga o texto do «mandaria» na tela (alvos diferentes)', async () => {
  const c: Cenario = { lead: lead(), msgs: equipeFalou(3) };
  cartoes = [c];
  await varrerCutucada(unit(), 'seco', montar());
  c.lead = { ...c.lead, updated_at: (c.lead.updated_at ?? 0) + 60 };
  await varrerCutucada(unit(), 'seco', montar({ porQueAFranquiaSegura: async () => 'consulta futura na franquia' }));
  await aguardar();
  assert.ok(simulacoes.some((x) => x.acao === 'mandaria' && x.alvo === 'mensagem' && /Conseguiu ver/.test(x.valor ?? '')));
  assert.ok(simulacoes.some((x) => x.acao === 'pularia' && x.alvo === 'mensagem-segurada'));
});

test('cartão que dá erro de leitura (não 403) recua 10 min em vez de comer uma vaga de leitura a cada varredura', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  let chamadas = 0;
  const deps = montar();
  deps.kommo = { ...deps.kommo, listTalks: async () => { chamadas++; throw new Error('listTalks: 500'); } } as DepsDaCutucada['kommo'];
  await varrerCutucada(unit(), 'ligado', deps);
  await varrerCutucada(unit(), 'ligado', deps);
  assert.equal(chamadas, 1);
});

test('conta sem o escopo de conversas (403): não derruba a varredura, não repete a leitura, e três seguidos encerram a unidade', async () => {
  cartoes = Array.from({ length: 5 }, () => ({ lead: lead(), msgs: equipeFalou(3) }));
  let chamadas = 0;
  const deps = montar();
  deps.kommo = { ...deps.kommo, listTalks: async () => { chamadas++; throw new Error('listTalks(1): 403 Invalid scope'); } } as DepsDaCutucada['kommo'];
  const r = await varrerCutucada(unit(), 'ligado', deps);
  assert.equal(chamadas, 3);
  assert.equal(r.erros, 3);
  assert.deepEqual(efeitos.enviados, []);
  const depois = await varrerCutucada(unit(), 'ligado', deps);
  assert.equal(chamadas, 5, 'os 3 que falharam esperam; só os 2 restantes são tentados');
  assert.equal(depois.barrados['conversa-ja-lida-sem-novidade'], 3);
});

// ─── horário REAL da unidade (spine_day_hours) ───────────────────────────────────────────────────

test('HORÁRIO: sábado Petrópolis atende 7h30–13h (spine_day_hours), não até 19h — 15h e 18h30 NÃO mandam; 10h manda; segunda 12h40 manda', async () => {
  const sabado = (horaBrasilia: string) => new Date(`2026-11-21T${horaBrasilia}:00-03:00`); // 21/11/2026 é sábado
  for (const [hora, manda] of [['15:00', false], ['18:30', false], ['13:30', false], ['10:00', true], ['08:15', true], ['07:45', false]] as const) {
    _limparMemoriaDaCutucada();
    efeitos.enviados = [];
    efeitos.marcas = new Set();
    const base = sabado(hora);
    // a equipe falou 3 h antes do horário testado
    const falou = Math.floor(base.getTime() / 1000) - 3 * H;
    cartoes = [{ lead: lead({ atualizado: falou }), msgs: [msg('in', falou - H, 'Quero saber'), msg('lite', falou, 'Qual é a sua dor? Me conte um pouco.')] }];
    const r = await varrerCutucada(unit(), 'ligado', montar({ agora: () => base }));
    assert.equal(r.enviadas, manda ? 1 : 0, `sábado ${hora}`);
    if (!manda) assert.equal(r.barrados['fora-do-horario'], 1, `sábado ${hora}`);
  }
});

test('HORÁRIO: sem agenda cadastrada ("não sei") = fechada; e o fechamento ENQUANTO o texto é escrito derruba o envio', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit({ spineEnabled: false } as Partial<Unit>), 'seco', montar());
  assert.equal(r.barrados['fora-do-horario'], 1);
  let chamadas = 0;
  const deps = montar({ agora: () => (chamadas++ < 1 ? AGORA : new Date('2026-11-16T22:30:00Z')) }); // 19h30: já fechou quando o texto ficou pronto
  _limparMemoriaDaCutucada();
  const r2 = await varrerCutucada(unit(), 'ligado', deps);
  assert.deepEqual(efeitos.enviados, []);
  assert.equal(r2.enviadas, 0);
});

// ─── desligar vale na hora ───────────────────────────────────────────────────────────────────────

test('DESLIGAR: a chave é relida antes da marca — desligou no meio da varredura, nenhum dos envios que faltam sai', async () => {
  cartoes = Array.from({ length: 4 }, () => ({ lead: lead(), msgs: equipeFalou(3) }));
  let leituras = 0;
  const r = await varrerCutucada(unit(), 'ligado', montar({ chaveLigadaAgora: async () => ++leituras <= 1 }));
  assert.equal(efeitos.enviados.length, 1, 'só o primeiro, que foi antes de desligar');
  assert.equal(efeitos.marcas.size, 1);
  assert.equal(r.enviadas, 1);
  assert.equal(leituras, 2, 'parou na 1ª leitura «desligada»: os outros dois nem perguntam');
});

// ─── franquia: na dúvida, não manda ──────────────────────────────────────────────────────────────

test('FRANQUIA: índice de telefones velho, vazio ou com erro = «sem índice fresco», e NÃO cutuca (a classe do incidente de 14/11)', async () => {
  const kommo = { getContactPhone: async () => '5524999990000' } as unknown as DepsDaCutucada['kommo'];
  const l = { ...lead(), _embedded: { contacts: [{ id: 1, is_main: true }] } } as KommoLead;
  const u = unit({ spineEnabled: true, spineToken: 'x' } as Partial<Unit>);
  const nada = { conhecido: false, consultaFutura: false, emAndamento: false, finalizado: false };
  const deps = (indice: DepsDaFranquia['indice'], sinal: Awaited<ReturnType<DepsDaFranquia['consultarFranquia']>> = { tipo: 'nao_achou' }): DepsDaFranquia => ({
    indice,
    franquiaDoPaciente: async () => nada,
    consultarFranquia: async () => sinal,
    agendarIndice: () => undefined,
  });
  assert.match((await porQueAFranquiaSeguraComDeps(u, kommo, l, deps(async () => ({ fresco: false, idadeHoras: 50 })))) ?? '', /sem índice fresco \(50 h\)/);
  assert.match((await porQueAFranquiaSeguraComDeps(u, kommo, l, deps(async () => ({ fresco: false, idadeHoras: null })))) ?? '', /nunca carregado/);
  assert.match((await porQueAFranquiaSeguraComDeps(u, kommo, l, deps(async () => { throw new Error('banco'); }))) ?? '', /sem índice fresco/);
  // índice fresco e telefone que NÃO está lá: aí sim segue
  assert.equal(await porQueAFranquiaSeguraComDeps(u, kommo, l, deps(async () => ({ fresco: true, idadeHoras: 2 }))), null);
  // fresco e paciente em tratamento: segura
  assert.match((await porQueAFranquiaSeguraComDeps(u, kommo, l, deps(async () => ({ fresco: true, idadeHoras: 2 }), { tipo: 'paciente', idClient: 9, tratamentoAtivo: true, sessaoFutura: false }))) ?? '', /paciente em tratamento/);
  // fresco, mas a ficha não veio: indisponível = segura
  assert.match((await porQueAFranquiaSeguraComDeps(u, kommo, l, deps(async () => ({ fresco: true, idadeHoras: 2 }), { tipo: 'indisponivel', motivo: 'timeout' }))) ?? '', /não respondeu/);
});

test('FRANQUIA: no worker, o índice velho vira «pularia» com o motivo e nada sai', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit(), 'ligado', montar({ porQueAFranquiaSegura: async () => 'franquia sem índice fresco (50 h): não dá para afirmar que o telefone não é de paciente' }));
  await aguardar();
  assert.equal(efeitos.textosPedidos, 0);
  assert.deepEqual(efeitos.enviados, []);
  assert.match(simulacoes.find((x) => x.acao === 'pularia' && x.kommoLeadId === l.id)?.motivo ?? '', /sem índice fresco/);
  assert.ok(r.seguradas['franquia sem índice fresco (50 h)']);
});

// ─── a clínica deve o retorno ────────────────────────────────────────────────────────────────────

test('CLÍNICA DEVE O RETORNO: «vou pedir para a equipe analisar e já retorno» → não cutuca e vira «pularia» (lead 5806575, 13/11)', async () => {
  const l = lead();
  cartoes = [{
    lead: l,
    msgs: [
      msg('in', S - 6 * H, 'Segue meus exames'),
      msg('lite', S - 4 * H, 'Vou pedir para a nossa equipe especializada em patologias da coluna para analisar os exames e já retorno o contato com o senhor'),
      msg('in', S - 3.5 * H, 'Ok, obrigado'),
    ],
  }];
  // o paciente só acusou o recebimento: a promessa continua devida (e a última fala é dele, então nada sai por isso também)
  const r = await varrerCutucada(unit(), 'ligado', montar());
  assert.deepEqual(efeitos.enviados, []);
  _limparMemoriaDaCutucada();
  cartoes = [{ lead: l, msgs: [msg('in', S - 6 * H, 'Segue meus exames'), msg('lite', S - 4 * H, 'Vou pedir para a nossa equipe especializada em patologias da coluna para analisar os exames e já retorno o contato com o senhor')] }];
  const r2 = await varrerCutucada(unit(), 'ligado', montar());
  await aguardar();
  assert.equal(r2.naoEhCaso.clinica_deve_retorno, 1);
  assert.equal(efeitos.textosPedidos, 0);
  assert.match(simulacoes.find((x) => x.acao === 'pularia')?.motivo ?? '', /clínica deve retorno/);
  assert.ok(r);
});

// ─── o motivo do «mandaria» mostra o que a equipe disse ──────────────────────────────────────────

test('MANDARIA: o motivo traz o trecho da última fala da equipe (sem telefone) — para conferir se um robô de texto novo foi lido como equipe', async () => {
  const l = lead();
  cartoes = [{ lead: l, msgs: equipeFalou(3, 'Olá, bom dia! Me chamo Natalia. Pode me chamar no (24) 99999-0000 ou 24999990000, qual é a sua dor?') }];
  await varrerCutucada(unit(), 'seco', montar());
  await aguardar();
  const m = simulacoes.find((x) => x.acao === 'mandaria')?.motivo ?? '';
  assert.match(m, /«Olá, bom dia! Me chamo Natalia/);
  assert.doesNotMatch(m, /9999/);
});

// ─── 403 seguidos ────────────────────────────────────────────────────────────────────────────────

test('403: «três SEGUIDOS» — uma leitura boa no meio zera a conta e a varredura não encerra', async () => {
  cartoes = Array.from({ length: 6 }, () => ({ lead: lead(), msgs: equipeFalou(1) }));
  const deps = montar();
  let n = 0;
  const falha = new Set([1, 2, 4, 5]); // 403, 403, ok, 403, 403, ok
  const original = deps.kommo.listTalks;
  deps.kommo = { ...deps.kommo, listTalks: async (id: number) => { n++; if (falha.has(n)) throw new Error('403 Invalid scope'); return original(id); } } as DepsDaCutucada['kommo'];
  const r = await varrerCutucada(unit(), 'ligado', deps);
  assert.equal(n, 6, 'leu os seis: nunca chegou a 3 seguidos');
  assert.equal(r.erros, 4);
});

test('SECO → LIGADO sem reiniciar: o que o papel já viu NÃO esconde o lead quando a chave passa a ligada (o João liga e confere)', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  await varrerCutucada(unit(), 'seco', montar());
  assert.deepEqual(efeitos.enviados, []);
  const r = await varrerCutucada(unit(), 'ligado', montar());
  assert.equal(r.enviadas, 1);
  assert.equal(efeitos.enviados.length, 1);
});

test('LIGADO no modo bypass (texto em pedaços, com fallback para outras rotas) não envia: o paciente poderia receber duas vezes', async () => {
  cartoes = [{ lead: lead(), msgs: equipeFalou(3) }];
  const r = await varrerCutucada(unit({ kommoBypassSalesbot: true } as Partial<Unit>), 'ligado', montar());
  assert.equal(r.barrados['sem-rota-de-envio-pelo-salesbot'], 1);
  assert.deepEqual(efeitos.enviados, []);
});

test('a pausa com data é consultada só para quem seria cutucado (não uma consulta por cartão da janela)', async () => {
  cartoes = [
    { lead: lead(), msgs: [...equipeFalou(5), msg('in', S - 3 * H, 'Na lombar')] }, // paciente por último
    { lead: lead(), msgs: equipeFalou(1) }, // dentro do prazo
    { lead: lead(), msgs: equipeFalou(3) }, // este sim
  ];
  const consultados: number[] = [];
  await varrerCutucada(unit(), 'seco', montar({ leadPausadoPorJanela: async (_u, id) => { consultados.push(id); return false; } }));
  assert.deepEqual(consultados, [cartoes[2].lead.id]);
});
