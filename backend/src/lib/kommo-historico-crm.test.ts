/**
 * Histórico da Kommo → CRM (Timbó, 25/11/2026): a decisão pura. Etapa, atributos, etiquetas, nota e mensagens de cada cartão.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atributosDoCartao,
  foneParaWhatsApp,
  linhaDoCartao,
  mensagensParaCrm,
  motivoDeNaoAgendamento,
  nomeLimpo,
  notaDoCartao,
  traduzirEtapa,
  TETO_DE_MENSAGENS,
  type CartaoDaKommo,
} from './kommo-historico-crm.js';

const AGORA = new Date('2026-11-25T15:00:00Z');
/** 2026-11-27 10:30 em Belém (UTC−3) */
const CONSULTA = Math.floor(Date.parse('2026-11-27T13:30:00Z') / 1000);

function cartao(extra: Partial<CartaoDaKommo> & { campos?: CartaoDaKommo['campos'] } = {}): CartaoDaKommo {
  return { id: 777, nome: 'Lead 777', funil: 'COMERCIAL', etapa: 'AGENDADO', statusId: 112321359, preco: 0, criadoEm: 1_790_000_000, atualizadoEm: 1_790_100_000, fechadoEm: null, responsavel: 'Camily', motivoPerda: null, etiquetas: [], campos: [], ...extra };
}
const campo = (nome: string, valor: unknown, tipo = 'text') => ({ nome, tipo, valor });

// ── telefone ──
test('telefone: 10/11 dígitos ganham o 55; formato com máscara; lixo vira null', () => {
  assert.equal(foneParaWhatsApp('(47) 99123-4567'), '5547991234567');
  assert.equal(foneParaWhatsApp('+55 47 9123-4567'), '554791234567');
  assert.equal(foneParaWhatsApp('4733334444'), '554733334444');
  assert.equal(foneParaWhatsApp('5547991234567'), '5547991234567');
  assert.equal(foneParaWhatsApp('0047991234567'), '5547991234567', 'prefixo 00 de ligação internacional');
  assert.equal(foneParaWhatsApp('123'), null);
  assert.equal(foneParaWhatsApp('55123'), null);
  assert.equal(foneParaWhatsApp(null), null);
  assert.equal(foneParaWhatsApp('5547991234567890123'), null);
  assert.equal(foneParaWhatsApp('+351912345678'), '351912345678', 'número de fora do Brasil entra como veio');
});

test('nome do campo: tira símbolo e acento (a Kommo põe «◷ Data da Consulta»)', () => {
  assert.equal(nomeLimpo('◷ Data da Consulta'), 'DATA DA CONSULTA');
  assert.equal(nomeLimpo('✓ Situação da consulta'), 'SITUACAO DA CONSULTA');
  assert.equal(nomeLimpo('# Nº de parcelas'), 'Nº DE PARCELAS');
});

// ── etapas ──
test('de/para COMERCIAL: cada etapa vai para o nome do CRM (o mesmo de 12/11)', () => {
  const t = (etapa: string, statusId = 1, campos: CartaoDaKommo['campos'] = []) => traduzirEtapa(cartao({ etapa, statusId, campos }));
  assert.deepEqual([t('Incoming leads').funil, t('Incoming leads').etapa], ['Comercial', 'Novo lead']);
  assert.equal(t('EM QUALIFICAÇÃO').etapa, 'Sofia qualifica');
  assert.equal(t('EM QUALIFICAÇÃO', 1, [campo('✓ Atendimento assumido por humano', 'Sim', 'select')]).etapa, 'Esperando humano');
  assert.equal(t('AGENDADO').etapa, 'Agendado');
  assert.equal(t('AGENDADO', 1, [campo('✓ Situação da consulta', 'Confirmado', 'select')]).etapa, 'Confirmado');
  const faltou = t('NÃO COMPARECEU');
  assert.equal(faltou.etapa, 'Agendado');
  assert.equal(faltou.situacao, 'Não compareceu', 'NÃO COMPARECEU continua Agendado com a situação «Não compareceu»');
  assert.equal(t('COMPARECEU').etapa, 'Compareceu');
  assert.equal(t('EM NEGOCIAÇÃO').etapa, 'Pós-consulta');
  assert.equal(t('GANHO / CONCLUÍDO', 142).etapa, 'Fechou');
  assert.equal(t('PERDIDO', 143).etapa, 'Perdido');
});

