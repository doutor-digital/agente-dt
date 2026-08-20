// ============================================================================
// Login — tela de entrada do console.
//
// Estilo: split com card branco flutuante sobre fundo azul. À esquerda um
// painel azul com a animação (Lottie de chatbot); à direita o formulário claro
// (LOGIN, usuário, senha, lembrar, esqueci). No mobile o painel azul some.
//
// Sem signup público nem login social — a autenticação é e-mail/senha pelo
// backend; o super admin cria usuários pelo painel ou via CLI. Botões falsos de
// "criar conta"/"entrar com Google" enganam, então não entram.
//
// Códigos de erro do backend:
//   invalid_credentials — email/senha errados
//   account_disabled    — user desativado
//   no_password_set     — user existe mas sem senha (peça reset)
// ============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import Lottie from 'lottie-react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

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
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Lottie da coluna azul — carregado de /public pra não inchar o bundle.
  const [anim, setAnim] = useState<object | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/ai-chatbot.json')
      .then((r) => r.json())
      .then((d) => {
        if (alive) setAnim(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      await login(email.trim().toLowerCase(), password);
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
      className="min-h-screen w-full flex items-center justify-center p-4 sm:p-6"
      style={{
        background: 'radial-gradient(120% 120% at 30% 10%, #5cc0ff 0%, #16a6ff 42%, #0b84e6 100%)',
      }}
    >
      <div className="w-full max-w-4xl grid md:grid-cols-2 rounded-[26px] overflow-hidden bg-white shadow-[0_30px_90px_rgba(4,58,110,0.45)]">
        {/* ── Painel azul + animação (some no mobile) ────────────────────────── */}
        <aside className="relative hidden md:flex flex-col items-center justify-center bg-[#12a6ff] p-10 overflow-hidden">
          {/* folhas decorativas suaves (como a referência) */}
          <span className="pointer-events-none absolute -left-8 bottom-8 h-40 w-40 rounded-[46%] bg-white/10 blur-[2px]" />
          <span className="pointer-events-none absolute -right-6 bottom-16 h-28 w-28 rounded-[46%] bg-white/10 blur-[2px]" />

          <div className="relative flex items-center gap-2.5 self-start">
            <img
              src="/logo-dd.png"
              alt=""
              className="w-9 h-9 rounded-xl object-contain bg-white/15 p-1.5 ring-1 ring-white/25"
            />
            <span className="text-white font-semibold tracking-tight">Doutor Digital</span>
          </div>

          <div className="relative flex-1 w-full flex items-center justify-center py-6">
            {anim ? (
              <Lottie animationData={anim} loop autoplay className="w-full max-w-[300px]" />
            ) : (
              <div className="h-[220px]" />
            )}
          </div>

          <p className="relative text-center text-white/90 text-[15px] leading-relaxed max-w-[280px]">
            Seus agentes de IA, conectados ao Kommo — do primeiro “oi” ao lead na etapa
            certa.
          </p>
        </aside>

        {/* ── Formulário ─────────────────────────────────────────────────────── */}
        <main className="flex flex-col justify-center px-7 py-12 sm:px-12">
          {/* marca compacta só no mobile (painel azul sumiu) */}
          <div className="flex md:hidden items-center justify-center gap-2.5 mb-6">
            <img src="/logo-dd.png" alt="" className="w-9 h-9 rounded-xl object-contain ring-1 ring-slate-200 p-1" />
            <span className="text-slate-700 font-semibold tracking-tight">Doutor Digital</span>
          </div>

          <h1 className="text-2xl font-extrabold tracking-wide text-slate-800 text-center">LOGIN</h1>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            {error && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-[12px] text-rose-600">
                {error}
              </div>
            )}
            {info && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[12px] text-sky-700">
                {info}
              </div>
            )}

            <label className="block">
              <span className="text-[13px] font-medium text-slate-600">Usuário</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="@mail.com"
                autoComplete="username"
                autoFocus
                required
                className="mt-1.5 w-full rounded-lg bg-slate-100 border border-transparent px-3.5 py-2.5 text-[14px] text-slate-800 placeholder:text-slate-400 outline-none transition focus:bg-white focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
            </label>

            <label className="block">
              <span className="text-[13px] font-medium text-slate-600">Senha</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="senha"
                autoComplete="current-password"
                required
                className="mt-1.5 w-full rounded-lg bg-slate-100 border border-transparent px-3.5 py-2.5 text-[14px] text-slate-800 placeholder:text-slate-400 outline-none transition focus:bg-white focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
            </label>

            <div className="flex items-center justify-between text-[13px]">
              <label className="flex items-center gap-2 text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-sky-500 accent-sky-500"
                />
                Lembrar de mim
              </label>
              <button
                type="button"
                onClick={() =>
                  setInfo(
                    'Recuperação automática ainda não está ativa. Peça ao administrador para resetar sua senha.',
                  )
                }
                className="font-medium text-sky-600 hover:text-sky-700 transition-colors"
              >
                Esqueceu a senha?
              </button>
            </div>

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[#12a6ff] py-2.5 text-[14px] font-semibold text-white shadow-[0_8px_20px_rgba(18,166,255,0.35)] transition hover:bg-[#0b93e6] disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting && <Loader2 size={15} className="animate-spin" />}
              {submitting ? 'Entrando…' : 'Entrar'}
            </button>
          </form>

          <p className="mt-8 text-center text-[12px] leading-relaxed text-slate-400">
            Acesso restrito ao time. Não existe cadastro público — peça sua conta ao
            administrador.
          </p>
        </main>
      </div>
    </div>
  );
}
