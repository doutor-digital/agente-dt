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
import { aceitouOPix, formaParaOCarimbo, gravarAceiteDoPix, gravarRecusaDoSinal, OFERTA_DO_SINAL_FEITA, recusouOSinal } from './pix-depois-de-marcar.js';
import { decidirPagamentoAntecipado } from './carimbos-do-agendamento.js';
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
let escolhaNaConversa: string | null = null;
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
    findFirst: async (a: { select?: { id?: boolean; pagamentoEscolhido?: boolean } }) =>
      a.select?.id ? (conversaExiste ? { id: 'c1' } : null) : a.select?.pagamentoEscolhido && escolhaNaConversa ? { pagamentoEscolhido: escolhaNaConversa } : null,
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
  escolhaNaConversa = null;
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
  assert.ok(conversaGravou.every((g) => (g.data as { pagamentoEscolhido?: string | null }).pagamentoEscolhido === 'sinal_oferecido'), 'sem escolha dita, NUNCA se grava "na_clinica": só o marcador da oferta');
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

test('LIGADA, chave Pix FIXA (sem sinal): marca e, DEPOIS, oferece o antecipado UMA vez (R$ 250 pelo Pix ou R$ 350 no dia) — o desconto não some; o marcador fica gravado e NÃO "na_clinica" (a régua segue vendo)', async () => {
  const u = unidade({ sinalPixCentavos: null });
  unidades.set(u.id, u);
  ligar(u.slug);
  const hora = await primeiroHorario(u);
  const r = await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta marcada para /);
  assert.match(r, /ofereça UMA vez o valor antecipado/);
  assert.match(r, /R\$ 350 pagando no dia, ou R\$ 250 pagando antes pelo Pix — o preço é o de sempre/);
  assert.match(r, /\[\[botoes: Quero o Pix \| Pago no dia\]\]/);
  assert.ok(r.includes(CHAVE_FIXA), 'a chave só é mandada se ele escolher; a ferramenta a traz para copiar');
  assert.match(r, /Se disser "pago no dia" ou não responder, vale PAGAR NA CLÍNICA/);
  assert.match(r, /NUNCA cobre o Pix mais de uma vez/);
  assert.deepEqual(conversaGravou.map((g) => (g.data as { pagamentoEscolhido: string }).pagamentoEscolhido), [OFERTA_DO_SINAL_FEITA]);
});

