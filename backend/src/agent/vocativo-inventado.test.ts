import { test } from 'node:test';
import assert from 'node:assert/strict';

import { semVocativoInventado } from './vocativo-inventado.js';

const msg = (tipo: 'human' | 'ai' | 'tool', content: string) => ({ getType: () => tipo, content });

// Parauapebas, lead 28679252 (15/10/2026): o que a IA tinha em mãos naquele turno — nenhum "Amanda" em lugar nenhum
const PROMPT = '<memoria_paciente>Paciente é cabeleireira e apresenta dor de pescoço…</memoria_paciente>';
const CONVERSA = [
  msg('human', 'Qual o valor da consulta!'),
  msg('ai', 'Claro, já te explico certo! 😊 Antes só me conta: onde dói e há quanto tempo?'),
  msg('human', 'Estou com um hérnia cervical e na lombar sinto muitas dores no pescoço e ombro'),
  msg('human', '[áudio do cliente]: Mulher, tem dias que eu sinto muitas dores no pescoço, incha um pouco assim os braços. Logo, eu sou cabeleireira.'),
  msg('human', '[áudio do cliente]: Vou me organizar aqui e entro em contato com você novamente.'),
];

test('Parauapebas 28679252: "Amanda" não estava em lugar nenhum — o vocativo sai e o resto fica', () => {
  const a = semVocativoInventado('Combinado, Amanda! 😊 Fico no aguardo então, sem pressa nenhuma.', PROMPT, CONVERSA);
  assert.equal(a.texto, 'Combinado! 😊 Fico no aguardo então, sem pressa nenhuma.');
  assert.deepEqual(a.removidos, ['Amanda']);
  const b = semVocativoInventado('Poxa, Amanda, isso já está pesando bastante no seu dia a dia 😢', PROMPT, CONVERSA);
  assert.equal(b.texto, 'Poxa, isso já está pesando bastante no seu dia a dia 😢');
});

test('nome que o paciente disse, que está na memória ou que a ferramenta devolveu fica', () => {
  const conversa = [...CONVERSA, msg('human', 'Franciara')];
  assert.equal(semVocativoInventado('Prazer, Franciara! 💙 Me conta onde dói?', PROMPT, conversa).texto, 'Prazer, Franciara! 💙 Me conta onde dói?');
  assert.equal(semVocativoInventado('Entendo, Fran, isso preocupa mesmo 💙', PROMPT, conversa).removidos.length, 0, 'diminutivo do nome conhecido');
  // nome curto (Taubaté 20/10, Araguaína 14/10): "Lu" que o paciente escreveu, ou começo de "Luciana"
  assert.equal(semVocativoInventado('Que bom, Lu, Caçapava é perto daqui 😊', PROMPT, [...CONVERSA, msg('human', 'pode me chamar de Lu')]).removidos.length, 0);
  assert.equal(semVocativoInventado('Oi, Lu 😊 Faz tempo já', PROMPT, [...CONVERSA, msg('human', 'Luciana')]).removidos.length, 0);
  const comMemoria = `${PROMPT}\n<memoria_paciente>nome: Cristiane</memoria_paciente>`;
  assert.equal(semVocativoInventado('Combinado, Cristiane! 😊', comMemoria, CONVERSA).removidos.length, 0);
  const comFerramenta = [...CONVERSA, msg('tool', 'Paciente achado na franquia: JOSÉ CARLOS DA SILVA')];
  assert.equal(semVocativoInventado('Perfeito, José! Já vi aqui.', PROMPT, comFerramenta).removidos.length, 0, 'acento e caixa não importam');
});

test('o nome que a própria IA inventou antes não vira fonte', () => {
  const conversa = [...CONVERSA, msg('ai', 'Poxa, Amanda, isso já está pesando…')];
  assert.deepEqual(semVocativoInventado('Combinado, Amanda!', PROMPT, conversa).removidos, ['Amanda']);
});

test('só o vocativo depois de uma abertura sai: nome no meio da frase e frase sem abertura ficam', () => {
  for (const t of [
    'A consulta com a especialista Juliana é às 15h 😊',
    'Tenho horário na terça, Segunda-feira não tem 🙏',
    'Fica na Rua C, Cidade Nova, perto do Fórum.',
    'Oi Amanda! Tudo bem?',
    // palavra comum depois da vírgula não é nome, mesmo fora das fontes
    'Certo, então. Vou ver um horário pra você 😊',
    'Combinado, obrigada!',
    // tratamento e abreviação (Bebedouro 20/10, Balsas 20/10): não é o nome
    'Combinado, Sr. Belino! Vamos te esperar sexta-feira, 23/10, às 17:30.',
    'Entendo, Dra. Sofia aqui 😊',
  ]) {
    assert.equal(semVocativoInventado(t, PROMPT, CONVERSA).texto, t, t);
  }
});

test('outras aberturas: "Que bom te ver, X!", "Entendi, X —", no começo de outra frase', () => {
  assert.equal(semVocativoInventado('Que bom te ver, Marta! Como está a dor?', PROMPT, CONVERSA).texto, 'Que bom te ver! Como está a dor?');
  assert.equal(semVocativoInventado('Entendi, Marta — isso é bem comum.', PROMPT, CONVERSA).texto, 'Entendi — isso é bem comum.');
  assert.equal(semVocativoInventado('A consulta é R$ 350. Certo, Marta?', PROMPT, CONVERSA).texto, 'A consulta é R$ 350. Certo?');
});
