// ============================================================================
// ToastContext — sistema global de notificações.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Wrapper FINO sobre `react-toastify` que preserva a API histórica do projeto
// (`useToast().success/error/info/dismiss`). Os ~14 callers continuam funcionando
// sem alteração. A renderização é feita pelo `<ToastContainer />` da lib, que
// fica montado uma única vez aqui dentro do Provider.
//
// Por que wrapper em vez de usar `toast()` direto nos componentes?
//   - Migrações futuras (trocar de lib de novo) ficam num único arquivo.
//   - Mantém defaults consistentes (duração de erro maior, posição, tema).
//   - Permite forçar um dismiss programático com nosso próprio ID se quiser.
//
// USO
// ---
//   const toast = useToast();
//   toast.success('Salvo!');
//   toast.error('Falhou: ' + msg);   // duração maior por padrão (6s)
//   toast.info('Recarregando...');
//   toast.dismiss(id);               // id opcional — sem id, fecha todos
// ============================================================================

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { Slide, ToastContainer, toast as toastify, type Id } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import './toast-overrides.css';

interface ToastApi {
  success: (text: string, durationMs?: number) => Id;
  error: (text: string, durationMs?: number) => Id;
  info: (text: string, durationMs?: number) => Id;
  /** Fecha um toast específico (id retornado de success/error/info) ou TODOS se omitido. */
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
  // API estável (não recria a cada render).
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
        // Ajusta espaçamento pra não colar na borda em telas pequenas.
        toastClassName="dt-toast"
        // limit evita pilha gigante quando algo dispara em loop.
        limit={6}
      />
    </ToastContext.Provider>
  );
}
