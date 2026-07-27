// ============================================================================
// AppSidebar — navegação primária do console.
//
// Padrão dos consoles de IA modernos: uma coluna estreita, escura, puramente
// NAVEGACIONAL. Nada de identidade/estado do usuário aqui — isso vive no
// TopBar. A sidebar responde a uma pergunta só: "onde eu estou e pra onde
// posso ir".
//
//   - grupos rotulados (Operação / Agente / Análise / Plataforma)
//   - item ativo = superfície elevada + barra de acento à esquerda
//   - colapsável pra 64px (só ícones + tooltip); a escolha persiste
//   - <a href> real: ctrl/cmd-clique abre em nova aba de verdade
//
// A lista de itens vem de `lib/nav.ts` — a mesma que alimenta o breadcrumb e
// a paleta de comandos.
// ============================================================================

import { useEffect, useState } from 'react';
import { BookOpen, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../context/AuthContext';
import { tabToPath } from '../hooks/useRoute';
import {
  NAV_ITEMS,
  SECTION_LABEL,
  type AppTab,
  type NavItem,
  type NavSection,
} from '../lib/nav';

// Reexportado porque outros painéis já importavam o tipo daqui.
export type { AppTab };

const LOGO_URL = '/logo-dd.png';
const COLLAPSE_KEY = 'sidebar:collapsed';
const SECTION_ORDER: NavSection[] = ['operacao', 'agente', 'analise', 'plataforma'];

export function AppSidebar({
  tab,
  onChange,
  onBackToHub,
}: {
  tab: AppTab;
  onChange: (t: AppTab) => void;
  /** Quando presente, a marca vira clicável e volta pra landing de agentes. */
  onBackToHub?: () => void;
}) {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // modo privado — vale só nesta sessão
    }
  }, [collapsed]);

  const visible = NAV_ITEMS.filter((n) => !n.superOnly || user?.role === 'SUPER_ADMIN');

  return (
    <aside
      className={clsx(
        'shrink-0 h-full flex flex-col border-r border-zinc-800 bg-zinc-900/50 transition-[width] duration-200 ease-out',
        collapsed ? 'w-16' : 'w-[248px]',
      )}
    >
      {/* ── Marca ─────────────────────────────────────────────────────────── */}
      <div
        className={clsx(
          'h-14 shrink-0 flex items-center gap-2.5 border-b border-zinc-800',
          collapsed ? 'justify-center px-2' : 'px-3',
        )}
      >
        <button
          type="button"
          onClick={onBackToHub}
          disabled={!onBackToHub}
          title={onBackToHub ? 'Trocar de agente' : 'Agente DT'}
          className={clsx(
            'flex items-center gap-2.5 min-w-0 rounded-lg p-1 -m-1 transition-colors',
            onBackToHub && 'hover:bg-zinc-800/70 cursor-pointer',
          )}
        >
          <img
            src={LOGO_URL}
            alt=""
            className="w-8 h-8 rounded-lg object-contain shrink-0 ring-1 ring-zinc-800 bg-zinc-950 p-1"
          />
          {!collapsed && (
            <span className="flex flex-col items-start min-w-0">
              <span className="text-[13px] font-semibold text-zinc-50 leading-none tracking-tight">
                Agente DT
              </span>
              <span className="text-[10px] text-zinc-500 leading-none mt-1">Console</span>
            </span>
          )}
        </button>

        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Recolher menu"
            className="ml-auto p-1.5 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <PanelLeftClose size={15} />
          </button>
        )}
      </div>

      {/* ── Navegação ─────────────────────────────────────────────────────── */}
      <nav className={clsx('flex-1 overflow-y-auto overflow-x-hidden py-3', collapsed ? 'px-2' : 'px-2.5')}>
        {SECTION_ORDER.map((section) => {
          const items = visible.filter((n) => n.section === section);
          if (items.length === 0) return null;
          return (
            <div key={section} className="mb-4 last:mb-0">
              {collapsed ? (
                <div className="h-px bg-zinc-800 mx-2 mb-2 first:hidden" />
              ) : (
                <div className="eyebrow px-2.5 mb-1.5">{SECTION_LABEL[section]}</div>
              )}
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <NavLink
                    key={item.id}
                    item={item}
                    active={tab === item.id}
                    collapsed={collapsed}
                    onClick={onChange}
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* ── Rodapé ────────────────────────────────────────────────────────── */}
      <div
        className={clsx(
          'shrink-0 border-t border-zinc-800 p-2 flex items-center gap-1',
          collapsed ? 'flex-col' : '',
        )}
      >
        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="Expandir menu"
            className="w-full flex items-center justify-center p-2 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <PanelLeftOpen size={15} />
          </button>
        )}
        <a
          href="/docs"
          target="_blank"
          rel="noopener"
          title="Documentação"
          className={clsx(
            'flex items-center gap-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors',
            collapsed ? 'w-full justify-center p-2' : 'flex-1 px-2.5 py-2',
          )}
        >
          <BookOpen size={14} />
          {!collapsed && <span>Documentação</span>}
        </a>
      </div>
    </aside>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: (t: AppTab) => void;
}) {
  const Icon = item.icon;
  return (
    <li>
      <a
        href={tabToPath(item.id)}
        title={collapsed ? item.label : undefined}
        // Ctrl/Cmd/middle-click caem no comportamento default do <a> (nova aba).
        // Clique normal é interceptado pra navegação SPA sem reload.
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          onClick(item.id);
        }}
        className={clsx(
          'group relative flex items-center gap-2.5 rounded-lg text-[13px] transition-colors duration-150',
          collapsed ? 'justify-center px-0 py-2.5' : 'px-2.5 py-2',
          active
            ? 'bg-zinc-800 text-zinc-50 font-medium'
            : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60',
        )}
      >
        {/* Barra de acento do item ativo. */}
        <span
          className={clsx(
            'absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-brand-400 transition-opacity',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
        <Icon
          size={16}
          strokeWidth={active ? 2.1 : 1.8}
          className={clsx('shrink-0', active ? 'text-brand-400' : 'text-zinc-500 group-hover:text-zinc-300')}
        />
        {!collapsed && <span className="truncate">{item.label}</span>}
      </a>
    </li>
  );
}
