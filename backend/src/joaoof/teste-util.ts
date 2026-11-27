/** Peças de teste do Joaoof (não é `*.test.ts`: não roda sozinho). */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ModeloDeChat } from './cerebro.js';
import { criarFreio, type ChamadaRegistrada, type DepsCusto } from './custo.js';
import { orcamentoDoJoaoof } from './config.js';

export const pedidoDeFerramenta = (nome: string, args: Record<string, unknown>, id = `c_${nome}_${Math.random().toString(36).slice(2, 7)}`) =>
  new AIMessage({
    content: '',
    tool_calls: [{ name: nome, args, id, type: 'tool_call' }],
    usage_metadata: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
  });

export const falaFinal = (texto: string) => new AIMessage({ content: texto, usage_metadata: { input_tokens: 1200, output_tokens: 50, total_tokens: 1250 } });

/** Um modelo que devolve as respostas do roteiro, na ordem, e guarda o que recebeu. */
export function modeloRoteirizado(roteiro: Array<AIMessage | Error>, nome = 'claude-teste') {
  const recebidos: BaseMessage[][] = [];
  const modelo: ModeloDeChat = {
    nome,
    bindTools: () => ({
      async invoke(mensagens) {
        recebidos.push(mensagens);
        const proxima = roteiro.shift();
        if (!proxima) throw new Error('roteiro acabou');
        if (proxima instanceof Error) throw proxima;
        return proxima;
      },
    }),
  };
  return { modelo, recebidos, sobrou: () => roteiro.length };
}

export function depsDeCustoFalsas(opcoes: { gastoUsd?: number; falhaNaLeitura?: boolean; avisoFalha?: boolean; agora?: () => Date } = {}) {
  const chamadas: ChamadaRegistrada[] = [];
  const estado = new Set<string>();
  const avisos: string[] = [];
  const deps: DepsCusto = {
    agora: opcoes.agora ?? (() => new Date('2026-11-27T15:00:00.000Z')),
    async gastoDesdeUsd() {
      if (opcoes.falhaNaLeitura) throw new Error('banco fora');
      return (opcoes.gastoUsd ?? 0) + chamadas.reduce((s, c) => s + c.custoUsd, 0) * 0; // o banco só vê o que já foi gravado e lido
    },
    async gravarChamada(c) {
      chamadas.push(c);
    },
    async jaAvisou(chave) {
      return estado.has(chave);
    },
    async marcarAviso(chave) {
      estado.add(chave);
    },
    async avisar(texto) {
      avisos.push(texto);
      return opcoes.avisoFalha ? false : true;
    },
    // US$ 1 por 1M de entrada e US$ 5 por 1M de saída (o Haiku 4.5)
    calcularCustoUsd: (_m, u) => (u.entrada / 1e6) * 1 + (u.saida / 1e6) * 5,
  };
  return { deps, chamadas, avisos, estado };
}

export function freioDeTeste(opcoes: Parameters<typeof depsDeCustoFalsas>[0] = {}, env: NodeJS.ProcessEnv = {}) {
  const f = depsDeCustoFalsas(opcoes);
  return { ...f, freio: criarFreio(f.deps, orcamentoDoJoaoof(env)) };
}
