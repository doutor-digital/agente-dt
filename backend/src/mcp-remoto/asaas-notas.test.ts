import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { rotaPermitida } from '../lib/integracoes/asaas-escrita.js';
import { registrarEscritaAsaasSePermitido } from './asaas-ferramentas.js';
import { ErroHttp, montar, type Cli, type Nf, type Pg } from './asaas-falso.js';
import { asaasDadosFiscais, asaasNota, asaasNotas, registrarLeituraNotasAsaas } from './asaas-notas.js';
import { confirmarNota, EVENTO_NOTA, prepararNota, type PedidoDePreparo } from './asaas-notas-escrita.js';

const Q = { id: 'u1', email: 'joao@exemplo.com' };
const OUTRO = { id: 'u2', email: 'ana@exemplo.com' };
const CPF_DIGITOS = '52998224725';
const CLIENTE: Cli = { id: 'cus_000005401844', name: 'Maria da Silva', cpfCnpj: CPF_DIGITOS, email: 'maria.silva@exemplo.com', postalCode: '77000000', address: 'Rua A', addressNumber: '10' };
const COBRANCA: Pg = { id: 'pay_nota00000001', customer: CLIENTE.id, status: 'RECEIVED', value: 250, description: 'Consulta de avaliação' };
const AUTORIZADA: Nf = { id: 'inv_000000000232', status: 'AUTHORIZED', customer: CLIENTE.id, payment: COBRANCA.id, value: 250, deductions: 0, effectiveDate: '2026-10-20', number: '1234', serviceDescription: 'Consulta de avaliação com texto longo '.repeat(10), pdfUrl: 'https://www.asaas.com/i/nf.pdf', xmlUrl: 'https://www.asaas.com/i/nf.xml', municipalServiceCode: '4.01', municipalServiceName: 'Medicina', taxes: { iss: 3 } };
// "hoje" no Asaas falso é 28/10/2026 (AGORA)
const EMITIR: PedidoDePreparo = { unidade: 'serra', acao: 'emitir', cobrancaId: COBRANCA.id, servico: '4.01', dataEmissao: '2026-10-30', impostos: { retemIss: false, inss: 0, ir: 0 } };

const base = (o: Parameters<typeof montar>[0] = {}, op: Parameters<typeof montar>[1] = {}) => montar({ clientes: [CLIENTE], pagamentos: [{ ...COBRANCA }], ...o }, op);
type M = ReturnType<typeof montar>;
const preparar = (m: M, p: Partial<PedidoDePreparo> = {}, quem = Q) => prepararNota(m.ctx, quem, { ...EMITIR, ...p } as PedidoDePreparo) as Promise<any>;
const confirmar = (m: M, codigo: string, quem = Q) => confirmarNota(m.ctx, quem, { confirmacao: codigo }, m.registrar) as Promise<any>;
const tudo = (x: unknown) => JSON.stringify(x);
const recusa = async (p: Promise<unknown>, re: RegExp) => assert.rejects(p, re);

// ------------------------------------------------------------------ leitura

test('leitura: asaas_notas filtra pelos nomes da doc do Asaas, traduz o status, traz tomador, PDF e XML e soma por status', async () => {
  const m = base({ notas: [AUTORIZADA, { ...AUTORIZADA, id: 'inv_000000000233', status: 'ERROR', statusDescription: 'Inscrição municipal inválida', number: null, pdfUrl: null, xmlUrl: null, value: 100, effectiveDate: '2026-10-22' }, { ...AUTORIZADA, id: 'inv_000000000234', effectiveDate: '2026-09-01' }] });
  const r = await asaasNotas(m.asaas, { unidade: 'serra', inicio: '2026-10-01', fim: '2026-10-31' });
  const q = m.f.consultas.find((c) => c.caminho === '/invoices')!.query;
  assert.equal(q['effectiveDate[Ge]'], '2026-10-01');
  assert.equal(q['effectiveDate[Le]'], '2026-10-31');
  assert.equal(q.limit, 100);
  assert.equal(r.notas, 2);
  assert.equal(r.valor, 350);
  assert.deepEqual(r.porStatus['emitida'], { quantidade: 1, valor: 250 });
  assert.deepEqual(r.porStatus['erro na emissão'], { quantidade: 1, valor: 100 });
  const emitida = r.itens.find((i) => i.id === AUTORIZADA.id)!;
  assert.equal(emitida.numero, '1234');
  assert.equal(emitida.status, 'emitida');
  assert.equal(emitida.tomador.nome, 'Maria da Silva');
  assert.equal(emitida.pdf, 'https://www.asaas.com/i/nf.pdf');
  assert.equal(emitida.xml, 'https://www.asaas.com/i/nf.xml');
  assert.ok((emitida.descricao ?? '').length <= 120, 'descrição curta na lista');
  const erro = r.itens.find((i) => i.id === 'inv_000000000233')!;
  assert.equal(erro.motivoDoStatus, 'Inscrição municipal inválida');
  // por cobrança e por status: filtros que a doc oficial chama de payment e status
  await asaasNotas(m.asaas, { unidade: 'serra', cobrancaId: COBRANCA.id, status: 'AUTHORIZED' });
  const q2 = m.f.consultas.filter((c) => c.caminho === '/invoices')[1]!.query;
  assert.equal(q2.payment, COBRANCA.id);
  assert.equal(q2.status, 'AUTHORIZED');
  assert.equal(m.f.posts().length, 0, 'leitura nunca escreve');
});

