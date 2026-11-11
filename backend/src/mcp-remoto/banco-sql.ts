/**
 * Análise do SQL das ferramentas `banco_*` (puro, sem banco). Nada aqui confia em regex sobre o texto cru: o SQL vira uma lista de tokens
 * (texto entre aspas, identificador entre aspas duplas, $$…$$ e comentário saem do caminho) e todas as regras olham os tokens.
 *
 * LEITURA (`analisarLeitura`): um comando só, começando em SELECT/WITH; nenhuma palavra de escrita/DDL/SET; nenhuma função perigosa
 * (arquivo, dblink, set_config, sequência, query_to_xml…); nenhum nome do catálogo do sistema nem de outro esquema; nenhuma tabela ou coluna de
 * segredo, em lugar nenhum da consulta. Tabelas com coluna de segredo são lidas por um invólucro que só tem as colunas boas.
 *
 * ESCRITA (`analisarEscrita`): só três formas, escritas à mão — INSERT INTO t (colunas) VALUES (…),(…); UPDATE t SET c = … WHERE …;
 * DELETE FROM t WHERE … — sem RETURNING, ON CONFLICT, FROM/USING/JOIN no nível de cima, sem apelido, sem esquema, sem vários comandos.
 * UPDATE e DELETE exigem WHERE; a tabela precisa ter chave primária (é o que permite desfazer) e não ser view.
 *
 * Estas travas são a primeira camada. A segunda é do banco: a leitura roda em transação READ ONLY com `statement_timeout` (banco-pg.ts).
 */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { colunaSecreta, FUNCOES_PG_LIBERADAS, FUNCOES_PROIBIDAS, tabelaSecreta, TEXTOS_SECRETOS } from './banco-segredos.js';

export const MAX_CARACTERES_SQL = 20_000;
export const MAX_LINHAS_LEITURA = 500;
export const MAX_LINHAS_ESCRITA = 200;
export const MAX_BYTES_RESPOSTA = 200_000;

// ------------------------------------------------------------------ catálogo

export interface TabelaCat {
  /** nome real, como está no banco */
  nome: string;
  colunas: string[];
  /** colunas da chave primária, na ordem; vazio = sem chave */
  chave: string[];
  visao: boolean;
  linhas?: number | null;
}

export interface Catalogo {
  /** chave = nome da tabela em minúsculas */
  tabelas: Map<string, TabelaCat>;
  /** esquemas que existem além do public (minúsculas) */
  esquemas: string[];
  /** funções criadas no esquema public (minúsculas): não se chamam daqui */
  funcoes: string[];
}

export const colunasBoas = (t: TabelaCat): string[] => t.colunas.filter((c) => !colunaSecreta(c));
export const colunasOcultas = (t: TabelaCat): string[] => t.colunas.filter((c) => colunaSecreta(c));
/** tabela inteira de segredo ou sem nenhuma coluna que se possa mostrar */
export const tabelaFechada = (t: TabelaCat): boolean => tabelaSecreta(t.nome) || colunasBoas(t).length === 0;

export function criarCatalogo(tabelas: TabelaCat[], esquemas: string[] = [], funcoes: string[] = []): Catalogo {
  return {
    tabelas: new Map(tabelas.map((t) => [t.nome.toLowerCase(), t])),
    esquemas: esquemas.map((e) => e.toLowerCase()).filter((e) => e !== 'public'),
    funcoes: funcoes.map((f) => f.toLowerCase()),
  };
}

// ------------------------------------------------------------------ tokens

export interface Token {
  tipo: 'id' | 'qid' | 'str' | 'num' | 'pt';
  v: string;
  ini: number;
  fim: number;
}

const INICIO_ID = /[A-Za-z_\u0080-￿]/;
const CORPO_ID = /[A-Za-z0-9_$\u0080-￿]/;

const recusa = (m: string): never => {
  throw new ErroDeEntrada(m);
};

