/**
 * Chave `pix-depois-de-marcar` (decisão do João, 27/11/2026): `agendar_consulta` marca com o DIA confirmado e SEM a forma de pagamento;
 * depois de marcar, a unidade com sinal ganha a oferta única do sinal e quem não responde paga na clínica. Frases reais do relatório
 * ops/relatorios/2026-11-27-por-que-sofia-nao-converte.md (L3-13: "Na clínica mesmo, pago quando for"). Prisma, franquia, Kommo e Asaas são falsos.
 */
import { renderRulesGlobal } from './prompt-composer.js';
import { instrucaoReservaSemMarcar } from './reserva-sem-marcar.js';
import { porQueNaoReservar } from './agenda-tools.js';
import { degrauDoPixNaoSeAplica } from '../lib/follow-up-worker.js';
import { composeSystemPrompt } from './prompt-composer.js';
import { gravarRecusaDoSinal, recusouOSinal } from './pix-depois-de-marcar.js';
import type { Fala } from './repeticao.js';
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
import { pixDoSinalDoTurno } from './sinal-pix-tool.js';

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
    findMany: async ({ where }: any) =>
      sinais.filter((l) => l.clinica === where.clinica && l.leadId === where.leadId && where.status.in.includes(l.status) && l.criadoEm >= where.criadoEm.gte).sort((a, b) => b.criadoEm - a.criadoEm),
    count: async ({ where }: any) => sinais.filter((l) => l.clinica === where.clinica && l.criadoEm >= where.criadoEm.gte).length,
    create: async ({ data }: any) => {
      const l = { id: `s${sinais.length + 1}`, status: 'pendente', paymentId: null, criadoEm: new Date(), pagoEm: null, avisadoEm: null, ...data };
      sinais.push(l);
      return l;
    },
    updateMany: async ({ where, data }: any) => {
      const l = sinais.find((x) => x.id === where.id);
      if (l) Object.assign(l, data);
      return { count: l ? 1 : 0 };
    },
    deleteMany: async ({ where }: any) => {
      const i = sinais.findIndex((x) => x.id === where.id);
      if (i >= 0) sinais.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
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
// Pix copia-e-cola de verdade (BR Code): nome e cidade do recebedor têm espaço
const PIX = '00020126580014br.gov.bcb.pix0136a1b2c3d4-0000-1111-2222-333344445555520400005303986540550.005802BR5920ATTIVA CORPO E MENTE6009ARAGUAINA62290525sofiasinalaraguaina2800016304A1B2';
const QR_OK = { id: 'qr_725104409743', payload: PIX };
let respostaDoAsaas: { status: number; corpo: unknown } = { status: 200, corpo: QR_OK };
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  // leitura da chave Pix da conta (GET /pix/addressKeys): não conta como escrita
  if (String(url).includes('/pix/addressKeys')) {
    return new Response(JSON.stringify({ data: [{ key: 'a1b2c3d4-0000-1111-2222-333344445555', status: 'ACTIVE', type: 'EVP' }] }), { status: 200 });
  }
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
  respostaDoAsaas = { status: 200, corpo: QR_OK };
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


const CHAVE = 'pix-depois-de-marcar';
const ligar = (slug = 'doutor-hernia-araguaina') => _semearParaTeste([{ slug, automacao: CHAVE, estado: 'ligado' }]);

test('DESLIGADA (padrão): nada muda — sem a forma de pagamento a consulta NÃO é marcada', async () => {
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta NÃO marcada ainda/);
  assert.match(r, /falta: 1\) como ele prefere garantir|garantir a consulta: sinal/);
  assert.equal(conversaGravou.length, 0);
});