test('leitura: asaas_notas exige um filtro, valida os campos e é de UMA clínica', async () => {
  const m = base({ notas: [AUTORIZADA] });
  await recusa(asaasNotas(m.asaas, { unidade: 'serra' }), /pelo menos um filtro/);
  await recusa(asaasNotas(m.asaas, { unidade: 'serra', inicio: '2026-10-31', fim: '2026-10-01' }), /fim antes do início/);
  await recusa(asaasNotas(m.asaas, { unidade: 'serra', status: 'PAGA' }), /status "PAGA" não existe/);
  await recusa(asaasNotas(m.asaas, { unidade: 'serra', cobrancaId: 'abc' }), /cobrancaId inválido/);
  await recusa(asaasNotas(m.asaas, { unidade: 'todas', status: 'ERROR' }), /UMA clínica/);
  const vazio = await asaasNotas(m.asaas, { unidade: 'serra', status: 'CANCELED' });
  assert.equal(vazio.notas, 0);
  assert.match(String((vazio as { aviso?: string }).aviso), /asaas_dados_fiscais/);
});

test('leitura: asaas_nota devolve a nota completa, com o documento do tomador mascarado; id ruim e nota inexistente têm mensagem clara', async () => {
  const m = base({ notas: [{ ...AUTORIZADA, observations: 'Obs da nota', rpsNumber: '77', validationCode: 'ABC123' }] });
  const r = (await asaasNota(m.asaas, { unidade: 'serra', notaId: AUTORIZADA.id })) as any;
  assert.equal(r.nota.numero, '1234');
  assert.equal(r.nota.observacoes, 'Obs da nota');
  assert.deepEqual(r.nota.impostos, { iss: 3 });
  assert.equal(r.nota.codigoDeVerificacao, 'ABC123');
  assert.equal(r.nota.tomador.nome, 'Maria da Silva');
  assert.equal(r.nota.tomador.documento, '***.***.247-**');
  assert.ok(!tudo(r).includes(CPF_DIGITOS) && !tudo(r).includes('maria.silva'), 'documento ou e-mail inteiro na resposta');
  assert.ok(r.nota.descricao.length > 120, 'completa traz a descrição inteira');
  await recusa(asaasNota(m.asaas, { unidade: 'serra', notaId: 'inv_naoexiste99' }), /não existe nesta conta/);
  await recusa(asaasNota(m.asaas, { unidade: 'serra', notaId: 'pay_123456789' }), /notaId inválido/);
});

test('dados fiscais: clínica com cadastro mostra regime e serviços, sem usuário, e-mail nem inscrição da prefeitura', async () => {
  const m = base();
  const r = (await asaasDadosFiscais(m.asaas, { unidade: 'serra' })) as any;
  assert.equal(r.dadosFiscaisCadastrados, true);
  assert.equal(r.dados.simplesNacional, true);
  assert.equal(r.dados.inscricaoMunicipalCadastrada, true);
  assert.deepEqual(r.dados.acessoDaPrefeitura, { certificado: true, senha: false, token: false });
  assert.equal(r.prefeituraAceitaCancelarPelaIntegracao, true);
  assert.equal(r.servicosMunicipais.disponivel, true);
  assert.deepEqual(r.servicosMunicipais.servicos.map((s: any) => [s.id, s.issPercentual]), [['3544', 2], ['2360', 3]]);
  const texto = tudo(r);
  for (const proibido of ['usuario-da-prefeitura', 'fiscal@clinica.com.br', '21779501']) assert.ok(!texto.includes(proibido), `vazou: ${proibido}`);
  const filtrado = (await asaasDadosFiscais(m.asaas, { unidade: 'serra', servico: 'medicina' })) as any;
  assert.deepEqual(filtrado.servicosMunicipais.servicos.map((s: any) => s.id), ['2360']);
});

test('dados fiscais: clínica SEM cadastro fiscal (404 do Asaas) responde em português, não com erro cru', async () => {
  const m = base({ semDadoFiscal: true });
  const r = (await asaasDadosFiscais(m.asaas, { unidade: 'serra' })) as any;
  assert.equal(r.dadosFiscaisCadastrados, false);
  assert.equal(r.podeEmitirNota, false);
  assert.match(r.motivo, /AINDA NÃO tem informações fiscais cadastradas no Asaas/);
  assert.ok(!/404|Asaas 404/.test(r.motivo), 'erro cru da API');
});

test('serviços municipais: um 400 que NÃO é "sem lista" é erro de verdade, não vira o caminho do código à mão', async () => {
  const m = base({ falhas: [{ metodo: 'GET', caminho: /^\/fiscalInfo\/services$/, erro: new ErroHttp('Asaas 400 em /fiscalInfo/services: parâmetro limit inválido', 400) }] });
  await recusa(asaasDadosFiscais(m.asaas, { unidade: 'serra' }), /parâmetro limit inválido/);
  await recusa(preparar(m), /parâmetro limit inválido/);
  assert.equal(m.esc.notas.pendentes, 0);
});

test('leitura: o período também é conferido do nosso lado, mesmo se o Asaas ignorasse o filtro de data', async () => {
  const m = base({ notas: [AUTORIZADA, { ...AUTORIZADA, id: 'inv_000000000900', effectiveDate: '2026-03-01' }] });
  // o falso aplica o filtro; aqui ele é "esquecido" para provar que o total não sai de outro mês
  const original = m.f.conta.fonte.get.bind(m.f.conta.fonte);
  m.f.conta.fonte.get = (async (caminho: string, query: Record<string, string | number | undefined> = {}) => original(caminho, caminho === '/invoices' ? { offset: query.offset, limit: query.limit } : query)) as typeof m.f.conta.fonte.get;
  const r = await asaasNotas(m.asaas, { unidade: 'serra', inicio: '2026-10-01', fim: '2026-10-31' });
  assert.equal(r.notas, 1);
  assert.equal(r.itens[0]!.id, AUTORIZADA.id);
});

