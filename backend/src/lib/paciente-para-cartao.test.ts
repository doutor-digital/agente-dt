/**
 * A pessoa da franquia espelhada no cartão.
 *
 * Dois grupos de regra, e eles são opostos de propósito:
 *   - sexo e nascimento: a franquia SOBRESCREVE o cartão (é cadastro conferido);
 *   - o resto: só preenche o que está vazio.
 * Confundir os dois é escrever por cima do trabalho de uma pessoa.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escritasDoPaciente, idadeADesencalhar, idadeHoje, nascimentoEmEpoch, sexoDaFranquia,
} from './paciente-para-cartao.js';

const vazio = () => null;
const acha = (l: ReturnType<typeof escritasDoPaciente>, campo: string) => l.find((e) => e.campo === campo);

test('a franquia escreve sexo de várias formas — todas viram o que o Kommo aceita', () => {
  for (const v of ['F', 'f', 'Feminino', 'FEMININO', 'feminina', 'Mulher']) {
    assert.equal(sexoDaFranquia(v), 'Feminino', v);
  }
  for (const v of ['M', 'Masculino', 'masculino', 'Homem']) {
    assert.equal(sexoDaFranquia(v), 'Masculino', v);
  }
});

test('sexo desconhecido fica vazio — melhor vazio que errado', () => {
  for (const v of ['', null, undefined, 'Outro', 'Não informado', 'X', '  ']) {
    assert.equal(sexoDaFranquia(v), null, JSON.stringify(v));
  }
});

test('sexo e nascimento sobrescrevem o cartão; o resto não', () => {
  const l = escritasDoPaciente(
    { gender: 'F', birthdate: '1980-05-10', addressCity: 'Serra', source: 'Indicação' },
    (c) => (c === '⚥ Sexo' ? 'Masculino' : c === '⌂ Cidade' ? 'Vitória' : null),
  );
  assert.equal(acha(l, '⚥ Sexo')?.sobrescreve, true);
  assert.equal(acha(l, '⚥ Sexo')?.valor, 'Feminino');
  assert.equal(acha(l, '◷ Data de nascimento')?.sobrescreve, true);
  // Cidade já tinha valor: não entra na lista.
  assert.equal(acha(l, '⌂ Cidade'), undefined, 'cidade preenchida não pode ser tocada');
  assert.equal(acha(l, '⚑ Origem na franquia')?.sobrescreve, false);
});

test('não reescreve sexo quando já está igual — evita chamada à toa', () => {
  const l = escritasDoPaciente({ gender: 'Feminino' }, () => 'Feminino');
  assert.equal(acha(l, '⚥ Sexo'), undefined);
});

test('data de nascimento aceita os dois formatos da franquia', () => {
  const iso = nascimentoEmEpoch('1980-05-10');
  const br = nascimentoEmEpoch('10/05/1980');
  assert.ok(iso && br);
  assert.equal(iso, br, 'ISO e dd/mm/aaaa têm de dar o mesmo dia');
});

test('data impossível não vira campo — é erro de digitação, não paciente', () => {
  for (const v of ['', null, '0000-00-00', '1899-01-01', '2999-01-01', 'ontem', '31/31/1980']) {
    assert.equal(nascimentoEmEpoch(v), null, JSON.stringify(v));
  }
});

test('a data não escorrega um dia por causa de fuso', () => {
  const e = nascimentoEmEpoch('1980-05-10');
  assert.equal(new Date(e! * 1000).toISOString().slice(0, 10), '1980-05-10');
});

test('idade é calculada, nunca gravada — e respeita o aniversário', () => {
  const nasc = nascimentoEmEpoch('1980-05-10')!;
  assert.equal(idadeHoje(nasc, new Date('2026-05-09T12:00:00Z')), 45, 'véspera do aniversário');
  assert.equal(idadeHoje(nasc, new Date('2026-05-10T12:00:00Z')), 46, 'no aniversário');
  assert.equal(idadeHoje(null), null);
});

test('a idade É gravada — e vem junto com a data que a mantém viva', () => {
  const l = escritasDoPaciente({ birthdate: '1980-05-10' }, vazio);
  assert.ok(acha(l, '# Idade'), 'a recepção quer ler a idade, não a data');
  assert.ok(acha(l, '◷ Data de nascimento'), 'a data tem de ir junto, senão a idade não se corrige depois');
});

test('a idade se corrige sozinha a partir da data do próprio cartão', () => {
  const nasc = String(nascimentoEmEpoch('1980-05-10'));
  // Cartão diz 45, mas o aniversário já passou.
  const e = idadeADesencalhar(
    (c) => (c === '◷ Data de nascimento' ? nasc : c === '# Idade' ? '45' : null),
    new Date('2026-06-01T12:00:00Z'),
  );
  assert.equal(e?.valor, 46);
  assert.match(e!.motivo, /recalculada/);
});

test('idade certa não gera escrita — não bate no Kommo à toa', () => {
  const nasc = String(nascimentoEmEpoch('1980-05-10'));
  const e = idadeADesencalhar(
    (c) => (c === '◷ Data de nascimento' ? nasc : c === '# Idade' ? '46' : null),
    new Date('2026-06-01T12:00:00Z'),
  );
  assert.equal(e, null);
});

test('sem data de nascimento no cartão, não há idade a corrigir', () => {
  assert.equal(idadeADesencalhar(() => null), null);
  assert.equal(idadeADesencalhar((c) => (c === '# Idade' ? '40' : null)), null);
});

test('rua e número viram um endereço só', () => {
  const l = escritasDoPaciente({ address: 'Rua das Palmeiras', addressNumber: '120' }, vazio);
  assert.equal(acha(l, '⌂ Endereço')?.valor, 'Rua das Palmeiras, 120');
});

test('ficha vazia não gera escrita nenhuma', () => {
  assert.equal(escritasDoPaciente({}, vazio).length, 0);
  assert.equal(escritasDoPaciente({ gender: '', birthdate: null, addressCity: '   ' }, vazio).length, 0);
});

test('toda escrita diz o porquê — sem isso ninguém confere o campo', () => {
  const l = escritasDoPaciente(
    { gender: 'M', birthdate: '1975-01-02', addressCity: 'Serra', addressUf: 'ES', source: 'Meta', status: 'Ativo' },
    vazio,
  );
  assert.ok(l.length >= 5);
  for (const e of l) assert.ok(e.motivo.length > 4, `${e.campo} sem motivo`);
});
