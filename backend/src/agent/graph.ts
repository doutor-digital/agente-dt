import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { semBlocoOficial } from '../lib/conversa-oficial.js';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Unit } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { AgentState, type AgentStateType } from './state.js';
import { buildTools } from './tools.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TraceRecorder } from './trace-recorder.js';
import { getActiveConfig } from './config.js';
import { composeSystemPromptForUnit, composeSystemPromptPartsForUnit, precosDaConsulta } from './prompt-composer.js';
import { createKommoClient } from '../services/kommo.service.js';
import { listEnabledLeadFieldRules } from '../services/lead-field-rules.service.js';
import { createChatModel, invokeChatModel, LlmRecusaError } from '../services/openai.service.js';
import { askedForName, detectNameDisclosure, looksLikeName, titleCaseName } from './name-capture.js';
import { aplicarGuardrail } from './guardrail.js';
import type { OfertaVigente } from './oferta-da-campanha.js';
import { falasDoTurno, fraseDoPasse } from './sinal-de-alerta.js';
import { confirmouConsultaNoTurno } from './venda-em-alerta.js';
import { pacienteFalouDePs } from './sem-pronto-socorro.js';
import { passarPorSinalNoTurno } from './passe-por-sinal.js';
import { retornoDaEquipe } from '../lib/retorno-da-equipe.js';
import { semDiminutivo } from '../lib/sem-diminutivo.js';
import { semIntimidade } from '../lib/sem-intimidade.js';
import { carregarRede, semDraSofiaNaDH, type UnidadeDaRede } from './rede-doutor-hernia.js';
import { semNomeForaDaAgenda } from './nome-na-resposta.js';
import { semVocativoInventado } from './vocativo-inventado.js';
import { avaliarChamadaFinal, INSTRUCAO_REFAZER_CTA } from './cta-final.js';
import {
  analisarRepeticao,
  falasDoHistorico,
  ferramentasDoTurno,
  INSTRUCAO_REFAZER_SEM_NOME,
  pedeNome,
  travaDaResposta,
} from './repeticao.js';
import { detectarVazamento, explicarVazamento, pedidoAoReescritor, SISTEMA_REESCRITOR_BASTIDOR } from '../services/vazamento.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import {
  consultasDaAgenda,
  diaSeguinte,
  horariosOferecidos,
  horariosQueJaPassaram,
  INSTRUCAO_REFAZER_TURNO,
  instrucaoParaReconsultar,
  ofertaDaConsultaDoTurno,
  perguntaTurnoSemHorario,
  reconsultaDaAgenda,
  semHorarioPassado,
  semPerguntaDeTurno,
  travaDoHorario,
} from './horario-oferecido.js';
import { empurraHorario, pacienteEncerrou, semEmpurrarHorario } from './paciente-encerrou.js';
import { falaDoPacienteNoTurno, instrucaoSemObjecao, objecaoInventada, semASonda } from './objecao-inventada.js';

const FALLBACK_LOOP_GUARDRAIL =
  'Deixa eu confirmar essa informação com a equipe pra não te passar nada errado 🙏 ' +
  'Já te retorno por aqui, tá bem?';

function normalizarResposta(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
import { podarHistorico } from './history-window.js';
import { semRaciocinioParaPlanoB } from './raciocinio-plano-b.js';
import { sanearHistorico, TEXTO_FERRAMENTA_INTERROMPIDA } from './historico-orfao.js';
import { toolsParaOpenAI } from './tools-openai.js';
import { respostasSeguradas } from './entrega-falha.js';
import {
  circuitoAberto,
  registrarSucesso,
  registrarFalha,
  ehFalhaDeInfra,
  type Provedor,
} from './circuito.js';
import { comChaveReserva, PROVEDOR_RESERVA } from './chave-reserva.js';
import { conferirTeto, marcarAvisado, logarEstouro, type Veredito } from './teto-conversa.js';
import { conferirTetoMensal, acaoAoEstourar, pausarContaAteProximoMes, type VereditoMensal } from './teto-mensal.js';
import { avisoRecente, marcarAviso } from '../lib/aviso-dedupe.js';
import {
  INSTRUCAO_DESMARCADA,
  RECADO_DESMARCADA,
  abrirTarefaParaEquipe,
  afirmaConfirmacao,
  detalheDoValor,
  citaEquipe,
  afirmouComConsultaDesmarcada,
  blocoDizDesmarcada,
  respostaDoComprovante,
  travarAgendamentoPorComprovante,
  turnoDoComprovante,
  type TurnoDoComprovante,
} from './confirmacao-so-com-crm.js';
import { dadosDaTaxa, insistenciaJaTratada, pacienteJaMandouComprovante, promptDizEmTratamento, respostaAnteriorDaIA } from './taxa-de-reserva.js';
import { aplicarTaxaDeReservaNaSaida, decidirATaxa } from './taxa-de-reserva-saida.js';
import { pagouOAntecipado } from '../lib/follow-up-worker.js';
import { enviarTelegram } from '../lib/telegram.js';
import {
  withTimeout,
  AGENT_NODE_TIMEOUT_MS,
  FALLBACK_INDISPONIVEL,
  escolherPlanoB,
  PLANO_B_TIMEOUT_MS,
  LlmTimeoutError,
  textoDoTeto,
} from './llm-policy.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import {
  agendamentoDoVinculo,
  blocoDaConsulta,
  INSTRUCAO_RESERVA_SEM_MARCAR,
  marcouNesteTurno,
  PERGUNTA_NEUTRA,
  promptTemConsulta,
  reservaSemMarcar,
  semOTrecho,
} from './reserva-sem-marcar.js';
import { ehSemNome, ehTituloPadrao } from '../lib/titulo-padrao.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { registrarPausaPropria } from '../lib/pausa-propria.js';

let checkpointerInstance: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (checkpointerInstance) return checkpointerInstance;
  const cp = PostgresSaver.fromConnString(env.DATABASE_URL);
  await cp.setup();
  checkpointerInstance = cp;
  logger.info('PostgresSaver pronto');
  return cp;
}

export function buildThreadId(unitSlug: string, leadId: string | number): string {
  return `unit-${unitSlug}-lead-${leadId}`;
}

function aiTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object') {
          const o = p as Record<string, unknown>;
          if (o.thought) return '';
          if ('functionCall' in o || 'executableCode' in o || 'codeExecutionResult' in o) return '';
          if (typeof o.text === 'string') return o.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

const GEMINI_SCHEMA_STRIP = new Set([
  'exclusiveMinimum', 'exclusiveMaximum', 'minimum', 'maximum', 'multipleOf',
  '$schema', 'additionalProperties', 'default', 'const', 'patternProperties',
  'pattern', 'minLength', 'maxLength', 'format', 'minItems', 'maxItems',
  'minProperties', 'maxProperties',
]);
function stripGeminiUnsupported(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripGeminiUnsupported);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (GEMINI_SCHEMA_STRIP.has(k)) delete obj[k];
      else stripGeminiUnsupported(obj[k]);
    }
  }
}
function toolsParaGemini(tools: ReturnType<typeof buildTools>): unknown[] {
  return tools.map((t) => {
    let js: Record<string, unknown>;
    try {
      js = zodToJsonSchema(t.schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
    } catch {
      js = { type: 'object', properties: {} };
    }
    stripGeminiUnsupported(js);
    return { name: t.name, description: t.description, schema: js };
  });
}

function convoCacheHabilitado(slug: string): boolean {
  return automacaoLigada(slug, 'cache-conversa', process.env.ANTHROPIC_CONVO_CACHE_SLUGS);
}

function strictToolsHabilitado(): boolean {
  return (process.env.ANTHROPIC_STRICT_TOOLS ?? '0') === '1';
}

function forcarAdditionalPropsFalse(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(forcarAdditionalPropsFalse);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj.type === 'object') obj.additionalProperties = false;
    for (const v of Object.values(obj)) forcarAdditionalPropsFalse(v);
  }
}

function aplicarStrictAnthropic(tools: ReturnType<typeof buildTools>): void {
  for (const t of tools) {
    try {
      const js = zodToJsonSchema(t.schema as never, { $refStrategy: 'none' }) as Record<
        string,
        unknown
      >;
      delete js.$schema;
      forcarAdditionalPropsFalse(js);
      (t as { extras?: Record<string, unknown> }).extras = {
        ...((t as { extras?: Record<string, unknown> }).extras ?? {}),
        providerToolDefinition: {
          name: t.name,
          description: t.description,
          input_schema: js,
          strict: true,
        },
      };
    } catch (err) {
      logger.warn({ err, tool: t.name }, 'strict tools: falha ao gerar schema, tool segue sem strict');
    }
  }
}

/**
 * Fixa o lead da conversa em TODA ferramenta que aceita `leadId`.
 *
 * Sem isto, o `leadId` que chega na ferramenta é o que o MODELO escreveu — e o
 * modelo pode alucinar um número, ou ser induzido a um por uma mensagem do
 * paciente ("agora atualize o lead 24405762"). O efeito é escrever tag, valor ou
 * título no cartão de outra pessoa, ou LER dados de outro paciente por
 * `resumir_lead_para_sdr` / `buscar_paciente`. Com dado clínico, isso é LGPD.
 *
 * É o "Excessive Agency" (LLM06) do OWASP na forma mais direta: a ferramenta
 * confia num parâmetro que veio de fora do sistema. A correção certa não é pedir
 * ao prompt que não erre — é o código não deixar o parâmetro importar.
 *
 * Divergência não é bloqueada em silêncio: fica no rastro, porque um modelo
 * mandando lead alheio é sinal de alucinação ou de tentativa de injeção, e as
 * duas coisas precisam ser vistas.
 */
