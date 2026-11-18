/**
 * A cutucada depois da equipe NÃO desliga a pausa pela equipe (achado do sênior, lead 5767287, 16/11/2026).
 *
 * Antes: a cutucada era gravada como `assistant`; `ultimaFalaDaIa` a lia como fala da Sofia depois da equipe (`ia_falou_depois`) e, quando o
 * paciente respondia à cutucada, a Sofia respondia por cima da equipe. Agora a cutucada não conta como fala da IA em nenhuma decisão de
 * «quem tem a palavra», e a janela de 24 h da fala da equipe conta a partir dela.
 *
 * Este arquivo também prova que a mudança é NEUTRA para quem não tem cutucada (todas as unidades): mesma decisão, mesmas datas.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { _semearParaTeste } from './automacoes-estado.js';
import { JANELA_DA_EQUIPE_MS, conferirEquipe, equipeComAPalavra, type DepsPausaEquipe } from './pausa-equipe.js';
import { contaComoEnvioDaSofia, enviosDaSofia, ultimaCutucadaDoLead, type MensagemOficial } from '../services/kommo-talks.service.js';

interface Linha {
  createdAt: Date;
  meta: Record<string, unknown> | null;
}
let linhas: Linha[] = [];
Object.defineProperty(prisma, 'unit', { value: { findMany: async () => [{ id: 'u1' }] }, configurable: true });
Object.defineProperty(prisma, 'conversation', { value: { findMany: async () => [{ id: 'c1' }] }, configurable: true });
Object.defineProperty(prisma, 'message', {
  value: {
    // enviosDaSofia: todas as `assistant` desde `desde`, da mais nova à mais velha
    findMany: async (a: { where: { createdAt: { gte: Date } } }) => linhas.filter((l) => l.createdAt >= a.where.createdAt.gte).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime()),
    // ultimaCutucadaDoLead: a mais nova com meta.cutucada
    findFirst: async (a: { where: { createdAt: { gte: Date } } }) =>
      linhas.filter((l) => l.createdAt >= a.where.createdAt.gte && (l.meta as { cutucada?: number } | null)?.cutucada).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())[0] ?? null,
  },
  configurable: true,
});
Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });

beforeEach(() => {
  _semearParaTeste([]);
  linhas = [];
});

const H = 3600_000;
const AGORA = new Date('2026-11-16T15:00:00Z');
const antes = (horas: number) => new Date(AGORA.getTime() - horas * H);
const unidade = { id: 'u1', slug: 'doutor-hernia-petropolis', kommoSubdomain: 'doutorhernialvp', kommoPausedFieldId: 246730 } as unknown as Unit;

let seq = 0;
const m = (direcao: 'entrada' | 'saida', quando: Date, texto: string, autor: MensagemOficial['autor'], autorNome = ''): MensagemOficial => ({ id: String(++seq), em: quando, direcao, autor, autorNome, texto, anexo: null, status: null });

/** `equipe falou` (pelo celular) → `cutucada` → `paciente responde à cutucada`. */
const conversa = (equipeHa: number, pacienteHa: number): MensagemOficial[] => [
  m('saida', antes(equipeHa), 'Olá, bom dia! Me chamo Natalia, da Clínica Doutor Hérnia. Qual é a sua dor?', 'equipe', 'WhatsApp Lite'),
  m('entrada', antes(pacienteHa), 'Na lombar, faz uns três meses', 'paciente'),
];

function deps(over: Partial<DepsPausaEquipe> = {}): DepsPausaEquipe {
  return {
    agora: () => AGORA,
    mensagens: async () => [],
    // o MESMO que o padrão da produção: as saídas do agente no banco, e a cutucada achada à parte
    ultimaFalaDaIa: async (u, leadId, desde) => (await enviosDaSofia(u, leadId, desde))[0] ?? null,
    ultimaCutucada: ultimaCutucadaDoLead,
    pausaMexidaDesde: async () => false,
    pausaMarcadaAgora: async () => false,
    marcarPausa: async () => 'marcou',
    simular: () => undefined,
    ...over,
  };
}

test('equipe falou → CUTUCADA → o paciente responde à cutucada: a PAUSA continua (a Sofia não responde por cima da equipe)', async () => {
  linhas = [{ createdAt: antes(2), meta: { via: 'salesbot', cutucada: 1 } }];
  const msgs = conversa(5, 1);
  const r = await conferirEquipe(unidade, 5767287, deps({ mensagens: async () => msgs }));
  assert.equal(r.motivo, null);
  assert.equal(r.fala?.autorNome, 'WhatsApp Lite');
});

