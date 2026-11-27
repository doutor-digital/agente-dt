import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rodarCerebro } from './cerebro.js';
import { criarFerramentas } from './ferramentas.js';
import { repoEmMemoria } from './repo.js';
import { falaFinal, freioDeTeste, modeloRoteirizado, pedidoDeFerramenta } from './teste-util.js';

test('o modelo escolhe as ferramentas, o grafo executa e volta até ele responder', async () => {
  const repo = repoEmMemoria();
  const { freio, chamadas } = freioDeTeste();
  const { modelo, recebidos, sobrou } = modeloRoteirizado([
    pedidoDeFerramenta('listar_demandas', {}),
    pedidoDeFerramenta('criar_demanda', { titulo: 'Sofia parou de responder em Parauapebas', categoria: 'problema_ia', prioridade: 'urgente', unidade_slug: 'doutor-hernia-parauapebas', refs: ['m1'] }),
    falaFinal('Criei #1.'),
  ]);
  const r = await rodarCerebro({ modelo, ferramentas: criarFerramentas({ repo, fonte: 'grupo', refsDoLote: new Map([['m1', 'x:1']]) }), freio, papel: 'triagem' }, 'sistema', 'pedido');
  assert.equal(r.parou, null);
  assert.equal(r.passos, 3);
  assert.equal(r.resposta, 'Criei #1.');
  assert.deepEqual(r.chamadasDeFerramenta.map((c) => c.nome), ['listar_demandas', 'criar_demanda']);
  assert.equal((await repo.listarDemandas()).length, 1);
  assert.equal(sobrou(), 0);
  // o resultado da ferramenta volta ao modelo no passo seguinte
  const ultimaEntrada = recebidos[2]!;
  assert.match(String(ultimaEntrada[ultimaEntrada.length - 1]!.content), /CRIADA #1/);
  // cada ida ao modelo foi registrada com o rótulo do papel
  assert.equal(chamadas.length, 3);
  assert.ok(chamadas.every((c) => c.papel === 'triagem' && c.status === 'success'));
  assert.ok(r.custoUsd > 0);
});

test('orçamento esgotado: o modelo NEM É CHAMADO', async () => {
  const { freio } = freioDeTeste({ gastoUsd: 60 });
  const { modelo, recebidos } = modeloRoteirizado([falaFinal('não deveria')]);
  const r = await rodarCerebro({ modelo, ferramentas: [], freio, papel: 'triagem' }, 's', 'p');
  assert.equal(r.parou, 'orcamento');
  assert.equal(recebidos.length, 0);
});

test('limite de passos: modelo que não para de pedir ferramenta é cortado', async () => {
  const repo = repoEmMemoria();
  const { freio } = freioDeTeste();
  const { modelo } = modeloRoteirizado(Array.from({ length: 20 }, () => pedidoDeFerramenta('listar_demandas', {})));
  const r = await rodarCerebro({ modelo, ferramentas: criarFerramentas({ repo, fonte: 'grupo' }), freio, papel: 'triagem', maxPassos: 3 }, 's', 'p');
  assert.equal(r.parou, 'passos');
  assert.equal(r.passos, 3);
});

test('falha do modelo vira parou=erro, é registrada em llm_calls e não lança', async () => {
  const { freio, chamadas } = freioDeTeste();
  const { modelo } = modeloRoteirizado([new Error('overloaded')]);
  const r = await rodarCerebro({ modelo, ferramentas: [], freio, papel: 'resposta' }, 's', 'p');
  assert.equal(r.parou, 'erro');
  assert.match(r.erro!, /overloaded/);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0]!.status, 'error');
});

test('ferramenta que falha devolve o erro ao modelo em vez de derrubar o grafo', async () => {
  const repo = repoEmMemoria();
  repo.buscarDemanda = async () => {
    throw new Error('banco caiu');
  };
  const { freio } = freioDeTeste();
  const { modelo } = modeloRoteirizado([pedidoDeFerramenta('atualizar_demanda', { numero: 1, status: 'feita' }), falaFinal('Não consegui atualizar agora.')]);
  const r = await rodarCerebro({ modelo, ferramentas: criarFerramentas({ repo, fonte: 'telegram' }), freio, papel: 'resposta' }, 's', 'p');
  assert.equal(r.parou, null);
  assert.equal(r.resposta, 'Não consegui atualizar agora.');
});
