/**
 * A SOFIA VOLTA SOZINHA, 1 h DEPOIS DA ÚLTIMA FALA DA EQUIPE (pedido do João, 30/10/2026).
 *
 * Antes: a automação `pausa-equipe` marcava "Pausar IA" quando a equipe falava com o paciente (inclusive pelo
 * celular da clínica) e a Sofia ficava calada ATÉ ALGUÉM DESMARCAR; a reativação de 30 min era cancelada de
 * propósito. Conversa que a equipe largava ficava muda para sempre se ninguém lembrasse da caixinha.
 *
 * Agora um worker (5 em 5 min, sob o lease dos workers — um líder só no Swarm) olha só as pausas que a própria
 * automação registrou (`pausas_da_equipe`, ver pausa-equipe-registro.ts) e devolve o cartão quando, ao mesmo tempo:
 *  - a última fala HUMANA da equipe (`falasHumanasDaEquipe`: sem Salesbot, sem saudação/ausência do WhatsApp
 *    Business) tem ≥ PAUSA_EQUIPE_VOLTA_MIN (padrão 60) — lida da conversa oficial NO MOMENTO de despausar,
 *    então fala nova da equipe zera a conta;
 *  - ninguém mexeu na caixinha desde que a Sofia a marcou, e ela segue marcada (desmarcada = alguém já
 *    devolveu; mexida e remarcada = virou pausa de gente, não é nossa);
 *  - não há pausa com data do widget em curso, nem pausa da unidade;
 *  - a IA atende na etapa em que o cartão está (a mesma regra do webhook: allowlist da unidade/conta, regra
 *    global `pause_in_stages` e "Sofia calada" em GANHO/ALTA/CANCELADO).
 *
 * Ao voltar: desmarca "Pausar IA" e deixa NOTA no cartão. NÃO manda nada ao paciente — a Sofia só responde
 * quando ele escrever (e a fala antiga da equipe não pausa de novo: desmarcar é "devolver", ver `conferirEquipe`).
 *
 * Chave `pausa-equipe` por unidade: ligado = faz; só no papel = só registra "gravaria Pausar IA (volta)" na
 * tela; desligado = nada (as linhas ficam abertas e valem de novo se a chave voltar — por isso há validade).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';
import { etapaPermitida, precisaDoFunil, type FunisDaConta } from './etapa-permitida.js';
import { etapaCalada, sofiaCaladaLiberada } from './sofia-calada.js';
import { esquemaDaUnidade } from './kommo-schema.js';
import { AUTOMACAO_PAUSA_EQUIPE, DEPS_PAUSA_EQUIPE_PADRAO, estadoDaPausaPelaEquipe, falasHumanasDaEquipe, nomeDoAutor } from './pausa-equipe.js';
import { encerrarPausaDaEquipe, pausasAbertas, type DesfechoDaPausa, type PausaAberta } from './pausa-equipe-registro.js';
import { createKommoClient } from '../services/kommo.service.js';
import { getPausedStagesGlobalSet } from '../services/actions.service.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';

export const VOLTA_PADRAO_MIN = 60;
/** Pausa aberta há mais que isto sem poder voltar (etapa fechada, chave desligada…) deixa de ser candidata. */
export const VALIDADE_DA_PAUSA_MS = 14 * 24 * 3600_000;
/** O Kommo carimba o evento da nossa própria marcação com o relógio dele: folga antes de contar "alguém mexeu". */
export const FOLGA_DA_MARCACAO_MS = 120_000;
const SWEEP_MS = 5 * 60_000;

/** `PAUSA_EQUIPE_VOLTA_MIN`: minutos sem fala da equipe para a Sofia voltar. Inválido ou ≤ 0 = 60. */
export function minutosDaVolta(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PAUSA_EQUIPE_VOLTA_MIN);
  return Number.isFinite(n) && n > 0 ? n : VOLTA_PADRAO_MIN;
}

// ── parte pura ──────────────────────────────────────────────────────────────────────────────────

export interface UltimaFala {
  em: Date;
  autorNome: string;
}

/**
 * PURA: a última fala humana da equipe. A fala que provocou a pausa (do registro) vale como piso: a conversa
 * oficial é lida em janela curta e a fala antiga pode ter saído dela.
 */
