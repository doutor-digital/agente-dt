/**
 * Números internos: gente da rede que NUNCA vira lead na franquia.
 *
 * Funcionárias das clínicas, a equipe da Doutor Digital, números de teste e de alerta, e quem faz
 * prospecção de marketing também escrevem para a Sofia. Com a regra "toda pessoa que entra em
 * contato vira lead na franquia" (27/10/2026), cada uma delas apareceria na base da franqueadora.
 *
 * COMO SE EDITA: variável de ambiente `NUMEROS_INTERNOS`, csv. Trocar o valor e reiniciar o
 * contêiner basta — não há deploy de código nem migração. Cada item é um telefone em qualquer
 * formato ("+55 (98) 99999-9464", "98999999464"), opcionalmente com um rótulo antes dos dois-pontos
 * ("joao:98999999464"): o rótulo é só para quem lê o `.env`.
 *
 * COMO SE COMPARA: pelos ÚLTIMOS 8 DÍGITOS. É o que sobrevive ao DDI, ao 0 do DDD e ao nono
 * dígito — o WhatsApp de alguns números chega com o 9 e de outros sem.
 *
 * ITEM CURTO NÃO VALE. Um item com menos de 8 dígitos é ignorado (e avisado no log): casar por 4
 * dígitos pegaria 1 paciente de cada 10 mil por item, e marcar a mãe de alguém como "interna" some
 * com ela da base sem ninguém ver. É por isso que a lista começa vazia no código: os números
 * completos moram no `.env` da VPS, não aqui.
 */
import { logger } from './logger.js';

/** Quantos dígitos finais identificam um telefone. */
export const DIGITOS_DA_CHAVE = 8;

/**
 * O que se sabe hoje: SÓ o final de cada número interno. Serve de documentação e de insumo de teste —
 * NÃO é usado para decidir nada em produção (4 dígitos não identificam ninguém). Quem opera precisa
 * pôr os números completos em `NUMEROS_INTERNOS`.
 */
export const SEMENTE_CONHECIDA: ReadonlyArray<{ quem: string; final: string }> = [
  { quem: 'João', final: '9464' },
  { quem: 'João (segundo número)', final: '1043' },
  { quem: 'WhatsApp de alertas', final: '3638' },
  { quem: 'Suzanne', final: '1248' },
  { quem: 'Scroows Marketing Digital', final: '6240' },
];

/** Os últimos 8 dígitos do telefone, ou `null` se não há 8 dígitos para comparar. */
export function ultimos8(telefone: unknown): string | null {
  if (telefone === null || telefone === undefined) return null;
  const digitos = String(telefone).replace(/\D/g, '');
  if (digitos.length < DIGITOS_DA_CHAVE) return null;
  return digitos.slice(-DIGITOS_DA_CHAVE);
}

export interface ListaDeInternos {
  chaves: Set<string>;
  /** Itens que não deram 8 dígitos — ficam fora da lista e aparecem no log. */
  ignorados: string[];
}

let memoRaw: string | undefined;
let memoLista: ListaDeInternos | null = null;

/** Lê o csv. Memoriza por valor: o `.env` não muda dentro de um processo, mas o teste muda. */
export function lerNumerosInternos(raw: string | undefined = process.env.NUMEROS_INTERNOS): ListaDeInternos {
  if (memoLista && memoRaw === raw) return memoLista;
  const chaves = new Set<string>();
  const ignorados: string[] = [];
  const bruto = (raw ?? '').replace(/^['"]|['"]$/g, '');
  for (const item of bruto.split(',')) {
    const t = item.trim();
    if (!t) continue;
    const numero = t.includes(':') ? t.slice(t.lastIndexOf(':') + 1) : t;
    const chave = ultimos8(numero);
    if (chave) chaves.add(chave);
    else ignorados.push(t);
  }
  if (ignorados.length) {
    logger.warn(
      { ignorados: ignorados.map((i) => `…${i.replace(/\D/g, '').slice(-4)}`) },
      'numeros-internos: item(ns) com menos de 8 dígitos ignorado(s) em NUMEROS_INTERNOS — ponha o número completo',
    );
  }
  memoRaw = raw;
  memoLista = { chaves, ignorados };
  return memoLista;
}

/** Este telefone é de alguém da rede? Telefone ilegível (menos de 8 dígitos) não é. */
export function ehNumeroInterno(telefone: unknown, raw: string | undefined = process.env.NUMEROS_INTERNOS): boolean {
  const chave = ultimos8(telefone);
  return chave !== null && lerNumerosInternos(raw).chaves.has(chave);
}
