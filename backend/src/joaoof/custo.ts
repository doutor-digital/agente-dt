/**
 * O teto do Joaoof: R$ 300/mês SÓ dele. Cada chamada ao modelo vira uma linha em `llm_calls` com `endpoint = 'joaoof.<papel>'`
 * (e `unit_id` nulo: não é gasto de clínica nenhuma), e o freio soma essas linhas no mês de Brasília.
 *
 *   até 80%  → segue.
 *   80%      → avisa o João UMA vez no mês e segue.
 *   100%     → PARA (nenhuma chamada nova ao modelo) e avisa UMA vez. Só volta no mês seguinte ou com o teto subido.
 *
 * Fail-closed: se não consegue ler o gasto, NÃO chama o modelo (teto que falha aberto não é teto).
 */
import { inicioDoMesNoFuso, mesNoFuso } from '../lib/fuso.js';
import { FUSO_DO_JOAO, ROTULO_LLM, type OrcamentoConfig } from './config.js';

export type NivelDoOrcamento = 'normal' | 'aviso' | 'parado';

export interface UsoDeTokens {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
}

export interface ChamadaRegistrada {
  papel: string;
  modelo: string;
  uso: UsoDeTokens;
  custoUsd: number;
  latenciaMs: number;
  status: 'success' | 'error';
  erro?: string;
}

export interface DepsCusto {
  agora: () => Date;
  /** soma de `cost_usd` das linhas `joaoof.*` desde `desde` */
  gastoDesdeUsd(desde: Date): Promise<number>;
  gravarChamada(c: ChamadaRegistrada): Promise<void>;
  /** o que já foi avisado neste mês (chave de estado) */
  jaAvisou(chave: string): Promise<boolean>;
  marcarAviso(chave: string): Promise<void>;
  /** manda (ou, em seco, registra) o aviso; `true` = entregue. A marca de «já avisei» só é gravada depois disso. */
  avisar(texto: string, chave: string): Promise<boolean>;
  /** namespace das marcas: em seco as marcas não bloqueiam o aviso real de quando o João ligar */
  prefixoDaChave?: () => string;
  calcularCustoUsd(modelo: string, uso: UsoDeTokens): number;
}

export interface Situacao {
  gastoBrl: number;
  tetoBrl: number;
  fracao: number;
  nivel: NivelDoOrcamento;
}

