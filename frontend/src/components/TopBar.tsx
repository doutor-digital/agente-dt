// ============================================================================
// TopBar — a barra fixa do topo do console.
//
// Concentra tudo que é CONTEXTO e IDENTIDADE (a sidebar cuida só de navegação):
//   - breadcrumb: agente ativo › página atual
//   - seletor de agente (UnitSelector)
//   - gatilho da paleta de comandos (⌘K)
//   - notificações, tema e menu do usuário
//
// É a mesma divisão de responsabilidades dos consoles de IA modernos: coluna
// à esquerda navega, barra do topo diz onde você está e quem você é.
// ============================================================================

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Eraser,
  LayoutGrid,
  Loader2,
  LogOut,
  Search,
  UserRound,
} from 'lucide-react';
import clsx from 'clsx';
import { UnitSelector } from './UnitSelector';
import { NotificationsBadge } from './NotificationsBadge';
import { ThemeToggle } from './ThemeToggle';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { api } from '../lib/api';
import { navItem, tabLabel, type AppTab } from '../lib/nav';

export function TopBar({
  tab,
  onOpenPalette,
  onBackToHub,
}: {
  tab: AppTab;
  onOpenPalette: () => void;
  onBackToHub?: () => void;
}) {
  const meta = navItem(tab);

  // O `relative z-30` do <header> é OBRIGATÓRIO, não cosmético: o
  // `backdrop-blur` cria um stacking context mesmo num elemento estático, e o
  // contexto de um elemento NÃO-posicionado é pintado abaixo de qualquer irmão
  // posicionado (a área de conteúdo). Sem ele, os dropdowns filhos (sino,
  // seletor de agente, menu de conta) ficam atrás do conteúdo — invisíveis e
  // sem receber clique, o que quebrava até o botão "Sair".
  return (
    <header className="relative z-30 h-14 shrink-0 flex items-center gap-3 px-4 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-xl supports-backdrop-filter:bg-zinc-950/60">
      {/* Breadcrumb: agente ativo › página */}
      <div className="flex items-center gap-2 min-w-0">
        <UnitSelector />
        <ChevronRight size={14} className="text-zinc-600 shrink-0" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-zinc-100 truncate leading-tight">
            {tabLabel(tab)}
          </div>
          {meta && (
            <div className="text-[11px] text-zinc-500 truncate leading-tight hidden lg:block">
              {meta.hint}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1" />

      {/* Gatilho da paleta de comandos */}
      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden sm:inline-flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-500 hover:text-zinc-200 hover:border-zinc-700 transition-colors"
      >
        <Search size={14} />
        <span className="text-xs pr-6">Buscar…</span>
        <span className="kbd">⌘K</span>
      </button>

      <NotificationsBadge />
      <ThemeToggle />
      <UserMenu onBackToHub={onBackToHub} />
    </header>
  );
}

/** Avatar + menu de conta: trocar de agente, limpar cache, sair. */
function UserMenu({ onBackToHub }: { onBackToHub?: () => void }) {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // "Limpar cache" — esvazia caches em memória do backend, limpa o localStorage
  // e força hard-reload. Útil quando algo "grudou" após mudar dado no Kommo.
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
        // navegador pode bloquear em modo privado
      }
      toast.success(
        `Cache limpo: ${r.cleared.configCache} config(s), ${r.cleared.unitBySlugCache} unit(s), ${r.cleared.dedupCache} dedup. Recarregando…`,
      );
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao limpar cache: ${msg}`);
      setClearing(false);
    }
  }

  if (!user) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={user.name ?? user.email}
        className="flex items-center gap-2 rounded-lg p-1 hover:bg-zinc-800 transition-colors"
      >
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            className="w-7 h-7 rounded-full ring-1 ring-zinc-700"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-7 h-7 rounded-full bg-brand-500/15 ring-1 ring-brand-500/30 text-brand-300 flex items-center justify-center text-[11px] font-semibold">
            {(user.name ?? user.email).slice(0, 1).toUpperCase()}
          </div>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 z-40 popover animate-pop-in overflow-hidden">
          <div className="px-3 py-3 border-b border-zinc-800">
            <div className="text-[13px] font-medium text-zinc-100 truncate">
              {user.name ?? user.email}
            </div>
            <div className="text-[11px] text-zinc-500 truncate">{user.email}</div>
            <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-400">
              <UserRound size={10} />
              {user.role === 'SUPER_ADMIN' ? 'Super admin' : 'Admin do agente'}
            </div>
          </div>

          <div className="p-1">
            {onBackToHub && (
              <MenuItem
                icon={<LayoutGrid size={14} />}
                label="Trocar de agente"
                onClick={() => {
                  setOpen(false);
                  onBackToHub();
                }}
              />
            )}
            <MenuItem
              icon={clearing ? <Loader2 size={14} className="animate-spin" /> : <Eraser size={14} />}
              label={clearing ? 'Limpando…' : 'Limpar cache'}
              disabled={clearing}
              onClick={() => void handleClearCache()}
            />
            <MenuItem
              icon={<LogOut size={14} />}
              label="Sair"
              tone="danger"
              onClick={() => void logout()}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  tone = 'default',
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] transition-colors disabled:opacity-50',
        tone === 'danger'
          ? 'text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10'
          : 'text-zinc-300 hover:text-zinc-50 hover:bg-zinc-800',
      )}
    >
      <span className="text-zinc-500">{icon}</span>
      {label}
    </button>
  );
}
