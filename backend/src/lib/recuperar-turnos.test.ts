import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

// Janela curta do coalescer só para o teste (a de produção é 8 s).
process.env.AGENT_COALESCE_MS = '30';
const { scheduleAgentRun } = await import('./agent-coalescer.js');
const {
  recuperarTurnosPerdidos,
  janelaDeBusca,
  filtroDePerdidos,
  dadosDeEncerramento,
  tarefaCobreOPedido,
  depsDeProducao,
  posseDaLideranca,
  turnoJaAvancou,
  equipeRespondeuDepois,
  respondeuOPedido,
  roboSaiuDepois,
  jaHaTarefaParaOPedido,
  traceDoBurstDoPedido,
  JANELA_DO_BURST_MS,
  JANELA_APOS_LIDERANCA_MS,
  agendarRecuperacao,
  dentroDaJanelaDeRecuperacao,
  INTERVALO_MS,
  ATRASO_INICIAL_MS,
  IDADE_MINIMA_MS,
  FOLGA_ANTES_DA_POSSE_MS,
  MAX_VOLTAS_SEM_DECISAO,
  IDADE_TENTATIVA_MORTA_MS,
  MARCA_ABANDONADO,
} = await import('./recuperar-turnos.js');
import type {
  BancoDaRecuperacao,
  DepsRecuperacao,
  TurnoPerdido,
  RespostaSegurada,
  ResultadoRetomada,
  ConversaLida,
  PassoGravado,
} from './recuperar-turnos.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { EstadoLideranca } from './worker-lease.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cenário-base = o caso real (Timbó, lead 5142896, 30/10/2026): 17:00:47 áudio (resposta segurada), 17:01:05 foto
 * (trace RUNNING, o serviço reiniciou). O novo processo assumiu a liderança às 17:01:30 e varre às 17:03:30.
 */
const POSSE = new Date('2026-10-30T20:01:30Z');
const T_VARREDURA = POSSE.getTime() + 120_000;
const FOTO = new Date('2026-10-30T20:01:05Z');

const UNIT_A = { id: 'u1', slug: 'timbo', kommoSubdomain: 'timbo', isActive: true } as unknown as Unit;
const UNIT_B = { id: 'u2', slug: 'timbo-resgate', kommoSubdomain: 'timbo', isActive: true } as unknown as Unit;

interface TraceFalso {
  id: string;
  unitId: string;
  leadId: string;
  criadoEm: Date;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  iaDecision: string | null;
  input: unknown;
  passos: PassoGravado[];
}

function msg(direcao: 'entrada' | 'saida', em: Date, extra: Partial<MensagemOficial> = {}): MensagemOficial {
  return {
    id: `${direcao}-${em.getTime()}`,
    em,
    direcao,
    autor: direcao === 'entrada' ? 'paciente' : 'equipe',
    autorNome: direcao === 'entrada' ? 'Paciente' : 'Melissa',
    texto: direcao === 'entrada' ? 'oi' : 'Olá, tudo bem? Aqui é a recepção.',
    anexo: null,
    status: null,
    ...extra,
  };
}

function mundo(opts: { agora?: number } = {}) {
  const w = {
    emVoo: new Set<string>(),
    traces: [] as TraceFalso[],
    /** Mensagens da IA no BANCO, por lead (qualquer unidade da conta). */
    respostasNoBanco: [] as Array<{ leadId: string; em: Date; traceId?: string; traceCriadoEm?: Date | null }>,
    /** A conversa oficial do Kommo. `null` = o Kommo não respondeu. */
    kommo: { msgs: [] as MensagemOficial[], equipeComAPalavra: false, naoConferi: false } as ConversaLida | null,
    pausados: new Set<string>(),
    foraDoHorario: false,
    reivindicados: new Set<string>(),
    bancoFalhaNaReivindicacao: false,
    seguradas: [] as RespostaSegurada[],
    restauradas: [] as RespostaSegurada[],
    /** Quem é a dona do paciente agora, por `unitId::leadId` gravado (padrão: a gravada). */
    donas: new Map<string, Unit | null>(),
    unidadesConsultadas: [] as string[],
    tarefas: [] as Array<{ unit: string; leadId: string; esperaMs: number }>,
    tarefasJaExistem: new Set<string>(),
    pedidosDeTarefa: 0,
    chamadasDeRestauracao: 0,
    /** A ordem do que aconteceu (ler seguradas, retomar, restaurar). */
    eventos: [] as string[],
    liberadas: [] as string[],
    kommoRecusaTarefa: false,
    /** O que SAIU para o paciente (a "IA" do teste responde uma vez por turno). */
    saidas: [] as Array<{ leadId: string; texto: string; traceIds: string[] }>,
    retomadas: [] as string[],
    consultas: [] as Array<{ criadosAntes: Date; criadosDepois: Date; excluirIds: string[] }>,
    retomada: undefined as ((t: TurnoPerdido) => ResultadoRetomada | Error) | undefined,
    agora: opts.agora ?? T_VARREDURA,
  };

  const deps: DepsRecuperacao = {
    agora: () => w.agora,
    idsEmVoo: () => [...w.emVoo],
    async buscarPerdidos({ criadosAntes, criadosDepois, limite, excluirIds }) {
      w.consultas.push({ criadosAntes, criadosDepois, excluirIds });
      return w.traces
        .filter((t) => t.status === 'RUNNING' && t.criadoEm < criadosAntes && t.criadoEm > criadosDepois && !excluirIds.includes(t.id))
        .slice(0, limite)
        .map((t) => ({ traceId: t.id, unitId: t.unitId, leadId: t.leadId, criadoEm: t.criadoEm, input: t.input }));
    },
    // O mesmo contrato da produção: os passos do pedido e dos traces do paciente que nasceram até a janela antes dele.
    async passosDoBurst(_unit, t) {
      return w.traces
        .filter(
          (x) =>
            x.leadId === t.leadId &&
            traceDoBurstDoPedido({ status: x.status, iaDecision: x.iaDecision }) &&
            x.criadoEm.getTime() >= t.criadoEm.getTime() - JANELA_DO_BURST_MS &&
            x.criadoEm.getTime() <= t.criadoEm.getTime(),
        )
        .flatMap((x) => x.passos);
    },
    async unidadeDona(t) {
      const k = `${t.unitId}::${t.leadId}`;
      if (w.donas.has(k)) return w.donas.get(k)!;
      return t.unitId === 'u1' ? UNIT_A : UNIT_B;
    },
    async enviosDaIa(unit, leadId, desde) {
      w.unidadesConsultadas.push(unit.id);
      return w.respostasNoBanco
        .filter((r) => r.leadId === leadId && r.em >= desde)
        // por padrão a resposta é de um turno que nasceu logo antes dela (depois do pedido, como na vida normal)
        .map((r) => ({ em: r.em, traceId: r.traceId ?? 'turno-x', traceCriadoEm: r.traceCriadoEm === undefined ? new Date(r.em.getTime() - 1) : r.traceCriadoEm }));
    },
    async lerConversa() {
      if (!w.kommo) throw new Error('403 do Kommo');
      return w.kommo;
    },
    async iaPausada(unit, leadId) {
      return w.pausados.has(`${unit.id}::${leadId}`);
    },
    foraDoHorario: () => w.foraDoHorario,
    async reivindicar(traceId) {
      if (w.bancoFalhaNaReivindicacao) return 'incerto';
      if (w.reivindicados.has(traceId)) return 'perdeu';
      w.reivindicados.add(traceId);
      return 'ganhou';
    },
    async seguradasPendentes() {
      w.eventos.push('lê seguradas');
      return w.seguradas;
    },
    restaurarSeguradas(_u, _l, lista) {
      w.eventos.push('restaura');
      w.restauradas.push(...lista);
      w.chamadasDeRestauracao++;
    },
    async liberarReivindicacao(traceId) {
      w.reivindicados.delete(traceId);
      w.liberadas.push(traceId);
    },
    async criarTarefa(unit, t, esperaMs) {
      w.pedidosDeTarefa++;
      if (w.kommoRecusaTarefa) throw new Error('Kommo recusou');
      if (w.tarefasJaExistem.has(`${unit.id}::${t.leadId}`)) return 'ja_existia';
      w.tarefas.push({ unit: unit.id, leadId: t.leadId, esperaMs });
      w.tarefasJaExistem.add(`${unit.id}::${t.leadId}`);
      return 'criada';
    },
    resumoDoPedido: (t) => ({ contato: 'Paciente', texto: (t.input as { texto: string }).texto }),
    async retomar(t, unit) {
      w.eventos.push(`retoma ${t.traceId}`);
      const r = w.retomada?.(t);
      if (r instanceof Error) throw r;
      if (r && r !== 'retomado') return r;
      w.retomadas.push(t.traceId);
      const texto = (t.input as { texto: string }).texto;
      scheduleAgentRun({
        unitSlug: unit.slug,
        leadId: Number(t.leadId),
        traceId: t.traceId,
        humanMessage: texto,
        audioUrl: null,
        imageUrl: null,
        run: async (combinado, _a, _i, traceIds) => {
          w.saidas.push({ leadId: t.leadId, texto: combinado, traceIds });
          w.respostasNoBanco.push({ leadId: t.leadId, em: new Date(w.agora + 1), traceId: t.traceId, traceCriadoEm: t.criadoEm });
          for (const id of traceIds) {
            const tr = w.traces.find((x) => x.id === id);
            if (tr) tr.status = 'SUCCESS';
          }
        },
        retomada: { chegouEm: t.criadoEm.getTime() },
      });
      return 'retomado';
    },
    async encerrar(traceId, motivo) {
      const tr = w.traces.find((x) => x.id === traceId);
      if (tr && tr.status === 'RUNNING') {
        tr.status = 'FAILED';
        tr.iaDecision = `${MARCA_ABANDONADO}:${motivo}`;
      }
    },
  };
  return { w, deps };
}