test('dados fiscais: prefeitura / Portal Nacional sem lista de serviços avisa que o código vai à mão; sem acesso à prefeitura avisa', async () => {
  const m = base({ semListaDeServicos: true, dadoFiscal: { certificateSent: false } });
  const r = (await asaasDadosFiscais(m.asaas, { unidade: 'serra' })) as any;
  assert.equal(r.servicosMunicipais.disponivel, false);
  assert.match(r.servicosMunicipais.motivo, /informe o CÓDIGO do serviço/);
  assert.match(r.atencao, /nenhum acesso à prefeitura/);
});

// ------------------------------------------------------------------ preparar: NÃO escreve

test('preparar emitir: devolve o resumo COMPLETO e o código, e NÃO chama o Asaas para escrever', async () => {
  const m = base();
  const r = await preparar(m, { deducoes: 20, observacoes: 'Ref. outubro' });
  assert.equal(m.f.posts().length, 0, 'preparar escreveu no Asaas');
  assert.equal(m.f.notas.length, 0);
  assert.equal(m.esc.notas.pendentes, 1);
  assert.match(r.confirmacao, /^[0-9A-F]{12}$/);
  assert.match(r.instrucao, /NADA foi emitido nem gravado/);
  const x = r.resumo;
  assert.equal(x.clinica.unidade, 'doutor-hernia-serra');
  assert.equal(x.clinica.nomeDaConta, 'Clínica Serra Saúde LTDA');
  assert.equal(x.tomador.nome, 'Maria da Silva');
  assert.equal(x.tomador.documento, '***.***.247-**');
  assert.equal(x.tomador.enderecoCadastrado, true);
  assert.equal(x.valorDaNota, 'R$ 250,00');
  assert.equal(x.deducoes, 'R$ 20,00');
  assert.equal(x.baseDeCalculoDoIss, 'R$ 230,00');
  assert.equal(x.servicoMunicipal.id, '2360');
  assert.equal(x.servicoMunicipal.issCadastradoNaPrefeitura, '3%');
  assert.deepEqual(x.impostos.iss, { valor: '3%', origem: 'cadastro do serviço na prefeitura (Asaas)' });
  assert.equal(x.impostos.retemIss.valor, 'não');
  assert.match(x.impostos.pis.origem, /Simples Nacional/);
  assert.equal(x.descricaoDosServicos, 'Consulta de avaliação');
  assert.equal(x.observacoes, 'Ref. outubro');
  assert.equal(x.dataDeEmissao, '30/10/2026');
  assert.match(x.quandoSai, /AGENDADA/);
  assert.ok(!tudo(r).includes(CPF_DIGITOS) && !tudo(r).includes('maria.silva@exemplo.com'), 'documento ou e-mail inteiro no resumo');
  assert.deepEqual(m.avisos, [], 'preparar não avisa o Telegram');
  assert.equal(m.eventos.filter((e) => e.evento === EVENTO_NOTA).length, 0, 'preparar não registra operação');
});

test('preparar emitir: clínica SEM dado fiscal recusa em português, sem preparar nada', async () => {
  const m = base({ semDadoFiscal: true });
  await recusa(preparar(m), /AINDA NÃO tem informações fiscais cadastradas no Asaas/);
  assert.equal(m.esc.notas.pendentes, 0);
  assert.equal(m.f.posts().length, 0);
});

test('preparar emitir: NUNCA inventa imposto — retenção, INSS e IR só vêm da pessoa; no regime normal PIS/COFINS/CSLL também', async () => {
  const m = base();
  await recusa(preparar(m, { impostos: undefined }), /faltam dados fiscais que eu NÃO posso supor: retemIss .*inss .*ir /s);
  await recusa(preparar(m, { impostos: { retemIss: true } }), /inss .*; ir /s);
  assert.equal(m.esc.notas.pendentes, 0);
  const normal = base({ dadoFiscal: { simplesNacional: false } });
  await recusa(preparar(normal), /pis .*cofins .*csll .*não é do Simples Nacional/s);
  const ok = await preparar(normal, { impostos: { retemIss: false, inss: 0, ir: 1.5, pis: 0.65, cofins: 3, csll: 1 } });
  assert.deepEqual(ok.resumo.impostos.ir, { valor: '1,5%', origem: 'informado por quem pediu' });
  assert.equal(ok.resumo.impostos.cofins.valor, '3%');
  // regime desconhecido também não presume zero
  const desconhecido = base({ dadoFiscal: { simplesNacional: undefined } });
  await recusa(preparar(desconhecido), /não tem o regime identificado/);
});

test('preparar emitir: Simples Nacional não aceita PIS/COFINS/CSLL diferente de 0; ISS informado diferente do da prefeitura é avisado; alíquota ruim é recusada', async () => {
  const m = base();
  await recusa(preparar(m, { impostos: { retemIss: false, inss: 0, ir: 0, pis: 0.65 } }), /Simples Nacional, regime em que PIS não se aplica/);
  const r = await preparar(m, { impostos: { retemIss: false, inss: 0, ir: 0, iss: 5 } });
  assert.equal(r.resumo.impostos.iss.valor, '5%');
  assert.ok(r.avisos.some((x: string) => /DIFERENTE da alíquota cadastrada na prefeitura/.test(x)));
  await recusa(preparar(m, { impostos: { retemIss: false, inss: 0, ir: 150 } }), /ir: informe a alíquota em %/);
  await recusa(preparar(m, { impostos: { retemIss: false, inss: 0, ir: 1.123456 } }), /no máximo 4 casas/);
});

