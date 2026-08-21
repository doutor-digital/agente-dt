#!/usr/bin/env node
/**
 * Gera o workflow de BACKFILL: preenche campanha/conjunto/anúncio/UTMs dos leads
 * que foram atribuídos entre 12/08 e 18/08/2026, quando o `META_ADS_TOKEN` não
 * estava configurado e toda chamada à Graph voltava "Bad request".
 *
 * Regras que ele herda do fluxo principal, de propósito:
 *  - só grava campo VAZIO (first-touch preservado — nunca sobrescreve atribuição);
 *  - um único PATCH por lead (a API do Kommo tem race entre PATCHes concorrentes);
 *  - um lead por vez, para respeitar rate limit;
 *  - falha em um lead não derruba o lote (`onError: continue`), e vira linha de log.
 *
 * É descartável: rodar, conferir o resumo, apagar o workflow.
 *
 * Uso: node ops/build-backfill.mjs  →  escreve ops/backfill-graph.json
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));

const CRED_PG = { postgres: { id: 'y6Q1JmvPL4BodI9u', name: 'Postgres - Rastreio CTWA' } };
const CRED_KOMMO = { kommoLongLivedApi: { id: 'MnPGiOOvaSPm9HgC', name: 'Kommo Imperatriz' } };

const SQL_PENDENTES = `select distinct on (l.kommo_lead_id)
       l.kommo_lead_id                                          as lead_id,
       e.ad_id                                                  as ad_id,
       e.wamid                                                  as wamid,
       e.telefone                                               as telefone,
       e.payload->'messages'->0->'referral'->>'source_url'      as source_url
from ctwa_logs l
join ctwa_eventos e on e.wamid = l.wamid
where l.status = 'sucesso'
  and l.payload->>'erroGraph' is not null
  and coalesce(l.payload->>'tipoCru', 'ad') = 'ad'
  and l.kommo_lead_id is not null
  and e.ad_id is not null
order by l.kommo_lead_id, l.criado_em desc;`;

const JS_ATRIBUICAO = `// Monta a atribuicao a partir da resposta da Graph, com a MESMA precedencia de
// UTM do fluxo principal: query string do source_url > creative.url_tags > derivado.
const ctx = $('Loop').first().json;
const g = $input.first().json || {};

const erro = g.error
  ? String(g.error.message || g.error.error_user_msg || g.error).slice(0, 300)
  : null;
const ad = erro ? {} : g;

const campanha = ad.campaign || {};
const conjunto = ad.adset || {};
const criativo = ad.creative || {};
const plataformas = (conjunto.targeting && conjunto.targeting.publisher_platforms) || [];
const plataforma = plataformas.includes('instagram') ? 'instagram'
                 : (plataformas[0] || (/instagram/i.test(String(ctx.source_url || '')) ? 'instagram' : 'facebook'));

function queryDe(url) {
  const out = {};
  const i = String(url || '').indexOf('?');
  if (i < 0) return out;
  for (const par of String(url).slice(i + 1).split('&')) {
    if (!par) continue;
    const [k, ...resto] = par.split('=');
    try { out[decodeURIComponent(k)] = decodeURIComponent(resto.join('=').replace(/\\+/g, ' ')); }
    catch (e) { out[k] = resto.join('='); }
  }
  return out;
}
function resolverMacros(texto, vars) {
  if (!texto) return '';
  return String(texto).replace(/\\{\\{\\s*([a-z_.]+)\\s*\\}\\}/gi, (m, chave) => {
    const v = vars[String(chave).toLowerCase()];
    return v === undefined || v === null ? '' : String(v);
  });
}

const vars = {
  'campaign.name': campanha.name || '', 'campaign.id': campanha.id || '',
  'adset.name': conjunto.name || '', 'adset.id': conjunto.id || '',
  'ad.name': ad.name || '', 'ad.id': ad.id || '',
  'site_source_name': plataforma, 'placement': plataforma,
};

const utmUrl = queryDe(ctx.source_url);
const utmCriativo = queryDe('?' + resolverMacros(criativo.url_tags || '', vars));
const pegar = (chave, derivado) => utmUrl[chave] || utmCriativo[chave] || derivado || null;

return [{ json: {
  ...ctx,
  erroGraph: erro,
  atribuicao: {
    campanhaNome: campanha.name || null,
    conjuntoNome: conjunto.name || null,
    anuncioNome: ad.name || null,
    anuncioId: ad.id || ctx.ad_id || null,
    plataforma,
    imagemAnuncio: criativo.image_url || criativo.thumbnail_url || null,
    utmSource: pegar('utm_source', plataforma),
    utmMedium: pegar('utm_medium', 'paid_social'),
    utmCampaign: pegar('utm_campaign', campanha.name),
    utmContent: pegar('utm_content', ad.name),
    utmTerm: pegar('utm_term', conjunto.name),
  },
} }];`;

const JS_MONTAR = `// So preenche o que esta VAZIO — first-touch continua valendo no backfill.
const ctx = $('Atribuicao').first().json;
const a = ctx.atribuicao || {};

function corpoJson(j) {
  if (!j) return {};
  if (typeof j === 'string') { try { return JSON.parse(j); } catch (e) { return {}; } }
  if (typeof j.data === 'string') { try { return JSON.parse(j.data); } catch (e) { return j; } }
  return j;
}
const lead = corpoJson($input.first().json);

const inteiro = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null; };
const campos = {
  campanha:    inteiro($env.KOMMO_CF_CAMPANHA)    || 2442767,
  conjunto:    inteiro($env.KOMMO_CF_CONJUNTO)    || 2442725,
  anuncio:     inteiro($env.KOMMO_CF_ANUNCIO)     || 2443929,
  anuncioId:   inteiro($env.KOMMO_CF_AD_ID)       || 2443931,
  utmSource:   inteiro($env.KOMMO_CF_UTM_SOURCE)  || 888104,
  utmMedium:   inteiro($env.KOMMO_CF_UTM_MEDIUM)  || 888100,
  utmCampaign: inteiro($env.KOMMO_CF_UTM_CAMPAIGN)|| 888102,
  utmContent:  inteiro($env.KOMMO_CF_UTM_CONTENT) || 888098,
  utmTerm:     inteiro($env.KOMMO_CF_UTM_TERM)    || 888106,
  plataforma:  inteiro($env.KOMMO_CF_PLATAFORMA)  || 2443939,
  imagemAnuncio: inteiro($env.KOMMO_CF_IMAGEM_ANUNCIO) || 2444385,
};

const atuais = new Map();
for (const f of (lead.custom_fields_values || [])) {
  const v = (f.values || [])[0];
  const valor = v ? (v.value ?? null) : null;
  atuais.set(Number(f.field_id), valor === '' ? null : valor);
}

const custom = [];
const gravados = [];
const preservados = [];
for (const [chave, valor] of Object.entries({
  campanha: a.campanhaNome, conjunto: a.conjuntoNome, anuncio: a.anuncioNome,
  anuncioId: a.anuncioId, utmSource: a.utmSource, utmMedium: a.utmMedium,
  utmCampaign: a.utmCampaign, utmContent: a.utmContent, utmTerm: a.utmTerm,
  plataforma: a.plataforma, imagemAnuncio: a.imagemAnuncio,
})) {
  const fieldId = campos[chave];
  if (!fieldId || valor === null || valor === undefined || valor === '') continue;
  if (atuais.get(fieldId)) { preservados.push(chave); continue; }
  custom.push({ field_id: fieldId, values: [{ value: valor }] });
  gravados.push(chave);
}

return [{ json: {
  ...ctx,
  patchBody: custom.length ? { custom_fields_values: custom } : {},
  temAlgoParaGravar: custom.length > 0,
  gravados, preservados,
} }];`;

const JS_RESUMO = `const linhas = $('Loop').all().map((i) => i.json);
return [{ json: { processados: linhas.length, obs: 'detalhe por lead em ctwa_logs, etapa = backfill' } }];`;

const nodes = [
  {
    parameters: { httpMethod: 'POST', path: 'ctwa-backfill-tmp', responseMode: 'responseNode', options: {} },
    id: 'wh', name: 'Disparar', type: 'n8n-nodes-base.webhook', typeVersion: 2,
    position: [-800, 0], webhookId: 'ctwa-backfill-tmp',
  },
  {
    parameters: { operation: 'executeQuery', query: SQL_PENDENTES, options: {} },
    id: 'sel', name: 'Pendentes', type: 'n8n-nodes-base.postgres', typeVersion: 2.5,
    position: [-580, 0], credentials: CRED_PG,
  },
  {
    parameters: { options: { reset: false } },
    id: 'loop', name: 'Loop', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3,
    position: [-360, 0],
  },
  {
    parameters: {
      url: "=https://graph.facebook.com/{{ $env.META_GRAPH_VERSION || 'v23.0' }}/{{ $json.ad_id }}",
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'fields', value: 'id,name,campaign{id,name,objective},adset{id,name,targeting{publisher_platforms}},creative{id,name,url_tags,thumbnail_url,image_url}' },
          { name: 'access_token', value: '={{ $env.META_ADS_TOKEN }}' },
        ],
      },
      options: { timeout: 20000, response: { response: { neverError: true } } },
    },
    id: 'graph', name: 'Graph', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [-140, 100], retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput',
  },
  {
    parameters: { jsCode: JS_ATRIBUICAO },
    id: 'atr', name: 'Atribuicao', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [80, 100],
  },
  {
    parameters: {
      url: '=https://attivacorpoementeitz.kommo.com/api/v4/leads/{{ $json.lead_id }}',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'kommoLongLivedApi',
      options: { timeout: 15000 },
    },
    id: 'ler', name: 'Ler lead', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [300, 100], credentials: CRED_KOMMO, retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
  },
  {
    parameters: { jsCode: JS_MONTAR },
    id: 'mon', name: 'Montar PATCH', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [520, 100],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: 'c1', leftValue: '={{ $json.temAlgoParaGravar }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    id: 'if', name: 'Tem algo?', type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [740, 100],
  },
  {
    parameters: {
      method: 'PATCH',
      url: '=https://attivacorpoementeitz.kommo.com/api/v4/leads/{{ $json.lead_id }}',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'kommoLongLivedApi',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.patchBody) }}',
      options: { timeout: 15000 },
    },
    id: 'patch', name: 'Gravar', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [960, 20], credentials: CRED_KOMMO, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput',
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, kommo_lead_id, detalhe, payload) VALUES ($1, $2, 'backfill', 'sucesso', $3, $4, $5::jsonb)",
      options: {
        queryReplacement: "={{ (() => { const c = $('Montar PATCH').first().json; return [ c.wamid, c.telefone, c.lead_id, 'backfill | gravados: ' + (c.gravados||[]).join(', ') + ' | preservados: ' + ((c.preservados||[]).join(', ') || 'nenhum'), JSON.stringify(c.atribuicao || {}) ]; })() }}",
      },
    },
    id: 'log', name: 'Log backfill', type: 'n8n-nodes-base.postgres', typeVersion: 2.5,
    position: [1180, 20], credentials: CRED_PG, onError: 'continueRegularOutput',
  },
  {
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO ctwa_logs (wamid, telefone, etapa, status, kommo_lead_id, detalhe, payload) VALUES ($1, $2, 'backfill', 'preservado', $3, $4, $5::jsonb)",
      options: {
        queryReplacement: "={{ (() => { const c = $('Montar PATCH').first().json; return [ c.wamid, c.telefone, c.lead_id, 'backfill | nada a gravar | preservados: ' + ((c.preservados||[]).join(', ') || 'nenhum') + (c.erroGraph ? ' | graph: ' + c.erroGraph : ''), JSON.stringify(c.atribuicao || {}) ]; })() }}",
      },
    },
    id: 'lognada', name: 'Log sem mudanca', type: 'n8n-nodes-base.postgres', typeVersion: 2.5,
    position: [960, 220], credentials: CRED_PG, onError: 'continueRegularOutput',
  },
  {
    parameters: { jsCode: JS_RESUMO },
    id: 'res', name: 'Resumo', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [-140, -140],
  },
  {
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    id: 'resp', name: 'Responder', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1,
    position: [80, -140],
  },
];

const connections = {
  Disparar: { main: [[{ node: 'Pendentes', type: 'main', index: 0 }]] },
  Pendentes: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
  // saida 0 do splitInBatches = terminou; saida 1 = proximo item
  Loop: { main: [[{ node: 'Resumo', type: 'main', index: 0 }], [{ node: 'Graph', type: 'main', index: 0 }]] },
  Graph: { main: [[{ node: 'Atribuicao', type: 'main', index: 0 }]] },
  Atribuicao: { main: [[{ node: 'Ler lead', type: 'main', index: 0 }]] },
  'Ler lead': { main: [[{ node: 'Montar PATCH', type: 'main', index: 0 }]] },
  'Montar PATCH': { main: [[{ node: 'Tem algo?', type: 'main', index: 0 }]] },
  'Tem algo?': {
    main: [
      [{ node: 'Gravar', type: 'main', index: 0 }],
      [{ node: 'Log sem mudanca', type: 'main', index: 0 }],
    ],
  },
  Gravar: { main: [[{ node: 'Log backfill', type: 'main', index: 0 }]] },
  'Log backfill': { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
  'Log sem mudanca': { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
  Resumo: { main: [[{ node: 'Responder', type: 'main', index: 0 }]] },
};

const wf = {
  name: 'TMP — Backfill CTWA (campanha/conjunto/anuncio)',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo', executionTimeout: 3600 },
};

const saida = resolve(aqui, 'backfill-graph.json');
writeFileSync(saida, `${JSON.stringify(wf, null, 2)}\n`);
console.log(`ok: ${saida} (${nodes.length} nós)`);
