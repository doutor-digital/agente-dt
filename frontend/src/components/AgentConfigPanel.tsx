import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  ListChecks,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api';
import type { AgentConfigInput, AgentConfigResponse, ToolConfig, WorkflowRule } from '../types/api';

/**
 * Painel de configuração do agente.
 *
 * Três blocos:
 *  1. System Prompt — textarea grande. É a "personalidade" do agente.
 *  2. Tools — toggle de habilitação + descrição editável. A descrição é o
 *     "gatilho" que o LLM lê pra decidir QUANDO chamar a tool.
 *  3. Sequências — regras declarativas "SE X ENTÃO Y" que são anexadas ao
 *     system prompt em runtime, guiando o ReAct loop.
 *
 * Lógica:
 *  - Carrega config no mount via GET /api/config.
 *  - Usa estado local como "rascunho" — só envia ao back quando o usuário
 *    clica em Salvar (evita PUT a cada keystroke).
 *  - Flag `dirty` indica mudanças não salvas.
 */
export function AgentConfigPanel() {
  const [loaded, setLoaded] = useState<AgentConfigResponse | null>(null);
  const [draft, setDraft] = useState<AgentConfigInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    api.getConfig().then((r) => {
      if (!alive) return;
      setLoaded(r);
      // Merge das tools conhecidas com as salvas — garante que tools
      // novas no código apareçam na UI mesmo sem registro no banco.
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
  }, []);

  if (!loaded || !draft) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Carregando configuração…
      </div>
    );
  }

  const dirty =
    draft.systemPrompt !== loaded.config.systemPrompt ||
    JSON.stringify(draft.tools) !== JSON.stringify(loaded.config.tools) ||
    JSON.stringify(draft.workflow) !== JSON.stringify(loaded.config.workflow);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const saved = await api.saveConfig(draft);
      setLoaded({ ...loaded, config: saved });
      setSaveMsg({ kind: 'ok', text: 'Configuração salva. O agente já vai usar na próxima execução.' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveMsg({ kind: 'err', text: `Falha ao salvar: ${msg}` });
    } finally {
      setSaving(false);
      // Mensagem some sozinha depois de 4s.
      setTimeout(() => setSaveMsg(null), 4000);
    }
  };

  const handleResetPrompt = () => {
    setDraft({ ...draft, systemPrompt: loaded.defaults.systemPrompt });
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

  const addWorkflowRule = () => {
    const rule: WorkflowRule = {
      id: crypto.randomUUID(),
      when: '',
      then: '',
    };
    setDraft({ ...draft, workflow: [...draft.workflow, rule] });
  };

  const updateRule = (id: string, patch: Partial<WorkflowRule>) => {
    setDraft({
      ...draft,
      workflow: draft.workflow.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  };

  const removeRule = (id: string) => {
    setDraft({ ...draft, workflow: draft.workflow.filter((r) => r.id !== id) });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between sticky top-0 bg-zinc-950/95 backdrop-blur py-3 z-10 border-b border-zinc-800/60">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <Sparkles size={18} className="text-brand-300" />
              Configuração do Agente
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Define o comportamento da IA — prompt, tools habilitadas, sequências de automação.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {saveMsg && (
              <div
                className={`text-xs flex items-center gap-1.5 ${
                  saveMsg.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {saveMsg.kind === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}
                {saveMsg.text}
              </div>
            )}
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-brand-600 hover:bg-brand-500 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Salvando…' : dirty ? 'Salvar alterações' : 'Salvo'}
            </button>
          </div>
        </div>

        {/* SYSTEM PROMPT */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-brand-300" />
              <h2 className="font-semibold text-zinc-100">System Prompt</h2>
            </div>
            <button
              onClick={handleResetPrompt}
              className="text-xs text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"
            >
              <RotateCcw size={12} />
              Restaurar padrão
            </button>
          </div>
          <p className="text-xs text-zinc-500 mb-3">
            É a personalidade e as regras do agente. O LLM lê isso ANTES de cada interação. Mantenha
            curto e direcional — instruções cirúrgicas levam a tool-calls consistentes.
          </p>
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            rows={14}
            className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950 text-sm text-zinc-100 font-mono leading-relaxed focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/40 resize-vertical"
            placeholder="Você é um agente de…"
          />
          <div className="text-[10px] text-zinc-600 mt-1 text-right font-mono">
            {draft.systemPrompt.length} caracteres
          </div>
        </section>

        {/* TOOLS */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-2 mb-3">
            <Wrench size={16} className="text-brand-300" />
            <h2 className="font-semibold text-zinc-100">Tools (Gatilhos da IA)</h2>
          </div>
          <p className="text-xs text-zinc-500 mb-4">
            A descrição de cada tool é o que o LLM lê pra decidir <strong>QUANDO</strong> chamá-la.
            Edite as descrições pra mudar comportamento sem mexer no código. Toggle desliga a tool.
          </p>

          <div className="space-y-2">
            {draft.tools.map((tool) => {
              const expanded = openTools[tool.name] ?? false;
              return (
                <div
                  key={tool.name}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/40"
                >
                  <div
                    onClick={() => setOpenTools({ ...openTools, [tool.name]: !expanded })}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-900/50"
                  >
                    {expanded ? (
                      <ChevronDown size={14} className="text-zinc-500" />
                    ) : (
                      <ChevronRight size={14} className="text-zinc-500" />
                    )}
                    <code className="text-sm font-mono text-brand-300">{tool.name}</code>
                    <span className="text-xs text-zinc-500 truncate flex-1">
                      {tool.description.slice(0, 80)}
                      {tool.description.length > 80 && '…'}
                    </span>
                    <label
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center cursor-pointer"
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
                        <label className="text-xs text-zinc-400">Descrição (gatilho)</label>
                        <button
                          onClick={() => resetToolDescription(tool.name)}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"
                        >
                          <RotateCcw size={10} /> padrão
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
          </div>
        </section>

        {/* SEQUÊNCIAS / WORKFLOW */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <GitBranch size={16} className="text-brand-300" />
              <h2 className="font-semibold text-zinc-100">Sequências de Automação</h2>
            </div>
            <button
              onClick={addWorkflowRule}
              className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200 border border-brand-500/30 rounded-md px-2.5 py-1 hover:bg-brand-500/10"
            >
              <Plus size={12} />
              Nova regra
            </button>
          </div>
          <p className="text-xs text-zinc-500 mb-4">
            Regras declarativas que o agente recebe junto ao prompt. Formato:{' '}
            <strong>SE</strong> &lt;gatilho&gt; <strong>ENTÃO</strong> &lt;ação esperada&gt;.
            Funcionam como "policy" pra guiar o loop ReAct — não substituem a decisão do LLM.
          </p>

          {draft.workflow.length === 0 ? (
            <div className="text-center py-8 border border-dashed border-zinc-800 rounded-lg">
              <ListChecks size={28} className="text-zinc-700 mx-auto mb-2" />
              <p className="text-xs text-zinc-500">
                Nenhuma sequência cadastrada. O agente vai operar só com o System Prompt.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {draft.workflow.map((rule, i) => (
                <div
                  key={rule.id}
                  className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 relative"
                >
                  <div className="absolute -left-2.5 top-3 w-5 h-5 rounded-full bg-zinc-900 border border-brand-500/40 flex items-center justify-center text-[10px] font-mono font-bold text-brand-300">
                    {i + 1}
                  </div>
                  <button
                    onClick={() => removeRule(rule.id)}
                    className="absolute top-2 right-2 text-zinc-600 hover:text-rose-400 p-1"
                    title="Remover"
                  >
                    <Trash2 size={14} />
                  </button>

                  <div className="grid md:grid-cols-2 gap-3 ml-3">
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
                        SE (gatilho)
                      </label>
                      <textarea
                        value={rule.when}
                        onChange={(e) => updateRule(rule.id, { when: e.target.value })}
                        rows={3}
                        placeholder='ex: "o lead mencionou orçamento aprovado"'
                        className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500 resize-vertical"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
                        ENTÃO (ação)
                      </label>
                      <textarea
                        value={rule.then}
                        onChange={(e) => updateRule(rule.id, { then: e.target.value })}
                        rows={3}
                        placeholder='ex: aplicar tag "Quente" e responder confirmando interesse'
                        className="w-full px-3 py-2 rounded-md border border-zinc-800 bg-zinc-950 text-xs text-zinc-100 focus:outline-none focus:border-brand-500 resize-vertical"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* MODELO */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h2 className="font-semibold text-zinc-100 mb-3 flex items-center gap-2">
            <Wrench size={16} className="text-brand-300" />
            Parâmetros do modelo
          </h2>
          <div className="grid md:grid-cols-3 gap-3 text-sm">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
                Modelo
              </label>
              <input
                type="text"
                value={draft.model ?? ''}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs font-mono text-zinc-100 focus:outline-none focus:border-brand-500"
                placeholder="claude-opus-4-7"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
                Temperatura
              </label>
              <input
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={draft.temperature ?? 0}
                onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) })}
                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs font-mono text-zinc-100 focus:outline-none focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1 block">
                Max tokens
              </label>
              <input
                type="number"
                min={1}
                max={8192}
                value={draft.maxTokens ?? 1024}
                onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) })}
                className="w-full px-3 py-1.5 rounded-md border border-zinc-800 bg-zinc-950 text-xs font-mono text-zinc-100 focus:outline-none focus:border-brand-500"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
