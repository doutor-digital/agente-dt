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
import { useState } from 'react';
import {
  AlertOctagon,
  BookOpen,
  Building2,
  Cable,
  Cpu,
  Database,
  Eraser,
  FileText,
  LayoutDashboard,
  Loader2,
  LogOut,
  MessageCircle,
  Settings,
  Sparkles,
  Terminal,
  TestTube2,
  UserCog,
  Wand2,
  Wrench,
  Zap,
} from 'lucide-react';
import clsx from 'clsx';
import { UnitSelector } from './UnitSelector';
import { NotificationsBadge } from './NotificationsBadge';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { tabToPath } from '../hooks/useRoute';
import { api } from '../lib/api';

export type AppTab =
  | 'dashboard'
  | 'traces'
  | 'conversations'
  | 'llm'
  | 'prompts'
  | 'integrations'
  | 'wizard'
  | 'playground'
  | 'sources'
  | 'actions'
  | 'captures'
  | 'tools'
  | 'config'
  | 'units'
  | 'users'
  | 'errors';

interface NavItem {
  id: AppTab;
  label: string;
  icon: typeof Terminal;
  group: 'primary' | 'secondary';
  superOnly?: boolean;
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'primary' },
  { id: 'wizard', label: 'Configurar IA', icon: Wand2, group: 'primary' },
  { id: 'playground', label: 'Testar IA', icon: TestTube2, group: 'primary' },
  { id: 'sources', label: 'Fontes', icon: FileText, group: 'primary' },
  { id: 'actions', label: 'Ações', icon: Zap, group: 'primary' },
  { id: 'tools', label: 'Ferramentas', icon: Wrench, group: 'primary' },
  { id: 'captures', label: 'Captura de Dados', icon: Database, group: 'primary' },
  { id: 'conversations', label: 'Conversas', icon: MessageCircle, group: 'primary' },
  { id: 'traces', label: 'Execuções', icon: Terminal, group: 'primary' },
  { id: 'errors', label: 'Erros', icon: AlertOctagon, group: 'primary' },

  { id: 'llm', label: 'Chamadas IA', icon: Cpu, group: 'secondary' },
  { id: 'prompts', label: 'Prompts', icon: Sparkles, group: 'secondary' },
  { id: 'integrations', label: 'Integrações', icon: Cable, group: 'secondary' },
  { id: 'config', label: 'Avançado (técnico)', icon: Settings, group: 'secondary' },
  { id: 'units', label: 'Unidades', icon: Building2, group: 'secondary', superOnly: true },
  { id: 'users', label: 'Usuários', icon: UserCog, group: 'secondary', superOnly: true },
];

export function AppSidebar({
  tab,
  onChange,
}: {
  tab: AppTab;
  onChange: (t: AppTab) => void;
}) {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [clearing, setClearing] = useState(false);
  const visible = NAV.filter((n) => !n.superOnly || user?.role === 'SUPER_ADMIN');
  const primary = visible.filter((n) => n.group === 'primary');
  const secondary = visible.filter((n) => n.group === 'secondary');

  // "Limpar cache" — chama o backend pra esvaziar caches em memória, limpa o
  // localStorage do front e força hard-reload pra puxar bundle fresco.
  // Útil quando algo "ficou grudado" após mudar dado no banco/Kommo.
  async function handleClearCache() {
    if (clearing) return;
    const confirmed = window.confirm(
      'Limpar cache do sistema?\n\n' +
        '• Esvazia caches em memória do backend (config, unit, dedup)\n' +
        '• Limpa armazenamento local do navegador\n' +
        '• Recarrega a página\n\n' +
        'Nenhum dado é apagado — só os caches.',
    );
    if (!confirmed) return;
    setClearing(true);
    try {
      const r = await api.clearCache();
      try {
        window.localStorage.clear();
        window.sessionStorage.clear();
      } catch {
        // Ignorar se o navegador bloquear (modo privado).
      }
      toast.success(
        `Cache limpo: ${r.cleared.configCache} config(s), ${r.cleared.unitBySlugCache} unit(s), ${r.cleared.dedupCache} dedup. Recarregando…`,
      );
      // Pequeno delay pra o toast aparecer antes do reload.
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao limpar cache: ${msg}`);
      setClearing(false);
    }
  }

  return (
    <aside className="w-60 shrink-0 border-r border-zinc-800/80 bg-ink-950 flex flex-col h-full">
      {/* Brand com logo */}
      <div className="px-4 py-4 border-b border-zinc-800/60 flex items-center gap-3">
        <img
          src="https://i.postimg.cc/9fkz8kVx/DESIGN-(1).png"
          alt="Agente DT"
          className="w-10 h-10 object-contain shrink-0 drop-shadow-[0_0_8px_rgba(124,77,255,0.4)]"
        />
        <div className="flex-1 min-w-0">
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

      {/* User info + logout */}
      {user && (
        <div className="border-t border-zinc-800/60 px-3 py-2 flex items-center gap-2">
          {user.picture ? (
            <img
              src={user.picture}
              alt=""
              className="w-7 h-7 rounded-full ring-1 ring-zinc-700"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-zinc-800 text-zinc-400 flex items-center justify-center text-xs font-bold">
              {user.email.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-xs text-zinc-200 truncate font-medium">{user.name ?? user.email}</div>
            <div className="text-[9px] uppercase tracking-wider text-zinc-500">
              {user.role === 'SUPER_ADMIN' ? 'Super admin' : 'Unit admin'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            title="Sair"
            className="p-1.5 rounded-md text-zinc-500 hover:text-rose-300 hover:bg-zinc-900/60"
          >
            <LogOut size={14} />
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-zinc-800/60 p-3 flex items-center justify-between gap-1">
        <NotificationsBadge />
        <button
          type="button"
          onClick={() => void handleClearCache()}
          disabled={clearing}
          title="Limpa caches em memória do backend, localStorage do navegador e recarrega"
          className="inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {clearing ? <Loader2 size={13} className="animate-spin" /> : <Eraser size={13} />}
          {clearing ? 'Limpando…' : 'Limpar cache'}
        </button>
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
  const href = tabToPath(item.id);
  return (
    <li>
      <a
        href={href}
        // Ctrl/Cmd/middle-click caem no comportamento default do <a> (abre
        // nova aba). Clique normal é interceptado pra navegação SPA sem reload.
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
          e.preventDefault();
          onClick(item.id);
        }}
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
      </a>
    </li>
  );
}
