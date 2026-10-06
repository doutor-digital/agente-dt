import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Unidade } from './unidade.js';
import * as c from './consultas.js';
import { criarContexto, type OpcoesContexto, trocarUnidades } from './contexto.js';
import { type DadosDaUnidade, type FranquiaFalsa, subirFranquiaFalsa } from './franquia-falsa.js';
import { ErroDeEntrada } from './travas.js';

const T_SERRA = 'token-serra-0123456789abcdef';
const T_TAUB = 'token-taubate-0123456789abcdef';
const T_SEM_BI = 'token-sem-bi-0123456789abcdef';
const T_ESTRANHO = 'token-estranho-0123456789abcdef';

/** Um agendamento por dia, às 13:00 UTC (10:00 em SP), de 01/01 a 31/07/2026. */
function agendaDiaria(): Record<string, unknown>[] {
  const lista: Record<string, unknown>[] = [];
  for (let d = Date.parse('2026-01-01T13:00:00Z'), i = 1; d <= Date.parse('2026-07-31T13:00:00Z'); d += 86_400_000, i++) {
    lista.push({ idSchedule: i, clientName: `Paciente ${i}`, dateAttendance: new Date(d).toISOString(), statusName: i % 3 ? 'Atendido' : 'Faltou' });
  }
  return lista;
}

const serra: DadosDaUnidade = {
  agendamentos: [
    ...agendaDiaria(),
    // 22:30 em SP do dia 30/09 = 01:30 UTC do dia 01/10: a franquia corta pelo dia UTC com fim exclusivo
    { idSchedule: 9001, clientName: 'Noturno', dateAttendance: '2026-10-01T01:30:00.000Z', statusName: 'Agendado' },
    { idSchedule: 9002, clientName: 'Depois do fim', dateAttendance: '2026-10-01T13:00:00.000Z', statusName: 'Agendado' },
  ],
  pacientes: [
    { idClient: 1, name: 'Ana Souza', whatsapp: '5541999999999', created: '2026-03-01T12:00:00Z', gender: 'F', idade: 40 },
    { idClient: 2, name: 'Bruno Lima', whatsapp: '5541888888888', created: '2026-06-01T12:00:00Z', gender: 'M', idade: 60 },
    { idClient: 3, name: 'Carla Dias', whatsapp: '5541777777777', created: '2026-06-02T12:00:00Z', gender: 'F', idade: 50 },
  ],
  tratamentos: [
    { idTreatment: 1, clientName: 'Ana', created: '2026-02-10T12:00:00Z', category: 'Fisioterapia' },
    { idTreatment: 2, clientName: 'Bruno', created: '2026-05-10T12:00:00Z', category: 'Fisioterapia' },
    { idTreatment: 3, clientName: 'Carla', created: '2026-05-11T12:00:00Z', category: 'Cirurgia' },
  ],
  leads: [
    { idLead: 1, name: 'L1', created: '2026-01-05T12:00:00Z', sourceName: 'Instagram' },
    { idLead: 2, name: 'L2', created: '2026-04-20T12:00:00Z', sourceName: 'Site' },
    { idLead: 3, name: 'L3', created: '2026-04-21T12:00:00Z', sourceName: 'Instagram' },
  ],
  gerais: { sources: [{ idSource: 1, name: 'Site' }, { idSource: 10002, name: 'IA SOFIA' }] },
};

let falsa: FranquiaFalsa;

before(async () => {
  falsa = await subirFranquiaFalsa({
    [T_SERRA]: serra,
    [T_TAUB]: { agendamentos: [{ idSchedule: 1, dateAttendance: '2026-06-10T13:00:00Z', statusName: 'Atendido' }], leads: [{ idLead: 1, created: '2026-03-01T12:00:00Z', sourceName: 'Site' }] },
    [T_SEM_BI]: { semBi: true },
    [T_ESTRANHO]: { formatoEstranho: true },
  });
});
after(() => falsa.fechar());
beforeEach(() => {
  falsa.pedidos.length = 0;
  falsa.falhas.length = 0;
});

