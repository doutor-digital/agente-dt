/**
 * Compõe o prompt de uma unidade COM O CÓDIGO DO WORKTREE, a partir do despejo de dados da produção
 * (input/<slug>.json, sem segredos), e escreve o texto em composed/<slug>.json pra contar tokens no container.
 *
 * Roda de dentro do worktree: `npx tsx <este arquivo> [slug]`. Env igual à produção nas flags que mudam o prompt.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

process.env.CAPTURA_UNIFICADA_SLUGS ??= '*';
process.env.PROMPT_DA_UNIDADE_SLUGS ??= '';

const S = '/tmp/claude-1000/-home-joaoof-agente-dt/d95912f5-9607-4619-a45e-835830e741f5/scratchpad';
/** Um lead qualquer: só precisa ser >0 pra o caminho de produção rodar inteiro. */
const LEAD_DE_MEDICAO = 1;
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(`${S}/input`).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

const { composeSystemPromptParts } = await import('../agent/prompt-composer.js');
const { buildTools } = await import('../agent/tools.js');
const { fixarLeadDaConversa, limparSchemaDoModelo } = await import('../agent/graph.js');

mkdirSync(`${S}/composed`, { recursive: true });
const recorder = new Proxy({}, { get: () => async () => {} });
const kommo = new Proxy({}, { get: () => async () => { throw new Error('kommo stub'); } });

for (const slug of slugs) {
  const d = JSON.parse(readFileSync(`${S}/input/${slug}.json`, 'utf8'));
  const unit = d.unit;
  const p = composeSystemPromptParts({
    unit,
    agentConfigPrompt: d.agentConfigPrompt ?? undefined,
    templates: d.templates,
    flaggedExamples: d.flaggedExamples,
    knowledge: [],
    actions: d.actions,
    globalActions: d.globalActions,
    leadFieldRules: d.leadFieldRules,
    leadMemory: null,
    lessons: d.lessons,
    isFirstTurn: false,
    leadId: undefined,
    telefone: null,
    consulta: null,
    estadoEtapa: null,
  });
  const overrides: Record<string, string> = {};
  for (const t of d.toolConfigs ?? []) if (t.description) overrides[t.name] = t.description;
  const on = new Map<string, boolean>((d.toolConfigs ?? []).map((t: { name: string; enabled: boolean }) => [t.name, t.enabled]));
  // Mesmo caminho do buildAgentGraph: montar → filtrar pelo config → fixar o lead
  // (que é quem tira o leadId do schema). Medir sem isto mede um prompt que não existe.
  const tools = fixarLeadDaConversa(
    buildTools({ recorder: recorder as never, kommo: kommo as never, descriptionOverrides: overrides, pausedFieldId: unit.kommoPausedFieldId, leadFieldRules: d.leadFieldRules, unit })
      .filter((t) => on.get(t.name) ?? true) as never,
    LEAD_DE_MEDICAO,
    recorder as never,
    unit,
  );
  limparSchemaDoModelo(tools as never);
  // Espelha a escolha do LangChain (chat_models.js:698): quando a ferramenta traz
  // `extras.providerToolDefinition`, é ELE que vai no pedido — o schema do Zod
  // nem é convertido. Medir pelo Zod aqui mediria um prompt que não existe.
  const anth = tools.map((t) => {
    const pronta = (t as unknown as { extras?: { providerToolDefinition?: unknown } }).extras?.providerToolDefinition;
    if (pronta) return pronta as { name: string; description: string; input_schema: unknown };
    const o = convertToOpenAITool(t as never);
    return { name: o.function.name, description: o.function.description, input_schema: o.function.parameters };
  });
  writeFileSync(`${S}/composed/${slug}.json`, JSON.stringify({ model: d.anthropicModel || 'claude-sonnet-5', cacheable: p.cacheable, dynamic: p.dynamic, tools: anth }));
  const tk = (s: string) => Math.round((s || '').length / 2.6);
  console.log(`${slug.padEnd(28)} fixo ~${tk(p.cacheable)} tk · vivo ~${tk(p.dynamic)} tk · ${anth.length} tools ~${tk(JSON.stringify(anth))} tk (estimativa; o exato vem do container)`);
}
