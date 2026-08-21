// ============================================================================
// StrategyLab — "3 jeitos de responder" para um lead travado.
//
// O dono abre a conversa, clica, e recebe 3 mensagens prontas — cada uma com
// uma abordagem diferente — pra copiar a que ele sabe que funciona com aquele
// paciente. É busca de caminhos feita FORA do turno do paciente: aqui quem
// espera 5 segundos é o dono, não quem está com dor.
// ============================================================================

import { useState } from 'react';
import { Lightbulb, Copy, Check, Loader2, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type { StrategyCandidato } from '../types/api';

export function StrategyLab({ conversationId }: { conversationId: string }) {
  const { selectedUnitId } = useUnit();
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [cands, setCands] = useState<StrategyCandidato[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<number | null>(null);

  async function gerar() {
    if (!selectedUnitId || carregando) return;
    setAberto(true);
    setCarregando(true);
    setErro(null);
    setCands(null);
    try {
      const r = await api.runStrategyLab(selectedUnitId, conversationId);
      setRunId(r.runId);
      setCands(r.candidatos);
      if (r.candidatos.length === 0) setErro('Não consegui gerar sugestões agora.');
    } catch {
      setErro('Não consegui gerar sugestões agora. Tente de novo em instantes.');
    } finally {
      setCarregando(false);
    }
  }

  async function copiar(c: StrategyCandidato, i: number) {
    try {
      await navigator.clipboard.writeText(c.texto);
      setCopiado(i);
      setTimeout(() => setCopiado(null), 2000);
      // Registra a escolha — é como sabemos se a ferramenta serve de verdade.
      if (selectedUnitId && runId) void api.escolherEstrategia(selectedUnitId, runId, c.texto);
    } catch {
      setCopiado(null);
    }
  }

  return (
    <div className="border-t border-zinc-800/80 bg-ink-900/40">
      <button
        type="button"
        onClick={() => (aberto && cands ? setAberto(false) : void gerar())}
        disabled={carregando}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-[12px] font-medium text-violet-300 hover:bg-violet-500/10 disabled:opacity-60"
      >
        {carregando ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />}
        {carregando
          ? 'Pensando em 3 abordagens…'
          : aberto && cands
            ? 'Fechar sugestões'
            : 'Travou? Ver 3 jeitos de responder'}
      </button>

      {aberto && (
        <div className="px-4 pb-4 space-y-2.5">
          {erro && <div className="text-[12px] text-rose-300">{erro}</div>}

          {cands?.map((c, i) => (
            <div key={i} className="rounded-lg bg-zinc-900/70 ring-1 ring-zinc-800 p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] uppercase tracking-wide font-semibold text-violet-300">
                  {c.titulo}
                </span>
                {c.alertas.length > 0 && (
                  <span
                    title={`A trava de segurança apontou: ${c.alertas.join(', ')}. Revise antes de enviar.`}
                    className="inline-flex items-center gap-1 text-[10px] text-amber-300"
                  >
                    <AlertTriangle size={10} /> revisar
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void copiar(c, i)}
                  className="ml-auto inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-100"
                >
                  {copiado === i ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                  {copiado === i ? 'copiado' : 'copiar'}
                </button>
              </div>
              <p className={clsx('text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-200')}>
                {c.texto}
              </p>
            </div>
          ))}

          {cands && cands.length > 0 && (
            <p className="text-[11px] text-zinc-600">
              Copie a que combina com este paciente e envie pelo WhatsApp. A IA não manda nada
              sozinha aqui.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
