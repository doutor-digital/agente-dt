import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listarIntegracoes } from './integracoes.js';
import { contaPlanilhaDaChave } from './planilha.js';
import { contaTramitacaoDaChave } from './tramitacao.js';

const ID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

test('listar_integracoes mostra planilha e Tramitação, e as ferramentas de cada uma', () => {
  const r = listarIntegracoes({
    franquia: new Map(),
    kommo: new Map(),
    bling: new Map(),
    planilha: new Map([['magalhaes', { nome: 'Magalhães' }]]),
    tramitacao: new Map([['magalhaes', { nome: 'Magalhães' }]]),
  });
  assert.equal(r.comPlanilha, 1);
  assert.equal(r.comTramitacao, 1);
  const u = r.unidades[0]!;
  assert.equal(u.planilha, true);
  assert.equal(u.tramitacao, true);
  const f = u.ferramentas.join(' | ');
  assert.match(f, /planilha_\*/);
  assert.match(f, /tramitacao_\*/);
  // quem não tem nenhuma das duas continua igual
  const antes = listarIntegracoes({ franquia: new Map([['serra', { nome: 'Serra' }]]), kommo: new Map(), bling: new Map() });
  assert.equal(antes.comPlanilha, 0);
  assert.equal(antes.unidades[0]!.planilha, false);
});

test('conta de planilha a partir da chave do cofre; JSON de conta de serviço não carrega ainda', () => {
  const c = contaPlanilhaDaChave({ slug: 'magalhaes', nome: 'M', chave: `clientes=${ID}` });
  assert.deepEqual(c.planilhas.map((p) => [p.apelido, p.fonte.modo]), [['clientes', 'publico']]);
  assert.throws(() => contaPlanilhaDaChave({ slug: 'x', nome: 'X', chave: '{"type":"service_account"}' }), /conta de serviço/);
});

test('conta da Tramitação: a chave só vai no cabeçalho de quem chama, e a unidade separa o ritmo', async () => {
  const vistas: unknown[][] = [];
  const conta = contaTramitacaoDaChave({ unitId: 'u1', slug: 'magalhaes', nome: 'M', chave: 'chave-simulada' }, (async (...args: unknown[]) => (vistas.push(args), { ok: true })) as never);
  assert.deepEqual(await conta.fonte.get('/v1/processos', { per_page: 1 }), { ok: true });
  assert.deepEqual(vistas[0], ['u1', 'chave-simulada', '/v1/processos', { per_page: 1 }]);
  assert.equal(JSON.stringify(conta).includes('chave-simulada'), false, 'a chave não aparece se a conta for serializada/logada');
});
