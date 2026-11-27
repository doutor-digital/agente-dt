/**
 * Duas pessoas são "a mesma" pelo NOME? Quem decide se o lead da franquia achado pelo telefone pode virar o paciente que está sendo
 * agendado (27/11/2026).
 *
 * Telefone sozinho não prova pessoa: a mãe e a filha dividem o WhatsApp, e o nome do cartão no 1º contato vem do PERFIL do WhatsApp,
 * que é o da dona do aparelho. Por isso o nome do cartão nunca serve de prova; só o nome que o paciente DEU para a consulta, comparado
 * com o do lead achado, com nome E sobrenome. Na dúvida (nome ausente, provisório, sem sobrenome) é NÃO: o pior caso é um paciente novo
 * a mais, nunca o lead da mãe convertido em paciente com o nome da filha, que não tem desfazer.
 */
import { ehNomeProvisorio } from './nome-provisorio.js';

/** Tratamento e parentesco não são nome: "Dona Maria" e "Dona Ana" não são a mesma pessoa. Pulados antes de comparar. */
const NAO_SAO_NOME = new Set([
  'dona', 'seu', 'sr', 'sra', 'srta', 'senhor', 'senhora', 'dr', 'dra', 'doutor', 'doutora', 'prof', 'profa', 'professor', 'professora',
  'mae', 'mamae', 'pai', 'papai', 'vo', 'vovo', 'tia', 'tio', 'filha', 'irma', 'irmao', 'esposa', 'marido', 'avo',
  'sogra', 'sogro', 'prima', 'primo', 'sobrinha', 'sobrinho', 'neta', 'paciente',
]);

/** Partículas de sobrenome: não identificam ninguém ("Mãe da Ana" × "Tia da Ana" não casa pelo "da"). */
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'del', 'della', 'la', 'le', 'van', 'von', 'y', 'dal']);

/** As palavras do nome, minúsculas, sem acento, sem tratamento nem partícula. Vazio se não há nome utilizável (ausente ou provisório). */
export function palavrasDoNome(nome: string | null | undefined): string[] {
  const bruto = String(nome ?? '').trim();
  if (!bruto || ehNomeProvisorio(bruto)) return [];
  return bruto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.replace(/[^a-z]/g, ''))
    .filter((p) => p.length >= 2 && !NAO_SAO_NOME.has(p) && !PARTICULAS.has(p));
}

/**
 * Mesmo nome E mesmo sobrenome (primeira e última palavra), os dois lados com pelo menos duas palavras.
 * "Maria Souza" casa com "Maria José Souza"; "Maria José Souza" NÃO casa com "Maria Aparecida"; "Maria" sozinha nunca casa.
 */
export function nomesCompletosCompativeis(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = palavrasDoNome(a);
  const y = palavrasDoNome(b);
  if (x.length < 2 || y.length < 2) return false;
  return x[0] === y[0] && x[x.length - 1] === y[y.length - 1];
}
