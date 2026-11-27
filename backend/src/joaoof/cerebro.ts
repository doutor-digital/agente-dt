/**
 * O cérebro do Joaoof: um grafo LangGraph com dois nós — `pensar` (o modelo olha o que tem e decide) e `agir` (executa as
 * ferramentas que ele escolheu) — que se repetem até o modelo responder sem pedir ferramenta. Não é árvore de if: quem
 * escolhe o caminho é o modelo; o código só impõe os limites (passos, orçamento, o que cada ferramenta aceita).
 *
 * O modelo entra por fora (`ModeloDeChat`), então o teste usa um roteiro fixo e a produção usa o ChatAnthropic.
 * Cada ida ao modelo passa pelo freio de custo e é registrada em `llm_calls` (rótulo `joaoof.<papel>`).
 */
import { cortar } from './privacidade.js';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph, messagesStateReducer } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { Freio, UsoDeTokens } from './custo.js';
import { usoDaResposta } from './custo.js';

export interface ModeloComFerramentas {
  invoke(mensagens: BaseMessage[], opcoes?: { signal?: AbortSignal }): Promise<AIMessage>;
}

export interface ModeloDeChat {
  nome: string;
  bindTools(ferramentas: StructuredToolInterface[]): ModeloComFerramentas;
}

export interface OpcoesDoCerebro {
  modelo: ModeloDeChat;
  ferramentas: StructuredToolInterface[];
  freio: Freio;
  /** rótulo do gasto: `triagem`, `resposta`, `urgencia`… */
  papel: string;
  /** teto de idas ao modelo por execução (cada ida pode pedir ferramentas) */
  maxPassos?: number;
  /** prazo de cada ida ao modelo */
  prazoMs?: number;
}

export interface ResultadoDoCerebro {
  /** a última fala do modelo (sem pedido de ferramenta) */
  resposta: string;
  passos: number;
  chamadasDeFerramenta: Array<{ nome: string; argumentos: unknown }>;
  /** o que cada ferramenta respondeu («ATUALIZADA #1…», «RECUSADO…»): é a PROVA do que foi feito, não a fala do modelo */
  resultadosDeFerramenta: string[];
  /** `orcamento` = o freio negou; `passos` = bateu o limite; `erro` = o modelo falhou; null = terminou sozinho */
  parou: 'orcamento' | 'passos' | 'erro' | null;
  custoUsd: number;
  erro?: string;
}

const Estado = Annotation.Root({
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  passos: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  parou: Annotation<ResultadoDoCerebro['parou']>({ reducer: (_a, b) => b, default: () => null }),
  erro: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
});

const textoDa = (m: BaseMessage | undefined): string => {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : ((p as { text?: string }).text ?? ''))).join('');
  return '';
};

export function montarGrafo(o: OpcoesDoCerebro) {
  const maxPassos = o.maxPassos ?? 8;
  const comFerramentas = o.modelo.bindTools(o.ferramentas);
  const noDeFerramentas = new ToolNode(o.ferramentas);
  let custoUsd = 0;

  async function pensar(estado: typeof Estado.State): Promise<Partial<typeof Estado.State>> {
    if (estado.passos >= maxPassos) return { parou: 'passos' };
    if (!(await o.freio.permitir())) return { parou: 'orcamento' };
    const t0 = performance.now();
    try {
      const resposta = await comFerramentas.invoke(estado.messages, { signal: AbortSignal.timeout(o.prazoMs ?? 60_000) });
      const uso: UsoDeTokens = usoDaResposta(resposta);
      custoUsd += await o.freio.registrar({ papel: o.papel, modelo: o.modelo.nome, uso, latenciaMs: Math.round(performance.now() - t0), status: 'success' });
      return { messages: [resposta], passos: estado.passos + 1 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await o.freio
        .registrar({ papel: o.papel, modelo: o.modelo.nome, uso: { entrada: 0, saida: 0, cacheLeitura: 0, cacheEscrita: 0 }, latenciaMs: Math.round(performance.now() - t0), status: 'error', erro: cortar(msg, 300) })
        .catch(() => 0);
      return { parou: 'erro', erro: cortar(msg, 300) };
    }
  }

  const aoSair = (estado: typeof Estado.State): 'agir' | typeof END => {
    if (estado.parou) return END;
    const ultima = estado.messages[estado.messages.length - 1];
    const pedidos = ultima instanceof AIMessage ? (ultima.tool_calls?.length ?? 0) : 0;
    return pedidos > 0 ? 'agir' : END;
  };

  const grafo = new StateGraph(Estado)
    .addNode('pensar', pensar)
    .addNode('agir', noDeFerramentas)
    .addEdge(START, 'pensar')
    .addConditionalEdges('pensar', aoSair, { agir: 'agir', [END]: END })
    .addEdge('agir', 'pensar')
    .compile();

  return { grafo, custo: () => custoUsd };
}

/** Roda o grafo uma vez: instrução do sistema + o pedido (já montado) → resposta final e o que foi feito. */
export async function rodarCerebro(o: OpcoesDoCerebro, sistema: string, pedido: string): Promise<ResultadoDoCerebro> {
  const { grafo, custo } = montarGrafo(o);
  const maxPassos = o.maxPassos ?? 8;
  const final = await grafo.invoke({ messages: [new SystemMessage(sistema), new HumanMessage(pedido)] }, { recursionLimit: maxPassos * 2 + 6 });
  const chamadas: ResultadoDoCerebro['chamadasDeFerramenta'] = [];
  for (const m of final.messages) {
    if (m instanceof AIMessage) for (const c of m.tool_calls ?? []) chamadas.push({ nome: c.name, argumentos: c.args });
  }
  const resultados = final.messages.filter((m): m is ToolMessage => m instanceof ToolMessage).map((m) => textoDa(m).trim());
  const ultimaIa = [...final.messages].reverse().find((m): m is AIMessage => m instanceof AIMessage);
  return {
    resposta: textoDa(ultimaIa).trim(),
    passos: final.passos,
    chamadasDeFerramenta: chamadas,
    resultadosDeFerramenta: resultados,
    parou: final.parou,
    custoUsd: custo(),
    ...(final.erro ? { erro: final.erro } : {}),
  };
}
