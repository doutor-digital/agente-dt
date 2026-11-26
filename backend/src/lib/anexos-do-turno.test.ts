import test from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { avisarComprovanteComIaPausada, avisarComprovanteDoLiteComIaPausada, lerAnexosDoTurno, MARCA_ANEXO_NAO_LIDO } from './anexos-do-turno.js';

const taxa = { id: 'u1', slug: 'doutor-hernia-boa-vista', spineBookingRequiresPayment: true } as unknown as Unit;
const semTaxa = { id: 'u2', slug: 'doutor-hernia-x', spineBookingRequiresPayment: false } as unknown as Unit;
const kommo = (() => ({ marca: 'kommo' })) as never;

function cenario(lidos: { texto?: string; lidos?: number; comprovantes?: number; paraEntregar?: string[]; naoLidos?: number }) {
  const passos: Array<{ kind: string; title: string }> = [];
  const tarefas: Array<Record<string, unknown>> = [];
  const chamadas = { ler: 0, conversa: 0 };
  const deps = {
    kommo,
    conversa: (async () => { chamadas.conversa++; return []; }) as never,
    ler: (async () => { chamadas.ler++; return { texto: '', lidos: 0, comprovantes: 0, paraEntregar: [], naoLidos: 0, ...lidos }; }) as never,
    abrirTarefa: (async (a: Record<string, unknown>) => { tarefas.push(a); return 'criada'; }) as never,
  };
  const recorder = { step: async (s: { kind: string; title: string }) => { passos.push(s); } } as never;
  return { deps, passos, tarefas, chamadas, recorder };
}

test('unidade SEM taxa de reserva: não lê nada, não vai ao Kommo', async () => {
  const c = cenario({ texto: 'x' });
  const r = await lerAnexosDoTurno(semTaxa, 10, null, c.recorder, c.deps);
  assert.deepEqual(r, { texto: '', paraEntregar: [], msgs: null });
  assert.equal(c.chamadas.ler + c.chamadas.conversa, 0);
});

test('Boa Vista: comprovante lido na rota oficial vai na fala, com o que entregar depois do turno', async () => {
  const c = cenario({ texto: '[imagem do cliente]: COMPROVANTE: ... [comprovante-lido:abc]', lidos: 1, comprovantes: 1, paraEntregar: ['abc'] });
  const r = await lerAnexosDoTurno(taxa, 10, null, c.recorder, c.deps);
  assert.match(r.texto, /comprovante-lido:abc/);
  assert.deepEqual(r.paraEntregar, ['abc']);
  assert.equal(c.chamadas.conversa, 1, 'sem a conversa já lida, vai à rota oficial uma vez');
  assert.equal(c.tarefas.length, 0);
  assert.ok(c.passos.some((p) => /1 lido\(s\), 1 comprovante\(s\)/.test(p.title)));
});

test('conversa já lida pelo turno: não relê a rota oficial', async () => {
  const c = cenario({});
  await lerAnexosDoTurno(taxa, 10, [], c.recorder, c.deps);
  assert.equal(c.chamadas.conversa, 0);
  assert.equal(c.chamadas.ler, 1);
});

test('anexo que o servidor não leu: o modelo é avisado (não diz «recebi») e a equipe ganha a tarefa', async () => {
  const c = cenario({ naoLidos: 1 });
  const r = await lerAnexosDoTurno(taxa, 10, [], c.recorder, c.deps);
  assert.equal(r.texto, MARCA_ANEXO_NAO_LIDO);
  assert.equal(c.tarefas.length, 1);
  assert.equal(c.tarefas[0].motivo, 'anexo_nao_lido');
  assert.equal(c.tarefas[0].leadId, 10);
});

test('falha ao ler a rota oficial nunca derruba o turno — e a conversa já buscada continua à mão de quem chama', async () => {
  const c = cenario({});
  c.deps.ler = (async () => { throw new Error('kommo fora'); }) as never;
  const r = await lerAnexosDoTurno(taxa, 10, [], c.recorder, c.deps);
  assert.deepEqual(r, { texto: '', paraEntregar: [], msgs: [] });
  // buscou a conversa, e a leitura falhou: devolve a que buscou (não manda quem chama ao Kommo outra vez)
  const lista = [{ id: 'm1' }] as never;
  const c2 = cenario({});
  c2.deps.conversa = (async () => lista) as never;
  c2.deps.ler = (async () => { throw new Error('kommo fora'); }) as never;
  const r2 = await lerAnexosDoTurno(taxa, 10, null, c2.recorder, c2.deps);
  assert.equal(r2.msgs, lista);
});

test('Lite com a IA pausada: comprovante lido na rota oficial vira uma tarefa por comprovante; NÃO marca como entregue', async () => {
  const c = cenario({ texto: '[arquivo do cliente]: COMPROVANTE: R$ 100,00 favorecido DOUTOR HERNIA [comprovante-lido:a]', lidos: 2, comprovantes: 2, paraEntregar: ['a', 'b'] });
  const n = await avisarComprovanteDoLiteComIaPausada(taxa, 7, c.recorder, c.deps);
  assert.equal(n, 2);
  assert.deepEqual(c.tarefas.map((t) => t.chaveExtra), ['ia_pausada:a', 'ia_pausada:b']);
  assert.match(String(c.tarefas[0].detalhe), /DOUTOR HERNIA/);
});

test('Lite com a IA pausada: foto que não é comprovante (ou que não carregou) não abre tarefa', async () => {
  const c = cenario({ lidos: 1, comprovantes: 0 });
  assert.equal(await avisarComprovanteDoLiteComIaPausada(taxa, 7, c.recorder, c.deps), 0);
  const c2 = cenario({ naoLidos: 1 });
  assert.equal(await avisarComprovanteDoLiteComIaPausada(taxa, 7, c2.recorder, c2.deps), 0);
  assert.equal(c.tarefas.length + c2.tarefas.length, 0);
  const c3 = cenario({ comprovantes: 1, paraEntregar: ['x'] });
  assert.equal(await avisarComprovanteDoLiteComIaPausada(semTaxa, 7, c3.recorder, c3.deps), 0, 'unidade sem taxa: nada');
  assert.equal(c3.chamadas.conversa, 0);
});

test('comprovante com a IA pausada: tarefa «comprovante», uma por imagem, dizendo que a IA não marcou', async () => {
  const c = cenario({});
  await avisarComprovanteComIaPausada(taxa, 23725091, c.recorder, { id: 'leitura-1', resumo: 'R$ 100,00; favorecido: DOUTOR HERNIA' }, c.deps);
  assert.equal(c.tarefas.length, 1);
  const t = c.tarefas[0];
  assert.equal(t.motivo, 'comprovante');
  assert.equal(t.chaveExtra, 'ia_pausada:leitura-1');
  assert.equal(t.unitId, 'u1');
  assert.match(String(t.detalhe), /PAUSADA[\s\S]*NÃO marcou[\s\S]*DOUTOR HERNIA/);
});

test('comprovante com a IA pausada: falha ao abrir a tarefa não lança', async () => {
  const c = cenario({});
  c.deps.abrirTarefa = (async () => { throw new Error('kommo fora'); }) as never;
  await avisarComprovanteComIaPausada(taxa, 1, c.recorder, { id: null, resumo: 'x' }, c.deps);
});