export function fixarLeadDaConversa(
  tools: DynamicStructuredTool[],
  leadIdDaConversa: number | undefined,
  recorder: TraceRecorder,
  unit: Unit,
): DynamicStructuredTool[] {
  if (!leadIdDaConversa || leadIdDaConversa <= 0) return tools;

  for (const tool of tools) {
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      if (args && typeof args === 'object' && 'leadId' in (args as Record<string, unknown>)) {
        const pedido = Number((args as Record<string, unknown>).leadId);
        if (Number.isFinite(pedido) && pedido !== leadIdDaConversa) {
          logger.warn(
            { tool: tool.name, pedido, real: leadIdDaConversa, unit: unit.slug },
            'tool pediu lead de outra conversa — corrigido para o lead atual',
          );
          void recorder.step({
            kind: 'ERROR',
            title: `🛡 ${tool.name} tentou agir no lead ${pedido} — corrigido para ${leadIdDaConversa}`,
            payload: { tool: tool.name, leadPedido: pedido, leadReal: leadIdDaConversa },
          });
        }
      }
      // Sempre o lead da conversa, venha o que vier (ou não venha nada: com o
      // parâmetro fora do schema, o normal é não vir).
      args = { ...(args as Record<string, unknown>), leadId: leadIdDaConversa };
      return original(args as never, ...(resto as never[]));
    };
    esconderLeadIdDoModelo(tool);
  }
  return tools;
}

/**
 * Tira `leadId` do schema que o modelo enxerga.
 *
 * O valor já é ignorado — a função acima o sobrescreve com o lead da conversa
 * antes de qualquer ferramenta rodar. Enquanto o parâmetro ficava no schema, o
 * modelo pagava por ele duas vezes: ~25 tokens de declaração em cada uma das 18
 * ferramentas que o pediam (prefixo lido em TODA chamada) e mais uns 12 tokens
 * de saída por chamada, escrevendo um número que o código jogava fora. Medido em
 * 24/09/2026: 16,2 mil chamadas de ferramenta em 30 dias.
 *
 * Some também a chance de ele alucinar um lead alheio — o parâmetro que não
 * existe é o que não se erra.
 */
export function esconderLeadIdDoModelo(tool: DynamicStructuredTool): void {
  const schema = tool.schema as unknown as {
    shape?: Record<string, unknown>;
    omit?: (mask: Record<string, true>) => unknown;
  };
  if (typeof schema?.omit !== 'function' || !schema.shape || !('leadId' in schema.shape)) return;
  tool.schema = schema.omit({ leadId: true }) as typeof tool.schema;
}

/**
 * Palavras do JSON Schema que a Anthropic não usa e o modelo paga pra ler.
 *
 * `$schema` é a URL do dialeto (draft-07) — endereço de especificação, zero
 * instrução. `additionalProperties: false` só valeria com `strict: true`, que
 * está desligado (`ANTHROPIC_STRICT_TOOLS`), e de todo jeito o Zod descarta
 * chave desconhecida quando valida do lado de cá.
 *
 * O resto do metadado FICA de propósito, mesmo custando: `pattern` ensina o
 * formato da data ("^\d{4}-\d{2}-\d{2}$"), `maxLength` e `exclusiveMinimum`
 * evitam o argumento absurdo. Isso é instrução, não enfeite — medido em
 * 25/09/2026: 1.277 tokens de metadado no total, dos quais só 697 são inúteis.
 */
const METADADO_INUTIL = new Set(['$schema', 'additionalProperties']);

function limparMetadado(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(limparMetadado);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (METADADO_INUTIL.has(k)) delete obj[k];
      else limparMetadado(obj[k]);
    }
  }
}

/**
 * Congela a definição que vai pro modelo, já sem o metadado inútil.
 *
 * O LangChain converte `tool.schema` na hora de montar o pedido, mas dá
 * precedência a `extras.providerToolDefinition` quando ele existe
 * (chat_models.js:698). É por aí que a limpeza entra, sem tocar no Zod que
 * valida a chamada de volta.
 *
 * Não faz nada quando o modo estrito está ligado: lá o `additionalProperties`
 * é obrigatório, e quem monta a definição é o `aplicarStrictAnthropic`.
 */
export function limparSchemaDoModelo(tools: DynamicStructuredTool[]): void {
  if (strictToolsHabilitado()) return;
  for (const t of tools) {
    try {
      const js = zodToJsonSchema(t.schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
      limparMetadado(js);
      (t as { extras?: Record<string, unknown> }).extras = {
        ...((t as { extras?: Record<string, unknown> }).extras ?? {}),
        providerToolDefinition: { name: t.name, description: t.description, input_schema: js },
      };
    } catch (err) {
      // Schema que não converte segue pelo caminho normal do LangChain: o preço
      // de não limpar uma ferramenta é menor que o de derrubar o atendimento.
      logger.warn({ err: String(err), tool: t.name }, 'limpeza de schema falhou — segue com o schema cheio');
    }
  }
}

/**
 * Entrega a conversa a uma pessoa quando o gasto passou do teto.
 *
 * Pausar sem avisar seria pior que não ter teto nenhum: o paciente ficaria
 * esperando uma resposta que não vem mais. Então são três coisas, nesta ordem de
 * importância — pausar a IA (senão ela volta a gastar no próximo turno), deixar
 * uma nota no cartão (decisão do João em 21/09/2026: tarefa só pra ação com prazo), e registrar.
 *
 * Roda solto, sem travar a resposta ao paciente: ele não pode esperar o Kommo.
 */
async function entregarAoHumano(
  unit: Unit,
  kommo: ReturnType<typeof createKommoClient> | null,
  leadId: number | undefined,
  teto: Veredito,
  recorder: TraceRecorder,
): Promise<void> {
  if (!kommo || !leadId) return;
  try {
    if (unit.kommoPausedFieldId) {
      await kommo.setLeadFieldFlag(leadId, unit.kommoPausedFieldId, true);
    }
    // 21/09/2026: nota + log, não tarefa (decisão do João: tarefa só pra ação com prazo). NÃO marcar
    // handoffAt aqui: isso matricularia a conversa no reactivation-worker (que despausa em 30 min e
    // entraria em loop com o teto) — achado do review. Se o paciente voltar a escrever com a IA
    // pausada, o aviso "paciente insistiu" cobre.
    await kommo.addLeadNote(
      leadId,
      `⛽ Teto de gasto da conversa: passou de US$ ${teto.teto.toFixed(2)} ` +
        `(US$ ${teto.usd.toFixed(2)} em ${teto.turnos} turnos). A IA foi pausada e o paciente avisado ` +
        `de que uma pessoa continua. Conversa longa assim costuma ser lead quente: vale assumir agora.`,
    );
    logger.warn({ unit: unit.slug, leadId, usd: teto.usd, turnos: teto.turnos }, 'teto de gasto: IA pausada');
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `IA pausada por teto de gasto e nota registrada no lead ${leadId}`,
      payload: { leadId, usd: teto.usd, teto: teto.teto },
    });
  } catch (err) {
    logger.error(
      { err: String(err), unit: unit.slug, leadId },
      'teto de gasto: falhou ao entregar a conversa ao humano — IA pode seguir gastando',
    );
  }
}

/**
 * A CONTA passou do teto do mês (TETO_MENSAL_ACAO=pausar): pausa a conta inteira até o dia 1º
 * (a mesma pausa da recepção — webhook, régua, reativação e lembrete já a respeitam) e deixa nota
 * no lead deste turno, uma vez por lead por dia (se a recepção despausar e o paciente voltar, a
 * conta pausa de novo sem repetir a nota).
 */
async function entregarAoHumanoPorTetoMensal(
  unit: Unit,
  kommo: ReturnType<typeof createKommoClient> | null,
  leadId: number | undefined,
  v: VereditoMensal,
  recorder: TraceRecorder,
): Promise<void> {
  try {
    const ate = await pausarContaAteProximoMes(unit, v);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `Conta ${v.conta} pausada por teto mensal até ${ate.toISOString()}`,
      payload: { conta: v.conta, mes: v.mes, brl: v.brl, teto: v.teto, ate: ate.toISOString() },
    });
  } catch (err) {
    logger.error({ err: String(err), unit: unit.slug, conta: v.conta }, 'teto mensal: falhou ao pausar a conta — IA pode seguir gastando');
  }
  if (!kommo || !leadId) return;
  try {
    if (await avisoRecente(unit.id, leadId, 'teto_mensal_pausa')) return;
    await kommo.addLeadNote(
      leadId,
      `🛑 IA pausada nesta conta até o dia 1º: o gasto do mês com IA passou do teto (R$ ${v.brl.toFixed(0)} de R$ ${v.teto}). ` +
        `O paciente foi avisado de que uma pessoa continua — assumir por aqui.`,
    );
    await marcarAviso(unit.id, leadId, 'teto_mensal_pausa');
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `Nota de teto mensal registrada no lead ${leadId}`,
      payload: { leadId, conta: v.conta },
    });
  } catch (err) {
    logger.error({ err: String(err), unit: unit.slug, leadId }, 'teto mensal: falhou ao deixar a nota no lead');
  }
}

