// ============================================================================
// agent-coalescer.ts — Junta mensagens em rajada numa única execução do agente.
//
// PROBLEMA QUE RESOLVE
// --------------------
// Paciente manda 3 mensagens em sequência ("oi", "tudo bem?", "quero marcar").
// Cada uma vira um webhook do Kommo, cada webhook dispara `processAgent` em
// paralelo. Resultado: 3 runs concorrentes da IA, 3 respostas duplicadas,
// possível corrupção do checkpoint do LangGraph (que é por thread_id).
//
// SOLUÇÃO
// -------
// Janela de debounce por lead. Quando chega uma mensagem:
//  - Se já tem buffer aberto pro lead: anexa a mensagem, REINICIA o timer.
//  - Se não tem: abre buffer + agenda timer.
// Quando o timer expira (3s de silêncio):
//  - Combina mensagens com "\n\n"
//  - Roda `processAgent` UMA vez
//  - O trace usado é o do PRIMEIRO webhook do burst; webhooks seguintes só
//    registram step "coalescida no trace X" no recorder próprio e somem.
//
// LIMITAÇÕES
// ----------
// - In-memory: se o processo reiniciar no meio de um burst, as mensagens
//   bufferizadas se perdem (mas o histórico de Message do banco preserva
//   tudo — o agente só vai ver "uma a uma" em vez de coalescido). Aceitável.
// - Single-process. Pra escalar horizontalmente, mover pra Redis pub/sub.
// ============================================================================

import { logger } from './logger.js';

const COALESCE_WINDOW_MS = 8_000;       // 8s de silêncio antes de rodar
const MAX_BURST_DURATION_MS = 30_000;   // hard cap: nunca segura mais de 30s
const MAX_MESSAGES_PER_BURST = 20;      // safety: evita memória crescente sem limite

interface PendingMessage {
  text: string;
  audioUrl: string | null;
  arrivedAt: number;
  /** traceId do webhook que trouxe ESTA mensagem em particular. */
  traceId: string;
}

interface BufferEntry {
  /** Quando o buffer abriu (1ª mensagem do burst). */
  openedAt: number;
  /** Timer atual de debounce. Null quando o flush está em execução. */
  timer: NodeJS.Timeout | null;
  /** Hard-cap timer — força flush mesmo se mensagens não param. Null durante o running. */
  maxTimer: NodeJS.Timeout | null;
  /** Mensagens acumuladas, em ordem de chegada. */
  pending: PendingMessage[];
  /** Função que roda quando o timer expira (closure preservando args do 1º webhook). */
  flush: (combined: string, audioUrls: string[], traceIds: string[]) => Promise<void>;
  /**
   * Flag de execução. Verdadeira enquanto um flush() está rodando.
   * Mensagens que chegam neste estado SÃO acumuladas em `pending` mas NÃO
   * disparam novo timer — quando o flush atual termina, se sobrou `pending`,
   * agendamos um novo flush em sequência. Isso evita 2 processAgent
   * concorrentes para o mesmo lead (causa raiz da resposta duplicada).
   */
  running: boolean;
}

const buffers = new Map<string, BufferEntry>();

/** Chave única por lead (Unit + leadId). Evita colisão entre tenants. */
function bufferKey(unitSlug: string, leadId: number | string): string {
  return `${unitSlug}::${leadId}`;
}

/**
 * Agenda (ou anexa a) um run do agente com debounce.
 *
 * @returns 'started'   — primeiro do burst, timer iniciado
 *          'joined'    — burst em curso, mensagem anexada
 *          'rejected'  — burst cheio, processou sozinho (raro)
 */