export function ultimaFalaDaEquipe(msgs: readonly MensagemOficial[], doRegistro: UltimaFala): UltimaFala {
  const falas = falasHumanasDaEquipe(msgs);
  const ultima = falas[falas.length - 1];
  if (ultima && ultima.em.getTime() >= doRegistro.em.getTime()) return { em: ultima.em, autorNome: ultima.autorNome };
  return doRegistro;
}

export type DecisaoDoTempo = { passou: true; ultima: UltimaFala } | { passou: false; ultima: UltimaFala; faltamMs: number };

/** PURA: já se passaram `minutos` desde a última fala da equipe? Fala nova da equipe empurra a volta. */
export function passouTempoSemEquipe(
  msgs: readonly MensagemOficial[],
  doRegistro: UltimaFala,
  agora: Date,
  minutos: number = VOLTA_PADRAO_MIN,
): DecisaoDoTempo {
  const ultima = ultimaFalaDaEquipe(msgs, doRegistro);
  const decorrido = agora.getTime() - ultima.em.getTime();
  const limite = minutos * 60_000;
  return decorrido >= limite ? { passou: true, ultima } : { passou: false, ultima, faltamMs: limite - decorrido };
}

export interface PosicaoDoCartao {
  statusId: number | null | undefined;
  pipelineId: number | null | undefined;
  /** Nome da etapa e do funil, quando o esquema da conta foi lido (só a "Sofia calada" precisa). */
  etapa?: string | null;
  funil?: string | null;
}

export type SemAtendimento = 'fora_da_allowlist' | 'regra_global' | 'etapa_calada';

/**
 * PURA: a IA atende nesta etapa? A MESMA regra do webhook antes de responder:
 *  1. "Sofia calada" (GANHO / ALTA / TRATAMENTO CANCELADO), se a chave `sofia-calada` está ligada na unidade;
 *  2. allowlist (`kommoAllowedStatusIds`) — vazia na conta toda = sem restrição; com Kommo dividido, basta UMA
 *     unidade da conta atender a etapa (é o roteador por etapa que escolhe a dona);
 *  3. regra global `pause_in_stages` (chaves `*:status` e `funil:status`).
 */
export function iaAtendeNaEtapa(args: {
  unidadesDaConta: ReadonlyArray<{ kommoAllowedStatusIds: readonly number[] | null }>;
  posicao: PosicaoDoCartao;
  funis: FunisDaConta | null;
  etapasPausadasGlobal: ReadonlySet<string>;
  caladaAtiva: boolean;
}): { atende: true } | { atende: false; motivo: SemAtendimento } {
  const { posicao: p } = args;
  if (args.caladaAtiva && p.statusId && etapaCalada(p.etapa, { statusId: p.statusId, pipeline: p.funil })) {
    return { atende: false, motivo: 'etapa_calada' };
  }
  const listas = args.unidadesDaConta.map((u) => u.kommoAllowedStatusIds ?? []);
  if (listas.some((l) => l.length > 0) && !listas.some((l) => etapaPermitida(l, p.statusId, p.pipelineId, args.funis))) {
    return { atende: false, motivo: 'fora_da_allowlist' };
  }
  const sid = p.statusId;
  const pid = p.pipelineId;
  if ((sid && args.etapasPausadasGlobal.has(`*:${sid}`)) || (sid && pid && args.etapasPausadasGlobal.has(`${pid}:${sid}`))) {
    return { atende: false, motivo: 'regra_global' };
  }
  return { atende: true };
}

/** PURA: "Melissa às 10:25" (ou "…em 29/10 às 10:25" se não for de hoje) / "o celular da clínica (WhatsApp Business) às 10:25". */
export function descreverUltimaFala(f: UltimaFala, agora: Date, tz = 'America/Sao_Paulo'): string {
  const quem = nomeDoAutor(f.autorNome);
  try {
    const dia = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(d);
    const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(f.em);
    return dia(f.em) === dia(agora) ? `${quem} às ${hora}` : `${quem} em ${dia(f.em)} às ${hora}`;
  } catch {
    return `${quem} às ${f.em.toISOString().slice(11, 16)}`;
  }
}

