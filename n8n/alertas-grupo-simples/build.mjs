// Gera workflow.json a partir de src/*.js. Uso: node build.mjs   (sem dependências)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const ler = (f) => readFileSync(join(aqui, 'src', f), 'utf8');
const comum = ler('comum.js');
const codigo = (f) => ler(f).replace('//__COMUM__', comum);

export const montar = () => ({
  name: 'DD · Alertas grupo (simples)',
  nodes: [
    {
      id: 'a1', name: 'Webhook alerta-grupo', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
      webhookId: 'alerta-grupo-simples',
      parameters: { httpMethod: 'POST', path: 'alerta-grupo', responseMode: 'onReceived', options: {} },
    },
    {
      id: 'a2', name: 'Entrada (classifica e guarda)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [260, 0],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: codigo('entrada.js') },
    },
    {
      id: 'b1', name: 'A cada minuto', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 260],
      parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } },
    },
    {
      id: 'b2', name: 'Despachar (fila, teto, silêncio)', type: 'n8n-nodes-base.code', typeVersion: 2, position: [260, 260],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: codigo('despachar.js') },
    },
    {
      // Só entrega ao webhook interno (que responde na hora) e termina: a execução do gatilho não espera a Evolution.
      id: 'b3', name: 'Entregar ao envio', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [520, 260],
      parameters: {
        method: 'POST',
        url: '={{ $json.urlEnvio }}',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ instancia: $json.instancia, number: $json.number, text: $json.text, delay: $json.delay, linkPreview: $json.linkPreview, mentioned: $json.mentioned }) }}',
        options: { timeout: 10000 },
      },
      retryOnFail: false,
    },
    {
      id: 'c1', name: 'Webhook alerta-grupo-envio', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 520],
      webhookId: 'alerta-grupo-envio-simples',
      parameters: { httpMethod: 'POST', path: 'alerta-grupo-envio', responseMode: 'onReceived', options: {} },
    },
    {
      id: 'c2', name: 'Validar envio', type: 'n8n-nodes-base.code', typeVersion: 2, position: [260, 520],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: ler('validar.js') },
    },
    {
      // Chave da Evolution = CREDENCIAL do n8n (Header Auth), nunca texto no nó. O importar.sh cria e preenche o id.
      id: 'c3', name: 'Evolution sendText', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [520, 520],
      parameters: {
        method: 'POST',
        url: "={{ 'http://evolution_api:8080/message/sendText/' + $json.instancia }}",
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ number: $json.number, text: $json.text, delay: $json.delay, linkPreview: $json.linkPreview, mentioned: $json.mentioned }) }}',
        options: { timeout: 15000 },
      },
      credentials: { httpHeaderAuth: { id: '__CRED_EVOLUTION_ID__', name: 'DD · Evolution (apikey) · alertas grupo' } },
      // sem retry: falha de envio não vira laço (lição do ban de 06/10). A execução com erro fica guardada.
      retryOnFail: false,
    },
  ],
  connections: {
    'Webhook alerta-grupo': { main: [[{ node: 'Entrada (classifica e guarda)', type: 'main', index: 0 }]] },
    'A cada minuto': { main: [[{ node: 'Despachar (fila, teto, silêncio)', type: 'main', index: 0 }]] },
    'Despachar (fila, teto, silêncio)': { main: [[{ node: 'Entregar ao envio', type: 'main', index: 0 }]] },
    'Webhook alerta-grupo-envio': { main: [[{ node: 'Validar envio', type: 'main', index: 0 }]] },
    'Validar envio': { main: [[{ node: 'Evolution sendText', type: 'main', index: 0 }]] },
  },
  settings: {
    executionOrder: 'v1',
    timezone: 'America/Sao_Paulo',
    saveDataSuccessExecution: 'none', // o gatilho roda 1440x/dia: o histórico útil vai no static data (log), erros ficam salvos
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(aqui, 'workflow.json'), JSON.stringify(montar(), null, 2) + '\n');
  console.log('workflow.json gerado');
}
