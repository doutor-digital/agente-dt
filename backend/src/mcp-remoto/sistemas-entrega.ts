/**
 * O que `sistemas-anexo.ts` (comprovante de lançamento) e `sistemas-documento.ts` (documento de colaborador, empresa, paciente, cliente) têm em comum na
 * ENTREGA de um arquivo ao servidor do sistema: o nome que vai no corpo e o que fazer com o arquivo do cofre conforme a resposta.
 */
import { ErroSistemas } from '../lib/integracoes/sistemas.js';

/** Nome de arquivo que vai para o sistema: só o último trecho, sem barras, sem '..', sem caractere de controle. */
export function nomeLimpo(bruto: string): string {
  const base = bruto.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.{2,}/g, '.').trim().slice(0, 100);
}

/** O servidor leu o pedido e disse não por causa do pedido (formato, repetido, tamanho, tipo): repetir o mesmo arquivo não adianta. */
const RECUSAS_DEFINITIVAS = new Set([400, 409, 413, 415, 422]);

export interface ResultadoDaEntrega<R> {
  /** o servidor respondeu com aceite ou com recusa da REGRA dele: o arquivo não tem mais o que fazer no cofre. false = o arquivo fica. */
  definitivo: boolean;
  resposta?: R;
  erro?: ErroSistemas | Error;
  /** 404: servidor desatualizado (sem a rota) ou registro que sumiu. Nada foi gravado; o arquivo fica. */
  desatualizado?: boolean;
  /** outro 4xx (chave, 408, 429…): falha do momento; nada foi gravado; o arquivo fica. */
  naoGravou?: boolean;
}

/** A classificação de um erro da chamada de entrega. 5xx e sem resposta: NÃO se sabe se gravou (o arquivo fica). */
export function classificarErroDaEntrega(e: unknown): ResultadoDaEntrega<never> {
  if (e instanceof ErroSistemas && e.status !== null) {
    if (e.status === 404) return { definitivo: false, erro: e, desatualizado: true };
    if (RECUSAS_DEFINITIVAS.has(e.status)) return { definitivo: true, erro: e };
    if (e.status < 500) return { definitivo: false, erro: e, naoGravou: true };
  }
  return { definitivo: false, erro: e as Error };
}