/** SQL → tokens. Recusa o que não fecha (texto, comentário, $$) e o que esconde nome (U&"…", $1). Comentário some. */
export function tokenizar(sql: string): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c < ' ' && c !== '\n' && c !== '\t' && c !== '\r' && c !== '\f') recusa('o SQL tem um caractere de controle');
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let nivel = 1;
      i += 2;
      while (i < n && nivel > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          nivel++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          nivel--;
          i += 2;
        } else i++;
      }
      if (nivel > 0) recusa('comentário /* … */ sem fechar');
      continue;
    }
    if (c === "'") {
      const ini = i;
      // E'…' aceita \ como escape; b'…', x'…' e n'…' são textos comuns: o prefixo colado ao texto não é um nome
      const ant = out.at(-1);
      const prefixo = ant && ant.tipo === 'id' && ant.fim === i && /^[ebxn]$/i.test(ant.v) ? ant : undefined;
      const comEscape = prefixo !== undefined && /^e$/i.test(prefixo.v);
      if (prefixo) out.pop();
      i++;
      let fechou = false;
      while (i < n) {
        if (comEscape && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          fechou = true;
          i++;
          break;
        }
        i++;
      }
      if (!fechou) recusa("texto entre aspas simples sem fechar");
      out.push({ tipo: 'str', v: sql.slice(ini, i), ini: prefixo?.ini ?? ini, fim: i });
      continue;
    }
    if (c === '"') {
      const ini = i;
      i++;
      let nome = '';
      let fechou = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            nome += '"';
            i += 2;
            continue;
          }
          fechou = true;
          i++;
          break;
        }
        nome += sql[i];
        i++;
      }
      if (!fechou) recusa('nome entre aspas duplas sem fechar');
      if (!nome) recusa('nome vazio entre aspas duplas');
      out.push({ tipo: 'qid', v: nome, ini, fim: i });
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (!m) recusa('parâmetro $n ou "$" solto: escreva o valor direto no SQL');
      const tag = m![0];
      const fim = sql.indexOf(tag, i + tag.length);
      if (fim < 0) recusa('texto $$ … $$ sem fechar');
      out.push({ tipo: 'str', v: sql.slice(i, fim + tag.length), ini: i, fim: fim + tag.length });
      i = fim + tag.length;
      continue;
    }
    if (INICIO_ID.test(c)) {
      const ini = i;
      i++;
      while (i < n && CORPO_ID.test(sql[i]!)) i++;
      const v = sql.slice(ini, i);
      // U&"…" / U&'…': escapes unicode que montam nomes sem o nome aparecer
      if (/^u$/i.test(v) && sql[i] === '&' && (sql[i + 1] === '"' || sql[i + 1] === "'")) recusa('U&"…" (escape unicode) não é aceito');
      out.push({ tipo: 'id', v, ini, fim: i });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const ini = i;
      while (i < n && /[0-9]/.test(sql[i]!)) i++;
      if (sql[i] === '.' && /[0-9]/.test(sql[i + 1] ?? '')) {
        i++;
        while (i < n && /[0-9]/.test(sql[i]!)) i++;
      }
      if (/[eE]/.test(sql[i] ?? '') && /[0-9+-]/.test(sql[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9]/.test(sql[i]!)) i++;
      }
      out.push({ tipo: 'num', v: sql.slice(ini, i), ini, fim: i });
      continue;
    }
    out.push({ tipo: 'pt', v: c, ini: i, fim: i + 1 });
    i++;
  }
  return out;
}

const baixo = (t: Token | undefined): string => (t ? t.v.toLowerCase() : '');
const ehPalavra = (t: Token | undefined, p: string): boolean => t?.tipo === 'id' && t.v.toLowerCase() === p;
const ehPonto = (t: Token | undefined, p: string): boolean => t?.tipo === 'pt' && t.v === p;
const ehNome = (t: Token | undefined): t is Token => t?.tipo === 'id' || t?.tipo === 'qid';

/** profundidade de parênteses ANTES de cada token */
function profundidades(toks: Token[]): number[] {
  const d: number[] = [];
  let n = 0;
  for (const t of toks) {
    if (ehPonto(t, ')')) n--;
    d.push(n);
    if (ehPonto(t, '(')) n++;
  }
  return d;
}

