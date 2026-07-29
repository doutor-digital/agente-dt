import { lazy, Suspense, useEffect, useState } from 'react';
import { AppSidebar } from './components/AppSidebar';
import { TopBar } from './components/TopBar';
import { CommandPalette, useCommandPalette } from './components/CommandPalette';
import { OnboardingModal } from './components/OnboardingModal';
import { UnitHub } from './components/UnitHub';
import { UnitProvider, useUnit } from './context/UnitContext';
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
const DeliveryMonitorPanel = lazy(() =>
  import('./components/DeliveryMonitorPanel').then((m) => ({ default: m.DeliveryMonitorPanel })),
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
const TrainingPanel = lazy(() =>
  import('./components/TrainingPanel').then((m) => ({ default: m.TrainingPanel })),
);
const FontesPanel = lazy(() =>
  import('./components/FontesPanel').then((m) => ({ default: m.FontesPanel })),
);
const AcoesPanel = lazy(() =>
  import('./components/AcoesPanel').then((m) => ({ default: m.AcoesPanel })),
);
const SocialCommentsPanel = lazy(() => import('./components/SocialCommentsPanel'));
const AgendaPanel = lazy(() => import('./components/AgendaPanel'));
const CapturesPanel = lazy(() =>
  import('./components/CapturesPanel').then((m) => ({ default: m.CapturesPanel })),
);
const FerramentasPanel = lazy(() =>
  import('./components/FerramentasPanel').then((m) => ({ default: m.FerramentasPanel })),
);
const ReportsPanel = lazy(() =>
  import('./components/ReportsPanel').then((m) => ({ default: m.ReportsPanel })),
);
const WhatsappCostsPanel = lazy(() =>
  import('./components/WhatsappCostsPanel').then((m) => ({ default: m.WhatsappCostsPanel })),
);
const AgentConfigPanel = lazy(() =>
  import('./components/AgentConfigPanel').then((m) => ({ default: m.AgentConfigPanel })),
);
const UnitsPanel = lazy(() =>
  import('./components/UnitsPanel').then((m) => ({ default: m.UnitsPanel })),
);
const AgentWorkspace = lazy(() =>
  import('./components/AgentWorkspace').then((m) => ({ default: m.AgentWorkspace })),
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
        <AppEntry />
      </KommoMetaProvider>
    </UnitProvider>
  );
}

// Decide entre a landing de unidades (UnitHub) e o app (Shell). SUPER_ADMIN sem
// unidade escolhida cai no hub; UNIT_ADMIN (pinado na própria unit) e quem já
// escolheu uma unidade vão direto pro Shell. "Ver painel geral" (viewAll) entra
// no Shell com a visão de todas as unidades.
function AppEntry() {
  const { user } = useAuth();
  const { selectedUnitId, setSelectedUnitId } = useUnit();
  const [viewAll, setViewAll] = useState(false);

  const showHub = user?.role === 'SUPER_ADMIN' && !selectedUnitId && !viewAll;
  if (showHub) {
    return <UnitHub onViewAll={() => setViewAll(true)} />;
  }
  return (
    <Shell
      onBackToHub={
        user?.role === 'SUPER_ADMIN'
          ? () => {
              setViewAll(false);
              setSelectedUnitId(null);
            }
          : undefined
      }
    />
  );
}

function Shell({ onBackToHub }: { onBackToHub?: () => void }) {
  const { tab, navigate } = useRoute();
  const [paletteOpen, openPalette, closePalette] = useCommandPalette();

  // Drill-down do Dashboard: o LeadsBucketModal dispara `app:openConversation`.
  // Aqui navegamos pra aba Conversas (atualizando a URL via useRoute); o
  // ConversationsPanel escuta o mesmo evento e seleciona a conversa.
  useEffect(() => {
    const handler = () => navigate('conversations');
    window.addEventListener('app:openConversation', handler);
    return () => window.removeEventListener('app:openConversation', handler);
  }, [navigate]);

  // App renderiza imediatamente — cada panel cuida do próprio loading state.
  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <AppSidebar tab={tab} onChange={navigate} onBackToHub={onBackToHub} />
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <TopBar tab={tab} onOpenPalette={openPalette} onBackToHub={onBackToHub} />
        {/* `app-ambient` põe o halo de acento no topo do conteúdo — a assinatura
            visual do console. `key` remonta a área a cada troca de aba pra
            reiniciar a animação de entrada. */}
        <div key={tab} className="app-ambient flex-1 flex flex-col overflow-hidden animate-fade-in-up">
          <Suspense fallback={<PanelSkeleton />}>
            {tab === 'dashboard' && <DashboardPanel />}
            {tab === 'configure' && <AgentWorkspace />}
            {tab === 'traces' && <TracesView />}
            {tab === 'errors' && <ErrorsPanel />}
            {tab === 'delivery' && <DeliveryMonitorPanel />}
            {tab === 'conversations' && <ConversationsPanel />}
            {tab === 'llm' && <LlmCallsPanel />}
            {tab === 'prompts' && <PromptsPanel />}
            {tab === 'integrations' && <IntegrationsPanel />}
            {tab === 'wizard' && <WizardPanel />}
            {tab === 'playground' && <PlaygroundPanel />}
            {tab === 'training' && <TrainingPanel onNavigate={navigate} />}
            {tab === 'sources' && <FontesPanel />}
            {tab === 'actions' && <AcoesPanel />}
            {tab === 'global-actions' && <AcoesPanel scope="global" />}
            {tab === 'tools' && <FerramentasPanel />}
            {tab === 'reports' && <ReportsPanel />}
            {tab === 'whatsapp' && <WhatsappCostsPanel />}
            {tab === 'captures' && <CapturesPanel />}
            {tab === 'instagram' && <SocialCommentsPanel platform="instagram" />}
            {tab === 'facebook' && <SocialCommentsPanel platform="facebook" />}
            {tab === 'agenda' && <AgendaPanel />}
            {tab === 'config' && <AgentConfigPanel />}
            {tab === 'units' && <UnitsPanel />}
            {tab === 'users' && <UsersPanel />}
          </Suspense>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={closePalette} onNavigate={navigate} />
      <OnboardingModal />
    </div>
  );
}

/**
 * Esqueleto exibido enquanto o chunk JS do painel baixa. Blocos com o mesmo
 * ritmo do conteúdo real — menos "pulo" na hora que o painel monta do que um
 * spinner centralizado.
 */
function PanelSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-4">
      <div className="h-7 w-56 rounded-lg bg-zinc-900 animate-pulse" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 rounded-xl bg-zinc-900 animate-pulse"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
      <div className="h-64 rounded-xl bg-zinc-900 animate-pulse" style={{ animationDelay: '160ms' }} />
    </div>
  );
}
