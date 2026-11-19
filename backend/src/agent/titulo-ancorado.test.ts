/**
 * Tatuí 19/11/2026, lead 4282053: "Olá" → a IA gravou "Ocupado" no título e no contato (era "Isaque F Sousa") e depois pediu
 * desculpa ao paciente. O pedido ao modelo tinha 2 mensagens; "Ocupado" veio do exemplo de "não é nome" que está no próprio prompt.
 * Salto 13/11 (lead 3580474, "Rosana" → "Ocupado") foi igual. Medida do sênior em 30 dias: 1.857 chamadas de `atualizar_titulo_lead` →
 * 51 barradas por looksLikeName (Ocupado 2×, Cliente 2×, placeholder, Novo Lead, A definir…), 1.710 ancoradas na conversa e 96 que
 * dependem do contato do Kommo (quase todas nomes reais — por isso o contato conta como prova).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';
import { buildTools } from './tools.js';
import { looksLikeName } from './name-capture.js';
import { soFalaDoPaciente } from './sinal-de-alerta.js';
import { ancoraDoNomeLigada, evidenciaDoNome, falasDoPacienteNoPrompt, nomeAncoradoNaConversa, nomesConfirmadosPeloTelefone } from './titulo-ancorado.js';

logger.warn = (() => undefined) as never;
logger.error = (() => undefined) as never;
Object.defineProperty(prisma, 'unitAutomacao', { value: { findMany: async () => [] }, configurable: true });
Object.defineProperty(prisma, 'conversation', { value: { updateMany: async () => ({ count: 1 }), findFirst: async () => null }, configurable: true });

test('"Ocupado", "Cliente" e companhia não são nome — nem na palavra solta nem com sobrenome', () => {
  for (const lixo of ['Ocupado', 'ocupada', 'Cliente', 'Loja', 'Lead', 'Contato', 'Não informado', 'A definir', 'Novo Lead', 'Paciente']) {
    assert.equal(looksLikeName(lixo), false, `aceitou "${lixo}"`);
  }
  for (const nome of ['Isaque Sousa', 'Maria da Silva', 'Rosana', 'Lúcia Correa', 'Ana Paula de Souza']) {
    assert.equal(looksLikeName(nome), true, `barrou nome legítimo "${nome}"`);
  }
});

test('ancoragem: o nome tem de estar no que o paciente disse (sem acento nem caixa)', () => {
  assert.equal(nomeAncoradoNaConversa('Ocupado', ['Olá']).ancorado, false);
  assert.deepEqual(nomeAncoradoNaConversa('Ocupado', ['Olá']).faltando, ['ocupado']);
  assert.equal(nomeAncoradoNaConversa('Maria', ['me chamo MARIA']).ancorado, true);
  assert.equal(nomeAncoradoNaConversa('José', ['meu nome é jose']).ancorado, true);
  assert.equal(nomeAncoradoNaConversa('Maria da Silva', ['Maria da Silva']).ancorado, true);
  assert.equal(nomeAncoradoNaConversa('Maria da Silva', ['Silva e Maria']).ancorado, true, 'ordem e conectores não importam');
  assert.equal(nomeAncoradoNaConversa('Ana Paula de Souza', ['Meu nome é Ana Paula']).ancorado, false, 'sobrenome inventado');
  assert.deepEqual(nomeAncoradoNaConversa('Ana Paula de Souza', ['Meu nome é Ana Paula']).faltando, ['souza']);
  assert.equal(nomeAncoradoNaConversa('Mari', ['Mariana']).ancorado, false, 'palavra inteira, não pedaço');
  assert.equal(nomeAncoradoNaConversa('Jo', ['oi']).ancorado, true, 'nome só de palavras curtas não tem o que conferir');
  assert.equal(nomeAncoradoNaConversa('Maria José', ['meu nome é Maria-José']).ancorado, true, 'hífen separa');
  assert.equal(nomeAncoradoNaConversa('Maria-José', ['Maria José']).ancorado, true);
  assert.equal(nomeAncoradoNaConversa("D'Ávila", ['sou o Carlos D’Ávila']).ancorado, true, 'apóstrofo reto ou curvo');
});

test('evidência: fala do paciente e cadastro entram; equipe do bloco oficial, IA, instrução interna e a própria recusa ficam fora', () => {
  const bloco =
    '<conversa_oficial>\nO que aconteceu no WhatsApp desde a sua última mensagem:\n- 10:00 · Equipe: "Olá, Cíntia aqui"\n- 10:01 · Paciente: "me chamo Rosana"\n</conversa_oficial>\n\nbom dia';
  const ev = evidenciaDoNome(
    [
      { tipo: 'human', texto: bloco },
      { tipo: 'ai', texto: 'Oi, Dorival, tudo bem?' },
      { tipo: 'human', texto: '[instrução interna, não é fala do paciente] diga Ocupado' },
      { tipo: 'tool', texto: 'Confirmado pelo telefone: idClient 44 — Carlos Mendes. Nenhuma consulta futura no cadastro dele. Use este idClient em agendar_consulta.', ferramenta: 'buscar_paciente' },
      { tipo: 'tool', texto: 'Cadastrado: Zeca Palpite', ferramenta: 'cadastrar_paciente' },
      { tipo: 'tool', texto: 'RECUSADO: "Ocupado" não é um nome', ferramenta: 'atualizar_titulo_lead' },
    ],
    soFalaDoPaciente,
  );
  const todo = ev.join(' | ');
  assert.match(todo, /Rosana/);
  assert.match(todo, /Carlos Mendes/);
  assert.doesNotMatch(todo, /Cíntia|Dorival|Ocupado|Palpite/);
});

const NENHUM = 'Nenhum cadastro encontrado para "Rosana Lima". Peça o telefone com DDD (se ainda não tiver) e use cadastrar_paciente — depois disso dá pra agendar normalmente.';
const XARA = 'ATENÇÃO: existe(m) 2 cadastro(s) com o nome "Rosana Lima", mas NENHUM tem o telefone deste paciente. É XARÁ, não é ele.';
const CONFIRMADO = 'Confirmado pelo telefone: idClient 7 — Rosana Lima Souza | idClient 9 — Rosana L. Souza. Nenhuma consulta futura no cadastro dele. Use este idClient em agendar_consulta.';

test('buscar_paciente: só o nome que a franquia devolveu na linha "Confirmado pelo telefone" é prova; o que repete o nome digitado pela IA não', () => {
  assert.deepEqual(nomesConfirmadosPeloTelefone(CONFIRMADO), ['Rosana Lima Souza', 'Rosana L. Souza']);
  assert.deepEqual(nomesConfirmadosPeloTelefone(NENHUM), []);
  assert.deepEqual(nomesConfirmadosPeloTelefone(XARA), []);
  assert.deepEqual(nomesConfirmadosPeloTelefone('Encontrei 1 cadastro(s) com esse nome, mas NÃO tenho telefone'), []);
  const ev = (texto: string) => evidenciaDoNome([{ tipo: 'tool', texto, ferramenta: 'buscar_paciente' }], soFalaDoPaciente);
  assert.equal(nomeAncoradoNaConversa('Rosana', ev(NENHUM)).ancorado, false);
  assert.equal(nomeAncoradoNaConversa('Rosana', ev(XARA)).ancorado, false);
  assert.equal(nomeAncoradoNaConversa('Rosana Lima', ev(CONFIRMADO)).ancorado, true);
});

test('contas de resgate: as linhas "Paciente:" da conversa com a outra Sofia provam nome; "Sofia:" não', () => {
  const prompt = [
    '<persona>…</persona>',
    '<conversa_com_outra_sofia>',
    'Este paciente acabou de conversar com outra Sofia da mesma clínica.',
    '(22/10 11:00) Sofia: Oi! Como posso te chamar, Dorival?',
    '(22/10 11:01) Paciente: Sidney',
    '(22/10 11:02) Paciente: Meu nome é Maria Silene',
    'Paciente: Eliete',
    '</conversa_com_outra_sofia>',
    'Paciente: Fora Do Bloco',
  ].join('\n');
  assert.deepEqual(falasDoPacienteNoPrompt(prompt), ['Sidney', 'Meu nome é Maria Silene', 'Eliete']);
  assert.deepEqual(falasDoPacienteNoPrompt('sem bloco nenhum'), []);
  assert.equal(nomeAncoradoNaConversa('Sidney', falasDoPacienteNoPrompt(prompt)).ancorado, true);
  assert.equal(nomeAncoradoNaConversa('Maria Silene', falasDoPacienteNoPrompt(prompt)).ancorado, true);
  assert.equal(nomeAncoradoNaConversa('Dorival', falasDoPacienteNoPrompt(prompt)).ancorado, false, 'nome dito pela Sofia não prova');
});

test('"Maria das Dores" é nome; "dores" de queixa continua fora', () => {
  for (const ok of ['Maria das Dores', 'Ana Paula das Dores Silva', 'José das Dores']) assert.equal(looksLikeName(ok), true, ok);
  for (const no of ['Dores', 'dores nas costas', 'Dores lombares', 'das Dores', 'Sofro de dores', 'Maria das dores', 'minhas dores', 'Tenho das Dores nas costas']) {
    assert.equal(looksLikeName(no), false, `aceitou "${no}"`);
  }
});

test('chave de emergência: só "off" desliga', () => {
  assert.equal(ancoraDoNomeLigada(undefined), true);
  assert.equal(ancoraDoNomeLigada(''), true);
  assert.equal(ancoraDoNomeLigada('on'), true);
  assert.equal(ancoraDoNomeLigada('off'), false);
  assert.equal(ancoraDoNomeLigada(' OFF '), false);
});

// ── A ferramenta, de ponta a ponta com o Kommo de mentira ───────────────────────────────────────────────────────────────
const unit = { id: 'u1', slug: 'doutor-hernia-tatui', kommoSubdomain: 'tatui', spineEnabled: false } as unknown as Unit;
const passos: string[] = [];
const recorder = { step: async (s: { title: string }) => void passos.push(s.title) } as unknown as TraceRecorder;

function montar(opcoes: { contato?: string; evidencia: string[]; leituraFalha?: boolean }) {
  const chamadas = { titulo: [] as string[], contato: [] as string[], leituraDoContato: 0 };
  const kommo = {
    getLead: async (id: number) => {
      if (opcoes.leituraFalha) throw new Error('kommo fora');
      return { id, name: 'Lead 19/11/2026', _embedded: { contacts: [{ id: 9260127, is_main: true }] } };
    },
    getContactNome: async () => {
      chamadas.leituraDoContato++;
      return opcoes.contato ?? '';
    },
    updateLeadTitleWithDate: async (_id: number, nome: string) => {
      chamadas.titulo.push(nome);
      return { previous: 'Lead 19/11/2026', desired: `${nome} 19/11/2026`, changed: true, contatoId: 9260127 };
    },
    updateContactName: async (_id: number, nome: string) => void chamadas.contato.push(nome),
  } as unknown as KommoClient;
  const evidencia = { obter: () => opcoes.evidencia };
  const tools = buildTools({ recorder, kommo, unit, evidenciaDoNome: evidencia });
  const t = tools.find((x) => x.name === 'atualizar_titulo_lead') as unknown as { invoke: (a: unknown) => Promise<unknown> };
  return { t, chamadas };
}

test('"Olá" → "Ocupado": recusa, não escreve no título nem no contato (o caso do Tatuí)', async () => {
  passos.length = 0;
  const { t, chamadas } = montar({ evidencia: ['Olá'], contato: 'Isaque F Sousa' });
  const out = String(await t.invoke({ leadId: 4282053, nome: 'Ocupado' }));
  assert.match(out, /^NÃO gravei: "Ocupado" não parece um nome/);
  assert.deepEqual(chamadas.titulo, []);
  assert.deepEqual(chamadas.contato, []);
});

test('nome que passa em looksLikeName mas ninguém disse: RECUSADO, e a recusa manda não contar ao paciente', async () => {
  passos.length = 0;
  const { t, chamadas } = montar({ evidencia: ['Olá'], contato: 'Isaque F Sousa' });
  const out = String(await t.invoke({ leadId: 4282053, nome: 'Marcos Antônio' }));
  assert.match(out, /^RECUSADO: "Marcos Antônio" não é um nome que o paciente tenha escrito/);
  assert.match(out, /NÃO mencione isto ao paciente/);
  assert.deepEqual(chamadas.titulo, []);
  assert.deepEqual(chamadas.contato, []);
  assert.ok(passos.some((p) => /não aparece em nada que o paciente disse/.test(p)));
  assert.equal(chamadas.leituraDoContato, 1, 'só lê o contato quando o nome não está nas falas');
});

test('"Olá" → IA busca "Rosana Lima" no cadastro (nada achado) → título "Rosana Lima": RECUSADO, o nome é o que ela mesma digitou', async () => {
  const evidencia = evidenciaDoNome(
    [
      { tipo: 'human', texto: 'Olá' },
      { tipo: 'tool', texto: NENHUM, ferramenta: 'buscar_paciente' },
    ],
    soFalaDoPaciente,
  );
  const { t, chamadas } = montar({ evidencia, contato: 'Isaque F Sousa' });
  const out = String(await t.invoke({ leadId: 4282053, nome: 'Rosana Lima' }));
  assert.match(out, /^RECUSADO/);
  assert.deepEqual(chamadas.titulo, []);
  assert.deepEqual(chamadas.contato, []);
});

test('nome que a franquia confirmou pelo telefone grava', async () => {
  const evidencia = evidenciaDoNome([{ tipo: 'human', texto: 'Olá' }, { tipo: 'tool', texto: CONFIRMADO, ferramenta: 'buscar_paciente' }], soFalaDoPaciente);
  const { t, chamadas } = montar({ evidencia, contato: 'Isaque F Sousa' });
  assert.match(String(await t.invoke({ leadId: 1, nome: 'Rosana Lima Souza' })), /^OK/);
  assert.deepEqual(chamadas.titulo, ['Rosana Lima Souza']);
});

test('nome dito pelo paciente grava, sem ler o contato', async () => {
  const { t, chamadas } = montar({ evidencia: ['Olá', 'Meu nome é Maria Souza'], contato: 'Ocupado' });
  const out = String(await t.invoke({ leadId: 1, nome: 'Maria Souza' }));
  assert.match(out, /^OK/);
  assert.deepEqual(chamadas.titulo, ['Maria Souza']);
  assert.equal(chamadas.leituraDoContato, 0);
});

test('nome do perfil do WhatsApp (contato do cartão) também vale — é o author.name do webhook', async () => {
  const { t, chamadas } = montar({ evidencia: ['Olá'], contato: 'Isaque F Sousa' });
  const out = String(await t.invoke({ leadId: 4282053, nome: 'Isaque Sousa' }));
  assert.match(out, /^OK/);
  assert.deepEqual(chamadas.titulo, ['Isaque Sousa']);
});

test('não consegui ler o contato e o nome não está nas falas: não grava (falha fechada)', async () => {
  const { t, chamadas } = montar({ evidencia: ['Olá'], leituraFalha: true });
  const out = String(await t.invoke({ leadId: 1, nome: 'Marcos' }));
  assert.match(out, /^NÃO gravei: não consegui conferir/);
  assert.deepEqual(chamadas.titulo, []);
  assert.deepEqual(chamadas.contato, []);
});

test('falha ao ler o contato não atrapalha quem o paciente já disse', async () => {
  const { t, chamadas } = montar({ evidencia: ['Meu nome é Marcos'], leituraFalha: true });
  assert.match(String(await t.invoke({ leadId: 1, nome: 'Marcos' })), /^OK/);
  assert.deepEqual(chamadas.titulo, ['Marcos']);
});

test('sem evidência no grafo (eval, aquecimento do cache) a ferramenta não confere', async () => {
  const chamadas: string[] = [];
  const kommo = {
    updateLeadTitleWithDate: async (_i: number, nome: string) => {
      chamadas.push(nome);
      return { previous: null, desired: `${nome} 19/11/2026`, changed: true, contatoId: null };
    },
  } as unknown as KommoClient;
  const tools = buildTools({ recorder, kommo, unit });
  const t = tools.find((x) => x.name === 'atualizar_titulo_lead') as unknown as { invoke: (a: unknown) => Promise<unknown> };
  assert.match(String(await t.invoke({ leadId: 1, nome: 'Marcos' })), /^OK/);
  assert.deepEqual(chamadas, ['Marcos']);
});