const lead = (id: string, texto: string, criadoEm: Date, extra: Partial<TraceFalso> = {}): TraceFalso => ({
  id,
  unitId: 'u1',
  leadId: '5142896',
  criadoEm,
  status: 'RUNNING',
  iaDecision: null,
  input: { texto },
  passos: [{ kind: 'WEBHOOK_RECEIVED', title: 'Mensagem de Paciente' }],
  ...extra,
});

const motivoDe = (w: ReturnType<typeof mundo>['w'], id: string) => w.traces.find((t) => t.id === id)!.iaDecision;

// ── o caso real ────────────────────────────────────────────────────────────────────────────────────────

test('caso Timbó: a foto perdida no deploy volta para a IA UMA vez e a resposta segurada é restaurada', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('foto', '[foto]', FOTO));
  w.seguradas = [{ reply: 'Olá! Posso ajudar?', mensagemId: 'm-1' }];

  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.candidatos, 1);
  assert.equal(r.retomados, 1);
  assert.equal(w.restauradas.length, 1, 'a resposta segurada volta para o turno responder as duas');
  await dormir(120);
  assert.equal(w.saidas.length, 1, 'uma resposta');
  assert.equal(w.tarefas.length, 0);

  // Segunda varredura: o trace virou SUCCESS (o turno terminou) — nada de novo.
  const r2 = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r2.candidatos, 0);
  await dormir(120);
  assert.equal(w.saidas.length, 1, 'varrer de novo não responde em dobro');
});

test('vários pedidos perdidos do mesmo paciente viram UM turno, na ordem em que ele escreveu', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 5_000)));
  w.traces.push(lead('a', 'primeira', FOTO));
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 2);
  await dormir(150);
  assert.equal(w.saidas.length, 1);
  assert.equal(w.saidas[0]!.texto, 'primeira\n\nsegunda');
});

// ── (1) já respondido: banco E Kommo, independente da chave pausa-equipe ───────────────────────────────

test('resposta da IA no banco depois do pedido: fecha FAILED e não reprocessa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() + 30_000) });
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.traces[0]!.status, 'FAILED', 'nunca SUCCESS: SUCCESS esconderia paciente sem resposta');
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:ja_respondida`);
  assert.equal(w.tarefas.length, 0);
});

test('a recepção respondeu pelo celular (só o Kommo sabe): não reprocessa, não abre tarefa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [msg('entrada', FOTO), msg('saida', new Date(FOTO.getTime() + 60_000))], equipeComAPalavra: true, naoConferi: false };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:ja_respondida`);
  assert.equal(w.tarefas.length, 0);
  assert.equal(w.saidas.length, 0);
});

test('saída de ROBÔ depois do pedido (Salesbot/boas-vindas/lembrete, que o Kommo marca como sofia) NÃO é resposta: tarefa, nunca retomada nem ja_respondida', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 60_000), { autor: 'sofia', autorNome: 'Salesbot', texto: 'Olá! Bem-vinda à clínica.' })], equipeComAPalavra: false, naoConferi: false };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1, 'a recepção fica sabendo');
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:robo_falou_depois_do_pedido`);
});

test('o robô falou depois de UM dos pedidos: o paciente todo vai para a tarefa (uma só)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 20_000)));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 30_000), { autor: 'sofia', autorNome: 'Salesbot' })], equipeComAPalavra: false, naoConferi: false };
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(w.traces.every((t) => t.status === 'FAILED'), true);
});

test('o robô falou ANTES do pedido: não impede a retomada', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() - 60_000), { autor: 'sofia', autorNome: 'Salesbot' }), msg('entrada', FOTO)], equipeComAPalavra: false, naoConferi: false };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  assert.equal(w.tarefas.length, 0);
});

test('robô falou e a IA está pausada: a equipe atende, fecha sem tarefa (pausa vem antes)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.pausados.add('u1::5142896');
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 60_000), { autor: 'sofia', autorNome: 'Salesbot' })], equipeComAPalavra: false, naoConferi: false };
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:ia_pausada`);
  assert.equal(w.tarefas.length, 0);
});

test('a resposta automática do WhatsApp Business (saudação/ausência) NÃO conta como resposta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = {
    msgs: [
      msg('entrada', FOTO),
      msg('saida', new Date(FOTO.getTime() + 2_000), {
        autorNome: 'WhatsApp Business',
        texto: 'Olá! Nosso horário de atendimento é de segunda a sexta, das 8h às 18h. Já já respondemos.',
      }),
    ],
    equipeComAPalavra: false,
    naoConferi: false,
  };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  assert.equal(w.tarefas.length, 0);
});

test('o "já respondido" é julgado por pedido: o primeiro foi respondido, o segundo não', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 24_000)));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 10_000))], equipeComAPalavra: false, naoConferi: false };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 'a'), `${MARCA_ABANDONADO}:ja_respondida`);
  assert.equal(r.retomados, 1);
  assert.deepEqual(w.retomadas, ['b']);
  await dormir(120);
});

test('aviso do sistema ("Unable to open this message") que o Kommo marca como sofia NÃO é robô falando: o pedido volta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 3_000), { autor: 'sofia', autorNome: 'Salesbot', texto: 'Unable to open this message' })], equipeComAPalavra: false, naoConferi: false };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  assert.equal(w.tarefas.length, 0);
  await dormir(100);
});

test('aviso do sistema marcado como equipe também não é fala humana (não fecha como respondido)', () => {
  const t = new Date('2026-10-30T20:00:00Z');
  assert.equal(equipeRespondeuDepois([msg('saida', new Date(t.getTime() + 3_000), { texto: 'Unable to open this message' })], t), false);
  assert.equal(roboSaiuDepois([msg('saida', new Date(t.getTime() + 3_000), { autor: 'sofia', texto: 'Não foi possível abrir esta mensagem' })], t), false);
  assert.equal(roboSaiuDepois([msg('saida', new Date(t.getTime() + 3_000), { autor: 'sofia', texto: 'Olá! Bem-vinda.' })], t), true);
});

test('o robô falou entre os dois pedidos (depois só do primeiro): basta UM pedido para o paciente todo ir para a tarefa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 24_000)));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 10_000), { autor: 'sofia', autorNome: 'Salesbot' })], equipeComAPalavra: false, naoConferi: false };
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
});

test('fala de entrada (paciente) nunca é resposta, mesmo marcada como equipe', () => {
  const t = new Date('2026-10-30T20:00:00Z');
  assert.equal(equipeRespondeuDepois([msg('entrada', new Date(t.getTime() + 60_000), { autor: 'equipe' })], t), false);
});

// ── a resposta atrasada do turno ANTERIOR não prova nada sobre o pedido novo ───────────────────────────

test('respondeuOPedido: só a resposta DEPOIS do pedido, de trace nascido no pedido/depois ou do próprio trace', () => {
  const t = { traceId: 'NOVO', criadoEm: new Date('2026-11-03T11:24:27.400Z') };
  const em = (ms: number) => new Date(t.criadoEm.getTime() + ms);
  assert.equal(respondeuOPedido([], t), false);
  assert.equal(respondeuOPedido([{ em: em(3_000), traceId: 'ANT', traceCriadoEm: em(-15_000) }], t), false, 'turno anterior entregue tarde');
  assert.equal(respondeuOPedido([{ em: em(3_000), traceId: 'ANT', traceCriadoEm: null }], t), false, 'sem saber de quando é o trace: dúvida');
  assert.equal(respondeuOPedido([{ em: em(3_000), traceId: 'NOVO', traceCriadoEm: em(-15_000) }], t), true, 'o próprio trace do pedido');
  assert.equal(respondeuOPedido([{ em: em(3_000), traceId: 'OUTRO', traceCriadoEm: em(0) }], t), true, 'trace nascido no instante do pedido');
  assert.equal(respondeuOPedido([{ em: em(3_000), traceId: 'OUTRO', traceCriadoEm: em(-1) }], t), false, '1 ms antes do pedido');
  assert.equal(respondeuOPedido([{ em: em(3_000), traceId: 'OUTRO', traceCriadoEm: em(2_000) }], t), true, 'turno que nasceu depois');
  assert.equal(respondeuOPedido([{ em: em(0), traceId: 'NOVO', traceCriadoEm: em(0) }], t), false, 'no mesmo instante do pedido não é "depois"');
  assert.equal(respondeuOPedido([{ em: em(-1), traceId: 'NOVO', traceCriadoEm: em(0) }], t), false, 'antes do pedido');
  assert.equal(respondeuOPedido([{ em: em(-5_000), traceId: 'X', traceCriadoEm: em(-9_000) }, { em: em(4_000), traceId: 'NOVO', traceCriadoEm: em(0) }], t), true, 'uma que vale basta');
});

