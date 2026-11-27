/**
 * A fiação de produção do Joaoof: banco (Prisma), modelo (Anthropic), Telegram e freio de custo ligados nas peças puras.
 * É o único arquivo do módulo que importa o openai.service (preço) e o ChatAnthropic — o resto roda em teste sem env nem rede.
 */
import { cortar } from './privacidade.js';
import { ChatAnthropic } from '@langchain/anthropic';
import type { AIMessage } from '@langchain/core/messages';
import { Prisma } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { configTelegram, enviarTelegram } from '../lib/telegram.js';
import { calculateCost } from '../services/openai.service.js';
import type { ModeloDeChat } from './cerebro.js';
import { rodarCerebro, type ResultadoDoCerebro } from './cerebro.js';
import { canalDoJoaoof, chatDoJoao, modelosDoJoaoof, modoDoJoaoof, orcamentoDoJoaoof, ROTULO_LLM } from './config.js';
import { brl, criarFreio, rotuloDaChamada, type DepsCusto, type Freio } from './custo.js';
import { criarFerramentas } from './ferramentas.js';
import { repoPrisma } from './repo-prisma.js';
import type { JoaoofRepo } from './repo.js';
import type { DepsEntrega } from './avisos.js';
import type { DepsTelegramJoao } from './telegram-joao.js';
import type { DepsPasso } from './passo.js';

const agora = () => new Date();

export function enviarAoJoao(texto: string): Promise<boolean> {
  return enviarTelegram(texto, { canal: canalDoJoaoof(), chat: chatDoJoao() });
}

export function depsDeCusto(repo: JoaoofRepo = repoPrisma): DepsCusto {
  return {
    agora,
    async gastoDesdeUsd(desde) {
      const r = await prisma.llmCall.aggregate({ where: { endpoint: { startsWith: `${ROTULO_LLM}.` }, createdAt: { gte: desde } }, _sum: { costUsd: true } });
      return Number(r._sum.costUsd ?? 0);
    },
    async gravarChamada(c) {
      // se a gravação falha o erro SOBE: o freio guarda o custo na conta local para sempre (teto não falha aberto)
      try {
        await prisma.llmCall.create({
          data: {
            unitId: null,
            traceId: null,
            provider: 'anthropic',
            model: c.modelo,
            endpoint: rotuloDaChamada(c.papel),
            promptTokens: c.uso.entrada,
            completionTokens: c.uso.saida,
            totalTokens: c.uso.entrada + c.uso.saida,
            costUsd: new Prisma.Decimal(c.custoUsd),
            latencyMs: c.latenciaMs,
            status: c.status,
            errorMessage: c.erro,
          },
        });
      } catch (err) {
        logger.error({ err: String(err) }, 'joaoof: falha ao gravar a chamada em llm_calls — o custo segue contado na memória');
        throw err;
      }
    },
    async jaAvisou(chave) {
      return (await repo.lerEstado(chave)) !== null;
    },
    async marcarAviso(chave) {
      await repo.gravarEstado(chave, { em: new Date().toISOString() });
    },
    prefixoDaChave: () => (modoDoJoaoof(process.env.JOAOOF_LIGADO) === 'seco' ? 'seco:' : ''),
    async avisar(texto, chave) {
      const modo = modoDoJoaoof(process.env.JOAOOF_LIGADO);
      if (modo === 'ligado') return enviarAoJoao(texto);
      if (modo === 'seco') {
        // seco: registra o texto (o ver-joaoof.sh mostra) em vez de mandar
        await repo.registrarAviso({ tipo: 'sistema', chave, texto, enviado: false, seco: true });
        return true;
      }
      return false;
    },
    calcularCustoUsd: (modelo, uso) => calculateCost(modelo, uso.entrada, uso.saida, uso.cacheLeitura, uso.cacheEscrita, 0),
  };
}

let freioUnico: Freio | null = null;
export function freioDoJoaoof(): Freio {
  freioUnico ??= criarFreio(depsDeCusto(), orcamentoDoJoaoof());
  return freioUnico;
}

/**
 * A chave do modelo: `JOAOOF_ANTHROPIC_API_KEY` se existir; senão a `ANTHROPIC_API_KEY` do servidor (a MESMA da rede — decisão do João, 27/11).
 * Nunca a de uma clínica (essas ficam na unidade, no banco). O gasto do Joaoof continua só dele, no `llm_calls` (`joaoof.*`), e o freio de R$ 300 vale igual.
 */
export function chaveDoModelo(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.JOAOOF_ANTHROPIC_API_KEY ?? '').trim() || String(env.ANTHROPIC_API_KEY ?? '').trim();
}

