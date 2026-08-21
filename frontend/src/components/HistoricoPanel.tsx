import { useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';
import { api } from '../lib/api';
import type { ChangeLogEntry } from '../types/api';

const CAT: Record<string, { label: string; cls: string }> = {
  treino: { label: 'Treino', cls: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30' },
  correcao: { label: 'Correção', cls: 'text-amber-300 bg-amber-500/10 ring-amber-500/30' },
  fix: { label: 'Bug corrigido', cls: 'text-rose-300 bg-rose-500/10 ring-rose-500/30' },
  config: { label: 'Configuração', cls: 'text-sky-300 bg-sky-500/10 ring-sky-500/30' },
  feature: { label: 'Novidade', cls: 'text-violet-300 bg-violet-500/10 ring-violet-500/30' },
};
function cat(c: string) {
  return CAT[c] ?? { label: c, cls: 'text-zinc-300 bg-zinc-500/10 ring-zinc-500/30' };
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function HistoricoPanel() {
  const { selectedUnitId } = useUnit();
  const [entries, setEntries] = useState<ChangeLogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedUnitId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    let alive = true;
    api
      .getChangeLog(selectedUnitId)
      .then((e) => {
        if (alive) setEntries(e);
      })
      .catch(() => {
        if (alive) setEntries([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedUnitId]);

  if (!selectedUnitId) {
    return <div className="p-8 text-sm text-zinc-500">Selecione um agente pra ver o histórico.</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-center gap-2.5 mb-1.5">
          <History size={18} className="text-brand-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Histórico de melhorias</h1>
        </div>
        <p className="text-[13px] text-zinc-500 mb-8">
          Tudo que foi treinado, ajustado ou corrigido na IA desta clínica — do mais recente
          pro mais antigo.
        </p>

        {loading && (
          <div className="flex justify-center py-12">
            <Loader2 className="animate-spin text-zinc-500" size={18} />
          </div>
        )}

        {!loading && entries && entries.length === 0 && (
          <div className="surface p-10 text-center text-sm text-zinc-500">
            Nenhuma melhoria registrada ainda. Cada correção ou treino feito na IA desta
            clínica vai aparecer aqui.
          </div>
        )}

        {!loading && entries && entries.length > 0 && (
          <ol className="relative border-l border-zinc-800 ml-1.5 space-y-6">
            {entries.map((e) => {
              const c = cat(e.category);
              return (
                <li key={e.id} className="relative pl-6">
                  <span className="absolute -left-[6.5px] top-1.5 w-3 h-3 rounded-full bg-brand-400 ring-4 ring-zinc-950" />
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={clsx(
                        'inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ring-1',
                        c.cls,
                      )}
                    >
                      {c.label}
                    </span>
                    <span className="text-[11px] text-zinc-500 font-mono">
                      {fmtDate(e.createdAt)}
                    </span>
                    {e.author && <span className="text-[11px] text-zinc-600">· {e.author}</span>}
                  </div>
                  <div className="text-[14px] text-zinc-100 mt-1.5 font-medium">{e.summary}</div>
                  {e.details && (
                    <div className="text-[13px] text-zinc-400 mt-1 leading-relaxed whitespace-pre-wrap">
                      {e.details}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