test('preparar emitir: serviço municipal nunca é palpite — inexistente e ambíguo recusam com as opções; sem lista, só o código à mão', async () => {
  const m = base({ servicos: [{ id: '10', description: '4.01 - Medicina', issTax: 3 }, { id: '11', description: '4.011 - Medicina do trabalho', issTax: 3 }, { id: '12', description: '5.02 - Veterinária', issTax: 2 }] });
  await recusa(preparar(m, { servico: undefined }), /informe o serviço municipal/);
  await recusa(preparar(m, { servico: 'odontologia' }), /não existe na lista desta prefeitura\. Opções: 10: 4\.01/);
  await recusa(preparar(m, { servico: 'medicina' }), /é ambíguo/);
  // o código exato e o id exato escolhem UM
  assert.equal((await preparar(m, { servico: '4.01' })).resumo.servicoMunicipal.id, '10');
  assert.equal((await preparar(m, { servico: '12' })).resumo.servicoMunicipal.id, '12');
  assert.equal(m.f.posts().length, 0);

  const semLista = base({ semListaDeServicos: true });
  await recusa(preparar(semLista, { servico: 'medicina' }), /não tem a lista de serviços municipais .* informe o CÓDIGO/s);
  await recusa(preparar(semLista, { servico: 'medicina' }), /Nada foi preparado/);
  // sem lista, o ISS não vem da prefeitura: a pessoa informa
  await recusa(preparar(semLista, { servico: '4.01' }), /iss \(alíquota do ISS em %; a prefeitura desta conta não informa\)/);
  const ok = await preparar(semLista, { servico: '4.01', nomeDoServico: 'Serviços médicos', impostos: { retemIss: false, iss: 2, inss: 0, ir: 0 } });
  assert.deepEqual(ok.resumo.servicoMunicipal, { codigo: '4.01', nome: 'Serviços médicos', origem: 'código informado por quem pediu (esta conta não tem lista da prefeitura)' });
});

test('preparar emitir: valor, descrição, data e origem são conferidos (e a cobrança alheia/inexistente não vira nota)', async () => {
  const m = base();
  await recusa(preparar(m, { cobrancaId: undefined }), /cobrancaId \(pay_…\) OU clienteId/);
  await recusa(preparar(m, { clienteId: CLIENTE.id }), /um dos dois/);
  await recusa(preparar(m, { notaId: 'inv_000000000232' }), /notaId é só para cancelar/);
  await recusa(preparar(m, { cobrancaId: 'pay_naoexiste1' }), /não existe nesta conta/);
  await recusa(preparar(m, { dataEmissao: undefined }), /informe a data de emissão/);
  await recusa(preparar(m, { dataEmissao: '2026-10-27' }), /já passou/);
  await recusa(preparar(m, { dataEmissao: '2027-03-01' }), /passa de 90 dias/);
  await recusa(preparar(m, { emitirAgora: true, dataEmissao: '2026-10-30' }), /emitirAgora emite HOJE/);
  await recusa(preparar(m, { deducoes: 250 }), /deduções .* menores que o valor/);
  await recusa(preparar(m, { descricao: 'Consulta do paciente CPF 529.982.247-25' }), /11 ou mais dígitos seguidos/);
  // sem descrição na cobrança nem no pedido
  const semDesc = base({ pagamentos: [{ ...COBRANCA, description: undefined }] });
  await recusa(preparar(semDesc), /informe a descrição dos serviços/);
  // nota avulsa: não há cobrança de onde copiar o valor
  await recusa(preparar(m, { cobrancaId: undefined, clienteId: CLIENTE.id, descricao: 'Consulta' }), /informe o valor da nota/);
  const avulsa = await preparar(m, { cobrancaId: undefined, clienteId: CLIENTE.id, descricao: 'Consulta', valor: 180, emitirAgora: true, dataEmissao: undefined });
  assert.equal(avulsa.resumo.valorDaNota, 'R$ 180,00');
  assert.deepEqual(avulsa.resumo.origem, { notaAvulsaParaOCliente: CLIENTE.id });
  assert.match(avulsa.resumo.quandoSai, /AGORA/);
  assert.equal(avulsa.resumo.dataDeEmissao, '28/10/2026');
  // valor diferente do da cobrança é avisado
  const dif = await preparar(m, { valor: 200 });
  assert.ok(dif.avisos.some((x: string) => /DIFERENTE do valor da cobrança/.test(x)));
  assert.equal(m.f.posts().length, 0);
});

test('preparar emitir: nota REPETIDA da mesma cobrança é avisada (cancelada e com erro não contam)', async () => {
  const m = base({ notas: [AUTORIZADA, { ...AUTORIZADA, id: 'inv_000000000299', status: 'CANCELED' }, { ...AUTORIZADA, id: 'inv_000000000298', status: 'ERROR' }] });
  const r = await preparar(m);
  assert.match(r.avisos[0], /ATENÇÃO, NOTA REPETIDA/);
  assert.match(r.avisos[0], /inv_000000000232/);
  assert.ok(!r.avisos[0].includes('inv_000000000299') && !r.avisos[0].includes('inv_000000000298'));
  // cancelamento NEGADO: a nota continua valendo; status que o Asaas criar amanhã também conta como ativo (a lista é de quem NÃO vale)
  for (const status of ['CANCELLATION_DENIED', 'SYNCHRONIZED', 'WAITING_OVERDUE_PAYMENT']) {
    const viva = base({ notas: [{ ...AUTORIZADA, status }] });
    assert.match((await preparar(viva)).avisos[0], /ATENÇÃO, NOTA REPETIDA/, status);
  }
  const limpa = base({ notas: [{ ...AUTORIZADA, status: 'CANCELED' }] });
  assert.ok(!(await preparar(limpa)).avisos.some((x: string) => /REPETIDA/.test(x)));
  // nota avulsa: repetida é a do mesmo cliente, mesmo valor, mesma data
  const avulsa = base({ notas: [{ ...AUTORIZADA, payment: undefined, effectiveDate: '2026-10-30', value: 180 }] });
  const a = await preparar(avulsa, { cobrancaId: undefined, clienteId: CLIENTE.id, descricao: 'Consulta', valor: 180 });
  assert.match(a.avisos[0], /ATENÇÃO, NOTA REPETIDA/);
  const outroValor = await preparar(avulsa, { cobrancaId: undefined, clienteId: CLIENTE.id, descricao: 'Consulta', valor: 181 });
  assert.ok(!outroValor.avisos.some((x: string) => /REPETIDA/.test(x)));
});

