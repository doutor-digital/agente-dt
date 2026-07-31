#!/usr/bin/env node
/**
 * Gera o JSON importável do workflow n8n
 *   "Rastreio de Campanhas - WhatsApp > Kommo"
 *
 * Por que um builder e não o JSON na mão: os nós Code carregam ~200 linhas de
 * JavaScript. Escrever isso escapado dentro de string JSON é onde bugs entram
 * sem serem vistos. Aqui o código dos nós fica em template literal (legível,
 * lintável) e o JSON.stringify cuida do escape.
 *
 * Uso:  node build-workflow.mjs
 * Saída: rastreio-campanhas-whatsapp-kommo.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

/* ────────────────────────────────────────────────────────────────────────────
 * Código dos nós Code
 * ──────────────────────────────────────────────────────────────────────────*/

const CODE_ASSINATURA = `
// Valida X-Hub-Signature-256 (HMAC-SHA256 do corpo BRUTO com o App Secret).
// Exige "Raw Body" ligado no nó Webhook — o corpo já parseado não serve,
// porque qualquer reserialização muda os bytes e quebra o HMAC.
const nodeCrypto = (typeof crypto !== 'undefined' && crypto.createHmac) ? crypto : require('crypto');
const segredo = $env.META_APP_SECRET || '';
const saida = [];

for (const item of $input.all()) {
  const headers = item.json.headers || {};
  const assinatura = String(headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '');

  let bruto = null;
  const bin = (item.binary && item.binary.data) ? item.binary.data : null;
  if (bin && bin.data) bruto = Buffer.from(bin.data, 'base64');

  let valida = false;
  let motivo = 'ok';

  if (!segredo) motivo = 'META_APP_SECRET ausente nas variaveis de ambiente do n8n';
  else if (!assinatura) motivo = 'header x-hub-signature-256 ausente';
  else if (!bruto) motivo = 'corpo bruto indisponivel — ative a opcao Raw Body no no Webhook';
  else {
    const esperada = 'sha256=' + nodeCrypto.createHmac('sha256', segredo).update(bruto).digest('hex');
    const a = Buffer.from(esperada, 'utf8');
    const b = Buffer.from(assinatura, 'utf8');
    valida = a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
    if (!valida) motivo = 'assinatura nao confere';
  }

  let corpo = {};
  try {
    corpo = bruto ? JSON.parse(bruto.toString('utf8')) : {};
  } catch (e) {
    corpo = {};
    valida = false;
    motivo = 'corpo nao e JSON valido';
  }

  saida.push({ json: {
    valida,
    motivo,
    recebidoEm: new Date().toISOString(),
    bytes: bruto ? bruto.length : 0,
    assinaturaPrefixo: assinatura ? assinatura.slice(0, 20) + '...' : null,
    corpo,
  }});
}

return saida;
`.trim();

const CODE_CONFIG = `
// Ponto unico de configuracao. Tudo vem de variavel de ambiente do n8n —
// nenhum ID/segredo fica hardcoded no workflow (que e versionado/exportado).
const inteiro = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};
const inteiroPadrao = (v, padrao) => inteiro(v) ?? padrao;

const cfg = {
  kommoSubdomain: $env.KOMMO_SUBDOMAIN || 'attivacorpoementeitz',
  graphVersion: $env.META_GRAPH_VERSION || 'v23.0',

  // Regra de criacao: por padrao NAO criamos nada no Kommo. A Kommo cria o
  // lead sozinha ao receber a mensagem; criar em paralelo gera lead duplicado.
  // So ligue depois de medir quantos "orfaos" sobram no log.
  criarSeNaoExistir: String($env.KOMMO_CREATE_IF_MISSING || 'false').toLowerCase() === 'true',
  pipelineId: inteiro($env.KOMMO_PIPELINE_ID),
  statusId: inteiro($env.KOMMO_STATUS_ID),

  tagOrigem: $env.KOMMO_TAG_ORIGEM || 'Origem: Anuncio pago',
  maxTentativas: inteiroPadrao($env.CTWA_LOOKUP_MAX_TENTATIVAS, 4),
  backoffSegundos: inteiroPadrao($env.CTWA_LOOKUP_BACKOFF_SEGUNDOS, 20),
  alertaUrl: $env.ALERT_WEBHOOK_URL || '',

  // IDs dos campos personalizados de LEAD no Kommo.
  campos: {
    campanha:        inteiro($env.KOMMO_CF_CAMPANHA),
    conjunto:        inteiro($env.KOMMO_CF_CONJUNTO),
    anuncio:         inteiro($env.KOMMO_CF_ANUNCIO),
    anuncioId:       inteiro($env.KOMMO_CF_AD_ID),
    utmSource:       inteiro($env.KOMMO_CF_UTM_SOURCE),
    utmMedium:       inteiro($env.KOMMO_CF_UTM_MEDIUM),
    utmCampaign:     inteiro($env.KOMMO_CF_UTM_CAMPAIGN),
    utmContent:      inteiro($env.KOMMO_CF_UTM_CONTENT),
    utmTerm:         inteiro($env.KOMMO_CF_UTM_TERM),
    origemUrl:       inteiro($env.KOMMO_CF_ORIGEM_URL),
    ctwaClid:        inteiro($env.KOMMO_CF_CTWA_CLID),
    origemTipo:      inteiro($env.KOMMO_CF_ORIGEM_TIPO),
    primeiroContato: inteiro($env.KOMMO_CF_PRIMEIRO_CONTATO),
    headline:        inteiro($env.KOMMO_CF_HEADLINE),
    plataforma:      inteiro($env.KOMMO_CF_PLATAFORMA),
  },
};

cfg.problemas = [];
if (!cfg.kommoSubdomain) cfg.problemas.push('KOMMO_SUBDOMAIN vazio');
if (!Object.values(cfg.campos).some(Boolean)) cfg.problemas.push('nenhum KOMMO_CF_* configurado');

// Mantem o item original e pendura a config — os nos seguintes leem via
// $('Config').first().json.cfg.
return $input.all().map((item) => ({ json: { ...item.json, cfg } }));
`.trim();

