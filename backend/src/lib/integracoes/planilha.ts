/**
 * Leitura de planilha do Google Sheets, SÓ LEITURA, sem biblioteca de terceiros.
 *
 * Modo `publico` (o único que lê hoje): a planilha está compartilhada como "qualquer pessoa com o link" e
 * o Google entrega o arquivo em `…/export?format=xlsx` sem login. Só GET.
 * Modo `conta_de_servico` (Sheets API): gancho para depois — o formato da chave já o reconhece, a leitura
 * ainda não existe.
 *
 * A planilha sai LIMPA desta camada (`limparAba`): coluna de senha/login/"meu inss" é descartada aqui, antes
 * de qualquer cache, filtro, busca ou resposta; CPF e telefone saem mascarados. Quem consome só vê o limpo.
 *
 * O xlsx é lido à mão (zip + XML) por três motivos: não há biblioteca de planilha nas dependências, as boas
 * trazem dezenas de pacotes (OWASP A03, cadeia de suprimentos) e a única que é "a" biblioteca tem CVEs abertas.
 * Os tetos abaixo existem porque o arquivo vem da rede: tamanho baixado, tamanho descomprimido, linhas, colunas.
 */
import { inflateRawSync } from 'node:zlib';
import { dormir } from '../../franquia-mcp/ritmo.js';
import { ehColunaSecreta, mascararCelula, mascararTexto, temCpfColado } from './mascaras.js';

const AGENTE = 'DoutorDigital-Conector/1.0';
const EXPORT = 'https://docs.google.com/spreadsheets/d';

export const MAX_BAIXADO = 25 * 1024 * 1024;
export const MAX_DESCOMPRIMIDO = 40 * 1024 * 1024;
export const MAX_LINHAS_LIDAS = 20_000;
export const MAX_COLUNAS = 200;
/** coluna em que pelo menos esta fração das células não vazias é "CPF/senha" colado é de credencial, mesmo sem dizer no cabeçalho */
const FRACAO_CREDENCIAL = 0.3;

export class ErroPlanilha extends Error {
  constructor(msg: string, readonly status: number | null = null) {
    super(msg);
  }
}

export type ModoPlanilha = 'publico' | 'conta_de_servico';

// ----------------------------------------------------------------- zip

interface EntradaZip {
  metodo: number;
  comprimido: number;
  offset: number;
}

function indiceDoZip(buf: Buffer): Map<string, EntradaZip> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ErroPlanilha('o arquivo baixado não é um xlsx (zip sem diretório)');
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entradas = new Map<string, EntradaZip>();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ErroPlanilha('xlsx corrompido (diretório do zip)');
    const n = buf.readUInt16LE(p + 28);
    const m = buf.readUInt16LE(p + 30);
    const k = buf.readUInt16LE(p + 32);
    entradas.set(buf.toString('utf8', p + 46, p + 46 + n), { metodo: buf.readUInt16LE(p + 10), comprimido: buf.readUInt32LE(p + 20), offset: buf.readUInt32LE(p + 42) });
    p += 46 + n + m + k;
  }
  return entradas;
}

function extrair(buf: Buffer, e: EntradaZip): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ErroPlanilha('xlsx corrompido (cabeçalho local do zip)');
  const ini = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const dados = buf.subarray(ini, ini + e.comprimido);
  if (e.metodo === 0) {
    if (dados.length > MAX_DESCOMPRIMIDO) throw new ErroPlanilha('xlsx grande demais depois de descomprimido');
    return dados;
  }
  if (e.metodo !== 8) throw new ErroPlanilha(`xlsx com compressão não suportada (${e.metodo})`);
  try {
    // o tamanho declarado no zip pode mentir: o teto vale para o que de fato sai da descompressão
    return inflateRawSync(dados, { maxOutputLength: MAX_DESCOMPRIMIDO });
  } catch {
    throw new ErroPlanilha('xlsx grande demais depois de descomprimido, ou corrompido');
  }
}

// ----------------------------------------------------------------- xml

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodificar(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (todo, e: string) => {
    if (e[0] !== '#') return ENTIDADES[e.toLowerCase()] ?? todo;
    const cod = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(cod) && cod >= 0 && cod <= 0x10ffff ? String.fromCodePoint(cod) : todo;
  });
}

const REGEX_ATRIBUTO = new Map<string, RegExp>();
const atributo = (tag: string, nome: string): string | undefined => {
  let re = REGEX_ATRIBUTO.get(nome);
  if (!re) REGEX_ATRIBUTO.set(nome, (re = new RegExp(`(?:^|\\s)${nome}="([^"]*)"`)));
  const m = re.exec(tag);
  return m ? decodificar(m[1]!) : undefined;
};

