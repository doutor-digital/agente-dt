/**
 * CUSTO e RITMO de um disparo pelo CRM — o que o João pediu para ver ANTES de aprovar, e o teto de gasto por dia.
 *
 * NENHUM preço é inventado. O preço por mensagem de cada CATEGORIA (marketing, utilidade, autenticação) vem das MESMAS tabelas de custo da Meta
 * que o resultado do disparo do Kommo usa (`whatsapp_cost_daily`, gravada pelo sync diário): o MAIOR custo por mensagem diário, dos últimos 90 dias, da
 * PRÓPRIA unidade, só cobranças regulares no Brasil — o maior, e não a média, porque a média mistura dias de mensagem grátis (dentro da janela de 24 h) e
 * subestimaria um modelo mandado a quem não escreve há semanas. Em reais pelo mesmo câmbio do Kommo (`cotacaoDoDolar`). Sem linha para a categoria da
 * unidade (ou sem câmbio), o custo é «DESCONHECIDO»: a tela diz isso e a aprovação exige confirmação explícita.
 */
import { prisma } from '../../prisma.js';
import { cotacaoDoDolar } from '../../campanha/coleta.js';
import type { Freios } from '../freios.js';

// ── teto de gasto por dia ───────────────────────────────────────────────────────────────────────────────────────

export const TETO_REAIS_DIA_PADRAO = 50;
const TETO_MAXIMO_SENSATO = 1_000_000;

