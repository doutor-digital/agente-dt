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

/** Telefone brasileiro, com ou sem DDI/DDD/máscara. Guarda os 4 últimos. */
const TELEFONE = /(?:\+?55\s?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/g;

/** CPF com ou sem pontuação. */
const CPF = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g;

/** CNPJ — aparece em chave Pix nas mensagens da clínica. */
const CNPJ = /\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}\b/g;

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

/** Cartão de crédito — nunca deveria aparecer, e é o pior caso se aparecer. */
const CARTAO = /\b(?:\d{4}[\s-]?){3}\d{4}\b/g;

export function mascararPii(texto: string): string {
  if (!texto) return texto;
  return texto
    // Ordem importa: cartão e CNPJ antes de telefone, senão o telefone come
    // pedaço deles e sobra lixo meio mascarado.
    .replace(CARTAO, '«cartão»')
    .replace(CNPJ, '«cnpj»')
    .replace(CPF, '«cpf»')
    .replace(EMAIL, '«email»')
    .replace(TELEFONE, (m) => {
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
