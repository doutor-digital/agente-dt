/**
 * Ponta a ponta do que o sênior achou no PR #171: a máscara que roda em TODA gravação da auditoria não pode estragar o evento
 * que o próprio código relê para bloquear boleto duplicado depois de um reinício.
 *
 *   registrar a cobrança (escrita do Asaas) → auditar (o gravador REAL do servidor) → armazém (banco falso)
 *   → cobrancasRecentesDe (o leitor REAL da produção) → segunda instância (reinício) → duplicata bloqueada
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mascararTexto } from '../lib/integracoes/mascaras.js';
import { impressaoDaChave } from '../lib/integracoes/cofre.js';
import { criarContextoAsaas, type ContaAsaas } from './asaas.js';
import { argumentosDaAuditoria, cobrancasRecentesDe, criarAuditor, EVENTOS_INTERNOS, type LeitorDeAuditoria } from './auditoria.js';
import {
  chaveDeDuplicata,
  confirmarCobranca,
  criarEscritaAsaas,
  EVENTO_CLIENTE,
  EVENTO_COBRANCA,
  prepararCobranca,
  type PedidoDeCobranca,
  type RegistroDeCobranca,
} from './asaas-escrita.js';

const CHAVE_A = '$aact_prod_AAAAAAAAAAAAAAAAAAAAAAAAAAAAxYZ1';
const AGORA = Date.parse('2026-10-28T15:00:00-03:00');
const CPF = '529.982.247-25';
const EXISTENTE = { id: 'cus_000005401844', name: 'Maria da Silva', cpfCnpj: '52998224725', notificationDisabled: true };
const COBRANCA: PedidoDeCobranca = { unidade: 'serra', cpfCnpj: CPF, valor: 250, vencimento: '2026-11-10', descricao: 'Consulta de avaliação', externalReference: 'pedido-1' };

class ErroHttp extends Error {
  constructor(msg: string, readonly status: number | null) {
    super(msg);
  }
}

function contaAsaas(opc: { falhaNoPagamento?: Error } = {}) {
  const conta: ContaAsaas = {
    slug: 'doutor-hernia-serra',
    nome: 'Serra',
    fonte: {
      async get<T>(caminho: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
        if (caminho === '/myAccount/commercialInfo') return { companyName: 'Clínica Serra Saúde LTDA' } as T;
        if (caminho === '/customers') return { data: String(query.cpfCnpj) === EXISTENTE.cpfCnpj ? [EXISTENTE] : [] } as T;
        if (/^\/customers\/.+$/.test(caminho)) return EXISTENTE as T;
        if (caminho === '/payments') return { data: [] } as T;
        if (/^\/payments\/.+\/identificationField$/.test(caminho)) return { identificationField: '34191.79001 01043.510047 91020.150008 5 87650026000' } as T;
        throw new Error(`rota não simulada: ${caminho}`);
      },
    },
    escrita: {
      chaveFinal: '…xYZ1',
      chaveImpressao: impressaoDaChave(CHAVE_A),
      contaSalva: 'Serra (nome salvo)',
      async post<T>(_caminho: string, corpo: Record<string, unknown>): Promise<T> {
        if (opc.falhaNoPagamento) throw opc.falhaNoPagamento;
        return { id: 'pay_080225913252', status: 'PENDING', ...corpo, bankSlipUrl: 'https://www.asaas.com/b/pdf/abc', invoiceUrl: 'https://www.asaas.com/i/abc' } as T;
      },
    },
  };
  return conta;
}

/** O banco: guarda o que o gravador mandou (como JSON, que é o que o Postgres devolve) e responde ao `findMany` do leitor. */
function bancoFalso() {
  const linhas: Array<{ ferramenta: string; argumentos: unknown; ok: boolean; erro?: string; createdAt: Date }> = [];
  const armazem = {
    async auditar(r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) {
      linhas.push({ ferramenta: r.ferramenta, argumentos: JSON.parse(JSON.stringify(r.argumentos ?? {})), ok: r.ok, erro: r.erro, createdAt: new Date(AGORA) });
    },
  };
  const db: LeitorDeAuditoria = {
    mcpAuditoria: {
      async findMany({ where }) {
        const [campo] = where.argumentos.path;
        return linhas
          .filter((l) => l.ferramenta === where.ferramenta && l.createdAt >= where.createdAt.gte && (l.argumentos as Record<string, unknown>)[campo!] === where.argumentos.equals)
          .map((l) => ({ createdAt: l.createdAt, ok: l.ok, argumentos: l.argumentos }));
      },
    },
  };
  return { linhas, armazem, db };
}

