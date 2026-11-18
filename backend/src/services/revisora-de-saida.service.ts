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
import { registrarSimulacao } from '../lib/so-no-papel.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { custoComFallback, montarPedidoAnthropic, respostaCortada, textoDaResposta } from '../lib/juiz-da-ia.js';
import {
  consolidar,
  cumprimentoForaDeHora,
  dadosDaRevisao,
  decidirPeloEstado,
  escolherRevisora,
  categoriaRevisavel,
  falasParaARevisora,
  ferramentasDoTurnoComResultado,
  horaLocalDaUnidade,
  lerVeredito,
  LINHAS_A_LER,
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
import { AUTOMACAO_REVISORA_DE_SAIDA, estadoDaRevisora, pegarStatusDoTurno } from '../lib/revisora-de-saida-contexto.js';
import { precosDaConsulta, sinalDaUnidade } from '../agent/prompt-composer.js';
import { sinalDeclaradoNaFicha } from '../agent/guardrail.js';
import { calculateCost, recordLlmCall, resolveOpenAIApiKey } from './openai.service.js';

// O estado (`estadoDaRevisora`) mora em `lib/revisora-de-saida-contexto.ts`: o grafo também o consulta, e não deve importar este serviço.
export { AUTOMACAO_REVISORA_DE_SAIDA, estadoDaRevisora };

// ── limites: o auxiliar nunca derruba o principal ─────────────────────────────────────────────────

export const MAX_EM_VOO = 25;
export const FALHAS_PARA_ABRIR = 5;
export const PAUSA_DO_DISJUNTOR_MS = 60_000;

/**
 * Teto de revisões simultâneas (global: é o que protege o processo) + disjuntor POR UNIDADE. A chave do provedor é da unidade, então uma
 * chave inválida (Salto/Tatuí têm Anthropic sem workspace) tem de abrir só o disjuntor DELA — com um disjuntor único, os sucessos das
 * outras unidades o manteriam fechado e a unidade ruim pagaria 8 s por resposta; ou, no extremo oposto, ela silenciaria a rede toda.
 */
export class LimiteDaRevisora {
  private emVoo = 0;
  private puladas = 0;
  private readonly unidades = new Map<string, { falhasSeguidas: number; abertoAte: number }>();

  constructor(
    private readonly maxEmVoo = MAX_EM_VOO,
    private readonly falhasParaAbrir = FALHAS_PARA_ABRIR,
    private readonly pausaMs = PAUSA_DO_DISJUNTOR_MS,
  ) {}

  /** Pode começar mais uma revisão desta unidade? Se sim, ocupa a vaga (quem pediu TEM de chamar `terminou`). */
  pedir(unitId: string, agoraMs: number = Date.now()): { ok: true } | { ok: false; motivo: 'disjuntor_aberto' | 'muitas_em_voo' } {
    if (agoraMs < (this.unidades.get(unitId)?.abertoAte ?? 0)) {
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

  /** `falhouOProvedor`: erro/prazo da chamada ao modelo. JSON fora do formato (ou falha nossa) NÃO conta: o provedor respondeu. */
  terminou(unitId: string, falhouOProvedor: boolean, agoraMs: number = Date.now()): { abriu: boolean } {
    this.emVoo = Math.max(0, this.emVoo - 1);
    const u = this.unidades.get(unitId) ?? { falhasSeguidas: 0, abertoAte: 0 };
    this.unidades.set(unitId, u);
    if (!falhouOProvedor) {
      u.falhasSeguidas = 0;
      return { abriu: false };
    }
    u.falhasSeguidas++;
    if (u.falhasSeguidas >= this.falhasParaAbrir) {
      u.falhasSeguidas = 0;
      u.abertoAte = agoraMs + this.pausaMs;
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
    esforco: 'low',
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
    // bem mais linhas que as falas usadas: mídia sem texto e a resposta recém-gravada ocupam linhas, e "o começo da conversa está visível?"
    // só se responde sabendo se o banco ACABOU (veio menos que o pedido) — ver `falasParaARevisora`
    const rows = await deps.carregarMensagens(pedido.conversationId, LINHAS_A_LER);
    falas = falasParaARevisora(rows, pedido.textoEnviado, agora, { linhasPedidas: LINHAS_A_LER, max: MAX_FALAS });
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
  let chamou = false;
  // A hora local não depende de banco nem de modelo: a regra 8 (código) roda com ela mesmo que tudo o mais falhe.
  const hora = horaLocalDaUnidade(deps.agora(), fusoDaUnidade(unit));

  // 1. a entrada. Falha NOSSA (banco, ficha mal formada) não é falha do provedor: não alimenta o disjuntor.
  try {
    entrada = await montarEntrada(pedido, deps);
  } catch (err) {
    erro = `entrada_falhou: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn({ err: erro, traceId: pedido.traceId }, 'revisora de saída: não consegui montar a entrada — sem veredito do modelo');
  }

  // 2. o modelo
  if (entrada) {
    try {
      chamou = true;
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
  }

  const latencyMs = Math.round(performance.now() - t0);
  const doCodigo = [cumprimentoForaDeHora(pedido.textoEnviado, hora)].filter((v): v is NonNullable<typeof v> => !!v);
  const final = consolidar(lido, doCodigo);

  const costUsd = custoComFallback(escolha.modelo, calculateCost(escolha.modelo, promptTokens, completionTokens), promptTokens, completionTokens);
  if (chamou) {
    deps.registrarChamada({
      unitId: unit.id,
      // SEM traceId, como o juiz: fora do custo do turno da Sofia e do teto POR CONVERSA (esses somam por trace). Mas ENTRA no teto MENSAL da
      // conta (`teto-mensal.ts` soma `llm_calls` por unidade, sem olhar trace): é dinheiro de verdade, e excluí-lo exigiria mexer na consulta
      // do teto de todas as unidades por ~US$ 11/mês na rede inteira — a conta de uma clínica gasta dezenas de vezes isso com a Sofia.
      // Se um dia pesar, filtre `request_body->>'revisora'` lá. O elo com o turno está em `revisoes_de_saida.trace_id`.
      traceId: null,
      provider: escolha.provedor,
      model: escolha.modelo,
      endpoint: 'chat.completions',
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      latencyMs,
      // 'error' é o provedor que falhou; formato ruim gasta token e fica `success` (o motivo vai em errorMessage e em revisoes_de_saida.erro)
      status: falhouOProvedor ? 'error' : 'success',
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
      inicioVisivel: entrada ? entrada.inicioVisivel : null,
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
export function agendarRevisaoDeSaida(args: ArgsDaPorta, deps: DependenciasDaRevisora = dependenciasPadrao, limiteUsado: LimiteDaRevisora = limite): void {
  try {
    // consome mesmo quando não vai revisar: a marca não pode ficar esperando o TTL
    const status = pegarStatusDoTurno(args.traceId);
    // a lista de erros é de clínica: advocacia/energia solar não entram (categoria vazia passa — Caxias e Tatuí)
    if (!categoriaRevisavel(args.unit.category)) return;
    const decisao = decidirPeloEstado(estadoDaRevisora(args.unit.slug));
    if (!decisao.revisar || !args.textoEnviado.trim()) return;
    if (decisao.aviso) logger.warn({ unit: args.unit.slug }, decisao.aviso);

    const vaga = limiteUsado.pedir(args.unit.id);
    if (!vaga.ok) {
      const puladas = limiteUsado.puladasTotal;
      if (puladas % 50 === 1) logger.warn({ motivo: vaga.motivo, emVoo: limiteUsado.emVooAgora }, 'revisora de saída: revisão pulada (o auxiliar não pode atrapalhar o principal)');
      return;
    }
    // A vaga é devolvida UMA vez, no `finally`: se o log lançasse dentro do `then`, o `catch` devolveria de novo e `emVoo` ficaria abaixo do real.
    let falhouOProvedor = false;
    void revisarSaida({ ...args, status }, deps)
      .then((d) => {
        falhouOProvedor = d.falhouOProvedor;
      })
      .catch((err) => {
        try {
          logger.warn({ err: String(err) }, 'revisora de saída: falhou fora do previsto');
        } catch {
          /* o log não pode derrubar a devolução da vaga */
        }
      })
      .finally(() => {
        const { abriu } = limiteUsado.terminou(args.unit.id, falhouOProvedor);
        if (!abriu) return;
        try {
          logger.error({ unit: args.unit.slug, pausaMs: PAUSA_DO_DISJUNTOR_MS }, 'revisora de saída: disjuntor ABERTO — erros seguidos do provedor, sem chamar por um tempo');
        } catch {
          /* idem */
        }
      });
  } catch (err) {
    logger.warn({ err: String(err), traceId: args.traceId }, 'revisora de saída: não consegui agendar');
  }
}
