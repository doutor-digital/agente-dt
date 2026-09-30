#!/usr/bin/env node
/**
 * Gera o JSON importável do workflow n8n  "DD · Relatório da rede (18h)".
 *
 * Por que um gerador e não o JSON na mão: é a convenção do repositório (veja
 * rastreio-campanhas/build-workflow.mjs). O código dos nós Code fica em template literal, legível,
 * e o JSON.stringify faz o escape.
 *
 * O workflow é FINO de propósito. Toda a conta (franquia + Kommo, por unidade) e o texto são feitos
 * pelo backend em  GET /api/relatorios/rede-diaria. O n8n só: dispara às 18h, pede o texto, escolhe o
 * destino e manda pelo WhatsApp. Nenhum token de unidade passa pelo n8n.
 *
 * NASCE DESLIGADO (active:false) e em modo "teste": o texto vai só para o número do João, com a
 * etiqueta TESTE. Para a chefe receber, troque `modo` para "producao" no nó Config E ative o workflow.
 *
 * Uso:  node build-workflow.mjs        Saída: relatorio-rede-18h.json
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

/* ───────────── nós Code ───────────── */

const CODE_MONTAR_ENVIO = `
// Escolhe o destino e prepara a(s) mensagem(ns). NÃO envia nada: o envio é o nó seguinte.
const cfg = $('Config').first().json;
const r = $input.first().json;

if (!r || typeof r.texto !== 'string' || !r.texto.trim()) {
  throw new Error('O backend respondeu sem texto. Resposta: ' + JSON.stringify(r).slice(0, 300));
}

const producao = cfg.modo === 'producao';
const destino = producao ? cfg.destinoChefe : cfg.destinoTeste;

// Trava: em produção, recusa mandar se o destino da chefe ainda é o marcador.
if (!destino || /PREENCHER/i.test(String(destino))) {
  throw new Error('Destino vazio ou ainda como marcador (' + (producao ? 'destinoChefe' : 'destinoTeste') + '). Preencha no nó Config.');
}

// Uma mensagem de WhatsApp por item: [placar do dia, análise dos 7 dias]. Backend antigo sem
// \`mensagens\` cai no \`texto\` inteiro.
const msgs = Array.isArray(r.mensagens) && r.mensagens.length ? r.mensagens : [r.texto];
const saida = msgs.map((m, i) => ({ json: {
  numero: String(destino),
  texto: (producao || i > 0 ? '' : '🧪 *TESTE* — este texto iria para a chefe. Nada foi enviado a ela.\\n\\n') + m,
  tipo: i === 0 ? 'relatorio' : 'analise',
}}));

// Saiu incompleto (alguma fonte falhou)? O texto já traz o bloco ATENÇÃO para a chefe; o João
// recebe à parte o detalhe, para consertar antes da próxima vez.
const s = r.saude || {};
if (s.completo === false) {
  const falhas = [];
  // o João recebe o erro técnico (detalhes); a chefe só vê a versão em palavras de gente
  for (const u of (r.unidades || [])) for (const f of (u.detalhes && u.detalhes.length ? u.detalhes : (u.falhas || []))) falhas.push('• ' + u.nome + ': ' + f);
  saida.push({ json: {
    numero: String(cfg.destinoAlerta),
    texto: '⚠️ *Relatório das 18h saiu INCOMPLETO* (' + s.falhas + ' falha(s) em ' + s.unidades + ' unidades)\\n\\n' + falhas.join('\\n').slice(0, 1500),
    tipo: 'aviso-incompleto',
  }});
}
return saida;
`;

const CODE_AVISO_FALHA = `
// A chamada ao backend falhou (rede, 401, 500, timeout). A chefe NÃO recebe nada; o João é avisado.
const cfg = $('Config').first().json;
const e = $input.first().json;
const detalhe = (e.error && (e.error.message || e.error.description)) || e.message || JSON.stringify(e).slice(0, 300);
return [{ json: {
  numero: String(cfg.destinoAlerta),
  texto: '❌ *Relatório das 18h FALHOU* e não foi enviado à chefe.\\n\\nMotivo: ' + String(detalhe).slice(0, 400) +
         '\\n\\nRode de novo pelo nó "Rodar agora (teste)" depois de conferir o backend.',
  tipo: 'aviso-falha',
}}];
`;

/* ───────────── montagem ───────────── */

const nos = [];
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const add = (n) => { nos.push(n); return n; };

add({
  parameters: { content: [
    '## DD · Relatório da rede (18h)',
    '**NASCE DESLIGADO e em modo TESTE.** O texto vai só para o número do João.',
    'Para a chefe receber: nó *Config* → `modo` = `producao` e `destinoChefe` preenchido; depois ative o workflow.',
    'Credenciais a criar no n8n: ver README.md (2 do tipo Header Auth).',
  ].join('\n\n'), height: 240, width: 460 },
  id: 'nota', name: 'Leia antes de ativar', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-300, -200],
});

