/**
 * InfinitePay — o que a API NÃO lê (vendas, Pix recebidos, extrato, recebíveis) entra por RELATÓRIO IMPORTADO: a clínica exporta o relatório do app da
 * InfinitePay e o conector o lê e guarda nas tabelas `infinitepay_movimentos` e `infinitepay_vendas`. Este arquivo tem o que não depende do banco nem do
 * chat: ler o arquivo (OFX e CSV), importar com segurança e somar.
 *
 * O que está pronto e o que NÃO está:
 *   - OFX (extrato): leitor completo, escrito pela especificação do formato (v1 SGML e v2 XML). NÃO foi testado com um arquivo REAL da InfinitePay (não
 *     havia um): o leitor recusa o que não entende em vez de adivinhar, e a primeira importação real deve ser conferida contra o app.
 *   - CSV (vendas, recebíveis): a leitura do arquivo (aspas, delimitador, BOM) está pronta, mas NENHUM leiaute da InfinitePay está cadastrado, porque
 *     não se inventa coluna sem ver o arquivo. CSV de leiaute desconhecido NÃO grava nada: devolve só o cabeçalho (nunca as linhas) para o leiaute ser
 *     escrito em `LEIAUTES_CSV` e o mesmo arquivo ser importado de novo.
 *   - PDF: não é lido (não há como somar um PDF com segurança).
 *
 * Regras de honestidade do número: todo total sai com a COBERTURA (os períodos que de fato foram importados e as lacunas). Importar um mês não faz do
 * total do ano um total do ano. A descrição do lançamento vem do arquivo, com documento, telefone e e-mail mascarados (pode conter o nome de quem pagou).
 */
import { createHash, createHmac } from 'node:crypto';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { mascararDigitosSeguidos } from '../lib/pii.js';

export type TipoDeRelatorio = 'extrato' | 'vendas' | 'recebiveis';
export const RELATORIOS: readonly TipoDeRelatorio[] = ['extrato', 'vendas', 'recebiveis'];

export interface LinhaDeMovimento {
  /** AAAA-MM-DD */
  data: string;
  /** recebível: o dia previsto para cair */
  dataPrevista?: string;
  /** com sinal: entrada +, saída − */
  valorCentavos: number;
  descricao: string;
  /** o id do lançamento no arquivo (FITID), se houver */
  idExterno?: string;
}

export interface LinhaDeVenda {
  /** ISO 8601 */
  quando: string;
  valorBrutoCentavos: number;
  valorLiquidoCentavos?: number;
  forma: 'credito' | 'debito' | 'pix' | 'link' | 'outro';
  parcelas?: number;
  bandeira?: string;
  status?: string;
  idExterno?: string;
}

// ----------------------------------------------------------------- texto e números

/**
 * "1.234,56", "1234.56", "-12,5", "R$ 10,00" → centavos; undefined se não for número. Um texto só com PONTO é decimal ("1500.50", como o OFX escreve);
 * num CSV em português o ponto sozinho é MILHAR ("1.500" = mil e quinhentos): o leiaute de CSV passa `{ pontoEhMilhar: true }`.
 */
export function centavosDoTexto(bruto: string, o: { pontoEhMilhar?: boolean } = {}): number | undefined {
  let t = bruto.replace(/[R$\s]/g, '');
  if (!t) return undefined;
  const negativoPorParenteses = /^\(.*\)$/.test(t);
  t = t.replace(/[()]/g, '');
  const temVirgula = t.includes(',');
  const temPonto = t.includes('.');
  if (o.pontoEhMilhar && temPonto && !temVirgula) {
    // pt-BR sem vírgula: o ponto só pode ser separador de milhar (grupos de 3 dígitos); "12.5" não é número neste formato
    if (!/^[+-]?\d{1,3}(\.\d{3})+$/.test(t)) return undefined;
    t = t.replace(/\./g, '');
  } else if (temVirgula && temPonto) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (temVirgula) t = /^[+-]?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  if (!/^[+-]?\d+(\.\d{1,4})?$/.test(t)) return undefined;
  const n = Math.round(Number(t) * 100);
  if (!Number.isFinite(n) || Math.abs(n) > 2_000_000_000) return undefined;
  return negativoPorParenteses ? -Math.abs(n) : n;
}

