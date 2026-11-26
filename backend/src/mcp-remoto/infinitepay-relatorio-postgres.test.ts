/**
 * O armazém de relatórios (`armazemDeRelatoriosPrisma`) contra um Postgres DE VERDADE, com as migrations reais aplicadas: importação, arquivo repetido,
 * arquivos que se sobrepõem e duas importações do MESMO arquivo ao mesmo tempo. Só roda com `TESTE_POSTGRES_URL` apontando para um banco DESCARTÁVEL
 * (ele recria as tabelas `infinitepay_*`):
 *   docker run -d --rm -p 55999:5432 -e POSTGRES_PASSWORD=t postgres:16
 *   TESTE_POSTGRES_URL=postgresql://postgres:t@127.0.0.1:55999/postgres pnpm exec tsx --test src/mcp-remoto/infinitepay-relatorio-postgres.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { criarContextoInfinitepay, type ContaInfinitepay } from './infinitepay.js';
import { importarRelatorio } from './infinitepay-relatorio.js';
import { armazemDeRelatoriosPrisma } from './infinitepay-relatorio-armazem.js';
import { infinitepayExtrato } from './infinitepay-relatorio-ferramentas.js';

const BANCO = process.env.TESTE_POSTGRES_URL;
const UNI = 'doutor-hernia-acailandia';
const SEGREDO_PG = 'segredo-do-teste-no-postgres-0123456789';

const OFX = (extra = '', fim = '20261115') => `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0001<ACCTID>987654321</BANKACCTFROM><BANKTRANLIST><DTSTART>20261101<DTEND>${fim}
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261103<TRNAMT>1500.50<FITID>A1<MEMO>Venda
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261110<TRNAMT>-350.25<FITID>A3<MEMO>Transferencia
</STMTTRN>
${extra}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;

function aplicar(sql: string): string[] {
  return sql.split(/;\s*\n/).map((c) => c.replace(/^(--.*\n)+/gm, '').trim()).filter(Boolean);
}

test('Postgres de verdade: migrations aplicam; importa, não duplica arquivo nem linha; dois envios do mesmo arquivo ao mesmo tempo gravam um só', { skip: !BANCO }, async () => {
  const db = new PrismaClient({ datasourceUrl: BANCO });
  const db2 = new PrismaClient({ datasourceUrl: BANCO });
  try {
    for (const t of ['infinitepay_vendas', 'infinitepay_movimentos', 'infinitepay_importacoes']) await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    for (const m of ['20261126130000_infinitepay_relatorios', '20261126150000_infinitepay_importacoes_conta']) {
      const sql = readFileSync(path.resolve(process.cwd(), `prisma/migrations/${m}/migration.sql`), 'utf8');
      for (const c of aplicar(sql)) await db.$executeRawUnsafe(c);
    }

    const arm = armazemDeRelatoriosPrisma(db as never);
    const arm2 = armazemDeRelatoriosPrisma(db2 as never);
    const a = { unidade: UNI, relatorio: 'extrato' as const, tipoDoCofre: 'ofx' as const, importadoPor: 'j@x.com', segredoDaConta: SEGREDO_PG };

    const r1 = await importarRelatorio(arm, { ...a, conteudo: Buffer.from(OFX()) });
    assert.ok(r1.importado);
    if (!r1.importado) return;
    assert.equal(r1.importacao.linhasNovas, 2);
    assert.equal((await importarRelatorio(arm, { ...a, conteudo: Buffer.from(OFX()) })).importado, false, 'o mesmo arquivo não entra de novo');

    // arquivo que se sobrepõe: o FITID repetido não duplica, só a linha nova entra
    const novo = '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261118<TRNAMT>50.00<FITID>A9<MEMO>novo\n</STMTTRN>\n';
    const r2 = await importarRelatorio(arm, { ...a, conteudo: Buffer.from(OFX(novo, '20261120')) });
    assert.ok(r2.importado);
    if (!r2.importado) return;
    assert.equal(r2.importacao.linhasNovas, 1);
    assert.equal(r2.importacao.linhasRepetidas, 2);
    assert.equal(await db.infinitepayMovimento.count({ where: { unitSlug: UNI } }), 3);

    // duas "instâncias" importando o MESMO arquivo ao mesmo tempo: a unicidade do banco deixa uma
    const igual = Buffer.from(OFX('<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261119<TRNAMT>7.00<FITID>Z1<MEMO>z\n</STMTTRN>\n', '20261121'));
    const par = await Promise.allSettled([importarRelatorio(arm, { ...a, conteudo: igual }), importarRelatorio(arm2, { ...a, conteudo: igual })]);
    const importou = par.filter((x) => x.status === 'fulfilled' && x.value.importado).length;
    assert.equal(importou, 1, 'só uma das duas importa');
    assert.equal(await db.infinitepayImportacao.count({ where: { unitSlug: UNI } }), 3);
    assert.equal(await db.infinitepayMovimento.count({ where: { unitSlug: UNI } }), 4, 'a linha Z1 entrou uma vez');

    // o mesmo arquivo em OUTRA unidade é recusado (índice por sha256) e o extrato de OUTRA conta também; a conta fica gravada só como hash + final
    const outraUnidade = await importarRelatorio(arm, { ...a, unidade: 'doutor-hernia-serra', conteudo: Buffer.from(OFX()) });
    assert.equal(!outraUnidade.importado && outraUnidade.motivo, 'arquivo_de_outra_unidade');
    assert.equal(await db.infinitepayImportacao.count({ where: { unitSlug: 'doutor-hernia-serra' } }), 0);
    const outraConta = await importarRelatorio(arm, { ...a, conteudo: Buffer.from(OFX('', '20261125').replace('<ACCTID>987654321', '<ACCTID>111122223').replace('<FITID>A1', '<FITID>Q1')) });
    assert.equal(!outraConta.importado && outraConta.motivo, 'outra_conta');
    const gravada = await db.infinitepayImportacao.findFirst({ where: { unitSlug: UNI }, orderBy: { createdAt: 'asc' } });
    assert.equal(gravada?.contaFinal, '4321');
    assert.match(gravada?.contaHash ?? '', /^[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(gravada).includes('987654321'), false, 'o número da conta nunca é gravado');

    // DUAS importações da mesma conta em unidades diferentes AO MESMO TEMPO (bytes diferentes): a trava por conta deixa passar só uma
    const contas2 = Array.from({ length: 12 }, () => new PrismaClient({ datasourceUrl: BANCO }));
    try {
      const corrida = await Promise.allSettled(
        contas2.map((cli, i) =>
          importarRelatorio(armazemDeRelatoriosPrisma(cli as never), {
            ...a, unidade: `unidade-corrida-${i}`, conteudo: Buffer.from(OFX('', `2026121${i % 10}`).replace('<ACCTID>987654321', '<ACCTID>424242424')),
          }),
        ),
      );
      const gravadas = await db.infinitepayImportacao.count({ where: { unitSlug: { startsWith: 'unidade-corrida-' } } });
      assert.equal(gravadas, 1, `a mesma conta entrou em ${gravadas} unidades ao mesmo tempo`);
      assert.equal(corrida.filter((x) => x.status === 'fulfilled' && x.value.importado).length, 1);
    } finally {
      await Promise.all(contas2.map((c2) => c2.$disconnect()));
    }

    // a MESMA conta em OUTRA unidade, com bytes diferentes (novo export do período): recusada pelo hash da conta
    const mesmaConta = await importarRelatorio(arm, { ...a, unidade: 'doutor-hernia-serra', segredoDaConta: 'outro-segredo-do-teste-no-postgres-01234', conteudo: Buffer.from(OFX('', '20261116')) });
    assert.notEqual(!mesmaConta.importado && mesmaConta.motivo, 'conta_de_outra_unidade', 'com OUTRO segredo o hash é outro: a conta é desconhecida (isso mostra que o segredo entra no hash)');
    const dono = await importarRelatorio(arm, { ...a, unidade: 'doutor-hernia-serra', conteudo: Buffer.from(OFX('', '20261117')) });
    assert.equal(!dono.importado && dono.motivo, 'conta_de_outra_unidade');
    assert.equal(await db.infinitepayImportacao.count({ where: { unitSlug: 'doutor-hernia-serra' } }), mesmaConta.importado ? 1 : 0);

    // a leitura do conector contra o banco: datas como dia (sem deslocar de fuso), valores e cobertura
    const conta: ContaInfinitepay = { slug: UNI, nome: 'Açailândia', chaveFinal: '…x', temHandle: false, fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined } };
    const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), { async listar() { return []; }, async porOrderNsu() { return null; } });
    const e = await infinitepayExtrato(ctx, arm, { inicio: '2026-11-01', fim: '2026-11-30' });
    assert.equal(e.resumo.lancamentos, 4);
    assert.equal(e.resumo.entradas, 1557.5);
    assert.equal(e.resumo.saidas, -350.25);
    assert.equal(e.itens.find((i) => i.valor === 1500.5)?.data, '2026-11-03', 'o dia não anda por causa do fuso');
    assert.deepEqual(e.cobertura.periodosImportados, [{ de: '2026-11-01', ate: '2026-11-21' }]);
    assert.deepEqual(e.cobertura.lacunas, [{ de: '2026-11-22', ate: '2026-11-30' }]);
  } finally {
    for (const t of ['infinitepay_vendas', 'infinitepay_movimentos', 'infinitepay_importacoes']) await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}" CASCADE`).catch(() => undefined);
    await db.$disconnect();
    await db2.$disconnect();
  }
});
