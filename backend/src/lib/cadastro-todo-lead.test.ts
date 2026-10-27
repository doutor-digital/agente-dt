/**
 * "Toda pessoa que entra em contato vira lead na franquia" (27/10/2026) — e as três coisas que não
 * podem escapar: número interno, telefone que fala com 3+ unidades, e o modo seco que grava.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _semearParaTeste } from './automacoes-estado.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { deveCriarNaFranquia } from './cadastro-na-franquia.js';
import {
  _limparCacheParaTeste,
  decidirCadastroDoLead,
  estadoCadastroTodoLead,
  triar,
  umCadastroPorVez,
  unidadeBase,
  unidadesDistintas,
  type DepsDoCadastro,
} from './cadastro-todo-lead.js';

const SERRA = { id: 'u-serra', slug: 'doutor-hernia-serra' };
const INTERNO = '5598999999464';
const INTERNOS = 'joao:98999999464';
const PACIENTE = '5598988887777';

const SEM_AGENDAR = deveCriarNaFranquia({ ferramentas: ['registrar_campo'] });
const AGENDOU = deveCriarNaFranquia({ ferramentas: ['agendar_consulta'] });

beforeEach(() => {
  _semearParaTeste([]);
  _limparCacheParaTeste();
  process.env.NUMEROS_INTERNOS = INTERNOS;
});

function deps(o: Partial<{ ja: boolean; telefone: string | null; unidades: string[] | Error }>): DepsDoCadastro & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async jaNaFranquia() {
      chamadas.push('ja');
      return o.ja ?? false;
    },
    async telefoneDaConversa() {
      chamadas.push('telefone');
      return o.telefone === undefined ? PACIENTE : o.telefone;
    },
    async unidadesDoTelefone() {
      chamadas.push('unidades');
      if (o.unidades instanceof Error) throw o.unidades;
      return o.unidades ?? [SERRA.slug];
    },
  };
}

const ligar = (estado: 'ligado' | 'seco') => _semearParaTeste([{ slug: SERRA.slug, automacao: 'cadastro-todo-lead', estado }]);

test('catálogo: a automação existe, tem modo seco e nasce DESLIGADA', () => {
  const a = automacaoPorId('cadastro-todo-lead');
  assert.ok(a);
  assert.equal(a.chave, 'CADASTRO_TODO_LEAD_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(), []);
  assert.ok(AUTOMACOES.some((x) => x.id === 'cadastro-todo-lead'));
  assert.equal(estadoCadastroTodoLead(SERRA.slug, undefined), 'desligado', 'sem tela e sem .env, a regra de 26/09 segue valendo');
  assert.equal(estadoCadastroTodoLead(SERRA.slug, ''), 'desligado');
});

test('DESLIGADA: devolve exatamente a regra de 26/09 e não toca no banco', async () => {
  const d = deps({ telefone: INTERNO });
  const sem = await decidirCadastroDoLead({ unit: SERRA, leadId: 1, legado: SEM_AGENDAR }, d);
  assert.deepEqual(sem, SEM_AGENDAR);
  assert.equal(sem.criar, false, 'quem só conversou continua fora');
  const ag = await decidirCadastroDoLead({ unit: SERRA, leadId: 1, legado: AGENDOU }, d);
  assert.deepEqual(ag, AGENDOU);
  assert.deepEqual(d.chamadas, [], 'zero consultas novas com a chave desligada');
});

test('SECO não cadastra nada a mais: a regra de 26/09 continua decidindo, mesmo para número interno e 3+ unidades', async () => {
  ligar('seco');
  // paciente comum que só conversou: "cadastraria", mas a decisão devolvida segue sendo NÃO
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 2, legado: SEM_AGENDAR }, deps({})), SEM_AGENDAR);
  // interno que agendou: seco só loga que barraria — a decisão devolvida continua sendo a antiga (criar)
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 3, legado: AGENDOU }, deps({ telefone: INTERNO })), AGENDOU);
  // 3+ unidades que agendou: idem
  const tres = deps({ unidades: ['a', 'b', 'c-resgate', SERRA.slug] });
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 4, legado: AGENDOU }, tres), AGENDOU);
  // banco falhando em seco também não muda nada
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 5, legado: SEM_AGENDAR }, deps({ unidades: new Error('banco fora') })), SEM_AGENDAR);
});

test('SECO: lead que já está na franquia não é reavaliado', async () => {
  ligar('seco');
  const d = deps({ ja: true });
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 6, legado: AGENDOU }, d), AGENDOU);
  assert.deepEqual(d.chamadas, ['ja']);
});

test('LIGADA: quem entra em contato é cadastrado já na primeira mensagem, sem agendar', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 10, legado: SEM_AGENDAR }, deps({}));
  assert.equal(r.criar, true);
  assert.match(r.motivo, /lead novo/);
});

test('LIGADA: número interno nunca é cadastrado — nem quando agendou', async () => {
  ligar('ligado');
  const d = deps({ telefone: INTERNO });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 11, legado: AGENDOU }, d);
  assert.equal(r.criar, false);
  assert.match(r.motivo, /interno/);
  assert.ok(!d.chamadas.includes('unidades'), 'interno já é resposta: não precisa contar unidades');
  // o mesmo número em outro formato (sem nono dígito, com máscara)
  const r2 = await decidirCadastroDoLead({ unit: SERRA, leadId: 12, legado: AGENDOU }, deps({ telefone: '+55 (98) 9999-9464' }));
  assert.equal(r2.criar, false);
});

test('LIGADA: telefone em 3 ou mais unidades NÃO é cadastrado e fica marcado para humano', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 13, legado: SEM_AGENDAR }, deps({ unidades: [SERRA.slug, 'doutor-hernia-marabá', 'doutor-hernia-canaa'] }));
  assert.equal(r.criar, false);
  assert.match(r.motivo, /varias-unidades/);
  assert.match(r.motivo, /3 unidades/);
});

test('LIGADA: duas unidades ainda é gente (mudou de cidade, procurou duas clínicas)', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 14, legado: SEM_AGENDAR }, deps({ unidades: [SERRA.slug, 'doutor-hernia-canaa'] }));
  assert.equal(r.criar, true);
});

test('LIGADA: X e X-resgate são a MESMA unidade, e hm-tecnologia não conta', async () => {
  ligar('ligado');
  const mesma = deps({ unidades: [SERRA.slug, 'doutor-hernia-serra-resgate', 'doutor-hernia-canaa', 'doutor-hernia-canaa-resgate'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 15, legado: SEM_AGENDAR }, mesma)).criar, true, '4 slugs, 2 unidades');
  const hm = deps({ unidades: [SERRA.slug, 'doutor-hernia-canaa', 'hm-tecnologia'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 16, legado: SEM_AGENDAR }, hm)).criar, true, 'a HM é teste, não é a terceira unidade');
  const tres = deps({ unidades: [SERRA.slug, 'doutor-hernia-canaa-resgate', 'doutor-hernia-marabá', 'hm-tecnologia'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 17, legado: SEM_AGENDAR }, tres)).criar, false);
});

test('LIGADA: sem telefone na conversa não cadastra (não dá para saber se é interno)', async () => {
  ligar('ligado');
  for (const telefone of [null, '', '123']) {
    const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 18, legado: AGENDOU }, deps({ telefone }));
    assert.equal(r.criar, false, String(telefone));
    assert.match(r.motivo, /sem-telefone/);
  }
});

test('LIGADA: na dúvida (banco fora) não cadastra — lead barrado volta na próxima mensagem, interno criado não tem volta', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 19, legado: AGENDOU }, deps({ unidades: new Error('banco fora') }));
  assert.equal(r.criar, false);
  const r2 = await decidirCadastroDoLead(
    { unit: SERRA, leadId: 20, legado: AGENDOU },
    { ...deps({}), telefoneDaConversa: async () => { throw new Error('banco fora'); } },
  );
  assert.equal(r2.criar, false);
});

test('LIGADA: lead que já está na franquia segue (o sincronizador devolve "já existia", não duplica)', async () => {
  ligar('ligado');
  const d = deps({ ja: true });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 21, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, true);
  assert.deepEqual(d.chamadas, ['ja']);
});

test('a chave é por unidade: ligada numa, as outras seguem a regra de 26/09', async () => {
  ligar('ligado');
  const outra = { id: 'u-canaa', slug: 'doutor-hernia-canaa' };
  assert.deepEqual(await decidirCadastroDoLead({ unit: outra, leadId: 22, legado: SEM_AGENDAR }, deps({})), SEM_AGENDAR);
});

test('triar: ordem das travas e unidades', () => {
  assert.equal(triar(null, [], INTERNOS).acao, 'sem-telefone');
  assert.equal(triar(INTERNO, [], INTERNOS).acao, 'interno');
  assert.equal(triar(PACIENTE, null, INTERNOS).acao, 'erro');
  assert.equal(triar(PACIENTE, ['a', 'b', 'c'], INTERNOS).acao, 'varias-unidades');
  assert.equal(triar(PACIENTE, ['a', 'b'], INTERNOS).acao, 'cadastrar');
  // o log não grava o telefone inteiro
  const t = triar(PACIENTE, ['a', 'b', 'c'], INTERNOS);
  assert.ok(!t.motivo.includes(PACIENTE));
  assert.match(t.motivo, /…7777/);
});

test('unidadesDistintas / unidadeBase', () => {
  assert.equal(unidadeBase('Doutor-Hernia-Serra-Resgate'), 'doutor-hernia-serra');
  assert.deepEqual(unidadesDistintas(['x', 'x-resgate', 'y', 'hm-tecnologia']), ['x', 'y']);
  assert.deepEqual(unidadesDistintas([]), []);
});

test('um cadastro por vez por lead: a rajada de mensagens não cria duas vezes na franquia', async () => {
  let criados = 0;
  let solta!: () => void;
  const trava = new Promise<void>((r) => { solta = r; });
  const um = umCadastroPorVez('u', 1, async () => { criados++; await trava; });
  const dois = umCadastroPorVez('u', 1, async () => { criados++; });
  assert.equal(await dois, undefined, 'a segunda chamada simultânea não faz nada');
  solta();
  await um;
  assert.equal(criados, 1);
  // terminada a primeira, outra mensagem pode tentar de novo (ex.: o nome só completou agora)
  await umCadastroPorVez('u', 1, async () => { criados++; });
  assert.equal(criados, 2);
  // e leads diferentes não se atrapalham
  await Promise.all([umCadastroPorVez('u', 2, async () => { criados++; }), umCadastroPorVez('u', 3, async () => { criados++; })]);
  assert.equal(criados, 4);
});
