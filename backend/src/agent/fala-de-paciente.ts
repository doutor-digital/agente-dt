/**
 * Quem JÁ faz tratamento escrevendo num cartão que ainda não sabe disso (lista de Marabá, 21/10/2026).
 *
 * Marabá, lead 28072622 (13/10): o paciente em tratamento mandou áudio às 08:49 e o cartão nasceu ali, vazio — o
 * sincronizador só o levou ao funil TRATAMENTO depois. A Sofia tratou a sessão dele como consulta, ofereceu "sexta,
 * 16/10, às 10h" e pediu o nome completo. Com o cartão já no funil, vale a regra do <etapa_do_lead>; antes disso,
 * o que denuncia é o jeito de falar: "minha sessão", "a fisioterapia de hoje", "já sou paciente".
 *
 * "Qual o valor da sessão?" é de quem ainda não é paciente e NÃO entra: só a sessão DELE, a de hoje ou amanhã.
 */
import type { Fala } from './repeticao.js';
import { linhasSemResposta } from './rajada.js';

const FALA_DE_PACIENTE = new RegExp(
  [
    String.raw`\bminhas?\s+sess(?:[aã]o|[oõ]es)(?![\wÀ-ÿ])`,
    String.raw`\bsess[aã]o\s+de\s+(?:hoje|amanh[aã])(?![\wÀ-ÿ])`,
    String.raw`\bfisioterapia\s+de\s+(?:hoje|amanh[aã])(?![\wÀ-ÿ])`,
    String.raw`\bj[aá]\s+sou\s+paciente\b`,
    String.raw`\bj[aá]\s+(?:fa[cç]o|estou\s+fazendo|t[oô]\s+fazendo)\s+(?:o\s+)?(?:tratamento|fisioterapia|as\s+sess)`,
    String.raw`\bj[aá]\s+(?:estou|t[oô])\s+em\s+tratamento\b`,
  ].join('|'),
  'i',
);

/** A frase do paciente que mostra que ele já está em tratamento (a última), ou nulo. */
export function falaDePacienteEmTratamento(falas: ReadonlyArray<Fala>): string | null {
  const linhas = linhasSemResposta(falas).filter((l) => FALA_DE_PACIENTE.test(l));
  return linhas.length ? linhas[linhas.length - 1] : null;
}

export function renderFalaDePaciente(falas: ReadonlyArray<Fala>): string {
  const fala = falaDePacienteEmTratamento(falas);
  if (!fala) return '';
  return [
    '<paciente_em_tratamento>',
    '(contado pelo sistema: ele fala como quem JÁ FAZ TRATAMENTO aqui, mesmo que o cartão ainda não mostre)',
    `  > "${fala.slice(0, 160)}"`,
    '- Sessão (horário, confirmar, remarcar, faltar) é com a equipe: NÃO use consultar_horarios nem',
    '  agendar_consulta, NÃO ofereça consulta, NÃO fale do valor da consulta e NÃO peça nome completo.',
    '- Diga que vai pedir para a equipe confirmar a sessão dele e chame resumir_lead_para_sdr e pausar_ia.',
    '</paciente_em_tratamento>',
  ].join('\n');
}
