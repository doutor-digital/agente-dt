/**
 * Gera um .xlsx FICTÍCIO em memória, só para teste: nada aqui lê planilha de ninguém. Imita o que o Google
 * Sheets exporta (strings compartilhadas, estilos de data, aba escondida, linha vazia, entidades XML).
 * Não é importado pelo código de produção.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export type CelulaFalsa = string | number | boolean | null | { data: number };
export interface AbaFalsa {
  nome: string;
  linhas: CelulaFalsa[][];
  escondida?: boolean;
  /** como o Google exporta: `<c>` sem valor para célula vazia, e `<row/>` para linha em branco */
  formaAlternativa?: 'inline';
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function letras(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

interface Entrada {
  nome: string;
  conteudo: Buffer;
  comprimir: boolean;
}

function zip(entradas: Entrada[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let offset = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const dados = e.comprimir ? deflateRawSync(e.conteudo) : e.conteudo;
    const crc = crc32(e.conteudo);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.comprimir ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(e.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    locais.push(local, nome, dados);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.comprimir ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(e.conteudo.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(offset, 42);
    centrais.push(central, nome);
    offset += 30 + nome.length + dados.length;
  }
  const cd = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(cd.length, 12);
  fim.writeUInt32LE(offset, 16);
  return Buffer.concat([...locais, cd, fim]);
}

export function xlsxFalso(abas: AbaFalsa[]): Buffer {
  const compartilhadas: string[] = [];
  const posicao = new Map<string, number>();
  const indice = (s: string) => {
    let i = posicao.get(s);
    if (i === undefined) {
      i = compartilhadas.push(s) - 1;
      posicao.set(s, i);
    }
    return i;
  };
  const planilhas = abas.map((aba) => {
    const linhas = aba.linhas
      .map((linha, r) => {
        if (!linha.length) return `<row r="${r + 1}"/>`;
        const cs = linha
          .map((c, k) => {
            const ref = `${letras(k)}${r + 1}`;
            if (c === null || c === '') return `<c r="${ref}"/>`;
            if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === 'boolean') return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
            if (typeof c === 'object') return `<c r="${ref}" s="1"><v>${c.data}</v></c>`;
            if (aba.formaAlternativa === 'inline') return `<c r="${ref}" t="inlineStr"><is><t>${xml(c)}</t></is></c>`;
            return `<c r="${ref}" t="s"><v>${indice(c)}</v></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cs}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas}</sheetData></worksheet>`;
  });
  const entradas: Entrada[] = [
    { nome: '[Content_Types].xml', comprimir: true, conteudo: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
    {
      nome: 'xl/workbook.xml',
      comprimir: true,
      conteudo: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${abas
          .map((a, i) => `<sheet name="${xml(a.nome)}" sheetId="${i + 1}"${a.escondida ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`)
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      nome: 'xl/_rels/workbook.xml.rels',
      comprimir: true,
      conteudo: Buffer.from(
        `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('')}</Relationships>`,
      ),
    },
    {
      nome: 'xl/styles.xml',
      comprimir: false,
      conteudo: Buffer.from('<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'),
    },
    ...planilhas.map((p, i) => ({ nome: `xl/worksheets/sheet${i + 1}.xml`, comprimir: true, conteudo: Buffer.from(p) })),
  ];
  entradas.push({
    nome: 'xl/sharedStrings.xml',
    comprimir: true,
    conteudo: Buffer.from(`<?xml version="1.0"?><sst count="${compartilhadas.length}" uniqueCount="${compartilhadas.length}">${compartilhadas.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('')}</sst>`),
  });
  return zip(entradas);
}
