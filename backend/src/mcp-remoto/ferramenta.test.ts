import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';

type Registro = { ferramenta: string; argumentos: unknown; ok: boolean; ms: number; erro?: string };
const texto = (r: { content: Array<{ type: string; text?: string }> }) => String(r.content[0]?.text);

test('erro: CPF, CNPJ e telefone (com ou sem pontuação) voltam ao modelo e vão à auditoria mascarados', async () => {
  const casos: Array<[string, RegExp, string]> = [
    ['404 em /v1/processos/123.456.789-09: não encontrado', /123\.456\.789-09/, '404 em /v1/processos/***.***.***-09: não encontrado'],
    ['cliente 12345678909 não achado', /12345678909/, 'cliente ***.***.***-09 não achado'],
    ['sem cadastro para 12.345.678/0001-95', /12\.345\.678\/0001-95/, 'sem cadastro para **.***.***/****-95'],
    ['sem cadastro para 12345678000195', /12345678000195/, 'sem cadastro para **.***.***/****-95'],
    ['telefone (11) 98765-4321 inválido', /98765-4321/, 'telefone (**) *****-4321 inválido'],
    ['falhou, senha: Zq7#Fict!x91', /Zq7/, 'falhou, [senha omitida]'],
  ];
  for (const [msg, proibido, esperado] of casos) {
    const registros: Registro[] = [];
    const r = await executar('qualquer', { x: 1 }, (x) => void registros.push(x), () => {
      throw new Error(msg);
    });
    assert.equal(r.isError, true);
    assert.equal(proibido.test(texto(r)), false, `modelo viu: ${texto(r)}`);
    assert.equal(proibido.test(registros[0]!.erro!), false, `auditoria guardou: ${registros[0]!.erro}`);
    assert.equal(texto(r), esperado);
    assert.equal(registros[0]!.erro, esperado);
    assert.equal(registros[0]!.ok, false);
  }
});

test('erro de entrada ganha o prefixo e também passa pela máscara', async () => {
  const registros: Registro[] = [];
  const r = await executar('qualquer', {}, (x) => void registros.push(x), () => {
    throw new ErroDeEntrada('cpfCnpj 123.456.789-09 não confere');
  });
  assert.equal(texto(r), 'Pedido inválido: cpfCnpj ***.***.***-09 não confere');
  assert.equal(registros[0]!.erro, 'Pedido inválido: cpfCnpj ***.***.***-09 não confere');
});

test('mensagem de erro sem dado pessoal passa intacta (ids, datas, números de processo, valores)', async () => {
  const msg = 'Tramitação 402 em /v1/processos/5010331-15.2024.4.03.6201: plano Ouro; lead 24405762 de 2026-10-30, R$ 1.234,56';
  const registros: Registro[] = [];
  const r = await executar('qualquer', {}, (x) => void registros.push(x), () => {
    throw new Error(msg);
  });
  assert.equal(texto(r), msg);
  assert.equal(registros[0]!.erro, msg);
});

test('sucesso: devolve o JSON, não grava erro e entrega os argumentos como vieram', async () => {
  const registros: Registro[] = [];
  const r = await executar('x', { a: 1 }, (x) => void registros.push(x), () => ({ ok: true }));
  assert.equal(r.isError, undefined);
  assert.equal(texto(r), '{"ok":true}');
  assert.equal(registros[0]!.erro, undefined);
  assert.equal(registros[0]!.ok, true);
  assert.deepEqual(registros[0]!.argumentos, { a: 1 });
});