test('CORRIDA: o turno anterior entregou a resposta 3 s DEPOIS do pedido novo e o novo morreu — NÃO fecha ja_respondida: tarefa, nunca retomada', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('novo', 'outra pergunta', FOTO));
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() + 3_000), traceId: 'anterior', traceCriadoEm: new Date(FOTO.getTime() - 15_000) });
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1, 'a recepção fica sabendo');
  assert.equal(motivoDe(w, 'novo'), `${MARCA_ABANDONADO}:resposta_de_turno_anterior_depois_do_pedido`);
});

test('CORRIDA com a IA pausada: a equipe atende, fecha sem tarefa (a pausa vem antes)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('novo', 'oi', FOTO));
  w.pausados.add('u1::5142896');
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() + 3_000), traceId: 'anterior', traceCriadoEm: new Date(FOTO.getTime() - 15_000) });
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 'novo'), `${MARCA_ABANDONADO}:ia_pausada`);
  assert.equal(w.tarefas.length, 0);
});

test('a resposta do PRÓPRIO trace do pedido (o turno respondeu e o deploy matou antes de fechar) fecha ja_respondida', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('novo', 'oi', FOTO));
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() + 8_000), traceId: 'novo', traceCriadoEm: FOTO });
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 'novo'), `${MARCA_ABANDONADO}:ja_respondida`);
  assert.equal(w.tarefas.length, 0);
});

test('resposta exatamente no instante do pedido não o responde (sem >=)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('novo', 'oi', FOTO));
  w.respostasNoBanco.push({ leadId: '5142896', em: FOTO, traceId: 'novo', traceCriadoEm: FOTO });
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  await dormir(100);
});

test('caso Bebedouro (lead 7165547, 03/11): pedido 11:24:27, a recepção respondeu com nota de voz às 11:26:59 → ja_respondida, sem tarefa e sem retomada', async () => {
  const posse = new Date('2026-11-03T11:26:00Z');
  const { w, deps } = mundo({ agora: posse.getTime() + 120_000 });
  const pedido = new Date('2026-11-03T11:24:27.400Z');
  w.traces.push(lead('t1', 'áudio', pedido));
  // No banco a nota de voz da recepção é uma Message SEM traceId: não é resposta de turno (respostasNoBanco vazio).
  w.kommo = {
    msgs: [
      msg('entrada', new Date('2026-11-03T11:24:27Z')),
      msg('saida', new Date('2026-11-03T11:26:59Z'), { autor: 'equipe', autorNome: 'Recepção', texto: '', anexo: { tipo: 'audio', link: null } }),
    ],
    equipeComAPalavra: true,
    naoConferi: false,
  };
  const r = await recuperarTurnosPerdidos(deps, posse);
  assert.equal(r.candidatos, 1);
  assert.equal(r.retomados, 0);
  assert.equal(w.tarefas.length, 0, 'humano continua fechando sem tarefa');
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:ja_respondida`);
});

test('equipeRespondeuDepois: só fala HUMANA depois do pedido; entrada, saída antiga, robô e resposta automática não contam', () => {
  const t = new Date('2026-10-30T20:00:00Z');
  const robo = (ms: number) => msg('saida', new Date(t.getTime() + ms), { autor: 'sofia', autorNome: 'Salesbot' });
  assert.equal(equipeRespondeuDepois([msg('entrada', new Date(t.getTime() + 10_000))], t), false);
  assert.equal(equipeRespondeuDepois([msg('saida', new Date(t.getTime() - 60_000))], t), false);
  assert.equal(equipeRespondeuDepois([msg('saida', new Date(t.getTime() + 60_000))], t), true);
  assert.equal(equipeRespondeuDepois([robo(60_000)], t), false, 'Salesbot/boas-vindas/lembrete não respondem o pedido');
  assert.equal(equipeRespondeuDepois([], t), false);
});

test('sem folga de relógio: a fala de ANTES do pedido (ou do mesmo instante) não conta como resposta a ele', () => {
  const t = new Date('2026-10-30T20:00:10.500Z');
  // o Kommo só tem segundos: 20:00:09 e 20:00:10 são ANTERIORES ao pedido das 20:00:10.500
  assert.equal(equipeRespondeuDepois([msg('saida', new Date('2026-10-30T20:00:09Z'))], t), false, '1,5 s antes: a folga de 2 s contava');
  assert.equal(equipeRespondeuDepois([msg('saida', new Date('2026-10-30T20:00:10Z'))], t), false);
  assert.equal(equipeRespondeuDepois([msg('saida', t)], t), false, 'no mesmo instante não é "depois"');
  assert.equal(equipeRespondeuDepois([msg('saida', new Date('2026-10-30T20:00:11Z'))], t), true);
  assert.equal(roboSaiuDepois([msg('saida', new Date('2026-10-30T20:00:09Z'), { autor: 'sofia' })], t), false);
  assert.equal(roboSaiuDepois([msg('saida', new Date('2026-10-30T20:00:11Z'), { autor: 'sofia' })], t), true);
});

test('a resposta de turno da Sofia no banco é "depois" só se for estritamente depois do pedido (sem folga para trás)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  // a resposta do turno ANTERIOR saiu 1,5 s antes do pedido: com a folga de 2 s ela fechava este pedido como respondido
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() - 1_500) });
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1, 'não estava respondido');
});

// ── (2) a janela: piso = posse da liderança, não "2 h atrás" ───────────────────────────────────────────

test('janelaDeBusca: o piso é a posse da liderança menos a folga; o teto é a idade mínima', () => {
  const j = janelaDeBusca(T_VARREDURA, POSSE);
  assert.equal(j.criadosDepois.getTime(), POSSE.getTime() - FOLGA_ANTES_DA_POSSE_MS);
  assert.equal(j.criadosAntes.getTime(), T_VARREDURA - IDADE_MINIMA_MS);
  assert.ok(FOLGA_ANTES_DA_POSSE_MS <= 5 * 60_000, 'folga grande demais pega trace preso por outro motivo');
});

test('trace preso por outro motivo, de ANTES da posse, não é reprocessado', async () => {
  const { w, deps } = mundo();
  // 40 min antes da posse: uma hora que não tem deploy nenhum.
  w.traces.push(lead('velho', 'oi', new Date(POSSE.getTime() - 40 * 60_000)));
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.candidatos, 0);
  assert.equal(w.traces[0]!.status, 'RUNNING', 'fica para investigar');
  assert.equal(w.saidas.length + w.tarefas.length, 0);
});

test('trace de poucos segundos atrás (ainda drenando no antigo) não é candidato', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('novo', 'oi', new Date(T_VARREDURA - 30_000)));
  assert.equal((await recuperarTurnosPerdidos(deps, POSSE)).candidatos, 0);
});

test('filtroDePerdidos: só RUNNING, só kommo_chat, dentro da janela, sem os em voo', () => {
  const j = janelaDeBusca(T_VARREDURA, POSSE);
  const f = filtroDePerdidos({ ...j, excluirIds: ['x'] });
  assert.equal(f.status, 'RUNNING');
  assert.equal(f.channel, 'kommo_chat');
  assert.deepEqual(f.createdAt, { lt: j.criadosAntes, gt: j.criadosDepois });
  assert.deepEqual(f.id, { notIn: ['x'] });
  assert.equal('id' in filtroDePerdidos({ ...j, excluirIds: [] }), false);
});

test('posseDaLideranca: só líder em modo lease; sem-lease (banco fora) e aguardando não varrem', () => {
  const base: EstadoLideranca = { lider: true, modo: 'lease', desde: POSSE, leaseDesde: POSSE, dono: 'a', falhasSeguidas: 0, ultimaVerificacao: null };
  assert.deepEqual(posseDaLideranca(base), { desde: POSSE, janelaDesde: POSSE });
  const depois = new Date(POSSE.getTime() + 5 * 60_000);
  assert.deepEqual(posseDaLideranca({ ...base, leaseDesde: depois }), { desde: POSSE, janelaDesde: depois }, 'o piso fica na posse; a janela conta do lease');
  assert.equal(posseDaLideranca({ ...base, modo: 'sem-lease' }), null, 'sem lease o antigo pode estar vivo');
  assert.equal(posseDaLideranca({ ...base, lider: false, modo: 'aguardando', desde: null, leaseDesde: null }), null);
  assert.equal(posseDaLideranca({ ...base, desde: null }), null);
  assert.equal(posseDaLideranca(null), null);
});

test('o que este processo tem em voo nunca é candidato (nem ocupa vaga)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('vivo', 'oi', FOTO));
  w.emVoo.add('vivo');
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.candidatos, 0);
  assert.deepEqual(w.consultas[0]!.excluirIds, ['vivo']);
});

// ── (3) turno que já avançou: não reinjeta, vai tarefa ─────────────────────────────────────────────────

test('turnoJaAvancou: webhook, leitura de áudio/imagem, burst e a retomada NÃO são avanço; modelo, ferramenta e o resto são', () => {
  const p = (kind: string, title = '') => ({ kind, title });
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED', 'Mensagem de X')]), false);
  assert.equal(
    turnoJaAvancou([
      p('WEBHOOK_RECEIVED'),
      p('THINKING', 'Burst coalescido: 2 mensagens do paciente combinadas em 1 turno'),
      p('THINKING', 'Áudio 1/2 transcrito (900ms): "oi"'),
      p('THINKING', 'Imagem lido (300ms): "foto"'),
      p('THINKING', '♻ Retomado após reinício do serviço'),
    ]),
    false,
  );
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED'), p('THINKING', 'IA analisando intenção')]), true);
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED'), p('TOOL_CALL', 'agendar_consulta')]), true);
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED'), p('KOMMO_ACTION', 'Handoff')]), true);
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED'), p('ERROR', 'falhou')]), true);
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED'), p('THINKING', 'Áudio não ouvido → pedir pra escrever')]), true, 'esse já decide uma resposta');
  assert.equal(turnoJaAvancou([p('WEBHOOK_RECEIVED'), p('THINKING', 'passo que ninguém previu')]), true);
});

test('trace com passo de modelo: NÃO volta para a IA — FAILED + tarefa para a recepção', async () => {
  const { w, deps } = mundo();
  w.traces.push(
    lead('t1', 'quero marcar', FOTO, {
      passos: [
        { kind: 'WEBHOOK_RECEIVED', title: 'Mensagem' },
        { kind: 'THINKING', title: 'IA analisando intenção' },
      ],
    }),
  );
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(w.traces[0]!.status, 'FAILED');
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:turno_ja_tinha_comecado`);
});

