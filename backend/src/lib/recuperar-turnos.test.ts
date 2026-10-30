import { test } from 'node:test';
import assert from 'node:assert/strict';

// Janela curta do coalescer só para o teste (a de produção é 8 s).
process.env.AGENT_COALESCE_MS = '30';
const { scheduleAgentRun } = await import('./agent-coalescer.js');
const {
  recuperarTurnosPerdidos,
  varrerSeLider,
  IDADE_MINIMA_MS,
  IDADE_MAXIMA_MS,
  IDADE_TENTATIVA_MORTA_MS,
  MARCA_ABANDONADO,
} = await import('./recuperar-turnos.js');
import type { DepsRecuperacao, TurnoPerdido, RespostaSegurada, ResultadoRetomada } from './recuperar-turnos.js';

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mundo falso: banco (traces, respostas da IA, pausa, reivindicações) e "Kommo" (as respostas que SAÍRAM).
 * O `retomar` usa o coalescer de verdade e conta as respostas: é o que prova "1 reprocessamento, 1 resposta".
 *
 * Cenário-base = o caso real (Timbó, lead 5142896, 30/10/2026): 17:00:47 áudio (resposta segurada), 17:01:05 foto
 * (trace RUNNING, o serviço reiniciou). O novo processo sobe às 17:01:10 e varre às 17:03:10.
 */
const T_BOOT = Date.parse('2026-10-30T20:01:10Z'); // 17:01:10 BRT
const T_VARREDURA = T_BOOT + 120_000;

interface TraceFalso {
  id: string;
  unitId: string;
  leadId: string;
  criadoEm: Date;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  iaDecision: string | null;
  input: unknown;
}

function mundo(opts: { agora?: number; pausada?: boolean; retomada?: (t: TurnoPerdido) => ResultadoRetomada } = {}) {
  const w = {
    /** traces que ESTE processo tem na fila/rodando */
    emVoo: new Set<string>(),
    traces: [] as TraceFalso[],
    respostasDaIa: [] as Array<{ unitId: string; leadId: string; em: Date }>,
    pausados: new Set<string>(),
    reivindicados: new Set<string>(),
    seguradas: [] as RespostaSegurada[],
    restauradas: [] as RespostaSegurada[],
    /** o que SAIU para o paciente */
    saidas: [] as Array<{ leadId: string; texto: string; traceIds: string[] }>,
    consultas: [] as Array<{ criadosAntes: Date; criadosDepois: Date; excluirIds: string[] }>,
    agora: opts.agora ?? T_VARREDURA,
  };
  if (opts.pausada) w.pausados.add('u1::5142896');

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
    async respondidoDepois(t) {
      return w.respostasDaIa.some((r) => r.unitId === t.unitId && r.leadId === t.leadId && r.em > t.criadoEm);
    },
    async iaPausada(unitId, leadId) {
      return w.pausados.has(`${unitId}::${leadId}`);
    },
    async reivindicar(traceId) {
      if (w.reivindicados.has(traceId)) return false;
      w.reivindicados.add(traceId);
      return true;
    },
    async seguradasPendentes() {
      return w.seguradas;
    },
    restaurarSegurada(_u, _l, s) {
      w.restauradas.push(s);
    },
    async retomar(t) {
      const r = opts.retomada?.(t);
      if (r && r !== 'retomado') return r;
      const texto = (t.input as { texto: string }).texto;
      scheduleAgentRun({
        unitSlug: t.unitId,
        leadId: Number(t.leadId),
        traceId: t.traceId,
        humanMessage: texto,
        audioUrl: null,
        imageUrl: null,
        run: async (combinado, _a, _i, traceIds) => {
          // a "IA" responde UMA vez por turno e grava a resposta (como o addMessage do envio)
          w.saidas.push({ leadId: t.leadId, texto: combinado, traceIds });
          w.respostasDaIa.push({ unitId: t.unitId, leadId: t.leadId, em: new Date(w.agora + 1) });
          for (const id of traceIds) {
            const tr = w.traces.find((x) => x.id === id);
            if (tr) tr.status = 'SUCCESS';
          }
        },
      });
      return 'retomado';
    },
    async encerrar(traceId, status, motivo) {
      const tr = w.traces.find((x) => x.id === traceId);
      if (tr && tr.status === 'RUNNING') {
        tr.status = status;
        tr.iaDecision = `${MARCA_ABANDONADO}:${motivo}`;
      }
    },
  };
  return { w, deps };
}

const lead = (id: string, texto: string, segDepoisDoBoot: number, extra: Partial<TraceFalso> = {}): TraceFalso => ({
  id,
  unitId: 'u1',
  leadId: '5142896',
  criadoEm: new Date(T_BOOT + segDepoisDoBoot * 1000),
  status: 'RUNNING',
  iaDecision: null,
  input: { texto },
  ...extra,
});

test('reinício no meio do turno: no start, UM reprocessamento e UMA resposta (a foto da paciente)', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-foto', 'foto do paciente', -5)); // chegou 5 s antes do boot
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(150);
  assert.equal(r.candidatos, 1);
  assert.equal(r.retomados, 1);
  assert.equal(w.saidas.length, 1);
  assert.equal(w.saidas[0]!.texto, 'foto do paciente');
  assert.equal(w.traces[0]!.status, 'SUCCESS');
});

