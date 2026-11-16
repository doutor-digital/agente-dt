import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conviteAberto, criarConvite, DIAS_DE_VALIDADE, FORMATO_DO_CODIGO, gerarCodigo, hashDoCodigo, registrarEnvio } from './convites.js';
import { bancoConvitesFalso } from './convites-falso.js';
import { validarFormulario } from './formulario.js';
import { respostasValidas } from './formulario-exemplo.js';

const respostas = () => {
  const v = validarFormulario(respostasValidas());
  assert.ok(v.ok);
  return v.ok ? v.respostas : (undefined as never);
};

test('código: 24 caracteres seguros para URL, aleatório, e o banco guarda só o hash', async () => {
  const a = gerarCodigo();
  assert.match(a, FORMATO_DO_CODIGO);
  assert.notEqual(a, gerarCodigo());
  const banco = bancoConvitesFalso();
  const c = await criarConvite(banco, { rotulo: 'Dra. Teste', criadoPor: 'joao' });
  assert.match(c.codigo, FORMATO_DO_CODIGO);
  const guardado = JSON.stringify(banco.linhas);
  assert.ok(!guardado.includes(c.codigo), 'o código em si nunca é guardado');
  assert.ok(guardado.includes(hashDoCodigo(c.codigo)));
});

test('vale 14 dias, uso único', async () => {
  const banco = bancoConvitesFalso();
  const t0 = new Date('2026-11-16T12:00:00Z');
  const c = await criarConvite(banco, { rotulo: 'x', criadoPor: 'joao', agora: t0 });
  assert.equal(DIAS_DE_VALIDADE, 14);
  assert.equal(c.expiraEm.toISOString(), '2026-11-30T12:00:00.000Z');
  assert.ok(await conviteAberto(banco, c.codigo, new Date('2026-11-29T12:00:00Z')));
  assert.equal(await conviteAberto(banco, c.codigo, new Date('2026-11-30T12:00:00Z')), null, 'vence no instante');
  const envio = await registrarEnvio(banco, c.codigo, respostas(), new Date('2026-11-20T00:00:00Z'));
  assert.ok(envio);
  assert.equal(await conviteAberto(banco, c.codigo, new Date('2026-11-20T00:00:01Z')), null, 'depois de usado não abre');
  assert.equal(await registrarEnvio(banco, c.codigo, respostas(), new Date('2026-11-20T00:00:02Z')), null, 'segundo envio é recusado');
  assert.equal(banco.linhas[0]!.slugSugerido, 'doutor-hernia-serra');
});

test('errado, mal formado, vencido, usado e revogado: todos dão null (sem dizer qual)', async () => {
  const banco = bancoConvitesFalso();
  const agora = new Date('2026-11-16T12:00:00Z');
  const usado = await criarConvite(banco, { rotulo: 'usado', criadoPor: 'j', agora });
  await registrarEnvio(banco, usado.codigo, respostas(), agora);
  const revogado = await criarConvite(banco, { rotulo: 'revogado', criadoPor: 'j', agora });
  assert.equal(await banco.revogar(banco.linhas[1]!.id, new Date(agora.getTime() + 1000)), true);
  const velho = await criarConvite(banco, { rotulo: 'velho', criadoPor: 'j', agora: new Date('2026-10-01T00:00:00Z') });
  const depois = new Date(agora.getTime() + 2000);
  for (const codigo of [usado.codigo, revogado.codigo, velho.codigo, gerarCodigo(), 'curto', '', undefined, null, 42, 'a'.repeat(24) + '!', "'; drop table--"]) {
    assert.equal(await conviteAberto(banco, codigo, depois), null, String(codigo));
  }
});

test('dois envios AO MESMO TEMPO: só um ganha', async () => {
  const banco = bancoConvitesFalso();
  const c = await criarConvite(banco, { rotulo: 'x', criadoPor: 'j' });
  const r = await Promise.all([registrarEnvio(banco, c.codigo, respostas()), registrarEnvio(banco, c.codigo, respostas()), registrarEnvio(banco, c.codigo, respostas())]);
  assert.equal(r.filter(Boolean).length, 1);
});

test('revogar não apaga, e não revoga o que já foi usado', async () => {
  const banco = bancoConvitesFalso();
  const c = await criarConvite(banco, { rotulo: 'x', criadoPor: 'j' });
  await registrarEnvio(banco, c.codigo, respostas());
  assert.equal(await banco.revogar(banco.linhas[0]!.id, new Date()), false);
  assert.equal(banco.linhas.length, 1);
  assert.ok(banco.linhas[0]!.respostas, 'as respostas continuam lá');
});

test('dias fora de 1..60 são recusados', async () => {
  const banco = bancoConvitesFalso();
  for (const dias of [0, -1, 61, 1.5, Number.NaN]) await assert.rejects(criarConvite(banco, { rotulo: 'x', criadoPor: 'j', dias }));
});