/** Texto de um bloco `<si>` ou `<is>`: junta os `<t>` e ignora a fonética (`<rPh>`). */
function textoDe(bloco: string): string {
  const sem = bloco.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of sem.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += decodificar(m[1] ?? '');
  return out;
}

const colunaDe = (ref: string): number => {
  let n = 0;
  for (const ch of /^[A-Z]+/i.exec(ref)?.[0] ?? '') n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
};

const FORMATOS_DE_DATA = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** Quais estilos (`s="N"`) são data: formatos prontos de data ou código com d/m/a/h/s fora de aspas e colchetes. */
function estilosDeData(styles: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    const id = Number(atributo(m[1]!, 'numFmtId'));
    const codigo = atributo(m[1]!, 'formatCode');
    if (Number.isFinite(id) && codigo !== undefined) custom.set(id, codigo);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(atributo(m[1]!, 'numFmtId') ?? 0);
    const codigo = custom.get(id);
    const ehData = codigo !== undefined ? /[dmyhs]/i.test(codigo.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) : FORMATOS_DE_DATA.has(id);
    if (ehData) out.add(i);
    i++;
  }
  return out;
}

function dataDoSerial(serial: number): string {
  const dias = Math.floor(serial);
  const frac = serial - dias;
  const d = new Date(Date.UTC(1899, 11, 30) + dias * 86_400_000);
  const dia = d.toISOString().slice(0, 10);
  if (frac < 1e-6) return dia;
  const min = Math.round(frac * 1440);
  return `${dia} ${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export interface AbaBruta {
  nome: string;
  linhas: string[][];
  truncado: boolean;
}

/** Lê o xlsx inteiro em matrizes de texto. Aba escondida fica de fora: quem a escondeu não a quis na tela. */
export function lerXlsx(buf: Buffer): AbaBruta[] {
  try {
    const zip = indiceDoZip(buf);
    const ler = (nome: string): string | undefined => {
      const e = zip.get(nome);
      return e ? extrair(buf, e).toString('utf8') : undefined;
    };
    const workbook = ler('xl/workbook.xml');
    if (!workbook) throw new ErroPlanilha('o arquivo baixado não é um xlsx (sem xl/workbook.xml)');
    const rels = new Map<string, string>();
    for (const m of (ler('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const id = atributo(m[1]!, 'Id');
      const alvo = atributo(m[1]!, 'Target');
      if (id && alvo) rels.set(id, alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`);
    }
    const compartilhadas = [...(ler('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => textoDe(m[1] ?? ''));
    const datas = estilosDeData(ler('xl/styles.xml'));

    const abas: AbaBruta[] = [];
    for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
      const tag = m[1]!;
      if ((atributo(tag, 'state') ?? 'visible') !== 'visible') continue;
      const nome = atributo(tag, 'name') ?? `Aba ${abas.length + 1}`;
      const caminho = rels.get(atributo(tag, 'r:id') ?? '');
      const xml = caminho ? ler(caminho) : undefined;
      if (xml === undefined) continue;
      abas.push(lerAba(nome, xml, compartilhadas, datas));
    }
    return abas;
  } catch (e) {
    if (e instanceof ErroPlanilha) throw e;
    throw new ErroPlanilha('não consegui ler o arquivo como xlsx (formato inesperado)');
  }
}

function lerAba(nome: string, xml: string, compartilhadas: string[], datas: Set<number>): AbaBruta {
  const linhas: string[][] = [];
  let truncado = false;
  let proxima = 0;
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const indice = (Number(atributo(r[1]!, 'r')) || proxima + 1) - 1;
    proxima = indice + 1;
    if (!r[2]) continue;
    if (indice >= MAX_LINHAS_LIDAS) {
      truncado = true;
      break;
    }
    const linha: string[] = [];
    let seguinte = 0;
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = atributo(c[1]!, 'r') ? colunaDe(atributo(c[1]!, 'r')!) : seguinte;
      seguinte = col + 1;
      if (col >= MAX_COLUNAS) {
        truncado = true;
        continue;
      }
      const corpo = c[2] ?? '';
      const tipo = atributo(c[1]!, 't') ?? 'n';
      const bruto = decodificar(/<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1] ?? '');
      let valor = '';
      if (tipo === 's') valor = compartilhadas[Number(bruto)] ?? '';
      else if (tipo === 'inlineStr') valor = textoDe(/<is>([\s\S]*?)<\/is>/.exec(corpo)?.[1] ?? '');
      else if (tipo === 'b') valor = bruto === '' ? '' : bruto === '1' ? 'VERDADEIRO' : 'FALSO';
      else if (tipo === 'n' && bruto !== '' && datas.has(Number(atributo(c[1]!, 's') ?? 0)) && Number.isFinite(Number(bruto))) valor = dataDoSerial(Number(bruto));
      else valor = bruto;
      while (linha.length < col) linha.push('');
      linha[col] = valor;
    }
    while (linhas.length < indice) linhas.push([]);
    linhas[indice] = linha;
  }
  return { nome, linhas, truncado };
}