/** PURA: o texto da nota que fica no cartão. */
export function notaDaVolta(minutos: number, ultima: string): string {
  const tempo = minutos % 60 === 0 ? `${minutos / 60} h` : `${minutos} min`;
  return `IA voltou: ${tempo} sem mensagem da equipe (última: ${ultima}). A Sofia volta a responder quando o paciente escrever.`;
}

// ── varredura ───────────────────────────────────────────────────────────────────────────────────

export type ResultadoDaLinha =
  | 'voltou'
  | 'despausaria'
  | 'cedo'
  | 'chave_desligada'
  | 'unidade_pausada'
  | 'pausa_com_data'
  | 'etapa_nao_atende'
  | 'devolvida_por_gente'
  | 'mexida_por_gente'
  | 'vencida'
  | 'nao_conferi';

export interface DepsDaVolta {
  agora: () => Date;
  estado: (slug: string) => ReturnType<typeof estadoDaPausaPelaEquipe>;
  minutos: () => number;
  /** Conversa oficial do lead. Lança se não leu. */
  mensagens: (unit: Unit, leadId: number) => Promise<MensagemOficial[]>;
  pausaMarcadaAgora: (unit: Unit, leadId: number) => Promise<boolean>;
  pausaMexidaDesde: (unit: Unit, leadId: number, desde: Date) => Promise<boolean>;
  pausaComData: (unit: Unit, leadId: number) => Promise<boolean>;
  /** Etapa do cartão + o que a regra de etapa precisa. Lança se não leu. */
  etapa: (unit: Unit, leadId: number) => Promise<{ atende: boolean; motivo: SemAtendimento | null; descricao: string }>;
  desmarcar: (unit: Unit, leadId: number) => Promise<void>;
  anotar: (unit: Unit, leadId: number, texto: string) => Promise<void>;
  encerrar: (id: string, desfecho: DesfechoDaPausa) => Promise<void>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

async function etapaPadrao(unit: Unit, leadId: number, cache: CacheDaVarredura): Promise<Awaited<ReturnType<DepsDaVolta['etapa']>>> {
  const kommo = createKommoClient(unit);
  const lead = await kommo.getLead(leadId);
  const chave = unit.kommoSubdomain || unit.id;
  let conta = cache.contas.get(chave);
  if (!conta) {
    conta = unit.kommoSubdomain
      ? await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain, isActive: true }, select: { kommoAllowedStatusIds: true } })
      : [{ kommoAllowedStatusIds: unit.kommoAllowedStatusIds }];
    if (!conta.length) conta = [{ kommoAllowedStatusIds: unit.kommoAllowedStatusIds }];
    cache.contas.set(chave, conta);
  }
  cache.pausadas ??= await getPausedStagesGlobalSet();
  const caladaAtiva = sofiaCaladaLiberada(unit.slug);
  const listas = conta.map((u) => u.kommoAllowedStatusIds ?? []);
  const precisaEsquema = caladaAtiva || listas.some((l) => precisaDoFunil(l, lead.status_id));
  const esquema = precisaEsquema ? await esquemaDaUnidade(unit, kommo).catch(() => null) : null;
  // Sem o esquema não se sabe o nome da etapa nem o funil do 142/143. O webhook, na dúvida, deixa a Sofia
  // responder; aqui a dúvida é a favor de NÃO mexer no cartão: lança e a próxima varredura tenta de novo.
  if (precisaEsquema && !esquema) throw new Error('não li o esquema da conta (etapa 142/143 ou "Sofia calada" dependem dele)');
  const pos = esquema && lead.pipeline_id ? esquema.nomeDoStatus(lead.pipeline_id, lead.status_id) : null;
  const r = iaAtendeNaEtapa({
    unidadesDaConta: conta,
    posicao: { statusId: lead.status_id, pipelineId: lead.pipeline_id, etapa: pos?.status ?? null, funil: pos?.pipeline ?? null },
    funis: esquema,
    etapasPausadasGlobal: cache.pausadas,
    caladaAtiva,
  });
  const descricao = `${pos ? `${pos.pipeline} / ${pos.status}` : `status ${lead.status_id}`} (funil ${lead.pipeline_id})`;
  return r.atende ? { atende: true, motivo: null, descricao } : { atende: false, motivo: r.motivo, descricao };
}

