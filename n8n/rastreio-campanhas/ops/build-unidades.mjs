#!/usr/bin/env node
/**
 * Gera UM workflow de rastreio por unidade, a partir do workflow da Imperatriz que
 * está em produção (`rastreio-campanhas-nativo.json`).
 *
 * Por que não dá para simplesmente duplicar: o desenho original lê tudo de `$env`
 * (subdomínio, os 18 ids de campo). Env var é **global no n8n** — dez workflows lendo
 * o mesmo `$env` gravariam todos na Imperatriz. Por isso, aqui, o que é da unidade vira
 * literal dentro do Config; o que é global (token de Ads, versão da Graph, política de
 * criação de lead, backoff) continua vindo de `$env`.
 *
 * Também injeta a coluna `unidade` em todo INSERT: sem isso, `ctwa_logs` e
 * `ctwa_eventos` viram uma sopa de dez unidades sem como separar.
 *
 * Entrada: ops/campos-por-unidade.json (saída do inventário: {slug: {chave: id}}).
 * Uso: node ops/build-unidades.mjs → ops/unidades/<slug>.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIDADES } from './unidades.mjs';

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '..');

const template = JSON.parse(readFileSync(resolve(raiz, 'rastreio-campanhas-nativo.json'), 'utf8'));
const camposPorUnidade = JSON.parse(readFileSync(resolve(aqui, 'campos-por-unidade.json'), 'utf8'));

/** WABA conhecida por unidade. Só a Imperatriz está descoberta — o resto entra quando
 *  o app da Meta daquela unidade for criado (o `entry.id` não vem no nó nativo). */
const WABA = { imperatriz: '1558318502323307', rioverde: '475739905626795', taubate: '1036096599272746' };

const ORDEM_CAMPOS = [
  'campanha', 'conjunto', 'anuncio', 'anuncioId',
  'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm',
  'origemUrl', 'ctwaClid', 'origemTipo', 'primeiroContato', 'headline',
  'plataforma', 'imagemAnuncio', 'ultimoAnuncio', 'cliques',
];

const clonar = (o) => JSON.parse(JSON.stringify(o));

function blocoCampos(ids, slug) {
  const linhas = ORDEM_CAMPOS.map((chave) => {
    const id = ids[chave];
    if (!id) throw new Error(`[${slug}] campo sem id no inventário: ${chave}`);
    return `    ${(chave + ':').padEnd(18)}${id},`;
  });
  return [
    '  // IDs desta unidade, resolvidos pelo inventario (ops/build-inventario.mjs).',
    '  // Literal de proposito: $env e global no n8n e vazaria entre unidades.',
    '  campos: {',
    ...linhas,
    '  },',
  ].join('\n');
}

