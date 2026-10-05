/**
 * Sugestão do motivo do não agendamento. O que estes testes prendem — os erros reais do gabarito do João:
 *  - "Atende pelo plano?" + silêncio NÃO é Plano de Saúde (caso 10193959): a trava troca por "parou de responder";
 *  - motivo dito pelo paciente com as palavras dele passa;
 *  - opção que a conta não tem (ou resposta ilegível) não vira sugestão.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { autorDaMensagem, interpretarResposta, montarPrompt, type FalaDaConversa } from './sugestao-motivo.js';

const OPCOES = ['Sem condições financeira', 'Não interagiu', 'Informação para terceiro', 'Outra patologia', 'Clicou por engano',
  'Sem interesse', 'Não deu continuidade ao atendimento', 'Vai se organizar', 'Plano de Saúde', 'Outra cidade'];
const P = (texto: string): FalaDaConversa => ({ autor: 'PACIENTE', texto });
const S = (texto: string): FalaDaConversa => ({ autor: 'SOFIA', texto });

test('perguntou do plano e sumiu: "Plano de Saúde" sem prova vira "Não deu continuidade" (caso 10193959)', () => {
  const falas = [P('Olá, quero informações'), P('Bom dia, atende pelo plano São Bernardo?'), S('Não faturamos pelo plano, mas…'), S('Posso guardar um horário?')];
  const r = interpretarResposta('{"frase_do_paciente": "atende pelo plano São Bernardo?", "resposta": "Plano de Saúde"}', falas, OPCOES)!;
  assert.equal(r.motivo, 'Não deu continuidade ao atendimento');
  assert.equal(r.travado, true);
});

test('quase não conversou: a trava cai em "Não interagiu"', () => {
  const falas = [P('Olá, quero informações'), S('Como posso te chamar?'), S('Me conta onde dói?')];
  const r = interpretarResposta('{"frase_do_paciente": "", "resposta": "Sem interesse"}', falas, OPCOES)!;
  assert.equal(r.motivo, 'Não interagiu');
});

test('motivo dito pelo paciente passa, com a grafia da conta', () => {
  const falas = [P('Quanto custa?'), S('R$ 350'), P('Só faço se for pelo plano, obrigado'), S('Entendo!')];
  const r = interpretarResposta('{"frase_do_paciente": "Só faço se for pelo plano, obrigado", "resposta": "plano de saude"}', falas, OPCOES)!;
  assert.equal(r.motivo, 'Plano de Saúde');
  assert.equal(r.travado, false);
});

test('paciente falou por último: não trava (a conversa ainda está com ele)', () => {
  const falas = [P('Quero saber o valor'), S('R$ 350'), P('vou pensar')];
  const r = interpretarResposta('{"frase_do_paciente": "", "resposta": "Vai se organizar"}', falas, OPCOES)!;
  assert.equal(r.motivo, 'Vai se organizar');
});

test('frase inventada (não está nas falas do paciente) não serve de prova', () => {
  const falas = [P('Oi'), P('quanto é?'), S('R$ 350'), S('Posso marcar?')];
  const r = interpretarResposta('{"frase_do_paciente": "está muito caro pra mim", "resposta": "Sem condições financeira"}', falas, OPCOES)!;
  assert.equal(r.motivo, 'Não deu continuidade ao atendimento');
});

test('resposta ilegível ou opção fora da conta → null (o widget diz que não conseguiu)', () => {
  assert.equal(interpretarResposta('não sei', [], OPCOES), null);
  assert.equal(interpretarResposta('{"resposta": "Motivo inventado"}', [], OPCOES), null);
});

test('autor: externo = paciente; bot e "Doutor Digital" (voz da Sofia) = Sofia; resto = equipe', () => {
  assert.equal(autorDaMensagem({ type: 'external' }), 'PACIENTE');
  assert.equal(autorDaMensagem({ type: 'bot' }), 'SOFIA');
  assert.equal(autorDaMensagem({ type: 'internal', name: 'Doutor Digital' }), 'SOFIA');
  assert.equal(autorDaMensagem({ type: 'internal', name: 'Néia' }), 'EQUIPE');
});

test('prompt leva as opções da conta e a conversa marcada por autor', () => {
  const p = montarPrompt([P('oi'), S('olá')], OPCOES);
  assert.ok(p.includes('"Plano de Saúde"'));
  assert.ok(p.includes('PACIENTE: oi\nSOFIA: olá'));
  assert.ok(p.includes('PERGUNTAR não é dizer o motivo'));
});
