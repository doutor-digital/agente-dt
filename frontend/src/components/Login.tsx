// ============================================================================
// Login — tela com form email/senha.
//
// Sem signup público — o super admin cria usuários pelo painel ou via CLI.
// Códigos de erro retornados pelo backend:
//   invalid_credentials — email/senha errados
//   account_disabled    — user desativado pelo super admin
//   no_password_set     — user existe mas ainda sem senha (peça reset)
// ============================================================================

import { useState, type FormEvent } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const LOGO_URL = 'https://i.postimg.cc/9fkz8kVx/DESIGN-(1).png';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Email ou senha incorretos.',
  account_disabled: 'Esta conta foi desativada. Fale com o administrador.',
  no_password_set:
    'Sua conta existe mas ainda não tem senha definida. Peça pro administrador resetar.',
  invalid_input: 'Preencha email e senha corretamente.',
  internal_error: 'Erro interno. Tente de novo em alguns segundos.',
};

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim().toLowerCase(), password);
      // AuthContext atualiza o user e o AuthGate troca de tela.
    } catch (err) {
      const e2 = err as { response?: { data?: { error?: string } }; message?: string };
      const code = e2?.response?.data?.error;
      setError(ERROR_MESSAGES[code ?? ''] ?? e2?.message ?? 'Erro ao entrar.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 px-6">
      <img
        src={LOGO_URL}
        alt="Agente DT"
        className="w-28 h-28 object-contain mb-5 drop-shadow-[0_0_30px_rgba(124,77,255,0.35)]"
      />
      <h1 className="text-2xl font-semibold text-zinc-100 mb-1">Agente DT</h1>
      <p className="text-xs uppercase tracking-[0.3em] text-zinc-500 font-display mb-8">
        Painel administrativo
      </p>

      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-3 bg-zinc-900/40 rounded-xl ring-1 ring-zinc-800 p-6"
      >
        {error && (
          <div className="rounded-md bg-rose-500/10 ring-1 ring-rose-500/30 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        )}

        <div>
          <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">
            Email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoFocus
            required
            className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:ring-brand-500/40 focus:outline-none"
          />
        </div>

        <div>
          <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">
            Senha
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:ring-brand-500/40 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={submitting || !email || !password}
          className="w-full px-4 py-2.5 rounded-md bg-brand-500/20 text-brand-100 ring-1 ring-brand-500/40 inline-flex items-center justify-center gap-2 hover:bg-brand-500/30 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          Entrar
        </button>
      </form>

      <p className="mt-6 text-[11px] text-zinc-600 max-w-sm text-center">
        Acesso restrito. Se não tem cadastro, peça pro administrador criar uma conta pra você.
      </p>
    </div>
  );
}
