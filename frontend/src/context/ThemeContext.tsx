// ============================================================================
// ThemeContext — tema claro/escuro do app inteiro.
//
// O mecanismo de cor vive no index.css: a escala `zinc` é uma variável de
// runtime que troca conforme a classe `light`/`dark` no <html>. Aqui só
// guardamos a escolha (localStorage), aplicamos a classe e expomos o toggle.
//
// A classe inicial já é setada por um script inline no index.html (anti-flash),
// então na primeira renderização o tema certo já está na tela.
// ============================================================================

import { createContext, useContext, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function apply(t: Theme) {
  const el = document.documentElement;
  el.classList.remove('light', 'dark');
  el.classList.add(t);
  try {
    localStorage.setItem('theme', t);
  } catch {
    // modo privado / storage bloqueado — tema ainda vale nesta sessão
  }
}

function initial(): Theme {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
    return 'dark';
  }
  return 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initial);

  const setTheme = (t: Theme) => {
    apply(t);
    setThemeState(t);
  };
  const toggle = () => setTheme(theme === 'light' ? 'dark' : 'light');

  return <Ctx.Provider value={{ theme, toggle, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme precisa estar dentro de <ThemeProvider>');
  return v;
}
