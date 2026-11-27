/**
 * Como o `GET /funil/menu.js` sai pela rede (o CRM inteiro espera por este arquivo: selo da Sofia, barra por papel, Funil, assistente, Resolver).
 *
 * O CONTEÚDO não muda aqui: `montarMenuJs` continua sendo a única fonte (e os testes que fixam o hash dele valem). Aqui só mudam os bytes do caminho:
 *  - compressão (gzip e brotli): ~146 KB viram ~40 KB / ~34 KB. Não vem de middleware nem de pacote novo: é o `zlib` do Node, feito UMA vez por conteúdo;
 *  - ETag FORTE (hash do conteúdo, um por codificação) e 304 em `If-None-Match`: quem já tem o arquivo só confere, não baixa;
 *  - `stale-while-revalidate`: passados os 5 min o navegador roda a cópia que tem NA HORA e confere por trás (antes parava e esperava a rede).
 *
 * Cache: o conteúdo é regerado a cada pedido (0,6 ms medidos) e o que custa (hash, gzip, brotli q11 ≈ 150 ms) fica guardado por IGUALDADE do conteúdo.
 * Assim a invalidação é exata — mudou a lista de contas sem antecipado, o mapa de domínios, o env: o texto muda e o preparo se refaz; nenhum TTL, nenhuma
 * lista de «o que invalida» para esquecer.
 */
import { createHash } from 'node:crypto';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { Request, Response } from 'express';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/**
 * 5 min «frescos» (como era) + 1 dia em que o navegador pode rodar a cópia velha enquanto confere a nova por trás. O preço: depois dos 5 min, um conserto (ou um
 * desligamento por chave) só chega no PRÓXIMO carregamento de cada pessoa, não no primeiro. Para voltar atrás mais rápido, baixe o número aqui.
 */
export const CACHE_DO_MENU_JS = 'public, max-age=300, stale-while-revalidate=86400';

export type Codificacao = 'br' | 'gzip' | 'identity';

export interface MenuJsPronto {
  /** o hash do conteúdo (sem aspas); cada codificação leva o seu sufixo no ETag, porque os bytes de cada uma são outros */
  hash: string;
  bytes: Record<Codificacao, Buffer>;
}

/**
 * A melhor codificação que o navegador aceita, com br à frente de gzip no empate. Lê `Accept-Encoding` com q-values («gzip;q=0, br» = sem gzip);
 * sem o cabeçalho, ou com só `identity`, sai sem compressão.
 */
export function escolherCodificacao(acceptEncoding: string | undefined): Codificacao {
  if (!acceptEncoding) return 'identity';
  const q: Record<string, number> = {};
  for (const parte of acceptEncoding.toLowerCase().split(',')) {
    const [nome, ...params] = parte.trim().split(';');
    if (!nome) continue;
    const bruto = params.join(';').trim();
    // sem `q=` vale 1; `q=` malformado vale 0 (na dúvida, sem compressão); o resto fica entre 0 e 1 (RFC 9110)
    const m = /^q\s*=\s*(\d(?:\.\d{0,3})?)$/.exec(bruto);
    q[nome.trim()] = !bruto ? 1 : m ? Math.min(1, Number(m[1])) : 0;
  }
  const peso = (n: string): number => q[n] ?? q['*'] ?? 0;
  const br = peso('br'), gz = peso('gzip');
  if (br > 0 && br >= gz) return 'br';
  if (gz > 0) return 'gzip';
  return 'identity';
}

/** Os últimos conteúdos preparados (poucos: o conteúdo pode alternar entre dois valores se o banco oscilar; cada troca refazer o brotli seria 150 ms de CPU). */
const MEMO_MAX = 4;
const memo = new Map<string, Promise<MenuJsPronto>>();

/**
 * Hash e compressões do conteúdo, feitos uma vez por texto (pedidos simultâneos dividem a mesma promessa). Nunca lança. Se uma compressão falhar, este
 * pedido sai sem compressão mas o resultado NÃO fica guardado: o próximo pedido tenta de novo (uma falha passageira não vale até o próximo deploy).
 */
export function prepararMenuJs(conteudo: string): Promise<MenuJsPronto> {
  const guardado = memo.get(conteudo);
  if (guardado) return guardado;
  const cru = Buffer.from(conteudo, 'utf8');
  const estado = { falhou: false };
  const pronto = (async (): Promise<MenuJsPronto> => {
    const hash = createHash('sha256').update(cru).digest('base64url').slice(0, 27);
    const cair = (): Buffer => { estado.falhou = true; return cru; };
    const [gz, br] = await Promise.all([
      gzipAsync(cru, { level: 9 }).catch(cair),
      brotliAsync(cru, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: cru.length } }).catch(cair),
    ]);
    return { hash, bytes: { identity: cru, gzip: gz, br } };
  })();
  memo.set(conteudo, pronto);
  void pronto.then(() => { if (estado.falhou && memo.get(conteudo) === pronto) memo.delete(conteudo); });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  return pronto;
}

/** Para os testes: esquece o preparo guardado. */
export function _esquecerMenuJsPronto(): void {
  memo.clear();
}

/** Manda o `menu.js` já comprimido, com ETag forte (e o 304 do Express quando `If-None-Match` bate). */
export async function servirMenuJs(req: Request, res: Response, conteudo: string): Promise<void> {
  const pronto = await prepararMenuJs(conteudo);
  let cod = escolherCodificacao(req.headers?.['accept-encoding'] as string | undefined);
  // compressão que falhou virou o texto cru em `prepararMenuJs`: nunca anuncia gzip/br em cima de bytes sem compressão
  if (cod !== 'identity' && pronto.bytes[cod] === pronto.bytes.identity) cod = 'identity';
  res
    // o charset vai escrito: com corpo em Buffer o Express não o acrescenta (o arquivo tem acentos e emojis)
    .type('application/javascript; charset=utf-8')
    .set('Cache-Control', CACHE_DO_MENU_JS)
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .set('ETag', `"${pronto.hash}${cod === 'identity' ? '' : '-' + cod}"`);
  // o CORS já põe `Vary: Origin`; a resposta também varia pela codificação (cache do navegador e de qualquer proxy no meio)
  res.vary('Accept-Encoding');
  if (cod !== 'identity') res.set('Content-Encoding', cod);
  res.send(pronto.bytes[cod]);
}
