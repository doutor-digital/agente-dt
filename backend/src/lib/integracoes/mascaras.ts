/**
 * O que NUNCA sai do conector em planilha ou em CRM jurídico: senha, CPF inteiro, telefone inteiro.
 *
 *  - coluna cujo cabeçalho diz senha/login/token/"meu inss" é DESCARTADA (não mascarada: o valor nem é lido adiante);
 *  - CPF seguido de qualquer coisa na mesma célula (`NNN.NNN.NNN-NN/senha`, `… - senha`, `… senha`, `…: senha`, quebra de
 *    linha) leva o resto da célula junto: na dúvida, some;
 *  - CPF e telefone aparecem só com os últimos dígitos; NIT, RG e "senha: xxx" em texto livre também não saem.
 *
 * Funções puras, sem estado. Quem lê a fonte (planilha, Tramitação) chama aqui ANTES de guardar em cache
 * ou de montar a resposta — nenhuma flag (`completo`, por exemplo) desliga isto.
 */

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const limpar = (s: string) => s.toLowerCase().replace(/[_\-/.\\|]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * As formas de um cabeçalho ou chave de JSON para as regras de credencial/dado sensível: a normal e a que separa
 * camelCase ("MeuInssPass" → "meu inss pass"). As duas, porque separar quebra "SêNhA"; a regra vale se QUALQUER uma casar.
 */
function formasDaChave(s: string): string[] {
  const sem = semAcento(String(s ?? ''));
  return [limpar(sem), limpar(sem.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))];
}

/** Minúsculo, sem acento, e `_ - / .` viram espaço: "CPF/Senha", "meu_inss_pass" e "Meu INSS" comparam por igual. */
export function normalizarCabecalho(s: string): string {
  return formasDaChave(s)[0]!;
}

/** Palavras que dizem "credencial", em chave de JSON ou em texto. */
const SECRETA = /senha|password|passwd|\bpass\b|\bpwd\b|\bpin\b|meu ?inss|\blogin\b|\bsegredo\b|\bsecret|\btoken\b|gov ?br/;
/** Chave de objeto (JSON de API) que guarda credencial: `meu_inss_pass`, `password`, `senha`, `api_token`… */
export function ehChaveSecreta(chave: string): boolean {
  return formasDaChave(chave).some((f) => SECRETA.test(f));
}

const DIGITOS = (s: string) => s.replace(/\D/g, '');

export function mascararCpf(valor: string): string {
  const d = DIGITOS(valor);
  return d.length >= 2 ? `***.***.***-${d.slice(-2)}` : '***';
}

export function mascararCnpj(valor: string): string {
  const d = DIGITOS(valor);
  return d.length >= 2 ? `**.***.***/****-${d.slice(-2)}` : '***';
}

export function mascararTelefone(valor: string): string {
  const d = DIGITOS(valor);
  return d.length >= 4 ? `(**) *****-${d.slice(-4)}` : '***';
}

/**
 * CPF com ou sem pontuação, com qualquer separador que alguém digita entre os grupos: espaço, ponto, hífen ou barra
 * ("123.456.789-09", "123 456 789 09", "123.456.789/09"). Fronteira de número nos dois lados.
 */
const CPF_SOLTO = /(?<!\d)\d{3}[\s.\-/]?\d{3}[\s.\-/]?\d{3}[\s.\-/]?\d{2}(?!\d)/g;
/** CNPJ, mesma ideia: "12.345.678/0001-95", "12345678000195", "12 345 678 0001 95". */
const CNPJ_SOLTO = /(?<!\d)\d{2}[\s.\-/]?\d{3}[\s.\-/]?\d{3}[\s.\-/]?\d{4}[\s.\-/]?\d{2}(?!\d)/g;

/** CPF, formatado ou só dígitos, que não é pedaço de número maior */
const CPF_ISOLADO = String.raw`(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)`;
/**
 * Texto corrido (publicação, movimentação): só o "cpf/senha" colado por `/`, `|` ou `\`, e só a palavra colada.
 * `;`, `:` e `-` aparecem em prosa logo depois de um CPF ("CPF 123…-01; réu: …", "… - Maria") e não são colagem de credencial.
 */
const CPF_COLADO_TEXTO = new RegExp(`${CPF_ISOLADO}\\s*[/|\\\\]\\s*\\S+`, 'g');
/**
 * Célula de planilha: depois de um CPF, QUALQUER coisa que venha na célula (barra, hífen, espaço, dois-pontos,
 * quebra de linha, nada visível entre os dois) pode ser a senha, e a senha pode ter espaço: leva o resto da célula.
 * Falha segura — perde o que vinha depois do CPF, mas nunca mostra uma senha.
 */
