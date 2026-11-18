import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  PRAZO_DA_TAREFA_S,
  ehToqueDeDuvida,
  estadoDaDuvidaNoLembrete,
  podeSerDuvidaDoLembrete,
  textoDaTarefaDeDuvida,
  tratarDuvidaDoLembrete,
  type DepsDuvida,
} from './duvida-no-lembrete.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId } from './automacoes.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { Simulacao } from './so-no-papel.js';

/**
 * Salto, lead 3185496 (17/11/2026): o robô do Kommo mandou o lembrete da consulta de hoje, o paciente tocou "Tenho uma dúvida" e a
 * Sofia respondeu por cima. O papel da unidade manda passar para a secretária calado — agora em código.
 */

beforeEach(() => _semearParaTeste([]));

const SLUG = 'doutor-hernia-salto';
const unidade = { id: 'u-salto', slug: SLUG, kommoPausedFieldId: 777 } as unknown as Unit;
const LEAD = 3185496;
const AGORA = new Date('2026-11-17T16:16:55-03:00');
const em = (hhmmss: string) => new Date(`2026-11-17T${hhmmss}-03:00`);
const LIGADO = { DUVIDA_NO_LEMBRETE_SLUGS: SLUG } as NodeJS.ProcessEnv;
const VAZIO = {} as NodeJS.ProcessEnv;

const LEMBRETE = '❗️ IMPORTANTE\n\nPara a sua consulta de hoje às 17:00, traga seus exames anteriores e documento com foto.\n\nFicou alguma dúvida?';
let seq = 0;
const msg = (
  direcao: 'entrada' | 'saida',
  quando: Date,
  texto: string,
  autor: MensagemOficial['autor'] = direcao === 'entrada' ? 'paciente' : 'sofia',
  autorNome = direcao === 'entrada' ? '' : 'Salesbot',
): MensagemOficial => ({ id: String(++seq), em: quando, direcao, autor, autorNome, texto, anexo: null, status: null });

const conversaDoLembrete = (): MensagemOficial[] => [msg('saida', em('16:16:02'), LEMBRETE), msg('entrada', em('16:16:51'), 'Tenho uma dúvida')];

function fakes(over: Partial<DepsDuvida> = {}) {
  const c = { pausas: 0, simulacoes: [] as Simulacao[], tarefas: [] as Array<{ leadId?: number | null; text: string; completeAt: number }> };
  const deps: DepsDuvida = {
    agora: () => AGORA,
    oficiais: async () => conversaDoLembrete(),
    falasDaSofia: async () => [],
    pausado: async () => false,
    pausar: async () => {
      c.pausas++;
      return 'marcou';
    },
    simular: (_u, _a, s) => {
      c.simulacoes.push(s);
    },
    ...over,
  };
  const kommo = {
    createTask: async (t: { leadId?: number | null; text: string; completeAt: number }) => {
      c.tarefas.push(t);
      return { id: 1 };
    },
  };
  return { deps, c, kommo: kommo as never };
}
const conv = { id: 'c1', contactName: 'Jailton', phone: null };
const tratar = (f: ReturnType<typeof fakes>, texto = 'Tenho uma dúvida', env = LIGADO) =>
  tratarDuvidaDoLembrete({ unit: unidade, leadId: LEAD, texto, conv, kommo: f.kommo, env }, f.deps);

// ── o texto ─────────────────────────────────────────────────────────────────────────────────────

test('só o texto do botão conta (sem acento, caixa ou pontuação); frase com mais coisa é conversa e vai para a Sofia', () => {
  for (const t of ['Tenho uma dúvida', 'tenho uma duvida', ' TENHO UMA DÚVIDA! ', 'Tenho uma dúvida 🤔']) assert.equal(ehToqueDeDuvida(t), true, t);
  for (const t of ['tenho uma dúvida sobre o valor', 'tenho duas dúvidas', 'dúvida', 'Está tudo certo', 'Confirmar presença', '']) assert.equal(ehToqueDeDuvida(t), false, t);
});

test('a chave nasce em "só no papel" na rede toda; a lista do .env diz quem está ligado', () => {
  assert.equal(automacaoPorId('duvida-no-lembrete')?.chave, 'DUVIDA_NO_LEMBRETE_SLUGS');
  assert.equal(automacaoPorId('duvida-no-lembrete')?.quandoVazio, 'seco');
  assert.equal(estadoDaDuvidaNoLembrete(SLUG, VAZIO), 'seco');
  assert.equal(estadoDaDuvidaNoLembrete(SLUG, LIGADO), 'ligado');
  assert.equal(estadoDaDuvidaNoLembrete('doutor-hernia-timbo', LIGADO), 'seco');
});

