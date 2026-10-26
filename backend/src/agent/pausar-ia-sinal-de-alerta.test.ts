/**
 * Sinal de alerta avisa a equipe NA HORA (prioridades da IA, 21/10/2026, itens 1 e 2).
 *
 * Antes, a transferência por sinal de alerta só pausava a IA: o aviso para a equipe dependia de a regra da unidade
 * criar uma tarefa (quando o modelo seguia a regra) ou do alerta de SLA, que é opcional por unidade e só sai depois
 * de 5–15 minutos. Agora `pausar_ia` com sinal de alerta cria a tarefa "ALERTA · … URGENTE" no cartão, com prazo
 * agora e no nome do responsável — e não duplica quando a regra da unidade já criou a dela no mesmo turno.
 *
 * 26/10/2026 (itens 1 e 2 da conferência da Suzanne): o "tentar agendar antes" saiu — a ferramenta
 * avisar_sinal_de_alerta não existe mais; todo sinal de alerta para a IA, ganha a etiqueta 🔴 PRIORIDADE e a
 * tarefa "LIGAR AGORA".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildTools } from './tools.js';

delete process.env.TELEGRAM_BOT_TOKEN;

// A marca "já avisei este cartão" (card_alert) em memória.
const marcas = new Map<string, Date>();
type ChaveMarca = { unitId_leadId_ruleKey: { unitId: string; leadId: string; ruleKey: string } };
const chaveDe = (w: ChaveMarca) => `${w.unitId_leadId_ruleKey.unitId}|${w.unitId_leadId_ruleKey.leadId}|${w.unitId_leadId_ruleKey.ruleKey}`;
Object.defineProperty(prisma, 'cardAlert', {
  value: {
    findUnique: async ({ where }: { where: ChaveMarca }) => {
      const em = marcas.get(chaveDe(where));
      return em ? { createdAt: em } : null;
    },
    upsert: async ({ where }: { where: ChaveMarca }) => {
      marcas.set(chaveDe(where), new Date());
      return {};
    },
  },
  configurable: true,
});

Object.defineProperty(prisma, 'conversation', {
  value: {
    findFirst: async () => ({ contactName: 'Maria' }),
    updateMany: async () => ({ count: 1 }),
  },
  configurable: true,
});

interface Tarefa {
  leadId: number;
  text: string;
  completeAt: number;
  responsibleUserId?: number;
}

let tarefas: Tarefa[] = [];
let pausas: number[] = [];
let falharPausa = false;
let falharEtiqueta = false;
let falharEtiquetaComEmoji = false;
let falharTarefa = false;
let guardadas: string[] | null = null;
let etiquetas: Array<{ leadId: number; tag?: string; tags?: string[] }> = [];
let passos: Array<{ title: string }> = [];

beforeEach(() => {
  tarefas = [];
  pausas = [];
  falharPausa = false;
  falharEtiqueta = false;
  falharEtiquetaComEmoji = false;
  falharTarefa = false;
  guardadas = null;
  etiquetas = [];
  passos = [];
  marcas.clear();
});

const kommo = {
  getLead: async (id: number) => ({ id, name: 'Maria 21/10/2026', responsible_user_id: 777, status_id: 1, pipeline_id: 1 }),
  tagsDoLead: async () => guardadas ?? ['🔴 PRIORIDADE'],
  createTask: async (t: Tarefa) => {
    if (falharTarefa) throw new Error('Kommo fora do ar');
    tarefas.push(t);
    return { id: 99 };
  },
  addTag: async (p: { leadId: number; tag?: string; tags?: string[] }) => {
    if (falharEtiqueta) throw new Error('Kommo recusou a etiqueta');
    if (falharEtiquetaComEmoji && /🔴/.test(p.tag ?? '')) throw new Error('Kommo recusou o emoji');
    etiquetas.push(p);
  },
  setLeadFieldFlag: async (leadId: number) => {
    if (falharPausa) throw new Error('Kommo fora do ar');
    pausas.push(leadId);
  },
  listLeadCustomFields: async () => ({ _embedded: { custom_fields: [] } }),
  listPipelines: async () => [],
  setLeadCustomFieldValue: async () => undefined,
} as unknown as KommoClient;

const recorder = {
  step: async (s: { title: string }) => {
    passos.push(s);
  },
} as unknown as TraceRecorder;

function unidade(over: Partial<Unit> = {}): Unit {
  return {
    id: 'u1',
    slug: 'doutor-hernia-teste',
    name: 'Teste',
    kommoSubdomain: 'teste',
    spineEnabled: false,
    spineTimezone: 'America/Sao_Paulo',
    businessHoursTimezone: 'America/Sao_Paulo',
    ...over,
  } as unknown as Unit;
}

/** As ferramentas têm schemas diferentes; para o teste basta nome + invoke. */
interface Ferramenta {
  name: string;
  invoke: (entrada: Record<string, unknown>) => Promise<unknown>;
}

