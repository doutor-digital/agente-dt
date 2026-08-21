import { Bot, Check, ChevronsUpDown, Globe, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';
import { normalize } from '../lib/nav';

const SEARCH_THRESHOLD = 6;

export function UnitSelector() {
  const { units, selectedUnit, selectedUnitId, setSelectedUnitId, loading } = useUnit();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      document.addEventListener('mousedown', onClick);
      document.addEventListener('keydown', onKey);
    }
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return units;
    return units.filter((u) => normalize(`${u.name} ${u.slug}`).includes(q));
  }, [units, query]);

  const label = loading
    ? 'Carregando…'
    : selectedUnit
      ? selectedUnit.name
      : units.length === 0
        ? 'Sem agentes'
        : 'Todos os agentes';

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 h-8 px-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 hover:border-zinc-700 hover:bg-zinc-800/60 transition-colors"
      >
        <span className="w-5 h-5 rounded-md bg-brand-500/15 text-brand-400 flex items-center justify-center shrink-0">
          {selectedUnit ? <Bot size={12} /> : <Globe size={12} />}
        </span>
        <span className="max-w-[150px] truncate text-[13px] font-medium text-zinc-100">{label}</span>
        <ChevronsUpDown size={13} className="text-zinc-500 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 mt-2 z-40 w-72 popover animate-pop-in overflow-hidden">
          {units.length >= SEARCH_THRESHOLD && (
            <div className="flex items-center gap-2 px-3 border-b border-zinc-800">
              <Search size={13} className="text-zinc-500 shrink-0" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filtrar agentes…"
                className="flex-1 bg-transparent py-2.5 text-[13px] text-zinc-100 placeholder:text-zinc-500 outline-none"
              />
            </div>
          )}

          <div className="max-h-80 overflow-y-auto p-1.5">
            <Row
              icon={<Globe size={13} />}
              title="Todos os agentes"
              subtitle="Visão consolidada (admin)"
              active={!selectedUnitId}
              onClick={() => {
                setSelectedUnitId(null);
                setOpen(false);
              }}
            />

            {units.length > 0 && <div className="my-1.5 h-px bg-zinc-800" />}

            {units.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-zinc-500 leading-relaxed">
                Nenhum agente cadastrado.
                <br />
                Crie um pela seção <span className="text-zinc-300">Agentes</span>.
              </div>
            )}

            {units.length > 0 && filtered.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-zinc-500">Nenhum agente com esse nome.</div>
            )}

            {filtered.map((u) => (
              <Row
                key={u.id}
                icon={<Bot size={13} />}
                title={u.name}
                subtitle={u.slug}
                badge={!u.isActive ? 'off' : undefined}
                active={selectedUnitId === u.id}
                onClick={() => {
                  setSelectedUnitId(u.id);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  icon,
  title,
  subtitle,
  badge,
  active,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
        active ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
      )}
    >
      <span
        className={clsx(
          'w-6 h-6 rounded-md flex items-center justify-center shrink-0',
          active ? 'bg-brand-500/15 text-brand-400' : 'bg-zinc-800 text-zinc-500',
        )}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-zinc-100 truncate">{title}</span>
        <span className="block text-[11px] text-zinc-500 truncate">{subtitle}</span>
      </span>
      {badge && (
        <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-500 shrink-0">
          {badge}
        </span>
      )}
      {active && <Check size={13} className="text-brand-400 shrink-0" />}
    </button>
  );
}