test('o webhook só responde 200 antes quando a chave não está desligada (seco ou ligado) e o texto é o do botão', () => {
  assert.equal(podeSerDuvidaDoLembrete(SLUG, 'Tenho uma dúvida', LIGADO), true);
  assert.equal(podeSerDuvidaDoLembrete(SLUG, 'Tenho uma dúvida', VAZIO), true); // seco: decide e registra
  assert.equal(podeSerDuvidaDoLembrete(SLUG, 'Tenho uma dúvida sobre o valor', LIGADO), false);
  _semearParaTeste([{ slug: SLUG, automacao: 'duvida-no-lembrete', estado: 'desligado' }]);
  assert.equal(podeSerDuvidaDoLembrete(SLUG, 'Tenho uma dúvida', LIGADO), false);
});

// ── ligado ──────────────────────────────────────────────────────────────────────────────────────

test('Salto 3185496, ligado: toque no lembrete do robô → pausa, tarefa para a equipe em 10 min, e a Sofia não responde (devolve o resultado)', async () => {
  const f = fakes();
  const r = await tratar(f);
  assert.deepEqual(r, { resultado: 'passou', pausa: 'marcou', tarefa: true });
  assert.equal(f.c.pausas, 1);
  assert.equal(f.c.tarefas.length, 1);
  assert.equal(f.c.tarefas[0].leadId, LEAD);
  assert.equal(f.c.tarefas[0].completeAt, Math.floor(AGORA.getTime() / 1000) + PRAZO_DA_TAREFA_S);
  assert.match(f.c.tarefas[0].text, /Jailton/);
  assert.match(f.c.tarefas[0].text, /Tenho uma dúvida/);
  assert.match(f.c.tarefas[0].text, /da consulta/);
  assert.equal(f.c.simulacoes.length, 0);
});

test('o paciente não recebe nada: o tratamento nem tem como enviar mensagem (só pausa e tarefa)', async () => {
  const f = fakes();
  // o kommo falso só tem createTask: qualquer sendChatReply lançaria TypeError e o teste falharia
  await tratar(f);
  assert.equal(f.c.tarefas.length, 1);
});

test('lembrete de SESSÃO: a tarefa diz «da sessão»', () => {
  assert.match(textoDaTarefaDeDuvida({ slug: SLUG, nome: null, prova: { tipo: 'sessao' }, texto: 'Tenho uma dúvida' }), /lembrete da sessão/);
  assert.match(textoDaTarefaDeDuvida({ slug: SLUG, nome: null, prova: { tipo: 'incerto' }, texto: 'Tenho uma dúvida' }), /\[Contato: paciente\]/);
});

test('a tarefa falhar não desfaz a pausa nem devolve a conversa à Sofia: passa para a equipe e diz que a tarefa falhou', async () => {
  const f = fakes();
  const kommo = {
    createTask: async () => {
      throw new Error('429');
    },
  };
  const r = await tratarDuvidaDoLembrete({ unit: unidade, leadId: LEAD, texto: 'Tenho uma dúvida', conv, kommo: kommo as never, env: LIGADO }, f.deps);
  assert.deepEqual(r, { resultado: 'passou', pausa: 'marcou', tarefa: false });
  assert.equal(f.c.pausas, 1);
});

// ── quando NÃO é caso daqui: segue para a Sofia como sempre ─────────────────────────────────────

test('chave desligada na unidade (lista vazia e linha "desligado" na tela): nada acontece, nem lê a conversa', async () => {
  _semearParaTeste([{ slug: SLUG, automacao: 'duvida-no-lembrete', estado: 'desligado' }]);
  let leu = 0;
  const f = fakes({ oficiais: async () => { leu++; return conversaDoLembrete(); } });
  assert.equal(await tratar(f), null);
  assert.deepEqual([leu, f.c.pausas, f.c.tarefas.length], [0, 0, 0]);
});

test('texto que não é o do botão não lê a conversa nem pausa', async () => {
  let leu = 0;
  const f = fakes({ oficiais: async () => { leu++; return conversaDoLembrete(); } });
  assert.equal(await tratar(f, 'Tenho uma dúvida sobre o valor'), null);
  assert.equal(await tratar(f, 'Está tudo certo'), null);
  assert.deepEqual([leu, f.c.pausas, f.c.tarefas.length], [0, 0, 0]);
});

