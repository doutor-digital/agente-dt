import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  INTERVALO_DO_AVISO_MS,
  TOLERANCIA_SEGUNDOS,
  assinaturaValida,
  criarTratadorDoWebhook,
  segredosDoWebhook,
  type DependenciasDoWebhook,
} from './pluggy-webhook.js';

// segredo de mentira no formato real: "whsec_" + 64 hex
const SEGREDO = `whsec_${'ab12'.repeat(16)}`;
const ANTERIOR = `whsec_${'cd34'.repeat(16)}`;
const CLIENT_ID = '00000000-1111-2222-3333-444444444444';
const ITEM = 'a5c763cb-0952-457b-9936-630f79c5b016';
const AGORA = 1_795_000_000_000; // ms
const T = Math.floor(AGORA / 1000);

/** Assina como a Pluggy documenta: HMAC-SHA256 em hex de "<t>.<corpo cru>", com o segredo INTEIRO (prefixo whsec_ incluído) como chave. */
const assinar = (corpo: string | Buffer, segredo = SEGREDO, t = T) => `t=${t},v1=${createHmac('sha256', segredo).update(`${t}.`).update(corpo).digest('hex')}`;

const evento = (o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ event: 'item/updated', eventId: 'e1', itemId: ITEM, triggeredBy: 'SYNC', clientId: CLIENT_ID, ...o }));

// ------------------------------------------------------------------ assinatura

test('assinatura: válida com o corpo cru e o segredo inteiro (incluindo o prefixo whsec_)', () => {
  const corpo = evento();
  assert.equal(assinaturaValida(corpo, assinar(corpo), [SEGREDO], AGORA), true);
});

test('assinatura: NÃO é Svix — o segredo não é decodificado de base64 nem o prefixo é tirado', () => {
  const corpo = evento();
  const semPrefixo = SEGREDO.slice('whsec_'.length);
  assert.equal(assinaturaValida(corpo, assinar(corpo, semPrefixo), [SEGREDO], AGORA), false, 'chave sem o prefixo não confere');
  const comoBase64 = Buffer.from(semPrefixo, 'base64').toString('binary');
  assert.equal(assinaturaValida(corpo, assinar(corpo, comoBase64), [SEGREDO], AGORA), false);
  // e o formato Svix (webhook-id/webhook-timestamp/webhook-signature) não vale como X-Pluggy-Signature
  assert.equal(assinaturaValida(corpo, `v1,${Buffer.from('x').toString('base64')}`, [SEGREDO], AGORA), false);
});

test('assinatura inválida: corpo alterado, segredo errado, digest adulterado', () => {
  const corpo = evento();
  const h = assinar(corpo);
  assert.equal(assinaturaValida(evento({ itemId: 'outro' }), h, [SEGREDO], AGORA), false, 'corpo alterado em um byte');
  assert.equal(assinaturaValida(corpo, assinar(corpo, ANTERIOR), [SEGREDO], AGORA), false, 'segredo errado');
  assert.equal(assinaturaValida(corpo, h.replace(/.$/, (c) => (c === '0' ? '1' : '0')), [SEGREDO], AGORA), false, 'um dígito trocado');
  assert.equal(assinaturaValida(corpo, h.replace(`t=${T}`, `t=${T + 1}`), [SEGREDO], AGORA), false, 't alterado invalida o digest');
});

test('assinatura com timestamp velho (ou do futuro) é recusada; a borda de 5 min vale', () => {
  const corpo = evento();
  assert.equal(assinaturaValida(corpo, assinar(corpo, SEGREDO, T - TOLERANCIA_SEGUNDOS - 1), [SEGREDO], AGORA), false, 'mais de 5 min atrás');
  assert.equal(assinaturaValida(corpo, assinar(corpo, SEGREDO, T + TOLERANCIA_SEGUNDOS + 1), [SEGREDO], AGORA), false, 'do futuro');
  assert.equal(assinaturaValida(corpo, assinar(corpo, SEGREDO, T - TOLERANCIA_SEGUNDOS), [SEGREDO], AGORA), true);
  assert.equal(assinaturaValida(corpo, assinar(corpo, SEGREDO, T - 60), [SEGREDO], AGORA), true);
});

