import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AGORA, BancoFalso, ErroHttp, montar, type Cli, type Pg } from './asaas-falso.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { criarCobranca, EVENTO_OPERACAO, type PedidoDeCobranca } from './asaas-escrita.js';
import { asaasCobranca } from './asaas.js';
import { cabecalhoDaConta, contaDeEscrita } from './asaas-escrita.js';
import { mascararDestinoDoPedido } from './asaas-escrita.js';
import { registrarEscritaAsaas } from './asaas-ferramentas.js';
import { cancelarCobranca, editarCliente, editarCobranca, estornarCobranca, limitesEDestinos, transferir } from './asaas-operacoes.js';
import { FALHA_DO_BANCO, lerDestinos, type DestinosLidos } from './asaas-limites.js';

const Q = { id: 'u1', email: 'joao@exemplo.com' };
const CPF = '529.982.247-25';
const CNPJ_DESTINO = '11222333000181';
const EXISTENTE: Cli = { id: 'cus_000005401844', name: 'Maria da Silva', cpfCnpj: '52998224725', email: 'maria.silva@exemplo.com', notificationDisabled: true };
const PENDENTE: Pg = { id: 'pay_pendente0001', customer: EXISTENTE.id, status: 'PENDING', value: 300, dueDate: '2026-11-10', description: 'Consulta', billingType: 'BOLETO' };
const PAGA: Pg = { id: 'pay_paga00000001', customer: EXISTENTE.id, status: 'RECEIVED', value: 800, dueDate: '2026-10-20', description: 'Consulta', billingType: 'PIX' };
const tudo = (x: unknown) => JSON.stringify(x);

const DESTINOS_ENV = JSON.stringify({
  'doutor-hernia-serra': [
    { nome: 'Fornecedor Exemplo LTDA', apelido: 'Fornecedor', chave_pix: '11.222.333/0001-81', tipo_chave: 'CNPJ' },
    { nome: 'Maria Contadora', apelido: 'contadora', chave_pix: 'Contadora@Exemplo.com', tipo_chave: 'EMAIL' },
    { nome: 'Aluguel', apelido: 'aluguel', banco: '341', agencia: '1234', conta: '56789', conta_digito: '0', tipo_conta: 'corrente', titular: 'Imobiliária Exemplo', documento: '11222333000181' },
  ],
});
const destinosDoEnv = (env: string | undefined) => (slug: string): DestinosLidos => lerDestinos(slug, { ASAAS_TRANSFERENCIA_DESTINOS: env });
const comDestinos = { destinos: destinosDoEnv(DESTINOS_ENV) };
const totais = (m: ReturnType<typeof montar>) => m.usado();

// ------------------------------------------------------------------ editar cliente

test('editar cliente: manda PUT só com o que foi pedido; o CPF não muda; sem campo nenhum recusa; cliente que não existe recusa', async () => {
  const m = montar({ clientes: [{ ...EXISTENTE, notificationDisabled: false }] });
  const r = (await editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, email: 'nova@exemplo.com', avisarCliente: false }, m.registrar)) as any;
  assert.equal(r.alterado, true);
  assert.deepEqual(m.f.posts()[0], { metodo: 'PUT', caminho: `/customers/${EXISTENTE.id}`, corpo: { email: 'nova@exemplo.com', notificationDisabled: true } });
  assert.ok(!tudo(r).includes('nova@exemplo.com'), 'e-mail inteiro na resposta');
  assert.equal(r.cliente.avisosAutomaticos, 'desligados');
  const ev = m.eventos.find((e) => e.evento === EVENTO_OPERACAO)!;
  assert.deepEqual([ev.args.operacao, ev.args.noTeto, ev.ok], ['editar_cliente', 0, true]);
  await assert.rejects(() => editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id }, m.registrar), /nada para alterar/);
  await assert.rejects(() => editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: 'cus_000009999999', nome: 'Outra' }, m.registrar), /não existe/);
  await assert.rejects(() => editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: '../x', nome: 'Outra' }, m.registrar), /clienteId inválido/);
  assert.equal(m.f.posts().length, 1);
});

test('editar cliente: o cadastro mudar sem resposta é "pode ter sido feito"; a alteração de aviso destrava a cobrança que estava recusada', async () => {
  const m = montar({ clientes: [{ ...EXISTENTE, notificationDisabled: false }], falhas: [{ metodo: 'PUT', caminho: /customers/, erro: new ErroHttp('timeout', null) }] });
  await assert.rejects(() => editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, nome: 'Maria S' }, m.registrar), /PODE ter sido feita/);
  const n = montar({ clientes: [{ ...EXISTENTE, notificationDisabled: false }] });
  const pedido: PedidoDeCobranca = { unidade: 'serra', clienteId: EXISTENTE.id, valor: 100, vencimento: '2026-11-10', descricao: 'x', externalReference: 'e1' };
  await assert.rejects(() => criarCobranca(n.ctx, Q, pedido, n.registrar), /LIGADO/);
  await editarCliente(n.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, avisarCliente: false }, n.registrar);
  assert.equal(((await criarCobranca(n.ctx, Q, pedido, n.registrar)) as any).gerado, true);
});

// ------------------------------------------------------------------ editar cobrança

test('editar cobrança pendente: PUT com valor/vencimento/descrição; só PENDENTE; o acréscimo (e só ele) conta no teto do dia', async () => {
  const m = montar({ pagamentos: [{ ...PENDENTE }, { ...PAGA }, { ...PENDENTE, id: 'pay_vencida00001', status: 'OVERDUE' }] });
  const r = (await editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 450, vencimento: '2026-11-20' }, m.registrar)) as any;
  assert.equal(r.alterada, true);
  assert.deepEqual(m.f.posts()[0], { metodo: 'PUT', caminho: `/payments/${PENDENTE.id}`, corpo: { value: 450, dueDate: '2026-11-20' } });
  assert.equal(await totais(m), 150, 'só o acréscimo de 300 para 450');
  // diminuir não gasta teto
  await editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 100 }, m.registrar);
  assert.equal(await totais(m), 150);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 1 }, m.registrar), /só cobrança PENDENTE.*recebida/);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_vencida00001', valor: 1 }, m.registrar), /Cancele e crie outra/);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, m.registrar), /nada para alterar/);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_naoexiste0001', valor: 1 }, m.registrar), /não existe/);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: '../payments', valor: 1 }, m.registrar), /cobrancaId inválido/);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, vencimento: '2020-01-01' }, m.registrar), /já passou/);
});

test('editar cobrança: valor novo acima do teto por operação recusa; editar só o vencimento de uma cobrança grande não trava', async () => {
  const m = montar({ pagamentos: [{ ...PENDENTE, value: 9000 }] }, { tetoOperacao: () => 5000 });
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 9500 }, m.registrar), /passa do teto de R\$ 5\.000,00 por operação/);
  assert.equal(m.f.posts().length, 0);
  // diminuir uma cobrança que já passa do teto (criada no painel ou com teto antigo) não envolve dinheiro novo
  assert.equal(((await editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 6000 }, m.registrar)) as any).alterada, true);
  assert.equal(await totais(m), 0);
  assert.equal(((await editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, vencimento: '2026-11-15' }, m.registrar)) as any).alterada, true);
  // subir o valor para mais da metade do teto avisa o João
  const n = montar({ pagamentos: [{ ...PENDENTE }] });
  const r = (await editarCobranca(n.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 3000 }, n.registrar)) as any;
  assert.match(n.avisos.join('\n'), /EDITADA PARA VALOR ACIMA DE 50% DO TETO/);
  assert.equal(r.avisoNoTelegram, 'enviado ao João');
});

// ------------------------------------------------------------------ cancelar