/** Valida e normaliza a entrada: um comando só, sem comentário solto, parênteses fechados. Devolve os tokens (sem o `;` final) e o SQL limpo. */
function prepararComando(entrada: unknown): { sql: string; toks: Token[] } {
  if (typeof entrada !== 'string' || !entrada.trim()) return recusa('sql vazio');
  if (entrada.length > MAX_CARACTERES_SQL) recusa(`sql grande demais (máximo ${MAX_CARACTERES_SQL} caracteres)`);
  const toks = tokenizar(entrada);
  if (!toks.length) recusa('sql vazio (só comentário)');
  const pontos = toks.map((t, i) => (ehPonto(t, ';') ? i : -1)).filter((i) => i >= 0);
  if (pontos.length > 1 || (pontos.length === 1 && pontos[0] !== toks.length - 1)) recusa('mande um comando só: ";" separando comandos não é aceito');
  if (pontos.length === 1) toks.pop();
  if (!toks.length) recusa('sql vazio');
  let nivel = 0;
  for (const t of toks) {
    if (ehPonto(t, '(')) nivel++;
    if (ehPonto(t, ')') && --nivel < 0) recusa('parênteses não batem: ")" sobrando');
  }
  if (nivel !== 0) recusa('parênteses não batem: falta fechar "("');
  return { sql: entrada.slice(toks[0]!.ini, toks.at(-1)!.fim), toks };
}

// ------------------------------------------------------------------ inspeção comum

/** palavras que escrevem, mudam estrutura/sessão ou executam texto; fora de nome entre aspas, não aparecem em lugar nenhum */
const PALAVRAS_PROIBIDAS = new Set([
  'insert', 'update', 'delete', 'merge', 'into', 'truncate', 'drop', 'alter', 'create', 'grant', 'revoke', 'copy', 'call', 'execute', 'do', 'set', 'vacuum',
  'returning', 'conflict', 'reset', 'begin', 'commit', 'rollback', 'savepoint', 'listen', 'notify', 'lock', 'analyze', 'cluster', 'reindex', 'prepare', 'deallocate',
]);

interface OpcoesInspecao {
  /** posições (no vetor de tokens) cujas palavras de escrita são do próprio comando (o INSERT, o INTO, o SET) */
  ignorar?: ReadonlySet<number>;
  /** posição do token que é a tabela-alvo da escrita (única ocorrência permitida de uma tabela restrita) */
  alvo?: number;
}