// ----------------------------------------------------------------- limpeza (a origem do descarte)

export interface ColunaDescartada {
  cabecalho: string;
  motivo: string;
}

export interface AbaLimpa {
  nome: string;
  cabecalhos: string[];
  linhas: string[][];
  linhasTotal: number;
  /** a aba passou do teto de linhas/colunas lido: os números são parciais */
  truncado: boolean;
  colunasDescartadas: ColunaDescartada[];
}

export interface PlanilhaLimpa {
  abas: AbaLimpa[];
}

const letrasDe = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * A 1ª linha com algum valor é o cabeçalho. Descarta, ANTES de qualquer outra coisa, a coluna cujo cabeçalho é
 * de credencial ou em que o "CPF/senha" colado é comum; mascara CPF/telefone no que sobra. Nada que passe
 * daqui carrega senha.
 */
export function limparAba(bruta: Omit<AbaBruta, 'truncado'> & { truncado?: boolean }): AbaLimpa {
  const nao_vazia = (l: string[]) => l.some((c) => c.trim() !== '');
  const iCab = bruta.linhas.findIndex(nao_vazia);
  if (iCab < 0) return { nome: bruta.nome, cabecalhos: [], linhas: [], linhasTotal: 0, truncado: !!bruta.truncado, colunasDescartadas: [] };
  const cab = bruta.linhas[iCab]!;
  const dados = bruta.linhas.slice(iCab + 1).filter(nao_vazia);
  const largura = Math.max(cab.length, ...dados.map((l) => l.length));

  const descartadas: ColunaDescartada[] = [];
  const manter: number[] = [];
  for (let c = 0; c < largura; c++) {
    const nome = (cab[c] ?? '').trim();
    const colados = dados.filter((l) => temCpfColado(l[c] ?? '')).length + (temCpfColado(nome) ? 1 : 0);
    const preenchidas = dados.filter((l) => (l[c] ?? '').trim() !== '').length;
    if (nome && ehColunaSecreta(nome)) descartadas.push({ cabecalho: mascararTexto(nome), motivo: 'cabeçalho de senha/login' });
    else if (colados > 0 && colados / Math.max(preenchidas, 1) >= FRACAO_CREDENCIAL) descartadas.push({ cabecalho: mascararTexto(nome) || `coluna ${letrasDe(c)}`, motivo: 'valores no formato CPF/senha' });
    else manter.push(c);
  }

  const usados = new Map<string, number>();
  const cabecalhos = manter.map((c) => {
    const base = mascararTexto((cab[c] ?? '').trim()) || `coluna ${letrasDe(c)}`;
    const n = (usados.get(base) ?? 0) + 1;
    usados.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const linhas = dados.map((l) => manter.map((c, k) => mascararCelula(l[c] ?? '', cabecalhos[k]!)));
  return { nome: bruta.nome, cabecalhos, linhas, linhasTotal: linhas.length, truncado: !!bruta.truncado, colunasDescartadas: descartadas };
}

// ----------------------------------------------------------------- chave e download

const ID_VALIDO = /^[A-Za-z0-9_-]{20,120}$/;

/** O id da planilha, a partir do id puro ou da URL de edição. Nada além do id entra na URL de download. */
export function idDaPlanilha(entrada: string): string {
  const t = entrada.trim();
  const id = ID_VALIDO.test(t) ? t : /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,120})(?:[/?#]|$)/.exec(t)?.[1];
  if (!id) throw new ErroPlanilha('id de planilha inválido: cole o id (a parte longa da URL, depois de /d/) ou a URL docs.google.com/spreadsheets/d/…');
  return id;
}

export interface PlanilhaDaChave {
  apelido: string;
  id: string;
  modo: ModoPlanilha;
}

/**
 * A "chave" que o painel guarda cifrada para este provedor não é segredo no modo público: é a lista de
 * planilhas liberadas, `apelido=id_ou_url` separadas por `;` ou quebra de linha. O apelido é opcional.
 * JSON de conta de serviço é o gancho do modo `conta_de_servico` — reconhecido, ainda não implementado.
 */
export function interpretarChavePlanilha(chave: string): PlanilhaDaChave[] {
  const t = chave.trim();
  if (t.startsWith('{')) throw new ErroPlanilha('o modo conta de serviço (Sheets API) ainda não foi implementado: por enquanto, compartilhe a planilha como "qualquer pessoa com o link" e cole só o id');
  const itens = t.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!itens.length) throw new ErroPlanilha('nenhuma planilha informada');
  const vistos = new Set<string>();
  return itens.map((item, i) => {
    const m = /^(?!https?:)([^=]{1,40})=(.+)$/.exec(item);
    const apelido = (m ? m[1]!.trim() : i === 0 && itens.length === 1 ? 'principal' : `planilha ${i + 1}`).toLowerCase();
    if (vistos.has(apelido)) throw new ErroPlanilha(`apelido repetido: ${apelido}`);
    vistos.add(apelido);
    return { apelido, id: idDaPlanilha(m ? m[2]! : item), modo: 'publico' as const };
  });
}

type Fetcher = typeof fetch;

async function lerCorpo(resp: Response): Promise<Buffer> {
  const declarado = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > MAX_BAIXADO) throw new ErroPlanilha('a planilha é grande demais para ler (mais de 25 MB)');
  const leitor = resp.body?.getReader();
  if (!leitor) return Buffer.from(await resp.arrayBuffer());
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BAIXADO) {
      await leitor.cancel();
      throw new ErroPlanilha('a planilha é grande demais para ler (mais de 25 MB)');
    }
    partes.push(value);
  }
  return Buffer.concat(partes);
}

