import { motion } from 'framer-motion';
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Inbox,
  Wrench,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { useState } from 'react';
import type { ExecutionStep, StepKind } from '../types/api';

const KIND_STYLE: Record<
  StepKind,
  { icon: typeof Brain; emoji: string; label: string; color: string; ring: string }
> = {
  WEBHOOK_RECEIVED: {
    icon: Inbox,
    emoji: '📥',
    label: 'Payload',
    color: 'text-sky-300',
    ring: 'ring-sky-500/40 bg-sky-500/10',
  },
  THINKING: {
    icon: Brain,
    emoji: '🧠',
    label: 'Thinking',
    color: 'text-brand-300',
    ring: 'ring-brand-500/40 bg-brand-500/10',
  },
  TOOL_CALL: {
    icon: Wrench,
    emoji: '🛠️',
    label: 'Tool call',
    color: 'text-amber-300',
    ring: 'ring-amber-500/40 bg-amber-500/10',
  },
  TOOL_RESULT: {
    icon: ChevronRight,
    emoji: '↩️',
    label: 'Tool result',
    color: 'text-zinc-300',
    ring: 'ring-zinc-500/40 bg-zinc-500/10',
  },
  KOMMO_ACTION: {
    icon: Zap,
    emoji: '⚡',
    label: 'Kommo',
    color: 'text-violet-300',
    ring: 'ring-violet-500/40 bg-violet-500/10',
  },
  COMPLETED: {
    icon: CheckCircle2,
    emoji: '✅',
    label: 'Done',
    color: 'text-emerald-300',
    ring: 'ring-emerald-500/40 bg-emerald-500/10',
  },
  ERROR: {
    icon: AlertCircle,
    emoji: '❌',
    label: 'Erro',
    color: 'text-rose-300',
    ring: 'ring-rose-500/40 bg-rose-500/10',
  },
};

function latencyTone(ms: number | null): string {
  if (ms == null) return 'text-zinc-500';
  if (ms < 500) return 'text-emerald-400';
  if (ms < 2000) return 'text-amber-300';
  return 'text-rose-400';
}

/**
 * Um "passo" do raciocínio renderizado no feed vertical.
 * Animação Framer Motion controla a entrada (slide+fade) com delay
 * incremental por sequence — assim ao abrir um trace o feed "digita"
 * sozinho de cima pra baixo (vibe terminal AgentGPT).
 */
export function TraceStep({ step, index }: { step: ExecutionStep; index: number }) {
  const cfg = KIND_STYLE[step.kind];
  const Icon = cfg.icon;
  const [open, setOpen] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.06, 0.6), duration: 0.25 }}
      className="relative pl-12 pb-5 last:pb-0"
    >
      {/* linha tracejada vertical entre nós */}
      <span className="absolute left-[15px] top-7 bottom-0 w-px timeline-line" />

      {/* nó (ícone) */}
      <div
        className={clsx(
          'absolute left-0 top-0.5 w-8 h-8 rounded-lg flex items-center justify-center ring-1',
          cfg.ring,
        )}
      >
        <Icon className={cfg.color} size={16} />
      </div>

      {/* card */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/50 hover:bg-zinc-900/80 transition">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full text-left px-3 py-2.5 flex items-start gap-3"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">
              <span>{cfg.emoji}</span>
              <span>{cfg.label}</span>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-600">#{step.sequence}</span>
              {step.latencyMs != null && (
                <>
                  <span className="text-zinc-700">·</span>
                  <span className={clsx('font-mono', latencyTone(step.latencyMs))}>
                    {step.latencyMs}ms
                  </span>
                </>
              )}
            </div>
            <div className="text-sm text-zinc-100 font-medium leading-snug">{step.title}</div>
          </div>
          {step.payload != null && (
            <ChevronRight
              size={14}
              className={clsx(
                'text-zinc-500 transition-transform shrink-0 mt-1',
                open && 'rotate-90',
              )}
            />
          )}
        </button>

        {open && step.payload != null && (
          <pre className="px-3 pb-3 text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-words border-t border-zinc-800/80 pt-2 max-h-64 overflow-auto">
            {JSON.stringify(step.payload, null, 2)}
          </pre>
        )}
      </div>
    </motion.div>
  );
}
