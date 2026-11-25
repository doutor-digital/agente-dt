/**
 * Modelo do WhatsApp mandado à mão: os parâmetros vêm preenchidos (só sugestão). Modelo do CRM usa a MESMA regra da régua; modelo de fora é lido pelo texto; sem dado, vazio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { preencherModelo, nomeBaseDoModelo, parametrosDoCorpo, papelDoParametro } = await import('./modelo-preenchido.js');
const { renderizar, variaveisDoModeloCampoACampo, proximaDataDaConversa } = await import('./chatwoot-regua.js');
const { textosDaUnidade } = await import('./chatwoot-modelos.js');
const { SEMENTE_PARAUAPEBAS } = await import('./chatwoot-unidades.js');

const conversa = (nome: string, attrs: Record<string, unknown> = {}) => ({ id: 77, nome, etiquetas: [], attrs, criadaEm: new Date(0), atendente: null, ultima: null });
const parau = { nome: 'Doutor Hérnia Parauapebas', pixKey: null, valorAntecipado: 200 };
const consulta = { data_consulta: '2026-12-02', hora_consulta: '15:00' };

test('MODELO DO CRM (Parauapebas): {{1}} primeiro nome e {{2}} data e horário — os MESMOS valores que a régua manda (renderizar)', () => {
  const c = conversa('maria da silva', consulta);
  const r = preencherModelo({ modelo: 'parau_consulta_lembrete_vespera' }, c, parau);
  assert.equal(r.origem, 'crm');
  assert.deepEqual(r.valores, { '1': 'Maria', '2': '02/12 às 15:00' });
  const regua = renderizar('parau_consulta_lembrete_vespera', c, parau);
  assert.deepEqual(regua.variaveis, [r.valores['1'], r.valores['2']], 'uma regra só: o que a atendente recebe é o que a régua enviaria');
});

test('MODELO DO CRM de clínica com prefixo próprio (timbocrm_): o nome base da régua é o mesmo, os dados são os da unidade', () => {
  const d = { nome: 'Doutor Hérnia Timbó', cidade: 'Timbó', endereco: 'Rua A, 1 — Centro, Timbó/SC', mapa: 'https://maps.example/timbo' };
  const textos = textosDaUnidade(d).textos;
  const u = { nome: d.nome, pixKey: null, valorAntecipado: null, textos, prefixoModelos: 'timbocrm_' };
  assert.equal(nomeBaseDoModelo('timbocrm_consulta_lembrete_vespera', 'timbocrm_'), 'parau_consulta_lembrete_vespera');
  const r = preencherModelo({ modelo: 'timbocrm_consulta_lembrete_vespera' }, conversa('Joana', consulta), u);
  assert.equal(r.origem, 'crm');
  assert.deepEqual(r.valores, { '1': 'Joana', '2': '02/12 às 15:00' });
  // o nome da unidade vira texto fixo no modelo, não parâmetro: um modelo que usa o nome da unidade como campo é resolvido pela régua
  assert.equal(nomeBaseDoModelo('parau_x', 'timbocrm_'), null, 'modelo de outra unidade não é daqui');
});

test('MODELO DO CRM sem o dado: o campo fica VAZIO (nunca inventa), os outros vêm', () => {
  const r = preencherModelo({ modelo: 'parau_consulta_lembrete_vespera' }, conversa('Maria', {}), parau);
  assert.deepEqual(r.valores, { '1': 'Maria' });
  const semNome = preencherModelo({ modelo: 'parau_consulta_lembrete_vespera' }, conversa('+5594984325883', consulta), parau);
  assert.deepEqual(semNome.valores, { '2': '02/12 às 15:00' }, 'nome que é telefone não vira «primeiro nome»');
  assert.deepEqual(variaveisDoModeloCampoACampo('parau_consulta_lembrete_vespera', conversa('Maria', {}), parau), [{ campo: 'contact.name', valor: 'Maria' }, { campo: 'lead.cf.2450736', valor: null }]);
});

test('MODELO DE FORA (timbo_*): saudação antes de {{1}} = primeiro nome; o parâmetro depois de «Data e horário:» = a próxima consulta; o resto vazio', () => {
  const corpo = 'Olá, {{1}}! Aqui é da Doutor Hérnia Timbó.\nSua consulta está confirmada.\n🗓 Data e horário: {{2}}\nResponda se precisar de algo. Protocolo {{3}}';
  const r = preencherModelo({ modelo: 'timbo_confirmacao_consulta', corpo }, conversa('ana paula souza', consulta), { ...parau, nome: 'Timbó' });
  assert.equal(r.origem, 'externo');
  assert.deepEqual(r.valores, { '1': 'Ana', '2': '02/12 às 15:00' }, 'o {{3}} não tem papel conhecido: vazio');
  // sem consulta: cai na próxima sessão; sem nada: vazio
  assert.equal(preencherModelo({ modelo: 'timbo_x', corpo }, conversa('Ana', { proxima_sessao: '2026-12-09', hora_sessao: '08:30' }), parau).valores['2'], '09/12 às 08:30');
  assert.deepEqual(preencherModelo({ modelo: 'timbo_x', corpo }, conversa('Ana', {}), parau).valores, { '1': 'Ana' });
});

test('modelo de fora: só a saudação conta como nome (um {{1}} depois de outra coisa não vira o nome); varia a saudação e a quebra de linha', () => {
  for (const [antes, esperado] of [['Olá, ', 'nome'], ['Oi ', 'nome'], ['Bom dia, ', 'nome'], ['Boa noite! ', 'nome'], ['Prezada ', 'nome'], ['🗓 Data e horário: ', 'data'], ['Data e horário:', 'data'], ['Seu código é ', null], ['Valor: R$ ', null], ['Sua consulta com ', null], ['', null]] as const) {
    assert.equal(papelDoParametro(antes), esperado, JSON.stringify(antes));
  }
  assert.deepEqual(parametrosDoCorpo('Olá, {{1}}!\nData e horário: {{2}} e {{1}}').map((p) => [p.chave, p.antes]), [['1', 'Olá, '], ['2', 'Data e horário: ']], 'cada parâmetro uma vez; o contexto é a linha dele');
  const nomeNaLinhaDeBaixo = preencherModelo({ modelo: 'timbo_y', corpo: 'Olá,\n{{1}}' }, conversa('Ana', {}), parau);
  assert.deepEqual(nomeNaLinhaDeBaixo.valores, {}, 'a saudação precisa estar na mesma linha: não adivinha');
});

test('entradas ruins não lançam nem inventam: nome de modelo estranho, corpo vazio, conversa sem nome', () => {
  assert.deepEqual(preencherModelo({ modelo: 'Nome Com Espaço!' }, conversa('Ana'), parau), { origem: 'nenhuma', valores: {} });
  assert.deepEqual(preencherModelo({ modelo: '' }, conversa('Ana'), parau), { origem: 'nenhuma', valores: {} });
  assert.deepEqual(preencherModelo({ modelo: 'timbo_z' }, conversa('Ana'), parau), { origem: 'externo', valores: {} }, 'modelo de fora sem corpo: nada a ler');
  assert.deepEqual(preencherModelo({ modelo: 'timbo_z', corpo: 'Olá, {{1}}' }, conversa(''), parau).valores, {});
  assert.equal(proximaDataDaConversa(conversa('x', {})), null);
});

test('os valores saem LIMPOS para parâmetro (uma linha, sem aspas nem <>), como a régua os manda', () => {
  const r = preencherModelo({ modelo: 'timbo_w', corpo: 'Olá, {{1}}' }, conversa("D'Ávila Lima"), parau);
  assert.deepEqual(r.valores, { '1': 'D’Ávila' });
});

test('a régua não mudou: renderizar de Parauapebas continua igual (todos os campos presentes → texto e variáveis; falta → null)', () => {
  const c = conversa('Maria Souza', consulta);
  const ok = renderizar('parau_consulta_lembrete_vespera', c, parau);
  assert.deepEqual(ok.variaveis, ['Maria', '02/12 às 15:00']);
  assert.match(ok.texto ?? '', /Data e horário: 02\/12 às 15:00/);
  const sem = renderizar('parau_consulta_lembrete_vespera', conversa('Maria', {}), parau);
  assert.equal(sem.texto, null);
  assert.equal(sem.variaveis, null);
  assert.ok(sem.faltando.some((f) => /data da consulta/.test(f)));
  assert.equal(SEMENTE_PARAUAPEBAS.prefixoModelos, 'parau_');
});