function diaValido(a: string, m: string, d: string): string | undefined {
  const ano = Number(a);
  const mes = Number(m);
  const dia = Number(d);
  if (ano < 2000 || ano > 2100 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  const t = new Date(Date.UTC(ano, mes - 1, dia));
  return t.getUTCMonth() === mes - 1 ? `${a}-${m}-${d}` : undefined;
}

/** O limite do texto que as regras de mascaramento chegam a ver. Cortar ANTES de qualquer expressão regular: o arquivo vem de fora e pode ter um campo de megabytes. */
const MAX_ANTES_DE_MASCARAR = 600;

/**
 * O que sai do texto do arquivo e vai para o banco: sem documento, telefone nem e-mail, sem quebra de linha, até 200 caracteres.
 * Tempo LINEAR: o texto é cortado antes das expressões regulares e o e-mail é achado por palavra (toda palavra com "@" vira "[e-mail]"), sem a regex
 * `x+@y+.z+` que, em texto de 20 mil caracteres sem espaço, levava 3,3 s e travava o processo que a Sofia divide.
 */
export function descricaoSegura(bruto: string): string {
  // 1) colapsa os espaços (linear) ANTES de cortar: com o corte primeiro, uma sequência de espaços gastava o limite e o número depois dela escapava do mascaramento
  let colapsado = bruto.replace(/\s+/g, ' ').trim();
  // 2) corta; se o corte caiu no meio de um número (ou de um grupo de dígitos com separadores), esse resto de dígitos sai junto: nada de pedaço de documento sem máscara
  if (colapsado.length > MAX_ANTES_DE_MASCARAR) colapsado = colapsado.slice(0, MAX_ANTES_DE_MASCARAR).replace(/[\d\s.\-/()]+$/, '');
  const palavras = colapsado.split(' ');
  const t = palavras.map((p) => (p.includes('@') ? '[e-mail]' : p)).join(' ');
  return mascararDigitosSeguidos(t, 8, '[número]').slice(0, 200);
}

// ----------------------------------------------------------------- OFX

/** A conta do arquivo: só um hash (irreversível) e os 4 últimos caracteres. O número da conta nunca é guardado nem mostrado. */
export interface ContaDoArquivo {
  hash: string;
  final: string;
}

export interface ResultadoDoOfx {
  /** a conta que o arquivo declara (ACCTID + BANKID), se declara */
  conta?: ContaDoArquivo;
  linhas: LinhaDeMovimento[];
  periodoInicio?: string;
  periodoFim?: string;
  /** lançamentos que o leitor não entendeu (sem data ou valor válidos): contados, nunca adivinhados */
  ignoradas: number;
}

/** UTF-8 se for UTF-8 válido; senão Windows-1252 (o que o OFX v1 de `CHARSET:1252` e o CSV do Excel usam): os acentos não viram lixo. */
export function decodificar(b: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

const campoOfx = (bloco: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i').exec(bloco);
  const v = m?.[1]?.trim();
  return v ? v : undefined;
};

/** O fuso da clínica (Brasília, UTC-3 fixo desde 2019): o dia de um lançamento é o dia LÁ. */
const FUSO_DA_CLINICA_H = -3;

/**
 * A data de um campo OFX (`YYYYMMDD[HHMM[SS[.XXX]]][deslocamento[:NOME]]`) como dia de Brasília. Só data, ou hora SEM o deslocamento entre colchetes, vale como está
 * (o banco que manda hora local sem fuso quase sempre quer dizer o dia daquela hora). Com o deslocamento (`[-3:BRT]`, `[0:GMT]`, `[-5:EST]`) a hora é levada ao
 * instante real e daí ao dia de Brasília: `20261104010000[0:GMT]` é 22h00 de 03/11 em Brasília, e `20261103235900[-3:BRT]` continua dia 03.
 */
export function dataDoOfx(v: string | undefined): string | undefined {
  const m = v ? /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?(?:\.\d+)?)?\s*(?:\[\s*([+-]?\d+(?:[.,]\d+)?)\s*(?::[^\]]*)?\])?/.exec(v) : null;
  if (!m) return undefined;
  const dia = diaValido(m[1]!, m[2]!, m[3]!);
  if (!dia) return undefined;
  if (m[4] === undefined || m[7] === undefined) return dia;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6] ?? 0);
  const deslocamento = Number(m[7].replace(',', '.'));
  if (hh > 23 || mm > 59 || ss > 60 || !Number.isFinite(deslocamento) || Math.abs(deslocamento) > 14) return dia;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm, ss) - deslocamento * 3_600_000;
  return new Date(utc + FUSO_DA_CLINICA_H * 3_600_000).toISOString().slice(0, 10);
}

