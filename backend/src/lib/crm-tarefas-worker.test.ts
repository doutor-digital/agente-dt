/**
 * As travas «uma vez só» do worker das tarefas moram nas CONDIÇÕES do banco (`updateMany` com o estado esperado): este teste confere o que o armazém de verdade
 * pergunta ao Prisma — é o que impede duas réplicas de mandarem a mesma mensagem. Mais: o modo da automação (seco de fábrica em toda conta) e o roteiro de registro
 * da aba «Tarefas» nas contas que já existem.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';

Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });
const W = await import('./crm-tarefas-worker.js');
const U = await import('./chatwoot-unidades.js');
const E = await import('./automacoes-estado.js');
const { AUTOMACOES, automacaoPorId } = await import('./automacoes.js');
const S = await import('../scripts/registrar-tarefas.js');

const originais = new Map<string, PropertyDescriptor | undefined>();
function falso(modelo: string, metodos: Record<string, unknown>): void {
  if (!originais.has(modelo)) originais.set(modelo, Object.getOwnPropertyDescriptor(prisma, modelo));
  Object.defineProperty(prisma, modelo, { value: metodos, configurable: true, writable: true });
}
afterEach(() => {
  for (const [m, d] of originais) {
    if (d) Object.defineProperty(prisma, m, d);
    else delete (prisma as unknown as Record<string, unknown>)[m];
  }
  originais.clear();
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  E._esquecerOBancoParaTeste();
});

const AGORA = new Date('2026-11-18T18:00:00Z');

test('as travas do armazém: pegar só pendente, lembrar só quem nunca foi lembrada, anotar o seco só uma vez, atualizar só no estado esperado', async () => {
  const pedidos: Array<{ op: string; a: any }> = [];
  falso('crmTarefa', { updateMany: async (a: unknown) => (pedidos.push({ op: 'updateMany', a }), { count: 1 }), findMany: async (a: unknown) => (pedidos.push({ op: 'findMany', a }), []) });
  const arm = W.armazemDoBanco();
  const lida = new Date('2026-11-18T17:59:00Z');
  assert.equal(await arm.pegar('t1', AGORA, lida), true);
  assert.deepEqual(pedidos[0]!.a, { where: { id: 't1', estado: 'pendente', atualizadoEm: lida }, data: { estado: 'enviando', tentativaEm: AGORA } }, 'só pega se a tarefa continua como foi lida (edição no meio do ciclo = larga)');
  assert.equal(await arm.pegarLembrete('t1', AGORA), true);
  assert.deepEqual(pedidos[1]!.a, { where: { id: 't1', estado: 'pendente', lembreteEm: null }, data: { lembreteEm: AGORA } });
  assert.equal(await arm.anotarSimulado('t1', 'x'.repeat(500), AGORA), true);
  assert.deepEqual(pedidos[2]!.a.where, { id: 't1', estado: 'pendente', simuladoEm: null });
  assert.equal(pedidos[2]!.a.data.simulado.length, 300);
  assert.equal(await arm.atualizar('t1', ['enviando'], { estado: 'feita' }), true);
  assert.deepEqual(pedidos[3]!.a.where, { id: 't1', estado: { in: ['enviando'] } });
  // «count: 0» = outra réplica já mexeu: quem chamou NÃO segue
  falso('crmTarefa', { updateMany: async () => ({ count: 0 }) });
  assert.equal(await W.armazemDoBanco().pegar('t1', AGORA, AGORA), false);
  assert.equal(await W.armazemDoBanco().pegarLembrete('t1', AGORA), false);
});

test('o que o robô busca: só pendente que já passou da hora; no seco pula as já anotadas; ligação já lembrada não volta; presa em «enviando» sai da fila', async () => {
  const pedidos: any[] = [];
  falso('crmTarefa', {
    findMany: async (a: unknown) => (pedidos.push(a), []),
    updateMany: async (a: unknown) => (pedidos.push(a), { count: 2 }),
  });
  const arm = W.armazemDoBanco();
  await arm.unidadesComVencidas(AGORA);
  assert.deepEqual(pedidos[0].where, { estado: 'pendente', quando: { lte: AGORA }, OR: [{ tipo: 'mensagem' }, { lembreteEm: null }] });
  await arm.vencidas('u1', AGORA, true, 100);
  assert.deepEqual(pedidos[1].where, { unitId: 'u1', estado: 'pendente', quando: { lte: AGORA }, OR: [{ tipo: 'mensagem' }, { lembreteEm: null }], simuladoEm: null });
  await arm.vencidas('u1', AGORA, false, 100);
  assert.equal('simuladoEm' in pedidos[2].where, false, 'ligado olha também as que o seco já tinha anotado');
  assert.equal(await arm.soltarPresas(AGORA), 2);
  assert.deepEqual(pedidos[3].where, { estado: 'enviando', tentativaEm: { lt: new Date(AGORA.getTime() - 10 * 60_000) } });
  assert.equal(pedidos[3].data.estado, 'falhou');
});

test('a automação «chatwoot-tarefas» está no catálogo, nasce em SECO em toda conta (inclusive Parauapebas) e exige o seco antes de ligar', () => {
  const a = automacaoPorId('chatwoot-tarefas')!;
  assert.ok(a && AUTOMACOES.includes(a));
  assert.deepEqual([a.temSeco, a.exigeSecoAntes, a.quandoVazio, a.risco, a.chave], [true, true, 'seco', 'manda-mensagem', 'CHATWOOT_TAREFAS_SLUGS']);
  const DEMO = { slug: 'clinica-demonstracao', contaId: 2, prefixoModelos: 'demo_', usuarioCelularId: 77, gerenteId: 51, metaAgendamentosDia: 5, kapsoPhoneNumberId: '404', wabaId: '999', envSufixo: 'DEMO', dadosModelos: { nome: 'Demo', cidade: 'D', endereco: 'Rua', mapa: 'https://m' }, caixas: [{ id: 20, tipo: 'cloud' as const }] };
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS, DEMO as never]);
  E._semearParaTeste([]);
  assert.equal(W.modoDasTarefas(U.SEMENTE_PARAUAPEBAS.slug, {} as never), 'seco', 'a conta do ambiente também nasce em seco');
  assert.equal(W.modoDasTarefas('clinica-demonstracao', {} as never), 'seco');
  assert.equal(W.modoDasTarefas(U.SEMENTE_PARAUAPEBAS.slug, { CHATWOOT_TAREFAS_SLUGS: U.SEMENTE_PARAUAPEBAS.slug } as never), 'ligado', 'a lista do .env liga quem está nela');
  assert.equal(W.modoDasTarefas('clinica-demonstracao', { CHATWOOT_TAREFAS_SLUGS: U.SEMENTE_PARAUAPEBAS.slug } as never), 'seco', 'quem não está na lista segue em seco');
  E._semearParaTeste([{ slug: 'clinica-demonstracao', automacao: 'chatwoot-tarefas', estado: 'desligado' }]);
  assert.equal(W.modoDasTarefas('clinica-demonstracao', {} as never), 'desligado', 'a tela de automações desliga');
});

// ── o roteiro de registro da aba nas contas que já existem ─────────────────────────────────────────────────────

function contaFalsa(conta: number, apps: Array<{ title: string }>, falha?: Error) {
  const criadas: unknown[] = [];
  return { criadas, c: { conta, propria: true, listar: async () => (falha ? Promise.reject(falha) : apps), criar: async (corpo: Record<string, unknown>) => (criadas.push(corpo), {}) } };
}

test('registrar-tarefas --so-conferir não escreve nada e diz o que falta; sem o flag cria só onde falta; rodar duas vezes não duplica; uma conta com erro não para as outras', async () => {
  const a = contaFalsa(1, [{ title: 'Funil' }]);
  const b = contaFalsa(2, [{ title: 'Funil' }, { title: 'Tarefas' }]);
  const conferir = await S.registrarTarefas([a.c, b.c], 'https://agente.exemplo.test', true);
  assert.deepEqual(conferir.map((l) => [l.conta, l.situacao]), [[1, 'faltava'], [2, 'ja-existia']]);
  assert.equal(a.criadas.length, 0, '--so-conferir não escreve');
  assert.match(conferir[0]!.texto, /FALTA a aba «Tarefas».*\/funil\/tarefas\?conta=1/);
  const feito = await S.registrarTarefas([a.c, b.c], 'https://agente.exemplo.test', false);
  assert.deepEqual(feito.map((l) => l.situacao), ['criada', 'ja-existia']);
  assert.deepEqual(a.criadas, [{ title: 'Tarefas', content: [{ type: 'frame', url: 'https://agente.exemplo.test/funil/tarefas?conta=1' }] }]);
  assert.equal(b.criadas.length, 0);
  const falha = contaFalsa(3, [], Object.assign(new Error('Chatwoot 401'), { status: 401 }));
  const c = contaFalsa(4, []);
  const mistas = await S.registrarTarefas([falha.c, c.c], 'https://agente.exemplo.test', false);
  assert.deepEqual(mistas.map((l) => l.situacao), ['falhou', 'criada']);
  assert.match(mistas[0]!.texto, /CRM respondeu 401/);
  assert.ok(!JSON.stringify(mistas).includes('token'), 'nenhum token na saída');
});
