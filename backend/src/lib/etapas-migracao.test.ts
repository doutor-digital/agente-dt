/**
 * Migração das etapas de Timbó (conta 3) para os nomes da Kommo: a decisão pura. Conversas (só renomeia o que a equipe mexeu; reclassifica só o que a importação deixou),
 * listas dos atributos e as pastas (filtros salvos, com os JSON reais da conta 3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidirConversa, decidirPasta, etapaDaNota, listasDosAtributos, planoDasConversas, planoDasPastas, type ConversaParaMigrar, type PastaParaMigrar } from './etapas-migracao.js';
import { mapaDaColuna } from './chatwoot-etapas.js';
import { ETAPAS_DE_TIMBO_NA_COLUNA } from './chatwoot-etapas-timbo.js';

const MAPA = mapaDaColuna(ETAPAS_DE_TIMBO_NA_COLUNA)!;
const conv = (o: Partial<ConversaParaMigrar> & { id: number }): ConversaParaMigrar => ({ etapa: null, etapa_tratamento: null, funil: 'Comercial', etiquetas: [], kommo: null, nota: null, ...o });
const importada = (id: number, kommo: string, etapa: string | null, extra: Partial<ConversaParaMigrar> = {}) =>
  conv({ id, kommo: String(900 + id), etapa, nota: `Na Kommo: COMERCIAL › ${kommo}`, etiquetas: ['historico'], ...extra });

test('a nota da importação: funil e etapa da Kommo, com ou sem o aviso «sem coluna»', () => {
  assert.deepEqual(etapaDaNota('Na Kommo: COMERCIAL › EM ESPERA — esta etapa não tem coluna no CRM: confira'), { funil: 'COMERCIAL', etapa: 'EM ESPERA' });
  assert.deepEqual(etapaDaNota('Na Kommo: COMERCIAL › GANHO / CONCLUÍDO'), { funil: 'COMERCIAL', etapa: 'GANHO / CONCLUÍDO' });
  assert.deepEqual(etapaDaNota('Na Kommo: TRATAMENTO › EM TRATAMENTO'), { funil: 'TRATAMENTO', etapa: 'EM TRATAMENTO' });
  assert.equal(etapaDaNota(null), null);
  assert.equal(etapaDaNota('qualquer outra nota'), null);
});

test('importada e AINDA como a importação deixou: vai para a etapa que o cartão tem na Kommo', () => {
  const casos: Array<[string, string | null, string]> = [
    ['EM QUALIFICAÇÃO', 'Sofia qualifica', 'EM QUALIFICAÇÃO'],
    ['AGENDADO', 'Agendado', 'AGENDADO'],
    ['AGENDADO', 'Confirmado', 'AGENDADO'],
    ['NÃO COMPARECEU', 'Agendado', 'NÃO COMPARECEU'],
    ['COMPARECEU', 'Compareceu', 'COMPARECEU'],
    ['EM NEGOCIAÇÃO', 'Pós-consulta', 'EM NEGOCIAÇÃO'],
    ['GANHO / CONCLUÍDO', 'Fechou', 'GANHO / CONCLUÍDO'],
    ['PERDIDO', 'Perdido', 'PERDIDO'],
    ['Leads de entrada', 'Novo lead', 'Leads de entrada'],
    ['EM ESPERA', null, 'EM ESPERA'],
    ['CONFERIR NA FRANQUIA', '', 'CONFERIR NA FRANQUIA'],
    ['RETORNO PÓS-TRATAMENTO', null, 'RETORNO PÓS-TRATAMENTO'],
  ];
  for (const [kommo, antes, depois] of casos) {
    const { troca } = decidirConversa(importada(1, kommo, antes), MAPA);
    assert.equal(troca?.etapaDepois, depois, `${kommo} (${antes})`);
    assert.equal(troca?.etapaAntes, antes);
  }
});

test('a equipe JÁ mexeu depois da importação: só renomeia, nunca reclassifica pela Kommo', () => {
  // importada de EM ESPERA mas a equipe pôs em Agendado: fica AGENDADO (renomeada), não volta para EM ESPERA
  assert.equal(decidirConversa(importada(2, 'EM ESPERA', 'Agendado'), MAPA).troca?.etapaDepois, 'AGENDADO');
  // importada de PERDIDO, a equipe reabriu em Sofia qualifica
  assert.equal(decidirConversa(importada(3, 'PERDIDO', 'Sofia qualifica'), MAPA).troca?.etapaDepois, 'EM QUALIFICAÇÃO');
  // conversa nova (não veio da Kommo): renomeia
  assert.equal(decidirConversa(conv({ id: 4, etapa: 'Pós-consulta' }), MAPA).troca?.etapaDepois, 'EM NEGOCIAÇÃO');
  assert.equal(decidirConversa(conv({ id: 5, etapa: 'Fechou' }), MAPA).troca?.etapaDepois, 'GANHO / CONCLUÍDO');
  // conversa nova sem etapa: nada
  assert.equal(decidirConversa(conv({ id: 6 }), MAPA).troca, null);
});

test('«Esperando humano» vira a qualificação + a etiqueta esperando-humano (que nunca é tirada)', () => {
  const t = decidirConversa(conv({ id: 7, etapa: 'Esperando humano' }), MAPA).troca!;
  assert.equal(t.etapaDepois, 'EM QUALIFICAÇÃO');
  assert.equal(t.poeEtiqueta, 'esperando-humano');
  assert.equal(decidirConversa(conv({ id: 8, etapa: 'Esperando humano', etiquetas: ['esperando-humano'] }), MAPA).troca?.poeEtiqueta, null, 'já tem: não repete');
  const i = decidirConversa(importada(9, 'EM QUALIFICAÇÃO', 'Esperando humano'), MAPA).troca!;
  assert.equal(i.etapaDepois, 'EM QUALIFICAÇÃO');
  assert.equal(i.poeEtiqueta, 'esperando-humano');
});

test('Tratamento: renomeia pelo papel; conversa sem destino na conta (Frio, Resgate) fica intacta e é contada', () => {
  const t = decidirConversa(conv({ id: 10, funil: 'Tratamento', etapa_tratamento: 'Em tratamento' }), MAPA).troca!;
  assert.equal(t.tratamentoDepois, 'EM TRATAMENTO');
  assert.equal(t.etapaDepois, null);
  assert.equal(decidirConversa(conv({ id: 11, funil: 'Tratamento', etapa_tratamento: 'Entrada' }), MAPA).troca?.tratamentoDepois, 'Leads de entrada');
  assert.equal(decidirConversa(conv({ id: 12, funil: 'Tratamento', etapa_tratamento: 'Tratamento cancelado' }), MAPA).troca?.tratamentoDepois, 'TRATAMENTO CANCELADO');
  const frio = decidirConversa(conv({ id: 13, etapa: 'Frio' }), MAPA);
  assert.equal(frio.troca, null);
  assert.equal(frio.intacta, 'etapa-sem-destino-na-conta');
  // já migrada: nada a fazer (rodar de novo é seguro)
  assert.equal(decidirConversa(importada(14, 'PERDIDO', 'PERDIDO'), MAPA).troca, null);
  assert.equal(decidirConversa(conv({ id: 15, etapa: 'AGENDADO' }), MAPA).troca, null);
});

test('plano: contagem por «de → para» (sem id de paciente) e as intactas', () => {
  const p = planoDasConversas(
    [importada(1, 'EM ESPERA', null), importada(2, 'EM ESPERA', ''), conv({ id: 3, etapa: 'Esperando humano' }), conv({ id: 4, etapa: 'Frio' }), conv({ id: 5, etapa: 'PERDIDO' })],
    MAPA,
  );
  assert.equal(p.trocas.length, 3);
  assert.equal(p.contagem['etapa: (vazia) → EM ESPERA'], 2);
  assert.equal(p.contagem['+ etiqueta esperando-humano'], 1);
  assert.equal(p.intactas['etapa-sem-destino-na-conta'], 1);
  assert.ok(!JSON.stringify(p.contagem).match(/\d{8,}/), 'só contagem');
});

test('as listas dos atributos da conta 3: na ordem da Kommo', () => {
  const l = listasDosAtributos(MAPA);
  assert.deepEqual(l.etapa, ['Leads de entrada', 'EM QUALIFICAÇÃO', 'EM ESPERA', 'CONFERIR NA FRANQUIA', 'AGENDADO', 'NÃO COMPARECEU', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'GANHO / CONCLUÍDO', 'PERDIDO']);
  assert.deepEqual(l.etapa_tratamento, ['Leads de entrada', 'EM TRATAMENTO', 'ALTA', 'TRATAMENTO CANCELADO']);
});

// ── as pastas: os JSON REAIS da conta 3 (usuário 13) ──────────────────────────────────────────
const item = (chave: string, valores: string[], extra: Record<string, unknown> = {}) => ({ values: valores, attribute_key: chave, query_operator: null, attribute_model: 'customer_attributes', filter_operator: 'equal_to', custom_attribute_type: 'conversation_attribute', ...extra });
const pasta = (id: number, name: string, payload: unknown[]): PastaParaMigrar => ({ id, name, query: { payload } as never });
const PASTAS: PastaParaMigrar[] = [
  pasta(51, '🆕 Novos leads', [item('etapa', ['Novo lead', 'Sofia qualifica'], { query_operator: 'and' }), { values: ['open'], attribute_key: 'status', query_operator: null, attribute_model: 'standard', filter_operator: 'equal_to' }]),
  pasta(52, '🙋 Esperando humano', [{ values: ['esperando-humano'], attribute_key: 'labels', query_operator: 'and', attribute_model: 'standard', filter_operator: 'equal_to' }]),
  pasta(54, '📅 Agendados', [item('etapa', ['Agendado', 'Confirmado'])]),
  pasta(55, '❌ Faltaram', [item('situacao_consulta', ['Não compareceu'])]),
  pasta(56, '✅ Compareceram (fechar tratamento)', [item('etapa', ['Compareceu', 'Pós-consulta'])]),
  pasta(59, '💤 Perdidos', [item('etapa', ['Perdido'])]),
  pasta(80, 'C1 · Leads de entrada', [item('etapa', ['Novo lead'])]),
  pasta(83, 'C2 · EM QUALIFICAÇÃO', [item('etapa', ['Sofia qualifica', 'Esperando humano'])]),
  pasta(86, 'C3 · EM ESPERA', [item('motivo_espera', [], { filter_operator: 'is_present', query_operator: 'or' }), item('retomar_em', [], { filter_operator: 'is_present' })]),
  pasta(89, 'C4 · CONFERIR NA FRANQUIA', [{ values: ['conferir-etapa'], attribute_key: 'labels', query_operator: null, attribute_model: 'standard', filter_operator: 'equal_to' }]),
  pasta(92, 'C5 · AGENDADO', [item('etapa', ['Agendado', 'Confirmado'])]),
  pasta(95, 'C6 · NÃO COMPARECEU', [item('situacao_consulta', ['Não compareceu'])]),
  pasta(98, 'C7 · COMPARECEU', [item('etapa', ['Compareceu'])]),
  pasta(101, 'C8 · EM NEGOCIAÇÃO', [item('etapa', ['Pós-consulta'])]),
  pasta(104, 'C9 · GANHO / CONCLUÍDO', [item('etapa', ['Fechou'])]),
  pasta(107, 'C10 · PERDIDO', [item('etapa', ['Perdido'])]),
  pasta(110, 'T1 · Leads de entrada', [item('etapa_tratamento', ['Entrada'])]),
  pasta(113, 'T2 · EM TRATAMENTO', [item('etapa_tratamento', ['Em tratamento'])]),
  pasta(116, 'T3 · ALTA', [item('etapa_tratamento', ['Alta'])]),
  pasta(119, 'T4 · TRATAMENTO CANCELADO', [item('etapa_tratamento', ['Tratamento cancelado'])]),
];
const depois = (id: number) => decidirPasta(PASTAS.find((p) => p.id === id)!, MAPA);
const valores = (id: number, chave = 'etapa') => ((depois(id)!.queryDepois as { payload: Array<{ attribute_key: string; values: string[] }> }).payload.find((i) => i.attribute_key === chave)?.values);

test('pastas: os valores passam para os nomes da conta (duplicados somem) e o resto do filtro fica como estava', () => {
  assert.deepEqual(valores(51), ['Leads de entrada', 'EM QUALIFICAÇÃO']);
  assert.deepEqual(valores(54), ['AGENDADO']);
  assert.deepEqual(valores(56), ['COMPARECEU', 'EM NEGOCIAÇÃO']);
  assert.deepEqual(valores(59), ['PERDIDO']);
  assert.deepEqual(valores(80), ['Leads de entrada']);
  assert.deepEqual(valores(83), ['EM QUALIFICAÇÃO']);
  assert.deepEqual(valores(92), ['AGENDADO']);
  assert.deepEqual(valores(98), ['COMPARECEU']);
  assert.deepEqual(valores(101), ['EM NEGOCIAÇÃO']);
  assert.deepEqual(valores(104), ['GANHO / CONCLUÍDO']);
  assert.deepEqual(valores(107), ['PERDIDO']);
  assert.deepEqual(valores(110, 'etapa_tratamento'), ['Leads de entrada']);
  assert.deepEqual(valores(113, 'etapa_tratamento'), ['EM TRATAMENTO']);
  assert.deepEqual(valores(116, 'etapa_tratamento'), ['ALTA']);
  assert.deepEqual(valores(119, 'etapa_tratamento'), ['TRATAMENTO CANCELADO']);
  // o item «aberta» da pasta Novos leads e o operador não mudaram
  const novos = depois(51)!.queryDepois as { payload: Array<Record<string, unknown>> };
  assert.equal(novos.payload.length, 2);
  assert.deepEqual(novos.payload[1], { values: ['open'], attribute_key: 'status', query_operator: null, attribute_model: 'standard', filter_operator: 'equal_to' });
  assert.equal(novos.payload[0]!.query_operator, 'and');
});

test('pastas C3, C4 e C6 passam a filtrar pela ETAPA de verdade; as de etiqueta/situação (Esperando humano, Faltaram) ficam como estão', () => {
  assert.deepEqual(valores(86), ['EM ESPERA']);
  assert.deepEqual(valores(89), ['CONFERIR NA FRANQUIA']);
  assert.deepEqual(valores(95), ['NÃO COMPARECEU']);
  assert.equal(depois(52), null, 'Esperando humano filtra pela etiqueta: nada a trocar');
  assert.equal(depois(55), null, 'Faltaram filtra pela situação: nada a trocar');
  assert.equal(((depois(86)!.queryDepois as { payload: unknown[] }).payload).length, 1, 'sem os filtros de «presente»');
});

test('pastas: rodar de novo não muda nada; plano completo; conta SEM a etapa não troca C3', () => {
  const feitas = planoDasPastas(PASTAS, MAPA);
  assert.equal(feitas.length, 18, '20 pastas do exemplo: só Esperando humano (etiqueta) e Faltaram (situação) não mudam');
  const jaTrocadas: PastaParaMigrar[] = feitas.map((t) => ({ id: t.id, name: t.nome, query: t.queryDepois as never }));
  assert.equal(planoDasPastas(jaTrocadas, MAPA).length, 0, 'idempotente');
  const semEspera = mapaDaColuna({ ...ETAPAS_DE_TIMBO_NA_COLUNA, comercial: ETAPAS_DE_TIMBO_NA_COLUNA.comercial.filter((e) => e.papel !== 'Em espera') })!;
  assert.equal(decidirPasta(PASTAS.find((p) => p.id === 86)!, semEspera), null);
});

// ── o SQL ─────────────────────────────────────────────────────────────────────────────────────
const { sqlDaMigracao, sqlDoDesfazer } = await import('./etapas-migracao.js');

test('SQL: uma transação, cada UPDATE com guarda do valor de antes, sem DELETE e sem mexer em updated_at; o registro leva o valor de antes', () => {
  const plano = planoDasConversas([importada(1, 'EM ESPERA', null), conv({ id: 2, etapa: 'Esperando humano' }), conv({ id: 3, funil: 'Tratamento', etapa_tratamento: 'Em tratamento' })], MAPA);
  const pastas = planoDasPastas(PASTAS, MAPA);
  const { sql, registro } = sqlDaMigracao({ conta: 3, listasAntes: { etapa: ['Novo lead'], etapa_tratamento: ['Entrada'] }, listas: listasDosAtributos(MAPA), trocas: plano.trocas, pastas });
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\n$/);
  assert.doesNotMatch(sql, /DELETE|updated_at|TRUNCATE|DROP/i);
  assert.match(sql, /UPDATE custom_attribute_definitions SET attribute_values = '\["Leads de entrada","EM QUALIFICAÇÃO"/);
  assert.match(sql, /UPDATE conversations SET custom_attributes = jsonb_set\(.*'\{etapa\}', to_jsonb\('EM ESPERA'::text\)\) WHERE id = 1 AND account_id = 3 AND coalesce\(custom_attributes->>'etapa', ''\) = ''/);
  assert.match(sql, /'\{etapa_tratamento\}', to_jsonb\('EM TRATAMENTO'::text\)\) WHERE id = 3 AND account_id = 3 AND coalesce\(custom_attributes->>'etapa_tratamento', ''\) = 'Em tratamento'/);
  assert.match(sql, /INSERT INTO taggings .* WHERE g\.name = 'esperando-humano' AND EXISTS .* AND NOT EXISTS/);
  assert.match(sql, /UPDATE custom_filters SET query = .* WHERE id = 51 AND account_id = 3/);
  assert.equal(registro.length, 2 + plano.trocas.length + pastas.length);
  const r1 = JSON.parse(registro.find((l) => JSON.parse(l).id === 2 && JSON.parse(l).tipo === 'conversa')!);
  assert.equal(r1.etapaAntes, 'Esperando humano');
  assert.equal(r1.poeEtiqueta, 'esperando-humano');
});

test('SQL: aspas e valores estranhos nunca viram injeção; id e conta têm de ser inteiros', () => {
  const t = { id: 5, etapaAntes: "x'; DROP TABLE conversations; --", etapaDepois: "y'z", tratamentoAntes: null, tratamentoDepois: null, poeEtiqueta: null, motivo: 'm' };
  const { sql } = sqlDaMigracao({ conta: 3, listasAntes: { etapa: null, etapa_tratamento: null }, listas: listasDosAtributos(MAPA), trocas: [t], pastas: [] });
  assert.match(sql, /'x''; DROP TABLE conversations; --'/);
  assert.match(sql, /to_jsonb\('y''z'::text\)/);
  assert.doesNotMatch(sql, /custom_attribute_definitions/, 'atributo que a conta não tem: não troca a lista');
  assert.throws(() => sqlDaMigracao({ conta: 3, listasAntes: { etapa: null, etapa_tratamento: null }, listas: listasDosAtributos(MAPA), trocas: [{ ...t, id: Number('1; DROP') }], pastas: [] }));
  assert.throws(() => sqlDaMigracao({ conta: 0, listasAntes: { etapa: null, etapa_tratamento: null }, listas: listasDosAtributos(MAPA), trocas: [], pastas: [] }));
});

test('desfazer: devolve o valor de antes SÓ onde ainda está o que a migração pôs; tira a etiqueta que ela pôs; restaura lista e pasta', () => {
  const plano = planoDasConversas([importada(1, 'EM ESPERA', null), conv({ id: 2, etapa: 'Esperando humano' })], MAPA);
  const pastas = planoDasPastas(PASTAS, MAPA).slice(0, 1);
  const { registro } = sqlDaMigracao({ conta: 3, listasAntes: { etapa: ['Novo lead', 'Perdido'], etapa_tratamento: null }, listas: listasDosAtributos(MAPA), trocas: plano.trocas, pastas });
  const d = sqlDoDesfazer(registro);
  assert.match(d, /UPDATE custom_attribute_definitions SET attribute_values = '\["Novo lead","Perdido"\]'::jsonb WHERE account_id = 3 AND attribute_key = 'etapa'/);
  assert.match(d, /custom_attributes - 'etapa' WHERE id = 1 AND account_id = 3 AND custom_attributes->>'etapa' = 'EM ESPERA'/, 'a etapa não existia: sai');
  assert.match(d, /to_jsonb\('Esperando humano'::text\)\) WHERE id = 2 AND account_id = 3 AND custom_attributes->>'etapa' = 'EM QUALIFICAÇÃO'/);
  assert.match(d, /DELETE FROM taggings WHERE taggable_type = 'Conversation' AND taggable_id = 2 AND context = 'labels' AND tag_id = \(SELECT id FROM tags WHERE name = 'esperando-humano'\)/);
  assert.equal((d.match(/DELETE FROM/g) ?? []).length, 1, 'o único DELETE é a etiqueta que a migração pôs');
  assert.match(d, /UPDATE custom_filters SET query = .* AND query = /);
  assert.equal(sqlDoDesfazer(['lixo', '{"tipo":"outro"}']), 'BEGIN;\nCOMMIT;\n');
});

test('NÃO COMPARECEU com a consulta REMARCADA (importada como Agendado + Remarcado) continua AGENDADO; só a falta de verdade vai para NÃO COMPARECEU', () => {
  assert.equal(decidirConversa(importada(20, 'NÃO COMPARECEU', 'Agendado', { situacao: 'Remarcado' }), MAPA).troca?.etapaDepois, 'AGENDADO');
  assert.equal(decidirConversa(importada(21, 'NÃO COMPARECEU', 'Agendado', { situacao: 'Não compareceu' }), MAPA).troca?.etapaDepois, 'NÃO COMPARECEU');
  assert.equal(decidirConversa(importada(22, 'NÃO COMPARECEU', 'Agendado', { situacao: null }), MAPA).troca?.etapaDepois, 'NÃO COMPARECEU');
});

test('SQL da etiqueta: só se a troca valeu (a conversa já está na etapa nova), em taggings E no cache cached_label_list; o desfazer tira dos dois; a lista só volta se ainda é a da migração', () => {
  const plano = planoDasConversas([conv({ id: 2, etapa: 'Esperando humano' })], MAPA);
  const { sql, registro } = sqlDaMigracao({ conta: 3, listasAntes: { etapa: ['Novo lead'], etapa_tratamento: null }, listas: listasDosAtributos(MAPA), trocas: plano.trocas, pastas: [] });
  assert.match(sql, /INSERT INTO taggings .* custom_attributes->>'etapa' = 'EM QUALIFICAÇÃO'\) AND NOT EXISTS/);
  assert.match(sql, /UPDATE conversations SET cached_label_list = CASE WHEN coalesce\(cached_label_list, ''\) = '' THEN 'esperando-humano' ELSE cached_label_list \|\| ', ' \|\| 'esperando-humano' END WHERE id = 2 AND account_id = 3 AND custom_attributes->>'etapa' = 'EM QUALIFICAÇÃO' AND NOT \('esperando-humano' = ANY/);
  const d = sqlDoDesfazer(registro);
  assert.match(d, /UPDATE conversations SET cached_label_list = array_to_string\(array_remove\(string_to_array\(coalesce\(cached_label_list, ''\), ', '\), 'esperando-humano'\), ', '\) WHERE id = 2 AND account_id = 3/);
  assert.match(d, /attribute_values = '\["Novo lead"\]'::jsonb WHERE account_id = 3 AND attribute_key = 'etapa' AND attribute_model = 0 AND attribute_values = '\["Leads de entrada"/);
});