function ferramentas(unit = unidade()): Ferramenta[] {
  return buildTools({ recorder, kommo, pausedFieldId: 123, unit }) as unknown as Ferramenta[];
}

function ferramenta(nome: string, unit = unidade(), lista = ferramentas(unit)): Ferramenta {
  const t = lista.find((x) => x.name === nome);
  assert.ok(t, `${nome} não existe`);
  return t;
}

test('pausar_ia com sinal de alerta cria a tarefa urgente na hora, no nome do responsável do cartão', async () => {
  const antes = Math.floor(Date.now() / 1000);
  const r = String(await ferramenta('pausar_ia').invoke({ leadId: 42, motivo: 'perda de força na perna há 2 dias', sinalDeAlerta: true }));
  assert.equal(tarefas.length, 1);
  const t = tarefas[0];
  assert.equal(t.leadId, 42);
  assert.match(t.text, /^ALERTA · doutor-hernia-teste · \[Contato: Maria\] LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico/);
  assert.equal(t.responsibleUserId, 777);
  // Etiqueta no cartão (Suzanne, 25/10: 0 etiquetas 🔴 PRIORIDADE nas 21 contas).
  assert.deepEqual(etiquetas, [{ leadId: 42, tag: '🔴 PRIORIDADE' }]);
  assert.ok(t.completeAt >= antes && t.completeAt <= antes + 5, 'o prazo é agora');
  assert.deepEqual(pausas, [42]);
  assert.match(r, /^OK — IA pausada/);
  assert.match(r, /NÃO prometa prazo/);
  assert.match(r, /NÃO sugira pronto-socorro/);
  // sem agenda ligada, o horário da equipe não é conhecido: a IA não inventa
  assert.match(r, /próximo horário de atendimento/);
  // O Telegram do João sai em paralelo; sem token, o rastro diz que não chegou (e nada estoura).
  await new Promise((ok) => setTimeout(ok, 20));
  assert.ok(passos.some((p) => /NÃO chegou ao Telegram/.test(p.title)));
});

test('o motivo basta quando o modelo esquece a flag', async () => {
  await ferramenta('pausar_ia').invoke({ leadId: 7, motivo: 'red flag: não está conseguindo segurar o xixi' });
  assert.equal(tarefas.length, 1);
  assert.match(tarefas[0].text, /LIGAR AGORA/);
  assert.equal(etiquetas.length, 1);
});

test('transferência comum não cria tarefa urgente e não promete prazo', async () => {
  const r = String(await ferramenta('pausar_ia').invoke({ leadId: 8, motivo: 'paciente pediu para falar com um atendente' }));
  assert.equal(tarefas.length, 0);
  assert.deepEqual(etiquetas, [], 'transferência comum não leva 🔴 PRIORIDADE');
  assert.deepEqual(pausas, [8]);
  assert.match(r, /NÃO prometa prazo/);
  assert.doesNotMatch(r, /prioridade/);
});

test('a regra da unidade já criou a tarefa urgente no turno: não duplica', async () => {
  const tools = ferramentas();
  const criar = ferramenta('criar_tarefa', undefined, tools);
  const pausar = ferramenta('pausar_ia', undefined, tools);
  await criar.invoke({ leadId: 9, text: 'URGENTE: paciente com sinal de alerta clínico — ligar já', deadlineMinutes: 5 });
  await pausar.invoke({ leadId: 9, motivo: 'sinal de alerta clínico confirmado', sinalDeAlerta: true });
  assert.equal(tarefas.length, 1, 'uma tarefa só: a da regra da unidade');
  assert.match(tarefas[0].text, /LIGAR AGORA/, 'a tarefa da regra da unidade ganha o LIGAR AGORA');
  assert.equal(etiquetas.length, 1, 'a etiqueta vai mesmo assim');
  assert.ok(passos.some((p) => /não repito/.test(p.title)));
});

test('tarefa comum da regra da unidade não cala o aviso urgente', async () => {
  const tools = ferramentas();
  await ferramenta('criar_tarefa', undefined, tools).invoke({ leadId: 10, text: 'Ligar amanhã para confirmar', deadlineMinutes: 60 });
  await ferramenta('pausar_ia', undefined, tools).invoke({ leadId: 10, motivo: 'perda de controle da urina', sinalDeAlerta: true });
  assert.equal(tarefas.length, 2);
  assert.match(tarefas[0].text, /Ligar amanhã para confirmar$/, 'tarefa comum passa intacta');
  assert.doesNotMatch(tarefas[0].text, /LIGAR AGORA/);
  assert.match(tarefas[1].text, /LIGAR AGORA/);
});

