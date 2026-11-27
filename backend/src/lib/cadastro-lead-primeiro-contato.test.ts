/**
 * Chave `cadastro-lead-primeiro-contato` (27/11/2026): "cadastrar TODO lead no 1º contato".
 *  - LIGADA: quem passou nas travas de número interno e 3+ unidades é lead — sem a leitura da IA e sem exigir o casamento;
 *  - DESLIGADA: a chave "Cadastrar TODO lead" (com a triagem pela IA) e a regra de 26/09 seguem byte a byte;
 *  - SECA: decide e registra, nunca cria — nem por cima da triagem que já está ligada.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { _semearParaTeste } from './automacoes-estado.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { deveCriarNaFranquia } from './cadastro-na-franquia.js';
import {
  _limparCacheParaTeste,
  cadastrarLeadDoTurno,
  decidirCadastroDoLead,
  depsPadrao,
  estadoCadastroTodoLead,
  modoPrimeiroContato,
  type DepsDoCadastro,
} from './cadastro-todo-lead.js';

const BEBEDOURO = { id: 'u-bebedouro', slug: 'doutor-hernia-bebedouro' };
const PACIENTE = '5517988887777';
const SEM_AGENDAR = deveCriarNaFranquia({ ferramentas: ['registrar_campo'] });
const AGENDOU = deveCriarNaFranquia({ ferramentas: ['agendar_consulta'] });

function deps(o: Partial<{ telefone: string | null; unidades: string[]; casamento: boolean; situacao: 'nova' | 'na-franquia' | 'tentou-ha-pouco' }> = {}): DepsDoCadastro & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async situacaoNaFranquia() { return o.situacao ?? 'nova'; },
    async telefoneDaConversa() { return o.telefone === undefined ? PACIENTE : o.telefone; },
    casamentoLigado: () => o.casamento ?? false,
    async unidadesDoTelefone() { return o.unidades ?? [BEBEDOURO.slug]; },
    async anuncioDoLead() { chamadas.push('anuncio'); return null; },
    async falasDoPaciente() { chamadas.push('falas'); return ['oi']; },
    async avaliarPelaIa() { chamadas.push('ia'); return { decisao: 'duvida' as const, motivo: 'só disse oi' }; },
  };
}

const ligar = (pc: 'ligado' | 'seco' | null, triagem: 'ligado' | 'seco' | null = null) =>
  _semearParaTeste([
    ...(pc ? [{ slug: BEBEDOURO.slug, automacao: 'cadastro-lead-primeiro-contato', estado: pc }] : []),
    ...(triagem ? [{ slug: BEBEDOURO.slug, automacao: 'cadastro-todo-lead', estado: triagem }] : []),
  ]);

let simulacoes: Array<Record<string, unknown>> = [];

beforeEach(() => {
  _semearParaTeste([]);
  _limparCacheParaTeste();
  process.env.NUMEROS_INTERNOS = 'joao:98999999464';
  simulacoes = [];
  for (const nivel of ['info', 'warn'] as const) mock.method(logger, nivel, (() => undefined) as never);
  Object.defineProperty(prisma, 'automacaoSimulacao', {
    value: { upsert: async (a: { create: Record<string, unknown> }) => { simulacoes.push(a.create); }, deleteMany: async () => ({ count: 0 }) },
    configurable: true,
  });
});
afterEach(() => mock.restoreAll());

test('LIGADA: "oi" solto vira lead no 1º contato — sem chamar a IA, sem exigir o casamento', async () => {
  ligar('ligado');
  const d = deps({ casamento: false });
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 1, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, true);
  assert.equal(r.soLead, true);
  assert.equal(r.primeiroContato, true);
  assert.equal(r.telefone, PACIENTE);
  assert.deepEqual(d.chamadas, [], 'nem anúncio, nem falas, nem IA');
});

test('LIGADA: número interno e telefone em 3+ unidades continuam barrados', async () => {
  ligar('ligado');
  const interno = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 2, legado: SEM_AGENDAR }, deps({ telefone: '5598999999464' }));
  assert.equal(interno.criar, false);
  assert.match(interno.motivo, /interno/);
  const rede = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 3, legado: SEM_AGENDAR }, deps({ unidades: ['doutor-hernia-bebedouro', 'doutor-hernia-serra', 'doutor-hernia-salto'] }));
  assert.equal(rede.criar, false);
  assert.match(rede.motivo, /varias-unidades/);
});

test('LIGADA: sem telefone na conversa não cadastra (não dá para conferir interno nem duplicado)', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 4, legado: SEM_AGENDAR }, deps({ telefone: null }));
  assert.equal(r.criar, false);
});

test('LIGADA: quem já está na franquia por este caminho não é recriado', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 5, legado: SEM_AGENDAR }, deps({ situacao: 'na-franquia' }));
  assert.equal(r.criar, false);
  assert.equal(r.silenciosa, true);
});

test('LIGADA: quem agendou segue como segue hoje (não é "só lead", sem nome provisório nem trava nova)', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 6, legado: AGENDOU }, deps());
  assert.equal(r.criar, true);
  assert.equal(r.soLead, false);
  assert.equal(r.primeiroContato, undefined);
});

test('DESLIGADA, triagem pela IA ligada: tudo como era — a IA lê, "oi" é dúvida, e nada de 1º contato', async () => {
  ligar(null, 'ligado');
  const d = deps({ casamento: true });
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 7, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, false);
  assert.ok(d.chamadas.includes('ia'));
  assert.equal(modoPrimeiroContato(BEBEDOURO.slug).vale, false);
});

test('DESLIGADA e a triagem também: a regra de 26/09, byte a byte', async () => {
  ligar(null, null);
  const d = deps();
  assert.deepEqual(await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 8, legado: SEM_AGENDAR }, d), SEM_AGENDAR);
  assert.deepEqual(d.chamadas, []);
  assert.equal(estadoCadastroTodoLead(BEBEDOURO.slug), 'desligado');
});

test('SECA: decide e registra "cadastraria (1º contato)", mas NÃO cria — a regra de 26/09 continua decidindo', async () => {
  ligar('seco');
  const d = deps();
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 9, legado: SEM_AGENDAR }, d);
  assert.deepEqual(r, SEM_AGENDAR);
  assert.equal(r.criar, false);
  assert.deepEqual(d.chamadas, []);
  assert.equal(simulacoes.length, 1);
  assert.equal(simulacoes[0].automacao, 'cadastro-lead-primeiro-contato', 'aparece na lista "o que ela faria" da chave nova');
  assert.equal(simulacoes[0].acao, 'gravaria');
});

test('SECA por cima da triagem LIGADA: nada de criar sem triagem — vale a triagem de sempre', async () => {
  ligar('seco', 'ligado');
  const d = deps({ casamento: true });
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 10, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, false, '"oi" ainda é dúvida pela IA');
  assert.equal(r.primeiroContato, undefined);
  assert.ok(d.chamadas.includes('ia'));
});

test('LIGADA por cima da triagem LIGADA: vale a nova (sem IA)', async () => {
  ligar('ligado', 'ligado');
  const d = deps({ casamento: true });
  const r = await decidirCadastroDoLead({ unit: BEBEDOURO, leadId: 11, legado: SEM_AGENDAR }, d);
  assert.equal(r.criar, true);
  assert.equal(r.primeiroContato, true);
  assert.ok(!d.chamadas.includes('ia'));
});

test('o gancho do turno repassa primeiroContato e o telefone ao sincronizador', async () => {
  ligar('ligado');
  const vistos: unknown[] = [];
  const r = await cadastrarLeadDoTurno({ unit: BEBEDOURO, leadId: 12, ferramentas: [] }, async (_u, _l, o) => { vistos.push(o); return { ok: true }; }, deps());
  await r.execucao;
  assert.deepEqual(vistos, [{ soLead: true, primeiroContato: true, telefone: PACIENTE }]);
});

test('"retentar" (a busca do telefone falhou) libera a PRÓXIMA mensagem sem esperar 10 min; sem isso a espera de 10 min vale', async () => {
  ligar('ligado');
  Object.defineProperty(prisma, 'spineLeadLink', { value: { findUnique: async () => null }, configurable: true });
  // a espera de 10 min mora em `situacaoNaFranquia` de produção: usamos ela, o resto é falso
  const comEsperaDeProducao = () => ({ ...deps(), situacaoNaFranquia: depsPadrao.situacaoNaFranquia });
  let n = 0;
  const falhaComRetentar = async () => { n++; return { ok: false, retentar: true }; };
  const falhaSemRetentar = async () => { n++; return { ok: false }; };

  await (await cadastrarLeadDoTurno({ unit: BEBEDOURO, leadId: 13, ferramentas: [] }, falhaComRetentar, comEsperaDeProducao())).execucao;
  await (await cadastrarLeadDoTurno({ unit: BEBEDOURO, leadId: 13, ferramentas: [] }, falhaComRetentar, comEsperaDeProducao())).execucao;
  assert.equal(n, 2, 'com retentar, a 2ª mensagem tentou de novo');

  n = 0;
  await (await cadastrarLeadDoTurno({ unit: BEBEDOURO, leadId: 14, ferramentas: [] }, falhaSemRetentar, comEsperaDeProducao())).execucao;
  const segunda = await cadastrarLeadDoTurno({ unit: BEBEDOURO, leadId: 14, ferramentas: [] }, falhaSemRetentar, comEsperaDeProducao());
  await segunda.execucao;
  assert.equal(n, 1, 'sem retentar, a espera de 10 min segura a 2ª mensagem');
  assert.equal(segunda.decisao.criar, false);
});
