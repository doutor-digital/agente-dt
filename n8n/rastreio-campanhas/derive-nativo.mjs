#!/usr/bin/env node
/**
 * Deriva a variante "nó nativo" do workflow de rastreio a partir do workflow de
 * PRODUÇÃO exportado (`producao/ZqW9mOjb0td2Flik.json`).
 *
 * Por que derivar em vez de manter dois builders: o workflow de produção recebe
 * correções direto na UI (token de ads, imagem do anúncio, unwrap da resposta do
 * Kommo, contexto do lead). Regerar a variante nativa a partir de um segundo
 * builder faz ela nascer atrasada — foi exatamente o que aconteceu com o fork de
 * 2026-08-11, que ficou 6 correções atrás. Aqui a produção é a fonte da verdade e
 * a única diferença é a cabeça do fluxo.
 *
 * O que muda:
 *   - saem os 10 nós da trilha de webhook manual (GET/POST, HMAC, 401, ACK);
 *   - entram `On messages` (n8n-nodes-base.whatsAppTrigger) e um nó de shim que
 *     reembala a saída do trigger no formato `{ corpo: { entry: [...] } }` que o
 *     resto do fluxo já espera.
 *
 * Uso:
 *   node derive-nativo.mjs                       # usa os caminhos padrão
 *   node derive-nativo.mjs entrada.json saida.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const entrada = resolve(aqui, process.argv[2] ?? 'producao/ZqW9mOjb0td2Flik.json');
const saidaPath = resolve(aqui, process.argv[3] ?? 'rastreio-campanhas-nativo.json');

/** Nós da trilha manual que o nó nativo substitui. */
const REMOVIDOS = [
  'Meta — Verificacao (GET)',
  'Verify token confere?',
  'Responder hub.challenge',
  'Recusar verificacao',
  'Meta — Eventos (POST)',
  'Validar assinatura HMAC',
  'Assinatura valida?',
  'Responder 401',
  'Log — assinatura invalida',
  'Responder 200 (ACK)',
];

/** Nó que o shim precisa alimentar (o primeiro nó do miolo do fluxo). */
const PRIMEIRO_DO_MIOLO = 'Config';

/**
 * Credencial do trigger: App ID + App Secret do app **novo** (client_credentials).
 * O nó usa isso para registrar a inscrição no app e para validar o HMAC.
 */
const CREDENCIAL_TRIGGER = { id: 'YfFu5LlXEzZwsZWv', name: 'WhatsApp Trigger · Rastreio Imperatriz' };

const SHIM = `// O WhatsApp Trigger entrega um item por "change", já desempacotado:
// { ...change.value, field: 'messages' }. O envelope entry[] some — e com ele o
// entry.id, que era o WABA ID. Aqui reembalamos no formato { corpo: { entry: [...] } }
// que o resto do fluxo espera, para reaproveitar todos os nós seguintes sem tocar
// em nenhum deles.
//
// O WABA ID vem de env var, com fallback fixo na WABA da Imperatriz (o valor real
// que o webhook manual vinha gravando em ctwa_eventos.waba_id). Inventar entry.id a
// partir do phone_number_id — como o fork antigo fazia — grava o número errado nessa
// coluna e mente na análise multi-unidade. Outra unidade: defina META_WABA_ID.
const wabaId = $env.META_WABA_ID || '1558318502323307';
const saida = [];

for (const item of $input.all()) {
  const v = item.json || {};

  // Já no formato antigo (reprocesso manual, dado pinado): passa direto.
  if (v.corpo && v.corpo.entry) { saida.push({ json: { corpo: v.corpo } }); continue; }
  if (v.entry) { saida.push({ json: { corpo: v } }); continue; }

  saida.push({ json: {
    recebidoEm: new Date().toISOString(),
    corpo: {
      object: 'whatsapp_business_account',
      entry: [{ id: wabaId, changes: [{ field: v.field || 'messages', value: v }] }],
    },
  }});
}

return saida;
`;

const NOTA_ENTRADA = `## 1. Entrada da Meta — nó nativo

\`WhatsApp Trigger\` faz sozinho o que a trilha manual fazia em 10 nós:

- responde o handshake \`hub.challenge\` (o \`verify_token\` é o **id deste nó**);
- valida o HMAC \`x-hub-signature-256\` com o **App Secret da credencial**;
- responde **200 na hora** (onReceived), antes de qualquer I/O;
- ao **ativar**, registra \`POST /{app_id}/subscriptions\` apontando para a URL deste webhook; ao **desativar**, apaga a inscrição.

**App dedicado, obrigatório.** A Meta aceita **uma inscrição por app** — o n8n falha na ativação se o app já tiver outra. Este workflow usa um app **novo**, separado do app do rastreio antigo, e é isso que permite os dois rodarem em paralelo durante o cutover.

⚠️ **Não clique em "Listen for test event" com o workflow em produção**: o n8n re-registra o callback para a URL de teste e os eventos reais param de chegar até reativar.

Assinar a WABA (\`POST /{WABA_ID}/subscribed_apps\`) continua sendo passo manual — o nó não faz isso.`;

const wf = JSON.parse(readFileSync(entrada, 'utf8'));
const removidos = new Set(REMOVIDOS);