/** Lê um extrato OFX (v1 SGML ou v2 XML). Só as marcas conhecidas; nenhuma é interpretada como XML. A conta (ACCTID) só vira hash + final. */
export function lerOfx(texto: string, segredoDaConta = ''): ResultadoDoOfx {
  if (!/<OFX>/i.test(texto)) throw new ErroDeEntrada('isto não parece um arquivo OFX (não achei a marca <OFX>)');
  const linhas: LinhaDeMovimento[] = [];
  let ignoradas = 0;
  const blocos = texto.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/STMTRS>|<\/CCSTMTRS>|<\/OFX>|$)/gi) ?? [];
  for (const b of blocos) {
    const data = dataDoOfx(campoOfx(b, 'DTPOSTED'));
    const valorBruto = campoOfx(b, 'TRNAMT');
    const valor = valorBruto !== undefined ? centavosDoTexto(valorBruto) : undefined;
    if (!data || valor === undefined) {
      ignoradas += 1;
      continue;
    }
    const descricao = descricaoSegura([campoOfx(b, 'NAME'), campoOfx(b, 'MEMO')].filter(Boolean).join(' - ')) || (valor >= 0 ? 'entrada' : 'saída');
    const id = campoOfx(b, 'FITID');
    linhas.push({ data, valorCentavos: valor, descricao, ...(id ? { idExterno: id.slice(0, 120) } : {}) });
  }
  const periodoInicio = dataDoOfx(campoOfx(texto, 'DTSTART'));
  const periodoFim = dataDoOfx(campoOfx(texto, 'DTEND'));
  const datas = linhas.map((l) => l.data).sort();
  // a conta do arquivo: a identificação é lida só para CONFERIR se o arquivo é da mesma conta já importada da unidade; guarda-se o hash e o final
  // SÓ a conta DONA do extrato (BANKACCTFROM / CCACCTFROM, que vêm antes da lista de lançamentos): um TED traz a conta de destino em BANKACCTTO dentro do lançamento, e isso
  // não é "outra conta" do arquivo. O bloco vai até a lista de lançamentos, com ou sem a marca de fechamento (OFX v1 pode omiti-la).
  const donos = [...texto.matchAll(/<(?:BANKACCTFROM|CCACCTFROM)>([\s\S]{0,400}?)(?=<BANKTRANLIST>|<LEDGERBAL>|<STMTTRN>|<\/STMTRS>|<\/CCSTMTRS>|$)/gi)];
  const contas = new Map<string, string>();
  for (const d of donos) {
    const acct = /<ACCTID>\s*([^<\r\n]{1,64})/i.exec(d[1]!)?.[1]?.trim();
    if (acct) contas.set(`${/<BANKID>\s*([^<\r\n]{1,32})/i.exec(d[1]!)?.[1]?.trim() ?? ''}|${acct}`, acct);
  }
  if (contas.size > 1) throw new ErroDeEntrada('o arquivo tem lançamentos de MAIS DE UMA conta (BANKACCTFROM diferentes). Peça o extrato de uma conta por arquivo. Nada foi gravado.');
  const [dono, acct] = [...contas.entries()][0] ?? [];
  return {
    // HMAC com um segredo do SERVIDOR (não um sha256 puro): o número de uma conta tem pouca entropia e um hash simples se desfaria por tentativa; sem o segredo, não
    ...(dono && acct ? { conta: { hash: createHmac('sha256', segredoDaConta).update(dono).digest('hex').slice(0, 32), final: acct.replace(/\W/g, '').slice(-4) } } : {}),
    linhas,
    ignoradas,
    // o período declarado pelo arquivo; sem ele, o das linhas
    ...(periodoInicio ?? datas[0] ? { periodoInicio: periodoInicio ?? datas[0] } : {}),
    ...(periodoFim ?? datas.at(-1) ? { periodoFim: periodoFim ?? datas.at(-1) } : {}),
  };
}

// ----------------------------------------------------------------- CSV

export interface CsvLido {
  delimitador: ';' | ',' | '\t' | '|';
  cabecalho: string[];
  linhas: string[][];
}

