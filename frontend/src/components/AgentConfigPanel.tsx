import { useCallback, useEffect, useState } from 'react';
import {
  Lightbulb,
  Loader2,
  RotateCcw,
  Save,
  Sparkles,
  ThumbsDown,
  Wand2,
  Wrench,
} from 'lucide-react';
import { api } from '../lib/api';
import type {
  AgentConfigInput,
  AgentConfigResponse,
  FlaggedMessage,
} from '../types/api';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';

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
  const { selectedUnitId } = useUnit();
  const [loaded, setLoaded] = useState<AgentConfigResponse | null>(null);
  const [draft, setDraft] = useState<AgentConfigInput | null>(null);
  const [saving, setSaving] = useState(false);
  // Modo prompt único (flag na Unit, persistida na hora que muda).
  const [singleMode, setSingleMode] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  const [flattening, setFlattening] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setDraft(null);
    api.getConfig(selectedUnitId).then((r) => {
      if (!alive) return;
      setLoaded(r);
      setDraft({
        unitId: selectedUnitId,
        systemPrompt: r.config.systemPrompt,
        tools: r.config.tools,
        model: r.config.model,
        temperature: r.config.temperature,
        maxTokens: r.config.maxTokens,
      });
    });
    // Carrega a flag singlePromptMode da unidade (separada do AgentConfig).
    if (selectedUnitId) {
      api.getUnit(selectedUnitId)
        .then((u) => { if (alive) setSingleMode(u.singlePromptMode); })
        .catch(() => { if (alive) setSingleMode(false); });
    } else {
      setSingleMode(false);
    }
    return () => {
      alive = false;
    };
  }, [selectedUnitId]);

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
    JSON.stringify(draft.tools) !== JSON.stringify(loaded.config.tools);

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await api.saveConfig({ ...draft, unitId: selectedUnitId });
      setLoaded({ ...loaded, config: saved });
      toast.success('Configuração salva. O agente já vai usar na próxima execução.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao salvar: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleResetPrompt = () => {
    setDraft({ ...draft, systemPrompt: loaded.defaults.systemPrompt });
  };

  // Liga/desliga o modo prompt único — persiste na Unit imediatamente.
  const handleToggleSingleMode = async (v: boolean) => {
    if (!selectedUnitId) {
      toast.error('Selecione uma unidade primeiro.');
      return;
    }
    setTogglingMode(true);
    try {
      await api.updateUnit(selectedUnitId, { singlePromptMode: v });
      setSingleMode(v);
      toast.success(
        v
          ? 'Modo prompt único LIGADO. O texto abaixo agora é o prompt inteiro.'
          : 'Modo prompt único desligado. Voltou ao modo em camadas.',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao alternar modo: ${msg}`);
    } finally {
      setTogglingMode(false);
    }
  };

  // "Centralizar no prompt": puxa a config achatada e joga no editor (não salva).
  const handleFlatten = async () => {
    if (!selectedUnitId) {
      toast.error('Selecione uma unidade primeiro.');
      return;
    }
    setFlattening(true);
    try {
      const prompt = await api.getFlattenedPrompt(selectedUnitId);
      setDraft({ ...draft, systemPrompt: prompt });
      toast.success('Config achatada no editor abaixo. Revise e clique em Salvar alterações.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao centralizar: ${msg}`);
    } finally {
      setFlattening(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between sticky top-0 bg-zinc-950/95 backdrop-blur py-3 z-10 border-b border-zinc-800/60">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
              <Sparkles size={18} className="text-brand-300" />
              🔧 Avançado — Configuração técnica
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Edição fina do prompt, tools habilitadas, sequências e modelo.
            </p>
          </div>
          <div className="flex items-center gap-3">
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

        {/* Banner de orientação — modo avançado */}
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none">⚠️</span>
            <div className="text-xs text-amber-100/90 leading-relaxed">
              <strong className="text-amber-200">Modo avançado.</strong> O caminho normal pra
              configurar a IA é <strong>Configurar IA</strong> (tom, emojis, toggles) +{' '}
              <strong>Fontes</strong> (papel, produtos, negócio). Esses dois bastam pra 95%
              dos casos. Use este painel apenas pra:
              <ul className="mt-2 space-y-0.5 list-disc list-inside text-amber-100/70">
                <li>Adicionar instruções extras (vão DEPOIS das Fontes, sem sobrescrever)</li>
                <li>Ajustar modelo/temperatura/maxTokens</li>
              </ul>
              <div className="mt-1 text-amber-100/60">
                Pra ligar/desligar tools, use a aba <strong>Ferramentas</strong>.
              </div>
              <div className="mt-2 text-amber-300/80">
                💡 Dica: deixe o <strong>System Prompt</strong> abaixo vazio se você já
                preencheu as Fontes — a IA gera a persona sozinha a partir do Wizard.
              </div>
            </div>
          </div>
        </section>

        {/* MODO PROMPT ÚNICO */}
        <section className="rounded-xl border border-brand-500/30 bg-brand-500/5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <h2 className="font-semibold text-zinc-100 flex items-center gap-2">
                <Sparkles size={16} className="text-brand-300" />
                Modo prompt único
              </h2>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                Quando ligado, o <strong className="text-zinc-200">texto abaixo é o prompt
                INTEIRO</strong>. A IA para de usar os blocos auto-gerados (persona, regras,
                toggles, Fontes, ações, templates) — só os dados de runtime (leadId, memória do
                paciente, base de conhecimento) entram automaticamente. Seus toggles continuam
                salvos; só ficam inertes enquanto isto está ligado.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={singleMode}
              onClick={() => handleToggleSingleMode(!singleMode)}
              disabled={togglingMode || !selectedUnitId}
              className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${
                singleMode ? 'bg-brand-500' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                  singleMode ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button
              onClick={handleFlatten}
              disabled={flattening || !selectedUnitId}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-100 text-xs font-medium transition-colors"
            >
              {flattening ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              {flattening ? 'Centralizando…' : 'Centralizar no prompt'}
            </button>
            <span className="text-[11px] text-zinc-500 flex-1 min-w-[200px]">
              Puxa tudo que você já configurou (persona, Fontes, toggles…) e escreve aqui embaixo,
              num lugar só. <strong className="text-zinc-400">Revise e clique em Salvar</strong> —
              depois ligue o modo único acima.
            </span>
          </div>
        </section>

        {/* SYSTEM PROMPT */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-brand-300" />
              <h2 className="font-semibold text-zinc-100">
                {singleMode ? 'Prompt completo (modo único ativo)' : 'Instruções extras (opcional)'}
              </h2>
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
            <strong className="text-zinc-300">Aditivo</strong> — o texto aqui é injetado <em>depois</em>{' '}
            das Fontes, sem sobrescrever a persona do Wizard. Use pra regras específicas que não
            cabem em toggle (ex: "se cliente perguntar sobre planos, sempre cite o plano Premium").
            Deixe vazio se as Fontes já dão conta.
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

        {/* EXEMPLOS A EVITAR (flagged messages) */}
        <FlaggedExamplesSection unitId={selectedUnitId} />

        {/* IDEIAS PRONTAS PRA ATIVAR */}
        <IdeasSection />

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

// ===========================================================================
// (RuleActionBuilder e helpers de workflow removidos — substituídos pela aba
// "Ações"/UnitAction com pickers tipados de tag e etapa. As Sequências de
// Automação foram aposentadas; a coluna agent_configs.workflow ainda existe
// mas não é mais injetada no prompt.)
// ===========================================================================

// ===========================================================================
// IdeasSection — cards informativos de funcionalidades pra construir depois
// ===========================================================================

const IDEAS: Array<{ icon: string; title: string; desc: string }> = [
  {
    icon: '🔥',
    title: 'Qualificação Quente/Frio automática',
    desc:
      'Detecta sinais de interesse (orçamento, urgência, decisor) ou desinteresse e aplica tag automática. Hoje você configura na mão como regra; ideia: heurística pré-pronta + ML leve.',
  },
  {
    icon: '👤',
    title: 'Handoff humano por palavras-chave',
    desc:
      'Lista de gatilhos (ex: "falar com pessoa", "atendente", "reclamação") que pausam a IA e notificam um operador específico no Slack/WhatsApp.',
  },
  {
    icon: '💰',
    title: 'Pipeline automático por intenção',
    desc:
      'Move o lead de etapa baseado em padrões de fala. "Pedi orçamento" → Qualificado. "Confirmei pedido" → Pedido realizado. Sem precisar criar regra manual pra cada caso.',
  },
  {
    icon: '📞',
    title: 'Coleta proativa de contato',
    desc:
      'Se o lead não preencheu email/telefone após N turnos, a IA pede de forma natural ("posso te enviar mais detalhes por email?"). Salva no campo certo do Kommo.',
  },
  {
    icon: '⏰',
    title: 'Horário comercial',
    desc:
      'Fora do expediente, a IA responde com mensagem padrão de boas-vindas e marca o lead como "esperando contato humano amanhã". Evita resposta robótica às 3h da manhã.',
  },
  {
    icon: '🎁',
    title: 'Cupom de boas-vindas',
    desc:
      'Se for o PRIMEIRO contato do lead (sem histórico), IA oferece cupom configurável. Útil pra converter visitante curioso em lead quente.',
  },
  {
    icon: '🔁',
    title: 'Follow-up automático',
    desc:
      'Lead sumiu há X horas sem fechar? A IA manda uma mensagem leve ("ainda interessado?") e move pra etapa "Reaquecimento" se responder.',
  },
  {
    icon: '📊',
    title: 'A/B de prompts',
    desc:
      'Mantém 2+ versões do system prompt ativas em paralelo. Cada conversa nova recebe uma versão aleatória. O juiz LLM (já existente) compara taxa de conversão entre versões.',
  },
];

function FlaggedExamplesSection({ unitId }: { unitId: string | null }) {
  const [items, setItems] = useState<FlaggedMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!unitId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await api.listFlaggedMessages(unitId);
      setItems(list);
    } finally {
      setLoading(false);
    }
  }, [unitId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function unflag(id: string) {
    await api.flagMessage(id, false);
    setItems(items.filter((m) => m.id !== id));
  }

  return (
    <section className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ThumbsDown size={16} className="text-rose-300" />
          <h2 className="font-semibold text-zinc-100">Exemplos a evitar</h2>
        </div>
        <button
          type="button"
          onClick={load}
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
        >
          {loading ? 'recarregando…' : 'recarregar'}
        </button>
      </div>
      <p className="text-xs text-zinc-400 mb-3">
        Respostas que você marcou com 👎 nas Conversas. O agente recebe esta lista no prompt
        com instrução de NÃO responder de forma parecida. Útil pra ensinar a IA por exemplos
        negativos.
      </p>
      {items.length === 0 ? (
        <div className="text-[11px] text-zinc-600 italic text-center py-4">
          Nenhuma resposta flaggada ainda. Vá em Conversas, passe o mouse numa resposta da IA
          e clique no 👎 pra adicionar exemplos aqui.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <li
              key={m.id}
              className="rounded-md bg-zinc-950/40 border border-zinc-800 p-3 text-xs text-zinc-300"
            >
              <div className="text-[10px] text-zinc-500 mb-1 flex items-center gap-2">
                <span>{m.conversation.contactName ?? 'Lead'} #{m.conversation.leadId}</span>
                <span>·</span>
                <span>{new Date(m.createdAt).toLocaleString('pt-BR')}</span>
                <button
                  type="button"
                  onClick={() => unflag(m.id)}
                  className="ml-auto text-rose-400 hover:text-rose-200"
                  title="Desmarcar"
                >
                  remover
                </button>
              </div>
              <div className="italic">"{m.content}"</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IdeasSection() {
  return (
    <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb size={16} className="text-amber-300" />
        <h2 className="font-semibold text-zinc-100">Ideias pra ativar depois</h2>
      </div>
      <p className="text-xs text-zinc-400 mb-4">
        Funcionalidades inspiradas em padrões comuns de vendas/atendimento. Não estão construídas
        ainda — me peça quando quiser ativar alguma e eu implemento.
      </p>
      <div className="grid md:grid-cols-2 gap-3">
        {IDEAS.map((idea) => (
          <div
            key={idea.title}
            className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 hover:border-amber-500/30 transition-colors"
          >
            <div className="flex items-start gap-2">
              <span className="text-lg leading-none mt-0.5">{idea.icon}</span>
              <div>
                <div className="text-xs font-semibold text-zinc-200">{idea.title}</div>
                <div className="text-[11px] text-zinc-500 mt-1 leading-snug">{idea.desc}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