test('cabeçalho ausente, vazio ou malformado é recusado', () => {
  const corpo = evento();
  const bom = assinar(corpo);
  const digest = bom.split('v1=')[1]!;
  for (const h of [undefined, '', 't=', `t=${T}`, `v1=${digest}`, `t=abc,v1=${digest}`, `t=${T},v1=${digest.slice(0, 63)}`, `t=${T},v1=${digest.toUpperCase()}`, `t=${T},v1=zz`, `t=${'9'.repeat(13)},v1=${digest}`, 'lixo', ',,,']) {
    assert.equal(assinaturaValida(corpo, h, [SEGREDO], AGORA), false, String(h));
  }
  assert.equal(assinaturaValida(corpo, bom, [], AGORA), false, 'sem segredo configurado nada vale');
  assert.equal(assinaturaValida(corpo, bom, [''], AGORA), false);
});

test('assinatura: aceita o segredo anterior na troca (lista) e vários v1 no cabeçalho', () => {
  const corpo = evento();
  assert.equal(assinaturaValida(corpo, assinar(corpo, ANTERIOR), [SEGREDO, ANTERIOR], AGORA), true);
  const novo = assinar(corpo).split('v1=')[1]!;
  assert.equal(assinaturaValida(corpo, `t=${T},v1=${'0'.repeat(64)},v1=${novo}`, [SEGREDO], AGORA), true);
});

test('segredosDoWebhook lê o atual e o anterior e ignora vazio', () => {
  assert.deepEqual(segredosDoWebhook({}), []);
  assert.deepEqual(segredosDoWebhook({ PLUGGY_WEBHOOK_SECRET: ` ${SEGREDO} `, PLUGGY_WEBHOOK_SECRET_PREVIOUS: '' }), [SEGREDO]);
  assert.deepEqual(segredosDoWebhook({ PLUGGY_WEBHOOK_SECRET: SEGREDO, PLUGGY_WEBHOOK_SECRET_PREVIOUS: ANTERIOR }), [SEGREDO, ANTERIOR]);
});

// ------------------------------------------------------------------ tratamento do evento

function montar(over: Partial<DependenciasDoWebhook> & { env?: NodeJS.ProcessEnv } = {}) {
  const registro = { invalidados: [] as string[], avisos: [] as string[], logs: [] as string[] };
  let agora = AGORA;
  const deps: DependenciasDoWebhook = {
    ambiente: () => over.env ?? { PLUGGY_WEBHOOK_SECRET: SEGREDO, PLUGGY_CLIENT_ID: CLIENT_ID },
    agora: () => agora,
    invalidarItem: (id) => void registro.invalidados.push(id),
    avisar: async (t) => (registro.avisos.push(t), true),
    log: { info: (o, m) => void registro.logs.push(JSON.stringify([o, m])), warn: (o, m) => void registro.logs.push(JSON.stringify([o, m])) },
    itensConhecidos: () => new Map([[ITEM, { apelido: 'Nubank_PJ' }]]),
    ...over,
  };
  return { tratar: criarTratadorDoWebhook(deps), registro, passar: (ms: number) => (agora += ms), tempo: () => agora };
}

const enviar = async (m: ReturnType<typeof montar>, corpo: Buffer, cabecalho?: string) => {
  const r = m.tratar(corpo, cabecalho);
  await r.depois?.();
  return r;
};

test('webhook: sem PLUGGY_WEBHOOK_SECRET a rota é 404 e nada acontece', async () => {
  const m = montar({ env: {} });
  const corpo = evento();
  const r = await enviar(m, corpo, assinar(corpo));
  assert.equal(r.status, 404);
  assert.deepEqual(m.registro.invalidados, []);
});

test('webhook: sem assinatura, com assinatura inválida, velha ou sem cabeçalho = 401 e NADA é tocado', async () => {
  const m = montar();
  const corpo = evento({ event: 'item/error', error: { code: 'USER_AUTHORIZATION_EXPIRED' } });
  assert.equal((await enviar(m, corpo, undefined)).status, 401);
  assert.equal((await enviar(m, corpo, assinar(corpo, ANTERIOR))).status, 401);
  assert.equal((await enviar(m, corpo, assinar(corpo, SEGREDO, T - 600))).status, 401);
  assert.equal((await enviar(m, Buffer.from('{}'), assinar(corpo))).status, 401, 'assinatura de outro corpo');
  assert.deepEqual(m.registro.invalidados, []);
  assert.deepEqual(m.registro.avisos, []);
});

