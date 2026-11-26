/**
 * A SOFIA SÓ FALA NO WHATSAPP: Instagram e Facebook (Messenger) ficam com a equipe.
 *
 * Pedido do João (24/11/2026) para Salto e Tatuí: «que a IA não responda Facebook e Instagram». Tudo dessas unidades chega pelo webhook
 * do Kommo, e cada mensagem diz de que canal veio em `message.add[].origin`: `waba` (API oficial do WhatsApp), `com.amocrm.amocrmwa`
 * (WhatsApp Lite), `instagram_business`, `facebook`. O campo já era lido pelo esquema do webhook e não era usado em lugar nenhum.
 *
 * Chave `sofia-so-whatsapp` (por unidade; env `SOFIA_SO_WHATSAPP_SLUGS`, padrão DESLIGADA):
 *  - `ligado`    → mensagem de Instagram/Facebook/Messenger: a Sofia não responde (decisão `__channel_not_allowed__`), e para esse paciente não
 *                  saem a escada de follow-up, a reativação pós-handoff nem a cutucada depois da equipe. (Lembrete/confirmação de consulta, sinal Pix
 *                  e cartão de chegada só existem para quem já marcou: não são tocados. Os workers só PULAM — nada é gravado na conversa.);
 *  - `seco`      → no webhook decide e REGISTRA no histórico da execução que calaria, mas responde. Os envios por iniciativa própria
 *                  seguem como hoje (o seco mede o que o webhook calaria; não há como «simular» um envio que não saiu);
 *  - `desligado` → como sempre.
 *
 * Origem ausente ou desconhecida = segue como hoje (a chave só cala o que sabe que é rede social). WhatsApp nunca é calado por aqui. No WEBHOOK
 * só a origem da PRÓPRIA mensagem decide — nunca a «última origem conhecida do cartão». Turno que não nasce de mensagem do webhook (modo widget,
 * cartão adiado de conta dividida) não traz origem e segue como WhatsApp: fica fora desta chave. Só os workers (que não têm mensagem) leem a
 * última origem do cartão.
 *
 * DE ONDE A ORIGEM VEM FORA DO WEBHOOK. Os workers não têm a mensagem na mão. A origem fica gravada no `input` do trace de toda mensagem
 * do paciente (`execution_traces.input`, canal `kommo_chat`) — a MESMA fonte, sem segundo escritor e sem migração: nada novo é gravado.
 * `origemDoPaciente` lê os últimos traces do cartão e fica com a origem da mensagem mais recente que tiver uma.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { conviteFalaNaUnidade, type NumerosDaUnidade, type RotaDeEnvioDaUnidade } from './convite-whatsapp-estado.js';
import { chaveDoConvite, conviteEnviado, esperarConvite } from './convite-whatsapp-marca.js';

export const ID_SOFIA_SO_WHATSAPP = 'sofia-so-whatsapp';

/** `iaDecision` do trace quando a Sofia não responde o canal. */
export const DECISAO_CANAL_NAO_PERMITIDO = '__channel_not_allowed__';

export function sofiaSoWhatsappEstado(slug: string, raw: string | undefined = process.env.SOFIA_SO_WHATSAPP_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_SOFIA_SO_WHATSAPP, raw);
}

export type UnidadeDoCanal = { id: string; slug: string; kommoSubdomain?: string | null } & NumerosDaUnidade & RotaDeEnvioDaUnidade;

/**
 * A Sofia se cala NESTE LEAD porque o robô «convite ao WhatsApp» o convidou? Só se a unidade tem o robô LIGADO (com número e rota de envio) E este lead tem a
 * marca de «recebeu o convite» (entrega confirmada, ≤ 7 dias). Nunca por unidade: o robô que parou numa leitura que falhou, numa franquia que não respondeu, num
 * erro de envio ou numa mensagem que virou nota não deixa a marca — e então a Sofia responde normalmente. Se o robô está decidindo este lead agora, espera (≤ 25 s)
 * o desfecho. Nunca lança.
 */
export async function sofiaCaladaPeloConvite(unit: UnidadeDoCanal, leadId: number, deps: { conviteEnviado?: (chave: string) => Promise<boolean> } = {}): Promise<boolean> {
  if (!conviteFalaNaUnidade(unit)) return false;
  const chave = chaveDoConvite(unit, leadId);
  await esperarConvite(chave);
  return (deps.conviteEnviado ?? conviteEnviado)(chave);
}

/** A origem do Kommo é de rede social (Instagram, Facebook, Messenger)? Sem diferenciar maiúsculas; vazio/desconhecido = não. */
export function origemDeRedeSocial(origem: string | null | undefined): boolean {
  if (typeof origem !== 'string') return false;
  return /instagram|facebook|messenger/i.test(origem);
}

