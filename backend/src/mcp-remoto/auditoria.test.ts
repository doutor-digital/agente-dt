/**
 * Ponta a ponta do que o sênior achou no PR #171: a máscara que roda em TODA gravação da auditoria não pode estragar o evento
 * que o próprio código relê para bloquear cobrança duplicada e somar o teto do dia depois de um reinício.
 *
 *   registrar a operação (escrita do Asaas) → auditar (o gravador REAL do servidor) → armazém (banco falso)
 *   → lancamentosRecentesDe (o leitor REAL da produção) → segunda instância (reinício) → duplicata e teto valem
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mascararTexto } from '../lib/integracoes/mascaras.js';
import { criarContextoAsaas } from './asaas.js';
import { AGORA, asaasFalso, BancoFalso, ErroHttp, porteiroEmMemoria, type Opc } from './asaas-falso.js';
import { argumentosDaAuditoria, criarAuditor, EVENTOS_INTERNOS, lancamentosRecentesDe, type LeitorDeAuditoria } from './auditoria.js';
import { chaveDeDuplicata, criarCobranca, criarEscritaAsaas, EVENTO_CLIENTE, EVENTO_COBRANCA, EVENTO_OPERACAO, type PedidoDeCobranca } from './asaas-escrita.js';
import { FALHA_DO_BANCO, lerDestinos } from './asaas-limites.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { estornarCobranca, transferir } from './asaas-operacoes.js';

const CPF = '529.982.247-25';
const EXISTENTE = { id: 'cus_000005401844', name: 'Maria da Silva', cpfCnpj: '52998224725', notificationDisabled: true };
const COBRANCA: PedidoDeCobranca = { unidade: 'serra', cpfCnpj: CPF, valor: 250, vencimento: '2026-11-10', descricao: 'Consulta de avaliação', externalReference: 'pedido-1' };
const Q = { id: 'cmvr6c1f00012345678ab' };
const DESTINOS = JSON.stringify({ 'doutor-hernia-serra': [{ nome: 'Fornecedor', chave_pix: '11222333000181', tipo_chave: 'CNPJ' }] });

/** O banco: guarda o que o gravador mandou (como JSON, que é o que o Postgres devolve) e responde ao `findMany` do leitor. */
function bancoFalso() {
  const banco = new BancoFalso();
  const armazem = {
    async auditar(r: { ferramenta: string; argumentos: unknown; ok: boolean; erro?: string }) {
      banco.gravar(r, AGORA);
    },
  };
  return { banco, linhas: banco.linhas, armazem, db: banco.leitor() };
}