test('LIGADA, chave Pix fixa mas SEM chave cadastrada: não há o que oferecer — marca, vale na clínica (gravado) e a promessa do antecipado vira resumir_lead_para_sdr, nunca só dita', async () => {
  const u = unidade({ sinalPixCentavos: null, pixKey: null });
  unidades.set(u.id, u);
  ligar(u.slug);
  const hora = await primeiroHorario(u);
  const r = await agendar(u).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /^Consulta marcada para /);
  assert.match(r, /vale PAGAR NA CLÍNICA/);
  assert.match(r, /NÃO ofereça Pix nem valor antecipado, NÃO envie chave Pix/);
  assert.match(r, /chame resumir_lead_para_sdr/);
  assert.doesNotMatch(r, /a equipe envia a chave/i);
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

test('3) chave Pix FIXA + chave ligada: o modelo de confirmação segue a forma DITA — o desconto NÃO some e a chave só vai a quem escolheu o Pix', () => {
  const u = unidade({ sinalPixCentavos: null, clinicAddress: 'Rua A, 1' });
  const antes = composeSystemPrompt({ unit: u });
  assert.match(antes, /A vaga é garantida com o pagamento antecipado no PIX: 12\.345\.678\/0001-90/);
  ligar(u.slug);
  const depois = composeSystemPrompt({ unit: u });
  assert.doesNotMatch(depois, /A vaga é garantida com o pagamento antecipado no PIX/);
  assert.match(depois, /✨ Valor: R\$ 250 antecipado \(pago antes da consulta\) ou R\$ 350 no dia/, 'a linha de sempre: o desconto continua');
  assert.doesNotMatch(depois, /R\$ 350 no dia, na clínica/);
  assert.match(depois, /\{SÓ se ele escolheu o Pix antecipado: "Pagando antes pelo Pix, a chave é: 12\.345\.678\/0001-90/);
  assert.match(depois, /Se escolheu pagar no dia ou ainda não respondeu: omita este parágrafo/);
  assert.match(depois, /A oferta do antecipado sai UMA vez, DEPOIS de marcar/);
  assert.doesNotMatch(depois, /NÃO envie chave Pix e NÃO fale de valor antecipado/);
  // sem chave Pix cadastrada: não há o que oferecer — valor do dia, e a promessa fica registrada
  const sem = unidade({ slug: 'doutor-hernia-x', sinalPixCentavos: null, pixKey: null, clinicAddress: 'Rua A, 1' });
  ligar(sem.slug);
  const t = composeSystemPrompt({ unit: sem });
  assert.match(t, /✨ Valor: R\$ 350 no dia, na clínica/);
  assert.match(t, /chame resumir_lead_para_sdr \(a promessa fica registrada\)/);
  assert.doesNotMatch(t, /a equipe envia a chave/);
  // com sinal: a confirmação mostra os dois preços e o link só a quem ACEITOU
  const comSinal = unidade({ clinicAddress: 'Rua A, 1' });
  ligar(comSinal.slug);
  const ts = composeSystemPrompt({ unit: comSinal });
  assert.match(ts, /✨ Valor: R\$ 350 no dia, ou R\$ 250 garantindo com sinal de R\$ 50/);
  assert.match(ts, /\{SÓ se ele ACEITOU o sinal:/);
  assert.doesNotMatch(ts, /\{SÓ se ele escolheu o sinal:/, 'a escolha ainda não houve');
  // Boa Vista: o modelo de sempre
  const bv = unidade({ slug: 'doutor-hernia-boa-vista', sinalPixCentavos: null, spineBookingRequiresPayment: true, clinicAddress: 'Rua A, 1' });
  ligar(bv.slug);
  assert.match(composeSystemPrompt({ unit: bv }), /Pagamento antecipado recebido — o horário está garantido/);
});

test('A.2) com sinal e a forma NÃO dita: marca a OFERTA (sinal_oferecido), nunca "na_clinica"; a escolha velha de outra marcação é trocada', async () => {
  ligar();
  escolhaNaConversa = 'pix_antecipado';
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /ofereça UMA vez o sinal/);
  assert.equal(conversaGravou.length, 1);
  const g = conversaGravou[0] as unknown as { data: { pagamentoEscolhido: string }; where: { OR: unknown[] } };
  assert.equal(g.data.pagamentoEscolhido, OFERTA_DO_SINAL_FEITA);
  assert.equal(g.where.OR, undefined, 'forma não dita agora: a escolha guardada (até na_clinica) é de marcação anterior e é trocada pelo marcador');
});

test('A.2) um "na_clinica" VELHO na conversa (marcação anterior) NÃO bloqueia a oferta do sinal: oferece de novo e troca pelo marcador', async () => {
  ligar();
  escolhaNaConversa = 'na_clinica';
  const hora = await primeiroHorario(atual);
  const r = await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  assert.match(r, /ofereça UMA vez o sinal/);
  assert.doesNotMatch(r, /PAGAR TUDO NO DIA/);
  assert.equal((conversaGravou[0]!.data as { pagamentoEscolhido: string }).pagamentoEscolhido, OFERTA_DO_SINAL_FEITA);
  // o dublê do updateMany ignora o where: conferimos o where em si — sem filtro que poupe o na_clinica velho (senão a gravação não casaria no Postgres)
  assert.equal((conversaGravou[0] as unknown as { where: { OR?: unknown } }).where.OR, undefined);
});

test('A.2) carimbo da 1ª marcação: o na_clinica PADRÃO da chave (e o velho) NÃO derrubam o "Sim" da equipe; a forma DITA agora vale como sempre', () => {
  const cartaoSim = { ehRetorno: false, pagamentoComprovado: false, valorAtual: 'Sim', preservarSim: true };
  // unidade sem sinal: a ferramenta põe na_clinica por padrão (forma NÃO dita)
  const padrao = formaParaOCarimbo({ pixDepois: true, formaDitaAgora: undefined, formaFinal: 'na_clinica', escolhaSalva: null });
  assert.deepEqual(padrao, { formaPagamento: undefined, escolhaSalva: 'na_clinica' });
  assert.equal(decidirPagamentoAntecipado({ ...cartaoSim, ...padrao }).valor, null, 'mantém o Sim (sonda do sênior: era "Não")');
  // ele DISSE na clínica agora: vale, carimba Não
  const dita = formaParaOCarimbo({ pixDepois: true, formaDitaAgora: 'na_clinica', formaFinal: 'na_clinica', escolhaSalva: null });
  assert.equal(decidirPagamentoAntecipado({ ...cartaoSim, ...dita }).valor, 'Não');
  // com sinal e forma não dita: nada de forma; cartão sem valor → Não como sempre
  const sinal = formaParaOCarimbo({ pixDepois: true, formaDitaAgora: undefined, formaFinal: undefined, escolhaSalva: null });
  assert.equal(decidirPagamentoAntecipado({ ...cartaoSim, ...sinal }).valor, null);
  assert.equal(decidirPagamentoAntecipado({ ...cartaoSim, ...sinal, valorAtual: null }).valor, 'Não');
  // chave desligada: devolve o que recebeu, byte a byte
  assert.deepEqual(formaParaOCarimbo({ pixDepois: false, formaDitaAgora: undefined, formaFinal: 'na_clinica', escolhaSalva: 'x' }), { formaPagamento: 'na_clinica', escolhaSalva: 'x' });
});

test('A.2) recusa do sinal: só o botão "Pago no dia" (frase inteira); os 6 falsos positivos do sênior NÃO gravam', () => {
  for (const t of ['Pago no dia', 'pago no dia.', 'Pago na clínica', 'prefiro pagar no dia']) assert.equal(recusouOSinal(t), true, t);
  for (const t of [
    'quanto custa a consulta? pago no dia?',
    'as sessões eu pago lá',
    'pode ser no dia',
    'pode ser lá',
    'pago lá mesmo, as sessões',
    'Quero o Pix',
    'no dia 10 eu pago',
    '',
    undefined,
  ]) assert.equal(recusouOSinal(t as string), false, String(t));
});

test('A.2) gravarRecusaDoSinal: só com a consulta marcada no futuro E o marcador da oferta (where exige sinal_oferecido); sem consulta, nada', async () => {
  const u = { id: 'u-arag', businessHoursTimezone: TZ, spineTimezone: TZ };
  agendadoPara = null;
  assert.equal(await gravarRecusaDoSinal(u, 1), false, 'sem consulta marcada');
  assert.equal(conversaGravou.length, 0);
  agendadoPara = `${DIA}T09:00`;
  assert.equal(await gravarRecusaDoSinal(u, 1), true);
  const g = conversaGravou[0] as unknown as { data: { pagamentoEscolhido: string }; where: { pagamentoEscolhido: string } };
  assert.equal(g.data.pagamentoEscolhido, 'na_clinica');
  assert.equal(g.where.pagamentoEscolhido, OFERTA_DO_SINAL_FEITA, 'a oferta de fato (marcador), nunca "sem escolha"');
  agendadoPara = '2020-01-01T09:00';
  conversaGravou.length = 0;
  assert.equal(await gravarRecusaDoSinal(u, 1), false, 'consulta no passado');
});

test('A.2) remarcação: o na_clinica PADRÃO da chave não derruba o "Sim" que a equipe pôs; a escolha dita continua valendo como sempre', () => {
  const base = { ehRetorno: false, pagamentoComprovado: false, escolhaSalva: 'na_clinica', valorAtual: 'Sim' };
  assert.equal(decidirPagamentoAntecipado({ ...base, preservarSim: true }).valor, null, 'mantém o Sim da equipe');
  assert.equal(decidirPagamentoAntecipado({ ...base }).valor, 'Não', 'chave desligada: como sempre');
  assert.equal(decidirPagamentoAntecipado({ ...base, preservarSim: true, formaPagamento: 'na_clinica' }).valor, 'Não', 'ele disse na clínica agora: vale');
  assert.equal(decidirPagamentoAntecipado({ ...base, preservarSim: true, valorAtual: 'Não' }).valor, 'Não');
});

test('A.1) a descrição de gerar_sinal_pix só muda com a chave ligada (desligada = a do main, palavra por palavra)', () => {
  const desc = () => (gerarSinal(atual) as unknown as { description: string }).description;
  const desligada = desc();
  assert.doesNotMatch(desligada, /DEPOIS de marcar/);
  assert.match(desligada, /ele ter escolhido o sinal \(formaPagamento=sinal_pix\)\. O sistema manda o código/);
  ligar();
  assert.match(desc(), /Também chame quando ele aceitar a oferta do sinal que você fez DEPOIS de marcar/);
  _semearParaTeste([]);
  assert.equal(desc(), desligada);
});

test('A.2) ao gerar o link, o marcador da oferta vira sinal_pix (o "Pago no dia" depois disso não vale mais)', async () => {
  ligar();
  const hora = await primeiroHorario(atual);
  await agendar(atual).func({ idClient: 9, data: DIA, hora, diaConfirmado: true, leadId: 1 });
  conversaGravou.length = 0;
  await gerarSinal(atual).func({ leadId: 1 });
  const g = conversaGravou[0] as unknown as { data: { pagamentoEscolhido: string }; where: { pagamentoEscolhido: string } };
  assert.deepEqual((g.where as unknown as { OR: unknown[] }).OR, [{ pagamentoEscolhido: OFERTA_DO_SINAL_FEITA }, { pagamentoEscolhido: 'na_clinica' }], '"Pago no dia" e depois "quero o Pix": o na_clinica da recusa também vira sinal_pix');
  assert.equal(g.data.pagamentoEscolhido, 'sinal_pix');
});

test('chave Pix fixa: "Quero o Pix" (o botão, frase inteira) depois da oferta grava pix_antecipado — só com o marcador e a consulta de pé', async () => {
  for (const t of ['Quero o Pix', 'quero o pix.', 'Quero Pix']) assert.equal(aceitouOPix(t), true, t);
  for (const t of ['quero o pix da sessão?', 'pode ser o pix', 'pix', 'te mando o pix?', '', undefined]) assert.equal(aceitouOPix(t as string), false, String(t));
  const u = { id: 'u-arag', businessHoursTimezone: TZ, spineTimezone: TZ };
  agendadoPara = null;
  assert.equal(await gravarAceiteDoPix(u, 1), false, 'sem consulta marcada');
  agendadoPara = `${DIA}T09:00`;
  assert.equal(await gravarAceiteDoPix(u, 1), true);
  const g = conversaGravou[conversaGravou.length - 1] as unknown as { data: { pagamentoEscolhido: string }; where: { pagamentoEscolhido: string } };
  assert.equal(g.data.pagamentoEscolhido, 'pix_antecipado');
  assert.deepEqual((g.where as unknown as { OR: unknown[] }).OR[0], { pagamentoEscolhido: OFERTA_DO_SINAL_FEITA }, 'só quem recebeu a oferta de fato (ou disse "Pago no dia")');
});

test('o aviso de agendamento diz o que ELE escolheu, não o padrão da ferramenta', () => {
  // `formaPagamento` do aviso é a forma DITA agora (formaDitaAgora) com a chave ligada; sem escolha, null → o aviso não afirma "na clínica"
  assert.equal(formaParaOCarimbo({ pixDepois: true, formaDitaAgora: undefined, formaFinal: 'na_clinica', escolhaSalva: null }).formaPagamento, undefined);
});

// ── 6ª rodada: régua, carimbo do cartão no aceite, regra global, "Pago no dia" → "Quero o Pix" ────────────────────────────────────

test('RÉGUA: quem só recebeu a OFERTA (sinal_oferecido) NÃO recebe o degrau do Pix; só pix_antecipado/sinal_pix recebem; sem a chave nada muda', () => {
  const degrau = { soPix: true };
  const fixa = unidade({ sinalPixCentavos: null });
  assert.equal(degrauDoPixNaoSeAplica(degrau, 'sinal_oferecido', fixa), true, 'oferta sem resposta: sem cobrança (o erro de 11/09)');
  assert.equal(degrauDoPixNaoSeAplica(degrau, 'na_clinica', fixa), true);
  assert.equal(degrauDoPixNaoSeAplica(degrau, 'pix_antecipado', fixa), false, 'escolheu o Pix: o degrau roda');
  assert.equal(degrauDoPixNaoSeAplica(degrau, null, fixa), false, 'como sempre (chave desligada: nada muda)');
  assert.equal(degrauDoPixNaoSeAplica({ soPix: false }, 'sinal_oferecido', fixa), false, 'degrau que não é só-Pix: indiferente');
});

function kommoFalso(valorAtual: string | null, falhaNoCampo = false) {
  const chamadas: string[] = [];
  const notas: string[] = [];
  const k = {
    getLead: async () => ({ id: 1, status_id: 1, custom_fields_values: valorAtual === null ? [] : [{ field_id: 777, values: [{ value: valorAtual }] }] }),
    setLeadCustomFieldValue: async (_l: number, id: number, tipo: string, v: unknown) => {
      chamadas.push(`${id}:${tipo}:${String(v)}`);
      if (falhaNoCampo) throw new Error('kommo fora');
    },
    addLeadNote: async (_l: number, t: string) => (notas.push(t), { id: 1 }),
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [{ id: 777, name: '¤ Pagamento antecipado', type: 'select', enums: [{ id: 1, value: 'Sim' }, { id: 2, value: 'Não' }] }] } }),
    listPipelines: async () => [],
  };
  return { k, chamadas, notas };
}

test('ACEITE no cartão: "Quero o Pix" grava a conversa E carimba o cartão (Sim + valor antecipado); falha abre NOTA; Sim da equipe não é reescrito', async () => {
  const ks = await import('../lib/kommo-schema.js');
  const { carimbarAceiteDoPix } = await import('./aceite-do-pix.js');
  const u = unidade({ sinalPixCentavos: null });
  const quando = { data: DIA, hora: '09:00' };
  // o aceite chama o carimbo DEPOIS de gravar a conversa
  agendadoPara = `${DIA}T09:00`;
  escolhaNaConversa = null;
  let carimbou: unknown = null;
  assert.equal(await gravarAceiteDoPix({ id: u.id, businessHoursTimezone: TZ, spineTimezone: TZ }, 1, { carimbar: async (q) => { carimbou = q; } }), true);
  assert.deepEqual(carimbou, { data: DIA, hora: '09:00' });
  // sem a oferta (nenhuma linha casa): nada de carimbo — o stub devolve count 1; checamos pelo where
  const g = conversaGravou[conversaGravou.length - 1] as unknown as { data: { pagamentoEscolhido: string }; where: { OR: unknown[] } };
  assert.equal(g.data.pagamentoEscolhido, 'pix_antecipado');
  assert.deepEqual(g.where.OR, [{ pagamentoEscolhido: OFERTA_DO_SINAL_FEITA }, { pagamentoEscolhido: 'na_clinica' }], 'também de um "Pago no dia" anterior');
  // o carimbo: campo existe, estava vazio → grava Sim
  ks.limparCacheEsquema();
  const a = kommoFalso(null);
  const r1 = await carimbarAceiteDoPix({ unit: u, kommo: a.k as never, leadId: 1, ...quando });
  assert.equal(r1, 'carimbado');
  assert.deepEqual(a.chamadas, ['777:select:Sim']);
  assert.equal(a.notas.length, 0);
  // já tinha Sim (equipe): não reescreve
  ks.limparCacheEsquema();
  const b = kommoFalso('Sim');
  assert.equal(await carimbarAceiteDoPix({ unit: u, kommo: b.k as never, leadId: 1, ...quando }), 'ja-estava');
  assert.deepEqual(b.chamadas, []);
  // o Kommo falha ao gravar: abre NOTA para a recepção
  ks.limparCacheEsquema();
  const c = kommoFalso(null, true);
  assert.equal(await carimbarAceiteDoPix({ unit: u, kommo: c.k as never, leadId: 1, ...quando }), 'falhou');
  assert.equal(c.notas.length, 1);
  assert.match(c.notas[0], /aceitou o Pix antecipado[\s\S]*Pagamento antecipado" = Sim/);
});

test('o carimbo falhar NÃO desfaz o aceite gravado na conversa', async () => {
  agendadoPara = `${DIA}T09:00`;
  const r = await gravarAceiteDoPix({ id: 'u-arag', businessHoursTimezone: TZ, spineTimezone: TZ }, 1, { carimbar: async () => { throw new Error('boom'); } });
  assert.equal(r, true);
});

test('REGRA GLOBAL: chave fixa com chave Pix e preços não diz mais "vale pagar na clínica" nos passos; sem chave Pix, diz', () => {
  const fixa = unidade({ sinalPixCentavos: null });
  ligar(fixa.slug);
  const r = renderRulesGlobal(fixa);
  assert.match(r, /marcar \(sem perguntar a forma de pagamento\) → oferta do valor antecipado pelo Pix \(com a chave\), uma vez, DEPOIS de marcar/);
  assert.doesNotMatch(r, /vale pagar na clínica\)/);
  const semChave = renderRulesGlobal(unidade({ sinalPixCentavos: null, pixKey: null }));
  assert.match(semChave, /marcar \(sem perguntar a forma de pagamento: vale pagar na clínica\)/);
});

test('Pago no dia e depois "Quero o Pix" (chave fixa): o aceite troca o na_clinica da recusa por pix_antecipado, com a consulta de pé', async () => {
  agendadoPara = `${DIA}T09:00`;
  assert.equal(await gravarRecusaDoSinal({ id: 'u-arag', businessHoursTimezone: TZ, spineTimezone: TZ }, 1), true);
  assert.equal(await gravarAceiteDoPix({ id: 'u-arag', businessHoursTimezone: TZ, spineTimezone: TZ }, 1), true);
  const ult = conversaGravou.slice(-2) as unknown as Array<{ data: { pagamentoEscolhido: string } }>;
  assert.deepEqual(ult.map((x) => x.data.pagamentoEscolhido), ['na_clinica', 'pix_antecipado']);
  agendadoPara = null;
  assert.equal(await gravarAceiteDoPix({ id: 'u-arag', businessHoursTimezone: TZ, spineTimezone: TZ }, 1), false, 'sem consulta de pé: nada');
});