test('LIGADA + sinal: marca com o dia confirmado e SEM a forma de pagamento; oferece o sinal UMA vez e o preço não muda', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta marcada para /);
  assert.match(r, /NÃO foi perguntada e NÃO é para perguntar antes/);
  assert.match(r, /R\$ 350 pagando tudo no dia, ou R\$ 250 garantindo com sinal de R\$ 50 agora por Pix \(R\$ 200 no dia\) — o preço é o de sempre, nada muda/);
  assert.match(r, /\[\[botoes: Quero o Pix \| Pago no dia\]\]/);
  assert.match(r, /UMA vez/);
  assert.match(r, /NUNCA cobre o Pix mais de uma vez/);
  assert.match(r, /gerar_sinal_pix com o leadId desta conversa/);
  assert.ok(!r.includes(CHAVE_FIXA), 'nunca a chave fixa');
  // a oferta do Pix NÃO é desligada: nada gravado como "na_clinica" (a lista «agendados sem Pix» continua vendo a pessoa)
  assert.ok(conversaGravou.every((g) => (g.data as { pagamentoEscolhido?: string | null }).pagamentoEscolhido === null), 'sem escolha dita, NUNCA se grava "na_clinica" (só se limpa a escolha velha)');
});

test('LIGADA: a confirmação do dia CONTINUA obrigatória ("consegue vir mesmo?") e a recusa não pergunta forma de pagamento', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, leadId: 1 });
  assert.match(r, /^Consulta NÃO marcada ainda/);
  assert.match(r, /CONSEGUE ir nesse dia/);
  assert.doesNotMatch(r, /forma de pagamento preenchido|garantir a consulta|\[\[botoes: Sinal/);
  assert.match(r, /NÃO pergunte forma de pagamento/);
  assert.equal(conversaGravou.length, 0);
});

test('LIGADA: "Na clínica mesmo, pago quando for" (L3-13) — se o paciente já disse, a forma dita vale e é gravada', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'na_clinica' });
  assert.match(r, /PAGAR TUDO NO DIA: R\$ 350 na clínica/);
  assert.equal(conversaGravou[0]!.data.pagamentoEscolhido, 'na_clinica');
});

test('LIGADA: quem já pediu o Pix por conta própria segue o caminho do sinal (gera o link depois de marcar)', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1, formaPagamento: 'pix_antecipado' });
  assert.match(r, /Ele escolheu o SINAL: chame gerar_sinal_pix AGORA/);
  assert.equal(conversaGravou[0]!.data.pagamentoEscolhido, 'sinal_pix');
});

test('LIGADA sem sinal na unidade (chave Pix fixa): marca, vale pagar na clínica e isso fica GRAVADO (a régua não cobra Pix de quem nunca escolheu)', async () => {
  const u = unidade({ sinalPixCentavos: null });
  unidades.set(u.id, u);
  ligar(u.slug);
  const hora = await primeiroHorario(u);
  const r = await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta marcada para /);
  assert.match(r, /vale PAGAR NA CLÍNICA/);
  assert.match(r, /NÃO ofereça Pix nem valor antecipado, NÃO envie chave Pix/);
  assert.ok(!r.includes(CHAVE_FIXA));
  assert.equal(conversaGravou[0]!.data.pagamentoEscolhido, 'na_clinica');
});

test('Boa Vista (taxa de reserva obrigatória): NADA muda com a chave ligada — a ferramenta responde igualzinho, ligada ou desligada', async () => {
  const u = unidade({ slug: 'doutor-hernia-boa-vista', spineBookingRequiresPayment: true, sinalPixCentavos: null });
  unidades.set(u.id, u);
  const hora = await primeiroHorario(u);
  const desc = (buildAgendarConsulta({ unit: u, recorder }) as unknown as { description: string }).description;
  const semChave = await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  const semDia = await agendar(u).func({ idClient: 9, data: DIA, hora, leadId: 1 });
  ligar(u.slug);
  const descLigada = (buildAgendarConsulta({ unit: u, recorder }) as unknown as { description: string }).description;
  assert.equal(descLigada, desc);
  assert.match(descLigada, /taxa é OBRIGATÓRIA/);
  assert.doesNotMatch(descLigada, /NÃO pergunte a forma de pagamento antes de marcar/);
  assert.equal(await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 }), semChave);
  assert.equal(await agendar(u).func({ idClient: 9, data: DIA, hora, leadId: 1 }), semDia);
  assert.match(semDia, /^Consulta NÃO marcada ainda/, 'a confirmação do dia segue exigida');
});

