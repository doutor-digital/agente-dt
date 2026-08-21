import { Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { useTheme } from '../context/ThemeContext';

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isLight = theme === 'light';
  return (
    <button
      type="button"
      onClick={toggle}
      title={isLight ? 'Mudar para escuro' : 'Mudar para claro'}
      aria-label={isLight ? 'Mudar para tema escuro' : 'Mudar para tema claro'}
      className={clsx(
        'inline-flex items-center justify-center w-8 h-8 rounded-lg text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors',
        className,
      )}
    >
      {isLight ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  );
}
