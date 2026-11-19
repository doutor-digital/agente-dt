/**
 * A IA comenta a própria ferramenta para o paciente (Tatuí 19/11/2026, lead 4282053, trace cmwnu9v4a0gc0lk019t2i65kp):
 * depois de gravar "Ocupado" no cartão, o turno seguinte abriu com "Desculpa, isso não devia ter sido feito, vou corrigir." e
 * a saudação normal — e foi entregue pelo salesbot. Salto 13/11 (lead 3580474) fez igual, mas a resposta foi descartada por outro motivo.
 *
 * Medido em 20/10–19/11 (32.177 respostas da IA, role=assistant e meta.origem nulo): "Desculpa…" aparece em 142 e "corrig" em 7;
 * só a do Tatuí tem a autocorreção da ferramenta. Por isso o padrão é estreito (ver os negativos abaixo).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cortarAberturaMetanarrativa, detectarVazamento } from './vazamento.js';

const TATUI =
  'Desculpa, isso não devia ter sido feito — vou corrigir.\n\n' +
  'Oi, tudo bem? 😊 Boa tarde! Me chamo Cíntia, sou secretária da Clínica Doutor Hérnia de Tatuí. Somos especialistas em coluna e nervo ciático.\n\n' +
  'Vi que se interessou pelos nossos tratamentos. O(a) senhor(a) sente dores? Onde são essas dores?';

const SALTO =
  'Desculpa, não precisava ter feito isso — vamos ao que importa:\n\n' +
  'Olá, boa tarde! Tudo bem com o(a) senhor(a)? Qual é o seu nome? Me chamo Aline, sou secretária da Clínica Doutor Hérnia de Salto.';

test('a abertura do Tatuí é bastidor', () => {
  assert.equal(detectarVazamento(TATUI)?.tipo, 'bastidor_em_portugues');
  assert.equal(detectarVazamento('Desculpa, isso não devia ter sido feito, vou corrigir.')?.tipo, 'bastidor_em_portugues');
});

test('a abertura do Salto é bastidor', () => {
  assert.equal(detectarVazamento(SALTO)?.tipo, 'bastidor_em_portugues');
});

test('o parágrafo da autocorreção sai sozinho e fica só a saudação (sem chamar o modelo)', () => {
  const sai = cortarAberturaMetanarrativa(TATUI);
  assert.ok(sai.startsWith('Oi, tudo bem?'), sai);
  assert.doesNotMatch(sai, /devia ter sido feito|vou corrigir/i);
  assert.equal(detectarVazamento(sai), null, 'o que sobra tem de estar limpo');
  const salto = cortarAberturaMetanarrativa(SALTO);
  assert.ok(salto.startsWith('Olá, boa tarde!'), salto);
  assert.equal(detectarVazamento(salto), null);
});

test('autocorreção no meio do parágrafo continua sendo detectada (o reescritor resolve)', () => {
  assert.ok(detectarVazamento('Oi! Isso não deveria ter sido feito, desculpa. Como posso te chamar?'));
  assert.ok(detectarVazamento('Oi, tudo bem? Perdão, não devia ter feito isso. Onde dói?'));
});

test('empatia e pedido de desculpa legítimos passam', () => {
  for (const ok of [
    'Sinto muito, isso não deveria ter acontecido com você. Me conta o que houve?',
    'Desculpa a confusão! Vou corrigir o seu nome no cadastro agora. Como é o sobrenome?',
    'Desculpa, você tem razão: o horário era 15h. Posso confirmar 15h?',
    'Ah, entendi, obrigada por corrigir! 😊 Ele sente dormência na perna?',
    'Ah, só corrigindo: ainda não ficou nada marcado, viu, Marlise? Combinado?',
    'A cirurgia não precisa ser feita agora, o tratamento conservador resolve muitos casos. Quer conhecer?',
    'Aaah, obrigada pela lembrança! Não precisava ter feito isso 😊 Posso te ajudar com o horário?',
    'Isso não devia ser feito sem orientação: não puxe a perna sozinho. Onde sente a dor?',
  ]) {
    assert.equal(detectarVazamento(ok), null, `barrou fala legítima: ${ok}`);
  }
});
