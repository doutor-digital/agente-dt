/**
 * Cadeia de reserva de provedores de IA (o `withFallbacks` do LangChain, no desenho do grafo).
 *
 * 26/11/2026: o crédito da Anthropic acabou às 18h e o da OpenAI (único plano B) também. ~15 h com 0
 * resposta boa na rede toda, 111 "tive uma instabilidade" em 71 conversas. Um plano B só é um ponto
 * único de falha com outro nome: aqui o principal cai para TODOS os outros provedores disponíveis,
 * em ordem (Anthropic, OpenAI, Google), cada tentativa com o seu teto de tempo.
 *
 * Regras:
 *  - Sem env nova, a cadeia é EXATAMENTE o plano B de hoje (`escolherPlanoB`): um só reserva, mesmo
 *    teto, circuito intocado. Só quando há chave reserva GLOBAL (`AGENT_RESERVE_GOOGLE_KEY` ou
 *    `ANTHROPIC_RESERVE_API_KEY`) a lista cresce com os demais provedores.
 *  - A chave da unidade vem sempre primeiro; a global só entra quando a unidade não tem a própria
 *    daquele provedor (a unidade que troca a chave volta pra ela sozinha, sem deploy).
 *  - Erro de saldo/cota (`erro-de-saldo.ts`) pula NA HORA para o próximo e abre o disjuntor do provedor.
 *  - Infra (timeout, 5xx) segue a regra do circuito: três seguidas abrem. Circuito aberto = pula sem chamar.
 *
 * Fica FORA deste módulo (e por isso testável sem rede nem banco): montar o modelo, ligar as
 * ferramentas e gravar o rastro — quem chama passa `chamar`.
 */
import type { Unit } from '@prisma/client';
import { chaveReservaAnthropic } from './chave-reserva.js';
import { ehErroDeSaldoOuCota } from './erro-de-saldo.js';
import { abrirCircuito, circuitoAberto, ehFalhaDeInfra, registrarFalha, registrarSucesso, type Provedor } from './circuito.js';
import { escolherPlanoB, PLANO_B_TIMEOUT_MS, withTimeout, type UnitCreds } from './llm-policy.js';

/** Ordem em que os reservas entram (o principal sai da lista). */
export const ORDEM_DOS_PROVEDORES: readonly Provedor[] = ['anthropic', 'openai', 'google'];

export type OrigemDaChave = 'unidade' | 'ambiente' | 'reserva-global';

export interface PassoDaCadeia {
  provider: Provedor;
  modelName: string;
  origemChave: OrigemDaChave;
  /** Chave a sobrepor na unidade ao montar o modelo (só quando a origem é a reserva global). */
  credenciais: Partial<Pick<Unit, 'anthropicApiKey' | 'googleApiKey'>>;
  timeoutMs: number;
}

export interface ReservasGlobais {
  anthropic: string | null;
  google: string | null;
}

/** Lida na hora (não no boot): pôr a chave no ambiente não exige mexer em código. */
export function reservasGlobais(): ReservasGlobais {
  const g = process.env.AGENT_RESERVE_GOOGLE_KEY?.trim();
  return { anthropic: chaveReservaAnthropic(), google: g ? g : null };
}

export function cadeiaCompletaLigada(r: ReservasGlobais): boolean {
  return !!r.anthropic || !!r.google;
}

/** O rótulo que vai para `llm_calls.provider` e para o rastro: a reserva global aparece separada da chave da unidade. */
export function rotuloDoProvedor(passo: Pick<PassoDaCadeia, 'provider' | 'origemChave'>): string {
  return passo.origemChave === 'reserva-global' ? `${passo.provider}-reserva` : passo.provider;
}

/**
 * Saldo é da CHAVE (da conta), não do provedor: a Anthropic da Taubaté sem crédito não pode tirar do ar a
 * Anthropic da Salto, que tem a sua. Por isso o circuito de saldo vive numa chave própria:
 *  - chave da unidade  -> "anthropic:<id da unidade>"
 *  - chave do ambiente (OpenAI compartilhada) -> "openai:ambiente"
 *  - chave reserva global -> "google:reserva"
 * O circuito de INFRA (provedor fora do ar) segue por provedor, como sempre.
 */
