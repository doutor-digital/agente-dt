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
import { criarFerramentas, limpoParaPedido } from './ferramentas.js';
import { repoPrisma } from './repo-prisma.js';
import type { JoaoofRepo } from './repo.js';
import type { DepsEntrega } from './avisos.js';
import type { DepsTelegramJoao } from './telegram-joao.js';
import type { DepsPasso } from './passo.js';
import { entradaPrisma } from './entrada.js';
import { configEvolution, lerGrupoNoEvolution, normalizarRegistro } from './evolution.js';
import { rodarLote, type DepsTriagem } from './triagem.js';
import { registrarEvento, type DepsVigia, type EventoDaVigia } from './vigia.js';

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
  // a fonte surda NÃO entra aqui: ela já sai como aviso próprio (1×/dia, no expediente) — duas mensagens para o mesmo fato seria barulho
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

/** O que a ferramenta `ler_mensagens_grupo` devolve ao cérebro: as últimas falas do grupo da unidade, já mascaradas. */
export async function lerMensagensDoGrupoParaOCerebro(slug: string, n: number): Promise<string> {
  const cfg = configEvolution();
  if (!cfg) return 'Sem credencial da Evolution (JOAOOF_EVO_APIKEY): não consigo ler o grupo.';
  const u = (await repoPrisma.unidades()).find((x) => x.slug === slug);
  if (!u?.grupoJid) return `Não conheço o grupo da unidade ${slug}.`;
  const r = await lerGrupoNoEvolution(cfg, u.grupoJid, 0, n);
  if (!r.ok) return `Não consegui ler o grupo agora (${r.erro}).`;
  const falas = r.registros
    .map((reg) => normalizarRegistro(reg, slug, process.env.JOAOOF_SEGREDO_PESSOA))
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => a.ts - b.ts)
    .map((m) => `${new Date(m.ts * 1000).toISOString().slice(5, 16).replace('T', ' ')}Z ${limpoParaPedido(m.autorNome || 'alguém', 80)}: ${limpoParaPedido(m.texto, 300)}`);
  return falas.length ? falas.join('\n') : 'Sem mensagens de gente nesse grupo no período lido.';
}

export function depsDeTriagemReais(): DepsTriagem {
  return {
    ...depsDeEntregaReais(),
    entradas: entradaPrisma,
    evolution: configEvolution(),
    segredoPessoa: process.env.JOAOOF_SEGREDO_PESSOA,
    executar: (o) => executarComModelo({ ...o, fonte: 'grupo', lerMensagens: lerMensagensDoGrupoParaOCerebro }),
    intervaloMin: Math.max(5, Number(process.env.JOAOOF_LOTE_MIN) || 20),
    retroativoHoras: Math.max(1, Number(process.env.JOAOOF_RETROATIVO_HORAS) || 24),
    maxPorChamada: 60,
    registrar: (nivel, dados, mensagem) => logger[nivel](dados, mensagem),
  };
}

/** O relógio chama isto a cada minuto; o lote respeita o intervalo sozinho. */
export function loteReal(): () => Promise<void> {
  const deps = depsDeTriagemReais();
  return async () => {
    const r = await rodarLote(deps);
    if (r.rodou && r.motivo !== 'sem-mensagens') logger.info({ ...r }, 'joaoof: lote');
  };
}

/** Ponto de entrada do vigia com a fiação real (ver `vigia.ts`). */
export function registrarEventoReal(e: EventoDaVigia) {
  const deps: DepsVigia = { entradas: entradaPrisma, modo: () => modoDoJoaoof(process.env.JOAOOF_LIGADO), agora };
  return registrarEvento(deps, e);
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