test('etapas SEM coluna no CRM: etapa vazia + conferir-etapa + aviso (o dado vai nos atributos e na nota)', () => {
  for (const etapa of ['EM ESPERA', 'CONFERIR NA FRANQUIA', 'RETORNO PÓS-TRATAMENTO']) {
    const r = traduzirEtapa(cartao({ etapa }));
    assert.equal(r.etapa, null, etapa);
    assert.equal(r.funil, 'Comercial');
    assert.deepEqual(r.etiquetas, ['conferir-etapa']);
    assert.ok(r.aviso, etapa);
  }
  assert.equal(traduzirEtapa(cartao({ etapa: 'RETORNO PÓS-TRATAMENTO' })).categoria, 'Retorno após tratamento');
  assert.equal(traduzirEtapa(cartao({ etapa: 'ETAPA NOVA QUE NINGUÉM MAPEOU' })).aviso, 'etapa-desconhecida');
  assert.equal(traduzirEtapa(cartao({ funil: 'OUTRO FUNIL' })).aviso, 'funil-desconhecido');
});

test('TRATAMENTO: funil Tratamento + etapa_tratamento; quem está em tratamento NÃO leva etapa comercial', () => {
  const t = (etapa: string, statusId = 1) => traduzirEtapa(cartao({ funil: 'TRATAMENTO', etapa, statusId }));
  assert.equal(t('Incoming leads').etapaTratamento, 'Entrada');
  assert.equal(t('EM TRATAMENTO').etapaTratamento, 'Em tratamento');
  assert.equal(t('ALTA', 142).etapaTratamento, 'Alta');
  assert.deepEqual(t('ALTA', 142).etiquetas, ['alta']);
  assert.equal(t('TRATAMENTO CANCELADO', 143).etapaTratamento, 'Tratamento cancelado');
  for (const x of [t('Incoming leads'), t('EM TRATAMENTO'), t('ALTA', 142)]) {
    assert.equal(x.etapa, null);
    assert.equal(x.funil, 'Tratamento');
  }
});

// ── atributos ──
test('consulta: data e hora em Belém (UTC−3), situação e categoria da lista do CRM', () => {
  const m = atributosDoCartao(
    cartao({ campos: [campo('◷ Data da Consulta', CONSULTA, 'date_time'), campo('✓ Situação da consulta', 'Agendado', 'select'), campo('⌂ Categoria da consulta', 'Avaliação', 'select')] }),
  );
  assert.equal(m.atributos.data_consulta, '2026-11-27');
  assert.equal(m.atributos.hora_consulta, '10:30');
  assert.equal(m.atributos.situacao_consulta, 'Agendado');
  assert.equal(m.atributos.categoria_consulta, 'Avaliação');
  assert.equal(m.atributos.funil, 'Comercial');
  assert.equal(m.atributos.kommo_lead_id, 777);
  assert.ok(m.etiquetas.includes('historico'), 'toda conversa importada leva `historico` (a trava da régua e do CAPI)');
});

test('data perto da meia-noite: 02:30 UTC ainda é o dia anterior em Belém', () => {
  const m = atributosDoCartao(cartao({ campos: [campo('Data da Consulta', Math.floor(Date.parse('2026-11-28T02:30:00Z') / 1000), 'date_time')] }));
  assert.equal(m.atributos.data_consulta, '2026-11-27');
  assert.equal(m.atributos.hora_consulta, '23:30');
});

test('categoria «Reavaliação» não existe no CRM de Timbó: não grava e avisa', () => {
  const m = atributosDoCartao(cartao({ campos: [campo('Categoria da consulta', 'Reavaliação', 'select')] }));
  assert.equal(m.atributos.categoria_consulta, undefined);
  assert.ok(m.avisos.includes('categoria-fora-da-lista'));
});

test('PERDIDO: motivo da Kommo (campo ou motivo nativo) vira o da lista do CRM e a etiqueta perdido-*', () => {
  const doCampo = atributosDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143, campos: [campo('⊘ Motivo do não agendamento', 'Plano de Saúde', 'select')] }));
  assert.equal(doCampo.atributos.etapa, 'Perdido');
  assert.equal(doCampo.atributos.motivo_nao_agendamento, 'Plano de saúde');
  assert.ok(doCampo.etiquetas.includes('perdido-plano-de-saude'));
  const nativo = atributosDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143, motivoPerda: 'Sem interesse' }));
  assert.equal(nativo.atributos.motivo_nao_agendamento, 'Sem interesse');
  assert.ok(nativo.etiquetas.includes('perdido-sem-interesse'));
  const apelidos = atributosDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143, campos: [campo('Motivo do não agendamento', 'Não deu continuidade ao atendimento', 'select')] }));
  assert.equal(apelidos.atributos.motivo_nao_agendamento, 'Não deu continuidade');
  assert.equal(motivoDeNaoAgendamento('Sem condições financeira'), 'Sem condições');
  assert.equal(motivoDeNaoAgendamento('Está viajando'), 'Viajando');
  assert.equal(motivoDeNaoAgendamento('Não é paciente (currículo)'), 'Currículo');
  assert.equal(motivoDeNaoAgendamento('Comprado do concorrente'), null);
});