/** GET no export xlsx. Planilha que não é pública faz o Google devolver a página de login (HTML) com status 200. */
export async function baixarXlsx(id: string, fetcher: Fetcher = fetch): Promise<Buffer> {
  const url = `${EXPORT}/${idDaPlanilha(id)}/export?format=xlsx`;
  const naoPublica = 'a planilha não está compartilhada como "qualquer pessoa com o link" (leitor): abra Compartilhar no Google Sheets e mude o acesso geral';
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    let resp: Response;
    try {
      resp = await fetcher(url, { method: 'GET', headers: { 'User-Agent': AGENTE, Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(45_000) });
    } catch (e) {
      if (tentativa < 2) {
        await dormir(1000 * (tentativa + 1));
        continue;
      }
      throw new ErroPlanilha(`sem resposta do Google Sheets: ${String(e).slice(0, 160)}`);
    }
    if ((resp.status === 429 || resp.status >= 500) && tentativa < 2) {
      await resp.body?.cancel();
      await dormir(2000 * (tentativa + 1));
      continue;
    }
    if (resp.status === 404) throw new ErroPlanilha('planilha não encontrada: confira o id', 404);
    if (resp.status === 401 || resp.status === 403) throw new ErroPlanilha(`${naoPublica} (${resp.status})`, resp.status);
    if (resp.status === 429) throw new ErroPlanilha('o Google Sheets limitou as leituras (429): tente de novo em alguns minutos', 429);
    if (!resp.ok) throw new ErroPlanilha(`o Google Sheets respondeu ${resp.status}`, resp.status);
    const buf = await lerCorpo(resp);
    if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new ErroPlanilha(naoPublica);
    return buf;
  }
  throw new ErroPlanilha('o Google Sheets não respondeu depois de 3 tentativas', 429);
}

/** Baixa e já devolve LIMPA: o conteúdo cru não sai desta função. */
export async function lerPlanilhaPublica(id: string, fetcher: Fetcher = fetch): Promise<PlanilhaLimpa> {
  return { abas: lerXlsx(await baixarXlsx(id, fetcher)).map(limparAba) };
}

/**
 * Prova a chave: baixa cada planilha e devolve só o apelido, a quantidade e os nomes das abas para o painel.
 * Conteúdo (nem cabeçalho de coluna) não vai para o rótulo.
 */
export async function testarChavePlanilha(chave: string, fetcher: Fetcher = fetch): Promise<string> {
  const partes: string[] = [];
  for (const p of interpretarChavePlanilha(chave)) {
    const { abas } = await lerPlanilhaPublica(p.id, fetcher);
    partes.push(`${p.apelido} · ${abas.length} ${abas.length === 1 ? 'aba' : 'abas'} (${abas.map((a) => a.nome).join(', ').slice(0, 80)})`);
  }
  return `Planilha · ${partes.join(' + ')}`.slice(0, 250);
}
