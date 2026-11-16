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
    where: { unitId, date: { gte: new Date(agora.getTime() - DIAS_DA_TABELA_DE_CUSTO * 86_400_000) }, pricingCategory: { startsWith: familia(categoria), mode: 'insensitive' } },
    select: { pricingCategory: true, pricingType: true, country: true, volume: true, costUsd: true },
    take: 2_000,
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
  /** `false` = não dá para saber: a tela diz «custo desconhecido» e a aprovação exige confirmação explícita */
  conhecido: boolean;
  categoria: string | null;
  pessoas: number;
  /** reais, arredondado para cima ao centavo (estimar para baixo seria o erro perigoso) */
  brl: number | null;
  porMensagemBrl: number | null;
  porMensagemUsd: number | null;
  cambio: number | null;
  /** por que é desconhecido, ou de onde veio o preço */
  nota: string;
}

const centavoParaCima = (v: number): number => Math.ceil(v * 100 - 1e-9) / 100;

export function estimarCusto(a: { pessoas: number; categoria: string | null | undefined; preco: PrecoPorMensagem | null; cambio: number | null }): EstimativaDeCusto {
  const base = { categoria: a.categoria ?? null, pessoas: a.pessoas, cambio: a.cambio };
  if (!a.categoria) return { ...base, conhecido: false, brl: null, porMensagemBrl: null, porMensagemUsd: null, nota: 'não sei a categoria do modelo (marketing, utilidade…) — custo desconhecido' };
  if (!a.preco) return { ...base, conhecido: false, brl: null, porMensagemBrl: null, porMensagemUsd: null, nota: `a tabela de custo da Meta desta unidade não tem a categoria ${a.categoria} (nenhuma cobrança regular no Brasil nos últimos ${DIAS_DA_TABELA_DE_CUSTO} dias) — custo desconhecido` };
  if (a.cambio === null || !(a.cambio > 0)) return { ...base, conhecido: false, brl: null, porMensagemBrl: null, porMensagemUsd: a.preco.usd, nota: 'não consegui o câmbio do dólar agora — custo em reais desconhecido' };
  const porMensagemBrl = a.preco.usd * a.cambio;
  return {
    ...base,
    conhecido: true,
    brl: centavoParaCima(porMensagemBrl * a.pessoas),
    porMensagemBrl: centavoParaCima(porMensagemBrl * 1000) / 1000,
    porMensagemUsd: a.preco.usd,
    nota: `${a.categoria}: maior custo por mensagem da tabela da Meta desta unidade (${a.preco.dias} dia(s) nos últimos ${DIAS_DA_TABELA_DE_CUSTO}) × dólar de hoje`,
  };
}

/** Preço + câmbio + conta, de uma vez (a leitura do banco e do câmbio ficam aqui). */
export async function estimativaDoDisparo(unitId: string, categoria: string | null | undefined, pessoas: number): Promise<EstimativaDeCusto> {
  const [preco, cambio] = await Promise.all([lerPrecoDaUnidade(unitId, categoria).catch(() => null), cambioDoDia().catch(() => null)]);
  return estimarCusto({ pessoas, categoria, preco, cambio });
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

/** Quantas mensagens por dia cabem no teto de gasto (null = preço desconhecido: o gasto não limita, as outras travas valem). */
export const mensagensPorGasto = (tetoReais: number, porMensagemBrl: number | null): number | null => (porMensagemBrl && porMensagemBrl > 0 ? Math.floor(tetoReais / porMensagemBrl) : null);

export function ritmoDaOnda(a: { pessoas: number; freios: Freios; tetoReais: number; porMensagemBrl: number | null }): Ritmo {
  const horas = Math.max(1, a.freios.janelaFim - a.freios.janelaInicio);
  const porHoraNaJanela = a.freios.tetoPorHora * horas;
  const gasto = mensagensPorGasto(a.tetoReais, a.porMensagemBrl);
  const candidatos: Array<[Ritmo['limitadoPor'], number]> = [['dia', a.freios.tetoPorDia], ['hora', porHoraNaJanela]];
  if (gasto !== null) candidatos.push(['gasto', gasto]);
  const [limitadoPor, porDia] = candidatos.reduce((m, c) => (c[1] < m[1] ? c : m));
  return { porHora: a.freios.tetoPorHora, porDia, horasDaJanela: horas, dias: porDia > 0 ? Math.ceil(a.pessoas / porDia) : Infinity, soDiasUteis: a.freios.soDiasUteis, limitadoPor };
}

/** Os freios do motor com o teto de gasto: o teto por 24 h nunca passa de `tetoReais / preço por mensagem` (preço desconhecido: só as outras travas). */
export function freiosComTetoDeGasto(f: Freios, tetoReais: number, porMensagemBrl: number | null): Freios {
  const cabem = mensagensPorGasto(tetoReais, porMensagemBrl);
  return cabem === null ? f : { ...f, tetoPorDia: Math.min(f.tetoPorDia, Math.max(0, cabem)) };
}
