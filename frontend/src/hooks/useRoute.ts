import { useCallback, useEffect, useState } from 'react';
import type { AppTab } from '../lib/nav';

const TAB_TO_SLUG: Record<AppTab, string> = {
  dashboard: 'dashboard',
  configure: 'configurar-agente',
  wizard: 'configurar-ia',
  playground: 'testar-ia',
  training: 'treinar-ia',
  sources: 'fontes',
  actions: 'acoes',
  'global-actions': 'regras-globais',
  tools: 'ferramentas',
  reports: 'relatorios',
  captures: 'capturas',
  conversations: 'conversas',
  traces: 'execucoes',
  errors: 'erros',
  delivery: 'entrega',
  llm: 'chamadas-ia',
  prompts: 'prompts',
  integrations: 'integracoes',
  config: 'avancado',
  units: 'unidades',
  users: 'usuarios',
  whatsapp: 'custo-whatsapp',
  instagram: 'instagram',
  facebook: 'facebook',
  agenda: 'agenda',
  'follow-up': 'follow-up',
  'crm-franquia': 'crm-franquia',
  'saude-ia': 'saude-ia',
  resultados: 'resultados',
  'como-funciona': 'como-funciona',
};

const SLUG_TO_TAB = Object.fromEntries(
  Object.entries(TAB_TO_SLUG).map(([tab, slug]) => [slug, tab as AppTab]),
) as Record<string, AppTab>;

const DEFAULT_TAB: AppTab = 'dashboard';

function pathnameToTab(pathname: string): AppTab {
  const slug = pathname.replace(/^\/+/, '').split('/')[0] ?? '';
  return SLUG_TO_TAB[slug] ?? DEFAULT_TAB;
}

export function tabToPath(tab: AppTab): string {
  return `/${TAB_TO_SLUG[tab]}`;
}

export function useRoute(): {
  tab: AppTab;
  navigate: (tab: AppTab) => void;
} {
  const [tab, setTab] = useState<AppTab>(() => pathnameToTab(window.location.pathname));

  useEffect(() => {
    if (window.location.pathname === '/' || window.location.pathname === '') {
      window.history.replaceState(null, '', tabToPath(DEFAULT_TAB));
    }
  }, []);

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