test('cancelar: DELETE da cobrança pendente ou vencida, SEM confirmação, com aviso no Telegram (conta, valor, quem pediu, id)', async () => {
  const m = montar({ pagamentos: [{ ...PENDENTE }, { ...PENDENTE, id: 'pay_vencida00001', status: 'OVERDUE', value: 50 }] });
  const r = (await cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, m.registrar)) as any;
  assert.equal(r.cancelada, true);
  assert.deepEqual(m.f.posts()[0], { metodo: 'DELETE', caminho: `/payments/${PENDENTE.id}` });
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /COBRANÇA CANCELADA/);
  assert.match(m.avisos[0]!, /doutor-hernia-serra \(Clínica Serra Saúde LTDA\)/);
  assert.match(m.avisos[0]!, /R\$ 300,00/);
  assert.match(m.avisos[0]!, /joao@exemplo\.com \(usuário u1\)/);
  assert.match(m.avisos[0]!, /pay_pendente0001/);
  assert.equal(r.avisoNoTelegram, 'enviado ao João');
  await cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_vencida00001' }, m.registrar);
  assert.equal(m.avisos.length, 2);
  const ev = m.eventos.filter((e) => e.evento === EVENTO_OPERACAO);
  assert.deepEqual(ev.map((e) => [e.args.operacao, e.args.noTeto, e.ok]), [['cancelar_cobranca', 0, true], ['cancelar_cobranca', 0, true]]);
  assert.equal(await totais(m), 0, 'cancelar não gasta teto');
});

test('cancelar: cobrança já paga NÃO cancela e manda estornar; inexistente e id torto recusam; nada é gravado nem avisado', async () => {
  const m = montar({ pagamentos: [{ ...PAGA }] });
  await assert.rejects(() => cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, m.registrar), /já foi paga.*asaas_estornar_cobranca/);
  await assert.rejects(() => cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_naoexiste0001' }, m.registrar), /não existe/);
  await assert.rejects(() => cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'cus_000005401844' }, m.registrar), /cobrancaId inválido/);
  assert.equal(m.f.posts().length, 0);
  assert.equal(m.avisos.length, 0);
});

test('cancelar: sem resposta do Asaas = "PODE ter sido feito" e o João é avisado do resultado incerto; se o Telegram cai, a resposta diz', async () => {
  const m = montar({ pagamentos: [{ ...PENDENTE }], falhas: [{ metodo: 'DELETE', caminho: /payments/, erro: new ErroHttp('timeout', null) }] });
  await assert.rejects(() => cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, m.registrar), /PODE ter sido feito/);
  assert.match(m.avisos.join('\n'), /CANCELAMENTO COM RESULTADO INCERTO/);
  const mudo = montar({ pagamentos: [{ ...PENDENTE }] }, { alertar: async () => false });
  const r = (await cancelarCobranca(mudo.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, mudo.registrar)) as any;
  assert.equal(r.cancelada, true, 'o aviso que falha não desfaz o cancelamento');
  assert.match(r.avisoNoTelegram, /NÃO ENVIADO/);
});

// ------------------------------------------------------------------ estornar

test('estornar: total (sem valor no corpo) e parcial (valor no corpo), DIRETO, com aviso no Telegram e contando nos tetos', async () => {
  const m = montar({ pagamentos: [{ ...PAGA }, { ...PAGA, id: 'pay_paga00000002', value: 1000, status: 'CONFIRMED' }] });
  const total = (await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, motivo: 'paciente desistiu' }, m.registrar)) as any;
  assert.equal(total.estornado, true);
  assert.deepEqual(m.f.posts()[0], { metodo: 'POST', caminho: `/payments/${PAGA.id}/refund`, corpo: { description: 'paciente desistiu' } });
  assert.equal(total.cobranca.estornoParcial, false);
  assert.equal(await totais(m), 800);
  const parcial = (await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_paga00000002', valor: 250 }, m.registrar)) as any;
  assert.deepEqual(m.f.posts()[1]!.corpo, { value: 250 });
  assert.equal(parcial.cobranca.estornoParcial, true);
  assert.equal(await totais(m), 1050);
  assert.equal(m.avisos.length, 2);
  assert.match(m.avisos[0]!, /ESTORNO\n/);
  assert.match(m.avisos[0]!, /ESTORNO TOTAL · motivo: paciente desistiu/);
  assert.match(m.avisos[1]!, /ESTORNO PARCIAL \(cobrança de R\$ 1\.000,00\)/);
  assert.match(m.avisos[1]!, /Valor: R\$ 250,00/);
  assert.match(m.avisos[1]!, /joao@exemplo\.com/);
  const ev = m.eventos.filter((e) => e.evento === EVENTO_OPERACAO);
  assert.deepEqual(ev.map((e) => [e.args.operacao, e.args.valor, e.args.noTeto, e.ok]), [['estornar_cobranca', 800, 800, true], ['estornar_cobranca', 250, 250, true]]);
});

test('estornar: cobrança pendente manda cancelar; parcial maior que a cobrança recusa; estorno igual em 10 min recusa; acima do teto por operação recusa', async () => {
  const m = montar({ pagamentos: [{ ...PENDENTE }, { ...PAGA }] }, { tetoOperacao: () => 5000 });
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, m.registrar), /asaas_cancelar_cobranca/);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 900 }, m.registrar), /passa do que ainda resta nesta cobrança/);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 0 }, m.registrar), /maior que zero/);
  await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 100 }, m.registrar);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 100 }, m.registrar), /estorno igual da cobrança pay_paga00000001/);
  const grande = montar({ pagamentos: [{ ...PAGA, value: 6000 }] }, { tetoOperacao: () => 5000 });
  await assert.rejects(() => estornarCobranca(grande.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, grande.registrar), /passa do teto de R\$ 5\.000,00 por operação/);
  assert.equal(grande.f.posts().length, 0);
  assert.equal(grande.avisos.length, 0);
  assert.equal(m.f.posts().length, 1);
});

test('estornar: Asaas sem resposta = "PODE ter sido feito", gasta o teto e avisa; recusa definitiva (4xx) devolve o teto', async () => {
  const incerto = montar({ pagamentos: [{ ...PAGA }], falhas: [{ metodo: 'POST', caminho: /refund/, erro: new ErroHttp('Asaas 503', 503) }] });
  await assert.rejects(() => estornarCobranca(incerto.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, incerto.registrar), /estorno PODE ter sido feito/);
  assert.equal(await totais(incerto), 800);
  assert.match(incerto.avisos.join('\n'), /ESTORNO COM RESULTADO INCERTO/);
  const recusa = montar({ pagamentos: [{ ...PAGA }], falhas: [{ metodo: 'POST', caminho: /refund/, erro: new ErroHttp('Asaas 400: saldo insuficiente', 400) }] });
  await assert.rejects(() => estornarCobranca(recusa.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, recusa.registrar), /saldo insuficiente/);
  assert.equal(await totais(recusa), 0);
  assert.equal(recusa.avisos.length, 0);
});

// ------------------------------------------------------------------ transferir: a lista de destinos

