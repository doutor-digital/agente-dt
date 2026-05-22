import { useEffect, useMemo, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ExecutionTrace } from './components/ExecutionTrace';
import { StatsHeader } from './components/StatsHeader';
import { AgentConfigPanel } from './components/AgentConfigPanel';
import { ConversationsPanel } from './components/ConversationsPanel';
import { LlmCallsPanel } from './components/LlmCallsPanel';
import { PromptsPanel } from './components/PromptsPanel';
import { UnitsPanel } from './components/UnitsPanel';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { WizardPanel } from './components/WizardPanel';
import { PlaygroundPanel } from './components/PlaygroundPanel';
import { FontesPanel } from './components/FontesPanel';
import { AcoesPanel } from './components/AcoesPanel';
import { AppSidebar } from './components/AppSidebar';
import { CapturesPanel } from './components/CapturesPanel';
import { FerramentasPanel } from './components/FerramentasPanel';
import { DashboardPanel } from './components/DashboardPanel';
import { ErrorsPanel } from './components/ErrorsPanel';
import { OnboardingModal } from './components/OnboardingModal';
import { UnitProvider, useUnit } from './context/UnitContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import { Splash } from './components/Splash';
import { UsersPanel } from './components/UsersPanel';
import { usePolling } from './hooks/usePolling';
import { useRoute } from './hooks/useRoute';
import { api } from './lib/api';
import type { TraceDetail } from './types/api';

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
      <Shell />
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
        {tab === 'tools' && <FerramentasPanel />}
        {tab === 'captures' && <CapturesPanel />}
        {tab === 'config' && <AgentConfigPanel />}
        {tab === 'units' && <UnitsPanel />}
        {tab === 'users' && <UsersPanel />}
      </main>
      <OnboardingModal />
    </div>
  );
}


function TracesView() {
  const { selectedUnitId } = useUnit();
  const tracesFetcher = useMemo(() => () => api.listTraces(selectedUnitId), [selectedUnitId]);
  const statsFetcher = useMemo(() => () => api.getStats(selectedUnitId), [selectedUnitId]);

  const { data: traces, loading } = usePolling(tracesFetcher, 3000, [selectedUnitId]);
  const { data: stats } = usePolling(statsFetcher, 5000, [selectedUnitId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);

  // Reset quando troca de unidade.
  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
  }, [selectedUnitId]);

  useEffect(() => {
    if (!selectedId && traces && traces.length > 0) {
      setSelectedId(traces[0].id);
    }
  }, [traces, selectedId]);

  const detailInterval = detail?.status === 'RUNNING' ? 1000 : 4000;
  const detailFetcher = useMemo(
    () => async () => (selectedId ? api.getTrace(selectedId) : null),
    [selectedId],
  );
  const { data: fetchedDetail } = usePolling(detailFetcher, detailInterval, [selectedId]);

  useEffect(() => {
    if (fetchedDetail) setDetail(fetchedDetail);
    if (!selectedId) setDetail(null);
  }, [fetchedDetail, selectedId]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar
        traces={traces ?? []}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={loading}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 pt-5">
          <StatsHeader stats={stats} />
        </div>
        <div className="flex-1 overflow-hidden flex flex-col">
          <ExecutionTrace trace={detail} />
        </div>
      </div>
    </div>
  );
}