export function chaveDeSaldo(provider: Provedor, origemChave: OrigemDaChave, unitId: string): string {
  return `${provider}:${origemChave === 'unidade' ? unitId : origemChave === 'ambiente' ? 'ambiente' : 'reserva'}`;
}

/** De onde vem a chave do PRINCIPAL: a OpenAI sem chave própria usa a do ambiente; os demais sempre a da unidade. */
export function origemDoPrincipal(provider: Provedor, unit: Pick<UnitCreds, 'openaiApiKey'>): OrigemDaChave {
  return provider === 'openai' && !unit.openaiApiKey ? 'ambiente' : 'unidade';
}

export interface MontarCadeiaArgs {
  unit: UnitCreds;
  /** Provedor EFETIVO da chamada principal (já considera chave ausente). */
  principal: Provedor;
  temChaveOpenAiNoAmbiente: boolean;
  /** Injeção para teste. Padrão: env. */
  reservas?: ReservasGlobais;
  timeoutMs?: number;
}

export function montarCadeia(args: MontarCadeiaArgs): PassoDaCadeia[] {
  const { unit, principal, temChaveOpenAiNoAmbiente } = args;
  const reservas = args.reservas ?? reservasGlobais();
  const timeoutMs = args.timeoutMs ?? PLANO_B_TIMEOUT_MS;
  const passos: PassoDaCadeia[] = [];

  // 1) O plano B de hoje, intacto. Sem reserva global é a cadeia inteira.
  const legado = escolherPlanoB(unit, temChaveOpenAiNoAmbiente);
  if (legado) {
    passos.push({
      provider: legado.provider,
      modelName: legado.modelName,
      origemChave: legado.provider === 'openai' && !unit.openaiApiKey ? 'ambiente' : 'unidade',
      credenciais: {},
      timeoutMs,
    });
  }
  if (!cadeiaCompletaLigada(reservas)) return passos;

  // 2) Todos os outros provedores com chave: a da unidade, ou a reserva global.
  for (const provider of ORDEM_DOS_PROVEDORES) {
    if (provider === principal) continue;
    if (passos.some((p) => p.provider === provider)) continue;

    if (provider === 'anthropic') {
      const modelName = unit.anthropicModel || 'claude-opus-4-8';
      if (unit.anthropicApiKey) {
        passos.push({ provider, modelName, origemChave: 'unidade', credenciais: {}, timeoutMs });
      } else if (reservas.anthropic) {
        passos.push({ provider, modelName, origemChave: 'reserva-global', credenciais: { anthropicApiKey: reservas.anthropic }, timeoutMs });
      }
    } else if (provider === 'openai') {
      if (unit.openaiApiKey || temChaveOpenAiNoAmbiente) {
        passos.push({
          provider,
          modelName: unit.openaiModel || 'gpt-4o-mini',
          origemChave: unit.openaiApiKey ? 'unidade' : 'ambiente',
          credenciais: {},
          timeoutMs,
        });
      }
    } else {
      const modelName = unit.googleModel || 'gemini-2.5-flash';
      if (unit.googleApiKey) {
        passos.push({ provider, modelName, origemChave: 'unidade', credenciais: {}, timeoutMs });
      } else if (reservas.google) {
        passos.push({ provider, modelName, origemChave: 'reserva-global', credenciais: { googleApiKey: reservas.google }, timeoutMs });
      }
    }
  }
  return passos;
}

export type ResultadoDaTentativa = 'respondeu' | 'circuito-aberto' | 'saldo' | 'timeout' | 'erro';

export interface Tentativa {
  provider: Provedor;
  modelName: string;
  origemChave: OrigemDaChave;
  resultado: ResultadoDaTentativa;
  /** Resumo do erro (nunca a chave). */
  erro?: string;
  ms: number;
}

