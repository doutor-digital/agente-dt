/**
 * Modelo do WhatsApp mandado à mão: os parâmetros vêm preenchidos (só sugestão). Modelo do CRM usa a MESMA regra da régua; modelo de fora é lido pelo texto; sem dado, vazio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { preencherModelo: preencherModeloReal, nomeBaseDoModelo, parametrosDoCorpo, papelDoParametro } = await import('./modelo-preenchido.js');
const { renderizar, variaveisDoModeloCampoACampo, proximaDataDaConversa } = await import('./chatwoot-regua.js');
const { textosDaUnidade } = await import('./chatwoot-modelos.js');
const { SEMENTE_PARAUAPEBAS } = await import('./chatwoot-unidades.js');
const { TEXTOS_PARAU: TEXTOS } = await import('./chatwoot-regua-textos.js');

// «hoje» FIXO (25/11/2026 12:00 em Belém): os testes não podem depender do relógio
const AGORA = new Date('2026-11-25T15:00:00Z');
const preencherModelo = (p: { modelo: string; corpo?: string }, c: Parameters<typeof preencherModeloReal>[1], u: Parameters<typeof preencherModeloReal>[2]) => preencherModeloReal(p, c, u, AGORA);
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
  assert.deepEqual(variaveisDoModeloCampoACampo('parau_consulta_lembrete_vespera', conversa('Maria', {}), parau, undefined, AGORA), [{ campo: 'contact.name', valor: 'Maria' }, { campo: 'lead.cf.2450736', valor: null }]);
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
  assert.equal(proximaDataDaConversa(conversa('x', {}), AGORA), null);
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

test('DATA QUE JÁ PASSOU nunca é sugerida (sonda do sênior): consulta em 20/11, hoje 25/11, próxima sessão em 02/12 → vale a sessão, nos modelos de fora e nos do CRM', () => {
  const c = conversa('MARIA SOUZA', { data_consulta: '2026-11-20', hora_consulta: '15:00', proxima_sessao: '2026-12-02', hora_sessao: '09:00' });
  const fora = preencherModelo({ modelo: 'timbo_confirmacao', corpo: 'Olá, {{1}}! Sua sessão está confirmada.\n🗓 Data e horário: {{2}}' }, c, { ...parau, prefixoModelos: 'timbocrm_' });
  assert.deepEqual(fora.valores, { '1': 'Maria', '2': '02/12 às 09:00' });
  for (const m of ['parau_consulta_lembrete_vespera', 'parau_consulta_confirmacao_dia']) assert.deepEqual(preencherModelo({ modelo: m }, c, parau).valores, { '1': 'Maria', '2': '02/12 às 09:00' }, m);
});

test('nada futuro: a data fica VAZIA (nunca a que passou); o nome continua', () => {
  const c = conversa('Maria', { data_consulta: '2026-11-20', hora_consulta: '15:00', proxima_sessao: '2026-11-22', data_retorno: '2026-11-01' });
  assert.deepEqual(preencherModelo({ modelo: 'parau_consulta_lembrete_vespera' }, c, parau).valores, { '1': 'Maria' });
  assert.deepEqual(preencherModelo({ modelo: 'timbo_x', corpo: 'Olá, {{1}}\nData e horário: {{2}}' }, c, parau).valores, { '1': 'Maria' });
  assert.equal(proximaDataDaConversa(c, AGORA), null);
});

test('o limite é o INSTANTE (Belém): hoje mais tarde vale; hoje mais cedo já passou; só com a data, vale até o fim do dia; sessão passada com retorno futuro cai no retorno', () => {
  // AGORA = 25/11 12:00 em Belém
  assert.equal(proximaDataDaConversa(conversa('x', { data_consulta: '2026-11-25', hora_consulta: '18:00' }), AGORA), '25/11 às 18:00');
  assert.equal(proximaDataDaConversa(conversa('x', { data_consulta: '2026-11-25', hora_consulta: '09:00' }), AGORA), null);
  assert.equal(proximaDataDaConversa(conversa('x', { data_consulta: '2026-11-25' }), AGORA), '25/11');
  assert.equal(proximaDataDaConversa(conversa('x', { data_consulta: '2026-11-24' }), AGORA), null);
  assert.equal(proximaDataDaConversa(conversa('x', { data_consulta: '2026-11-20', proxima_sessao: '2026-11-21', data_retorno: '2026-12-15' }), AGORA), '15/12');
});

test('«Aqui é {{atendente}}» dos modelos da SDR: vem de quem está logada; sem nome, vazio; a régua não muda', () => {
  const sdr = Object.keys((TEXTOS as Record<string, string>)).find((k) => /Aqui é \{\{lead\.cf\.2450732\}\}/.test((TEXTOS as Record<string, string>)[k]!))!;
  const com = { ...conversa('Maria', {}), atendente: 'Lorena' };
  const r = preencherModelo({ modelo: sdr }, com, parau);
  assert.equal(r.valores['2'], 'Lorena');
  assert.equal(preencherModelo({ modelo: sdr }, conversa('Maria', {}), parau).valores['2'], undefined);
});

test('a RÉGUA não descarta data passada: renderizar segue idêntica (a regra nova vale só no preenchimento à mão)', () => {
  const c = conversa('Maria', { data_consulta: '2020-01-02', hora_consulta: '15:00' });
  assert.deepEqual(renderizar('parau_consulta_lembrete_vespera', c, parau).variaveis, ['Maria', '02/01 às 15:00']);
  assert.deepEqual(preencherModelo({ modelo: 'parau_consulta_lembrete_vespera' }, c, parau).valores, { '1': 'Maria' });
});
