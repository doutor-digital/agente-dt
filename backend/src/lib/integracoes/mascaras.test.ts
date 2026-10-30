import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehChaveSecreta, limparRegistro, mascararArgumentos, mascararCelula, mascararCnpj, mascararCpf, mascararErro, mascararTelefone, mascararTexto, temCpfColado } from './mascaras.js';

// Tudo aqui é inventado: CPFs de exemplo e senhas que não existem.

test('chaves de credencial de JSON são reconhecidas, com ou sem acento, caixa e separador', () => {
  for (const h of ['senha', 'Password', 'meu_inss_pass', 'meuInssPass', 'api_token', 'LOGIN', 'PIN']) assert.equal(ehChaveSecreta(h), true, h);
  for (const h of ['name', 'cpf_cnpj', 'passagem', 'compasso', 'processo', '']) assert.equal(ehChaveSecreta(h), false, h);
});

test('CPF e telefone mostram só o final', () => {
  assert.equal(mascararCpf('123.456.789-09'), '***.***.***-09');
  assert.equal(mascararCpf('12345678909'), '***.***.***-09');
  assert.equal(mascararTelefone('(11) 98765-4321'), '(**) *****-4321');
  assert.equal(mascararTelefone('+55 11 98765-4321'), '(**) *****-4321');
});

test('texto livre: CPF formatado e telefone são mascarados', () => {
  assert.equal(mascararTexto('Cliente 123.456.789-09 ligou'), 'Cliente ***.***.***-09 ligou');
  assert.equal(mascararTexto('fone (11) 98765-4321 ou 11987654321'), 'fone (**) *****-4321 ou (**) *****-4321');
  assert.equal(mascararTexto('+55 (11) 3456-7890'), '(**) *****-7890');
  assert.equal(mascararTexto('zap 98765-4321'), 'zap (**) *****-4321');
});

test('texto livre: número de processo, data, valor e id não são tocados', () => {
  for (const s of ['5010331-15.2024.4.03.6201', '0001234-56.2024.8.26.0001', '50103311520244036201', '2026-10-29', '2026-10-29T10:00:00Z', 'R$ 1.234,56', '1500', 'Parcela 12/2026', '12345678', 'INSS 2024']) {
    assert.equal(mascararTexto(s), s, s);
  }
});

test('CPF e senha colados (NNN.NNN.NNN-NN/…): na célula some o resto dela; em texto corrido só a palavra colada', () => {
  assert.equal(temCpfColado('123.456.789-09/Abc 12345'), true);
  assert.equal(mascararTexto('123.456.789-09/SenhaFalsa#1', 'celula'), '[CPF/senha omitido]');
  assert.equal(mascararTexto('login: 123.456.789-09 / senha com espaço', 'celula'), 'login: [CPF/senha omitido]');
  assert.equal(mascararTexto('12345678909/outraSenha', 'celula'), '[CPF/senha omitido]');
  assert.equal(mascararTexto('123.456.789-09 | x9y8', 'celula'), '[CPF/senha omitido]');
  assert.equal(mascararTexto('acesso 123.456.789-09/SenhaFalsa#1 e depois o prazo de 15 dias'), 'acesso [CPF/senha omitido] e depois o prazo de 15 dias');
  assert.equal(temCpfColado('123.456.789-09'), false);
  assert.equal(temCpfColado('15/10/2026'), false);
});

test('prosa com CPF seguido de ; ou : não perde o resto do parágrafo', () => {
  const t = 'Autor: Maria, CPF 123.456.789-01; réu: Banco X. Prazo de 15 dias para contestar.';
  assert.equal(mascararTexto(t), 'Autor: Maria, CPF ***.***.***-01; réu: Banco X. Prazo de 15 dias para contestar.');
  // na CÉLULA o que vem depois de um CPF pode ser a senha, com qualquer separador (decisão do sênior no PR #160): perde o resto, nunca mostra
  assert.equal(mascararTexto(t, 'celula'), 'Autor: Maria, CPF [CPF/senha omitido]');
});

test('senha dita em texto livre ("senha: …", "senha do gov = …") some', () => {
  assert.equal(mascararTexto('senha gov: Abc@123 trocar'), '[senha omitida] trocar');
  assert.equal(mascararTexto('Senha=abc123'), '[senha omitida]');
  assert.equal(mascararTexto('password: x9'), '[senha omitida]');
  assert.equal(mascararTexto('cliente esqueceu a senha'), 'cliente esqueceu a senha');
  assert.equal(mascararTexto('Senha do INSS: confirmar com a cliente'), '[senha omitida] com a cliente', 'perde o 1º termo do valor: erra para o lado seguro');
});

test('célula: o cabeçalho ajuda onde o formato não basta', () => {
  assert.equal(mascararCelula('12345678909', 'CPF'), '***.***.***-09');
  assert.equal(mascararCelula('1234567890', 'cpf do cliente'), '***.***.***-90'); // zero à esquerda perdido pela planilha
  assert.equal(mascararCelula('987654321', 'Celular'), '(**) *****-4321');
  assert.equal(mascararCelula('Maria Souza', 'Nome'), 'Maria Souza');
  assert.equal(mascararCelula('', 'CPF'), '');
});

