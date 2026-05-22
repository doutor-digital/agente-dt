import { lazy, Suspense, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { AppSidebar } from './components/AppSidebar';
import { OnboardingModal } from './components/OnboardingModal';
import { UnitProvider } from './context/UnitContext';
import { KommoMetaProvider } from './context/KommoMetaContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import { Splash } from './components/Splash';
import { useRoute } from './hooks/useRoute';

// Lazy panels — cada um vira um chunk separado, baixa só quando o usuário
// abre a aba. Reduz drasticamente o JS inicial (de ~660KB pra ~150KB) e o
// custo de troca entre abas. React.lazy aceita só default export, então
// adaptamos os named exports em linha.
const DashboardPanel = lazy(() =>
  import('./components/DashboardPanel').then((m) => ({ default: m.DashboardPanel })),
);
const TracesView = lazy(() =>
  import('./components/TracesView').then((m) => ({ default: m.TracesView })),
);
const ErrorsPanel = lazy(() =>
  import('./components/ErrorsPanel').then((m) => ({ default: m.ErrorsPanel })),
);
const ConversationsPanel = lazy(() =>
  import('./components/ConversationsPanel').then((m) => ({ default: m.ConversationsPanel })),
);
const LlmCallsPanel = lazy(() =>
  import('./components/LlmCallsPanel').then((m) => ({ default: m.LlmCallsPanel })),
);
const PromptsPanel = lazy(() =>
  import('./components/PromptsPanel').then((m) => ({ default: m.PromptsPanel })),
);
const IntegrationsPanel = lazy(() =>
  import('./components/IntegrationsPanel').then((m) => ({ default: m.IntegrationsPanel })),
);
const WizardPanel = lazy(() =>
  import('./components/WizardPanel').then((m) => ({ default: m.WizardPanel })),
);
const PlaygroundPanel = lazy(() =>
  import('./components/PlaygroundPanel').then((m) => ({ default: m.PlaygroundPanel })),
);
const FontesPanel = lazy(() =>
  import('./components/FontesPanel').then((m) => ({ default: m.FontesPanel })),
);
const AcoesPanel = lazy(() =>
  import('./components/AcoesPanel').then((m) => ({ default: m.AcoesPanel })),
);
const CapturesPanel = lazy(() =>
  import('./components/CapturesPanel').then((m) => ({ default: m.CapturesPanel })),
);
const FerramentasPanel = lazy(() =>
  import('./components/FerramentasPanel').then((m) => ({ default: m.FerramentasPanel })),
);
const ReportsPanel = lazy(() =>
  import('./components/ReportsPanel').then((m) => ({ default: m.ReportsPanel })),
);
const AgentConfigPanel = lazy(() =>
  import('./components/AgentConfigPanel').then((m) => ({ default: m.AgentConfigPanel })),
);
const UnitsPanel = lazy(() =>
  import('./components/UnitsPanel').then((m) => ({ default: m.UnitsPanel })),
);
const UsersPanel = lazy(() =>
  import('./components/UsersPanel').then((m) => ({ default: m.UsersPanel })),
);

/**
 * App root — multi-tenant + autenticado.
 *
 * Pipeline:
 *   AuthProvider (sessão Google)
 *     ├─ user === undefined → Splash (verificando /auth/me)
 *     ├─ user === null      → Login (tela Google)
 *     └─ user !== null      → UnitProvider + Shell
 *
 * Tabs (depois de logado):
 *  - "dashboard", "traces", "conversations", "llm", "prompts", ...
 *  - "users": gestão de admins (só SUPER_ADMIN)
 *
 * O dropdown UnitSelector no topo filtra todas as views por unidade.
 */
export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

function AuthGate() {
  const { user } = useAuth();
  if (user === undefined) return <Splash />;
  if (user === null) return <Login />;
  return (
    <UnitProvider>
      <KommoMetaProvider>
        <Shell />
      </KommoMetaProvider>
    </UnitProvider>
  );
}

function Shell() {
  const { tab, navigate } = useRoute();

  // Drill-down do Dashboard: o LeadsBucketModal dispara `app:openConversation`.
  // Aqui navegamos pra aba Conversas (atualizando a URL via useRoute); o
  // ConversationsPanel escuta o mesmo evento e seleciona a conversa.
  useEffect(() => {
    const handler = () => navigate('conversations');
    window.addEventListener('app:openConversation', handler);
    return () => window.removeEventListener('app:openConversation', handler);
  }, [navigate]);
  // App renderiza imediatamente — cada panel cuida do próprio loading state.
  // (A Splash com logo continua disponível em ./components/Splash, mas não
  // bloqueia mais o boot.)
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <AppSidebar tab={tab} onChange={navigate} />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Suspense fallback={<PanelSkeleton />}>
          {tab === 'dashboard' && <DashboardPanel />}
          {tab === 'traces' && <TracesView />}
          {tab === 'errors' && <ErrorsPanel />}
          {tab === 'conversations' && <ConversationsPanel />}
          {tab === 'llm' && <LlmCallsPanel />}
          {tab === 'prompts' && <PromptsPanel />}
          {tab === 'integrations' && <IntegrationsPanel />}
          {tab === 'wizard' && <WizardPanel />}
          {tab === 'playground' && <PlaygroundPanel />}
          {tab === 'sources' && <FontesPanel />}
          {tab === 'actions' && <AcoesPanel />}
          {tab === 'global-actions' && <AcoesPanel scope="global" />}
          {tab === 'tools' && <FerramentasPanel />}
          {tab === 'reports' && <ReportsPanel />}
          {tab === 'captures' && <CapturesPanel />}
          {tab === 'config' && <AgentConfigPanel />}
          {tab === 'units' && <UnitsPanel />}
          {tab === 'users' && <UsersPanel />}
        </Suspense>
      </main>
      <OnboardingModal />
    </div>
  );
}

/** Spinner que aparece enquanto o chunk JS do panel baixa. */
function PanelSkeleton() {
  return (
    <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
      <Loader2 className="animate-spin mr-2" size={16} />
      Carregando…
    </div>
  );
}
