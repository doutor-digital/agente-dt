/**
 * REVISORA DE SAÍDA da Sofia — a parte com banco e rede (as regras e o prompt moram em `lib/revisora-de-saida.ts`).
 *
 * MODO SECO, e só ele: roda DEPOIS que a resposta foi entregue (chamada pelo `processAgent`, sem `await`), nunca bloqueia, nunca altera
 * o que o paciente recebeu, e grava UMA linha em `revisoes_de_saida` por revisão — aprovada, "barraria" ou sem veredito. Erro, prazo
 * estourado e JSON fora do formato viram `sem_veredito` + `erro`; nada disso volta para o paciente.
 *
 * Estabilidade (Nygard): prazo curto (8 s) sem retentativa; no máximo `MAX_EM_VOO` revisões ao mesmo tempo (acima disso a revisão é
 * PULADA, não enfileirada — fila crescendo é como um auxiliar derruba o principal); e um disjuntor que, depois de
 * `FALHAS_PARA_ABRIR` erros seguidos do provedor, para de chamar por `PAUSA_DO_DISJUNTOR_MS` em vez de pagar timeout em cada resposta.
 */
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Prisma } from '@prisma/client';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { estadoDaAutomacao, type Estado } from '../lib/automacoes-estado.js';
import { registrarSimulacao } from '../lib/so-no-papel.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { custoComFallback, esforcoDoJuiz, montarPedidoAnthropic, respostaCortada, textoDaResposta } from '../lib/juiz-da-ia.js';
import {
  consolidar,
  cumprimentoForaDeHora,
  dadosDaRevisao,
  decidirPeloEstado,
  escolherRevisora,
  falasParaARevisora,
  ferramentasDoTurnoComResultado,
  horaLocalDaUnidade,
  lerVeredito,
  MAX_FALAS,
  MAX_TOKENS_DA_REVISORA,
  PRAZO_DA_REVISORA_MS,
  promptDaRevisora,
  SCHEMA_DA_REVISORA,
  type Consolidado,
  type EntradaDaRevisora,
  type EscolhaDaRevisora,
  type MensagemDoBanco,
  type PrecosParaRevisora,
  type StatusDoPaciente,
  type VereditoLido,
} from '../lib/revisora-de-saida.js';
import { pegarStatusDoTurno } from '../lib/revisora-de-saida-contexto.js';
import { precosDaConsulta, sinalDaUnidade } from '../agent/prompt-composer.js';
import { sinalDeclaradoNaFicha } from '../agent/guardrail.js';
import { calculateCost, recordLlmCall, resolveOpenAIApiKey } from './openai.service.js';

/** `id` no catálogo (`lib/automacoes.ts`) e na tabela `unit_automacoes`. Nunca mude depois de criada. */
export const AUTOMACAO_REVISORA_DE_SAIDA = 'revisora-de-saida';

export function estadoDaRevisora(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_REVISORA_DE_SAIDA, env.REVISORA_SAIDA_SLUGS);
}

// ── limites: o auxiliar nunca derruba o principal ─────────────────────────────────────────────────

export const MAX_EM_VOO = 25;
export const FALHAS_PARA_ABRIR = 5;
export const PAUSA_DO_DISJUNTOR_MS = 60_000;

export class LimiteDaRevisora {
  private emVoo = 0;
  private falhasSeguidas = 0;
  private abertoAte = 0;
  private puladas = 0;

  constructor(
    private readonly maxEmVoo = MAX_EM_VOO,
    private readonly falhasParaAbrir = FALHAS_PARA_ABRIR,
    private readonly pausaMs = PAUSA_DO_DISJUNTOR_MS,
  ) {}

  /** Pode começar mais uma revisão? Se sim, ocupa a vaga (quem pediu TEM de chamar `terminou`). */
  pedir(agoraMs: number = Date.now()): { ok: true } | { ok: false; motivo: 'disjuntor_aberto' | 'muitas_em_voo' } {
    if (agoraMs < this.abertoAte) {
      this.puladas++;
      return { ok: false, motivo: 'disjuntor_aberto' };
    }
    if (this.emVoo >= this.maxEmVoo) {
      this.puladas++;
      return { ok: false, motivo: 'muitas_em_voo' };
    }
    this.emVoo++;
    return { ok: true };
  }

