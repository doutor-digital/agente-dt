import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { claimMessageId } from './dedup-cache.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { isLeadPaused } from '../services/kommo.service.js';
import { guardarRespostaSegurada, marcarNaoEntregue } from '../agent/entrega-falha.js';
import { idsEmVoo } from './agent-coalescer.js';

/**
 * Recuperação no start: o deploy (ou uma queda) matou um turno da IA no meio e ninguém retomou.
 *
 * Caso real (Timbó, lead 5142896, 30/10/2026): 17:00:47 a paciente mandou um áudio e a IA SEGUROU a resposta ("atropelada")
 * porque às 17:01:05 chegou uma foto. A foto esperava a janela do coalescer, em memória; o serviço reiniciou nesse intervalo
 * e o trace ficou RUNNING com um passo só. A paciente ficou sem resposta nenhuma. Na rede, 38 traces RUNNING há mais de
 * 10 min em 24 h, concentrados nas horas de deploy.
 *
 * Regras (cada uma tem um teste):
 *  - só roda no LÍDER do `worker_leases`. No deploy start-first o container antigo segue vivo e atendendo até acabar de
 *    drenar; ele só solta o lease no fim, então "sou o líder" = "o antigo já morreu" e nada ali está só demorando. Sem
 *    isto a varredura tomaria como perdido um turno vivo do antigo e a paciente receberia duas respostas;
 *  - só trace de WhatsApp via Kommo (`kommo_chat`) ainda RUNNING, com idade entre `IDADE_MINIMA_MS` e `IDADE_MAXIMA_MS`
 *    (passado disso a conversa seguiu e responder seria estranho), e que ESTE processo não tenha na fila nem rodando;
 *  - roda de tempos em tempos, não só no boot: o que o antigo recebeu nos últimos segundos antes de morrer ainda é novo
 *    demais na primeira varredura;
 *  - se já existe resposta da IA depois do pedido, não reprocessa;
 *  - IA pausada (unidade, cartão ou janela) não reprocessa — a mesma trava do turno normal;
 *  - UMA vez só: o `claimMessageId` é gravado no banco (vale entre processos e entre starts); se esta recuperação também
 *    morrer, o próximo start encontra a reivindicação e NÃO tenta de novo;
 *  - o pedido volta pelo coalescer (`scheduleAgentRun`), então vários pedidos perdidos do mesmo paciente viram UM turno e
 *    uma mensagem nova dele entra no mesmo turno em vez de abrir um segundo concorrente;
 *  - a resposta que estava "segurada" é restaurada em memória a partir do passo gravado no trace, para o turno responder
 *    as duas mensagens (o `<entrega_falhou>`).
 */

/** Primeira varredura depois do boot, e de quanto em quanto tempo repete (só o líder varre de fato). */
export const ATRASO_INICIAL_MS = 60_000;
export const INTERVALO_MS = 120_000;
/** Depois de virar líder, varre por este tempo e para (cobre as mensagens dos últimos segundos do antigo). */
export const JANELA_APOS_LIDERANCA_MS = 10 * 60_000;
export const IDADE_MINIMA_MS = 120_000;
export const IDADE_MAXIMA_MS = 2 * 60 * 60_000;
/** Reivindicação de outro processo que não terminou há tanto tempo: a tentativa morreu, o trace é fechado como falha. */
export const IDADE_TENTATIVA_MORTA_MS = 15 * 60_000;
export const MAX_POR_VARREDURA = 50;
/** Quanto tempo a reivindicação vale. Maior que `IDADE_MAXIMA_MS`: o trace nunca é candidato duas vezes. */
export const TTL_REIVINDICACAO_MS = 24 * 60 * 60_000;
export const ESCOPO_REIVINDICACAO = 'turno-recuperado';
export const MARCA_ABANDONADO = '__abandoned_by_restart__';

export interface TurnoPerdido {
  traceId: string;
  unitId: string;
  leadId: string;
  criadoEm: Date;
  input: unknown;
}

export interface RespostaSegurada {
  reply: string;
  mensagemId: string | null;
}

/** `retomado`: foi para o coalescer. Outro valor: o motivo de não retomar (o trace é fechado com ele). */
export type ResultadoRetomada = 'retomado' | `descartado:${string}`;

