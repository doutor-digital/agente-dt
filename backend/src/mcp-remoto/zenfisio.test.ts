import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agendamentoNormalizado,
  criarContextoZenfisio,
  hojeNoFuso,
  resolverContaZenfisio,
  zenfisioAgenda,
  zenfisioUnidades,
  type AgendamentoBruto,
  type ContaZenfisio,
} from './zenfisio.js';
import { listarIntegracoes } from './integracoes.js';

const AGORA = Date.parse('2026-11-06T14:00:00Z'); // 11:00 em Brasília
const COMENTARIO = 'paciente relatou hérnia L5 e pediu sigilo 63999990000';

function ag(id: number, data: string, status: string, extra: Partial<AgendamentoBruto> = {}): AgendamentoBruto {
  return {
    id, date: `${data} 00:00:00`, start: '09:00:00', end: '09:50:00', contact_id: 100 + (id % 5), contact_name: `Paciente ${id % 5}`,
    user_id: 1, user_name: 'Dra. Ana', status_id: status === 'Atendido' ? 3 : status === 'Faltou' ? 4 : 1, status_name: status,
    agreement_name: 'Particular', procedure_name: null, room_name: null, appointment_package_id: null, appointment_package_name: null,
    confirmed: 0, repetition: null, block_schedules: 0, blocking_reason: null, professional_archived: 0,
    comment: COMENTARIO, path_appointment_audio: 'https://audio/sigiloso.mp3', created_at: '2026-10-01 10:00:00', updated_at: '2026-10-01 10:00:00',
    ...extra,
  };
}

/** Fonte falsa que pagina de 25 em 25, como a API. */
function conta(registros: AgendamentoBruto[], op: { formatoQuebrado?: boolean } = {}) {
  const pedidos: Array<{ caminho: string; query?: Record<string, unknown> }> = [];
  const c: ContaZenfisio = {
    slug: 'instituto-trauma',
    nome: 'Instituto Trauma',
    fonte: {
      entityId: async () => 42739,
      get: async <T>(caminho: string, query?: Record<string, string | number | boolean | undefined>) => {
        pedidos.push({ caminho, query });
        if (caminho === '/units') return [{ id: 42739, name: 'Instituto Trauma', is_main_entity: 1 }] as T;
        if (op.formatoQuebrado) return { pagina: [] } as T;
        const page = Number(query?.page ?? 1);
        const last = Math.max(1, Math.ceil(registros.length / 25));
        return { current_page: page, last_page: last, total: registros.length, data: registros.slice((page - 1) * 25, page * 25) } as T;
      },
    },
  };
  return { c, pedidos };
}

const ctxCom = (c: ContaZenfisio, maxPaginas?: number) => criarContextoZenfisio(new Map([[c.slug, c]]), { agora: () => AGORA, maxPaginas });

test('hojeNoFuso usa o fuso de São Paulo', () => {
  assert.equal(hojeNoFuso(Date.parse('2026-11-07T02:30:00Z')), '2026-11-06'); // 23:30 em Brasília
});

test('agendamentoNormalizado não leva comentário nem áudio', () => {
  const n = agendamentoNormalizado(ag(1, '2026-11-03', 'Atendido'));
  assert.equal(n.inicio, '09:00');
  assert.equal(n.minutos, 50);
  const texto = JSON.stringify(n);
  assert.ok(!texto.includes('hérnia') && !texto.includes('63999990000') && !texto.includes('audio'));
});

test('agenda: resumo com atendidos, faltas, taxa de falta e passados sem desfecho', async () => {
  const regs = [
    ag(1, '2026-11-03', 'Atendido'), ag(2, '2026-11-03', 'Atendido'), ag(3, '2026-11-04', 'Atendido'),
    ag(4, '2026-11-04', 'Faltou'), ag(5, '2026-11-05', 'Agendado'), // dia passado sem desfecho
    ag(6, '2026-11-10', 'Agendado'), // futuro: não entra na taxa
  ];
  const { c, pedidos } = conta(regs);
  const r = await zenfisioAgenda(ctxCom(c), { inicio: '2026-11-01', fim: '2026-11-15' });
  assert.equal(r.resumo.agendamentos, 6);
  assert.equal(r.resumo.atendidos, 3);
  assert.equal(r.resumo.faltas, 1);
  assert.equal(r.resumo.taxaDeFalta, 25);
  assert.equal(r.resumo.passadosSemDesfecho, 1);
  assert.deepEqual(r.resumo.porStatus, { Agendado: 2, Atendido: 3, Faltou: 1 });
  assert.equal(pedidos[0]!.caminho, '/entity/42739/appointments');
  assert.equal(pedidos[0]!.query?.start_date, '2026-11-01');
  assert.ok(!JSON.stringify(r).includes(COMENTARIO));
});

test('agenda: percorre todas as páginas e guarda em cache', async () => {
  const regs = Array.from({ length: 60 }, (_, i) => ag(i + 1, '2026-11-02', i % 4 === 0 ? 'Faltou' : 'Atendido'));
  const { c, pedidos } = conta(regs);
  const ctx = ctxCom(c);
  const r = await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', maxItens: 5 });
  assert.equal(r.resumo.agendamentos, 60);
  assert.equal(r.itens.length, 5);
  assert.equal(r.itensOmitidos, 55);
  assert.equal(pedidos.length, 3);
  assert.equal(r.truncado, undefined);
  await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', status: 'faltou' });
  assert.equal(pedidos.length, 3, 'segunda leitura veio do cache');
});

