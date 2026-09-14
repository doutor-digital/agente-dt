import test from 'node:test';
import assert from 'node:assert/strict';
import { BOTOES_D1, classificarRespostaD1, janelaAberta, textoAlertaSemJanela, JANELA_WHATSAPP_MS } from './confirmacao-d1.js';

const agora = new Date('2026-09-14T12:00:00Z');
const h = (n: number) => new Date(agora.getTime() - n * 3600_000);

test('janelaAberta: paciente escreveu há 2 h → aberta; há 30 h → fechada; nunca escreveu → fechada', () => {
  assert.equal(janelaAberta([{ direcao: 'saida', em: h(1) }, { direcao: 'entrada', em: h(2) }], agora), true);
  assert.equal(janelaAberta([{ direcao: 'entrada', em: h(30) }, { direcao: 'saida', em: h(1) }], agora), false);
  assert.equal(janelaAberta([{ direcao: 'saida', em: h(1) }], agora), false);
  assert.equal(janelaAberta([], agora), false);
  assert.ok(JANELA_WHATSAPP_MS < 24 * 3600_000, 'folga de segurança antes das 24 h');
});

test('os rótulos dos botões da véspera são reconhecidos pelo classificador', () => {
  assert.equal(classificarRespostaD1(BOTOES_D1[0]), 'confirmou');
  assert.equal(classificarRespostaD1(BOTOES_D1[1]), 'remarcar');
});

test('textoAlertaSemJanela: vai para o grupo com nome, hora e o motivo', () => {
  const t = textoAlertaSemJanela({ slug: 'doutor-hernia-maraba', nome: 'Maria', quando: '2026-09-15 14:30' });
  assert.match(t, /^ALERTA · doutor-hernia-maraba · \[Contato: Maria\] 📅 Consulta amanhã às 14:30 SEM confirmação/);
  assert.match(t, /24 h/);
});
