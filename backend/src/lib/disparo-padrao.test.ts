import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { AUTOMACAO_DISPARO, avisosDaListaDeTeste, listaDeTesteDoAmbiente, portoReal } from './disparo/porto.js';
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

const env = (v: string) => ({ DISPARO_LISTA_DE_TESTE: v }) as NodeJS.ProcessEnv;
const CANAA = 'doutor-hernia-canaa';

test('lista de teste é POR UNIDADE e fail-closed: ausente, vazia, lixo ou outra unidade = NINGUÉM', () => {
  assert.equal(listaDeTesteDoAmbiente(CANAA, {} as NodeJS.ProcessEnv)!.size, 0, 'ausente: ninguém');
  assert.equal(listaDeTesteDoAmbiente(CANAA, env('  '))!.size, 0);
  assert.equal(listaDeTesteDoAmbiente(CANAA, env(`${CANAA}=abc, 123`))!.size, 0, 'lixo: ninguém');
  assert.deepEqual([...listaDeTesteDoAmbiente(CANAA, env(`${CANAA}=(63) 99102-1043`))!], ['5563991021043']);
  assert.deepEqual([...listaDeTesteDoAmbiente(CANAA, env(`${CANAA}=5563991021043,5563991021044`))!].sort(), ['5563991021043', '5563991021044']);
  assert.equal(listaDeTesteDoAmbiente('doutor-hernia-balsas', env(`${CANAA}=5563991021043`))!.size, 0, 'a lista de uma unidade não vale para a outra');
});

test('"*" solta só a unidade que o tem; nunca é global', () => {
  const v = env(`${CANAA}=*;doutor-hernia-balsas=5563991021043`);
  assert.equal(listaDeTesteDoAmbiente(CANAA, v), null, 'slug=* = todos DAQUELA unidade');
  assert.deepEqual([...listaDeTesteDoAmbiente('doutor-hernia-balsas', v)!], ['5563991021043']);
  assert.equal(listaDeTesteDoAmbiente('doutor-hernia-marabá', v)!.size, 0, 'unidade que não aparece: ninguém');
  assert.equal(listaDeTesteDoAmbiente(CANAA, env('*'))!.size, 0, '"*" sozinho (o formato global antigo) NÃO solta ninguém');
  assert.equal(listaDeTesteDoAmbiente(CANAA, env('5563991021043'))!.size, 0, 'telefone sem unidade (formato antigo) não vale');
});

test('o log de subida avisa a entrada no formato antigo, que não vale', () => {
  assert.deepEqual(avisosDaListaDeTeste(env(`${CANAA}=5563991021043;doutor-hernia-balsas=*`)), []);
  assert.equal(avisosDaListaDeTeste(env('*')).length, 1);
  assert.match(avisosDaListaDeTeste(env(`5563991021043;${CANAA}=*`))[0]!, /não vale/);
  assert.deepEqual(avisosDaListaDeTeste({} as NodeJS.ProcessEnv), []);
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
