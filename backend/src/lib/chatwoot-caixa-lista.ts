/**
 * A listagem de conversas de uma CAIXA, lida uma vez e dividida entre a régua, o CAPI e a agenda (27/11/2026).
 *
 * Antes, cada um dos três varria a caixa inteira (`status=all`, até 41 páginas de 25, uma a uma) no seu próprio ritmo (10, 10 e 15 min): três
 * leituras iguais do mesmo dado. Agora a primeira lê e guarda as páginas; quem chega depois aceita a leitura se ela for mais nova que a
 * VALIDADE que ELE aceita (a régua, que escreve nas conversas, só aceita 60 s; o CAPI e a agenda, que quase não dependem da hora, aceitam
 * mais). Leitura em andamento é junta: dois pedidos ao mesmo tempo viram um só.
 *
 * O que NÃO é feito, de propósito: leitura INCREMENTAL («só as páginas depois da última atividade»). No Chatwoot `last_activity_at` só anda
 * quando nasce MENSAGEM (Message#after_create). Trocar um atributo personalizado (a etapa do cartão!) não mexe nela, então reaproveitar o
 * rabo velho da lista esconderia exatamente o que a régua e a agenda decidem. Daí o prazo curto e inteiro, e não a emenda.
 *
 * As páginas guardadas são as MESMAS que o Chatwoot devolveu (`data.payload`): quem recebe não deve alterá-las.
 */
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

/** Nenhuma leitura guardada vive mais que isto (memória: uma caixa grande são alguns MB de JSON). */
export const VIDA_MAXIMA_MS = 8 * 60_000;

interface Leitura {
  /** só as páginas NÃO vazias, na ordem */
  paginas: unknown[][];
  /** chegou a uma página vazia (a caixa acabou antes do teto) */
  fim: boolean;
  /** quantas páginas ela estava autorizada a ler */
  teto: number;
  iniciouEm: number;
}

interface Entrada {
  pronta?: Leitura;
  andando?: Promise<Leitura>;
  andandoDesde?: number;
  andandoTeto?: number;
}

export interface PaginasLidas {
  paginas: unknown[][];
  /** `maxPaginas` páginas cheias e a caixa seguia: pode haver mais conversas além do teto */
  truncada: boolean;
  /** veio da leitura de outro (ou já guardada), não de uma nova */
  reaproveitada: boolean;
  idadeMs: number;
}

/** Uma loja por `fetch`: o servidor tem um só (as três varreduras usam o mesmo); o teste, com o `fetch` de mentira dele, fica isolado. */
const lojas = new WeakMap<object, Map<string, Entrada>>();

/** Até onde uma leitura vai quando quem a faz aceita menos (a agenda fatia nas 40 primeiras, mas lê como a régua para a leitura servir aos três). */
export const TETO_DA_LEITURA = 200;

export interface OpcoesDaLista {
  /** quantas páginas ESTE pedido recebe (a leitura pode ter ido além: o excedente fica guardado para os outros) */
  maxPaginas: number;
  /** até onde ler quando este pedido é quem lê (padrão `maxPaginas`); a agenda usa `TETO_DA_LEITURA` */
  lerAte?: number;
  /** a leitura guardada só serve se for mais nova que isto */
  validadeMs: number;
  /** quem está pedindo (vai para a conta do log) */
  origem: string;
  agora?: () => number;
  /** injetável no teste; o padrão é `GET conversations` com `status=all` pelo freio de fundo */
  lerPagina?: (pagina: number) => Promise<unknown[]>;
}

const doChatwoot = (ctx: ContextoChatwoot, caixa: number, origem: string) => async (pagina: number): Promise<unknown[]> => {
  const r = (await chamar(ctx, 'GET', 'conversations', {
    query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(pagina) },
    baixa: true,
    origem,
  })) as { data?: { payload?: unknown[] }; payload?: unknown[] } | null;
  const lista = r?.data?.payload ?? r?.payload ?? [];
  return Array.isArray(lista) ? lista : [];
};

/** O que a leitura `l` entrega a quem aceita até `maxPaginas` páginas; null = não dá (a leitura parou antes do teto que ele quer). */
function servir(l: Leitura, maxPaginas: number): { paginas: unknown[][]; truncada: boolean } | null {
  const n = l.paginas.length;
  // a caixa acabou numa página vazia que ELE também leria (a vazia seria a página n+1)
  if (l.fim && n + 1 <= maxPaginas) return { paginas: l.paginas, truncada: false };
  // encheu `maxPaginas` páginas e (para ele) não chegou ao fim
  if (n >= maxPaginas) return { paginas: l.paginas.slice(0, maxPaginas), truncada: true };
  // ele quer mais páginas do que a leitura teve permissão de ler
  return null;
}

export async function paginasDaCaixa(ctx: ContextoChatwoot, caixa: number, o: OpcoesDaLista): Promise<PaginasLidas> {
  const agora = o.agora ?? Date.now;
  let loja = lojas.get(ctx.fetch);
  if (!loja) lojas.set(ctx.fetch, (loja = new Map()));
  const t = agora();
  for (const [k, e] of loja) if (e.pronta && !e.andando && t - e.pronta.iniciouEm > VIDA_MAXIMA_MS) loja.delete(k);
  const chave = `${ctx.conta?.url ?? ''}|${ctx.conta?.conta ?? ''}|${caixa}`;
  const entrada = loja.get(chave);

  const pronta = entrada?.pronta;
  if (pronta && t - pronta.iniciouEm <= o.validadeMs) {
    const s = servir(pronta, o.maxPaginas);
    if (s) return { ...s, reaproveitada: true, idadeMs: t - pronta.iniciouEm };
  }
  if (entrada?.andando && t - (entrada.andandoDesde ?? t) <= o.validadeMs && (entrada.andandoTeto ?? 0) >= o.maxPaginas) {
    const inicio = entrada.andandoDesde ?? t;
    const l = await entrada.andando; // falha da leitura de outro é falha dele também (como se tivesse lido): quem chamou já trata
    const s = servir(l, o.maxPaginas);
    if (s) return { ...s, reaproveitada: true, idadeMs: Math.max(0, agora() - inicio) };
  }

  const ler = o.lerPagina ?? doChatwoot(ctx, caixa, o.origem);
  const e: Entrada = entrada ?? {};
  loja.set(chave, e);
  const iniciouEm = t;
  const teto = Math.max(o.maxPaginas, o.lerAte ?? 0);
  const andando = (async (): Promise<Leitura> => {
    const paginas: unknown[][] = [];
    let fim = false;
    for (let p = 1; p <= teto; p++) {
      const pagina = await ler(p);
      if (pagina.length === 0) {
        fim = true;
        break;
      }
      paginas.push(pagina);
    }
    return { paginas, fim, teto, iniciouEm };
  })();
  e.andando = andando;
  e.andandoDesde = iniciouEm;
  e.andandoTeto = teto;
  try {
    const l = await andando;
    // a leitura que acabou de chegar só vira «a guardada» se for mais nova que a que já está lá (duas leituras sobrepostas)
    if (!e.pronta || l.iniciouEm >= e.pronta.iniciouEm) e.pronta = l;
    const s = servir(l, o.maxPaginas)!; // leu até o próprio teto: sempre serve
    return { ...s, reaproveitada: false, idadeMs: 0 };
  } finally {
    if (e.andando === andando) {
      delete e.andando;
      delete e.andandoDesde;
      delete e.andandoTeto;
    }
  }
}

/** Só para teste. */
export function esquecerListasDaCaixa(ctx: ContextoChatwoot): void {
  lojas.delete(ctx.fetch);
}