/** CSV de verdade: aspas, aspas duplas escapadas, quebra dentro de campo, BOM e o delimitador escolhido pela primeira linha. */
export function lerCsv(texto: string): CsvLido {
  const t = texto.replace(/^\uFEFF/, '');
  const primeira = t.split(/\r?\n/, 1)[0] ?? '';
  const conta = (c: string) => primeira.split(c).length - 1;
  const delimitador = (['\t', ';', ',', '|'] as const).reduce((melhor, c) => (conta(c) > conta(melhor) ? c : melhor), ',' as ';' | ',' | '\t' | '|');
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (aspas) {
      if (c === '"' && t[i + 1] === '"') {
        campo += '"';
        i += 1;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === delimitador) {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i += 1;
      linha.push(campo);
      campo = '';
      if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  if (campo !== '' || linha.length) {
    linha.push(campo);
    if (linha.some((x) => x.trim() !== '')) linhas.push(linha);
  }
  if (aspas) throw new ErroDeEntrada('o CSV termina no meio de um campo entre aspas: o arquivo está cortado ou corrompido');
  const [cabecalho = [], ...resto] = linhas;
  return { delimitador, cabecalho: cabecalho.map((c) => c.trim()), linhas: resto };
}

export const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface LeiauteCsv {
  nome: string;
  relatorio: TipoDeRelatorio;
  /** recebe o cabeçalho já sem acento e em minúsculo */
  reconhece(cabecalho: string[]): boolean;
  ler(csv: CsvLido): { movimentos?: LinhaDeMovimento[]; vendas?: LinhaDeVenda[]; ignoradas: number; periodoInicio?: string; periodoFim?: string };
}

/**
 * Os leiautes de CSV conhecidos. VAZIO DE PROPÓSITO: o relatório de vendas e o de recebíveis da InfinitePay ainda não foram vistos por ninguém desta
 * equipe, e coluna inventada vira número errado no relatório do João. Para cadastrar um: peça o arquivo (ver `infinitepay_pedir_relatorio`), leia o
 * cabeçalho que a importação devolve, escreva o `LeiauteCsv` aqui com um teste do arquivo de exemplo (sem dado de paciente) e importe de novo.
 */
export const LEIAUTES_CSV: LeiauteCsv[] = [];

// ----------------------------------------------------------------- importar

export interface RelatorioLido {
  conta?: ContaDoArquivo;
  formato: 'ofx' | 'csv';
  leiaute: string;
  relatorio: TipoDeRelatorio;
  movimentos: LinhaDeMovimento[];
  vendas: LinhaDeVenda[];
  ignoradas: number;
  periodoInicio?: string;
  periodoFim?: string;
}

export type LeituraDoArquivo =
  | { reconhecido: true; lido: RelatorioLido }
  | { reconhecido: false; formato: 'csv'; delimitador: string; cabecalho: string[]; linhasNoArquivo: number; semCabecalho: boolean };

/**
 * A primeira linha de um CSV desconhecido volta ao chat para o leiaute ser escrito. Se o arquivo NÃO tem cabeçalho (ou tem uma linha de título antes), essa
 * linha é DADO (nome, documento, valor): então só passam células que parecem nome de coluna (curtas, sem 4 dígitos seguidos nem e-mail, sem número), e se
 * metade ou mais não parece, nenhuma célula volta e `semCabecalho` diz isso.
 */
function cabecalhoParaMostrar(cel: string[]): { cabecalho: string[]; semCabecalho: boolean } {
  const parece = (c: string) => c.length > 0 && c.length <= 40 && !/\d{4,}/.test(c) && !/@/.test(c) && !/^[-+R$\s\d.,/:()%]+$/.test(c);
  const boas = cel.filter(parece).length;
  if (cel.length === 0 || boas * 2 < cel.length) return { cabecalho: [], semCabecalho: true };
  return { cabecalho: cel.map((c) => (parece(c) ? c : '(coluna sem nome)')).slice(0, 60), semCabecalho: false };
}

/**
 * Lê o arquivo que chegou. `esperado` é o relatório que a pessoa disse que é: um OFX só pode ser extrato; um CSV só é lido por um leiaute do MESMO
 * relatório. Formato que não se reconhece NÃO vira erro mudo: volta `reconhecido: false` com o cabeçalho.
 */
export function lerRelatorio(conteudo: Buffer, tipoDoCofre: 'ofx' | 'csv', esperado: TipoDeRelatorio, segredoDaConta = ''): LeituraDoArquivo {
  const texto = decodificar(conteudo);
  if (tipoDoCofre === 'ofx') {
    if (esperado !== 'extrato') throw new ErroDeEntrada(`para ${esperado} use o CSV: o OFX é uma lista de lançamentos (data e valor) e não traz forma de pagamento, parcelas nem taxa. Para o OFX, escolha relatorio="extrato".`);
    const o = lerOfx(texto, segredoDaConta);
    if (o.linhas.length === 0) throw new ErroDeEntrada(`o OFX não tem nenhum lançamento que eu entenda (${o.ignoradas} ignorados). Nada foi gravado.`);
    return { reconhecido: true, lido: { ...(o.conta ? { conta: o.conta } : {}), formato: 'ofx', leiaute: 'ofx', relatorio: 'extrato', movimentos: o.linhas, vendas: [], ignoradas: o.ignoradas, ...(o.periodoInicio ? { periodoInicio: o.periodoInicio } : {}), ...(o.periodoFim ? { periodoFim: o.periodoFim } : {}) } };
  }
  const csv = lerCsv(texto);
  const cab = csv.cabecalho.map(semAcento);
  const leiaute = LEIAUTES_CSV.find((l) => l.relatorio === esperado && l.reconhece(cab));
  if (!leiaute) return { reconhecido: false, formato: 'csv', delimitador: csv.delimitador === '\t' ? 'tab' : csv.delimitador, ...cabecalhoParaMostrar(csv.cabecalho), linhasNoArquivo: csv.linhas.length };
  const r = leiaute.ler(csv);
  return {
    reconhecido: true,
    lido: { formato: 'csv', leiaute: leiaute.nome, relatorio: esperado, movimentos: r.movimentos ?? [], vendas: r.vendas ?? [], ignoradas: r.ignoradas, ...(r.periodoInicio ? { periodoInicio: r.periodoInicio } : {}), ...(r.periodoFim ? { periodoFim: r.periodoFim } : {}) },
  };
}

/** A chave que identifica um lançamento ao importar de novo: o id do arquivo ou, sem ele, um hash da linha + a ordem entre linhas iguais. */
export function chavesDosMovimentos(linhas: LinhaDeMovimento[]): string[] {
  const vistas = new Map<string, number>();
  return linhas.map((l) => {
    // o FITID só é único POR CONTA e por emissor (um contador que recomeça todo mês é comum): a chave leva também a data e o valor, então dois lançamentos
    // diferentes com o mesmo FITID não se apagam; o mesmo lançamento que reaparece num arquivo que se sobrepõe continua igual e é reconhecido como repetido
    const base = l.idExterno
      ? `id:${l.idExterno}|${l.data}|${l.valorCentavos}`
      : `h:${createHash('sha256').update([l.data, l.valorCentavos, l.descricao].join('|')).digest('hex').slice(0, 24)}`;
    const n = (vistas.get(base) ?? 0) + 1;
    vistas.set(base, n);
    return n === 1 && l.idExterno ? base : `${base}#${n}`;
  });
}

export function chavesDasVendas(linhas: LinhaDeVenda[]): string[] {
  const vistas = new Map<string, number>();
  return linhas.map((l) => {
    if (l.idExterno) return `id:${l.idExterno}`;
    const base = createHash('sha256').update([l.quando, l.valorBrutoCentavos, l.forma, l.parcelas ?? '', l.bandeira ?? ''].join('|')).digest('hex').slice(0, 24);
    const n = (vistas.get(base) ?? 0) + 1;
    vistas.set(base, n);
    return `h:${base}#${n}`;
  });
}

export const sha256Do = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ----------------------------------------------------------------- o armazém

export interface MovimentoGuardado {
  tipo: 'extrato' | 'recebivel';
  data: string;
  dataPrevista: string | null;
  valorCentavos: number;
  descricao: string;
}

export interface VendaGuardada {
  quando: string;
  valorBrutoCentavos: number;
  valorLiquidoCentavos: number | null;
  forma: string;
  parcelas: number | null;
  bandeira: string | null;
  status: string | null;
}

export interface ImportacaoGuardada {
  id: string;
  relatorio: string;
  formato: string;
  leiaute: string | null;
  periodoInicio: string | null;
  periodoFim: string | null;
  linhasLidas: number;
  linhasNovas: number;
  importadoPor: string;
  importadoEm: string;
  /** hash da conta do arquivo (nunca o número) e os 4 últimos caracteres; nulos quando o arquivo não declara conta */
  contaHash: string | null;
  contaFinal: string | null;
}

export interface NovaImportacao {
  unidade: string;
  relatorio: TipoDeRelatorio;
  formato: 'ofx' | 'csv';
  leiaute: string;
  sha256: string;
  bytes: number;
  periodoInicio?: string;
  periodoFim?: string;
  importadoPor: string;
  contaHash?: string;
  contaFinal?: string;
  movimentos: Array<LinhaDeMovimento & { tipo: 'extrato' | 'recebivel'; chave: string }>;
  vendas: Array<LinhaDeVenda & { chave: string }>;
}

export interface ArmazemDeRelatorios {
  jaImportado(unidade: string, sha256: string): Promise<boolean>;
  /** em que unidades este MESMO arquivo (sha256) já foi importado */
  unidadesComArquivo(sha256: string): Promise<string[]>;
  /** em que unidades já foi importado um extrato desta CONTA (hash da conta) */
  unidadesComConta(contaHash: string): Promise<string[]>;
  /** numa transação: cria a importação e as linhas que ainda não existem (a unicidade do banco manda). Devolve quantas eram novas. */
  gravar(i: NovaImportacao): Promise<{ id: string; novas: number }>;
  movimentos(f: { unidade: string; tipo?: 'extrato' | 'recebivel'; de?: string; ate?: string; limite: number }): Promise<MovimentoGuardado[]>;
  vendas(f: { unidade: string; de?: string; ate?: string; limite: number }): Promise<VendaGuardada[]>;
  importacoes(unidade: string, relatorio?: TipoDeRelatorio): Promise<ImportacaoGuardada[]>;
}

export type ResultadoDaImportacao =
  | { importado: false; motivo: 'ja_importado'; aviso: string }
  | { importado: false; motivo: 'arquivo_de_outra_unidade'; aviso: string; unidades: string[] }
  | { importado: false; motivo: 'conta_de_outra_unidade'; aviso: string; unidades: string[] }
  | { importado: false; motivo: 'outra_conta'; aviso: string; contaDoArquivo: string; contasJaImportadas: string[]; proximoPasso: string }
  | { importado: false; motivo: 'leiaute_desconhecido'; formato: 'csv'; delimitador: string; cabecalho: string[]; semCabecalho: boolean; linhasNoArquivo: number; aviso: string; proximoPasso: string }
  | { importado: true; aviso?: string; importacao: { id: string; relatorio: TipoDeRelatorio; formato: string; leiaute: string; periodoInicio: string | null; periodoFim: string | null; linhasLidas: number; linhasNovas: number; linhasRepetidas: number; linhasIgnoradas: number }; totais: Record<string, unknown> };

const reais = (c: number) => Math.round(c) / 100;

export async function importarRelatorio(
  armazem: ArmazemDeRelatorios,
  a: { unidade: string; relatorio: TipoDeRelatorio; tipoDoCofre: 'ofx' | 'csv'; conteudo: Buffer; importadoPor: string; aceitarOutraConta?: boolean; /** o segredo do servidor que torna o hash da conta um HMAC */ segredoDaConta?: string },
): Promise<ResultadoDaImportacao> {
  const sha = sha256Do(a.conteudo);
  if (await armazem.jaImportado(a.unidade, sha)) {
    return { importado: false, motivo: 'ja_importado', aviso: 'este mesmo arquivo já foi importado nesta unidade; nada mudou' };
  }
  // o MESMO arquivo em OUTRA unidade é quase certamente um engano (relatório de uma clínica indo para a conta de outra): recusa, sem exceção
  const outras = (await armazem.unidadesComArquivo(sha)).filter((u) => u !== a.unidade);
  if (outras.length > 0) {
    return { importado: false, motivo: 'arquivo_de_outra_unidade', unidades: outras, aviso: `este mesmo arquivo (mesmo conteúdo) já foi importado em ${outras.join(', ')}. Importar o mesmo relatório em duas unidades dobra o dinheiro de uma delas: não importei nada. Confira de que clínica é o arquivo e peça o relatório certo.` };
  }
  const leitura = lerRelatorio(a.conteudo, a.tipoDoCofre, a.relatorio, a.segredoDaConta);
  if (!leitura.reconhecido) {
    return {
      importado: false,
      motivo: 'leiaute_desconhecido',
      formato: 'csv',
      delimitador: leitura.delimitador,
      cabecalho: leitura.cabecalho,
      semCabecalho: leitura.semCabecalho,
      linhasNoArquivo: leitura.linhasNoArquivo,
      aviso: leitura.semCabecalho
        ? 'Não conheço o leiaute deste CSV (nenhum leiaute da InfinitePay está cadastrado ainda) e a primeira linha NÃO parece um cabeçalho (parece dado), então nem ela aparece aqui. NADA foi gravado. Peça o relatório de novo e confira se o arquivo tem a linha de títulos.'
        : 'Não conheço o leiaute deste CSV (nenhum leiaute da InfinitePay está cadastrado ainda). NADA foi gravado e as linhas do arquivo não foram lidas nem guardadas; só os nomes das colunas aparecem aqui.',
      proximoPasso: 'Passe este cabeçalho ao João: com ele (e um arquivo de exemplo SEM dados de paciente) o leiaute é cadastrado em LEIAUTES_CSV, e o mesmo arquivo é importado de novo (como nada foi gravado, não conta como repetido).',
    };
  }
  const l = leitura.lido;
  // a MESMA conta em duas unidades dobraria o dinheiro de uma delas. Um novo export do mesmo período tem bytes diferentes, então o sha256 não pega: quem pega é o hash da conta. Sem exceção.
  if (l.conta) {
    const donas = (await armazem.unidadesComConta(l.conta.hash)).filter((u) => u !== a.unidade);
    if (donas.length > 0) {
      return { importado: false, motivo: 'conta_de_outra_unidade', unidades: donas, aviso: `esta conta (final ${l.conta.final}) já tem extrato importado em ${donas.join(', ')}. A mesma conta em duas unidades contaria o dinheiro duas vezes: não importei nada. Confira de que clínica é o extrato.` };
    }
  }
  const anteriores = await armazem.importacoes(a.unidade);
  // a conta do arquivo tem de ser a que a unidade já importou: extrato de outra conta somaria dinheiro de outro lugar no total da unidade
  const avisos: string[] = [];
  if (l.conta) {
    const conhecidas = [...new Map(anteriores.filter((i) => i.contaHash).map((i) => [i.contaHash!, i.contaFinal ?? '????'])).entries()];
    if (conhecidas.length > 0 && !conhecidas.some(([h]) => h === l.conta!.hash)) {
      if (!a.aceitarOutraConta) {
        return {
          importado: false, motivo: 'outra_conta', contaDoArquivo: `final ${l.conta.final}`, contasJaImportadas: conhecidas.map(([, f]) => `final ${f}`),
          aviso: `este arquivo é de OUTRA conta (final ${l.conta.final}) que a já importada nesta unidade (${conhecidas.map(([, f]) => `final ${f}`).join(', ')}). Nada foi gravado: misturar contas dobra ou esconde dinheiro no total da unidade.`,
          proximoPasso: 'Se a unidade tem mesmo duas contas e é isso que você quer, chame infinitepay_importar_relatorio de novo com aceitarOutraConta=true (o arquivo continua guardado por alguns minutos). Senão, peça o extrato da conta certa.',
        };
      }
      avisos.push(`conta nova para esta unidade (final ${l.conta.final}), aceita por você: os totais da unidade passam a somar as DUAS contas (${conhecidas.map(([, f]) => `final ${f}`).join(', ')}).`);
    }
  } else if (a.relatorio === 'extrato') {
    avisos.push('o arquivo não declara a conta (ACCTID): não consegui conferir se é a mesma conta já importada desta unidade.');
  }
  const tipoMov = a.relatorio === 'recebiveis' ? 'recebivel' : 'extrato';
  const chavesM = chavesDosMovimentos(l.movimentos);
  const chavesV = chavesDasVendas(l.vendas);
  const total = l.movimentos.length + l.vendas.length;
  if (total === 0) throw new ErroDeEntrada('o arquivo foi reconhecido mas não tem nenhuma linha. Nada foi gravado.');
  const r = await armazem.gravar({
    unidade: a.unidade, relatorio: a.relatorio, formato: l.formato, leiaute: l.leiaute, sha256: sha, bytes: a.conteudo.length,
    ...(l.periodoInicio ? { periodoInicio: l.periodoInicio } : {}), ...(l.periodoFim ? { periodoFim: l.periodoFim } : {}), importadoPor: a.importadoPor,
    ...(l.conta ? { contaHash: l.conta.hash, contaFinal: l.conta.final } : {}),
    movimentos: l.movimentos.map((m, i) => ({ ...m, tipo: tipoMov as 'extrato' | 'recebivel', chave: chavesM[i]! })),
    vendas: l.vendas.map((v, i) => ({ ...v, chave: chavesV[i]! })),
  });
  const repetidas = total - r.novas;
  const antes = anteriores.filter((i) => i.relatorio === a.relatorio && i.id !== r.id);
  const sobrepoe = antes.some((i) => i.periodoInicio && i.periodoFim && l.periodoInicio && l.periodoFim && i.periodoInicio <= l.periodoFim && i.periodoFim >= l.periodoInicio);
  if (repetidas > 0 && !sobrepoe) avisos.push(`${repetidas} linha(s) foram tratadas como repetidas SEM que o período do arquivo encontre outro já importado: pode ser um identificador de lançamento reaproveitado pelo emissor. Confira o total com o app antes de confiar.`);
  // período que se sobrepõe a um arquivo já importado E linhas novas dentro dele: se forem os mesmos lançamentos com outro identificador, estão contados em dobro
  if (sobrepoe && r.novas > 0) avisos.push(`o período deste arquivo SE SOBREPÕE a um já importado e ${r.novas} linha(s) entraram como novas: se forem os MESMOS lançamentos com outro identificador (FITID) eles estão contados em dobro. Compare o total do período com o app antes de confiar.`);
  if (!l.periodoInicio || !l.periodoFim) avisos.push('o arquivo não declara o período: não dá para checar sobreposição com outros arquivos.');
  const entradas = l.movimentos.filter((m) => m.valorCentavos > 0).reduce((s, m) => s + m.valorCentavos, 0);
  const saidas = l.movimentos.filter((m) => m.valorCentavos < 0).reduce((s, m) => s + m.valorCentavos, 0);
  const bruto = l.vendas.reduce((s, v) => s + v.valorBrutoCentavos, 0);
  return {
    importado: true,
    importacao: {
      id: r.id, relatorio: a.relatorio, formato: l.formato, leiaute: l.leiaute, periodoInicio: l.periodoInicio ?? null, periodoFim: l.periodoFim ?? null,
      linhasLidas: total, linhasNovas: r.novas, linhasRepetidas: total - r.novas, linhasIgnoradas: l.ignoradas,
    },
    totais: l.movimentos.length ? { entradas: reais(entradas), saidas: reais(saidas), liquido: reais(entradas + saidas) } : { vendas: l.vendas.length, bruto: reais(bruto) },
    ...(avisos.length ? { aviso: avisos.join(' ') } : {}),
  };
}

// ----------------------------------------------------------------- cobertura e totais

const proximoDia = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Une os períodos importados e diz que dias do pedido NÃO estão cobertos por nenhum arquivo. */
export function coberturaDoPeriodo(importacoes: ImportacaoGuardada[], inicio?: string, fim?: string) {
  const faixas = importacoes
    .filter((i) => i.periodoInicio && i.periodoFim)
    .map((i) => [i.periodoInicio!, i.periodoFim!] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const unidas: Array<[string, string]> = [];
  for (const [de, ate] of faixas) {
    const ultima = unidas.at(-1);
    if (ultima && de <= proximoDia(ultima[1])) ultima[1] = ate > ultima[1] ? ate : ultima[1];
    else unidas.push([de, ate]);
  }
  const lacunas: Array<{ de: string; ate: string }> = [];
  if (inicio && fim) {
    let cursor = inicio;
    for (const [de, ate] of unidas) {
      if (ate < cursor) continue;
      if (de > fim) break;
      if (de > cursor) lacunas.push({ de: cursor, ate: new Date(Date.parse(`${de}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) });
      cursor = proximoDia(ate);
      if (cursor > fim) break;
    }
    if (cursor <= fim) lacunas.push({ de: cursor, ate: fim });
  }
  return {
    arquivosImportados: importacoes.length,
    periodosImportados: unidas.map(([de, ate]) => ({ de, ate })),
    ...(inicio && fim ? { periodoPedidoCompleto: lacunas.length === 0 && unidas.length > 0, lacunas } : {}),
    aviso:
      importacoes.length === 0
        ? 'nenhum relatório importado desta unidade: os números abaixo são ZERO por falta de dado, não por falta de venda'
        : 'os totais valem só para os períodos importados acima; o que não foi importado não está somado',
  };
}

export function totaisDoExtrato(linhas: MovimentoGuardado[]) {
  const entradas = linhas.filter((m) => m.valorCentavos > 0).reduce((s, m) => s + m.valorCentavos, 0);
  const saidas = linhas.filter((m) => m.valorCentavos < 0).reduce((s, m) => s + m.valorCentavos, 0);
  return { lancamentos: linhas.length, entradas: reais(entradas), saidas: reais(saidas), liquido: reais(entradas + saidas) };
}

export function totaisDasVendas(vendas: VendaGuardada[]) {
  const bruto = vendas.reduce((s, v) => s + v.valorBrutoCentavos, 0);
  const comLiquido = vendas.filter((v) => v.valorLiquidoCentavos !== null);
  const brutoComLiquido = comLiquido.reduce((s, v) => s + v.valorBrutoCentavos, 0);
  const liquido = comLiquido.reduce((s, v) => s + (v.valorLiquidoCentavos ?? 0), 0);
  const taxa = brutoComLiquido - liquido;
  return {
    vendas: vendas.length,
    bruto: reais(bruto),
    liquido: comLiquido.length ? reais(liquido) : null,
    taxa: comLiquido.length ? reais(taxa) : null,
    /** a taxa só sobre as vendas que têm valor líquido no arquivo (as outras não entram na conta) */
    taxaEfetivaPercentual: comLiquido.length && brutoComLiquido > 0 ? Math.round((taxa / brutoComLiquido) * 10_000) / 100 : null,
    ticketMedio: vendas.length ? reais(bruto / vendas.length) : null,
    vendasSemValorLiquido: vendas.length - comLiquido.length,
  };
}