const CODE_EXTRAIR = `
// Achata entry[].changes[].value.messages[] em um item por mensagem.
// Eventos de "statuses" (entregue/lido) sao descartados aqui: nao carregam
// atribuicao e so gerariam ruido no log.
const cfg = $('Config').first().json.cfg;
const saida = [];

for (const item of $input.all()) {
  const corpo = item.json.corpo || {};
  for (const entry of (corpo.entry || [])) {
    for (const change of (entry.changes || [])) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      const perfil = (value.contacts || [])[0] || {};
      const nomeContato = (perfil.profile && perfil.profile.name) || null;
      const meta = value.metadata || {};

      for (const msg of (value.messages || [])) {
        const ref = msg.referral || null;
        const ts = msg.timestamp ? Number(msg.timestamp) : null;
        const digitos = String(msg.from || '').replace(/\\D/g, '');

        saida.push({ json: {
          wamid: msg.id || null,
          telefone: msg.from || null,
          telefoneDigits: digitos,
          // Kommo casa por substring; os ultimos 8 digitos sobrevivem a
          // variacoes de DDI, "+" e do nono digito do celular brasileiro.
          telefoneBusca: digitos.slice(-8),
          nomeContato,
          tipoMensagem: msg.type || null,
          primeiroContatoUnix: ts,
          primeiroContatoIso: ts ? new Date(ts * 1000).toISOString() : null,
          wabaId: entry.id || null,
          phoneNumberId: meta.phone_number_id || null,
          numeroExibicao: meta.display_phone_number || null,
          temCampanha: !!(ref && (ref.source_id || ref.ctwa_clid)),
          referral: ref ? {
            ctwaClid: ref.ctwa_clid || null,
            sourceId: ref.source_id || null,
            sourceType: ref.source_type || null,
            sourceUrl: ref.source_url || null,
            headline: ref.headline || null,
            corpoAnuncio: ref.body || null,
            mediaType: ref.media_type || null,
            thumbnailUrl: ref.thumbnail_url || null,
          } : null,
          payloadBruto: value,
          cfg,
        }});
      }
    }
  }
}

return saida;
`.trim();

const CODE_CONTEXTO = `
// O no Postgres devolve so { inserido, wamid }. Reidrata o contexto completo
// casando por wamid (chave, nao indice — indice quebra quando o dedup
// descarta itens no meio do lote).
const mensagens = $('Extrair mensagens e referral').all();
const cfg = $('Config').first().json.cfg;
const porWamid = new Map(mensagens.map((m) => [m.json.wamid, m.json]));

const saida = [];
for (const item of $input.all()) {
  const base = porWamid.get(item.json.wamid);
  if (!base) continue;
  const ref = base.referral || {};
  const sourceId = ref.sourceId || null;
  saida.push({ json: {
    ...base,
    sourceId,
    ehAnuncio: !!sourceId && (!ref.sourceType || ref.sourceType === 'ad'),
    // source_id de post organico nao resolve como anuncio; a chamada falha e
    // o no seguinte esta com onError=continue justamente por isso.
    urlGraph: 'https://graph.facebook.com/' + cfg.graphVersion + '/' + (sourceId || '0'),
  }});
}
return saida;
`.trim();

const CODE_NORMALIZAR = `
// Junta referral (webhook) + metadados do anuncio (Graph) e resolve as UTMs.
// Alinhamento por indice e seguro aqui: o no Graph roda com
// onError=continueRegularOutput, entao emite exatamente 1 item por entrada.
const contexto = $('Contexto do anuncio').all();

function parseQuery(url) {
  const out = {};
  if (!url) return out;
  const i = String(url).indexOf('?');
  const qs = i >= 0 ? String(url).slice(i + 1) : String(url);
  for (const par of qs.split('&')) {
    if (!par) continue;
    const [k, ...resto] = par.split('=');
    if (!k) continue;
    try { out[decodeURIComponent(k)] = decodeURIComponent(resto.join('=').replace(/\\+/g, ' ')); }
    catch (e) { out[k] = resto.join('='); }
  }
  return out;
}

// url_tags do criativo vem com macros da Meta ({{campaign.name}} etc).
function resolverMacros(texto, vars) {
  if (!texto) return '';
  return String(texto).replace(/\\{\\{\\s*([a-z_.]+)\\s*\\}\\}/gi, (m, chave) => {
    const v = vars[String(chave).toLowerCase()];
    return v === undefined || v === null ? '' : String(v);
  });
}

const entradas = $input.all();
const saida = [];

for (let i = 0; i < entradas.length; i++) {
  const g = entradas[i].json || {};
  const base = (contexto[i] && contexto[i].json) || {};
  const ref = base.referral || {};

  const erroGraph = g.error
    ? String((g.error && (g.error.message || g.error.error_user_msg)) || g.error).slice(0, 500)
    : null;
  const ad = erroGraph ? {} : g;

  const campanha = ad.campaign || {};
  const conjunto = ad.adset || {};
  const criativo = ad.creative || {};
  const plataformas = (conjunto.targeting && conjunto.targeting.publisher_platforms) || [];

  const plataforma = plataformas.length
    ? plataformas.join('+')
    : (String(ref.sourceUrl || '').includes('instagram') ? 'instagram' : 'facebook');

  const vars = {
    'campaign.name': campanha.name || '',
    'campaign.id': campanha.id || '',
    'adset.name': conjunto.name || '',
    'adset.id': conjunto.id || '',
    'ad.name': ad.name || '',
    'ad.id': ad.id || ref.sourceId || '',
    'site_source_name': plataforma,
    'placement': 'click_to_whatsapp',
  };

  const utmCriativo = parseQuery('?' + resolverMacros(criativo.url_tags || '', vars));
  const utmUrl = parseQuery(ref.sourceUrl || '');
  // Precedencia: o que veio na URL clicada > url_tags do criativo > derivado.
  const escolher = (chave, derivado) => utmUrl[chave] || utmCriativo[chave] || derivado || null;

  const atribuicao = {
    campanhaNome: campanha.name || null,
    campanhaId: campanha.id ? String(campanha.id) : null,
    conjuntoNome: conjunto.name || null,
    conjuntoId: conjunto.id ? String(conjunto.id) : null,
    anuncioNome: ad.name || null,
    anuncioId: ad.id ? String(ad.id) : (ref.sourceId || null),
    objetivo: campanha.objective || null,

    utmSource: escolher('utm_source', plataforma),
    utmMedium: escolher('utm_medium', 'paid_social'),
    utmCampaign: escolher('utm_campaign', campanha.name),
    utmContent: escolher('utm_content', ad.name),
    utmTerm: escolher('utm_term', conjunto.name),

    origemUrl: ref.sourceUrl || null,
    ctwaClid: ref.ctwaClid || null,
    origemTipo: ref.sourceType || 'ad',
    headline: ref.headline || null,
    plataforma,
    origemUtm: Object.keys(utmUrl).length ? 'source_url'
             : (Object.keys(utmCriativo).length ? 'creative.url_tags' : 'derivado'),
    erroGraph,
  };

  saida.push({ json: { ...base, atribuicao } });
}

return saida;
`.trim();