test('transferir: lista vazia / ausente / JSON quebrado = DESLIGADA, com a resposta clara de como cadastrar; nada sai', async () => {
  for (const env of [undefined, '', '   ', '{', '[]', '{"doutor-hernia-serra":[]}', '{"outra-clinica":[{"nome":"X","chave_pix":"11222333000181","tipo_chave":"CNPJ"}]}', '{"doutor-hernia-serra":[{"nome":"Sem chave"}]}']) {
    const m = montar({}, { destinos: destinosDoEnv(env) });
    await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: CNPJ_DESTINO, valor: 10 }, m.registrar), /DESLIGADA.*ASAAS_TRANSFERENCIA_DESTINOS.*não dá para cadastrar pelo chat/s, String(env));
    assert.equal(m.f.chamadas.length, 0, String(env));
    assert.equal(m.avisos.length, 0);
  }
  // pelo ambiente de verdade (sem injeção): ausente → desligada
  const anterior = process.env.ASAAS_TRANSFERENCIA_DESTINOS;
  delete process.env.ASAAS_TRANSFERENCIA_DESTINOS;
  try {
    const m = montar({}, { destinos: undefined });
    await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: CNPJ_DESTINO, valor: 10 }, m.registrar), /DESLIGADA/);
  } finally {
    if (anterior !== undefined) process.env.ASAAS_TRANSFERENCIA_DESTINOS = anterior;
  }
});

test('transferir: destino FORA da lista recusa (chave parecida, outra conta, outro dígito) e diz quais são permitidos; nada sai nem é avisado', async () => {
  const m = montar({}, comDestinos);
  for (const destino of ['11222333000180', '99999999000191', 'outro@exemplo.com', 'fornecedor2', 'Fornecedor LTDA', '11.222.333/0001-8']) {
    await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino, valor: 10 }, m.registrar), /não está na lista permitida.*Fornecedor, contadora, aluguel.*nunca pelo chat/s, destino);
  }
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', contaBancaria: { banco: '341', agencia: '1234', conta: '56780', digito: '0' }, valor: 10 }, m.registrar), /não está na lista permitida/);
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', contaBancaria: { banco: '341', agencia: '1234', conta: '56789' }, valor: 10 }, m.registrar), /não está na lista permitida/, 'sem o dígito não é a mesma conta');
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', valor: 10 }, m.registrar), /"destino".*OU.*"contaBancaria"/);
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', contaBancaria: { banco: '341', agencia: '1234', conta: '56789', digito: '0' }, valor: 10 }, m.registrar), /um dos dois/);
  assert.equal(m.f.chamadas.length, 0);
  assert.equal(m.avisos.length, 0);
  assert.equal(await totais(m), 0);
});

test('transferir: destino DENTRO da lista passa — por chave Pix exata (com ou sem pontuação), por apelido e por conta; o corpo vem da LISTA, não do chat', async () => {
  const m = montar({}, comDestinos);
  const a = (await transferir(m.ctx, Q, { unidade: 'serra', destino: '11.222.333/0001-81', valor: 100, descricao: 'Material de março' }, m.registrar)) as any;
  assert.equal(a.transferido, true);
  assert.deepEqual(m.f.posts()[0], { metodo: 'POST', caminho: '/transfers', corpo: { value: 100, description: 'Material de março', pixAddressKey: CNPJ_DESTINO, pixAddressKeyType: 'CNPJ' } });
  assert.deepEqual(a.transferencia.destino, { apelido: 'Fornecedor', nome: 'Fornecedor Exemplo LTDA', via: 'Pix', tipoDaChave: 'CNPJ', chave: '**.***.333/0001-**' });
  // apelido (sem acento e sem maiúscula) e e-mail em caixa diferente
  await transferir(m.ctx, Q, { unidade: 'serra', destino: ' CONTADORA ', valor: 200 }, m.registrar);
  assert.deepEqual(m.f.posts()[1]!.corpo, { value: 200, pixAddressKey: 'contadora@exemplo.com', pixAddressKeyType: 'EMAIL' });
  await transferir(m.ctx, Q, { unidade: 'serra', destino: 'CONTADORA@exemplo.COM', valor: 201 }, m.registrar);
  assert.equal(m.f.posts()[2]!.corpo!.pixAddressKey, 'contadora@exemplo.com');
  // conta bancária exata
  const c = (await transferir(m.ctx, Q, { unidade: 'serra', contaBancaria: { banco: '341', agencia: '1234', conta: '56789', digito: '0' }, valor: 300 }, m.registrar)) as any;
  assert.deepEqual(m.f.posts()[3]!.corpo, {
    value: 300,
    operationType: 'PIX',
    bankAccount: { bank: { code: '341' }, accountName: 'Aluguel', ownerName: 'Imobiliária Exemplo', cpfCnpj: CNPJ_DESTINO, agency: '1234', account: '56789', accountDigit: '0', bankAccountType: 'CONTA_CORRENTE' },
  });
  assert.equal(c.transferencia.destino.conta, '***89-0');
  assert.equal(await totais(m), 100 + 200 + 201 + 300);
  // o chat não consegue trocar a chave que vai ao Asaas: o pedido leva uma chave com sobra de texto, e ela não casa
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: '11.222.333/0001-81; outra chave', valor: 5 }, m.registrar), /não está na lista/);
});

test('transferir: entradas inválidas na lista são ignoradas (e contadas), nunca viram destino; apelido ou chave repetidos não valem', () => {
  const env = JSON.stringify({
    'doutor-hernia-serra': [
      { nome: 'CNPJ errado', chave_pix: '11222333000180', tipo_chave: 'CNPJ' },
      { nome: 'Tipo torto', chave_pix: '11222333000181', tipo_chave: 'QUALQUER' },
      { nome: '', chave_pix: '11222333000181', tipo_chave: 'CNPJ', apelido: 'semnome' },
      { nome: 'Bom', apelido: 'Bom', chave_pix: '11222333000181', tipo_chave: 'CNPJ' },
      { nome: 'Repetida', apelido: 'outro', chave_pix: '11.222.333/0001-81', tipo_chave: 'CNPJ' },
      { nome: 'Apelido repetido', apelido: 'bom', chave_pix: 'x@exemplo.com', tipo_chave: 'EMAIL' },
      { nome: 'Conta sem titular', banco: '341', agencia: '1', conta: '2' },
      { nome: 'Fone', apelido: 'fone', chave_pix: '(63) 98141-1248', tipo_chave: 'PHONE' },
    ],
  });
  const l = lerDestinos('doutor-hernia-serra', { ASAAS_TRANSFERENCIA_DESTINOS: env });
  assert.deepEqual(l.destinos.map((d) => d.apelido), ['Bom', 'fone']);
  assert.equal((l.destinos[1] as { chave: string }).chave, '+5563981411248');
  assert.equal(l.problemas.length, 6);
  assert.ok(l.problemas.every((p) => !p.includes('11222333000181')), 'a chave não vai para a mensagem de problema');
  assert.equal(l.ligada, true);
});

// ------------------------------------------------------------------ transferir: tetos

test('transferir: teto POR OPERAÇÃO — no teto passa, um centavo acima recusa (e manda para o painel); 0/vazio/lixo no ambiente usam o padrão de 5000', async () => {
  const m = montar({}, { ...comDestinos, tetoOperacao: () => 1000, tetoDia: () => 100_000 });
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 1000.01 }, m.registrar), /passa do teto de R\$ 1\.000,00 por operação.*painel do Asaas.*ASAAS_TETO_OPERACAO_REAIS/s);
  assert.equal(m.f.posts().length, 0);
  assert.equal(((await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 1000 }, m.registrar)) as any).transferido, true);
  const anterior = [process.env.ASAAS_TETO_OPERACAO_REAIS, process.env.ASAAS_TETO_DIA_REAIS, process.env.ASAAS_COBRANCA_MAX_REAIS];
  for (const k of ['ASAAS_TETO_OPERACAO_REAIS', 'ASAAS_TETO_DIA_REAIS', 'ASAAS_COBRANCA_MAX_REAIS']) delete process.env[k];
  try {
    const esc = montar({}, { destinos: comDestinos.destinos });
    await assert.rejects(() => transferir(esc.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 5000.01 }, esc.registrar), /teto de R\$ 5\.000,00 por operação/);
    process.env.ASAAS_TETO_OPERACAO_REAIS = '0';
    await assert.rejects(() => transferir(esc.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 5000.01 }, esc.registrar), /teto de R\$ 5\.000,00 por operação/, '0 não é ilimitado');
    process.env.ASAAS_TETO_OPERACAO_REAIS = 'abc';
    await assert.rejects(() => transferir(esc.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 5000.01 }, esc.registrar), /teto de R\$ 5\.000,00 por operação/);
    assert.equal(esc.f.posts().length, 0);
  } finally {
    ['ASAAS_TETO_OPERACAO_REAIS', 'ASAAS_TETO_DIA_REAIS', 'ASAAS_COBRANCA_MAX_REAIS'].forEach((k, i) => (anterior[i] === undefined ? delete process.env[k] : (process.env[k] = anterior[i])));
  }
});