  /** `falhouOProvedor`: erro/prazo da chamada ao modelo. JSON fora do formato NÃO conta (o provedor respondeu). */
  terminou(falhouOProvedor: boolean, agoraMs: number = Date.now()): { abriu: boolean } {
    this.emVoo = Math.max(0, this.emVoo - 1);
    if (!falhouOProvedor) {
      this.falhasSeguidas = 0;
      return { abriu: false };
    }
    this.falhasSeguidas++;
    if (this.falhasSeguidas >= this.falhasParaAbrir) {
      this.falhasSeguidas = 0;
      this.abertoAte = agoraMs + this.pausaMs;
      return { abriu: true };
    }
    return { abriu: false };
  }

  get emVooAgora(): number {
    return this.emVoo;
  }
  /** Quantas revisões foram puladas desde o boot (vai para o log, para o pulo não ser invisível). */
  get puladasTotal(): number {
    return this.puladas;
  }
}

const limite = new LimiteDaRevisora();

// ── pontos de contato com o mundo (trocáveis nos testes) ──────────────────────────────────────────

export interface RespostaDaRevisora {
  text: string;
  promptTokens: number;
  completionTokens: number;
  stopReason?: string | null;
  raw: unknown;
}

export interface DependenciasDaRevisora {
  /** Mensagens da conversa, da mais nova para a mais antiga. */
  carregarMensagens(conversationId: string, quantas: number): Promise<MensagemDoBanco[]>;
  chamarModelo(escolha: EscolhaDaRevisora, system: string, user: string, unit: Unit, prazoMs: number): Promise<RespostaDaRevisora>;
  gravar(data: Prisma.RevisaoDeSaidaUncheckedCreateInput): Promise<void>;
  registrarChamada(p: Parameters<typeof recordLlmCall>[0]): void;
  registrarNoPapel(unit: Pick<Unit, 'id' | 'slug'>, leadId: number, c: Consolidado): void;
  agora(): Date;
}