export const brl = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`;

export function nivelDoGasto(gastoBrl: number, cfg: OrcamentoConfig): Situacao {
  const fracao = cfg.tetoBrl > 0 ? gastoBrl / cfg.tetoBrl : 1;
  const nivel: NivelDoOrcamento = fracao >= 1 ? 'parado' : fracao >= cfg.avisoEm ? 'aviso' : 'normal';
  return { gastoBrl, tetoBrl: cfg.tetoBrl, fracao, nivel };
}

/** Custo estimado de um dia típico no teto: quanto cada dia pode gastar (teto ÷ 30). */
export const gastoDiarioPermitidoBrl = (cfg: OrcamentoConfig) => cfg.tetoBrl / 30;

export function criarFreio(deps: DepsCusto, cfg: OrcamentoConfig) {
  // Custos que o banco AINDA não mostra: chamadas cuja gravação está em andamento, ou que NÃO conseguiram gravar (essas ficam para sempre
  // na conta desta instância). Só some daqui o que foi gravado ANTES de começar a leitura do banco que o contém.
  interface Pendente {
    usd: number;
    gravadoEm: number | null;
    falhou: boolean;
    mes: string;
  }
  let pendentes: Pendente[] = [];
  let leitura: { em: number; usd: number; mes: string } | null = null;

  const somaPendentes = () => pendentes.reduce((s, p) => s + p.usd, 0);

  async function gastoUsd(): Promise<number> {
    const agora = deps.agora();
    const mes = mesNoFuso(agora, FUSO_DO_JOAO);
    if (!leitura || leitura.mes !== mes || agora.getTime() - leitura.em > 30_000) {
      const inicio = Date.now();
      const usd = await deps.gastoDesdeUsd(inicioDoMesNoFuso(agora, FUSO_DO_JOAO));
      leitura = { em: agora.getTime(), usd, mes };
      // o que já estava gravado quando a leitura COMEÇOU está dentro de `usd`; o resto (em voo, ou que falhou) continua somando
      // custo que não gravou fica na conta do MÊS em que ocorreu (não vaza para o mês seguinte)
      pendentes = pendentes.filter((p) => p.mes === mes && (p.falhou || p.gravadoEm === null || p.gravadoEm >= inicio));
    }
    return leitura.usd + somaPendentes();
  }

  async function situacao(): Promise<Situacao> {
    return nivelDoGasto((await gastoUsd()) * cfg.usdBrl, cfg);
  }

  /** Chamar ANTES de cada ida ao modelo. `false` = não chame. Avisa o João nas duas faixas, uma vez por mês cada. */
  async function permitir(): Promise<boolean> {
    let s: Situacao;
    try {
      s = await situacao();
    } catch {
      return false;
    }
    if (s.nivel === 'normal') return true;
    const mes = mesNoFuso(deps.agora(), FUSO_DO_JOAO);
    const faixa = s.nivel === 'parado' ? 'parado' : 'aviso';
    const chave = `${deps.prefixoDaChave?.() ?? ''}freio:${mes}:${faixa}`;
    try {
      if (!(await deps.jaAvisou(chave))) {
        // marca DEPOIS de entregar: aviso que não saiu (Telegram fora) é tentado de novo na próxima chamada, não perdido
        const entregue = await deps.avisar(
          s.nivel === 'parado'
            ? `Joaoof PAROU: o gasto do mês chegou a ${brl(s.gastoBrl)} do teto de ${brl(s.tetoBrl)}. Não faço mais nenhuma chamada ao modelo até virar o mês (ou você subir JOAOOF_TETO_BRL).`
            : `Joaoof: o gasto do mês está em ${brl(s.gastoBrl)} de ${brl(s.tetoBrl)} (${Math.round(s.fracao * 100)}%). Sigo normal; em 100% eu paro e aviso.`,
          chave,
        );
        if (entregue) await deps.marcarAviso(chave);
      }
    } catch {
      /* aviso que falha não muda a decisão */
    }
    return s.nivel !== 'parado';
  }

  /** Soma o custo NA HORA (antes de gravar) e grava em `llm_calls`. Falha de gravação não tira o custo da conta. */
  async function registrar(c: Omit<ChamadaRegistrada, 'custoUsd'>): Promise<number> {
    const custoUsd = deps.calcularCustoUsd(c.modelo, c.uso);
    const p: Pendente = { usd: custoUsd, gravadoEm: null, falhou: false, mes: mesNoFuso(deps.agora(), FUSO_DO_JOAO) };
    pendentes.push(p);
    try {
      await deps.gravarChamada({ ...c, custoUsd });
      p.gravadoEm = Date.now();
    } catch {
      p.falhou = true;
    }
    return custoUsd;
  }

  return { permitir, situacao, registrar };
}

export type Freio = ReturnType<typeof criarFreio>;

/** Tokens de uma resposta do LangChain (`usage_metadata`); zeros se o provedor não mandou. */
export function usoDaResposta(msg: unknown): UsoDeTokens {
  const m = msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number; cache_creation?: number } } } | null;
  const u = m?.usage_metadata;
  return {
    entrada: Number(u?.input_tokens ?? 0),
    saida: Number(u?.output_tokens ?? 0),
    cacheLeitura: Number(u?.input_token_details?.cache_read ?? 0),
    cacheEscrita: Number(u?.input_token_details?.cache_creation ?? 0),
  };
}

export const rotuloDaChamada = (papel: string) => `${ROTULO_LLM}.${papel}`;
