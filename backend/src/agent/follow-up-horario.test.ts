import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horarioInventadoNoDegrau } from './follow-up.js';

// A régua gera o texto sem ferramenta de agenda: dia e hora que ela cita são inventados.
const semConsulta = async () => null;
const comConsulta = async () => '2026-10-27T14:00';
const ARGS = { unitId: 'u', leadId: 6564047, fuso: 'America/Sao_Paulo' };
const AGORA = new Date('2026-10-22T14:04:00Z'); // quinta 22/10, 11:04 em Bebedouro

test('régua: "tenho horário terça às 14h ou quarta às 10h" sem consulta não sai (Bebedouro 6564047, 22/10 11:04)', async () => {
  const texto = 'Anastácio, tenho horário terça às 14h ou quarta às 10h pra você conversar com o especialista. Qual fica melhor? ☺';
  const r = await horarioInventadoNoDegrau(texto, ARGS, semConsulta, AGORA);
  assert.ok(r, 'deveria barrar');
  assert.match(r!, /14:00/);
  assert.match(r!, /10:00/);
});

test('régua: data com hora também não sai', async () => {
  assert.ok(await horarioInventadoNoDegrau('Consigo pra você dia 27/10 às 15h30, pode ser?', ARGS, semConsulta, AGORA));
});

test('régua: convite sem hora continua saindo', async () => {
  for (const texto of [
    'Oi, Marcos! Quer que eu veja os horários de quinta pra você? 😊',
    'Sem pressa nenhuma, tá? Quando quiser, é só me chamar que eu vejo um horário pra você. 💙',
    'Anastácio, nosso método trata a hérnia de disco de forma conservadora. Quer que eu veja um horário pra você conversar com o especialista?',
  ]) {
    assert.equal(await horarioInventadoNoDegrau(texto, ARGS, semConsulta, AGORA), null, texto);
  }
});

test('régua: quem tem consulta marcada pode ouvir o horário dela', async () => {
  assert.equal(await horarioInventadoNoDegrau('Te espero terça às 14h, combinado? ☺', ARGS, comConsulta, AGORA), null);
});
