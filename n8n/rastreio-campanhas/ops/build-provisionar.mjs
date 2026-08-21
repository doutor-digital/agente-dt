#!/usr/bin/env node
/**
 * Gera o workflow descartável que PROVISIONA nas unidades o que falta para o rastreio
 * de nó nativo funcionar igual ao da Imperatriz:
 *
 *  - os dois campos de last-touch (`⌂ Último anúncio`, `⌂ Cliques no anúncio`), já
 *    criados dentro do MESMO grupo do `⌂ Campanha` daquela conta (o "MARKETING") —
 *    o `group_id` muda de conta para conta, então é descoberto em tempo de execução;
 *  - as duas tags de origem. Tag inexistente em `tags_to_add` é ignorada em silêncio
 *    pelo Kommo, então ela precisa existir ANTES do primeiro lead chegar.
 *
 * Só mexe nas unidades passadas em `ALVOS` — Trauma fica de fora de propósito: tem 6 de
 * 18 campos, não é uma unidade Doutor Hérnia, e criar 12 campos num CRM que não usa o
 * rastreio é intromissão, não replicação.
 *
 * Uso: node ops/build-provisionar.mjs → ops/provisionar.json (importar, ativar, chamar,
 * APAGAR).
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIDADES, TAGS } from './unidades.mjs';

const aqui = dirname(fileURLToPath(import.meta.url));
const ALVOS = UNIDADES.filter((u) => !u.canonica && u.slug !== 'trauma');

const nodes = [
  {
    parameters: { httpMethod: 'POST', path: 'ctwa-provisionar-tmp', responseMode: 'responseNode', options: {} },
    id: 'wh', name: 'Disparar', type: 'n8n-nodes-base.webhook', typeVersion: 2,
    position: [0, 0], webhookId: 'ctwa-provisionar-tmp',
  },
];
const connections = {};
let anterior = 'Disparar';
let x = 200;

const JS_PREPARAR = (u) => `// Descobre o grupo do "⌂ Campanha" desta conta e monta o corpo da criacao.
// Criar ja com group_id evita um PATCH extra depois.
function corpo(j) {
  if (typeof j === 'string') { try { return JSON.parse(j); } catch (e) { return {}; } }
  if (typeof j?.data === 'string') { try { return JSON.parse(j.data); } catch (e) { return j; } }
  return j || {};
}
function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .replace(/[^a-z0-9_]+/gi, ' ').trim().toLowerCase();
}
const campos = corpo($input.first().json)?._embedded?.custom_fields || [];
const porNome = new Map(campos.map((c) => [normalizar(c.name), c]));
const referencia = porNome.get(normalizar('⌂ Campanha'));
const grupo = referencia?.group_id ?? null;

const desejados = [
  { nome: '⌂ Último anúncio', tipo: 'text' },
  { nome: '⌂ Cliques no anúncio', tipo: 'numeric' },
];
// Idempotente: se ja existir (rodada anterior, ou criado na mao), nao recria.
const criar = desejados
  .filter((d) => !porNome.has(normalizar(d.nome)))
  .map((d) => (grupo ? { name: d.nome, type: d.tipo, group_id: grupo } : { name: d.nome, type: d.tipo }));

const jaExistiam = desejados
  .filter((d) => porNome.has(normalizar(d.nome)))
  .map((d) => d.nome + ' (' + porNome.get(normalizar(d.nome)).id + ')');

return [{ json: { unidade: '${u.slug}', grupo, criar, jaExistiam, precisaCriar: criar.length > 0 } }];`;

for (const u of ALVOS) {
  const nLer = `Ler ${u.nome}`;
  const nPrep = `Preparar ${u.nome}`;
  const nCriar = `Criar ${u.nome}`;
  const nTags = `Tags ${u.nome}`;

  nodes.push(
    {
      parameters: {
        url: `https://${u.subdominio}.kommo.com/api/v4/leads/custom_fields?limit=250`,
        authentication: 'predefinedCredentialType', nodeCredentialType: 'kommoLongLivedApi',
        options: { timeout: 20000, response: { response: { neverError: true } } },
      },
      id: `ler-${u.slug}`, name: nLer, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [x, 0], credentials: { kommoLongLivedApi: u.credencial }, onError: 'continueRegularOutput',
    },
    {
      parameters: { jsCode: JS_PREPARAR(u) },
      id: `prep-${u.slug}`, name: nPrep, type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [x, 160],
    },
    {
      parameters: {
        method: 'POST',
        url: `https://${u.subdominio}.kommo.com/api/v4/leads/custom_fields`,
        authentication: 'predefinedCredentialType', nodeCredentialType: 'kommoLongLivedApi',
        sendBody: true, specifyBody: 'json',
        // Sem nada para criar, manda um array vazio — o Kommo responde 400 e o
        // neverError transforma isso em item comum; o resumo distingue pelo `precisaCriar`.
        jsonBody: '={{ JSON.stringify($json.criar) }}',
        options: { timeout: 20000, response: { response: { neverError: true } } },
      },
      id: `criar-${u.slug}`, name: nCriar, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [x, 320], credentials: { kommoLongLivedApi: u.credencial }, onError: 'continueRegularOutput',
    },
    {
      parameters: {
        method: 'POST',
        url: `https://${u.subdominio}.kommo.com/api/v4/leads/tags`,
        authentication: 'predefinedCredentialType', nodeCredentialType: 'kommoLongLivedApi',
        sendBody: true, specifyBody: 'json',
        jsonBody: JSON.stringify(TAGS.map((name) => ({ name }))),
        options: { timeout: 20000, response: { response: { neverError: true } } },
      },
      id: `tags-${u.slug}`, name: nTags, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [x, 480], credentials: { kommoLongLivedApi: u.credencial }, onError: 'continueRegularOutput',
    },
  );

  connections[anterior] = { main: [[{ node: nLer, type: 'main', index: 0 }]] };
  connections[nLer] = { main: [[{ node: nPrep, type: 'main', index: 0 }]] };
  connections[nPrep] = { main: [[{ node: nCriar, type: 'main', index: 0 }]] };
  connections[nCriar] = { main: [[{ node: nTags, type: 'main', index: 0 }]] };
  anterior = nTags;
  x += 200;
}

const JS_RESUMO = `const ALVOS = ${JSON.stringify(ALVOS.map((u) => ({ slug: u.slug, nome: u.nome })))};
function corpo(j) {
  if (typeof j === 'string') { try { return JSON.parse(j); } catch (e) { return {}; } }
  if (typeof j?.data === 'string') { try { return JSON.parse(j.data); } catch (e) { return j; } }
  return j || {};
}
const out = {};
for (const u of ALVOS) {
  const prep = $('Preparar ' + u.nome).first().json;
  const criado = corpo($('Criar ' + u.nome).first().json);
  const tags = corpo($('Tags ' + u.nome).first().json);
  out[u.slug] = {
    grupo: prep.grupo,
    jaExistiam: prep.jaExistiam,
    criados: (criado?._embedded?.custom_fields || []).map((c) => c.id + ' | ' + c.name + ' | grupo ' + c.group_id),
    erroCriar: prep.precisaCriar ? (criado?.detail || criado?.title || null) : 'nada a criar',
    tags: (tags?._embedded?.tags || []).map((t) => t.id + ' | ' + t.name),
    erroTags: tags?.detail || tags?.title || null,
  };
}
return [{ json: out }];`;

nodes.push(
  {
    parameters: { jsCode: JS_RESUMO },
    id: 'res', name: 'Resumo', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [x, 0],
  },
  {
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    id: 'resp', name: 'Responder', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1,
    position: [x + 200, 0],
  },
);
connections[anterior] = { main: [[{ node: 'Resumo', type: 'main', index: 0 }]] };
connections.Resumo = { main: [[{ node: 'Responder', type: 'main', index: 0 }]] };

const wf = {
  name: 'TMP — Provisionar campos/tags CTWA por unidade',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo' },
};

const saida = resolve(aqui, 'provisionar.json');
writeFileSync(saida, `${JSON.stringify(wf, null, 2)}\n`);
console.log(`ok: ${saida} (${nodes.length} nós, ${ALVOS.length} unidades: ${ALVOS.map((u) => u.slug).join(', ')})`);
