import test from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { abrirTarefaParaEquipe } from '../agent/confirmacao-so-com-crm.js';
import { avisarComprovanteComIaPausada, avisarComprovanteDoLiteComIaPausada, lerAnexosDoTurno, MARCA_ANEXO_NAO_LIDO } from './anexos-do-turno.js';

const taxa = { id: 'u1', slug: 'doutor-hernia-boa-vista', spineBookingRequiresPayment: true } as unknown as Unit;
const semTaxa = { id: 'u2', slug: 'doutor-hernia-x', spineBookingRequiresPayment: false } as unknown as Unit;
const kommo = (() => ({ marca: 'kommo' })) as never;
const AVISO = 'Você recebeu uma mensagem de mídia (ID da mensagem: AC5FBE1D8C7FD104AC191A07E4A05ADE. Aguarde o carregamento';
const agoraS = () => Math.floor(Date.now() / 1000);
const fotoDoPaciente = (id: string, link: string | null) => ({ id, em: new Date(Date.now() - 2_000), direcao: 'entrada', autor: 'paciente', autorNome: 'P', texto: '', anexo: { tipo: 'picture', link }, status: null }) as never;

function cenario(lidos: { texto?: string; lidos?: number; comprovantes?: number; paraEntregar?: string[]; naoLidos?: number }) {
  const passos: Array<{ kind: string; title: string }> = [];
  const tarefas: Array<Record<string, unknown>> = [];
  const chamadas = { ler: 0, conversa: 0 };
  const deps = {
    kommo,
    conversa: (async () => { chamadas.conversa++; return []; }) as never,
    dormir: async () => undefined,
    esperas: [1, 1, 1],
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
  const n = await avisarComprovanteDoLiteComIaPausada(taxa, 7, c.recorder, AVISO, c.deps);
  assert.equal(n, 2);
  assert.deepEqual(c.tarefas.map((t) => t.chaveExtra), ['ia_pausada:a', 'ia_pausada:b']);
  assert.match(String(c.tarefas[0].detalhe), /DOUTOR HERNIA/);
});

test('Lite com a IA pausada: foto que não é comprovante não abre tarefa', async () => {
  const c = cenario({ lidos: 1, comprovantes: 0 });
  assert.equal(await avisarComprovanteDoLiteComIaPausada(taxa, 7, c.recorder, AVISO, c.deps), 0);
  assert.equal(c.tarefas.length, 0);
  const c3 = cenario({ comprovantes: 1, paraEntregar: ['x'] });
  assert.equal(await avisarComprovanteDoLiteComIaPausada(semTaxa, 7, c3.recorder, AVISO, c3.deps), 0, 'unidade sem taxa: nada');
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

test('MESMO comprovante parado com a IA pausada: 4 mídias com 20 min de intervalo abrem UMA tarefa, não quatro', async () => {
  let agora = Date.now();
  const marcados = new Map<string, number>();
  const dedupe = {
    avisoRecente: async (_u: string, _l: number | string, chave: string, janela: number = 24 * 3_600_000) => marcados.has(chave) && agora - marcados.get(chave)! < janela,
    marcarAviso: async (_u: string, _l: number | string, chave: string) => { marcados.set(chave, agora); },
  };
  const criadas: string[] = [];
  const kommoFalso = (() => ({ getLead: async () => ({ name: 'x', responsible_user_id: 1 }), createTask: async (t: { text: string }) => { criadas.push(t.text); return { id: criadas.length }; } })) as never;
  const c = cenario({});
  const deps = { kommo: kommoFalso, abrirTarefa: ((a: Record<string, unknown>) => abrirTarefaParaEquipe({ ...a, dedupe, agora: () => agora } as never)) as never };
  for (let i = 0; i < 4; i++) {
    await avisarComprovanteComIaPausada(taxa, 23725091, c.recorder, { id: 'leitura-1', resumo: 'R$ 100,00' }, deps);
    agora += 20 * 60_000;
  }
  assert.equal(criadas.length, 1);
  // outro comprovante (outra leitura) é outra tarefa
  await avisarComprovanteComIaPausada(taxa, 23725091, c.recorder, { id: 'leitura-2', resumo: 'R$ 100,00' }, deps);
  assert.equal(criadas.length, 2);
});

test('Lite com a IA pausada: espera a foto carregar antes de ler (a foto sem link não vira «0 comprovantes»)', async () => {
  const c = cenario({ texto: '[arquivo do cliente]: COMPROVANTE: R$ 100,00', lidos: 1, comprovantes: 1, paraEntregar: ['a'] });
  const leituras = [[fotoDoPaciente('f', null)], [fotoDoPaciente('f', null)], [fotoDoPaciente('f', 'https://x/c.jpg')]];
  let i = 0;
  const esperou: number[] = [];
  c.deps.conversa = (async () => leituras[Math.min(i++, leituras.length - 1)]) as never;
  (c.deps as { dormir: (ms: number) => Promise<void> }).dormir = async (ms) => { esperou.push(ms); };
  const n = await avisarComprovanteDoLiteComIaPausada(taxa, 7, c.recorder, AVISO, c.deps);
  assert.equal(n, 1);
  assert.equal(esperou.length, 2, 'esperou duas vezes e leu quando o link apareceu');
  assert.equal(c.tarefas.length, 1);
});

test('Lite com a IA pausada: foto que não carregou depois da espera abre «ver anexo» (janela longa), não fica muda', async () => {
  const c = cenario({ naoLidos: 1 });
  c.deps.conversa = (async () => [fotoDoPaciente('f', null)]) as never;
  assert.equal(await avisarComprovanteDoLiteComIaPausada(taxa, 7, c.recorder, AVISO, c.deps), 0);
  assert.equal(c.tarefas.length, 1);
  assert.equal(c.tarefas[0].motivo, 'anexo_nao_lido');
  assert.equal(c.tarefas[0].janelaMs, 6 * 3_600_000);
});

test('turno comum com taxa: só ENTREGA o comprovante guardado (soEntregar) — sem conversa já lida não vai ao Kommo, sem tarefa', async () => {
  const c = cenario({ texto: '[imagem do cliente]: COMPROVANTE: leitura guardada pelo servidor [comprovante-lido:a]', paraEntregar: ['a'] });
  const semConversa = await lerAnexosDoTurno(taxa, 10, null, c.recorder, { ...c.deps, soEntregar: true });
  assert.deepEqual(semConversa.paraEntregar, []);
  assert.equal(c.chamadas.conversa + c.chamadas.ler, 0);
  const r = await lerAnexosDoTurno(taxa, 10, [], c.recorder, { ...c.deps, soEntregar: true });
  assert.deepEqual(r.paraEntregar, ['a']);
  assert.match(r.texto, /comprovante-lido:a/);
  assert.equal(c.tarefas.length, 0);
});
