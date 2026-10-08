/**
 * Guarda de saída do nome do profissional. O caso: Açailândia, 08/10/2026 11:16, cartão 28088906 — a
 * Sofia respondeu "Tudo certo com sua consulta de quarta, 07/10 às 13h com a fisioterapeuta Aylana"
 * sobre uma consulta que tinha sido ontem. O nome estava só no histórico (a confirmação de 06/10).
 *
 * O que estes testes prendem:
 *  - nome que só existe no histórico sai da resposta, a profissão fica;
 *  - nome que a ferramenta devolveu NESTE turno (agendar/remarcar) fica — é a confirmação de 21/09 e 03/10;
 *  - nome que está no prompt deste turno (consulta confirmada agora na franquia) fica;
 *  - ferramenta de um turno ANTERIOR não vale como fonte viva.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

import { resultadosDasFerramentasDoTurno, semNomeForaDaAgenda } from './nome-na-resposta.js';

const RESPOSTA_DO_BUG =
  'Oi, João! ☺ Tudo certo com sua consulta de quarta, 07/10 às 13h com a fisioterapeuta Aylana — posso te ajudar em mais alguma coisa antes do seu dia?';

const PROMPT_SEM_NOME = '<persona>Você é Dra. Sofia…</persona>\n<consulta_que_ja_passou>…</consulta_que_ja_passou>';

const agendou = new ToolMessage({
  content: 'Consulta agendada. Data: quarta-feira, 07/10/2026 13:00. Especialista: fisioterapeuta Aylana Silva Mendes',
  tool_call_id: 'call-1',
});

test('o caso de 08/10: nome que só existe no histórico sai, a profissão fica', () => {
  const r = semNomeForaDaAgenda(RESPOSTA_DO_BUG, PROMPT_SEM_NOME, [new HumanMessage('oi, teste')]);
  assert.equal(r.texto, 'Oi, João! ☺ Tudo certo com sua consulta de quarta, 07/10 às 13h com a fisioterapeuta — posso te ajudar em mais alguma coisa antes do seu dia?');
  assert.deepEqual(r.removidos, ['Aylana']);
});

test('confirmação logo depois de agendar: o nome que a ferramenta devolveu agora fica', () => {
  const turno = [
    new HumanMessage('pode ser às 13h'),
    new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'agendar_consulta', args: {} }] }),
    agendou,
  ];
  const confirmacao = '✅ Agendamento confirmado!\n⭐ Atendimento com: a fisioterapeuta Aylana Silva Mendes\nQualquer dúvida, é só chamar.';
  const r = semNomeForaDaAgenda(confirmacao, PROMPT_SEM_NOME, turno);
  assert.equal(r.texto, confirmacao);
  assert.deepEqual(r.removidos, []);
});

test('consulta confirmada agora na franquia (bloco vivo do prompt): o nome fica', () => {
  const prompt = '<consulta_do_paciente>\nConsulta CONFIRMADA agora no sistema da clínica: **09/10/2026 às 07:00** — com fisioterapeuta Aylana Silva Mendes.\n</consulta_do_paciente>';
  const r = semNomeForaDaAgenda('Sua consulta é sexta às 7h com a fisioterapeuta Aylana 😊', prompt, [new HumanMessage('com quem vai ser?')]);
  assert.deepEqual(r.removidos, []);
});

test('ferramenta de um turno anterior não é fonte viva', () => {
  const historico = [new HumanMessage('pode ser às 13h'), agendou, new AIMessage('✅ Agendamento confirmado!'), new HumanMessage('oi, teste')];
  assert.deepEqual(resultadosDasFerramentasDoTurno(historico), []);
  const r = semNomeForaDaAgenda(RESPOSTA_DO_BUG, PROMPT_SEM_NOME, historico);
  assert.deepEqual(r.removidos, ['Aylana']);
});

test('não mexe no que não é nome de gente', () => {
  for (const t of [
    'Aqui é a Sofia, da Doutor Hérnia Açailândia 😊',
    'Nossa fisioterapeuta especializada em coluna vai te avaliar.',
    'Quem atende é fisioterapeuta, não médico.',
  ]) {
    assert.equal(semNomeForaDaAgenda(t, '', [new HumanMessage('oi')]).texto, t);
  }
});

test('os dois caminhos de fala passam pela guarda: conversa (graph.ts) e régua (follow-up.ts)', () => {
  const graph = readFileSync(new URL('./graph.ts', import.meta.url), 'utf8');
  assert.match(graph, /semNomeForaDaAgenda\(\s*textoFinal\s*,\s*promptDoTurno\s*,\s*nonSystemMessages\s*\)/);
  // a resposta limpa precisa voltar para textoFinal, que é o que o guardrail e a entrega usam
  assert.match(graph, /textoFinal = comNomeChecado\.texto;/);
  const regua = readFileSync(new URL('./follow-up.ts', import.meta.url), 'utf8');
  assert.match(regua, /semNomeDeProfissional\(\s*sem(?:Intimidade|Diminutivo)\(/);
});
