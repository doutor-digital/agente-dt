// ============================================================================
// formkit — peças de formulário compartilhadas, no skin "Stripe Settings"
// (escolhido pelo João, adaptado à cor `brand` do console pra ficar coeso).
//
// Fonte única do visual de TODOS os formulários do agente. Um painel importa
// daqui em vez de redefinir TextField/SelectField/etc. localmente — muda aqui,
// muda em todo lugar.
//
// Assinaturas espelham as peças que já existiam no WizardPanel, então a
// migração é só trocar a definição local pelo import.
// ============================================================================

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';

// Tokens do skin — LINEAR: input transparente, borda sutil, sem anel colorido.
// Cor = estado, não decoração. Um lugar só; mexer aqui reflete em tudo.
const INPUT =
  'w-full px-3 py-2 rounded-md border border-zinc-800 bg-transparent text-[13px] text-zinc-100 outline-none transition ' +
  'placeholder:text-zinc-600 focus:border-zinc-600 hover:border-zinc-700';
// ── FieldRow — linha de settings: rótulo + explicação à ESQUERDA, controle à
//    DIREITA, um por linha, com hairline dividindo (estilo Linear). Empilha no
//    mobile. Dá a cara de produto enxuto em vez de campos amontoados num grid.
function FieldRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-6 sm:items-start py-3.5 border-b border-zinc-800/40 last:border-b-0 last:pb-0">
      <div className="sm:pt-2">
        <label className="text-[13px] font-medium text-zinc-200">{label}</label>
        {hint && <p className="text-[11.5px] text-zinc-500 mt-0.5 leading-relaxed">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// ── FeatureCard — seção com toggle, acordeão. Coração do formulário. ────────
export function FeatureCard({
  icon,
  title,
  subtitle,
  enabled,
  onToggle,
  alwaysOn,
  disabled,
  comingSoonNote,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  enabled: boolean;
  onToggle?: (v: boolean) => void;
  alwaysOn?: boolean;
  disabled?: boolean;
  comingSoonNote?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(enabled || !!alwaysOn);
  useEffect(() => {
    if (enabled || alwaysOn) setOpen(true);
  }, [enabled, alwaysOn]);

  const active = enabled || alwaysOn;

  return (
    <section
      className={clsx(
        'border-t border-zinc-800/50 pt-7 first:border-t-0 transition-opacity',
        disabled && 'opacity-60',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-4 text-left group"
        disabled={disabled}
      >
        <div className="flex-1 min-w-0">
          <h3 className="text-[15px] font-semibold text-zinc-100 tracking-tight flex items-center gap-2">
            <span className="text-zinc-600 shrink-0">{icon}</span>
            {title}
            {comingSoonNote && (
              <span className="text-[9px] uppercase tracking-wider bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                em breve
              </span>
            )}
          </h3>
          <p className="text-[13px] text-zinc-500 mt-1 leading-relaxed max-w-xl">{subtitle}</p>
        </div>
        {!alwaysOn && !disabled && onToggle && (
          <div onClick={(e) => e.stopPropagation()} className="mt-0.5 shrink-0">
            <Toggle value={enabled} onChange={onToggle} />
          </div>
        )}
        {!alwaysOn && (
          <span className="mt-1 text-zinc-600 shrink-0">
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        )}
      </button>
      {(open || alwaysOn) && (active || disabled) && (
        <div className="mt-5">
          {comingSoonNote && <div className="text-[12px] text-zinc-500 italic mb-3">{comingSoonNote}</div>}
          {children}
        </div>
      )}
    </section>
  );
}

// ── Toggle ──────────────────────────────────────────────────────────────────
export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={clsx(
        'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
        value ? 'bg-brand-500' : 'bg-zinc-700',
      )}
    >
      <span
        className={clsx(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition',
          value ? 'translate-x-5' : 'translate-x-1',
        )}
      />
    </button>
  );
}

// ── TextField ────────────────────────────────────────────────────────────────
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={INPUT} />
    </FieldRow>
  );
}

// ── NumberField ──────────────────────────────────────────────────────────────
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className={clsx(INPUT, 'font-mono')}
      />
    </FieldRow>
  );
}

// ── TextareaField ────────────────────────────────────────────────────────────
export function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} className={clsx(INPUT, 'resize-vertical')} />
    </FieldRow>
  );
}

// ── SelectField ──────────────────────────────────────────────────────────────
export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

// ── KeywordList — chips + input pra listas de palavras ───────────────────────
export function KeywordList({
  keywords,
  onChange,
  placeholder,
}: {
  keywords: string[];
  onChange: (kws: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState('');

  function commit() {
    const v = input.trim();
    if (!v) return;
    if (keywords.includes(v)) {
      setInput('');
      return;
    }
    onChange([...keywords, v]);
    setInput('');
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {keywords.length === 0 && (
          <span className="text-[11px] text-zinc-600 italic">Nenhuma palavra cadastrada ainda.</span>
        )}
        {keywords.map((kw) => (
          <span
            key={kw}
            className="inline-flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-lg bg-zinc-800/80 text-zinc-200 text-[12px] ring-1 ring-zinc-700"
          >
            {kw}
            <button
              type="button"
              onClick={() => onChange(keywords.filter((x) => x !== kw))}
              className="text-zinc-500 hover:text-zinc-100"
              title="Remover"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className={INPUT}
        />
        <button
          type="button"
          onClick={commit}
          disabled={!input.trim()}
          className="px-3.5 rounded-lg bg-zinc-800 text-[12px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 shrink-0"
        >
          Adicionar
        </button>
      </div>
    </div>
  );
}
