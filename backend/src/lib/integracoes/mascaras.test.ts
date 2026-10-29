import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehChaveSecreta, ehColunaSecreta, limparRegistro, mascararCelula, mascararCpf, mascararTelefone, mascararTexto, temCpfColado } from './mascaras.js';

// Tudo aqui é inventado: CPFs de exemplo e senhas que não existem.

test('cabeçalhos de credencial são reconhecidos, com ou sem acento, caixa e separador', () => {
  for (const h of ['Senha', 'SENHA INSS', 'Password', 'senha do gov.br', 'Meu INSS', 'meu_inss_pass', 'CPF-Senha', 'CPF/SENHA', 'Login', 'login do portal', 'Token', 'Acesso gov.br', 'PWD']) {
    assert.equal(ehColunaSecreta(h), true, h);
  }
  for (const h of ['Nome', 'Telefone', 'CPF', 'Processo', 'Situação', 'Data de entrada', 'Benefício', 'Observações', 'Passagem', 'Compasso', '']) {
    assert.equal(ehColunaSecreta(h), false, h);
  }
  assert.equal(ehChaveSecreta('meu_inss_pass'), true);
  assert.equal(ehChaveSecreta('cpf_cnpj'), false);
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

test('CPF e senha colados (NNN.NNN.NNN-NN/…) somem inteiros, inclusive o que vem depois', () => {
  assert.equal(temCpfColado('123.456.789-09/Abc 12345'), true);
  assert.equal(mascararTexto('123.456.789-09/SenhaFalsa#1'), '[CPF/senha omitido]');
  assert.equal(mascararTexto('login: 123.456.789-09 / senha com espaço'), 'login: [CPF/senha omitido]');
  assert.equal(mascararTexto('12345678909/outraSenha'), '[CPF/senha omitido]');
  assert.equal(mascararTexto('123.456.789-09 | x9y8'), '[CPF/senha omitido]');
  assert.equal(temCpfColado('123.456.789-09'), false);
  assert.equal(temCpfColado('15/10/2026'), false);
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