/** Cancela a chamada pelo AbortSignal E por um relógio próprio (um provedor que ignora o sinal não pode segurar a revisão). */
async function comPrazo<T>(ms: number, chamada: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const estouro = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      ac.abort();
      rej(new Error(`revisora: sem resposta em ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([chamada(ac.signal), estouro]);
  } finally {
    clearTimeout(timer);
  }
}

async function chamarAnthropic(escolha: EscolhaDaRevisora, system: string, user: string, prazoMs: number): Promise<RespostaDaRevisora> {
  const pedido = montarPedidoAnthropic({
    modelo: escolha.modelo,
    system,
    user,
    esforco: esforcoDoJuiz({ JUDGE_ANTHROPIC_EFFORT: process.env.REVISORA_ANTHROPIC_EFFORT ?? 'low' }),
    schema: SCHEMA_DA_REVISORA,
    maxTokens: MAX_TOKENS_DA_REVISORA,
  });
  const modelo = new ChatAnthropic({
    apiKey: escolha.apiKeyAnthropic ?? '',
    model: pedido.model,
    maxTokens: pedido.max_tokens,
    maxRetries: 0,
    clientOptions: { timeout: prazoMs },
    thinking: pedido.thinking,
    outputConfig: pedido.output_config,
  });
  const msg = await comPrazo(prazoMs, (signal) => modelo.invoke([new SystemMessage(pedido.system), new HumanMessage(pedido.messages[0].content)], { signal }));
  const uso = (msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
  const meta = (msg as { response_metadata?: { stop_reason?: string | null } }).response_metadata;
  return {
    text: textoDaResposta(msg.content),
    promptTokens: uso?.input_tokens ?? 0,
    completionTokens: uso?.output_tokens ?? 0,
    stopReason: meta?.stop_reason ?? null,
    raw: { content: msg.content, usage: uso, stop_reason: meta?.stop_reason ?? null },
  };
}

async function chamarOpenAI(escolha: EscolhaDaRevisora, system: string, user: string, unit: Unit, prazoMs: number): Promise<RespostaDaRevisora> {
  const modelo = new ChatOpenAI({
    apiKey: resolveOpenAIApiKey(unit),
    model: escolha.modelo,
    temperature: 0,
    maxTokens: MAX_TOKENS_DA_REVISORA,
    timeout: prazoMs,
    maxRetries: 0,
    modelKwargs: { response_format: { type: 'json_schema', json_schema: { name: 'revisora_de_saida', strict: true, schema: SCHEMA_DA_REVISORA } } },
  });
  const capturado: { usage: { promptTokens?: number; completionTokens?: number } | null; resposta: unknown } = { usage: null, resposta: null };
  const msg = await comPrazo(prazoMs, (signal) =>
    modelo.invoke([new SystemMessage(system), new HumanMessage(user)], {
      signal,
      callbacks: [
        {
          handleLLMEnd: (output: { llmOutput?: { tokenUsage?: { promptTokens?: number; completionTokens?: number } } }) => {
            capturado.usage = output.llmOutput?.tokenUsage ?? null;
            capturado.resposta = output;
          },
        },
      ],
    }),
  );
  const finish = (msg as { response_metadata?: { finish_reason?: string } }).response_metadata?.finish_reason;
  return {
    text: textoDaResposta(msg.content),
    promptTokens: capturado.usage?.promptTokens ?? 0,
    completionTokens: capturado.usage?.completionTokens ?? 0,
    // o equivalente do `max_tokens`/`refusal` da Anthropic, no vocabulário da OpenAI
    stopReason: finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : (finish ?? null),
    raw: capturado.resposta,
  };
}

export const dependenciasPadrao: DependenciasDaRevisora = {
  async carregarMensagens(conversationId, quantas) {
    return prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: quantas,
      select: { role: true, content: true, meta: true, createdAt: true },
    });
  },
  chamarModelo: (escolha, system, user, unit, prazoMs) =>
    escolha.provedor === 'anthropic' ? chamarAnthropic(escolha, system, user, prazoMs) : chamarOpenAI(escolha, system, user, unit, prazoMs),
  async gravar(data) {
    await prisma.revisaoDeSaida.create({ data });
  },
  registrarChamada: (p) => void recordLlmCall(p),
  registrarNoPapel(unit, leadId, c) {
    // A tela de Automações («Só no papel») lista "alertaria" por cartão; a verdade para SQL é `revisoes_de_saida`.
    for (const v of c.violacoes) {
      registrarSimulacao(unit, AUTOMACAO_REVISORA_DE_SAIDA, { leadId, acao: 'alertaria', alvo: v.regra, valor: v.trecho, motivo: v.motivo });
    }
  },
  agora: () => new Date(),
};

// ── a entrada, montada do que o turno tem ─────────────────────────────────────────────────────────

export interface PedidoDeRevisao {
  unit: Unit;
  leadId: number;
  traceId: string;
  conversationId: string;
  /** O texto que o paciente RECEBEU (já sem a linha de botões). */
  textoEnviado: string;
  /** `result.messages` do grafo: de lá saem as ferramentas do turno. */
  mensagensDoGrafo: ReadonlyArray<unknown>;
  /** O que o grafo guardou do prompt do turno (status do paciente); `null` = não guardou. */
  status: StatusDoPaciente | null;
}

/** A tabela de preços e o sinal como a Sofia e o guardrail os enxergam (mesmas funções — a revisora não inventa uma segunda verdade). */
export function precosDaUnidade(unit: Unit): PrecosParaRevisora | null {
  const p = precosDaConsulta(unit);
  if (!p) return null;
  const doFlag = sinalDaUnidade(unit);
  const sinal = doFlag ? { sinal: doFlag.sinal, restoNoDia: doFlag.restoNoDia } : sinalDeclaradoNaFicha(unit, p.antecipado);
  return { noDia: p.noDia, antecipado: p.antecipado, sinal: sinal?.sinal ?? null, restoNoDia: sinal?.restoNoDia ?? null };
}

export async function montarEntrada(pedido: PedidoDeRevisao, deps: DependenciasDaRevisora): Promise<EntradaDaRevisora> {
  const { unit } = pedido;
  const agora = deps.agora();
  let falas: ReturnType<typeof falasParaARevisora> = { falas: [], inicioVisivel: false };
  try {
    // uma a mais que o necessário: a resposta que acabou de ser gravada ocupa uma vaga e sai
    const rows = await deps.carregarMensagens(pedido.conversationId, MAX_FALAS + 2);
    falas = falasParaARevisora(rows, pedido.textoEnviado, agora, MAX_FALAS);
  } catch (err) {
    logger.warn({ err: String(err), traceId: pedido.traceId }, 'revisora de saída: não consegui ler as falas — segue sem elas');
  }
  return {
    nomeDaUnidade: unit.name,
    textoEnviado: pedido.textoEnviado,
    hora: horaLocalDaUnidade(agora, fusoDaUnidade(unit)),
    ferramentas: ferramentasDoTurnoComResultado(pedido.mensagensDoGrafo),
    falas: falas.falas,
    inicioVisivel: falas.inicioVisivel,
    precos: precosDaUnidade(unit),
    trechoDaFicha: unit.sourceProdutos ?? null,
    endereco: unit.clinicAddress ?? null,
    chavePix: unit.pixKey ?? null,
    status: pedido.status,
  };
}

// ── a revisão ─────────────────────────────────────────────────────────────────────────────────────

export interface DesfechoDaRevisao {
  veredito: Consolidado['veredito'];
  violacoes: Consolidado['violacoes'];
  erro: string | null;
  /** O erro foi do provedor (chamada/prazo), não do formato — é o que alimenta o disjuntor. */
  falhouOProvedor: boolean;
}

/**
 * Revisa UMA resposta e grava a linha. Nunca lança: o chamador não tem o que tratar. Devolve o desfecho para o teste e para o disjuntor.
 */
export async function revisarSaida(pedido: PedidoDeRevisao, deps: DependenciasDaRevisora = dependenciasPadrao): Promise<DesfechoDaRevisao> {
  const { unit } = pedido;
  const escolha = escolherRevisora(process.env, unit);
  const t0 = performance.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let erro: string | null = null;
  let falhouOProvedor = false;
  let lido: VereditoLido | null = null;
  let entrada: EntradaDaRevisora | null = null;

  try {
    entrada = await montarEntrada(pedido, deps);
    const resposta = await deps.chamarModelo(escolha, promptDaRevisora(), dadosDaRevisao(entrada), unit, PRAZO_DA_REVISORA_MS);
    promptTokens = resposta.promptTokens;
    completionTokens = resposta.completionTokens;
    // leitura ESTRITA: resposta cortada/recusada ou JSON fora do formato = sem veredito, nunca "barraria"
    lido = respostaCortada(resposta.stopReason) ? null : lerVeredito(resposta.text);
    if (!lido) {
      erro = respostaCortada(resposta.stopReason) ? `resposta_cortada:${String(resposta.stopReason)}` : 'resposta_invalida';
      logger.warn({ traceId: pedido.traceId, modelo: escolha.modelo, stopReason: resposta.stopReason ?? null, inicio: resposta.text.slice(0, 160) }, 'revisora de saída: resposta fora do formato — sem veredito');
    }
  } catch (err) {
    falhouOProvedor = true;
    erro = err instanceof Error ? err.message : String(err);
    logger.warn({ err: erro, traceId: pedido.traceId, modelo: escolha.modelo }, 'revisora de saída: a chamada ao modelo falhou — sem veredito');
  }

  const latencyMs = Math.round(performance.now() - t0);
  // A regra 8 é aritmética sobre a hora local: roda mesmo quando o modelo falhou.
  const doCodigo = entrada ? [cumprimentoForaDeHora(pedido.textoEnviado, entrada.hora)].filter((v): v is NonNullable<typeof v> => !!v) : [];
  const final = consolidar(lido, doCodigo);

  const costUsd = custoComFallback(escolha.modelo, calculateCost(escolha.modelo, promptTokens, completionTokens), promptTokens, completionTokens);
  if (promptTokens > 0 || erro) {
    deps.registrarChamada({
      unitId: unit.id,
      // SEM traceId, como o juiz: o gasto da revisora entra na soma da unidade/mês (é dinheiro de verdade), mas não no custo do turno
      // da Sofia nem no teto por conversa — um auxiliar de medição não pode fazer a IA parar. O elo com o turno está em
      // `revisoes_de_saida.trace_id`.
      traceId: null,
      provider: escolha.provedor,
      model: escolha.modelo,
      endpoint: 'chat.completions',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      latencyMs,
      status: erro ? 'error' : 'success',
      ...(erro ? { errorMessage: erro } : {}),
      // `revisora: true` separa este gasto do da Sofia em qualquer soma por llm_calls
      requestBody: { revisora: true, leadId: pedido.leadId, conversationId: pedido.conversationId, traceId: pedido.traceId },
    });
  }

  try {
    await deps.gravar({
      unitId: unit.id,
      leadId: String(pedido.leadId),
      traceId: pedido.traceId,
      conversationId: pedido.conversationId,
      modo: 'seco',
      veredito: final.veredito,
      regras: final.violacoes.map((v) => v.regra),
      violacoes: final.violacoes.length ? (final.violacoes as unknown as Prisma.InputJsonValue) : undefined,
      textoEnviado: pedido.textoEnviado.slice(0, 4000),
      provedor: escolha.provedor,
      modelo: escolha.modelo,
      promptTokens,
      completionTokens,
      costUsd: new Prisma.Decimal(costUsd),
      latencyMs,
      erro,
    });
  } catch (err) {
    logger.warn({ err: String(err), traceId: pedido.traceId }, 'revisora de saída: não consegui gravar a revisão (a resposta já tinha saído)');
  }

  if (final.veredito === 'barraria') {
    logger.info(
      { unit: unit.slug, leadId: pedido.leadId, traceId: pedido.traceId, regras: final.violacoes.map((v) => v.regra) },
      `🔎 revisora (seco): barraria — ${final.violacoes.map((v) => `${v.regra}: ${v.motivo}`).join(' | ')}`,
    );
    try {
      deps.registrarNoPapel(unit, pedido.leadId, final);
    } catch {
      /* a tela é melhor-esforço */
    }
  }

  return { veredito: final.veredito, violacoes: final.violacoes, erro, falhouOProvedor };
}

// ── a porta de entrada do processAgent ────────────────────────────────────────────────────────────

export interface ArgsDaPorta {
  unit: Unit;
  leadId: number;
  traceId: string;
  conversationId: string;
  textoEnviado: string;
  mensagensDoGrafo: ReadonlyArray<unknown>;
}

/**
 * Chamada UMA vez por resposta entregue. Síncrona e barata: confere o estado da automação, pega uma vaga e solta a revisão para rodar em
 * segundo plano — o `processAgent` não espera e não recebe nada de volta. Qualquer coisa que dê errado aqui morre aqui.
 */
export function agendarRevisaoDeSaida(args: ArgsDaPorta, deps: DependenciasDaRevisora = dependenciasPadrao): void {
  try {
    // consome mesmo quando não vai revisar: a marca não pode ficar esperando o TTL
    const status = pegarStatusDoTurno(args.traceId);
    const decisao = decidirPeloEstado(estadoDaRevisora(args.unit.slug));
    if (!decisao.revisar || !args.textoEnviado.trim()) return;
    if (decisao.aviso) logger.warn({ unit: args.unit.slug }, decisao.aviso);

    const vaga = limite.pedir();
    if (!vaga.ok) {
      const puladas = limite.puladasTotal;
      if (puladas % 50 === 1) logger.warn({ motivo: vaga.motivo, emVoo: limite.emVooAgora }, 'revisora de saída: revisão pulada (o auxiliar não pode atrapalhar o principal)');
      return;
    }
    void revisarSaida({ ...args, status }, deps)
      .then((d) => {
        const { abriu } = limite.terminou(d.falhouOProvedor);
        if (abriu) logger.error({ pausaMs: PAUSA_DO_DISJUNTOR_MS }, 'revisora de saída: disjuntor ABERTO — erros seguidos do provedor, sem chamar por um tempo');
      })
      .catch((err) => {
        limite.terminou(true);
        logger.warn({ err: String(err) }, 'revisora de saída: falhou fora do previsto');
      });
  } catch (err) {
    logger.warn({ err: String(err), traceId: args.traceId }, 'revisora de saída: não consegui agendar');
  }
}