test('transferir: teto DO DIA soma transferências + estornos + cobranças criadas, em horas diferentes; passou, recusa; o dia seguinte (fuso da clínica) zera', async () => {
  const m = montar({ pagamentos: [{ ...PAGA, value: 400 }], clientes: [EXISTENTE] }, { ...comDestinos, tetoOperacao: () => 5000, tetoDia: () => 1000 });
  const SP = (iso: string) => Date.parse(`${iso}-03:00`);
  const cobranca = (ref: string, valor: number) => criarCobranca(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, valor, vencimento: '2026-11-10', descricao: 'x', externalReference: ref }, m.registrar);
  // 02:00 (05:00Z): cobrança de 300
  m.relogio.t = SP('2026-10-28T02:00:00');
  await cobranca('d1', 300);
  // 14:00: estorno de 400
  m.relogio.t = SP('2026-10-28T14:00:00');
  await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, m.registrar);
  // 23:30 (02:30Z do dia 29, outro dia em UTC e o MESMO dia em São Paulo): transferência de 300 fecha em 1000
  m.relogio.t = SP('2026-10-28T23:30:00');
  await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 300 }, m.registrar);
  assert.equal(await totais(m), 1000);
  const antes = m.f.posts().length;
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 0.01 }, m.registrar), /passa do teto do dia.*já foram R\$ 1\.000,00.*cobranças criadas \+ estornos \+ transferências.*ASAAS_TETO_DIA_REAIS/s);
  await assert.rejects(() => cobranca('d2', 1), /teto do dia/);
  assert.equal(m.f.posts().length, antes);
  // 00:10 do dia 29 em São Paulo: outro dia, o teto zera
  m.relogio.t = SP('2026-10-29T00:10:00');
  assert.equal(await totais(m), 0);
  assert.equal(((await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 999 }, m.registrar)) as any).limites.restanteHoje, 'R$ 1,00');
});

test('teto do dia: o dia é o da CLÍNICA — clínica em Manaus (UTC-4) tem a virada do dia quatro horas depois de UTC', async () => {
  const m = montar({ fuso: 'America/Manaus' }, { ...comDestinos, tetoDia: () => 500 });
  m.relogio.t = Date.parse('2026-10-28T22:30:00-04:00'); // 02:30Z do dia 29, mas dia 28 em Manaus
  await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 500 }, m.registrar);
  m.relogio.t = Date.parse('2026-10-28T23:50:00-04:00');
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'contadora', valor: 1 }, m.registrar), /teto do dia/);
  m.relogio.t = Date.parse('2026-10-29T00:05:00-04:00');
  assert.equal(((await transferir(m.ctx, Q, { unidade: 'serra', destino: 'contadora', valor: 1 }, m.registrar)) as any).transferido, true);
});

test('teto do dia vem do BANCO: hoje conta, ontem não, e banco que não responde trava tudo', async () => {
  const SP = (iso: string) => Date.parse(`${iso}-03:00`);
  const banco = new BancoFalso();
  banco.gravar({ ferramenta: EVENTO_OPERACAO, argumentos: { conta: 'doutor-hernia-serra', operacao: 'transferir', valor: 700, noTeto: 700, chave: 'a' }, ok: true }, SP('2026-10-28T09:00:00'));
  banco.gravar({ ferramenta: EVENTO_OPERACAO, argumentos: { conta: 'doutor-hernia-serra', operacao: 'estornar_cobranca', valor: 5000, noTeto: 5000, chave: 'b' }, ok: true }, SP('2026-10-27T20:00:00'));
  const m = montar({}, { ...comDestinos, banco, tetoDia: () => 1000 });
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 301 }, m.registrar), /já foram R\$ 700,00 hoje/);
  assert.equal(((await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 300 }, m.registrar)) as any).transferido, true);
  const falha = async () => {
    throw new ErroDeEntrada(FALHA_DO_BANCO);
  };
  const quebrado = montar({}, { ...comDestinos, porteiro: { reservar: falha, ler: falha } });
  await assert.rejects(() => transferir(quebrado.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 1 }, quebrado.registrar), /não consegui conferir nem registrar a operação no banco/);
  assert.equal(quebrado.f.posts().length, 0);
});

test('teto do dia: duas transferências JUNTAS (corrida) não passam as duas pelo mesmo saldo do teto', async () => {
  const m = montar({}, { ...comDestinos, tetoDia: () => 1000 });
  const r = await Promise.allSettled([
    transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 600 }, m.registrar),
    transferir(m.ctx, Q, { unidade: 'serra', destino: 'contadora', valor: 600 }, m.registrar),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(m.f.posts().length, 1);
});

// ------------------------------------------------------------------ transferir: aviso, saldo, falhas

test('transferir: o Telegram é chamado com conta, valor, quem pediu e destino (a chave sai mascarada); a resposta confirma o aviso', async () => {
  const m = montar({}, comDestinos);
  const r = (await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 123.45, descricao: 'Material' }, m.registrar)) as any;
  assert.equal(m.avisos.length, 1);
  const t = m.avisos[0]!;
  assert.match(t, /Asaas · TRANSFERÊNCIA/);
  assert.match(t, /Conta: doutor-hernia-serra \(Clínica Serra Saúde LTDA\)/);
  assert.match(t, /Valor: R\$ 123,45/);
  assert.match(t, /Quem pediu: joao@exemplo\.com \(usuário u1\)/);
  assert.match(t, /Destino: Fornecedor \(CNPJ \*\*\.\*\*\*\.333\/0001-\*\*\)/);
  assert.ok(!t.includes(CNPJ_DESTINO), 'a chave inteira foi para o Telegram');
  assert.equal(r.avisoNoTelegram, 'enviado ao João');
  const ev = m.eventos.find((e) => e.evento === EVENTO_OPERACAO)!;
  assert.deepEqual([ev.args.operacao, ev.args.destino, ev.args.valor, ev.args.pediuPor, ev.ok], ['transferir', 'Fornecedor', 123.45, 'u1', true]);
  assert.match(String(ev.args.idAsaas), /^tra_/);
  assert.ok(!tudo(ev).includes(CNPJ_DESTINO), 'a chave inteira foi para o registro');
  // Telegram fora: a transferência foi feita e a resposta DIZ que o aviso não saiu
  const mudo = montar({}, { ...comDestinos, alertar: async () => false });
  const r2 = (await transferir(mudo.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 10 }, mudo.registrar)) as any;
  assert.equal(r2.transferido, true);
  assert.match(r2.avisoNoTelegram, /NÃO ENVIADO/);
});