export interface DepsRecuperacao {
  agora(): number;
  /** Traces que este processo tem na fila ou rodando: não estão perdidos, nunca são candidatos. */
  idsEmVoo(): string[];
  /** `excluirIds` entra na consulta (antes do limite): os que estão em voo não podem ocupar as vagas dos perdidos. */
  buscarPerdidos(p: { criadosAntes: Date; criadosDepois: Date; limite: number; excluirIds: string[] }): Promise<TurnoPerdido[]>;
  /** Já existe mensagem da IA para este paciente depois do pedido? */
  respondidoDepois(t: TurnoPerdido): Promise<boolean>;
  iaPausada(unitId: string, leadId: string): Promise<boolean>;
  /** Atômico e permanente: `true` só para o primeiro que pedir, em qualquer processo. */
  reivindicar(traceId: string): Promise<boolean>;
  /** Respostas seguradas ("atropelada") deste paciente que ele nunca leu, mais antigas primeiro. */
  seguradasPendentes(unitId: string, leadId: string, aPartirDe: Date): Promise<RespostaSegurada[]>;
  restaurarSegurada(unitId: string, leadId: string, s: RespostaSegurada): void;
  retomar(t: TurnoPerdido): Promise<ResultadoRetomada>;
  /** Fecha o trace (só se ainda estiver RUNNING). */
  encerrar(traceId: string, status: 'SUCCESS' | 'FAILED', motivo: string): Promise<void>;
}

export interface ResumoRecuperacao {
  candidatos: number;
  retomados: number;
  descartados: Record<string, number>;
}

export async function recuperarTurnosPerdidos(deps: DepsRecuperacao): Promise<ResumoRecuperacao> {
  const agora = deps.agora();
  const resumo: ResumoRecuperacao = { candidatos: 0, retomados: 0, descartados: {} };
  const descartar = (motivo: string): void => {
    resumo.descartados[motivo] = (resumo.descartados[motivo] ?? 0) + 1;
  };

  const emVoo = new Set(deps.idsEmVoo());
  const perdidos = (
    await deps.buscarPerdidos({
      criadosAntes: new Date(agora - IDADE_MINIMA_MS),
      criadosDepois: new Date(agora - IDADE_MAXIMA_MS),
      limite: MAX_POR_VARREDURA,
      excluirIds: [...emVoo],
    })
  ).filter((t) => !emVoo.has(t.traceId)); // de novo, por garantia: quem implementa a consulta pode ignorar o filtro
  resumo.candidatos = perdidos.length;
  if (perdidos.length === 0) return resumo;

  // Um paciente por vez; dentro dele, na ordem em que escreveu.
  const porPaciente = new Map<string, TurnoPerdido[]>();
  for (const t of [...perdidos].sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime())) {
    const k = `${t.unitId}::${t.leadId}`;
    porPaciente.set(k, [...(porPaciente.get(k) ?? []), t]);
  }

  for (const turnos of porPaciente.values()) {
    try {
      await recuperarDoPaciente(deps, turnos, agora, resumo, descartar);
    } catch (err) {
      // Um paciente com problema não pode impedir a recuperação dos outros.
      logger.error({ err: String(err), leadId: turnos[0]?.leadId, unitId: turnos[0]?.unitId }, 'recuperar-turnos: falha ao recuperar um paciente (segue com os outros)');
    }
  }
  return resumo;
}