const CODE_AVALIAR_BUSCA = `
// Decide se achamos um lead utilizavel para este telefone.
// Contato sem lead conta como "nao achou": normalmente significa que a Kommo
// ainda esta criando o lead da mensagem que acabou de chegar — esperar e
// tentar de novo e melhor que criar um lead paralelo.
const ctx = $('Loop por lead').first().json;
const cfg = $('Config').first().json.cfg;

const resp = $input.first().json || {};
const contatos = (resp._embedded && resp._embedded.contacts) || [];
const alvo = ctx.telefoneDigits || '';
const sufixo = alvo.slice(-8);

function digitosDoContato(c) {
  const campos = c.custom_fields_values || [];
  const fones = [];
  for (const f of campos) {
    if (f.field_code !== 'PHONE') continue;
    for (const v of (f.values || [])) {
      if (v && v.value) fones.push(String(v.value).replace(/\\D/g, ''));
    }
  }
  return fones;
}

let contato = null;
for (const c of contatos) {
  const fones = digitosDoContato(c);
  if (fones.some((f) => f.endsWith(sufixo) || alvo.endsWith(f.slice(-8)))) { contato = c; break; }
}
// Fallback: a busca do Kommo ja filtra por telefone; se so veio um contato e
// nenhum campo PHONE bateu (campo customizado exotico), aceita o unico.
if (!contato && contatos.length === 1) contato = contatos[0];

const leads = contato ? ((contato._embedded && contato._embedded.leads) || []) : [];
const leadId = leads.length ? Math.max(...leads.map((l) => Number(l.id))) : null;

// Contador de tentativas por wamid, em static data (sobrevive ao no Wait).
const st = $getWorkflowStaticData('global');
st.tentativas = st.tentativas || {};
const agora = Date.now();
for (const [k, v] of Object.entries(st.tentativas)) {
  if (!v || !v.ts || agora - v.ts > 3600000) delete st.tentativas[k];
}
const chave = ctx.wamid || (ctx.telefoneDigits + ':' + (ctx.primeiroContatoUnix || ''));
const anterior = st.tentativas[chave] ? st.tentativas[chave].n : 0;
const tentativa = anterior + 1;
st.tentativas[chave] = { n: tentativa, ts: agora };

const encontrado = !!(contato && leadId);
if (encontrado) delete st.tentativas[chave];

return [{ json: {
  ...ctx,
  encontrado,
  contatoId: contato ? contato.id : null,
  contatoNome: contato ? contato.name : null,
  leadId,
  tentativa,
  tentativasEsgotadas: tentativa >= cfg.maxTentativas,
  // backoff progressivo: 20s, 40s, 60s...
  esperaSegundos: Math.min(cfg.backoffSegundos * tentativa, 120),
  contatosRetornados: contatos.length,
}}];
`.trim();