/** Uma subida do servidor: contexto do Asaas, escrita com o porteiro sobre o banco falso (que várias subidas dividem) e o gravador real da auditoria. */
function subida(banco: ReturnType<typeof bancoFalso>, opc: Opc = {}, tetoDia = 20000) {
  const f = asaasFalso({ clientes: [EXISTENTE], ...opc });
  const asaas = criarContextoAsaas(new Map([[f.conta.slug, f.conta]]));
  const esc = criarEscritaAsaas({
    agora: () => AGORA,
    unidades: () => new Set(['doutor-hernia-serra']),
    tetoDia: () => tetoDia,
    destinos: (slug) => lerDestinos(slug, { ASAAS_TRANSFERENCIA_DESTINOS: DESTINOS }),
    alertar: async () => true,
    tetoEspecifico: () => ({ operacao: Infinity, dia: Infinity }),
    porteiro: porteiroEmMemoria(banco.banco, () => AGORA),
  });
  const auditar = criarAuditor(banco.armazem, { userId: Q.id, clientId: 'claude' });
  const registrar = (evento: string, args: Record<string, unknown>, ok: boolean, erro?: string) => auditar({ ferramenta: evento, argumentos: args, ok, ms: 0, ...(erro ? { erro } : {}) });
  return { f, ctx: { asaas, esc }, registrar };
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

test('reinício: a cobrança gerada antes é achada na auditoria e o mesmo pedido é BLOQUEADO, mesmo com 10–11 dígitos seguidos na chave', async () => {
  const casos = pedidosComChaveQueAMascaraEstragaria(8);
  assert.equal(casos.length, 8, 'a busca precisa achar chaves que a máscara de texto estragaria (senão o teste não prova nada)');
  for (const { pedido, chave } of casos) {
    const banco = bancoFalso();
    const a = subida(banco);
    const feita = (await criarCobranca(a.ctx, Q, pedido, a.registrar)) as any;
    await esperarGravacao();

    const gravada = banco.linhas.find((l) => l.ferramenta === EVENTO_COBRANCA && !(l.argumentos as { fase?: string }).fase)!;
    assert.equal((gravada.argumentos as { chave: string }).chave, chave, `a chave foi alterada na gravação: ${(gravada.argumentos as { chave: string }).chave}`);
    assert.equal((gravada.argumentos as { cobrancaId: string }).cobrancaId, feita.cobranca.id);
    assert.equal((gravada.argumentos as { clienteId: string }).clienteId, EXISTENTE.id);

    // o leitor da produção enxerga o registro como o código o escreveu
    const lidas = await lancamentosRecentesDe(banco.db, 'doutor-hernia-serra', AGORA);
    assert.deepEqual(lidas.map((r) => [r.tipo, r.valor, r.noTeto, r.chave, r.id]), [['cobranca', 250, 250, chave, feita.cobranca.id]]);

    // reinício: outra subida, memória vazia, só o banco
    const b = subida(banco);
    await assert.rejects(criarCobranca(b.ctx, Q, pedido, b.registrar), new RegExp(`cobrança igual.*${feita.cobranca.id}.*Não repeti`, 's'));
  }
});

test('reinício com resposta perdida do Asaas (5xx): o registro "incerto" também sobrevive e bloqueia a segunda tentativa', async () => {
  const [{ pedido, chave }] = pedidosComChaveQueAMascaraEstragaria(1);
  const banco = bancoFalso();
  const a = subida(banco, { falhaNoPagamento: new ErroHttp('Asaas 503', 503) });
  await assert.rejects(criarCobranca(a.ctx, Q, pedido!, a.registrar), /PODE ter sido gerada/);
  await esperarGravacao();
  const gravada = banco.linhas.find((l) => l.ferramenta === EVENTO_COBRANCA && !(l.argumentos as { fase?: string }).fase)!;
  assert.equal(gravada.ok, false);
  assert.equal((gravada.argumentos as { chave: string }).chave, chave);
  assert.equal((gravada.argumentos as { incerto: boolean }).incerto, true);
  const b = subida(banco);
  await assert.rejects(criarCobranca(b.ctx, Q, pedido!, b.registrar), /cobrança igual/);
});

test('reinício: transferência feita antes de reiniciar continua contando no teto do dia (e a recusa definitiva do Asaas não conta)', async () => {
  const banco = bancoFalso();
  const a = subida(banco, {}, 1000);
  await transferir(a.ctx, Q, { unidade: 'serra', destino: '11.222.333/0001-81', valor: 700 }, a.registrar);
  const recusada = subida(banco, { falhas: [{ metodo: 'POST', caminho: /transfers/, erro: new ErroHttp('Asaas 400: chave inválida', 400) }] }, 1000);
  await assert.rejects(transferir(recusada.ctx, Q, { unidade: 'serra', destino: '11.222.333/0001-81', valor: 100 }, recusada.registrar), /chave inválida/);
  await esperarGravacao();
  const evento = banco.linhas.find((l) => l.ferramenta === EVENTO_OPERACAO && l.ok && !(l.argumentos as { fase?: string }).fase)!;
  assert.deepEqual([(evento.argumentos as any).operacao, (evento.argumentos as any).valor, (evento.argumentos as any).noTeto, (evento.argumentos as any).destino], ['transferir', 700, 700, 'Fornecedor']);
  const lidas = await lancamentosRecentesDe(banco.db, 'doutor-hernia-serra', AGORA);
  assert.deepEqual(lidas.map((r) => [r.tipo, r.valor]), [['transferencia', 700]], 'a recusa definitiva não entra');

  const b = subida(banco, {}, 1000); // reinício
  await assert.rejects(transferir(b.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 301 }, b.registrar), /já foram R\$ 700,00 hoje/);
  assert.equal(b.f.posts().length, 0);
  await transferir(b.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 300 }, b.registrar);
});

test('o evento interno é gravado sem dado pessoal: documento mascarado, nome abreviado, erro mascarado', async () => {
  const banco = bancoFalso();
  const a = subida(banco);
  await criarCobranca(a.ctx, Q, COBRANCA, a.registrar);
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
  assert.deepEqual(argumentosDaAuditoria(EVENTO_OPERACAO, args), args);
  assert.deepEqual(argumentosDaAuditoria('outra_ferramenta', args), { conta: 'x', chave: 'formato-novo-[CPF/senha omitido]' });
});

