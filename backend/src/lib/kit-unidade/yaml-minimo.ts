/**
 * LEITOR DE YAML MÍNIMO para o questionário do kit de unidade (sem dependência nova: cadeia de suprimentos, OWASP A03).
 *
 * Aceita só o subconjunto que o questionário usa: mapas por indentação (espaços), listas com "- " (de valores ou de mapas), listas
 * em linha `[a, b]`, texto entre aspas simples ou duplas, números, true/false, null/~, bloco de texto `|` e comentários `#`.
 * Qualquer outra coisa (tabulação, âncoras `&`/`*`, `---`, chaves `{}`, `>`) é ERRO com o número da linha — nunca interpretação
 * silenciosa. O questionário também pode ser JSON.
 */

interface Linha {
  n: number;
  indent: number;
  texto: string;
}

export class ErroDeYaml extends Error {
  constructor(
    mensagem: string,
    public readonly linha: number,
  ) {
    super(`linha ${linha}: ${mensagem}`);
  }
}

/** Tira o comentário (`#` fora de aspas, precedido de espaço ou no começo). */
function semComentario(s: string): string {
  let aspas: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (aspas) {
      if (c === '\\' && aspas === '"') i++;
      else if (c === aspas) aspas = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:\[,-]/.test(s[i - 1]!)) aspas = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
  }
  return s;
}

function lerEscalar(bruto: string, n: number): unknown {
  const t = bruto.trim();
  if (t === '') return null;
  if (t[0] === '"') {
    if (t.length < 2 || t[t.length - 1] !== '"') throw new ErroDeYaml('aspas duplas sem fechar', n);
    try {
      return JSON.parse(t);
    } catch {
      throw new ErroDeYaml('texto entre aspas duplas inválido', n);
    }
  }
  if (t[0] === "'") {
    if (t.length < 2 || t[t.length - 1] !== "'") throw new ErroDeYaml('aspas simples sem fechar', n);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t[0] === '[') {
    if (t[t.length - 1] !== ']') throw new ErroDeYaml('lista em linha sem fechar', n);
    const miolo = t.slice(1, -1).trim();
    if (!miolo) return [];
    const itens: string[] = [];
    let atual = '';
    let aspas: string | null = null;
    for (const c of miolo) {
      if (aspas) {
        atual += c;
        if (c === aspas) aspas = null;
      } else if (c === '"' || c === "'") {
        aspas = c;
        atual += c;
      } else if (c === ',') {
        itens.push(atual);
        atual = '';
      } else atual += c;
    }
    itens.push(atual);
    return itens.map((x) => lerEscalar(x, n));
  }
  if (/^[&*!>{}]/.test(t) || t === '---') throw new ErroDeYaml(`recurso de YAML não suportado (${t[0]})`, n);
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t) && Number.isSafeInteger(Number(t)) && !/^-?0\d/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  return t;
}

/** `chave: valor` → [chave, resto]; null se não é um par. A chave é simples (letras, dígitos, _ . -). */
function partir(texto: string): [string, string] | null {
  const m = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/.exec(texto);
  return m ? [m[1]!, (m[2] ?? '').trim()] : null;
}

