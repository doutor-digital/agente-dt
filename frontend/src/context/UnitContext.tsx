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
      if (user?.role === 'UNIT_ADMIN') {
        const fixedId = user.unitId ?? (list[0]?.id ?? null);
        setSelectedUnitIdState(fixedId);
        return;
      }
      if (selectedUnitId && !list.some((u) => u.id === selectedUnitId)) {
        setSelectedUnitIdState(null);
        try { localStorage.removeItem(STORAGE_KEY); } catch {  }
      }
      if (!selectedUnitId && list.length === 1) {
        setSelectedUnitIdState(list[0].id);
        try { localStorage.setItem(STORAGE_KEY, list[0].id); } catch {  }
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
      if (user?.role === 'UNIT_ADMIN') return;
      setSelectedUnitIdState(id);
      try {
        if (id) localStorage.setItem(STORAGE_KEY, id);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {  }
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
