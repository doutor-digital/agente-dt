/**
 * "Toda pessoa que entra em contato vira lead na franquia" (27/10/2026) — e as três coisas que não
 * podem escapar: número interno, telefone que fala com 3+ unidades, e o modo seco que grava.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _semearParaTeste } from './automacoes-estado.js';
import { prisma } from './prisma.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';
import { deveCriarNaFranquia } from './cadastro-na-franquia.js';
import {
  _limparCacheParaTeste,
  cadastrarLeadDoTurno,
  depsPadrao,
  criaPacienteJuntoComOLead,
  decidirCadastroDoLead,
  estadoCadastroTodoLead,
  triar,
  umCadastroPorVez,
  unidadesDistintas,
  type DepsDoCadastro,
  type SituacaoNaFranquia,
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

function deps(o: Partial<{ situacao: SituacaoNaFranquia; telefone: string | null; unidades: string[] | Error; casamento: boolean }>): DepsDoCadastro & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async situacaoNaFranquia() {
      chamadas.push('situacao');
      return o.situacao ?? 'nova';
    },
    async telefoneDaConversa() {
      chamadas.push('telefone');
      return o.telefone === undefined ? PACIENTE : o.telefone;
    },
    casamentoLigado: () => o.casamento ?? true,
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
  const d = deps({ situacao: 'na-franquia' });
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 6, legado: AGENDOU }, d), AGENDOU);
  assert.deepEqual(d.chamadas, ['situacao']);
});

test('LIGADA: quem entra em contato é cadastrado já na primeira mensagem, sem agendar', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 10, legado: SEM_AGENDAR }, deps({}));
  assert.equal(r.criar, true);
  assert.match(r.motivo, /lead novo/);
  assert.equal(r.soLead, true, 'quem só conversou vira LEAD — nunca paciente, mesmo com spine_sync_patients ligado');
  // quem agendou segue como segue hoje (o sincronizador decide pelo paciente)
  const ag = await decidirCadastroDoLead({ unit: SERRA, leadId: 10, legado: AGENDOU }, deps({}));
  assert.equal(ag.criar, true);
  assert.equal(ag.soLead, false);
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

test('LIGADA: X-resgate e doutor-hernia-X são a MESMA clínica (nomes reais), e hm-tecnologia não conta', async () => {
  ligar('ligado');
  // a Açailândia conta UMA vez, não duas: serra + açailândia + imperatriz = 3 clínicas → barra
  const tresClinicas = deps({ unidades: [SERRA.slug, 'acailandia-resgate', 'doutor-hernia-acailandia', 'imperatriz-financeiro'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 15, legado: SEM_AGENDAR }, tresClinicas)).criar, false);
  const dois = deps({ unidades: [SERRA.slug, 'acailandia-resgate', 'doutor-hernia-acailandia', 'doutor-hernia-acailandia-tratamento'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 15, legado: SEM_AGENDAR }, dois)).criar, true, 'serra + açailândia (3 contas) = 2 clínicas');
  const hm = deps({ unidades: [SERRA.slug, 'doutor-hernia-canaa', 'hm-tecnologia'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 16, legado: SEM_AGENDAR }, hm)).criar, true, 'a HM é teste, não é a terceira unidade');
  const tres = deps({ unidades: [SERRA.slug, 'canaa-resgate', 'doutor-hernia-marabá', 'hm-tecnologia'] });
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 17, legado: SEM_AGENDAR }, tres)).criar, false);
});

test('LIGADA: quem só conversou e não tem telefone na conversa NÃO é cadastrado (não dá para saber se é interno)', async () => {
  ligar('ligado');
  for (const telefone of [null, '', '123']) {
    const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 18, legado: SEM_AGENDAR }, deps({ telefone }));
    assert.equal(r.criar, false, String(telefone));
    assert.match(r.motivo, /sem-telefone/);
  }
});

test('LIGADA: na dúvida (banco fora) quem só conversou fica de fora — barrado volta na próxima mensagem, interno criado não tem volta', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 19, legado: SEM_AGENDAR }, deps({ unidades: new Error('banco fora') }));
  assert.equal(r.criar, false);
  const r2 = await decidirCadastroDoLead(
    { unit: SERRA, leadId: 20, legado: SEM_AGENDAR },
    { ...deps({}), telefoneDaConversa: async () => { throw new Error('banco fora'); } },
  );
  assert.equal(r2.criar, false);
});

test('LIGADA: na dúvida, quem AGENDOU segue como segue hoje — a regra nova não tira cadastro de quem já entrava', async () => {
  ligar('ligado');
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 23, legado: AGENDOU }, deps({ telefone: null })), AGENDOU, 'sem telefone');
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 24, legado: AGENDOU }, deps({ unidades: new Error('banco fora') })), AGENDOU, 'consulta falhou');
  const quebra = { ...deps({}), telefoneDaConversa: async () => { throw new Error('banco fora'); } };
  assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 25, legado: AGENDOU }, quebra), AGENDOU, 'banco fora');
});

test('LIGADA: lead que já está na franquia não volta ao sincronizador a cada mensagem', async () => {
  ligar('ligado');
  const d = deps({ situacao: 'na-franquia' });
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 21, legado: AGENDOU }, d);
  assert.equal(r.criar, false);
  assert.match(r.motivo, /já está na franquia/);
  assert.deepEqual(d.chamadas, ['situacao'], 'nem conversa nem unidades são consultadas');
});

test('LIGADA: quem não passou (só o primeiro nome) é tentado de novo só depois de alguns minutos — mas quem acabou de agendar não espera', async () => {
  ligar('ligado');
  const d = deps({ situacao: 'tentou-ha-pouco' });
  const espera = await decidirCadastroDoLead({ unit: SERRA, leadId: 26, legado: SEM_AGENDAR }, d);
  assert.equal(espera.criar, false);
  assert.deepEqual(d.chamadas, ['situacao']);
  const agendou = await decidirCadastroDoLead({ unit: SERRA, leadId: 26, legado: AGENDOU }, deps({ situacao: 'tentou-ha-pouco' }));
  assert.equal(agendou.criar, true);
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

test('unidadesDistintas: a dona da conta é a clínica (acailandia-resgate = doutor-hernia-acailandia)', () => {
  assert.deepEqual(unidadesDistintas(['acailandia-resgate', 'doutor-hernia-acailandia']), ['doutor-hernia-acailandia'], 'a mesma clínica conta 1');
  assert.deepEqual(
    unidadesDistintas(['doutor-hernia-serra', 'imperatriz-resgate', 'doutor-hernia-imperatriz', 'taubate-financeiro', 'taubate-tratamento', 'hm-tecnologia']),
    ['doutor-hernia-imperatriz', 'doutor-hernia-serra', 'doutor-hernia-taubate'],
  );
  assert.deepEqual(unidadesDistintas(['Doutor-Hernia-Serra']), ['doutor-hernia-serra'], 'caixa não separa');
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

test('lead cadastrado por ter entrado em contato nunca vira paciente, mesmo com spine_sync_patients ligado', () => {
  assert.equal(criaPacienteJuntoComOLead(true, true), false, 'soLead: só o lead');
  assert.equal(criaPacienteJuntoComOLead(true, false), true, 'agendou: como sempre');
  assert.equal(criaPacienteJuntoComOLead(true, undefined), true, 'chamada antiga (console): como sempre');
  assert.equal(criaPacienteJuntoComOLead(false, false), false, 'unidade sem a chave: nunca');
  assert.equal(criaPacienteJuntoComOLead(false, true), false);
});

// ── vínculo que já existe: o que é "já na franquia" ──────────────────────────────────────────

function vinculo(l: { spineIdLead?: number | null; spineIdClient?: number | null; status?: string; updatedAt?: Date } | null) {
  Object.defineProperty(prisma, 'spineLeadLink', {
    value: { findUnique: async () => (l ? { spineIdLead: null, spineIdClient: null, status: 'ok', updatedAt: new Date(), ...l } : null) },
    configurable: true,
  });
}

test('vínculo só com spineIdClient (carga, widget, Sofia) é gente que JÁ está na franquia — não se cria lead por cima', async () => {
  vinculo({ spineIdLead: null, spineIdClient: 4321 });
  assert.equal(await depsPadrao.situacaoNaFranquia('u-serra', 30), 'na-franquia');
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 30, legado: SEM_AGENDAR }, { ...deps({}), situacaoNaFranquia: depsPadrao.situacaoNaFranquia });
  assert.equal(r.criar, false);
  assert.match(r.motivo, /já está na franquia/);
  // e o de sempre
  vinculo({ spineIdLead: 99 });
  assert.equal(await depsPadrao.situacaoNaFranquia('u-serra', 31), 'na-franquia');
  vinculo(null);
  assert.equal(await depsPadrao.situacaoNaFranquia('u-serra', 32), 'nova');
});

test('vínculo "ignorado"/"falhou" há pouco espera; velho tenta de novo', async () => {
  vinculo({ status: 'ignorado', updatedAt: new Date() });
  assert.equal(await depsPadrao.situacaoNaFranquia('u-serra', 33), 'tentou-ha-pouco');
  vinculo({ status: 'ignorado', updatedAt: new Date(Date.now() - 11 * 60_000) });
  assert.equal(await depsPadrao.situacaoNaFranquia('u-serra', 34), 'nova');
});

test('a espera respeita QUALQUER resultado do sincronizador, inclusive o que não grava vínculo (trava Petrópolis×Caxias, dois pacientes)', async () => {
  vinculo(null);
  _limparCacheParaTeste();
  assert.equal(await depsPadrao.situacaoNaFranquia('u-petro', 40), 'nova');
  await umCadastroPorVez('u-petro', 40, async () => ({ ok: false, motivo: 'unidade de outra cidade' }));
  assert.equal(await depsPadrao.situacaoNaFranquia('u-petro', 40), 'tentou-ha-pouco');
  assert.equal(await depsPadrao.situacaoNaFranquia('u-petro', 41), 'nova', 'outro lead não espera');
  // erro lançado também conta
  await umCadastroPorVez('u-petro', 42, async () => { throw new Error('kommo fora'); }).catch(() => undefined);
  assert.equal(await depsPadrao.situacaoNaFranquia('u-petro', 42), 'tentou-ha-pouco');
  // quem acabou de agendar não espera (o decidir ignora a espera quando a regra de 26/09 já diz que cria)
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 43, legado: AGENDOU }, { ...deps({ situacao: 'tentou-ha-pouco' }) });
  assert.equal(r.criar, true);
});

// ── casamento-jornada: sem ele não há "só lead" ──────────────────────────────────────────────

test('LIGADA sem o casamento-jornada ligado: quem só conversou NÃO vira lead (duplicaria quem já é paciente)', async () => {
  ligar('ligado');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 50, legado: SEM_AGENDAR }, deps({ casamento: false }));
  assert.equal(r.criar, false);
  assert.match(r.motivo, /sem-casamento/);
  // quem agendou segue como segue hoje (a regra de 26/09 já o cadastrava)
  const ag = await decidirCadastroDoLead({ unit: SERRA, leadId: 51, legado: AGENDOU }, deps({ casamento: false }));
  assert.equal(ag.criar, true);
});

test('SECO sem o casamento-jornada ligado: segue devolvendo a regra de 26/09', async () => {
  ligar('seco');
  const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 52, legado: SEM_AGENDAR }, deps({ casamento: false }));
  assert.deepEqual(r, SEM_AGENDAR, 'seco devolve sempre a regra de 26/09');
});

// ── o gancho do webhook, no caminho que roda de verdade ──────────────────────────────────────

test('gancho: quem só conversou é cadastrado SÓ COMO LEAD — o sincronizador recebe soLead:true', async () => {
  ligar('ligado');
  const recebidas: Array<{ soLead?: boolean }> = [];
  const { decisao, execucao } = await cadastrarLeadDoTurno(
    { unit: SERRA, leadId: 60, ferramentas: ['registrar_campo'] },
    async (_u, _l, o) => { recebidas.push(o); },
    deps({}),
  );
  await execucao;
  assert.equal(decisao.criar, true);
  assert.deepEqual(recebidas, [{ soLead: true }]);
});

test('gancho: quem agendou NÃO recebe soLead (o sincronizador decide pelo paciente como sempre)', async () => {
  ligar('ligado');
  const recebidas: Array<{ soLead?: boolean }> = [];
  const { execucao } = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 61, ferramentas: ['agendar_consulta'] }, async (_u, _l, o) => { recebidas.push(o); }, deps({}));
  await execucao;
  assert.equal(recebidas.length, 1);
  assert.ok(!recebidas[0]!.soLead);
});

test('gancho DESLIGADO: é a regra de 26/09 — quem só conversou não dispara nada; quem agendou dispara sem soLead', async () => {
  const d = deps({});
  let chamadas = 0;
  const sem = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 62, ferramentas: [] }, async () => { chamadas++; }, d);
  assert.equal(sem.execucao, null);
  const ag = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 63, ferramentas: ['agendar_consulta'] }, async (_u, _l, o) => { chamadas++; assert.ok(!o.soLead); }, d);
  await ag.execucao;
  assert.equal(chamadas, 1);
  assert.deepEqual(d.chamadas, [], 'e nenhuma consulta nova ao banco');
});

test('gancho: a rajada de mensagens do mesmo lead dispara UM cadastro só', async () => {
  ligar('ligado');
  let chamadas = 0;
  let solta!: () => void;
  const trava = new Promise<void>((r) => { solta = r; });
  const sincronizar = async () => { chamadas++; await trava; };
  const a = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 64, ferramentas: [] }, sincronizar, deps({}));
  const b = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 64, ferramentas: [] }, sincronizar, deps({}));
  solta();
  await Promise.all([a.execucao, b.execucao]);
  assert.equal(chamadas, 1, 'a segunda mensagem chegou com o primeiro cadastro em andamento');
  // outro lead não é afetado
  const c = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 65, ferramentas: [] }, async () => { chamadas++; }, deps({}));
  await c.execucao;
  assert.equal(chamadas, 2);
});

test('gancho: erro do sincronizador não derruba o turno (e conta como tentativa)', async () => {
  ligar('ligado');
  const { execucao } = await cadastrarLeadDoTurno({ unit: SERRA, leadId: 66, ferramentas: [] }, async () => { throw new Error('franquia fora'); }, deps({}));
  await assert.doesNotReject(execucao!);
});

// ── lista de internos vazia não é "ninguém é interno" ────────────────────────────────────────

test('LIGADA com NUMEROS_INTERNOS vazia ou ausente: ninguém é cadastrado "só por conversar" — falha fechado', async () => {
  ligar('ligado');
  for (const valor of [undefined, '', ' , ', '9464']) {
    if (valor === undefined) delete process.env.NUMEROS_INTERNOS;
    else process.env.NUMEROS_INTERNOS = valor;
    const r = await decidirCadastroDoLead({ unit: SERRA, leadId: 70, legado: SEM_AGENDAR }, deps({ telefone: INTERNO }));
    assert.equal(r.criar, false, String(valor));
    assert.match(r.motivo, /sem-lista/, String(valor));
    // quem agendou segue como segue hoje (não piora)
    assert.deepEqual(await decidirCadastroDoLead({ unit: SERRA, leadId: 71, legado: AGENDOU }, deps({ telefone: INTERNO })), AGENDOU, String(valor));
  }
  assert.equal(triar(PACIENTE, [], undefined).acao, 'sem-lista');
});

test('decisão de rotina é silenciosa no webhook (já está na franquia, esperando a próxima tentativa); a que barra, não', async () => {
  ligar('ligado');
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 72, legado: SEM_AGENDAR }, deps({ situacao: 'na-franquia' }))).silenciosa, true);
  assert.equal((await decidirCadastroDoLead({ unit: SERRA, leadId: 73, legado: SEM_AGENDAR }, deps({ situacao: 'tentou-ha-pouco' }))).silenciosa, true);
  assert.notEqual((await decidirCadastroDoLead({ unit: SERRA, leadId: 74, legado: SEM_AGENDAR }, deps({ telefone: INTERNO }))).silenciosa, true, 'barrou interno aparece no log');
});
