/**
 * Quem atende na Doutor Hérnia é fisioterapeuta — não médico.
 *
 * A franquia devolve o profissional já com título de médico colado no nome:
 * `DR. PAULO HENRIQUE AZEVEDO DE SOUSA`, `DR. LUIS EDUARDO RAPOSO LOBATO`. A
 * Sofia repetia fielmente, e o paciente lia "sua consulta é com o Dr. Paulo
 * Henrique" — entendendo que vai ser atendido por um médico.
 *
 * A clínica de Araguaína cobrou isso em 21/09/2026, e com razão: não é
 * preciosismo de nomenclatura. O paciente escolhe, paga e vai à consulta
 * achando que verá um médico; quem o atende é fisioterapeuta. A expectativa
 * errada nasce na nossa mensagem.
 *
 * Aqui o título sai e a profissão entra. O nome continua sendo o que a franquia
 * mandou — só perde a patente que ela colou na frente.
 */

/**
 * Ordem importa: `dra` antes de `dr`, `doutora` antes de `doutor`. Na primeira
 * versão `dr` casava primeiro em "DRA. ANA PAULA" e sobrava um "A." grudado no
 * nome — a alternância do JavaScript para no primeiro que serve, não no maior.
 */
const TITULO_MEDICO = /^\s*(doutora|doutor|drª|dr\.ª|dra|dr)\s*\.?\s*/i;

/** Tira "DR."/"DRA." do começo e deixa o nome em Maiúscula Inicial. */
export function nomeDoProfissional(bruto: string | null | undefined): string | null {
  const limpo = String(bruto ?? '').replace(TITULO_MEDICO, '').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return limpo
    .toLocaleLowerCase('pt-BR')
    .split(' ')
    .map((p) => (p.length <= 2 && /^(de|da|do|e)$/i.test(p) ? p : p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1)))
    .join(' ');
}

/**
 * Como a consulta é apresentada ao paciente.
 *
 * "fisioterapeuta Regiane Duarte" em vez de "Dra. Regiane Duarte".
 *
 * SEM artigo de propósito. A primeira versão disto escolhia "o" ou "a" olhando
 * a última letra do primeiro nome, e errou no primeiro teste: "Regiane" não
 * termina em A e virou "o fisioterapeuta Regiane". Nome não diz gênero — Andrea,
 * Alexandre, Darci, Jean. A franquia não manda esse dado, então a saída é não
 * precisar dele: "fisioterapeuta Fulana" encaixa em qualquer frase e não erra
 * com ninguém.
 *
 * Sem nome conhecido devolve null, e quem chama omite a linha — inventar
 * profissional é pior que não citar nenhum.
 */
export function comQuemVaiSerAtendido(bruto: string | null | undefined): string | null {
  const nome = nomeDoProfissional(bruto);
  return nome ? `fisioterapeuta ${nome}` : null;
}