add({
  parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 18 * * 1-6' }] } },
  id: slug('Seg a sab as 18h'), name: 'Seg a sáb às 18h', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-300, 100],
});

add({
  parameters: {},
  id: slug('Rodar agora'), name: 'Rodar agora (teste)', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [-300, 300],
});

const campo = (name, value) => ({ id: slug(name), name, value, type: 'string' });
add({
  parameters: { assignments: { assignments: [
    campo('modo', 'teste'),
    campo('backendUrl', 'https://agente-vps.doutordigitalconsultoria.com'),
    campo('destinoTeste', '5563991021043'),
    campo('destinoChefe', '<<PREENCHER: número com 55+DDD, ou JID do grupo terminado em @g.us>>'),
    campo('destinoAlerta', '5563991021043'),
    campo('instanciaEvolution', 'alertas2'),
    campo('porUnidade', 'sim'),   // 'sim' = uma mensagem por unidade; 'nao' = placar da rede + análise
  ]}, options: {} },
  id: 'config', name: 'Config', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [-40, 200],
});

add({
  parameters: {
    method: 'GET',
    url: "={{ $('Config').first().json.backendUrl }}/api/relatorios/rede-diaria{{ $('Config').first().json.porUnidade === 'sim' ? '?porUnidade=1' : '' }}",
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    options: { timeout: 900000 },   // 15 min: pior caso = 120 s × 14 unidades ÷ 2
  },
  credentials: { httpHeaderAuth: { id: 'PREENCHER', name: 'Agente · chave de serviço (x-internal-key)' } },
  onError: 'continueErrorOutput',
  id: 'gerar', name: 'Gerar relatório', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 200],
});

add({
  parameters: { jsCode: CODE_MONTAR_ENVIO },
  id: 'montar-envio', name: 'Montar envio', type: 'n8n-nodes-base.code', typeVersion: 2, position: [480, 120],
});

add({
  parameters: { jsCode: CODE_AVISO_FALHA },
  id: 'aviso-falha', name: 'Montar aviso de falha', type: 'n8n-nodes-base.code', typeVersion: 2, position: [480, 320],
});

add({
  parameters: {
    method: 'POST',
    url: "=http://evolution_api:8080/message/sendText/{{ $('Config').first().json.instanciaEvolution }}",
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ number: $json.numero, text: $json.texto, linkPreview: false }) }}',
    // um envio por vez, espaçado: o relatório e o aviso ao João não saem em rajada
    options: { batching: { batch: { batchSize: 1, batchInterval: 1500 } } },
  },
  credentials: { httpHeaderAuth: { id: 'PREENCHER', name: 'Evolution · alertas2 (apikey)' } },
  // Evolution oscila: 3 tentativas, 10 s entre elas. Se as 3 falharem a execução fica vermelha no n8n
  // (não há outro canal para avisar — o aviso ao João também sai pela Evolution).
  retryOnFail: true, maxTries: 3, waitBetweenTries: 10000,
  id: 'enviar', name: 'Enviar WhatsApp', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [760, 220],
});

const liga = (de, para, saida = 0) => ({ de, para, saida });
const ligacoes = [
  liga('Seg a sáb às 18h', 'Config'),
  liga('Rodar agora (teste)', 'Config'),
  liga('Config', 'Gerar relatório'),
  liga('Gerar relatório', 'Montar envio', 0),          // sucesso
  liga('Gerar relatório', 'Montar aviso de falha', 1), // erro
  liga('Montar envio', 'Enviar WhatsApp'),
  liga('Montar aviso de falha', 'Enviar WhatsApp'),
];
const connections = {};
for (const { de, para, saida } of ligacoes) {
  connections[de] ??= { main: [] };
  connections[de].main[saida] ??= [];
  connections[de].main[saida].push({ node: para, type: 'main', index: 0 });
}

const workflow = {
  name: 'DD · Relatório da rede (18h)',
  nodes: nos,
  connections,
  active: false,
  settings: { executionOrder: 'v1', timezone: 'America/Sao_Paulo' },
  pinData: {},
  meta: { gerado: 'node n8n/relatorio-rede/build-workflow.mjs' },
};

// Integridade: toda ligação aponta para um nó que existe. Um nome trocado aqui só apareceria
// dentro do n8n, como nó solto — e o relatório simplesmente não sairia.
const nomes = new Set(nos.map((n) => n.name));
for (const { de, para } of ligacoes) {
  if (!nomes.has(de) || !nomes.has(para)) throw new Error(`ligação quebrada: ${de} → ${para}`);
}

const saida = join(AQUI, 'relatorio-rede-18h.json');
writeFileSync(saida, JSON.stringify(workflow, null, 2) + '\n');
console.log(`ok · ${nos.length} nós · ${ligacoes.length} ligações · active=${workflow.active} · ${saida}`);