export class CadeiaEsgotadaError extends Error {
  constructor(
    public readonly tentativas: Tentativa[],
    public readonly ultimoErro: unknown,
  ) {
    super(
      `nenhum provedor reserva respondeu: ${tentativas.map((t) => `${t.provider}=${t.resultado}`).join(', ') || 'cadeia vazia'}`,
    );
    this.name = 'CadeiaEsgotadaError';
  }
}

export interface PercorrerCadeiaArgs<T> {
  passos: PassoDaCadeia[];
  /** Faz a chamada daquele passo (monta o modelo, liga as ferramentas, chama). O teto de tempo é daqui. */
  chamar: (passo: PassoDaCadeia) => Promise<T>;
  /**
   * Cadeia completa ligada: os reservas passam pelo circuito (pula o aberto, fecha no sucesso, abre no
   * saldo). Desligada = o plano B de hoje, que nunca consultou o circuito.
   */
  comCircuito: boolean;
  /** Unidade da conversa: escopo do circuito de saldo das chaves que são DELA. */
  unitId: string;
  /** Relógio injetável. */
  agora?: () => number;
}

function resumoDoErro(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err ?? '');
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

/**
 * Tenta cada passo em ordem. O primeiro que responde vence; devolve também o que aconteceu antes dele
 * (para o rastro). Se nenhum responde, lança `CadeiaEsgotadaError` com todas as tentativas.
 */
export async function percorrerCadeia<T>(
  args: PercorrerCadeiaArgs<T>,
): Promise<{ resposta: T; passo: PassoDaCadeia; tentativas: Tentativa[] }> {
  const agora = args.agora ?? Date.now;
  const tentativas: Tentativa[] = [];
  let ultimoErro: unknown = null;

  for (const passo of args.passos) {
    const base = { provider: passo.provider, modelName: passo.modelName, origemChave: passo.origemChave };

    const saldoKey = chaveDeSaldo(passo.provider, passo.origemChave, args.unitId);
    if (args.comCircuito && (circuitoAberto(passo.provider) || circuitoAberto(saldoKey))) {
      tentativas.push({ ...base, resultado: 'circuito-aberto', ms: 0 });
      continue;
    }

    const t0 = agora();
    try {
      const resposta = await withTimeout(args.chamar(passo), passo.timeoutMs);
      if (args.comCircuito) {
        registrarSucesso(passo.provider);
        registrarSucesso(saldoKey);
      }
      tentativas.push({ ...base, resultado: 'respondeu', ms: agora() - t0 });
      return { resposta, passo, tentativas };
    } catch (err) {
      ultimoErro = err;
      const ms = agora() - t0;
      let resultado: ResultadoDaTentativa = 'erro';
      if (ehErroDeSaldoOuCota(err)) {
        resultado = 'saldo';
        if (args.comCircuito) abrirCircuito(saldoKey);
      } else if (ehFalhaDeInfra(err)) {
        resultado = err instanceof Error && err.name === 'LlmTimeoutError' ? 'timeout' : 'erro';
        if (args.comCircuito) registrarFalha(passo.provider);
      }
      tentativas.push({ ...base, resultado, erro: resumoDoErro(err), ms });
    }
  }
  throw new CadeiaEsgotadaError(tentativas, ultimoErro);
}

/** Uma linha para o título do rastro: "openai (sem saldo) → google". */
export function resumoDasTentativas(tentativas: Tentativa[]): string {
  const nome: Record<ResultadoDaTentativa, string> = {
    respondeu: 'respondeu',
    'circuito-aberto': 'circuito aberto',
    saldo: 'sem saldo/cota',
    timeout: 'não respondeu a tempo',
    erro: 'erro',
  };
  return tentativas.map((t) => (t.resultado === 'respondeu' ? t.provider : `${t.provider} (${nome[t.resultado]})`)).join(' → ');
}
