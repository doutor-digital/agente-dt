/**
 * Central do João — fase 1b: menções e não lidas do WhatsApp Web PESSOAL do João viram chamado (pedido de 11/11/2026: "muitas me
 * mencionam e eu não consigo ver"). A extensão lê só a LISTA de conversas (nome + prévia da última mensagem + selo de não lida /
 * de menção), nunca abre conversa sozinha, e manda só esse trecho. Aqui mora a regra, pura (sem banco e sem rede; o I/O fica em
 * `central-chamados-banco.ts`).
 *
 * LGPD: e-mail, cartão, CNPJ, CPF e telefone (régua de `pii.ts`) e qualquer outra sequência longa de dígitos são mascarados antes de gravar; o trecho é curto; o nome da
 * conversa, se for um número (contato não salvo), também é mascarado. Fechado há mais de 30 dias é apagado.
 */
import { createHmac } from 'node:crypto';
import { mascararPii } from './pii.js';

export type TipoChamado = 'mencao' | 'nao_lida' | 'manual';
export const TIPOS_CHAMADO: readonly TipoChamado[] = ['mencao', 'nao_lida', 'manual'];

/** Tamanho de cada trecho (um sinal) e do acumulado de um chamado aberto (os sinais seguintes da mesma conversa vão sendo anexados). */
export const MAX_TRECHO = 280;
export const MAX_ACUMULADO = 2000;
/** Fechado (feito, vista ou expirado) há mais que isso é apagado. */
export const DIAS_GUARDA = 30;
/** Não lida aberta sem sinal novo há mais que isso vira `vista` (o João leu num lugar que a extensão não viu: celular). */
export const DIAS_NAO_LIDA_ABERTA = 3;
/** Qualquer chamado aberto sem sinal novo há mais que isso vira `expirado` (e depois é apagado como os fechados). */
export const DIAS_ABERTO = 30;


const CONTROLE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Máscara do que vai para o banco: a régua de `pii.ts` (cartão, CNPJ, CPF, e-mail, telefone com DDD) e, por cima, toda sequência que
 * sobrou com 8+ dígitos (com espaço, ponto, traço ou parênteses no meio) vira "…" + 4 últimos. A barra fica de fora de propósito:
 * data (12/11/2026) não é telefone.
 */
export function mascararDigitos(s: string): string {
  return mascararPii(s, { exigirDdd: true }).replace(/\+?\d[\d\s().\-]{6,}\d/g, (m) => {
    const d = m.replace(/\D/g, '');
    return d.length >= 8 ? `…${d.slice(-4)}` : m;
  });
}

/** Trecho que a extensão mandou: sem caractere de controle, espaços juntados, dígitos longos mascarados, no máximo MAX_TRECHO. */
export function limparTrecho(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = mascararDigitos(v.replace(CONTROLE, ' ').replace(/\s+/g, ' ').trim());
  return s.length > MAX_TRECHO ? `${s.slice(0, MAX_TRECHO - 1)}…` : s;
}

/** Nome da conversa como o WhatsApp mostra, normalizado (é a base da chave: a mesma conversa cai no mesmo chamado aberto). */
export function nomeNormalizado(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(CONTROLE, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return s || null;
}

/** O nome que fica gravado e aparece: contato não salvo (o título é o número) vira "…1234". */
export function nomeParaMostrar(normalizado: string): string {
  return mascararDigitos(normalizado).slice(0, 80);
}

/** Chave da conversa no banco (HMAC do nome em minúsculas): agrupa os sinais sem guardar o número de contato não salvo. */
export function chaveDaConversa(normalizado: string, segredo: string): string {
  return createHmac('sha256', segredo).update(`central-conversa:${normalizado.toLowerCase()}`).digest('hex');
}

/** Anexa o trecho novo ao acumulado (se ainda não está lá), guardando o FIM quando passa de MAX_ACUMULADO. */
export function juntarTrecho(acumulado: string, novo: string): string {
  if (!novo || acumulado.split('\n').includes(novo)) return acumulado;
  const junto = acumulado ? `${acumulado}\n${novo}` : novo;
  if (junto.length <= MAX_ACUMULADO) return junto;
  const corte = junto.slice(junto.length - MAX_ACUMULADO);
  const quebra = corte.indexOf('\n');
  return quebra >= 0 ? corte.slice(quebra + 1) : corte;
}

/** Um chamado só por conversa aberta: o tipo fica o mais forte que já apareceu (manual > menção > não lida). */
const FORCA: Record<TipoChamado, number> = { nao_lida: 0, mencao: 1, manual: 2 };
export function tipoMaisForte(a: TipoChamado, b: TipoChamado): TipoChamado {
  return FORCA[b] > FORCA[a] ? b : a;
}

export interface SinalLimpo {
  normalizado: string;
  conversa: string;
  grupo: boolean;
  tipo: TipoChamado;
  trecho: string;
  naoLidas: number;
}

/** Valida um sinal cru da extensão. Sem nome = descartado. */
export function limparSinal(v: unknown): SinalLimpo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const normalizado = nomeNormalizado(o.conversa);
  const tipo = TIPOS_CHAMADO.find((t) => t === o.tipo);
  if (!normalizado || !tipo) return null;
  const n = Number(o.naoLidas);
  return {
    normalizado,
    conversa: nomeParaMostrar(normalizado),
    grupo: o.grupo === true,
    tipo,
    trecho: limparTrecho(o.trecho),
    naoLidas: Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 9999) : 0,
  };
}