test('Timbó (sem antecipado): nada muda com a chave ligada — "na clínica" implícito, sem oferta de Pix', async () => {
  const u = unidade({ slug: 'doutor-hernia-timbo', acceptsAdvancePayment: false, sinalPixCentavos: null });
  unidades.set(u.id, u);
  ligar(u.slug);
  const hora = await primeiroHorario(u);
  const r = await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta marcada para /);
  assert.doesNotMatch(r, /NÃO foi perguntada/);
});

test('LIGADA: a descrição da ferramenta não manda mais escolher a forma de pagamento antes de marcar', () => {
  ligar();
  const d = (buildAgendarConsulta({ unit: atual, recorder }) as unknown as { description: string }).description;
  assert.match(d, /NÃO pergunte a forma de pagamento antes de marcar/);
  assert.match(d, /confirmar que CONSEGUE ir/);
  assert.doesNotMatch(d, /escolher como garantir|escolher a forma de pagamento/);
});

test('o prompt: o passo da forma de pagamento sai de ANTES de marcar só com a chave ligada', () => {
  const desligada = renderRulesGlobal(atual);
  assert.match(desligada, /dia → horário → dados → sinal \(Pix\)/);
  ligar();
  const ligada = renderRulesGlobal(atual);
  assert.match(ligada, /marcar \(sem perguntar a forma de pagamento\) → oferta do sinal \(Pix\), uma vez, DEPOIS de marcar/);
  assert.doesNotMatch(ligada, /dados → sinal \(Pix\)\./);
  // os botões de exemplo não ensinam mais a pergunta de pagamento antes de marcar
  assert.match(desligada, /"Sinal de R\$ 50" ou "Pagar no dia"/);
  assert.doesNotMatch(ligada, /"Sinal de R\$ 50" ou "Pagar no dia"|"Pix antecipado" ou "Na clínica"/);
});

test('a refeita de "disse que reservou sem marcar" não manda checar "como vai pagar" com a chave ligada', () => {
  assert.match(instrucaoReservaSemMarcar(false, false), /já disse como vai pagar/);
  const com = instrucaoReservaSemMarcar(false, true);
  assert.doesNotMatch(com, /como vai pagar/);
  assert.match(com, /chame agendar_consulta AGORA/);
  assert.equal(instrucaoReservaSemMarcar(true, true), instrucaoReservaSemMarcar(true), 'Timbó segue com a dele');
});

test('remarcação não passa pela porta, ligada ou não', () => {
  assert.equal(porQueNaoReservar({ remarcando: true, pixDepois: true }), null);
});

test('a oferta depois de marcar chama gerar_sinal_pix e devolve o MESMO link se chamar de novo (não cobra duas vezes)', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  const g = gerarSinal(atual);
  const a = await g.func({ leadId: 1 });
  const b = await g.func({ leadId: 1 });
  assert.match(a, /Pix|código|link/i);
  assert.equal(sinais.length, 1, 'um único sinal no banco');
  assert.equal(chamadasAoAsaas.length, 1, 'um único Pix criado no Asaas');
  assert.match(b, /MESMO link|mesmo/i);
});

