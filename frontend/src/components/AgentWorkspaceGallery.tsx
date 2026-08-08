    // ============================================================================
// AgentWorkspaceGallery — MESMO conteúdo do AgentWorkspace (Identidade →
// Conhecimento → Ações → Kommo → Testar), mas com 5 CASCAS visuais diferentes
// pra escolher. Um seletor no topo troca o estilo ao vivo. Quando o João
// escolher, a gente extrai o vencedor e vira o AgentWorkspace definitivo.
//
// Só a CASCA muda (barra de seções + animações + fundo). O corpo de cada
// seção é o painel real (WizardPanel, FontesPanel…), renderizado uma vez.
// ============================================================================

import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import {
  UserRound,
  BookOpen,
  Zap,
  Cable,
  TestTube2,
  Wand2,
  FileText,
  GraduationCap,
  Database,
  Wrench,
  Palette,
} from 'lucide-react';
import { WizardPanel } from './WizardPanel';
import { FontesPanel } from './FontesPanel';
import { AcoesPanel } from './AcoesPanel';
import { CapturesPanel } from './CapturesPanel';
import { FerramentasPanel } from './FerramentasPanel';
import { PlaygroundPanel } from './PlaygroundPanel';
import { TrainingPanel } from './TrainingPanel';
import { AgentConfigPanel } from './AgentConfigPanel';

type SegId = 'identidade' | 'conhecimento' | 'acoes' | 'kommo' | 'testar';
type Icon = typeof Wand2;

interface SubPanel {
  id: string;
  label: string;
  icon: Icon;
  render: (go: (seg: SegId) => void) => ReactNode;
}
interface Segment {
  id: SegId;
  label: string;
  icon: Icon;
  hint: string;
  subs: SubPanel[];
}

const SEGMENTS: Segment[] = [
  {
    id: 'identidade',
    label: 'Identidade',
    icon: UserRound,
    hint: 'Quem é o agente — nome, tom, persona e o que ele sabe fazer.',
    subs: [{ id: 'persona', label: 'Persona', icon: Wand2, render: () => <WizardPanel /> }],
  },
  {
    id: 'conhecimento',
    label: 'Conhecimento',
    icon: BookOpen,
    hint: 'O que o agente sabe — fontes de informação e material de treino.',
    subs: [
      { id: 'fontes', label: 'Fontes', icon: FileText, render: () => <FontesPanel /> },
      { id: 'treinar', label: 'Treinar', icon: GraduationCap, render: (go) => <TrainingPanel onNavigate={() => go('testar')} /> },
    ],
  },
  {
    id: 'acoes',
    label: 'Ações',
    icon: Zap,
    hint: 'O que o agente faz — ações no CRM, captura de dados e ferramentas.',
    subs: [
      { id: 'acoes', label: 'Ações', icon: Zap, render: () => <AcoesPanel /> },
      { id: 'captura', label: 'Captura', icon: Database, render: () => <CapturesPanel /> },
      { id: 'ferramentas', label: 'Ferramentas', icon: Wrench, render: () => <FerramentasPanel /> },
    ],
  },
  {
    id: 'kommo',
    label: 'Kommo',
    icon: Cable,
    hint: 'A conexão — campo de resposta e pausa, Salesbot e etapas em que responde.',
    subs: [{ id: 'conexao', label: 'Conexão', icon: Cable, render: () => <AgentConfigPanel /> }],
  },
  {
    id: 'testar',
    label: 'Testar',
    icon: TestTube2,
    hint: 'Converse com o agente e veja as ações que ele dispara — antes de colocar no ar.',
    subs: [{ id: 'playground', label: 'Playground', icon: TestTube2, render: () => <PlaygroundPanel /> }],
  },
];

// ── Estado compartilhado por todas as cascas ─────────────────────────────────
interface Shell {
  seg: Segment;
  sub: SubPanel;
  segId: SegId;
  subId: string;
  stepIndex: number;
  setSubId: (id: string) => void;
  goSeg: (id: SegId) => void;
  body: ReactNode;
}

