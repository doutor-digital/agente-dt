/**
 * Rotina diária dos robôs — a parte pura (06/11/2026): prazos por etapa, configuração por unidade, o degrau da vez,
 * as travas do cartão, a marca e o aniversário. Nada de Kommo nem banco aqui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KommoLead } from '../services/kommo.service.js';
import {
  ENTRADA_EXLEAD_DIAS,
  ETIQUETAS_EXLEAD,
  ETIQUETAS_RETOMADA,
  REGUAS_POR_ETAPA,
  aniversarioHoje,
  aniversarioNoDia,
  diaDeNascimentoDaFicha,
  cartaoMostraConsulta,
  configDaUnidade,
  decidirToque,
  idDaMarca,
  lerMarca,
  marcasDoSilencio,
  motivoMorto,
  naJanelaDoAniversario,
  porQueNaoTocar,
  statusDeFalecido,
  type EntradaDoToque,
} from './rotina-robos.js';

const AGORA = Date.UTC(2026, 10, 6, 13, 0, 0) / 1000; // 06/11/2026 13h UTC (10h em Brasília)
const DIA = 86_400;
const TZ = 'America/Sao_Paulo';

const carta = (tags: string[] = [], campos: Record<string, unknown> = {}): Pick<KommoLead, 'custom_fields_values' | '_embedded'> => ({
  custom_fields_values: Object.entries(campos).map(([nome, value], i) => ({ field_id: 9000 + i, field_name: nome, values: [{ value }] })) as KommoLead['custom_fields_values'],
  _embedded: { tags: tags.map((name, i) => ({ id: i + 1, name })) },
});
const opcoes = { agora: AGORA, tz: TZ, pausarIaFieldId: null as number | null };

// ─── prazos por etapa (os do João) ────────────────────────────────────────────────────────────────

test('os prazos padrão são os do João: QUALIFICAÇÃO 2/4/7, NÃO COMPARECEU 1/3/6, NEGOCIAÇÃO 2/5/9, ex-lead 30/60/90', () => {
  const c = configDaUnidade(null, {});
  assert.deepEqual(c.etapas, { qualificacao: [2, 4, 7], naocompareceu: [1, 3, 6], negociacao: [2, 5, 9] });
  assert.deepEqual(c.exlead, [30, 60, 90]);
  assert.equal(c.teto, 30);
  assert.deepEqual(REGUAS_POR_ETAPA.map((r) => r.etapa), ['EM QUALIFICAÇÃO', 'NÃO COMPARECEU', 'EM NEGOCIAÇÃO']);
});

test('a unidade muda os prazos pelo pipelineIntents; prazo que não cresce volta ao padrão e fica anotado', () => {
  const c = configDaUnidade({ rotina_qualificacao_d1: 3, rotina_qualificacao_d2: 5, rotina_naocompareceu_d2: 1, rotina_teto_dia: 12, rotina_toques_prontos: 2 }, {});
  assert.deepEqual(c.etapas.qualificacao, [3, 5, 7]);
  assert.deepEqual(c.etapas.naocompareceu, [1, 3, 6], 'd2=1 não é maior que d1=1: padrão');
  assert.equal(c.invalidas.length, 1);
  assert.equal(c.teto, 12);
  assert.equal(c.toquesProntosEtapas, 2);
  assert.equal(c.toquesProntosExlead, 1);
  assert.equal(configDaUnidade({ rotina_teto_dia: 99999 }, {}).teto, 500, 'teto absurdo é cortado');
});

test('a rede muda os prazos pelo ambiente; a unidade ainda manda por cima', () => {
  const c = configDaUnidade({ rotina_negociacao_d3: 12 }, { ROTINA_ROBOS_DIAS_NEGOCIACAO: '3,6,10', ROTINA_ROBOS_TETO_DIA: '20' });
  assert.deepEqual(c.etapas.negociacao, [3, 6, 12]);
  assert.equal(c.teto, 20);
});

// ─── o degrau da vez ──────────────────────────────────────────────────────────────────────────────

const entrada = (silencioDias: number, extra: Partial<EntradaDoToque> = {}): EntradaDoToque => ({
  agora: AGORA,
  dias: [2, 4, 7],
  etiquetas: ETIQUETAS_RETOMADA,
  prontos: 3,
  ultimaDoPaciente: AGORA - silencioDias * DIA,
  marcas: [],
  entradaAteDias: 30,
  ...extra,
});

test('cada etapa dispara no prazo dela, nem um dia antes', () => {
  for (const r of REGUAS_POR_ETAPA) {
    const antes = decidirToque(entrada(r.dias[0] - 0.5, { dias: r.dias }));
    assert.equal(antes.tipo, 'espera', `${r.etapa}: faltando meio dia`);
    const no = decidirToque(entrada(r.dias[0], { dias: r.dias }));
    assert.equal(no.tipo, 'toca', `${r.etapa}: no dia ${r.dias[0]}`);
    assert.equal(no.tipo === 'toca' && no.toque, 1);
    assert.equal(no.tipo === 'toca' && no.etiqueta, '▶ Retomada');
  }
});

test('sem mensagem do paciente na janela não é esquecido: nada', () => {
  assert.equal(decidirToque(entrada(5, { ultimaDoPaciente: null })).tipo, 'fora');
});

test('estoque antigo não entra: calado há mais que a janela e sem nenhum toque enviado', () => {
  const d = decidirToque(entrada(45));
  assert.equal(d.tipo, 'fora');
});

test('a régua anda na ordem, sem repetir e sem pular: o 2º só com 4 dias E o espaço do desenho depois do 1º', () => {
  const primeiro = { toque: 1, em: AGORA - 2 * DIA };
  // 4 dias de silêncio, 1º saiu há 2 dias (o espaço é 4−2 = 2): sai o 2º
  const dois = decidirToque(entrada(4, { marcas: [primeiro] }));
  assert.equal(dois.tipo === 'toca' && dois.toque, 2);
  assert.equal(dois.tipo === 'toca' && dois.etiqueta, '▶ Retomada 2');
  // 5 dias de silêncio, mas o 1º saiu ontem: espera o espaço
  const cedo = decidirToque(entrada(5, { marcas: [{ toque: 1, em: AGORA - DIA }] }));
  assert.equal(cedo.tipo, 'espera');
  // 3 dias de silêncio com o 1º enviado: o 2º ainda não venceu
  assert.equal(decidirToque(entrada(3, { marcas: [primeiro] })).tipo, 'espera');
  // 1º enviado há tempos, silêncio de 8 dias: o próximo é o 2º (nunca pula pro 3º)
  const tarde = decidirToque(entrada(8, { marcas: [{ toque: 1, em: AGORA - 6 * DIA }] }));
  assert.equal(tarde.tipo === 'toca' && tarde.toque, 2);
});

test('quem chega atrasado leva o 1º hoje e o 2º só no espaço certo: nunca dois no mesmo dia', () => {
  const hoje = decidirToque(entrada(9));
  assert.equal(hoje.tipo === 'toca' && hoje.toque, 1);
  assert.equal(hoje.tipo === 'toca' && hoje.atrasado, true);
  const amanha = decidirToque(entrada(10, { marcas: [{ toque: 1, em: AGORA - DIA }] }));
  assert.equal(amanha.tipo, 'espera');
});

test('acabou a régua sem resposta: não manda mais nada (quem move é o parados)', () => {
  const todas = [1, 2, 3].map((toque) => ({ toque, em: AGORA - (4 - toque) * DIA }));
  assert.equal(decidirToque(entrada(20, { marcas: todas })).tipo, 'esgotada');
});

test('a mensagem do paciente zera a régua: marcas de ANTES dela não contam', () => {
  const marcas = [
    { leadId: 1, chave: 'qualificacao', toque: 1, em: AGORA - 10 * DIA },
    { leadId: 1, chave: 'qualificacao', toque: 2, em: AGORA - 8 * DIA },
    { leadId: 1, chave: 'negociacao', toque: 1, em: AGORA - 3 * DIA },
  ];
  const escreveuHaCincoDias = marcasDoSilencio(marcas, 'qualificacao', AGORA - 5 * DIA);
  assert.deepEqual(escreveuHaCincoDias, [], 'respondeu depois dos dois toques: recomeça do 1º');
  assert.equal(decidirToque(entrada(5, { marcas: escreveuHaCincoDias })).tipo === 'toca', true);
  assert.deepEqual(marcasDoSilencio(marcas, 'negociacao', AGORA - 5 * DIA).length, 1, 'cada etapa tem a sua régua');
});

test('degrau sem robô/gatilho confirmado na conta não sai: aparece como «sem gatilho» (no papel) e não manda', () => {
  const d = decidirToque(entrada(5, { prontos: 1, marcas: [{ toque: 1, em: AGORA - 3 * DIA }] }));
  assert.equal(d.tipo, 'sem-gatilho');
  assert.equal(d.tipo === 'sem-gatilho' && d.etiqueta, '▶ Retomada 2');
});

test('ex-lead: 30/60/90 desde a última mensagem; o 1º só entra na janela [30, 60)', () => {
  const base = { dias: [30, 60, 90], etiquetas: ETIQUETAS_EXLEAD, entradaAteDias: 30 + ENTRADA_EXLEAD_DIAS };
  assert.equal(decidirToque(entrada(29, base)).tipo, 'espera');
  const trinta = decidirToque(entrada(30, base));
  assert.equal(trinta.tipo === 'toca' && trinta.etiqueta, '▶ Reativação');
  assert.equal(decidirToque(entrada(75, base)).tipo, 'fora', 'estoque de 75 dias sem 1º toque: não entra');
  const sessenta = decidirToque(entrada(61, { ...base, marcas: [{ toque: 1, em: AGORA - 31 * DIA }] }));
  assert.equal(sessenta.tipo === 'toca' && sessenta.etiqueta, '▶ Reativação 2');
  const noventa = decidirToque(entrada(91, { ...base, marcas: [{ toque: 1, em: AGORA - 61 * DIA }, { toque: 2, em: AGORA - 31 * DIA }] }));
  assert.equal(noventa.tipo === 'toca' && noventa.etiqueta, '▶ Reativação 3');
});

// ─── marca ────────────────────────────────────────────────────────────────────────────────────────

test('o id da marca é determinístico e a leitura pega o fim (o id da unidade pode ter hífen)', () => {
  const id = idDaMarca('u-petro-1', 777, 'qualificacao', 2, 1_700_000_000);
  assert.equal(id, 'rotina-u-petro-1-777-qualificacao-2-1700000000');
  assert.deepEqual(lerMarca(id, 777, new Date(AGORA * 1000)), { leadId: 777, chave: 'qualificacao', toque: 2, em: AGORA });
  assert.equal(lerMarca('etiqueta-u-1-boas-vindas:1:2', 1, new Date()), null, 'marca do etiquetas-auto não é daqui');
});

// ─── travas do cartão ─────────────────────────────────────────────────────────────────────────────

test('travas do cartão: etiquetas de não contatar, currículo, fora do escopo e opt-out nunca recebem', () => {
  for (const tag of ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'BLOQUEADO_WHATSAPP', 'CURRÍCULO', 'Fora do escopo', 'Fluxo · Opt-out WhatsApp']) {
    assert.equal(porQueNaoTocar(carta([tag]), opcoes)?.codigo, 'nao-contatar', tag);
  }
  assert.equal(porQueNaoTocar(carta([], { '✓ Opt-out WhatsApp': 'Sim' }), opcoes)?.codigo, 'opt-out');
  assert.equal(porQueNaoTocar(carta(['LOMBAR']), opcoes), null, 'etiqueta qualquer não trava');
});

test('travas do cartão: consulta futura, ◷ Retomar em de hoje em diante e Pausar IA seguram', () => {
  const futuro = AGORA + 3 * DIA;
  assert.equal(porQueNaoTocar(carta([], { '◷ Data da Consulta': futuro }), opcoes)?.codigo, 'consulta-futura-cartao');
  assert.equal(porQueNaoTocar(carta([], { '◷ Data da Consulta': futuro, '✓ Situação da consulta': 'Desmarcado' }), opcoes), null, 'consulta desmarcada não é de pé');
  assert.equal(porQueNaoTocar(carta([], { '◷ Retomar em': futuro }), opcoes)?.codigo, 'retomar-em');
  assert.equal(porQueNaoTocar(carta([], { '◷ Retomar em': AGORA - 5 * DIA }), opcoes), null, 'retomada que já passou não segura');
  const pausar = { custom_fields_values: [{ field_id: 777, field_name: 'Pausar IA', values: [{ value: true }] }], _embedded: { tags: [] } } as unknown as Pick<KommoLead, 'custom_fields_values' | '_embedded'>;
  assert.equal(porQueNaoTocar(pausar, { ...opcoes, pausarIaFieldId: 777 })?.codigo, 'pausar-ia');
});

test('NÃO COMPARECEU: a consulta que faltou está no cartão e NÃO segura (só a de pé segura)', () => {
  const faltou = carta([], { '◷ Data da Consulta': AGORA - 2 * DIA, '✓ Situação da consulta': 'Não compareceu' });
  assert.equal(porQueNaoTocar(faltou, opcoes), null);
});

test('motivo de perda encerrado só trava onde a régua o confere (ex-lead e aniversário)', () => {
  for (const m of ['Outra cidade', 'Clicou por engano', 'Outra patologia', 'Plano de Saúde', 'Sem interesse']) {
    const c = carta([], { '⊘ Motivo do não agendamento': m });
    assert.equal(motivoMorto(c), m);
    assert.equal(porQueNaoTocar(c, { ...opcoes, conferirMotivoMorto: true })?.codigo, 'motivo-morto', m);
    assert.equal(porQueNaoTocar(c, opcoes), null, 'a régua por etapa não olha o motivo de PERDIDO');
  }
  assert.equal(motivoMorto(carta([], { '⊘ Motivo do não agendamento': 'Sem condições financeira' })), null, 'trabalhável');
  assert.equal(motivoMorto(carta([], { '⊘ Motivo de não fechamento': 'Sem interesse' })), 'Sem interesse', 'o outro campo ⊘ também');
});

test('«só não contatar» (aniversário): Retomar em, consulta futura e Pausar IA não impedem parabéns', () => {
  const c = carta([], { '◷ Retomar em': AGORA + 5 * DIA, '◷ Data da Consulta': AGORA + 2 * DIA });
  assert.equal(porQueNaoTocar(c, { ...opcoes, soNaoContatar: true }), null);
  assert.equal(porQueNaoTocar(carta(['NAO_PERTURBAR']), { ...opcoes, soNaoContatar: true })?.codigo, 'nao-contatar');
});

test('cartaoMostraConsulta: data, situação, compareceu ou tratamento fechado no cartão', () => {
  assert.equal(cartaoMostraConsulta(carta()), false);
  assert.equal(cartaoMostraConsulta(carta([], { '◷ Data da Consulta': AGORA })), true);
  assert.equal(cartaoMostraConsulta(carta([], { '✓ Situação da consulta': 'Atendido' })), true);
  assert.equal(cartaoMostraConsulta(carta([], { '✓ Compareceu': 'false' })), false);
});

// ─── aniversário ──────────────────────────────────────────────────────────────────────────────────

/** Como o Kommo guarda o campo `date`: meia-noite no fuso da conta (Brasília = 03:00 UTC). */
const nasc = (iso: string) => Date.parse(`${iso}T03:00:00Z`) / 1000;

