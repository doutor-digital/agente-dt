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

/**
 * Palavras com maiúscula que aparecem logo depois de "fisioterapeuta" e não são nome de gente
 * ("fisioterapeuta Doutor Hérnia"…). Comparadas sem acento e em minúscula.
 */
const NAO_E_NOME = new Set(['doutor', 'doutora', 'hernia', 'digital', 'sofia', 'especialista', 'especializado', 'especializada', 'responsavel']);

const PALAVRA_DE_NOME = String.raw`\p{Lu}[\p{L}'’-]*`;
/**
 * "fisioterapeuta Aylana Silva Mendes" → grupo 1 = profissão, grupo 2 = nome (até 5 palavras, com
 * "de/da/do/dos/das/e" no meio). Só espaço entre as palavras, nunca quebra de linha: na confirmação a
 * linha seguinte começa com maiúscula ("Qualquer dúvida…") e seria engolida como sobrenome.
 */
const NOME_DEPOIS_DA_PROFISSAO = new RegExp(
  String.raw`(?<!\p{L})([Ff]isioterapeuta|FISIOTERAPEUTA)[ \t]+(${PALAVRA_DE_NOME}(?:[ \t]+(?:(?:de|da|do|dos|das|e)[ \t]+)?${PALAVRA_DE_NOME}){0,4})`,
  'gu',
);

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Tira o NOME do profissional e deixa a profissão: "com a fisioterapeuta Aylana Silva Mendes" →
 * "com a fisioterapeuta".
 *
 * Por quê (Açailândia, 08/10/2026, cartão 28088906): a Sofia de resgate disse "sua consulta de quarta,
 * 07/10 às 13h com a fisioterapeuta Aylana" — a consulta tinha sido ontem, e o nome veio de mensagens
 * antigas (a confirmação de 06/10 que a outra Sofia mandou). Nome de profissional só vale quando a
 * agenda acabou de devolvê-lo: a escala muda por turno (ver profissional-por-turno.ts) e repetir um
 * nome velho é afirmar quem vai atender sem saber.
 *
 * `manter(nome)` decide o que pode ficar — quem chama passa o nome que a agenda devolveu AGORA.
 */
export function semNomeDeProfissional(
  texto: string,
  manter: (nome: string) => boolean = () => false,
): { texto: string; removidos: string[] } {
  if (!texto) return { texto, removidos: [] };
  const removidos: string[] = [];
  const limpo = texto.replace(NOME_DEPOIS_DA_PROFISSAO, (inteiro: string, profissao: string, nome: string) => {
    const primeira = semAcento(nome.split(/[ \t]+/)[0] ?? '');
    if (NAO_E_NOME.has(primeira) || manter(nome)) return inteiro;
    removidos.push(nome);
    return profissao;
  });
  return { texto: limpo, removidos };
}

/**
 * `manter` para `semNomeDeProfissional`: o nome fica só se o PRIMEIRO nome aparece, como palavra
 * inteira, em `fonteViva` (o que a agenda devolveu agora). "Aylana" basta para manter "Aylana Silva
 * Mendes" — o modelo encurta o nome que a ferramenta devolveu, e isso é legítimo.
 */
export function nomeEstaNaFonte(fonteViva: string): (nome: string) => boolean {
  const fonte = ` ${semAcento(fonteViva).replace(/[^a-z0-9]+/g, ' ')} `;
  return (nome) => {
    const primeiro = semAcento(nome.split(/[ \t]+/)[0] ?? '').replace(/[^a-z0-9]+/g, '');
    return primeiro.length > 0 && fonte.includes(` ${primeiro} `);
  };
}
