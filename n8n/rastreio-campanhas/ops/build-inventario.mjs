#!/usr/bin/env node
/**
 * Gera um workflow n8n descartável que faz o INVENTÁRIO das unidades: para cada uma,
 * lê os campos personalizados de lead do Kommo com a credencial daquela unidade e
 * devolve, num JSON só, quais dos campos de rastreio existem, com que id, e se o
 * `⚑ Origem` tem as opções que o fluxo precisa.
 *
 * Existe porque o token do Kommo de cada unidade vive só dentro da credencial do n8n —
 * ler daqui exigiria expor os dez tokens. Assim ninguém precisa ver segredo nenhum.
 *
 * Uso: node ops/build-inventario.mjs → ops/inventario.json (importar, ativar, chamar,
 * APAGAR — enquanto ativo é um endpoint aberto).
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIDADES, CAMPOS, OPCOES_ORIGEM } from './unidades.mjs';

const aqui = dirname(fileURLToPath(import.meta.url));

const nodes = [
  {
    parameters: { httpMethod: 'POST', path: 'ctwa-inventario-tmp', responseMode: 'responseNode', options: {} },
    id: 'wh', name: 'Disparar', type: 'n8n-nodes-base.webhook', typeVersion: 2,
    position: [0, 0], webhookId: 'ctwa-inventario-tmp',
  },
];
const connections = {};

// Uma consulta por unidade, em cadeia: sequencial de propósito — dez contas em
// paralelo estouraria rate limit e o ganho de tempo aqui não vale o risco.
let anterior = 'Disparar';
for (const u of UNIDADES) {
  const nome = `Campos ${u.nome}`;
  nodes.push({
    parameters: {
      url: `https://${u.subdominio}.kommo.com/api/v4/leads/custom_fields?limit=250`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'kommoLongLivedApi',
      options: { timeout: 20000, response: { response: { neverError: true } } },
    },
    id: `q-${u.slug}`, name: nome, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [220 + UNIDADES.indexOf(u) * 180, 0],
    credentials: { kommoLongLivedApi: u.credencial },
    onError: 'continueRegularOutput',
  });
  connections[anterior] = { main: [[{ node: nome, type: 'main', index: 0 }]] };
  anterior = nome;
}

const JS_RESUMO = `const UNIDADES = ${JSON.stringify(UNIDADES.map((u) => ({ slug: u.slug, nome: u.nome, subdominio: u.subdominio })))};
const CAMPOS = ${JSON.stringify(CAMPOS)};
const OPCOES = ${JSON.stringify(OPCOES_ORIGEM)};

function corpo(j) {
  if (typeof j === 'string') { try { return JSON.parse(j); } catch (e) { return {}; } }
  if (typeof j?.data === 'string') { try { return JSON.parse(j.data); } catch (e) { return j; } }
  return j || {};
}
// Comparar por nome exige normalizar: acento, caixa e os prefixos de simbolo
// (⌂ ⚑ ◷) variam entre contas replicadas em epocas diferentes.
function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .replace(/[^a-z0-9_]+/gi, ' ')
    .trim().toLowerCase();
}

const relatorio = {};
for (const u of UNIDADES) {
  const resp = corpo($('Campos ' + u.nome).first().json);
  const campos = resp?._embedded?.custom_fields || [];
  if (!campos.length) {
    relatorio[u.slug] = { erro: resp?.detail || resp?.title || resp?.message || 'sem campos / falha de acesso' };
    continue;
  }
  const porNome = new Map(campos.map((c) => [normalizar(c.name), c]));
  const achados = {};
  const faltando = [];
  for (const def of CAMPOS) {
    const c = porNome.get(normalizar(def.nome));
    if (c) achados[def.chave] = { id: c.id, tipo: c.type, nome: c.name };
    else faltando.push(def.chave);
  }
  const origem = porNome.get(normalizar('⚑ Origem'));
  const opcoesOrigem = (origem?.enums || []).map((e) => e.value);
  relatorio[u.slug] = {
    total: campos.length,
    achados,
    faltando,
    opcoesOrigemFaltando: origem ? OPCOES.filter((o) => !opcoesOrigem.includes(o)) : OPCOES,
    origemEhSelect: origem ? origem.type === 'select' : null,
  };
}
return [{ json: relatorio }];`;

nodes.push(
  {
    parameters: { jsCode: JS_RESUMO },
    id: 'res', name: 'Resumo', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [220 + UNIDADES.length * 180, 0],
  },
  {
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    id: 'resp', name: 'Responder', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1,
    position: [220 + (UNIDADES.length + 1) * 180, 0],
  },
);
connections[anterior] = { main: [[{ node: 'Resumo', type: 'main', index: 0 }]] };
connections.Resumo = { main: [[{ node: 'Responder', type: 'main', index: 0 }]] };

const wf = {
  name: 'TMP — Inventário CTWA por unidade',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo' },
};

const saida = resolve(aqui, 'inventario.json');
writeFileSync(saida, `${JSON.stringify(wf, null, 2)}\n`);
console.log(`ok: ${saida} (${nodes.length} nós, ${UNIDADES.length} unidades)`);
