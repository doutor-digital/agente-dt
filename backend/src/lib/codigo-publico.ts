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

/** Conta tentativas por chave; `excedeu` soma uma e diz se passou do teto; `limpar` zera (acertou o código). */
export function criarLimiteDeTentativas(agora: () => number = Date.now) {
  const tentativas = new Map<string, { n: number; desde: number }>();
  return {
    excedeu(chave: string): boolean {
      const t0 = agora();
      const t = tentativas.get(chave);
      if (!t || t0 - t.desde > JANELA_DE_TENTATIVAS_MS) {
        if (tentativas.size > 5000) tentativas.clear();
        tentativas.set(chave, { n: 1, desde: t0 });
        return false;
      }
      t.n += 1;
      return t.n > MAX_DE_TENTATIVAS;
    },
    limpar(chave: string): void {
      tentativas.delete(chave);
    },
  };
}
