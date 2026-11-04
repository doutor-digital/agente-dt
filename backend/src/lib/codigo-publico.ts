/**
 * A porta das páginas públicas da recepção (`/pausa`, `/alta`, `/ia`): código de 6 dígitos da unidade
 * (`units.pausa_codigo`), comparação em tempo constante e limite de 12 tentativas por ip+unidade a cada 10 min.
 * É o mesmo desenho da `/pausa/:slug`; a `/ia/:slug` usa daqui para não ganhar uma terceira cópia.
 */
import { timingSafeEqual } from 'node:crypto';

export const JANELA_DE_TENTATIVAS_MS = 10 * 60_000;
export const MAX_DE_TENTATIVAS = 12;

export function codigoConfere(esperado: string | null | undefined, recebido: unknown): boolean {
  if (!esperado || typeof recebido !== 'string') return false;
  const limpo = recebido.trim();
  if (limpo.length > 12) return false; // cortar em 12 aceitaria "123456      lixo"
  const a = Buffer.from(esperado.padEnd(12, ' '));
  const b = Buffer.from(limpo.padEnd(12, ' '));
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_DE_CHAVES = 5000;

/**
 * Conta só os ERROS de código, por chave (ip+unidade). Quem chama:
 *   1. acha a unidade (slug que não existe dá 404 e NÃO entra aqui: senão ~5.000 slugs inventados lotariam o mapa);
 *   2. `bloqueado(chave)` → 429 (antes de conferir o código, para não servir de gabarito);
 *   3. código errado → `registrarErro(chave)`; código certo → `limpar(chave)`.
 * O mapa tem teto: ao chegar nele só saem as chaves VENCIDAS (nunca zera o contador de quem ainda está na janela);
 * se mesmo assim não houver vaga, sai a mais antiga, uma de cada vez.
 */
export function criarLimiteDeTentativas(agora: () => number = Date.now, maxChaves = MAX_DE_CHAVES) {
  const erros = new Map<string, { n: number; desde: number }>();
  const vencida = (t: { desde: number }, t0: number) => t0 - t.desde > JANELA_DE_TENTATIVAS_MS;
  const abrirVaga = (t0: number) => {
    if (erros.size < maxChaves) return;
    for (const [k, v] of erros) if (vencida(v, t0)) erros.delete(k);
    if (erros.size >= maxChaves) {
      const maisAntiga = erros.keys().next().value;
      if (maisAntiga !== undefined) erros.delete(maisAntiga);
    }
  };
  return {
    /** Já errou o código vezes demais nesta janela? */
    bloqueado(chave: string): boolean {
      const t = erros.get(chave);
      if (!t) return false;
      if (vencida(t, agora())) {
        erros.delete(chave);
        return false;
      }
      return t.n >= MAX_DE_TENTATIVAS;
    },
    registrarErro(chave: string): void {
      const t0 = agora();
      const t = erros.get(chave);
      if (t && !vencida(t, t0)) {
        t.n += 1;
        return;
      }
      erros.delete(chave);
      abrirVaga(t0);
      erros.set(chave, { n: 1, desde: t0 });
    },
    limpar(chave: string): void {
      erros.delete(chave);
    },
    /** só para teste */
    tamanho: () => erros.size,
  };
}
