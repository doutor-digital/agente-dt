import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listarIntegracoes } from './integracoes.js';
import { contaTramitacaoDaChave } from './tramitacao.js';

test('listar_integracoes mostra a Tramitação e as ferramentas dela; quem não tem continua igual', () => {
  const r = listarIntegracoes({
    franquia: new Map(),
    kommo: new Map(),
    bling: new Map(),
    tramitacao: new Map([['magalhaes', { nome: 'Magalhães' }]]),
  });
  assert.equal(r.comTramitacao, 1);
  const u = r.unidades[0]!;
  assert.equal(u.tramitacao, true);
  assert.match(u.ferramentas.join(' | '), /tramitacao_\*/);
  const antes = listarIntegracoes({ franquia: new Map([['serra', { nome: 'Serra' }]]), kommo: new Map(), bling: new Map() });
  assert.equal(antes.comTramitacao, 0);
  assert.equal(antes.unidades[0]!.tramitacao, false);
});

test('conta da Tramitação: a chave só vai no cabeçalho de quem chama, e a unidade separa o ritmo', async () => {
  const vistas: unknown[][] = [];
  const conta = contaTramitacaoDaChave({ unitId: 'u1', slug: 'magalhaes', nome: 'M', chave: 'chave-simulada' }, (async (...args: unknown[]) => (vistas.push(args), { ok: true })) as never);
  assert.deepEqual(await conta.fonte.get('/v1/processos', { per_page: 1 }), { ok: true });
  assert.deepEqual(vistas[0], ['u1', 'chave-simulada', '/v1/processos', { per_page: 1 }]);
  assert.equal(JSON.stringify(conta).includes('chave-simulada'), false, 'a chave não aparece se a conta for serializada/logada');
});
