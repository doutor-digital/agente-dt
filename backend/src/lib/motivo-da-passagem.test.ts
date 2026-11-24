/** Categorias do motivo de a Sofia passar a conversa para a equipe (tela Agente → «Passou para a equipe»). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTIVOS_DA_PASSAGEM, categoriaDoMotivo, rotuloDoMotivo } from './motivo-da-passagem.js';

test('avisos fixos do código têm categoria exata, qualquer que seja o texto', () => {
  assert.equal(categoriaDoMotivo('o Pix do sinal não saiu. Asaas fora', 'pix'), 'pix-falhou');
  assert.equal(categoriaDoMotivo('cadastro recusado — ids 1, 2', 'agenda'), 'agenda');
  assert.equal(categoriaDoMotivo('qualquer coisa', 'horario'), 'horario-divergente');
});

test('texto livre do modelo (pausar_ia) vira categoria por palavra-chave; o que não casa é «outro»', () => {
  assert.equal(categoriaDoMotivo('o paciente quer falar com uma pessoa'), 'pediu-pessoa');
  assert.equal(categoriaDoMotivo('Pediu atendente humano'), 'pediu-pessoa');
  assert.equal(categoriaDoMotivo('pergunta sobre convênio Unimed'), 'convenio');
  assert.equal(categoriaDoMotivo('quer saber se aceita o plano de saúde'), 'convenio');
  assert.equal(categoriaDoMotivo('dúvida sobre o exame de ressonância'), 'clinico');
  assert.equal(categoriaDoMotivo('dor muito forte, pediu urgência'), 'clinico', 'clínico antes de valor/pessoa');
  assert.equal(categoriaDoMotivo('quer negociar o valor e pedir desconto'), 'valor-pagamento');
  assert.equal(categoriaDoMotivo('paciente reclamou do atendimento'), 'reclamacao');
  assert.equal(categoriaDoMotivo('preciso remarcar para outro horário'), 'agenda');
  assert.equal(categoriaDoMotivo('assunto de trabalho do paciente'), 'outro');
  assert.equal(categoriaDoMotivo('dúvida sobre o processo de tratamento da coluna'), 'outro', 'processo neutro não é reclamação');
  assert.equal(categoriaDoMotivo('o atendente anterior já cuidou disso'), 'outro', 'só o pedido de uma pessoa conta, não a palavra solta');
  assert.equal(categoriaDoMotivo(''), 'outro');
});

test('rótulo: código conhecido ganha o texto; vazio, nulo ou desconhecido = «sem motivo registrado» (nunca inventa)', () => {
  for (const c of Object.keys(MOTIVOS_DA_PASSAGEM)) assert.equal(rotuloDoMotivo(c).codigo, c);
  assert.deepEqual(rotuloDoMotivo(null), { codigo: 'sem-registro', rotulo: 'Sem motivo registrado' });
  assert.deepEqual(rotuloDoMotivo(''), { codigo: 'sem-registro', rotulo: 'Sem motivo registrado' });
  assert.deepEqual(rotuloDoMotivo('2026-11-17T09:00'), { codigo: 'sem-registro', rotulo: 'Sem motivo registrado' });
});
