import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ACUMULADO,
  MAX_TRECHO,
  chaveDaConversa,
  juntarTrecho,
  limparSinal,
  limparTrecho,
  mascararDigitos,
  nomeParaMostrar,
  tipoMaisForte,
  trechoJaVisto,
} from './central-chamados.js';

const SEM_DIGITO_LONGO = (s: string) => assert.ok(!/\d{5,}/.test(s.replace(/[\s().-]/g, '')), s);

test('mascararDigitos: telefone em vários formatos some, fica só o final', () => {
  for (const t of ['liga 63 99999-1234 agora', '+55 (63) 9 9999-1234', '5563999991234', '(63) 3411-1234']) {
    const m = mascararDigitos(t);
    assert.ok(m.includes('1234'), m);
    assert.ok(!/9999|3411/.test(m), m);
    SEM_DIGITO_LONGO(m);
  }
});

test('mascararDigitos: CPF, cartão e e-mail somem; hora, valor e data ficam', () => {
  assert.ok(!mascararDigitos('cpf 123.456.789-09').includes('456'));
  assert.ok(!mascararDigitos('cartão 4111 1111 1111 1111').includes('1111 1111'));
  assert.ok(!mascararDigitos('manda pra ana.silva@gmail.com').includes('ana.silva'));
  assert.equal(mascararDigitos('@João vê isso'), '@João vê isso');
  assert.ok(!mascararDigitos('protocolo 1234567890123').includes('1234567890'));
  assert.equal(mascararDigitos('às 14:30, sala 12, R$ 350'), 'às 14:30, sala 12, R$ 350');
  assert.equal(mascararDigitos('dia 12/11/2026'), 'dia 12/11/2026');
});

test('limparTrecho: tira controle, junta espaço e corta no teto', () => {
  assert.equal(limparTrecho('  oi\u0000\n\n  tudo  bem '), 'oi tudo bem');
  const longo = limparTrecho('a'.repeat(1000));
  assert.equal(longo.length, MAX_TRECHO);
  assert.ok(longo.endsWith('…'));
  assert.equal(limparTrecho(42), '');
});

test('nomeParaMostrar: contato não salvo aparece mascarado', () => {
  const n = nomeParaMostrar('+55 63 99999-1234');
  assert.ok(n.includes('1234') && !n.includes('99999'), n);
  assert.equal(nomeParaMostrar('Mkt | Dr Hérnia Timbó'), 'Mkt | Dr Hérnia Timbó');
});

test('chaveDaConversa: ignora maiúsculas, muda com o segredo, não contém o nome', () => {
  const a = chaveDaConversa('Fulano', 's'.repeat(16));
  assert.equal(chaveDaConversa('fulano', 's'.repeat(16)), a);
  assert.notEqual(chaveDaConversa('Fulano', 'x'.repeat(16)), a);
  assert.ok(!a.includes('Fulano'));
});

test('juntarTrecho: anexa só o que é novo', () => {
  assert.equal(juntarTrecho('', 'a'), 'a');
  assert.equal(juntarTrecho('a', 'b'), 'a\nb');
  assert.equal(juntarTrecho('a\nb', 'a'), 'a\nb');
  assert.equal(juntarTrecho('a', ''), 'a');
});

test('juntarTrecho: guarda o fim quando passa do teto, sem linha cortada', () => {
  let acc = '';
  for (let i = 0; i < 100; i++) acc = juntarTrecho(acc, `linha ${i} ${'x'.repeat(40)}`);
  assert.ok(acc.length <= MAX_ACUMULADO);
  assert.match(acc.split('\n').at(-1)!, /^linha 99 /);
  assert.match(acc.split('\n')[0]!, /^linha \d+ x+$/);
});

test('tipoMaisForte: manual > menção > não lida, nunca rebaixa', () => {
  assert.equal(tipoMaisForte('nao_lida', 'mencao'), 'mencao');
  assert.equal(tipoMaisForte('mencao', 'nao_lida'), 'mencao');
  assert.equal(tipoMaisForte('mencao', 'manual'), 'manual');
  assert.equal(tipoMaisForte('manual', 'nao_lida'), 'manual');
});

test('limparSinal: aceita válido e limpa', () => {
  assert.deepEqual(limparSinal({ conversa: ' Grupo  X ', tipo: 'mencao', grupo: true, trecho: 'Ana: @João liga 63999991234', naoLidas: 3.7 }), {
    normalizado: 'Grupo X',
    conversa: 'Grupo X',
    grupo: true,
    tipo: 'mencao',
    trecho: mascararDigitos('Ana: @João liga 63999991234'),
    naoLidas: 3,
  });
});

test('limparSinal: recusa sem nome, tipo estranho e lixo', () => {
  assert.equal(limparSinal({ conversa: '', tipo: 'mencao' }), null);
  assert.equal(limparSinal({ conversa: 'X', tipo: 'apagar' }), null);
  assert.equal(limparSinal(null), null);
  assert.equal(limparSinal('x'), null);
});

test('limparSinal: grupo só com true; não lidas negativas viram 0', () => {
  const s = limparSinal({ conversa: 'X', tipo: 'nao_lida', grupo: 'sim', naoLidas: -5 });
  assert.equal(s?.grupo, false);
  assert.equal(s?.naoLidas, 0);
});

test('trechoJaVisto: mesmo selo não reabre; mensagem nova reabre; vazio nunca conta', () => {
  assert.equal(trechoJaVisto('a\nb', 'b'), true);
  assert.equal(trechoJaVisto('a\nb', 'c'), false);
  assert.equal(trechoJaVisto('a', ''), false);
  assert.equal(trechoJaVisto('', ''), false);
});