/** Regras comuns a leitura e escrita. Devolve as tabelas restritas (com coluna de segredo) que a consulta usa. */
function inspecionar(toks: Token[], cat: Catalogo, o: OpcoesInspecao = {}): TabelaCat[] {
  const restritas = new Map<string, TabelaCat>();
  toks.forEach((t, i) => {
    if (t.tipo === 'str') {
      const texto = t.v.toLowerCase();
      for (const s of TEXTOS_SECRETOS) if (texto.includes(s)) recusa(`o texto "${s}" aponta para um dado de segredo (convite de acesso): não é lido por aqui`);
      return;
    }
    if (!ehNome(t)) return;
    const baixa = t.v.toLowerCase();
    const proximo = toks[i + 1];
    if (t.tipo === 'id' && PALAVRAS_PROIBIDAS.has(baixa) && !o.ignorar?.has(i)) {
      recusa(`a palavra ${baixa.toUpperCase()} não é aceita aqui${baixa === 'set' || baixa === 'into' ? '' : ': leitura é só SELECT/WITH; escrita é banco_preparar_escrita (INSERT, UPDATE ou DELETE simples)'}`);
    }
    if (t.tipo === 'id' && baixa === 'for' && ['share', 'no', 'key', 'update'].includes(baixo(proximo))) recusa('FOR UPDATE/SHARE (trava de linha) não é aceito');
    if (baixa === 'information_schema' || (baixa.startsWith('pg_') && !FUNCOES_PG_LIBERADAS.has(baixa))) recusa(`"${t.v}" é do catálogo do sistema: o mapa do banco vem de banco_esquema`);
    if (FUNCOES_PROIBIDAS.test(baixa) && !FUNCOES_PG_LIBERADAS.has(baixa)) recusa(`a função/objeto "${t.v}" não é permitido (lê arquivo, executa texto como SQL, mexe em configuração/sequência ou sai do banco)`);
    if (ehPonto(proximo, '.') && cat.esquemas.includes(baixa)) recusa(`só o esquema public é acessível (recebi "${t.v}.")`);
    if (ehPonto(proximo, '(') && cat.funcoes.includes(baixa)) recusa(`"${t.v}" é uma função do banco: não é chamada por aqui`);
    if (tabelaSecreta(baixa)) recusa(`"${t.v}" é tabela de segredo (chaves, tokens, sessões, OAuth): fechada para leitura e escrita`);
    if (colunaSecreta(baixa)) recusa(`"${t.v}" é coluna de segredo (senha, hash, token, chave): fechada para leitura e escrita`);
    const tab = cat.tabelas.get(baixa);
    if (tab && tabelaFechada(tab)) recusa(`a tabela ${tab.nome} é de segredo: fechada para leitura e escrita`);
    if (tab && colunasOcultas(tab).length > 0 && colunasBoas(tab).length > 0) {
      if (ehPonto(toks[i - 1], '.')) recusa(`não qualifique "${t.v}" com o esquema (public.${t.v}): escreva só ${t.v}`);
      if (o.alvo !== undefined && i !== o.alvo) {
        recusa(`a tabela ${tab.nome} tem colunas de segredo; numa escrita ela só aparece como alvo, uma vez (sem subconsulta nem "${tab.nome}.coluna" no WHERE)`);
      }
      restritas.set(baixa, tab);
    }
  });
  return [...restritas.values()];
}

// ------------------------------------------------------------------ leitura

export interface LeituraAnalisada {
  sql: string;
  restritas: TabelaCat[];
}

export function analisarLeitura(entrada: unknown, cat: Catalogo): LeituraAnalisada {
  const { sql, toks } = prepararComando(entrada);
  let i = 0;
  while (ehPonto(toks[i], '(')) i++;
  if (!ehPalavra(toks[i], 'select') && !ehPalavra(toks[i], 'with')) recusa('só é permitido um SELECT (ou WITH … SELECT); para alterar dados use banco_preparar_escrita');
  const restritas = inspecionar(toks, cat);
  return { sql, restritas };
}

export const aspas = (nome: string): string => `"${nome.replace(/"/g, '""')}"`;

/** Acima disto (bytes) a linha vira só um aviso com o começo dela: uma coluna gigante não pode estourar a memória do agente. */
export const MAX_BYTES_LINHA = 50_000;

/**
 * SQL final da leitura: invólucro com as colunas boas das tabelas restritas + teto de linhas. Com `emJson` (banco direto) cada linha volta
 * como UM json (`_linha`), já cortado se passar de `MAX_BYTES_LINHA`: o corte é feito no banco, antes de a linha chegar ao agente.
 */
export function montarLeitura(a: LeituraAnalisada, limite: number, emJson = false): string {
  const cte = a.restritas
    .map((t) => `${aspas(t.nome)} AS NOT MATERIALIZED (SELECT ${colunasBoas(t).map(aspas).join(', ')} FROM public.${aspas(t.nome)})`)
    .join(', ');
  const n = Math.trunc(limite);
  const corpo = emJson
    ? `SELECT CASE WHEN octet_length(_j) > ${MAX_BYTES_LINHA} THEN json_build_object('_linha_cortada_por_tamanho', left(_j, 1000)) ELSE _j::json END AS "_linha" FROM (SELECT to_json(_q)::text AS _j FROM (\n${a.sql}\n) AS _q LIMIT ${n}) AS _t`
    : `SELECT * FROM (\n${a.sql}\n) AS _q LIMIT ${n}`;
  return `${cte ? `WITH ${cte} ` : ''}${corpo}`;
}

