/**
 * O resultado de uma onda para o gestor: as contas puras e a leitura completa com banco, Kommo e franquia de mentira.
 * Regra de ouro conferida aqui: o que não dá para medir vem `null` com o motivo, e nenhum telefone sai.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import {
  atribuirMeta, contarAgendaram, contarResponderam, custoDaOnda, diasDosEnvios, enviosPorHora, funilDoBanco, mensagensPorCartao, umaLinhaPorDia,
  type EnviosDaOnda, type LinhaDeCusto, type LinhaDeTemplate,
} from './disparo/resultado.js';
import { CACHE_MS, _limparCache, lerExternos, lerResultado, type Leituras, type PessoaEnviada } from './disparo/resultado-dados.js';

const D = (iso: string) => new Date(iso);

// ── funil ──────────────────────────────────────────────────────────────────────────────────────────────────

test('funil: a conta fecha (selecionados = enviados + falhas + pendentes + descartados) e SAIR é subconjunto dos enviados', () => {
  const f = funilDoBanco({ enviado: 80, enviando: 2, pendente: 10, falhou: 3, saiu: 4, descartado: 5 }, 3);
  assert.deepEqual(f, { selecionados: 104, enviados: 83, falhas: 3, pendentes: 12, saiu: 3, descartados: 6 });
  assert.equal(f.enviados + f.falhas + f.pendentes + f.descartados, f.selecionados);
});

test('funil: quem pediu SAIR antes de receber não é enviado nem "saiu" da campanha: é descartado', () => {
  const f = funilDoBanco({ saiu: 2 }, 0);
  assert.equal(f.enviados, 0);
  assert.equal(f.saiu, 0);
  assert.equal(f.descartados, 2);
});

test('funil: onda sem ninguém é tudo zero (não null: isto é o banco)', () => {
  assert.deepEqual(funilDoBanco({}, 0), { selecionados: 0, enviados: 0, falhas: 0, pendentes: 0, saiu: 0, descartados: 0 });
});

test('envios por hora: hora cheia em UTC, do mais antigo ao mais novo', () => {
  const r = enviosPorHora([D('2026-10-28T13:59:59Z'), D('2026-10-28T12:01:00Z'), D('2026-10-28T12:59:00Z'), D('2026-10-28T13:00:00Z')]);
  assert.deepEqual(r, [{ hora: '2026-10-28T12:00:00.000Z', enviados: 2 }, { hora: '2026-10-28T13:00:00.000Z', enviados: 2 }]);
  assert.deepEqual(enviosPorHora([]), []);
});

test('dias dos envios: meia-noite UTC de cada ponta, fim exclusivo no dia seguinte', () => {
  const d = diasDosEnvios(D('2026-10-28T23:30:00Z'), D('2026-10-30T01:00:00Z'));
  assert.equal(d.de.toISOString(), '2026-10-28T00:00:00.000Z');
  assert.equal(d.ate.toISOString(), '2026-10-30T00:00:00.000Z');
  assert.equal(d.fimExclusivo.toISOString(), '2026-10-31T00:00:00.000Z');
});

// ── Meta: só atribui quando a conta fecha ───────────────────────────────────────────────────────────────────

const envios = (extra: Partial<EnviosDaOnda> = {}): EnviosDaOnda => ({ confirmados: 100, incertos: 0, deOutrasOndas: 0, deOutrasOndasDoModelo: 0, ...extra });
const tpl = (extra: Partial<LinhaDeTemplate> = {}): LinhaDeTemplate => ({ sent: 100, delivered: 92, read: 61, syncedAt: D('2026-10-29T03:00:00Z'), ...extra });
const cst = (extra: Partial<LinhaDeCusto> = {}): LinhaDeCusto => ({ pricingCategory: 'MARKETING', volume: 92, costUsd: 4.5, syncedAt: D('2026-10-29T03:00:00Z'), ...extra });

test('Meta: sent bate com o que a onda mandou → entregues, lidas e custo, com a hora da atualização', () => {
  const m = atribuirMeta(envios(), [tpl({ sent: 60, delivered: 55, read: 30, syncedAt: D('2026-10-29T03:00:00Z') }), tpl({ sent: 40, delivered: 37, read: 31, syncedAt: D('2026-10-28T03:00:00Z') })], [cst({ volume: 45, costUsd: 2.25 }), cst({ volume: 47, costUsd: 2.25 })]);
  assert.equal(m.entregues, 92);
  assert.equal(m.lidas, 61);
  assert.equal(m.custoUsd, 4.5);
  assert.equal(m.entreguesAtualizadoEm?.toISOString(), '2026-10-28T03:00:00.000Z', 'vale a linha mais antiga');
  assert.equal(m.motivoEntregues, null);
  assert.equal(m.motivoCusto, null);
});

test('Meta: tabela vazia → null com o motivo (e distingue "nunca gravou" de "falta este modelo/dia")', () => {
  const sem = atribuirMeta(envios(), [], [], { template: true, custo: true });
  assert.equal(sem.entregues, null);
  assert.equal(sem.custoUsd, null);
  assert.match(sem.motivoEntregues!, /nenhuma linha desta unidade[\s\S]*whatsapp_business_management/);
  const falta = atribuirMeta(envios(), [], [], { template: false, custo: false });
  assert.match(falta.motivoEntregues!, /não tem linhas deste modelo nos dias/);
});

test('Meta: mais envios na Meta do que a onda mandou → há envio de outra origem, não atribui', () => {
  const m = atribuirMeta(envios(), [tpl({ sent: 130 })], [cst()]);
  assert.equal(m.entregues, null);
  assert.equal(m.lidas, null);
  assert.match(m.motivoEntregues!, /130 envios[\s\S]*a onda mandou 100[\s\S]*outra origem/);
  assert.equal(m.custoUsd, null);
});

test('Meta: o envio incerto cabe no teto (pode ter saído), mas o piso é o confirmado', () => {
  assert.equal(atribuirMeta(envios({ incertos: 2 }), [tpl({ sent: 102 })], [cst()]).entregues, 92);
  const atrasado = atribuirMeta(envios(), [tpl({ sent: 90 })], [cst()]);
  assert.equal(atrasado.entregues, null);
  assert.match(atrasado.motivoEntregues!, /ainda não contou todos os envios \(90 de 100\)/);
});

test('Meta: outra onda com o MESMO modelo nos mesmos dias → nada é atribuído (a Meta soma as duas)', () => {
  const m = atribuirMeta(envios({ deOutrasOndas: 20, deOutrasOndasDoModelo: 20 }), [tpl()], [cst()]);
  assert.equal(m.entregues, null);
  assert.equal(m.custoUsd, null);
  assert.match(m.motivoEntregues!, /outra onda da mesma conta[\s\S]*20[\s\S]*mesmo modelo/);
});

test('Meta: outra onda com OUTRO modelo não suja o entregue (a Meta separa por modelo), mas suja o custo (é por categoria)', () => {
  const m = atribuirMeta(envios({ deOutrasOndas: 20, deOutrasOndasDoModelo: 0 }), [tpl()], [cst()]);
  assert.equal(m.entregues, 92);
  assert.equal(m.lidas, 61);
  assert.equal(m.custoUsd, null);
  assert.match(m.motivoCusto!, /outra onda da mesma conta[\s\S]*20[\s\S]*categoria/);
});

test('modelo: dia com a linha do idioma E a "não segmentada" vale a do idioma (somar dobraria o sent)', () => {
  const d1 = D('2026-10-28T00:00:00Z');
  const d2 = D('2026-10-29T00:00:00Z');
  const linhas = [
    tpl({ date: d1, language: '', sent: 60 }), tpl({ date: d1, language: 'pt_BR', sent: 60 }),
    tpl({ date: d2, language: '', sent: 40 }), // só a vazia neste dia: vale
    tpl({ date: D('2026-10-30T00:00:00Z'), language: 'en_US', sent: 5 }), // outro idioma: quem consulta já filtra, aqui só não duplica
  ];
  const r = umaLinhaPorDia(linhas, 'pt_BR');
  assert.equal(r.length, 3);
  assert.equal(r.filter((l) => l.date === d1)[0]!.language, 'pt_BR');
  assert.equal(r.filter((l) => l.date === d2)[0]!.language, '');
});

test('Meta: onda sem envio confirmado não tem o que medir', () => {
  const m = atribuirMeta(envios({ confirmados: 0 }), [tpl()], [cst()]);
  assert.equal(m.entregues, null);
  assert.match(m.motivoEntregues!, /ninguém recebeu/);
});

test('custo: só com entregues conferido; marketing de outra origem ou cobrança ainda aberta → null', () => {
  assert.equal(atribuirMeta(envios(), [tpl({ sent: 130 })], [cst()]).custoUsd, null, 'sem entregues conferido não há custo');
  const maisCobrado = atribuirMeta(envios(), [tpl()], [cst({ volume: 140 })]);
  assert.equal(maisCobrado.entregues, 92, 'o entregue continua valendo');
  assert.equal(maisCobrado.custoUsd, null);
  assert.match(maisCobrado.motivoCusto!, /140 mensagens de marketing[\s\S]*outra origem/);
  const aberta = atribuirMeta(envios(), [tpl()], [cst({ volume: 50 })]);
  assert.equal(aberta.custoUsd, null);
  assert.match(aberta.motivoCusto!, /ainda não fechou \(50 cobradas de 92 entregues\)/);
});

test('custo: só soma MARKETING (utilidade e autenticação são de outro assunto)', () => {
  const m = atribuirMeta(envios(), [tpl()], [cst({ costUsd: 4 }), cst({ pricingCategory: 'UTILITY', volume: 500, costUsd: 99 }), cst({ pricingCategory: 'marketing_lite', volume: 0, costUsd: 0.5 })]);
  assert.equal(m.custoUsd, 4.5);
  const semMarketing = atribuirMeta(envios(), [tpl()], [cst({ pricingCategory: 'UTILITY' })]);
  assert.equal(semMarketing.custoUsd, null);
  assert.match(semMarketing.motivoCusto!, /não tem linhas de MARKETING/);
});

test('custo em reais e por resposta/agendamento: sem câmbio ou sem divisor é null, nunca estimado', () => {
  assert.deepEqual(custoDaOnda(4.5, 5.5, 9, 3), { usd: 4.5, brl: 24.75, porResposta: 2.75, porAgendamento: 8.25 });
  assert.deepEqual(custoDaOnda(4.5, null, 9, 3), { usd: 4.5, brl: null, porResposta: null, porAgendamento: null });
  assert.deepEqual(custoDaOnda(4.5, 5.5, 0, null), { usd: 4.5, brl: 24.75, porResposta: null, porAgendamento: null }, 'zero respostas não divide');
  assert.deepEqual(custoDaOnda(null, 5.5, 9, 3), { usd: null, brl: null, porResposta: null, porAgendamento: null });
});

// ── Kommo: respondeu ─────────────────────────────────────────────────────────────────────────────────────────

test('respondeu: só vale a mensagem DEPOIS do envio dela; quem escreveu antes da campanha não conta; uma pessoa conta uma vez', () => {
  const t = (iso: string) => Math.floor(D(iso).getTime() / 1000);
  const pessoas = [
    { leadId: 1, enviadoEm: D('2026-10-28T12:00:00Z') },
    { leadId: 2, enviadoEm: D('2026-10-28T12:00:00Z') },
    { leadId: 3, enviadoEm: D('2026-10-28T12:00:00Z') },
    { leadId: 4, enviadoEm: D('2026-10-28T12:00:00Z') },
  ];
  const entradas = new Map([
    [1, [t('2026-10-28T12:05:00Z'), t('2026-10-28T12:06:00Z')]], // respondeu (duas mensagens = uma pessoa)
    [2, [t('2026-10-28T11:00:00Z')]], // escreveu ANTES
    [3, [t('2026-10-28T12:00:00Z')]], // no mesmo segundo: não é depois
    [99, [t('2026-10-28T13:00:00Z')]], // cartão que não é da onda
  ]);
  assert.equal(contarResponderam(pessoas, entradas), 1);
});

test('respondeu: dois cartões do mesmo contato recebem ambos as respostas (o mapa não perde um deles)', () => {
  const eventos = [
    { leadId: 10, tipo: 'entrada' as const, em: 1000 },
    { leadId: 10, tipo: 'saida' as const, em: 1001 }, // o que a gente mandou não é resposta
    { leadId: 20, tipo: 'entrada' as const, em: 2000 },
  ];
  const r = mensagensPorCartao(new Map([[10, 777], [11, 777], [20, 888]]), eventos);
  assert.deepEqual(r.get(10), [1000]);
  assert.equal(r.has(11), false, 'o cartão 11 não tem evento próprio quando o Kommo devolve o id do cartão');
  const pelaContato = mensagensPorCartao(new Map([[10, 777], [11, 777]]), [{ leadId: 777, tipo: 'entrada', em: 5 }]);
  assert.deepEqual([...pelaContato.keys()].sort(), [10, 11], 'se o evento vier com o id do contato, vale para os dois cartões');
});

// ── franquia: agendou ────────────────────────────────────────────────────────────────────────────────────────

const aval = (clientName: string, dia: string, extra: Record<string, string | null> = {}) => ({ clientName, categoryName: 'AVALIAÇÃO', statusName: 'AGENDADO', dateAttendanceUtc: `${dia}T15:00:00Z`, ...extra });

test('agendou: avaliação NÃO desmarcada para depois do envio, casando o nome inteiro', () => {
  const pessoas = [
    { nomeCompleto: 'Maria da Silva', enviadoEm: D('2026-10-28T12:00:00Z') },
    { nomeCompleto: 'Ana Souza', enviadoEm: D('2026-10-28T12:00:00Z') }, // desmarcou
    { nomeCompleto: 'Rita Lima', enviadoEm: D('2026-10-28T12:00:00Z') }, // avaliação ANTES do envio
    { nomeCompleto: 'Joana Reis', enviadoEm: D('2026-10-28T12:00:00Z') }, // só tem sessão, não avaliação
    { nomeCompleto: 'Paula Dias', enviadoEm: D('2026-10-28T12:00:00Z') }, // não está na agenda
  ];
  const agenda = [
    aval('MARIA DA SILVA', '2026-11-03'),
    aval('Ana Souza', '2026-11-03', { statusName: 'DESMARCADO' }),
    aval('Rita Lima', '2026-10-20'),
    aval('Joana Reis', '2026-11-04', { categoryName: 'SESSÃO' }),
  ];
  assert.deepEqual(contarAgendaram(pessoas, agenda), { agendaram: 1, semConferir: 0 });
});

test('agendou: nome repetido na onda e nome sem sobrenome ficam sem conferir (homônimo não vira dado)', () => {
  const pessoas = [
    { nomeCompleto: 'Maria Silva', enviadoEm: D('2026-10-28T12:00:00Z') },
    { nomeCompleto: 'maria  silva', enviadoEm: D('2026-10-28T12:00:00Z') },
    { nomeCompleto: 'Cleide', enviadoEm: D('2026-10-28T12:00:00Z') },
    { nomeCompleto: null, enviadoEm: D('2026-10-28T12:00:00Z') },
    { nomeCompleto: 'Rosa Alves', enviadoEm: D('2026-10-28T12:00:00Z') },
  ];
  const agenda = [aval('Maria Silva', '2026-11-03'), aval('Cleide', '2026-11-03'), aval('Rosa Alves', '2026-11-03')];
  assert.deepEqual(contarAgendaram(pessoas, agenda), { agendaram: 1, semConferir: 4 });
});

// ── lerExternos: cada fonte falha sozinha ─────────────────────────────────────────────────────────────────────

const unidade = { id: 'u1', slug: 'doutor-hernia-canaa', name: 'Doutor Hérnia Canaã', kommoSubdomain: 'drcanaa', kommoAccessToken: 'tok', spineToken: 'sp', spineTimezone: 'America/Sao_Paulo', businessHoursTimezone: null, metaWabaId: 'waba1', metaPhoneNumberId: 'pn1' } as unknown as Unit;
const pessoa = (leadId: number | null, nome: string | null): PessoaEnviada => ({ kommoLeadId: leadId, nomeCompleto: nome, enviadoEm: D('2026-10-28T12:00:00Z') });

function leituras(extra: Partial<Leituras> = {}): Leituras & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    agora: () => D('2026-10-29T15:00:00Z'),
    cambio: async () => (chamadas.push('cambio'), 5.5),
    mensagensRecebidas: async () => (chamadas.push('kommo'), new Map([[10, [Math.floor(D('2026-10-28T13:00:00Z').getTime() / 1000)]]])),
    agenda: async () => (chamadas.push('agenda'), [aval('Maria da Silva', '2026-11-03')]),
    ...extra,
  };
}

test('externos: Kommo e franquia respondem → números, com a ressalva de limite inferior', async () => {
  const e = await lerExternos(unidade, [pessoa(10, 'Maria da Silva'), pessoa(11, 'Ana Souza'), pessoa(null, 'Cleide')], leituras());
  assert.equal(e.responderam, 1);
  assert.equal(e.agendaram, 1);
  assert.equal(e.cambio, 5.5);
  assert.match(e.notaResponderam!, /limite inferior: 1 destinatário\(s\) sem cartão/);
  assert.match(e.notaAgendaram!, /limite inferior[\s\S]*1 pessoa\(s\) sem nome e sobrenome/);
});

test('externos: Kommo fora do ar → responderam null; a franquia e o câmbio continuam', async () => {
  const e = await lerExternos(unidade, [pessoa(10, 'Maria da Silva')], leituras({ mensagensRecebidas: async () => { throw new Error('503') } }));
  assert.equal(e.responderam, null);
  assert.equal(e.notaResponderam, 'o Kommo não respondeu');
  assert.equal(e.agendaram, 1);
  assert.equal(e.cambio, 5.5);
});

test('externos: agenda cortada ou franquia caída → agendaram null (nunca zero); câmbio que falha → null', async () => {
  const cortada = await lerExternos(unidade, [pessoa(10, 'Maria da Silva')], leituras({ agenda: async () => null, cambio: async () => { throw new Error('rede') } }));
  assert.equal(cortada.agendaram, null);
  assert.match(cortada.notaAgendaram!, /não veio por inteiro/);
  assert.equal(cortada.cambio, null);
  assert.equal(cortada.responderam, 1);
  const caiu = await lerExternos(unidade, [pessoa(10, 'Maria da Silva')], leituras({ agenda: async () => { throw new Error('boom') } }));
  assert.equal(caiu.agendaram, null);
  assert.equal(caiu.notaAgendaram, 'a franquia não respondeu');
});

test('externos: unidade sem Kommo ou sem token da franquia não chama a fonte', async () => {
  const l = leituras();
  const e = await lerExternos({ ...unidade, kommoAccessToken: null, spineToken: null } as unknown as Unit, [pessoa(10, 'Maria da Silva')], l);
  assert.equal(e.responderam, null);
  assert.equal(e.agendaram, null);
  assert.deepEqual(l.chamadas, ['cambio']);
});

// ── a leitura inteira, com o banco de mentira ───────────────────────────────────────────────────────────────

const originais = new Map<string, PropertyDescriptor | undefined>();
function falso(modelo: string, metodos: Record<string, unknown>): void {
  if (!originais.has(modelo)) originais.set(modelo, Object.getOwnPropertyDescriptor(prisma, modelo));
  Object.defineProperty(prisma, modelo, { value: metodos, configurable: true, writable: true });
}
afterEach(() => {
  for (const [modelo, d] of originais) {
    if (d) Object.defineProperty(prisma, modelo, d);
    else delete (prisma as unknown as Record<string, unknown>)[modelo];
  }
  originais.clear();
  _limparCache();
});

interface Cenario {
  template?: Array<{ date?: Date; language?: string; sent: number; delivered: number; read: number; syncedAt: Date }>;
  custo?: Array<{ pricingCategory: string; volume: number; costUsd: number; syncedAt: Date }>;
  outrasOndas?: number;
  outrasDoModelo?: number;
}

function bancoDeMentira(c: Cenario = {}) {
  const consultas: Array<{ modelo: string; metodo: string; where: Record<string, unknown> }> = [];
  const registrar = (modelo: string, metodo: string, a: { where?: Record<string, unknown> } | undefined) => consultas.push({ modelo, metodo, where: a?.where ?? {} });
  const recebidos = [
    { id: 'd1', estado: 'enviado', kommoLeadId: 10, nomeCompleto: 'Maria da Silva', telefone: '5563991021043', enviadoEm: D('2026-10-28T12:10:00Z') },
    { id: 'd2', estado: 'enviado', kommoLeadId: 11, nomeCompleto: 'Ana Souza', telefone: '5563988880002', enviadoEm: D('2026-10-28T12:40:00Z') },
    { id: 'd3', estado: 'saiu', kommoLeadId: 12, nomeCompleto: 'Rita Lima', telefone: '5563977770003', enviadoEm: D('2026-10-28T13:05:00Z') },
  ];
  falso('disparoOnda', {
    findUnique: async (a: { where: { id: string } }) => (a.where.id === 'o1'
      ? { id: 'o1', estado: 'aprovada', etiqueta: 'Outubro Rosa · Dia 2', template: 'canaa_resgate', idioma: 'pt_BR', aprovadaEm: D('2026-10-28T11:00:00Z'), aprovadaPor: 'joao@x.com', pausaMotivo: null, unit: unidade, campanha: { slug: 'outubro-rosa-2026', nome: 'Outubro Rosa' } }
      : null),
  });
  falso('disparoDestinatario', {
    groupBy: async (a: never) => (registrar('disparoDestinatario', 'groupBy', a), [{ estado: 'enviado', _count: 2 }, { estado: 'saiu', _count: 1 }, { estado: 'pendente', _count: 7 }]),
    count: async (a: { where: Record<string, unknown> }) => {
      registrar('disparoDestinatario', 'count', a);
      if ('ondaId' in a.where && typeof a.where.ondaId === 'object') return 'onda' in a.where ? (c.outrasDoModelo ?? 0) : (c.outrasOndas ?? 0); // ondaId: { not }
      if (a.where.estado === 'saiu') return 1;
      if (typeof a.where.estado === 'object') return 0; // falhou/enviando com hora de envio (incertos)
      return 2; // freios: o que a unidade mandou na janela
    },
    aggregate: async (a: never) => (registrar('disparoDestinatario', 'aggregate', a), { _count: 3, _min: { enviadoEm: recebidos[0]!.enviadoEm }, _max: { enviadoEm: recebidos[2]!.enviadoEm } }),
    findMany: async (a: { where: Record<string, unknown>; select: Record<string, boolean> }) => (registrar('disparoDestinatario', 'findMany', a), recebidos.map((r) => Object.fromEntries(Object.keys(a.select).map((k) => [k, (r as Record<string, unknown>)[k]])))),
  });
  falso('unit', { findMany: async (a: never) => (registrar('unit', 'findMany', a), [{ id: 'u1' }]) });
  falso('whatsappTemplateDaily', { findMany: async (a: never) => (registrar('whatsappTemplateDaily', 'findMany', a), c.template ?? []), count: async () => (c.template?.length ? 5 : 0) });
  falso('whatsappCostDaily', { findMany: async (a: never) => (registrar('whatsappCostDaily', 'findMany', a), (c.custo ?? []).map((x) => ({ ...x, costUsd: x.costUsd }))), count: async () => (c.custo?.length ? 5 : 0) });
  return { consultas };
}

test('resultado: onda que não existe → null (o handler responde 404)', async () => {
  bancoDeMentira();
  assert.equal(await lerResultado('nao-existe', leituras()), null);
});

test('resultado: formato do contrato, números do banco/Kommo/Meta e NENHUM telefone na resposta', async () => {
  const { consultas } = bancoDeMentira({
    template: [{ date: D('2026-10-28T00:00:00Z'), language: 'pt_BR', sent: 3, delivered: 3, read: 2, syncedAt: D('2026-10-29T03:00:00Z') }],
    custo: [{ pricingCategory: 'MARKETING', volume: 3, costUsd: 0.1, syncedAt: D('2026-10-29T03:00:00Z') }],
  });
  const r = (await lerResultado('o1', leituras()))!;
  assert.equal(r.onda.id, 'o1');
  assert.equal(r.onda.unidade, 'doutor-hernia-canaa');
  assert.equal(r.onda.campanha, 'outubro-rosa-2026');
  assert.equal(r.onda.aprovadaEm, '2026-10-28T11:00:00.000Z');
  assert.deepEqual(r.funil, { selecionados: 10, enviados: 3, falhas: 0, pendentes: 7, saiu: 1, descartados: 0, entregues: 3, lidas: 2, responderam: 1, agendaram: 1 });
  assert.deepEqual(r.custo, { usd: 0.1, brl: 0.55, porResposta: 0.55, porAgendamento: 0.55, atualizadoEm: '2026-10-29T03:00:00.000Z' });
  assert.deepEqual(r.porHora, [{ hora: '2026-10-28T12:00:00.000Z', enviados: 2 }, { hora: '2026-10-28T13:00:00.000Z', enviados: 1 }]);
  assert.equal(r.freios.tetoPorHora, 30);
  assert.equal(r.freios.tetoPorDia, 100);
  assert.equal(r.freios.maxSair, 3);
  assert.equal(r.freios.enviadosUltimaHora, 2);
  assert.match(r.freios.janela, /^9h às 18h/);
  assert.equal(r.fontes.entregues, 'meta-template-analytics');
  assert.equal(r.fontes.custo, 'meta-pricing-analytics');
  assert.equal(r.fontes.responderam, 'kommo');
  assert.equal(r.fontes.agendaram, 'franquia');
  assert.equal(r.fontes.entreguesAtualizadoEm, '2026-10-29T03:00:00.000Z');
  assert.equal(r.atualizadoEm, '2026-10-29T15:00:00.000Z');
  const json = JSON.stringify(r);
  assert.ok(!/5563\d{8}/.test(json), 'nenhum telefone na resposta');
  assert.ok(!/me tira|sair da lista/i.test(json), 'nenhum texto de SAIR');
  // tudo escopado na onda pedida, e as tabelas da Meta pelo modelo e idioma da onda
  for (const q of consultas.filter((q) => q.modelo === 'disparoDestinatario' && !('unitId' in q.where))) assert.equal(q.where.ondaId, 'o1', `${q.metodo} escopado na onda`);
  const dosModelo = consultas.find((q) => q.modelo === 'whatsappTemplateDaily')!;
  assert.equal(dosModelo.where.templateName, 'canaa_resgate');
  assert.deepEqual(dosModelo.where.language, { in: ['pt_BR', ''] });
  assert.equal(dosModelo.where.unitId, 'u1');
});

test('resultado: tabelas da Meta vazias → entregues/lidas/custo null, fonte "indisponivel" e o motivo escrito; o resto continua', async () => {
  bancoDeMentira({ template: [], custo: [] });
  const r = (await lerResultado('o1', leituras()))!;
  assert.equal(r.funil.entregues, null);
  assert.equal(r.funil.lidas, null);
  assert.deepEqual(r.custo, { usd: null, brl: null, porResposta: null, porAgendamento: null, atualizadoEm: null });
  assert.equal(r.fontes.entregues, 'indisponivel');
  assert.equal(r.fontes.custo, 'indisponivel');
  assert.equal(r.fontes.entreguesAtualizadoEm, null);
  assert.match(r.fontes.notas.entregues!, /nenhuma linha desta unidade/);
  assert.equal(r.funil.responderam, 1, 'o Kommo não depende da Meta');
  assert.equal(r.funil.enviados, 3);
});

test('resultado: outra onda com o mesmo modelo nos mesmos dias → a Meta não é atribuída', async () => {
  bancoDeMentira({ outrasOndas: 30, outrasDoModelo: 30, template: [{ sent: 33, delivered: 30, read: 10, syncedAt: D('2026-10-29T03:00:00Z') }], custo: [{ pricingCategory: 'MARKETING', volume: 30, costUsd: 1, syncedAt: D('2026-10-29T03:00:00Z') }] });
  const r = (await lerResultado('o1', leituras()))!;
  assert.equal(r.funil.entregues, null);
  assert.equal(r.custo.usd, null);
  assert.match(r.fontes.notas.entregues!, /outra onda da mesma conta/);
});

test('cache: duas aberturas seguidas leem Kommo, franquia e câmbio UMA vez; passado o prazo, leem de novo', async () => {
  bancoDeMentira();
  let agora = D('2026-10-29T15:00:00Z');
  const l = leituras({ agora: () => agora });
  await lerResultado('o1', l);
  await lerResultado('o1', l);
  assert.deepEqual(l.chamadas.filter((c) => c === 'kommo'), ['kommo']);
  assert.deepEqual(l.chamadas.filter((c) => c === 'agenda'), ['agenda']);
  agora = new Date(agora.getTime() + CACHE_MS + 1);
  await lerResultado('o1', l);
  assert.equal(l.chamadas.filter((c) => c === 'kommo').length, 2);
});

test('cache: quando uma fonte falha o resultado fica só um minuto (não prende o erro por cinco)', async () => {
  bancoDeMentira();
  let agora = D('2026-10-29T15:00:00Z');
  let kommoFora = true;
  const l = leituras({ agora: () => agora, mensagensRecebidas: async () => { if (kommoFora) throw new Error('503'); return new Map(); } });
  const a = (await lerResultado('o1', l))!;
  assert.equal(a.funil.responderam, null);
  assert.equal(a.fontes.responderam, 'indisponivel');
  kommoFora = false;
  agora = new Date(agora.getTime() + 61_000);
  await new Promise((ok) => setImmediate(ok)); // deixa a leitura anterior registrar o prazo curto
  const b = (await lerResultado('o1', l))!;
  assert.equal(b.funil.responderam, 0, 'um minuto depois já leu de novo');
});

// ── a rota tem a mesma proteção do JSON da onda ──────────────────────────────────────────────────────────

test('rota: GET /disparo/ondas/:id/resultado com a mesma proteção do JSON da onda (chave de serviço ou super-admin)', () => {
  const rotas = readFileSync(new URL('../routes/api.routes.ts', import.meta.url), 'utf8');
  const protecao = (rota: string) => rotas.match(new RegExp(`apiRouter\\.get\\('${rota}',\\s*([^,]+\\([^)]*\\)),`))?.[1];
  assert.ok(protecao('/disparo/ondas/:id/resultado'), 'a rota existe');
  assert.equal(protecao('/disparo/ondas/:id/resultado'), protecao('/disparo/ondas/:id'));
  assert.match(protecao('/disparo/ondas/:id/resultado')!, /chaveDeServicoOuSessao\(requireAuth, requireSuperAdmin\)/);
});
