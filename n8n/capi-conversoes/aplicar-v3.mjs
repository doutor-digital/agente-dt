// Monta os nós v3 de UM workflow "DD · CTWA → Meta CAPI · Conversões (<unidade>)". NÃO fala com o n8n nem com a
// Meta: lê o export do workflow (WF_JSON), escreve os nós novos (OUT_JSON) e imprime o que mudou. Quem faz o
// backup e o PUT é o aplicar-v3.sh. Roda dentro do container do n8n (node 20+), como o aplicar-v2.mjs de 08/09.
//
// Entrada (ambiente): WF_JSON, OUT_JSON, DIR (pasta com os .js/.sql v3), PEDIU_MODO, STATUS_MODO, PAGE_ID, TAG.
// Modo vazio = PRESERVA o que o Config já tem (rodar de novo não desliga o que o João ligou); sem nada, 'desligado'.
// Falha ALTO (exit 2) se qualquer nó esperado não existir ou se um trecho a trocar mudou: nunca grava pela metade.
import fs from 'node:fs';
import path from 'node:path';

const MODOS = ['desligado', 'seco', 'ligado'];
const wf = JSON.parse(fs.readFileSync(process.env.WF_JSON, 'utf8'));
const dir = process.env.DIR;
const ler = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const falha = (msg) => { console.error(`ERRO (${wf.name}): ${msg}`); process.exit(2); };
const no = (nome) => wf.nodes.find((n) => n.name === nome) ?? falha(`nó "${nome}" não existe — workflow fora do molde, nada foi gravado`);

const cfgNode = no('Config');
const antigo = cfgNode.parameters.jsCode;

// ── o que o Config já diz (para preservar) ────────────────────────────────────────────────────────────────
const lerBloco = (chave) => {
  // ancorado no começo da linha: "statusQualificacao:" ou um "status:" dentro de outro objeto não podem casar
  const m = antigo.match(new RegExp(`(?:^|\\n)[ \\t]*${chave}:[ \\t]*(\\{[^\\n]*\\}),?[ \\t]*(?=\\n)`));
  if (!m) {
    if (new RegExp(`(?:^|\\n)[ \\t]*${chave}:`).test(antigo)) falha(`o bloco "${chave}" existe no Config mas não está numa linha só — não vou adivinhar o que está ligado; arrume na mão ou apague o bloco`);
    return null;
  }
  try { return JSON.parse(m[1]); } catch { return falha(`o bloco "${chave}" do Config não é JSON válido — nada foi gravado`); }
};
const jaPediu = lerBloco('pediuHorario');
const jaStatus = lerBloco('status');

const escolhe = (env, ja) => {
  const v = (env ?? '').trim();
  if (!v) return ja?.modo ?? 'desligado';
  if (!MODOS.includes(v)) falha(`modo inválido "${v}" (use ${MODOS.join('|')})`);
  return v;
};
const pediu = {
  modo: escolhe(process.env.PEDIU_MODO, jaPediu),
  tag: (process.env.TAG || '').trim() || jaPediu?.tag || 'IA · Pediu horário',
  tagsExcluir: jaPediu?.tagsExcluir ?? ['Alerta · Mora fora', 'Fora do escopo'],
};
const pageId = (process.env.PAGE_ID || '').trim() || jaStatus?.pageId || '';
if (pageId && !/^\d{6,}$/.test(pageId)) falha(`page_id "${pageId}" não parece um id numérico da Página`);
const status = { modo: escolhe(process.env.STATUS_MODO, jaStatus), pageId };
if (status.modo !== 'desligado' && !status.pageId) falha('Status ligado/seco exige --page-id (sem page_id a Meta rejeita o evento)');

// ── Config: troca o bloco v3 (se houver) e acrescenta antes do "};" final ───────────────────────────────────
let js = antigo.replace(/\n\s*\/\/ v3: pediu horário[\s\S]*?\n\s*status: [^\n]*\n/, '\n');
const bloco =
  `\n  // v3: pediu horário (etiqueta que o agente põe) e anúncio de Status (page_id). modo: desligado | seco (não chama a Meta) | ligado` +
  `\n  pediuHorario: ${JSON.stringify(pediu)},` +
  `\n  status: ${JSON.stringify(status)},\n`;