// ------------------------------------------------------------------ escrita

export interface PlanoEscrita {
  tipo: 'insert' | 'update' | 'delete';
  tabela: TabelaCat;
  /** o comando, sem `;` final e sem comentário nas pontas */
  sql: string;
  /** UPDATE/DELETE: o texto depois do WHERE */
  condicao?: string;
  /** INSERT: colunas do VALUES; UPDATE: colunas do SET (nomes reais) */
  colunas: string[];
}

function acharTabela(cat: Catalogo, tok: Token | undefined): TabelaCat {
  if (!ehNome(tok)) return recusa('falta o nome da tabela');
  const t = cat.tabelas.get(tok.v.toLowerCase());
  if (!t) return recusa(`tabela "${tok.v}" não existe no esquema public deste banco (veja banco_esquema)`);
  if (tabelaFechada(t)) return recusa(`a tabela ${t.nome} é de segredo: fechada para leitura e escrita`);
  return t;
}

function colunaReal(t: TabelaCat, tok: Token | undefined): string {
  if (!ehNome(tok)) return recusa('esperava o nome de uma coluna');
  const c = t.colunas.find((x) => x.toLowerCase() === tok.v.toLowerCase());
  if (!c) return recusa(`a coluna "${tok.v}" não existe em ${t.nome}`);
  return c;
}

