// ============================================================================
// AgentWorkspaceLeanGallery — 5 direções ENXUTAS (estilo produto EUA) pra a
// casca do /configurar-agente. Ao contrário da galeria glossy anterior, aqui
// tudo é RESTRAINED: tipografia lidera, um acento só (= estado, não enfeite),
// espaço em branco como ferramenta. Zero gradiente/glass/neon/blob (o que dá
// "cara de IA"). Um seletor no topo troca a direção ao vivo; o corpo de cada
// seção é o painel real. Quando o João escolher, a gente fixa a vencedora.
// Referências: Linear, Vercel Geist, editorial/ledger, Raycast, Notion.
// ============================================================================

import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
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
  Search,
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

interface SubPanel { id: string; label: string; icon: Icon; render: (go: (seg: SegId) => void) => ReactNode }
interface Segment { id: SegId; label: string; hint: string; subs: SubPanel[] }

const SEGMENTS: Segment[] = [
  { id: 'identidade', label: 'Identidade', hint: 'Quem é o agente — nome, tom, persona e o que ele sabe fazer.',
    subs: [{ id: 'persona', label: 'Persona', icon: Wand2, render: () => <WizardPanel /> }] },
  { id: 'conhecimento', label: 'Conhecimento', hint: 'O que o agente sabe — fontes de informação e material de treino.',
    subs: [
      { id: 'fontes', label: 'Fontes', icon: FileText, render: () => <FontesPanel /> },
      { id: 'treinar', label: 'Treinar', icon: GraduationCap, render: (go) => <TrainingPanel onNavigate={() => go('testar')} /> },
    ] },
  { id: 'acoes', label: 'Ações', hint: 'O que o agente faz — ações no CRM, captura de dados e ferramentas.',
    subs: [
      { id: 'acoes', label: 'Ações', icon: Zap, render: () => <AcoesPanel /> },
      { id: 'captura', label: 'Captura', icon: Database, render: () => <CapturesPanel /> },
      { id: 'ferramentas', label: 'Ferramentas', icon: Wrench, render: () => <FerramentasPanel /> },
    ] },
  { id: 'kommo', label: 'Kommo', hint: 'A conexão — campo de resposta e pausa, Salesbot e etapas em que responde.',
    subs: [{ id: 'conexao', label: 'Conexão', icon: Cable, render: () => <AgentConfigPanel /> }] },
  { id: 'testar', label: 'Testar', hint: 'Converse com o agente e veja as ações que ele dispara — antes de colocar no ar.',
    subs: [{ id: 'playground', label: 'Playground', icon: TestTube2, render: () => <PlaygroundPanel /> }] },
];

const SEG_ICON: Record<SegId, Icon> = {
  identidade: UserRound, conhecimento: BookOpen, acoes: Zap, kommo: Cable, testar: TestTube2,
};

interface Shell {
  seg: Segment; sub: SubPanel; segId: SegId; stepIndex: number;
  setSubId: (id: string) => void; goSeg: (id: SegId) => void; body: ReactNode;
}

// ── Corpo (painel real) — sem animação decorativa, só troca limpa. ───────────
function Body({ subId, body }: { subId: string; body: ReactNode }) {
  return <div key={subId} className="flex-1 min-h-0 overflow-auto">{body}</div>;
}