interface CacheDaVarredura {
  contas: Map<string, Array<{ kommoAllowedStatusIds: number[] | null }>>;
  pausadas: Set<string> | null;
}

export function depsPadraoDaVolta(cache: CacheDaVarredura): DepsDaVolta {
  return {
    agora: () => new Date(),
    estado: estadoDaPausaPelaEquipe,
    minutos: () => minutosDaVolta(),
    mensagens: DEPS_PAUSA_EQUIPE_PADRAO.mensagens,
    pausaMarcadaAgora: DEPS_PAUSA_EQUIPE_PADRAO.pausaMarcadaAgora,
    pausaMexidaDesde: DEPS_PAUSA_EQUIPE_PADRAO.pausaMexidaDesde,
    pausaComData: (unit, leadId) => leadPausadoPorJanela(unit.id, leadId),
    etapa: (unit, leadId) => etapaPadrao(unit, leadId, cache),
    desmarcar: async (unit, leadId) => {
      if (unit.kommoPausedFieldId) await createKommoClient(unit).setLeadFieldFlag(leadId, unit.kommoPausedFieldId, false);
    },
    anotar: async (unit, leadId, texto) => {
      await createKommoClient(unit).addLeadNote(leadId, texto);
    },
    encerrar: encerrarPausaDaEquipe,
    simular: registrarSimulacao,
  };
}

/**
 * Uma pausa aberta. Só fala com o Kommo depois de passar pelos filtros baratos (chave, validade, 1 h desde a
 * fala que pausou). Falha em qualquer leitura = não mexe e tenta de novo na próxima varredura.
 */
export async function avaliarPausaAberta(linha: PausaAberta, deps: DepsDaVolta): Promise<ResultadoDaLinha> {
  const unit = linha.unit;
  const leadId = linha.kommoLeadId;
  const agora = deps.agora();
  const minutos = deps.minutos();

  // Validade primeiro e em qualquer estado da chave: é só a nossa linha (não mexe no cartão), e linha velha de
  // unidade desligada não pode lotar a fila das que ainda podem voltar.
  if (agora.getTime() - linha.pausadoEm.getTime() > VALIDADE_DA_PAUSA_MS) {
    await deps.encerrar(linha.id, 'vencida');
    return 'vencida';
  }
  const estado = deps.estado(unit.slug);
  if (estado === 'desligado') return 'chave_desligada';
  if (emPausa(unit, agora)) return 'unidade_pausada';
  // A última fala nunca é mais velha que a que provocou a pausa: se esta ainda não fez 1 h, nada a ler.
  if (agora.getTime() - linha.falaEm.getTime() < minutos * 60_000) return 'cedo';

  const doRegistro: UltimaFala = { em: linha.falaEm, autorNome: linha.falaAutor ?? '' };
  let msgs: MensagemOficial[];
  try {
    msgs = await deps.mensagens(unit, leadId);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe (volta): não li a conversa oficial (tento na próxima)');
    return 'nao_conferi';
  }
  const tempo = passouTempoSemEquipe(msgs, doRegistro, agora, minutos);
  if (!tempo.passou) {
    // A equipe seguiu falando: só vale olhar de novo quando a nova última fala fizer 1 h.
    reverEm.set(linha.id, agora.getTime() + tempo.faltamMs);
    return 'cedo';
  }

  try {
    // Alguém já devolveu à mão, ou mexeu e remarcou: a pausa deixou de ser só nossa.
    if (!(await deps.pausaMarcadaAgora(unit, leadId))) {
      if (estado === 'ligado') await deps.encerrar(linha.id, 'devolvida_por_gente');
      return 'devolvida_por_gente';
    }
    if (await deps.pausaMexidaDesde(unit, leadId, new Date(linha.pausadoEm.getTime() + FOLGA_DA_MARCACAO_MS))) {
      if (estado === 'ligado') await deps.encerrar(linha.id, 'mexida_por_gente');
      return 'mexida_por_gente';
    }
    // Pausa com data (widget) manda enquanto durar; ao vencer, volta a valer a regra de 1 h.
    if (await deps.pausaComData(unit, leadId)) return 'pausa_com_data';
    const etapa = await deps.etapa(unit, leadId);
    if (!etapa.atende) return 'etapa_nao_atende';

    const quem = descreverUltimaFala(tempo.ultima, agora, unit.spineTimezone ?? 'America/Sao_Paulo');
    if (estado === 'seco') {
      deps.simular(unit, AUTOMACAO_PAUSA_EQUIPE, {
        leadId,
        acao: 'gravaria',
        alvo: 'Pausar IA (volta)',
        valor: 'Não',
        motivo: `${minutos} min sem mensagem da equipe (última: ${quem}) e a Sofia atende em ${etapa.descricao}`,
      });
      return 'despausaria';
    }

    await deps.desmarcar(unit, leadId);
    // Já desmarcou no Kommo: falha ao fechar a linha não pode comer a nota (a próxima varredura a fecha como
    // "devolvida_por_gente", porque a caixinha já estará desmarcada).
    await deps.encerrar(linha.id, 'voltou').catch((err) =>
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe (volta): desmarquei mas não consegui fechar a linha (segue)'),
    );
    logger.info({ unit: unit.slug, leadId, ultima: tempo.ultima.autorNome || null, etapa: etapa.descricao }, 'IA voltou: a equipe ficou sem falar com o paciente');
    await deps.anotar(unit, leadId, notaDaVolta(minutos, quem)).catch((err) =>
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe (volta): desmarquei mas não consegui deixar a nota (segue)'),
    );
    return 'voltou';
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'pausa-equipe (volta): falha ao conferir/devolver (tento na próxima)');
    return 'nao_conferi';
  }
}