test('um pedido com passo de modelo leva o paciente todo para a tarefa (uma só)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO, { passos: [{ kind: 'TOOL_CALL', title: 'agendar_consulta' }] }));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 5_000)));
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(w.traces.every((t) => t.status === 'FAILED'), true);
});

// ── (4) o que não foi retomado fecha FAILED ────────────────────────────────────────────────────────────

test('IA pausada: fecha FAILED, sem tarefa (a equipe já atende) e sem resposta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.pausados.add('u1::5142896');
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:ia_pausada`);
  assert.equal(w.tarefas.length, 0);
});

test('retomar devolve descartado: o trace fecha FAILED com o motivo', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.retomada = () => 'descartado:encerramento_repetido';
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:encerramento_repetido`);
  assert.equal(w.restauradas.length, 0, 'sem turno a caminho não se restaura nada');
});

test('retomar devolve tarefa: abre a tarefa e fecha FAILED', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'sim', FOTO));
  w.retomada = () => 'tarefa:pode_ser_resposta_a_lembrete';
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:pode_ser_resposta_a_lembrete`);
});

test('retomar lança: tarefa + FAILED, e a recuperação dos outros pacientes segue', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.traces.push(lead('t2', 'oi', new Date(FOTO.getTime() + 1_000), { leadId: '999' }));
  w.retomada = (t) => (t.leadId === '5142896' ? new Error('boom') : 'retomado');
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:falha_ao_retomar`);
});


test('nenhum caminho deixa um trace não retomado como SUCCESS', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', FOTO));
  w.traces.push(lead('b', 'oi', FOTO, { leadId: '2' }));
  w.traces.push(lead('c', 'oi', FOTO, { leadId: '3', passos: [{ kind: 'TOOL_CALL', title: 'x' }] }));
  w.traces.push(lead('d', 'oi', FOTO, { leadId: '4' }));
  w.respostasNoBanco.push({ leadId: '2', em: new Date(FOTO.getTime() + 5_000) });
  w.pausados.add('u1::4');
  w.kommo = { msgs: [], equipeComAPalavra: false, naoConferi: false };
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(120);
  const fechados = w.traces.filter((t) => t.status !== 'RUNNING');
  for (const t of fechados) {
    if (t.iaDecision?.startsWith(MARCA_ABANDONADO)) assert.equal(t.status, 'FAILED', t.id);
  }
  assert.equal(w.traces.find((t) => t.id === 'b')!.status, 'FAILED');
  assert.equal(w.traces.find((t) => t.id === 'c')!.status, 'FAILED');
  assert.equal(w.traces.find((t) => t.id === 'd')!.status, 'FAILED');
});

// ── (5) na dúvida, tarefa; nunca resposta ──────────────────────────────────────────────────────────────

test('o Kommo não respondeu: não dá para conferir, então NÃO responde — tarefa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = null;
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:nao_consegui_conferir_o_kommo`);
});

test('não consegui conferir a caixinha "Pausar IA": tarefa, não resposta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [], equipeComAPalavra: false, naoConferi: true };
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
});

test('a equipe estava na conversa (falou antes e a IA não voltou): tarefa, não resposta por cima', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() - 3600_000))], equipeComAPalavra: true, naoConferi: false };
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:equipe_na_conversa`);
});

test('fora do horário no momento da retomada: tarefa, não resposta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.foraDoHorario = true;
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:fora_do_horario`);
});

test('a tarefa é UMA por paciente, mesmo com vários pedidos perdidos', async () => {
  const { w, deps } = mundo();
  w.foraDoHorario = true;
  w.traces.push(lead('a', 'um', FOTO));
  w.traces.push(lead('b', 'dois', new Date(FOTO.getTime() + 1_000)));
  w.traces.push(lead('c', 'três', new Date(FOTO.getTime() + 2_000)));
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.tarefas.length, 1);
  assert.equal(w.traces.every((t) => t.status === 'FAILED'), true);
});

test('o Kommo recusou a tarefa: o trace NÃO fecha (única pista do paciente sem resposta); a volta seguinte tenta de novo', async () => {
  const { w, deps } = mundo();
  w.foraDoHorario = true;
  w.kommoRecusaTarefa = true;
  w.traces.push(lead('t1', 'oi', FOTO));
  const voltas = new Map<string, number>();
  let r = await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
  assert.equal(r.tarefasFalhas, 1);
  assert.equal(w.traces[0]!.status, 'RUNNING');
  assert.equal(voltas.get('t1'), 1);

  w.kommoRecusaTarefa = false; // o Kommo voltou
  r = await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
  assert.equal(r.tarefas, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:fora_do_horario`);
});

test('tarefaCobreOPedido: só a tarefa criada DEPOIS do pedido o cobre (um segundo deploy no mesmo dia não fica sem aviso)', () => {
  const pedido = new Date('2026-10-30T20:01:05Z');
  assert.equal(tarefaCobreOPedido(null, pedido), false);
  assert.equal(tarefaCobreOPedido(new Date(pedido.getTime() - 5 * 3600_000), pedido), false, 'tarefa de 5 h antes, talvez já concluída');
  assert.equal(tarefaCobreOPedido(new Date(pedido.getTime() + 60_000), pedido), true);
});

// ── (5) uma vez só ─────────────────────────────────────────────────────────────────────────────────────

test('o banco não confirma a reivindicação: NÃO reprocessa (e o trace não é fechado às cegas)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.bancoFalhaNaReivindicacao = true;
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.traces[0]!.status, 'RUNNING');
});

test('reivindicação de outro processo, recente: deixa para ele; velha: a tentativa morreu — tarefa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.reivindicados.add('t1');
  let r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.traces[0]!.status, 'RUNNING');
  assert.equal(w.tarefas.length, 0);

  // Duas varreduras depois o pedido já tem mais que `IDADE_TENTATIVA_MORTA_MS` e continua RUNNING: ninguém está cuidando.
  w.agora = FOTO.getTime() + IDADE_TENTATIVA_MORTA_MS + 30_000;
  r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:recuperacao_ja_tentada`);
});

test('dois starts seguidos: o segundo encontra a reivindicação e não responde em dobro', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(120);
  assert.equal(w.saidas.length, 1);
  // o turno morreu de novo (a recuperação também): o trace volta a RUNNING e a resposta não saiu
  w.traces[0]!.status = 'RUNNING';
  w.respostasNoBanco.length = 0;
  w.saidas.length = 0;
  await dormir(100);
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  await dormir(100);
  assert.equal(w.saidas.length, 0);
});

// ── (5) a unidade é refeita pelo cartão ────────────────────────────────────────────────────────────────

test('a unidade que decide é a DONA de agora, não a gravada no trace', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO)); // gravada em u1
  w.donas.set('u1::5142896', UNIT_B); // o cartão foi para o resgate
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.deepEqual(w.unidadesConsultadas, ['u2']);
  await dormir(120); // deixa o burst fechar: o coalescer é do processo e não pode vazar para o teste seguinte
});

test('dois traces gravados em unidades diferentes que hoje têm a MESMA dona viram um turno só', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO)); // u1
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 5_000), { unitId: 'u2' }));
  w.donas.set('u1::5142896', UNIT_B);
  w.donas.set('u2::5142896', UNIT_B);
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(150);
  assert.equal(w.saidas.length, 1, 'duas respostas seriam o desastre');
  assert.equal(w.saidas[0]!.texto, 'primeira\n\nsegunda');
});

test('sem dona (unidade inativa ou lead inválido): fecha FAILED, sem resposta nem tarefa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.donas.set('u1::5142896', null);
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:unidade_ou_lead_invalido`);
  assert.equal(w.tarefas.length + w.saidas.length, 0);
});

test('não consegui descobrir a dona (Kommo/banco): não toca o trace e segue com os outros', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.traces.push(lead('t2', 'oi', new Date(FOTO.getTime() + 1_000), { leadId: '999' }));
  const original = deps.unidadeDona;
  deps.unidadeDona = async (t) => {
    if (t.leadId === '5142896') throw new Error('banco caiu');
    return original(t);
  };
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.traces[0]!.status, 'RUNNING');
  assert.equal(r.retomados, 1);
});