export function criarModelo(nome: string, env: NodeJS.ProcessEnv = process.env): ModeloDeChat {
  const apiKey = chaveDoModelo(env);
  if (!apiKey) throw new Error('JOAOOF_ANTHROPIC_API_KEY ausente (e ANTHROPIC_API_KEY também): sem chave do servidor o Joaoof não chama o modelo');
  const chat = new ChatAnthropic({ apiKey, model: nome, maxTokens: 2000, maxRetries: 1, clientOptions: { timeout: 60_000 } });
  return {
    nome,
    bindTools: (ferramentas) => {
      const ligado = chat.bindTools(ferramentas);
      return { invoke: (mensagens, opcoes) => ligado.invoke(mensagens, opcoes) as Promise<AIMessage> };
    },
  };
}

export type Papel = 'triagem' | 'resposta' | 'urgencia';

/** Roda o cérebro com as ferramentas reais. Nunca lança: falha vira `parou: 'erro'`. */
export async function executarComModelo(opcoes: { papel: Papel; forte: boolean; sistema: string; pedido: string; fonte: 'grupo' | 'vigia' | 'telegram'; refsDoLote?: ReadonlyMap<string, string>; lerMensagens?: (slug: string, n: number) => Promise<string>; maxPassos?: number; apenasFerramentas?: string[]; textoDoJoao?: string; escopo?: { unidade?: string | null; soNumero?: number; podeRebaixar?: boolean } }): Promise<ResultadoDoCerebro> {
  try {
    const { barato, forte } = modelosDoJoaoof();
    const modelo = criarModelo(opcoes.forte ? forte : barato);
    const todas = criarFerramentas({ repo: repoPrisma, fonte: opcoes.fonte, refsDoLote: opcoes.refsDoLote, lerMensagens: opcoes.lerMensagens, textoDoJoao: opcoes.textoDoJoao, escopo: opcoes.escopo });
    const ferramentas = opcoes.apenasFerramentas ? todas.filter((t) => opcoes.apenasFerramentas!.includes(t.name)) : todas;
    return await rodarCerebro({ modelo, ferramentas, freio: freioDoJoaoof(), papel: opcoes.papel, maxPassos: opcoes.maxPassos }, opcoes.sistema, opcoes.pedido);
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    logger.error({ erro }, 'joaoof: o cérebro falhou');
    return { resposta: '', passos: 0, chamadasDeFerramenta: [], resultadosDeFerramenta: [], parou: 'erro', custoUsd: 0, erro: cortar(erro, 300) };
  }
}

export async function textoDoCusto(): Promise<string> {
  try {
    const s = await freioDoJoaoof().situacao();
    const cfg = orcamentoDoJoaoof();
    return `Gasto do mês: ${brl(s.gastoBrl)} de ${brl(s.tetoBrl)} (${Math.round(s.fracao * 100)}%). Câmbio usado: ${cfg.usdBrl.toString().replace('.', ',')}.`;
  } catch {
    return 'Não consegui ler o gasto agora.';
  }
}

export async function alertasDoJoaoof(): Promise<string[]> {
  const alertas: string[] = [];
  try {
    const s = await freioDoJoaoof().situacao();
    if (s.nivel === 'parado') alertas.push(`Joaoof parado: gasto do mês chegou a ${brl(s.gastoBrl)} (teto ${brl(s.tetoBrl)}).`);
    else if (s.nivel === 'aviso') alertas.push(`Gasto do Joaoof em ${Math.round(s.fracao * 100)}% do teto (${brl(s.gastoBrl)} de ${brl(s.tetoBrl)}).`);
  } catch {
    /* sem leitura do gasto, sem linha de alerta */
  }
  return alertas;
}

export function depsDeEntregaReais(): DepsEntrega {
  return { repo: repoPrisma, modo: () => modoDoJoaoof(process.env.JOAOOF_LIGADO), enviar: enviarAoJoao, agora };
}

export function depsTelegramReais(): DepsTelegramJoao {
  return {
    repo: repoPrisma,
    modo: () => modoDoJoaoof(process.env.JOAOOF_LIGADO),
    agora,
    chatPermitido: () => chatDoJoao(),
    responder: enviarAoJoao,
    executar: (forte, sistema, pedido, textoDoJoao) => executarComModelo({ papel: 'resposta', forte, sistema, pedido, fonte: 'telegram', textoDoJoao }),
    registrar: (nivel, dados, mensagem) => logger[nivel](dados, mensagem),
    textoDoCusto,
    alertas: alertasDoJoaoof,
  };
}

export function depsDoPasso(lote?: DepsPasso['lote']): DepsPasso {
  return {
    ...depsDeEntregaReais(),
    alertas: alertasDoJoaoof,
    lote,
    registrar: (nivel, dados, mensagem) => logger[nivel](dados, mensagem),
  };
}

/** O Telegram do canal escolhido tem token? (para o log de partida) */
export const telegramDoJoaoofConfigurado = () => configTelegram(process.env, canalDoJoaoof()) !== null;
