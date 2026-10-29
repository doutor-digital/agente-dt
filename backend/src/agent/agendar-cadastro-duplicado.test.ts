/**
 * `agendar_consulta` × paciente com a consulta marcada pela recepção em OUTRO cadastro (Timbó, 29/10/2026).
 *
 * Ana Christina: a IA usava o idClient 374228; a recepção criou outro cadastro da mesma paciente (374234, mesmo nome e
 * telefone) e marcou nele sexta 16:00. Quando ela disse "ok, obrigada", a IA tentou 16:00 no 374228, a franquia disse
 * "ocupado" (pela consulta DELA) e a IA ofereceu outros horários a quem já estava marcada.
 *
 * Aqui: a franquia é falsa (mesmo molde de `pagamento-da-unidade-agendar.test.ts`) e a recusa tem de acontecer ANTES do
 * "ocupado", apontar o cadastro certo, vincular o lead a ele e nunca criar consulta nova.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService, type SpineSchedule } from '../services/spine.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { buildAgendarConsulta } from './agenda-tools.js';
import { gravarCampoDaRegra } from './tools.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import { feriadoNacional } from '../lib/feriados.js';
import { _depsDoCacheParaTeste, depositoNaMemoria } from '../lib/cache-agenda.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { _semearCrmParaTeste } from '../lib/crm-compartilhado.js';

const TZ = 'America/Sao_Paulo';
const ANA = 374228;
const ANA_DOBRO = 374234;
const FONE = '5547991234567';

const unidade = {
  id: 'u-timbo',
  slug: 'doutor-hernia-timbo',
  name: 'Timbó',
  spineEnabled: true,
  spineToken: 'tok',
  spineAiPaused: false,
  spineBookingRequiresPayment: false,
  spineTimezone: TZ,
  businessHoursTimezone: TZ,
  spineAgendaStart: '08:00',
  spineAgendaEnd: '18:00',
  spineLunchStart: '12:00',
  spineLunchEnd: '13:00',
  spineAgendaDays: [0, 1, 2, 3, 4, 5, 6],
  spineSlotMinutes: 60,
  spineDayHours: null,
  spineStaffPorTurno: null,
  acceptsAdvancePayment: false,
} as unknown as Unit;

function diaDeTeste(): string {
  let t = Date.now() + 5 * 86_400_000;
  while (feriadoNacional(agoraLocalISO(TZ, new Date(t)).slice(0, 10))) t += 86_400_000;
  return agoraLocalISO(TZ, new Date(t)).slice(0, 10);
}
const DIA = diaDeTeste();

const links: Array<{ update: Record<string, unknown>; create: Record<string, unknown> }> = [];
Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => unidade }, configurable: true });
Object.defineProperty(prisma, 'spineLeadLink', {
  value: {
    findFirst: async () => null,
    findUnique: async () => ({ spineIdClient: ANA }),
    upsert: async (a: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
      links.push(a);
      return {};
    },
  },
  configurable: true,
});
Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'conversation', { value: { updateMany: async () => ({ count: 1 }), findFirst: async () => null }, configurable: true });

function marcada(idSchedule: number, hora: string, over: Partial<SpineSchedule> = {}): SpineSchedule {
  return {
    idSchedule, idTreatment: null, idStatus: 37, statusName: 'Agendado', clientName: 'Ana Christina', categoryName: 'Avaliação',
    physicalTherapist: null, dateAttendanceUtc: null, dateAttendanceLocal: `${DIA}T${hora}:00`, dayLocal: DIA, timeLocal: hora,
    isBusy: true, requiresManualValidation: false, ...over,
  };
}

type Cadastro = { idClient: number; name: string | null; whatsapp: string | null; schedules: SpineSchedule[] };
let cadastros: Cadastro[] = [];
let buscaFalha = false;
let leituraFalha = new Set<number>();
let buscas = 0;
let criadas: string[] = [];

const spine = SpineService as unknown as Record<string, unknown>;
spine.searchSchedules = async (_u: Unit, f: { initialDate: string }) => {
  // a grade vê TODAS as consultas dos cadastros: o horário da recepção aparece ocupado
  const schedules = cadastros.flatMap((c) => c.schedules).filter((s) => s.dayLocal === f.initialDate);
  return { ok: true, data: { schedules, total: schedules.length, pages: 1 } };
};
spine.searchClients = async () => {
  buscas++;
  if (buscaFalha) return { ok: false, error: '500 da franquia' };
  return { ok: true, data: { clients: cadastros.map((c) => ({ idClient: c.idClient, name: c.name, whatsapp: c.whatsapp })) } };
};
spine.getClient = async (_u: Unit, id: number) => {
  if (leituraFalha.has(id)) return { ok: false, error: 'timeout' };
  const c = cadastros.find((x) => x.idClient === id);
  return { ok: true, data: { client: c ?? null } };
};
spine.createSchedule = async (_u: Unit, input: { idClient: number; dateAttendanceLocal: string }) => {
  criadas.push(`${input.idClient} ${input.dateAttendanceLocal}`);
  return { ok: true, data: { idSchedule: 9000 } };
};
spine.cancelSchedule = async () => ({ ok: true });

const passos: Array<{ title: string; payload?: unknown }> = [];
const recorder = {
  traceId: 'trace-dobro',
  step: async (s: { title: string; payload?: unknown }) => {
    passos.push(s);
  },
} as unknown as TraceRecorder;

const kommo = {
  getLead: async () => ({ _embedded: { contacts: [{ id: 7 }] } }),
  getContactPhone: async () => `+${FONE}`,
  setLeadCustomFieldValue: async () => undefined,
  getLead2: async () => null,
} as unknown as KommoClient;

beforeEach(() => {
  links.length = 0;
  passos.length = 0;
  buscas = 0;
  criadas = [];
  buscaFalha = false;
  leituraFalha = new Set();
  _depsDoCacheParaTeste({ deposito: depositoNaMemoria(), env: {}, registrar: () => undefined });
  _semearCrmParaTeste([]);
  _semearParaTeste([]);
  cadastros = [
    { idClient: ANA, name: 'Ana Christina Souza', whatsapp: FONE, schedules: [] },
    { idClient: ANA_DOBRO, name: 'ANA CHRISTINA SOUZA', whatsapp: `+${FONE}`, schedules: [marcada(555, '16:00')] },
  ];
});

type Func = { func: (a: unknown) => Promise<string> };
// `semKommo`: quando a marcação vai até o fim, os carimbos no cartão rodam em segundo plano e precisariam de um Kommo inteiro
const agendar = (comKommo: boolean) => buildAgendarConsulta({ unit: unidade, recorder, kommo: comKommo ? kommo : undefined }) as unknown as Func;
const pedir = (hora: string, extra: Record<string, unknown> = {}, comKommo = true) =>
  agendar(comKommo).func({ idClient: ANA, data: DIA, hora, diaConfirmado: true, formaPagamento: 'na_clinica', leadId: 4984700, ...extra });

test('Timbó: a consulta está no OUTRO cadastro e o horário pedido é o dela — confirma, não diz "ocupado" nem oferece outro', async () => {
  const r = await pedir('16:00');
  assert.match(r, /^RECUSADO: este paciente já tem consulta marcada na clínica em /);
  assert.match(r, /16:00/);
  assert.match(r, /exatamente o horário que ele pediu: está marcado/);
  assert.match(r, /NÃO ofereça outro dia/);
  assert.doesNotMatch(r, /não está mais disponível|acabou de ser ocupado|ofereça outro\./);
  assert.match(r, /mais de um cadastro — idClient 374228 e 374234/);
  assert.deepEqual(criadas, [], 'nada foi criado na franquia');
});

test('Timbó: o lead passa a apontar para o cadastro e a consulta onde ela está, e o passo fica no rastro', async () => {
  await pedir('16:00');
  assert.equal(links.length, 1);
  assert.equal(links[0].update.spineIdClient, ANA_DOBRO);
  assert.equal(links[0].update.spineIdSchedule, 555);
  assert.equal(links[0].update.agendadoPara, `${DIA}T16:00`);
  const passo = passos.find((p) => /já tem consulta na clínica/.test(p.title));
  assert.ok(passo, 'registrou o passo');
  assert.match(passo.title, /OUTRO cadastro do paciente \(idClient 374234, não o 374228\)/);
  assert.deepEqual((passo.payload as { cadastrosDuplicados: number[] }).cadastrosDuplicados, [ANA_DOBRO]);
});

test('a consulta do outro cadastro é em outro horário: recusa e manda confirmar ESSE (não marca a segunda)', async () => {
  const r = await pedir('10:00');
  assert.match(r, /^RECUSADO: este paciente já tem consulta marcada na clínica em /);
  assert.match(r, /16:00/);
  assert.match(r, /Confirme esse dia e hora com o paciente/);
  assert.doesNotMatch(r, /exatamente o horário que ele pediu/);
  assert.deepEqual(criadas, []);
});

test('telefone no outro formato (sem o 9º dígito, sem o +55): continua sendo o mesmo cadastro duplicado', async () => {
  cadastros[1].whatsapp = '(47) 9123-4567';
  cadastros[0].whatsapp = '+5547991234567';
  const r = await pedir('16:00');
  assert.match(r, /^RECUSADO: este paciente já tem consulta marcada/);
});

test('mãe e filha no mesmo telefone (nome diferente) NÃO são o mesmo paciente: horário ocupado segue como ocupado', async () => {
  cadastros[1].name = 'Maria Souza';
  const r = await pedir('16:00');
  assert.match(r, /não está mais disponível/);
  assert.equal(links.length, 0, 'não vinculou o cartão ao cadastro de outra pessoa');
  assert.deepEqual(criadas, []);
});

test('mesmo nome com telefone diferente NÃO é duplicado', async () => {
  cadastros[1].whatsapp = '5547988880000';
  const r = await pedir('16:00');
  assert.match(r, /não está mais disponível/);
  assert.equal(links.length, 0);
});

test('consulta já passada ou desmarcada no outro cadastro não conta', async () => {
  cadastros[1].schedules = [
    marcada(1, '09:00', { idStatus: 57, statusName: 'Desmarcado', isBusy: false, requiresManualValidation: true }),
    marcada(2, '09:00', { dayLocal: '2020-01-01', dateAttendanceLocal: '2020-01-01T09:00:00' }),
  ];
  const r = await pedir('16:00', {}, false);
  assert.match(r, /Consulta marcada para/, 'o horário está livre e a paciente não tem consulta de pé: marca');
  assert.deepEqual(criadas, [`${ANA} ${DIA}T16:00:00`]);
});

test('lado seguro: a busca de cadastros falhou e o horário aparece ocupado — NÃO oferece outro, manda conferir com a equipe', async () => {
  buscaFalha = true;
  const r = await pedir('16:00');
  assert.match(r, /NÃO consegui conferir/);
  assert.match(r, /NÃO ofereça outro horário/);
  assert.match(r, /confirmar com a equipe/);
  assert.doesNotMatch(r, /RECUSADO|já tem consulta marcada|não está mais disponível/);
  assert.ok(passos.some((p) => /não consegui conferir os cadastros/.test(p.title)));
  assert.deepEqual(criadas, []);
});

test('lado seguro: o cadastro irmão não pôde ser lido e o horário aparece ocupado — mesma resposta', async () => {
  leituraFalha = new Set([ANA_DOBRO]);
  const r = await pedir('16:00');
  assert.match(r, /NÃO consegui conferir/);
  assert.match(r, /NÃO ofereça outro horário/);
});

test('lado seguro: nem o cadastro do paciente pôde ser lido e o horário aparece ocupado — mesma resposta', async () => {
  leituraFalha = new Set([ANA]);
  const r = await pedir('16:00');
  assert.match(r, /NÃO consegui conferir/);
  assert.match(r, /NÃO ofereça outro horário/);
  assert.deepEqual(criadas, []);
});

test('a busca falhou mas o horário está livre: marca como antes (a falha só muda o que se diz de "ocupado")', async () => {
  buscaFalha = true;
  const r = await pedir('10:00', {}, false);
  assert.match(r, /Consulta marcada para/);
  assert.deepEqual(criadas, [`${ANA} ${DIA}T10:00:00`]);
});

test('caso Bebedouro (cadastro único): a consulta que a recepção marcou no próprio cadastro recusa, e o vínculo fica no mesmo idClient', async () => {
  cadastros = [{ idClient: ANA, name: 'Ana Christina Souza', whatsapp: FONE, schedules: [marcada(777, '16:00')] }];
  const r = await pedir('10:00');
  assert.match(r, /^RECUSADO: este paciente já tem consulta marcada na clínica em /);
  assert.doesNotMatch(r, /mais de um cadastro/);
  assert.equal(links[0].update.spineIdClient, ANA);
  assert.equal(links[0].update.spineIdSchedule, 777);
  assert.deepEqual(criadas, []);
});

test('cadastro único e horário realmente ocupado por outra pessoa: segue "não está mais disponível" (e nem procura duplicado à toa se não há telefone)', async () => {
  cadastros = [
    { idClient: ANA, name: 'Ana Christina Souza', whatsapp: null, schedules: [] },
    { idClient: 4321, name: 'Pedro Alves', whatsapp: '5547977770000', schedules: [marcada(888, '16:00', { clientName: 'Pedro Alves' })] },
  ];
  const semFone = { getLead: async () => ({}), getContactPhone: async () => null } as unknown as KommoClient;
  const r = await (buildAgendarConsulta({ unit: unidade, recorder, kommo: semFone }) as unknown as Func).func({
    idClient: ANA, data: DIA, hora: '16:00', diaConfirmado: true, leadId: 4984700,
  });
  assert.match(r, /não está mais disponível/);
  assert.equal(buscas, 0, 'sem telefone não há prova de "mesma pessoa": não procura');
});

test('remarcando não passa por esta conferência (a consulta existente é justamente a que se troca)', async () => {
  const r = await pedir('10:00', { remarcando: true }, false);
  assert.match(r, /Consulta marcada para/);
  assert.equal(buscas, 0);
});

test('o cadastro tem outro telefone que o do lead: a recusa de "é de outra pessoa" continua valendo e não se procura duplicado', async () => {
  cadastros[0].whatsapp = '5547955550000';
  const r = await pedir('10:00');
  assert.match(r, /NÃO é o deste paciente/);
  assert.equal(buscas, 0);
  assert.equal(links.length, 0);
});

// ── Carimbos "feito por = IA" / "Situação = Agendado" só com marcação da IA no turno ─────────────────────────────────────
// Timbó, 29/10/2026: o modelo chamou agendar_consulta (que falhou) e a captura de campos EM PARALELO, que gravou os dois
// carimbos antes do resultado.

type Regra = Parameters<typeof gravarCampoDaRegra>[0]['rule'];
const regra = (nome: string, toolName: string): Regra =>
  ({ toolName, kommoFieldId: 11, kommoFieldName: nome, kommoFieldType: 'select', kommoFieldEnums: null, updatesLeadTitle: false, enabled: true }) as unknown as Regra;
const FEITO_POR = regra('⬢ Agendamento feito por', 'registra_agendamento_por');
const SITUACAO = regra('✓ Situação da consulta', 'registra_situacao_consulta');

let seqTrace = 0;
function turnoNovo() {
  const gravados: string[] = [];
  const passosDoTurno: string[] = [];
  const rec = { traceId: `trace-carimbo-${++seqTrace}`, step: async (p: { title: string }) => void passosDoTurno.push(p.title) } as unknown as TraceRecorder;
  const k = { setLeadCustomFieldValue: async (_l: number, _f: number, _t: string, v: unknown) => void gravados.push(String(v)) } as unknown as KommoClient;
  const gravar = (rule: Regra, value: string) => gravarCampoDaRegra({ rule, kommo: k, recorder: rec, tz: TZ, leadId: 4984700, value });
  return { rec, gravados, passosDoTurno, gravar };
}

test('carimbo: "feito por = IA" e "Agendado" sem marcação da IA no turno são recusados e NADA é gravado', async () => {
  const t = turnoNovo();
  const a = await t.gravar(FEITO_POR, 'IA');
  const b = await t.gravar(SITUACAO, 'Agendado');
  assert.match(a, /^RECUSADO/);
  assert.match(b, /^RECUSADO/);
  assert.match(a, /nenhuma marcação sua deu certo neste turno/);
  assert.deepEqual(t.gravados, []);
  assert.ok(t.passosDoTurno.some((x) => /sem marcação da IA neste turno/.test(x)), 'fica no rastro');
});

test('carimbo: outros valores desses campos e outros campos continuam livres (Humano, Confirmado, Queixa)', async () => {
  const t = turnoNovo();
  assert.match(await t.gravar(FEITO_POR, 'Humano'), /^OK/);
  assert.match(await t.gravar(SITUACAO, 'Confirmado'), /^OK/);
  assert.match(await t.gravar(regra('★ Queixa', 'registra_queixa'), 'Dor lombar'), /^OK/);
  assert.deepEqual(t.gravados, ['Humano', 'Confirmado', 'Dor lombar']);
});

test('carimbo, Timbó em paralelo: agendar_consulta RECUSA (a recepção já marcou) e o carimbo disparado junto não grava', async () => {
  const t = turnoNovo();
  const ferramenta = buildAgendarConsulta({ unit: unidade, recorder: t.rec, kommo }) as unknown as Func;
  const [resAgendar, resFeitoPor, resSituacao] = await Promise.all([
    ferramenta.func({ idClient: ANA, data: DIA, hora: '16:00', diaConfirmado: true, formaPagamento: 'na_clinica', leadId: 4984700 }),
    t.gravar(FEITO_POR, 'IA'),
    t.gravar(SITUACAO, 'Agendado'),
  ]);
  assert.match(resAgendar, /^RECUSADO/);
  assert.match(resFeitoPor, /^RECUSADO/);
  assert.match(resSituacao, /^RECUSADO/);
  assert.deepEqual(t.gravados, []);
});

test('carimbo, caso normal em paralelo: a IA MARCA e o carimbo avulso, pedido junto (antes ou depois), grava', async () => {
  cadastros = [{ idClient: ANA, name: 'Ana Christina Souza', whatsapp: FONE, schedules: [] }];
  const t = turnoNovo();
  const ferramenta = buildAgendarConsulta({ unit: unidade, recorder: t.rec }) as unknown as Func;
  const [resAgendar, resFeitoPor] = await Promise.all([
    ferramenta.func({ idClient: ANA, data: DIA, hora: '10:00', diaConfirmado: true, formaPagamento: 'na_clinica', leadId: 4984700 }),
    t.gravar(FEITO_POR, 'IA'), // chamado ANTES de a ferramenta de agendar começar a rodar
  ]);
  assert.match(resAgendar, /Consulta marcada para/);
  assert.match(resFeitoPor, /^OK/);
  // e depois do resultado, no turno seguinte da mesma conversa de ferramentas
  assert.match(await t.gravar(SITUACAO, 'Agendado'), /^OK/);
  assert.deepEqual(t.gravados, ['IA', 'Agendado']);
});

test('carimbo: marcação de OUTRO turno não vale (o estado é por turno)', async () => {
  cadastros = [{ idClient: ANA, name: 'Ana Christina Souza', whatsapp: FONE, schedules: [] }];
  const antes = turnoNovo();
  await (buildAgendarConsulta({ unit: unidade, recorder: antes.rec }) as unknown as Func).func({
    idClient: ANA, data: DIA, hora: '10:00', diaConfirmado: true, formaPagamento: 'na_clinica', leadId: 4984700,
  });
  const depois = turnoNovo();
  assert.match(await depois.gravar(FEITO_POR, 'IA'), /^RECUSADO/);
  assert.deepEqual(depois.gravados, []);
});

test('carimbo: o pedido de carimbo chega ANTES de a ferramenta de agendar começar (ordem do modelo) e ainda assim grava quando ela marca', async () => {
  cadastros = [{ idClient: ANA, name: 'Ana Christina Souza', whatsapp: FONE, schedules: [] }];
  const t = turnoNovo();
  const ferramenta = buildAgendarConsulta({ unit: unidade, recorder: t.rec }) as unknown as Func;
  const carimbo = t.gravar(FEITO_POR, 'IA');
  await new Promise((r) => setTimeout(r, 30));
  const resAgendar = await ferramenta.func({ idClient: ANA, data: DIA, hora: '10:00', diaConfirmado: true, formaPagamento: 'na_clinica', leadId: 4984700 });
  assert.match(resAgendar, /Consulta marcada para/);
  assert.match(await carimbo, /^OK/);
  assert.deepEqual(t.gravados, ['IA']);
});