function gerar(unidade) {
  const ids = camposPorUnidade[unidade.slug];
  if (!ids) throw new Error(`sem inventário para ${unidade.slug}`);

  const wf = clonar(template);
  wf.name = `DD · Rastreio CTWA · ${unidade.nome}`;

  const acharNo = (nome) => {
    const no = wf.nodes.find((n) => n.name === nome);
    if (!no) throw new Error(`[${unidade.slug}] nó não encontrado: ${nome}`);
    return no;
  };

  // 1. Config — subdomínio e ids viram literais.
  const config = acharNo('Config');
  let js = config.parameters.jsCode;

  const alvoSub = /kommoSubdomain: \$env\.KOMMO_SUBDOMAIN \|\| '[^']+',/;
  if (!alvoSub.test(js)) throw new Error(`[${unidade.slug}] âncora do subdomínio não encontrada`);
  js = js.replace(alvoSub, `kommoSubdomain: '${unidade.subdominio}',`);

  const alvoCampos = /  \/\/ IDs dos campos personalizados de LEAD no Kommo\.\n  campos: \{[\s\S]*?\n  \},/;
  if (!alvoCampos.test(js)) throw new Error(`[${unidade.slug}] âncora do bloco de campos não encontrada`);
  js = js.replace(alvoCampos, blocoCampos(ids, unidade.slug));
  config.parameters.jsCode = js;

  // 2. Credencial do Kommo em todos os nós que falam com o CRM.
  let trocadas = 0;
  for (const no of wf.nodes) {
    if (no.credentials?.kommoLongLivedApi) {
      no.credentials.kommoLongLivedApi = unidade.credencial;
      trocadas += 1;
    }
  }
  if (trocadas < 4) throw new Error(`[${unidade.slug}] só ${trocadas} nós Kommo — template mudou?`);

  // 3. Trigger: id próprio (é o verify_token) e webhookId próprio (é a URL do callback).
  //    A credencial fica VAZIA: cada unidade precisa do app da Meta dela, e apontar
  //    duas unidades para o mesmo app faria uma derrubar a inscrição da outra.
  //    A canônica (Imperatriz) já está em produção: mexer no id do nó trocaria o
  //    verify_token, e no webhookId trocaria a URL já registrada na Meta.
  const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.whatsAppTrigger');
  if (!trigger) throw new Error(`[${unidade.slug}] trigger não encontrado`);
  if (!unidade.canonica) {
    trigger.id = `whatsapp-trigger-${unidade.slug}`;
    trigger.webhookId = `meta-ctwa-${unidade.slug}`;
    // Credencial do app da Meta desta unidade, quando ja existir; sem ela o workflow
    // fica parado esperando o operador criar o app (ver README §11.3).
    if (unidade.trigger) trigger.credentials = { whatsAppTriggerApi: unidade.trigger };
    else delete trigger.credentials;
  }

  // 4. Shim: WABA da unidade (ou null — melhor vazio que o id de outra unidade).
  const shim = acharNo('Normalizar formato do Trigger');
  const alvoWaba = /const wabaId = \$env\.META_WABA_ID \|\| '[^']*';/;
  if (!alvoWaba.test(shim.parameters.jsCode)) throw new Error(`[${unidade.slug}] âncora do wabaId não encontrada`);
  const waba = WABA[unidade.slug];
  shim.parameters.jsCode = shim.parameters.jsCode.replace(
    alvoWaba,
    waba
      ? `const wabaId = '${waba}';`
      : `const wabaId = null; // WABA desta unidade ainda nao descoberta (ver README §11)`,
  );

  // 5. Toda escrita no Postgres carimba a unidade.
  let sqlPatchado = 0;
  for (const no of wf.nodes) {
    if (no.type !== 'n8n-nodes-base.postgres') continue;
    const q = no.parameters?.query;
    if (!q) continue;
    const novo = q
      .replace(/INSERT INTO ctwa_logs \(/g, 'INSERT INTO ctwa_logs (unidade, ')
      .replace(/INSERT INTO ctwa_eventos \(/g, 'INSERT INTO ctwa_eventos (unidade, ')
      .replace(/VALUES \(/g, `VALUES ('${unidade.slug}', `);
    if (novo !== q) sqlPatchado += 1;
    no.parameters.query = novo;
  }
  if (sqlPatchado < 5) throw new Error(`[${unidade.slug}] só ${sqlPatchado} INSERTs patchados`);

  // 6. Nota de topo: o que falta para esta unidade sair do papel.
  const nota = wf.nodes.find((n) => n.type === 'n8n-nodes-base.stickyNote' && /## 1\./.test(n.parameters?.content ?? ''));
  if (nota && unidade.canonica) {
    // A canônica já está no ar: a nota dela continua sendo a de operação (§10).
  } else if (nota) {
    nota.parameters.content = `## ${unidade.nome} — PARADO até ter app da Meta

Subdomínio: \`${unidade.subdominio}\` · credencial: \`${unidade.credencial.name}\`
Callback deste workflow (quando ativar):
\`/webhook/meta-ctwa-${unidade.slug}/webhook\`
\`verify_token\` = id do nó = \`whatsapp-trigger-${unidade.slug}\`

**Falta, e sem isso não roda:**
1. app próprio da Meta para esta unidade (um webhook por app — não dá para dividir o app da Imperatriz);
2. credencial \`WhatsApp Trigger · ${unidade.nome}\` (App ID + App Secret) ligada no nó \`On messages\`;
3. ativar aqui — o n8n registra o callback sozinho;
4. \`POST /{WABA_ID}/subscribed_apps\` com token \`whatsapp_business_management\` da unidade.

⛔ **Nunca** clique em "Listen for test event": apaga a inscrição de produção. Ver README §10.`;
    nota.parameters.height = 620;
  }

  wf.active = false;
  return wf;
}

const destino = resolve(aqui, 'unidades');
mkdirSync(destino, { recursive: true });

const alvos = UNIDADES.filter((u) => camposPorUnidade[u.slug] && Object.keys(camposPorUnidade[u.slug]).length === 18);
for (const u of alvos) {
  const wf = gerar(u);
  writeFileSync(resolve(destino, `${u.slug}.json`), `${JSON.stringify(wf, null, 2)}\n`);
  console.log(`ok  ${u.slug.padEnd(12)} ${wf.name}`);
}
const fora = UNIDADES.filter((u) => !alvos.includes(u));
if (fora.length) console.log(`\nfora (inventário incompleto): ${fora.map((u) => u.slug).join(', ')}`);
