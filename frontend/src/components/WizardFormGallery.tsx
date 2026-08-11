// ============================================================================
// WizardFormGallery — 7 DIREÇÕES DE DESIGN pro formulário de Persona.
//
// Objetivo: parar de chutar. Aqui o João vê os MESMOS campos (Nome, Tom,
// Categoria, Saudação, Tamanho, Idioma, Pausa, Intervalo) renderizados em 7
// estilos consagrados de produto gringo, lado a lado, e escolhe UM número.
// Depois eu aplico o vencedor no formkit real (ui/formkit.tsx) e some com
// esta galeria.
//
// Estado local só pra demo — não salva nada. É um provador de roupa.
// ============================================================================

import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  UserRound,
  Sparkles,
  Clock,
  Languages,
  MessageSquare,
  Building2,
  Check,
} from 'lucide-react';

// ── Modelo de dados compartilhado por TODOS os skins ────────────────────────
interface Demo {
  company: string;
  tone: string;
  category: string;
  greeting: string;
  length: string;
  language: string;
  delay: number;
  gap: number;
}

const TONE_OPTS = [
  { value: 'friendly', label: 'Amigável e caloroso' },
  { value: 'balanced', label: 'Equilibrado (padrão)' },
  { value: 'casual', label: 'Descontraído' },
  { value: 'formal', label: 'Formal e profissional' },
];
const CATEGORY_OPTS = [
  { value: 'saude', label: 'Saúde (Dra. Sofia)' },
  { value: 'solar', label: 'Energia Solar (Dr. João)' },
  { value: 'advocacia', label: 'Advocacia (Ana)' },
  { value: '', label: 'Genérica (sem categoria)' },
];
const LENGTH_OPTS = [
  { value: 'curta', label: 'Curta (1 frase)' },
  { value: 'normal', label: 'Normal (1-3 frases)' },
  { value: 'detalhada', label: 'Detalhada (parágrafo)' },
];
const LANG_OPTS = [
  { value: 'pt-BR', label: 'Português (BR)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'es-ES', label: 'Español' },
];

const INITIAL: Demo = {
  company: 'Doutor Hérnia Imperatriz',
  tone: 'friendly',
  category: 'saude',
  greeting: '',
  length: 'detalhada',
  language: 'pt-BR',
  delay: 3,
  gap: 30,
};

// Cada campo, descrito uma vez. Os skins iteram por cima disto.
type FieldDef =
  | { key: keyof Demo; kind: 'text'; label: string; hint?: string; placeholder?: string }
  | { key: keyof Demo; kind: 'number'; label: string; hint?: string }
  | { key: keyof Demo; kind: 'select'; label: string; hint?: string; opts: { value: string; label: string }[] };

const FIELDS: FieldDef[] = [
  { key: 'company', kind: 'text', label: 'Nome da empresa', placeholder: 'ex: HM Tecnologia' },
  { key: 'tone', kind: 'select', label: 'Tom de voz', opts: TONE_OPTS },
  {
    key: 'category',
    kind: 'select',
    label: 'Categoria / segmento',
    hint: 'Define a identidade: Saúde → Dra. Sofia, Solar → Dr. João.',
    opts: CATEGORY_OPTS,
  },
  {
    key: 'greeting',
    kind: 'text',
    label: 'Saudação preferida (opcional)',
    placeholder: 'Oi! Sou a Sofia, da HM Tecnologia. Como posso te chamar?',
  },
  { key: 'length', kind: 'select', label: 'Tamanho da resposta', opts: LENGTH_OPTS },
  { key: 'language', kind: 'select', label: 'Idioma', opts: LANG_OPTS },
  {
    key: 'delay',
    kind: 'number',
    label: 'Pausa antes de responder (s)',
    hint: "0 = imediato. Simula 'digitando…' humano.",
  },
  {
    key: 'gap',
    kind: 'number',
    label: 'Intervalo mínimo entre respostas (s)',
    hint: 'Trava anti-loop do Kommo. Recomendado 30.',
  },
];

type SkinProps = { d: Demo; set: (patch: Partial<Demo>) => void };

// ════════════════════════════════════════════════════════════════════════
// SKIN 1 — LINEAR. Dark, hairline, tipografia manda. Rótulo à esquerda,
// controle à direita, divisória fininha. O padrão "settings" da Linear.
// ════════════════════════════════════════════════════════════════════════
function SkinLinear({ d, set }: SkinProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h2 className="text-[15px] font-semibold text-zinc-100">Persona da IA</h2>
        <p className="text-[13px] text-zinc-500 mt-0.5">Quem é o agente e como ele fala.</p>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {FIELDS.map((f) => (
          <div key={f.key} className="grid grid-cols-[1fr_1.3fr] gap-6 py-4 items-center">
            <div>
              <label className="text-[13px] font-medium text-zinc-200">{f.label}</label>
              {f.hint && <p className="text-[12px] text-zinc-500 mt-0.5 leading-snug">{f.hint}</p>}
            </div>
            <Control
              f={f}
              d={d}
              set={set}
              inputCls="w-full h-9 px-3 rounded-md bg-white/[0.03] border border-white/10 text-[13px] text-zinc-100 outline-none focus:border-indigo-500/60 focus:bg-white/[0.05] transition"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 2 — STRIPE. Claro, branco, muito respiro. Duas colunas, azul só no
// foco. O gold-standard de formulário SaaS gringo.
// ════════════════════════════════════════════════════════════════════════
function SkinStripe({ d, set }: SkinProps) {
  return (
    <div className="max-w-3xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
      <div className="px-8 py-6 border-b border-slate-100">
        <h2 className="text-[17px] font-semibold text-slate-900 tracking-tight">Persona da IA</h2>
        <p className="text-[13px] text-slate-500 mt-1">Quem é o agente e como ele fala.</p>
      </div>
      <div className="px-8 py-2 divide-y divide-slate-100">
        {FIELDS.map((f) => (
          <div key={f.key} className="grid sm:grid-cols-[220px_1fr] gap-x-8 gap-y-1.5 py-5">
            <div>
              <label className="text-[13px] font-semibold text-slate-700">{f.label}</label>
              {f.hint && <p className="text-[12px] text-slate-400 mt-1 leading-relaxed">{f.hint}</p>}
            </div>
            <Control
              f={f}
              d={d}
              set={set}
              inputCls="w-full h-10 px-3.5 rounded-lg bg-white border border-slate-200 text-[13px] text-slate-900 outline-none shadow-[0_1px_2px_rgba(0,0,0,0.04)] focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 3 — VERCEL / GEIST. Preto e branco puro, alto contraste, geométrico,
// bordas nítidas, mono nos números. Frio e caro.
// ════════════════════════════════════════════════════════════════════════
function SkinVercel({ d, set }: SkinProps) {
  return (
    <div className="max-w-2xl mx-auto rounded-xl border border-zinc-800 bg-black overflow-hidden">
      <div className="px-6 py-5 border-b border-zinc-800">
        <h2 className="text-[16px] font-semibold text-white tracking-tight">Persona da IA</h2>
        <p className="text-[13px] text-zinc-500 mt-1">Quem é o agente e como ele fala.</p>
      </div>
      <div className="p-6 space-y-5">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <label className="text-[12px] font-medium text-zinc-300">{f.label}</label>
            <Control
              f={f}
              d={d}
              set={set}
              inputCls={clsx(
                'w-full h-10 px-3 rounded-md bg-zinc-950 border border-zinc-800 text-[13px] text-white outline-none focus:border-white transition',
                f.kind === 'number' && 'font-mono',
              )}
            />
            {f.hint && <p className="text-[12px] text-zinc-600 leading-snug">{f.hint}</p>}
          </div>
        ))}
      </div>
      <div className="px-6 py-4 border-t border-zinc-800 flex justify-end">
        <button className="h-9 px-4 rounded-md bg-white text-black text-[13px] font-medium hover:bg-zinc-200 transition">
          Salvar
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 4 — NOTION. Claro-quente, cinza suave, amigável, redondo, ícone por
// campo. Acolhedor pra usuário leigo — vibe "não-técnico".
// ════════════════════════════════════════════════════════════════════════
const FIELD_ICON: Partial<Record<keyof Demo, ReactNode>> = {
  company: <Building2 size={15} />,
  tone: <Sparkles size={15} />,
  category: <UserRound size={15} />,
  greeting: <MessageSquare size={15} />,
  length: <MessageSquare size={15} />,
  language: <Languages size={15} />,
  delay: <Clock size={15} />,
  gap: <Clock size={15} />,
};
function SkinNotion({ d, set }: SkinProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-11 w-11 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center text-xl">🤖</div>
        <div>
          <h2 className="text-[19px] font-semibold text-stone-800">Persona da IA</h2>
          <p className="text-[13px] text-stone-500">Quem é o agente e como ele fala.</p>
        </div>
      </div>
      <div className="rounded-xl bg-stone-50 border border-stone-200/80 p-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white transition-colors">
            <span className="text-stone-400 w-5 flex justify-center shrink-0">{FIELD_ICON[f.key]}</span>
            <label className="text-[13.5px] text-stone-600 w-52 shrink-0">{f.label}</label>
            <Control
              f={f}
              d={d}
              set={set}
              inputCls="w-full h-9 px-3 rounded-md bg-white border border-stone-200 text-[13px] text-stone-800 outline-none focus:border-stone-400 focus:ring-2 focus:ring-stone-200 transition"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 5 — APPLE / iOS SETTINGS. Grupos "inset", cantos bem redondos,
// divisórias curtas, controle encostado à direita. Familiar e limpíssimo.
// ════════════════════════════════════════════════════════════════════════
function SkinApple({ d, set }: SkinProps) {
  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-[26px] font-bold text-zinc-100 tracking-tight mb-1 px-1">Persona da IA</h2>
      <p className="text-[13px] text-zinc-500 mb-5 px-1">Quem é o agente e como ele fala.</p>
      <div className="rounded-2xl bg-zinc-900/80 border border-white/5 overflow-hidden backdrop-blur">
        {FIELDS.map((f, i) => (
          <div
            key={f.key}
            className={clsx(
              'flex items-center gap-4 px-4 py-3',
              i > 0 && 'border-t border-white/[0.06]',
            )}
          >
            <label className="text-[14px] text-zinc-200 shrink-0">{f.label}</label>
            <div className="ml-auto min-w-0 w-[52%]">
              <Control
                f={f}
                d={d}
                set={set}
                inputCls="w-full h-8 px-2.5 rounded-lg bg-white/[0.04] border-0 text-[13px] text-right text-zinc-100 outline-none focus:bg-white/[0.08] transition"
                selectRight
              />
            </div>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-zinc-600 mt-2 px-4 leading-snug">
        A pausa simula “digitando…” humano. O intervalo mínimo trava o loop do Kommo.
      </p>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 6 — SUPERHUMAN / COMMAND. Denso, profissional, dark azulado, atalho
// de teclado, foco produtivo. Pra quem usa o painel o dia todo.
// ════════════════════════════════════════════════════════════════════════
function SkinCommand({ d, set }: SkinProps) {
  return (
    <div className="max-w-3xl mx-auto rounded-lg border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />
          <h2 className="text-[13px] font-semibold text-slate-100 uppercase tracking-wider">Persona</h2>
        </div>
        <kbd className="text-[10px] text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">⌘S</kbd>
      </div>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-4 p-5">
        {FIELDS.map((f) => (
          <div key={f.key} className={clsx(f.key === 'greeting' && 'sm:col-span-2')}>
            <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wide flex items-center gap-1.5 mb-1.5">
              {f.label}
            </label>
            <Control
              f={f}
              d={d}
              set={set}
              inputCls="w-full h-9 px-3 rounded-md bg-slate-950/80 border border-slate-800 text-[13px] text-slate-100 outline-none focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/10 transition"
            />
            {f.hint && <p className="text-[11px] text-slate-600 mt-1 leading-snug">{f.hint}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 7 — ATTIO / MODERN SAAS. Gradiente sutil de fundo, card de vidro,
// acento colorido tasteful, cantos generosos. Moderno sem virar neon.
// ════════════════════════════════════════════════════════════════════════
function SkinAttio({ d, set }: SkinProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="relative rounded-3xl p-[1px] bg-gradient-to-b from-white/15 to-transparent">
        <div className="rounded-3xl bg-zinc-900/70 backdrop-blur-xl p-8">
          <div className="flex items-center gap-3 mb-7">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
              <Sparkles size={18} className="text-white" />
            </div>
            <div>
              <h2 className="text-[17px] font-semibold text-zinc-50 tracking-tight">Persona da IA</h2>
              <p className="text-[13px] text-zinc-400">Quem é o agente e como ele fala.</p>
            </div>
          </div>
          <div className="space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="text-[12.5px] font-medium text-zinc-300 mb-1.5 block">{f.label}</label>
                <Control
                  f={f}
                  d={d}
                  set={set}
                  inputCls="w-full h-10 px-3.5 rounded-xl bg-white/[0.04] border border-white/10 text-[13px] text-zinc-100 outline-none focus:border-violet-400/60 focus:bg-white/[0.06] focus:ring-4 focus:ring-violet-500/10 transition"
                />
                {f.hint && <p className="text-[11.5px] text-zinc-500 mt-1">{f.hint}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// SKIN 8 — STUDIO (com preview AO VIVO). Split-screen: à esquerda o form em
// vidro, à direita um celular renderizando a conversa da Sofia — atualiza
// enquanto você digita nome/tom/saudação. É o padrão "premium" de editor de
// persona. Rico, animado, tecnológico.
// ════════════════════════════════════════════════════════════════════════
const TONE_SAMPLE: Record<string, string> = {
  friendly: 'Oi, tudo bem? 🥰 Sou a Sofia, da {c}. Como posso te chamar?',
  balanced: 'Olá! Sou a Sofia, da {c}. Com quem eu falo?',
  casual: 'Oii! 👋 Aqui é a Sofia, da {c}. Como é seu nome?',
  formal: 'Olá, seja bem-vindo(a). Sou a Sofia, da {c}. Poderia me informar seu nome?',
};

function PhonePreview({ d }: { d: Demo }) {
  const company = d.company || 'sua empresa';
  const greet = (d.greeting?.trim() || TONE_SAMPLE[d.tone] || TONE_SAMPLE.balanced).replace('{c}', company);
  return (
    <div className="mx-auto w-[300px] shrink-0">
      {/* moldura do celular */}
      <div className="rounded-[2.2rem] bg-zinc-950 border border-zinc-800 p-2.5 shadow-2xl shadow-black/50">
        <div className="rounded-[1.7rem] overflow-hidden bg-[#0b141a]">
          {/* header WhatsApp */}
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-[#202c33]">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-white text-[13px] font-bold">
              S
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-zinc-100 truncate">Sofia · {company}</div>
              <div className="text-[10.5px] text-emerald-400">online</div>
            </div>
          </div>
          {/* fundo do chat */}
          <div
            className="px-3 py-4 space-y-2 min-h-[340px]"
            style={{
              backgroundColor: '#0b141a',
              backgroundImage:
                'radial-gradient(rgba(255,255,255,0.025) 1px, transparent 1px)',
              backgroundSize: '14px 14px',
            }}
          >
            <div className="flex">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-[#202c33] px-3 py-2 text-[12.5px] text-zinc-100 leading-relaxed shadow">
                {greet}
                <div className="text-[9px] text-zinc-500 text-right mt-0.5">09:41</div>
              </div>
            </div>
            <div className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-[#005c4b] px-3 py-2 text-[12.5px] text-zinc-50 leading-relaxed shadow">
                Oi, é sobre a cirurgia de hérnia
                <div className="text-[9px] text-emerald-200/70 text-right mt-0.5">09:41 ✓✓</div>
              </div>
            </div>
            {/* typing — reflete a "pausa antes de responder" */}
            <div className="flex">
              <div className="rounded-2xl rounded-tl-sm bg-[#202c33] px-3.5 py-2.5 flex gap-1 items-center">
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-400 animate-bounce" />
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="text-center text-[11px] text-zinc-500 mt-3">
        Prévia ao vivo · pausa de {d.delay}s antes de responder
      </p>
    </div>
  );
}

function SkinStudio({ d, set }: SkinProps) {
  return (
    <div className="max-w-5xl mx-auto grid lg:grid-cols-[1fr_auto] gap-8 items-start">
      {/* Form em vidro */}
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 backdrop-blur-xl p-7">
        <div className="flex items-center gap-3 mb-6">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-600 flex items-center justify-center">
            <Sparkles size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-[17px] font-semibold text-zinc-50 tracking-tight">Persona da IA</h2>
            <p className="text-[12.5px] text-zinc-400">Edite à esquerda, veja a conversa mudar à direita.</p>
          </div>
        </div>
        <div className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label className="text-[12.5px] font-medium text-zinc-300 mb-1.5 block">{f.label}</label>
              <Control
                f={f}
                d={d}
                set={set}
                inputCls="w-full h-10 px-3.5 rounded-xl bg-white/[0.04] border border-white/10 text-[13px] text-zinc-100 outline-none focus:border-indigo-400/60 focus:bg-white/[0.06] focus:ring-4 focus:ring-indigo-500/10 transition"
              />
              {f.hint && <p className="text-[11.5px] text-zinc-500 mt-1">{f.hint}</p>}
            </div>
          ))}
        </div>
      </div>
      {/* Preview ao vivo */}
      <div className="lg:sticky lg:top-24">
        <PhonePreview d={d} />
      </div>
    </div>
  );
}

// ── Control — renderiza input/select/number com a classe do skin ────────────
function Control({
  f,
  d,
  set,
  inputCls,
  selectRight,
}: {
  f: FieldDef;
  d: Demo;
  set: (patch: Partial<Demo>) => void;
  inputCls: string;
  selectRight?: boolean;
}) {
  if (f.kind === 'select') {
    return (
      <select
        value={String(d[f.key])}
        onChange={(e) => set({ [f.key]: e.target.value } as Partial<Demo>)}
        className={clsx(inputCls, selectRight && 'text-right pr-6')}
      >
        {f.opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (f.kind === 'number') {
    return (
      <input
        type="number"
        value={d[f.key] as number}
        onChange={(e) => set({ [f.key]: Number(e.target.value) } as Partial<Demo>)}
        className={inputCls}
      />
    );
  }
  return (
    <input
      type="text"
      value={d[f.key] as string}
      placeholder={f.placeholder}
      onChange={(e) => set({ [f.key]: e.target.value } as Partial<Demo>)}
      className={inputCls}
    />
  );
}

// ── Registry ────────────────────────────────────────────────────────────────
const SKINS: { id: number; name: string; sub: string; dark: boolean; render: (p: SkinProps) => ReactNode }[] = [
  { id: 1, name: 'Studio + Preview', sub: 'Split · conversa ao vivo · premium', dark: true, render: (p) => <SkinStudio {...p} /> },
  { id: 2, name: 'Attio', sub: 'Vidro · gradiente sutil · moderno', dark: true, render: (p) => <SkinAttio {...p} /> },
  { id: 3, name: 'Superhuman', sub: 'Denso · pro · command', dark: true, render: (p) => <SkinCommand {...p} /> },
  { id: 4, name: 'Stripe', sub: 'Claro · respiro · SaaS clássico', dark: false, render: (p) => <SkinStripe {...p} /> },
  { id: 5, name: 'Vercel', sub: 'Preto & branco · alto contraste', dark: true, render: (p) => <SkinVercel {...p} /> },
  { id: 6, name: 'Notion', sub: 'Claro-quente · amigável · ícones', dark: false, render: (p) => <SkinNotion {...p} /> },
  { id: 7, name: 'Apple Settings', sub: 'Grupos inset · redondo', dark: true, render: (p) => <SkinApple {...p} /> },
  { id: 8, name: 'Linear', sub: 'Dark · hairline · tipografia', dark: true, render: (p) => <SkinLinear {...p} /> },
];

export function WizardFormGallery() {
  const [active, setActive] = useState(1);
  const [demos, setDemos] = useState<Record<number, Demo>>(() =>
    Object.fromEntries(SKINS.map((s) => [s.id, { ...INITIAL }])),
  );
  const skin = SKINS.find((s) => s.id === active)!;
  const set = (patch: Partial<Demo>) =>
    setDemos((prev) => ({ ...prev, [active]: { ...prev[active], ...patch } }));

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Barra de escolha — sticky, sempre visível */}
      <div className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
        <div className="max-w-5xl mx-auto px-6 py-3">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={15} className="text-indigo-400" />
            <span className="text-[13px] font-semibold text-zinc-100">Escolha o design</span>
            <span className="text-[12px] text-zinc-500">— clique nos 7, digite nos campos pra sentir, e me diga o número.</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SKINS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActive(s.id)}
                className={clsx(
                  'group flex items-center gap-2 px-3 py-1.5 rounded-lg border text-left transition',
                  active === s.id
                    ? 'border-indigo-500/60 bg-indigo-500/10'
                    : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700',
                )}
              >
                <span
                  className={clsx(
                    'h-5 w-5 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0',
                    active === s.id ? 'bg-indigo-500 text-white' : 'bg-zinc-800 text-zinc-400',
                  )}
                >
                  {active === s.id ? <Check size={12} /> : s.id}
                </span>
                <span>
                  <span className="block text-[12.5px] font-medium text-zinc-100 leading-none">{s.name}</span>
                  <span className="block text-[10.5px] text-zinc-500 mt-0.5">{s.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Palco — fundo adapta ao skin (claro/escuro) */}
      <div className={clsx('min-h-[70vh] py-12 px-6 transition-colors', skin.dark ? 'bg-zinc-950' : 'bg-slate-100')}>
        {skin.render({ d: demos[active], set })}
      </div>

      <div className="text-center text-[12px] text-zinc-600 py-6">
        Versão <span className="text-zinc-300 font-semibold">{skin.id} — {skin.name}</span>. Gostou? Me diz o número que eu aplico no formulário de verdade.
      </div>
    </div>
  );
}

export default WizardFormGallery;
