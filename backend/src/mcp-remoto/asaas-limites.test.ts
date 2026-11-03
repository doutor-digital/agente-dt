import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enfileirar, criarEscritaAsaas } from './asaas-escrita.js';
import { cancelamentosPorHora, acharDestino, conferirTetos, diaLocal, Livro, mascararChavePix, normalizarChave, tetoEspecificoDe, tetoPorDia, tetoPorOperacao, textoDoAviso, lerDestinos } from './asaas-limites.js';

test('tetos: padrão 5000 por operação e 20000 por dia; vazio, 0, negativo e lixo = o PADRÃO (nunca ilimitado); valor bom manda', () => {
  assert.equal(tetoPorOperacao({}), 5000);
  assert.equal(tetoPorDia({}), 20000);
  for (const v of ['', '   ', '0', '-1', 'abc', 'NaN', 'Infinity']) {
    assert.equal(tetoPorOperacao({ ASAAS_TETO_OPERACAO_REAIS: v }), 5000, `operação ${v}`);
    assert.equal(tetoPorDia({ ASAAS_TETO_DIA_REAIS: v }), 20000, `dia ${v}`);
  }
  assert.equal(tetoPorOperacao({ ASAAS_TETO_OPERACAO_REAIS: '1200.5' }), 1200.5);
  assert.equal(tetoPorDia({ ASAAS_TETO_DIA_REAIS: '8000' }), 8000);
  // o nome antigo do teto por boleto ainda vale como segunda opção (o teto não sobe sozinho), e o novo manda
  assert.equal(tetoPorOperacao({ ASAAS_COBRANCA_MAX_REAIS: '300' }), 300);
  assert.equal(tetoPorOperacao({ ASAAS_COBRANCA_MAX_REAIS: '300', ASAAS_TETO_OPERACAO_REAIS: '900' }), 900);
  // o nome antigo com 0 ou lixo mantém o sentido antigo (DESLIGADO) até ser apagado; o nome novo, se válido, manda por cima
  assert.equal(tetoPorOperacao({ ASAAS_COBRANCA_MAX_REAIS: '0' }), 0);
  assert.equal(tetoPorOperacao({ ASAAS_COBRANCA_MAX_REAIS: 'abc' }), 0);
  assert.equal(tetoPorOperacao({ ASAAS_COBRANCA_MAX_REAIS: '0', ASAAS_TETO_OPERACAO_REAIS: '700' }), 700);
});

test('diaLocal: o dia civil de cada fuso; fuso desconhecido cai em São Paulo', () => {
  const t = Date.parse('2026-10-29T02:30:00Z');
  assert.equal(diaLocal(t, 'America/Sao_Paulo'), '2026-10-28');
  assert.equal(diaLocal(t, 'America/Manaus'), '2026-10-28');
  assert.equal(diaLocal(t, 'UTC'), '2026-10-29');
  assert.equal(diaLocal(t, 'Lugar/Nenhum'), '2026-10-28');
});

test('livro: a soma do dia usa o fuso da clínica e soma tipos e horas diferentes; edição conta só o acréscimo; por tipo', () => {
  const SP = (iso: string) => Date.parse(`${iso}-03:00`);
  const L = new Livro([
    { conta: 'c', tipo: 'cobranca', valor: 100, noTeto: 100, em: SP('2026-10-28T00:05:00') },
    { conta: 'c', tipo: 'estorno', valor: 200, noTeto: 200, em: SP('2026-10-28T12:00:00') },
    { conta: 'c', tipo: 'transferencia', valor: 300.1, noTeto: 300.1, em: SP('2026-10-28T23:59:00') },
    { conta: 'c', tipo: 'edicao', valor: 500, noTeto: 50, em: SP('2026-10-28T10:00:00') },
    { conta: 'c', tipo: 'cobranca', valor: 999, noTeto: 999, em: SP('2026-10-27T23:59:00') },
  ]);
  assert.equal(L.somaDoDia(SP('2026-10-28T23:59:59'), 'America/Sao_Paulo'), 650.1);
  assert.equal(L.somaDoDia(SP('2026-10-29T00:00:01'), 'America/Sao_Paulo'), 0);
  assert.equal(L.somaDoDia(SP('2026-10-27T23:59:59'), 'America/Sao_Paulo'), 999);
  assert.equal(L.somaDoDia(SP('2026-10-28T23:59:59'), 'America/Sao_Paulo', 'estorno'), 200);
  assert.equal(L.somaDoDia(SP('2026-10-28T23:59:59'), 'America/Sao_Paulo', 'transferencia'), 300.1);
  // em Manaus (uma hora antes) a virada é outra: a cobrança das 00:05 de 28 em São Paulo (23:05 em Manaus) ainda é dia 27 lá
  assert.equal(L.somaDoDia(SP('2026-10-28T12:00:00'), 'America/Manaus'), 550.1);
  assert.equal(L.somaDoDia(SP('2026-10-27T23:59:59'), 'America/Manaus'), 1099);
  assert.equal(L.cobrancasNaHora(SP('2026-10-28T00:30:00'), 3_600_000), 2);
  assert.equal(L.cobrancasNaHora(SP('2026-10-28T01:00:00'), 3_600_000), 1);
});

