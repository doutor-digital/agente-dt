// ============================================================================
// ToastContext — sistema global de notificações flutuantes.
//
// USO
// ---
//   const { toast } = useToast();
//   toast.success('Salvo!');
//   toast.error('Falhou: ' + msg);
//   toast.info('Recarregando...');
//
// Auto-remove após `duration` (default 4s). Stack canto inferior direito.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import clsx from 'clsx';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: string;
  kind: ToastKind;
  text: string;
  duration: number;
}

interface ToastApi {
  success: (text: string, durationMs?: number) => void;
  error: (text: string, durationMs?: number) => void;
  info: (text: string, durationMs?: number) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast deve estar dentro de ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((kind: ToastKind, text: string, durationMs: number = 4000) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setItems((cur) => [...cur, { id, kind, text, duration: durationMs }]);
    if (durationMs > 0) {
      setTimeout(() => {
        setItems((cur) => cur.filter((t) => t.id !== id));
      }, durationMs);
    }
  }, []);

  const api: ToastApi = {
    success: (text, ms) => push('success', text, ms),
    error: (text, ms) => push('error', text, ms ?? 6000),
    info: (text, ms) => push('info', text, ms),
    dismiss: (id) => setItems((cur) => cur.filter((t) => t.id !== id)),
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack items={items} onDismiss={api.dismiss} />
    </ToastContext.Provider>
  );
}

function ToastStack({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      {items.map((t) => (
        <Toast key={t.id} item={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  const palette = {
    success: 'bg-emerald-500/10 ring-emerald-500/40 text-emerald-100',
    error: 'bg-rose-500/10 ring-rose-500/40 text-rose-100',
    info: 'bg-sky-500/10 ring-sky-500/40 text-sky-100',
  }[item.kind];

  const Icon = { success: CheckCircle2, error: AlertCircle, info: Info }[item.kind];

  return (
    <div
      className={clsx(
        'pointer-events-auto rounded-lg ring-1 px-3 py-2.5 shadow-2xl backdrop-blur',
        'flex items-start gap-2 min-w-[280px] transition-all duration-300',
        visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-6',
        palette,
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1 text-sm font-body">{item.text}</div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-current opacity-60 hover:opacity-100 shrink-0"
        title="Fechar"
      >
        <X size={14} />
      </button>
    </div>
  );
}
