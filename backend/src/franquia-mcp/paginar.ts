/**
 * Ler uma busca paginada inteira (§6: `page` começa em 1, máximo 100 por página).
 *
 * O ENVELOPE NÃO É O DO GUIA. O guia mostra `{ success, data: [...], total, totalPages }`;
 * a franquia de verdade responde `{ status, data: { data: [...], total, totalPages } }`
 * (medido pelo agente em produção). Aceitamos os dois — e qualquer outro formato é ERRO,
 * nunca "zero resultados": um relatório que diz "nenhum agendamento" porque não entendeu
 * a resposta é pior do que um relatório que falha.
 */
import { ErroSpine } from './cliente.js';
import { OrcamentoEsgotado } from './ritmo.js';

export interface Pagina {
  itens: unknown[];
  total: number | null;
  /** `null` quando a franquia não mandou `totalPages` */
  totalPaginas: number | null;
}

function numero(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function lerPagina(resposta: unknown): Pagina {
  const raiz = resposta as Record<string, unknown> | null;
  const meio = raiz?.data as Record<string, unknown> | unknown[] | null | undefined;

  let corpo: Record<string, unknown> | null = null;
  let itens: unknown[] | null = null;
  if (meio && !Array.isArray(meio) && Array.isArray(meio.data)) {
    corpo = meio; // formato real: { data: { data: [...] } }
    itens = meio.data as unknown[];
  } else if (Array.isArray(meio)) {
    corpo = raiz; // formato do guia: { data: [...] }
    itens = meio;
  }
  if (!itens || !corpo) throw new ErroSpine('a franquia respondeu num formato que este MCP não reconhece');

  const totalPaginas = numero(corpo.totalPages);
  return { itens, total: numero(corpo.total), totalPaginas: totalPaginas === null ? null : Math.max(1, totalPaginas) };
}

export interface Lidos {
  itens: unknown[];
  /** O `total` que a franquia diz ter (da 1ª página). Pode ser maior que `itens` se truncou. */
  totalInformado: number | null;
  paginas: number;
  truncado: boolean;
  motivoTruncado?: string;
}

/**
 * Pede página por página. Sabe que acabou por `totalPages`; se a franquia não mandar, usa
 * `total` (lidos < total → continua); sem os dois, continua enquanto a página vier cheia.
 * Nunca "assume 1 página" em silêncio: isso cortaria o relatório sem avisar.
 *
 * Para no `tetoPaginas` ou quando a cota da unidade acaba, e nos dois casos marca `truncado`:
 * quem lê o resultado precisa saber que o número é um mínimo, não o total.
 */
export async function lerTudo(
  buscar: (pagina: number) => Promise<unknown>,
  tetoPaginas: number,
  linhasPorPagina: number,
): Promise<Lidos> {
  const itens: unknown[] = [];
  let totalInformado: number | null = null;
  let pagina = 1;

  for (;;) {
    let lida: Pagina;
    try {
      lida = lerPagina(await buscar(pagina));
    } catch (e) {
      // sem cota na 1ª página não há o que devolver; nas seguintes, devolve o que já leu
      if (e instanceof OrcamentoEsgotado && pagina > 1) {
        return { itens, totalInformado, paginas: pagina - 1, truncado: true, motivoTruncado: e.message };
      }
      throw e;
    }
    if (pagina === 1) totalInformado = lida.total;
    itens.push(...lida.itens);

    const haMais =
      lida.totalPaginas !== null
        ? pagina < lida.totalPaginas
        : totalInformado !== null
          ? itens.length < totalInformado && lida.itens.length > 0
          : lida.itens.length >= linhasPorPagina;
    if (!haMais) return { itens, totalInformado, paginas: pagina, truncado: false };
    if (pagina >= tetoPaginas) {
      const tem = lida.totalPaginas !== null ? ` (a franquia tem ${lida.totalPaginas})` : '';
      return { itens, totalInformado, paginas: pagina, truncado: true, motivoTruncado: `parou no teto de ${tetoPaginas} páginas${tem}` };
    }
    pagina++;
  }
}
