// ============================================================================
// useRoute — roteamento minimalista por History API (sem react-router).
//
// LÓGICA DE ENGENHARIA
// --------------------
// Cada AppTab tem um slug de URL legível (ex: 'playground' → '/testar-ia').
// O hook mantém o state em sync com `window.location.pathname`:
//   - lê o pathname no boot (preserva aba após F5)
//   - escuta `popstate` (botões voltar/avançar do browser)
//   - `navigate(tab)` faz `history.pushState` SEM recarregar a página
//
// Por que não react-router?
//   - Uma única navegação (sidebar) com mapeamento estático — overhead injus-
//     tificável (~15kb gz + abstrações).
//   - Em produção precisa do mesmo SPA fallback que tanto faz pra um caso ou
//     outro, então não ganha nada.
//
// SPA fallback: o Vite dev já serve index.html pra qualquer rota não-arquivo.
// Vercel/Netlify fazem o mesmo automaticamente. Em hosting estático "raw",
// adicione a regra `try_files`.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import type { AppTab } from '../components/AppSidebar';

// Map tab ↔ slug. Slugs em PT-BR (pra ficar bonito na URL).
const TAB_TO_SLUG: Record<AppTab, string> = {
  dashboard: 'dashboard',
  wizard: 'configurar-ia',
  playground: 'testar-ia',
  sources: 'fontes',
  actions: 'acoes',
  'global-actions': 'regras-globais',
  tools: 'ferramentas',
  reports: 'relatorios',
  captures: 'capturas',
  conversations: 'conversas',
  traces: 'execucoes',
  errors: 'erros',
  llm: 'chamadas-ia',
  prompts: 'prompts',
  integrations: 'integracoes',
  config: 'avancado',
  units: 'unidades',
  users: 'usuarios',
  whatsapp: 'custo-whatsapp',
};

const SLUG_TO_TAB = Object.fromEntries(
  Object.entries(TAB_TO_SLUG).map(([tab, slug]) => [slug, tab as AppTab]),
) as Record<string, AppTab>;

const DEFAULT_TAB: AppTab = 'dashboard';

function pathnameToTab(pathname: string): AppTab {
  const slug = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return SLUG_TO_TAB[slug] ?? DEFAULT_TAB;
}

/** Path canônico de uma aba — exposto pra montar `<a href>` na sidebar. */
export function tabToPath(tab: AppTab): string {
  return `/${TAB_TO_SLUG[tab]}`;
}

export function useRoute(): {
  tab: AppTab;
  navigate: (tab: AppTab) => void;
} {
  const [tab, setTab] = useState<AppTab>(() => pathnameToTab(window.location.pathname));

  // Se o usuário caiu em "/" (raiz), normaliza pra "/dashboard" sem
  // empilhar histórico — replaceState é o correto.
  useEffect(() => {
    if (window.location.pathname === '/' || window.location.pathname === '') {
      window.history.replaceState(null, '', tabToPath(DEFAULT_TAB));
    }
  }, []);

  // Sincroniza com botões voltar/avançar do navegador.
  useEffect(() => {
    const handler = () => setTab(pathnameToTab(window.location.pathname));
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const navigate = useCallback((next: AppTab) => {
    const target = tabToPath(next);
    if (window.location.pathname !== target) {
      window.history.pushState(null, '', target);
    }
    setTab(next);
  }, []);

  return { tab, navigate };
}
