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
  saiuMensagemDepois,
  IDADE_MINIMA_MS,
  FOLGA_ANTES_DA_POSSE_MS,
  MAX_VOLTAS_SEM_DECISAO,
  IDADE_TENTATIVA_MORTA_MS,
  MARCA_ABANDONADO,
} = await import('./recuperar-turnos.js');
import type {
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
    respostasNoBanco: [] as Array<{ leadId: string; em: Date }>,
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
    async passosDoTrace(traceId) {
      return w.traces.find((t) => t.id === traceId)?.passos ?? [];
    },
    async unidadeDona(t) {
      const k = `${t.unitId}::${t.leadId}`;
      if (w.donas.has(k)) return w.donas.get(k)!;
      return t.unitId === 'u1' ? UNIT_A : UNIT_B;
    },
    async enviosDaIa(unit, leadId, desde) {
      w.unidadesConsultadas.push(unit.id);
      return w.respostasNoBanco.filter((r) => r.leadId === leadId && r.em >= desde).map((r) => r.em);
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
      return w.seguradas;
    },
    restaurarSeguradas(_u, _l, lista) {
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
          w.respostasNoBanco.push({ leadId: t.leadId, em: new Date(w.agora + 1) });
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

test('QUALQUER saída depois do pedido conta, não só a da equipe (robô, Sofia)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t1', 'oi', FOTO));
  w.kommo = { msgs: [msg('saida', new Date(FOTO.getTime() + 60_000), { autor: 'sofia', autorNome: 'Doutor Digital' })], equipeComAPalavra: false, naoConferi: false };
  await recuperarTurnosPerdidos(deps, POSSE);
  assert.equal(motivoDe(w, 't1'), `${MARCA_ABANDONADO}:ja_respondida`);
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
});

test('saiuMensagemDepois: entrada, saída antiga e resposta automática não contam; saída depois conta', () => {
  const t = new Date('2026-10-30T20:00:00Z');
  assert.equal(saiuMensagemDepois([msg('entrada', new Date(t.getTime() + 10_000))], t), false);
  assert.equal(saiuMensagemDepois([msg('saida', new Date(t.getTime() - 60_000))], t), false);
  assert.equal(saiuMensagemDepois([msg('saida', new Date(t.getTime() + 60_000))], t), true);
  assert.equal(saiuMensagemDepois([], t), false);
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
  const base: EstadoLideranca = { lider: true, modo: 'lease', desde: POSSE, dono: 'a', falhasSeguidas: 0, ultimaVerificacao: null };
  assert.equal(posseDaLideranca(base), POSSE);
  assert.equal(posseDaLideranca({ ...base, modo: 'sem-lease' }), null, 'sem lease o antigo pode estar vivo');
  assert.equal(posseDaLideranca({ ...base, lider: false, modo: 'aguardando', desde: null }), null);
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