test('preparar emitir: tomador sem documento ou sem endereço é avisado', async () => {
  const m = base({ clientes: [{ ...CLIENTE, cpfCnpj: '', address: undefined }] });
  const r = await preparar(m);
  assert.ok(r.avisos.some((x: string) => /não tem CPF\/CNPJ/.test(x)));
  assert.ok(r.avisos.some((x: string) => /não tem endereço completo/.test(x)));
});

// ------------------------------------------------------------------ confirmar: escreve UMA vez

test('confirmar emitir (agendada): chama o Asaas UMA vez, com o corpo certo; código reusado é recusado; avisa o Telegram e registra', async () => {
  const m = base();
  const { confirmacao } = await preparar(m, { observacoes: 'Ref. outubro', deducoes: 10 });
  assert.equal(m.f.posts().length, 0);
  const r = await confirmar(m, confirmacao);
  assert.equal(m.f.posts().length, 1, 'uma chamada só');
  const [p] = m.f.posts();
  assert.deepEqual([p!.metodo, p!.caminho], ['POST', '/invoices']);
  const corpo = p!.corpo!;
  assert.equal(corpo.payment, COBRANCA.id);
  assert.equal(corpo.customer, undefined);
  assert.equal(corpo.value, 250);
  assert.equal(corpo.deductions, 10);
  assert.equal(corpo.effectiveDate, '2026-10-30');
  assert.equal(corpo.municipalServiceId, '2360');
  assert.equal(corpo.municipalServiceCode, undefined);
  assert.equal(corpo.municipalServiceName, '4.01 - Medicina e biomedicina');
  assert.equal(corpo.serviceDescription, 'Consulta de avaliação');
  assert.equal(corpo.observations, 'Ref. outubro');
  assert.deepEqual(corpo.taxes, { retainIss: false, iss: 3, inss: 0, ir: 0, pis: 0, cofins: 0, csll: 0 });
  assert.equal(corpo.updatePayment, undefined, 'não mexe no valor da cobrança');
  assert.equal(corpo.externalReference, `dd-nf-${confirmacao.toLowerCase()}`);
  assert.equal(r.notaCriada, true);
  assert.equal(r.nota.status, 'agendada (ainda não emitida)');
  assert.equal(r.nota.tomador.nome, 'Maria da Silva');
  assert.equal(m.f.notas.length, 1);
  // aviso ao João, sem dado pessoal
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /NOTA FISCAL AGENDADA/);
  assert.match(m.avisos[0]!, /Valor: R\$ 250,00/);
  assert.match(m.avisos[0]!, /joao@exemplo\.com/);
  assert.ok(!m.avisos[0]!.includes('Maria') && !m.avisos[0]!.includes(CPF_DIGITOS), 'dado do paciente no Telegram');
  assert.equal(r.avisoNoTelegram, 'enviado ao João');
  // registro: a intenção ANTES da chamada, o resultado depois
  const ev = m.eventos.filter((e) => e.evento === EVENTO_NOTA);
  assert.equal(ev.length, 2);
  assert.equal(ev[0]!.args.fase, 'intencao');
  assert.equal(ev[1]!.args.idAsaas, m.f.notas[0]!.id);
  assert.equal(ev[1]!.ok, true);
  assert.ok(!tudo(m.eventos).includes(CPF_DIGITOS) && !tudo(m.eventos).includes('Maria da Silva'));
  // o mesmo código não vale duas vezes
  await recusa(confirmar(m, confirmacao), /desconhecido ou já usado/);
  assert.equal(m.f.posts().length, 1);
  assert.equal(m.avisos.length, 1);
});

test('confirmar emitir AGORA: agenda para hoje e depois pede a emissão (…/authorize), em duas chamadas', async () => {
  const m = base();
  const { confirmacao } = await preparar(m, { dataEmissao: undefined, emitirAgora: true });
  const r = await confirmar(m, confirmacao);
  assert.deepEqual(m.f.posts().map((c) => `${c.metodo} ${c.caminho}`), ['POST /invoices', `POST /invoices/${m.f.notas[0]!.id}/authorize`]);
  assert.equal(m.f.posts()[0]!.corpo!.effectiveDate, '2026-10-28');
  assert.equal(r.notaCriada, true);
  assert.match(m.avisos[0]!, /EMISSÃO PEDIDA/);
});

test('confirmar emitir AGORA: se o pedido de emissão falha, a nota fica agendada, o erro vai na resposta e NÃO se repete nada', async () => {
  const m = base({ falhas: [{ metodo: 'POST', caminho: /\/authorize$/, erro: new ErroHttp('Asaas 400 em /invoices/x/authorize: nota em processamento', 400) }] });
  const { confirmacao } = await preparar(m, { dataEmissao: undefined, emitirAgora: true });
  const r = await confirmar(m, confirmacao);
  assert.equal(r.notaCriada, true);
  assert.match(r.atencao, /AGENDADA para hoje.*NÃO emita de novo/s);
  assert.equal(m.f.posts().filter((c) => c.caminho === '/invoices').length, 1);
  assert.match(m.avisos[0]!, /NOTA FISCAL AGENDADA/);
  assert.match(m.avisos[0]!, /emissão imediata FALHOU/);
});

test('confirmar emitir: data aprovada que ficou para trás (resumo à noite, ok depois da meia-noite) NÃO emite com data de ontem', async () => {
  const m = base();
  m.relogio.t = Date.parse('2026-10-28T23:50:00-03:00');
  const { confirmacao } = await preparar(m, { dataEmissao: undefined, emitirAgora: true });
  m.relogio.t += 14 * 60_000; // 00h04 do dia 29, ainda dentro dos 15 minutos do código
  await recusa(confirmar(m, confirmacao), /a data de emissão aprovada \(28\/10\/2026\) já passou \(hoje é 29\/10\/2026\)/);
  assert.equal(m.f.posts().length, 0);
});