test('a resposta SEGURADA volta: o turno retomado recebe o que ficou sem sair', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-foto', 'foto', -5));
  w.seguradas = [{ reply: 'Só preciso do telefone dele com DDD pra finalizar o cadastro', mensagemId: 'msg-ai-1' }];
  await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.deepEqual(w.restauradas, w.seguradas);
  assert.equal(w.saidas.length, 1);
});

test('nada em dobro: segundo start (ou segunda réplica) não reprocessa o mesmo pedido', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-foto', 'foto', -5));
  await recuperarTurnosPerdidos(deps);
  await dormir(100);
  // o primeiro turno morreu de novo antes de fechar o trace: volta a RUNNING e uma nova varredura acontece
  w.traces[0]!.status = 'RUNNING';
  w.respostasDaIa.length = 0; // e a resposta também não saiu: só a reivindicação impede o 2º reprocessamento
  w.agora += 60_000;
  const r2 = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r2.retomados, 0);
  assert.equal(w.saidas.length, 1, 'uma resposta só, nunca duas');
  assert.equal(r2.descartados['outro_processo_cuida'], 1);
});

test('reivindicação antiga de uma recuperação que morreu: o trace é fechado como falha, sem reprocessar', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-foto', 'foto', -5));
  w.reivindicados.add('t-foto');
  w.agora = T_BOOT + IDADE_TENTATIVA_MORTA_MS + 60_000;
  const r = await recuperarTurnosPerdidos(deps);
  assert.equal(r.retomados, 0);
  assert.equal(w.traces[0]!.status, 'FAILED');
  assert.equal(w.traces[0]!.iaDecision, `${MARCA_ABANDONADO}:recuperacao_ja_tentada`);
  assert.equal(w.saidas.length, 0);
});

test('IA pausada: não reprocessa, e o trace é fechado dizendo por quê', async () => {
  const { w, deps } = mundo({ pausada: true });
  w.traces.push(lead('t-foto', 'foto', -5));
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.retomados, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.traces[0]!.status, 'SUCCESS');
  assert.equal(w.traces[0]!.iaDecision, `${MARCA_ABANDONADO}:ia_pausada`);
  assert.equal(w.reivindicados.size, 0, 'pausada não gasta a reivindicação');
});

test('conversa já respondida depois do pedido: não reprocessa', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-foto', 'foto', -5));
  w.respostasDaIa.push({ unitId: 'u1', leadId: '5142896', em: new Date(T_BOOT + 30_000) });
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.retomados, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.traces[0]!.iaDecision, `${MARCA_ABANDONADO}:ja_respondida`);
});

test('cada pedido é julgado sozinho: o respondido sai, o que ficou sem resposta é refeito', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-velho', 'oi', -90), lead('t-novo', 'e a foto?', -5));
  w.respostasDaIa.push({ unitId: 'u1', leadId: '5142896', em: new Date(T_BOOT - 60_000) }); // respondeu só o primeiro
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.retomados, 1);
  assert.deepEqual(w.saidas.map((s) => s.texto), ['e a foto?']);
  assert.equal(w.traces.find((t) => t.id === 't-velho')!.iaDecision, `${MARCA_ABANDONADO}:ja_respondida`);
});

test('dois pedidos perdidos do mesmo paciente viram UM turno e UMA resposta', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-audio', 'áudio', -20), lead('t-foto', 'foto', -5));
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(150);
  assert.equal(r.retomados, 2);
  assert.equal(w.saidas.length, 1);
  assert.equal(w.saidas[0]!.texto, 'áudio\n\nfoto');
  assert.deepEqual(w.saidas[0]!.traceIds, ['t-audio', 't-foto']);
});

test('pacientes diferentes não se misturam', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('a', 'oi', -20), lead('b', 'olá', -15, { leadId: '999' }));
  await recuperarTurnosPerdidos(deps);
  await dormir(150);
  assert.equal(w.saidas.length, 2);
});

test('janela: trace novo demais e trace velho demais ficam de fora', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('velho', 'oi', -(IDADE_MAXIMA_MS / 1000) - 600)); // mais de 2 h
  w.traces.push(lead('muito-novo', 'oi', +100, { leadId: '1' })); // 20 s antes da varredura: o antigo pode estar terminando
  const r = await recuperarTurnosPerdidos(deps);
  assert.equal(r.candidatos, 0);
  assert.equal(w.consultas[0]!.criadosAntes.getTime(), w.agora - IDADE_MINIMA_MS);
  assert.equal(w.consultas[0]!.criadosDepois.getTime(), w.agora - IDADE_MAXIMA_MS);
});

