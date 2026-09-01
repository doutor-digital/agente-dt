import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';

import { getActiveConfig } from '../agent/config.js';
import { aplicarGuardrail } from '../agent/guardrail.js';
import { composeSystemPromptForUnit, composeSystemPromptPartsForUnit } from '../agent/prompt-composer.js';
import { buildTools } from '../agent/tools.js';
import type { TraceRecorder } from '../agent/trace-recorder.js';
import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { listEnabledLeadFieldRules } from '../services/lead-field-rules.service.js';
import { createChatModel } from '../services/openai.service.js';
import type { Caso } from './banco.js';
import { conferir, type Falha, type FerramentaChamada, type OutraUnidade } from './checks.js';

/**
 * Roda um caso do banco dourado contra a IA de verdade.
 *
 * "De verdade" quer dizer: a unidade sai do banco, o prompt é montado pelo mesmo
 * compositor da produção (com persona, fontes, lições e ações da unidade), o
 * modelo é o que aquela cidade usa, e a resposta passa pelo mesmo guardrail. Se
 * fosse um prompt de mentira, o banco aprovaria mudanças que quebram o real.
 *
 * O que NÃO acontece: nenhuma ferramenta é executada. O modelo recebe os
 * esquemas para poder escolher `consultar_horarios`, e a escolha é registrada —
 * mas nada é escrito no Kommo nem na franquia. O cliente do Kommo entregue ao
 * construtor é um boneco que estoura se alguém tentar usá-lo, para o dia em que
 * essa garantia deixar de valer não passar em silêncio.
 *
 * Também não usa `invokeChatModel`: aquele caminho grava custo por unidade, e
 * uma bateria de testes não pode entrar na conta de nenhuma clínica.
 */

export interface ResultadoDoCaso {
  caso: string;
  titulo: string;
  unidade: string;
  passou: boolean;
  falhas: Falha[];
  texto: string;
  ferramentas: string[];
  /** O guardrail agiu? Já é sinal de erro, mesmo quando as conferências passam. */
  guardrailAgiu: boolean;
  ms: number;
  erro?: string;
}

const recorderSilencioso = {
  traceId: 'eval',
  unitId: null,
  step: async () => {},
} as unknown as TraceRecorder;

/** Boneco: qualquer método devolve uma função que estoura ao ser chamada. */
const kommoDeMentira = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('eval: nenhuma ferramenta pode ser executada durante o banco dourado');
    },
  },
) as never;

