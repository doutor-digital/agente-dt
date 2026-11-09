import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_NOTA, lerItemDeConhecimento, limparNota, reabrirPeloPainel, resolverDemanda, type DepsPainel, type StatusDemanda } from './suporte-painel.js';
import { TEXTOS, type Passo } from './suporte-menu-maquina.js';

const AGORA = new Date('2026-11-09T15:00:00Z');
const JID = '556391021043@s.whatsapp.net';

function mundo(o: { status?: StatusDemanda; passo?: Passo; protocoloDaConversa?: number | null; menuLigado?: boolean; corrida?: boolean; semConversa?: boolean; envioFalha?: boolean } = {}) {
  const ev = { whatsapp: [] as string[], telegram: [] as string[], resolvida: [] as unknown[], conversaMudou: 0, reabertas: [] as number[] };
  const deps: DepsPainel = {
    agora: () => AGORA,
    demanda: async (p) => (p === 404 ? null : { protocolo: p, jid: JID, status: o.status ?? 'aberta' }),
    conversa: async () => (o.semConversa ? null : { passo: o.passo ?? 'aberta', protocolo: o.protocoloDaConversa === undefined ? 5 : o.protocoloDaConversa, versao: 3 }),
    marcarResolvida: async (_p, d) => {
      ev.resolvida.push(d);
    },
    conversaParaResolvida: async () => {
      ev.conversaMudou++;
      return !o.corrida;
    },
    menuLigado: () => o.menuLigado ?? true,
    enviarWhatsApp: async (_j, t) => {
      ev.whatsapp.push(t);
      return !o.envioFalha;
    },
    telegram: async (t) => {
      ev.telegram.push(t);
      return true;
    },
    reabrir: async (p) => {
      ev.reabertas.push(p);
    },
  };
  return { deps, ev };
}

test('resolver: marca, passa a conversa a "resolvida", pergunta "funcionou?" no WhatsApp e avisa no Telegram', async () => {
  const { deps, ev } = mundo();
  const r = await resolverDemanda(5, 'joao@dd', '  Liguei o robô de novo.  ', deps);
  assert.deepEqual(r, { ok: true, perguntou: true, whatsapp: true });
  assert.deepEqual(ev.resolvida, [{ quem: 'joao@dd', nota: 'Liguei o robô de novo.', quando: AGORA }]);
  assert.equal(ev.conversaMudou, 1);
  assert.deepEqual(ev.whatsapp, [TEXTOS.resolvida(5, 'Liguei o robô de novo.')]);
  assert.match(ev.telegram[0]!, /✅ Demanda #5 resolvida por joao@dd — "Liguei o robô de novo\."\. A pessoa foi avisada para testar\./);
});

test('resolver: pessoa já noutra conversa do menu (ou noutra demanda) → avisa SEM a pergunta 1/2 e não mexe na conversa', async () => {
  for (const o of [{ passo: 'categoria' as Passo }, { protocoloDaConversa: 6 }, { semConversa: true }]) {
    const { deps, ev } = mundo(o);
    const r = await resolverDemanda(5, 'x', null, deps);
    assert.deepEqual(r, { ok: true, perguntou: false, whatsapp: true });
    assert.equal(ev.conversaMudou, 0);
    assert.equal(ev.whatsapp[0], 'Sua demanda 5 foi resolvida. ✅');
  }
});

test('resolver: a conversa andou no meio (trava otimista) → avisa sem a pergunta', async () => {
  const { deps, ev } = mundo({ corrida: true });
  const r = await resolverDemanda(5, 'x', null, deps);
  assert.equal(r.ok && r.perguntou, false);
  assert.equal(ev.whatsapp[0], 'Sua demanda 5 foi resolvida. ✅');
});

test('resolver: menu fora de "ligado" → não manda WhatsApp, e o Telegram diz que a pessoa NÃO foi avisada', async () => {
  const { deps, ev } = mundo({ menuLigado: false });
  const r = await resolverDemanda(5, 'x', null, deps);
  assert.deepEqual(r, { ok: true, perguntou: true, whatsapp: false });
  assert.equal(ev.whatsapp.length, 0);
  assert.match(ev.telegram[0]!, /NÃO foi avisada/);
});

test('resolver: 404 sem demanda; 409 se já resolvida (nada é enviado)', async () => {
  const a = mundo();
  assert.deepEqual(await resolverDemanda(404, 'x', null, a.deps), { ok: false, status: 404, erro: 'demanda não encontrada' });
  const b = mundo({ status: 'resolvida' });
  assert.deepEqual(await resolverDemanda(5, 'x', null, b.deps), { ok: false, status: 409, erro: 'a demanda já está resolvida' });
  assert.equal(a.ev.whatsapp.length + b.ev.whatsapp.length + a.ev.telegram.length + b.ev.telegram.length, 0);
});

test('reabrir pelo painel: só resolvida; avisa no Telegram', async () => {
  const a = mundo({ status: 'resolvida' });
  assert.deepEqual(await reabrirPeloPainel(5, 'suzanne', a.deps), { ok: true });
  assert.deepEqual(a.ev.reabertas, [5]);
  assert.match(a.ev.telegram[0]!, /reaberta no painel por suzanne/);
  const b = mundo({ status: 'aberta' });
  assert.equal((await reabrirPeloPainel(5, 'x', b.deps)).status, 409);
  assert.equal((await reabrirPeloPainel(404, 'x', b.deps)).status, 404);
});

test('nota: só texto, sem caracteres de controle, cortada; vazia = sem nota', () => {
  assert.equal(limparNota('  ok\u0000\u0007 '), 'ok');
  assert.equal(limparNota('x'.repeat(MAX_NOTA + 50))!.length, MAX_NOTA);
  assert.equal(limparNota('   '), null);
  assert.equal(limparNota(42), null);
});

test('item da base: título e texto obrigatórios ao criar; parcial ao editar; ativo só booleano', () => {
  assert.deepEqual(lerItemDeConhecimento({ titulo: ' T ', texto: ' corpo ' }), { ok: true, dados: { titulo: 'T', texto: 'corpo' } });
  assert.equal(lerItemDeConhecimento({ titulo: 'T' }).ok, false);
  assert.equal(lerItemDeConhecimento({ titulo: '', texto: 'x' }).ok, false);
  assert.deepEqual(lerItemDeConhecimento({ ativo: false }, true), { ok: true, dados: { ativo: false } });
  assert.equal(lerItemDeConhecimento({ ativo: 'sim' }, true).ok, false);
  assert.equal(lerItemDeConhecimento(null).ok, false);
  const longo = lerItemDeConhecimento({ titulo: 't'.repeat(300), texto: 'x'.repeat(3000) });
  assert.ok(longo.ok && longo.dados.titulo!.length === 120 && longo.dados.texto!.length === 2000);
});
