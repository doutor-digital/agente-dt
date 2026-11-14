/**
 * Campos obrigatórios ao resolver: a regra (igual à da janela do menu), a etiqueta falta-etapa (pôr ao resolver sem os campos,
 * tirar quando completar), histórico fora, interruptor, e a janela do menu (parseia, só o botão «Resolver», deixa resolver na falha).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { aplicarResolucao, camposFaltandoAoResolver, eventoDeResolucao, ETIQUETA_FALTA } = await import('./chatwoot-resolver.js');
const { assistenteJs } = await import('./chatwoot-assistente-ui.js');

const CAIXAS = { 3: 'doutor-hernia-parauapebas' } as const;
const conv = (o: { status?: string; attrs?: Record<string, unknown>; labels?: string[]; event?: string; inbox?: number } = {}) => ({
  event: o.event ?? 'conversation_status_changed',
  id: 500,
  inbox_id: o.inbox ?? 3,
  status: o.status ?? 'resolved',
  labels: o.labels ?? [],
  custom_attributes: o.attrs ?? {},
});

test('regra: etapa sempre; Perdido pede motivo; Fechou pede valor > 0', () => {
  assert.deepEqual(camposFaltandoAoResolver({}), ['etapa']);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'Agendado' }), []);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'Perdido' }), ['motivo_nao_agendamento']);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), []);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'Fechou', valor_fechado: 0 }), ['valor_fechado']);
  assert.deepEqual(camposFaltandoAoResolver({ etapa: 'Fechou', valor_fechado: '4200' }), []);
  assert.deepEqual(camposFaltandoAoResolver(null), ['etapa']);
});

test('evento: resolvida sem etapa → pôr; completou depois → tirar; aberta sem etapa → nada; histórico e caixa de fora → null', () => {
  assert.equal(eventoDeResolucao(conv(), CAIXAS)?.acao, 'por');
  assert.equal(eventoDeResolucao(conv({ labels: [ETIQUETA_FALTA] }), CAIXAS)?.acao, null, 'já tem a etiqueta');
  assert.equal(eventoDeResolucao(conv({ event: 'conversation_updated', labels: [ETIQUETA_FALTA], attrs: { etapa: 'Agendado' } }), CAIXAS)?.acao, 'tirar');
  assert.equal(eventoDeResolucao(conv({ status: 'open' }), CAIXAS)?.acao, null, 'conversa aberta sem etapa não é problema');
  assert.equal(eventoDeResolucao(conv({ labels: ['historico'] }), CAIXAS), null);
  assert.equal(eventoDeResolucao(conv({ inbox: 9 }), CAIXAS), null);
  assert.equal(eventoDeResolucao(conv({ event: 'message_created' }), CAIXAS), null);
});

test('aplicar: manda a lista COMPLETA de etiquetas; interruptor desliga; falha não lança', async () => {
  const chamadas: Array<[number, string[]]> = [];
  const p = { etiquetas: async (c: number, l: string[]) => { chamadas.push([c, l]); } };
  assert.equal(await aplicarResolucao(eventoDeResolucao(conv({ labels: ['quente'] }), CAIXAS)!, p, {}), 'pos');
  assert.deepEqual(chamadas[0], [500, ['quente', ETIQUETA_FALTA]]);
  assert.equal(await aplicarResolucao(eventoDeResolucao(conv({ event: 'conversation_updated', labels: ['quente', ETIQUETA_FALTA], attrs: { etapa: 'Perdido', motivo_nao_agendamento: 'X' } }), CAIXAS)!, p, {}), 'tirou');
  assert.deepEqual(chamadas[1], [500, ['quente']]);
  assert.equal(await aplicarResolucao(eventoDeResolucao(conv(), CAIXAS)!, p, { CHATWOOT_RESOLVER_OBRIGATORIO: '0' }), 'nada');
  assert.equal(chamadas.length, 2);
  assert.equal(await aplicarResolucao(eventoDeResolucao(conv(), CAIXAS)!, { etiquetas: async () => { throw new Error('fora'); } }, {}), 'nada');
});

test('janela do menu: parseia, mesma regra, só o botão «Resolver», deixa resolver se falhar, interruptor', () => {
  const js = assistenteJs({}).split('__AGENTE__').join(JSON.stringify('https://agente.exemplo.test'));
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('var OBRIGATORIOS = true;'));
  assert.ok(assistenteJs({ CHATWOOT_RESOLVER_OBRIGATORIO: '0' }).includes('var OBRIGATORIOS = false;'));
  const ini = js.indexOf('var OBRIGATORIOS');
  const bloco = js.slice(ini, js.indexOf("window.addEventListener('message'", ini));
  assert.ok(bloco.includes("closest('.resolve-actions button')") && bloco.includes('ROTULO_RESOLVER.test'), 'só o botão Resolver do topo da conversa');
  assert.ok(bloco.includes(".catch(function(){ liberarResolver(); })"), 'falhou ler: deixa resolver');
  assert.ok(bloco.includes("etapa === 'Perdido' && !String(a.motivo_nao_agendamento") && bloco.includes("etapa === 'Fechou' && !(Number(a.valor_fechado) > 0)"), 'mesma regra do servidor');
  assert.ok(bloco.includes("Object.assign({}, base, novos)"), 'manda TODOS os atributos (o Chatwoot troca o conjunto inteiro)');
  assert.equal((bloco.match(/innerHTML/g) ?? []).length, 0);
});
