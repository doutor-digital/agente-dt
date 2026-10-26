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
  const m = antigo.match(new RegExp(`${chave}:\\s*(\\{[^\\n]*\\}),?\\s*\\n`));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
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
js = js.slice(0, fim) + bloco + js.slice(fim);
cfgNode.parameters.jsCode = js;

// ── nós de código e SQL ───────────────────────────────────────────────────────────────────────────────────
no('Classificar etapa').parameters.jsCode = ler('classificar-etapa.v3.js');
no('Montar evento').parameters.jsCode = ler('montar-evento.v3.js');

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
if (!q.includes('AND v.ctwa_clid IS NOT NULL')) {
  if (!q.includes(ancora)) falha('o SQL de reenvio mudou: não achei a linha do event_id para acrescentar "ctwa_clid IS NOT NULL"');
  q = q.replace(ancora, `${ancora}\n  AND v.ctwa_clid IS NOT NULL   -- v3: evento de Status (sem clid) volta pelo webhook, não pelo relógio`);
  reenvio.parameters.query = q;
}

// O modo seco do caminho NOVO: o IF "Modo teste" passa a olhar também o _seco do item (o dryRun global continua valendo).
const ifTeste = no('Modo teste (nao chama a Meta)?');
const cond = ifTeste.parameters.conditions?.conditions?.[0];
if (!cond) falha('o IF "Modo teste" não tem a condição esperada');
cond.leftValue = "={{ $('Config').first().json.cfg.dryRun === true || $json._seco === true }}";

fs.writeFileSync(process.env.OUT_JSON, JSON.stringify(wf.nodes));
console.log(`${wf.name}: pediuHorario=${JSON.stringify(pediu)} status=${JSON.stringify({ ...status, pageId: status.pageId ? '…' + status.pageId.slice(-4) : '' })}`);
