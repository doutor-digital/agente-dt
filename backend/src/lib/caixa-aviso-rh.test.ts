import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armazemEmMemoria } from '../mcp-remoto/infinitepay-falso.js';
import { assinaturaParaORh, configAvisoRhDoAmbiente, ouvinteDoCaixa } from './caixa-aviso-rh.js';
import { aoLinkPago, emitirLinkPago, type LinkPago } from './link-pago.js';

const UNI = 'doutor-hernia-acailandia';
const SEGREDO = 's'.repeat(40);
const URL_RH = 'https://rh.exemplo.com/functions/v1/caixa-link?aviso=1';
const AGORA = 1_795_000_000_000;

const PAGO: LinkPago = { unidade: UNI, orderNsu: 'dd-1', valorCentavos: 15000, descricao: 'Consulta', forma: 'credit_card', parcelas: 3, valorPagoCentavos: 15150, transactionNsu: 'tx-1', pagoEm: new Date('2026-11-26T15:00:00Z') };

function montar(op: { origemRef?: string | null; resp?: Array<number | 'cai'> } = {}) {
  const armazem = armazemEmMemoria([{ orderNsu: 'dd-1', unidade: UNI, valorCentavos: 15000, ...(op.origemRef === null ? {} : { origemRef: op.origemRef ?? 'cx-aaaa1111' }) }]);
  const chamadas: Array<{ url: string; init: RequestInit }> = [];
  const respostas = [...(op.resp ?? [200])];
  const avisos: string[] = [];
  const dormiu: number[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    chamadas.push({ url, init });
    const r = respostas.length > 1 ? respostas.shift()! : respostas[0]!;
    if (r === 'cai') throw new TypeError('fetch failed');
    return new Response('{}', { status: r });
  }) as unknown as typeof fetch;
  const ouvinte = ouvinteDoCaixa({
    config: { url: URL_RH, segredo: SEGREDO }, armazem, alertar: async (t) => (avisos.push(t), true),
    fetchFn, agora: () => AGORA, esperas: [0, 2000, 10000, 60000], dorme: async (ms) => void dormiu.push(ms), esperar: true,
  });
  return { ouvinte, chamadas, avisos, dormiu };
}

test('config: sem URL, sem segredo ou com segredo curto não há aviso (null); URL que não é http(s) também não', () => {
  assert.equal(configAvisoRhDoAmbiente({}), null);
  assert.equal(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: URL_RH }), null);
  assert.equal(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: URL_RH, CAIXA_RH_WEBHOOK_SEGREDO: 'curto' }), null);
  assert.equal(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: 'ftp://x', CAIXA_RH_WEBHOOK_SEGREDO: SEGREDO }), null);
  // http só para dentro da máquina ou da rede do Docker; para a internet, https
  assert.equal(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: 'http://rh.exemplo.com/x', CAIXA_RH_WEBHOOK_SEGREDO: SEGREDO }), null);
  assert.ok(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: 'http://sistemasrh_api:8080/functions/v1/caixa-link?aviso=1', CAIXA_RH_WEBHOOK_SEGREDO: SEGREDO }));
  assert.ok(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: 'http://127.0.0.1:9/x', CAIXA_RH_WEBHOOK_SEGREDO: SEGREDO }));
  assert.equal(configAvisoRhDoAmbiente({ CAIXA_RH_WEBHOOK_URL: URL_RH, CAIXA_RH_WEBHOOK_SEGREDO: SEGREDO })?.segredo, SEGREDO);
});

