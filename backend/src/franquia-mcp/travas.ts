/**
 * As regras do Guia de Integração Spine 1.9.3, aplicadas ANTES de chamar a franquia.
 * Um 400 da franquia custa uma requisição e não ensina nada; um erro aqui custa zero.
 */

/** Erro de quem chamou a ferramenta (data errada, período grande demais). Não é falha da franquia. */
export class ErroDeEntrada extends Error {}

/**
 * O guia (§9.3) fala em "máximo 100 dias", sem dizer se o intervalo conta os dois extremos,
 * e algumas rotas pedem o fim como dia seguinte (agenda: fim exclusivo). 90 deixa folga
 * pras duas dúvidas sem custar muito: um ano vira 5 fatias em vez de 4.
 */
export const MAX_DIAS_FATIA = 90;
/**
 * §6: o máximo é sempre 100. O §12 recomenda 50, mas aqui o que pesa pra franquia é o NÚMERO de
 * requisições: 100 por página lê o mesmo dado com metade das chamadas.
 */
export const LINHAS_POR_PAGINA = 100;

const DIA = 86_400_000;
const FORMATO_DATA = /^\d{4}-\d{2}-\d{2}$/;

/** Confere `YYYY-MM-DD` E que o dia existe — `2026-02-30` passa no formato e não é data. */
export function validarData(valor: string, campo: string): string {
  if (!FORMATO_DATA.test(valor)) {
    throw new ErroDeEntrada(`${campo}: use o formato AAAA-MM-DD (recebi "${valor}")`);
  }
  const t = Date.parse(`${valor}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== valor) {
    throw new ErroDeEntrada(`${campo}: "${valor}" não é uma data que existe`);
  }
  return valor;
}

export function somarDias(data: string, dias: number): string {
  return new Date(Date.parse(`${data}T00:00:00Z`) + dias * DIA).toISOString().slice(0, 10);
}

/** Quantos dias o período cobre, contando os dois extremos: 01/01 a 01/01 é 1 dia. */
export function diasNoPeriodo(inicio: string, fim: string): number {
  return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / DIA) + 1;
}

export interface Fatia {
  inicio: string;
  fim: string;
}

/**
 * Quebra o período em fatias de até `max` dias (extremos inclusos), contíguas: o fim de uma
 * é a véspera do início da próxima. Sem buraco e sem dia repetido, senão o total soma errado.
 */
export function fatiarPeriodo(inicio: string, fim: string, max = MAX_DIAS_FATIA): Fatia[] {
  validarData(inicio, 'inicio');
  validarData(fim, 'fim');
  if (inicio > fim) throw new ErroDeEntrada(`inicio (${inicio}) é depois do fim (${fim})`);
  if (!Number.isInteger(max) || max < 1) throw new Error(`max de dias inválido: ${max}`);

  const fatias: Fatia[] = [];
  let cursor = inicio;
  while (cursor <= fim) {
    const candidato = somarDias(cursor, max - 1);
    const fimFatia = candidato < fim ? candidato : fim;
    fatias.push({ inicio: cursor, fim: fimFatia });
    cursor = somarDias(fimFatia, 1);
  }
  return fatias;
}

/**
 * Busca de texto: mínimo 2 caracteres (§9.3). Vazio vira "sem filtro" (undefined), não erro:
 * quem manda `nome: ""` quer dizer "não filtra por nome".
 */
export function validarTexto(valor: string | undefined, campo: string): string | undefined {
  if (valor === undefined) return undefined;
  const limpo = valor.trim();
  if (limpo === '') return undefined;
  if (limpo.length < 2) throw new ErroDeEntrada(`${campo}: a franquia exige pelo menos 2 caracteres`);
  return limpo;
}
