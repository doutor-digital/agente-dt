import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ehEncerramento, ehEncerramentoRepetido, JANELA_ENCERRAMENTO_MS } from './encerramento.js';

const t0 = new Date('2026-09-04T04:32:00-03:00');
const seg = (s: number) => new Date(t0.getTime() + s * 1000);

/** A conversa real do Carlos (Parauapebas, 04/09/2026), na ordem em que aconteceu. */
const carlos = [
  { role: 'assistant', content: 'Carlos, o próximo sábado com vaga é dia 14/09. Tenho 13h ou 14h da tarde disponíveis 😊 Qual fica melhor pra você?', createdAt: seg(-60) },
  { role: 'user', content: 'Irei verificar aí aviso vcs', createdAt: seg(0) },
  { role: 'user', content: 'Obrigado pelo atendimento', createdAt: seg(2) },
  { role: 'assistant', content: 'Combinado, Carlos! 😊 Fico no aguardo do seu retorno pra garantir o sábado dia 14/09 às 13h ou 14h pra você. Qualquer coisa é só me chamar por aqui, tá bom? 💙', createdAt: seg(10) },
  { role: 'user', content: 'Ok obrigado', createdAt: seg(60) },
  { role: 'assistant', content: 'Eu que agradeço, Carlos! 😊 Foi um prazer conversar com você, e vou ficar de olho aqui pra te ajudar quando decidir. Cuide-se e até breve! 💙🙏', createdAt: seg(70) },
];

test('o que é encerramento e o que não é', () => {
  for (const s of ['Ok obrigado', 'obrigada!', 'valeu 🙏', '🙏', '👍', 'tá bom, obrigado', 'Obrigado pelo atendimento', 'até mais', 'de nada', 'blz']) {
    assert.equal(ehEncerramento(s), true, `deveria ser encerramento: ${s}`);
  }
  for (const s of ['Obrigado, mas qual o valor?', 'ok, e sábado tem?', 'Vcs aceitam o plano Hapvida?', 'Não dá tô no trabalho', 'Irei verificar aí aviso vcs', 'obrigado, pode marcar 13h']) {
    assert.equal(ehEncerramento(s), false, `NÃO deveria ser encerramento: ${s}`);
  }
});

test('Carlos: "Ok obrigado" recebe despedida (1ª vez); "🙏" depois da despedida fica sem resposta', () => {
  // no momento do "Ok obrigado", a última mensagem da IA respondia a "Irei verificar…", que não é encerramento
  assert.equal(ehEncerramentoRepetido('Ok obrigado', carlos.slice(0, 4), seg(60)), false);
  // depois de "Eu que agradeço…", o "🙏" é o 2º encerramento em sequência
  assert.equal(ehEncerramentoRepetido('🙏', carlos, seg(75)), true);
});

test('pergunta depois da despedida SEMPRE responde, mesmo curta', () => {
  assert.equal(ehEncerramentoRepetido('e sábado?', carlos, seg(75)), false);
  assert.equal(ehEncerramentoRepetido('qual o valor?', carlos, seg(75)), false);
});

test('agradecimento horas depois é conversa nova — responde', () => {
  assert.equal(ehEncerramentoRepetido('obrigado', carlos, new Date(seg(70).getTime() + JANELA_ENCERRAMENTO_MS + 1000)), false);
});

test('sem histórico ou com a última mensagem sendo do paciente, não bloqueia', () => {
  assert.equal(ehEncerramentoRepetido('obrigado', [], seg(0)), false);
  assert.equal(ehEncerramentoRepetido('🙏', carlos.slice(0, 5), seg(65)), false, 'a IA ainda não respondeu ao "Ok obrigado"');
});
