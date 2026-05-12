// ============================================================================
// UnitSelector — dropdown global no topo do app.
//
// Permite escolher entre "Todas" (visão admin) ou uma Unit específica. Toda
// view filha reage à mudança via UnitContext.
// ============================================================================

import { Building2, Check, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';

export function UnitSelector() {
  const { units, selectedUnit, selectedUnitId, setSelectedUnitId, loading } = useUnit();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const label = loading
    ? 'Carregando...'
    : selectedUnit
      ? selectedUnit.name
      : units.length === 0
        ? 'Sem unidades'
        : 'Todas as unidades';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-md bg-zinc-900/60 ring-1 ring-zinc-800 hover:ring-zinc-700 text-zinc-200 transition"
      >
        <Building2 size={13} className="text-brand-400" />
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown size={12} className="text-zinc-500" />
      </button>

      {open && (
        <div className="absolute left-0 mt-1 z-30 w-72 rounded-md border border-zinc-800 bg-zinc-950/95 backdrop-blur shadow-2xl py-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedUnitId(null);
              setOpen(false);
            }}
            className={clsx(
              'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-zinc-900',
              !selectedUnitId && 'text-brand-300',
            )}
          >
            {!selectedUnitId ? <Check size={12} /> : <span className="w-3" />}
            <span>Todas as unidades (admin)</span>
          </button>

          <div className="my-1 border-t border-zinc-800/60" />

          {units.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-zinc-500">
              Nenhuma unidade cadastrada.<br />
              Use a aba "Unidades" pra criar.
            </div>
          )}

          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => {
                setSelectedUnitId(u.id);
                setOpen(false);
              }}
              className={clsx(
                'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-zinc-900',
                selectedUnitId === u.id && 'text-brand-300',
              )}
            >
              {selectedUnitId === u.id ? <Check size={12} /> : <span className="w-3" />}
              <div className="flex-1 min-w-0">
                <div className="truncate">{u.name}</div>
                <div className="text-[10px] text-zinc-600 truncate">{u.slug}</div>
              </div>
              {!u.isActive && (
                <span className="text-[9px] text-amber-500/80 uppercase tracking-wider">off</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
