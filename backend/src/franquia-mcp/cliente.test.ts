import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ClienteSpine, ehLeitura, ErroSpine } from './cliente.js';
import type { Unidade } from './unidade.js';
import { Contador, Orcamento, OrcamentoEsgotado, Ritmo } from './ritmo.js';
import { type FranquiaFalsa, subirFranquiaFalsa } from './franquia-falsa.js';

const TOKEN = 'token-da-serra-0123456789abcdef';
let falsa: FranquiaFalsa;
let logs: string[];

before(async () => {
  falsa = await subirFranquiaFalsa({ [TOKEN]: { pacientes: [{ idClient: 1, name: 'Ana Souza' }] } });
});
after(() => falsa.fechar());
beforeEach(() => {
  falsa.pedidos.length = 0;
  falsa.falhas.length = 0;
  falsa.atrasoMs = 0;
  falsa.corpoTravadoMs = 0;
  logs = [];
});

function cliente(token = TOKEN, extra: Partial<ConstructorParameters<typeof ClienteSpine>[1]> = {}) {
  const unidade: Unidade = { slug: 'serra', nome: 'Serra', token, fuso: 'America/Sao_Paulo', baseUrl: falsa.url };
  const contador = new Contador();
  const c = new ClienteSpine(unidade, {
    ritmo: new Ritmo(0),
    contador,
    esperaBaseMs: 1,
    log: (l) => logs.push(l),
    ...extra,
  });
  return { c, contador };
}

test('manda o token no Authorization e devolve o JSON', async () => {
  const { c } = cliente();
  const r = (await c.chamar('POST', '/api/clients/search', { pagination: { page: 1, rowsPerPage: 1 } })) as { data: { total: number } };
  assert.equal(r.data.total, 1);
  assert.equal(falsa.pedidos[0]?.token, TOKEN);
});

test('401 não repete e a mensagem não traz o token', async () => {
  const { c } = cliente('token-errado-0123456789abcdef');
  await assert.rejects(c.chamar('POST', '/api/clients/search', {}), (e: ErroSpine) => {
    assert.equal(e.status, 401);
    assert.match(e.message, /token inválido/);
    assert.ok(!e.message.includes('token-errado'));
    return true;
  });
  assert.equal(falsa.pedidos.length, 1);
});

test('400 traz a lista de erros da franquia e não repete', async () => {
  const { c } = cliente();
  await assert.rejects(c.chamar('POST', '/api/clients/search', { pagination: { page: 1, rowsPerPage: 500 } }), /rowsPerPage máximo 100/);
  assert.equal(falsa.pedidos.length, 1);
});

test('5xx repete com espera crescente e conta cada tentativa', async () => {
  const esperas: number[] = [];
  const { c, contador } = cliente(TOKEN, {
    esperaBaseMs: 100,
    dormir: async (ms) => {
      esperas.push(ms);
    },
  });
  falsa.falhas.push(500, 503);
  await c.chamar('POST', '/api/clients/search', {});
  assert.equal(falsa.pedidos.length, 3);
  assert.deepEqual(esperas, [100, 200]);
  assert.deepEqual(contador.resumo().porUnidade.serra?.['POST /api/clients/search'], { chamadas: 3, erros: 2 });
});

test('5xx em todas as tentativas: desiste e diz quantas fez', async () => {
  const { c } = cliente();
  falsa.falhas.push(500, 500, 500);
  await assert.rejects(c.chamar('POST', '/api/clients/search', {}), /desisti depois de 3 tentativas/);
});

test('timeout vira erro transitório com mensagem clara', async () => {
  const { c } = cliente(TOKEN, { timeoutMs: 30, tentativas: 1 });
  falsa.atrasoMs = 200;
  await assert.rejects(c.chamar('POST', '/api/clients/search', {}), /sem resposta em 0 s|sem resposta/);
  assert.ok(logs.some((l) => l.includes('timeout')));
});

test('429 NÃO repete: é a franquia pedindo pra parar', async () => {
  const { c } = cliente();
  falsa.falhas.push(429);
  await assert.rejects(c.chamar('POST', '/api/clients/search', {}), /429.*diminuir o ritmo/);
  assert.equal(falsa.pedidos.length, 1);
});

test('corpo que trava no meio conta como timeout: repete e registra erro', async () => {
  const { c, contador } = cliente(TOKEN, { timeoutMs: 40, tentativas: 2 });
  falsa.corpoTravadoMs = 200;
  await assert.rejects(c.chamar('POST', '/api/clients/search', {}), /resposta incompleta.*desisti depois de 2/);
  assert.equal(falsa.pedidos.length, 2);
  assert.deepEqual(contador.resumo().porUnidade.serra?.['POST /api/clients/search'], { chamadas: 2, erros: 2 });
});

test('retentativa também gasta orçamento', async () => {
  const { c } = cliente();
  falsa.falhas.push(500, 500);
  await assert.rejects(c.chamar('POST', '/api/clients/search', {}, new Orcamento(2)), OrcamentoEsgotado);
  assert.equal(falsa.pedidos.length, 2);
});

test('SÓ LEITURA: escrita é recusada sem abrir conexão', async () => {
  const { c } = cliente();
  for (const [metodo, caminho] of [
    ['POST', '/api/clients'],
    ['POST', '/api/clients/batch-insert'],
    ['POST', '/api/leads/convert'],
    ['POST', '/api/schedules'],
    ['POST', '/api/treatments'],
    ['POST', '/api/finance/accounts-payable'],
    ['GET', '/api/finance/accounts-payable'],
    ['POST', '/api/clients/search/../../clients'],
  ] as const) {
    await assert.rejects(c.chamar(metodo, caminho, {}), /não é uma leitura permitida/, `${metodo} ${caminho}`);
  }
  assert.equal(falsa.pedidos.length, 0);
});

test('ehLeitura: as leituras do guia passam', () => {
  assert.ok(ehLeitura('GET', '/api/clients/123'));
  assert.ok(ehLeitura('GET', '/api/general/treatments/status'));
  assert.ok(ehLeitura('POST', '/api/schedules/search'));
  assert.ok(ehLeitura('POST', '/api/bi/leads/sources'));
  assert.ok(!ehLeitura('PATCH', '/api/schedules/confirm'));
  assert.ok(!ehLeitura('DELETE', '/api/schedules'));
});

test('log vai pro stderr com status e latência, sem token', async () => {
  const { c } = cliente();
  await c.chamar('POST', '/api/clients/search', {});
  assert.match(logs[0] ?? '', /^\[spine\] serra POST \/api\/clients\/search 200 \d+ms id=/);
  assert.ok(!logs.join('').includes(TOKEN));
});