test('a pausa falhou: a equipe é avisada do mesmo jeito', async () => {
  falharPausa = true;
  const r = String(await ferramenta('pausar_ia').invoke({ leadId: 11, motivo: 'sinal de alerta', sinalDeAlerta: true }));
  assert.match(r, /^ERRO ao pausar IA/);
  assert.equal(tarefas.length, 1);
  assert.equal(etiquetas.length, 1);
});

test('a etiqueta falhou: a tarefa e a pausa saem do mesmo jeito, e o rastro diz que a etiqueta não foi', async () => {
  falharEtiqueta = true;
  const r = String(await ferramenta('pausar_ia').invoke({ leadId: 13, motivo: 'sinal de alerta', sinalDeAlerta: true }));
  assert.match(r, /^OK — IA pausada/);
  assert.equal(tarefas.length, 1);
  assert.deepEqual(pausas, [13]);
  assert.ok(passos.some((p) => /Falha ao aplicar a etiqueta/.test(p.title)));
});

test('sinal de alerta não passa pela volta à agenda do "sem vaga"', async () => {
  // Com a agenda ligada, "pediu encaixe hoje" no motivo acionaria o safety-net, que consulta a agenda e
  // devolve "PAUSA NÃO APLICADA". Com sinal de alerta, a regra é transferir na hora.
  const r = String(
    await ferramenta('pausar_ia', unidade({ spineEnabled: true, spineToken: 'tok' })).invoke({
      leadId: 12,
      motivo: 'sinal de alerta, pediu encaixe hoje',
      sinalDeAlerta: true,
    }),
  );
  assert.match(r, /^OK — IA pausada/);
  assert.ok(!passos.some((p) => /safety-net/.test(p.title)), 'não consultou a agenda');
  assert.equal(tarefas.length, 1);
});

test('não existe mais a ferramenta avisar_sinal_de_alerta: o "tentar agendar antes" saiu (26/10)', () => {
  assert.equal(ferramentas().find((t) => t.name === 'avisar_sinal_de_alerta'), undefined);
});

test('o aviso de 24 h: a segunda transferência no mesmo cartão não repete a tarefa, mas recoloca a etiqueta', async () => {
  await ferramenta('pausar_ia').invoke({ leadId: 21, motivo: 'perna fraca de repente', sinalDeAlerta: true });
  // reativação e nova transferência: ferramentas novas, mesma marca no banco
  await ferramenta('pausar_ia').invoke({ leadId: 21, motivo: 'perna fraca de repente', sinalDeAlerta: true });
  assert.equal(tarefas.length, 1);
  assert.equal(etiquetas.length, 2, 'a etiqueta é idempotente e vai de novo');
  assert.deepEqual(pausas, [21, 21]);
  assert.match(tarefas[0].text, /A IA parou e passou o atendimento/);
  assert.match(tarefas[0].text, /ligar para o paciente agora/);
});

// ── Revisão do sênior (26/10): quando o aviso falha, e a etiqueta com emoji ────────────────────────────

test('a tarefa E o Telegram falharam: a pausa vale, o rastro grita e a IA não manda dizer "avisei a equipe"', async () => {
  falharTarefa = true; // sem TELEGRAM_BOT_TOKEN neste arquivo, o Telegram também falha
  const r = String(await ferramenta('pausar_ia').invoke({ leadId: 31, motivo: 'perda de força na perna', sinalDeAlerta: true }));
  assert.match(r, /^OK — IA pausada/);
  assert.match(r, /\[SEM AVISO À EQUIPE\]/);
  assert.match(r, /NÃO diga que a equipe já foi avisada/);
  assert.doesNotMatch(r, /já foi avisada com prioridade/);
  assert.deepEqual(pausas, [31]);
  assert.ok(passos.some((p) => /ALERTA: sinal de alerta SEM aviso à equipe/.test(p.title)));
});

test('o Kommo recusou o emoji na etiqueta: entra "PRIORIDADE" sem ele e o rastro registra', async () => {
  falharEtiquetaComEmoji = true;
  await ferramenta('pausar_ia').invoke({ leadId: 33, motivo: 'red flag', sinalDeAlerta: true });
  assert.deepEqual(etiquetas, [{ leadId: 33, tag: 'PRIORIDADE' }]);
  assert.ok(passos.some((p) => /a com emoji falhou/.test(p.title)));
  assert.equal(tarefas.length, 1, 'a tarefa sai do mesmo jeito');
});

test('o Kommo guardou a etiqueta diferente da pedida: fica como ele devolveu e o rastro registra', async () => {
  guardadas = ['PRIORIDADE'];
  await ferramenta('pausar_ia').invoke({ leadId: 34, motivo: 'red flag', sinalDeAlerta: true });
  assert.ok(passos.some((p) => /Kommo guardou a etiqueta diferente de "🔴 PRIORIDADE".*PRIORIDADE/.test(p.title)));
});