test('confirmar emitir: código expirado, de outra pessoa e inexistente são recusados e NADA é escrito', async () => {
  const m = base();
  const a = await preparar(m);
  // outra pessoa não confirma o pedido de quem preparou — e a tentativa NÃO queima o código de quem preparou
  await recusa(confirmar(m, a.confirmacao, OUTRO), /gerado por outro usuário/);
  assert.equal(m.f.posts().length, 0);
  // vencido (15 minutos)
  m.relogio.t += 16 * 60_000;
  await recusa(confirmar(m, a.confirmacao), /o código venceu \(15 minutos\)/);
  assert.equal(m.f.posts().length, 0);
  await recusa(confirmar(m, a.confirmacao), /desconhecido ou já usado/);
  await recusa(confirmar(m, 'ZZZZZZZZZZZZ'), /desconhecido ou já usado/);
  // dentro do prazo e pela pessoa certa, vale
  const b = await preparar(m);
  m.relogio.t += 14 * 60_000;
  assert.equal((await confirmar(m, b.confirmacao)).notaCriada, true);
  assert.equal(m.f.posts().length, 1);
  assert.equal(m.avisos.length, 1);
});

test('confirmar emitir: nota nova da mesma cobrança que apareceu DEPOIS do resumo derruba a confirmação; a que a pessoa já tinha visto não', async () => {
  const m = base();
  const { confirmacao } = await preparar(m);
  m.f.notas.push({ ...AUTORIZADA, id: 'inv_000000000777', status: 'SCHEDULED' });
  await recusa(confirmar(m, confirmacao), /apareceu outra nota ativa .*inv_000000000777/s);
  assert.equal(m.f.posts().length, 0);
  // se a repetida já existia no resumo, a pessoa foi avisada e aprovou assim mesmo
  const sabida = base({ notas: [AUTORIZADA] });
  const p = await preparar(sabida);
  assert.match(p.avisos[0], /REPETIDA/);
  assert.equal((await confirmar(sabida, p.confirmacao)).notaCriada, true);
  assert.equal(sabida.f.posts().length, 1);
});

test('confirmar: sem permissão — escrita desligada na clínica, conta sem porta de escrita, ou desligada depois do resumo: recusa e não escreve', async () => {
  const desligada = base({}, { unidades: () => new Set() });
  await recusa(preparar(desligada), /DESLIGADA para doutor-hernia-serra/);
  assert.equal(desligada.esc.notas.pendentes, 0);
  const semPorta = base({ semEscrita: true });
  await recusa(preparar(semPorta), /não está liberada para escrita/);
  await recusa(prepararNota(base().ctx, Q, { ...EMITIR, unidade: 'todas' }), /numa conta só/);
  // preparou com a escrita ligada; o João desligou antes do ok
  let ligada = true;
  const m = base({}, { unidades: () => (ligada ? new Set(['doutor-hernia-serra']) : new Set()) });
  const { confirmacao } = await preparar(m);
  ligada = false;
  await recusa(confirmar(m, confirmacao), /DESLIGADA para doutor-hernia-serra/);
  assert.equal(m.f.posts().length, 0);
});

test('confirmar emitir: erro DEFINITIVO do Asaas é registrado e relatado sem dado pessoal; erro de rede avisa que a nota PODE ter sido criada', async () => {
  const recusado = base({ falhas: [{ metodo: 'POST', caminho: /^\/invoices$/, erro: new ErroHttp('Asaas 400 em /invoices: município do tomador inválido; cliente 52998224725', 400) }] });
  const a = await preparar(recusado);
  const erro = await confirmar(recusado, a.confirmacao).then(() => null, (e: Error) => e);
  assert.ok(erro);
  assert.match(erro.message, /município do tomador inválido/);
  assert.ok(!erro.message.includes(CPF_DIGITOS), 'documento na mensagem');
  assert.ok(!/PODE ter sido/.test(erro.message));
  assert.equal(recusado.avisos.length, 0, 'não houve emissão: sem aviso');
  assert.equal(recusado.eventos.filter((e) => e.evento === EVENTO_NOTA && !e.ok).length, 1);

  const rede = base({ falhas: [{ metodo: 'POST', caminho: /^\/invoices$/, erro: new ErroHttp('sem resposta do Asaas em /invoices', null) }] });
  const b = await preparar(rede);
  await recusa(confirmar(rede, b.confirmacao), /a nota PODE ter sido criada: confira com asaas_notas antes de repetir/);
  assert.match(rede.avisos[0]!, /RESULTADO INCERTO/);
  const falhas = rede.eventos.filter((e) => e.evento === EVENTO_NOTA && !e.ok);
  assert.equal(falhas.length, 1);
  assert.equal(falhas[0]!.args.incerto, true);
  // o código foi gasto: repetir exige preparar de novo (e o preparar enxerga a nota, se ela existir)
  await recusa(confirmar(rede, b.confirmacao), /desconhecido ou já usado/);
});

test('confirmar emitir: se o registro não grava (banco fora), nada é enviado ao Asaas', async () => {
  const m = base();
  const { confirmacao } = await preparar(m);
  const semBanco = (evento: string, args: Record<string, unknown>, ok: boolean, erro?: string) => (args.fase === 'intencao' ? false : m.registrar(evento, args, ok, erro));
  await recusa(confirmarNota(m.ctx, Q, { confirmacao }, semBanco), /não consegui gravar o registro/);
  assert.equal(m.f.posts().length, 0);
});

// ------------------------------------------------------------------ cancelar

