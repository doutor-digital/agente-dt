/**
 * O porteiro de produção (`porteiroPrisma`) contra um Postgres DE VERDADE: duas conexões (duas "instâncias" do servidor) disputando o teto do dia pela
 * trava `pg_advisory_xact_lock`. Só roda com `TESTE_POSTGRES_URL` apontando para um banco DESCARTÁVEL (ele cria a tabela `mcp_auditoria` se não existir e
 * apaga as linhas do teste), por exemplo:
 *   docker run -d --rm -p 55999:5432 -e POSTGRES_PASSWORD=t postgres:16
 *   TESTE_POSTGRES_URL=postgresql://postgres:t@127.0.0.1:55999/postgres pnpm exec tsx --test src/mcp-remoto/asaas-porteiro-postgres.test.ts
 * Sem a variável o teste é pulado (a suíte normal não tem banco).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { asaasFalso, AGORA, type Opc } from './asaas-falso.js';
import { criarContextoAsaas } from './asaas.js';
import { criarEscritaAsaas } from './asaas-escrita.js';
import { lerDestinos } from './asaas-limites.js';
import { transferir } from './asaas-operacoes.js';
import { lancamentosRecentesDe, porteiroPrisma } from './auditoria.js';

const URL = process.env.TESTE_POSTGRES_URL;
const Q = { id: 'u-teste', email: 'j@x.com' };
const DESTINOS = JSON.stringify({ 'doutor-hernia-serra': [{ nome: 'F', apelido: 'f', chave_pix: '11222333000181', tipo_chave: 'CNPJ' }] });

function instancia(prisma: PrismaClient, o: Opc = {}) {
  const f = asaasFalso({ saldo: 1e9, chaveGrupo: 'grupo-pg-teste', ...o });
  const asaas = criarContextoAsaas(new Map([[f.conta.slug, f.conta]]));
  const esc = criarEscritaAsaas({
    agora: () => Date.now(),
    unidades: () => new Set(['doutor-hernia-serra']),
    destinos: (slug) => lerDestinos(slug, { ASAAS_TRANSFERENCIA_DESTINOS: DESTINOS }),
    tetoOperacao: () => 5000,
    tetoDia: () => 20000,
    tetoEspecifico: () => ({ operacao: Infinity, dia: Infinity }),
    porteiro: porteiroPrisma(prisma as never),
    alertar: async () => true,
  });
  return { f, ctx: { asaas, esc } };
}

test('Postgres de verdade: duas instâncias disputando o teto do dia (advisory lock) — nunca passa de R$ 20.000, e a duplicata vale entre elas', { skip: !URL }, async () => {
  const A = new PrismaClient({ datasourceUrl: URL });
  const B = new PrismaClient({ datasourceUrl: URL });
  try {
    await A.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS mcp_auditoria (id text PRIMARY KEY, user_id text NOT NULL, client_id text NOT NULL, ferramenta text NOT NULL, argumentos jsonb NOT NULL, ok boolean NOT NULL, duracao_ms integer NOT NULL, erro text, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    );
    await A.$executeRawUnsafe(`DELETE FROM mcp_auditoria WHERE user_id = 'u-teste'`);
    const ia = instancia(A);
    const ib = instancia(B);
    // 12 transferências de valores diferentes (R$ 4.000 a R$ 4.011), metade em cada instância, todas ao mesmo tempo
    const pedidos = Array.from({ length: 12 }, (_, i) => {
      const x = i % 2 ? ib : ia;
      return transferir(x.ctx, Q, { unidade: 'serra', destino: 'f', valor: 4000 + i }, () => true);
    });
    const r = await Promise.allSettled(pedidos);
    const enviado = [...ia.f.posts(), ...ib.f.posts()].reduce((s, p) => s + (p.corpo!.value as number), 0);
    assert.ok(enviado <= 20000, `o Asaas recebeu R$ ${enviado}`);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, ia.f.posts().length + ib.f.posts().length);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 4, 'com R$ 4.000+ por operação cabem exatamente 4 em R$ 20.000');
    for (const x of r) if (x.status === 'rejected') assert.match(String(x.reason), /teto do dia/);
    // o que ficou no banco: só as intenções (o `registrar` do teste não grava resultado), todas contadas, e a soma lida de volta bate
    const lidas = await lancamentosRecentesDe(A, 'doutor-hernia-serra', Date.now(), 'grupo-pg-teste');
    assert.equal(lidas.length, 4);
    assert.ok(lidas.reduce((s, l) => s + l.noTeto, 0) <= 20000);
    const linhas = await A.mcpAuditoria.findMany({ where: { userId: 'u-teste' } });
    assert.ok(linhas.every((l) => (l.argumentos as { fase?: string }).fase === 'intencao' && l.ok === true));

    // duplicata entre as instâncias, simultâneas: só uma sai
    await A.$executeRawUnsafe(`DELETE FROM mcp_auditoria WHERE user_id = 'u-teste'`);
    const c = instancia(A);
    const d = instancia(B);
    const dup = await Promise.allSettled([transferir(c.ctx, Q, { unidade: 'serra', destino: 'f', valor: 77 }, () => true), transferir(d.ctx, Q, { unidade: 'serra', destino: 'f', valor: 77 }, () => true)]);
    assert.deepEqual(dup.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(c.f.posts().length + d.f.posts().length, 1);
    assert.equal(AGORA > 0, true);
  } finally {
    await A.$executeRawUnsafe(`DELETE FROM mcp_auditoria WHERE user_id = 'u-teste'`).catch(() => undefined);
    await A.$disconnect();
    await B.$disconnect();
  }
});

test('Postgres de verdade: o banco fora do ar faz a reserva falhar FECHADO (nada é enviado ao Asaas)', { skip: !URL }, async () => {
  const quebrado = new PrismaClient({ datasourceUrl: 'postgresql://postgres:x@127.0.0.1:1/nada?connect_timeout=2' });
  try {
    const i = instancia(quebrado);
    await assert.rejects(() => transferir(i.ctx, Q, { unidade: 'serra', destino: 'f', valor: 10 }, () => true), /não consegui conferir nem registrar a operação no banco/);
    assert.equal(i.f.posts().length, 0);
  } finally {
    await quebrado.$disconnect();
  }
});