function textoDaResposta(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
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

/**
 * Marcadores que identificam cada unidade: PIX, titular e o começo do endereço.
 *
 * Um marcador que aparece em duas unidades é descartado. Duas clínicas podem
 * dividir o mesmo CNPJ ou a mesma rua, e acusar a IA de "usou dado de outra
 * cidade" quando o dado é das duas seria uma reprovação impossível de corrigir.
 */
export function marcadoresPorUnidade(units: Unit[]): OutraUnidade[] {
  const vezes = new Map<string, number>();
  const porUnidade = new Map<string, string[]>();

  for (const u of units) {
    const brutos = [
      u.pixKey,
      u.pixHolder,
      (u.clinicAddress ?? '').split(/[,—–]/)[0],
    ];
    const limpos = brutos
      .map((s) => (s ?? '').trim())
      .filter((s) => s.length >= 8);
    porUnidade.set(u.slug, limpos);
    for (const m of new Set(limpos)) vezes.set(m, (vezes.get(m) ?? 0) + 1);
  }

  return [...porUnidade].map(([slug, marcadores]) => ({
    slug,
    marcadores: marcadores.filter((m) => (vezes.get(m) ?? 0) === 1),
  }));
}

export async function rodarCaso(
  caso: Caso,
  ctx: { outrasUnidades: OutraUnidade[]; promptDaUnidade?: boolean },
): Promise<ResultadoDoCaso> {
  const t0 = performance.now();
  const base = {
    caso: caso.id,
    titulo: caso.titulo,
    unidade: caso.unidade,
    texto: '',
    ferramentas: [] as string[],
    guardrailAgiu: false,
  };

  const unit = await prisma.unit.findUnique({ where: { slug: caso.unidade } });
  if (!unit) {
    return {
      ...base,
      passou: false,
      falhas: [{ regra: 'unidade_inexistente', detalhe: `slug "${caso.unidade}" não existe` }],
      ms: performance.now() - t0,
    };
  }

  try {
    const config = await getActiveConfig(unit.id);

    const usaAnthropic = unit.llmProvider === 'anthropic' && !!unit.anthropicApiKey;
    const usaGoogle = unit.llmProvider === 'google' && !!unit.googleApiKey;
    const nomeDoModelo = usaAnthropic
      ? unit.anthropicModel || 'claude-opus-4-8'
      : usaGoogle
        ? unit.googleModel || 'gemini-2.5-flash'
        : config.model || unit.openaiModel || env.OPENAI_MODEL;

    const ultimaDoPaciente = [...caso.historico].reverse().find((t) => t.de === 'paciente')?.texto;
    const primeiroTurno =
      caso.historico.filter((t) => t.de === 'paciente').length === 1 &&
      caso.historico.every((t) => t.de === 'paciente');

    // `promptDaUnidade` desliga o prompt do AgentConfig para o compositor cair
    // no `unit.systemPrompt` — o playbook que a unidade tem escrito. Serve para
    // medir, antes de mexer em produção, o que muda quando aquele texto chega
    // ao modelo. Sem esse interruptor, a comparação seria opinião.
    const entrada = {
      unit,
      agentConfigPrompt: ctx.promptDaUnidade ? '' : config.systemPrompt,
      userMessage: ultimaDoPaciente,
      isFirstTurn: primeiroTurno,
    };

    let system: SystemMessage;
    if (usaAnthropic) {
      const { cacheable, dynamic } = await composeSystemPromptPartsForUnit(entrada);
      system = new SystemMessage([cacheable, dynamic].filter(Boolean).join('\n\n'));
    } else {
      system = new SystemMessage(await composeSystemPromptForUnit(entrada));
    }

    const configPorNome = new Map(config.tools.map((t) => [t.name, t]));
    const descricoes: Record<string, string> = {};
    for (const [nome, cfg] of configPorNome) if (cfg.description) descricoes[nome] = cfg.description;

    const todas = buildTools({
      recorder: recorderSilencioso,
      kommo: kommoDeMentira,
      descriptionOverrides: descricoes,
      pausedFieldId: unit.kommoPausedFieldId,
      leadFieldRules: await listEnabledLeadFieldRules(unit.id),
      unit,
    });
    const tools = todas.filter((t) => configPorNome.get(t.name)?.enabled ?? true);

    const mensagens: BaseMessage[] = [
      system,
      ...caso.historico.map((t) =>
        t.de === 'paciente' ? new HumanMessage(t.texto) : new AIMessage(t.texto),
      ),
    ];

    const modelo = createChatModel(unit, {
      model: nomeDoModelo,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    const comTools =
      tools.length > 0
        ? (modelo as unknown as { bindTools: (t: unknown[]) => { invoke: (m: BaseMessage[]) => Promise<AIMessage> } }).bindTools(tools)
        : (modelo as unknown as { invoke: (m: BaseMessage[]) => Promise<AIMessage> });

    const resposta = await comTools.invoke(mensagens);

    const bruto = textoDaResposta(resposta.content);
    const g = aplicarGuardrail(bruto, unit);
    const ferramentas: FerramentaChamada[] = (resposta.tool_calls ?? []).map((c) => ({
      nome: c.name,
      args: (c.args ?? {}) as Record<string, unknown>,
    }));

    const falhas = conferir(
      { texto: g.text, ferramentas },
      caso.espera,
      { unit, outrasUnidades: ctx.outrasUnidades },
    );

    return {
      ...base,
      texto: g.text,
      ferramentas: ferramentas.map((f) => f.nome),
      guardrailAgiu: g.rewritten,
      passou: falhas.length === 0,
      falhas,
      ms: performance.now() - t0,
    };
  } catch (err) {
    return {
      ...base,
      passou: false,
      falhas: [{ regra: 'erro_ao_rodar', detalhe: err instanceof Error ? err.message : String(err) }],
      ms: performance.now() - t0,
      erro: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Roda os casos e devolve o resultado de cada rodada.
 *
 * `repeticoes` existe porque o modelo não é determinístico: uma passada só diz
 * pouco. Três passadas em que uma reprova é um caso instável, e caso instável em
 * produção é paciente atendido de um jeito hoje e de outro amanhã.
 *
 * Os casos rodam em série de propósito. Em paralelo, uma bateria de 14 casos
 * bate no limite de requisições do provedor e o relatório vira uma lista de 429
 * que ninguém sabe interpretar.
 */
export async function rodarBanco(
  casos: Caso[],
  opts: { repeticoes?: number; promptDaUnidade?: boolean; aoTerminar?: (r: ResultadoDoCaso) => void } = {},
): Promise<ResultadoDoCaso[]> {
  const repeticoes = Math.max(1, opts.repeticoes ?? 1);
  const units = await prisma.unit.findMany();
  const outrasUnidades = marcadoresPorUnidade(units);

  const resultados: ResultadoDoCaso[] = [];
  for (let volta = 1; volta <= repeticoes; volta++) {
    for (const caso of casos) {
      const r = await rodarCaso(caso, { outrasUnidades, promptDaUnidade: opts.promptDaUnidade });
      resultados.push(r);
      opts.aoTerminar?.(r);
    }
  }
  return resultados;
}