test('transferir: saldo insuficiente recusa antes de tentar; status FAILED do Asaas devolve o teto; 5xx fica reservado e avisa como INCERTO', async () => {
  const pobre = montar({ saldo: 50 }, comDestinos);
  await assert.rejects(() => transferir(pobre.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 100 }, pobre.registrar), /saldo insuficiente.*R\$ 50,00/);
  assert.equal(pobre.f.posts().length, 0);
  assert.equal(await totais(pobre), 0);
  const falhou = montar({ statusDaTransferencia: 'FAILED' }, comDestinos);
  await assert.rejects(() => transferir(falhou.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 100 }, falhou.registrar), /não fez a transferência \(FAILED\)/);
  assert.equal(await totais(falhou), 0);
  assert.equal(falhou.avisos.length, 0);
  const incerto = montar({ falhas: [{ metodo: 'POST', caminho: /transfers/, erro: new ErroHttp('Asaas 502', 502) }] }, comDestinos);
  await assert.rejects(() => transferir(incerto.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 100 }, incerto.registrar), /transferência PODE ter sido feita.*asaas_extrato/);
  assert.equal(await totais(incerto), 100, 'resposta perdida não libera o teto');
  assert.match(incerto.avisos.join('\n'), /TRANSFERÊNCIA COM RESULTADO INCERTO/);
  await assert.rejects(() => transferir(incerto.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 100 }, incerto.registrar), /transferência igual para Fornecedor/);
});

test('transferir: transferência igual (mesmo destino e valor) em 10 minutos é recusada MESMO com outra descrição; 11 minutos depois ou outro valor passa', async () => {
  const m = montar({}, comDestinos);
  const t = (descricao?: string, valor = 50) => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor, descricao }, m.registrar);
  await t('A');
  await assert.rejects(() => t('A'), /transferência igual para Fornecedor/);
  await assert.rejects(() => t('B'), /transferência igual para Fornecedor.*espere 10 minutos/s);
  await assert.rejects(() => t(undefined), /transferência igual/);
  await t('A', 51);
  m.relogio.t += 11 * 60_000;
  await t('A');
  assert.equal(m.f.posts().length, 3);
});

test('transferir: texto com CPF/telefone na descrição, valor torto e conta/unidade desligada recusam', async () => {
  const m = montar({}, comDestinos);
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 10, descricao: 'pix para 52998224725' }, m.registrar), /11 ou mais dígitos/);
  for (const v of [0, -1, 1.234, NaN, Infinity]) await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: v }, m.registrar), /valor/, String(v));
  const off = montar({}, { ...comDestinos, unidades: () => new Set() });
  await assert.rejects(() => transferir(off.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 10 }, off.registrar), /DESLIGADA para doutor-hernia-serra.*ASAAS_ESCRITA_UNIDADES/);
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'todas', destino: 'fornecedor', valor: 10 }, m.registrar), /numa conta só/);
  assert.equal(m.f.posts().length + off.f.posts().length, 0);
});

// ------------------------------------------------------------------ Telegram em cobrança grande

test('cobrança: acima de 50% do teto por operação chama o Telegram; exatamente 50% e abaixo não', async () => {
  const m = montar({ clientes: [EXISTENTE] });
  const c = (ref: string, valor: number) => criarCobranca(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, valor, vencimento: '2026-11-10', descricao: 'x', externalReference: ref }, m.registrar) as Promise<any>;
  await c('g1', 2500);
  assert.equal(m.avisos.length, 0);
  const r = await c('g2', 2500.01);
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /COBRANÇA ACIMA DE 50% DO TETO/);
  assert.match(m.avisos[0]!, /Valor: R\$ 2\.500,01/);
  assert.match(m.avisos[0]!, /joao@exemplo\.com/);
  assert.match(m.avisos[0]!, /BOLETO/);
  assert.equal(r.avisoNoTelegram, 'enviado ao João');
  // o teto de 4000: 2001 já passa de 50%
  const n = montar({ clientes: [EXISTENTE] }, { tetoOperacao: () => 4000 });
  await criarCobranca(n.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, valor: 2001, vencimento: '2026-11-10', descricao: 'x', externalReference: 'g3' }, n.registrar);
  assert.equal(n.avisos.length, 1);
  // acima do teto por operação: recusa
  await assert.rejects(() => criarCobranca(n.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, valor: 4000.01, vencimento: '2026-11-10', descricao: 'x', externalReference: 'g4' }, n.registrar), /passa do teto de R\$ 4\.000,00 por operação/);
});

// ------------------------------------------------------------------ pelo protocolo

type Registro = { ferramenta: string; argumentos: any; ok: boolean; erro?: string };
const texto = (r: any) => String(r.content?.[0]?.text ?? '');

async function conectar(m: ReturnType<typeof montar>, registros: Registro[] = []) {
  const server = new McpServer({ name: 't', version: '0' });
  registrarEscritaAsaas(server, m.asaas, m.esc, Q, (r) => registros.push(r as never));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  return cliente;
}

test('protocolo: cada operação roda DIRETO pelo claude.ai, sem passo de confirmação', async () => {
  const m = montar({ clientes: [EXISTENTE], pagamentos: [{ ...PENDENTE }, { ...PAGA }, { ...PENDENTE, id: 'pay_pendente0002', value: 70 }] }, comDestinos);
  const c = await conectar(m);
  const chamar = async (name: string, args: Record<string, unknown>) => {
    const r = await c.callTool({ name, arguments: { unidade: 'serra', ...args } });
    assert.notEqual(r.isError, true, `${name}: ${texto(r)}`);
    return JSON.parse(texto(r));
  };
  await chamar('asaas_criar_cliente', { nome: 'Joana Souza', cpfCnpj: '111.444.777-35' });
  await chamar('asaas_editar_cliente', { clienteId: EXISTENTE.id, nome: 'Maria da Silva Souza' });
  await chamar('asaas_criar_cobranca', { clienteId: EXISTENTE.id, valor: 120, vencimento: '2026-11-10', descricao: 'Consulta', forma: 'PIX', externalReference: 'p1' });
  await chamar('asaas_criar_cobranca', { clienteId: EXISTENTE.id, valor: 600, vencimento: '2026-11-10', descricao: 'Tratamento', forma: 'CARTAO', parcelas: 3, externalReference: 'p2' });
  await chamar('asaas_editar_cobranca', { cobrancaId: PENDENTE.id, valor: 310 });
  await chamar('asaas_cancelar_cobranca', { cobrancaId: 'pay_pendente0002' });
  await chamar('asaas_estornar_cobranca', { cobrancaId: PAGA.id, valor: 100 });
  const t = await chamar('asaas_transferir', { destino: 'fornecedor', valor: 150, descricao: 'Material' });
  assert.equal(t.transferido, true);
  assert.deepEqual(m.f.posts().map((p) => `${p.metodo} ${p.caminho.replace(/\/(pay|cus|tra)_\w+/, '/$1_')}`), [
    'POST /customers', 'PUT /customers/cus_', 'POST /payments', 'POST /payments', 'PUT /payments/pay_', 'DELETE /payments/pay_', 'POST /payments/pay_/refund', 'POST /transfers',
  ]);
  const lim = await chamar('asaas_limites', {});
  assert.equal(lim.transferencia.ligada, true);
  assert.deepEqual(lim.transferencia.destinosPermitidos.map((d: { apelido: string }) => d.apelido), ['Fornecedor', 'contadora', 'aluguel']);
  assert.match(lim.limites.usadoHoje, /R\$ /);
  assert.ok(!tudo(lim).includes(CNPJ_DESTINO) && !tudo(lim).includes('Contadora@Exemplo.com'), 'chave inteira na consulta de limites');
  assert.match(lim.naoExiste, /dados bancários da clínica, chaves de API, webhooks, usuários do Asaas, antecipação, empréstimo e pagar contas/);
});