test('a última mensagem que saiu NÃO é lembrete de robô → segue para a Sofia (equipe, fala da Sofia, robô sem cara de lembrete, lembrete velho)', async () => {
  const casos: Array<[string, MensagemOficial[]]> = [
    ['equipe falou por último', [msg('saida', em('16:16:02'), LEMBRETE), msg('saida', em('16:16:30'), 'Oi, posso ajudar?', 'equipe', 'WhatsApp Business'), msg('entrada', em('16:16:51'), 'Tenho uma dúvida')]],
    ['robô sem cara de lembrete', [msg('saida', em('16:16:02'), 'Olá! Aqui é a Clínica Doutor Hérnia, como podemos ajudar?'), msg('entrada', em('16:16:51'), 'Tenho uma dúvida')]],
    ['lembrete de há 2 dias', [msg('saida', new Date(AGORA.getTime() - 48 * 3600_000), LEMBRETE), msg('entrada', em('16:16:51'), 'Tenho uma dúvida')]],
    ['conversa vazia', [msg('entrada', em('16:16:51'), 'Tenho uma dúvida')]],
  ];
  for (const [nome, msgs] of casos) {
    const f = fakes({ oficiais: async () => msgs });
    assert.equal(await tratar(f), null, nome);
    assert.deepEqual([f.c.pausas, f.c.tarefas.length], [0, 0], nome);
  }
});

test('a última saída é fala da Sofia (guardada no nosso banco) com cara de lembrete → não é do robô, segue para a Sofia', async () => {
  const f = fakes({ falasDaSofia: async () => [LEMBRETE] });
  assert.equal(await tratar(f), null);
  assert.equal(f.c.pausas, 0);
});

test('não li a conversa oficial → sem prova, segue para a Sofia (o lado de antes)', async () => {
  const f = fakes({ oficiais: async () => null });
  assert.equal(await tratar(f), null);
  assert.equal(f.c.pausas, 0);
});

test('cartão que já está com "Pausar IA" marcado não ganha 2ª tarefa nem 2ª pausa (segundo toque do paciente)', async () => {
  const f = fakes({ pausado: async () => true });
  assert.equal(await tratar(f), null);
  assert.deepEqual([f.c.pausas, f.c.tarefas.length], [0, 0]);
});

test('não deu para ler a caixinha → o erro sobe e o webhook manda para a Sofia (sem pausa, sem tarefa)', async () => {
  const f = fakes({ pausado: async () => { throw new Error('429'); } });
  await assert.rejects(() => tratar(f), /429/);
  assert.deepEqual([f.c.pausas, f.c.tarefas.length], [0, 0]);
});

test('unidade sem a caixinha "Pausar IA": não há como segurar a Sofia → ela responde como sempre, sem tarefa solta', async () => {
  const f = fakes({ pausar: async () => 'sem_campo' });
  assert.equal(await tratar(f), null);
  assert.equal(f.c.tarefas.length, 0);
});

// ── só no papel ─────────────────────────────────────────────────────────────────────────────────

test('"só no papel" (o padrão da rede): registra na lista e NÃO pausa, NÃO abre tarefa — a Sofia segue como hoje', async () => {
  const f = fakes();
  const r = await tratar(f, 'Tenho uma dúvida', VAZIO);
  assert.equal(r, null);
  assert.deepEqual([f.c.pausas, f.c.tarefas.length], [0, 0]);
  assert.equal(f.c.simulacoes.length, 1);
  assert.equal(f.c.simulacoes[0].leadId, LEAD);
  assert.equal(f.c.simulacoes[0].acao, 'gravaria');
  assert.match(f.c.simulacoes[0].alvo, /Pausar IA/);
});

test('"só no papel" com o cartão já pausado não registra nada (não gravaria)', async () => {
  const f = fakes({ pausado: async () => true });
  assert.equal(await tratar(f, 'Tenho uma dúvida', VAZIO), null);
  assert.equal(f.c.simulacoes.length, 0);
});

// ── dois toques seguidos ────────────────────────────────────────────────────────────────────────

test('dois toques seguidos (ids de mensagem diferentes) antes da marca: uma pausa, uma tarefa; o 2º espera o 1º, vê a caixinha marcada e não faz nada', async () => {
  let marcada = false;
  const f = fakes({
    // lê o estado do Kommo com uma pausa no meio, como a rede de verdade: sem a fila os dois leriam «false»
    pausado: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return marcada;
    },
    pausar: async () => {
      f.c.pausas++;
      await new Promise((r) => setTimeout(r, 5));
      marcada = true;
      return 'marcou';
    },
  });
  const [primeiro, segundo] = await Promise.all([tratar(f), tratar(f)]);
  assert.deepEqual(primeiro, { resultado: 'passou', pausa: 'marcou', tarefa: true });
  assert.equal(segundo, null);
  assert.deepEqual([f.c.pausas, f.c.tarefas.length], [1, 1]);
});

test('a fila é por cartão e não prende depois de um erro: o toque seguinte ao que falhou é tratado', async () => {
  let falhar = true;
  const f = fakes({
    pausado: async () => {
      if (falhar) {
        falhar = false;
        throw new Error('429');
      }
      return false;
    },
  });
  const [a, b] = await Promise.allSettled([tratar(f), tratar(f)]);
  assert.equal(a.status, 'rejected');
  assert.deepEqual(b.status === 'fulfilled' && b.value, { resultado: 'passou', pausa: 'marcou', tarefa: true });
});