export function scheduleAgentRun(args: {
  unitSlug: string;
  leadId: number;
  traceId: string;
  humanMessage: string;
  audioUrl: string | null;
  /**
   * Função que de fato roda o agente. Recebe a mensagem combinada de todo o
   * burst + a lista de audioUrls + a lista de traceIds (pra que o caller
   * possa associar a execução a todos os webhooks que entraram).
   *
   * Só é chamada UMA vez, quando o debounce expirar.
   */
  run: (combined: string, audioUrls: string[], traceIds: string[]) => Promise<void>;
}): 'started' | 'joined' | 'rejected' {
  const key = bufferKey(args.unitSlug, args.leadId);
  const existing = buffers.get(key);
  const now = Date.now();

  const newMsg: PendingMessage = {
    text: args.humanMessage,
    audioUrl: args.audioUrl,
    arrivedAt: now,
    traceId: args.traceId,
  };

  if (existing) {
    // Hard cap de mensagens — se exceder, deixa a próxima criar seu próprio
    // burst em vez de inflar o atual indefinidamente.
    if (existing.pending.length >= MAX_MESSAGES_PER_BURST) {
      logger.warn(
        { key, count: existing.pending.length },
        'coalescer: burst cheio, mensagem nova será processada em novo run',
      );
      return 'rejected';
    }
    // Sempre atualiza a closure pra refletir args do webhook mais recente
    // (ex: chatId/talkId podem variar entre msgs — usamos a mais recente).
    existing.flush = args.run;
    existing.pending.push(newMsg);
    if (existing.running) {
      // Flush em curso: NÃO agenda timer. Quando o flush atual terminar
      // ele detecta `pending.length > 0` e re-agenda automaticamente.
      logger.debug(
        { key, count: existing.pending.length },
        'coalescer: msg anexada durante flush em curso (sem novo timer)',
      );
      return 'joined';
    }
    // Caso normal: anexa + reinicia timer.
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => fire(key), COALESCE_WINDOW_MS);
    logger.debug(
      { key, count: existing.pending.length, sinceOpen: now - existing.openedAt },
      'coalescer: mensagem anexada ao burst',
    );
    return 'joined';
  }

  // Primeira do burst — guarda flush (closure com `run` do caller).
  const entry: BufferEntry = {
    openedAt: now,
    pending: [newMsg],
    flush: args.run,
    timer: setTimeout(() => fire(key), COALESCE_WINDOW_MS),
    maxTimer: setTimeout(() => fire(key), MAX_BURST_DURATION_MS),
    running: false,
  };
  buffers.set(key, entry);
  logger.debug({ key }, 'coalescer: burst iniciado');
  return 'started';
}

/**
 * Dispara o flush do buffer.
 *
 * Mantém o entry no map durante toda a execução com `running=true`, pra que
 * mensagens chegando enquanto a IA responde sejam ENFILEIRADAS no mesmo entry
 * em vez de criarem um burst paralelo. Quando o flush termina, se sobrou
 * `pending`, reagenda automaticamente — garantindo execução SERIAL por lead.
 *
 * Idempotente: chamado 2x (timer + maxTimer concorrendo) o segundo encontra
 * `running=true` ou `pending.length=0` e sai.
 */
function fire(key: string): void {
  const entry = buffers.get(key);
  if (!entry) return;
  if (entry.running) {
    // Outro fire já está executando — não disparamos paralelamente.
    return;
  }
  if (entry.pending.length === 0) {
    // Nada pra processar (raro: maxTimer disparou após flush limpar tudo).
    buffers.delete(key);
    return;
  }

  if (entry.timer) clearTimeout(entry.timer);
  if (entry.maxTimer) clearTimeout(entry.maxTimer);
  entry.timer = null;
  entry.maxTimer = null;

  // Snapshot do que vamos processar; esvazia o buffer pra acumular novas msgs.
  const messages = entry.pending.splice(0, entry.pending.length);
  const combined = messages.map((m) => m.text).join('\n\n');
  const audioUrls = messages.map((m) => m.audioUrl).filter((u): u is string => !!u);
  const traceIds = messages.map((m) => m.traceId);
  const flush = entry.flush;
  entry.running = true;

  logger.info(
    {
      key,
      count: messages.length,
      duration: Date.now() - entry.openedAt,
      preview: combined.slice(0, 80),
    },
    messages.length > 1
      ? 'coalescer: flush — combinando burst em 1 turno'
      : 'coalescer: flush — mensagem única',
  );

  // Fire-and-forget. Erros propagados pelo logger do próprio flush.
  // Importante: tudo após o flush precisa rodar via .finally() pra liberar
  // o lock independente de sucesso/erro.
  void flush(combined, audioUrls, traceIds)
    .catch((err) => {
      logger.error({ err, key }, 'coalescer: erro no flush');
    })
    .finally(() => {
      const cur = buffers.get(key);
      if (!cur) return;
      cur.running = false;
      if (cur.pending.length > 0) {
        // Mensagens chegaram durante a execução — reagenda outro turno em
        // sequência. Usa janela curta porque o usuário pode estar parado já.
        logger.info(
          { key, count: cur.pending.length },
          'coalescer: msgs chegaram durante flush — encadeando próximo turno',
        );
        cur.timer = setTimeout(() => fire(key), COALESCE_WINDOW_MS);
        cur.maxTimer = setTimeout(() => fire(key), MAX_BURST_DURATION_MS);
        cur.openedAt = Date.now();
      } else {
        buffers.delete(key);
      }
    });
}

/** Só pra observabilidade/testes. */
export function _coalescerStats(): { activeBursts: number } {
  return { activeBursts: buffers.size };
}

/** Força flush imediato de todos os buffers — usado em shutdown gracioso. */
export function flushAll(): void {
  for (const key of Array.from(buffers.keys())) fire(key);
}