test('dois grupos gravados em unidades diferentes com a mesma dona pedem UMA tarefa, não duas', async () => {
  const { w, deps } = mundo();
  w.foraDoHorario = true;
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 5_000), { unitId: 'u2' }));
  w.donas.set('u1::5142896', UNIT_B);
  w.donas.set('u2::5142896', UNIT_B);
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(w.pedidosDeTarefa, 1);
});

test('dadosDeEncerramento: sempre FAILED, com o motivo na marca e na mensagem', () => {
  const d = dadosDeEncerramento('ia_pausada');
  assert.equal(d.status, 'FAILED');
  assert.equal(d.iaDecision, `${MARCA_ABANDONADO}:ia_pausada`);
  assert.match(d.errorMessage, /ia_pausada/);
});

test('em produção a reivindicação diz "incerto" quando o banco não responde (sem banco no teste)', async () => {
  const deps = depsDeProducao({
    unidadeDona: async () => null,
    retomar: async () => 'retomado',
    resumoDoPedido: () => ({ contato: null, texto: '' }),
  });
  assert.equal(await deps.reivindicar('trace-sem-banco'), 'incerto');
});

// ── banco incerto não é "tentativa que já aconteceu" ───────────────────────────────────────────────────

test('banco incerto na reivindicação, mesmo com o pedido velho: NÃO vira "já tentada" nem tarefa; a volta seguinte retoma', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.bancoFalhaNaReivindicacao = true;
  w.agora = FOTO.getTime() + IDADE_TENTATIVA_MORTA_MS + 60_000; // mais velho que o limite da tentativa morta
  const voltas = new Map<string, number>();
  let r = await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
  assert.equal(r.retomados, 0);
  assert.equal(w.tarefas.length, 0, 'o banco falhou, a IA nunca tentou: tarefa de "já tentada" seria mentira');
  assert.equal(w.traces[0]!.status, 'RUNNING');
  assert.equal(voltas.get('t1'), 1);

  w.bancoFalhaNaReivindicacao = false; // o banco voltou
  r = await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
  assert.equal(r.retomados, 1);
  await dormir(120);
  assert.equal(w.saidas.length, 1);
});

// ── trace sem decisão não pode esconder os mais novos ──────────────────────────────────────────────────

test('50 traces que ficam sem decisão saem da consulta depois de MAX_VOLTAS e deixam entrar o pedido mais novo', async () => {
  const { w, deps } = mundo();
  for (let i = 0; i < 50; i++) {
    const id = `preso-${i}`;
    w.traces.push(lead(id, 'oi', new Date(FOTO.getTime() - 60_000 + i), { leadId: `${1000 + i}` }));
    w.reivindicados.add(id); // de outro processo, recente: fica sem decisão
  }
  w.traces.push(lead('novo', 'oi', new Date(FOTO.getTime() + 10_000), { leadId: '777' }));
  const voltas = new Map<string, number>();
  for (let v = 0; v < MAX_VOLTAS_SEM_DECISAO; v++) {
    const r = await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
    assert.equal(r.retomados, 0, `volta ${v}: o "novo" ainda não cabe na fila`);
  }
  const r = await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
  assert.equal(r.retomados, 1, 'depois do teto os presos saem e o novo é visto');
  assert.deepEqual(w.retomadas, ['novo']);
  await dormir(120);
});

test('o que foi retomado ou fechado NÃO gasta volta sem decisão', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', FOTO));
  w.traces.push(lead('b', 'oi', FOTO, { leadId: '2' }));
  w.respostasNoBanco.push({ leadId: '2', em: new Date(FOTO.getTime() + 5_000) });
  const voltas = new Map<string, number>();
  await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas });
  await dormir(120);
  assert.equal(voltas.size, 0);
});

// ── parar no meio ──────────────────────────────────────────────────────────────────────────────────────

test('parar() verdadeiro (shutdown ou perdeu a liderança): não reivindica nem retoma nada', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', FOTO));
  const r = await recuperarTurnosPerdidos(deps, POSSE, { parar: () => true });
  assert.equal(r.retomados, 0);
  assert.equal(w.reivindicados.size, 0, 'nada gasta a reivindicação de 24 h');
  assert.equal(w.traces[0]!.status, 'RUNNING');
});

test('parar() no meio da volta: o paciente seguinte não é tocado', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', FOTO));
  w.traces.push(lead('b', 'oi', new Date(FOTO.getTime() + 1_000), { leadId: '2' }));
  const r = await recuperarTurnosPerdidos(deps, POSSE, { parar: () => w.retomadas.length >= 1 });
  await dormir(120);
  assert.equal(r.retomados, 1, 'só o primeiro paciente foi retomado');
  assert.deepEqual(w.retomadas, ['a']);
  assert.equal(w.unidadesConsultadas.length, 1, 'o segundo paciente nem foi consultado');
});

test('parar() depois de ler o Kommo e antes de reivindicar: nada é reivindicado (o claim de 24 h não se gasta à toa)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', FOTO));
  let leu = false;
  const original = deps.lerConversa;
  deps.lerConversa = async (u, l) => {
    leu = true;
    return original(u, l);
  };
  await recuperarTurnosPerdidos(deps, POSSE, { parar: () => leu });
  assert.equal(w.reivindicados.size, 0);
  assert.equal(w.liberadas.length, 0, 'nem chegou a reivindicar (não é reivindicar e devolver)');
  assert.equal(w.retomadas.length, 0);
});

// ── parar depois de reivindicar, volta interrompida, várias seguradas ──────────────────────────────────

test('parar() depois de ganhar a reivindicação e antes de retomar: devolve a reivindicação (a próxima volta refaz)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'um', FOTO));
  w.traces.push(lead('b', 'dois', new Date(FOTO.getTime() + 5_000)));
  await recuperarTurnosPerdidos(deps, POSSE, { parar: () => w.reivindicados.size + w.liberadas.length >= 2 });
  assert.deepEqual(w.liberadas.sort(), ['a', 'b']);
  assert.equal(w.reivindicados.size, 0, 'nada fica gasto à toa');
  assert.equal(w.retomadas.length, 0);
  // o próximo líder (ou a próxima volta) consegue retomar
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 2);
  await dormir(150);
});

test('volta interrompida por parar() não gasta volta sem decisão de quem nem foi avaliado', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', FOTO));
  w.traces.push(lead('b', 'oi', new Date(FOTO.getTime() + 1_000), { leadId: '2' }));
  const voltas = new Map<string, number>();
  await recuperarTurnosPerdidos(deps, POSSE, { voltasSemDecisao: voltas, parar: () => true });
  assert.equal(voltas.size, 0);
});

test('duas respostas seguradas voltam juntas numa só chamada (a memória guarda um texto por paciente)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.seguradas = [{ reply: 'primeira', mensagemId: 'm1' }, { reply: 'segunda', mensagemId: 'm2' }];
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(120);
  assert.equal(w.chamadasDeRestauracao, 1);
  assert.deepEqual(w.restauradas.map((x) => x.reply), ['primeira', 'segunda']);
});

test('o banco é lido UMA vez por paciente, não por trace', async () => {
  const { w, deps } = mundo();
  for (let i = 0; i < 5; i++) w.traces.push(lead(`t${i}`, `m${i}`, new Date(FOTO.getTime() + i * 1_000)));
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(150);
  assert.equal(w.unidadesConsultadas.length, 1);
});

test('resposta da IA no banco entre dois pedidos: só o primeiro é "já respondido"', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 24_000)));
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() + 10_000) });
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 'a'), `${MARCA_ABANDONADO}:ja_respondida`);
  assert.equal(r.retomados, 1);
  assert.deepEqual(w.retomadas, ['b']);
  await dormir(120);
});

// ── a resposta segurada só volta DEPOIS de haver turno a caminho ───────────────────────────────────────

test('a resposta segurada é lida ANTES de retomar e restaurada DEPOIS — e uma só vez, mesmo com vários pedidos', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 5_000)));
  w.seguradas = [{ reply: 'Olá! Posso ajudar?', mensagemId: 'm-1' }];
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(150);
  assert.deepEqual(w.eventos, ['lê seguradas', 'retoma a', 'restaura', 'retoma b']);
  assert.equal(w.chamadasDeRestauracao, 1);
});

test('retomar devolve tarefa/descartado ou lança: a resposta segurada NÃO volta (sem turno a caminho a IA pediria desculpa por nada)', async () => {
  for (const resultado of ['tarefa:burst_cheio', 'descartado:encerramento_repetido', new Error('boom')] as const) {
    const { w, deps } = mundo();
    w.traces.push(lead('t1', 'oi', FOTO));
    w.seguradas = [{ reply: 'Olá!', mensagemId: 'm-1' }];
    w.retomada = () => resultado;
    await recuperarTurnosPerdidos(deps, POSSE);
    assert.equal(w.chamadasDeRestauracao, 0, String(resultado));
    assert.equal(w.restauradas.length, 0);
  }
});

test('sem resposta segurada, nada é restaurado', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  await recuperarTurnosPerdidos(deps, POSSE);
  await dormir(100);
  assert.equal(w.chamadasDeRestauracao, 0);
});

// ── (4) o satélite do burst: o dono rodou o modelo ─────────────────────────────────────────────────────

