/**
 * A rede de segurança em código (26/10/2026): o paciente disse o sinal e o modelo não avisou a equipe.
 * "minha perna está perdendo força" em Marabá/Canaã → a IA para, sai a frase do passe, sem pronto-socorro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { Unit } from '@prisma/client';

import { passarPorSinalNoTurno } from './passe-por-sinal.js';

const unit = { id: 'u1', slug: 'doutor-hernia-teste', category: 'saude', spineEnabled: false } as unknown as Unit;

function montar(resultadoPausa = 'OK — IA pausada no lead 7 (3ms).') {
  const chamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];
  const passos: string[] = [];
  const tools = [
    { name: 'pausar_ia', invoke: async (a: Record<string, unknown>) => (chamadas.push({ nome: 'pausar_ia', args: a }), resultadoPausa) },
    { name: 'resumir_lead_para_sdr', invoke: async (a: Record<string, unknown>) => (chamadas.push({ nome: 'resumir_lead_para_sdr', args: a }), 'ok') },
  ];
  const recorder = { step: async (s: { title: string }) => void passos.push(s.title) };
  return { chamadas, passos, tools, recorder };
}

const entrada = (over: Partial<Parameters<typeof passarPorSinalNoTurno>[0]> & { falas: string[] }) => {
  const m = montar();
  return {
    ...m,
    args: {
      unit,
      leadId: 7,
      mensagens: over.mensagens ?? ([new HumanMessage(over.falas.join('\n'))] as BaseMessage[]),
      falasDoPaciente: over.falas,
      tools: over.tools ?? m.tools,
      recorder: m.recorder,
      textoFinal: over.textoFinal ?? 'Entendi! Que tal quarta às 9h?',
    },
  };
};

test('"minha perna está perdendo força" e o modelo seguiu vendendo: pausa com a flag, resume e troca a resposta', async () => {
  const { args, chamadas, passos } = entrada({ falas: ['minha perna está perdendo força'] });
  const r = await passarPorSinalNoTurno(args);
  assert.equal(r.avisou, true);
  assert.match(r.texto, /avisei a nossa equipe, com prioridade/);
  assert.doesNotMatch(r.texto, /pronto|UPA|hospital|quarta/i);
  assert.equal(chamadas[0].nome, 'pausar_ia');
  assert.equal(chamadas[0].args.sinalDeAlerta, true);
  assert.equal(chamadas[0].args.leadId, 7);
  assert.match(String(chamadas[0].args.motivo), /^sinal de alerta: perda de força/);
  assert.equal(chamadas[1].nome, 'resumir_lead_para_sdr');
  assert.match(passos[0], /aviso feito pelo código/);
});

test('o paciente falou em pronto-socorro: a frase do passe não desaconselha', async () => {
  const { args } = entrada({ falas: ['não estou segurando o xixi, devo ir ao pronto-socorro?'] });
  const r = await passarPorSinalNoTurno(args);
  assert.match(r.texto, /Se você sentir que não dá para esperar, pode ir/);
});

test('o modelo já avisou como sinal de alerta: o código não mexe', async () => {
  const mensagens = [
    new HumanMessage('não consigo segurar o xixi'),
    new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'pausar_ia', args: { motivo: 'x', sinalDeAlerta: true } }] }),
    new ToolMessage({ content: 'OK — IA pausada', tool_call_id: 'a' }),
  ];
  const { args, chamadas } = entrada({ falas: ['não consigo segurar o xixi'], mensagens, textoFinal: 'Sinto muito 🙏' });
  const r = await passarPorSinalNoTurno(args);
  assert.deepEqual(r, { avisou: true, texto: 'Sinto muito 🙏' });
  assert.equal(chamadas.length, 0);
});

test('o modelo pausou SEM a flag (Mossoró): o código avisa a equipe mas a resposta do modelo fica', async () => {
  const mensagens = [
    new HumanMessage('perdi a força na perna'),
    new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'pausar_ia', args: { motivo: 'quer falar com humano' } }] }),
    new ToolMessage({ content: 'OK — IA pausada', tool_call_id: 'a' }),
  ];
  const { args, chamadas } = entrada({ falas: ['perdi a força na perna'], mensagens, textoFinal: 'Já aviso a equipe 🙏' });
  const r = await passarPorSinalNoTurno(args);
  assert.deepEqual(r, { avisou: true, texto: 'Já aviso a equipe 🙏' });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].args.sinalDeAlerta, true);
});

test('a pausa do modelo foi recusada (PAUSA NÃO APLICADA): conta como se ele não tivesse pausado', async () => {
  const mensagens = [
    new HumanMessage('perdi a força na perna'),
    new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'pausar_ia', args: { motivo: 'sem vaga hoje' } }] }),
    new ToolMessage({ content: 'PAUSA NÃO APLICADA. Você afirmou…', tool_call_id: 'a' }),
  ];
  const { args } = entrada({ falas: ['perdi a força na perna'], mensagens });
  const r = await passarPorSinalNoTurno(args);
  assert.match(r.texto, /avisei a nossa equipe/);
});

test('a pausa pelo código falhou: fica a resposta do modelo e o rastro diz que o aviso não pegou', async () => {
  const m = montar('ERRO ao pausar IA: Kommo fora do ar');
  const { args } = entrada({ falas: ['perdi a força na perna'], tools: m.tools });
  const r = await passarPorSinalNoTurno({ ...args, recorder: m.recorder });
  assert.deepEqual(r, { avisou: false, texto: 'Entendi! Que tal quarta às 9h?' });
  assert.match(m.passos[0], /o aviso pelo código não pegou/);
  // o resumo corre junto com a pausa, então sai mesmo quando a pausa falha (a tarefa e o Telegram podem ter saído)
  assert.equal(m.chamadas.filter((c) => c.nome === 'resumir_lead_para_sdr').length, 1);
});

test('sem sinal na fala, negado, vago, ou fora de clínica: não mexe', async () => {
  for (const fala of ['oi, vim pelo anúncio', 'não tenho perda de força', 'me faltaram as pernas ontem']) {
    const { args, chamadas } = entrada({ falas: [fala] });
    const r = await passarPorSinalNoTurno(args);
    assert.deepEqual(r, { avisou: false, texto: 'Entendi! Que tal quarta às 9h?' }, fala);
    assert.equal(chamadas.length, 0, fala);
  }
  const { args, chamadas } = entrada({ falas: ['perdi a força na perna'] });
  const r = await passarPorSinalNoTurno({ ...args, unit: { ...unit, category: 'juridico' } as unknown as Unit });
  assert.equal(r.avisou, false);
  assert.equal(chamadas.length, 0);
  const semLead = await passarPorSinalNoTurno({ ...args, leadId: undefined });
  assert.equal(semLead.avisou, false);
});

test('o modelo marcou consulta neste turno: a confirmação dele fica, mas a equipe é avisada', async () => {
  const mensagens = [
    new HumanMessage('perdi a força na perna, quero marcar'),
    new AIMessage({ content: '', tool_calls: [{ id: 'g', name: 'agendar_consulta', args: {} }] }),
    new ToolMessage({ content: 'OK — marcada', tool_call_id: 'g' }),
  ];
  const { args, chamadas } = entrada({ falas: ['perdi a força na perna, quero marcar'], mensagens, textoFinal: 'Marcado para quarta às 9h!' });
  const r = await passarPorSinalNoTurno(args);
  assert.deepEqual(r, { avisou: true, texto: 'Marcado para quarta às 9h!' });
  assert.equal(chamadas.find((c) => c.nome === 'pausar_ia')?.args.sinalDeAlerta, true);
});

test('o resumo sai junto com a pausa, sem segurar a resposta além do prazo', async () => {
  const m = montar();
  m.tools[1] = { name: 'resumir_lead_para_sdr', invoke: () => new Promise(() => undefined) }; // nunca responde
  const { args } = entrada({ falas: ['não estou segurando o xixi'], tools: m.tools });
  const t0 = Date.now();
  const r = await Promise.race([
    passarPorSinalNoTurno({ ...args, recorder: m.recorder }),
    new Promise<never>((_, no) => setTimeout(() => no(new Error('travou no resumo')), 12000)),
  ]);
  assert.match(r.texto, /avisei a nossa equipe/);
  assert.ok(Date.now() - t0 < 11000);
  assert.equal(m.chamadas[0].nome, 'pausar_ia', 'a pausa não esperou o resumo');
});
