import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ETAPAS_PADRAO, cartaoDaConversa, chaveConfere, chaveDoFunil, etapasDoAtributo, montarQuadro, nomeSeTemConta, notaDaMudanca, sessaoDosCabecalhos } from './funil-chatwoot.js';

test('chave: derivada do token, 32 hex, só confere a certa', () => {
  const k = chaveDoFunil('token-do-chatwoot');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(chaveDoFunil('token-do-chatwoot'), k);
  assert.notEqual(chaveDoFunil('outro-token'), k);
  assert.equal(chaveConfere('token-do-chatwoot', k), true);
  assert.equal(chaveConfere('token-do-chatwoot', k.replace(/.$/, k.endsWith('0') ? '1' : '0')), false);
  assert.equal(chaveConfere('token-do-chatwoot', undefined), false);
  assert.equal(chaveConfere(undefined, k), false);
  assert.equal(chaveConfere('token-do-chatwoot', 'curta'), false);
});

test('etapas: as do atributo `etapa` (sem repetir); sem atributo, as padrão', () => {
  assert.deepEqual(etapasDoAtributo([{ attribute_key: 'outro', attribute_values: ['x'] }]), [...ETAPAS_PADRAO]);
  assert.deepEqual(etapasDoAtributo(null), [...ETAPAS_PADRAO]);
  assert.deepEqual(etapasDoAtributo([{ attribute_key: 'etapa', attribute_values: ['Novo', ' Agendado ', 'Novo', ''] }]), ['Novo', 'Agendado']);
});

const conv = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  inbox_id: 3,
  status: 'open',
  last_activity_at: 1000 + id,
  meta: { sender: { name: `Paciente ${id}` }, assignee: { name: 'Stefany' } },
  messages: [{ content: 'quero   marcar\nconsulta', private: false }],
  labels: ['retorno'],
  custom_attributes: {},
  ...extra,
});

test('cartão: etapa vazia ou fora da lista cai na 1ª; nota interna não vaza como última mensagem', () => {
  const etapas = ['Novo', 'Agendado'];
  assert.equal(cartaoDaConversa(conv(1), etapas).etapa, 'Novo');
  assert.equal(cartaoDaConversa(conv(2, { custom_attributes: { etapa: 'Agendado' } }), etapas).etapa, 'Agendado');
  assert.equal(cartaoDaConversa(conv(3, { custom_attributes: { etapa: 'Etapa apagada' } }), etapas).etapa, 'Novo');
  const k = cartaoDaConversa(conv(4), etapas);
  assert.equal(k.ultimaMensagem, 'quero marcar consulta');
  assert.equal(k.responsavel, 'Stefany');
  assert.equal(cartaoDaConversa(conv(5, { messages: [{ content: 'segredo da equipe', private: true }] }), etapas).ultimaMensagem, '(nota interna)');
});

test('quadro: junta páginas sem repetir, mais recente primeiro, colunas na ordem das etapas', () => {
  const etapas = ['Novo', 'Agendado', 'Perdido'];
  const p1 = { data: { payload: [conv(1), conv(2, { custom_attributes: { etapa: 'Agendado' } })] } };
  const p2 = { data: { payload: [conv(2, { custom_attributes: { etapa: 'Agendado' } }), conv(3)] } };
  const q = montarQuadro([p1, p2], etapas);
  assert.equal(q.total, 3);
  assert.deepEqual(q.colunas.map((c) => c.etapa), etapas);
  assert.deepEqual(q.colunas[0].cartoes.map((c) => c.id), [3, 1]);
  assert.deepEqual(q.colunas[1].cartoes.map((c) => c.id), [2]);
  assert.deepEqual(q.colunas[2].cartoes, []);
});

test('nota da mudança diz de onde, para onde e quem', () => {
  assert.equal(notaDaMudanca('Novo', 'Agendado', 'Suzanne'), '📋 Etapa: Novo → Agendado (por Suzanne) — pelo funil');
  assert.equal(notaDaMudanca('Novo', 'Agendado', null), '📋 Etapa: Novo → Agendado — pelo funil');
});

test('login do Chatwoot: só com os 3 cabeçalhos, sem quebra de linha nem tamanho absurdo', () => {
  const h = (o: Record<string, string>) => (n: string) => o[n];
  assert.deepEqual(sessaoDosCabecalhos(h({ 'x-cw-token': ' t1 ', 'x-cw-client': 'c1', 'x-cw-uid': 'a@b.com' })), { token: 't1', client: 'c1', uid: 'a@b.com' });
  assert.equal(sessaoDosCabecalhos(h({ 'x-cw-token': 't1', 'x-cw-client': 'c1' })), null);
  assert.equal(sessaoDosCabecalhos(h({ 'x-cw-token': 't1\r\nX: y', 'x-cw-client': 'c1', 'x-cw-uid': 'u' })), null);
  assert.equal(sessaoDosCabecalhos(h({ 'x-cw-token': 'x'.repeat(201), 'x-cw-client': 'c1', 'x-cw-uid': 'u' })), null);
  assert.equal(sessaoDosCabecalhos(h({})), null);
});

test('perfil do Chatwoot: só passa quem tem acesso à conta do funil; o nome vem do perfil', () => {
  assert.equal(nomeSeTemConta({ name: 'Suzanne', accounts: [{ id: 1 }] }, 1), 'Suzanne');
  assert.equal(nomeSeTemConta({ name: 'Outra', accounts: [{ id: 7 }] }, 1), null);
  assert.equal(nomeSeTemConta({ name: 'Sem conta' }, 1), null);
  assert.equal(nomeSeTemConta(null, 1), null);
  assert.equal(nomeSeTemConta({ name: '', accounts: [{ id: '1' }] }, 1), 'alguém da equipe');
});
