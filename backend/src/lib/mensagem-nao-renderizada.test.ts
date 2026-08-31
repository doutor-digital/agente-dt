import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ehAvisoDeMensagemNaoRenderizada,
  tratarMensagemNaoRenderizada,
  AVISO_PARA_IA,
} from './mensagem-nao-renderizada.js';

// O texto exato que chegou 81 vezes em 7 dias, copiado do banco.
const REAL =
  'Unable to display this message in CRM. View it in the WhatsApp Business app. '
  + 'You can reply in CRM. Learn more: '
  + 'https://support.kommo.com/docs/troubleshoot-whatsapp-message-errors#message-available-only-in-the-app-error-131060';

test('reconhece o aviso real que chega do Kommo', () => {
  assert.equal(ehAvisoDeMensagemNaoRenderizada(REAL), true);
});

test('reconhece variações do mesmo aviso', () => {
  assert.equal(ehAvisoDeMensagemNaoRenderizada('Unable to display this message in CRM.'), true);
  assert.equal(ehAvisoDeMensagemNaoRenderizada('View it in the WhatsApp Business app'), true);
  assert.equal(ehAvisoDeMensagemNaoRenderizada('Não foi possível exibir esta mensagem'), true);
});

test('fala normal do paciente não é confundida com aviso', () => {
  for (const t of [
    'Oi, tudo bem?',
    'Quanto custa a consulta?',
    'Meu WhatsApp Business é esse mesmo',
    'Vi no app de vocês',
    'Manda o link do endereço por favor',
  ]) {
    assert.equal(ehAvisoDeMensagemNaoRenderizada(t), false, `"${t}" virou aviso por engano`);
  }
});

test('vazio não é aviso', () => {
  assert.equal(ehAvisoDeMensagemNaoRenderizada(''), false);
  assert.equal(ehAvisoDeMensagemNaoRenderizada(null), false);
  assert.equal(ehAvisoDeMensagemNaoRenderizada(undefined), false);
});

test('o aviso vira observação, não fala do paciente', () => {
  assert.equal(tratarMensagemNaoRenderizada(REAL), AVISO_PARA_IA);
});

test('mensagem normal passa intacta', () => {
  assert.equal(tratarMensagemNaoRenderizada('Tenho dor na lombar'), 'Tenho dor na lombar');
});

test('a observação proíbe falar em link — era o erro que o juiz apontava', () => {
  assert.match(AVISO_PARA_IA, /NÃO comente o erro nem fale em link/);
});

test('a observação manda pedir por escrito, em vez de ignorar', () => {
  assert.match(AVISO_PARA_IA, /conte por escrito/);
});