test('PERDIDO sem motivo que se mapeie: entra como Perdido, SEM motivo inventado, com etiqueta de revisão e aviso', () => {
  const m = atributosDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143, motivoPerda: 'Comprado do concorrente' }));
  assert.equal(m.atributos.etapa, 'Perdido');
  assert.equal(m.atributos.motivo_nao_agendamento, undefined);
  assert.ok(m.avisos.includes('perdido-sem-motivo-mapeavel'));
  assert.ok(m.etiquetas.includes('pendente-de-revisao'));
});

test('GANHO: Fechou + fechou_tratamento + valor_fechado; origem de anúncio ganha a etiqueta anuncio', () => {
  const m = atributosDoCartao(cartao({ etapa: 'GANHO / CONCLUÍDO', statusId: 142, fechadoEm: 1_790_050_000, campos: [campo('¤ Valor do tratamento', '4500', 'monetary'), campo('⚑ Origem', 'Meta-Instagram', 'select')] }));
  assert.equal(m.atributos.etapa, 'Fechou');
  assert.equal(m.atributos.fechou_tratamento, true);
  assert.equal(m.atributos.valor_fechado, 4500);
  assert.equal(m.atributos.origem, 'Meta-Instagram');
  assert.ok(m.etiquetas.includes('anuncio'));
});

test('EM ESPERA: retomar_em e motivo_espera (com os motivos extras da Kommo caindo em «Outro»)', () => {
  const m = atributosDoCartao(cartao({ etapa: 'EM ESPERA', campos: [campo('◷ Retomar em', CONSULTA - 7 * 86400, 'date'), campo('⊘ Motivo da espera', 'Queria convênio', 'select')] }));
  assert.equal(m.atributos.etapa, undefined);
  assert.equal(m.atributos.retomar_em, '2026-11-20');
  assert.equal(m.atributos.motivo_espera, 'Outro');
  assert.ok(m.etiquetas.includes('conferir-etapa'));
  const v = atributosDoCartao(cartao({ etapa: 'EM ESPERA', campos: [campo('Motivo da espera', 'Viajando', 'select')] }));
  assert.equal(v.atributos.motivo_espera, 'Viajando');
});

test('TRATAMENTO: próxima sessão (data+hora), alta, compareceu à última sessão, avaliação no Google', () => {
  const m = atributosDoCartao(
    cartao({
      funil: 'TRATAMENTO',
      etapa: 'EM TRATAMENTO',
      campos: [campo('◷ Próxima sessão', CONSULTA, 'date_time'), campo('◷ Data de alta', CONSULTA, 'date'), campo('✓ Compareceu à última sessão marcada', 'Sim', 'select'), campo('✓ Deixou avaliação (Google)', 'Não', 'select')],
    }),
  );
  assert.equal(m.atributos.funil, 'Tratamento');
  assert.equal(m.atributos.etapa_tratamento, 'Em tratamento');
  assert.equal(m.atributos.etapa, undefined);
  assert.equal(m.atributos.proxima_sessao, '2026-11-27');
  assert.equal(m.atributos.hora_sessao, '10:30');
  assert.equal(m.atributos.data_alta, '2026-11-27');
  assert.equal(m.atributos.compareceu_ultima_sessao, 'Sim');
  assert.equal(m.atributos.deixou_avaliacao_google, false);
});

test('qualificação: Quente num cartão ABERTO leva a etiqueta quente; fechado não', () => {
  const quente = [campo('★ Qualificação (Quente/Morno/Frio)', 'Quente', 'select')];
  assert.ok(atributosDoCartao(cartao({ campos: quente })).etiquetas.includes('quente'));
  assert.ok(!atributosDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143, fechadoEm: 1_790_050_000, campos: quente, motivoPerda: 'Sem interesse' })).etiquetas.includes('quente'));
  assert.equal(atributosDoCartao(cartao({ campos: quente })).atributos.qualificacao, 'Quente');
});

test('campo repetido na Kommo (nomes iguais): vale o 1º com valor', () => {
  const m = atributosDoCartao(cartao({ campos: [campo('Forma de pagamento', null, 'select'), campo('Forma de pagamento', 'Pix', 'select')] }));
  assert.ok(notaDoCartao(cartao({ campos: [campo('Forma de pagamento', null, 'select'), campo('Forma de pagamento', 'Pix', 'select')] }), m, { importadoEm: AGORA, mensagensTotal: 0, mensagensNaConversa: 0 }).includes('Forma de pagamento: Pix'));
});

