// ============================================================================
// Login — tela com form email/senha.
//
// Sem signup público — o super admin cria usuários pelo painel ou via CLI.
// Códigos de erro retornados pelo backend:
//   invalid_credentials — email/senha errados
//   account_disabled    — user desativado pelo super admin
//   no_password_set     — user existe mas ainda sem senha (peça reset)
//
// TEMA: card branco sobre foto de fundo (estilo híbrido do Kommo).
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
    <div
      className="h-screen w-screen flex flex-col items-center justify-center px-6 bg-cover bg-center bg-[#0a1628]"
      style={{
        backgroundImage:
          'linear-gradient(to bottom, rgba(8,8,12,0.55) 0%, rgba(8,8,12,0.78) 100%), url(https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2000&q=70)',
      }}
    >
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl ring-1 ring-black/5 p-7 flex flex-col items-center">
        <img src={LOGO_URL} alt="Agente DT" className="w-20 h-20 object-contain mb-4" />
        <h1 className="text-2xl font-bold text-zinc-900">Agente DT</h1>
        <p className="text-[11px] uppercase tracking-[0.3em] text-zinc-400 mb-6">
          Painel administrativo
        </p>

        <form onSubmit={handleSubmit} className="w-full space-y-3">
          {error && (
            <div className="rounded-md bg-rose-50 ring-1 ring-rose-200 px-3 py-2 text-xs text-rose-700">
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
              className="w-full rounded-md bg-zinc-50 ring-1 ring-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:outline-none transition"
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
              className="w-full rounded-md bg-zinc-50 ring-1 ring-zinc-200 px-3 py-2 text-sm text-zinc-900 focus:bg-white focus:ring-2 focus:ring-brand-500/50 focus:outline-none transition"
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !email || !password}
            className="w-full px-4 py-2.5 rounded-md bg-brand-600 text-white inline-flex items-center justify-center gap-2 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-sm transition-colors shadow-sm shadow-brand-600/20"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
            Entrar
          </button>
        </form>
      </div>

      <p className="mt-6 text-[11px] text-zinc-300 max-w-sm text-center">
        Acesso restrito. Se não tem cadastro, peça pro administrador criar uma conta pra você.
      </p>
    </div>
  );
}