function SubTabs({ subs, activeId, onPick, tone }: { subs: SubPanel[]; activeId: string; onPick: (id: string) => void; tone: 'quiet' | 'mono' }) {
  if (subs.length <= 1) return null;
  return (
    <div className="flex items-center gap-4">
      {subs.map((s) => {
        const active = s.id === activeId;
        return (
          <button key={s.id} type="button" onClick={() => onPick(s.id)}
            className={clsx('text-[12px] transition-colors', tone === 'mono' && 'font-mono',
              active ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

// ════ 1 · LINEAR — hairlines, um acento só no ativo, escala justa ════════════
function LinearShell({ seg, sub, segId, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-950">
      <div className="shrink-0 px-6 border-b border-zinc-800/70">
        <nav className="flex items-center gap-6 -mb-px">
          {SEGMENTS.map((s) => {
            const active = s.id === segId;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)}
                className={clsx('relative py-3 text-[13px] transition-colors',
                  active ? 'text-zinc-100 font-medium' : 'text-zinc-500 hover:text-zinc-300')}>
                {s.label}
                {active && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-brand-500" />}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="shrink-0 flex items-center justify-between gap-4 px-6 py-3">
        <p className="text-[12px] text-zinc-500">{seg.hint}</p>
        <SubTabs subs={seg.subs} activeId={sub.id} onPick={setSubId} tone="quiet" />
      </div>
      <Body subId={sub.id} body={body} />
    </div>
  );
}

// ════ 2 · GEIST (VERCEL) — preto/branco, mono, bordas nítidas ════════════════
function GeistShell({ seg, sub, segId, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-black">
      <div className="shrink-0 px-6 pt-5 pb-4">
        <div className="inline-flex border border-zinc-800">
          {SEGMENTS.map((s, i) => {
            const active = s.id === segId;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)}
                className={clsx('px-4 py-2 text-[12px] font-mono uppercase tracking-wide transition-colors',
                  i > 0 && 'border-l border-zinc-800',
                  active ? 'bg-white text-black' : 'text-zinc-500 hover:text-white')}>
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 mt-3">
          <p className="text-[12px] text-zinc-500 font-mono">{seg.hint}</p>
          <SubTabs subs={seg.subs} activeId={sub.id} onPick={setSubId} tone="mono" />
        </div>
      </div>
      <Body subId={sub.id} body={body} />
    </div>
  );
}

// ════ 3 · EDITORIAL / LEDGER — serifa, seções numeradas, respiro ═════════════
function EditorialShell({ seg, sub, segId, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-[#0c0b0a]">
      <div className="shrink-0 px-8 pt-6 pb-4 border-b border-zinc-800/60">
        <nav className="flex items-baseline gap-8">
          {SEGMENTS.map((s, i) => {
            const active = s.id === segId;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)} className="group text-left">
                <span className={clsx('font-mono text-[10px] tabular-nums mr-2', active ? 'text-brand-400' : 'text-zinc-600')}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className={clsx('font-serif text-[17px] transition-colors',
                  active ? 'text-zinc-100 italic' : 'text-zinc-500 group-hover:text-zinc-300')}>
                  {s.label}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="flex items-center justify-between gap-4 mt-4">
          <p className="text-[13px] text-zinc-400 max-w-xl leading-relaxed">{seg.hint}</p>
          <SubTabs subs={seg.subs} activeId={sub.id} onPick={setSubId} tone="quiet" />
        </div>
      </div>
      <Body subId={sub.id} body={body} />
    </div>
  );
}

// ════ 4 · RAYCAST — barra ⌘K, cartões uniformes, um acento quente ════════════
function RaycastShell({ seg, sub, segId, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-950">
      <div className="shrink-0 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/70 text-zinc-500 text-[12px]">
          <Search size={13} />
          <span>Configurar agente…</span>
          <kbd className="ml-auto font-mono text-[10px] text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">⌘K</kbd>
        </div>
        <div className="flex items-center gap-1.5 mt-3 overflow-x-auto">
          {SEGMENTS.map((s) => {
            const Ic = SEG_ICON[s.id];
            const active = s.id === segId;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)}
                className={clsx('inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-[13px] whitespace-nowrap transition-colors',
                  active ? 'bg-orange-500/12 text-orange-200 ring-1 ring-orange-500/25' : 'text-zinc-400 hover:bg-zinc-900')}>
                <Ic size={13} className={active ? 'text-orange-300' : 'text-zinc-500'} />
                {s.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-4 mt-2.5 px-1">
          <p className="text-[12px] text-zinc-500">{seg.hint}</p>
          <SubTabs subs={seg.subs} activeId={sub.id} onPick={setSubId} tone="quiet" />
        </div>
      </div>
      <Body subId={sub.id} body={body} />
    </div>
  );
}

// ════ 5 · QUIET (NOTION) — chrome mínimo, abas de texto, ponto de acento ═════
function QuietShell({ seg, sub, segId, setSubId, goSeg, body }: Shell) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-950">
      <div className="shrink-0 px-8 pt-6 pb-4">
        <nav className="flex items-center gap-7">
          {SEGMENTS.map((s) => {
            const active = s.id === segId;
            return (
              <button key={s.id} type="button" onClick={() => goSeg(s.id)}
                className={clsx('inline-flex items-center gap-2 text-[14px] transition-colors',
                  active ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}>
                <span className={clsx('w-1.5 h-1.5 rounded-full transition-colors', active ? 'bg-brand-500' : 'bg-transparent')} />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="flex items-center justify-between gap-4 mt-3 pl-3.5">
          <p className="text-[13px] text-zinc-500">{seg.hint}</p>
          <SubTabs subs={seg.subs} activeId={sub.id} onPick={setSubId} tone="quiet" />
        </div>
      </div>
      <Body subId={sub.id} body={body} />
    </div>
  );
}

const STYLES = [
  { id: 1, name: 'Linear', Comp: LinearShell },
  { id: 2, name: 'Geist', Comp: GeistShell },
  { id: 3, name: 'Editorial', Comp: EditorialShell },
  { id: 4, name: 'Raycast', Comp: RaycastShell },
  { id: 5, name: 'Quiet', Comp: QuietShell },
] as const;

export function AgentWorkspaceLeanGallery() {
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

  const Comp = STYLES.find((s) => s.id === style)?.Comp ?? LinearShell;
  const body = sub.render(goSeg);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Seletor — provisório, enxuto */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-2 border-b border-zinc-800 bg-zinc-950">
        <span className="text-[11px] text-zinc-500 uppercase tracking-wider">Direção</span>
        <div className="flex items-center gap-1">
          {STYLES.map((s) => (
            <button key={s.id} type="button" onClick={() => setStyle(s.id)}
              className={clsx('px-2.5 py-1 rounded text-[12px] transition-colors',
                style === s.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200')}>
              <span className="tabular-nums text-zinc-600 mr-1">{s.id}</span>{s.name}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <Comp seg={seg} sub={sub} segId={segId} stepIndex={stepIndex} setSubId={setSubId} goSeg={goSeg} body={body} />
      </div>
    </div>
  );
}