export function lerYaml(fonte: string): unknown {
  const linhas: Linha[] = [];
  const cruas = fonte.replace(/^\uFEFF/, '').split(/\r?\n/);
  const blocos = new Map<number, string>(); // linha (índice em `linhas`) → texto de bloco `|`
  for (let k = 0; k < cruas.length; k++) {
    const cru = cruas[k]!;
    if (/\t/.test(cru.match(/^\s*/)![0])) throw new ErroDeYaml('tabulação na indentação (use espaços)', k + 1);
    const limpo = semComentario(cru).replace(/\s+$/, '');
    if (!limpo.trim()) continue;
    linhas.push({ n: k + 1, indent: limpo.length - limpo.trimStart().length, texto: limpo.trim() });
  }
  if (!linhas.length) throw new ErroDeYaml('arquivo vazio', 1);
  let i = 0;

  /** Bloco de texto `|`: junta as linhas MAIS indentadas que a chave, a partir das cruas (comentários ficam). */
  function lerBloco(chaveIndent: number, nLinha: number): string {
    const saida: string[] = [];
    let base = -1;
    for (let k = nLinha; k < cruas.length; k++) {
      const cru = cruas[k]!;
      if (!cru.trim()) {
        saida.push('');
        continue;
      }
      const ind = cru.length - cru.trimStart().length;
      if (ind <= chaveIndent) break;
      if (base < 0) base = ind;
      saida.push(cru.slice(Math.min(base, ind)));
    }
    // consome as linhas já tokenizadas que pertencem ao bloco
    while (i < linhas.length && linhas[i]!.n > nLinha && linhas[i]!.n <= nLinha + saida.length) i++;
    while (saida.length && saida[saida.length - 1] === '') saida.pop();
    return saida.join('\n') + '\n';
  }

  function valor(resto: string, indentDaChave: number, n: number): unknown {
    if (resto === '|') return lerBloco(indentDaChave, n);
    if (resto !== '') return lerEscalar(resto, n);
    const prox = linhas[i];
    if (prox && prox.indent > indentDaChave) return bloco(prox.indent);
    if (prox && prox.indent === indentDaChave && prox.texto.startsWith('- ')) return lista(prox.indent);
    return null;
  }

  function mapa(indent: number): Record<string, unknown> {
    const saida: Record<string, unknown> = {};
    while (i < linhas.length) {
      const l = linhas[i]!;
      if (l.indent < indent) break;
      if (l.indent > indent) throw new ErroDeYaml('indentação inesperada', l.n);
      if (l.texto.startsWith('- ')) break;
      const par = partir(l.texto);
      if (!par) throw new ErroDeYaml(`esperava "chave: valor", achei «${l.texto.slice(0, 40)}»`, l.n);
      if (Object.prototype.hasOwnProperty.call(saida, par[0]) || par[0] === '__proto__') throw new ErroDeYaml(`chave repetida (${par[0]})`, l.n);
      i++;
      saida[par[0]] = valor(par[1], indent, l.n);
    }
    return saida;
  }

  function lista(indent: number): unknown[] {
    const saida: unknown[] = [];
    while (i < linhas.length) {
      const l = linhas[i]!;
      if (l.indent !== indent || !(l.texto.startsWith('- ') || l.texto === '-')) break;
      const item = l.texto === '-' ? '' : l.texto.slice(2).trim();
      if (item === '') {
        i++;
        const prox = linhas[i];
        saida.push(prox && prox.indent > indent ? bloco(prox.indent) : null);
      } else if (partir(item) && !/^["'\[]/.test(item)) {
        // "- chave: valor" abre um mapa cujas outras chaves ficam 2 colunas à frente do traço
        linhas[i] = { n: l.n, indent: indent + 2, texto: item };
        saida.push(mapa(indent + 2));
      } else {
        i++;
        saida.push(lerEscalar(item, l.n));
      }
    }
    return saida;
  }

  function bloco(indent: number): unknown {
    const l = linhas[i]!;
    return l.texto.startsWith('- ') || l.texto === '-' ? lista(indent) : mapa(indent);
  }

  const primeira = linhas[0]!;
  if (primeira.indent !== 0) throw new ErroDeYaml('o documento começa indentado', primeira.n);
  const raiz = bloco(0);
  if (i < linhas.length) throw new ErroDeYaml('conteúdo fora do lugar', linhas[i]!.n);
  return raiz;
}

/** YAML ou JSON, pelo primeiro caractere útil. */
export function lerYamlOuJson(fonte: string): unknown {
  const t = fonte.replace(/^\uFEFF/, '').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return JSON.parse(t);
  return lerYaml(fonte);
}