async function recuperarDoPaciente(
  deps: DepsRecuperacao,
  turnos: TurnoPerdido[],
  agora: number,
  resumo: ResumoRecuperacao,
  descartar: (motivo: string) => void,
): Promise<void> {
  const { unitId, leadId } = turnos[0]!;

  // Cada pedido é julgado sozinho: o primeiro pode ter sido respondido (trace que só não fechou) e o segundo não.
  const semResposta: TurnoPerdido[] = [];
  for (const t of turnos) {
    if (await deps.respondidoDepois(t)) {
      await deps.encerrar(t.traceId, 'SUCCESS', 'ja_respondida');
      descartar('ja_respondida');
    } else {
      semResposta.push(t);
    }
  }
  if (semResposta.length === 0) return;

  if (await deps.iaPausada(unitId, leadId)) {
    for (const t of semResposta) {
      await deps.encerrar(t.traceId, 'SUCCESS', 'ia_pausada');
      descartar('ia_pausada');
    }
    return;
  }

  // Uma vez só, em qualquer processo, em qualquer start.
  const meus: TurnoPerdido[] = [];
  for (const t of semResposta) {
    if (await deps.reivindicar(t.traceId)) {
      meus.push(t);
    } else if (agora - t.criadoEm.getTime() > IDADE_TENTATIVA_MORTA_MS) {
      await deps.encerrar(t.traceId, 'FAILED', 'recuperacao_ja_tentada');
      descartar('recuperacao_ja_tentada');
    } else {
      descartar('outro_processo_cuida');
    }
  }
  if (meus.length === 0) return;

  // Lidas ANTES de retomar (o turno nasce na janela do coalescer e não pode esperar o banco), aplicadas DEPOIS.
  const seguradas = await deps.seguradasPendentes(unitId, leadId, meus[0]!.criadoEm).catch(() => [] as RespostaSegurada[]);
  let restaurou = false;
  for (const t of meus) {
    let r: ResultadoRetomada;
    try {
      r = await deps.retomar(t);
    } catch (err) {
      logger.error({ err: String(err), traceId: t.traceId, leadId }, 'recuperar-turnos: falha ao retomar o turno');
      await deps.encerrar(t.traceId, 'FAILED', 'falha_ao_retomar');
      descartar('falha_ao_retomar');
      continue;
    }
    if (r === 'retomado') {
      resumo.retomados++;
      if (!restaurou) {
        // A resposta que a IA segurou porque o paciente escreveu de novo não saiu e vive só na memória do processo morto.
        // Só DEPOIS de haver um turno a caminho (a janela do coalescer ainda não fechou): sem turno, a marca ficaria
        // na memória até a próxima mensagem do paciente e a IA pediria desculpa por algo que a conversa já passou.
        restaurou = true;
        for (const s of seguradas) deps.restaurarSegurada(unitId, leadId, s);
      }
    } else {
      await deps.encerrar(t.traceId, 'SUCCESS', r.slice('descartado:'.length));
      descartar(r.slice('descartado:'.length));
    }
  }
}

// ── produção ───────────────────────────────────────────────────────────────────────────────────────────

const TITULO_SEGURADA = '⏭ Resposta segurada';