test('a régua do Pix (follow-up): com sinal, quem não escolheu NADA não é cobrado em duplicidade; sem sinal, só a escolha gravada "na_clinica" o poupa', () => {
  const degrau = { soPix: true };
  // unidade com sinal: o degrau «só Pix» (chave fixa) nunca roda, tenha ou não escolha gravada
  assert.equal(degrauDoPixNaoSeAplica(degrau, null, atual), true);
  assert.equal(degrauDoPixNaoSeAplica(degrau, 'sinal_pix', atual), true);
  // unidade com chave fixa: sem escolha gravada o degrau rodaria — por isso a ferramenta grava "na_clinica" (teste acima)
  const fixa = unidade({ sinalPixCentavos: null });
  assert.equal(degrauDoPixNaoSeAplica(degrau, null, fixa), false);
  assert.equal(degrauDoPixNaoSeAplica(degrau, 'na_clinica', fixa), true);
});

// ── devolução do sênior (27/11) ────────────────────────────────────────────────────────────────────────────────────────────────

test('3) unidade com chave Pix fixa + chave ligada: o modelo de confirmação NÃO diz "a vaga é garantida com o PIX: <chave>" e segue "na clínica"', () => {
  const u = unidade({ sinalPixCentavos: null, clinicAddress: 'Rua A, 1' });
  const antes = composeSystemPrompt({ unit: u });
  assert.match(antes, /A vaga é garantida com o pagamento antecipado no PIX: 12\.345\.678\/0001-90/);
  ligar(u.slug);
  const depois = composeSystemPrompt({ unit: u });
  assert.doesNotMatch(depois, /A vaga é garantida com o pagamento antecipado no PIX/);
  assert.ok(!depois.includes('PIX: 12.345.678/0001-90'));
  assert.match(depois, /vale pagar na clínica, no dia\. NÃO escreva "a vaga é garantida com o PIX"/);
  assert.match(depois, /✨ Valor: R\$ 350 no dia, na clínica/);
  assert.match(depois, /O pagamento é feito no dia, na clínica/);
  // Boa Vista e Timbó: o modelo de sempre
  const bv = unidade({ slug: 'doutor-hernia-boa-vista', sinalPixCentavos: null, spineBookingRequiresPayment: true, clinicAddress: 'Rua A, 1' });
  ligar(bv.slug);
  assert.match(composeSystemPrompt({ unit: bv }), /Pagamento antecipado recebido — o horário está garantido/);
});

test('4) com sinal e a forma NÃO dita: a escolha VELHA da conversa é limpa (não carimba "¤ Pagamento antecipado" com a decisão antiga)', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.equal(conversaGravou.length, 1);
  const g = conversaGravou[0] as unknown as { data: { pagamentoEscolhido: string | null }; where: Record<string, unknown> };
  assert.equal(g.data.pagamentoEscolhido, null, 'a escolha antiga é zerada');
  assert.deepEqual(g.where.pagamentoEscolhido, { not: null }, 'só mexe em quem tem escolha antiga');
});

test('nit) "Pago no dia" depois da oferta do sinal é gravado como na_clinica (só com a oferta antes, e nunca por cima de sinal_pix)', async () => {
  const oferta: Fala = { papel: 'ia', texto: '✅ Marcado: segunda 08h. Quer sair por R$ 250? É só o sinal de R$ 50 no Pix.' };
  assert.equal(recusouOSinal([oferta, { papel: 'paciente', texto: 'Pago no dia' }]), true);
  assert.equal(recusouOSinal([oferta, { papel: 'paciente', texto: 'pago na clínica mesmo' }]), false, 'só a frase curta de resposta');
  assert.equal(recusouOSinal([oferta, { papel: 'paciente', texto: 'Quero o Pix' }]), false);
  assert.equal(recusouOSinal([{ papel: 'ia', texto: 'Qual horário fica melhor?' }, { papel: 'paciente', texto: 'Pago no dia' }]), false, 'sem oferta de sinal antes, não é resposta a nada');
  await gravarRecusaDoSinal('u-arag', 1);
  const g = conversaGravou[conversaGravou.length - 1] as unknown as { data: { pagamentoEscolhido: string }; where: Record<string, unknown> };
  assert.equal(g.data.pagamentoEscolhido, 'na_clinica');
  assert.equal(g.where.pagamentoEscolhido, null, 'só quando ainda não há escolha');
});
