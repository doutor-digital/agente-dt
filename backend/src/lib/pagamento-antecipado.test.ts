import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ehTranscricaoDeComprovante } from './pagamento-antecipado.js';

/**
 * Só a transcrição da visão vale como comprovante. O paciente ESCREVER
 * "comprovante" não vale — "vou mandar o comprovante" é promessa, não prova.
 */

test('recibo lido pela visão conta como comprovante', () => {
  assert.equal(
    ehTranscricaoDeComprovante('[imagem do cliente]: COMPROVANTE: R$ 100,00, 05/09/2026 09:12, pagador Lindomar Alves Pereira, para BENSAG FISIOTERAPIA LTDA'),
    true,
  );
});

test('texto do paciente antes da imagem não atrapalha', () => {
  assert.equal(
    ehTranscricaoDeComprovante('Segue\n\n[imagem do cliente]: "COMPROVANTE: Pix de R$ 100 …"'),
    true,
  );
});

test('caixa e aspas não importam', () => {
  assert.equal(ehTranscricaoDeComprovante('[imagem do cliente]: “comprovante: transferência R$ 100”'), true);
});

test('paciente dizendo que vai mandar o comprovante NÃO é prova', () => {
  assert.equal(ehTranscricaoDeComprovante('já fiz o pix, vou mandar o comprovante'), false);
  assert.equal(ehTranscricaoDeComprovante('paguei, tá?'), false);
});

test('imagem que não é recibo NÃO é prova', () => {
  assert.equal(ehTranscricaoDeComprovante('[imagem do cliente]: foto de um exame de ressonância da coluna lombar'), false);
  assert.equal(ehTranscricaoDeComprovante('[imagem do cliente]: [imagem sem conteúdo legível]'), false);
  assert.equal(ehTranscricaoDeComprovante('[cliente mandou uma imagem, mas não foi possível ler]'), false);
});

test('a palavra "comprovante" dentro da descrição de outra imagem não conta', () => {
  assert.equal(ehTranscricaoDeComprovante('[imagem do cliente]: print de conversa onde alguém pede o comprovante'), false);
});
