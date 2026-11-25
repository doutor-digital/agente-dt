/**
 * Histórico da Kommo → CRM (Timbó, 25/11/2026): a decisão pura. Etapa, atributos, etiquetas, nota e mensagens de cada cartão.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atributosDoCartao,
  compararOrdem,
  consultaDePe,
  cortar,
  foneParaWhatsApp,
  linhaDoCartao,
  mensagensParaCrm,
  motivoDeNaoAgendamento,
  nomeLimpo,
  notaDoCartao,
  ordemDoCartao,
  traduzirEtapa,
  TETO_DE_MENSAGENS,
  type CartaoDaKommo,
} from './kommo-historico-crm.js';
import { atualizarVistos, conversaDoChatwoot, decidirRegua, ehArquivo, type DadosDaUnidade } from './chatwoot-regua.js';

// a MESMA função do CAPI (a decisão de `capi_inicial`); o módulo do CAPI lê a configuração do servidor ao carregar
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';
const { eventosAlcancados } = await import('./chatwoot-capi.js');

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
  assert.equal(foneParaWhatsApp('047 99123-4567'), '5547991234567', 'prefixo de tronco 0 («047…»)');
  assert.equal(foneParaWhatsApp('(0xx47) 3333-4444'), '554733334444');
  assert.equal(foneParaWhatsApp('13051234567'), null, '11 dígitos que não são DDD brasileiro + 9…: não é telefone que a gente saiba usar (sem país)');
  assert.equal(foneParaWhatsApp('12850123456'), null, 'DDD 12 existe, mas o 3º dígito 8 não é celular de 11 dígitos: não ganha 55');
  assert.equal(foneParaWhatsApp('1295012345678'), '1295012345678', 'com DDI de país (13 dígitos) entra como veio');
  assert.equal(foneParaWhatsApp('10991234567'), null, 'DDD 10 não existe');
  assert.equal(foneParaWhatsApp('4733334444'), '554733334444');
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

test('nota: cabe no limite mesmo com texto enorme, e o RODAPÉ (conversa, etiquetas, o que conferir) nunca é o que se corta', () => {
  const muitos = Array.from({ length: 30 }, (_, i) => campo(['Queixa', 'Observações', 'Observações de consulta', 'Negociação feita', 'Profissão', 'Plano de saúde'][i % 6]!, `${'x'.repeat(390)}${i}`, 'textarea'));
  const c = cartao({ etiquetas: ['retomar', 'frio'], campos: [...muitos, campo('Queixa', 'y'.repeat(5000), 'textarea')] });
  const n = notaDoCartao(c, atributosDoCartao(c), { importadoEm: AGORA, mensagensTotal: 0, mensagensNaConversa: 0, conversaNaoLida: true });
  assert.ok(n.length <= 3500, `tamanho ${n.length}`);
  assert.ok(n.includes('Etiquetas na Kommo: retomar, frio'));
  assert.ok(n.includes('a Kommo não entregou a conversa'), 'a frase de estado da conversa continua na nota');
  assert.ok(n.startsWith('📥 Histórico da Kommo'));
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
  const l = linhaDoCartao(cartao(), { id: 55, nome: 'Maria da Silva', telefone: '(47) 99123-4567' }, [], AGORA, eventosAlcancados);
  assert.equal(l.tipo, 'cartao');
  assert.equal(l.lead_id, 777);
  assert.equal(l.nome, 'Maria da Silva');
  assert.equal(l.telefone, '5547991234567');
  assert.equal(l.sem_telefone, null);
  assert.equal(l.aberto, true);
  assert.equal(l.atributos.kommo_lead_id, 777);
  const semFone = linhaDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143 }), { id: 55, nome: null, telefone: '12' }, [], AGORA, eventosAlcancados);
  assert.equal(semFone.telefone, null);
  assert.equal(semFone.sem_telefone, 'invalido');
  assert.equal(semFone.aberto, false);
  assert.equal(semFone.nome, 'Lead 777', 'sem nome no contato: o do cartão');
  const semContato = linhaDoCartao(cartao(), null, [], AGORA, eventosAlcancados);
  assert.equal(semContato.sem_telefone, 'ausente');
});

test('corte por ponto de código: emoji não vira meio-emoji e surrogate solitário sai', () => {
  const t = `${'a'.repeat(9)}📥${'b'.repeat(5)}`;
  assert.equal(cortar(t, 10), `${'a'.repeat(9)}📥`);
  assert.equal(cortar(t, 9), 'a'.repeat(9));
  assert.equal(cortar('ok\uD83D', 10), 'ok\uFFFD');
  const l = linhaDoCartao(cartao({ campos: [campo('Queixa', `${'q'.repeat(3300)}📥📥📥`, 'textarea')] }), { id: 1, nome: 'A', telefone: '47991234567' }, [], AGORA, eventosAlcancados);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(l)));
  assert.ok(l.nota.isWellFormed(), 'a nota não tem surrogate solitário');
});

test('conversa que a Kommo não entregou (null) NÃO vira «nenhuma mensagem»: a nota diz a verdade', () => {
  const nao = linhaDoCartao(cartao(), { id: 1, nome: 'A', telefone: '47991234567' }, null, AGORA, eventosAlcancados);
  assert.ok(nao.nota.includes('a Kommo não entregou a conversa'));
  assert.ok(!nao.nota.includes('nenhuma mensagem'));
  const vazia = linhaDoCartao(cartao(), { id: 1, nome: 'A', telefone: '47991234567' }, [], AGORA, eventosAlcancados);
  assert.ok(vazia.nota.includes('nenhuma mensagem na Kommo'));
});

test('direção da mensagem: type=incoming OU autor externo = paciente (o critério do normalizador do repositório); o resto é a clínica', () => {
  const m = (id: string, type: string | undefined, autor: string | undefined) => ({ id, type, text: id, created_at: Number(id.slice(1)), author: autor ? { type: autor } : null });
  const r = mensagensParaCrm([m('m1', 'incoming', undefined), m('m2', 'outgoing', 'external'), m('m3', undefined, 'external'), m('m4', 'outgoing', 'internal'), m('m5', 'outgoing', 'bot'), m('m6', 'incoming', 'internal')]);
  assert.deepEqual(r.mensagens.map((x) => [x.id, x.entrada]), [['m1', true], ['m2', true], ['m3', true], ['m4', false], ['m5', false], ['m6', true]]);
});

test('campo de DATA sem hora: o dia UTC do valor (03:00 UTC e 00:00 UTC dão o MESMO dia); campo COM hora: o dia em Belém', () => {
  const tres = Math.floor(Date.parse('2026-12-01T03:00:00Z') / 1000); // 00:00 em UTC−3
  const zero = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000); // 00:00 UTC: o −3 h jogaria para a véspera
  for (const v of [tres, zero]) {
    const m = atributosDoCartao(cartao({ campos: [campo('◷ Retomar em', v, 'date'), campo('◷ Data de alta', v, 'date'), campo('◷ Data de retorno com exames', v, 'date')] }));
    assert.equal(m.atributos.retomar_em, '2026-12-01', String(v));
    assert.equal(m.atributos.data_alta, '2026-12-01');
    assert.equal(m.atributos.data_retorno, '2026-12-01');
  }
  const comHora = atributosDoCartao(cartao({ campos: [campo('◷ Data da Consulta', zero, 'date_time')] }));
  assert.equal(comHora.atributos.data_consulta, '2026-11-30', 'com hora, 00:00 UTC é 21:00 de Belém do dia anterior');
});

test('etapa de ENTRADA reconhecida pelo TIPO (1), com qualquer nome; valor em reais no formato pt-BR', () => {
  assert.equal(traduzirEtapa(cartao({ etapa: 'Leads de entrada', statusTipo: 1 })).etapa, 'Novo lead');
  assert.equal(traduzirEtapa(cartao({ funil: 'TRATAMENTO', etapa: 'Entrada nova', statusTipo: 1 })).etapaTratamento, 'Entrada');
  for (const [bruto, esperado] of [['1.500,00', 1500], ['1500.50', 1500.5], ['250', 250], ['1.234.567,89', 1234567.89], ['1.500', 1500], ['2.500.000', 2500000], ['1.5', 1.5], ['0.500', 0.5], ['1500.500', 1500.5], ['R$ ?', undefined]] as const) {
    const m = atributosDoCartao(cartao({ etapa: 'GANHO / CONCLUÍDO', statusId: 142, fechadoEm: 1_790_050_000, campos: [campo('Valor do tratamento', bruto, 'monetary')] }));
    assert.equal(m.atributos.valor_fechado, esperado, bruto);
  }
});

test('a linha é JSON puro (vai para o arquivo) e não traz URL nem token', () => {
  const l = linhaDoCartao(cartao(), { id: 1, nome: 'A', telefone: '47991234567' }, [{ id: 'm', created_at: 1, text: 'oi', author: { type: 'external' }, attachment: { type: 'voice' } }], AGORA, eventosAlcancados);
  const j = JSON.stringify(l);
  assert.deepEqual(JSON.parse(j), l);
  assert.ok(!/https?:\/\//.test(j));
});

test('AGENDADO com data de consulta e «Situação da consulta» em branco: a situação é a da etapa (sem ela a conversa nasceria arquivo, sem lembrete)', () => {
  const dia = campo('◷ Data da Consulta', 1_790_000_000, 'date_time');
  assert.equal(atributosDoCartao(cartao({ etapa: 'AGENDADO', campos: [dia] })).atributos.situacao_consulta, 'Agendado');
  assert.equal(atributosDoCartao(cartao({ etapa: 'AGENDADO', campos: [dia, campo('✓ Situação da consulta', 'Confirmado', 'select')] })).atributos.situacao_consulta, 'Confirmado');
  assert.equal(atributosDoCartao(cartao({ etapa: 'AGENDADO' })).atributos.situacao_consulta, undefined, 'sem data de consulta não inventa situação');
  assert.equal(atributosDoCartao(cartao({ etapa: 'EM QUALIFICAÇÃO', campos: [dia] })).atributos.situacao_consulta, undefined, 'só nas etapas Agendado/Confirmado');
});

// ── a situação e o destino da consulta de pé (rodada 4) ──

const BELEM_AMANHA = Math.floor(Date.parse('2026-11-26T13:00:00Z') / 1000); // 26/11 10:00 em Belém
const camposDaConsulta = (epoch: number, situacao?: string) => [campo('◷ Data da Consulta', epoch, 'date_time'), ...(situacao ? [campo('✓ Situação da consulta', situacao, 'select')] : [])];

test('NÃO COMPARECEU com consulta DEPOIS DE HOJE nasce «Remarcado» (de pé); com consulta passada continua «Não compareceu»; fechado não muda', () => {
  const futuro = atributosDoCartao(cartao({ etapa: 'NÃO COMPARECEU', campos: camposDaConsulta(BELEM_AMANHA) }), AGORA);
  assert.equal(futuro.atributos.etapa, 'Agendado');
  assert.equal(futuro.atributos.situacao_consulta, 'Remarcado');
  assert.ok(futuro.avisos.includes('nao-compareceu-com-consulta-futura'));
  assert.equal(atributosDoCartao(cartao({ etapa: 'AGENDADO', campos: camposDaConsulta(BELEM_AMANHA, 'Não compareceu') }), AGORA).atributos.situacao_consulta, 'Remarcado', 'a situação do campo também');
  const hoje = Math.floor(Date.parse('2026-11-25T20:00:00Z') / 1000); // 25/11 17:00 Belém: HOJE
  assert.equal(atributosDoCartao(cartao({ etapa: 'NÃO COMPARECEU', campos: camposDaConsulta(hoje) }), AGORA).atributos.situacao_consulta, 'Não compareceu', 'consulta de HOJE: quem faltou hoje faltou (não vira Remarcado)');
  const ontem = Math.floor(Date.parse('2026-11-24T13:00:00Z') / 1000);
  assert.equal(atributosDoCartao(cartao({ etapa: 'NÃO COMPARECEU', campos: camposDaConsulta(ontem) }), AGORA).atributos.situacao_consulta, 'Não compareceu', 'faltou de verdade: a régua manda o «você faltou»');
  assert.equal(atributosDoCartao(cartao({ etapa: 'PERDIDO', statusId: 143, fechadoEm: 1_790_000_000, campos: camposDaConsulta(BELEM_AMANHA, 'Não compareceu') }), AGORA).atributos.situacao_consulta, 'Não compareceu', 'cartão fechado fica como está');
});

test('consultaDePe: só cartão ABERTO, consulta de hoje em diante e situação de pé; a linha leva o sinal', () => {
  const m = (c: CartaoDaKommo) => atributosDoCartao(c, AGORA);
  const aberto = cartao({ etapa: 'AGENDADO', campos: camposDaConsulta(BELEM_AMANHA, 'Agendado') });
  assert.equal(consultaDePe(aberto, m(aberto), AGORA), true);
  assert.equal(linhaDoCartao(aberto, { id: 1, nome: 'A', telefone: '47991234567' }, [], AGORA, eventosAlcancados).consulta_de_pe, true);
  const passada = cartao({ etapa: 'AGENDADO', campos: camposDaConsulta(Math.floor(Date.parse('2026-11-20T13:00:00Z') / 1000), 'Agendado') });
  assert.equal(consultaDePe(passada, m(passada), AGORA), false, 'consulta de 5 dias atrás: arquivo');
  const fechado = cartao({ etapa: 'GANHO / CONCLUÍDO', statusId: 142, fechadoEm: 1_790_000_000, campos: camposDaConsulta(BELEM_AMANHA, 'Agendado') });
  assert.equal(consultaDePe(fechado, m(fechado), AGORA), false, 'Fechou/Alta: arquivo');
  const semData = cartao({ etapa: 'AGENDADO' });
  assert.equal(consultaDePe(semData, m(semData), AGORA), false);
});

test('destino: a consulta de pé vem NA FRENTE do aberto mais novo (o «confirmo» cai na conversa certa)', () => {
  const pe = ordemDoCartao({ consultaDePe: true, aberto: true, atualizadoEm: 100, id: 1 });
  const novoAberto = ordemDoCartao({ consultaDePe: false, aberto: true, atualizadoEm: 900, id: 2 });
  const fechadoNovo = ordemDoCartao({ consultaDePe: false, aberto: false, atualizadoEm: 999, id: 3 });
  assert.equal(compararOrdem(pe, novoAberto), 1);
  assert.equal(compararOrdem(novoAberto, fechadoNovo), 1);
  assert.equal(compararOrdem(pe, pe), 0);
});

const UNIDADE: DadosDaUnidade = { nome: 'Doutor Hérnia Timbó', pixKey: 'pix@x', valorAntecipado: 250 };
/** o que a régua mandaria, hora a hora, a uma conversa importada: o mesmo ciclo do worker (arquivo não é lido; a 1ª vista com `historico` é «inicial») */
function varrerRegua(raw: any, de: string, ate: string): string[] {
  let vistos: any = new Map();
  const saiu: string[] = [];
  for (let t = Date.parse(de); t <= Date.parse(ate); t += 3600_000) {
    const quando = new Date(t);
    if (ehArquivo(raw, quando)) continue;
    const c = { ...conversaDoChatwoot(raw)!, criadaEm: new Date(de) };
    const k = atualizarVistos(c, vistos, quando, { primeiraVez: false, desde: new Date('2026-11-01T00:00:00Z') });
    vistos = k.vistos;
    for (const d of decidirRegua(c, { vistos: k.vistos, feitos: new Set() }, quando, UNIDADE).disparos) if (!saiu.includes(d.regra)) saiu.push(d.regra);
  }
  return saiu;
}

