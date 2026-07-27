// ============================================================================
// Login — tela dark com verde (identidade Doutor Digital).
//
// Sem signup público — o super admin cria usuários pelo painel ou via CLI.
// Códigos de erro retornados pelo backend:
//   invalid_credentials — email/senha errados
//   account_disabled    — user desativado pelo super admin
//   no_password_set     — user existe mas ainda sem senha (peça reset)
//
// TEMA: fundo escuro, coluna esquerda com a logo DD + chamada, card de LOGIN
// verde à direita. Estilo próprio (verde inline), não usa o brand roxo global.
// ============================================================================

import { useState, type FormEvent, type CSSProperties } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { LoginArt } from './LoginArt';

const GREEN = '#2EE68E';
const GREEN_DEEP = '#0f2b1e';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Usuário ou senha incorretos.',
  account_disabled: 'Esta conta foi desativada. Fale com o administrador.',
  no_password_set:
    'Sua conta existe mas ainda não tem senha definida. Peça pro administrador resetar.',
  invalid_input: 'Preencha usuário e senha corretamente.',
  internal_error: 'Erro interno. Tente de novo em alguns segundos.',
};

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
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

  const inputStyle: CSSProperties = {
    background: '#3a3348',
    color: '#eceaf3',
    border: '1px solid #46405a',
  };

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center px-6 py-10"
      style={{ background: '#1b1725' }}
    >
      <div className="w-full max-w-5xl grid gap-12 md:grid-cols-2 md:gap-8 items-center">
        {/* ── Coluna esquerda: chamada + logo DD ────────────────────────── */}
        <div className="flex flex-col items-center md:items-start text-center md:text-left gap-8">
          <h1
            className="text-3xl md:text-[2.75rem] font-bold leading-tight text-balance"
            style={{ color: GREEN }}
          >
            Faça login
            <br />E entre para o nosso time
          </h1>
          <LoginArt className="w-full max-w-md h-auto select-none" />
        </div>

        {/* ── Card de LOGIN ─────────────────────────────────────────────── */}
        <div className="w-full max-w-sm mx-auto md:mx-0 md:justify-self-end">
          <div
            className="rounded-2xl p-7 sm:p-8"
            style={{
              background: '#2a2436',
              border: '1px solid #3a3348',
              boxShadow: '0 24px 60px -20px rgba(0,0,0,0.6)',
            }}
          >
            <h2
              className="text-center text-2xl font-extrabold tracking-[0.2em] mb-7"
              style={{ color: GREEN }}
            >
              LOGIN
            </h2>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.35)', color: '#fca5a5' }}>
                  {error}
                </div>
              )}
              {info && (
                <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(46,230,142,0.10)', border: '1px solid rgba(46,230,142,0.3)', color: GREEN }}>
                  {info}
                </div>
              )}

              <div>
                <label htmlFor="login-user" className="block mb-1.5 text-sm" style={{ color: '#c9c3d9' }}>
                  Usuário
                </label>
                <input
                  id="login-user"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Usuário"
                  autoComplete="username"
                  autoFocus
                  required
                  className="w-full rounded-lg px-3.5 py-2.5 text-sm outline-none transition focus:ring-2"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.boxShadow = `0 0 0 2px ${GREEN}55`)}
                  onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
                />
              </div>

              <div>
                <label htmlFor="login-pass" className="block mb-1.5 text-sm" style={{ color: '#c9c3d9' }}>
                  Senha
                </label>
                <input
                  id="login-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Senha"
                  autoComplete="current-password"
                  required
                  className="w-full rounded-lg px-3.5 py-2.5 text-sm outline-none transition"
                  style={inputStyle}
                  onFocus={(e) => (e.currentTarget.style.boxShadow = `0 0 0 2px ${GREEN}55`)}
                  onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
                />
                <div className="text-right mt-1.5">
                  <button
                    type="button"
                    onClick={() => setInfo('Recuperação por aqui ainda não está ativa. Peça ao administrador para resetar sua senha.')}
                    className="text-xs hover:underline"
                    style={{ color: '#a79ec2' }}
                  >
                    Recuperar senha?
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || !email || !password}
                className="w-full py-3 rounded-lg font-bold tracking-widest text-sm inline-flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: GREEN,
                  color: GREEN_DEEP,
                  boxShadow: `0 0 26px -2px ${GREEN}99`,
                }}
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : null}
                LOGIN
              </button>
            </form>
          </div>

          <p className="mt-5 text-center text-[11px]" style={{ color: '#7d7690' }}>
            Acesso restrito. Sem cadastro? Peça pro administrador criar sua conta.
          </p>
        </div>
      </div>
    </div>
  );
}
