import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREIOS_PADRAO } from './disparo/freios.js';
import { montarPainelDaOnda, telefoneMascarado, type DadosDoPainel } from './disparo/painel.js';

const base = (extra: Partial<DadosDoPainel> = {}, onda: Partial<DadosDoPainel['onda']> = {}): DadosDoPainel => ({
  onda: {
    id: 'o1', estado: 'montada', total: 27, etiqueta: 'Outubro Rosa · Dia 2', impressao: 'abc123', aprovadaPor: null, aprovadaEm: null, pausaMotivo: null,
    template: 'canaa_resgate_150_arte', idioma: 'pt_BR', textoModelo: 'Oi {{1}}, aqui é a {{2}}.', variaveis: ['primeiroNome', 'unidade'], cabecalho: { tipo: 'image', link: 'https://x.com/arte4.jpg' },
    ...onda,
  },
  campanhaNome: 'Outubro Rosa', unidade: { slug: 'doutor-hernia-canaa', nome: 'Doutor Hérnia Canaã' }, modo: 'seco', freios: FREIOS_PADRAO,
  resumo: { candidatos: 40, fora: { 'consulta-futura': 9, 'pediu-sair': 1, 'tratamento-aberto': 0 } }, contagem: { pendente: 27 }, simulados: 0,
  amostra: [{ nome: 'Maria', telefone: '5563991021043' }, { nome: '<b>Ana</b>', telefone: '5563988880002' }],
  conferenciaMeta: { ok: true }, podeAprovar: true, listaDeTeste: null,
  ...extra,
});

test('a tela mostra unidade, quantas pessoas, o texto final com as variáveis resolvidas e a amostra', () => {
  const html = montarPainelDaOnda(base());
  assert.ok(html.includes('Doutor Hérnia Canaã'));
  assert.ok(html.includes('<b>27</b><span>pessoas vão receber'));
  assert.ok(html.includes('Oi Maria, aqui é a Doutor Hérnia Canaã.'), 'texto final, sem {{1}}');
  assert.ok(!/\{\{\d\}\}/.test(html.replace(/<script[\s\S]*<\/script>/, '')), 'nenhuma variável sobrando na página');
  assert.ok(html.includes('tem consulta marcada na franquia'));
  assert.ok(html.includes('pediu para sair'));
  assert.ok(!html.includes('tem tratamento aberto'), 'motivo com zero não aparece');
  assert.ok(html.includes('Aprovar esta onda (27 pessoas)'));
});

test('MODO SECO fica gritado no topo: aprovar não manda nada', () => {
  assert.match(montarPainelDaOnda(base()), /MODO SECO[\s\S]*Aprovar NÃO manda mensagem nenhuma/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado' })), /UNIDADE LIGADA/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado', listaDeTeste: ['5563991021043'] })), /lista de teste: só 1 número/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado', listaDeTeste: [] })), /SEM lista de teste[\s\S]*ninguém recebe/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado', listaDeTeste: null })), /TODOS os aprovados recebem/);
});

test('telefone aparece mascarado e nome do paciente é escapado', () => {
  const html = montarPainelDaOnda(base());
  assert.equal(telefoneMascarado('5563991021043'), '+55 63 9••••-••43');
  assert.ok(html.includes('+55 63 9••••-••43'));
  assert.ok(!html.includes('5563991021043'));
  assert.ok(!html.includes('<b>Ana</b>'));
  assert.ok(html.includes('&lt;b&gt;Ana&lt;/b&gt;'));
});

test('o botão manda de volta o total e a impressão que a página mostrou (a lista não muda no meio)', () => {
  const html = montarPainelDaOnda(base());
  assert.ok(html.includes('total=27'));
  assert.ok(html.includes('impressao="abc123"'));
});

test('botão de aprovar trava sem permissão ou sem a conferência da Meta', () => {
  assert.match(montarPainelDaOnda(base({ podeAprovar: false })), /<button id="aprovar" disabled>/);
  assert.match(montarPainelDaOnda(base({ conferenciaMeta: { ok: false, motivo: 'texto diferente' } })), /<button id="aprovar" disabled>/);
  assert.match(montarPainelDaOnda(base({ conferenciaMeta: { ok: false, motivo: 'texto diferente' } })), /A Meta não confere:<\/b> texto diferente/);
  assert.match(montarPainelDaOnda(base()), /<button id="aprovar" >/);
});

test('onda já aprovada ou cancelada não oferece aprovar; aprovada oferece parar', () => {
  const aprovada = montarPainelDaOnda(base({}, { estado: 'aprovada', aprovadaPor: 'joao@x.com', aprovadaEm: new Date('2026-10-24T15:00:00Z') }));
  assert.ok(!aprovada.includes('id="aprovar"'));
  assert.ok(aprovada.includes('Parar e cancelar'));
  assert.ok(aprovada.includes('Aprovada por joao@x.com'));
  const cancelada = montarPainelDaOnda(base({}, { estado: 'cancelada', pausaMotivo: 'nenhuma pessoa elegível' }));
  assert.ok(!cancelada.includes('id="aprovar"') && !cancelada.includes('id="cancelar"'));
  assert.ok(cancelada.includes('nenhuma pessoa elegível'));
});

test('os freios aparecem com os números', () => {
  const html = montarPainelDaOnda(base());
  assert.ok(html.includes('9h às 18h'));
  assert.ok(html.includes('30 por hora e 100 por 24 horas'));
  assert.ok(html.includes('mais de 3 pessoas responderem SAIR'));
});