test('preparar cancelar: mostra a nota e o aviso do prazo da prefeitura, e não escreve; só nota cancelável passa', async () => {
  const m = base({ notas: [AUTORIZADA, ...['SYNCHRONIZED', 'PROCESSING_CANCELLATION', 'CANCELED', 'CANCELLATION_DENIED', 'ERROR'].map((s, i) => ({ ...AUTORIZADA, id: `inv_00000000030${i}`, status: s }))] });
  const r = await prepararNota(m.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id }) as any;
  assert.equal(m.f.posts().length, 0);
  assert.equal(r.resumo.nota.numero, '1234');
  assert.equal(r.resumo.nota.tomador.nome, 'Maria da Silva');
  assert.equal(r.resumo.statusAtual, 'emitida');
  assert.ok(r.avisos.some((x: string) => /depende das regras e do prazo da prefeitura/.test(x)));
  assert.ok(r.avisos.some((x: string) => /emitida há 8 dias/.test(x)));
  assert.match(r.instrucao, /NADA foi cancelado ainda/);
  for (let i = 0; i < 5; i++) await recusa(prepararNota(m.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: `inv_00000000030${i}` }), /Nada foi preparado/);
  await recusa(prepararNota(m.ctx, Q, { unidade: 'serra', acao: 'cancelar' }), /notaId inválido/);
  await recusa(prepararNota(m.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id, valor: 10, servico: '4.01' }), /são de emissão e não valem aqui: valor, servico/);
  const semSuporte = base({ notas: [AUTORIZADA], prefeituraNaoCancela: true });
  const s = await prepararNota(semSuporte.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id }) as any;
  assert.ok(s.avisos.some((x: string) => /NÃO aceita cancelamento automático/.test(x)));
});

test('confirmar cancelar: chama o Asaas UMA vez (POST …/cancel), avisa o Telegram, registra, e o código não vale de novo', async () => {
  const m = base({ notas: [{ ...AUTORIZADA }] });
  const { confirmacao } = await prepararNota(m.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id }) as any;
  assert.equal(m.f.posts().length, 0);
  await recusa(confirmar(m, confirmacao, OUTRO), /gerado por outro usuário/);
  const r = await confirmar(m, confirmacao);
  assert.deepEqual(m.f.posts().map((c) => `${c.metodo} ${c.caminho}`), [`POST /invoices/${AUTORIZADA.id}/cancel`]);
  assert.equal(m.f.posts()[0]!.corpo, undefined, 'sem cancelOnlyOnAsaas: o cancelamento vai à prefeitura');
  assert.equal(r.cancelamentoPedido, true);
  assert.equal(r.nota.statusAgora, 'cancelamento em processamento (a prefeitura ainda vai responder)');
  assert.match(r.aviso, /depende da prefeitura/);
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /NOTA FISCAL: CANCELAMENTO PEDIDO/);
  assert.match(m.avisos[0]!, new RegExp(AUTORIZADA.id));
  const ev = m.eventos.filter((e) => e.evento === EVENTO_NOTA);
  assert.deepEqual(ev.map((e) => [e.args.fase ?? 'resultado', e.args.operacao]), [['intencao', 'cancelar_nota'], ['resultado', 'cancelar_nota']]);
  await recusa(confirmar(m, confirmacao), /desconhecido ou já usado/);
  assert.equal(m.f.posts().length, 1);
});

test('confirmar cancelar: nota que mudou de status desde o resumo NÃO é cancelada; erro de rede avisa que o pedido PODE ter saído', async () => {
  const m = base({ notas: [{ ...AUTORIZADA }] });
  const { confirmacao } = await prepararNota(m.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id }) as any;
  m.f.notas[0]!.status = 'CANCELED';
  await recusa(confirmar(m, confirmacao), /mudou de status desde o resumo/);
  assert.equal(m.f.posts().length, 0);

  const rede = base({ notas: [{ ...AUTORIZADA }], falhas: [{ metodo: 'POST', caminho: /\/cancel$/, erro: new ErroHttp('sem resposta do Asaas', null) }] });
  const p = await prepararNota(rede.ctx, Q, { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id }) as any;
  await recusa(confirmar(rede, p.confirmacao), /o cancelamento PODE ter sido pedido/);
  assert.match(rede.avisos[0]!, /CANCELAMENTO DE NOTA COM RESULTADO INCERTO/);
});

// ------------------------------------------------------------------ rotas e protocolo

test('rotas: só agendar, emitir e cancelar nota existem; editar, excluir e rota sem o id certo continuam fora', () => {
  for (const [metodo, caminho] of [['POST', '/invoices'], ['POST', '/invoices/inv_000000000232/authorize'], ['POST', '/invoices/inv_000000000232/cancel']] as const) assert.equal(rotaPermitida(metodo, caminho), true, `${metodo} ${caminho}`);
  for (const [metodo, caminho] of [
    ['PUT', '/invoices/inv_000000000232'], ['DELETE', '/invoices/inv_000000000232'], ['POST', '/invoices/inv_000000000232'], ['POST', '/invoices/abc123456/cancel'], ['POST', '/invoices/pay_000000000232/cancel'],
    ['POST', '/invoices?x=1'], ['POST', '/invoices/'], ['PUT', '/invoices'], ['POST', '/invoices/inv_000000000232/cancel/x'], ['POST', '/invoices/inv_1/authorize'], ['POST', '/fiscalInfo'], ['POST', '/fiscalInfo/'],
  ] as const) assert.equal(rotaPermitida(metodo, caminho), false, `${metodo} ${caminho}`);
});

type Registro = { ferramenta: string; argumentos: any; ok: boolean; erro?: string };
async function conectar(m: M, usuario: string, escritores: Set<string>, registros: Registro[] = []) {
  const server = new McpServer({ name: 't', version: '0' });
  registrarLeituraNotasAsaas(server, m.asaas, (r) => registros.push(r as never));
  registrarEscritaAsaasSePermitido(server, m.asaas, m.esc, usuario, escritores, (r) => registros.push(r as never), { email: `${usuario}@exemplo.com` });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  return cliente;
}
const texto = (r: any) => String(r.content?.[0]?.text ?? '');

