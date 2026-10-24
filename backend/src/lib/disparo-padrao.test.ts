import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { AUTOMACAO_DISPARO, listaDeTesteDoAmbiente, portoReal } from './disparo/porto.js';
import { temAgendamentoFuturo } from './disparo/franquia.js';

beforeEach(() => {
  _semearParaTeste([]);
  delete process.env.DISPARO_CAMPANHA_SLUGS;
});

test('o PADRÃO é seco para a rede toda: sem variável e sem tela, nenhuma unidade está ligada', () => {
  const a = automacaoPorId(AUTOMACAO_DISPARO);
  assert.ok(a, 'a automação está no catálogo');
  assert.equal(a.quandoVazio, 'seco');
  assert.equal(a.temSeco, true);
  const porto = portoReal(new Map());
  for (const slug of ['doutor-hernia-canaa', 'doutor-hernia-acailandia', 'qualquer-outra']) assert.equal(porto.modoDaUnidade(slug), 'seco', slug);
  assert.deepEqual(verificarCatalogo(AUTOMACOES), [], 'catálogo íntegro');
});

test('só liga quem o João (ou o .env) pôs na lista; o resto continua seco', () => {
  process.env.DISPARO_CAMPANHA_SLUGS = 'doutor-hernia-canaa';
  const porto = portoReal(new Map());
  assert.equal(porto.modoDaUnidade('doutor-hernia-canaa'), 'ligado');
  assert.equal(porto.modoDaUnidade('doutor-hernia-balsas'), 'seco');
  _semearParaTeste([{ slug: 'doutor-hernia-canaa', automacao: AUTOMACAO_DISPARO, estado: 'desligado' }]);
  assert.equal(porto.modoDaUnidade('doutor-hernia-canaa'), 'desligado', 'a tela manda mais que o .env');
});

test('lista de teste: fail-closed — ausente, vazia ou lixo = NINGUÉM; só "*" solta todos', () => {
  assert.equal(listaDeTesteDoAmbiente({} as NodeJS.ProcessEnv)!.size, 0, 'ausente: ninguém');
  assert.equal(listaDeTesteDoAmbiente({ DISPARO_LISTA_DE_TESTE: '  ' } as NodeJS.ProcessEnv)!.size, 0);
  assert.equal(listaDeTesteDoAmbiente({ DISPARO_LISTA_DE_TESTE: 'abc, 123' } as NodeJS.ProcessEnv)!.size, 0, 'lixo: ninguém');
  assert.deepEqual([...listaDeTesteDoAmbiente({ DISPARO_LISTA_DE_TESTE: '(63) 99102-1043' } as NodeJS.ProcessEnv)!], ['5563991021043']);
  assert.equal(listaDeTesteDoAmbiente({ DISPARO_LISTA_DE_TESTE: '*' } as NodeJS.ProcessEnv), null, '* = todos, deliberado');
});

test('agendamento futuro: marcado/confirmado/remarcado barram; passado e desmarcado não', () => {
  const agora = Math.floor(Date.parse('2026-10-24T12:00:00Z') / 1000);
  const s = (dia: string, idStatus: number) => ({ dateAttendanceUtc: `${dia}T15:00:00Z`, idStatus });
  assert.equal(temAgendamentoFuturo([s('2026-10-30', 37)], agora), true, 'agendado');
  assert.equal(temAgendamentoFuturo([s('2026-10-30', 38)], agora), true, 'confirmado');
  assert.equal(temAgendamentoFuturo([s('2026-10-30', 41)], agora), true, 'remarcado: o paciente vem naquele dia');
  assert.equal(temAgendamentoFuturo([s('2026-10-30', 57)], agora), false, 'desmarcado');
  assert.equal(temAgendamentoFuturo([s('2026-10-30', 40)], agora), false, 'não compareceu');
  assert.equal(temAgendamentoFuturo([s('2026-10-01', 37)], agora), false, 'passado');
  assert.equal(temAgendamentoFuturo([{ dateAttendanceUtc: null, idStatus: 37 }], agora), false);
});

// ── as rotas (mesmo estilo do teste das rotas do Bling: lê o arquivo, porque montar o app inteiro aqui custa caro) ──
const rotas = readFileSync(new URL('../routes/api.routes.ts', import.meta.url), 'utf8');

test('APROVAR exige sessão de super-admin e nunca aceita a chave de serviço', () => {
  assert.match(rotas, /apiRouter\.post\('\/disparo\/ondas\/:id\/aprovar', requireAuth, requireSuperAdmin, disparoOndaAprovarHandler\)/);
  assert.doesNotMatch(rotas, /'\/disparo\/ondas\/:id\/aprovar',\s*chaveDeServicoOuSessao/);
});

test('as rotas do disparo ficam acima do requireAuth global (senão a chave de serviço nunca é lida)', () => {
  const global = rotas.indexOf('apiRouter.use(requireAuth);');
  for (const trecho of ["'/disparo/ondas'", "'/disparo/ondas/:id/painel'", "'/disparo/ondas/:id/cancelar'"]) {
    const i = rotas.indexOf(trecho);
    assert.ok(i > 0 && global > 0 && i < global, trecho);
  }
});