const CODE_MONTAR_PATCH = `
// Monta UM unico PATCH (campos + tag na mesma chamada).
// Dois motivos para nao fatiar em varios PATCH: (1) a API do Kommo tem race
// entre PATCHes concorrentes no mesmo lead — o ultimo a chegar pode apagar o
// que o anterior gravou; (2) gasta rate limit a toa.
//
// Regra de first-touch: so grava campo que esta VAZIO. Uma atribuicao anterior
// valida nunca e sobrescrita — o primeiro anuncio que trouxe o lead e o que
// conta para analise de conversao.
const ctx = $('Loop por lead').first().json;
const cfg = $('Config').first().json.cfg;
const lead = $input.first().json || {};
const a = ctx.atribuicao || {};

const atuais = new Map();
for (const f of (lead.custom_fields_values || [])) {
  const v = (f.values || [])[0];
  const valor = v ? (v.value ?? null) : null;
  atuais.set(Number(f.field_id), valor === '' ? null : valor);
}

const mapa = [
  ['campanha',        a.campanhaNome],
  ['conjunto',        a.conjuntoNome],
  ['anuncio',         a.anuncioNome],
  ['anuncioId',       a.anuncioId],
  ['utmSource',       a.utmSource],
  ['utmMedium',       a.utmMedium],
  ['utmCampaign',     a.utmCampaign],
  ['utmContent',      a.utmContent],
  ['utmTerm',         a.utmTerm],
  ['origemUrl',       a.origemUrl],
  ['ctwaClid',        a.ctwaClid],
  ['origemTipo',      a.origemTipo],
  ['headline',        a.headline],
  ['plataforma',      a.plataforma],
  // Campo "Data e hora" do Kommo recebe unix timestamp em segundos.
  ['primeiroContato', ctx.primeiroContatoUnix],
];

const custom = [];
const gravados = [];
const preservados = [];

for (const [chave, valor] of mapa) {
  const fieldId = cfg.campos[chave];
  if (!fieldId || valor === null || valor === undefined || valor === '') continue;
  if (atuais.get(fieldId)) { preservados.push(chave); continue; }
  custom.push({ field_id: fieldId, values: [{ value: valor }] });
  gravados.push(chave);
}

const patchBody = {};
if (custom.length) patchBody.custom_fields_values = custom;
// tags_to_add vai na RAIZ do body. Dentro de _embedded o Kommo aceita a
// requisicao e ignora silenciosamente (200 OK, tag nao aplicada).
if (cfg.tagOrigem) patchBody.tags_to_add = [{ name: cfg.tagOrigem }];

const temAlgoParaGravar = custom.length > 0;

const nota =
  'Atribuicao de campanha (CTWA)\\n' +
  'Campanha: ' + (a.campanhaNome || '-') + ' (' + (a.campanhaId || '-') + ')\\n' +
  'Conjunto: ' + (a.conjuntoNome || '-') + ' (' + (a.conjuntoId || '-') + ')\\n' +
  'Anuncio: ' + (a.anuncioNome || '-') + ' (' + (a.anuncioId || '-') + ')\\n' +
  'UTM: source=' + (a.utmSource || '-') + ' medium=' + (a.utmMedium || '-') +
  ' campaign=' + (a.utmCampaign || '-') + ' content=' + (a.utmContent || '-') +
  ' term=' + (a.utmTerm || '-') + ' [' + (a.origemUtm || '-') + ']\\n' +
  'ctwa_clid: ' + (a.ctwaClid || '-') + '\\n' +
  'URL de origem: ' + (a.origemUrl || '-') + '\\n' +
  'Primeiro contato: ' + (ctx.primeiroContatoIso || '-') + '\\n' +
  'Telefone: ' + (ctx.telefone || '-') + '\\n' +
  'Campos gravados: ' + (gravados.join(', ') || 'nenhum') +
  (preservados.length ? ' | preservados: ' + preservados.join(', ') : '') +
  (a.erroGraph ? '\\nFalha ao consultar a Graph API: ' + a.erroGraph : '');

return [{ json: { ...ctx, patchBody, temAlgoParaGravar, gravados, preservados, nota } }];
`.trim();

const CODE_CRIAR_BODY = `
// Body do POST /leads/complex (cria contato + lead em UMA chamada).
// So chega aqui com KOMMO_CREATE_IF_MISSING=true e depois de esgotar o
// backoff — ou seja, a Kommo comprovadamente nao criou o lead sozinha.
const ctx = $('Loop por lead').first().json;
const cfg = $('Config').first().json.cfg;
const a = ctx.atribuicao || {};

const mapa = [
  ['campanha', a.campanhaNome], ['conjunto', a.conjuntoNome], ['anuncio', a.anuncioNome],
  ['anuncioId', a.anuncioId], ['utmSource', a.utmSource], ['utmMedium', a.utmMedium],
  ['utmCampaign', a.utmCampaign], ['utmContent', a.utmContent], ['utmTerm', a.utmTerm],
  ['origemUrl', a.origemUrl], ['ctwaClid', a.ctwaClid], ['origemTipo', a.origemTipo],
  ['headline', a.headline], ['plataforma', a.plataforma],
  ['primeiroContato', ctx.primeiroContatoUnix],
];

const custom = [];
for (const [chave, valor] of mapa) {
  const fieldId = cfg.campos[chave];
  if (!fieldId || valor === null || valor === undefined || valor === '') continue;
  custom.push({ field_id: fieldId, values: [{ value: valor }] });
}

const lead = {
  name: (ctx.nomeContato || ctx.telefone || 'Lead WhatsApp') + ' — anuncio',
  _embedded: {
    contacts: [{
      first_name: ctx.nomeContato || ctx.telefone,
      custom_fields_values: [{
        field_code: 'PHONE',
        values: [{ value: ctx.telefone, enum_code: 'WORK' }],
      }],
    }],
    // Na criacao via /complex a tag vai em _embedded.tags (aqui nao existe
    // lead anterior, entao nao ha risco de sobrescrever tags existentes).
    tags: cfg.tagOrigem ? [{ name: cfg.tagOrigem }] : undefined,
  },
};
if (custom.length) lead.custom_fields_values = custom;
if (cfg.pipelineId) lead.pipeline_id = cfg.pipelineId;
if (cfg.statusId) lead.status_id = cfg.statusId;

return [{ json: { ...ctx, criarBody: [lead] } }];
`.trim();

/* ────────────────────────────────────────────────────────────────────────────
 * Helpers de nós
 * ──────────────────────────────────────────────────────────────────────────*/

