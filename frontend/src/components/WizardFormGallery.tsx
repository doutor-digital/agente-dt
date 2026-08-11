// ============================================================================
// WizardFormGallery — PREVIEW pra escolher o novo FORMATO do formulário de
// "Configurar a IA". Mostra os mesmos campos (nome, tom, categoria, tamanho,
// paleta de emoji, e um card de toggle) em 5 linguagens de design usadas lá
// fora em 2026 (Linear, Vercel Geist, Stripe Settings, Aurora Glass, Bento).
//
// Estado é LOCAL/mock — nada salva. É só pra bater o olho e escolher. Quando o
// João escolher, a gente aplica o skin vencedor nas peças reais do WizardPanel
// (FeatureCard / TextField / SelectField / EmojiPaletteField…) e o formulário
// inteiro herda o visual de uma vez.
// ============================================================================

import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { motion } from 'framer-motion';
import {
  Building2,
  MessageSquareText,
  Stethoscope,
  Globe,
  Timer,
  Headset,
  Check,
  X,
  Plus,
  Palette,
} from 'lucide-react';

type Layout = 'inline' | 'stack' | 'twocol' | 'bento';

interface Tokens {
  page: string;
  card: string;
  title: string;
  label: string;
  hint: string;
  input: string;
  segWrap: string;
  segIdle: string;
  segActive: string;
  chipIdle: string;
  chipActive: string;
  accent: string; // toggle-on bg
  glass?: boolean;
}

// ── Dados de exemplo ─────────────────────────────────────────────────────────
const TONES = ['Amigável', 'Formal', 'Direto', 'Consultivo'];
const SIZES = ['Curta', 'Média', 'Detalhada'];
const CATS = ['🩺 Saúde (Dra. Sofia)', '☀️ Energia Solar (Dr. João)', '⚖️ Advocacia', '🛒 E-commerce'];
const LANGS = ['🇧🇷 Português (BR)', '🇺🇸 English', '🇪🇸 Español'];
const SUGGEST = ['😊', '🥰', '🙏', '👋', '💙', '✨', '🎉', '🩺', '💊'];

function useFormState() {
  const [empresa, setEmpresa] = useState('Doutor Hérnia Imperatriz');
  const [tom, setTom] = useState('Amigável');
  const [cat, setCat] = useState(CATS[0]);
  const [size, setSize] = useState('Detalhada');
  const [lang, setLang] = useState(LANGS[0]);
  const [pausa, setPausa] = useState(3);
  const [emojis, setEmojis] = useState<string[]>(['😊', '🙏', '💙', '✨']);
  const [handoff, setHandoff] = useState(true);
  const [kws, setKws] = useState<string[]>(['falar com atendente', 'falar com humano']);
  const [draft, setDraft] = useState('');
  return { empresa, setEmpresa, tom, setTom, cat, setCat, size, setSize, lang, setLang, pausa, setPausa, emojis, setEmojis, handoff, setHandoff, kws, setKws, draft, setDraft };
}
type FormState = ReturnType<typeof useFormState>;