// ── nota ──
test('nota-resumo: cartão, etapa na Kommo, datas, campos com valor, aviso e a contagem de mensagens', () => {
  const c = cartao({
    etapa: 'EM ESPERA',
    preco: 250,
    etiquetas: ['retomar', 'frio'],
    campos: [campo('✎ Queixa', 'dor lombar há 2 anos', 'textarea'), campo('¤ Valor da Consulta', '250', 'monetary'), campo('◷ Data da Consulta', CONSULTA, 'date_time'), campo('✎ Observações', '', 'textarea')],
  });
  const m = atributosDoCartao(c);
  const n = notaDoCartao(c, m, { importadoEm: AGORA, mensagensTotal: 120, mensagensNaConversa: 50 });
  assert.ok(n.startsWith('📥 Histórico da Kommo — cartão #777 (importado em 25/11/2026)'));
  assert.ok(n.includes('Na Kommo: COMERCIAL › EM ESPERA — esta etapa não tem coluna no CRM: confira'));
  assert.ok(n.includes('Responsável na Kommo: Camily'));
  assert.ok(n.includes('Consulta: 27/11/2026 10:30'));
  assert.ok(n.includes('Queixa: dor lombar há 2 anos'));
  assert.ok(n.includes('Valor da consulta: R$ 250,00'));
  assert.ok(n.includes('Etiquetas na Kommo: retomar, frio'));
  assert.ok(!n.includes('Observações:'), 'campo vazio não entra');
  assert.ok(n.includes('as 50 últimas de 120 mensagens'));
});

test('nota: cabe no limite mesmo com texto enorme', () => {
  const c = cartao({ campos: [campo('Queixa', 'x'.repeat(5000), 'textarea'), campo('Observações', 'y'.repeat(5000), 'textarea')] });
  const n = notaDoCartao(c, atributosDoCartao(c), { importadoEm: AGORA, mensagensTotal: 0, mensagensNaConversa: 0 });
  assert.ok(n.length <= 3500);
});

// ── mensagens ──
test('mensagens: ordem por hora, paciente = external, anexo vira rótulo, vazia some, repetida some, e o teto fica com as ÚLTIMAS', () => {
  const m = (id: string, em: number, text: string | null, tipo: string, anexo?: string) => ({ id, type: 'x', text, created_at: em, author: { type: tipo }, attachment: anexo ? { type: anexo } : null });
  const r = mensagensParaCrm([m('b', 20, 'resposta', 'internal'), m('a', 10, 'oi', 'external'), m('c', 30, '', 'external', 'picture'), m('d', 40, '  ', 'bot'), m('a', 10, 'oi', 'external'), m('e', 50, 'ouça', 'external', 'voice')]);
  assert.deepEqual(r.mensagens.map((x) => [x.id, x.entrada, x.texto]), [['a', true, 'oi'], ['b', false, 'resposta'], ['c', true, '[imagem]'], ['e', true, 'ouça\n[áudio]']]);
  assert.equal(r.total, 4);
  const muitas = Array.from({ length: TETO_DE_MENSAGENS + 20 }, (_, i) => m(`m${i}`, 1000 + i, `t${i}`, 'external'));
  const t = mensagensParaCrm(muitas);
  assert.equal(t.mensagens.length, TETO_DE_MENSAGENS);
  assert.equal(t.mensagens[0]!.id, 'm20', 'o teto fica com o FIM da conversa');
  assert.equal(t.mensagens.at(-1)!.id, `m${TETO_DE_MENSAGENS + 19}`);
  assert.equal(t.total, TETO_DE_MENSAGENS + 20);
});

// ── a linha inteira ──
test('linha do cartão: contato, telefone, marcas, aberto/fechado e sem_telefone', () => {
  const l = linhaDoCartao(cartao(), { id: 55, nome: 'Maria da Silva', telefone: '(47) 99123-4567' }, [], AGORA);
  assert.equal(l.tipo, 'cartao');
  assert.equal(l.lead_id, 777);
  assert.equal(l.nome, 'Maria da Silva');
  assert.equal(l.telefone, '5547991234567');
  assert.equal(l.sem_telefone, null);
  assert.equal(l.aberto, true);
  assert.equal(l.atributos.kommo_lead_id, 777);
  const semFone = linhaDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143 }), { id: 55, nome: null, telefone: '12' }, [], AGORA);
  assert.equal(semFone.telefone, null);
  assert.equal(semFone.sem_telefone, 'invalido');
  assert.equal(semFone.aberto, false);
  assert.equal(semFone.nome, 'Lead 777', 'sem nome no contato: o do cartão');
  const semContato = linhaDoCartao(cartao(), null, [], AGORA);
  assert.equal(semContato.sem_telefone, 'ausente');
});

test('a linha é JSON puro (vai para o arquivo) e não traz URL nem token', () => {
  const l = linhaDoCartao(cartao(), { id: 1, nome: 'A', telefone: '47991234567' }, [{ id: 'm', created_at: 1, text: 'oi', author: { type: 'external' }, attachment: { type: 'voice' } }], AGORA);
  const j = JSON.stringify(l);
  assert.deepEqual(JSON.parse(j), l);
  assert.ok(!/https?:\/\//.test(j));
});