// Credenciais que ja existem na instancia n8n da Doutor Digital — reaproveitadas
// para o workflow subir funcionando, sem recadastrar segredo nenhum.
//
// A credencial Kommo e POR UNIDADE. Imperatriz e o default (unidade canonica de
// configuracao). Para apontar para outra unidade: troque aqui + a env
// KOMMO_SUBDOMAIN, ou troque a credencial nos 4 nos Kommo pela UI.
const CRED_META = { facebookGraphApi: { id: 'wnlgBl15EIK6LT7X', name: 'Facebook Graph account' } };
const CRED_KOMMO = { kommoLongLivedApi: { id: 'MnPGiOOvaSPm9HgC', name: 'Kommo Imperatriz' } };
// Banco DEDICADO: n8n_rastreio, role propria `rastreio`, criado na instancia
// postgres:14 da VPS (a mesma que hospeda o n8n_queue). Nao compartilha nada
// com o banco do 3C nem com o do agente-dt.
const CRED_PG = { postgres: { id: 'y6Q1JmvPL4BodI9u', name: 'Postgres - Rastreio CTWA' } };

const AUTH_META = { authentication: 'predefinedCredentialType', nodeCredentialType: 'facebookGraphApi' };
const AUTH_KOMMO = { authentication: 'predefinedCredentialType', nodeCredentialType: 'kommoLongLivedApi' };

const nos = [];
const add = (no) => { nos.push(no); return no.name; };

