// ============================================================================
// UnitContext — gerencia a Unit selecionada globalmente.
//
// Mantém:
//  - lista de Units carregada do back
//  - id da Unit selecionada (persistido em localStorage)
//  - opção "Todas" (selectedUnitId = null) — visão admin
//
// Toda página filha consome `useUnit()` para reagir à seleção. Polling de
// dados deve usar o id atual nas deps pra resetar quando o usuário troca
// de unidade.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Unit } from '../types/api';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';

interface UnitContextValue {
  units: Unit[];
  loading: boolean;
  error: string | null;
  selectedUnitId: string | null;
  selectedUnit: Unit | null;
  setSelectedUnitId: (id: string | null) => void;
  refresh: () => Promise<void>;
}

const UnitContext = createContext<UnitContextValue | null>(null);

const STORAGE_KEY = 'agente-dt:selected-unit';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function UnitProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // UNIT_ADMIN é pinado na própria unit — ignora persistência de seleção.
  const initialSelected =
    user?.role === 'UNIT_ADMIN' ? (user.unitId ?? null) : readStored();
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUnitId, setSelectedUnitIdState] = useState<string | null>(initialSelected);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listUnits();
      setUnits(list);
      // UNIT_ADMIN sempre na sua unit (backend já filtra a lista).
      if (user?.role === 'UNIT_ADMIN') {
        const fixedId = user.unitId ?? (list[0]?.id ?? null);
        setSelectedUnitIdState(fixedId);
        return;
      }
      // SUPER_ADMIN: se a Unit persistida não existe mais, cai pra null (todas).
      if (selectedUnitId && !list.some((u) => u.id === selectedUnitId)) {
        setSelectedUnitIdState(null);
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      }
      // Se não tem nada selecionado e há só uma, seleciona ela.
      if (!selectedUnitId && list.length === 1) {
        setSelectedUnitIdState(list[0].id);
        try { localStorage.setItem(STORAGE_KEY, list[0].id); } catch { /* ignore */ }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedUnitId, user]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.role]);

  const setSelectedUnitId = useCallback(
    (id: string | null) => {
      // UNIT_ADMIN não pode trocar de unit — ignora silenciosamente.
      if (user?.role === 'UNIT_ADMIN') return;
      setSelectedUnitIdState(id);
      try {
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      } catch { /* ignore */ }
    },
    [user],
  );

  const selectedUnit = selectedUnitId ? (units.find((u) => u.id === selectedUnitId) ?? null) : null;

  return (
    <UnitContext.Provider
      value={{ units, loading, error, selectedUnitId, selectedUnit, setSelectedUnitId, refresh }}
    >
      {children}
    </UnitContext.Provider>
  );
}

export function useUnit(): UnitContextValue {
  const ctx = useContext(UnitContext);
  if (!ctx) throw new Error('useUnit precisa ser chamado dentro de <UnitProvider>');
  return ctx;
}
