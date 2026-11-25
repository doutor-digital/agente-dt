import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desdeAEtapa, exigeConfirmacao, ETAPAS_PADRAO, etapasDoTratamento, funilDaConversa, notaDaMudancaDeTratamento, cartaoDaConversa, chaveConfere, chaveDoFunil, etapasDoAtributo, montarQuadro, nomeSeTemConta, notaDaMudanca, sessaoDosCabecalhos } from './funil-chatwoot.js';

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

test('cartão: nota interna depois da mensagem do paciente NÃO tira o lead de «Esperando resposta» (nota «Veio do anúncio», #334)', () => {
  const etapas = ['Novo', 'Agendado'];
  const k = cartaoDaConversa(conv(6, { messages: [
    { content: 'Olá! Tenho interesse', message_type: 0 },
    { content: '📣 Veio do anúncio «AGENDAR AVALIAÇÃO!»', message_type: 1, private: true },
  ] }), etapas);
  assert.equal(k.ultimaDela, true);
  assert.equal(k.ultimaMensagem, 'Olá! Tenho interesse');
  // a listagem só trouxe a nota (conversa já vista): o waiting_since do Chatwoot decide
  const so = (w: number) => cartaoDaConversa(conv(7, { messages: [{ content: 'nota', message_type: 1, private: true }], last_non_activity_message: { content: 'nota', private: true }, waiting_since: w }), etapas);
  assert.equal(so(1794631315).ultimaDela, true);
  assert.equal(so(0).ultimaDela, false);
  assert.equal(so(0).ultimaMensagem, '(nota interna)');
  // a equipe respondeu depois do paciente: não está esperando
  const r = cartaoDaConversa(conv(8, { messages: [{ content: 'oi', message_type: 0 }, { content: 'Olá!', message_type: 1 }, { content: 'nota', message_type: 1, private: true }] }), etapas);
  assert.equal(r.ultimaDela, false);
  assert.equal(r.ultimaMensagem, 'Olá!');
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

test('cartão: aviso do sistema ("Atribuído a…") não vira a última mensagem', () => {
  const k = cartaoDaConversa({ id: 1, messages: [{ content: 'quero marcar', message_type: 0 }, { content: 'Atribuído a Suzanne', message_type: 2 }] }, ['Novo']);
  assert.equal(k.ultimaMensagem, 'quero marcar');
  assert.equal(k.ultimaDela, true);
});

test('cartão: lista do Chatwoot com só o aviso do sistema cai no last_non_activity_message', () => {
  const k = cartaoDaConversa({ id: 2, messages: [{ content: 'Atribuído a X', message_type: 2 }], last_non_activity_message: { content: 'oi doutor', message_type: 0 } }, ['Novo']);
  assert.equal(k.ultimaMensagem, 'oi doutor');
  assert.equal(k.ultimaDela, true);
});

test('cartão: id do responsável (o filtro "Minhas" compara por id, não por nome)', () => {
  assert.equal(cartaoDaConversa({ id: 1, meta: { assignee: { id: 7, name: 'Ana' } } }, ['Novo']).responsavelId, 7);
  assert.equal(cartaoDaConversa({ id: 2, meta: {} }, ['Novo']).responsavelId, null);
  assert.equal(cartaoDaConversa({ id: 3, meta: { assignee: { id: 'x' } } }, ['Novo']).responsavelId, null);
});

test('cartão: a nossa mensagem de espera (crm-demora) como última pública NÃO tira a paciente de «esperando resposta»', async () => {
  const { textoDaEspera } = await import('./crm-demora/marca.js');
  const etapas = ['Novo', 'Agendado'];
  const nossa = { message_type: 1, private: false, content: textoDaEspera('Maria') };
  const c = cartaoDaConversa(conv(7, { messages: [{ message_type: 0, content: 'quero marcar', private: false }, nossa] }), etapas);
  assert.equal(c.ultimaDela, true);
  // resposta de gente depois dela: a paciente deixa de esperar
  assert.equal(cartaoDaConversa(conv(8, { messages: [{ message_type: 0, content: 'quero marcar', private: false }, nossa, { message_type: 1, content: 'Oi, Maria!', private: false }] }), etapas).ultimaDela, false);
});

test('funilDaConversa: `funil` explícito manda; sem ele, etapa_tratamento preenchida = Tratamento; o resto é Comercial', () => {
  assert.equal(funilDaConversa({}), 'comercial');
  assert.equal(funilDaConversa({ funil: 'Tratamento' }), 'tratamento');
  assert.equal(funilDaConversa({ funil: ' tratamento ' }), 'tratamento');
  // a MESMA regra da régua e da Sofia: etapa_tratamento preenchida = Tratamento, mesmo com funil «Comercial» escrito
  assert.equal(funilDaConversa({ funil: 'Comercial', etapa_tratamento: 'Alta' }), 'tratamento');
  assert.equal(funilDaConversa({ funil: 'Comercial' }), 'comercial');
  assert.equal(funilDaConversa({ etapa_tratamento: 'Em tratamento' }), 'tratamento');
  assert.equal(funilDaConversa({ etapa_tratamento: '  ' }), 'comercial');
  assert.equal(funilDaConversa({ funil: 3, etapa_tratamento: null }), 'comercial');
});

test('etapasDoTratamento lê as opções de `etapa_tratamento` (vazio = a conta não tem o funil de Tratamento)', () => {
  assert.deepEqual(etapasDoTratamento([{ attribute_key: 'etapa_tratamento', attribute_values: ['Entrada', ' Alta ', 'Entrada'] }]), ['Entrada', 'Alta']);
  assert.deepEqual(etapasDoTratamento([{ attribute_key: 'etapa', attribute_values: ['Novo'] }]), []);
  assert.deepEqual(etapasDoTratamento(undefined), []);
});

test('montarQuadro com Tratamento: cartão sem etapa_tratamento válida vai para a 1ª etapa do tratamento; quadro sem etapasDoTrat é o de sempre (campos novos só somam)', () => {
  const pag = { data: { payload: [conv(1, { custom_attributes: { funil: 'Tratamento' } }), conv(2, { custom_attributes: { etapa: 'Agendado' } })] } };
  const trat = montarQuadro([pag], ['Novo', 'Agendado'], new Map(), ['Entrada', 'Alta'], 'tratamento');
  assert.deepEqual(trat.etapas, ['Entrada', 'Alta']);
  assert.deepEqual(trat.colunas[0]!.cartoes.map((k) => k.id), [1]);
  assert.deepEqual(trat.funis.map((f) => [f.id, f.total]), [['comercial', 1], ['tratamento', 1]]);
  const velho = montarQuadro([pag], ['Novo', 'Agendado']);
  assert.equal(velho.total, 2);
  assert.deepEqual(velho.funis, []);
  assert.ok(velho.colunas.flatMap((c) => c.cartoes).every((k) => k.funil === 'comercial'));
});

test('a nota do tratamento tem outro prefixo (desdeAEtapa só lê as notas da etapa comercial)', () => {
  assert.equal(notaDaMudancaDeTratamento('Alta', 'Em tratamento', 'Ana'), '📋 Etapa do tratamento: Alta → Em tratamento (por Ana) — pelo funil');
  assert.ok(!notaDaMudancaDeTratamento('A', 'B', null).startsWith('📋 Etapa:'));
});

test('desdeAEtapa conta os dias pela nota CERTA: a do tratamento para quem está no Tratamento, a comercial para o resto', () => {
  const h = (texto: string, quando: number) => ({ id: quando, tipo: 'nota' as const, texto, quem: null, quando, anexo: false });
  const historico = [h('📋 Etapa: Novo lead → Agendado (por Ana) — pelo funil', 100), h('📋 Etapa do tratamento: Entrada → Em tratamento (por Bia) — pelo funil', 500)];
  assert.equal(desdeAEtapa(historico, 'Em tratamento', 10, true), 500);
  assert.equal(desdeAEtapa(historico, 'Agendado', 10), 100);
  assert.equal(desdeAEtapa(historico, 'Em tratamento', 10), 10, 'a nota do tratamento não vale para a etapa comercial');
  assert.equal(desdeAEtapa(historico, 'Agendado', 10, true), 10);
});

test('só Alta e Tratamento cancelado (as etapas que a régua observa) pedem confirmação', () => {
  assert.ok(exigeConfirmacao('Alta') && exigeConfirmacao('Tratamento cancelado'));
  for (const e of ['Entrada', 'Em tratamento', 'Falta de retorno', 'alta']) assert.equal(exigeConfirmacao(e), false, e);
});
