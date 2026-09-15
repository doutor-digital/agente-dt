import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoDeSessaoCaida, decidirProva, DIAS_SEM_PROVA } from './prova-de-sessao.js';

const AGORA = new Date('2026-09-15T15:00:00-03:00');
const diasAtras = (n: number) => new Date(AGORA.getTime() - n * 86_400_000);

test('renovou agora: já provou, não testa de novo', () => {
  // Emitir token É a prova. Testar depois seria chamada à toa no Kommo.
  const d = decidirProva(diasAtras(30), AGORA, { renovouAgora: true });
  assert.equal(d.provar, false);
  assert.equal(d.motivo, 'ja-provou-agora');
});

test('nunca provada: testa', () => {
  const d = decidirProva(null, AGORA);
  assert.equal(d.provar, true);
  assert.equal(d.motivo, 'nunca-provada');
  assert.equal(d.idadeDias, null);
});

test('prova recente: não testa', () => {
  const d = decidirProva(diasAtras(2), AGORA);
  assert.equal(d.provar, false);
  assert.equal(d.motivo, 'prova-recente');
});

test('o caso que motivou tudo: prova de 1 dia atrás não dispara nada', () => {
  // 15/09: `ultimo_ok` estava em 14/09 10:44 e eu li aquilo como "morta há um dia".
  // Com a régua certa, 1 dia é saúde normal — o alarme vem dos 7.
  const d = decidirProva(diasAtras(1), AGORA);
  assert.equal(d.provar, false);
});

test('prova velha (7 dias ou mais): testa', () => {
  const d = decidirProva(diasAtras(DIAS_SEM_PROVA), AGORA);
  assert.equal(d.provar, true);
  assert.equal(d.motivo, 'prova-velha');
});

test('a fronteira é fechada: 6,9 dias não testa, 7 testa', () => {
  assert.equal(decidirProva(diasAtras(6.9), AGORA).provar, false);
  assert.equal(decidirProva(diasAtras(7.0), AGORA).provar, true);
});

test('o limite é ajustável', () => {
  assert.equal(decidirProva(diasAtras(3), AGORA, { diasSemProva: 2 }).provar, true);
  assert.equal(decidirProva(diasAtras(3), AGORA, { diasSemProva: 10 }).provar, false);
});

test('o aviso diz quanta margem sobra e o que fazer', () => {
  const t = avisoDeSessaoCaida('401 Unauthorized', 3);
  assert.match(t, /mais 3 dia/);
  assert.match(t, /janela an[ôo]nima/i);
  assert.match(t, /401/);
});

test('sem margem, o aviso diz que JÁ está saindo em texto', () => {
  const t = avisoDeSessaoCaida('erro', 0);
  assert.match(t, /AGORA/);
});

test('margem desconhecida não inventa prazo', () => {
  const t = avisoDeSessaoCaida('erro', null);
  assert.doesNotMatch(t, /\d+ dia/);
  assert.match(t, /n[ãa]o consigo emitir novos/i);
});

test('o aviso corta erro gigante para não estourar a mensagem', () => {
  const t = avisoDeSessaoCaida('x'.repeat(500), 1);
  assert.ok(t.length < 600, `aviso ficou com ${t.length} chars`);
});
