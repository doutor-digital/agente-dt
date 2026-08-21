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
