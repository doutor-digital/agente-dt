/**
 * O que NUNCA sai do conector em planilha ou em CRM jurídico: senha, CPF inteiro, telefone inteiro.
 *
 *  - coluna cujo cabeçalho diz senha/login/token/"meu inss" é DESCARTADA (não mascarada: o valor nem é lido adiante);
 *  - valor no formato `NNN.NNN.NNN-NN/…` (CPF e senha colados na mesma célula) some inteiro;
 *  - CPF e telefone aparecem só com os últimos dígitos.
 *
 * Funções puras, sem estado. Quem lê a fonte (planilha, Tramitação) chama aqui ANTES de guardar em cache
 * ou de montar a resposta — nenhuma flag (`completo`, por exemplo) desliga isto.
 */

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Minúsculo, sem acento, e `_ - / .` viram espaço: "CPF/Senha", "meu_inss_pass" e "Meu INSS" comparam por igual. */
export function normalizarCabecalho(s: string): string {
  return semAcento(String(s ?? '')).toLowerCase().replace(/[_\-/.\\|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const SECRETA = /senha|password|passwd|\bpass\b|\bpwd\b|\bpin\b|meu ?inss|\blogin\b|\bsegredo\b|\bsecret|\btoken\b|gov ?br/;

/** O cabeçalho é de uma coluna de credencial? Em dúvida (cabeçalho vazio não é), descarta. */
export function ehColunaSecreta(cabecalho: string): boolean {
  return SECRETA.test(normalizarCabecalho(cabecalho));
}

/** Chave de objeto (JSON de API) que guarda credencial: `meu_inss_pass`, `password`, `senha`, `api_token`… */
export function ehChaveSecreta(chave: string): boolean {
  return SECRETA.test(normalizarCabecalho(chave));
}

const DIGITOS = (s: string) => s.replace(/\D/g, '');

export function mascararCpf(valor: string): string {
  const d = DIGITOS(valor);
  return d.length >= 2 ? `***.***.***-${d.slice(-2)}` : '***';
}

export function mascararTelefone(valor: string): string {
  const d = DIGITOS(valor);
  return d.length >= 4 ? `(**) *****-${d.slice(-4)}` : '***';
}

/**
 * CPF (formatado ou só dígitos) colado a outra coisa por `/`, `|` ou `\` — o padrão "cpf/senha". Só esses três:
 * `;` e `:` aparecem em prosa logo depois de um CPF ("CPF 123…-01; réu: …") e não são colagem de credencial.
 */
const COLADO = String.raw`(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}\s*[/|\\]\s*`;
/** na célula de planilha o que vem depois do CPF é a senha, que pode ter espaço: leva o resto da célula */
const CPF_COLADO_CELULA = new RegExp(`${COLADO}[\\s\\S]*$`);
/** em texto corrido (publicação, movimentação), só a palavra colada: não apaga o resto do parágrafo */
const CPF_COLADO_TEXTO = new RegExp(`${COLADO}\\S+`, 'g');
/** "senha: abc123", "senha do gov: abc123", "password=abc": a palavra, um complemento curto e o valor */
const SENHA_DITA = /\b(?:senha|password|passwd|pwd)\b[^:=\n]{0,25}[:=]\s*\S+/gi;
const CPF_FORMATADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
/** Telefone brasileiro com ou sem +55, DDD e hífen (10 ou 11 dígitos), e também 11 dígitos soltos. Só em fronteira de número. */
const TELEFONE = /(?<![\d,])(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\d{2})[\s.-]?9?\d{4}[\s.-]?\d{4}(?![\d])/g;
const TELEFONE_SEM_DDD = /(?<![\d,])9?\d{4}-\d{4}(?!\d)/g;

export const CPF_SENHA_OMITIDO = '[CPF/senha omitido]';
export const SENHA_OMITIDA = '[senha omitida]';

/** Tem valor "CPF/senha" colado? */
export function temCpfColado(texto: string): boolean {
  return CPF_COLADO_CELULA.test(texto);
}

/**
 * Mascara, dentro de um texto, o que parece CPF ou telefone; apaga CPF+senha colados e "senha: xxx".
 * `celula` (planilha) leva tudo o que vem depois do CPF colado; `texto` (padrão) só a palavra colada.
 */
export function mascararTexto(texto: string, modo: 'celula' | 'texto' = 'texto'): string {
  if (!texto) return texto;
  return texto
    .replace(modo === 'celula' ? CPF_COLADO_CELULA : CPF_COLADO_TEXTO, CPF_SENHA_OMITIDO)
    .replace(SENHA_DITA, SENHA_OMITIDA)
    .replace(CPF_FORMATADO, (m) => mascararCpf(m))
    .replace(TELEFONE, (m) => mascararTelefone(m))
    .replace(TELEFONE_SEM_DDD, (m) => mascararTelefone(m));
}

const CABECALHO_CPF = /\bcpf\b|cpf ?cnpj|documento/;
const CABECALHO_FONE = /telefone|celular|\bfone\b|whats|\btel\b|\bcontato\b|\bphone\b|\bmobile\b/;

/**
 * Uma célula de planilha. O cabeçalho ajuda onde o formato não basta (CPF sem pontuação e sem zero à esquerda,
 * telefone só com números); o padrão do valor protege onde o cabeçalho não diz nada.
 */
export function mascararCelula(valor: string, cabecalho: string, modo: 'celula' | 'texto' = 'celula'): string {
  if (!valor) return valor;
  const h = normalizarCabecalho(cabecalho);
  if (!temCpfColado(valor)) {
    const so = DIGITOS(valor);
    const soNumeros = /^[\s\d.()+-]+$/.test(valor);
    if (soNumeros && CABECALHO_CPF.test(h) && so.length >= 6 && so.length <= 11) return mascararCpf(valor);
    if (soNumeros && CABECALHO_FONE.test(h) && so.length >= 8) return mascararTelefone(valor);
  }
  return mascararTexto(valor, modo);
}

/**
 * Chaves de JSON que a máscara de telefone estragaria: ids (uuid tem "1234-5678" no meio), links e datas.
 * Número de processo NÃO está aqui de propósito — a máscara já o deixa passar (fronteira de número) e uma lista
 * de chaves isentas é furo: `{"number":"11999998888"}` sairia inteiro.
 */
const PRESERVAR = new Set(['id', 'uuid', 'iid', 'numero_beneficio', 'link', 'link_tramitacao', 'created_at', 'updated_at']);
const CHAVE_DE_DOCUMENTO = /cpf|cnpj|documento|telefone|celular|fone|phone|mobile|whats/;

/**
 * Limpa um registro de API inteiro, em qualquer profundidade: some a chave de credencial, mascara CPF/telefone
 * em todo texto (e em número, se a chave for de CPF/telefone). Devolve cópia; o original não é tocado.
 */
export function limparRegistro<T>(valor: T, chave = ''): T {
  if (typeof valor === 'string') {
    if (PRESERVAR.has(chave)) return valor;
    return mascararCelula(valor, chave, 'texto') as T;
  }
  if (typeof valor === 'number') {
    // CPF ou telefone que a API mande como número JSON
    return (CHAVE_DE_DOCUMENTO.test(normalizarCabecalho(chave)) ? mascararCelula(String(valor), chave, 'texto') : valor) as T;
  }
  if (Array.isArray(valor)) return valor.map((x) => limparRegistro(x, chave)) as T;
  if (valor && typeof valor === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (ehChaveSecreta(k)) continue;
      out[k] = limparRegistro(v, k);
    }
    return out as T;
  }
  return valor;
}