test('o caso que escapava: fala da equipe de 30 h atrás + cutucada há 2 h + resposta do paciente → a equipe segue com a palavra (a janela de 24 h conta da cutucada)', async () => {
  linhas = [{ createdAt: antes(2), meta: { via: 'salesbot', cutucada: 1 } }];
  const msgs = conversa(30, 1);
  const com = await conferirEquipe(unidade, 5767287, deps({ mensagens: async () => msgs }));
  assert.equal(com.motivo, null, 'com a cutucada, a conversa segue sendo da equipe');
  // sem a cutucada, o comportamento de sempre: fala com mais de 24 h é «antiga»
  linhas = [];
  const sem = await conferirEquipe(unidade, 5767287, deps({ mensagens: async () => msgs }));
  assert.equal(sem.motivo, 'antiga');
});

test('uma fala da Sofia DE VERDADE depois da equipe continua devolvendo a conversa a ela (a cutucada não mexe nisso)', async () => {
  linhas = [{ createdAt: antes(3), meta: { via: 'salesbot', cutucada: 1 } }, { createdAt: antes(2), meta: { via: 'salesbot' } }];
  const r = await conferirEquipe(unidade, 5767287, deps({ mensagens: async () => conversa(5, 1) }));
  assert.equal(r.motivo, 'ia_falou_depois');
});

test('NEUTRO para quem não tem cutucada: mesmas datas de `enviosDaSofia`, mesma decisão de `equipeComAPalavra`', async () => {
  linhas = [
    { createdAt: antes(4), meta: { via: 'salesbot' } },
    { createdAt: antes(3), meta: { followUp: 2 } }, // régua: continua contando como envio nosso
    { createdAt: antes(2), meta: { reactivation: 1 } },
    { createdAt: antes(1), meta: { origem: 'kommo_talks' } }, // cópia da equipe: continua fora
    { createdAt: antes(0.5), meta: null },
  ];
  const datas = (await enviosDaSofia(unidade, 1, antes(10))).map((d) => d.getTime());
  assert.deepEqual(datas, [antes(0.5), antes(2), antes(3), antes(4)].map((d) => d.getTime()));
  assert.equal(await ultimaCutucadaDoLead(unidade, 1, antes(10)), null);

  const msgs = conversa(5, 1);
  // 3 argumentos (como todo chamador antigo) e 4º argumento nulo dão a MESMA resposta
  for (const ia of [null, antes(6), antes(2)]) {
    assert.deepEqual(equipeComAPalavra(msgs, ia, AGORA), equipeComAPalavra(msgs, ia, AGORA, null));
  }
  assert.equal(equipeComAPalavra(msgs, antes(2), AGORA).motivo, 'ia_falou_depois');
  assert.equal(equipeComAPalavra(msgs, null, AGORA).motivo, null);
  assert.equal(equipeComAPalavra(conversa(25, 1), null, AGORA).motivo, 'antiga');
  assert.equal(JANELA_DA_EQUIPE_MS, 24 * H);

  // deps antigas, sem `ultimaCutucada`, funcionam como sempre
  linhas = [];
  // (a fala é do app "WhatsApp Lite", que pausa só por 60 min: por isso aqui a conversa é de 45 min atrás; a de 5 h é «antiga» só para o Lite)
  const antigas = deps({ mensagens: async () => conversa(0.75, 0.1) });
  delete antigas.ultimaCutucada;
  assert.equal((await conferirEquipe(unidade, 1, antigas)).motivo, null);
});

test('contaComoEnvioDaSofia: a assinatura antiga (2 argumentos) responde como sempre; a cutucada só entra se pedida', () => {
  for (const [meta, estrito, esperado] of [
    [{ via: 'salesbot' }, false, true],
    [{ followUp: 1 }, false, true],
    [{ followUp: 1 }, true, false],
    [{ origem: 'kommo_talks' }, false, false],
    [null, false, true],
    [null, true, true],
  ] as const) {
    assert.equal(contaComoEnvioDaSofia(meta, estrito), esperado, JSON.stringify([meta, estrito]));
  }
  assert.equal(contaComoEnvioDaSofia({ cutucada: 1 }, false), false);
  assert.equal(contaComoEnvioDaSofia({ cutucada: 1 }, true), false);
  assert.equal(contaComoEnvioDaSofia({ cutucada: 1 }, false, true), true, 'a própria cutucada precisa vê-la para casar a saída «Salesbot» do Kommo');
});

test('`enviosDaSofia({ comCutucada: true })` devolve a cutucada; o padrão não', async () => {
  linhas = [{ createdAt: antes(2), meta: { via: 'salesbot', cutucada: 1 } }, { createdAt: antes(3), meta: { via: 'salesbot' } }];
  assert.equal((await enviosDaSofia(unidade, 1, antes(10))).length, 1);
  assert.equal((await enviosDaSofia(unidade, 1, antes(10), { comCutucada: true })).length, 2);
});