/** Uma subida do servidor: contexto do Asaas, escrita com o histórico lido do banco falso e o gravador real da auditoria. */
function subida(banco: ReturnType<typeof bancoFalso>, opc: { falhaNoPagamento?: Error } = {}) {
  const conta = contaAsaas(opc);
  const asaas = criarContextoAsaas(new Map([[conta.slug, conta]]));
  const esc = criarEscritaAsaas({ agora: () => AGORA, unidades: () => new Set(['doutor-hernia-serra']), historico: (c) => cobrancasRecentesDe(banco.db, c, AGORA) });
  const auditar = criarAuditor(banco.armazem, { userId: 'cmvr6c1f00012345678ab', clientId: 'claude' });
  const registrar = (evento: string, args: Record<string, unknown>, ok: boolean, erro?: string) => auditar({ ferramenta: evento, argumentos: args, ok, ms: 0, ...(erro ? { erro } : {}) });
  return { ctx: { asaas, esc }, registrar };
}

const esperarGravacao = () => new Promise<void>((r) => setImmediate(r));

/** Chaves de duplicata (as do sênior: hash de 32 hex) em que a máscara de texto mexe, ou seja, com 10–11 dígitos seguidos. */
function pedidosComChaveQueAMascaraEstragaria(quantos: number): Array<{ pedido: PedidoDeCobranca; chave: string }> {
  const achados: Array<{ pedido: PedidoDeCobranca; chave: string }> = [];
  for (let i = 0; i < 2000 && achados.length < quantos; i++) {
    const pedido = { ...COBRANCA, descricao: `Consulta de avaliação ${i}` };
    const chave = chaveDeDuplicata('doutor-hernia-serra', EXISTENTE.id, 250, '2026-11-10', pedido.descricao, pedido.externalReference);
    if (mascararTexto(chave, 'celula') !== chave) achados.push({ pedido, chave });
  }
  return achados;
}

test('reinício: o boleto gerado antes é achado na auditoria e o mesmo pedido é BLOQUEADO, mesmo com 10–11 dígitos seguidos na chave', async () => {
  const casos = pedidosComChaveQueAMascaraEstragaria(8);
  assert.equal(casos.length, 8, 'a busca precisa achar chaves que a máscara de texto estragaria (senão o teste não prova nada)');
  for (const { pedido, chave } of casos) {
    const banco = bancoFalso();
    const a = subida(banco);
    const p = await prepararCobranca(a.ctx, 'u1', pedido);
    await confirmarCobranca(a.ctx, 'u1', { confirmacao: String(p.confirmacao) }, a.registrar);
    await esperarGravacao();

    const gravada = banco.linhas.find((l) => l.ferramenta === EVENTO_COBRANCA)!;
    assert.equal((gravada.argumentos as { chave: string }).chave, chave, `a chave foi alterada na gravação: ${(gravada.argumentos as { chave: string }).chave}`);
    assert.equal((gravada.argumentos as { cobrancaId: string }).cobrancaId, 'pay_080225913252');
    assert.equal((gravada.argumentos as { clienteId: string }).clienteId, EXISTENTE.id);

    // o leitor da produção enxerga o registro como o código o escreveu
    const lidas = await cobrancasRecentesDe(banco.db, 'doutor-hernia-serra', AGORA);
    assert.deepEqual(lidas.map((r: RegistroDeCobranca) => [r.chave, r.cobrancaId]), [[chave, 'pay_080225913252']]);

    // reinício: outra subida, memória vazia, só o banco
    const b = subida(banco);
    await assert.rejects(prepararCobranca(b.ctx, 'u1', pedido), /cobrança igual.*pay_080225913252.*Não criei outra/s);
  }
});

test('reinício com resposta perdida do Asaas (5xx): o registro "incerto" também sobrevive e bloqueia a segunda tentativa', async () => {
  const [{ pedido, chave }] = pedidosComChaveQueAMascaraEstragaria(1);
  const banco = bancoFalso();
  const a = subida(banco, { falhaNoPagamento: new ErroHttp('Asaas 503', 503) });
  const p = await prepararCobranca(a.ctx, 'u1', pedido!);
  await assert.rejects(confirmarCobranca(a.ctx, 'u1', { confirmacao: String(p.confirmacao) }, a.registrar), /PODE ter sido gerado/);
  await esperarGravacao();
  const gravada = banco.linhas.find((l) => l.ferramenta === EVENTO_COBRANCA)!;
  assert.equal(gravada.ok, false);
  assert.equal((gravada.argumentos as { chave: string; incerto: boolean }).chave, chave);
  assert.equal((gravada.argumentos as { incerto: boolean }).incerto, true);
  const b = subida(banco);
  await assert.rejects(prepararCobranca(b.ctx, 'u1', pedido!), /cobrança igual/);
});