test('satélite do burst: o DONO (já fechado) rodou o modelo/ferramenta → TAREFA, o satélite NÃO é reinjetado', async () => {
  const { w, deps } = mundo();
  // o dono foi fechado FAILED por uma volta anterior; o satélite (só webhook) segue RUNNING
  w.traces.push(
    lead('dono', 'primeira', new Date(FOTO.getTime() - 10_000), {
      status: 'FAILED',
      iaDecision: `${MARCA_ABANDONADO}:ja_respondida`,
      passos: [{ kind: 'WEBHOOK_RECEIVED', title: 'Mensagem' }, { kind: 'TOOL_CALL', title: 'agendar_consulta' }],
    }),
  );
  w.traces.push(lead('satelite', 'segunda', FOTO));
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 0);
  assert.equal(w.retomadas.length, 0);
  assert.equal(w.tarefas.length, 1);
  assert.equal(motivoDe(w, 'satelite'), `${MARCA_ABANDONADO}:turno_ja_tinha_comecado`);
});

test('satélite: um turno que FALHOU por erro do modelo (FAILED sem marca de abandono) não é o dono do burst — o pedido ainda volta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('falhou', 'x', new Date(FOTO.getTime() - 20_000), { status: 'FAILED', iaDecision: null, passos: [{ kind: 'THINKING', title: 'IA analisando intenção' }] }));
  w.traces.push(lead('b', 'oi', FOTO));
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  await dormir(100);
});

test('satélite: o dono do burst é de OUTRO paciente, ou de mais de JANELA_DO_BURST_MS antes → não conta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('outro', 'x', new Date(FOTO.getTime() - 5_000), { leadId: '999', status: 'FAILED', passos: [{ kind: 'TOOL_CALL', title: 'x' }] }));
  w.traces.push(lead('velho', 'x', new Date(FOTO.getTime() - JANELA_DO_BURST_MS - 1_000), { status: 'FAILED', passos: [{ kind: 'TOOL_CALL', title: 'x' }] }));
  w.traces.push(lead('t1', 'oi', FOTO));
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(r.retomados, 1);
  await dormir(100);
});

// ── a janela de 10 min depois de assumir a liderança ───────────────────────────────────────────────────

test('dentroDaJanelaDeRecuperacao: só nos 10 min seguintes à posse (a borda inclusive); sem posse, nunca', () => {
  const posse = new Date('2026-11-03T11:26:00Z');
  assert.equal(JANELA_APOS_LIDERANCA_MS, 10 * 60_000);
  assert.equal(dentroDaJanelaDeRecuperacao(posse, posse.getTime() + 2 * 60_000), true);
  assert.equal(dentroDaJanelaDeRecuperacao(posse, posse.getTime() + JANELA_APOS_LIDERANCA_MS), true);
  assert.equal(dentroDaJanelaDeRecuperacao(posse, posse.getTime() + JANELA_APOS_LIDERANCA_MS + 1), false);
  assert.equal(dentroDaJanelaDeRecuperacao(posse, posse.getTime() + 60 * 60_000), false, 'trace preso 1 h depois é outra coisa');
  assert.equal(dentroDaJanelaDeRecuperacao(null, posse.getTime()), false);
});

test('agendarRecuperacao: varre dentro da janela e, passada ela, NÃO varre mais (só reagenda)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-03T11:26:00Z') });
  const posse = { desde: new Date(Date.now()), janelaDesde: new Date(Date.now()) };
  let buscas = 0;
  const { deps } = mundo();
  const contando: DepsRecuperacao = { ...deps, buscarPerdidos: async () => { buscas++; return []; } };
  const ganchos = { unidadeDona: async () => null, retomar: async () => 'retomado' as const, resumoDoPedido: () => ({ contato: null, texto: '' }) };
  const parar = agendarRecuperacao(ganchos, () => posse, contando);
  // Um timer por vez (cada volta reagenda a próxima ao terminar): anda um passo e deixa a volta assentar.
  const andar = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  await andar(ATRASO_INICIAL_MS); // 1 min depois da posse: dentro
  assert.equal(buscas, 1);
  for (let i = 0; i < 4; i++) await andar(INTERVALO_MS); // até 9 min: dentro
  assert.equal(buscas, 5, 'uma varredura por intervalo dentro da janela');
  await andar(INTERVALO_MS); // 11 min: passou de 10
  for (let i = 0; i < 5; i++) await andar(INTERVALO_MS);
  assert.equal(buscas, 5, 'passada a janela não varre mais');
  parar();
});

test('agendarRecuperacao: a JANELA de 10 min conta do lease (janelaDesde) e o PISO da busca da posse (desde) — cada um com o seu', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-03T11:08:00Z') });
  // virou líder às 11:00 em sem-lease e o lease só veio às 11:08 (agora)
  const posse = { desde: new Date('2026-11-03T11:00:00Z'), janelaDesde: new Date(Date.now()) };
  const pisos: Date[] = [];
  const { deps } = mundo();
  const contando: DepsRecuperacao = { ...deps, buscarPerdidos: async (p) => { pisos.push(p.criadosDepois); return []; } };
  const ganchos = { unidadeDona: async () => null, retomar: async () => 'retomado' as const, resumoDoPedido: () => ({ contato: null, texto: '' }) };
  const parar = agendarRecuperacao(ganchos, () => posse, contando);
  const andar = async (ms: number) => {
    t.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  await andar(ATRASO_INICIAL_MS); // 11:09 — 9 min depois da posse, 1 min depois do lease
  for (let i = 0; i < 3; i++) await andar(INTERVALO_MS); // até 11:15 — 15 min depois da posse, 7 min depois do lease: ainda varre
  assert.equal(pisos.length, 4, 'a janela conta do lease, não da posse');
  assert.ok(pisos.every((d) => d.getTime() === posse.desde.getTime() - FOLGA_ANTES_DA_POSSE_MS), 'o piso fica na posse (menos a folga)');
  for (let i = 0; i < 4; i++) await andar(INTERVALO_MS); // passou de 10 min do lease
  const n = pisos.length;
  for (let i = 0; i < 3; i++) await andar(INTERVALO_MS);
  assert.equal(pisos.length, n, 'passados 10 min do lease não varre mais');
  parar();
});

test('agendarRecuperacao: sem posse (não é líder em modo lease) não varre', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-03T11:26:00Z') });
  let buscas = 0;
  const { deps } = mundo();
  const contando: DepsRecuperacao = { ...deps, buscarPerdidos: async () => { buscas++; return []; } };
  const ganchos = { unidadeDona: async () => null, retomar: async () => 'retomado' as const, resumoDoPedido: () => ({ contato: null, texto: '' }) };
  const parar = agendarRecuperacao(ganchos, () => null, contando);
  t.mock.timers.tick(ATRASO_INICIAL_MS + INTERVALO_MS * 3);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(buscas, 0);
  parar();
});

// ── tarefa: a recuperação e o alerta de sem-resposta não abrem duas ────────────────────────────────────

test('jaHaTarefaParaOPedido: a marca de QUALQUER das duas tarefas, criada depois do pedido, cobre; anterior ou ausente não', () => {
  const pedido = new Date('2026-11-03T11:24:27Z');
  const depois = new Date(pedido.getTime() + 60_000);
  const antes = new Date(pedido.getTime() - 60_000);
  assert.equal(jaHaTarefaParaOPedido([null, null], pedido), false);
  assert.equal(jaHaTarefaParaOPedido([antes, antes], pedido), false);
  assert.equal(jaHaTarefaParaOPedido([depois, null], pedido), true);
  assert.equal(jaHaTarefaParaOPedido([null, depois], pedido), true);
  assert.equal(jaHaTarefaParaOPedido([], pedido), false);
});

const ganchosVazios = { unidadeDona: async () => null, retomar: async () => 'retomado' as const, resumoDoPedido: () => ({ contato: null, texto: '' }) };

test('em produção, criarTarefa não abre outra quando o alerta de sem-resposta (sem_resposta_tarefa) já abriu uma DEPOIS do pedido', async () => {
  const pedido = new Date('2026-11-03T11:24:27Z');
  const consultadas: string[] = [];
  const deps = depsDeProducao(ganchosVazios, bancoFalso({ unidadesDaConta: ['u1'] }).banco, {
    marcadoEm: async (_u, _l, regra) => {
      consultadas.push(regra);
      return regra === 'sem_resposta_tarefa' ? new Date(pedido.getTime() + 5 * 60_000) : null;
    },
  });
  const r = await deps.criarTarefa(UNIT_A, { traceId: 't', unitId: 'u1', leadId: '7165547', criadoEm: pedido, input: {} }, 60_000);
  assert.equal(r, 'ja_existia');
  assert.ok(consultadas.includes('sem_resposta_tarefa') && consultadas.includes('turno_perdido_tarefa'), `consultou as duas marcas: ${consultadas}`);
});

test('em produção, criarTarefa não abre outra quando a própria recuperação já abriu uma DEPOIS do pedido', async () => {
  const pedido = new Date('2026-11-03T11:24:27Z');
  const deps = depsDeProducao(ganchosVazios, bancoFalso({ unidadesDaConta: ['u1'] }).banco, {
    marcadoEm: async (_u, _l, regra) => (regra === 'turno_perdido_tarefa' ? new Date(pedido.getTime() + 60_000) : null),
  });
  assert.equal(await deps.criarTarefa(UNIT_A, { traceId: 't', unitId: 'u1', leadId: '7165547', criadoEm: pedido, input: {} }, 1), 'ja_existia');
});