export function analisarEscrita(entrada: unknown, cat: Catalogo): PlanoEscrita {
  const { sql, toks } = prepararComando(entrada);
  const verbo = baixo(toks[0]);
  if (toks[0]!.tipo !== 'id' || !['insert', 'update', 'delete'].includes(verbo)) {
    recusa('escrita é só INSERT INTO t (colunas) VALUES (…), UPDATE t SET coluna = … WHERE …, ou DELETE FROM t WHERE … — DDL (DROP, ALTER, TRUNCATE, CREATE, GRANT) não existe aqui');
  }
  const prof = profundidades(toks);
  const ignorar = new Set<number>([0]);
  let alvo: number;
  let colunas: string[] = [];
  let ondeIdx = -1;

  if (verbo === 'insert') {
    if (!ehPalavra(toks[1], 'into')) recusa('INSERT precisa de INTO: INSERT INTO tabela (colunas) VALUES (…)');
    ignorar.add(1);
    alvo = 2;
  } else if (verbo === 'update') {
    alvo = 1;
    if (!ehPalavra(toks[2], 'set')) recusa('UPDATE tabela SET coluna = valor WHERE …: sem apelido e sem esquema antes do SET');
    ignorar.add(2);
  } else {
    if (!ehPalavra(toks[1], 'from')) recusa('DELETE precisa de FROM: DELETE FROM tabela WHERE …');
    alvo = 2;
  }
  if (ehPonto(toks[alvo + 1], '.')) recusa('não qualifique a tabela com o esquema: escreva só o nome');
  const tabela = acharTabela(cat, toks[alvo]);
  if (tabela.visao) recusa(`${tabela.nome} é uma view: não se escreve nela`);
  if (!tabela.chave.length) recusa(`${tabela.nome} não tem chave primária: sem ela não há como guardar o backup e desfazer, então não se escreve nela por aqui`);
  if (tabela.chave.some((c) => colunaSecreta(c))) recusa(`a chave primária de ${tabela.nome} é uma coluna de segredo: não se escreve nela por aqui`);

  inspecionar(toks, cat, { ignorar, alvo });
  const ocultas = colunasOcultas(tabela);

  // nenhum FROM/USING/JOIN no nível de cima (só dentro de parênteses, em subconsulta de leitura)
  toks.forEach((t, i) => {
    if (prof[i] === 0 && t.tipo === 'id' && ['from', 'using', 'join'].includes(baixo(t)) && !(verbo === 'delete' && i === 1)) {
      recusa(`${baixo(t).toUpperCase()} no nível de cima não é aceito: faça a ligação com uma subconsulta em (SELECT …) dentro do WHERE/SET`);
    }
  });

  if (verbo === 'insert') {
    if (!ehPonto(toks[alvo + 1], '(')) recusa('liste as colunas: INSERT INTO tabela (c1, c2) VALUES (…)');
    let j = alvo + 2;
    for (;;) {
      colunas.push(colunaReal(tabela, toks[j]));
      j++;
      if (ehPonto(toks[j], ',')) {
        j++;
        continue;
      }
      if (ehPonto(toks[j], ')')) {
        j++;
        break;
      }
      recusa('lista de colunas mal formada');
    }
    if (new Set(colunas.map((c) => c.toLowerCase())).size !== colunas.length) recusa('coluna repetida no INSERT');
    if (!ehPalavra(toks[j], 'values')) recusa('depois das colunas vem VALUES (…): INSERT … SELECT, DEFAULT VALUES e ON CONFLICT não são aceitos');
    j++;
    let grupos = 0;
    while (j < toks.length) {
      if (!ehPonto(toks[j], '(')) recusa('depois de VALUES só grupos (…) separados por vírgula: ON CONFLICT e RETURNING não são aceitos');
      grupos++;
      const nivel = prof[j]!;
      j++;
      while (j < toks.length && !(ehPonto(toks[j], ')') && prof[j] === nivel)) j++;
      j++; // o ")" do grupo
      if (j < toks.length) {
        if (!ehPonto(toks[j], ',')) recusa('depois de VALUES só grupos (…) separados por vírgula');
        j++;
        if (j >= toks.length) recusa('vírgula sobrando no fim do VALUES');
      }
    }
    if (grupos === 0) recusa('VALUES sem nenhum grupo');
    return { tipo: 'insert', tabela, sql, colunas };
  }

  // UPDATE e DELETE: WHERE no nível de cima, obrigatório
  const primeiro = verbo === 'update' ? 3 : alvo + 1;
  ondeIdx = toks.findIndex((t, i) => i >= primeiro && prof[i] === 0 && ehPalavra(t, 'where'));
  if (ondeIdx < 0 || ondeIdx === toks.length - 1) recusa(`${verbo.toUpperCase()} sem WHERE não é aceito: diga quais linhas (o teto por escrita é ${MAX_LINHAS_ESCRITA})`);
  if (verbo === 'delete' && ondeIdx !== alvo + 1) recusa('DELETE FROM tabela WHERE …: sem apelido, USING nem outra coisa antes do WHERE');
  const condicao = sql.slice(toks[ondeIdx]!.fim - toks[0]!.ini);
  if (verbo === 'delete') {
    if (ocultas.length) recusa(`${tabela.nome} tem colunas de segredo (${ocultas.join(', ')}): o backup não as guarda, então apagar linha dela não se desfaz — não é feito por aqui`);
    return { tipo: 'delete', tabela, sql, condicao, colunas: [] };
  }
  // UPDATE: SET c = expr [, c = expr]* — uma coluna por atribuição
  let j = 3;
  while (j < ondeIdx) {
    if (!ehNome(toks[j]) || !ehPonto(toks[j + 1], '=')) recusa('SET aceita "coluna = valor" separados por vírgula (uma coluna por atribuição; (a, b) = … não)');
    const col = colunaReal(tabela, toks[j]);
    if (tabela.chave.some((k) => k.toLowerCase() === col.toLowerCase())) recusa(`a chave primária (${col}) não muda por aqui: o backup e o desfazer dependem dela`);
    colunas.push(col);
    j += 2;
    while (j < ondeIdx && !(prof[j] === 0 && ehPonto(toks[j], ','))) j++;
    if (j < ondeIdx) {
      j++;
      if (j >= ondeIdx) recusa('vírgula sobrando no SET');
    }
  }
  if (!colunas.length) recusa('UPDATE sem nenhuma coluna no SET');
  colunas = [...new Set(colunas)];
  return { tipo: 'update', tabela, sql, condicao, colunas };
}

// ------------------------------------------------------------------ montagem do SQL de escrita (nomes vêm do catálogo, nunca do pedido)