const CPF_COLADO_CELULA = new RegExp(`${CPF_ISOLADO}(?=\\s*\\S)[\\s\\S]*$`);

/**
 * "senha: abc123", "password=abc", "senha do gov: abc123" (a palavra, um complemento curto e `:`/`=`) e também sem
 * pontuação nenhuma — "senha - abc", "senha gov abc", "a senha abc": a palavra, palavras de ligação e o valor.
 */
const LIGACAO = String.raw`(?:d[aeo]s?|meu|minha|gov(?:\.?br)?|inss|login|acesso|é|eh|e|foi|era|nova?|atual)(?=[\s:=\-–—]|$)`;
const SENHA_DITA = new RegExp(String.raw`\b(?:senha|password|passwd|pwd)s?\b(?!\s+omitid[oa]\])(?:[^:=\n]{0,25}[:=]\s*|(?:[\s:=\-–—]+${LIGACAO})*[\s:=\-–—]+)\S+`, 'gi');
const CPF_FORMATADO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
/** NIT/PIS (123.45678.90-1) e RG (12.345.678-9): documento que, com nascimento e nome da mãe, recupera conta do gov.br */
const NIT_FORMATADO = /(?<![\d.])\d{3}\.\d{5}\.\d{2}-\d(?!\d)/g;
const RG_FORMATADO = /(?<![\d.])\d{1,2}\.\d{3}\.\d{3}-[\dXx](?!\d)/g;
/** Telefone brasileiro com ou sem +55, DDD e hífen (10 ou 11 dígitos), e também 11 dígitos soltos. Só em fronteira de número. */
const TELEFONE = /(?<!\d)(?:\+?55[\s.-]?)?(?:\(\d{2}\)|\d{2})[\s.-]?9?\d{4}[\s.-]?\d{4}(?![\d])/g;
const TELEFONE_SEM_DDD = /(?<!\d)9?\d{4}-\d{4}(?!\d)/g;

export const CPF_SENHA_OMITIDO = '[CPF/senha omitido]';
export const SENHA_OMITIDA = '[senha omitida]';
export const DOCUMENTO_OMITIDO = '[documento omitido]';

/** Tem CPF seguido de mais alguma coisa na mesma célula (possível "cpf + senha")? */
export function temCpfColado(texto: string): boolean {
  return CPF_COLADO_CELULA.test(texto);
}

/**
 * Mascara, dentro de um texto, o que parece CPF (com ou sem pontuação), CNPJ, NIT, RG ou
 * telefone; apaga CPF+senha colados e "senha: xxx".
 * `celula` (planilha) leva tudo o que vem depois do CPF; `texto` (padrão) só a palavra colada por `/`, `|` ou `\`.
 */
export function mascararTexto(texto: string, modo: 'celula' | 'texto' = 'texto'): string {
  if (!texto) return texto;
  return texto
    .replace(modo === 'celula' ? CPF_COLADO_CELULA : CPF_COLADO_TEXTO, CPF_SENHA_OMITIDO)
    .replace(SENHA_DITA, SENHA_OMITIDA)
    .replace(CNPJ_SOLTO, (m) => mascararCnpj(m))
    .replace(CPF_FORMATADO, (m) => mascararCpf(m))
    .replace(NIT_FORMATADO, DOCUMENTO_OMITIDO)
    .replace(RG_FORMATADO, DOCUMENTO_OMITIDO)
    .replace(TELEFONE, (m) => mascararTelefone(m))
    .replace(TELEFONE_SEM_DDD, (m) => mascararTelefone(m))
    // por último, o que sobrou com cara de CPF: sem pontuação ou com espaço ("CPF 12345678909", "123 456 789 09")
    .replace(CPF_SOLTO, (m) => mascararCpf(m));
}

const CABECALHO_CPF = /\bcpf\b|cpf ?cnpj|documento/;
const CABECALHO_FONE = /telefone|celular|\bfone\b|whats|\btel\b|\bcontato\b|\bphone\b|\bmobile\b/;

/**
 * Uma célula de planilha. O cabeçalho ajuda onde o formato não basta (CPF sem pontuação e sem zero à esquerda,
 * telefone só com números); o padrão do valor protege onde o cabeçalho não diz nada.
 */
export function mascararCelula(valor: string, cabecalho: string, modo: 'celula' | 'texto' = 'celula'): string {
  if (!valor) return valor;
  const hs = formasDaChave(cabecalho);
  if (!temCpfColado(valor)) {
    const so = DIGITOS(valor);
    const soNumeros = /^[\s\d.()+-]+$/.test(valor);
    if (soNumeros && hs.some((h) => CABECALHO_CPF.test(h)) && so.length >= 6 && so.length <= 11) return mascararCpf(valor);
    if (soNumeros && hs.some((h) => CABECALHO_FONE.test(h)) && so.length >= 8) return mascararTelefone(valor);
  }
  return mascararTexto(valor, modo);
}