test('criarTarefa: a tarefa aberta pela OUTRA unidade da mesma conta do Kommo (comercial ↔ resgate) também cobre o pedido', async () => {
  const pedido = new Date('2026-11-03T11:24:27Z');
  const lidas: string[] = [];
  const deps = depsDeProducao(ganchosVazios, bancoFalso({ unidadesDaConta: ['u1', 'u2'] }).banco, {
    marcadoEm: async (unitId, _l, regra) => {
      lidas.push(`${unitId}:${regra}`);
      return unitId === 'u2' && regra === 'sem_resposta_tarefa' ? new Date(pedido.getTime() + 60_000) : null;
    },
  });
  assert.equal(await deps.criarTarefa(UNIT_A, { traceId: 't', unitId: 'u1', leadId: '7165547', criadoEm: pedido, input: {} }, 1), 'ja_existia');
  assert.equal(lidas.length, 4, `2 unidades × 2 marcas: ${lidas}`);
});

// ── produção contra um banco falso: as consultas certas, com os filtros certos ─────────────────────────

function bancoFalso(opts: { unidadesDaConta?: string[]; ultimaResposta?: Date | null } = {}) {
  const chamadas = {
    unitFindMany: [] as unknown[],
    unitFindUnique: [] as unknown[],
    messageFindFirst: [] as unknown[],
    stepFindMany: [] as unknown[],
    traceFindMany: [] as unknown[],
    traceUpdateMany: [] as unknown[],
  };
  const banco = {
    unit: {
      findMany: async (a: unknown) => {
        chamadas.unitFindMany.push(a);
        return (opts.unidadesDaConta ?? ['u1', 'u2']).map((id) => ({ id }));
      },
      findUnique: async (a: unknown) => {
        chamadas.unitFindUnique.push(a);
        return { ...UNIT_A, pausaAte: null };
      },
    },
    message: {
      findFirst: async (a: unknown) => {
        chamadas.messageFindFirst.push(a);
        return opts.ultimaResposta ? { createdAt: opts.ultimaResposta } : null;
      },
    },
    executionStep: {
      findMany: async (a: unknown) => {
        chamadas.stepFindMany.push(a);
        return [{ kind: 'WEBHOOK_RECEIVED', title: 'x', payload: { reply: 'segurada' }, trace: { status: 'RUNNING', iaDecision: null } }];
      },
    },
    executionTrace: {
      findMany: async (a: unknown) => {
        chamadas.traceFindMany.push(a);
        return [];
      },
      updateMany: async (a: unknown) => {
        chamadas.traceUpdateMany.push(a);
        return { count: 1 };
      },
    },
  } as unknown as BancoDaRecuperacao;
  return { banco, chamadas };
}

test('seguradasPendentes: lê as unidades da MESMA conta do Kommo (comercial e resgate), nas duas consultas', async () => {
  const { banco, chamadas } = bancoFalso({ unidadesDaConta: ['u1', 'u2'] });
  const deps = depsDeProducao(ganchosVazios, banco);
  const lista = await deps.seguradasPendentes(UNIT_A, '5142896', FOTO);
  assert.deepEqual(chamadas.unitFindMany, [{ where: { kommoSubdomain: 'timbo' }, select: { id: true } }]);
  const msgWhere = (chamadas.messageFindFirst[0] as { where: { conversation: { unitId: { in: string[] }; leadId: string } } }).where;
  assert.deepEqual(msgWhere.conversation.unitId.in, ['u1', 'u2']);
  assert.equal(msgWhere.conversation.leadId, '5142896');
  const stepWhere = (chamadas.stepFindMany[0] as { where: { trace: { unitId: { in: string[] }; leadId: string } } }).where;
  assert.deepEqual(stepWhere.trace.unitId.in, ['u1', 'u2']);
  assert.equal(stepWhere.trace.leadId, '5142896');
  assert.deepEqual(lista, [{ reply: 'segurada', mensagemId: null }]);
});

test('seguradasPendentes: unidade sem conta do Kommo só olha a si mesma (e nem consulta as outras); conta sem unidades cai na própria', async () => {
  const sem = bancoFalso();
  await depsDeProducao(ganchosVazios, sem.banco).seguradasPendentes({ ...UNIT_A, kommoSubdomain: null } as unknown as Unit, '1', FOTO);
  assert.equal(sem.chamadas.unitFindMany.length, 0);
  assert.deepEqual((sem.chamadas.stepFindMany[0] as { where: { trace: { unitId: { in: string[] } } } }).where.trace.unitId.in, ['u1']);
  const vazia = bancoFalso({ unidadesDaConta: [] });
  await depsDeProducao(ganchosVazios, vazia.banco).seguradasPendentes(UNIT_A, '1', FOTO);
  assert.deepEqual((vazia.chamadas.stepFindMany[0] as { where: { trace: { unitId: { in: string[] } } } }).where.trace.unitId.in, ['u1']);
});

test('seguradasPendentes: o piso é a última resposta que saiu, mas nunca mais de 30 min antes do pedido', async () => {
  const antiga = bancoFalso({ ultimaResposta: new Date(FOTO.getTime() - 3 * 3600_000) });
  await depsDeProducao(ganchosVazios, antiga.banco).seguradasPendentes(UNIT_A, '1', FOTO);
  const desdeAntiga = (antiga.chamadas.stepFindMany[0] as { where: { createdAt: { gt: Date } } }).where.createdAt.gt;
  assert.equal(desdeAntiga.getTime(), FOTO.getTime() - 30 * 60_000);
  const recente = new Date(FOTO.getTime() - 5 * 60_000);
  const rec = bancoFalso({ ultimaResposta: recente });
  await depsDeProducao(ganchosVazios, rec.banco).seguradasPendentes(UNIT_A, '1', FOTO);
  assert.equal((rec.chamadas.stepFindMany[0] as { where: { createdAt: { gt: Date } } }).where.createdAt.gt.getTime(), recente.getTime());
});

test('encerrar: só fecha o que AINDA está RUNNING (nunca sobrescreve um turno que terminou de verdade) e sempre FAILED com o motivo', async () => {
  const { banco, chamadas } = bancoFalso();
  await depsDeProducao(ganchosVazios, banco).encerrar('trace-1', 'ja_respondida');
  assert.deepEqual(chamadas.traceUpdateMany, [
    { where: { id: 'trace-1', status: 'RUNNING' }, data: dadosDeEncerramento('ja_respondida') },
  ]);
});

test('buscarPerdidos: usa o filtro de perdidos (RUNNING, kommo_chat, janela, sem os em voo) em ordem de chegada', async () => {
  const { banco, chamadas } = bancoFalso();
  const j = janelaDeBusca(T_VARREDURA, POSSE);
  await depsDeProducao(ganchosVazios, banco).buscarPerdidos({ ...j, limite: 50, excluirIds: ['x'] });
  const a = chamadas.traceFindMany[0] as { where: unknown; orderBy: unknown; take: number };
  assert.deepEqual(a.where, filtroDePerdidos({ ...j, excluirIds: ['x'] }));
  assert.deepEqual(a.orderBy, { createdAt: 'asc' });
  assert.equal(a.take, 50);
});

test('passosDoBurst: os passos do paciente (qualquer unidade da conta), RUNNING/FAILED, até JANELA_DO_BURST_MS antes do pedido', async () => {
  const { banco, chamadas } = bancoFalso({ unidadesDaConta: ['u1', 'u2'] });
  const passos = await depsDeProducao(ganchosVazios, banco).passosDoBurst(UNIT_A, { traceId: 't', unitId: 'u1', leadId: '5142896', criadoEm: FOTO, input: {} });
  const where = (chamadas.stepFindMany[0] as { where: { trace: { leadId: string; unitId: { in: string[] }; status: { in: string[] }; createdAt: { gte: Date; lte: Date } } } }).where.trace;
  assert.equal(where.leadId, '5142896');
  assert.deepEqual(where.unitId.in, ['u1', 'u2']);
  assert.deepEqual(where.status.in, ['RUNNING', 'FAILED']);
  assert.equal(where.createdAt.gte.getTime(), FOTO.getTime() - JANELA_DO_BURST_MS);
  assert.equal(where.createdAt.lte.getTime(), FOTO.getTime());
  assert.deepEqual(passos, [{ kind: 'WEBHOOK_RECEIVED', title: 'x' }]);
});

test('iaPausada em produção: relê a unidade do banco (a recepção pode ter pausado depois de carregada) e unidade que sumiu = pausada', async () => {
  const { banco, chamadas } = bancoFalso();
  const deps = depsDeProducao(ganchosVazios, banco);
  const pausadaAte = new Date(Date.now() + 3600_000);
  (banco.unit as unknown as { findUnique: (a: unknown) => Promise<unknown> }).findUnique = async (a) => {
    chamadas.unitFindUnique.push(a);
    return { ...UNIT_A, pausaAte: pausadaAte };
  };
  assert.equal(await deps.iaPausada(UNIT_A, '5142896'), true);
  assert.deepEqual(chamadas.unitFindUnique[0], { where: { id: 'u1' } });
  (banco.unit as unknown as { findUnique: (a: unknown) => Promise<unknown> }).findUnique = async () => null;
  assert.equal(await deps.iaPausada(UNIT_A, '5142896'), true, 'sem unidade não há IA a retomar');
});

