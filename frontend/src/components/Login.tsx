// ============================================================================
// Login — tela de entrada do console.
//
// Layout split, padrão das plataformas de IA: à esquerda a MARCA e a promessa
// do produto (fundo escuro com malha de pontos + halo do acento); à direita um
// cartão de autenticação sóbrio e estreito. Em telas pequenas a coluna da
// esquerda some e sobra só o cartão — o formulário nunca é o que quebra.
//
// Sem signup público — o super admin cria usuários pelo painel ou via CLI.
// Códigos de erro do backend:
//   invalid_credentials — email/senha errados
//   account_disabled    — user desativado pelo super admin
//   no_password_set     — user existe mas ainda sem senha (peça reset)
// ============================================================================

import { useState, type FormEvent } from 'react';
import { ArrowRight, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Usuário ou senha incorretos.',
  account_disabled: 'Esta conta foi desativada. Fale com o administrador.',
  no_password_set:
    'Sua conta existe mas ainda não tem senha definida. Peça pro administrador resetar.',
  invalid_input: 'Preencha usuário e senha corretamente.',
  internal_error: 'Erro interno. Tente de novo em alguns segundos.',
};

const HIGHLIGHTS = [
  'Agentes de IA conectados ao seu Kommo',
  'Cada execução rastreada: passo, custo e latência',
  'Ações no CRM disparadas pela própria conversa',
];

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

  return (
    <div className="dark min-h-screen w-full bg-zinc-950 text-zinc-100 lg:grid lg:grid-cols-[1.1fr_1fr]">
      {/* ── Coluna da marca (some no mobile) ───────────────────────────────── */}
      <aside className="relative hidden lg:flex flex-col justify-between p-12 overflow-hidden border-r border-zinc-800">
        <div className="absolute inset-0 grid-mesh opacity-70 pointer-events-none" />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(70% 60% at 20% 10%, color-mix(in oklab, var(--b-500) 16%, transparent), transparent 70%)',
          }}
        />

        <div className="relative flex items-center gap-3">
          <img
            src="/logo-dd.png"
            alt=""
            className="w-10 h-10 rounded-xl object-contain ring-1 ring-zinc-800 bg-zinc-900 p-1.5"
          />
          <div>
            <div className="text-sm font-semibold tracking-tight">Doutor Digital</div>
            <div className="text-[11px] text-zinc-500">Console de agentes</div>
          </div>
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-[2.6rem] leading-[1.08] font-semibold tracking-tight text-balance">
            Seus agentes de IA,
            <br />
            <span className="text-brand-400">sob controle total.</span>
          </h1>
          <p className="mt-5 text-[15px] leading-relaxed text-zinc-400 max-w-md">
            Configure a persona, ligue no CRM e acompanhe cada conversa — do primeiro
            “oi” até o lead na etapa certa.
          </p>

          <ul className="mt-8 space-y-3">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-start gap-3 text-sm text-zinc-300">
                <span className="mt-0.5 w-4 h-4 rounded-full bg-brand-500/15 ring-1 ring-brand-500/30 flex items-center justify-center shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand-400" />
                </span>
                {h}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-[11px] text-zinc-600">
          © {new Date().getFullYear()} Doutor Digital · Acesso restrito
        </div>
      </aside>

      {/* ── Cartão de autenticação ─────────────────────────────────────────── */}
      <main className="flex items-center justify-center px-6 py-14 min-h-screen lg:min-h-0">
        <div className="w-full max-w-sm">
          {/* Marca compacta — só no mobile, onde a coluna da esquerda sumiu. */}
          <div className="flex lg:hidden items-center gap-3 mb-8">
            <img
              src="/logo-dd.png"
              alt=""
              className="w-9 h-9 rounded-xl object-contain ring-1 ring-zinc-800 bg-zinc-900 p-1.5"
            />
            <span className="text-sm font-semibold tracking-tight">Agente DT</span>
          </div>

          <h2 className="text-xl font-semibold tracking-tight">Entrar no console</h2>
          <p className="mt-1.5 text-[13px] text-zinc-500">
            Use as credenciais que o administrador criou pra você.
          </p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4">
            {error && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-[12px] text-rose-300">
                {error}
              </div>
            )}
            {info && (
              <div className="rounded-lg border border-brand-500/30 bg-brand-500/10 px-3 py-2.5 text-[12px] text-brand-300">
                {info}
              </div>
            )}

            <label className="block">
              <span className="text-[12px] font-medium text-zinc-400">E-mail</span>
              <span className="mt-1.5 relative block">
                <Mail
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@clinica.com.br"
                  autoComplete="username"
                  autoFocus
                  required
                  className="field pl-9 py-2.5"
                />
              </span>
            </label>

            <label className="block">
              <span className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-zinc-400">Senha</span>
                <button
                  type="button"
                  onClick={() =>
                    setInfo(
                      'Recuperação automática ainda não está ativa. Peça ao administrador para resetar sua senha.',
                    )
                  }
                  className="text-[11px] text-zinc-500 hover:text-brand-300 transition-colors"
                >
                  Esqueci a senha
                </button>
              </span>
              <span className="mt-1.5 relative block">
                <Lock
                  size={15}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  className="field pl-9 py-2.5"
                />
              </span>
            </label>

            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="btn-primary w-full py-2.5 group"
            >
              {submitting ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <ArrowRight
                  size={15}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              )}
              {submitting ? 'Entrando…' : 'Entrar'}
            </button>
          </form>

          <div className="mt-7 flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-zinc-600" />
            Acesso restrito ao time. Não existe cadastro público — peça ao administrador
            para criar sua conta.
          </div>
        </div>
      </main>
    </div>
  );
}
