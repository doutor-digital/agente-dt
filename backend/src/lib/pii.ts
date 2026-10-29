/**
 * Máscara de dado pessoal para registro técnico.
 *
 * Os segredos já eram mascarados (token, senha, Authorization). Dado de paciente
 * não: a conversa inteira ia para o log e para o banco com telefone, CPF e
 * queixa clínica em texto puro. Segredo vazado se troca; dado de saúde de
 * paciente, não.
 *
 * A régua aqui é diferente da do guardrail: ali o risco é segurar mensagem boa,
 * aqui o risco é deixar passar dado. Então mascara na dúvida — o registro serve
 * pra entender O QUE aconteceu, e pra isso "telefone ***-7766" basta.
 *
 * O nome NÃO é mascarado de propósito: sem ele o registro fica ilegível pra
 * quem for investigar ("o lead 24405762 disse que…"), e nome sozinho, sem
 * telefone nem documento, não identifica ninguém numa base de milhares. É uma
 * escolha, não um esquecimento.
 */

/**
 * Telefone brasileiro, com ou sem DDI/DDD/máscara. Guarda os 4 últimos.
 * `TELEFONE_COM_DDD` (usado quando `exigirDdd`) não pega 8 dígitos soltos: número de pedido, nossoNumero e datas
 * (PED-20261028) não são telefone, e mascará-los deixa a mensagem de erro ilegível.
 */
const TELEFONE = /(?:\+?55\s?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/g;
const TELEFONE_COM_DDD = /(?<!\d)(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g;

/**
 * Separadores que alguém põe entre os grupos de um documento ou telefone: espaço, ponto, hífen e barra
 * (`529 982 247 25`, `529-982-247-25`, `529.982.247/25`). Uma só definição, usada por tudo abaixo.
 */
const SEP = '[\\s.\\-/]';

/** CPF com ou sem pontuação (qualquer um dos separadores entre os grupos). */
const CPF = new RegExp(`\\b\\d{3}${SEP}?\\d{3}${SEP}?\\d{3}${SEP}?\\d{2}\\b`, 'g');

/** CNPJ — aparece em chave Pix nas mensagens da clínica. */
const CNPJ = new RegExp(`\\b\\d{2}${SEP}?\\d{3}${SEP}?\\d{3}${SEP}?\\d{4}${SEP}?\\d{2}\\b`, 'g');

/**
 * Dígitos "seguidos" para quem olha: uma corrida de dígitos com até 3 separadores (os de cima e parênteses, do DDD) entre um e outro. Detecta CPF/CNPJ/telefone
 * em QUALQUER agrupamento, sem depender do desenho exato da máscara — é o que fecha `529 982 247 25` ou `11 222 333 0001 81`.
 */
const CORRIDA_DE_DIGITOS = new RegExp(`\\d(?:[\\s.\\-/()]{0,3}\\d)*`, 'g');

/** Dígitos (sem separador) da maior corrida de dígitos seguidos do texto. */
export function maiorCorridaDeDigitos(texto: string): number {
  let maior = 0;
  for (const m of texto.matchAll(CORRIDA_DE_DIGITOS)) maior = Math.max(maior, m[0].replace(/\D/g, '').length);
  return maior;
}

/** Tem `minDigitos` ou mais dígitos seguidos (CPF = 11, CNPJ = 14, telefone com DDD = 10 ou 11)? */
export function temDigitosSeguidos(texto: string, minDigitos: number): boolean {
  return maiorCorridaDeDigitos(texto) >= minDigitos;
}

/** Troca por `marca` toda corrida de `minDigitos` ou mais dígitos seguidos. */
export function mascararDigitosSeguidos(texto: string, minDigitos: number, marca: string): string {
  return texto.replace(CORRIDA_DE_DIGITOS, (m) => (m.replace(/\D/g, '').length >= minDigitos ? marca : m));
}

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/** Cartão de crédito — nunca deveria aparecer, e é o pior caso se aparecer. */
const CARTAO = /\b(?:\d{4}[\s-]?){3}\d{4}\b/g;

export function mascararPii(texto: string, opcoes: { exigirDdd?: boolean } = {}): string {
  if (!texto) return texto;
  const telefone = opcoes.exigirDdd ? TELEFONE_COM_DDD : TELEFONE;
  return texto
    // Ordem importa: cartão e CNPJ antes de telefone, senão o telefone come
    // pedaço deles e sobra lixo meio mascarado.
    .replace(CARTAO, '«cartão»')
    .replace(CNPJ, '«cnpj»')
    .replace(CPF, '«cpf»')
    .replace(EMAIL, '«email»')
    .replace(telefone, (m) => {
      const d = m.replace(/\D/g, '');
      return d.length >= 8 ? `«tel ***${d.slice(-4)}»` : m;
    });
}

/** Mascara recursivamente qualquer texto dentro de um objeto de registro. */
export function mascararPiiProfundo<T>(valor: T, profundidade = 0): T {
  if (profundidade > 6) return valor;
  if (typeof valor === 'string') return mascararPii(valor) as unknown as T;
  if (Array.isArray(valor)) {
    return valor.map((v) => mascararPiiProfundo(v, profundidade + 1)) as unknown as T;
  }
  if (valor && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      saida[k] = mascararPiiProfundo(v, profundidade + 1);
    }
    return saida as unknown as T;
  }
  return valor;
}