const fim = js.lastIndexOf('\n};');
if (fim < 0) falha('não achei o fim do cfg no nó Config');
let antes = js.slice(0, fim);
if (!/,\s*$/.test(antes) && !/\{\s*$/.test(antes)) antes = antes.replace(/\s*$/, ',');   // última propriedade sem vírgula
js = antes + bloco + js.slice(fim);
try { new Function('$input', js); } catch (e) { falha(`o Config ficaria com erro de sintaxe (${e.message}) — nada foi gravado`); }
{
  // o `};` achado fecha mesmo o objeto cfg? Avalia o Config com stub e confere as chaves (compilar não prova isso)
  let cfgAvaliado;
  try { cfgAvaliado = new Function('$input', '$env', js)({ all: () => [{ json: {} }] }, {})[0].json.cfg; } catch (e) { falha(`o Config novo não executa (${e.message}) — nada foi gravado`); }
  if (!cfgAvaliado || cfgAvaliado.pediuHorario?.modo !== pediu.modo || cfgAvaliado.status?.modo !== status.modo) falha('depois da troca o cfg não expõe pediuHorario/status (o "};" achado não fecha o cfg?) — nada foi gravado');
  const cfgAntigo = new Function('$input', '$env', antigo)({ all: () => [{ json: {} }] }, {})[0].json.cfg;
  for (const k of ['cadeia', 'preAgendado', 'pipelineId', 'janelaDias']) if (JSON.stringify(cfgAntigo[k]) !== JSON.stringify(cfgAvaliado[k])) falha(`o cfg perdeu/alterou "${k}" — nada foi gravado`);
}
cfgNode.parameters.jsCode = js;

// ── nós de código e SQL ───────────────────────────────────────────────────────────────────────────────────
for (const [nome, arq] of [['Classificar etapa', 'classificar-etapa.v3.js'], ['Montar evento', 'montar-evento.v3.js']]) {
  const codigo = ler(arq);
  try { new Function('$', '$input', 'require', codigo); } catch (e) { falha(`${arq} não compila (${e.message})`); }
  no(nome).parameters.jsCode = codigo;
}

const busca = no('Buscar telefone e nome');
busca.parameters.query = ler('buscar-clique.v3.sql');
busca.parameters.options = {
  ...(busca.parameters.options || {}),
  queryReplacement:
    "={{ [ $json.event_name, $json.event_id, $json.event_time, $json.ctwa_clid, $json.kommo_lead_id, $json.pipeline_id, $json.valor, " +
    "$('Config').first().json.cfg.unidade, $json.via || 'quente', String($json._seco === true) ] }}",
};

no('Reservar envio').parameters.query = ler('reservar-envio.v3.sql');

// Reenvio do relógio: evento sem clid (Status) não é reenviado por aqui — o relógio só sabe montar com ctwa_clid. Quem
// reavalia o Status que falhou é o próximo webhook do cartão (o DO UPDATE do Reservar devolve a linha 'falhou').
const reenvio = no('Cliques e reenvios');
const ancora = "AND v.event_id ~ '^(msg|quente|agendado|compareceu|ganho)-'";
let q = reenvio.parameters.query;
const MARCA = '/* v3:';
if (!q.includes(MARCA)) {
  if (!q.includes(ancora)) falha('o SQL de reenvio mudou: não achei a linha do event_id para acrescentar "ctwa_clid IS NOT NULL"');
  // ANTES da âncora e em comentário de bloco: nada que venha depois dela na mesma linha pode ser comentado por engano
  q = q.replace(ancora, `AND v.ctwa_clid IS NOT NULL /* v3: evento de Status (sem clid) volta pelo webhook, não pelo relógio */\n  ${ancora}`);
  reenvio.parameters.query = q;
}

// O modo seco do caminho NOVO: o IF "Modo teste" passa a olhar também o _seco do item (o dryRun global continua valendo).
const rehidratar = no('Rehidratar evento').parameters.jsCode || '';
if (!/\$\('Montar evento'\)\.all\(\)/.test(rehidratar) || !/json:\s*evento\b/.test(rehidratar)) falha('"Rehidratar evento" não devolve o item inteiro do "Montar evento": o _seco poderia se perder e o seco chamaria a Meta');
const ifTeste = no('Modo teste (nao chama a Meta)?');
const ligadoDireto = (wf.connections?.['Rehidratar evento']?.main?.[0] ?? []).some((c) => c.node === 'Modo teste (nao chama a Meta)?');
if (!ligadoDireto) falha('"Rehidratar evento" não liga direto no IF "Modo teste": o _seco poderia se perder no caminho e o seco chamaria a Meta');
const cond = ifTeste.parameters.conditions?.conditions?.[0];
if (!cond) falha('o IF "Modo teste" não tem a condição esperada');
cond.leftValue = "={{ $('Config').first().json.cfg.dryRun === true || $json._seco === true }}";

fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(wf.nodes));
console.log(`${wf.name}: pediuHorario=${JSON.stringify(pediu)} status=${JSON.stringify({ ...status, pageId: status.pageId ? '…' + status.pageId.slice(-4) : '' })}`);
