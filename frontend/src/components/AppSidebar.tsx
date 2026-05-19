// ============================================================================
// AppSidebar — navegação principal lateral.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Substitui o TopNav horizontal. Sidebar fixa à esquerda agrupa:
//   - Brand
//   - UnitSelector (a unidade ativa)
//   - Tabs verticais com ícones + labels
//   - Notificações + link de Docs no rodapé
//
// O conteúdo principal fica à direita ocupando o resto da viewport.
// Cada panel é responsável pelo seu próprio header.
// ============================================================================

import type { ReactNode } from 'react';
import {
  BookOpen,
  Building2,
  Cable,
  Cpu,
  LayoutDashboard,
  MessageCircle,
  Settings,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';
import clsx from 'clsx';
import { UnitSelector } from './UnitSelector';
import { NotificationsBadge } from './NotificationsBadge';

export type AppTab =
  | 'dashboard'
  | 'traces'
  | 'conversations'
  | 'llm'
  | 'prompts'
  | 'integrations'
  | 'wizard'
  | 'config'
  | 'units';

interface NavItem {
  id: AppTab;
  label: string;
  icon: typeof Terminal;
  group: 'primary' | 'secondary';
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'primary' },
  { id: 'wizard', label: 'Configurar IA', icon: Wand2, group: 'primary' },
  { id: 'conversations', label: 'Conversas', icon: MessageCircle, group: 'primary' },
  { id: 'traces', label: 'Execuções', icon: Terminal, group: 'primary' },

  { id: 'llm', label: 'Chamadas IA', icon: Cpu, group: 'secondary' },
  { id: 'prompts', label: 'Prompts', icon: Sparkles, group: 'secondary' },
  { id: 'integrations', label: 'Integrações', icon: Cable, group: 'secondary' },
  { id: 'config', label: 'Avançado', icon: Settings, group: 'secondary' },
  { id: 'units', label: 'Unidades', icon: Building2, group: 'secondary' },
];

export function AppSidebar({
  tab,
  onChange,
}: {
  tab: AppTab;
  onChange: (t: AppTab) => void;
}) {
  const primary = NAV.filter((n) => n.group === 'primary');
  const secondary = NAV.filter((n) => n.group === 'secondary');

  return (
    <aside className="w-60 shrink-0 border-r border-zinc-800/80 bg-ink-950 flex flex-col h-full">
      {/* Brand */}
      <div className="px-4 py-4 border-b border-zinc-800/60 flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-full bg-brand-400 shadow-[0_0_10px_rgba(124,77,255,0.7)]" />
        <div className="flex-1">
          <div className="text-sm font-display font-bold text-zinc-100 tracking-tight leading-none">
            Agente DT
          </div>
          <div className="text-[9px] font-display font-medium uppercase tracking-widest text-zinc-500 mt-1">
            Kommo Console v0.2
          </div>
        </div>
      </div>

      {/* Unit selector */}
      <div className="px-3 py-3 border-b border-zinc-800/60">
        <div className="text-[9px] font-display font-semibold uppercase tracking-widest text-zinc-500 mb-1.5 px-1">
          Unidade ativa
        </div>
        <UnitSelector />
      </div>

      {/* Nav primary */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        <NavGroup label="Principal">
          {primary.map((item) => (
            <NavLink key={item.id} item={item} active={tab === item.id} onClick={onChange} />
          ))}
        </NavGroup>

        <div className="my-3 h-px bg-zinc-800/40 mx-2" />

        <NavGroup label="Administração">
          {secondary.map((item) => (
            <NavLink key={item.id} item={item} active={tab === item.id} onClick={onChange} />
          ))}
        </NavGroup>
      </nav>

      {/* Footer */}
      <div className="border-t border-zinc-800/60 p-3 flex items-center justify-between">
        <NotificationsBadge />
        <a
          href="/docs"
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 transition-colors"
        >
          <BookOpen size={13} />
          Docs
        </a>
      </div>
    </aside>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[9px] font-display font-semibold uppercase tracking-widest text-zinc-600 mb-1 px-3">
        {label}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </div>
  );
}

function NavLink({
  item,
  active,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  onClick: (t: AppTab) => void;
}) {
  const Icon = item.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => onClick(item.id)}
        className={clsx(
          'w-full inline-flex items-center gap-2.5 text-sm px-3 py-2 rounded-md transition-all',
          active
            ? 'bg-brand-500/15 text-brand-100 ring-1 ring-brand-500/30 shadow-[inset_0_0_0_1px_rgba(124,77,255,0.1)]'
            : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60',
        )}
      >
        <Icon size={15} className={clsx(active ? 'text-brand-300' : 'text-zinc-500')} />
        <span className={clsx(active ? 'font-display font-semibold' : 'font-medium')}>
          {item.label}
        </span>
      </button>
    </li>
  );
}