test('registro de API: some a chave de credencial e mascara texto em qualquer profundidade, sem estragar identificadores', () => {
  const entrada = {
    id: 7,
    number: '5010331-15.2024.4.03.6201',
    name: 'Maria Souza',
    cpf_cnpj: '123.456.789-09',
    meu_inss_pass: 'Indisponível por padrão',
    phone_mobile: '11987654321',
    aninhado: { password: 'x', obs: 'ligar (11) 98765-4321', lista: [{ api_token: 'abc', cpf_cnpj: '98765432100' }] },
  };
  const out = limparRegistro(entrada);
  assert.deepEqual(out, {
    id: 7,
    number: '5010331-15.2024.4.03.6201',
    name: 'Maria Souza',
    cpf_cnpj: '***.***.***-09',
    phone_mobile: '(**) *****-4321',
    aninhado: { obs: 'ligar (**) *****-4321', lista: [{ cpf_cnpj: '***.***.***-00' }] },
  });
  assert.equal(entrada.meu_inss_pass, 'Indisponível por padrão', 'o original não é alterado');
});

test('registro de API: chave "number"/"numero" não isenta valor; CPF/telefone como número JSON mascarados; uuid e links intactos', () => {
  const uuid = 'a1b2c3d4-1234-5678-9abc-def012345678';
  const out = limparRegistro({
    uuid,
    link: 'https://tramitacaointeligente.com.br/publicacoes/1234-5678',
    telefone: { number: '11999998888' },
    outro: { numero: '123.456.789-01' },
    cpf: 12345678901,
    phone: 11987654321,
    valor: 12345678901,
    numero_processo: '5010331-15.2024.4.03.6201',
  });
  assert.deepEqual(out, {
    uuid,
    link: 'https://tramitacaointeligente.com.br/publicacoes/1234-5678',
    telefone: { number: '(**) *****-8888' },
    outro: { numero: '***.***.***-01' },
    cpf: '***.***.***-01',
    phone: '(**) *****-4321',
    valor: 12345678901,
    numero_processo: '5010331-15.2024.4.03.6201',
  });
});

test('telefones separados por vírgula sem espaço: todos mascarados', () => {
  assert.equal(mascararTexto('11999998888,11988887777'), '(**) *****-8888,(**) *****-7777');
  assert.equal(mascararTexto('(11)99999-8888,(11)98888-7777'), '(**) *****-8888,(**) *****-7777');
  assert.equal(mascararTexto('R$ 1.234,56'), 'R$ 1.234,56');
});

test('registro de API: dado bancário não sai, com qualquer nome de chave', () => {
  const out = limparRegistro({ nome: 'Maria', bank_accounts: [{ x: 1 }], bank_name: 'Banco X', pix_key: 'a@b.com', agencia: '123', conta_corrente: '99-1', cidade: 'Campo Grande' });
  assert.deepEqual(out, { nome: 'Maria', cidade: 'Campo Grande' });
});

test('CNPJ: com ou sem pontuação, só os dois últimos dígitos; processo CNJ, data e valor não são tocados', () => {
  assert.equal(mascararCnpj('12.345.678/0001-95'), '**.***.***/****-95');
  assert.equal(mascararTexto('empresa 12.345.678/0001-95 e 12345678000195'), 'empresa **.***.***/****-95 e **.***.***/****-95');
  assert.equal(mascararTexto('Proc. 5010331-15.2024.4.03.6201 em 2026-10-30, R$ 1.234,56'), 'Proc. 5010331-15.2024.4.03.6201 em 2026-10-30, R$ 1.234,56');
  // cabeçalho de CPF/CNPJ com 14 dígitos só numéricos
  assert.equal(mascararCelula('12345678000195', 'CPF/CNPJ'), '**.***.***/****-95');
});

test('CPF com barra ou hífen entre os grupos também é mascarado', () => {
  assert.equal(mascararTexto('cpf 123.456.789/09'), 'cpf ***.***.***-09');
  assert.equal(mascararTexto('cpf 123-456-789-09'), 'cpf ***.***.***-09');
});

test('argumentos da auditoria: cpfCnpj com CNPJ nunca fica inteiro', () => {
  for (const cnpj of ['12345678000195', '12.345.678/0001-95']) {
    const out = mascararArgumentos({ cpfCnpj: cnpj, busca: `empresa ${cnpj}` });
    assert.equal(JSON.stringify(out).includes('345'), false, JSON.stringify(out));
    assert.equal(out.cpfCnpj, '**.***.***/****-95');
  }
});

test('mascararErro: a mesma máscara dos argumentos, sem comer o resto da mensagem', () => {
  assert.equal(mascararErro('404 em /v1/processos/123.456.789-09: não encontrado'), '404 em /v1/processos/***.***.***-09: não encontrado');
  assert.equal(mascararErro('CNPJ 12345678000195 e fone 11987654321'), 'CNPJ **.***.***/****-95 e fone (**) *****-4321');
  assert.equal(mascararErro('plano Ouro exigido'), 'plano Ouro exigido');
});
