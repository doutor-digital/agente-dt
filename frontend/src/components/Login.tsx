// ============================================================================
// Login — tela única com botão "Entrar com Google".
//
// Lê `?auth_error=...` do querystring (vindo do redirect do callback) e
// mostra mensagem apropriada. Códigos esperados:
//   not_invited        — email não foi pré-cadastrado por super admin
//   account_disabled   — usuário existente foi desativado
//   email_not_verified — Google retornou email sem verificação
//   state_mismatch     — CSRF (cookie auth_state ausente/divergente)
//   oauth_not_configured — falta GOOGLE_CLIENT_ID/SECRET no .env do backend
//   invalid_code       — code expirado/usado/inválido
// ============================================================================

import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const LOGO_URL = 'https://i.postimg.cc/9fkz8kVx/DESIGN-(1).png';

const ERROR_MESSAGES: Record<string, string> = {
  not_invited:
    'Esta conta Google não está cadastrada no painel. Peça pro administrador te convidar.',
  account_disabled: 'Esta conta foi desativada. Fale com o administrador.',
  email_not_verified:
    'O Google retornou esse email como não verificado. Verifique sua conta Google e tente de novo.',
  state_mismatch: 'A sessão de login expirou (CSRF). Tente entrar de novo.',
  oauth_not_configured:
    'O backend ainda não tem as credenciais do Google OAuth. Configure GOOGLE_CLIENT_ID/SECRET no .env.',
  invalid_code: 'Não foi possível trocar o código de login. Tente entrar de novo.',
  internal_error: 'Erro inesperado durante o login. Tente novamente.',
  missing_code: 'O Google não retornou um código de autorização. Tente de novo.',
};

export function Login() {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  // Pega ?auth_error=... e limpa da URL pra não persistir após refresh.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('auth_error');
    if (code) {
      setError(ERROR_MESSAGES[code] ?? `Erro: ${code}`);
      params.delete('auth_error');
      const newUrl =
        window.location.pathname + (params.toString() ? `?${params.toString()}` : '');
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-zinc-950 text-zinc-100 px-6">
      <img
        src={LOGO_URL}
        alt="Agente DT"
        className="w-32 h-32 object-contain mb-6 drop-shadow-[0_0_30px_rgba(124,77,255,0.35)]"
      />
      <h1 className="text-2xl font-semibold text-zinc-100 mb-1">Agente DT</h1>
      <p className="text-xs uppercase tracking-[0.3em] text-zinc-500 font-display mb-8">
        Painel administrativo
      </p>

      {error && (
        <div className="mb-6 max-w-sm rounded-md bg-rose-500/10 ring-1 ring-rose-500/30 px-4 py-3 text-xs text-rose-200">
          {error}
        </div>
      )}

      <button
        type="button"
        onClick={login}
        className="px-6 py-3 rounded-md bg-white text-zinc-900 inline-flex items-center gap-3 hover:bg-zinc-100 font-medium shadow-lg shadow-black/40"
      >
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A10.997 10.997 0 0 0 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.997 10.997 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l2.85-2.22.81-.62z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          />
        </svg>
        Entrar com Google
      </button>

      <p className="mt-6 text-[11px] text-zinc-600 max-w-sm text-center">
        Acesso restrito. Se não tem cadastro, peça pro administrador te convidar pelo email da sua
        conta Google.
      </p>
    </div>
  );
}