test('integração: NÃO COMPARECEU com consulta FUTURA recebe a véspera e o lembrete do dia — e NUNCA o «você faltou» (falta-48h)', () => {
  const linha = linhaDoCartao(cartao({ etapa: 'NÃO COMPARECEU', campos: camposDaConsulta(Math.floor(Date.parse('2026-11-27T13:00:00Z') / 1000)) }), { id: 1, nome: 'Maria', telefone: '47991234567' }, [], AGORA, eventosAlcancados);
  const importadoEm = Math.floor(AGORA.getTime() / 1000);
  const raw = { id: 5, created_at: importadoEm - 86_400, labels: ['historico'], status: 'resolved', last_activity_at: importadoEm, additional_attributes: { kommo_lead_id: 777, kommo_importado_em: importadoEm, kommo_aberto: linha.aberto }, custom_attributes: linha.atributos, meta: { sender: { name: 'Maria', phone_number: '+5547991234567', identifier: '5547991234567' } }, last_non_activity_message: null };
  assert.equal(linha.consulta_de_pe, true);
  const saiu = varrerRegua(raw, '2026-11-25T15:00:00Z', '2026-12-05T15:00:00Z');
  assert.ok(saiu.includes('consulta-vespera') && saiu.includes('consulta-dia'), `véspera e dia (saiu: ${saiu.join(', ')})`);
  assert.ok(!saiu.includes('falta-48h') && !saiu.includes('falta-mesmo-dia'), `«você faltou» não sai (saiu: ${saiu.join(', ')})`);
  // contraprova: a MESMA conversa com a situação «Não compareceu» (o que o importador gravava) ficaria sem véspera (e o «você faltou» chegaria se a conversa seguisse viva depois da consulta)
  const antiga = { ...raw, custom_attributes: { ...linha.atributos, situacao_consulta: 'Não compareceu' } };
  const saiuAntes = varrerRegua(antiga, '2026-11-25T15:00:00Z', '2026-12-05T15:00:00Z');
  assert.ok(!saiuAntes.includes('consulta-vespera'), `com «Não compareceu» a régua NÃO manda véspera (saiu: ${saiuAntes.join(', ')})`);
});

test('capi_inicial: os eventos do CAPI que o estado importado já alcança (a mesma função do CAPI); estado que não alcança nada = lista vazia', () => {
  const eventos = (c: CartaoDaKommo) => linhaDoCartao(c, { id: 1, nome: 'A', telefone: '47991234567' }, [], AGORA, eventosAlcancados).capi_inicial;
  assert.deepEqual(eventos(cartao({ etapa: 'GANHO / CONCLUÍDO', statusId: 142, fechadoEm: 1_790_000_000, campos: [campo('Fechou tratamento', 'Sim', 'checkbox')] })).sort(), eventosAlcancados({ etapa: 'Fechou', fechou_tratamento: true }).sort());
  assert.deepEqual(eventos(cartao({ etapa: 'AGENDADO', campos: camposDaConsulta(BELEM_AMANHA, 'Agendado') })), ['AddToCart']);
  assert.deepEqual(eventos(cartao({ etapa: 'EM QUALIFICAÇÃO' })), []);
});