test('em produção, enviosDaIa devolve cada resposta de turno com o trace de que veio e quando ele NASCEU (null se não achar)', async () => {
  const nasceu = new Date('2026-11-03T11:24:12Z');
  const { banco, chamadas } = bancoFalso();
  (banco.executionTrace as unknown as { findMany: (a: unknown) => Promise<unknown[]> }).findMany = async (a) => {
    chamadas.traceFindMany.push(a);
    return [{ id: 'ANT', createdAt: nasceu }];
  };
  const pedidas: unknown[] = [];
  const deps = depsDeProducao(ganchosVazios, banco, {
    respostasDeTurno: async (unit, leadId, desde) => {
      pedidas.push([unit.id, leadId, desde]);
      return [
        { em: new Date('2026-11-03T11:24:30Z'), traceId: 'ANT' },
        { em: new Date('2026-11-03T11:24:31Z'), traceId: 'SUMIU' },
      ];
    },
  });
  const r = await deps.enviosDaIa(UNIT_A, '7165547', FOTO);
  assert.deepEqual(pedidas, [['u1', 7165547, FOTO]]);
  assert.deepEqual(r, [
    { em: new Date('2026-11-03T11:24:30Z'), traceId: 'ANT', traceCriadoEm: nasceu },
    { em: new Date('2026-11-03T11:24:31Z'), traceId: 'SUMIU', traceCriadoEm: null },
  ]);
  assert.deepEqual((chamadas.traceFindMany[0] as { where: { id: { in: string[] } } }).where.id.in.sort(), ['ANT', 'SUMIU']);
  const vazio = depsDeProducao(ganchosVazios, banco, { respostasDeTurno: async () => [] });
  assert.deepEqual(await vazio.enviosDaIa(UNIT_A, '1', FOTO), []);
});

test('o "já respondido" do banco é por pedido, sem folga: a resposta do turno ANTERIOR (1,5 s antes do 2º pedido) não fecha o 2º', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'primeira', FOTO));
  w.traces.push(lead('b', 'segunda', new Date(FOTO.getTime() + 24_000)));
  w.respostasNoBanco.push({ leadId: '5142896', em: new Date(FOTO.getTime() + 22_500) }); // 1,5 s antes do pedido b
  const r = await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 'a'), `${MARCA_ABANDONADO}:ja_respondida`);
  assert.equal(r.retomados, 1);
  assert.deepEqual(w.retomadas, ['b']);
  await dormir(120);
});

test('roboSaiuDepois: fala humana da equipe NÃO é robô (quem decide que o humano respondeu é equipeRespondeuDepois)', () => {
  const t = new Date('2026-10-30T20:00:00Z');
  assert.equal(roboSaiuDepois([msg('saida', new Date(t.getTime() + 60_000))], t), false);
  assert.equal(roboSaiuDepois([msg('entrada', new Date(t.getTime() + 60_000), { autor: 'sofia' })], t), false);
  assert.equal(roboSaiuDepois([msg('saida', new Date(t.getTime() + 60_000), { autor: 'sofia' })], t), true);
});

test('traceDoBurstDoPedido: RUNNING (o dono que o deploy matou) e FAILED com a marca de abandono; SUCCESS e FAILED por erro do modelo não', () => {
  assert.equal(traceDoBurstDoPedido({ status: 'RUNNING', iaDecision: null }), true);
  assert.equal(traceDoBurstDoPedido({ status: 'FAILED', iaDecision: `${MARCA_ABANDONADO}:ja_respondida` }), true);
  assert.equal(traceDoBurstDoPedido({ status: 'FAILED', iaDecision: null }), false);
  assert.equal(traceDoBurstDoPedido({ status: 'FAILED', iaDecision: 'erro do modelo' }), false);
  assert.equal(traceDoBurstDoPedido({ status: 'FAILED', iaDecision: { x: 1 } }), false);
  assert.equal(traceDoBurstDoPedido({ status: 'SUCCESS', iaDecision: `${MARCA_ABANDONADO}:x` }), false);
});

test('passosDoBurst: descarta os passos de trace FAILED por erro do modelo (a marca de abandono é conferida no resultado)', async () => {
  const { banco } = bancoFalso();
  (banco.executionStep as unknown as { findMany: () => Promise<unknown[]> }).findMany = async () => [
    { kind: 'THINKING', title: 'IA analisando', trace: { status: 'FAILED', iaDecision: 'erro' } },
    { kind: 'TOOL_CALL', title: 'agendar', trace: { status: 'FAILED', iaDecision: `${MARCA_ABANDONADO}:ja_respondida` } },
    { kind: 'WEBHOOK_RECEIVED', title: 'm', trace: { status: 'RUNNING', iaDecision: null } },
  ];
  const passos = await depsDeProducao(ganchosVazios, banco).passosDoBurst(UNIT_A, { traceId: 't', unitId: 'u1', leadId: '1', criadoEm: FOTO, input: {} });
  assert.deepEqual(passos.map((p) => p.kind), ['TOOL_CALL', 'WEBHOOK_RECEIVED']);
});

// ── passosDoBurst com um banco que RESPEITA o filtro (o falso de cima devolve o que mandarem, qualquer que seja o where) ────

interface PassoComTrace {
  kind: string;
  title: string;
  trace: { id: string; leadId: string; unitId: string; status: string; iaDecision: unknown; createdAt: Date };
}

/** Avalia só os filtros que `passosDoBurst` usa; um filtro que ele passe a usar sem o teste saber QUEBRA o teste de propósito. */
function casaComOFiltroDoTrace(where: Record<string, unknown>, tr: PassoComTrace['trace']): boolean {
  return Object.entries(where).every(([chave, v]) => {
    if (chave === 'id') return tr.id === v;
    if (chave === 'leadId') return tr.leadId === v;
    if (chave === 'unitId') return (v as { in: string[] }).in.includes(tr.unitId);
    if (chave === 'status') return (v as { in: string[] }).in.includes(tr.status);
    if (chave === 'createdAt') {
      const { gte, lte } = v as { gte?: Date; lte?: Date };
      return (!gte || tr.createdAt >= gte) && (!lte || tr.createdAt <= lte);
    }
    throw new Error(`filtro do trace que o teste não conhece: ${chave}`);
  });
}

function bancoComPassos(passos: PassoComTrace[], unidadesDaConta = ['u1', 'u2']) {
  const { banco } = bancoFalso({ unidadesDaConta });
  (banco.executionStep as unknown as { findMany: (a: { where: { trace: Record<string, unknown> } }) => Promise<unknown[]> }).findMany = async (a) =>
    passos.filter((p) => casaComOFiltroDoTrace(a.where.trace, p.trace));
  return banco;
}

test('passosDoBurst (banco que respeita o filtro): o satélite enxerga o passo do DONO, que é de outro trace', async () => {
  const mk = (id: string, deslocamentoMs: number, over: Partial<PassoComTrace['trace']> = {}) => ({
    id, leadId: '5142896', unitId: 'u1', status: 'RUNNING', iaDecision: null as unknown, createdAt: new Date(FOTO.getTime() + deslocamentoMs), ...over,
  });
  const passos: PassoComTrace[] = [
    { kind: 'WEBHOOK_RECEIVED', title: 'm', trace: mk('satelite', 0) },
    { kind: 'TOOL_CALL', title: 'do-dono', trace: mk('dono', -10_000) },
    { kind: 'TOOL_CALL', title: 'dono-outra-unidade-da-conta', trace: mk('d2', -5_000, { unitId: 'u2' }) },
    { kind: 'TOOL_CALL', title: 'outro-paciente', trace: mk('o', -5_000, { leadId: '999' }) },
    { kind: 'TOOL_CALL', title: 'outra-conta', trace: mk('c', -5_000, { unitId: 'u9' }) },
    { kind: 'TOOL_CALL', title: 'longe-demais', trace: mk('l', -JANELA_DO_BURST_MS - 1_000) },
    { kind: 'TOOL_CALL', title: 'depois-do-pedido', trace: mk('p', 5_000) },
    { kind: 'TOOL_CALL', title: 'sucesso', trace: mk('s', -5_000, { status: 'SUCCESS' }) },
    { kind: 'TOOL_CALL', title: 'falha-do-modelo', trace: mk('f', -5_000, { status: 'FAILED', iaDecision: 'erro' }) },
    { kind: 'TOOL_CALL', title: 'fechado-pela-recuperacao', trace: mk('r', -5_000, { status: 'FAILED', iaDecision: `${MARCA_ABANDONADO}:x` }) },
  ];
  const deps = depsDeProducao(ganchosVazios, bancoComPassos(passos));
  const vistos = (await deps.passosDoBurst(UNIT_A, { traceId: 'satelite', unitId: 'u1', leadId: '5142896', criadoEm: FOTO, input: {} })).map((p) => p.title);
  assert.deepEqual(vistos.sort(), ['do-dono', 'dono-outra-unidade-da-conta', 'fechado-pela-recuperacao', 'm'].sort());
  assert.equal(turnoJaAvancou(await deps.passosDoBurst(UNIT_A, { traceId: 'satelite', unitId: 'u1', leadId: '5142896', criadoEm: FOTO, input: {} })), true);
});
