import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Slide, ToastContainer, toast as toastify, type Id } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './toast-overrides.css';

interface ToastApi {
  success: (text: string, durationMs?: number) => Id;
  error: (text: string, durationMs?: number) => Id;
  info: (text: string, durationMs?: number) => Id;
  dismiss: (id?: Id) => void;
}

const DEFAULT_DURATION = 4_000;
const DEFAULT_ERROR_DURATION = 6_000;

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast deve estar dentro de ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const api = useMemo<ToastApi>(
    () => ({
      success: (text, ms) =>
        toastify.success(text, {
          icon: <CheckCircle2 size={18} className="text-emerald-300" />,
          autoClose: ms ?? DEFAULT_DURATION,
        }),
      error: (text, ms) =>
        toastify.error(text, {
          icon: <AlertCircle size={18} className="text-rose-300" />,
          autoClose: ms ?? DEFAULT_ERROR_DURATION,
        }),
      info: (text, ms) =>
        toastify.info(text, {
          icon: <Info size={18} className="text-sky-300" />,
          autoClose: ms ?? DEFAULT_DURATION,
        }),
      dismiss: (id) => (id !== undefined ? toastify.dismiss(id) : toastify.dismiss()),
    }),
    [],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastContainer
        position="bottom-right"
        autoClose={DEFAULT_DURATION}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        pauseOnHover
        pauseOnFocusLoss
        draggable
        theme="dark"
        transition={Slide}
        toastClassName="dt-toast"
        limit={6}
      />
    </ToastContext.Provider>
  );
}