const presentes = new Set(wf.nodes.map((n) => n.name));
const faltando = REMOVIDOS.filter((n) => !presentes.has(n));
if (faltando.length) {
  throw new Error(`Entrada não parece o workflow de webhook manual — não achei: ${faltando.join(', ')}`);
}

// 1. Tira a trilha manual, mantendo o resto intacto (inclusive credenciais e onError).
const nodes = wf.nodes.filter((n) => !removidos.has(n.name));

// 2. Sticky notes 1 e 2 falavam de GET/POST/HMAC/ACK: viram uma nota só.
const notaEntrada = nodes.find(
  (n) => n.type === 'n8n-nodes-base.stickyNote' && /## 1\./.test(n.parameters?.content ?? ''),
);
if (notaEntrada) {
  notaEntrada.parameters.content = NOTA_ENTRADA;
  notaEntrada.parameters.height = 700;
}
const notaAssinatura = nodes.findIndex(
  (n) => n.type === 'n8n-nodes-base.stickyNote' && /## 2\. Assinatura/.test(n.parameters?.content ?? ''),
);
if (notaAssinatura >= 0) nodes.splice(notaAssinatura, 1);

// 3. Cabeça nova.
nodes.unshift(
  {
    parameters: { updates: ['messages'], options: {} },
    id: 'whatsapp-trigger-nativo',
    name: 'On messages',
    type: 'n8n-nodes-base.whatsAppTrigger',
    typeVersion: 1,
    position: [-1120, 64],
    // Fixo de propósito: é ele que forma a URL do callback registrado na Meta
    // (`/webhook/<webhookId>/webhook` — o sufixo é do nó, não dá para tirar). Deixar o
    // n8n sortear um UUID a cada import faz o callback mudar sem ninguém perceber.
    webhookId: 'meta-ctwa-tracking-nativo',
    credentials: { whatsAppTriggerApi: CREDENCIAL_TRIGGER },
  },
  {
    // Aviso no canvas: o erro mora no botão, então o aviso tem de estar ao lado dele.
    parameters: {
      content: `## ⛔ NÃO clique em "Listen for test event"

Esse botão **apaga a inscrição de produção** na Meta e tenta registrar a URL \`/webhook-test/...\`, que **não existe** nesta instância (modo fila → 404 nos dois hosts). A Meta recusa e o app fica **sem webhook nenhum** — rastreio cego.

Sintomas: \`(#2200) Callback verification failed ... 404\` ou
\`The WhatsApp App ID 1108510921356615 already has a webhook subscription\`.

**Conserto:** desativar e ativar o workflow (nessa ordem — só ativar não basta, o n8n acha que já registrou).

**Para testar**, use os \`curl\` do README §10.3 na URL de produção.`,
      height: 380,
      width: 420,
      color: 3,
    },
    id: 'aviso-listen-test',
    name: 'ATENÇÃO — teste',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-1120, -400],
  },
  {
    parameters: { jsCode: SHIM },
    id: 'shim-formato-trigger',
    name: 'Normalizar formato do Trigger',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-688, 64],
  },
);

// 4. Religa: trigger → shim → miolo.
const connections = {};
for (const [origem, valor] of Object.entries(wf.connections)) {
  if (removidos.has(origem)) continue;
  connections[origem] = valor;
}
connections['On messages'] = { main: [[{ node: 'Normalizar formato do Trigger', type: 'main', index: 0 }]] };
connections['Normalizar formato do Trigger'] = {
  main: [[{ node: PRIMEIRO_DO_MIOLO, type: 'main', index: 0 }]],
};

// 5. Sanidade: nenhuma conexão pode apontar para nó que não existe mais, e nenhuma
//    expressão pode referenciar um nó removido ($('Nome')).
const nomes = new Set(nodes.map((n) => n.name));
for (const [origem, valor] of Object.entries(connections)) {
  if (!nomes.has(origem)) throw new Error(`Conexão saindo de nó inexistente: ${origem}`);
  for (const saidaLista of valor.main ?? []) {
    for (const alvo of saidaLista ?? []) {
      if (!nomes.has(alvo.node)) throw new Error(`Conexão ${origem} → ${alvo.node}: alvo não existe`);
    }
  }
}
const serializado = JSON.stringify(nodes);
for (const nome of REMOVIDOS) {
  if (serializado.includes(`$('${nome}')`)) throw new Error(`Ainda há expressão referenciando $('${nome}')`);
}
if (![...nomes].includes(PRIMEIRO_DO_MIOLO)) throw new Error(`Nó ${PRIMEIRO_DO_MIOLO} sumiu`);

const saida = {
  name: 'Meta → Kommo — Rastreio CTWA (nó nativo On messages)',
  nodes,
  connections,
  settings: wf.settings ?? { executionOrder: 'v1' },
  active: false,
};

writeFileSync(saidaPath, `${JSON.stringify(saida, null, 2)}\n`);
console.log(
  `ok: ${saidaPath}\n` +
    `  nós: ${wf.nodes.length} (produção) → ${nodes.length} (nativo)\n` +
    `  removidos: ${REMOVIDOS.length} · adicionados: On messages, Normalizar formato do Trigger`,
);
