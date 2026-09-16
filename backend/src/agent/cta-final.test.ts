import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { avaliarChamadaFinal } from './cta-final.js';

describe('avaliarChamadaFinal (juiz determinístico da pergunta final)', () => {
  it('aprova quando tem pergunta, botões ou pedido direto', () => {
    assert.equal(avaliarChamadaFinal('Entendi, dor lombar há 3 meses não é pouco. Onde exatamente dói mais?').precisaRefazer, false);
    assert.equal(avaliarChamadaFinal('Tenho quinta 14h ou sexta 9h.\n[[botoes: Quinta 14h | Sexta 9h]]').precisaRefazer, false);
    assert.equal(avaliarChamadaFinal('Perfeito! Assim que fizer o Pix me avisa aqui que eu já confirmo sua vaga.').precisaRefazer, false);
    assert.equal(avaliarChamadaFinal('Chave Pix: 63 99999-0000 (Doutor Hérnia). Só me confirmar quando cair.').precisaRefazer, false);
  });
  it('aprova despedidas e confirmações, que não pedem pergunta', () => {
    assert.equal(avaliarChamadaFinal('Sua consulta está confirmada pra quinta às 14h. Te espero lá! 😊').precisaRefazer, false);
    assert.equal(avaliarChamadaFinal('Combinado então, Maria. Até amanhã e bom descanso 🙏').precisaRefazer, false);
    assert.equal(avaliarChamadaFinal('Ok!').precisaRefazer, false, 'curta demais pra cobrar');
  });
  it('reprova a resposta que só informa e para', () => {
    const v = avaliarChamadaFinal('A consulta com a especialista é R$ 350, ou R$ 200 pagando antes. É nela que se descobre a causa da dor.');
    assert.equal(v.precisaRefazer, true);
    assert.match(v.motivo ?? '', /sem pergunta/);
    assert.equal(avaliarChamadaFinal('A clínica fica na Rua das Flores, 100, no centro. Atendemos de segunda a sexta das 8h às 18h.').precisaRefazer, true);
  });
});