function ctx(op: OpcoesContexto = {}, tokens: Record<string, string> = { serra: T_SERRA, taubate: T_TAUB, lajeado: 'token-invalido-0123456789abcdef', 'sem-bi': T_SEM_BI, estranho: T_ESTRANHO }) {
  const unidades = new Map<string, Unidade>(
    Object.entries(tokens).map(([slug, token]) => [slug, { slug, nome: slug, token, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]),
  );
  return criarContexto(unidades, { intervaloMs: 0, ...op, cliente: { esperaBaseMs: 0, log: () => {}, ...op.cliente } });
}

type R = Record<string, any>;

test('agenda de 7 meses: fatias dentro do limite, cada dia contado uma vez', async () => {
  const r = (await c.buscarAgendamentos(ctx(), { unidade: 'serra', inicio: '2026-01-01', fim: '2026-07-31' })) as R;
  const s = r.porUnidade.serra;
  assert.equal(s.ok, true, s.erro);
  assert.equal(s.total, 212); // 01/01 a 31/07 = 212 dias, um agendamento por dia
  assert.equal(new Set(s.itens.map((i: R) => i.idSchedule)).size, s.itens.length);
  // nenhuma requisição levou 400 da franquia falsa (que recusa > 100 dias)
  assert.ok(falsa.pedidos.every((p) => p.caminho === '/api/schedules/search'));
  assert.equal(falsa.pedidos.length, 3); // 3 fatias de até 90 dias, 1 página cada
});

test('consulta às 22h30 do último dia entra; a do dia seguinte não', async () => {
  const r = (await c.buscarAgendamentos(ctx(), { unidade: 'serra', inicio: '2026-09-30', fim: '2026-09-30', maxItens: 10 })) as R;
  const nomes = r.porUnidade.serra.itens.map((i: R) => i.clientName);
  assert.deepEqual(nomes, ['Noturno']);
  assert.equal(r.porUnidade.serra.itens[0].dateAttendanceLocal, '2026-09-30T22:30:00');
});

test('agruparPor statusName e por dia', async () => {
  const r = (await c.buscarAgendamentos(ctx(), { unidade: 'serra', inicio: '2026-01-01', fim: '2026-01-06', agruparPor: 'statusName' })) as R;
  assert.deepEqual(r.porUnidade.serra.agrupado, { Atendido: 4, Faltou: 2 });
  const d = (await c.buscarAgendamentos(ctx(), { unidade: 'serra', inicio: '2026-01-01', fim: '2026-01-02', agruparPor: 'dia' })) as R;
  assert.deepEqual(d.porUnidade.serra.agrupado, { '2026-01-01': 1, '2026-01-02': 1 });
});

test('várias unidades: a que falha aparece, e a rede soma só as que deram certo', async () => {
  const r = (await c.buscarAgendamentos(ctx(), { unidade: ['serra', 'taubate', 'lajeado'], inicio: '2026-06-01', fim: '2026-06-30' })) as R;
  assert.equal(r.porUnidade.serra.total, 30);
  assert.equal(r.porUnidade.taubate.total, 1);
  assert.equal(r.porUnidade.lajeado.ok, false);
  assert.match(r.porUnidade.lajeado.erro, /401/);
  assert.equal(r.rede.total, 31);
  assert.deepEqual(r.rede.unidadesForaDoTotal, ['lajeado']);
  // com várias unidades, o padrão é só totais
  assert.deepEqual(r.porUnidade.serra.itens, []);
});

test('pedido grande demais é recusado antes de chamar a franquia', async () => {
  await assert.rejects(
    c.buscarAgendamentos(ctx({ tetoRequisicoes: 5 }), { unidade: ['serra', 'taubate'], inicio: '2026-01-01', fim: '2026-07-31' }),
    (e: Error) => e instanceof ErroDeEntrada && /pelo menos 6 requisições/.test(e.message),
  );
  assert.equal(falsa.pedidos.length, 0);
});

test('teto de páginas com mais de 100 registros na fatia', async () => {
  const muitos = Array.from({ length: 150 }, (_, i) => ({ idSchedule: i + 1, dateAttendance: '2026-05-05T13:00:00Z', statusName: 'Atendido' }));
  const outra = await subirFranquiaFalsa({ [T_SERRA]: { agendamentos: muitos } });
  try {
    const unidades = new Map<string, Unidade>([['serra', { slug: 'serra', nome: 'Serra', token: T_SERRA, fuso: 'America/Sao_Paulo', baseUrl: outra.url }]]);
    const r = (await c.buscarAgendamentos(criarContexto(unidades, { intervaloMs: 0, tetoPaginas: 1, cliente: { log: () => {} } }), {
      unidade: 'serra',
      inicio: '2026-05-05',
      fim: '2026-05-05',
    })) as R;
    assert.equal(r.porUnidade.serra.total, 100);
    assert.equal(r.porUnidade.serra.truncado, true);
    assert.match(r.porUnidade.serra.aviso, /INCOMPLETO.*mínimo/);
  } finally {
    await outra.fechar();
  }
});

test('cota por unidade: com teto apertado, TODAS leem a sua parte e saem marcadas, nenhuma some', async () => {
  const muitos = Array.from({ length: 450 }, (_, i) => ({ idSchedule: i + 1, dateAttendance: '2026-05-05T13:00:00Z' }));
  const outra = await subirFranquiaFalsa({ a: { agendamentos: muitos }, b: { agendamentos: muitos }, c: { agendamentos: muitos } } as never);
  try {
    const unidades = new Map<string, Unidade>(
      ['a', 'b', 'c'].map((t) => [t, { slug: t, nome: t, token: t, fuso: 'America/Sao_Paulo', baseUrl: outra.url }]),
    );
    const contexto = criarContexto(unidades, { intervaloMs: 0, tetoRequisicoes: 9, cliente: { log: () => {} } });
    const r = (await c.buscarAgendamentos(contexto, { unidade: 'todas', inicio: '2026-05-05', fim: '2026-05-05' })) as R;
    for (const slug of ['a', 'b', 'c']) {
      assert.equal(r.porUnidade[slug].ok, true, slug);
      assert.equal(r.porUnidade[slug].total, 300); // 3 páginas de 100, a cota de cada uma
      assert.equal(r.porUnidade[slug].truncado, true);
    }
    assert.deepEqual(r.rede.unidadesIncompletas, ['a', 'b', 'c']);
    // e o incompleto NÃO foi pro cache: a mesma pergunta com folga lê tudo
    const folga = criarContexto(unidades, { intervaloMs: 0, cliente: { log: () => {} } });
    folga.cache = contexto.cache;
    const r2 = (await c.buscarAgendamentos(folga, { unidade: 'a', inicio: '2026-05-05', fim: '2026-05-05' })) as R;
    assert.equal(r2.porUnidade.a.total, 450);
    assert.equal(r2.porUnidade.a.doCache, undefined);
  } finally {
    await outra.fechar();
  }
});

test('cache: a mesma pergunta não chama a franquia de novo', async () => {
  const contexto = ctx();
  await c.buscarAgendamentos(contexto, { unidade: 'serra', inicio: '2026-03-01', fim: '2026-03-31' });
  const antes = falsa.pedidos.length;
  const r = (await c.buscarAgendamentos(contexto, { unidade: 'serra', inicio: '2026-03-01', fim: '2026-03-31', agruparPor: 'statusName' })) as R;
  assert.equal(falsa.pedidos.length, antes);
  assert.equal(r.porUnidade.serra.doCache, true);
  assert.ok(r.porUnidade.serra.agrupado); // agrupar não exige reler
});

test('formato de resposta desconhecido é ERRO, nunca "zero registros"', async () => {
  const r = (await c.buscarAgendamentos(ctx(), { unidade: 'estranho', inicio: '2026-03-01', fim: '2026-03-31' })) as R;
  assert.equal(r.porUnidade.estranho.ok, false);
  assert.match(r.porUnidade.estranho.erro, /formato/);
});

test('tratamentos e leads cortam pela data de criação no dia local', async () => {
  const t = (await c.buscarTratamentos(ctx(), { unidade: 'serra', inicio: '2026-05-01', fim: '2026-05-31', agruparPor: 'category' })) as R;
  assert.equal(t.porUnidade.serra.total, 2);
  assert.deepEqual(t.porUnidade.serra.agrupado, { Cirurgia: 1, Fisioterapia: 1 });
  const corpo = falsa.pedidos.at(-1)?.corpo as R;
  assert.equal(corpo.initialCreatedDate, '2026-05-01'); // filtro na raiz do corpo
  assert.equal(corpo.filters, undefined);
  const l = (await c.buscarLeads(ctx(), { unidade: 'serra', inicio: '2026-04-01', fim: '2026-04-30' })) as R;
  assert.equal(l.porUnidade.serra.total, 2);
});

test('leads: inicio sem fim é recusado', async () => {
  await assert.rejects(c.buscarLeads(ctx(), { unidade: 'serra', inicio: '2026-04-01' }), /inicio E fim/);
});

test('pacientes: busca por nome e WhatsApp normalizado', async () => {
  const r = (await c.buscarPacientes(ctx(), { unidade: 'serra', nome: 'souza' })) as R;
  assert.equal(r.porUnidade.serra.total, 1);
  assert.equal(r.porUnidade.serra.itens[0].whatsappE164, '+5541999999999');
  await assert.rejects(c.buscarPacientes(ctx(), { unidade: 'serra', nome: 'a' }), ErroDeEntrada);
});

test('paciente_por_id: acha, e "não encontrado" é erro', async () => {
  const r = (await c.pacientePorId(ctx(), { unidade: 'serra', idClient: 2 })) as R;
  assert.equal(r.paciente.name, 'Bruno Lima');
  await assert.rejects(c.pacientePorId(ctx(), { unidade: 'serra', idClient: 999 }), /não encontrado/);
  await assert.rejects(c.pacientePorId(ctx(), { unidade: 'todas', idClient: 2 }), /UMA unidade/);
});

test('pacientes: agruparPor "dia" usa a data de cadastro', async () => {
  const r = (await c.buscarPacientes(ctx(), { unidade: 'serra', agruparPor: 'dia' })) as R;
  assert.deepEqual(r.porUnidade.serra.agrupado, { '2026-03-01': 1, '2026-06-01': 1, '2026-06-02': 1 });
});

test('BI: soma as fatias e pondera a idade média', async () => {
  const r = (await c.bi(ctx(), c.BI.pacientesPorGenero, { unidade: 'serra', inicio: '2026-01-01', fim: '2026-07-31' })) as R;
  const s = r.porUnidade.serra;
  assert.equal(s.total, 3);
  assert.equal(s.fatias, 3);
  assert.deepEqual(s.agrupado, { Feminino: 2, Masculino: 1 });
  assert.equal(s.idadeMedia, 50); // (40 + 60 + 50) / 3 — média de médias daria outro número
  assert.match(s.aviso, /3 fatias/); // a fronteira das fatias do BI não foi verificada na API real
});

test('BI: unidade sem permissão vira ok=false com 403 explicado, e sai do total da rede', async () => {
  const r = (await c.bi(ctx(), c.BI.leadsPorOrigem, { unidade: ['serra', 'taubate', 'sem-bi'], inicio: '2026-01-01', fim: '2026-06-30' })) as R;
  assert.equal(r.porUnidade['sem-bi'].ok, false);
  assert.match(r.porUnidade['sem-bi'].erro, /403.*permissão.*BI/);
  assert.equal(r.rede.total, 4);
  assert.deepEqual(r.rede.agrupado, { Instagram: 2, Site: 2 });
  assert.deepEqual(r.rede.unidadesForaDoTotal, ['sem-bi']);
});

test('dados gerais, listar_unidades sem token, e unidade desconhecida', async () => {
  const r = (await c.dadosGerais(ctx(), { unidade: 'serra', lista: 'sources' })) as R;
  assert.equal(r.porUnidade.serra.total, 2);
  assert.ok(!JSON.stringify(c.listarUnidades(ctx())).includes('token-'));
  await assert.rejects(c.buscarPacientes(ctx(), { unidade: 'xpto' }), /unidade desconhecida ou ambígua: xpto.*Válidas: serra/);
});

test('checar_conexao: token por unidade e consumo medido', async () => {
  const contexto = ctx();
  const r = (await c.checarConexao(contexto, { unidade: ['serra', 'lajeado'] })) as R;
  assert.equal(r.porUnidade.serra.token, 'ok');
  assert.equal(r.porUnidade.serra.pacientesNaFranquia, 3);
  assert.equal(r.porUnidade.lajeado.ok, false);
  assert.equal(r.versaoDaApi[falsa.url], '1.9.3');
  assert.ok(r.consumoDesteMcp.total >= 3);
});

test('trocarUnidades mantém cache e contador', async () => {
  const contexto = ctx();
  await c.buscarAgendamentos(contexto, { unidade: 'serra', inicio: '2026-03-01', fim: '2026-03-02' });
  const antes = contexto.contador.resumo().total;
  trocarUnidades(contexto, new Map([...contexto.unidades].filter(([slug]) => slug === 'serra')));
  assert.deepEqual([...contexto.unidades.keys()], ['serra']);
  const r = (await c.buscarAgendamentos(contexto, { unidade: 'serra', inicio: '2026-03-01', fim: '2026-03-02' })) as R;
  assert.equal(r.porUnidade.serra.doCache, true);
  assert.equal(contexto.contador.resumo().total, antes);
  await assert.rejects(c.buscarPacientes(contexto, { unidade: 'taubate' }), /desconhecida/);
});

test('sem unidade nenhuma (carregando, ou nenhuma com token): erro claro, não "unidade desconhecida"', async () => {
  const vazio = criarContexto(new Map(), { intervaloMs: 0 });
  await assert.rejects(c.buscarPacientes(vazio, { unidade: 'todas' }), /nenhuma unidade disponível agora/);
});

test('nome curto acha o slug longo; ambíguo é recusado', async () => {
  const unidades = new Map<string, Unidade>(
    ['doutor-hernia-serra', 'doutor-hernia-canaa', 'lab-canaa', 'canaa-resgate'].map((slug) => [slug, { slug, nome: slug, token: T_SERRA, fuso: 'America/Sao_Paulo', baseUrl: falsa.url }]),
  );
  const contexto = criarContexto(unidades, { intervaloMs: 0, cliente: { log: () => {} } });
  const r = (await c.buscarPacientes(contexto, { unidade: ['serra', 'doutor-hernia-serra'] })) as R;
  assert.deepEqual(Object.keys(r.porUnidade), ['doutor-hernia-serra']); // o mesmo pedido duas vezes conta uma
  await assert.rejects(c.buscarPacientes(contexto, { unidade: 'canaa' }), /ambígua: canaa/); // doutor-hernia-canaa E lab-canaa
});