test('protocolo: transferência para destino fora da lista, pelo claude.ai, volta erro e não grava nem avisa; o schema não deixa "cadastrar" destino', async () => {
  const m = montar({}, comDestinos);
  const registros: Registro[] = [];
  const c = await conectar(m, registros);
  const r = await c.callTool({ name: 'asaas_transferir', arguments: { unidade: 'serra', destino: 'chave-nova@exemplo.com', valor: 10 } });
  assert.equal(r.isError, true);
  assert.match(texto(r), /não está na lista permitida/);
  const camposDaTransferencia = Object.keys((await c.listTools()).tools.find((t) => t.name === 'asaas_transferir')!.inputSchema.properties ?? {});
  assert.deepEqual(camposDaTransferencia.sort(), ['contaBancaria', 'descricao', 'destino', 'unidade', 'valor']);
  assert.ok(!camposDaTransferencia.some((k) => /apelido|nome|cadastr|salvar|nova/i.test(k)));
  assert.equal(m.f.chamadas.length, 0);
  assert.equal(m.avisos.length, 0);
  assert.ok(!tudo(registros).includes('chave-nova@exemplo.com'), 'e-mail inteiro do destino no registro do pedido');
  // lista vazia: o claude.ai recebe a explicação
  const vazio = montar({}, { destinos: destinosDoEnv(undefined) });
  const cv = await conectar(vazio);
  const rv = await cv.callTool({ name: 'asaas_transferir', arguments: { unidade: 'serra', destino: CNPJ_DESTINO, valor: 10 } });
  assert.equal(rv.isError, true);
  assert.match(texto(rv), /DESLIGADA.*ASAAS_TRANSFERENCIA_DESTINOS/s);
  const lim = JSON.parse(texto(await cv.callTool({ name: 'asaas_limites', arguments: { unidade: 'serra' } })));
  assert.equal(lim.transferencia.ligada, false);
});

test('limitesEDestinos: mostra tetos (geral e próprios), consumo do dia e destinos (chave mascarada) sem gravar', async () => {
  const m = montar({}, { ...comDestinos, tetoOperacao: () => 3000, tetoDia: () => 9000, tetoEspecifico: () => ({ operacao: 500, dia: 2000 }) });
  const r = await limitesEDestinos(m.ctx, { unidade: 'serra' });
  assert.deepEqual(r.limites, {
    tetoPorOperacao: 'R$ 3.000,00', tetoDoDia: 'R$ 9.000,00', usadoHoje: 'R$ 0,00', restanteHoje: 'R$ 9.000,00',
    estorno: { tetoPorOperacao: 'R$ 500,00', tetoDoDia: 'R$ 2.000,00', usadoHoje: 'R$ 0,00', restanteHoje: 'R$ 2.000,00' },
    transferencia: { tetoPorOperacao: 'R$ 500,00', tetoDoDia: 'R$ 2.000,00', usadoHoje: 'R$ 0,00', restanteHoje: 'R$ 2.000,00' },
  });
  assert.equal(m.f.chamadas.length, 0);
  assert.equal(AGORA > 0, true);
});

test('editar cliente: telefone de outro tipo avisa que o antigo continua no cadastro', async () => {
  const m = montar({ clientes: [{ ...EXISTENTE, mobilePhone: '63981411248' }] });
  const r = (await editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, telefone: '(63) 3321-4455' }, m.registrar)) as any;
  assert.deepEqual(m.f.posts()[0]!.corpo, { phone: '6333214455' });
  assert.match(r.atencao, /outro telefone.*CONTINUA/);
  const n = montar({ clientes: [{ ...EXISTENTE, mobilePhone: '63981411248' }] });
  const r2 = (await editarCliente(n.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, telefone: '(63) 99999-0000' }, n.registrar)) as any;
  assert.equal(r2.atencao, undefined, 'mesmo tipo: troca o campo e pronto');
});

test('teto por operação no nome antigo = 0 desliga o dinheiro pelo conector (transferência e estorno), com a instrução de como corrigir', async () => {
  const m = montar({ pagamentos: [{ ...PAGA }] }, { ...comDestinos, tetoOperacao: () => 0 });
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 1 }, m.registrar), /DESLIGAD[AO].*ASAAS_TETO_OPERACAO_REAIS/s);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, m.registrar), /DESLIGAD[AO]/);
  assert.equal(m.f.posts().length, 0);
});

test('asaas_cobranca (consulta): uma clínica só ("todas" e lista recusam); por referência ignora a cobrança apagada', async () => {
  const m = montar({ pagamentos: [{ ...PAGA, id: 'pay_apagada00001', deleted: true, externalReference: 'ref-1' }, { ...PAGA, externalReference: 'ref-1' }] });
  for (const u of ['todas', 'serra,maraba']) await assert.rejects(() => asaasCobranca(m.asaas, { unidade: u, cobrancaId: PAGA.id }), /UMA clínica/, u);
  const r = await asaasCobranca(m.asaas, { unidade: 'serra', externalReference: 'ref-1' });
  assert.equal(r.cobranca.id, PAGA.id);
  assert.equal(r.cobranca.statusDoAsaas, 'RECEIVED');
  await assert.rejects(() => asaasCobranca(m.asaas, { unidade: 'serra' }), /um dos dois/);
  await assert.rejects(() => asaasCobranca(m.asaas, { unidade: 'serra', cobrancaId: '../x' }), /cobrancaId inválido/);
});

test('registro do pedido de transferência: e-mail, chave aleatória (UUID), documento e telefone do destino não vão inteiros', () => {
  assert.equal(mascararDestinoDoPedido('contadora@exemplo.com'), 'c***@exemplo.com');
  assert.equal(mascararDestinoDoPedido('123e4567-e89b-12d3-a456-426614174000'), '123e4567…');
  assert.equal(mascararDestinoDoPedido('11.222.333/0001-81'), '[…]');
  assert.ok(!mascararDestinoDoPedido('+55 63 98141-1248').includes('98141'));
  assert.equal(mascararDestinoDoPedido('Fornecedor'), 'Fornecedor');
});

test('o nome da conta no Asaas é lido uma vez e guardado 10 minutos (uma leitura a menos em cada escrita); depois relê', async () => {
  const m = montar({}, comDestinos);
  const c = contaDeEscrita(m.asaas, m.esc, 'serra');
  await cabecalhoDaConta(c, m.esc);
  await cabecalhoDaConta(c, m.esc);
  assert.equal(m.f.gets.filter((g) => g === '/myAccount/commercialInfo').length, 1);
  m.relogio.t += 11 * 60_000;
  await cabecalhoDaConta(c, m.esc);
  assert.equal(m.f.gets.filter((g) => g === '/myAccount/commercialInfo').length, 2);
});

test('Telegram lento não segura a resposta: passado o prazo, a operação responde dizendo que o aviso NÃO foi confirmado', async () => {
  const m = montar({ pagamentos: [{ ...PENDENTE }] }, { alertar: () => new Promise<boolean>(() => undefined) });
  const t0 = Date.now();
  const r = (await cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, m.registrar)) as any;
  assert.equal(r.cancelada, true);
  assert.match(r.avisoNoTelegram, /NÃO ENVIADO/);
  assert.ok(Date.now() - t0 < 8000, 'respondeu depois de ~5 s, não ficou pendurado');
});

test('transferência e estorno: a intenção sai ANTES da chamada ao Asaas (nada tinha saído ainda) e o resultado depois', async () => {
  const m = montar({ pagamentos: [{ ...PAGA }] }, comDestinos);
  await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 50 }, m.registrar);
  await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 10 }, m.registrar);
  assert.deepEqual(m.intencoes.map((i) => [i.args.operacao, i.args.valor, i.args.chamadasAteAgora]), [['transferir', 50, 0], ['estornar_cobranca', 10, 1]]);
  assert.ok(m.intencoes.every((i) => i.args.incerto === true && typeof i.args.chave === 'string'));
  assert.deepEqual(m.eventos.map((e) => [e.args.operacao, e.ok]), [['transferir', true], ['estornar_cobranca', true]]);
});

