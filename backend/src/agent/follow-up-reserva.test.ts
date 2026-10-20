import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservaFalsaNoDegrau } from './follow-up.js';

// Degraus reais da régua (06–20/10/2026) — a régua só fala com quem NÃO marcou.
const semConsulta = async () => null;
const ARGS = { unitId: 'u', leadId: 20951523, fuso: 'America/Boa_Vista' };

test('régua: "Deixo guardado um horário na sexta pra você" sem consulta não sai (Teresinha, Boa Vista 20951523, 20/10 08:12)', async () => {
  const texto =
    'Sem pressa, Teresinha 💙 Deixo guardado um horário na sexta pra você, e quando puder me diz qual prefere, 08:30 ou 09:00. Vou ficar à disposição por aqui 😊';
  assert.equal(await reservaFalsaNoDegrau(texto, ARGS, semConsulta), 'Deixo guardado um horário na sexta pra você');
});

test('régua: "seu horário de quinta fica guardado" e "deixei dois horários guardados" também não saem', async () => {
  assert.ok(await reservaFalsaNoDegrau('Seu horário de quinta às 13h fica guardado esperando por você.', ARGS, semConsulta));
  assert.ok(await reservaFalsaNoDegrau('Junior, deixei dois horários guardados pra quinta, dia 22/10: às 07h ou às 11h 🙏', ARGS, semConsulta));
});

test('régua: oferta e condição continuam saindo ("quando quiser, deixo um horário guardado")', async () => {
  for (const texto of [
    'Sem pressa nenhuma, tá? 😊 Quando quiser retomar é só me chamar que deixo um horário guardado pra você. Um abraço e até já! 💜',
    'Sem problemas, fico por aqui 🙏 Posso deixar um horário reservado pra sua consulta e você me diz quando puder, tá bom? 💙',
    'Oi, Marcos! Quer que eu veja os horários de quinta pra você? 😊',
  ]) {
    assert.equal(await reservaFalsaNoDegrau(texto, ARGS, semConsulta), null, texto);
  }
});

test('régua: com consulta de verdade no vínculo da franquia, falar do horário guardado é verdade e sai', async () => {
  const comConsulta = async () => '2026-10-23T08:30';
  assert.equal(await reservaFalsaNoDegrau('Seu horário de sexta às 08:30 fica guardado esperando por você.', ARGS, comConsulta), null);
});