test('agenda: passou do teto de páginas → truncado, aviso e fora do cache', async () => {
  const regs = Array.from({ length: 80 }, (_, i) => ag(i + 1, '2026-11-02', 'Atendido'));
  const { c, pedidos } = conta(regs);
  const ctx = ctxCom(c, 2);
  const r = await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05' });
  assert.equal(r.truncado, true);
  assert.match(r.aviso!, /INCOMPLETOS/);
  assert.equal(r.resumo.agendamentos, 50);
  await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05' });
  assert.equal(pedidos.length, 4, 'leitura incompleta não foi para o cache');
});

test('agenda: bloqueios de horário saem da conta por padrão', async () => {
  const regs = [ag(1, '2026-11-03', 'Atendido'), ag(2, '2026-11-03', 'Agendado', { block_schedules: 1, contact_name: null, blocking_reason: 'Almoço' })];
  const { c } = conta(regs);
  const r = await zenfisioAgenda(ctxCom(c), { inicio: '2026-11-01', fim: '2026-11-05' });
  assert.equal(r.resumo.agendamentos, 1);
  assert.equal(r.bloqueiosIgnorados, 1);
  const com = await zenfisioAgenda(ctxCom(c), { inicio: '2026-11-01', fim: '2026-11-05', incluirBloqueios: true });
  assert.equal(com.resumo.agendamentos, 2);
});

test('agenda: filtros por status sem acento, profissional e pacote; agrupar por profissional', async () => {
  const regs = [
    ag(1, '2026-11-03', 'Atendido', { user_name: 'Dra. Ana', appointment_package_id: 7, appointment_package_name: 'Pacote Coluna 10 sessões' }),
    ag(2, '2026-11-03', 'Faltou', { user_name: 'Dr. Bruno' }),
    ag(3, '2026-11-04', 'Atendido', { user_name: 'Dr. Bruno', start: '10:00:00', end: '11:00:00' }),
  ];
  const { c } = conta(regs);
  const ctx = ctxCom(c);
  assert.equal((await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', profissional: 'bruno' })).resumo.agendamentos, 2);
  assert.equal((await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', status: 'FALTOU' })).resumo.agendamentos, 1);
  assert.equal((await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', comPacote: true })).resumo.agendamentos, 1);
  assert.equal((await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', pacote: 'coluna' })).resumo.comPacote, 1);
  const g = await zenfisioAgenda(ctx, { inicio: '2026-11-01', fim: '2026-11-05', agruparPor: 'profissional' });
  assert.equal(g.itens.length, 0, 'agrupado: só os números por padrão');
  const bruno = (g.grupos as Array<Record<string, unknown>>).find((x) => x.profissional === 'Dr. Bruno')!;
  assert.equal(bruno.agendamentos, 2);
  assert.equal(bruno.taxaDeFalta, 50);
  assert.equal(bruno.minutosAtendidos, 60);
});

test('agenda: valida datas, período máximo e formato desconhecido', async () => {
  const { c } = conta([]);
  const ctx = ctxCom(c);
  await assert.rejects(zenfisioAgenda(ctx, { inicio: '06/11/2026', fim: '2026-11-06' }), /AAAA-MM-DD/);
  await assert.rejects(zenfisioAgenda(ctx, { inicio: '2026-11-06', fim: '2026-11-01' }), /inicio depois de fim/);
  await assert.rejects(zenfisioAgenda(ctx, { inicio: '2026-01-01', fim: '2026-06-01' }), /até 93 dias/);
  const quebrado = conta([], { formatoQuebrado: true });
  await assert.rejects(zenfisioAgenda(ctxCom(quebrado.c), { inicio: '2026-11-01', fim: '2026-11-02' }), /formato desconhecido/);
});

test('resolverContaZenfisio: uma conta dispensa a unidade; sem conta explica', () => {
  const { c } = conta([]);
  assert.equal(resolverContaZenfisio(ctxCom(c), undefined).slug, 'instituto-trauma');
  assert.equal(resolverContaZenfisio(ctxCom(c), 'trauma').slug, 'instituto-trauma');
  assert.throws(() => resolverContaZenfisio(criarContextoZenfisio(new Map()), 'x'), /painel de integrações/);
});

test('zenfisio_unidades mostra o entityId usado e as unidades da conta', async () => {
  const { c } = conta([]);
  const r = await zenfisioUnidades(ctxCom(c));
  assert.deepEqual(r.contas[0], {
    unidade: 'instituto-trauma', nome: 'Instituto Trauma', ok: true, entityIdUsado: 42739,
    unidadesDaConta: [{ id: 42739, nome: 'Instituto Trauma', principal: true }],
  });
});

test('listar_integracoes marca a unidade com ZenFisio', () => {
  const r = listarIntegracoes({ franquia: new Map(), kommo: new Map([['instituto-trauma', { nome: 'Instituto Trauma' }]]), bling: new Map(), zenfisio: new Map([['instituto-trauma', { nome: 'Instituto Trauma' }]]) });
  assert.equal(r.comZenfisio, 1);
  assert.equal(r.unidades[0]!.zenfisio, true);
  assert.ok(r.unidades[0]!.ferramentas.some((f) => f.startsWith('zenfisio_*')));
});
