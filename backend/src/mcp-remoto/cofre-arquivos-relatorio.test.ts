/** O cofre de arquivos aceita CSV e extrato OFX (para o relatório da InfinitePay), SÓ quando o pedido do envio os lista em `tipos`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CofreDeArquivos, EXTENSOES_ACEITAS, ErroDeCofre, detectarTipo, validarArquivo } from './cofre-arquivos.js';

const OFX = Buffer.from('OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261103<TRNAMT>10.00<FITID>1<MEMO>x\n</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n');
const OFX_XML = Buffer.from('<?xml version="1.0"?>\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n');
const CSV = Buffer.from('Data;Valor\n01/11/2026;10,00\n');
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

test('OFX v1 e v2 são reconhecidos pelo conteúdo; o nome guardado leva a extensão .ofx', () => {
  assert.equal(detectarTipo(OFX), 'ofx');
  assert.equal(detectarTipo(OFX_XML), 'ofx');
  assert.deepEqual(validarArquivo('Extrato Novembro.ofx', OFX, 1e6), { tipo: 'ofx', nome: 'Extrato-Novembro.ofx' });
});

test('o que parece OFX mas é perigoso NÃO é OFX: DOCTYPE/ENTITY, script, byte de controle e XML qualquer', () => {
  assert.equal(detectarTipo(Buffer.from('<?xml version="1.0"?>\n<!DOCTYPE OFX [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<OFX>&x;</OFX>')), null);
  assert.notEqual(detectarTipo(Buffer.concat([OFX, Buffer.from('<script>alert(1)</script>')])), 'ofx', 'com <script> dentro não é OFX (cai como texto, como já caía antes)');
  assert.equal(detectarTipo(Buffer.concat([OFX, Buffer.from([0x00, 0x01])])), null);
  assert.equal(detectarTipo(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'XML que não é OFX continua barrado como marcação');
  assert.equal(detectarTipo(Buffer.from('OFXHEADER:100\nsem a marca do corpo')), 'txt', 'cabeçalho sem <OFX> é só texto');
});

test('CSV: só com a extensão .csv e texto de verdade por baixo; .txt continua .txt', () => {
  assert.deepEqual(validarArquivo('vendas.csv', CSV, 1e6), { tipo: 'csv', nome: 'vendas.csv' });
  assert.deepEqual(validarArquivo('vendas.txt', CSV, 1e6), { tipo: 'txt', nome: 'vendas.txt' });
  assert.throws(() => validarArquivo('vendas.csv', PDF, 1e6), /diz ser \.csv, mas o conteúdo é PDF/);
  assert.throws(() => validarArquivo('x.csv', Buffer.concat([CSV, Buffer.from([0x00])]), 1e6), /não é de um tipo aceito/);
  assert.throws(() => validarArquivo('x.csv', Buffer.from('<html><script>alert(1)</script></html>'), 1e6), /não é de um tipo aceito/);
});

test('.ofx com conteúdo que não é OFX e OFX com extensão trocada são recusados', () => {
  assert.throws(() => validarArquivo('extrato.ofx', CSV, 1e6), /diz ser \.ofx, mas o conteúdo é texto/);
  assert.throws(() => validarArquivo('extrato.pdf', OFX, 1e6), /diz ser \.pdf, mas o conteúdo é extrato OFX/);
});

test('o envio comum trata o OFX como sempre tratou: .txt com texto é aceito; OFX em XML (marcação) segue recusado', () => {
  assert.deepEqual(validarArquivo('extrato.txt', OFX, 1e6, false), { tipo: 'txt', nome: 'extrato.txt' });
  assert.equal(detectarTipo(OFX_XML, false), null);
  assert.equal(detectarTipo(OFX, false), 'txt');
});

test('o envio COMUM (sem lista de tipos) não aceita CSV nem OFX, e eles não aparecem entre as extensões aceitas', async () => {
  assert.equal(EXTENSOES_ACEITAS.includes('csv'), false);
  assert.equal(EXTENSOES_ACEITAS.includes('ofx'), false);
  const dir = mkdtempSync(path.join(tmpdir(), 'cofre-rel-'));
  try {
    const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre') });
    const p = cofre.pedirEnvio({ userId: 'u', finalidade: 'contrato' });
    const r = cofre.reservar(p.token);
    // no envio comum o OFX nem é reconhecido como OFX: continua sendo o que sempre foi (texto), e com a extensão .ofx é recusado
    await assert.rejects(() => cofre.guardar(r, 'x.ofx', OFX), (e: unknown) => e instanceof ErroDeCofre && /diz ser \.ofx, mas o conteúdo é texto/.test(e.message));
    const p2 = cofre.pedirEnvio({ userId: 'u', finalidade: 'contrato' });
    await assert.rejects(() => cofre.guardar(cofre.reservar(p2.token), 'x.csv', CSV), /não é aceito neste envio/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o envio que PEDE csv/ofx os aceita; com destino, o arquivo não vira link de download', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cofre-rel-'));
  try {
    const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre') });
    const p = cofre.pedirEnvio({ userId: 'u', finalidade: 'relatório', tipos: ['ofx', 'csv'], destino: { tipo: 'infinitepay-relatorio', unidade: 'x', relatorio: 'extrato' } });
    const g = await cofre.guardar(cofre.reservar(p.token), 'e.ofx', OFX);
    assert.equal(g.tipo, 'ofx');
    assert.throws(() => cofre.gerarLink('u', p.id, 10), /só segue para o sistema/);
    const a = await cofre.abrir('u', p.id);
    assert.equal(a.tipo, 'ofx');
    assert.equal(a.conteudo.equals(OFX), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