test('interruptor antigo (ASAAS_COBRANCA_MAX_REAIS=0): TODA escrita da conta fica desligada — cancelar, editar e cadastrar também — com a instrução de como corrigir', async () => {
  const m = montar({ clientes: [EXISTENTE], pagamentos: [{ ...PENDENTE }] }, { ...comDestinos, tetoOperacao: () => 0 });
  await assert.rejects(() => cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, m.registrar), /DESLIGADA.*ASAAS_COBRANCA_MAX_REAIS.*ASAAS_TETO_OPERACAO_REAIS/s);
  await assert.rejects(() => editarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, vencimento: '2026-11-15' }, m.registrar), /DESLIGADA/);
  await assert.rejects(() => editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, nome: 'Outro Nome' }, m.registrar), /DESLIGADA/);
  await assert.rejects(() => criarCobranca(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, valor: 1, vencimento: '2026-11-10', descricao: 'x' }, m.registrar), /DESLIGADA/);
  assert.equal(m.f.chamadas.length, 0);
});


// ------------------------------------------------------------------ estorno parcial acumulado (achado do sênior no #194)

test('estorno parcial NÃO ignora os anteriores: R$ 800 pagos, 500 + 400 → o segundo é recusado; o restante é o que dá; "total" = o restante', async () => {
  const m = montar({ pagamentos: [{ ...PAGA }] });
  const unidade = 'serra';
  await estornarCobranca(m.ctx, Q, { unidade, cobrancaId: PAGA.id, valor: 500 }, m.registrar);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade, cobrancaId: PAGA.id, valor: 400 }, m.registrar), /passa do que ainda resta nesta cobrança: R\$ 300,00.*já estornado R\$ 500,00/s);
  assert.deepEqual(m.f.pagamentos[0]!.refunds!.map((r) => r.value), [500]);
  // "total" depois de um parcial devolve só o que resta, e diz isso no Telegram e nos tetos
  m.relogio.t += 11 * 60_000;
  const r = (await estornarCobranca(m.ctx, Q, { unidade, cobrancaId: PAGA.id }, m.registrar)) as any;
  assert.equal(r.cobranca.valorEstornado, 'R$ 300,00');
  assert.equal(r.cobranca.jaEstornadoAntes, 'R$ 500,00');
  assert.equal(r.cobranca.aindaRestaDevolver, 'R$ 0,00');
  assert.deepEqual(m.f.posts().at(-1)!.corpo, { value: 300 }, 'o corpo leva o valor do restante, não "tudo"');
  assert.match(m.avisos.at(-1)!, /Valor: R\$ 300,00/);
  assert.match(m.avisos.at(-1)!, /ESTORNO PARCIAL \(cobrança de R\$ 800,00, já estornado R\$ 500,00\)/);
  assert.equal(await totais(m), 500 + 300, 'o teto do dia conta o que saiu de verdade');
  // tudo devolvido: não há o que estornar
  m.relogio.t += 11 * 60_000;
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade, cobrancaId: PAGA.id }, m.registrar), /já foi estornada por inteiro|só cobrança RECEBIDA/);
});

test('estorno: os estornos anteriores vêm da lista do Asaas E do campo da cobrança (vale o maior); estorno cancelado não conta; lista ilegível = não estorna', async () => {
  const lista = montar({ pagamentos: [{ ...PAGA }] });
  lista.f.pagamentos[0]!.refunds = [{ value: 600 }];
  await assert.rejects(() => estornarCobranca(lista.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 300 }, lista.registrar), /resta nesta cobrança: R\$ 200,00/);
  // a rota de lista dá 404: ainda vale o campo `refunds` da cobrança
  const so404 = montar({ pagamentos: [{ ...PAGA, refunds: [{ value: 600 }] }], falhas: [{ metodo: 'GET', caminho: /refunds$/, erro: new ErroHttp('Asaas 404', 404) }] });
  await assert.rejects(() => estornarCobranca(so404.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 300 }, so404.registrar), /resta nesta cobrança: R\$ 200,00/);
  const cancelado = montar({ pagamentos: [{ ...PAGA, refunds: [{ value: 600, status: 'CANCELLED' } as never] }] });
  assert.equal(((await estornarCobranca(cancelado.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 800 }, cancelado.registrar)) as any).estornado, true);
  // a rota de lista falha (500, 400, 405…) mas a cobrança trouxe o campo `refunds`: vale o campo (o maior dos dois que se conhece)
  for (const status of [500, 400, 405]) {
    const comCampo = montar({ pagamentos: [{ ...PAGA, refunds: [{ value: 600 }] }], falhas: [{ metodo: 'GET', caminho: /refunds$/, erro: new ErroHttp(`Asaas ${status}`, status) }] });
    await assert.rejects(() => estornarCobranca(comCampo.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 300 }, comCampo.registrar), /resta nesta cobrança: R\$ 200,00/, String(status));
  }
  // lista falhou E o campo não veio: não sabe o que já saiu, não estorna
  const ilegivel = montar({ semCampoRefunds: true, pagamentos: [{ ...PAGA }], falhas: [{ metodo: 'GET', caminho: /refunds$/, erro: new ErroHttp('Asaas 500', 500) }] });
  await assert.rejects(() => estornarCobranca(ilegivel.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, ilegivel.registrar), /não consegui conferir os estornos anteriores/);
  assert.equal(ilegivel.f.posts().length, 0);
  // 401 continua sendo "chave recusada", não vira erro genérico de entrada
  const chaveRuim = montar({ pagamentos: [{ ...PAGA }], falhas: [{ metodo: 'GET', caminho: /refunds$/, erro: new ErroHttp('o Asaas recusou a chave (401)', 401) }] });
  await assert.rejects(() => estornarCobranca(chaveRuim.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, chaveRuim.registrar), /recusou a chave/);
});

// ------------------------------------------------------------------ tetos próprios de estorno e de transferência

test('estorno e transferência têm teto PRÓPRIO (padrão 500 por operação e 2000 por dia), cada um por si; o geral continua valendo', async () => {
  const proprio = { tetoEspecifico: () => ({ operacao: 500, dia: 2000 }) };
  const m = montar({ pagamentos: [{ ...PAGA, value: 3000 }, { ...PAGA, id: 'pay_paga00000002', value: 3000 }, { ...PAGA, id: 'pay_paga00000003', value: 3000 }, { ...PAGA, id: 'pay_paga00000004', value: 3000 }, { ...PAGA, id: 'pay_paga00000005', value: 3000 }] }, { ...comDestinos, ...proprio });
  // por operação
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 500.01 }, m.registrar), /teto de R\$ 500,00 por estorno \(ASAAS_TETO_ESTORNO_OPERACAO_REAIS\)/);
  await assert.rejects(() => transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 500.01 }, m.registrar), /teto de R\$ 500,00 por transferência \(ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS\)/);
  // por dia, cada tipo por si: 4 x 500 de estorno enche os 2000 do estorno e NÃO tira nada da transferência
  for (let i = 1; i <= 4; i++) await estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: i === 1 ? PAGA.id : `pay_paga0000000${i}`, valor: 500 }, m.registrar);
  await assert.rejects(() => estornarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: 'pay_paga00000005', valor: 1 }, m.registrar), /teto do dia para estorno.*ASAAS_TETO_ESTORNO_DIA_REAIS/s);
  for (const [i, v] of [10, 20, 30, 40].entries()) await transferir(m.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 400 + v + i }, m.registrar);
  assert.equal(await m.usado('estorno'), 2000);
  assert.equal(await m.usado('transferencia'), 400 * 4 + 10 + 20 + 30 + 40 + 0 + 1 + 2 + 3);
  // o geral continua valendo por cima: soma de tudo
  const geral = montar({ pagamentos: [{ ...PAGA }] }, { ...comDestinos, ...proprio, tetoDia: () => 600 });
  await transferir(geral.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 400 }, geral.registrar);
  await assert.rejects(() => estornarCobranca(geral.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id, valor: 201 }, geral.registrar), /teto do dia desta chave do Asaas/);
  // estorno e transferência: a recusa não grava nada nem avisa
  assert.equal(m.avisos.filter((a) => /TRANSFERÊNCIA$|ESTORNO$/m.test(a)).length, 8);
});

