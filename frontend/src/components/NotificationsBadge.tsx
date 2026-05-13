// ============================================================================
// NotificationsBadge — sino no header com alertas globais.
//
// Polling em /api/alerts (60s). Mostra badge vermelho com contagem se há
// danger; amarelo se warning. Click abre lista detalhada.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { GlobalAlert } from '../types/api';

const POLL_MS = 60_000;

export function NotificationsBadge() {
  const [alerts, setAlerts] = useState<GlobalAlert[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = async () => {
      try {
        const a = await api.getAlerts();
        if (active) setAlerts(a);
      } catch {
        // alerts é best-effort — silencia
      }
    };
    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const danger = alerts.filter((a) => a.severity === 'danger').length;
  const warning = alerts.filter((a) => a.severity === 'warning').length;
  const total = alerts.length;

  const tone = danger > 0 ? 'text-rose-400' : warning > 0 ? 'text-amber-400' : 'text-zinc-500';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'relative inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-zinc-800/60 transition',
          tone,
        )}
        title={
          total === 0 ? 'Sem alertas' : `${total} alerta${total === 1 ? '' : 's'} ativo${total === 1 ? '' : 's'}`
        }
      >
        <Bell size={15} />
        {total > 0 && (
          <span
            className={clsx(
              'absolute -top-0.5 -right-0.5 min-w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center px-1',
              danger > 0 ? 'bg-rose-500 text-white' : 'bg-amber-500 text-black',
            )}
          >
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 z-30 w-96 max-h-125 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/95 backdrop-blur shadow-2xl">
          <div className="px-3 py-2 border-b border-zinc-800/80 text-[11px] uppercase tracking-wider text-zinc-500 flex items-center justify-between">
            <span>Notificações</span>
            <span>
              {danger > 0 && <span className="text-rose-400">{danger} críticas</span>}
              {danger > 0 && warning > 0 && <span className="text-zinc-600 mx-1">·</span>}
              {warning > 0 && <span className="text-amber-400">{warning} atenção</span>}
            </span>
          </div>
          {total === 0 && (
            <div className="px-4 py-6 text-center text-xs text-zinc-500">
              Tudo certo. Nenhuma notificação.
            </div>
          )}
          <ul className="divide-y divide-zinc-800/60">
            {alerts.map((a, i) => (
              <li key={i} className="px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0">
                    {a.severity === 'danger' ? (
                      <ShieldAlert size={14} className="text-rose-400" />
                    ) : (
                      <AlertTriangle size={14} className="text-amber-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-200">{a.message}</div>
                    <div className="text-[10px] text-zinc-500 mt-0.5">
                      <span className="uppercase tracking-wider">{a.integration}</span>
                      <span className="mx-1">·</span>
                      <span>{a.unitName}</span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