const AGORA_T = Date.parse('2026-10-28T15:00:00-03:00');
const base = { fuso: 'America/Sao_Paulo', agora: AGORA_T, tetoOperacao: 1000, tetoDia: 1000.3 };
const lanc = (tipo: 'cobranca' | 'estorno' | 'transferencia', valor: number) => ({ conta: 'c', tipo, valor, noTeto: valor, em: AGORA_T });

test('conferirTetos: recusa por operação e por dia com a mensagem do teto; no limite exato passa (em centavos, sem erro de ponto flutuante)', () => {
  assert.throws(() => conferirTetos({ ...base, livro: new Livro(), valor: 1000.01, noTeto: 1000.01 }), /passa do teto de R\$ 1\.000,00 por operação/);
  const L = new Livro([lanc('transferencia', 0.1), lanc('transferencia', 0.2)]);
  conferirTetos({ ...base, livro: L, valor: 1000, noTeto: 1000 }); // 0.1 + 0.2 + 1000 = 1000.3 exato
  assert.throws(() => conferirTetos({ ...base, livro: L, valor: 1000, noTeto: 1000.01 }), /passa do teto do dia desta chave do Asaas/);
});

test('teto PRÓPRIO de estorno e de transferência: padrão 500/2000; vale o menor com o geral; vazio, 0 e lixo = o padrão', () => {
  assert.deepEqual(tetoEspecificoDe('estorno', {}), { operacao: 500, dia: 2000 });
  assert.deepEqual(tetoEspecificoDe('transferencia', {}), { operacao: 500, dia: 2000 });
  assert.deepEqual(tetoEspecificoDe('estorno', { ASAAS_TETO_ESTORNO_OPERACAO_REAIS: '800', ASAAS_TETO_ESTORNO_DIA_REAIS: '3000' }), { operacao: 800, dia: 3000 });
  assert.deepEqual(tetoEspecificoDe('transferencia', { ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS: '1200', ASAAS_TETO_TRANSFERENCIA_DIA_REAIS: '9000' }), { operacao: 1200, dia: 9000 });
  for (const v of ['', '0', '-5', 'abc']) assert.deepEqual(tetoEspecificoDe('estorno', { ASAAS_TETO_ESTORNO_OPERACAO_REAIS: v, ASAAS_TETO_ESTORNO_DIA_REAIS: v }), { operacao: 500, dia: 2000 }, v);
  // cada tipo olha a SUA variável
  assert.deepEqual(tetoEspecificoDe('transferencia', { ASAAS_TETO_ESTORNO_OPERACAO_REAIS: '9' }), { operacao: 500, dia: 2000 });

  const teto = { tipo: 'estorno' as const, teto: { operacao: 500, dia: 2000 } };
  const grande = { ...base, tetoOperacao: 5000, tetoDia: 20000 };
  // por operação: o próprio manda quando é menor que o geral
  assert.throws(() => conferirTetos({ ...grande, livro: new Livro(), valor: 500.01, noTeto: 500.01, saida: teto }), /passa do teto de R\$ 500,00 por estorno \(ASAAS_TETO_ESTORNO_OPERACAO_REAIS\)/);
  conferirTetos({ ...grande, livro: new Livro(), valor: 500, noTeto: 500, saida: teto });
  // e o geral manda quando é menor que o próprio
  assert.throws(() => conferirTetos({ ...grande, tetoOperacao: 300, livro: new Livro(), valor: 400, noTeto: 400, saida: teto }), /teto de R\$ 300,00 por operação \(ASAAS_TETO_OPERACAO_REAIS\)/);
  // por dia: soma só do MESMO tipo (transferência de ontem à parte não entra no teto do estorno), e o geral continua valendo para a soma de tudo
  const L = new Livro([lanc('estorno', 1900), lanc('transferencia', 1900)]);
  conferirTetos({ ...grande, livro: L, valor: 100, noTeto: 100, saida: teto });
  assert.throws(() => conferirTetos({ ...grande, livro: L, valor: 100.01, noTeto: 100.01, saida: teto }), /teto do dia para estorno.*ASAAS_TETO_ESTORNO_DIA_REAIS/s);
  const cheio = new Livro([lanc('cobranca', 19500), lanc('estorno', 100)]);
  assert.throws(() => conferirTetos({ ...grande, livro: cheio, valor: 500, noTeto: 500, saida: teto }), /passa do teto do dia desta chave do Asaas/);
  // o teto próprio do dia nunca passa do geral
  assert.throws(() => conferirTetos({ ...grande, tetoDia: 1000, livro: new Livro(), valor: 600, noTeto: 1001, saida: { tipo: 'transferencia', teto: { operacao: 5000, dia: 5000 } } }), /teto do dia/);
});