// ════════════════════════════════════════════════════════════════════════════
// ESTILO 1 — NEON PULSE  (barra de comando em vidro, glow que desliza)
// ════════════════════════════════════════════════════════════════════════════
function NeonPulse({ seg, sub, segId, stepIndex, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden relative bg-zinc-950">
      <div className="absolute inset-0 pointer-events-none opacity-[0.35] gw-grid" />
      <div className="shrink-0 px-4 pt-4 pb-3 relative z-10">
        <div className="flex items-center gap-1.5 p-1.5 rounded-2xl bg-zinc-900/60 backdrop-blur-xl border border-zinc-800/80 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.6)] overflow-x-auto">
          {SEGMENTS.map((s, i) => {
            const SIcon = s.icon;
            const active = s.id === segId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => goSeg(s.id)}
                className={clsx(
                  'relative inline-flex items-center gap-2 px-4 py-2 text-[13px] rounded-xl whitespace-nowrap shrink-0 transition-colors',
                  active ? 'text-white font-semibold' : 'text-zinc-400 hover:text-zinc-100',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="neon-glow"
                    className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-500/90 to-cyan-400/80 shadow-[0_0_24px_-2px_var(--color-brand-500)]"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-2">
                  <span className={clsx('w-5 h-5 rounded-md flex items-center justify-center', active ? 'bg-white/20' : 'bg-zinc-800')}>
                    <SIcon size={12} />
                  </span>
                  {s.label}
                  <span className={clsx('text-[10px] tabular-nums', active ? 'text-white/70' : 'text-zinc-600')}>0{i + 1}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 mt-3 px-1">
          <p className="text-[12px] text-zinc-500">{seg.hint}</p>
          {seg.subs.length > 1 && <SubNav variant="pill" subs={seg.subs} activeId={sub.id} onPick={setSubId} />}
        </div>
      </div>
      <Body stepIndex={stepIndex} subId={sub.id} body={body} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ESTILO 2 — HUD RAIL  (trilho lateral estilo cockpit, espinha de progresso)
// ════════════════════════════════════════════════════════════════════════════
function HudRail({ seg, sub, segId, stepIndex, setSubId, goSeg, body }: Shell) {
  const pct = (stepIndex / (SEGMENTS.length - 1)) * 100;
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-zinc-950">
      <div className="shrink-0 w-[220px] border-r border-zinc-800/80 bg-zinc-900/40 backdrop-blur-xl relative py-4 px-3">
        <div className="absolute left-[26px] top-8 bottom-8 w-px bg-zinc-800">
          <motion.div className="absolute top-0 left-0 w-px bg-gradient-to-b from-cyan-400 to-brand-500 shadow-[0_0_8px] shadow-cyan-400/60" animate={{ height: `${pct}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
        </div>
        <div className="text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-600 px-2 mb-3">Setup</div>
        <div className="flex flex-col gap-1 relative">
          {SEGMENTS.map((s, i) => {
            const SIcon = s.icon;
            const active = s.id === segId;
            const done = i < stepIndex;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)} className={clsx('relative flex items-center gap-3 pl-1 pr-2 py-2 rounded-lg transition-colors group', active ? 'text-cyan-200' : 'text-zinc-400 hover:text-zinc-100')}>
                {active && <motion.span layoutId="hud-bg" className="absolute inset-0 rounded-lg bg-cyan-400/10 border border-cyan-400/30" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
                <span className={clsx('relative z-10 w-[18px] h-[18px] rounded-md flex items-center justify-center border transition-colors', active ? 'bg-cyan-400 border-cyan-300 text-zinc-950' : done ? 'bg-brand-500/30 border-brand-500/50 text-brand-200' : 'bg-zinc-900 border-zinc-700 text-zinc-500')}>
                  <SIcon size={11} />
                </span>
                <span className="relative z-10 text-[13px] font-medium">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="shrink-0 flex items-center justify-between gap-4 px-5 py-3.5 border-b border-zinc-800/80">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            <p className="text-[12px] text-zinc-400 font-mono">{seg.hint}</p>
          </div>
          {seg.subs.length > 1 && <SubNav variant="hud" subs={seg.subs} activeId={sub.id} onPick={setSubId} />}
        </div>
        <Body stepIndex={stepIndex} subId={sub.id} body={body} />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ESTILO 3 — ORBIT CARDS  (cartões com anel de progresso, brilho que varre)
// ════════════════════════════════════════════════════════════════════════════
function OrbitCards({ seg, sub, segId, stepIndex, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-950">
      <div className="shrink-0 px-4 pt-4 pb-3">
        <div className="flex items-stretch gap-2.5 overflow-x-auto pb-1">
          {SEGMENTS.map((s, i) => {
            const SIcon = s.icon;
            const active = s.id === segId;
            const done = i < stepIndex;
            return (
              <motion.button
                key={s.id}
                type="button"
                onClick={() => goSeg(s.id)}
                animate={{ y: active ? -3 : 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                className={clsx(
                  'relative flex-1 min-w-[130px] overflow-hidden rounded-2xl border px-4 py-3 text-left transition-colors',
                  active ? 'border-brand-500/50 bg-gradient-to-br from-brand-500/15 to-zinc-900 shadow-[0_10px_40px_-14px_var(--color-brand-500)]' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700',
                )}
              >
                {active && <span className="absolute inset-0 gw-shimmer pointer-events-none" />}
                <div className="relative flex items-center gap-2.5">
                  <span className="relative w-9 h-9 shrink-0">
                    <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
                      <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-zinc-800" />
                      <motion.circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" strokeLinecap="round" className={active ? 'stroke-brand-400' : done ? 'stroke-brand-600' : 'stroke-zinc-700'} strokeDasharray={2 * Math.PI * 15} animate={{ strokeDashoffset: 2 * Math.PI * 15 * (1 - (i + 1) / SEGMENTS.length) }} transition={{ duration: 0.6, ease: 'easeOut' }} />
                    </svg>
                    <span className={clsx('absolute inset-0 flex items-center justify-center', active ? 'text-brand-200' : 'text-zinc-400')}><SIcon size={15} /></span>
                  </span>
                  <div className="min-w-0">
                    <div className="text-[10px] font-mono text-zinc-600">PASSO 0{i + 1}</div>
                    <div className={clsx('text-[13px] font-semibold truncate', active ? 'text-white' : 'text-zinc-300')}>{s.label}</div>
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 mt-2.5 px-1">
          <p className="text-[12px] text-zinc-500">{seg.hint}</p>
          {seg.subs.length > 1 && <SubNav variant="pill" subs={seg.subs} activeId={sub.id} onPick={setSubId} />}
        </div>
      </div>
      <Body stepIndex={stepIndex} subId={sub.id} body={body} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ESTILO 4 — TERMINAL  (janela de console, fonte mono, cursor piscando)
// ════════════════════════════════════════════════════════════════════════════
function Terminal({ seg, sub, segId, stepIndex, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-[#0a0e0a]">
      <div className="shrink-0 px-4 pt-3.5 pb-2 font-mono">
        <div className="flex items-center gap-2 px-2 pb-2.5">
          <span className="w-3 h-3 rounded-full bg-red-500/80" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <span className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="ml-2 text-[11px] text-emerald-500/70">sofia@doutorhernia:~/configurar-agente</span>
        </div>
        <div className="flex items-end gap-0.5 border-b border-emerald-900/60 overflow-x-auto">
          {SEGMENTS.map((s, i) => {
            const active = s.id === segId;
            const done = i < stepIndex;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)} className={clsx('relative px-3.5 py-2 text-[12px] whitespace-nowrap shrink-0 rounded-t-md border border-b-0 transition-colors', active ? 'bg-emerald-500/10 border-emerald-700/60 text-emerald-300' : 'bg-transparent border-transparent text-emerald-800 hover:text-emerald-400')}>
                <span className="text-emerald-700">{done ? '✓' : active ? '›' : '·'} </span>
                {s.label.toLowerCase()}
                {active && <span className="absolute -bottom-px left-0 right-0 h-px bg-emerald-400" />}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 mt-2 px-1">
          <p className="text-[12px] text-emerald-600/90">
            <span className="text-emerald-700"># </span>{seg.hint}
            <span className="inline-block w-2 h-3.5 ml-1 bg-emerald-400 align-middle gw-blink" />
          </p>
          {seg.subs.length > 1 && <SubNav variant="term" subs={seg.subs} activeId={sub.id} onPick={setSubId} />}
        </div>
      </div>
      <Body stepIndex={stepIndex} subId={sub.id} body={body} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ESTILO 5 — AURORA FLOW  (fundo aurora animado, pílulas flutuantes)
// ════════════════════════════════════════════════════════════════════════════
function AuroraFlow({ seg, sub, segId, stepIndex, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden relative bg-zinc-950">
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="gw-aurora gw-aurora-a" />
        <div className="gw-aurora gw-aurora-b" />
      </div>
      <div className="shrink-0 px-4 pt-5 pb-3 relative z-10">
        <div className="flex flex-wrap items-center gap-2.5">
          {SEGMENTS.map((s, i) => {
            const SIcon = s.icon;
            const active = s.id === segId;
            return (
              <motion.button
                key={s.id}
                type="button"
                onClick={() => goSeg(s.id)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 400, damping: 22 }}
                className={clsx(
                  'relative inline-flex items-center gap-2.5 pl-3 pr-5 py-2.5 rounded-full backdrop-blur-xl border transition-colors',
                  active ? 'bg-white/12 border-white/30 text-white shadow-[0_8px_32px_-8px_rgba(255,255,255,0.25)]' : 'bg-white/5 border-white/10 text-zinc-400 hover:bg-white/10',
                )}
              >
                <span className={clsx('w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold', active ? 'bg-gradient-to-br from-brand-400 to-cyan-300 text-zinc-950' : 'bg-white/10 text-zinc-400')}>
                  {active ? <SIcon size={14} /> : i + 1}
                </span>
                <span className="text-[14px] font-semibold tracking-tight">{s.label}</span>
              </motion.button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 mt-3.5 px-1">
          <p className="text-[13px] text-zinc-400">{seg.hint}</p>
          {seg.subs.length > 1 && <SubNav variant="aurora" subs={seg.subs} activeId={sub.id} onPick={setSubId} />}
        </div>
      </div>
      <Body stepIndex={stepIndex} subId={sub.id} body={body} />
    </div>
  );
}

// ── Sub-navegação reaproveitável (Conhecimento/Ações têm mais de um painel) ──
function SubNav({ variant, subs, activeId, onPick }: { variant: 'pill' | 'hud' | 'term' | 'aurora'; subs: SubPanel[]; activeId: string; onPick: (id: string) => void }) {
  return (
    <div className={clsx('inline-flex gap-0.5 p-0.5 rounded-lg shrink-0', variant === 'term' ? 'bg-emerald-950/40 border border-emerald-900/60 font-mono' : variant === 'aurora' ? 'bg-white/5 border border-white/10 backdrop-blur' : 'bg-zinc-900 border border-zinc-800')}>
      {subs.map((su) => {
        const SubIcon = su.icon;
        const active = su.id === activeId;
        return (
          <button key={su.id} type="button" onClick={() => onPick(su.id)} className={clsx('inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-md transition-colors', active ? (variant === 'term' ? 'bg-emerald-500/15 text-emerald-300' : variant === 'aurora' ? 'bg-white/15 text-white font-medium' : 'bg-zinc-800 text-zinc-100 font-medium') : 'text-zinc-500 hover:text-zinc-200')}>
            <SubIcon size={12} />
            {variant === 'term' ? su.label.toLowerCase() : su.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Corpo (painel real da seção). Re-anima na troca via key. ─────────────────
function Body({ stepIndex, subId, body }: { stepIndex: number; subId: string; body: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-auto relative z-10">
      <AnimatePresence mode="wait">
        <motion.div key={`${stepIndex}:${subId}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}>
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

const STYLES = [
  { id: 1, name: 'Neon Pulse', Comp: NeonPulse },
  { id: 2, name: 'HUD Rail', Comp: HudRail },
  { id: 3, name: 'Orbit Cards', Comp: OrbitCards },
  { id: 4, name: 'Terminal', Comp: Terminal },
  { id: 5, name: 'Aurora Flow', Comp: AuroraFlow },
] as const;

export function AgentWorkspaceGallery() {
  const [style, setStyle] = useState(1);
  const [segId, setSegId] = useState<SegId>('identidade');
  const [subId, setSubId] = useState<string>(SEGMENTS[0].subs[0].id);

  const seg = SEGMENTS.find((s) => s.id === segId) ?? SEGMENTS[0];
  const sub = seg.subs.find((s) => s.id === subId) ?? seg.subs[0];
  const stepIndex = SEGMENTS.findIndex((s) => s.id === segId);

  function goSeg(id: SegId) {
    const target = SEGMENTS.find((s) => s.id === id) ?? SEGMENTS[0];
    setSegId(target.id);
    setSubId(target.subs[0].id);
  }

  const Comp = STYLES.find((s) => s.id === style)?.Comp ?? NeonPulse;
  const body = sub.render(goSeg);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <GalleryCss />
      {/* Seletor de estilos — provisório, pra você escolher */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
          <Palette size={13} /> Estilo
        </span>
        <div className="flex items-center gap-1">
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStyle(s.id)}
              className={clsx('px-3 py-1 rounded-full text-[12px] transition-colors border', style === s.id ? 'bg-brand-500/15 border-brand-500/40 text-brand-200 font-medium' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700')}
            >
              <span className="tabular-nums text-zinc-600 mr-1">{s.id}</span>{s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Comp seg={seg} sub={sub} segId={segId} subId={subId} stepIndex={stepIndex} setSubId={setSubId} goSeg={goSeg} body={body} />
      </div>
    </div>
  );
}

// Keyframes escopadas — evita mexer no index.css global.
function GalleryCss() {
  return (
    <style>{`
      .gw-grid { background-image: linear-gradient(var(--color-zinc-800) 1px, transparent 1px), linear-gradient(90deg, var(--color-zinc-800) 1px, transparent 1px); background-size: 32px 32px; mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, #000 40%, transparent 100%); }
      .gw-shimmer { background: linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.08) 50%, transparent 70%); background-size: 200% 100%; animation: gwShimmer 2.4s linear infinite; }
      @keyframes gwShimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
      .gw-blink { animation: gwBlink 1.1s step-end infinite; }
      @keyframes gwBlink { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }
      .gw-aurora { position: absolute; width: 60vw; height: 60vw; border-radius: 9999px; filter: blur(80px); opacity: 0.28; }
      .gw-aurora-a { background: radial-gradient(circle, var(--color-brand-500), transparent 60%); top: -20vw; left: -10vw; animation: gwFloatA 14s ease-in-out infinite; }
      .gw-aurora-b { background: radial-gradient(circle, #22d3ee, transparent 60%); top: -30vw; right: -10vw; animation: gwFloatB 18s ease-in-out infinite; }
      @keyframes gwFloatA { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(8vw,6vw) scale(1.15); } }
      @keyframes gwFloatB { 0%,100% { transform: translate(0,0) scale(1.1); } 50% { transform: translate(-6vw,8vw) scale(1); } }
      @media (prefers-reduced-motion: reduce) { .gw-shimmer, .gw-blink, .gw-aurora { animation: none; } }
    `}</style>
  );
}