test('o evento interno é gravado sem dado pessoal: documento mascarado, nome abreviado, erro mascarado', async () => {
  const banco = bancoFalso();
  const a = subida(banco);
  const p = await prepararCobranca(a.ctx, 'u1', COBRANCA);
  await confirmarCobranca(a.ctx, 'u1', { confirmacao: String(p.confirmacao) }, a.registrar);
  // um cadastro de cliente que falha: o erro grava, mas mascarado
  a.registrar(EVENTO_CLIENTE, { conta: 'doutor-hernia-serra', documento: '***.***.247-**', nome: 'Maria S.', jaExistia: false }, false, 'Asaas 400: cpf 52998224725 inválido, fone 11987654321');
  await esperarGravacao();
  const texto = JSON.stringify(banco.linhas);
  assert.equal(texto.includes('52998224725'), false, texto);
  assert.equal(texto.includes('529.982.247-25'), false, texto);
  assert.equal(texto.includes('Maria da Silva'), false, texto);
  assert.equal(texto.includes('11987654321'), false, texto);
  const cliente = banco.linhas.find((l) => l.ferramenta === EVENTO_CLIENTE)!;
  assert.equal(cliente.erro, 'Asaas 400: cpf (**) *****-4725 inválido, fone (**) *****-4321');
});

test('evento interno é isento por NOME, não só pelo formato dos campos: chave em formato novo com 11 dígitos sai intacta; em outra ferramenta, mascarada', () => {
  const args = { conta: 'x', chave: 'formato-novo-11987654321-fim' };
  assert.deepEqual(argumentosDaAuditoria(EVENTO_COBRANCA, args), args);
  assert.deepEqual(argumentosDaAuditoria(EVENTO_CLIENTE, args), args);
  assert.deepEqual(argumentosDaAuditoria('outra_ferramenta', args), { conta: 'x', chave: 'formato-novo-[CPF/senha omitido]' });
});

test('leitor: só conta o que está na janela de 1 hora e só da conta pedida', async () => {
  const MIN = 60_000;
  const linha = (conta: string, chave: string, idadeMin: number) => ({ createdAt: new Date(AGORA - idadeMin * MIN), ok: true, argumentos: { conta, chave, cobrancaId: `pay_${chave}` } });
  // o banco devolve tudo (ignora o filtro): quem decide a conta e a janela é o leitor + o `where` que ele manda
  const vistos: Array<{ gte: Date }> = [];
  const db: LeitorDeAuditoria = {
    mcpAuditoria: {
      async findMany({ where }) {
        vistos.push(where.createdAt);
        return [linha('serra', 'a1', 30), linha('outra', 'b2', 30), linha('serra', 'c3', 59)];
      },
    },
  };
  const lidas = await cobrancasRecentesDe(db, 'serra', AGORA);
  assert.deepEqual(lidas.map((r) => r.chave), ['a1', 'c3'], 'linha de outra conta não entra');
  assert.equal(vistos[0]!.gte.getTime(), AGORA - 60 * MIN, 'a janela pedida ao banco é de exatamente 1 hora');
  // `em` vem da data da linha; cobrancaId volta junto
  assert.deepEqual(lidas[0], { conta: 'serra', chave: 'a1', em: AGORA - 30 * MIN, cobrancaId: 'pay_a1' });
});

test('só os eventos que o código relê escapam da máscara; o resto da auditoria (inclusive evo_envio) continua mascarado', () => {
  assert.deepEqual([...EVENTOS_INTERNOS].sort(), [EVENTO_CLIENTE, EVENTO_COBRANCA].sort());
  const chave = chaveDeDuplicata('x', 'cus_1', 1, '2026-11-10', 'a');
  assert.deepEqual(argumentosDaAuditoria(EVENTO_COBRANCA, { chave: '0123456789012345678901234567890a' }), { chave: '0123456789012345678901234567890a' });
  assert.equal(chave.length, 32);
  assert.deepEqual(argumentosDaAuditoria('evo_envio', { para: '5511987654321' }), { para: '(**) *****-4321' });
  assert.deepEqual(argumentosDaAuditoria('asaas_cliente', { busca: '529.982.247-25' }), { busca: '***.***.***-25' });
});