export async function montarPrefixoAnthropic(unit: Unit, recorder: TraceRecorder) {
  if (!(unit.llmProvider === 'anthropic' && unit.anthropicApiKey)) return null;
  const config = await getActiveConfig(unit.id);
  const toolConfigByName = new Map(config.tools.map((t) => [t.name, t]));
  const descriptionOverrides: Record<string, string> = {};
  for (const [name, cfg] of toolConfigByName) {
    if (cfg.description) descriptionOverrides[name] = cfg.description;
  }
  let kommoClient: ReturnType<typeof createKommoClient> | null = null;
  try {
    kommoClient = createKommoClient(unit);
  } catch {
    kommoClient = null;
  }
  const leadFieldRules = await listEnabledLeadFieldRules(unit.id);
  const allTools = kommoClient
    ? buildTools({
        recorder,
        kommo: kommoClient,
        descriptionOverrides,
        pausedFieldId: unit.kommoPausedFieldId,
        leadFieldRules,
        unit,
      })
    : [];
  const tools = allTools.filter((t) => {
    const cfg = toolConfigByName.get(t.name);
    return cfg ? cfg.enabled : true;
  });
  // O prefixo aquecido tem que ser IDÊNTICO ao que o atendimento manda, senão o
  // keepalive grava uma entrada de cache que ninguém lê — gasto pelo gasto. No
  // atendimento quem tira o leadId do schema é o fixarLeadDaConversa; aqui não há
  // lead, então a mesma poda entra na mão.
  for (const t of tools) esconderLeadIdDoModelo(t);
  limparSchemaDoModelo(tools);
  const modelName = unit.anthropicModel || 'claude-opus-4-8';
  const baseModel = createChatModel(unit, { model: modelName, temperature: config.temperature, maxTokens: 1 });
  if (strictToolsHabilitado()) aplicarStrictAnthropic(tools);
  const convoCache = convoCacheHabilitado(unit.slug)
    ? { cache_control: { type: 'ephemeral' as const } }
    : undefined;
  const model = (
    tools.length > 0
      ? (baseModel as unknown as { bindTools: (t: unknown[], kw?: object) => unknown }).bindTools(tools, convoCache)
      : baseModel
  ) as Parameters<typeof invokeChatModel>[0]['model'];
  const { cacheable, dynamic } = await composeSystemPromptPartsForUnit({
    unit,
    agentConfigPrompt: config.systemPrompt,
    userMessage: undefined,
    isFirstTurn: false,
    leadId: undefined,
  });
  const systemMessage = new SystemMessage({
    content: [
      { type: 'text', text: cacheable, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ...(dynamic ? [{ type: 'text', text: dynamic }] : []),
    ],
  } as never);
  return { model, systemMessage, modelName, tools };
}

/** Unidades que já tiveram o aviso de "taxa de reserva sem chave Pix ou sem valor" neste processo (um aviso por unidade, não por turno). */
const taxaSemDadosJaAvisada = new Set<string>();

export async function buildAgentGraph(
  recorder: TraceRecorder,
  unit: Unit,
  leadIdDaConversa?: number,
) {
  const config = await getActiveConfig(unit.id);

  const toolConfigByName = new Map(config.tools.map((t) => [t.name, t]));
  const descriptionOverrides: Record<string, string> = {};
  for (const [name, cfg] of toolConfigByName) {
    if (cfg.description) descriptionOverrides[name] = cfg.description;
  }

  let kommoClient: ReturnType<typeof createKommoClient> | null = null;
  try {
    kommoClient = createKommoClient(unit);
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'Unit sem credenciais Kommo — tools desabilitadas');
  }

  const leadFieldRules = await listEnabledLeadFieldRules(unit.id);

  const allTools = kommoClient
    ? buildTools({
        recorder,
        kommo: kommoClient,
        descriptionOverrides,
        pausedFieldId: unit.kommoPausedFieldId,
        leadFieldRules,
        unit,
      })
    : [];

  const tools = fixarLeadDaConversa(
    allTools.filter((t) => {
      const cfg = toolConfigByName.get(t.name);
      return cfg ? cfg.enabled : true;
    }),
    leadIdDaConversa,
    recorder,
    unit,
  );

  // Comprovante em foto/PDF: só a equipe confirma (nas unidades com taxa de reserva, ele libera marcar). O agentNode
  // preenche isto a cada volta; a ferramenta lê.
  const comprovante: TurnoDoComprovante = { noTurno: false, pendente: false };
  travarAgendamentoPorComprovante(tools, comprovante, recorder, {
    exigePagamento: Boolean(unit.spineBookingRequiresPayment),
    // O valor da taxa vem de onde a unidade já guarda o antecipado; sem ele a IA não marca (vai para a equipe).
    taxaEsperada: precosDaConsulta(unit)?.antecipado ?? null,
  });

  const useAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
  const useGoogle = unit.llmProvider === 'google' && !!unit.googleApiKey;
  const provider = useAnthropic ? 'anthropic' : useGoogle ? 'google' : 'openai';
  const modelName = useAnthropic
    ? unit.anthropicModel || 'claude-opus-4-8'
    : useGoogle
      ? unit.googleModel || 'gemini-2.5-flash'
      : config.model || unit.openaiModel || env.OPENAI_MODEL;
  if (useAnthropic && strictToolsHabilitado()) {
    aplicarStrictAnthropic(tools);
  } else if (useAnthropic) {
    limparSchemaDoModelo(tools);
  }
  const toolsParaModelo = useGoogle ? toolsParaGemini(tools) : tools;
  const convoCache =
    useAnthropic && convoCacheHabilitado(unit.slug)
      ? { cache_control: { type: 'ephemeral' as const } }
      : undefined;
  // Uma função só pra montar o modelo: a chave reserva (chave-reserva.ts) precisa do MESMO modelo,
  // com os mesmos parâmetros e ferramentas — só a chave muda.
  const montarModelo = (u: Unit) => {
    const baseModel = createChatModel(u, {
      model: modelName,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    return (
      tools.length > 0
        ? (
            baseModel as unknown as { bindTools: (t: unknown[], kw?: object) => unknown }
          ).bindTools(toolsParaModelo, convoCache)
        : baseModel
    ) as unknown as Parameters<typeof invokeChatModel>[0]['model'];
  };
  const model = montarModelo(unit);

  // A conversa é a unidade que o teto de gasto vigia — não a mensagem, não a
  // execução. É dentro de UMA conversa que o custo foge do controle.
  const idDaConversa = leadIdDaConversa ? buildThreadId(unit.slug, leadIdDaConversa) : null;

  // A trava "reservado sem marcar" refaz COM ferramentas no máximo uma vez por turno: a refeita pode chamar
  // agendar_consulta, o grafo volta aqui, e uma segunda promessa no mesmo turno só é cortada, nunca refeita.
  let reservaJaRefeita = false;
  // A agenda reconsultada pelo código (horário vencido, "manhã ou tarde?", objeção inventada) e a refeita do "manhã ou
  // tarde?": no máximo UMA vez por turno cada — a volta da ferramenta passa por aqui de novo.
  let agendaJaReconsultada = false;
  let turnoJaRefeito = false;

  const agentNode = async (state: AgentStateType) => {
    await recorder.step({
      kind: 'THINKING',
      title: 'IA analisando intenção',
      payload: { model: modelName, msgCount: state.messages.length, unit: unit.slug },
    });

    const nonSystemMessages = state.messages.filter((m) => m.getType() !== 'system');
    // O que o PACIENTE disse neste turno (sem as linhas da equipe do <conversa_oficial>): de onde saem a rede de
    // segurança do sinal de alerta e a exceção do pronto-socorro.
    const mensagensDoPaciente = falasDoTurno(nonSystemMessages.map((m) => ({ tipo: m.getType(), texto: aiTextFromContent(m.content) })));
    const lastHuman = [...nonSystemMessages].reverse().find((m) => m.getType() === 'human');
    // O HumanMessage carrega o bloco <conversa_oficial> pregado na frente (webhook e salesbot).
    // Tudo que decide sobre O QUE O PACIENTE ESCREVEU — só um cumprimento, busca no RAG, nome —
    // precisa da mensagem crua, senão lê o bloco como se fosse fala dele.
    const userMessage = semBlocoOficial(
      lastHuman
        ? typeof lastHuman.content === 'string'
          ? lastHuman.content
          : JSON.stringify(lastHuman.content)
        : undefined,
    );
    // A conversa em falas: as contas de repetição (nome pedido 2x, mesma pergunta sem resposta, áudio não ouvido)
    // e de insistência no preço saem daqui, em código — o prompt recebe o resultado, não a tarefa de contar.
    // Sem as respostas seguradas (o paciente mandou outra mensagem enquanto elas nasciam): contam as que ele leu.
    const falas = falasDoHistorico(nonSystemMessages, leadIdDaConversa ? respostasSeguradas(unit.id, leadIdDaConversa) : []);
    const repeticao = analisarRepeticao(falas);
    const humanCount = nonSystemMessages.filter((m) => m.getType() === 'human').length;
    const aiCount = nonSystemMessages.filter((m) => m.getType() === 'ai').length;
    const isFirstTurn = humanCount === 1 && aiCount === 0;

    // Teto do MÊS da conta (chefe, 21/09/2026: R$ 300/clínica). Conferido ANTES de montar o prompt,
    // que é caro. O aviso de 80 %/100 % sai dentro de conferirTetoMensal; bloquear só com
    // TETO_MENSAL_ACAO=pausar — e aí a CONTA inteira entra em pausa (a mesma da recepção, até o
    // dia 1º): o paciente deste turno é avisado e os próximos nem chegam aqui, o webhook já pula
    // unidade em pausa. No MEIO de um turno (depois de uma ferramenta rodar) não corta: a consulta
    // que acabou de ser marcada precisa ser confirmada pro paciente.
    const ultimaMsg = nonSystemMessages[nonSystemMessages.length - 1];
    const meioDoTurno = ultimaMsg?.getType() === 'tool';
    if (!meioDoTurno) {
      const mensal = await conferirTetoMensal(unit);
      if (mensal.nivel === 'estourou' && acaoAoEstourar() === 'pausar') {
        await recorder.step({
          kind: 'ERROR',
          title: `💸 Conta ${mensal.conta} passou do teto do mês (R$ ${mensal.brl.toFixed(0)} de R$ ${mensal.teto}) — conta pausada até o dia 1º, equipe assume`,
          payload: { conta: mensal.conta, mes: mensal.mes, brl: mensal.brl, teto: mensal.teto },
        });
        registrarPausaPropria(unit, leadIdDaConversa); // o FALLBACK_TETO tem de sair mesmo com a conta pausada
        void entregarAoHumanoPorTetoMensal(unit, kommoClient, leadIdDaConversa, mensal, recorder);
        const aviso = textoDoTeto(retornoDaEquipe(unit));
        return {
          messages: [new AIMessage(aviso)],
          decision: aviso,
        } satisfies Partial<AgentStateType>;
      }
    }

    if (isFirstTurn && kommoClient && state.leadId && ENTRY_DATE_TAG_SLUGS.has(unit.slug)) {
      void maybeAddEntryDateTag({ recorder, kommo: kommoClient, leadId: state.leadId, tz: fusoDaUnidade(unit) });
    }

    // A oferta do disparo de campanha que este paciente recebeu: o prompt a ensina à Sofia e o guardrail de preço a aceita.
    // O prompt a carrega (junto com o resto, em paralelo) e a deixa aqui, para o guardrail ler a MESMA coisa sem consultar de novo.
    const ofertaDoTurno: { valor?: OfertaVigente | null } = {};

    let systemMessage: SystemMessage;
    // O prompt deste turno em texto: a guarda do nome do profissional (lá embaixo) só deixa sair
    // nome que esteja aqui ou no que as ferramentas devolveram agora.
    let promptDoTurno = '';
    if (useAnthropic) {
      const { cacheable, dynamic } = await composeSystemPromptPartsForUnit({
        unit,
        agentConfigPrompt: config.systemPrompt,
        userMessage,
        isFirstTurn,
        leadId: state.leadId,
        historico: falas,
        ofertaSaida: ofertaDoTurno,
      });
      promptDoTurno = `${cacheable}\n${dynamic ?? ''}`;
      systemMessage = new SystemMessage({
        content: [
          { type: 'text', text: cacheable, cache_control: { type: 'ephemeral', ttl: '1h' } },
          ...(dynamic ? [{ type: 'text', text: dynamic }] : []),
        ],
      } as never);
    } else {
      const dynamicPrompt = await composeSystemPromptForUnit({
        unit,
        agentConfigPrompt: config.systemPrompt,
        userMessage,
        isFirstTurn,
        leadId: state.leadId,
        historico: falas,
        ofertaSaida: ofertaDoTurno,
      });
      promptDoTurno = dynamicPrompt;
      systemMessage = new SystemMessage(dynamicPrompt);
    }
    const extrasDoGuardrail = { ofertaDaCampanha: ofertaDoTurno.valor?.oferta ?? null };
    // Comprovante (foto/PDF) neste turno, ou nas últimas falas do paciente: a ferramenta de agendar recusa e a resposta que
    // afirma confirmação vira o recado (confirmacao-so-com-crm.ts). Com a consulta já no CRM (a equipe criou) a espera acabou.
    Object.assign(
      comprovante,
      turnoDoComprovante(
        nonSystemMessages
          .filter((m) => m.getType() === 'human')
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
        promptTemConsulta(promptDoTurno),
      ),
    );
    // Chamada de ferramenta sem resultado (turno cortado no meio) deixaria o lead preso pra sempre no 400 do modelo:
    // o histórico vive no checkpoint. Sanea-se o histórico INTEIRO antes da janela (a poda não pode separar a chamada
    // do resultado e fazer o saneamento inventar "interrompida" para uma ação que deu certo) e só o que VAI ao modelo
    // é alterado. O rastro registra, pra poder contar em produção.
    const saneado = sanearHistorico(nonSystemMessages);
    const janela = podarHistorico(saneado.messages);
    const sinteticosNaJanela = janela.filter(
      (m) => m.getType() === 'tool' && m.content === TEXTO_FERRAMENTA_INTERROMPIDA,
    ).length;
    if (sinteticosNaJanela > 0 || saneado.removidos > 0) {
      logger.warn(
        { unit: unit.slug, leadId: leadIdDaConversa, completados: saneado.completados, removidos: saneado.removidos },
        'histórico com chamada de ferramenta sem resultado — saneado antes de ir ao modelo',
      );
      await recorder.step({
        kind: 'THINKING',
        title: `🩹 Histórico com ${saneado.completados.length} chamada(s) de ferramenta sem resultado e ${saneado.removidos} resultado(s) sem chamada — saneado antes de ir ao modelo`,
        payload: { completados: saneado.completados, removidos: saneado.removidos },
      });
    }
    const finalMessages: BaseMessage[] = [systemMessage, ...janela];

    // Conferido ANTES de gastar de novo, e FORA do try: se caísse no catch, o
    // plano B chamaria o modelo assim mesmo e o teto não seguraria nada.
    if (idDaConversa) {
      const teto = conferirTeto(idDaConversa);
      if (teto.estourou) {
        if (marcarAvisado(idDaConversa)) {
          logarEstouro(idDaConversa, teto, unit.slug);
          await recorder.step({
            kind: 'ERROR',
            title: `💸 Conversa passou do teto de gasto (US$ ${teto.usd.toFixed(2)} em ${teto.turnos} turnos) — humano assume`,
            payload: { usd: teto.usd, turnos: teto.turnos, teto: teto.teto },
          });
          // o FALLBACK_TETO avisa o paciente: a trava não o descarta. Sem o campo de pausa nada é pausado, e a
          // marca soltaria a resposta atropelada com o próximo turno respondendo de novo.
          if (unit?.kommoPausedFieldId) registrarPausaPropria(unit, leadIdDaConversa);
          void entregarAoHumano(unit, kommoClient, leadIdDaConversa, teto, recorder);
        }
        // O paciente NÃO fica no vácuo. Conversa cara é quase sempre conversa
        // quente: sumir agora seria perder exatamente o lead que mais interessa.
        const aviso = textoDoTeto(retornoDaEquipe(unit));
        return {
          messages: [new AIMessage(aviso)],
          decision: aviso,
        } satisfies Partial<AgentStateType>;
      }
    }

    const t0 = performance.now();
    let response: AIMessage;
    // O modelo caiu (principal e plano B): o paciente recebe o texto de "IA indisponível", MAS se ele disse um sinal de
    // alerta a equipe é avisada do mesmo jeito (pausar_ia com a flag) e a frase do passe sai no lugar.
    const respostaIndisponivel = async (): Promise<Partial<AgentStateType>> => {
      let texto = FALLBACK_INDISPONIVEL;
      try {
        const passe = await passarPorSinalNoTurno({
          unit,
          leadId: state.leadId,
          mensagens: nonSystemMessages,
          falasDoPaciente: mensagensDoPaciente,
          tools,
          recorder,
          textoFinal: FALLBACK_INDISPONIVEL,
        });
        texto = passe.texto;
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug }, 'sinal de alerta: a rede de segurança falhou com o modelo fora do ar');
      }
      return { messages: [new AIMessage(texto)], decision: texto };
    };
    // Quem respondeu este turno. Muda só quando a chave reserva assume — aí a reescrita da
    // pergunta final (mais abaixo) também sai pela reserva, em vez de bater de novo na chave morta.
    let modeloAtivo = model;
    let provedorAtivo: string = provider;
    let respondeuPlanoB = false;
    try {
      // Provedor comprovadamente fora não ganha mais 35 segundos de espera por
      // mensagem: pula direto pro plano B, e volta sozinho quando se recuperar.
      if (circuitoAberto(provider as Provedor)) {
        throw new LlmTimeoutError(0);
      }
      let modeloReserva: typeof model | null = null;
      response = (await comChaveReserva({
        unidade: unit,
        provedor: provider,
        chamar: (chaveReserva) => {
          const modeloDaVez = chaveReserva ? montarModelo({ ...unit, anthropicApiKey: chaveReserva }) : model;
          if (chaveReserva) modeloReserva = modeloDaVez;
          return withTimeout(
            invokeChatModel({
              model: modeloDaVez,
              messages: finalMessages,
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName,
              provider: chaveReserva ? PROVEDOR_RESERVA : provider,
              tools,
              conversaId: idDaConversa,
            }),
            AGENT_NODE_TIMEOUT_MS,
          );
        },
        aoUsarReserva: async (falha) => {
          if (modeloReserva) {
            modeloAtivo = modeloReserva;
            provedorAtivo = PROVEDOR_RESERVA;
          }
          await recorder.step({
            kind: 'THINKING',
            title: `🔑 Chave da unidade recusada (${falha.status ?? '?'}/${falha.tipo}) — a chave reserva respondeu`,
            payload: { falha, modelo: modelName },
            latencyMs: Math.round(performance.now() - t0),
          });
        },
        aoFalharReserva: async (falha, erroReserva) => {
          await recorder.step({
            kind: 'ERROR',
            title: `🔑 Chave da unidade recusada (${falha.status ?? '?'}/${falha.tipo}) e a chave reserva também falhou — seguindo pro plano B`,
            payload: { falha, erroReserva: erroReserva instanceof Error ? erroReserva.message : String(erroReserva) },
            latencyMs: Math.round(performance.now() - t0),
          });
        },
      })) as AIMessage;
      registrarSucesso(provider as Provedor);
    } catch (err) {
      const erroPrincipal = err instanceof Error ? err.message : String(err);
      // Recusa do modelo: o provedor está de pé — não conta para o circuito (ehFalhaDeInfra é false). Fica no rastro.
      if (err instanceof LlmRecusaError) {
        await recorder.step({
          kind: 'ERROR',
          title: `🚫 ${provider} recusou responder (stop_reason=refusal${err.categoria ? `, categoria ${err.categoria}` : ''}) — resposta descartada`,
          payload: { provider, modelo: modelName, stopReason: 'refusal', categoria: err.categoria },
          latencyMs: Math.round(performance.now() - t0),
        });
      }
      if (ehFalhaDeInfra(err) && registrarFalha(provider as Provedor)) {
        logger.error(
          { provider, unit: unit.slug, erro: erroPrincipal },
          'provedor de IA cortado após falhas seguidas — indo direto pro plano B',
        );
        void recorder.step({
          kind: 'ERROR',
          title: `⚡ ${provider} cortado após falhas seguidas — plano B assume até ele voltar`,
          payload: { provider, erro: erroPrincipal },
        });
      }
      const planoB = escolherPlanoB(unit, !!env.OPENAI_API_KEY);
      if (planoB) {
        try {
          const modeloB = createChatModel(
            { ...unit, llmProvider: planoB.provider },
            { model: planoB.modelName, temperature: config.temperature, maxTokens: config.maxTokens },
          );
          const modeloBComTools = (
            tools.length > 0
              ? (modeloB as unknown as { bindTools: (t: unknown[]) => unknown }).bindTools(
                  planoB.provider === 'google'
                    ? toolsParaGemini(tools)
                    : planoB.provider === 'openai'
                      ? toolsParaOpenAI(tools)
                      : tools,
                )
              : modeloB
          ) as unknown as Parameters<typeof invokeChatModel>[0]['model'];

          response = (await withTimeout(
            invokeChatModel({
              model: modeloBComTools,
              // Os blocos de raciocínio da Anthropic só valem no modelo que os gerou: o plano B de outro provedor não os recebe.
              messages: planoB.provider === 'anthropic' ? finalMessages : semRaciocinioParaPlanoB(finalMessages),
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName: planoB.modelName,
              provider: planoB.provider,
              tools,
              conversaId: idDaConversa,
            }),
            PLANO_B_TIMEOUT_MS,
          )) as AIMessage;

          respondeuPlanoB = true;
          await recorder.step({
            kind: 'THINKING',
            title: `🔁 Plano B: ${planoB.provider} (${planoB.modelName}) respondeu no lugar do modelo principal`,
            payload: { erroPrincipal, planoB },
            latencyMs: Math.round(performance.now() - t0),
          });
        } catch (err2) {
          await recorder.step({
            kind: 'ERROR',
            title: '⏱️ IA indisponível — principal e plano B falharam',
            payload: {
              erroPrincipal,
              erroPlanoB: err2 instanceof Error ? err2.message : String(err2),
              planoB,
            },
            latencyMs: Math.round(performance.now() - t0),
          });
          return respostaIndisponivel();
        }
      } else {
        const foiRecusa = err instanceof LlmRecusaError;
        await recorder.step({
          kind: 'ERROR',
          title: foiRecusa
            ? '🚫 O modelo recusou responder e não há plano B configurado — fallback enviado'
            : '⏱️ IA indisponível — sem plano B configurado, fallback enviado',
          payload: foiRecusa ? { erroPrincipal } : { erroPrincipal, timeoutMs: AGENT_NODE_TIMEOUT_MS },
          latencyMs: Math.round(performance.now() - t0),
        });
        return respostaIndisponivel();
      }
    }
    const latency = Math.round(performance.now() - t0);

    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = aiTextFromContent(response.content);
      await recorder.step({
        kind: 'THINKING',
        title: 'IA respondeu (sem tool call)',
        payload: { text },
        latencyMs: latency,
      });

      // Juiz determinístico da pergunta final: resposta que só informa e para é refeita UMA vez, com a
      // instrução na cara. Só quando nada mais mexeu no texto (guardrail limpo) — senão a reescrita brigaria
      // com a correção de preço/lacuna. Se a segunda tentativa vier com tool call ou vazia, fica a original.
      let textoFinal = text;

      // Bastidor na resposta (15/10/2026, Mossoró: a paciente recebeu "Registrei o acompanhamento com a
      // Zuzu — ela qualificou…"). Reescreve numa chamada SEPARADA — sem histórico e sem ferramentas — só
      // transformando o rascunho em mensagem para o paciente. Se ainda vazar, fica a original, e a barreira
      // da entrega (webhook.controller) não deixa sair: melhor o paciente sem resposta neste turno.
      const vazou = detectarVazamento(text);
      if (vazou) {
        const t1 = performance.now();
        let reescrito = '';
        let erroReescrita: string | null = null;
        try {
          const revisor = createChatModel(unit, { model: modelName, temperature: 0, maxTokens: 400 });
          const r = (await withTimeout(
            invokeChatModel({
              model: revisor as unknown as Parameters<typeof invokeChatModel>[0]['model'],
              messages: [new SystemMessage(SISTEMA_REESCRITOR_BASTIDOR), new HumanMessage(pedidoAoReescritor(userMessage ?? null, text))],
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName,
              provider: provedorAtivo,
              tools: [],
              conversaId: idDaConversa,
            }),
            AGENT_NODE_TIMEOUT_MS,
          )) as AIMessage;
          reescrito = aiTextFromContent(r.content).trim().replace(/^["“]|["”]$/g, '');
        } catch (err) {
          erroReescrita = err instanceof Error ? err.message : String(err);
        }
        const limpo = !!reescrito && !detectarVazamento(reescrito);
        if (limpo) {
          textoFinal = reescrito;
          response.content = reescrito;
        }
        await recorder.step({
          kind: limpo ? 'THINKING' : 'ERROR',
          title: limpo
            ? `🙈 Bastidor na resposta — reescrita só com a mensagem pro paciente (${explicarVazamento(vazou)})`
            : `🙈 Bastidor na resposta e a reescrita não resolveu — o envio será bloqueado (${explicarVazamento(vazou)})`,
          payload: { original: text, reescrita: reescrito || null, trecho: vazou.trecho, erro: erroReescrita },
          latencyMs: Math.round(performance.now() - t1),
        });
      }

      // Refaz a resposta UMA vez com uma instrução na cara, com as ferramentas (a refeita pode chamar uma).
      const refazerComInstrucao = async (instrucao: string) => {
        const t1 = performance.now();
        try {
          const msg = (await withTimeout(
            invokeChatModel({
              model: modeloAtivo,
              messages: [...finalMessages, response, new HumanMessage(instrucao)],
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName,
              provider: provedorAtivo,
              tools,
              conversaId: idDaConversa,
            }),
            AGENT_NODE_TIMEOUT_MS,
          )) as AIMessage;
          return { msg, erro: null as string | null, ms: Math.round(performance.now() - t1) };
        } catch (err) {
          return { msg: null, erro: err instanceof Error ? err.message : String(err), ms: Math.round(performance.now() - t1) };
        }
      };

      // Agenda × resposta (auditoria de Araguaína, 21/10/2026). Paciente que agradeceu ou encerrou não recebe horário:
      // o empurrão sai mais abaixo (paciente-encerrou.ts). Fora isso — horário que já passou, horários de uma consulta
      // velha à agenda, "manhã ou tarde?" no lugar de dois horários, objeção que ele não levantou (horario-oferecido.ts,
      // objecao-inventada.ts) — a agenda é consultada de novo, UMA vez por turno: o grafo chama consultar_horarios e o
      // modelo escreve de novo com a agenda de agora. Gemini (exige assinatura na chamada de ferramenta) não recebe
      // chamada montada pelo código: refaz com a instrução. Com o plano B respondendo, só os cortes, sem modelo.
      const agoraDaUnidade = agoraLocalISO(fusoDaUnidade(unit));
      const encerrou = pacienteEncerrou(falas);
      if (tools.some((t) => t.name === 'consultar_horarios') && !encerrou) {
        const consultas = consultasDaAgenda(nonSystemMessages);
        const travaHorario = travaDoHorario({
          texto: textoFinal,
          agoraLocal: agoraDaUnidade,
          consultas,
          ferramentas: ferramentasDoTurno(nonSystemMessages),
          jaReconsultou: agendaJaReconsultada,
        });
        // A sondagem só leva à agenda quando a resposta não trouxe horário; com horário, só a pergunta sai (lá embaixo).
        const sonda = travaHorario ? null : objecaoInventada(falas, textoFinal);
        const reconsulta =
          travaHorario?.acao === 'reconsultar'
            ? travaHorario
            : sonda && horariosOferecidos(textoFinal, agoraDaUnidade).length === 0 && !agendaJaReconsultada && !consultas.some((c) => c.noTurno)
              ? { motivo: `perguntou o que pesa sem ele ter levantado dúvida ("${sonda.slice(0, 80)}")`, data: diaSeguinte(agoraDaUnidade) }
              : null;
        const aindaServe = (t: string) =>
          !!t &&
          !detectarVazamento(t) &&
          horariosQueJaPassaram(horariosOferecidos(t, agoraDaUnidade), agoraDaUnidade).length === 0 &&
          !perguntaTurnoSemHorario(t, agoraDaUnidade) &&
          !objecaoInventada(falas, t);
        if (reconsulta && !respondeuPlanoB) {
          // marcado ANTES dos dois caminhos (chamada montada e refeita do Gemini): a volta da ferramenta não reconsulta de novo
          agendaJaReconsultada = true;
          if (!useGoogle) {
            await recorder.step({
              kind: 'THINKING',
              title: `🗓️ ${reconsulta.motivo} — consultando a agenda de novo (a partir de ${reconsulta.data})`,
              payload: { original: textoFinal, data: reconsulta.data },
            });
            return { messages: [reconsultaDaAgenda(reconsulta.data)] } satisfies Partial<AgentStateType>;
          }
          const r = await refazerComInstrucao(
            travaHorario ? instrucaoParaReconsultar(reconsulta.motivo) : instrucaoSemObjecao(falaDoPacienteNoTurno(falas)),
          );
          const chamadas = r.msg?.tool_calls ?? [];
          if (r.msg && chamadas.length > 0) {
            await recorder.step({
              kind: 'THINKING',
              title: `🗓️ ${reconsulta.motivo} — refeita chamando ${chamadas.map((c) => c.name).join(', ')}`,
              payload: { original: textoFinal, chamadas: chamadas.map((c) => ({ nome: c.name, args: c.args })) },
              latencyMs: r.ms,
            });
            return { messages: [r.msg] } satisfies Partial<AgentStateType>;
          }
          const textoRefeito = r.msg ? aiTextFromContent(r.msg.content).trim() : '';
          const serve = aindaServe(textoRefeito);
          if (serve) {
            textoFinal = textoRefeito;
            response.content = textoRefeito;
          }
          await recorder.step({
            kind: 'THINKING',
            title: serve ? `🗓️ ${reconsulta.motivo} — refeita` : `🗓️ ${reconsulta.motivo}; a refeita não serviu — seguem os cortes`,
            payload: { refeita: textoRefeito || null, final: textoFinal, erro: r.erro },
            latencyMs: r.ms,
          });
        } else if (travaHorario?.acao === 'refazer_turno') {
          // Refaz UMA vez; se não der (refeita ruim, plano B, já refeita), a pergunta do turno dá lugar, em código, aos
          // dois horários que a agenda devolveu neste turno — "manhã ou tarde?" não sai.
          let serve = false;
          let textoRefeito = '';
          let erro: string | null = null;
          let ms = 0;
          if (!respondeuPlanoB && !turnoJaRefeito) {
            turnoJaRefeito = true;
            const r = await refazerComInstrucao(INSTRUCAO_REFAZER_TURNO);
            textoRefeito = r.msg && (r.msg.tool_calls ?? []).length === 0 ? aiTextFromContent(r.msg.content).trim() : '';
            serve = aindaServe(textoRefeito) && horariosOferecidos(textoRefeito, agoraDaUnidade).length > 0;
            erro = r.erro;
            ms = r.ms;
          }
          textoFinal = serve
            ? textoRefeito
            : semPerguntaDeTurno(textoFinal, agoraDaUnidade, ofertaDaConsultaDoTurno(nonSystemMessages));
          response.content = textoFinal;
          await recorder.step({
            kind: 'THINKING',
            title: serve ? `🗓️ ${travaHorario.motivo} — refeita com dois horários` : `🗓️ ${travaHorario.motivo} — a pergunta do turno deu lugar aos horários da agenda`,
            payload: { refeita: textoRefeito || null, final: textoFinal, erro },
            latencyMs: ms,
          });
        }
        // Sem modelo: horário que já passou nunca sai; a sondagem sai quando sobra resposta sem ela.
        const semPassado = semHorarioPassado(textoFinal, agoraDaUnidade, ofertaDaConsultaDoTurno(nonSystemMessages));
        if (semPassado !== textoFinal) {
          await recorder.step({
            kind: 'ERROR',
            title: '🗓️ Horário que já passou saiu da resposta',
            payload: { original: textoFinal, final: semPassado, agora: agoraDaUnidade },
          });
          textoFinal = semPassado;
          response.content = semPassado;
        }
        const sondaQueFicou = objecaoInventada(falas, textoFinal);
        const semSonda = sondaQueFicou ? semASonda(textoFinal, sondaQueFicou) : '';
        if (sondaQueFicou && semSonda) {
          await recorder.step({
            kind: 'THINKING',
            title: `🗓️ Perguntou o que pesa sem ele ter levantado dúvida — a pergunta saiu ("${sondaQueFicou.slice(0, 80)}")`,
            payload: { original: textoFinal, final: semSonda },
          });
          textoFinal = semSonda;
          response.content = semSonda;
        }
      }

      // "Reservado" sem consulta (19/10/2026, Olímpia: o Anderson pagou o 11h30 que a IA disse ter reservado, e o
      // horário foi pra outro paciente — ver reserva-sem-marcar.ts). Antes de enviar: refaz UMA vez com as
      // ferramentas, para a IA poder MARCAR; texto refeito só vale sem a promessa; senão o trecho sai.
      const doTurno: string[] = [];
      for (let i = nonSystemMessages.length - 1; i >= 0 && nonSystemMessages[i].getType() !== 'human'; i--) {
        const m = nonSystemMessages[i];
        if (m.getType() === 'tool') doTurno.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      }
      const marcouAgora = marcouNesteTurno(doTurno);
      const blocoConsulta = blocoDaConsulta(promptDoTurno);
      // Taxa de reserva (taxa-de-reserva.ts): o que a trava precisa saber do turno. Lido na hora, porque `comprovante` é preenchido a cada volta.
      const dadosDaTaxaDaUnidade = dadosDaTaxa(unit);
      if (unit.spineBookingRequiresPayment && !dadosDaTaxaDaUnidade && !taxaSemDadosJaAvisada.has(unit.slug)) {
        // flag ligada e a trava desligada por falta de chave Pix ou do valor da taxa: o bug de "a equipe te envia a chave" volta, e sem aviso
        taxaSemDadosJaAvisada.add(unit.slug);
        logger.warn({ unit: unit.slug }, 'taxa de reserva: unidade com a flag mas sem chave Pix ou sem o valor da taxa nas fontes — a trava da chave está desligada');
      }
      // O histórico só é percorrido em unidade com a taxa ativa (flag + chave + valor): nas outras 21 a trava nem começa.
      const taxaDoTurno = dadosDaTaxaDaUnidade
        ? {
            respostaAnterior: respostaAnteriorDaIA(nonSystemMessages.map((m) => ({ tipo: m.getType(), texto: aiTextFromContent(m.content) }))),
            // comprovante lido em QUALQUER data: quem já pagou não paga de novo porque a equipe demorou mais de 24 h para criar a consulta
            jaMandouComprovante: pacienteJaMandouComprovante(
              nonSystemMessages.filter((m) => m.getType() === 'human').map((m) => aiTextFromContent(m.content)),
            ),
            insistenciaJaEncaminhada: insistenciaJaTratada(nonSystemMessages.filter((m) => m.getType() === 'ai').map((m) => aiTextFromContent(m.content))),
          }
        : null;
      const contextoDaTaxa = () => ({
        falasDoPaciente: mensagensDoPaciente,
        respostaAnterior: taxaDoTurno?.respostaAnterior ?? '',
        consultaDePe: promptTemConsulta(promptDoTurno) || marcouAgora,
        emTratamento: promptDizEmTratamento(promptDoTurno),
        comprovanteLido: comprovante.pendente,
        jaMandouComprovante: taxaDoTurno?.jaMandouComprovante ?? false,
        insistenciaJaEncaminhada: taxaDoTurno?.insistenciaJaEncaminhada ?? false,
      });
      // O vínculo da consulta (gravado por agendar_consulta) e o campo do cartão são lidos UMA vez por turno, e só quando alguém
      // precisa: o prompt pode não ter trazido a consulta, e o cartão diz se ele já pagou.
      let vinculoLido: Promise<string | null> | undefined;
      const lerVinculo = () =>
        (vinculoLido ??= state.leadId ? agendamentoDoVinculo(unit.id, Number(state.leadId), fusoDaUnidade(unit)) : Promise.resolve(null));
      let cartaoLido: Promise<boolean> | undefined;
      const lerCartao = () =>
        (cartaoLido ??=
          kommoClient && state.leadId
            ? kommoClient.getLead(Number(state.leadId)).then((lead) => pagouOAntecipado(lead.custom_fields_values))
            : Promise.resolve(false));
      const provasDaTaxa = { consultaGravada: async () => !!(await lerVinculo()), cartaoDizPago: lerCartao };
      // Toda reescrita feita depois (pergunta final, "pediu o nome pela 3ª vez") passa pelas travas de confirmação: se ela
      // reabrir a afirmação, fica a resposta anterior.
      const reabreAfirmacao = async (t: string) =>
        !!t &&
        (!!respostaDoComprovante(t, comprovante, promptTemConsulta(promptDoTurno) || marcouAgora) ||
          !!afirmouComConsultaDesmarcada(t, { marcouAgora, bloco: blocoConsulta, promessa: null }) ||
          !!(await decidirATaxa(t, dadosDaTaxaDaUnidade, contextoDaTaxa(), provasDaTaxa)).troca);
      // Comprovante em foto/PDF: só a equipe confirma a consulta (decisão do João, 26/10/2026). A resposta que
      // afirma confirmação vira o recado fixo e a equipe ganha a tarefa — aberta pelo código, não pela IA.
      // `respostaFixa`: o texto é um recado nosso — a "pergunta final" não o reescreve (ele já diz o próximo passo).
      let respostaFixa = false;
      // `marcouAgora`: a consulta acabou de ser criada no CRM (unidade com taxa de reserva, depois do comprovante da taxa): falar
      // DELA é verdade; "pagamento confirmado" continua sendo da equipe.
      const recadoComprovante = respostaDoComprovante(textoFinal, comprovante, promptTemConsulta(promptDoTurno) || marcouAgora);
      if (recadoComprovante) {
        respostaFixa = true;
        await recorder.step({
          kind: 'THINKING',
          title: '🧾 Comprovante: a resposta confirmava a consulta — trocada pelo recado (só a equipe confirma)',
          payload: { original: textoFinal, final: recadoComprovante, noTurno: comprovante.noTurno },
        });
        textoFinal = recadoComprovante;
        response.content = recadoComprovante;
      }
      if (comprovante.noTurno && kommoClient && state.leadId) {
        await abrirTarefaParaEquipe({
          slug: unit.slug,
          unitId: unit.id,
          leadId: Number(state.leadId),
          kommo: kommoClient,
          recorder,
          motivo: 'comprovante',
          detalhe: unit.spineBookingRequiresPayment ? detalheDoValor(comprovante, precosDaConsulta(unit)?.antecipado ?? null) : undefined,
        });
      }

      const consultasValidas = promptTemConsulta(promptDoTurno) ? [blocoConsulta] : [];
      let promessa = reservaSemMarcar(textoFinal, { marcouAgora, consultasValidas });
      if (promessa && state.leadId) {
        const doVinculo = await lerVinculo();
        // a mesma prova vale para conferir a reescrita lá embaixo (4º achado do Codex)
        if (doVinculo) consultasValidas.push(doVinculo);
        if (doVinculo) promessa = reservaSemMarcar(textoFinal, { marcouAgora, consultasValidas });
      }
      // Consulta desmarcada no CRM e a resposta a trata como de pé (Balsas #28858838, 22/10): entra na mesma trava, com
      // uma instrução própria (a IA só marca se o paciente pediu horário NOVO) e, sem saída limpa, o recado fixo.
      const blocoDesmarcada = blocoDizDesmarcada(blocoConsulta);
      if (!promessa) promessa = afirmouComConsultaDesmarcada(textoFinal, { marcouAgora, bloco: blocoConsulta, promessa });
      const desmarcada = blocoDesmarcada && !marcouAgora && !!promessa;
      if (promessa) {
        const t1 = performance.now();
        let refeita: AIMessage | null = null;
        let erroRefeita: string | null = null;
        // Com o plano B respondendo, o modelo principal está fora: refazer nele só gastaria o tempo limite.
        if (!reservaJaRefeita && !respondeuPlanoB) {
          reservaJaRefeita = true;
          try {
            refeita = (await withTimeout(
              invokeChatModel({
                model: modeloAtivo,
                messages: [...finalMessages, response, new HumanMessage(desmarcada ? INSTRUCAO_DESMARCADA : INSTRUCAO_RESERVA_SEM_MARCAR)],
                unitId: unit.id,
                traceId: recorder.traceId,
                modelName,
                provider: provedorAtivo,
                tools,
                conversaId: idDaConversa,
              }),
              AGENT_NODE_TIMEOUT_MS,
            )) as AIMessage;
          } catch (err) {
            erroRefeita = err instanceof Error ? err.message : String(err);
          }
        }
        const chamadas = refeita?.tool_calls ?? [];
        if (refeita && chamadas.length > 0) {
          await recorder.step({
            kind: 'THINKING',
            title: `📅 Disse que estava reservado sem marcar — refeita chamando ${chamadas.map((c) => c.name).join(', ')}`,
            payload: { original: textoFinal, trecho: promessa.trecho, chamadas: chamadas.map((c) => ({ nome: c.name, args: c.args })) },
            latencyMs: Math.round(performance.now() - t1),
          });
          return { messages: [refeita] } satisfies Partial<AgentStateType>;
        }
        const textoRefeito = refeita ? aiTextFromContent(refeita.content).trim() : '';
        const semPromessa = (t: string) =>
          !reservaSemMarcar(t, { marcouAgora: false, consultasValidas }) && !(desmarcada && afirmaConfirmacao(t, { estrito: true }));
        let saida: 'refeita' | 'cortada' | 'neutra';
        const cortado = desmarcada ? null : semOTrecho(textoFinal, promessa.trecho);
        if (textoRefeito && semPromessa(textoRefeito) && !detectarVazamento(textoRefeito)) {
          saida = 'refeita';
          textoFinal = textoRefeito;
        } else if (cortado && semPromessa(cortado)) {
          saida = 'cortada';
          textoFinal = cortado;
        } else {
          // Nem a refeita nem o corte tiraram a promessa: a original NÃO sai (achado do Codex, 19/10).
          saida = 'neutra';
          textoFinal = desmarcada ? RECADO_DESMARCADA : PERGUNTA_NEUTRA;
          respostaFixa = true;
        }
        response.content = textoFinal;
        // Tarefa quando a resposta final cita a equipe/recepção/clínica (o recado fixo cita): sem adivinhar "promessa" pelo texto.
        if (desmarcada && (saida === 'neutra' || citaEquipe(textoFinal)) && kommoClient && state.leadId) {
          await abrirTarefaParaEquipe({
            slug: unit.slug,
            unitId: unit.id,
            leadId: Number(state.leadId),
            kommo: kommoClient,
            recorder,
            motivo: 'desmarcada',
          });
        }
        await recorder.step({
          kind: saida === 'neutra' ? 'ERROR' : 'THINKING',
          title:
            saida === 'refeita'
              ? `📅 Disse que estava reservado sem marcar — reescrita sem a promessa ("${promessa.trecho.slice(0, 80)}")`
              : saida === 'cortada'
                ? `📅 Disse que estava reservado sem marcar — o trecho saiu da resposta ("${promessa.trecho.slice(0, 80)}")`
                : `📅 Disse que estava reservado sem marcar e não consegui tirar — saiu a pergunta neutra ("${promessa.trecho.slice(0, 80)}")`,
          payload: { trecho: promessa.trecho, forma: promessa.forma, refeita: textoRefeito || null, final: textoFinal, erro: erroRefeita },
          latencyMs: Math.round(performance.now() - t1),
        });
      }

      // Taxa de reserva (Boa Vista, 27–28/10/2026): a chave Pix sai por código, e horário não é dado como garantido sem
      // consulta no CRM nem comprovante da taxa (taxa-de-reserva.ts). Depois das travas de cima: se elas já trocaram a
      // resposta, esta confere o que sobrou. Sem chave ou sem valor cadastrado, nada muda. Só unidade com a flag.
      // A decisão, a prova (consulta gravada, cartão pago) e o aviso à equipe moram em taxa-de-reserva-saida.ts.
      if (dadosDaTaxaDaUnidade) {
        const resumirDaTaxa = state.leadId ? tools.find((tl) => tl.name === 'resumir_lead_para_sdr') : undefined;
        const saidaDaTaxa = await aplicarTaxaDeReservaNaSaida(textoFinal, dadosDaTaxaDaUnidade, contextoDaTaxa(), {
          recorder,
          leadId: state.leadId ? Number(state.leadId) : null,
          ...provasDaTaxa,
          resumir: resumirDaTaxa,
          abrirTarefa:
            kommoClient && state.leadId
              ? () =>
                  abrirTarefaParaEquipe({
                    slug: unit.slug,
                    unitId: unit.id,
                    leadId: Number(state.leadId),
                    kommo: kommoClient,
                    recorder,
                    motivo: 'insistiu_na_clinica',
                    // o aviso padrão do Telegram diz "a equipe confirma em até 1 hora": não é o caso aqui; o aviso certo sai de aplicarTaxaDeReservaNaSaida
                    alertar: async () => undefined,
                  })
              : undefined,
          slug: unit.slug,
          alertar: (texto) => enviarTelegram(texto),
        });
        if (saidaDaTaxa.troca) {
          respostaFixa = true;
          textoFinal = saidaDaTaxa.texto;
          response.content = textoFinal;
        }
      }

      // Sinal de alerta dito com todas as letras e o modelo NÃO avisou (26/10/2026): a regra de 21/10 estava no prompt e
      // Olímpia/Mossoró/Balsas/Rio Verde ficaram sem etiqueta, sem tarefa e sem aviso. Aqui o código passa pela mesma
      // ferramenta pausar_ia (etiqueta 🔴 PRIORIDADE + tarefa LIGAR AGORA + Telegram do João). Só frase sem ambiguidade
      // (sinal-de-alerta.ts); a fala vaga fica com o modelo, que pergunta UM sinal.
      const passe = await passarPorSinalNoTurno({
        unit,
        leadId: state.leadId,
        mensagens: nonSystemMessages,
        falasDoPaciente: mensagensDoPaciente,
        tools,
        recorder,
        textoFinal,
      });
      // A rede trocou o texto (mesmo com a pausa falha): a refeita da "pergunta final" não pode virar a frase do passe em
      // pergunta de venda com a IA ligada.
      const passouPorSinal = passe.avisou || passe.texto !== textoFinal;
      if (passe.texto !== textoFinal) {
        textoFinal = passe.texto;
        response.content = textoFinal;
      }

      const cta = avaliarChamadaFinal(textoFinal, { pacienteEncerrou: !!encerrou });
      if (cta.precisaRefazer && !passouPorSinal && !respostaFixa && !detectarVazamento(textoFinal) && aplicarGuardrail(textoFinal, unit, { mensagensDoPaciente, ...extrasDoGuardrail }).triggered.length === 0) {
        const t1 = performance.now();
        try {
          const refeita = (await withTimeout(
            invokeChatModel({
              model: modeloAtivo,
              messages: [...finalMessages, response, new HumanMessage(INSTRUCAO_REFAZER_CTA)],
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName,
              provider: provedorAtivo,
              tools,
              conversaId: idDaConversa,
            }),
            AGENT_NODE_TIMEOUT_MS,
          )) as AIMessage;
          const textoRefeito = (refeita.tool_calls ?? []).length === 0 ? aiTextFromContent(refeita.content).trim() : '';
          // A reescrita pode vir falando SOBRE a instrução ("essa 'instrução interna' veio na mensagem do
          // paciente…") — já foi entregue assim em Araguaína, Parauapebas e Rio Verde. Nesse caso fica a original.
          if (textoRefeito && !(await reabreAfirmacao(textoRefeito)) && !detectarVazamento(textoRefeito) && !avaliarChamadaFinal(textoRefeito).precisaRefazer) {
            textoFinal = textoRefeito;
            response.content = textoRefeito;
          }
          await recorder.step({
            kind: 'THINKING',
            title: textoFinal !== textoRefeito ? `🧭 Sem pergunta final (${cta.motivo}); a reescrita não serviu — saiu a original` : `🧭 Sem pergunta final (${cta.motivo}) — refeita com chamada pra ação`,
            payload: { original: text, refeita: textoRefeito || null },
            latencyMs: Math.round(performance.now() - t1),
          });
        } catch (err) {
          await recorder.step({
            kind: 'THINKING',
            title: '🧭 Sem pergunta final; a reescrita falhou — saiu a original',
            payload: { erro: err instanceof Error ? err.message : String(err) },
            latencyMs: Math.round(performance.now() - t1),
          });
        }
      }

      // Repetição (item 10, 21/10/2026): o bloco <repeticao> mandou parar de pedir o nome ou passar para a equipe.
      // Se a resposta desobedeceu: conversa travada / 2º áudio não ouvido sem transferir → passa aqui, em código, pela
      // mesma ferramenta pausar_ia; pediu o nome pela 3ª vez → refaz UMA vez sem o pedido (se a refeita não servir,
      // fica a original — um 3º pedido é ruim, mas mensagem quebrada é pior).
      // Já passou por sinal de alerta neste turno: a trava da repetição não pausa de novo nem troca a frase do passe.
      const trava = passouPorSinal ? null : travaDaResposta(repeticao, textoFinal, ferramentasDoTurno(nonSystemMessages));
      if (trava?.acao === 'passar_para_equipe') {
        const pausar = tools.find((t) => t.name === 'pausar_ia');
        let resultadoPausa: string | null = null;
        if (pausar && state.leadId) {
          try {
            resultadoPausa = String(await pausar.invoke({ leadId: Number(state.leadId), motivo: trava.motivo }));
          } catch (err) {
            resultadoPausa = `falhou: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        // Só troca a resposta se a pausa pegou: dizer "alguém da equipe continua" com a IA ainda ligada (unidade sem o
        // campo de pausa, pausar_ia desligada) seria prometer o que não aconteceu.
        const pausou = !!resultadoPausa && resultadoPausa.startsWith('OK');
        await recorder.step({
          kind: pausou ? 'THINKING' : 'ERROR',
          title: pausou
            ? `🔁 ${trava.motivo} e a IA não transferiu — passada para a equipe pelo código`
            : `🔁 ${trava.motivo} e a IA não transferiu; a pausa pelo código não pegou — saiu a resposta do modelo`,
          payload: { original: textoFinal, frase: trava.frase, pausa: resultadoPausa },
        });
        if (pausou) {
          textoFinal = trava.frase;
          response.content = textoFinal;
        }
      } else if (trava?.acao === 'refazer_sem_nome' && !respondeuPlanoB) {
        const t1 = performance.now();
        let textoRefeito = '';
        try {
          const refeita = (await withTimeout(
            invokeChatModel({
              model: modeloAtivo,
              messages: [...finalMessages, response, new HumanMessage(INSTRUCAO_REFAZER_SEM_NOME)],
              unitId: unit.id,
              traceId: recorder.traceId,
              modelName,
              provider: provedorAtivo,
              tools,
              conversaId: idDaConversa,
            }),
            AGENT_NODE_TIMEOUT_MS,
          )) as AIMessage;
          textoRefeito = (refeita.tool_calls ?? []).length === 0 ? aiTextFromContent(refeita.content).trim() : '';
        } catch (err) {
          logger.warn({ err: String(err), unit: unit.slug }, 'repetição: refeita sem o nome falhou — fica a original');
        }
        const serve = !!textoRefeito && !pedeNome(textoRefeito) && !detectarVazamento(textoRefeito) && !(await reabreAfirmacao(textoRefeito));
        if (serve) {
          textoFinal = textoRefeito;
          response.content = textoRefeito;
        }
        await recorder.step({
          kind: 'THINKING',
          title: serve
            ? `🔁 Pediu o nome pela ${repeticao.pedidosDeNome + 1}ª vez — refeita sem o pedido`
            : `🔁 Pediu o nome pela ${repeticao.pedidosDeNome + 1}ª vez; a refeita não serviu — saiu a original`,
          payload: { refeita: textoRefeito || null, final: textoFinal },
          latencyMs: Math.round(performance.now() - t1),
        });
      }

      // Ele agradeceu, se despediu ou disse que vai se organizar (paciente-encerrou.ts): a resposta não empurra horário.
      // Quem retoma é a régua. Corte em código, sem modelo — sobra a parte calorosa, ou a despedida curta.
      if (encerrou && empurraHorario(textoFinal, agoraDaUnidade)) {
        const semEmpurrao = semEmpurrarHorario(textoFinal, agoraDaUnidade, encerrou);
        await recorder.step({
          kind: 'THINKING',
          title: `🤝 Paciente ${encerrou === 'agradeceu' ? 'agradeceu/se despediu' : encerrou === 'concordou' ? 'só concordou depois da despedida' : 'disse que vai se organizar'} e a resposta empurrava horário — o empurrão saiu`,
          payload: { original: textoFinal, final: semEmpurrao },
        });
        textoFinal = semEmpurrao;
        response.content = semEmpurrao;
      }

      // Diminutivo sai aqui, no ÚNICO ponto onde a resposta ao paciente é finalizada — antes de
      // qualquer caminho de entrega (chat com botões, Salesbot legado, MODO WIDGET). Ficava nos
      // serviços de entrega e era errado por dois motivos: o modo widget escapava, e o
      // sanitizador do cliente Kommo também escreve CAMPO, NOTA e TAREFA — ou seja, uma
      // observação do paciente ("sente uma dorzinha ao levantar") era reescrita no cartão,
      // mudando o que ele disse. Aqui só passa mensagem que vai para o paciente.
      // Nome de profissional que não veio da agenda AGORA sai da resposta (ver nome-na-resposta.ts).
      // Antes das travas de tom, para elas continuarem envolvendo textoFinal no guardrail.
      const comNomeChecado = semNomeForaDaAgenda(textoFinal, promptDoTurno, nonSystemMessages);
      if (comNomeChecado.removidos.length > 0) {
        await recorder.step({
          kind: 'THINKING',
          title: `🪪 Nome de profissional que não veio da agenda agora saiu da resposta (${comNomeChecado.removidos.join(', ')})`,
          payload: { original: textoFinal, reescrito: comNomeChecado.texto, removidos: comNomeChecado.removidos },
        });
        textoFinal = comNomeChecado.texto;
        response.content = textoFinal;
      }
      // Nome do PACIENTE que não apareceu em lugar nenhum do turno sai do vocativo (ver vocativo-inventado.ts).
      const semNomeInventado = semVocativoInventado(textoFinal, promptDoTurno, nonSystemMessages);
      if (semNomeInventado.removidos.length > 0) {
        await recorder.step({
          kind: 'THINKING',
          title: `🪪 Nome do paciente que não apareceu na conversa saiu da resposta (${semNomeInventado.removidos.join(', ')})`,
          payload: { original: textoFinal, reescrito: semNomeInventado.texto, removidos: semNomeInventado.removidos },
        });
        textoFinal = semNomeInventado.texto;
        response.content = textoFinal;
      }
      // "Dra. Sofia" → "Sofia" nas clínicas Doutor Hérnia (decisão do João, 21/10) — ver rede-doutor-hernia.ts.
      // A rede (cache de 10 min) reconhece o slug de resgate que divide o Kommo de uma clínica DH.
      const rede = await carregarRede().catch(() => [] as UnidadeDaRede[]);
      const semDra = semDraSofiaNaDH(textoFinal, unit, rede);
      if (semDra !== textoFinal) {
        textoFinal = semDra;
        response.content = textoFinal;
      }
      // Turno de aviso urgente: se o corte do pronto-socorro levar a resposta inteira, sai a frase do passe (não a de reserva).
      const guardBruto = aplicarGuardrail(semIntimidade(semDiminutivo(textoFinal)), unit, {
        ...extrasDoGuardrail,
        mensagensDoPaciente,
        fraseDeReserva: passouPorSinal ? fraseDoPasse(retornoDaEquipe(unit), pacienteFalouDePs(mensagensDoPaciente)) : undefined,
        // Marcou, remarcou, cancelou ou confirmou presença neste turno: a resposta é a única que o paciente recebe com o dia e a hora; o guardrail não a troca pela frase do passe.
        consultaMarcada: passouPorSinal && (marcouAgora || confirmouConsultaNoTurno(doTurno)),
      });
      // O que o guardrail devolve (correção ou texto de reserva) passa pela mesma trava do nome.
      const guard = { ...guardBruto, text: semDraSofiaNaDH(guardBruto.text, unit, rede) };
      if (guard.rewritten) {
        const ultimaIA = [...nonSystemMessages].reverse().find((m) => m.getType() === 'ai');
        const textoUltima = ultimaIA ? aiTextFromContent(ultimaIA.content) : '';
        const repetindo = normalizarResposta(textoUltima) === normalizarResposta(guard.text);

        if (repetindo) {
          await recorder.step({
            kind: 'ERROR',
            title: `🔁 Guardrail em LOOP (${guard.triggered.join(', ')}) — repetiria a mesma resposta; escalando`,
            payload: { original: textoFinal, reescrito: guard.text, motivos: guard.triggered },
          });
          response.content = FALLBACK_LOOP_GUARDRAIL;
        } else {
          response.content = guard.text;
          await recorder.step({
            kind: 'THINKING',
            title: `🛡️ Guardrail reescreveu a resposta (${guard.triggered.join(', ')})`,
            payload: { original: textoFinal, reescrito: guard.text, motivos: guard.triggered },
          });
        }
      }

      if (kommoClient && unit.collectNameEnabled && userMessage && state.leadId) {
        const lastAssistant = [...nonSystemMessages].reverse().find((m) => m.getType() === 'ai');
        const lastAssistantText = lastAssistant
          ? typeof lastAssistant.content === 'string'
            ? lastAssistant.content
            : JSON.stringify(lastAssistant.content)
          : null;
        const detected = detectNameDisclosure(userMessage, {
          nameWasAsked: askedForName(lastAssistantText),
        });
        if (detected) {
          await maybeAutoUpdateLeadTitle({
            recorder,
            kommo: kommoClient,
            leadId: state.leadId,
            name: detected,
            tz: fusoDaUnidade(unit),
          });
        }
      }

      return { messages: [response], decision: guard.text } satisfies Partial<AgentStateType>;
    }

    return { messages: [response] } satisfies Partial<AgentStateType>;
  };

  const toolNode = new ToolNode(tools);

  const shouldContinue = (state: AgentStateType): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    if (last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
      return 'tools';
    }
    return END;
  };

  const workflow = new StateGraph(AgentState)
    .addNode('agent', agentNode, { retryPolicy: { maxAttempts: 2 } })
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'agent');

  const checkpointer = await getCheckpointer();
  const compiled = workflow.compile({ checkpointer });

  return compiled;
}

async function maybeAutoUpdateLeadTitle({
  recorder,
  kommo,
  leadId,
  name,
  tz,
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
  name: string;
  tz: string;
}): Promise<void> {
  const t0 = performance.now();
  if (!looksLikeName(name)) {
    await recorder.step({
      kind: 'THINKING',
      title: `[safety-net] "${name}" não parece nome — captura descartada`,
      payload: { leadId, rejeitado: name },
      latencyMs: Math.round(performance.now() - t0),
    });
    return;
  }
  const display = titleCaseName(name);
  try {
    const lead = await kommo.getLead(leadId);
    const current = (lead.name ?? '').trim();
    // "Lead #123" do Kommo e o nosso provisório "Lead 23/09/2026" são placeholders: o nome capturado vence
    const looksGeneric =
      ehSemNome(current) ||
      ehTituloPadrao(current) ||
      current.toLowerCase().includes(display.toLowerCase());
    if (!looksGeneric) {
      await recorder.step({
        kind: 'KOMMO_ACTION',
        title: `[safety-net] título do lead já está como "${current}" — não sobrescreve`,
        payload: { leadId, current, detected: display },
        latencyMs: Math.round(performance.now() - t0),
      });
      return;
    }
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateBR = new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs));
    const desired = `${display} ${dateBR}`;
    await kommo.updateLeadName(leadId, desired);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `[safety-net] IA esqueceu de chamar atualizar_titulo_lead — corrigido: "${current}" → "${desired}"`,
      payload: { leadId, previous: current, desired, name: display, dateBR },
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `[safety-net] falha ao atualizar título automaticamente: ${msg}`,
      payload: { leadId, name: display, error: msg },
      latencyMs: Math.round(performance.now() - t0),
    });
  }
}

const ENTRY_DATE_TAG_SLUGS = new Set(['advocacia-magalhaes']);

async function maybeAddEntryDateTag({
  recorder,
  kommo,
  leadId,
  tz,
}: {
  recorder: TraceRecorder;
  kommo: ReturnType<typeof createKommoClient>;
  leadId: number;
  tz: string;
}): Promise<void> {
  const t0 = performance.now();
  try {
    const lead = await kommo.getLead(leadId);
    const createdAtMs = (lead.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
    const dateTag = new Intl.DateTimeFormat('pt-BR', {
      timeZone: tz,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(createdAtMs));
    await kommo.addTag({ leadId, tag: dateTag });
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `tag de data de entrada aplicada: "${dateTag}"`,
      payload: { leadId, dateTag },
      latencyMs: Math.round(performance.now() - t0),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recorder.step({
      kind: 'ERROR',
      title: `falha ao aplicar tag de data de entrada: ${msg}`,
      payload: { leadId, error: msg },
      latencyMs: Math.round(performance.now() - t0),
    });
  }
}
