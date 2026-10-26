import { test } from 'node:test';
import assert from 'node:assert/strict';

import { motivoDeBloqueio, ETIQUETAS_QUE_CALAM_A_REGUA, ETIQUETAS_QUE_CALAM_TUDO } from './mensagem-bloqueada.js';

const cartao = (name: string, ...tags: string[]) => ({ name, _embedded: { tags: tags.map((t) => ({ name: t })) } });

test('Boituva #6298947: "NÃO É LEAD" está no NOME, não numa etiqueta — vale para lembrete e para régua', () => {
  const c = cartao('VIVO OPERADORA - NÃO É LEAD', 'Follow-up-120');
  assert.match(motivoDeBloqueio(c, 'regua') ?? '', /NÃO É LEAD/);
  assert.match(motivoDeBloqueio(c, 'lembrete') ?? '', /NÃO É LEAD/);
});

test('o nome é lido sem acento, sem caixa e com pontuação no meio', () => {
  for (const nome of ['nao e lead', 'Número errado — NAO É LEAD!', 'não é lead', 'X (não é Lead)']) {
    assert.ok(motivoDeBloqueio(cartao(nome), 'regua'), nome);
  }
  // "lead" sozinho, ou "não é" sem lead, não bloqueia
  for (const nome of ['Maria 20/10/26', 'Lead quente', 'não é Maria, é a filha', 'leadership']) {
    assert.equal(motivoDeBloqueio(cartao(nome), 'regua'), null, nome);
  }
});

test('os nomes exatos das etiquetas das contas calam tudo, escritos como estão e também sem acento', () => {
  for (const t of ETIQUETAS_QUE_CALAM_TUDO) {
    assert.ok(motivoDeBloqueio(cartao('Maria', t), 'lembrete'), `${t} (lembrete)`);
    assert.ok(motivoDeBloqueio(cartao('Maria', t), 'regua'), `${t} (régua)`);
  }
  assert.ok(motivoDeBloqueio(cartao('Maria', 'nao-mandar-mensagem'), 'lembrete'), 'sem acento');
  assert.ok(motivoDeBloqueio(cartao('Maria', 'NÃO-MANDAR-MENSAGEM'), 'lembrete'), 'caixa alta');
  assert.ok(motivoDeBloqueio(cartao('Maria', 'fluxo · opt-out whatsapp'), 'lembrete'), 'caixa baixa');
});

test('NO_FOLLOW_UP e as etiquetas de "morto" calam a régua mas NÃO a pergunta de uma consulta marcada', () => {
  for (const t of ETIQUETAS_QUE_CALAM_A_REGUA) {
    assert.ok(motivoDeBloqueio(cartao('Maria', t), 'regua'), `${t} (régua)`);
    assert.equal(motivoDeBloqueio(cartao('Maria', t), 'lembrete'), null, `${t} (lembrete): quem marcou continua recebendo`);
  }
});

test('Capivari #5699887: 23-arquivo-morto cala a régua', () => {
  assert.match(motivoDeBloqueio(cartao('.', '23-arquivo-morto', 'Follow-up-120'), 'regua') ?? '', /23-arquivo-morto/);
});

test('estorno: etiqueta ou nome calam tudo (hoje nenhuma conta tem a etiqueta — a regra espera por ela)', () => {
  assert.ok(motivoDeBloqueio(cartao('Maria', 'Estorno'), 'lembrete'));
  assert.ok(motivoDeBloqueio(cartao('Maria - ESTORNO PIX'), 'lembrete'));
  // o que a Açailândia tinha no #28780654 não é estorno por etiqueta: continua passando (e fica no relatório do PR)
  assert.equal(motivoDeBloqueio(cartao('ROSÂNGELA / MARIA DAS DORES 19/10/26', 'Fora do escopo', '$ · Pagou antecipado'), 'regua'), null);
});

test('etiquetas comuns não bloqueiam: origem, IA, follow-up já enviado, remarcação', () => {
  const c = cartao('Stella Mary', 'Alerta · Mora fora', 'Origem · Anúncio', '⚠ Revisar cartão', 'IA · Sofia atendeu', 'Follow-up-120', 'Fluxo · Remarcação solicitada');
  assert.equal(motivoDeBloqueio(c, 'regua'), null);
  assert.equal(motivoDeBloqueio(c, 'lembrete'), null);
});

test('cartão ilegível ou sem etiqueta: não há prova, não bloqueia', () => {
  assert.equal(motivoDeBloqueio(null, 'regua'), null);
  assert.equal(motivoDeBloqueio(undefined, 'lembrete'), null);
  assert.equal(motivoDeBloqueio({ name: null, _embedded: null }, 'regua'), null);
  assert.equal(motivoDeBloqueio({ name: 'Maria', _embedded: { tags: null } }, 'regua'), null);
});