export type DecisaoDeCanal =
  | { acao: 'segue' }
  /** `calar`: não responde. `seco`: responderia normalmente, só registra. */
  | { acao: 'calar' | 'seco'; origem: string };

/** Puro: o que fazer com uma mensagem desta origem, dado o estado da chave na unidade. */
export function decidirCanal(estado: Estado, origem: string | null | undefined): DecisaoDeCanal {
  if (estado === 'desligado' || !origemDeRedeSocial(origem)) return { acao: 'segue' };
  return { acao: estado === 'ligado' ? 'calar' : 'seco', origem: String(origem) };
}

/** O que a porta do webhook precisa do trace (o `TraceRecorder` cabe aqui; no teste entra um gravador de mentira). */
export interface GravadorDoCanal {
  step(s: { kind: 'THINKING' | 'COMPLETED'; title: string; payload: unknown; latencyMs?: number }): Promise<void>;
  /** Termina o trace como SUCCESS com esta `iaDecision`. Só é chamado quando a Sofia CALA. */
  finalizar(iaDecision: string, latencyMs: number): Promise<void>;
}

export const TITULO_CANAL_CALADO = 'Instagram/Facebook — a Sofia não responde esse canal nesta unidade (quem atende é a equipe)';

/**
 * A porta do webhook. `calou` = o turno acaba aqui (trace finalizado com `__channel_not_allowed__`, sem nota e sem tarefa); `segue` = a Sofia
 * responde como sempre (em seco, depois de registrar no histórico que calaria). Quem chama decide o que fazer com o widget e o log.
 */
export async function portaDoCanal(
  args: {
    slug: string;
    leadId: number;
    origem: string | null | undefined;
    estado?: Estado;
    latenciaMs?: () => number;
  },
  gravador: GravadorDoCanal,
): Promise<'calou' | 'segue'> {
  // SÓ a origem desta mensagem decide. Mensagem sem `origin` (ou de origem desconhecida) segue como WhatsApp: nunca se herda a origem de uma
  // mensagem ANTERIOR do cartão (quem escreveu pelo Instagram ontem e pelo WhatsApp hoje tem de ser respondido hoje).
  const canal = decidirCanal(args.estado ?? sofiaSoWhatsappEstado(args.slug), args.origem);
  if (canal.acao === 'segue') return 'segue';
  if (canal.acao === 'seco') {
    await gravador.step({
      kind: 'THINKING',
      title: `🧪 (só no papel) a Sofia ficaria calada — mensagem de ${canal.origem}, não é WhatsApp`,
      payload: { leadId: args.leadId, origem: canal.origem, reason: 'sofia_so_whatsapp_seco' },
    });
    return 'segue';
  }
  const latencia = args.latenciaMs?.() ?? 0;
  await gravador.step({
    kind: 'COMPLETED',
    title: TITULO_CANAL_CALADO,
    payload: { leadId: args.leadId, origem: canal.origem, reason: 'sofia_so_whatsapp' },
    latencyMs: latencia,
  });
  await gravador.finalizar(DECISAO_CANAL_NAO_PERMITIDO, latencia);
  return 'calou';
}

/**
 * A origem da 1ª mensagem ENTRANTE de um payload de webhook gravado (o `input` do trace), ou null.
 * Tolerante de propósito: o Kommo às vezes entrega a lista como objeto de índices, e traces de outras origens (widget, adiado) não têm `message`.
 */
