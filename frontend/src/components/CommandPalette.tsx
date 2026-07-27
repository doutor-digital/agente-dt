// ============================================================================
// CommandPalette — navegação por teclado (⌘K / Ctrl+K).
//
// Por que existe: o console tem ~20 páginas e N agentes. Caçar isso no menu
// custa caro; digitar duas letras não. É o mesmo atalho que o usuário já tem
// no dedo de outras ferramentas.
//
// Faz duas coisas:
//   - "Ir para": qualquer página (respeitando o papel do usuário)
//   - "Trocar de agente": seleciona a unidade ativa
//
// Busca sem acento (normalize) e por sinônimo (keywords do lib/nav.ts) — quem
// digita "custo" acha "Chamadas IA" e "Custo WhatsApp".
// ============================================================================

import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Bot, CornerDownLeft, Search } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { useUnit } from '../context/UnitContext';
import { NAV_ITEMS, SECTION_LABEL, normalize, type AppTab } from '../lib/nav';

interface Row {
  key: string;
  kind: 'page' | 'unit';
  label: string;
  hint: string;
  group: string;
  haystack: string;
  run: () => void;
  icon: ComponentType<{ size?: number; className?: string }>;
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (t: AppTab) => void;
}) {
  const { user } = useAuth();
  const { units, setSelectedUnitId } = useUnit();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reabrir sempre começa limpo e com o foco no campo.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);

  const rows = useMemo<Row[]>(() => {
    const pages: Row[] = NAV_ITEMS.filter(
      (n) => !n.superOnly || user?.role === 'SUPER_ADMIN',
    ).map((n) => ({
      key: `page:${n.id}`,
      kind: 'page',
      label: n.label,
      hint: n.hint,
      group: SECTION_LABEL[n.section],
      haystack: normalize([n.label, n.hint, ...(n.keywords ?? [])].join(' ')),
      icon: n.icon,
      run: () => onNavigate(n.id),
    }));

    const agents: Row[] = units.map((u) => ({
      key: `unit:${u.id}`,
      kind: 'unit',
      label: u.name,
      hint: u.isActive ? u.slug : `${u.slug} · desativado`,
      group: 'Agentes',
      haystack: normalize(`${u.name} ${u.slug}`),
      icon: Bot,
      run: () => setSelectedUnitId(u.id),
    }));

    return [...pages, ...agents];
  }, [units, user?.role, onNavigate, setSelectedUnitId]);

  const results = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return rows.slice(0, 12);
    const terms = q.split(/\s+/);
    return rows.filter((r) => terms.every((t) => r.haystack.includes(t))).slice(0, 24);
  }, [rows, query]);

  // Cursor nunca pode apontar pra fora da lista filtrada.
  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, results.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = results[cursor];
        if (row) {
          row.run();
          onClose();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, results, cursor, onClose]);

  // Mantém o item selecionado visível ao navegar com as setas.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!open) return null;

  // Agrupa preservando a ordem de aparição dos resultados.
  const groups: { name: string; rows: Row[] }[] = [];
  for (const r of results) {
    const last = groups[groups.length - 1];
    if (last && last.name === r.group) last.rows.push(r);
    else groups.push({ name: r.group, rows: [r] });
  }

  let index = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/55 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl popover overflow-hidden animate-pop-in"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Campo de busca */}
        <div className="flex items-center gap-2.5 px-4 h-13 border-b border-zinc-800">
          <Search size={16} className="text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar página ou agente…"
            className="flex-1 bg-transparent py-3.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
          />
          <span className="kbd">esc</span>
        </div>

        {/* Resultados */}
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {results.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-zinc-500">
              Nada encontrado para “{query}”.
            </div>
          )}

          {groups.map((g) => (
            <div key={g.name} className="mb-1 last:mb-0">
              <div className="eyebrow px-2.5 py-1.5">{g.name}</div>
              {g.rows.map((r) => {
                index += 1;
                const active = index === cursor;
                const at = index;
                const Icon = r.icon;
                return (
                  <button
                    key={r.key}
                    type="button"
                    data-active={active}
                    onMouseMove={() => setCursor(at)}
                    onClick={() => {
                      r.run();
                      onClose();
                    }}
                    className={clsx(
                      'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left transition-colors',
                      active ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
                    )}
                  >
                    <Icon
                      size={15}
                      className={clsx('shrink-0', active ? 'text-brand-400' : 'text-zinc-500')}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] text-zinc-100 truncate">{r.label}</span>
                      <span className="block text-[11px] text-zinc-500 truncate">{r.hint}</span>
                    </span>
                    {active && <CornerDownLeft size={13} className="text-zinc-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Rodapé com as teclas */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-zinc-800 text-[11px] text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            navegar
          </span>
          <span className="flex items-center gap-1.5">
            <span className="kbd">↵</span>
            abrir
          </span>
        </div>
      </div>
    </div>
  );
}

/** Registra o atalho global ⌘K / Ctrl+K. Devolve [aberta, abrir, fechar]. */
export function useCommandPalette(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return [open, () => setOpen(true), () => setOpen(false)];
}