// ── Controles genéricos (dirigidos por tokens) ───────────────────────────────
function Segmented({ options, value, onChange, t }: { options: string[]; value: string; onChange: (v: string) => void; t: Tokens }) {
  return (
    <div className={clsx('inline-flex flex-wrap gap-1 p-1 rounded-xl', t.segWrap)}>
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onChange(o)} className={clsx('px-3 py-1.5 text-[12px] rounded-lg transition-all', value === o ? t.segActive : t.segIdle)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function Toggle({ on, onChange, t }: { on: boolean; onChange: (v: boolean) => void; t: Tokens }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className={clsx('relative inline-flex h-6 w-11 items-center rounded-full transition-colors', on ? t.accent : 'bg-zinc-700')}>
      <motion.span layout className="inline-block h-4.5 w-4.5 rounded-full bg-white shadow" animate={{ x: on ? 22 : 3 }} transition={{ type: 'spring', stiffness: 500, damping: 32 }} style={{ height: 18, width: 18 }} />
    </button>
  );
}

function EmojiChips({ s, t }: { s: FormState; t: Tokens }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {s.emojis.map((e) => (
          <button key={e} type="button" onClick={() => s.setEmojis(s.emojis.filter((x) => x !== e))} className={clsx('group inline-flex items-center gap-1 pl-2 pr-1.5 py-1 rounded-lg text-[15px] transition', t.chipActive)}>
            {e}
            <X size={11} className="opacity-40 group-hover:opacity-100" />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {SUGGEST.filter((e) => !s.emojis.includes(e)).map((e) => (
          <button key={e} type="button" onClick={() => s.setEmojis([...s.emojis, e])} className={clsx('w-8 h-8 rounded-lg text-[15px] transition', t.chipIdle)}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

function KeywordList({ s, t }: { s: FormState; t: Tokens }) {
  function add() {
    const v = s.draft.trim();
    if (v && !s.kws.includes(v)) s.setKws([...s.kws, v]);
    s.setDraft('');
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {s.kws.map((k) => (
          <span key={k} className={clsx('inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-lg text-[12px]', t.chipActive)}>
            {k}
            <button type="button" onClick={() => s.setKws(s.kws.filter((x) => x !== k))}><X size={11} className="opacity-50 hover:opacity-100" /></button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input value={s.draft} onChange={(e) => s.setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="ex: humano, atendente…" className={clsx('flex-1 text-[12px]', t.input)} />
        <button type="button" onClick={add} className={clsx('inline-flex items-center gap-1 px-3 rounded-lg text-[12px]', t.chipIdle)}><Plus size={12} /> Add</button>
      </div>
    </div>
  );
}

// ── Um "campo" que se adapta ao layout ───────────────────────────────────────
function Field({ layout, t, icon, label, hint, control, wide }: { layout: Layout; t: Tokens; icon?: ReactNode; label: string; hint?: string; control: ReactNode; wide?: boolean }) {
  if (layout === 'twocol') {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-6 py-4 border-b border-zinc-800/60 last:border-0">
        <div>
          <div className={clsx('flex items-center gap-2', t.label)}>{icon}{label}</div>
          {hint && <p className={clsx('mt-1', t.hint)}>{hint}</p>}
        </div>
        <div>{control}</div>
      </div>
    );
  }
  if (layout === 'inline') {
    return (
      <div className="flex items-center justify-between gap-6 py-3.5 border-b border-zinc-800/60 last:border-0">
        <div className="min-w-0">
          <div className={clsx('flex items-center gap-2', t.label)}>{icon}{label}</div>
          {hint && <p className={clsx('mt-0.5', t.hint)}>{hint}</p>}
        </div>
        <div className="shrink-0 max-w-[60%]">{control}</div>
      </div>
    );
  }
  // stack + bento
  return (
    <div className={clsx(t.card, layout === 'bento' ? 'p-4 rounded-2xl' : 'p-4 rounded-xl', wide && 'sm:col-span-2')}>
      <div className={clsx('flex items-center gap-2', t.label)}>{icon}{label}</div>
      {hint && <p className={clsx('mt-0.5 mb-2.5', t.hint)}>{hint}</p>}
      {!hint && <div className="mb-2.5" />}
      {control}
    </div>
  );
}

// ── Corpo do formulário — UM só, dirigido por layout + tokens ────────────────
function FormBody({ layout, t }: { layout: Layout; t: Tokens }) {
  const s = useFormState();
  const wrap =
    layout === 'twocol' || layout === 'inline'
      ? clsx(t.card, 'p-5 rounded-2xl')
      : layout === 'bento'
        ? 'grid grid-cols-1 sm:grid-cols-2 gap-3'
        : 'space-y-3';

  const F = (p: Omit<Parameters<typeof Field>[0], 'layout' | 't'>) => <Field layout={layout} t={t} {...p} />;

  return (
    <div className={clsx('max-w-4xl mx-auto px-4 sm:px-6 py-6', t.glass && 'relative z-10')}>
      <header className="mb-6">
        <div className={clsx('text-[11px] uppercase tracking-[0.14em] mb-2', t.hint)}>Configuração · Persona</div>
        <h1 className={clsx('text-xl', t.title)}>Persona da IA</h1>
        <p className={clsx('mt-1.5', t.hint)}>Quem é o agente, como ele fala.</p>
      </header>

      <div className={wrap}>
        <F icon={<Building2 size={14} className="text-zinc-500" />} label="Nome da empresa" hint={layout === 'stack' || layout === 'bento' ? undefined : 'Aparece na saudação.'} control={<input value={s.empresa} onChange={(e) => s.setEmpresa(e.target.value)} className={clsx('w-full', t.input)} />} />
        <F icon={<MessageSquareText size={14} className="text-zinc-500" />} label="Tom de voz" hint="Define o jeito de falar." control={<Segmented options={TONES} value={s.tom} onChange={s.setTom} t={t} />} />
        <F icon={<Stethoscope size={14} className="text-zinc-500" />} label="Categoria / segmento" hint="Dá nome e enquadramento à IA." control={<select value={s.cat} onChange={(e) => s.setCat(e.target.value)} className={clsx('w-full', t.input)}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>} />
        <F icon={<MessageSquareText size={14} className="text-zinc-500" />} label="Tamanho da resposta" control={<Segmented options={SIZES} value={s.size} onChange={s.setSize} t={t} />} />
        <F icon={<Globe size={14} className="text-zinc-500" />} label="Idioma" control={<select value={s.lang} onChange={(e) => s.setLang(e.target.value)} className={clsx('w-full', t.input)}>{LANGS.map((c) => <option key={c}>{c}</option>)}</select>} />
        <F icon={<Timer size={14} className="text-zinc-500" />} label="Pausa antes de responder" hint={`Simula "digitando…". ${s.pausa}s`} control={
          <div className="flex items-center gap-3">
            <input type="range" min={0} max={8} value={s.pausa} onChange={(e) => s.setPausa(+e.target.value)} className="flex-1 accent-brand-500" />
            <span className={clsx('tabular-nums text-[13px] w-8 text-right', t.title)}>{s.pausa}s</span>
          </div>
        } />
        <F wide icon={<Palette size={14} className="text-zinc-500" />} label="Paleta de emojis" hint="A IA usa livremente nas respostas." control={<EmojiChips s={s} t={t} />} />
      </div>

      {/* Card de recurso com toggle — o padrão on/off do formulário */}
      <div className={clsx('mt-4', t.card, 'rounded-2xl overflow-hidden', s.handoff && t.glass ? '' : '')}>
        <div className="flex items-center gap-3 p-4">
          <span className={clsx('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', s.handoff ? 'bg-brand-500/15 text-brand-300' : 'bg-zinc-800 text-zinc-500')}><Headset size={16} /></span>
          <div className="flex-1 min-w-0">
            <div className={clsx('text-[13px] font-semibold', t.title)}>Handoff humano automático</div>
            <div className={t.hint}>Quando o cliente usa certas palavras, a IA pausa e chama um humano.</div>
          </div>
          <Toggle on={s.handoff} onChange={s.setHandoff} t={t} />
        </div>
        {s.handoff && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="px-4 pb-4 pt-1 border-t border-zinc-800/40">
            <KeywordList s={s} t={t} />
          </motion.div>
        )}
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <button className={clsx('px-4 py-2 rounded-xl text-[13px]', t.segIdle)}>Cancelar</button>
        <button className={clsx('px-5 py-2 rounded-xl text-[13px] font-medium text-white', t.accent)}>Salvar alterações</button>
      </div>
    </div>
  );
}

// ── 5 SKINS = 5 conjuntos de tokens + layout ─────────────────────────────────
// 5 direções ENXUTAS (estilo produto EUA). Zero gradiente/glass/blob. Cor =
// estado, não decoração; tipografia lidera; espaço em branco é ferramenta.
const linear: Tokens = {
  page: 'bg-zinc-950',
  card: 'bg-zinc-900/30 border border-zinc-800/60',
  title: 'font-semibold text-zinc-100 tracking-tight',
  label: 'text-[13px] font-medium text-zinc-200',
  hint: 'text-[12px] text-zinc-500',
  input: 'bg-transparent border border-zinc-800 rounded-md px-3 py-2 text-[13px] text-zinc-100 focus:border-zinc-600 outline-none transition',
  segWrap: 'bg-zinc-900/50 border border-zinc-800',
  segIdle: 'text-zinc-500 hover:text-zinc-200',
  segActive: 'bg-zinc-800 text-zinc-100',
  chipIdle: 'bg-zinc-900 border border-zinc-800 text-zinc-300 hover:border-zinc-600',
  chipActive: 'bg-zinc-800 text-zinc-100',
  accent: 'bg-brand-600 hover:bg-brand-500',
};
const geist: Tokens = {
  page: 'bg-black',
  card: 'bg-zinc-950 border border-zinc-800',
  title: 'font-semibold text-white tracking-tight',
  label: 'text-[13px] font-medium text-zinc-100 tracking-tight',
  hint: 'text-[12px] text-zinc-500 font-mono',
  input: 'bg-black border border-zinc-800 rounded-md px-3 py-2 text-[13px] text-white font-mono focus:border-white/40 outline-none transition',
  segWrap: 'bg-zinc-950 border border-zinc-800',
  segIdle: 'text-zinc-500 hover:text-white',
  segActive: 'bg-white text-black font-medium',
  chipIdle: 'bg-zinc-950 border border-zinc-800 text-zinc-200 hover:border-zinc-600',
  chipActive: 'bg-white/10 border border-white/20 text-white',
  accent: 'bg-white !text-black hover:bg-zinc-200',
};
const editorial: Tokens = {
  page: 'bg-[#0c0b0a]',
  card: 'bg-transparent border border-zinc-800/60',
  title: 'font-serif italic text-zinc-100 tracking-tight',
  label: 'font-serif text-[15px] text-zinc-200',
  hint: 'text-[12px] text-zinc-500 leading-relaxed',
  input: 'bg-transparent border-b border-zinc-700 rounded-none px-1 py-2 text-[14px] text-zinc-100 focus:border-brand-500 outline-none transition',
  segWrap: 'bg-transparent border border-zinc-800',
  segIdle: 'text-zinc-500 hover:text-zinc-200',
  segActive: 'bg-zinc-800/80 text-zinc-100',
  chipIdle: 'bg-transparent border border-zinc-800 text-zinc-300 hover:border-zinc-600',
  chipActive: 'bg-zinc-800 text-zinc-100',
  accent: 'bg-zinc-100 !text-zinc-900 hover:bg-white',
};
const raycast: Tokens = {
  page: 'bg-zinc-950',
  card: 'bg-zinc-900/50 border border-zinc-800',
  title: 'font-semibold text-zinc-100',
  label: 'text-[13px] font-medium text-zinc-200',
  hint: 'text-[12px] text-zinc-500',
  input: 'bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[13px] text-zinc-100 focus:border-orange-500/60 focus:ring-2 focus:ring-orange-500/15 outline-none transition',
  segWrap: 'bg-zinc-950 border border-zinc-800',
  segIdle: 'text-zinc-500 hover:text-zinc-200',
  segActive: 'bg-orange-500/15 text-orange-200 ring-1 ring-orange-500/25',
  chipIdle: 'bg-zinc-950 border border-zinc-800 text-zinc-300 hover:border-zinc-600',
  chipActive: 'bg-orange-500/12 border border-orange-500/25 text-orange-200',
  accent: 'bg-orange-500 hover:bg-orange-400',
};
const quiet: Tokens = {
  page: 'bg-zinc-950',
  card: 'bg-transparent border border-zinc-800/50',
  title: 'font-semibold text-zinc-100',
  label: 'text-[13px] font-medium text-zinc-300',
  hint: 'text-[12px] text-zinc-500',
  input: 'bg-zinc-900/40 border border-transparent rounded-lg px-3 py-2 text-[13px] text-zinc-100 focus:border-zinc-700 focus:bg-zinc-900 outline-none transition',
  segWrap: 'bg-zinc-900/40 border border-zinc-800/60',
  segIdle: 'text-zinc-500 hover:text-zinc-200',
  segActive: 'bg-zinc-800 text-zinc-100',
  chipIdle: 'bg-zinc-900/40 border border-zinc-800/60 text-zinc-300 hover:border-zinc-600',
  chipActive: 'bg-zinc-800 text-zinc-100',
  accent: 'bg-brand-600 hover:bg-brand-500',
};

const SKINS = [
  { id: 1, name: 'Linear', layout: 'inline' as Layout, t: linear },
  { id: 2, name: 'Geist', layout: 'stack' as Layout, t: geist },
  { id: 3, name: 'Editorial', layout: 'twocol' as Layout, t: editorial },
  { id: 4, name: 'Raycast', layout: 'stack' as Layout, t: raycast },
  { id: 5, name: 'Quiet', layout: 'twocol' as Layout, t: quiet },
];

export function WizardFormGallery() {
  const [skin, setSkin] = useState(1);
  const cur = SKINS.find((x) => x.id === skin) ?? SKINS[0];

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <style>{`
        .wf-aurora { position:absolute; width:55vw; height:55vw; border-radius:9999px; filter:blur(90px); opacity:0.22; pointer-events:none; }
        .wf-a { background:radial-gradient(circle, var(--color-brand-500), transparent 60%); top:-18vw; left:-8vw; animation:wfA 16s ease-in-out infinite; }
        .wf-b { background:radial-gradient(circle,#22d3ee,transparent 60%); top:-24vw; right:-8vw; animation:wfB 20s ease-in-out infinite; }
        @keyframes wfA { 0%,100%{transform:translate(0,0)} 50%{transform:translate(6vw,5vw)} }
        @keyframes wfB { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-5vw,7vw)} }
        @media (prefers-reduced-motion: reduce){ .wf-aurora{animation:none} }
      `}</style>

      {/* Seletor de formato — provisório */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur z-20">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 uppercase tracking-wider"><Palette size={13} /> Formato</span>
        <div className="flex items-center gap-1 overflow-x-auto">
          {SKINS.map((x) => (
            <button key={x.id} type="button" onClick={() => setSkin(x.id)} className={clsx('px-3 py-1 rounded-full text-[12px] whitespace-nowrap transition-colors border', skin === x.id ? 'bg-brand-500/15 border-brand-500/40 text-brand-200 font-medium' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700')}>
              <span className="tabular-nums text-zinc-600 mr-1">{x.id}</span>{x.name}
            </button>
          ))}
        </div>
      </div>

      <div className={clsx('flex-1 min-h-0 overflow-auto relative', cur.t.page)}>
        {cur.t.glass && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="wf-aurora wf-a" />
            <div className="wf-aurora wf-b" />
          </div>
        )}
        <motion.div key={cur.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
          <FormBody layout={cur.layout} t={cur.t} />
        </motion.div>
      </div>
    </div>
  );
}
