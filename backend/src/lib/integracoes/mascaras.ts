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

const SECRETA = /senha|password|passwd|\bpass\b|\bpwd\b|meu ?inss|\blogin\b|\bsegredo\b|\bsecret|\btoken\b|gov ?br/;

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

/** CPF (formatado ou só dígitos) colado a outra coisa por `/ | \ : ;` — o padrão "cpf/senha". Leva o resto da célula. */
const CPF_COLADO = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}\s*[/|\\:;]\s*[\s\S]*$/;
const CPF_FORMATADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
/** Telefone brasileiro com ou sem +55, DDD e hífen (10 ou 11 dígitos), e também 11 dígitos soltos. Só em fronteira de número. */
const TELEFONE = /(?<![\d,])(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\d{2})[\s.-]?9?\d{4}[\s.-]?\d{4}(?![\d])/g;
const TELEFONE_SEM_DDD = /(?<![\d,])9?\d{4}-\d{4}(?!\d)/g;

export const CPF_SENHA_OMITIDO = '[CPF/senha omitido]';

/** Tem valor "CPF/senha" colado? */
export function temCpfColado(texto: string): boolean {
  return CPF_COLADO.test(texto);
}

/** Mascara, dentro de um texto qualquer, o que parece CPF ou telefone, e apaga o que parece CPF+senha colados. */
export function mascararTexto(texto: string): string {
  if (!texto) return texto;
  return texto
    .replace(CPF_COLADO, CPF_SENHA_OMITIDO)
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
export function mascararCelula(valor: string, cabecalho: string): string {
  if (!valor) return valor;
  const h = normalizarCabecalho(cabecalho);
  if (!temCpfColado(valor)) {
    const so = DIGITOS(valor);
    const soNumeros = /^[\s\d.()+-]+$/.test(valor);
    if (soNumeros && CABECALHO_CPF.test(h) && so.length >= 6 && so.length <= 11) return mascararCpf(valor);
    if (soNumeros && CABECALHO_FONE.test(h) && so.length >= 8) return mascararTelefone(valor);
  }
  return mascararTexto(valor);
}

/** Chaves de JSON que não são dado pessoal e que a máscara de telefone estragaria (número de processo, links, ids). */
const PRESERVAR = new Set(['id', 'uuid', 'iid', 'number', 'numero', 'numero_beneficio', 'numero_processo', 'numero_processo_com_mascara', 'link', 'link_tramitacao', 'created_at', 'updated_at']);

/**
 * Limpa um registro de API inteiro, em qualquer profundidade: some a chave de credencial, mascara CPF/telefone
 * em todo texto (menos as chaves de identificador). Devolve cópia; o original não é tocado.
 */
export function limparRegistro<T>(valor: T, chave = ''): T {
  if (typeof valor === 'string') {
    if (PRESERVAR.has(chave)) return valor;
    return mascararCelula(valor, chave) as T;
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