test('webhook: item/updated com assinatura válida invalida o cache e loga só o id mascarado', async () => {
  const m = montar();
  const corpo = evento();
  const r = await enviar(m, corpo, assinar(corpo));
  assert.equal(r.status, 200);
  assert.deepEqual(m.registro.invalidados, [ITEM]);
  assert.deepEqual(m.registro.avisos, [], 'item/updated não alerta');
  const log = m.registro.logs.join('\n');
  assert.match(log, /…c5b016/);
  assert.equal(log.includes(ITEM), false, 'o id inteiro não vai para o log');
  assert.equal(log.includes(SEGREDO), false);
});

test('webhook: item/error invalida e manda UM aviso ao João, com rate limit por item', async () => {
  const m = montar();
  const corpo = evento({ event: 'item/error', eventId: 'e-erro-1', error: { code: 'USER_AUTHORIZATION_EXPIRED', message: 'texto livre do banco com CPF 123.456.789-09' } });
  await enviar(m, corpo, assinar(corpo));
  assert.equal(m.registro.avisos.length, 1);
  assert.match(m.registro.avisos[0]!, /Nubank_PJ \(…c5b016\)/);
  assert.match(m.registro.avisos[0]!, /USER_AUTHORIZATION_EXPIRED/);
  assert.equal(m.registro.avisos[0]!.includes('CPF'), false, 'texto livre do corpo não vai para o Telegram');
  assert.equal(m.registro.avisos[0]!.includes(ITEM), false);
  // outro evento do mesmo item dentro de 6 h: invalida de novo, mas não repete o aviso
  const outro = evento({ event: 'item/error', eventId: 'e-erro-2' });
  await enviar(m, outro, assinar(outro));
  assert.equal(m.registro.avisos.length, 1);
  assert.equal(m.registro.invalidados.length, 2);
  m.passar(INTERVALO_DO_AVISO_MS + 1000);
  const depois = evento({ event: 'item/error', eventId: 'e-erro-3' });
  await enviar(m, depois, assinar(depois, SEGREDO, Math.floor(m.tempo() / 1000)));
  assert.equal(m.registro.avisos.length, 2, 'passadas 6 h o aviso volta');
});

test('webhook: o mesmo eventId repetido é um no-op que ainda responde 2xx (a Pluggy reenvia)', async () => {
  const m = montar();
  const corpo = evento({ event: 'item/error', eventId: 'repetido' });
  assert.equal((await enviar(m, corpo, assinar(corpo))).status, 200);
  assert.equal((await enviar(m, corpo, assinar(corpo))).status, 200);
  assert.equal(m.registro.invalidados.length, 1);
  assert.equal(m.registro.avisos.length, 1);
});

test('webhook: clientId de OUTRA aplicação, item desconhecido e evento que não tratamos = 2xx sem efeito', async () => {
  const m = montar();
  const outro = evento({ clientId: 'outra-aplicacao', eventId: 'x1' });
  assert.equal((await enviar(m, outro, assinar(outro))).status, 200);
  const desconhecido = evento({ itemId: 'd161a74a-8bc8-4093-88de-724312969b0d', eventId: 'x2' });
  assert.equal((await enviar(m, desconhecido, assinar(desconhecido))).status, 200);
  const deletado = evento({ event: 'item/deleted', eventId: 'x3' });
  assert.equal((await enviar(m, deletado, assinar(deletado))).status, 200);
  const semItem = Buffer.from(JSON.stringify({ event: 'item/updated', eventId: 'x4' }));
  assert.equal((await enviar(m, semItem, assinar(semItem))).status, 200);
  assert.deepEqual(m.registro.invalidados, []);
  assert.deepEqual(m.registro.avisos, []);
});

test('webhook: corpo que não é JSON, mesmo assinado, é 400 e não toca em nada', async () => {
  const m = montar();
  const lixo = Buffer.from('isto não é json');
  assert.equal((await enviar(m, lixo, assinar(lixo))).status, 400);
  const lista = Buffer.from('[1,2]');
  assert.equal((await enviar(m, lista, assinar(lista))).status, 400);
  assert.deepEqual(m.registro.invalidados, []);
});

test('webhook: a resposta sai ANTES do tratamento (o que demora roda em `depois`)', async () => {
  let avisou = false;
  const m = montar({ avisar: async () => ((avisou = true), true) });
  const corpo = evento({ event: 'item/error', eventId: 'rapido' });
  const r = m.tratar(corpo, assinar(corpo));
  assert.equal(r.status, 200);
  assert.equal(avisou, false, 'o Telegram só é chamado em depois()');
  assert.equal(typeof r.depois, 'function');
  await r.depois!();
  assert.equal(avisou, true);
});
