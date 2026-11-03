/**
 * Detalhes da revisão do #194: duplicata por CHAVE do Asaas (não por clínica), consumo do dia só como apresentação, valor da cobrança ilegível.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarContextoAsaas } from './asaas.js';
import { asaasFalso, AGORA, BancoFalso, montar, porteiroEmMemoria, type Pg } from './asaas-falso.js';
import { criarEscritaAsaas } from './asaas-escrita.js';
import { lerDestinos } from './asaas-limites.js';
import { estornarCobranca, transferir } from './asaas-operacoes.js';

const Q = { id: 'u1', email: 'j@x.com' };
const PAGA: Pg = { id: 'pay_paga00000001', customer: 'cus_000005401844', status: 'RECEIVED', value: 800, billingType: 'PIX' };
const DESTINOS = (slugs: string[]) => (slug: string) =>
  lerDestinos(slug, { ASAAS_TRANSFERENCIA_DESTINOS: JSON.stringify(Object.fromEntries(slugs.map((s) => [s, [{ nome: 'F', apelido: 'f', chave_pix: '11222333000181', tipo_chave: 'CNPJ' }]]))) });

test('duplicata por CHAVE do Asaas: a mesma transferência (e o mesmo estorno) feita pela Serra e repetida pela Marabá, com a mesma chave, é barrada', async () => {
  const banco = new BancoFalso();
  const t = { v: AGORA };
  const serra = asaasFalso({ slug: 'doutor-hernia-serra', chaveGrupo: 'chave-X', saldo: 1e9, pagamentos: [{ ...PAGA }] });
  const maraba = asaasFalso({ slug: 'doutor-hernia-maraba', chaveGrupo: 'chave-X', saldo: 1e9, pagamentos: [{ ...PAGA }] });
  const asaas = criarContextoAsaas(new Map([serra, maraba].map((f) => [f.conta.slug, f.conta])));
  const esc = criarEscritaAsaas({
    agora: () => t.v,
    unidades: () => new Set(['doutor-hernia-serra', 'doutor-hernia-maraba']),
    destinos: DESTINOS(['doutor-hernia-serra', 'doutor-hernia-maraba']),
    tetoEspecifico: () => ({ operacao: Infinity, dia: Infinity }),
    porteiro: porteiroEmMemoria(banco, () => t.v),
    alertar: async () => true,
  });
  const registrar = (ev: string, a: Record<string, unknown>, ok: boolean, erro?: string) => banco.gravar({ ferramenta: ev, argumentos: a, ok, erro }, t.v);
  const ctx = { asaas, esc };
  await transferir(ctx, Q, { unidade: 'doutor-hernia-serra', destino: 'f', valor: 300 }, registrar);
  t.v += 120_000;
  await assert.rejects(() => transferir(ctx, Q, { unidade: 'doutor-hernia-maraba', destino: 'f', valor: 300 }, registrar), /transferência igual para f/);
  await estornarCobranca(ctx, Q, { unidade: 'doutor-hernia-serra', cobrancaId: PAGA.id, valor: 100 }, registrar);
  await assert.rejects(() => estornarCobranca(ctx, Q, { unidade: 'doutor-hernia-maraba', cobrancaId: PAGA.id, valor: 100 }, registrar), /estorno igual/);
  assert.equal(maraba.posts().length, 0);
});

test('o consumo do dia na RESPOSTA é só apresentação: se o banco falhar depois da operação feita, a operação NÃO vira erro', async () => {
  const banco = new BancoFalso();
  const base = porteiroEmMemoria(banco, () => AGORA);
  const m = montar({ saldo: 1e9, pagamentos: [{ ...PAGA }] }, { banco, destinos: DESTINOS(['doutor-hernia-serra']) });
  m.esc.porteiro = {
    reservar: base.reservar,
    ler: async () => {
      throw new Error('banco caiu depois');
    },
  };
  const r = (await transferir(m.ctx, Q, { unidade: 'serra', destino: 'f', valor: 100 }, m.registrar)) as any;
  assert.equal(r.transferido, true);
  assert.match(r.limites.indisponivel, /JÁ foi feita/);
  const e = (await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 50 }, m.registrar)) as any;
  assert.equal(e.estornado, true);
  assert.match(e.limites.indisponivel, /JÁ foi feita/);
});

test('cobrança sem valor legível no Asaas: o estorno recusa com a explicação certa (não diz "já estornada")', async () => {
  const m = montar({ pagamentos: [{ ...PAGA, value: undefined as never }] });
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, m.registrar), /não consegui ler o valor da cobrança/);
  assert.equal(m.f.posts().length, 0);
});