/**
 * Chaves de JSON que a máscara de telefone estragaria: ids (uuid tem "1234-5678" no meio), links e datas.
 * Número de processo NÃO está aqui de propósito — a máscara já o deixa passar (fronteira de número) e uma lista
 * de chaves isentas é furo: `{"number":"11999998888"}` sairia inteiro.
 */
const PRESERVAR = new Set(['id', 'uuid', 'iid', 'numero_beneficio', 'link', 'link_tramitacao', 'created_at', 'updated_at']);
/** Chave de dado bancário (conta, agência, Pix): não sai, qualquer que seja o nome exato que a API use. */
const CHAVE_BANCARIA = /bank|banco|banc[aá]ri|\bpix\b|pix key|agenc|iban|account number|conta corrente/;
const CHAVE_DE_DOCUMENTO = /cpf|cnpj|documento|document|telefone|celular|fone|phone|mobile|whats/;
/** chave numérica que só CONTA ou MEDE (documents_count, tamanho_bytes): o número fica como número, mesmo com "document" no nome */
const CHAVE_DE_MEDIDA = /count|total|qtd|quantidade|size|tamanho|bytes|length|pages|paginas|\bn\b/;
/**
 * Chave de documento de identidade (NIT/PIS/PASEP, RG, CNH, CTPS, título, passaporte, `document_number`): não sai nem
 * mascarado. Com nascimento e nome da mãe — que o `completo` devolve — o NIT e o RG recuperam a conta do gov.br.
 */
const CHAVE_IDENTIDADE = /(?:^| )(?:nit|pis|pasep|rg|cnh|ctps|rne|rnm)(?: |$)|identidade|document number|documento numero|numero do documento|passaporte|passport|titulo de eleitor|voter/;

/**
 * Limpa um registro de API inteiro, em qualquer profundidade: some a chave de credencial, de dado bancário e de
 * documento de identidade, mascara CPF/telefone
 * em todo texto (e em número, se a chave for de CPF/telefone). Devolve cópia; o original não é tocado.
 */
export function limparRegistro<T>(valor: T, chave = ''): T {
  if (typeof valor === 'string') {
    if (PRESERVAR.has(chave)) return valor;
    return mascararCelula(valor, chave, 'texto') as T;
  }
  if (typeof valor === 'number') {
    // CPF ou telefone que a API mande como número JSON
    const formas = formasDaChave(chave);
    return (formas.some((f) => CHAVE_DE_DOCUMENTO.test(f)) && !formas.some((f) => CHAVE_DE_MEDIDA.test(f)) ? mascararCelula(String(valor), chave, 'texto') : valor) as T;
  }
  if (Array.isArray(valor)) return valor.map((x) => limparRegistro(x, chave)) as T;
  if (valor && typeof valor === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (ehChaveSecreta(k) || formasDaChave(k).some((f) => CHAVE_BANCARIA.test(f) || CHAVE_IDENTIDADE.test(f))) continue;
      out[k] = limparRegistro(v, k);
    }
    return out as T;
  }
  return valor;
}

/**
 * Argumentos de uma ferramenta como a AUDITORIA os guarda: todo texto passa pela máscara (CPF digitado na busca com
 * ou sem pontuação, telefone, "senha: xxx"), em qualquer profundidade e em modo célula (na dúvida, apaga o resto).
 * O campo de CPF/CNPJ puro (`cpfCnpj`) nunca fica inteiro, mesmo sem pontuação.
 */
export function mascararArgumentos<T>(args: T): T {
  const ir = (v: unknown, chave: string): unknown => {
    if (typeof v === 'string') return formasDaChave(chave).some((f) => CABECALHO_CPF.test(f)) ? mascararCelula(v, chave) : mascararTexto(v, 'celula');
    if (Array.isArray(v)) return v.map((x) => ir(x, chave));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ir(x, k)]));
    return v;
  };
  return ir(args, '') as T;
}

/**
 * Mensagem de erro de uma ferramenta, como ela VOLTA ao modelo e como a AUDITORIA a guarda. O erro repete o que veio no
 * pedido ("404 em /v1/processos/123.456.789-09", "cliente 12345678000195 não achado"), então passa pela mesma máscara
 * dos argumentos: CPF, CNPJ e telefone (com ou sem pontuação) e "senha: xxx". Uma função só, para os dois destinos
 * não divergirem.
 */
export function mascararErro(mensagem: string): string {
  return mascararTexto(mensagem, 'texto');
}