test('chave Pix: só o formato do próprio tipo (texto com sobra não vira a chave); máscara não mostra a chave inteira', () => {
  assert.equal(normalizarChave('CNPJ', '11.222.333/0001-81'), '11222333000181');
  assert.equal(normalizarChave('CNPJ', '11.222.333/0001-81; outra chave'), null);
  assert.equal(normalizarChave('CNPJ', '11222333000180'), null);
  assert.equal(normalizarChave('CPF', '529.982.247-25'), '52998224725');
  assert.equal(normalizarChave('CPF', 'meu cpf 529.982.247-25'), null);
  assert.equal(normalizarChave('EMAIL', ' Ana@Exemplo.com '), 'ana@exemplo.com');
  assert.equal(normalizarChave('PHONE', '(63) 98141-1248'), '+5563981411248');
  assert.equal(normalizarChave('PHONE', '63 98141-1248 e outro'), null);
  assert.equal(normalizarChave('PHONE', '12 3456 7890 12'), null, '12 dígitos sem o 55 não é telefone brasileiro');
  assert.equal(normalizarChave('EVP', '123E4567-E89B-12D3-A456-426614174000'), '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(normalizarChave('EVP', '123E4567E89B12D3A456426614174000'), '123e4567-e89b-12d3-a456-426614174000', 'sem hífens vira o formato canônico');
  assert.equal(normalizarChave('EVP', 'não é uuid'), null);
  assert.equal(mascararChavePix('CPF', '52998224725'), '***.***.247-**');
  assert.equal(mascararChavePix('EMAIL', 'ana@exemplo.com'), 'a***@exemplo.com');
  assert.equal(mascararChavePix('PHONE', '+5563981411248'), '+55 (63) *****-1248');
  assert.equal(mascararChavePix('EVP', '123e4567-e89b-12d3-a456-426614174000'), '123e4567…');
});

test('destinos: o JSON é por clínica (slug em qualquer caixa); outra clínica não herda; problema na entrada não vaza a chave', () => {
  const env = { ASAAS_TRANSFERENCIA_DESTINOS: JSON.stringify({ 'Doutor-Hernia-Serra': [{ nome: 'A', chave_pix: '11222333000181', tipo_chave: 'cnpj' }], 'doutor-hernia-maraba': [{ nome: 'B', chave_pix: 'x', tipo_chave: 'EVP' }] }) };
  assert.equal(lerDestinos('doutor-hernia-serra', env).destinos.length, 1);
  assert.equal(lerDestinos('doutor-hernia-canaa', env).ligada, false);
  const maraba = lerDestinos('doutor-hernia-maraba', env);
  assert.equal(maraba.ligada, false);
  assert.match(maraba.problemas.join(' '), /chave_pix não é uma chave EVP válida/);
  assert.ok(!maraba.problemas.join(' ').includes('"x"'));
  assert.match(lerDestinos('x', { ASAAS_TRANSFERENCIA_DESTINOS: '{quebrado' }).problemas.join(' '), /não é um JSON válido/);
});

test('aviso do Telegram: conta, valor, quem pediu, destino e id — sem campos vazios', () => {
  const t = textoDoAviso({ titulo: 'ESTORNO', conta: 'doutor-hernia-serra', nomeDaConta: 'Clínica Serra', quem: { id: 'u9', email: 'ana@exemplo.com' }, valor: 1234.5, destino: 'Fornecedor', id: 'pay_1', detalhe: 'ESTORNO TOTAL' });
  assert.equal(t, 'Asaas · ESTORNO\nConta: doutor-hernia-serra (Clínica Serra)\nValor: R$ 1.234,50\nQuem pediu: ana@exemplo.com (usuário u9)\nDestino: Fornecedor\nId no Asaas: pay_1\nESTORNO TOTAL');
  assert.equal(textoDoAviso({ titulo: 'X', conta: 'c', quem: { id: 'u' } }), 'Asaas · X\nConta: c\nQuem pediu: (usuário u)');
});

test('conferirTetos: teto por operação 0 (nome antigo desligado) recusa tudo e diz como corrigir', () => {
  assert.throws(
    () => conferirTetos({ livro: new Livro(), fuso: 'America/Sao_Paulo', agora: AGORA_T, valor: 1, noTeto: 1, tetoOperacao: tetoPorOperacao({ ASAAS_COBRANCA_MAX_REAIS: '0' }), tetoDia: 100 }),
    /DESLIGADO.*ASAAS_COBRANCA_MAX_REAIS.*ASAAS_TETO_OPERACAO_REAIS/s,
  );
});

test('agência e conta com hífen ou ponto NÃO viram outra conta: a lista os ignora, o pedido os recusa (só dígitos, como estão)', () => {
  const entrada = (extra: object) => lerDestinos('x', { ASAAS_TRANSFERENCIA_DESTINOS: JSON.stringify({ x: [{ nome: 'A', banco: '001', agencia: '1234', conta: '98765', conta_digito: '4', titular: 'T', documento: '11222333000181', ...extra }] }) });
  assert.equal(entrada({}).destinos.length, 1);
  assert.equal((entrada({}).destinos[0] as { digito: string }).digito, '4');
  for (const extra of [{ agencia: '1234-5' }, { conta: '98765-4' }, { conta: '98.765' }, { banco: '0 01' }, { conta_digito: '4-' }, { agencia: '12 34' }]) {
    const l = entrada(extra);
    assert.equal(l.destinos.length, 0, JSON.stringify(extra));
    assert.match(l.problemas.join(' '), /só números/);
  }
  const ok = entrada({}).destinos;
  assert.equal(acharDestino(ok, { contaBancaria: { banco: '001', agencia: '1234', conta: '98765', digito: '4' } }).apelido, 'A');
  // o pedido com hífen não "vira" a conta da lista
  for (const cb of [{ banco: '001', agencia: '1234-5', conta: '98765', digito: '4' }, { banco: '001', agencia: '1234', conta: '98765-4' }, { banco: '001', agencia: '1234', conta: '9876.5', digito: '4' }]) {
    assert.throws(() => acharDestino(ok, { contaBancaria: cb }), /só com números/, JSON.stringify(cb));
  }
});

test('fila: uma por conta — uma conta travada não segura as outras, e duas operações da MESMA conta rodam uma depois da outra', async () => {
  const esc = criarEscritaAsaas();
  let soltarA!: () => void;
  const a1 = enfileirar(esc, 'A', () => new Promise<void>((r) => (soltarA = r)));
  const ordem: string[] = [];
  const a2 = enfileirar(esc, 'A', async () => void ordem.push('A2'));
  const b1 = await enfileirar(esc, 'B', async () => 'B1 rodou sem esperar a conta A');
  assert.equal(b1, 'B1 rodou sem esperar a conta A');
  assert.deepEqual(ordem, [], 'A2 ainda espera A1');
  soltarA();
  await Promise.all([a1, a2]);
  assert.deepEqual(ordem, ['A2']);
  await new Promise((r) => setImmediate(r));
  assert.equal(esc.filas.size, 0, 'filas paradas não ficam guardadas');
});

test('ASAAS_CANCELAMENTOS_POR_HORA: padrão 10; vazio, 0 e lixo = o padrão', () => {
  assert.equal(cancelamentosPorHora({}), 10);
  assert.equal(cancelamentosPorHora({ ASAAS_CANCELAMENTOS_POR_HORA: '25' }), 25);
  for (const v of ['', '0', '-3', 'abc', '2.5']) assert.equal(cancelamentosPorHora({ ASAAS_CANCELAMENTOS_POR_HORA: v }), 10, v);
});