test('leitor: só conta o que está na janela de 36 horas e só da conta pedida; editar cliente não entra; cancelar entra com noTeto 0 (só para o limite de quantidade); edição entra com o acréscimo', async () => {
  const H = 3_600_000;
  const linha = (ferramenta: string, conta: string, idadeH: number, args: object, ok = true) => ({ createdAt: new Date(AGORA - idadeH * H), ok, ferramenta, argumentos: { conta, ...args } });
  const vistos: Array<{ gte: Date }> = [];
  const db: LeitorDeAuditoria = {
    mcpAuditoria: {
      async findMany({ where }) {
        vistos.push(where.createdAt);
        assert.deepEqual(where.OR, [{ argumentos: { path: ['conta'], equals: 'serra' } }, { argumentos: { path: ['chaveAsaas'], equals: 'g1' } }]);
        assert.deepEqual(where.ferramenta.in.sort(), [EVENTO_COBRANCA, EVENTO_OPERACAO].sort());
        return [
          linha(EVENTO_COBRANCA, 'serra', 1, { chave: 'a1', valor: 100, cobrancaId: 'pay_a1' }),
          linha(EVENTO_COBRANCA, 'outra', 1, { chave: 'b2', valor: 100 }),
          linha(EVENTO_COBRANCA, 'serra', 2, { chave: 'c3', valor: 30 }, false), // falha definitiva: não conta
          linha(EVENTO_COBRANCA, 'serra', 3, { chave: 'd4', valor: 40, incerto: true }, false), // pode ter criado: conta
          linha(EVENTO_OPERACAO, 'serra', 4, { operacao: 'estornar_cobranca', valor: 200, noTeto: 200, idAsaas: 'pay_e5', chave: 'e5' }),
          linha(EVENTO_OPERACAO, 'serra', 5, { operacao: 'transferir', valor: 300, noTeto: 300, chave: 'f6' }),
          linha(EVENTO_OPERACAO, 'serra', 6, { operacao: 'editar_cobranca', valor: 500, noTeto: 50, idAsaas: 'pay_g7' }),
          linha(EVENTO_OPERACAO, 'serra', 7, { operacao: 'cancelar_cobranca', valor: 999, noTeto: 0, idAsaas: 'pay_h8' }),
          linha(EVENTO_OPERACAO, 'serra', 8, { operacao: 'editar_cliente', valor: 0, noTeto: 0 }),
          linha(EVENTO_OPERACAO, 'serra', 9, { operacao: 'transferir', valor: 400, incerto: true }, false), // sem noTeto gravado: vale o valor
        ];
      },
    },
  };
  const lidas = await lancamentosRecentesDe(db, 'serra', AGORA, 'g1');
  assert.deepEqual(lidas.map((r) => [r.tipo, r.valor, r.noTeto, r.chave ?? null, r.id ?? null]), [
    ['cobranca', 100, 100, 'a1', 'pay_a1'],
    ['cobranca', 40, 40, 'd4', null],
    ['estorno', 200, 200, 'e5', 'pay_e5'],
    ['transferencia', 300, 300, 'f6', null],
    ['edicao', 500, 50, null, 'pay_g7'],
    ['cancelamento', 999, 0, null, 'pay_h8'],
    ['transferencia', 400, 400, null, null],
  ]);
  assert.equal(vistos[0]!.gte.getTime(), AGORA - 36 * H, 'a janela pedida ao banco é de exatamente 36 horas');
  assert.equal(lidas[0]!.em, AGORA - 1 * H);
});

test('só os eventos que o código relê escapam da máscara; o resto da auditoria (inclusive evo_envio) continua mascarado', () => {
  assert.deepEqual([...EVENTOS_INTERNOS].sort(), [EVENTO_CLIENTE, EVENTO_COBRANCA, EVENTO_OPERACAO].sort());
  const chave = chaveDeDuplicata('x', 'cus_1', 1, '2026-11-10', 'a');
  assert.deepEqual(argumentosDaAuditoria(EVENTO_COBRANCA, { chave: '0123456789012345678901234567890a' }), { chave: '0123456789012345678901234567890a' });
  assert.equal(chave.length, 32);
  assert.deepEqual(argumentosDaAuditoria('evo_envio', { para: '5511987654321' }), { para: '(**) *****-4321' });
  assert.deepEqual(argumentosDaAuditoria('asaas_cliente', { busca: '529.982.247-25' }), { busca: '***.***.***-25' });
});