/**
 * Quanto esperar para olhar de novo uma linha que não deu para devolver agora. Sem isto, cada cartão parado em
 * etapa fechada custaria ~4 chamadas ao Kommo a cada 5 min por até 14 dias.
 */
const REVER_APOS_MS: Partial<Record<ResultadoDaLinha, number>> = {
  etapa_nao_atende: 30 * 60_000,
  pausa_com_data: 30 * 60_000,
  despausaria: 2 * 3600_000,
  nao_conferi: 10 * 60_000,
};
const reverEm = new Map<string, number>();

/** Uma varredura. Devolve quantas linhas deram cada resultado (para log e teste). */
export async function varrerVolta(
  deps?: DepsDaVolta,
  abertas: () => Promise<PausaAberta[]> = pausasAbertas,
): Promise<Record<string, number>> {
  const d = deps ?? depsPadraoDaVolta({ contas: new Map(), pausadas: null });
  const total: Record<string, number> = {};
  const linhas = await abertas();
  const ids = new Set(linhas.map((l) => l.id));
  for (const id of reverEm.keys()) if (!ids.has(id)) reverEm.delete(id);
  for (const linha of linhas) {
    const agora = d.agora().getTime();
    if ((reverEm.get(linha.id) ?? 0) > agora) {
      total.adiada = (total.adiada ?? 0) + 1;
      continue;
    }
    const r = await avaliarPausaAberta(linha, d).catch((err) => {
      logger.warn({ err: String(err), unit: linha.unit.slug, leadId: linha.kommoLeadId }, 'pausa-equipe (volta): linha falhou');
      return 'nao_conferi' as const;
    });
    const espera = REVER_APOS_MS[r];
    if (espera) reverEm.set(linha.id, agora + espera);
    total[r] = (total[r] ?? 0) + 1;
  }
  return total;
}

/** Só para teste. */
export function _limparAdiadas(): void {
  reverEm.clear();
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const t = await varrerVolta();
    if (t.voltou || t.despausaria) logger.info({ ...t }, 'pausa-equipe (volta): varredura');
  } catch (err) {
    logger.warn({ err: String(err) }, 'pausa-equipe (volta): varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startPausaEquipeVoltaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  const bruto = process.env.PAUSA_EQUIPE_VOLTA_MIN;
  if (bruto && !(Number(bruto) > 0)) logger.warn({ bruto }, 'PAUSA_EQUIPE_VOLTA_MIN inválida (use minutos, ex. 60) — valendo 60');
  logger.info({ minutos: minutosDaVolta() }, 'pausa-equipe (volta): worker iniciado (guardado pela chave pausa-equipe)');
}

export function stopPausaEquipeVoltaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