test('protocolo: quem pode escrever vê as 5 ferramentas de nota (3 leituras + preparar/confirmar); quem não pode vê só as leituras e não emite', async () => {
  const m = base({ notas: [AUTORIZADA] });
  const joao = await conectar(m, 'u-joao', new Set(['u-joao']));
  const nomes = (await joao.listTools()).tools.map((t) => t.name).filter((n) => /nota|fiscais/.test(n)).sort();
  assert.deepEqual(nomes, ['asaas_confirmar_nota', 'asaas_dados_fiscais', 'asaas_nota', 'asaas_notas', 'asaas_preparar_nota']);
  const por = new Map((await joao.listTools()).tools.map((t) => [t.name, t]));
  assert.match(por.get('asaas_preparar_nota')!.description!, /PASSO 1 de 2/);
  assert.match(por.get('asaas_preparar_nota')!.description!, /NUNCA suponha alíquota/);
  assert.match(por.get('asaas_confirmar_nota')!.description!, /PASSO 2 de 2/);
  assert.equal(por.get('asaas_preparar_nota')!.annotations?.readOnlyHint, false, 'preparar guarda o código de uma escrita fiscal: não se passa por consulta');
  assert.equal(por.get('asaas_confirmar_nota')!.annotations?.readOnlyHint, false);
  for (const leitura of ['asaas_notas', 'asaas_nota', 'asaas_dados_fiscais']) assert.equal(por.get(leitura)!.annotations?.readOnlyHint, true, leitura);

  const fora = await conectar(m, 'u-fora', new Set(['u-joao']));
  assert.deepEqual((await fora.listTools()).tools.map((t) => t.name).sort(), ['asaas_dados_fiscais', 'asaas_nota', 'asaas_notas']);
  const tentativa = await fora.callTool({ name: 'asaas_preparar_nota', arguments: { unidade: 'serra', acao: 'cancelar', notaId: AUTORIZADA.id } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal((tentativa as { isError?: boolean }).isError, true);
  const confirma = await fora.callTool({ name: 'asaas_confirmar_nota', arguments: { confirmacao: 'ABCDEF123456' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal((confirma as { isError?: boolean }).isError, true);
  assert.equal(m.f.posts().length, 0);
  // a leitura funciona para quem não escreve
  const lista = await fora.callTool({ name: 'asaas_notas', arguments: { unidade: 'serra', status: 'AUTHORIZED' } });
  assert.notEqual(lista.isError, true);
  assert.equal(JSON.parse(texto(lista)).notas, 1);
});

test('protocolo: preparar → confirmar de ponta a ponta; o registro sai mascarado e campo que não existe (cartão, typo em impostos) é recusado', async () => {
  const m = base();
  const registros: Registro[] = [];
  const joao = await conectar(m, 'u-joao', new Set(['u-joao']), registros);
  const args = { unidade: 'serra', acao: 'emitir', cobrancaId: COBRANCA.id, servico: '4.01', dataEmissao: '2026-10-30', impostos: { retemIss: false, inss: 0, ir: 0 } };
  const prep = await joao.callTool({ name: 'asaas_preparar_nota', arguments: args });
  assert.notEqual(prep.isError, true, texto(prep));
  assert.equal(m.f.posts().length, 0);
  const codigo = JSON.parse(texto(prep)).confirmacao as string;
  // campos que a ferramenta não declara são RECUSADOS, não descartados
  const cartao = await joao.callTool({ name: 'asaas_preparar_nota', arguments: { ...args, cardNumber: '4111111111111111' } });
  assert.equal(cartao.isError, true);
  assert.match(texto(cartao), /NUNCA entram pelo chat/);
  const typo = await joao.callTool({ name: 'asaas_preparar_nota', arguments: { ...args, impostos: { retemIss: false, inss: 0, ir: 0, irpf: 5 } } });
  assert.equal(typo.isError, true);
  assert.equal(m.esc.notas.pendentes, 1, 'só o primeiro pedido ficou preparado');
  const conf = await joao.callTool({ name: 'asaas_confirmar_nota', arguments: { confirmacao: codigo } });
  assert.notEqual(conf.isError, true, texto(conf));
  assert.equal(m.f.posts().length, 1);
  assert.equal(JSON.parse(texto(conf)).notaCriada, true);
  const outra = await joao.callTool({ name: 'asaas_confirmar_nota', arguments: { confirmacao: codigo } });
  assert.equal(outra.isError, true);
  assert.equal(m.f.posts().length, 1);
  const aud = tudo(registros);
  assert.ok(!aud.includes('4111111111111111') && !aud.includes(CPF_DIGITOS));
});

test('producao.ts liga a leitura de notas e a escrita de notas só pelos portões testados', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarLeituraNotasAsaas\(server, asaas, auditar\)/g)?.length, 1);
  // a escrita da nota entra pelo mesmo portão da escrita do Asaas (lista de escritores); ninguém chama o registrador cru
  assert.equal(src.match(/\bregistrarNotasFiscaisAsaas\(/g), null);
  assert.doesNotMatch(src, /import \{[^}]*\bregistrarNotasFiscaisAsaas\b[^}]*\} from/);
  const servidor = readFileSync(new URL('./servidor.ts', import.meta.url), 'utf8');
  for (const nome of ['asaas_notas', 'asaas_nota', 'asaas_dados_fiscais', 'asaas_preparar_nota', 'asaas_confirmar_nota']) assert.ok(servidor.includes(nome), `servidor.ts não cita ${nome}`);
  assert.match(servidor, /NOTA FISCAL é a exceção ao "direto" e é em DOIS passos/);
});