// Revisão: o container antigo segue recebendo webhook entre o boot do novo e o SIGTERM dele. O que ele recebeu nos
// últimos segundos e não conseguiu terminar é criado DEPOIS do boot do novo — e tem de ser recuperado.
test('trace criado depois do boot do processo novo (últimos segundos do antigo) também é recuperado', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('do-antigo', 'última mensagem', +10)); // 10 s depois do boot do novo
  w.agora = T_BOOT + 300_000; // varredura 5 min depois do boot (o trace já tem mais de 2 min)
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.retomados, 1);
  assert.equal(w.saidas.length, 1);
});

test('o que ESTE processo tem na fila ou rodando nunca é tomado como perdido', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('em-voo', 'oi', -300));
  w.emVoo.add('em-voo');
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.candidatos, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.reivindicados.size, 0);
  assert.equal(w.traces[0]!.status, 'RUNNING');
  assert.deepEqual(w.consultas[0]!.excluirIds, ['em-voo'], 'os em voo saem na consulta, antes do limite');
});

test('os em voo não ocupam as vagas do limite: perdidos de verdade ainda são achados', async () => {
  const { w, deps } = mundo();
  // 60 traces em voo (mais antigos) e 1 perdido mais novo: com o limite de 50 aplicado antes do filtro o perdido nunca apareceria
  for (let i = 0; i < 60; i++) {
    w.traces.push(lead(`voo-${i}`, 'oi', -600 + i, { leadId: String(1000 + i) }));
    w.emVoo.add(`voo-${i}`);
  }
  w.traces.push(lead('perdido', 'foto', -5));
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.retomados, 1);
  assert.equal(w.saidas.length, 1);
});

test('só o líder do worker_leases varre: o container antigo ainda vivo não tem o trace tomado como perdido', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-foto', 'foto', -5));
  assert.equal(await varrerSeLider(deps, () => false), null);
  await dormir(100);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.consultas.length, 0, 'nem consultou o banco');
  const r = await varrerSeLider(deps, () => true);
  await dormir(100);
  assert.equal(r!.retomados, 1);
  assert.equal(w.saidas.length, 1);
});

test('a resposta segurada só é restaurada se houve turno a caminho (retomada descartada não deixa lixo na memória)', async () => {
  const { w, deps } = mundo({ retomada: () => 'descartado:encerramento_repetido' });
  w.traces.push(lead('t-1', '🙏', -5));
  w.seguradas = [{ reply: 'resposta velha', mensagemId: 'm1' }];
  await recuperarTurnosPerdidos(deps);
  assert.deepEqual(w.restauradas, []);
});

test('mensagem recuperada entra NA ORDEM, antes da mensagem nova, e não troca o run do webhook ao vivo', async () => {
  const runs: Array<{ combinado: string; quem: string }> = [];
  const ao_vivo = async (c: string) => { runs.push({ combinado: c, quem: 'ao-vivo' }); };
  const recuperacao = async (c: string) => { runs.push({ combinado: c, quem: 'recuperacao' }); };
  scheduleAgentRun({ unitSlug: 'ord', leadId: 1, traceId: 'novo', humanMessage: 'mensagem nova', audioUrl: null, imageUrl: null, run: ao_vivo });
  const st = scheduleAgentRun({
    unitSlug: 'ord', leadId: 1, traceId: 'velho', humanMessage: 'mensagem velha', audioUrl: null, imageUrl: null,
    run: recuperacao, retomada: { chegouEm: Date.now() - 120_000 },
  });
  assert.equal(st, 'joined');
  await dormir(150);
  assert.deepEqual(runs, [{ combinado: 'mensagem velha\n\nmensagem nova', quem: 'ao-vivo' }]);
});

test('retomar que descarta (ex.: era resposta ao lembrete): trace fechado com o motivo, sem resposta', async () => {
  const { w, deps } = mundo({ retomada: () => 'descartado:resposta_a_lembrete' });
  w.traces.push(lead('t-1', '1', -5));
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(100);
  assert.equal(r.retomados, 0);
  assert.equal(w.saidas.length, 0);
  assert.equal(w.traces[0]!.iaDecision, `${MARCA_ABANDONADO}:resposta_a_lembrete`);
});

test('um paciente que dá erro não impede os outros', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('ruim', 'oi', -20), lead('bom', 'olá', -15, { leadId: '999' }));
  const original = deps.respondidoDepois;
  deps.respondidoDepois = async (t) => {
    if (t.leadId === '5142896') throw new Error('banco caiu');
    return original(t);
  };
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(150);
  assert.equal(r.retomados, 1);
  assert.equal(w.saidas.length, 1);
  assert.equal(w.saidas[0]!.leadId, '999');
});

test('retomar que lança: trace fechado como falha e os demais seguem', async () => {
  const { w, deps } = mundo();
  w.traces.push(lead('t-1', 'oi', -20), lead('t-2', 'olá', -15, { leadId: '999' }));
  const original = deps.retomar;
  deps.retomar = async (t) => {
    if (t.traceId === 't-1') throw new Error('kommo fora');
    return original(t);
  };
  const r = await recuperarTurnosPerdidos(deps);
  await dormir(150);
  assert.equal(r.retomados, 1);
  assert.equal(w.traces.find((t) => t.id === 't-1')!.status, 'FAILED');
  assert.equal(w.saidas.length, 1);
});
