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

/** Tratamento: não identifica ninguém e pode faltar de um lado ("Dona Maria Souza" × "Maria Souza" é a mesma pessoa). Pulado antes de comparar. */
const TRATAMENTO = new Set([
  'dona', 'seu', 'sr', 'sra', 'srta', 'senhor', 'senhora', 'dr', 'dra', 'doutor', 'doutora', 'prof', 'profa', 'professor', 'professora',
]);

/**
 * Parentesco e sufixo de geração DIFERENCIAM pessoas: "Maria Souza Filha" não é "Maria Souza" (é a filha dela), "Tia Ana" não é "Ana", "Pedro Neto" não
 * é "Pedro". Não entram na comparação das palavras, mas precisam ser IGUAIS dos dois lados — presente de um lado só (ou diferente) = NÃO casa.
 */
const PARENTESCO = new Set([
  'mae', 'mamae', 'pai', 'papai', 'vo', 'vovo', 'avo', 'tia', 'tio', 'irma', 'irmao', 'esposa', 'marido', 'sogra', 'sogro', 'prima', 'primo', 'paciente',
]);
/** Só valem como sufixo DEPOIS da primeira palavra: "Junior Santos" e "Neto Silva" têm o apelido como nome. */
const GERACAO = new Set(['filha', 'filho', 'neta', 'neto', 'sobrinha', 'sobrinho', 'bisneta', 'bisneto', 'junior', 'jr', 'segundo', 'terceiro']);

/** Partículas de sobrenome: não identificam ninguém ("Mãe da Ana" × "Tia da Ana" não casa pelo "da"). */
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'del', 'della', 'la', 'le', 'van', 'von', 'y', 'dal']);

function palavrasBrutas(nome: string | null | undefined): string[] {
  const bruto = String(nome ?? '').trim();
  if (!bruto || ehNomeProvisorio(bruto)) return [];
  return bruto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.replace(/[^a-z]/g, ''))
    .filter((p) => p.length >= 2 && !TRATAMENTO.has(p) && !PARTICULAS.has(p));
}

function ehMarca(p: string, posicao: number): boolean {
  return PARENTESCO.has(p) || (posicao > 0 && GERACAO.has(p));
}

/** As palavras do nome, minúsculas, sem acento, sem tratamento, partícula, parentesco nem sufixo de geração. Vazio se não há nome utilizável (ausente ou provisório). */
export function palavrasDoNome(nome: string | null | undefined): string[] {
  return palavrasBrutas(nome).filter((p, i) => !ehMarca(p, i));
}

function marcasDoNome(nome: string | null | undefined): string[] {
  return [...new Set(palavrasBrutas(nome).filter((p, i) => ehMarca(p, i)))].sort();
}

/**
 * Mesmo nome, mesmo sobrenome (primeira e última palavra), mesmas marcas de parentesco/geração e o MESMO conjunto de nomes do meio — os dois
 * lados com pelo menos duas palavras. Na dúvida, NÃO:
 *  - "Maria Souza" × "Maria Souza Filha": não casa (a filha); "Maria Souza" × "Maria Eduarda Souza": não casa (nome do meio de um lado só);
 *  - "Maria Aparecida Souza" × "Maria Eduarda Souza": não casa; "Maria Aparecida Souza" × "Maria Aparecida Lima Souza": não casa (conjunto
 *    do meio diferente); "Maria Aparecida Lima Souza" × "MARIA APARECIDA LIMA SOUZA": casa.
 */
export function nomesCompletosCompativeis(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = palavrasDoNome(a);
  const y = palavrasDoNome(b);
  if (x.length < 2 || y.length < 2) return false;
  if (x[0] !== y[0] || x[x.length - 1] !== y[y.length - 1]) return false;
  if (marcasDoNome(a).join('|') !== marcasDoNome(b).join('|')) return false;
  const meioX = x.slice(1, -1);
  const meioY = y.slice(1, -1);
  if ((meioX.length === 0) !== (meioY.length === 0)) return false;
  // O MESMO conjunto de nomes do meio — um só em comum não basta: "Lima" costuma ser sobrenome da família, e mãe
  // "Maria Aparecida Lima Souza" × filha "Maria Lima Souza" / "Maria Eduarda Lima Souza" não podem casar (sênior, 27/11).
  const conjunto = (m: string[]) => [...new Set(m)].sort().join('|');
  if (conjunto(meioX) !== conjunto(meioY)) return false;
  return true;
}
