/**
 * Sofia 2.0, ponta a ponta no agente: `agendar_consulta` com a flag do sinal (o modelo manda `pix_antecipado` e isso é o SINAL) e a
 * ferramenta `gerar_sinal_pix` criando o link no Asaas (fetch falso). Prisma, franquia, Kommo e Asaas são falsos: nada sai da máquina.
 * Cobre também a unidade "Resgate", que usa a chave do Asaas da clínica dona, e as falhas (sem chave, 403, baixa desligada).
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { cifrar } from '../lib/integracoes/cofre.js';
import { SpineService } from '../services/spine.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { buildAgendaTools, buildAgendarConsulta, buildConsultarHorarios } from './agenda-tools.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import { feriadoNacional } from '../lib/feriados.js';
import { _depsDoCacheParaTeste, depositoNaMemoria } from '../lib/cache-agenda.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { ID_SINAL_PIX } from '../lib/sinal-pix.js';
import { _semearCrmParaTeste } from '../lib/crm-compartilhado.js';
import { limparCacheEsquema } from '../lib/kommo-schema.js';

const TZ = 'America/Sao_Paulo';
const CHAVE_FIXA = '12.345.678/0001-90';
const CHAVE_DA_CLINICA = '$aact_chave_da_clinica_araguaina_0000000000';

function unidade(over: Record<string, unknown> = {}): Unit {
  return {
    id: 'u-arag',
    slug: 'doutor-hernia-araguaina',
    name: 'Doutor Hérnia Araguaína',
    category: 'saude',
    spineEnabled: true,
    spineToken: 'tok',
    spineAiPaused: false,
    spineBookingRequiresPayment: false,
    acceptsAdvancePayment: true,
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
    pixKey: CHAVE_FIXA,
    pixHolder: 'Clinica Araguaina LTDA',
    sourceProdutos: 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.',
    sinalPixCentavos: 5000,
    ...over,
  } as unknown as Unit;
}

function diaDeTeste(): string {
  let t = Date.now() + 5 * 86_400_000;
  while (feriadoNacional(agoraLocalISO(TZ, new Date(t)).slice(0, 10))) t += 86_400_000;
  return agoraLocalISO(TZ, new Date(t)).slice(0, 10);
}
const DIA = diaDeTeste();

// ── dublês ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const unidades = new Map<string, Unit>();
const chavesPorUnidade = new Map<string, string>(); // unitId -> chave em texto
const sinais: Array<Record<string, any>> = [];
const conversaGravou: Array<{ data: { pagamentoEscolhido?: string } }> = [];
let agendadoPara: string | null = null;
let conversaExiste = true;
let atual: Unit = unidade();

Object.defineProperty(prisma, 'unit', {
  value: {
    findUnique: async ({ where }: { where: { id?: string; slug?: string } }) => (where.id ? unidades.get(where.id) : [...unidades.values()].find((u) => u.slug === where.slug)) ?? null,
  },
  configurable: true,
});
Object.defineProperty(prisma, 'spineLeadLink', {
  value: { findFirst: async () => ({ spineIdClient: 999 }), findUnique: async () => (agendadoPara ? { agendadoPara } : null), upsert: async () => ({}) },
  configurable: true,
});
Object.defineProperty(prisma, 'agendaBlock', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'cardAlert', { value: { findUnique: async () => null, upsert: async () => ({}) }, configurable: true });
Object.defineProperty(prisma, 'conversation', {
  value: {
    updateMany: async (a: { data: { pagamentoEscolhido?: string } }) => (conversaGravou.push(a), { count: 1 }),
    // `agendar_consulta` lê a escolha guardada (pagamentoEscolhido); a ferramenta do sinal só confere que a conversa existe
    findFirst: async (a: { select?: { id?: boolean } }) => (a.select?.id ? (conversaExiste ? { id: 'c1' } : null) : null),
  },
  configurable: true,
});
Object.defineProperty(prisma, 'chaveDeIntegracao', {
  value: {
    findUnique: async ({ where }: { where: { unitId_provedor: { unitId: string } } }) => {
      const unitId = where.unitId_provedor.unitId;
      const chave = chavesPorUnidade.get(unitId);
      const u = unidades.get(unitId);
      if (!chave || !u) return null;
      return { id: `k-${unitId}`, unitId, chaveCifrada: cifrar(chave, process.env.INTEGRACOES_CHAVE_MESTRA || env.SESSION_JWT_SECRET), unit: { slug: u.slug, isActive: true } };
    },
    update: async () => ({}),
  },
  configurable: true,
});
Object.defineProperty(prisma, 'sinalPix', {
  value: {
    findFirst: async ({ where }: any) =>
      sinais.filter((l) => l.unitId === where.unitId && l.leadId === where.leadId && where.status.in.includes(l.status) && l.criadoEm >= where.criadoEm.gte).sort((a, b) => b.criadoEm - a.criadoEm)[0] ?? null,
    count: async ({ where }: any) => sinais.filter((l) => l.unitId === where.unitId && l.criadoEm >= where.criadoEm.gte).length,
    create: async ({ data }: any) => {
      const l = { id: `s${sinais.length + 1}`, status: 'pendente', paymentId: null, criadoEm: new Date(), pagoEm: null, avisadoEm: null, ...data };
      sinais.push(l);
      return l;
    },
  },
  configurable: true,
});

// a trava de geração em produção é uma transação com advisory lock; aqui só confirma que o corpo roda com o `sinalPix` da transação
const travas: string[] = [];
Object.defineProperty(prisma, '$transaction', {
  value: async (fn: (tx: unknown) => Promise<unknown>) => fn({ $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => (travas.push(String(v[0])), 1), sinalPix: (prisma as any).sinalPix }),
  configurable: true,
});

const spine = SpineService as unknown as Record<string, unknown>;
spine.searchSchedules = async () => ({ ok: true, data: { schedules: [], total: 0, pages: 1 } });
spine.createSchedule = async () => ({ ok: true, data: { idSchedule: 101 } });
spine.cancelSchedule = async () => ({ ok: true });
spine.getClient = async () => ({ ok: true, data: { client: { idClient: 9, name: 'Maria Teste', whatsapp: null, schedules: [] } } });

const chamadasAoAsaas: Array<{ url: string; chave: string; corpo: Record<string, unknown> }> = [];
let respostaDoAsaas: { status: number; corpo: unknown } = { status: 200, corpo: { id: '725104409743', url: 'https://www.asaas.com/c/725104409743' } };
globalThis.fetch = (async (url: string, init: RequestInit) => {
  chamadasAoAsaas.push({ url, chave: (init.headers as Record<string, string>).access_token ?? '', corpo: JSON.parse(String(init.body ?? '{}')) });
  return new Response(JSON.stringify(respostaDoAsaas.corpo), { status: respostaDoAsaas.status });
}) as typeof fetch;

const tarefas: Array<{ text: string }> = [];
const kommo = {
  createTask: async (t: { text: string }) => (tarefas.push(t), { id: 1 }),
  getLead: async () => ({ name: 'Maria Teste', responsible_user_id: 7 }),
} as unknown as KommoClient;

// um traceId por teste: o cartão do turno (`agendar_consulta` → `gerar_sinal_pix`) é guardado por ele
let n = 0;
let recorder = { traceId: 'trace-sinal-0', step: async () => undefined } as unknown as TraceRecorder;

beforeEach(() => {
  recorder = { traceId: `trace-sinal-${++n}`, step: async () => undefined } as unknown as TraceRecorder;
  atual = unidade();
  unidades.clear();
  unidades.set(atual.id, atual);
  chavesPorUnidade.clear();
  chavesPorUnidade.set(atual.id, CHAVE_DA_CLINICA);
  sinais.length = 0;
  travas.length = 0;
  conversaGravou.length = 0;
  chamadasAoAsaas.length = 0;
  tarefas.length = 0;
  agendadoPara = `${DIA}T09:00`;
  conversaExiste = true;
  respostaDoAsaas = { status: 200, corpo: { id: '725104409743', url: 'https://www.asaas.com/c/725104409743' } };
  process.env.SINAL_PIX_SLUGS = '*';
  limparCacheEsquema();
  _depsDoCacheParaTeste({ deposito: depositoNaMemoria(), env: {}, registrar: () => undefined });
  _semearCrmParaTeste([]);
  _semearParaTeste([]);
});
after(() => {
  _depsDoCacheParaTeste();
  _semearParaTeste([]);
  delete process.env.SINAL_PIX_SLUGS;
});

type Func = { func: (a: unknown) => Promise<string> };
const agendar = (u: Unit) => buildAgendarConsulta({ unit: u, recorder }) as unknown as Func;
const gerarSinal = (u: Unit) => (buildAgendaTools({ unit: u, recorder, kommo }).find((t) => t.name === 'gerar_sinal_pix') as unknown as Func);

async function primeiroHorario(u: Unit): Promise<string> {
  const consultar = buildConsultarHorarios({ unit: u, recorder, estado: { consultou: false } }) as unknown as Func;
  const texto = await consultar.func({ data: DIA, leadId: 1 });
  const h = /\(\d{4}-\d{2}-\d{2}\): ([\d:, ]+)\./.exec(texto)?.[1].split(', ')[0];
  assert.ok(h, `a grade devolveu horários: ${texto}`);
  return h;
}

test('com a flag: sem a forma de pagamento a consulta NÃO é marcada e a pergunta é "sinal de R$ 50 ou tudo no dia"', async () => {
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta NÃO marcada ainda/);
  assert.match(r, /sinal de R\$ 50 agora por Pix \(a consulta fica R\$ 250, com R\$ 200 no dia\) ou pagar tudo no dia \(R\$ 350\)/);
  assert.match(r, /\[\[botoes: Sinal de R\$ 50 \| Pagar no dia\]\]/);
  assert.doesNotMatch(r, /Pix antecipado \| Na clínica/);
});

test('com a flag: o prompt manda pix_antecipado para o sinal — a conversa guarda sinal_pix, a ferramenta manda gerar o link e nunca a chave fixa', async () => {
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'pix_antecipado' });
  assert.match(r, /^Consulta marcada para /);
  assert.match(r, /Ele escolheu o SINAL: chame gerar_sinal_pix AGORA/);
  assert.match(r, /R\$ 250: R\$ 50 de sinal pelo Pix agora \(envie o link\) \+ R\$ 200 no dia/);
  assert.ok(!r.includes(CHAVE_FIXA), r);
  assert.doesNotMatch(r, /chave Pix é|ESCOLHEU PIX ANTECIPADO/);
  assert.equal(conversaGravou[0]!.data.pagamentoEscolhido, 'sinal_pix', 'a régua da chave fixa lê isto e não roda');
});

test('com a flag: na_clinica diz R$ 350 no dia, sem Pix, sem sinal', async () => {
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'na_clinica' });
  assert.match(r, /PAGAR TUDO NO DIA: R\$ 350 na clínica\. NÃO gere Pix, NÃO mencione sinal nem chave Pix/);
  assert.ok(!r.includes(CHAVE_FIXA));
  assert.equal(conversaGravou[0]!.data.pagamentoEscolhido, 'na_clinica');
});

test('com a flag mas fontes sem os dois preços: tudo como sempre (chave fixa), sem ferramenta de sinal', async () => {
  const u = unidade({ sourceProdutos: 'Consulta de avaliação.' });
  unidades.set(u.id, u);
  const hora = await primeiroHorario(u);
  const r = await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'pix_antecipado' });
  assert.match(r, /Ele escolheu PIX ANTECIPADO/);
  assert.equal(conversaGravou[0]!.data.pagamentoEscolhido, 'pix_antecipado');
  assert.equal(gerarSinal(u), undefined);
});

test('gerar_sinal_pix SEM argumentos (o cartão é o da consulta marcada no turno): cria o link PIX de R$ 50 na conta da clínica e o devolve', async () => {
  const hora = await primeiroHorario(atual);
  await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 28000001, formaPagamento: 'pix_antecipado' });
  const r = await gerarSinal(atual).func({});
  assert.match(r, /Pix do sinal de R\$ 50 gerado/);
  assert.ok(r.includes('https://www.asaas.com/c/725104409743'), r);
  assert.match(r, /NUNCA envie chave Pix/);
  assert.equal(chamadasAoAsaas.length, 1);
  assert.match(chamadasAoAsaas[0]!.url, /\/v3\/paymentLinks$/);
  assert.equal(chamadasAoAsaas[0]!.chave, CHAVE_DA_CLINICA);
  assert.equal(chamadasAoAsaas[0]!.corpo.value, 50);
  assert.equal(chamadasAoAsaas[0]!.corpo.billingType, 'PIX');
  assert.equal(chamadasAoAsaas[0]!.corpo.externalReference, 'sofia-sinal:doutor-hernia-araguaina:28000001');
  assert.equal(chamadasAoAsaas[0]!.corpo.name, 'Sinal consulta Doutor Hérnia Araguaína');
  // de novo: o MESMO link, sem nova chamada ao Asaas
  const outra = await gerarSinal(atual).func({ leadId: 28000001 });
  assert.ok(outra.includes('https://www.asaas.com/c/725104409743'));
  assert.match(outra, /MESMO link/);
  assert.equal(chamadasAoAsaas.length, 1);
  assert.equal(sinais.length, 1);
  assert.ok(travas.every((t) => t === 'sinal-pix:u-arag:28000001') && travas.length === 2, `uma trava por geração: ${travas}`);
});

test('sem consulta marcada no cartão a ferramenta não gera sinal', async () => {
  agendadoPara = null;
  const r = await gerarSinal(atual).func({ leadId: 5 });
  assert.match(r, /Ainda não há consulta marcada/);
  assert.equal(chamadasAoAsaas.length, 0);
});

test('Resgate: a unidade usa a chave do Asaas da CLÍNICA dona (araguaina-resgate → doutor-hernia-araguaina)', async () => {
  const resgate = unidade({ id: 'u-arag-resgate', slug: 'araguaina-resgate', name: 'Araguaína - Resgate' });
  unidades.set(resgate.id, resgate);
  // a chave está só na dona; a unidade Resgate não tem linha no cofre
  const r = await gerarSinal(resgate).func({ leadId: 77 });
  assert.match(r, /Pix do sinal de R\$ 50 gerado/);
  assert.equal(chamadasAoAsaas.length, 1);
  assert.equal(chamadasAoAsaas[0]!.chave, CHAVE_DA_CLINICA);
  assert.equal(chamadasAoAsaas[0]!.corpo.name, 'Sinal consulta Doutor Hérnia Araguaína');
  assert.equal(chamadasAoAsaas[0]!.corpo.externalReference, 'sofia-sinal:araguaina-resgate:77');
  assert.equal(sinais[0]!.unitId, 'u-arag-resgate', 'o sinal é da unidade do paciente; a chave é que vem da dona');
});

test('NUNCA a conta de outra clínica: unidade sem chave e sem dona com chave não gera link, cai na equipe', async () => {
  const marabaResgate = unidade({ id: 'u-maraba-resgate', slug: 'maraba-resgate', name: 'Marabá - Resgate' });
  unidades.set(marabaResgate.id, marabaResgate); // a dona doutor-hernia-maraba nem existe; a chave de Araguaína está no cofre
  const r = await gerarSinal(marabaResgate).func({ leadId: 78 });
  assert.equal(chamadasAoAsaas.length, 0, 'não tocou no Asaas de ninguém');
  assert.match(r, /NÃO consegui gerar o Pix do sinal agora/);
  assert.match(r, /a equipe envia o Pix do sinal por aqui em instantes/);
  assert.equal(tarefas.length, 1);
  assert.match(tarefas[0]!.text, /ENVIAR O PIX DO SINAL · maraba-resgate/);
  assert.match(tarefas[0]!.text, /a unidade não tem a chave do Asaas no cofre/);
  assert.equal(sinais.length, 0);
});

test('unidade que não é Resgate e não tem chave própria também não pega a de outra', async () => {
  chavesPorUnidade.clear();
  const r = await gerarSinal(atual).func({ leadId: 79 });
  assert.equal(chamadasAoAsaas.length, 0);
  assert.match(r, /NÃO consegui gerar/);
  assert.equal(tarefas.length, 1);
});

test('Asaas negou (403, chave só de leitura): a Sofia não fala do erro, não inventa Pix, e a SDR recebe a tarefa', async () => {
  respostaDoAsaas = { status: 403, corpo: { errors: [{ description: 'sem permissão' }] } };
  const r = await gerarSinal(atual).func({ leadId: 80 });
  assert.match(r, /NÃO consegui gerar o Pix do sinal agora/);
  assert.match(r, /NÃO invente link nem chave Pix e NÃO conte ao paciente o motivo/);
  assert.doesNotMatch(r, /403|aact|permissão/);
  assert.equal(tarefas.length, 1);
  assert.match(tarefas[0]!.text, /o Asaas recusou ou não respondeu/);
  assert.equal(sinais.length, 0);
});

test('baixa desligada (SINAL_PIX_SLUGS vazio): não gera link que ninguém vai dar baixa — a equipe manda o Pix', async () => {
  delete process.env.SINAL_PIX_SLUGS;
  const r = await gerarSinal(atual).func({ leadId: 81 });
  assert.equal(chamadasAoAsaas.length, 0);
  assert.match(r, /NÃO consegui gerar/);
  assert.match(tarefas[0]!.text, /a baixa automática do sinal não está ligada nesta unidade/);
});

test('baixa em "só no papel" (seco): o worker não grava nada, então a ferramenta também NÃO gera link real — a equipe manda o Pix', async () => {
  _semearParaTeste([{ slug: atual.slug, automacao: ID_SINAL_PIX, estado: 'seco' }]);
  const r = await gerarSinal(atual).func({ leadId: 82 });
  assert.equal(chamadasAoAsaas.length, 0);
  assert.match(r, /NÃO consegui gerar/);
  assert.match(tarefas[0]!.text, /a baixa automática do sinal não está ligada nesta unidade/);
  assert.equal(sinais.length, 0);
});

test('o leadId que o modelo escreve NÃO troca o cartão da consulta marcada no turno (id alucinado ou induzido não cria sinal em outro paciente)', async () => {
  const hora = await primeiroHorario(atual);
  await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 28000001, formaPagamento: 'pix_antecipado' });
  const r = await gerarSinal(atual).func({ leadId: 99999999 });
  assert.match(r, /Pix do sinal de R\$ 50 gerado/);
  assert.equal(chamadasAoAsaas[0]!.corpo.externalReference, 'sofia-sinal:doutor-hernia-araguaina:28000001');
  assert.equal(sinais[0]!.leadId, '28000001');
});

test('sem marcação no turno e sem conversa para o leadId do modelo: nada é gerado', async () => {
  conversaExiste = false;
  const r = await gerarSinal(atual).func({ leadId: 424242 });
  assert.match(r, /Não achei esta conversa/);
  assert.equal(chamadasAoAsaas.length, 0);
});
