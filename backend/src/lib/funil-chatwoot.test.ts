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

import { camposParaGravar, desdeAEtapa, historicoDasMensagens, idsDasPaginas, situacaoDaTarefa, telefoneParaCadastro, valorEmReais, valoresDoAtributo } from './funil-chatwoot.js';

test('valor em reais: formatos BR e número; lixo vira 0', () => {
  assert.equal(valorEmReais('R$ 1.234,50'), 1234.5);
  assert.equal(valorEmReais('350'), 350);
  assert.equal(valorEmReais(1800), 1800);
  assert.equal(valorEmReais('1.800'), 1800);
  assert.equal(valorEmReais('R$ 2.000'), 2000);
  assert.equal(valorEmReais('2.000.000'), 2000000);
  assert.equal(valorEmReais('350.5'), 350.5);
  assert.equal(valorEmReais('abc'), 0);
  assert.equal(valorEmReais(-5), 0);
  assert.equal(valorEmReais(null), 0);
});

test('situação da tarefa: sem, vencida (dias), hoje, futura — pelo dia de SP', () => {
  const agora = new Date('2026-11-11T18:00:00Z'); // 15h em SP
  assert.deepEqual(situacaoDaTarefa([], agora), { tipo: 'sem' });
  assert.deepEqual(situacaoDaTarefa([new Date('2026-11-11T13:00:00Z')], agora), { tipo: 'vencida', dias: 0 });
  assert.deepEqual(situacaoDaTarefa([new Date('2026-11-09T13:00:00Z')], agora), { tipo: 'vencida', dias: 2 });
  assert.deepEqual(situacaoDaTarefa([new Date('2026-11-11T22:00:00Z')], agora), { tipo: 'hoje' });
  assert.deepEqual(situacaoDaTarefa([new Date('2026-11-13T12:00:00Z')], agora), { tipo: 'futura' });
  // a mais próxima manda
  assert.equal(situacaoDaTarefa([new Date('2026-11-13T12:00:00Z'), new Date('2026-11-10T12:00:00Z')], agora).tipo, 'vencida');
});

test('cartão: valor, qualificação, telefone, avatar só https, última mensagem dela', () => {
  const k = cartaoDaConversa(
    { id: 9, created_at: 100, meta: { sender: { name: 'Ana', phone_number: '+5563999991234', thumbnail: 'javascript:x' } }, custom_attributes: { valor_fechado: '350', qualificacao: 'Quente' }, messages: [{ content: 'oi', message_type: 0 }] },
    ['Novo'],
    { tipo: 'hoje' },
  );
  assert.equal(k.valor, 350);
  assert.equal(k.qualificacao, 'Quente');
  assert.equal(k.telefone, '+5563999991234');
  assert.equal(k.avatar, null);
  assert.equal(k.ultimaDela, true);
  assert.deepEqual(k.tarefa, { tipo: 'hoje' });
});

test('quadro: soma em R$ por coluna e ids das páginas', () => {
  const p = { data: { payload: [{ id: 1, custom_attributes: { etapa: 'Fechou', valor_fechado: 1800 } }, { id: 2, custom_attributes: { etapa: 'Fechou', valor_fechado: '200,50' } }] } };
  const q = montarQuadro([p], ['Novo', 'Fechou']);
  assert.equal(q.colunas[1]!.soma, 2000.5);
  assert.deepEqual(idsDasPaginas([p]), [1, 2]);
});

test('histórico: tipos certos, sem vazio, em ordem; desde a etapa pela nota do funil', () => {
  const h = historicoDasMensagens({
    payload: [
      { id: 3, content: '📋 Etapa: Novo → Agendado (por X) — pelo funil', private: true, message_type: 1, created_at: 30 },
      { id: 1, content: 'oi', message_type: 0, created_at: 10, sender: { name: 'Ana' } },
      { id: 2, content: 'olá', message_type: 1, created_at: 20 },
      { id: 4, content: '', message_type: 2, created_at: 40 },
    ],
  });
  assert.deepEqual(h.map((x) => x.tipo), ['ela', 'nos', 'nota']);
  assert.equal(desdeAEtapa(h, 'Agendado', 5), 30);
  assert.equal(desdeAEtapa(h, 'Perdido', 5), 5);
});

test('campos: só os editáveis, lista fechada, valor em reais, vazio limpa', () => {
  const defs = [{ attribute_key: 'qualificacao', attribute_values: ['Quente', 'Frio'] }];
  assert.deepEqual(valoresDoAtributo(defs, 'qualificacao'), ['Quente', 'Frio']);
  assert.deepEqual(camposParaGravar({ qualificacao: 'Quente', valor_fechado: 'R$ 350' }, defs), { ok: true, campos: { qualificacao: 'Quente', valor_fechado: 350 } });
  assert.deepEqual(camposParaGravar({ valor_fechado: '1.800' }, defs), { ok: true, campos: { valor_fechado: 1800 } });
  assert.deepEqual(camposParaGravar({ qualificacao: '' }, defs), { ok: true, campos: { qualificacao: null } });
  assert.equal(camposParaGravar({ qualificacao: 'Morno' }, defs).ok, false);
  assert.equal(camposParaGravar({ etapa: 'Fechou' }, defs).ok, false);
  assert.equal(camposParaGravar({}, defs).ok, false);
});

test('telefone da adição rápida: com DDD vira +55; curto é recusado', () => {
  assert.equal(telefoneParaCadastro('(63) 99999-1234'), '+5563999991234');
  assert.equal(telefoneParaCadastro('+55 63 99999-1234'), '+5563999991234');
  assert.equal(telefoneParaCadastro('1234'), null);
});
