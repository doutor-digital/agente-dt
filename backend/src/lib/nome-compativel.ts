/**
 * Dois nomes são "da mesma pessoa" o bastante para o lead da franquia achado pelo TELEFONE virar o lead do cartão? (27/11/2026)
 *
 * Telefone sozinho não prova pessoa: a mãe e a filha dividem o WhatsApp. O lead achado pelo telefone só é adotado pelo cartão
 * (`spineIdLead` no vínculo, que a agenda converte em paciente com o nome que a Sofia levar) se o PRIMEIRO NOME bate, sem acento,
 * caixa nem pontuação. Na dúvida (nome ausente, provisório, curto) é NÃO: o pior caso é um lead a mais na franquia, nunca o
 * paciente da filha com o cadastro da mãe, que não tem desfazer.
 */
import { ehNomeProvisorio } from './nome-provisorio.js';

/** Primeiro nome em minúsculas e sem acento; `null` se não há nome utilizável para comparar. */
export function primeiroNomeNormalizado(nome: string | null | undefined): string | null {
  const bruto = String(nome ?? '').trim();
  if (!bruto || ehNomeProvisorio(bruto)) return null;
  const primeiro = bruto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.replace(/[^a-z]/g, ''))
    .find((p) => p.length > 0);
  // uma letra solta ("A. Silva") não identifica ninguém
  return primeiro && primeiro.length >= 2 ? primeiro : null;
}

export function nomesCompativeis(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = primeiroNomeNormalizado(a);
  const y = primeiroNomeNormalizado(b);
  return x !== null && y !== null && x === y;
}