/** As dependências de verdade: banco, Kommo e a memória do processo. `retomar` vem do controller (precisa do processAgent). */
export function depsDeProducao(retomar: (t: TurnoPerdido) => Promise<ResultadoRetomada>): DepsRecuperacao {
  return {
    agora: () => Date.now(),
    idsEmVoo: idsEmVoo,
    retomar,
    async buscarPerdidos({ criadosAntes, criadosDepois, limite, excluirIds }) {
      const linhas = await prisma.executionTrace.findMany({
        where: {
          channel: 'kommo_chat',
          status: 'RUNNING',
          unitId: { not: null },
          createdAt: { lt: criadosAntes, gt: criadosDepois },
          ...(excluirIds.length ? { id: { notIn: excluirIds } } : {}),
        },
        orderBy: { createdAt: 'asc' },
        take: limite,
        select: { id: true, unitId: true, leadId: true, createdAt: true, input: true },
      });
      return linhas.map((l) => ({ traceId: l.id, unitId: l.unitId!, leadId: l.leadId, criadoEm: l.createdAt, input: l.input }));
    },
    async respondidoDepois(t) {
      // `traceId` não nulo = resposta de um TURNO da IA. Follow-up, reativação e lembrete também gravam role 'assistant',
      // mas sem trace, e não respondem ao que o paciente escreveu.
      const n = await prisma.message.count({
        where: { role: 'assistant', traceId: { not: null }, createdAt: { gt: t.criadoEm }, conversation: { unitId: t.unitId, leadId: t.leadId } },
      });
      return n > 0;
    },
    async iaPausada(unitId, leadId) {
      try {
        const unit = await prisma.unit.findUnique({ where: { id: unitId } });
        if (!unit) return true; // unidade sumiu: não há IA a retomar
        if (emPausa(unit)) return true;
        if (await leadPausadoPorJanela(unit.id, Number(leadId))) return true;
        return await isLeadPaused(unit, Number(leadId));
      } catch (err) {
        // Falha ao perguntar não decide: o turno normal confere tudo de novo antes de gerar e antes de enviar.
        logger.warn({ err: String(err), unitId, leadId }, 'recuperar-turnos: não consegui conferir a pausa (o turno confere de novo)');
        return false;
      }
    },
    reivindicar: (traceId) => claimMessageId(ESCOPO_REIVINDICACAO, traceId, TTL_REIVINDICACAO_MS),
    async seguradasPendentes(unitId, leadId, aPartirDe) {
      // O que a IA segurou e ninguém entregou: depois da última resposta que saiu e até meia hora antes do pedido perdido.
      const ultima = await prisma.message.findFirst({
        where: { role: 'assistant', traceId: { not: null }, conversation: { unitId, leadId } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const piso = new Date(aPartirDe.getTime() - 30 * 60_000);
      const desde = ultima && ultima.createdAt > piso ? ultima.createdAt : piso;
      const passos = await prisma.executionStep.findMany({
        where: {
          kind: 'THINKING',
          title: { startsWith: TITULO_SEGURADA },
          // Sem teto de cima: a resposta é segurada DEPOIS que o pedido perdido chegou (é por causa dele que foi segurada).
          createdAt: { gt: desde },
          trace: { unitId, leadId },
        },
        orderBy: { createdAt: 'asc' },
        select: { payload: true },
      });
      const r: RespostaSegurada[] = [];
      for (const p of passos) {
        const payload = (p.payload ?? {}) as { reply?: unknown; mensagemId?: unknown };
        if (typeof payload.reply === 'string' && payload.reply.trim()) {
          r.push({ reply: payload.reply, mensagemId: typeof payload.mensagemId === 'string' ? payload.mensagemId : null });
        }
      }
      return r;
    },
    restaurarSegurada(unitId, leadId, s) {
      marcarNaoEntregue(unitId, leadId, s.reply, Date.now(), 'atropelada');
      guardarRespostaSegurada(unitId, leadId, s.mensagemId);
    },
    async encerrar(traceId, status, motivo) {
      // `status: RUNNING` no filtro: nunca sobrescreve um turno que terminou de verdade entre a busca e agora.
      await prisma.executionTrace.updateMany({
        where: { id: traceId, status: 'RUNNING' },
        data: {
          status,
          iaDecision: `${MARCA_ABANDONADO}:${motivo}`,
          ...(status === 'FAILED' ? { errorMessage: `abandonado: o serviço reiniciou no meio do turno (${motivo})` } : {}),
        },
      });
    },
  };
}

/**
 * Uma volta da varredura: só o líder do `worker_leases` (= o container antigo já soltou o lease no fim da drenagem).
 * Devolve `null` quando não é o líder.
 */
export async function varrerSeLider(deps: DepsRecuperacao, souLider: () => boolean): Promise<ResumoRecuperacao | null> {
  if (!souLider()) return null;
  return recuperarTurnosPerdidos(deps);
}

/**
 * Liga a varredura periódica (primeira em `ATRASO_INICIAL_MS`, depois a cada `INTERVALO_MS`). Devolve a função que
 * desliga, para o shutdown chamar. Uma volta nunca começa em cima da outra.
 */
export function agendarRecuperacao(
  retomar: (t: TurnoPerdido) => Promise<ResultadoRetomada>,
  souLider: () => boolean,
): () => void {
  if (process.env.RECUPERAR_TURNOS_DESLIGADO === '1') {
    logger.info('recuperar-turnos: desligado por RECUPERAR_TURNOS_DESLIGADO=1');
    return () => undefined;
  }
  const deps = depsDeProducao(retomar);
  let parado = false;
  let timer: NodeJS.Timeout | null = null;
  // A janela conta a partir de quando ESTE processo virou líder (= o antigo morreu): só o que o deploy/queda deixou
  // para trás interessa. Trace RUNNING fora disso é outra coisa (um caminho que não fecha o trace?) e reprocessá-lo
  // seria responder de novo a quem pode já ter sido respondido — fica para investigar, não para refazer.
  let lideradoEm: number | null = null;
  const proxima = (ms: number): void => {
    if (parado) return;
    timer = setTimeout(() => {
      // Perdeu a liderança: a janela fecha e, se reassumir (banco instável, novo deploy), abre de novo.
      if (!souLider()) lideradoEm = null;
      else if (lideradoEm === null) lideradoEm = Date.now();
      if (lideradoEm === null || Date.now() - lideradoEm > JANELA_APOS_LIDERANCA_MS) {
        proxima(INTERVALO_MS);
        return;
      }
      varrerSeLider(deps, souLider)
        .then((r) => {
          if (r && r.candidatos > 0) logger.info(r, 'recuperar-turnos: varredura concluída');
        })
        .catch((err) => logger.error({ err: String(err) }, 'recuperar-turnos: varredura falhou'))
        .finally(() => proxima(INTERVALO_MS));
    }, ms);
    timer.unref();
  };
  proxima(ATRASO_INICIAL_MS);
  return () => {
    parado = true;
    if (timer) clearTimeout(timer);
  };
}
