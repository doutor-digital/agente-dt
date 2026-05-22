// ============================================================================
// FerramentasPanel — aba dedicada pra ligar/desligar tools da IA e editar
// suas descrições (que são os gatilhos que o LLM lê pra decidir QUANDO chamar).
//
// Antes vivia dentro de AgentConfigPanel ("Avançado"), mas a Avançado misturava
// prompt + tools + modelo. Tools agora é cidadão de 1ª classe da sidebar.
// ============================================================================

import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCcw,
  Save,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AgentConfigInput, AgentConfigResponse, ToolConfig } from '../types/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';

export function FerramentasPanel() {
  const { selectedUnitId } = useUnit();
  const toast = useToast();
  const [loaded, setLoaded] = useState<AgentConfigResponse | null>(null);
  const [draft, setDraft] = useState<AgentConfigInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setDraft(null);
    api.getConfig(selectedUnitId).then((r) => {
      if (!alive) return;
      setLoaded(r);
      // Merge tools conhecidas (vindas do código) com as salvas no banco.
      // Garante que tools novas apareçam na UI mesmo antes do primeiro save.
      const byName = new Map(r.config.tools.map((t) => [t.name, t]));
      const merged: ToolConfig[] = r.knownTools.map((name) => {
        const existing = byName.get(name);
        const fallback = r.defaults.tools.find((t) => t.name === name);
        return (
          existing ?? {
            name,
            enabled: true,
            description: fallback?.description ?? '',
          }
        );
      });
      setDraft({
        unitId: selectedUnitId,
        systemPrompt: r.config.systemPrompt,
        tools: merged,
        workflow: r.config.workflow,
        model: r.config.model,
        temperature: r.config.temperature,
        maxTokens: r.config.maxTokens,
      });
    });
    return () => {
      alive = false;
    };
  }, [selectedUnitId]);

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando ferramentas…
      </div>
    );
  }

  const dirty = JSON.stringify(draft.tools) !== JSON.stringify(loaded.config.tools);

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await api.saveConfig({ ...draft, unitId: selectedUnitId });
      setLoaded({ ...loaded, config: saved });
      toast.success('Ferramentas salvas. Próxima execução já reflete.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao salvar: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const updateTool = (name: string, patch: Partial<ToolConfig>) => {
    setDraft({
      ...draft,
      tools: draft.tools.map((t) => (t.name === name ? { ...t, ...patch } : t)),
    });
  };

  const resetToolDescription = (name: string) => {
    const fallback = loaded.defaults.tools.find((t) => t.name === name);
    if (fallback) updateTool(name, { description: fallback.description });
  };

  const enabledCount = draft.tools.filter((t) => t.enabled).length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between sticky top-0 bg-zinc-950/95 backdrop-blur py-3 z-10 border-b border-zinc-800/60">
          <div>
            <h1 className="text-2xl font-display font-bold text-zinc-100 tracking-tight flex items-center gap-2">
              <Wrench size={22} className="text-brand-300" />
              Ferramentas
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              Ligue/desligue as tools que a IA pode usar. A descrição é o gatilho que
              o LLM lê pra decidir QUANDO chamar — edite pra mudar comportamento sem
              tocar no código.
            </p>
            <p className="text-[11px] text-zinc-600 mt-1">
              <strong className="text-zinc-400">{enabledCount}</strong> de{' '}
              <strong className="text-zinc-400">{draft.tools.length}</strong> ativas.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Salvando…' : dirty ? 'Salvar alterações' : 'Salvo'}
          </button>
        </div>

        {/* Lista de tools */}
        <section className="space-y-2">
          {draft.tools.map((tool) => {
            const expanded = openTools[tool.name] ?? false;
            const fallback = loaded.defaults.tools.find((t) => t.name === tool.name);
            const isCustom =
              fallback && tool.description.trim() !== fallback.description.trim();
            return (
              <div
                key={tool.name}
                className="rounded-lg border border-zinc-800 bg-zinc-900/40"
              >
                <div
                  onClick={() => setOpenTools({ ...openTools, [tool.name]: !expanded })}
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-900/70"
                >
                  {expanded ? (
                    <ChevronDown size={14} className="text-zinc-500 shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-zinc-500 shrink-0" />
                  )}
                  <code className="text-sm font-mono text-brand-300 shrink-0">
                    {tool.name}
                  </code>
                  {isCustom && (
                    <span
                      className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 uppercase tracking-wider shrink-0"
                      title="Descrição modificada do padrão"
                    >
                      custom
                    </span>
                  )}
                  <span className="text-xs text-zinc-500 truncate flex-1">
                    {tool.description.slice(0, 100)}
                    {tool.description.length > 100 && '…'}
                  </span>
                  <label
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center cursor-pointer shrink-0"
                  >
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      onChange={(e) => updateTool(tool.name, { enabled: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="relative w-9 h-5 bg-zinc-800 rounded-full peer peer-checked:bg-brand-500 transition-colors">
                      <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-zinc-300 rounded-full transition-transform peer-checked:translate-x-4" />
                    </div>
                  </label>
                </div>

                {expanded && (
                  <div className="px-4 pb-4 pt-1 border-t border-zinc-800/60">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-zinc-400">Descrição (gatilho do LLM)</label>
                      <button
                        onClick={() => resetToolDescription(tool.name)}
                        disabled={!fallback || !isCustom}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <RotateCcw size={10} /> restaurar padrão
                      </button>
                    </div>
                    <textarea
                      value={tool.description}
                      onChange={(e) => updateTool(tool.name, { description: e.target.value })}
                      rows={4}
                      className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 leading-relaxed focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/40 resize-vertical"
                      placeholder="Descreva o caso de uso da tool…"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </section>

        {/* Dica final */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-xs text-zinc-400 leading-relaxed">
          <strong className="text-zinc-300">Dica:</strong> a IA decide quais tools chamar a
          cada turno baseado nas descrições aqui. Se uma tool nunca dispara, refine o gatilho
          (ex: adicione exemplos: <em>"chame quando o cliente disser 'quero falar com humano'"</em>).
          Se dispara demais, restrinja (<em>"NÃO chame se o cliente só estiver perguntando preço"</em>).
        </section>
      </div>
    </div>
  );
}
