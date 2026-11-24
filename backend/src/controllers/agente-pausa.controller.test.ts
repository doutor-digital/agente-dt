/**
 * Pausar e religar a Sofia da clínica pelo painel Agente: só administradora/gerente muda (atendente comum não), a unidade é a que a
 * conta e as caixas da pessoa enxergam (conta errada recusa antes de escrever), quem mudou é sempre o login, e pausar exige confirmação.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { fazerPausaDoAgente } = await import('./agente-pausa.controller.js');

const unidade = (o: Partial<Unit> = {}): Unit => ({ id: 'u1', slug: 'timbo', name: 'Doutor Hérnia Timbó', pausaAte: null, pausaDesde: null, pausaMotivo: null, pausaPor: null, pausaCodigo: '123456', spineTimezone: 'America/Sao_Paulo', ...o }) as unknown as Unit;

function montar(o: { papel?: string | null; email?: string | null; gestores?: string; recusaConta?: boolean; unit?: Unit; conflitoNoBanco?: boolean } = {}) {
  const chamadas: Array<{ tipo: string; unitId: string; corpo?: unknown; por: string | null; soSeLivre?: boolean; soSeHouver?: boolean }> = [];
  const unit = o.unit ?? unidade();
  const h = fazerPausaDoAgente({
    atendente: async (_req, res, slug) => {
      if (o.recusaConta || slug !== unit.slug) {
        res.status(403).json({ error: 'você não atende esta unidade' });
        return null;
      }
      return { a: { nome: 'Cleia Gerente', papel: o.papel ?? 'agent', email: o.email ?? null, c: {} as never }, unit };
    },
    gestoresDaConta: () => o.gestores,
    aplicar: async (u, corpo, por, opcoes) => {
      chamadas.push({ tipo: 'pausar', unitId: u.id, corpo, por, soSeLivre: opcoes?.soSeLivre });
      if (o.conflitoNoBanco) return { ok: false as const, erro: 'A Sofia já está pausada (ou com pausa marcada). Religue antes de pausar de novo.', conflito: unidade({ pausaAte: new Date(Date.now() + 3_600_000), pausaPor: 'Outra pessoa' }) };
      const c = corpo as { ate: string; motivo: string | null; por: string };
      return { ok: true as const, unit: { ...u, pausaAte: new Date(c.ate), pausaMotivo: c.motivo, pausaPor: c.por } as Unit };
    },
    retomar: async (u, por, opcoes) => {
      chamadas.push({ tipo: 'religar', unitId: u.id, por, soSeHouver: opcoes?.soSeHouver });
      return { ...u, pausaAte: null, pausaMotivo: null, pausaPor: null } as Unit;
    },
    estado: (u) => ({ unidade: u.name, slug: u.slug, tz: 'America/Sao_Paulo', emPausa: !!u.pausaAte, agendada: false, pausaDesde: u.pausaDesde, pausaAte: u.pausaAte, motivo: u.pausaMotivo, por: u.pausaPor, descricao: 'x', agora: new Date() }) as never,
  });
  return { h, chamadas };
}

function resposta() {
  const r = { codigo: 200, corpo: undefined as unknown, set: () => r, status: (c: number) => { r.codigo = c; return r; }, json: (b: unknown) => { r.corpo = b; return r; } };
  return r;
}
const pedido = (corpo: Record<string, unknown> = {}, query: Record<string, unknown> = {}) => ({ body: corpo, query }) as unknown as Request;
const ate = new Date(Date.now() + 2 * 3_600_000).toISOString();

test('atendente comum VÊ o estado mas não pausa nem religa (403) e nada é escrito', async () => {
  const { h, chamadas } = montar({ papel: 'agent' });
  const ver = resposta();
  await h.ver(pedido({}, { slug: 'timbo' }), ver as unknown as Response);
  assert.equal((ver.corpo as { podeMudar: boolean }).podeMudar, false);
  const p = resposta();
  await h.pausar(pedido({ slug: 'timbo', ate, motivo: 'teste', confirmar: true }), p as unknown as Response);
  assert.equal(p.codigo, 403);
  const r = resposta();
  await h.religar(pedido({ slug: 'timbo' }), r as unknown as Response);
  assert.equal(r.codigo, 403);
  assert.deepEqual(chamadas, [], 'nenhuma escrita na unidade');
});

test('administradora pausa: quem mudou é o login (o «por» da página não vale), o motivo e a hora vão, e o estado volta com podeMudar', async () => {
  const { h, chamadas } = montar({ papel: 'administrator' });
  const r = resposta();
  await h.pausar(pedido({ slug: 'timbo', ate, desde: new Date(Date.now() + 5 * 86_400_000).toISOString(), motivo: 'o doutor atrasou', por: 'OUTRA PESSOA', confirmar: true }), r as unknown as Response);
  assert.equal(r.codigo, 200);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0]!.por, 'Cleia Gerente');
  assert.equal((chamadas[0]!.corpo as { por: string }).por, 'Cleia Gerente');
  assert.equal((chamadas[0]!.corpo as { motivo: string }).motivo, 'o doutor atrasou');
  assert.equal((chamadas[0]!.corpo as { desde: unknown }).desde, null, 'o painel só pausa a partir de agora: o «desde» da página não vale');
  const j = r.corpo as { emPausa: boolean; por: string; podeMudar: boolean; codigo?: string };
  assert.equal(j.emPausa, true);
  assert.equal(j.por, 'Cleia Gerente');
  assert.equal(j.podeMudar, true);
  assert.ok(!('codigo' in j) && !JSON.stringify(j).includes('123456'), 'o código da unidade nunca vai para a tela');
});

test('gerente por e-mail na lista de gestores também pode; e-mail fora da lista não', async () => {
  const ok = montar({ papel: 'agent', email: 'gerente@clinica.com', gestores: 'dono@x.com, gerente@clinica.com', unit: unidade({ pausaAte: new Date(Date.now() + 3_600_000), pausaPor: 'Recepção' }) });
  const r1 = resposta();
  await ok.h.religar(pedido({ slug: 'timbo' }), r1 as unknown as Response);
  assert.equal(r1.codigo, 200);
  assert.deepEqual(ok.chamadas.map((c) => c.tipo), ['religar']);
  const no = montar({ papel: 'agent', email: 'outra@clinica.com', gestores: 'dono@x.com', unit: unidade({ pausaAte: new Date(Date.now() + 3_600_000), pausaPor: 'Recepção' }) });
  const r2 = resposta();
  await no.h.religar(pedido({ slug: 'timbo' }), r2 as unknown as Response);
  assert.equal(r2.codigo, 403);
  assert.deepEqual(no.chamadas, []);
});

test('pausar exige a confirmação (sem ela, 400 e nada escrito)', async () => {
  const { h, chamadas } = montar({ papel: 'administrator' });
  const r = resposta();
  await h.pausar(pedido({ slug: 'timbo', ate, motivo: 'x' }), r as unknown as Response);
  assert.equal(r.codigo, 400);
  assert.deepEqual(chamadas, []);
});

test('conta errada ou unidade que a pessoa não atende: recusa ANTES de ler ou escrever, mesmo sendo administradora', async () => {
  const errada = montar({ papel: 'administrator', recusaConta: true });
  const a = resposta();
  await errada.h.pausar(pedido({ slug: 'timbo', ate, motivo: 'x', confirmar: true }), a as unknown as Response);
  assert.equal(a.codigo, 403);
  const outra = montar({ papel: 'administrator' });
  const b = resposta();
  await outra.h.pausar(pedido({ slug: 'caxias', ate, motivo: 'x', confirmar: true }), b as unknown as Response);
  assert.equal(b.codigo, 403, 'a unidade vem do slug que a conta enxerga, não de um id solto');
  const c = resposta();
  await outra.h.ver(pedido({}, { slug: 'caxias' }), c as unknown as Response);
  assert.equal(c.codigo, 403);
  assert.deepEqual([...errada.chamadas, ...outra.chamadas], []);
});

test('o estado diz o que a pausa PARA nos lembretes (a mesma função do worker): véspera/D-2 do servidor param, o robô da Kommo e o CRM não', async () => {
  const casos: Array<[Partial<Unit>, { vesperaServidor: boolean; vesperaRoboKommo: boolean; d2Servidor: boolean }]> = [
    [{ spineEnabled: true, spineToken: 'tok' } as Partial<Unit>, { vesperaServidor: true, vesperaRoboKommo: false, d2Servidor: false }],
    [{ spineEnabled: false, spineToken: null } as Partial<Unit>, { vesperaServidor: false, vesperaRoboKommo: false, d2Servidor: false }],
  ];
  for (const [spine, esperado] of casos) {
    const { h } = montar({ papel: 'agent', unit: unidade(spine) });
    const r = resposta();
    await h.ver(pedido({}, { slug: 'timbo' }), r as unknown as Response);
    assert.deepEqual((r.corpo as { lembretes: unknown }).lembretes, esperado, JSON.stringify(spine));
  }
});

test('pausar sem motivo é recusado, e não passa por cima de uma pausa que já existe (409)', async () => {
  const a = montar({ papel: 'administrator' });
  const r1 = resposta();
  await a.h.pausar(pedido({ slug: 'timbo', ate, motivo: ' ', confirmar: true }), r1 as unknown as Response);
  assert.equal(r1.codigo, 400);
  const b = montar({ papel: 'administrator', unit: unidade({ pausaAte: new Date(Date.now() + 5 * 3_600_000), pausaPor: 'Recepção' }) });
  const r2 = resposta();
  await b.h.pausar(pedido({ slug: 'timbo', ate, motivo: 'outra', confirmar: true }), r2 as unknown as Response);
  assert.equal(r2.codigo, 409);
  assert.deepEqual([...a.chamadas, ...b.chamadas], [], 'nada foi escrito');
});

test('pausar grava CONDICIONAL (soSeLivre) e, se outra pessoa pausou no meio, devolve 409 com o estado de quem pausou', async () => {
  const { h, chamadas } = montar({ papel: 'administrator', conflitoNoBanco: true });
  const r = resposta();
  await h.pausar(pedido({ slug: 'timbo', ate, motivo: 'a minha', confirmar: true }), r as unknown as Response);
  assert.equal(r.codigo, 409);
  const j = r.corpo as { emPausa: boolean; por: string };
  assert.equal(j.emPausa, true, 'a tela redesenha a faixa com a pausa de quem pausou');
  assert.equal(j.por, 'Outra pessoa');
  assert.equal(chamadas[0]!.soSeLivre, true);
});

test('religar uma Sofia que NÃO está pausada: nada é gravado e ninguém é avisado', async () => {
  const { h, chamadas } = montar({ papel: 'administrator' });
  const r = resposta();
  await h.religar(pedido({ slug: 'timbo' }), r as unknown as Response);
  assert.equal(r.codigo, 200);
  assert.deepEqual(chamadas, [], 'retomar (que grava e avisa o João) nem é chamado');
  assert.equal((r.corpo as { emPausa: boolean }).emPausa, false);
});

test('religar: administradora volta a Sofia e o estado sai sem pausa', async () => {
  const { h, chamadas } = montar({ papel: 'administrator', unit: unidade({ pausaAte: new Date(Date.now() + 3_600_000), pausaPor: 'Fulana' }) });
  const r = resposta();
  await h.religar(pedido({ slug: 'timbo' }), r as unknown as Response);
  assert.equal(r.codigo, 200);
  assert.deepEqual(chamadas, [{ tipo: 'religar', unitId: 'u1', por: 'Cleia Gerente', soSeHouver: true }]);
  assert.equal((r.corpo as { emPausa: boolean }).emPausa, false);
});