test('link do Caixa pago: um POST assinado, SEM dado pessoal, com a origem_ref', async () => {
  const m = montar();
  await m.ouvinte(PAGO);
  assert.equal(m.chamadas.length, 1);
  const { url, init } = m.chamadas[0]!;
  assert.equal(url, URL_RH);
  const h = init.headers as Record<string, string>;
  const corpo = String(init.body);
  assert.equal(h['x-dd-timestamp'], String(Math.floor(AGORA / 1000)));
  assert.equal(h['x-dd-assinatura'], assinaturaParaORh(SEGREDO, h['x-dd-timestamp']!, corpo));
  assert.notEqual(h['x-dd-assinatura'], assinaturaParaORh('x'.repeat(40), h['x-dd-timestamp']!, corpo), 'outro segredo, outra assinatura');
  assert.deepEqual(Object.keys(JSON.parse(corpo)).sort(), ['evento', 'forma', 'order_nsu', 'origem_ref', 'pago_em', 'parcelas', 'transaction_nsu', 'unidade', 'valor_centavos', 'valor_pago_centavos']);
  assert.equal(JSON.parse(corpo).origem_ref, 'cx-aaaa1111');
  assert.equal(JSON.parse(corpo).descricao, undefined, 'a descrição não sai');
});

test('link que NÃO é do Caixa (conector, Sofia): nada sai; link do Caixa SEM recibo (nome e CPF de quem pagou) nem dado pessoal no corpo', async () => {
  const semOrigem = montar({ origemRef: null });
  await semOrigem.ouvinte(PAGO);
  const deOutro = montar({ origemRef: 'sinal-1' });
  await deOutro.ouvinte(PAGO);
  for (const m of [semOrigem, deOutro]) assert.equal(m.chamadas.length, 0);
  const caixa = montar();
  await caixa.ouvinte({ ...PAGO, reciboUrl: 'https://recibo.exemplo.com/1' } as never);
  const corpo = String(caixa.chamadas[0]!.init.body);
  assert.equal(/recibo|receipt/i.test(corpo), false, 'o recibo nunca sai');
  assert.equal(/Consulta/.test(corpo), false, 'nem a descrição');
});

test('tirar a unidade de CAIXA_LINK_UNIDADES NÃO para o aviso: o ouvinte não olha a lista (ela fecha só a criação)', async () => {
  // a assinatura do ouvinte nem recebe a lista de unidades: um link `cx-` já enviado é sempre avisado
  const m = montar();
  await m.ouvinte(PAGO);
  assert.equal(m.chamadas.length, 1);
});

test('o RH fora do ar: repete com esperas crescentes e avisa o João no fim; 4xx de configuração não repete', async () => {
  const fora = montar({ resp: [503, 'cai', 502, 503] });
  await fora.ouvinte(PAGO);
  assert.equal(fora.chamadas.length, 4);
  assert.deepEqual(fora.dormiu, [2000, 10000, 60000]);
  assert.equal(fora.avisos.length, 1);
  assert.match(fora.avisos[0]!, /foi PAGO, mas não consegui avisar o RH/);
  const config = montar({ resp: [401] });
  await config.ouvinte(PAGO);
  assert.equal(config.chamadas.length, 1);
  assert.equal(config.avisos.length, 1);
  const volta = montar({ resp: [503, 200] });
  await volta.ouvinte(PAGO);
  assert.equal(volta.chamadas.length, 2);
  assert.equal(volta.avisos.length, 0);
});

test('em produção o ouvinte NÃO espera o RH: o evento segue para os outros ouvintes mesmo com o RH fora do ar', async () => {
  const armazem = armazemEmMemoria([{ orderNsu: 'dd-1', unidade: UNI, valorCentavos: 15000, origemRef: 'cx-aaaa1111' }]);
  let solta: (() => void) | undefined;
  const fetchFn = (() => new Promise<Response>((r) => (solta = () => r(new Response('{}', { status: 200 }))))) as unknown as typeof fetch;
  const ouvinte = ouvinteDoCaixa({ config: { url: URL_RH, segredo: SEGREDO }, armazem, alertar: async () => true, fetchFn });
  await ouvinte(PAGO); // volta sem esperar a resposta do RH
  assert.ok(solta, 'o envio começou');
  solta!();
});

test('encaixa no evento de link pago: quem escuta é chamado e o erro dele não derruba os outros', async () => {
  const m = montar();
  const para = aoLinkPago(m.ouvinte);
  const outro: string[] = [];
  const para2 = aoLinkPago(() => void outro.push('ok'));
  await emitirLinkPago(PAGO);
  para();
  para2();
  assert.equal(m.chamadas.length, 1);
  assert.deepEqual(outro, ['ok']);
});
