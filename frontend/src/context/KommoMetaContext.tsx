// ============================================================================
// KommoMetaContext — cache em memória dos metadados do Kommo por unidade.
//
// POR QUÊ
// -------
// Antes, todo modal de Ações (e cada componente que mostrava picker de tag,
// pipeline, usuário, motivo de perda) fazia 4 chamadas HTTP em paralelo pra
// API do Kommo a CADA abertura. Em conexões lentas, isso travava o modal.
//
// COMO FUNCIONA
// -------------
// Carrega tags + pipelines + users + lossReasons UMA vez por unidade,
// guarda em estado. Componentes consumem via `useKommoMeta()`. Recarrega
// só quando a unidade muda (selectedUnitId) ou quando alguém chama
// `refresh()`.
//
// LIMITAÇÕES
// ----------
// - O cache é em memória do tab — não persiste entre refresh do navegador.
//   Não precisa: TTL natural é a vida do tab.
// - Erros são silenciosos por categoria (só users pode falhar sem afetar tags).
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../lib/api';
import type {
  KommoLossReasonsResponse,
  KommoPipelinesResponse,
  KommoTagsResponse,
  KommoUsersResponse,
} from '../types/api';
import { useUnit } from './UnitContext';

interface KommoMeta {
  tags: KommoTagsResponse | null;
  pipelines: KommoPipelinesResponse | null;
  users: KommoUsersResponse | null;
  lossReasons: KommoLossReasonsResponse | null;
  loading: boolean;
  tagsError: string | null;
  pipelinesError: string | null;
  refresh: () => void;
}

const KommoMetaCtx = createContext<KommoMeta | null>(null);

function friendlyError(raw: string | undefined): string {
  if (!raw) return 'falha ao carregar do Kommo';
  if (raw === 'kommo_not_configured')
    return 'Unidade sem subdomínio/token do Kommo configurado. Vá em Unidades → conecte o Kommo.';
  if (/401|unauthor/i.test(raw))
    return 'Token do Kommo recusado (401). Gere um Long-lived token novo em Unidades.';
  if (/403|forbidden/i.test(raw))
    return 'Sem permissão pra ler tags/etapas (403). Cheque os escopos do token Kommo.';
  return raw;
}

export function KommoMetaProvider({ children }: { children: ReactNode }) {
  const { selectedUnitId } = useUnit();
  const [tags, setTags] = useState<KommoTagsResponse | null>(null);
  const [pipelines, setPipelines] = useState<KommoPipelinesResponse | null>(null);
  const [users, setUsers] = useState<KommoUsersResponse | null>(null);
  const [lossReasons, setLossReasons] = useState<KommoLossReasonsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!selectedUnitId) {
      setTags(null);
      setPipelines(null);
      setUsers(null);
      setLossReasons(null);
      setTagsError(null);
      setPipelinesError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setTagsError(null);
    setPipelinesError(null);
    Promise.all([
      api.kommoTags(selectedUnitId).catch((err) => ({ _err: err } as const)),
      api.kommoPipelines(selectedUnitId).catch((err) => ({ _err: err } as const)),
      api.kommoUsers(selectedUnitId).catch((err) => ({ _err: err } as const)),
      api.kommoLossReasons(selectedUnitId).catch((err) => ({ _err: err } as const)),
    ]).then(([t, p, u, lr]) => {
      if (!alive) return;
      if ('_err' in t) {
        const e = t._err as { response?: { data?: { message?: string; error?: string } } };
        setTagsError(friendlyError(e?.response?.data?.message ?? e?.response?.data?.error));
      } else {
        setTags(t);
      }
      if ('_err' in p) {
        const e = p._err as { response?: { data?: { message?: string; error?: string } } };
        setPipelinesError(friendlyError(e?.response?.data?.message ?? e?.response?.data?.error));
      } else {
        setPipelines(p);
      }
      // users + lossReasons silenciosos — campos opcionais.
      if (!('_err' in u)) setUsers(u);
      if (!('_err' in lr)) setLossReasons(lr);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [selectedUnitId, reloadTick]);

  const refresh = useCallback(() => setReloadTick((n) => n + 1), []);

  const value = useMemo<KommoMeta>(
    () => ({ tags, pipelines, users, lossReasons, loading, tagsError, pipelinesError, refresh }),
    [tags, pipelines, users, lossReasons, loading, tagsError, pipelinesError, refresh],
  );

  return <KommoMetaCtx.Provider value={value}>{children}</KommoMetaCtx.Provider>;
}

export function useKommoMeta(): KommoMeta {
  const ctx = useContext(KommoMetaCtx);
  if (!ctx) {
    throw new Error('useKommoMeta precisa estar dentro de <KommoMetaProvider>');
  }
  return ctx;
}