function code(name, position, jsCode, extra = {}) {
  return add({ parameters: { jsCode }, id: slug(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, ...extra });
}

function se(name, position, condicoes, extra = {}) {
  return add({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: condicoes,
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
    id: slug(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position, ...extra,
  });
}

const condBool = (esquerda, verdadeiro = true) => ([{
  id: 'c1', leftValue: esquerda, rightValue: '',
  operator: { type: 'boolean', operation: verdadeiro ? 'true' : 'false', singleValue: true },
}]);

function http(name, position, parameters, extra = {}) {
  return add({
    parameters: { options: {}, ...parameters },
    id: slug(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position, ...extra,
  });
}

function pg(name, position, query, valores, extra = {}) {
  return add({
    parameters: {
      operation: 'executeQuery',
      query,
      options: { queryReplacement: valores },
    },
    id: slug(name), name, type: 'n8n-nodes-base.postgres', typeVersion: 2.5, position,
    credentials: CRED_PG,
    alwaysOutputData: true,
    // Log nunca derruba o fluxo principal.
    onError: 'continueRegularOutput',
    retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    ...extra,
  });
}

function responder(name, position, corpo, codigo) {
  return add({
    parameters: { respondWith: 'text', responseBody: corpo, options: { responseCode: codigo } },
    id: slug(name), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position,
  });
}

function noop(name, position) {
  return add({ parameters: {}, id: slug(name), name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position });
}

function sticky(conteudo, position, largura, altura, cor = 4) {
  return add({
    parameters: { content: conteudo, height: altura, width: largura, color: cor },
    id: slug('nota-' + position.join('-')), name: 'Nota ' + position.join(','),
    type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position,
  });
}

function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Nós — trilha 1: verificação do webhook (GET)
 * ──────────────────────────────────────────────────────────────────────────*/

const CAMINHO = 'meta-ctwa-tracking';

add({
  parameters: { httpMethod: 'GET', path: CAMINHO, responseMode: 'responseNode', options: {} },
  id: 'webhook-verificacao', name: 'Meta — Verificacao (GET)',
  type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-1120, -260], webhookId: CAMINHO,
});

se('Verify token confere?', [-900, -260], [{
  id: 'v1',
  leftValue: "={{ $json.query['hub.verify_token'] }}",
  rightValue: '={{ $env.META_WEBHOOK_VERIFY_TOKEN }}',
  operator: { type: 'string', operation: 'equals' },
}]);

responder('Responder hub.challenge', [-660, -340], "={{ $json.query['hub.challenge'] }}", 200);
responder('Recusar verificacao', [-660, -180], 'forbidden', 403);

/* ────────────────────────────────────────────────────────────────────────────
 * Nós — trilha 2: eventos (POST)
 * ──────────────────────────────────────────────────────────────────────────*/

add({
  parameters: {
    httpMethod: 'POST', path: CAMINHO, responseMode: 'responseNode',
    // rawBody e obrigatorio: o HMAC e sobre os bytes originais.
    options: { rawBody: true },
  },
  id: 'webhook-eventos', name: 'Meta — Eventos (POST)',
  type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-1120, 120], webhookId: CAMINHO,
});

code('Validar assinatura HMAC', [-900, 120], CODE_ASSINATURA);
se('Assinatura valida?', [-680, 120], condBool('={{ $json.valida }}'));

responder('Responder 401', [-460, 300], 'invalid signature', 401);
pg('Log — assinatura invalida', [-240, 300],
  "INSERT INTO ctwa_logs (etapa, status, detalhe, payload) VALUES ('assinatura', 'falha', $1, $2::jsonb)",
  '={{ [ $json.motivo, JSON.stringify({ bytes: $json.bytes, assinatura: $json.assinaturaPrefixo }) ] }}');

// ACK imediato: a Meta reenvia o evento se nao receber 200 em ~20s. Respondemos
// antes de qualquer I/O e seguimos processando nos nos abaixo.
responder('Responder 200 (ACK)', [-460, 60], 'EVENT_RECEIVED', 200);

code('Config', [-240, 60], CODE_CONFIG);
code('Extrair mensagens e referral', [-20, 60], CODE_EXTRAIR);

se('Tem dados de campanha?', [200, 60], condBool('={{ $json.temCampanha }}'));

pg('Log — mensagem sem campanha', [420, 260],
  "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, detalhe, payload) VALUES ($1, $2, 'extracao', 'ignorado', 'mensagem sem referral de anuncio', $3::jsonb)",
  '={{ [ $json.wamid, $json.telefone, JSON.stringify($json.payloadBruto || {}) ] }}');
noop('Fim — sem atribuicao', [640, 260]);

// Dedup + auditoria do payload na mesma escrita. O truque do xmax=0 devolve
// sempre uma linha, dizendo se foi INSERT (evento novo) ou conflito (repetido).
pg('Dedup + registrar evento', [420, 40],
  [
    'INSERT INTO ctwa_eventos (wamid, telefone, telefone_digits, waba_id, phone_number_id, ad_id, ctwa_clid, primeiro_contato_em, payload)',
    'VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::bigint), $9::jsonb)',
    'ON CONFLICT (wamid) DO UPDATE SET repeticoes = ctwa_eventos.repeticoes + 1, ultima_repeticao_em = now()',
    'RETURNING wamid, (xmax = 0) AS inserido, repeticoes;',
  ].join('\n'),
  '={{ [ $json.wamid, $json.telefone, $json.telefoneDigits, $json.wabaId, $json.phoneNumberId, ($json.referral && $json.referral.sourceId) || null, ($json.referral && $json.referral.ctwaClid) || null, $json.primeiroContatoUnix, JSON.stringify($json.payloadBruto || {}) ] }}',
  { onError: 'stopWorkflow' });

se('Evento novo?', [640, 40], condBool('={{ $json.inserido }}'));

pg('Log — evento duplicado', [860, 240],
  "INSERT INTO ctwa_logs (wamid, etapa, status, detalhe) VALUES ($1, 'dedup', 'duplicado', 'evento ja processado; reentrega da Meta')",
  '={{ [ $json.wamid ] }}');
noop('Fim — duplicado', [1080, 240]);

code('Contexto do anuncio', [860, 20], CODE_CONTEXTO);

http('Resolver anuncio (Graph API)', [1080, 20], {
  url: '={{ $json.urlGraph }}',
  ...AUTH_META,
  sendQuery: true,
  queryParameters: {
    parameters: [{
      name: 'fields',
      value: 'id,name,campaign{id,name,objective},adset{id,name,targeting{publisher_platforms}},creative{id,name,url_tags,effective_object_story_id}',
    }],
  },
  options: { timeout: 15000 },
}, {
  credentials: CRED_META,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
  // Anuncio deletado / source_id de post organico / token sem ads_read:
  // seguimos com o que veio do webhook em vez de perder a atribuicao inteira.
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

code('Normalizar atribuicao', [1300, 20], CODE_NORMALIZAR);

add({
  parameters: { batchSize: 1, options: { reset: false } },
  id: 'loop-por-lead', name: 'Loop por lead',
  type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [1520, 20],
});

noop('Fim — lote processado', [1740, -160]);

http('Buscar contato na Kommo', [1740, 60], {
  url: "=https://{{ $('Config').first().json.cfg.kommoSubdomain }}.kommo.com/api/v4/contacts",
  ...AUTH_KOMMO,
  sendQuery: true,
  queryParameters: {
    parameters: [
      { name: 'query', value: '={{ $json.telefoneBusca }}' },
      { name: 'with', value: 'leads' },
      { name: 'limit', value: '50' },
    ],
  },
  options: { timeout: 15000, response: { response: { neverError: true } } },
}, {
  credentials: CRED_KOMMO,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

code('Avaliar busca', [1960, 60], CODE_AVALIAR_BUSCA);
se('Contato com lead?', [2180, 60], condBool('={{ $json.encontrado }}'));

/* — ramo achou ————————————————————————————————————————————————————————— */

http('Ler lead atual', [2400, -80], {
  url: "=https://{{ $('Config').first().json.cfg.kommoSubdomain }}.kommo.com/api/v4/leads/{{ $json.leadId }}",
  ...AUTH_KOMMO,
  options: { timeout: 15000 },
}, {
  credentials: CRED_KOMMO,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

code('Montar PATCH (first-touch)', [2620, -80], CODE_MONTAR_PATCH);
se('Ha algo para gravar?', [2840, -80], condBool('={{ $json.temAlgoParaGravar }}'));

pg('Log — atribuicao preservada', [3060, 40],
  "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, kommo_lead_id, kommo_contact_id, detalhe) VALUES ($1, $2, 'kommo', 'preservado', $3, $4, $5)",
  '={{ [ $json.wamid, $json.telefone, $json.leadId, $json.contatoId, "lead ja tinha atribuicao: " + ($json.preservados || []).join(", ") ] }}');

http('Atualizar lead (PATCH unico)', [3060, -160], {
  method: 'PATCH',
  url: "=https://{{ $('Config').first().json.cfg.kommoSubdomain }}.kommo.com/api/v4/leads/{{ $json.leadId }}",
  ...AUTH_KOMMO,
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.patchBody) }}',
  options: { timeout: 15000 },
}, {
  credentials: CRED_KOMMO,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  onError: 'continueErrorOutput',
});

http('Nota de auditoria no lead', [3280, -220], {
  method: 'POST',
  url: "=https://{{ $('Config').first().json.cfg.kommoSubdomain }}.kommo.com/api/v4/leads/{{ $('Montar PATCH (first-touch)').first().json.leadId }}/notes",
  ...AUTH_KOMMO,
  sendBody: true,
  specifyBody: 'json',
  jsonBody: "={{ JSON.stringify([{ note_type: 'common', params: { text: $('Montar PATCH (first-touch)').first().json.nota } }]) }}",
  options: { timeout: 15000 },
}, {
  credentials: CRED_KOMMO,
  retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

pg('Log — sucesso', [3500, -220],
  "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, kommo_lead_id, kommo_contact_id, detalhe, payload) VALUES ($1, $2, 'kommo', 'sucesso', $3, $4, $5, $6::jsonb)",
  '={{ (() => { const c = $(\'Montar PATCH (first-touch)\').first().json; return [ c.wamid, c.telefone, c.leadId, c.contatoId, "gravados: " + (c.gravados || []).join(", "), JSON.stringify(c.atribuicao || {}) ]; })() }}');

pg('Log — falha na Kommo', [3280, -60],
  "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, kommo_lead_id, detalhe, payload) VALUES ($1, $2, 'kommo', 'falha', $3, $4, $5::jsonb)",
  '={{ (() => { const c = $(\'Montar PATCH (first-touch)\').first().json; return [ c.wamid, c.telefone, c.leadId, String(($json.error && ($json.error.message || $json.error.description)) || $json.message || "erro desconhecido").slice(0, 500), JSON.stringify($json) ]; })() }}');

http('Alertar falha persistente', [3500, -60], {
  method: 'POST',
  url: "={{ $('Config').first().json.cfg.alertaUrl || 'https://localhost/desativado' }}",
  sendBody: true,
  specifyBody: 'json',
  jsonBody: "={{ JSON.stringify({ origem: 'n8n/rastreio-ctwa', nivel: 'erro', texto: 'Falha ao gravar atribuicao no Kommo — lead ' + ($('Montar PATCH (first-touch)').first().json.leadId || '?') }) }}",
  options: { timeout: 10000 },
}, {
  // Sem ALERT_WEBHOOK_URL o no falha e e ignorado: o log no Postgres continua
  // sendo a fonte de verdade.
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
  executeOnce: false,
});

/* — ramo não achou ————————————————————————————————————————————————————— */

se('Tentativas esgotadas?', [2400, 240], condBool('={{ $json.tentativasEsgotadas }}'));

add({
  parameters: { amount: '={{ $json.esperaSegundos }}', unit: 'seconds' },
  id: 'aguardar-kommo', name: 'Aguardar a Kommo criar o lead',
  type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [2180, 380], webhookId: 'ctwa-backoff',
});

se('Criar lead se nao existir?', [2620, 240],
  condBool("={{ $('Config').first().json.cfg.criarSeNaoExistir }}"));

code('Montar criacao (complex)', [2840, 180], CODE_CRIAR_BODY);

http('Criar contato + lead na Kommo', [3060, 180], {
  method: 'POST',
  url: "=https://{{ $('Config').first().json.cfg.kommoSubdomain }}.kommo.com/api/v4/leads/complex",
  ...AUTH_KOMMO,
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.criarBody) }}',
  options: { timeout: 15000 },
}, {
  credentials: CRED_KOMMO,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

pg('Log — lead criado', [3280, 180],
  "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, kommo_lead_id, detalhe, payload) VALUES ($1, $2, 'kommo', 'criado', $3, 'lead criado pelo rastreio (KOMMO_CREATE_IF_MISSING=true)', $4::jsonb)",
  '={{ (() => { const c = $(\'Montar criacao (complex)\').first().json; const r = Array.isArray($json) ? $json[0] : $json; const id = (r && r._embedded && r._embedded.leads && r._embedded.leads[0] && r._embedded.leads[0].id) || (r && r.id) || null; return [ c.wamid, c.telefone, id, JSON.stringify(c.atribuicao || {}) ]; })() }}');

pg('Log — orfao (aguardando reconciliacao)', [2840, 340],
  "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, detalhe, payload) VALUES ($1, $2, 'kommo', 'orfao', $3, $4::jsonb)",
  '={{ [ $json.wamid, $json.telefone, "nenhum lead encontrado apos " + $json.tentativa + " tentativas", JSON.stringify($json.atribuicao || {}) ] }}');

/* ────────────────────────────────────────────────────────────────────────────
 * Sticky notes (documentação no canvas)
 * ──────────────────────────────────────────────────────────────────────────*/

sticky(
  '## 1. Entrada da Meta\n\n' +
  '**GET** = handshake de verificação do webhook (`hub.challenge`).\n' +
  '**POST** = eventos. `Raw Body` está LIGADO porque o HMAC é sobre os bytes originais.\n\n' +
  'Este workflow é um **segundo app assinante da mesma WABA**. Ele não substitui e não ' +
  'intercepta o webhook da Kommo — a Kommo continua recebendo tudo, direto da Meta.',
  [-1400, -400], 260, 620, 5);

sticky(
  '## 2. Assinatura e ACK\n\n' +
  'Assinatura inválida → **401** (a Meta não reentrega em 4xx, evita loop) e log.\n\n' +
  'Assinatura válida → **200 imediato**, antes de qualquer I/O. A Meta reentrega se não ' +
  'receber 200 em ~20s; o processamento segue depois do Respond.',
  [-700, 460], 420, 220, 3);

sticky(
  '## 3. Dedup + auditoria\n\n' +
  '`INSERT ... ON CONFLICT ... RETURNING (xmax = 0)` faz as duas coisas numa escrita só: ' +
  'grava o payload bruto e diz se o evento é novo.\n\n' +
  'Reentregas da Meta caem no ramo "duplicado" e param aqui.',
  [380, 440], 420, 200, 6);

sticky(
  '## 4. Enriquecimento na Graph API\n\n' +
  'O webhook traz `source_id` (ID do anúncio) e `ctwa_clid`. Campanha, conjunto, nome do ' +
  'anúncio e `url_tags` (de onde saem as UTMs) vêm da Graph.\n\n' +
  'Falha aqui **não** aborta: seguimos gravando o que veio do webhook (`onError: continue`).',
  [1020, 300], 420, 220, 7);

sticky(
  '## 5. Casamento com a Kommo\n\n' +
  'Busca por telefone (últimos 8 dígitos — imune a DDI/9º dígito).\n\n' +
  '**Contato sem lead conta como "não achou"**: quase sempre significa que a Kommo ainda ' +
  'está criando o lead da mensagem que acabou de chegar. Espera com backoff (20s/40s/60s) ' +
  'em vez de criar um lead paralelo.\n\n' +
  'Só cria registro se `KOMMO_CREATE_IF_MISSING=true`. Padrão: **não cria**, registra órfão.',
  [1900, 480], 460, 300, 3);

sticky(
  '## 6. Gravação first-touch\n\n' +
  'Um **único PATCH** com campos + tag. Dois PATCHes concorrentes no mesmo lead têm race ' +
  'na API do Kommo — o último pode apagar o anterior.\n\n' +
  '`tags_to_add` vai na **raiz** do body. Dentro de `_embedded` o Kommo responde 200 e ' +
  'ignora em silêncio.\n\n' +
  'Só grava campo **vazio**: atribuição anterior válida nunca é sobrescrita.',
  [2800, -420], 480, 300, 4);

/* ────────────────────────────────────────────────────────────────────────────
 * Conexões
 * ──────────────────────────────────────────────────────────────────────────*/

const conexoes = {};
function liga(de, para, saidaIdx = 0) {
  conexoes[de] = conexoes[de] || { main: [] };
  while (conexoes[de].main.length <= saidaIdx) conexoes[de].main.push([]);
  conexoes[de].main[saidaIdx].push({ node: para, type: 'main', index: 0 });
}

// trilha GET
liga('Meta — Verificacao (GET)', 'Verify token confere?');
liga('Verify token confere?', 'Responder hub.challenge', 0);
liga('Verify token confere?', 'Recusar verificacao', 1);

// trilha POST
liga('Meta — Eventos (POST)', 'Validar assinatura HMAC');
liga('Validar assinatura HMAC', 'Assinatura valida?');
liga('Assinatura valida?', 'Responder 200 (ACK)', 0);
liga('Assinatura valida?', 'Responder 401', 1);
liga('Responder 401', 'Log — assinatura invalida');

liga('Responder 200 (ACK)', 'Config');
liga('Config', 'Extrair mensagens e referral');
liga('Extrair mensagens e referral', 'Tem dados de campanha?');
liga('Tem dados de campanha?', 'Dedup + registrar evento', 0);
liga('Tem dados de campanha?', 'Log — mensagem sem campanha', 1);
liga('Log — mensagem sem campanha', 'Fim — sem atribuicao');

liga('Dedup + registrar evento', 'Evento novo?');
liga('Evento novo?', 'Contexto do anuncio', 0);
liga('Evento novo?', 'Log — evento duplicado', 1);
liga('Log — evento duplicado', 'Fim — duplicado');

liga('Contexto do anuncio', 'Resolver anuncio (Graph API)');
liga('Resolver anuncio (Graph API)', 'Normalizar atribuicao');
liga('Normalizar atribuicao', 'Loop por lead');

liga('Loop por lead', 'Fim — lote processado', 0);   // saída "done"
liga('Loop por lead', 'Buscar contato na Kommo', 1);  // saída "loop"

liga('Buscar contato na Kommo', 'Avaliar busca');
liga('Avaliar busca', 'Contato com lead?');

// achou
liga('Contato com lead?', 'Ler lead atual', 0);
liga('Ler lead atual', 'Montar PATCH (first-touch)');
liga('Montar PATCH (first-touch)', 'Ha algo para gravar?');
liga('Ha algo para gravar?', 'Atualizar lead (PATCH unico)', 0);
liga('Ha algo para gravar?', 'Log — atribuicao preservada', 1);
liga('Log — atribuicao preservada', 'Loop por lead');

liga('Atualizar lead (PATCH unico)', 'Nota de auditoria no lead', 0);  // sucesso
liga('Atualizar lead (PATCH unico)', 'Log — falha na Kommo', 1);       // erro
liga('Nota de auditoria no lead', 'Log — sucesso');
liga('Log — sucesso', 'Loop por lead');
liga('Log — falha na Kommo', 'Alertar falha persistente');
liga('Alertar falha persistente', 'Loop por lead');

// não achou
liga('Contato com lead?', 'Tentativas esgotadas?', 1);
liga('Tentativas esgotadas?', 'Criar lead se nao existir?', 0);
liga('Tentativas esgotadas?', 'Aguardar a Kommo criar o lead', 1);
liga('Aguardar a Kommo criar o lead', 'Buscar contato na Kommo');

liga('Criar lead se nao existir?', 'Montar criacao (complex)', 0);
liga('Criar lead se nao existir?', 'Log — orfao (aguardando reconciliacao)', 1);
liga('Montar criacao (complex)', 'Criar contato + lead na Kommo');
liga('Criar contato + lead na Kommo', 'Log — lead criado');
liga('Log — lead criado', 'Loop por lead');
liga('Log — orfao (aguardando reconciliacao)', 'Loop por lead');

/* ────────────────────────────────────────────────────────────────────────────
 * Saída
 * ──────────────────────────────────────────────────────────────────────────*/

const workflow = {
  name: 'Rastreio de Campanhas - WhatsApp > Kommo',
  nodes: nos,
  connections: conexoes,
  settings: {
    executionOrder: 'v1',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    saveExecutionProgress: true,
    executionTimeout: 900,
    timezone: 'America/Sao_Paulo',
  },
  tags: [{ name: 'rastreio' }, { name: 'meta' }, { name: 'kommo' }],
  active: false,
  pinData: {},
};

const destino = join(AQUI, 'rastreio-campanhas-whatsapp-kommo.json');
writeFileSync(destino, JSON.stringify(workflow, null, 2) + '\n', 'utf8');
console.log('ok:', destino, '—', nos.length, 'nos,', Object.keys(conexoes).length, 'origens de conexao');