test('os tetos próprios lidos do AMBIENTE de verdade: sem variável = 500/2000; com variável sobe; o menor com o geral manda', async () => {
  const chaves = ['ASAAS_TETO_ESTORNO_OPERACAO_REAIS', 'ASAAS_TETO_ESTORNO_DIA_REAIS', 'ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS', 'ASAAS_TETO_TRANSFERENCIA_DIA_REAIS', 'ASAAS_TETO_OPERACAO_REAIS', 'ASAAS_TETO_DIA_REAIS', 'ASAAS_COBRANCA_MAX_REAIS'];
  const antes = chaves.map((k) => process.env[k]);
  chaves.forEach((k) => delete process.env[k]);
  try {
    const f = montar({}, { destinos: comDestinos.destinos, tetoEspecifico: undefined });
    // `tetoEspecifico: undefined` deixa o padrão de produção (lê o ambiente)
    await assert.rejects(() => transferir(f.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 500.01 }, f.registrar), /por transferência \(ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS\)/);
    process.env.ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS = '900';
    assert.equal(((await transferir(f.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 900 }, f.registrar)) as any).transferido, true);
    process.env.ASAAS_TETO_OPERACAO_REAIS = '300'; // o geral é menor: manda
    await assert.rejects(() => transferir(f.ctx, Q, { unidade: 'serra', destino: 'fornecedor', valor: 301 }, f.registrar), /teto de R\$ 300,00 por operação \(ASAAS_TETO_OPERACAO_REAIS\)/);
  } finally {
    chaves.forEach((k, i) => (antes[i] === undefined ? delete process.env[k] : (process.env[k] = antes[i])));
  }
});

test('cancelar em massa não passa: limite de cancelamentos por hora (padrão 10) por chave do Asaas, valendo entre instâncias; passada a hora, libera', async () => {
  const ids = Array.from({ length: 14 }, (_, i) => `pay_pendente${String(i).padStart(4, '0')}`);
  const pagamentos = ids.map((id) => ({ ...PENDENTE, id }));
  const banco = new BancoFalso();
  const A = montar({ pagamentos: pagamentos.map((p) => ({ ...p })) }, { banco });
  const B = montar({ pagamentos: pagamentos.map((p) => ({ ...p })) }, { banco });
  // alternando as duas instâncias: as 10 primeiras passam, a 11ª em diante não
  const feitos: string[] = [];
  for (const [i, id] of ids.entries()) {
    const m = i % 2 ? B : A;
    try {
      await cancelarCobranca(m.ctx, Q, { unidade: 'serra', cobrancaId: id }, m.registrar);
      feitos.push(id);
    } catch (e) {
      assert.match(String(e), /limite de 10 cancelamentos por hora nesta chave do Asaas/);
    }
  }
  assert.equal(feitos.length, 10);
  assert.equal(A.f.posts().length + B.f.posts().length, 10);
  assert.equal(A.avisos.length + B.avisos.length, 10, 'a recusa não avisa nem cancela');
  // passada a hora, libera
  A.relogio.t += 61 * 60_000;
  B.relogio.t = A.relogio.t;
  assert.equal(((await cancelarCobranca(A.ctx, Q, { unidade: 'serra', cobrancaId: ids[10]! }, A.registrar)) as any).cancelada, true);
  // um cancelamento que o Asaas recusa de vez (4xx) NÃO gasta a cota da hora
  const ruim = montar({ pagamentos: [{ ...PENDENTE }], falhas: [{ metodo: 'DELETE', caminho: /payments/, erro: new ErroHttp('Asaas 400: não pode', 400) }] });
  for (let i = 0; i < 12; i++) await assert.rejects(() => cancelarCobranca(ruim.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id }, ruim.registrar), /não pode/);
  // e o limite sobe por variável
  const dois = montar({ pagamentos: pagamentos.map((p) => ({ ...p })) }, { cancelamentosPorHora: () => 2 });
  await cancelarCobranca(dois.ctx, Q, { unidade: 'serra', cobrancaId: ids[0]! }, dois.registrar);
  await cancelarCobranca(dois.ctx, Q, { unidade: 'serra', cobrancaId: ids[1]! }, dois.registrar);
  await assert.rejects(() => cancelarCobranca(dois.ctx, Q, { unidade: 'serra', cobrancaId: ids[2]! }, dois.registrar), /limite de 2 cancelamentos por hora/);
});

test('editar cliente avisa o João (e-mail, telefone e aviso automático são o caminho de um desvio de cobrança); editar cobrança só avisa quando o valor SOBE', async () => {
  const m = montar({ clientes: [{ ...EXISTENTE }] });
  const r = (await editarCliente(m.ctx, Q, { unidade: 'serra', clienteId: EXISTENTE.id, email: 'novo@exemplo.com', avisarCliente: true }, m.registrar)) as any;
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /CLIENTE EDITADO/);
  assert.match(m.avisos[0]!, /campos alterados: email, avisos automáticos/);
  assert.ok(!m.avisos[0]!.includes('novo@exemplo.com'), 'o e-mail novo não vai inteiro ao Telegram');
  assert.equal(r.avisoNoTelegram, 'enviado ao João');
  const n = montar({ pagamentos: [{ ...PENDENTE, value: 4900 }] });
  await editarCobranca(n.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 3000 }, n.registrar);
  assert.equal(n.avisos.length, 0, 'reduzir o valor não é alarme');
  await editarCobranca(n.ctx, Q, { unidade: 'serra', cobrancaId: PENDENTE.id, valor: 3100 }, n.registrar);
  assert.equal(n.avisos.length, 1, 'subir para mais da metade do teto avisa');
});

test('estornos anteriores: rota de lista fora do ar e cobrança com refunds NULO (não sei o que já saiu) = não estorna; com a lista vazia no campo, estorna', async () => {
  const nulo = montar({ pagamentos: [{ ...PAGA }], falhas: [{ metodo: 'GET', caminho: /refunds$/, erro: new ErroHttp('Asaas 503', 503) }] });
  const get = nulo.f.conta.fonte.get.bind(nulo.f.conta.fonte);
  (nulo.f.conta.fonte as { get: unknown }).get = async (caminho: string, q: Record<string, any>) => (caminho === `/payments/${PAGA.id}` ? { ...(await get(caminho, q) as object), refunds: null } : get(caminho, q));
  await assert.rejects(() => estornarCobranca(nulo.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, nulo.registrar), /não consegui conferir os estornos anteriores/);
  assert.equal(nulo.f.posts().length, 0);
  const vazio = montar({ pagamentos: [{ ...PAGA }], falhas: [{ metodo: 'GET', caminho: /refunds$/, erro: new ErroHttp('Asaas 503', 503) }] });
  assert.equal(((await estornarCobranca(vazio.ctx, Q, { unidade: 'serra', cobrancaId: PAGA.id }, vazio.registrar)) as any).estornado, true);
});