export const tabelaSql = (t: TabelaCat): string => `public.${aspas(t.nome)}`;
export const chaveTexto = (t: TabelaCat): string => t.chave.map((c, i) => `${aspas(c)}::text AS ${aspas(`__pk${i}`)}`).join(', ');

/** A linha, só com as colunas boas, como JSON em texto (exato: nada passa por número do JavaScript). */
function origemBoa(t: TabelaCat): string {
  return `(SELECT ${colunasBoas(t).map(aspas).join(', ')} FROM ${tabelaSql(t)}) AS ${aspas(t.nome)}`;
}

/** As linhas que o UPDATE/DELETE pegaria (e, com `travar`, trancadas até o fim da transação). */
export function sqlAntes(p: PlanoEscrita, teto: number, travar: boolean): string {
  return `SELECT ${chaveTexto(p.tabela)}, to_jsonb(${aspas(p.tabela.nome)})::text AS "__linha" FROM ${origemBoa(p.tabela)} WHERE (\n${p.condicao}\n) LIMIT ${teto + 1}${travar ? ' FOR UPDATE' : ''}`;
}

/** O comando do usuário, devolvendo só a chave (texto) das linhas tocadas. */
export function sqlExecutar(p: PlanoEscrita): string {
  return `${p.sql}\nRETURNING ${chaveTexto(p.tabela)}`;
}

/** As linhas pela chave (texto), com as colunas boas. Os parâmetros vêm achatados: [pk0 da linha 1, pk1 da linha 1, pk0 da linha 2…]. */
export function sqlPorChave(t: TabelaCat, linhas: number, travar = false): string {
  const cols = t.chave.map((c) => `${aspas(c)}::text`).join(', ');
  let n = 0;
  const grupos = Array.from({ length: linhas }, () => `(${t.chave.map(() => `$${++n}`).join(', ')})`).join(', ');
  return `SELECT ${chaveTexto(t)}, to_jsonb(${aspas(t.nome)})::text AS "__linha" FROM ${origemBoa(t)} WHERE (${cols}) IN (${grupos})${travar ? ' FOR UPDATE' : ''}`;
}

/** Desfazer UPDATE: devolve as colunas boas (fora da chave) ao valor do backup, uma linha por vez (parâmetros: JSON da linha, chave…). */
export function sqlRestaurarLinha(t: TabelaCat): string {
  const sets = colunasBoas(t)
    .filter((c) => !t.chave.some((k) => k.toLowerCase() === c.toLowerCase()))
    .map((c) => `${aspas(c)} = _r.${aspas(c)}`);
  if (!sets.length) throw new ErroDeEntrada(`${t.nome} só tem colunas de chave: nada a restaurar`);
  const cols = t.chave.map((c) => `${tabelaSql(t)}.${aspas(c)}::text`).join(', ');
  return `UPDATE ${tabelaSql(t)} SET ${sets.join(', ')} FROM jsonb_populate_record(NULL::${tabelaSql(t)}, $1::jsonb) AS _r WHERE (${cols}) = (${t.chave.map((_, i) => `$${i + 2}`).join(', ')})`;
}

/** Desfazer DELETE: reinsere as linhas do backup (parâmetro: array JSON). */
export function sqlReinserir(t: TabelaCat): string {
  const cols = colunasBoas(t).map(aspas).join(', ');
  return `INSERT INTO ${tabelaSql(t)} (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::${tabelaSql(t)}, $1::jsonb)`;
}

/** Desfazer INSERT: apaga as linhas inseridas, pela chave (mesmos parâmetros achatados de sqlPorChave). */
export function sqlApagarPorChave(t: TabelaCat, linhas: number): string {
  const cols = t.chave.map((c) => `${aspas(c)}::text`).join(', ');
  let n = 0;
  const grupos = Array.from({ length: linhas }, () => `(${t.chave.map(() => `$${++n}`).join(', ')})`).join(', ');
  return `DELETE FROM ${tabelaSql(t)} WHERE (${cols}) IN (${grupos}) RETURNING ${chaveTexto(t)}`;
}