test('aniversário: dia e mês batem no fuso da unidade; ano de nascimento absurdo não vale', () => {
  assert.equal(aniversarioHoje(nasc('1980-11-06'), AGORA, TZ), true);
  assert.equal(aniversarioHoje(nasc('1980-11-07'), AGORA, TZ), false);
  assert.equal(aniversarioHoje(nasc('2026-11-06'), AGORA, TZ), false, 'nasceu hoje: data digitada errada');
  assert.equal(aniversarioHoje(nasc('1850-11-06'), AGORA, TZ), false);
  assert.equal(aniversarioHoje(null, AGORA, TZ), false);
});

test('a ficha da franquia diz a data em ISO ou dd/mm/aaaa; lixo vira null', () => {
  assert.equal(diaDeNascimentoDaFicha('1980-11-06T00:00:00.000Z'), '1980-11-06');
  assert.equal(diaDeNascimentoDaFicha('06/11/1980'), '1980-11-06');
  assert.equal(diaDeNascimentoDaFicha('ontem'), null);
  assert.equal(diaDeNascimentoDaFicha(null), null);
  assert.equal(aniversarioNoDia('1980-11-06', AGORA, TZ), true);
  assert.equal(aniversarioNoDia(null, AGORA, TZ), false);
});

test('aniversário de 29/02 comemora em 28/02 nos anos sem bissexto', () => {
  const dia28 = Date.UTC(2027, 1, 28, 13) / 1000;
  const dia29 = Date.UTC(2028, 1, 29, 13) / 1000;
  assert.equal(aniversarioHoje(nasc('1996-02-29'), dia28, TZ), true);
  assert.equal(aniversarioHoje(nasc('1996-02-29'), dia29, TZ), true);
  assert.equal(aniversarioHoje(nasc('1996-02-29'), Date.UTC(2028, 1, 28, 13) / 1000, TZ), false, 'ano bissexto: é dia 29');
});

test('aniversário sai só de manhã na hora da unidade (9h a 12h)', () => {
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 12, 30) / 1000, TZ), true, '9h30 em Brasília');
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 11, 59) / 1000, TZ), false, '8h59');
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 15, 0) / 1000, TZ), false, '12h');
  assert.equal(naJanelaDoAniversario(Date.UTC(2026, 10, 6, 13, 0) / 1000, 'America/Manaus'), true, '9h em Manaus (UTC-4)');
});

test('paciente falecido na franquia nunca recebe parabéns', () => {
  assert.equal(statusDeFalecido('Óbito'), true);
  assert.equal(statusDeFalecido('Falecido'), true);
  assert.equal(statusDeFalecido('Ativo'), false);
  assert.equal(statusDeFalecido(null), false);
});