/** `CHATWOOT_DISPARO_TETO_REAIS_DIA`. Ilegível, zero, negativo ou absurdo volta ao PADRÃO — nunca vira «sem teto». */
export function tetoReaisPorDia(env: NodeJS.ProcessEnv = process.env): number {
  const bruto = env.CHATWOOT_DISPARO_TETO_REAIS_DIA;
  if (bruto === undefined || bruto.trim() === '') return TETO_REAIS_DIA_PADRAO;
  const n = Number(bruto.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= TETO_MAXIMO_SENSATO ? n : TETO_REAIS_DIA_PADRAO;
}

/** O que a variável tem de errado, para o log de subida avisar. */
export function avisoDoTetoDeGasto(env: NodeJS.ProcessEnv = process.env): string | null {
  const bruto = env.CHATWOOT_DISPARO_TETO_REAIS_DIA;
  if (bruto === undefined || bruto.trim() === '') return null;
  return tetoReaisPorDia(env) === Number(bruto.trim().replace(',', '.')) ? null : `CHATWOOT_DISPARO_TETO_REAIS_DIA="${bruto.slice(0, 20)}" não vale: ficou R$ ${TETO_REAIS_DIA_PADRAO}/dia`;
}

// ── preço de RESERVA: o teto de gasto SEMPRE vale ───────────────────────────────────────────────────────────────

/**
 * Sem histórico da Meta para a categoria (clínica nova no CRM, categoria que a unidade nunca mandou, banco ou câmbio fora), o teto de gasto NÃO pode
 * deixar de valer: usa-se um preço de reserva CONSERVADOR, em reais, por categoria. A ordem de grandeza vem da própria tabela `whatsapp_cost_daily` da
 * rede (3.844 linhas, 14 unidades, 21/08 a 16/11/2026, cobrança regular no Brasil): marketing (MARKETING_LITE) tem mediana de US$ 0,0625 por mensagem
 * (R$ 0,35) mas já chegou a US$ 0,3217 (R$ 1,80) em dias de pouco volume em Boituva, Rio Verde e Bebedouro — 46 de 534 linhas passam de R$ 0,50 —,
 * então a reserva de marketing é R$ 2,00 (acima do pior dia visto); utilidade vai de US$ 0,0068 a US$ 0,035 (R$ 0,20): reserva R$ 0,25.
 * Autenticação não tem NENHUMA linha na rede: R$ 0,25 é a tarifa publicada da Meta (de memória, não conferida na tabela) com folga. Categoria que não é
 * nenhuma das três (ou não gravada) usa a de marketing, a mais cara. Dá para baixar/subir por `CHATWOOT_DISPARO_PRECO_RESERVA_<MARKETING|UTILITY|AUTHENTICATION>`
 * (em reais); valor ilegível, zero ou negativo volta ao padrão — nunca vira «sem preço».
 */
export const PRECO_RESERVA_PADRAO_BRL = { MARKETING: 2, UTILITY: 0.25, AUTHENTICATION: 0.25 } as const;
type FamiliaDeReserva = keyof typeof PRECO_RESERVA_PADRAO_BRL;
const FAMILIAS_DE_RESERVA = Object.keys(PRECO_RESERVA_PADRAO_BRL) as FamiliaDeReserva[];

const familiaDeReserva = (categoria: string | null | undefined): FamiliaDeReserva => {
  const c = (categoria ?? '').trim().toUpperCase();
  return FAMILIAS_DE_RESERVA.find((f) => c.startsWith(f)) ?? 'MARKETING';
};
const lerReserva = (env: NodeJS.ProcessEnv, f: FamiliaDeReserva): { valor: number; valido: boolean; bruto: string | undefined } => {
  const bruto = env[`CHATWOOT_DISPARO_PRECO_RESERVA_${f}`];
  if (bruto === undefined || bruto.trim() === '') return { valor: PRECO_RESERVA_PADRAO_BRL[f], valido: true, bruto };
  const n = Number(bruto.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 1000 ? { valor: n, valido: true, bruto } : { valor: PRECO_RESERVA_PADRAO_BRL[f], valido: false, bruto };
};
/** Reais por mensagem. Sempre um número positivo. */
export const precoDeReservaBrl = (categoria: string | null | undefined, env: NodeJS.ProcessEnv = process.env): number => lerReserva(env, familiaDeReserva(categoria)).valor;
/** O que as variáveis de reserva têm de errado, para o log de subida avisar. */
export function avisosDoPrecoDeReserva(env: NodeJS.ProcessEnv = process.env): string[] {
  return FAMILIAS_DE_RESERVA.map((f) => ({ f, r: lerReserva(env, f) }))
    .filter((x) => !x.r.valido)
    .map((x) => `CHATWOOT_DISPARO_PRECO_RESERVA_${x.f}="${(x.r.bruto ?? '').slice(0, 20)}" não vale: ficou R$ ${PRECO_RESERVA_PADRAO_BRL[x.f]} por mensagem`);
}

// ── preço por mensagem (a tabela de custo da Meta, da própria unidade) ──────────────────────────────────────────

export const DIAS_DA_TABELA_DE_CUSTO = 90;

export interface LinhaDeCusto {
  pricingCategory: string;
  pricingType: string;
  country: string;
  volume: number;
  costUsd: number;
}
export interface PrecoPorMensagem {
  /** dólares por mensagem */
  usd: number;
  /** quantos dias de tabela sustentam o número */
  dias: number;
}

/** A família da categoria na tabela: `MARKETING` cobre `MARKETING_LITE`; o resto é por prefixo igual. */
const familia = (c: string): string => c.trim().toUpperCase();

/** Puro. `null` = a tabela não tem a categoria (custo desconhecido). */
export function precoDaCategoria(linhas: readonly LinhaDeCusto[], categoria: string | null | undefined): PrecoPorMensagem | null {
  const alvo = familia(categoria ?? '');
  if (!alvo) return null;
  const boas = linhas.filter(
    (l) => familia(l.pricingCategory).startsWith(alvo) && l.pricingType.toUpperCase() === 'REGULAR' && (l.country === '' || l.country.toUpperCase() === 'BR') && l.volume >= 5 && l.costUsd > 0,
  );
  if (!boas.length) return null;
  return { usd: Math.max(...boas.map((l) => l.costUsd / l.volume)), dias: boas.length };
}

export async function lerPrecoDaUnidade(unitId: string, categoria: string | null | undefined, agora: Date = new Date()): Promise<PrecoPorMensagem | null> {
  if (!categoria) return null;
  const linhas = await prisma.whatsappCostDaily.findMany({
    // O filtro inteiro vai para o SQL (cobrança regular, Brasil, amostra mínima, custo > 0): sobram poucas linhas (≤ 2 por dia) e o dia mais caro nunca fica de fora de um corte sem ordem.
    where: {
      unitId,
      date: { gte: new Date(agora.getTime() - DIAS_DA_TABELA_DE_CUSTO * 86_400_000) },
      pricingCategory: { startsWith: familia(categoria), mode: 'insensitive' },
      pricingType: { equals: 'REGULAR', mode: 'insensitive' },
      OR: [{ country: { equals: 'BR', mode: 'insensitive' } }, { country: '' }],
      volume: { gte: 5 },
      costUsd: { gt: 0 },
    },
    select: { pricingCategory: true, pricingType: true, country: true, volume: true, costUsd: true },
    orderBy: { date: 'desc' },
    take: 5_000,
  });
  return precoDaCategoria(linhas.map((l) => ({ ...l, costUsd: Number(l.costUsd) })), categoria);
}

let cambioGuardado: { valor: number | null; ate: number } | null = null;
/** O câmbio do Kommo (`cotacaoDoDolar`), guardado 10 min (falha, 1 min). */
export async function cambioDoDia(buscar: () => Promise<number | null> = cotacaoDoDolar, agora = Date.now()): Promise<number | null> {
  if (cambioGuardado && cambioGuardado.ate > agora) return cambioGuardado.valor;
  const valor = await buscar();
  cambioGuardado = { valor, ate: agora + (valor === null ? 60_000 : 600_000) };
  return valor;
}
export const _esquecerCambio = (): void => void (cambioGuardado = null);
/** Só para o teste: fixa o câmbio (sem rede). */
export const _definirCambio = (valor: number | null): void => void (cambioGuardado = { valor, ate: Date.now() + 3_600_000 });

// ── a estimativa ────────────────────────────────────────────────────────────────────────────────────────────────

export interface EstimativaDeCusto {
  /** `false` = sem preço da Meta (ver `reserva`): a tela avisa e a aprovação exige confirmação explícita */
  conhecido: boolean;
  categoria: string | null;
  pessoas: number;
  /** reais, arredondado para cima ao centavo (estimar para baixo seria o erro perigoso) */
  brl: number | null;
  porMensagemBrl: number | null;
  porMensagemUsd: number | null;
  cambio: number | null;
  /** `true` = o CRM não informou a categoria do modelo: a estimativa é pelo preço de MARKETING (a mais cara) e a aprovação exige confirmação */
  categoriaAssumida?: boolean;
  /** `true` = SEM histórico da Meta: o valor é uma estimativa com o preço de RESERVA (conservador); a aprovação exige confirmação explícita */
  reserva: boolean;
  /** de onde veio o preço, ou por que foi usada a reserva */
  nota: string;
}

const centavoParaCima = (v: number): number => Math.ceil(v * 100 - 1e-9) / 100;

export function estimarCusto(a: { pessoas: number; categoria: string | null | undefined; preco: PrecoPorMensagem | null; cambio: number | null; env?: NodeJS.ProcessEnv }): EstimativaDeCusto {
  const base = { categoria: a.categoria ?? null, pessoas: a.pessoas, cambio: a.cambio };
  // Sem preço da Meta: custo estimado com o preço de RESERVA (conservador). Nunca «sem número»: o teto de gasto e o ritmo continuam valendo.
  const comReserva = (porque: string, usd: number | null): EstimativaDeCusto => {
    const porMensagemBrl = precoDeReservaBrl(a.categoria, a.env);
    return { ...base, conhecido: false, reserva: true, brl: centavoParaCima(porMensagemBrl * a.pessoas), porMensagemBrl, porMensagemUsd: usd, nota: `custo estimado com preço de reserva (sem histórico da Meta): ${porque}; reserva de R$ ${porMensagemBrl.toFixed(2).replace('.', ',')} por mensagem, de propósito alta` };
  };
  if (!a.categoria) return comReserva('não sei a categoria do modelo (marketing, utilidade…); usei a mais cara', null);
  if (!a.preco) return comReserva(`a tabela de custo da Meta desta unidade não tem a categoria ${a.categoria} (nenhuma cobrança regular no Brasil nos últimos ${DIAS_DA_TABELA_DE_CUSTO} dias)`, null);
  if (a.cambio === null || !(a.cambio > 0)) return comReserva('não consegui o câmbio do dólar agora', a.preco.usd);
  const porMensagemBrl = a.preco.usd * a.cambio;
  return {
    ...base,
    conhecido: true,
    reserva: false,
    brl: centavoParaCima(porMensagemBrl * a.pessoas),
    porMensagemBrl: centavoParaCima(porMensagemBrl * 1000) / 1000,
    porMensagemUsd: a.preco.usd,
    nota: `${a.categoria}: maior custo por mensagem da tabela da Meta desta unidade (${a.preco.dias} dia(s) nos últimos ${DIAS_DA_TABELA_DE_CUSTO}) × dólar de hoje`,
  };
}

/** A estimativa quando nem dá para ler a tabela (demorou, caiu): só com o preço de reserva. */
export const estimativaDeReserva = (categoria: string | null | undefined, pessoas: number, categoriaAssumida = false): EstimativaDeCusto => comCategoriaAssumida(estimarCusto({ pessoas, categoria: categoriaAssumida ? CATEGORIA_ASSUMIDA : categoria, preco: null, cambio: null }), categoriaAssumida);

/** Preço + câmbio + conta, de uma vez (a leitura do banco e do câmbio ficam aqui). */
export async function estimativaDoDisparo(unitId: string, categoria: string | null | undefined, pessoas: number, categoriaAssumida = false): Promise<EstimativaDeCusto> {
  // categoria assumida = preço de MARKETING (o que a nota promete), seja qual for a que estiver gravada
  const cat = categoriaAssumida ? CATEGORIA_ASSUMIDA : categoria;
  const [preco, cambio] = await Promise.all([lerPrecoDaUnidade(unitId, cat).catch(() => null), cambioDoDia().catch(() => null)]);
  return comCategoriaAssumida(estimarCusto({ pessoas, categoria: cat, preco, cambio }), categoriaAssumida);
}

const CATEGORIA_ASSUMIDA = 'MARKETING';
/** A estimativa mostrada com o preço do NÚMERO (o do teto de gasto): nunca menor que o da própria unidade. Se o preço do número é de RESERVA, a estimativa também vira «reserva» (pede confirmação). */
export function comPrecoDoNumero(e: EstimativaDeCusto, doNumero: { valor: number; reserva: boolean }): EstimativaDeCusto {
  if (e.porMensagemBrl !== null && doNumero.valor <= e.porMensagemBrl && !doNumero.reserva) return e;
  const valor = Math.max(doNumero.valor, e.porMensagemBrl ?? 0);
  return {
    ...e,
    porMensagemBrl: valor,
    brl: centavoParaCima(valor * e.pessoas),
    reserva: e.reserva || doNumero.reserva,
    conhecido: e.conhecido && !doNumero.reserva,
    nota: `${e.nota}; o teto de gasto usa o preço do NÚMERO (o maior entre as unidades que o dividem${doNumero.reserva ? ', sem histórico da Meta numa delas: preço de reserva' : ''})`,
  };
}

export const NOTA_CATEGORIA_ASSUMIDA = 'categoria não informada pelo CRM: estimativa pelo preço de marketing';

/** Categoria assumida: o valor segue (preço de marketing), mas deixa de ser «conhecido» — a tela avisa e a aprovação exige a confirmação explícita. */
export function comCategoriaAssumida(e: EstimativaDeCusto, assumida: boolean): EstimativaDeCusto {
  return assumida ? { ...e, conhecido: false, categoriaAssumida: true, nota: `${NOTA_CATEGORIA_ASSUMIDA}${e.reserva ? ' (e sem histórico da Meta: preço de reserva)' : ''}` } : e;
}

// ── ritmo: em quantos dias termina ──────────────────────────────────────────────────────────────────────────────

export interface Ritmo {
  porHora: number;
  /** quantas saem por dia (o menor entre o teto por dia, o teto por hora × as horas da janela e o teto de gasto) */
  porDia: number;
  horasDaJanela: number;
  /** dias (úteis, se o motor só manda em dia útil) até acabar */
  dias: number;
  soDiasUteis: boolean;
  /** o que limita: 'dia' | 'hora' | 'gasto' */
  limitadoPor: 'dia' | 'hora' | 'gasto';
}

/** A conta ÚNICA do teto de gasto (a rodada e a tela usam esta): quantas mensagens ainda cabem em `tetoReais − gastoBrl` ao preço dado. */
export const mensagensQueCabem = (tetoReais: number, gastoBrl: number, porMensagemBrl: number): number => Math.max(0, Math.floor(Math.max(0, tetoReais - gastoBrl) / porMensagemBrl + 1e-9));

/** Quantas mensagens por dia cabem no teto de gasto num dia SEM gasto (null = sem preço: nunca acontece na rodada, que usa a reserva). */
export const mensagensPorGasto = (tetoReais: number, porMensagemBrl: number | null): number | null => (porMensagemBrl && porMensagemBrl > 0 ? mensagensQueCabem(tetoReais, 0, porMensagemBrl) : null);

export function ritmoDaOnda(a: { pessoas: number; freios: Freios; tetoReais: number; porMensagemBrl: number | null }): Ritmo {
  // o ritmo de um dia CHEIO: usa a mesma conta da rodada (`mensagensQueCabem`), com gasto zero
  const horas = Math.max(1, a.freios.janelaFim - a.freios.janelaInicio);
  const porHoraNaJanela = a.freios.tetoPorHora * horas;
  const gasto = mensagensPorGasto(a.tetoReais, a.porMensagemBrl);
  const candidatos: Array<[Ritmo['limitadoPor'], number]> = [['dia', a.freios.tetoPorDia], ['hora', porHoraNaJanela]];
  if (gasto !== null) candidatos.push(['gasto', gasto]);
  const [limitadoPor, porDia] = candidatos.reduce((m, c) => (c[1] < m[1] ? c : m));
  return { porHora: a.freios.tetoPorHora, porDia, horasDaJanela: horas, dias: porDia > 0 ? Math.ceil(a.pessoas / porDia) : Infinity, soDiasUteis: a.freios.soDiasUteis, limitadoPor };
}

/**
 * Os freios do motor com o teto de gasto: o teto por 24 h nunca passa de `já mandadas nas 24 h + as que ainda cabem em reais`. O que cabe vem de `orcamentoDeGasto`
 * (gasto por categoria das 24 h, não «teto ÷ preço» comparado com a contagem de mensagens de qualquer categoria).
 */
export function freiosComTetoDeGasto(f: Freios, jaMandadasNas24h: number, cabemPeloGasto: number | null): Freios {
  return cabemPeloGasto === null ? f : { ...f, tetoPorDia: Math.min(f.tetoPorDia, jaMandadasNas24h + Math.max(0, cabemPeloGasto)) };
}