export function origemDoPayload(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const message = (input as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const add = (message as { add?: unknown }).add;
  const lista: unknown[] = Array.isArray(add) ? add : add && typeof add === 'object' ? Object.values(add) : [];
  for (const m of lista) {
    if (!m || typeof m !== 'object') continue;
    const { type, origin } = m as { type?: unknown; origin?: unknown };
    if ((typeof type === 'string' ? type : 'incoming') !== 'incoming') continue;
    if (typeof origin === 'string' && origin.trim()) return origin.trim();
  }
  return null;
}

/** Quantos traces recentes do cartão olhar atrás de uma origem (traces sem mensagem do paciente — adiado, Ponte, widget — não têm). */
const TRACES_LIDOS = 8;

/**
 * A origem da mensagem mais recente do paciente neste cartão, ou null se nenhum trace recente a traz. LANÇA se o banco falhar: «não sei» por
 * erro não pode ser tratado (nem lembrado) como «sem origem» — quem chama decide (e não memoriza).
 */
export async function origemDoPaciente(unitId: string, leadId: number | string): Promise<string | null> {
  const traces = await prisma.executionTrace.findMany({
    where: { unitId, leadId: String(leadId), channel: 'kommo_chat' },
    orderBy: { createdAt: 'desc' },
    take: TRACES_LIDOS,
    select: { input: true },
  });
  for (const t of traces) {
    const o = origemDoPayload(t.input);
    if (o) return o;
  }
  return null;
}

/** Memória curta por cartão: a escada e a reativação passam pelo mesmo cartão a cada varredura (minuto a minuto). */
const VALIDADE_MS = 10 * 60_000;
const TETO_DA_MEMORIA = 2000;
const memoria = new Map<string, { social: boolean; ate: number }>();

export function _esquecerOrigensParaTeste(): void {
  memoria.clear();
}

export interface DepsDoCanal {
  estado?: Estado;
  /** o lead recebeu o convite do robô? (só o teste troca) */
  conviteEnviado?: (chave: string) => Promise<boolean>;
  origem?: (unitId: string, leadId: number | string) => Promise<string | null>;
  agora?: () => number;
}

/**
 * Para quem fala POR INICIATIVA PRÓPRIA (escada de follow-up, reativação, cutucada): este paciente é de Instagram/Facebook e a chave está
 * LIGADA? Então nada nosso sai. Chave desligada ou em seco: `false` sem ler nada (o seco só vale no webhook). Nunca lança.
 */
export async function pacienteDeRedeSocialCalado(unit: UnidadeDoCanal, leadId: number | string, deps: DepsDoCanal = {}): Promise<boolean> {
  const propria = (deps.estado ?? sofiaSoWhatsappEstado(unit.slug)) === 'ligado';
  // sem a chave própria, só o robô do convite pode calar — e só o lead que ele convidou (abaixo)
  if (!propria && !conviteFalaNaUnidade(unit)) return false;
  const agora = (deps.agora ?? Date.now)();
  const chave = `${unit.id}:${leadId}`;
  const lembrado = memoria.get(chave);
  let social: boolean;
  if (lembrado && lembrado.ate > agora) social = lembrado.social;
  else {
    try {
      social = origemDeRedeSocial(await (deps.origem ?? origemDoPaciente)(unit.id, leadId));
    } catch (err) {
      // banco fora: segue como hoje (WhatsApp) nesta passada, mas NÃO lembra — a próxima varredura pergunta de novo
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'sofia-so-whatsapp: não li a origem do paciente (segue como se fosse WhatsApp, sem memorizar)');
      return false;
    }
    if (memoria.size >= TETO_DA_MEMORIA) memoria.clear();
    memoria.set(chave, { social, ate: agora + VALIDADE_MS });
  }
  if (!social) return false;
  if (propria) return true;
  return typeof leadId === 'number' || /^\d+$/.test(String(leadId)) ? sofiaCaladaPeloConvite(unit, Number(leadId), deps) : false;
}

export interface TalkComOrigem {
  origin?: string | null;
  updated_at?: number;
  is_in_work?: boolean;
}

/** A origem da conversa (talk) mais recente do cartão no Kommo (`GET /talks`), ou null. */
export function origemDoTalkMaisRecente(talks: ReadonlyArray<TalkComOrigem>): string | null {
  // conversa antiga e já encerrada de outro canal não decide: se há alguma em atendimento, só entre elas
  const vivas = talks.filter((t) => t.is_in_work === true);
  let melhor: TalkComOrigem | null = null;
  for (const t of vivas.length ? vivas : talks) if (!melhor || (t.updated_at ?? 0) > (melhor.updated_at ?? 0)) melhor = t;
  return typeof melhor?.origin === 'string' && melhor.origin.trim() ? melhor.origin.trim() : null;
}

/**
 * A cutucada depois da equipe começa de uma conversa que a EQUIPE puxou: pode não haver nenhuma mensagem do paciente (nem trace) para a origem
 * sair de `origemDoPaciente`. Então, além dela, olha a conversa do próprio Kommo. Chave desligada ou em seco: `false` sem ler nada. Nunca lança.
 */
export async function cartaoDeRedeSocialCalado(unit: UnidadeDoCanal, leadId: number, talks: () => Promise<ReadonlyArray<TalkComOrigem>>, deps: DepsDoCanal = {}): Promise<boolean> {
  const propria = (deps.estado ?? sofiaSoWhatsappEstado(unit.slug)) === 'ligado';
  if (!propria && !conviteFalaNaUnidade(unit)) return false;
  if (await pacienteDeRedeSocialCalado(unit, leadId, deps)) return true;
  try {
    const social = origemDeRedeSocial(origemDoTalkMaisRecente(await talks()));
    if (!social) return false;
    return propria ? true : await sofiaCaladaPeloConvite(unit, leadId, deps);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'sofia-so-whatsapp: não li a conversa do Kommo (segue como se fosse WhatsApp)');
    return false;
  }
}