test('a INTENÇÃO é gravada no banco ANTES de a chamada sair para o Asaas; resolvida pelo resultado, não conta em dobro', async () => {
  const banco = bancoFalso();
  const a = subida(banco, {}, 5000);
  let vistoNaChamada: unknown[] = [];
  const enviar = a.f.conta.escrita!.enviar.bind(a.f.conta.escrita);
  a.f.conta.escrita!.enviar = (async (metodo: 'POST' | 'PUT' | 'DELETE', caminho: string, corpo?: Record<string, unknown>) => {
    if (caminho === '/transfers') vistoNaChamada = banco.linhas.filter((l) => (l.argumentos as { fase?: string }).fase === 'intencao').map((l) => l.argumentos);
    return enviar(metodo, caminho, corpo);
  }) as never;
  await transferir(a.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 700 }, a.registrar);
  assert.equal(vistoNaChamada.length, 1, 'a intenção já estava no banco quando a chamada saiu');
  assert.deepEqual([(vistoNaChamada[0] as any).operacao, (vistoNaChamada[0] as any).valor, (vistoNaChamada[0] as any).incerto], ['transferir', 700, true]);
  await esperarGravacao();
  assert.equal(banco.linhas.filter((l) => l.ferramenta === EVENTO_OPERACAO).length, 2, 'intenção + resultado');
  assert.equal(banco.linhas.filter((l) => l.ok === false).length, 0, 'a intenção não aparece como falha nos painéis');
  const lidas = await lancamentosRecentesDe(banco.db, 'doutor-hernia-serra', AGORA);
  assert.deepEqual(lidas.map((r) => [r.tipo, r.valor]), [['transferencia', 700]], 'resolvida pelo resultado: conta uma vez só');
});

test('reinício NO MEIO da chamada: só a intenção ficou no banco, e ela segura o teto do dia e a duplicata', async () => {
  const banco = bancoFalso();
  const a = subida(banco, {}, 1000);
  a.f.conta.escrita!.enviar = (() => new Promise(() => undefined)) as never; // o servidor morre com o Asaas ainda respondendo
  void transferir(a.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 700 }, a.registrar).catch(() => undefined);
  await esperarGravacao();
  await esperarGravacao();
  assert.equal(banco.linhas.length > 0 && banco.linhas.every((l) => (l.argumentos as { fase?: string }).fase === 'intencao'), true, 'só a intenção foi gravada');
  const b = subida(banco, {}, 1000); // reinício
  await assert.rejects(transferir(b.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 301 }, b.registrar), /já foram R\$ 700,00 hoje/);
  await assert.rejects(transferir(b.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 700 }, b.registrar), /transferência igual para Fornecedor/);
  assert.equal(b.f.posts().length, 0);
});

test('banco que não responde ao porteiro = a operação NÃO sai (fail closed) e nada é avisado', async () => {
  const banco = bancoFalso();
  const a = subida(banco, { pagamentos: [{ id: 'pay_paga00000001', status: 'RECEIVED', value: 80 }] }, 1000);
  const falha = async () => {
    throw new ErroDeEntrada(FALHA_DO_BANCO);
  };
  a.ctx.esc.porteiro = { reservar: falha, ler: falha };
  await assert.rejects(transferir(a.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 700 }, a.registrar), /não consegui conferir nem registrar a operação no banco/);
  await assert.rejects(criarCobranca(a.ctx, Q, COBRANCA, a.registrar), /nada foi feito/);
  await assert.rejects(estornarCobranca(a.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_paga00000001' }, a.registrar), /nada foi feito/);
  assert.equal(a.f.posts().length, 0);
});

test('a intenção SEM resultado de outra operação não é "resolvida" pelo resultado de uma parecida: o casamento é pelo id da intenção, não pelo hash', async () => {
  const banco = bancoFalso();
  // duas operações com o MESMO hash (mesmo destino e valor), 20 min uma da outra; a 1ª morreu no meio da chamada (só a intenção), a 2ª terminou
  const mesma = { conta: 'doutor-hernia-serra', operacao: 'transferir', valor: 700, noTeto: 700, chave: 'mesmo-hash', chaveAsaas: 'g1' };
  banco.banco.gravar({ ferramenta: EVENTO_OPERACAO, argumentos: { ...mesma, intencaoId: 'int-1', fase: 'intencao', incerto: true }, ok: true }, AGORA - 20 * 60_000);
  banco.banco.gravar({ ferramenta: EVENTO_OPERACAO, argumentos: { ...mesma, intencaoId: 'int-2', fase: 'intencao', incerto: true }, ok: true }, AGORA - 5 * 60_000);
  banco.banco.gravar({ ferramenta: EVENTO_OPERACAO, argumentos: { ...mesma, intencaoId: 'int-2', idAsaas: 'tra_2' }, ok: true }, AGORA - 5 * 60_000 + 1000);
  const lidas = await lancamentosRecentesDe(banco.db, 'doutor-hernia-serra', AGORA, 'g1');
  assert.deepEqual(lidas.map((r) => r.intencaoId), ['int-1', 'int-2'], 'a órfã (int-1) continua contando; a int-2 conta uma vez só, pelo resultado');
});
