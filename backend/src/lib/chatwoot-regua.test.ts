/**
 * A régua do Chatwoot (função pura): cada regra dispara no alvo e não antes, não repete, respeita o atraso máximo,
 * o `sem-follow-up`, a janela de horário, muda de chave ao remarcar e não manda texto com campo faltando.
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atualizarVistos,
  brl,
  conversaDoChatwoot,
  decidirEtiquetaCelular,
  decidirRegua,
  janelaAberta,
  lerData,
  lerHora,
  notaDoSeco,
  primeiroNome,
  renderizar,
  SUFIXO_FALTA,
  type ConversaRegua,
  type DadosDaUnidade,
  type Disparo,
  type MensagemResumo,
  type Visto,
} from './chatwoot-regua.js';
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';

const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const Z = (s: string) => new Date(s);

function conv(o: { attrs?: Record<string, unknown>; etiquetas?: string[]; nome?: string; atendente?: string | null; ultima?: MensagemResumo | null } = {}): ConversaRegua {
  return {
    id: 10,
    nome: o.nome ?? 'maria da silva',
    etiquetas: o.etiquetas ?? [],
    attrs: o.attrs ?? {},
    criadaEm: Z('2026-10-01T12:00:00Z'),
    atendente: o.atendente === undefined ? 'Ana' : o.atendente,
    ultima: o.ultima ?? null,
  };
}
const visto = (valor: string, desde: string, inicial = false): Visto => ({ valor, desde: Z(desde), inicial });
const vistos = (o: Record<string, Visto>) => new Map(Object.entries(o));
function rodar(c: ConversaRegua, agora: string, v: Record<string, Visto> = {}, feitos: string[] = [], u: DadosDaUnidade = U) {
  return decidirRegua(c, { vistos: vistos(v), feitos: new Set(feitos) }, Z(agora), u);
}
const regras = (d: { disparos: Disparo[] }) => d.disparos.map((x) => x.regra).sort();

// ── utilidades ─────────────────────────────────────────────────────────────────────────────────────

test('data e hora: formatos do Chatwoot, lixo e data impossível', () => {
  assert.equal(lerData('2026-11-13')?.iso, '2026-11-13');
  assert.equal(lerData('2026-11-13T03:00:00.000Z')?.iso, '2026-11-13');
  assert.equal(lerData('2026-02-30'), null);
  assert.equal(lerData('13/11/2026'), null);
  assert.equal(lerData(null), null);
  assert.deepEqual(lerHora('14:30'), { hh: 14, mm: 30 });
  assert.deepEqual(lerHora('9:05'), { hh: 9, mm: 5 });
  assert.deepEqual(lerHora('14h'), { hh: 14, mm: 0 });
  assert.deepEqual(lerHora('14h30'), { hh: 14, mm: 30 });
  assert.equal(lerHora('25:00'), null);
  assert.equal(lerHora('tarde'), null);
  assert.equal(lerHora(''), null);
});

test('janela: 08:00–20:00 de Belém, segunda a sábado', () => {
  assert.equal(janelaAberta(Z('2026-11-16T10:59:00Z')), false); // 07:59 seg
  assert.equal(janelaAberta(Z('2026-11-16T11:00:00Z')), true); // 08:00 seg
  assert.equal(janelaAberta(Z('2026-11-16T22:59:00Z')), true); // 19:59
  assert.equal(janelaAberta(Z('2026-11-16T23:00:00Z')), false); // 20:00
  assert.equal(janelaAberta(Z('2026-11-14T15:00:00Z')), true); // sábado
  assert.equal(janelaAberta(Z('2026-11-15T15:00:00Z')), false); // domingo
  assert.equal(janelaAberta(Z('2026-11-16T01:00:00Z')), false); // 22:00 de domingo em Belém
});

test('primeiro nome e dinheiro', () => {
  assert.equal(primeiroNome('maria da silva'), 'Maria');
  assert.equal(primeiroNome('JOÃO PEDRO'), 'João');
  assert.equal(primeiroNome('Ana Paula'), 'Ana');
  assert.equal(primeiroNome('+55 94 99999-0000'), null);
  assert.equal(primeiroNome(''), null);
  assert.equal(brl(350), 'R$ 350');
  assert.equal(brl(1234.5), 'R$ 1.234,50');
});

test('os modelos usados existem e só têm campos que a régua sabe preencher', () => {
  const conhecidos = new Set(['contact.name', 'lead.cf.2450736', 'lead.cf.2450928', 'lead.cf.2450998', 'lead.cf.2451112', 'lead.cf.2451110', 'lead.cf.2451104', 'lead.cf.2450798', 'lead.cf.2451006', 'lead.cf.2450732', 'lead.cf.2450750']);
  for (const [nome, texto] of Object.entries(TEXTOS_PARAU)) {
    assert.ok(texto.trim().length > 20, nome);
    for (const m of texto.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) assert.ok(conhecidos.has(m[1]!), `${nome}: ${m[1]}`);
  }
});

// ── 1–3: perdido ───────────────────────────────────────────────────────────────────────────────────

const PERDIDO = { etapa: 'Perdido' };
const T0 = '2026-11-16T12:00:00Z'; // segunda 09:00 em Belém

test('followup 48/96/120 h: dispara no alvo, não antes', () => {
  const v = { etapa: visto('Perdido', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO }), '2026-11-18T11:59:00Z', v)), []);
  const r48 = rodar(conv({ attrs: PERDIDO }), '2026-11-18T12:00:00Z', v);
  assert.deepEqual(regras(r48), ['followup-48h']);
  assert.match(r48.disparos[0]!.texto!, /^Olá, Maria, aqui é da Doutor Hérnia Parauapebas\./);
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO }), '2026-11-20T12:00:00Z', v, ['followup-48h|perdido@2026-11-16T12:00:00.000Z'])), ['followup-96h']);
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO }), '2026-11-21T12:00:00Z', v)), ['followup-120h']); // sábado 09:00
});

test('followup: não repete, atraso máximo, sem-follow-up, inicial e funil Tratamento', () => {
  const v = { etapa: visto('Perdido', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO }), '2026-11-18T12:00:00Z', v, ['followup-48h|perdido@2026-11-16T12:00:00.000Z'])), []);
  // 48h + 13h (dentro da janela do dia seguinte não importa: o 48h já expirou); só o 96h existe mais adiante
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO }), '2026-11-19T12:00:00Z', v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO, etiquetas: ['sem-follow-up'] }), '2026-11-18T12:00:00Z', v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: PERDIDO }), '2026-11-18T12:00:00Z', { etapa: visto('Perdido', T0, true) })), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...PERDIDO, funil: 'Tratamento' } }), '2026-11-18T12:00:00Z', v)), []);
  // saiu de Perdido: a regra some
  assert.deepEqual(regras(rodar(conv({ attrs: { etapa: 'Agendado' } }), '2026-11-18T12:00:00Z', v)), []);
});

test('perdida: aparece uma vez, logo depois de expirar', () => {
  const v = { etapa: visto('Perdido', T0) };
  // limite do 48h = T0 + 60h = 19/11 00:00Z; 10 min depois ainda cabe no log
  assert.deepEqual(rodar(conv({ attrs: PERDIDO }), '2026-11-19T00:10:00Z', v).perdidas, ['followup-48h']);
  assert.deepEqual(rodar(conv({ attrs: PERDIDO }), '2026-11-19T06:00:00Z', v).perdidas, []);
});

// ── 4–5: pré-pagamento ─────────────────────────────────────────────────────────────────────────────

const AGENDADO = { etapa: 'Agendado', pagamento_antecipado: true, situacao_consulta: 'Agendado', data_consulta: '2026-11-17', hora_consulta: '14:30' };

test('prepagamento: ao entrar em Agendado com pagamento antecipado; pendente 3 h depois', () => {
  const v = { etapa: visto('Agendado', T0) };
  const r = rodar(conv({ attrs: AGENDADO }), T0, v);
  assert.deepEqual(regras(r), ['prepagamento']);
  assert.match(r.disparos[0]!.texto!, /Data e horário: 17\/11 às 14:30/);
  assert.match(r.disparos[0]!.texto!, /pagamento antecipado é R\$ 250\./);
  assert.deepEqual(regras(rodar(conv({ attrs: AGENDADO }), '2026-11-16T15:00:00Z', v, ['prepagamento|agendado@2026-11-16T12:00:00.000Z'])), ['prepagamento-pendente']);
  assert.deepEqual(regras(rodar(conv({ attrs: AGENDADO }), '2026-11-16T14:59:00Z', v, ['prepagamento|agendado@2026-11-16T12:00:00.000Z'])), []);
});

test('prepagamento: já pagou, sem antecipado, outra situação ou valor desconhecido', () => {
  const v = { etapa: visto('Agendado', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs: AGENDADO, etiquetas: ['pagou-antecipado'] }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...AGENDADO, pagamento_antecipado: false } }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...AGENDADO, situacao_consulta: 'Confirmado' } }), T0, v)), []);
  const sem = rodar(conv({ attrs: AGENDADO }), T0, v, [], { ...U, valorAntecipado: null });
  assert.equal(sem.disparos[0]!.texto, null);
  assert.match(sem.disparos[0]!.faltando[0]!, /valor da consulta com pagamento antecipado/);
});

// ── 6–8: véspera, dia, preparo ─────────────────────────────────────────────────────────────────────

const CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Confirmado', data_consulta: '2026-11-17', hora_consulta: '14:30' };

test('consulta: véspera 24 h, dia 3 h e preparo 1 h antes — no alvo, não antes', () => {
  const c = conv({ attrs: CONSULTA });
  assert.deepEqual(regras(rodar(c, '2026-11-16T17:29:00Z')), []);
  const v = rodar(c, '2026-11-16T17:30:00Z');
  assert.deepEqual(regras(v), ['consulta-vespera']);
  assert.match(v.disparos[0]!.texto!, /A sua consulta é amanhã\.\nData e horário: 17\/11 às 14:30/);
  assert.deepEqual(regras(rodar(c, '2026-11-17T14:29:00Z', {}, ['consulta-vespera|2026-11-17T14:30'])), []);
  assert.deepEqual(regras(rodar(c, '2026-11-17T14:30:00Z', {}, ['consulta-vespera|2026-11-17T14:30'])), ['consulta-dia']);
  assert.deepEqual(regras(rodar(c, '2026-11-17T16:30:00Z', {}, ['consulta-vespera|2026-11-17T14:30', 'consulta-dia|2026-11-17T14:30'])), ['consulta-preparo']);
  assert.match(rodar(c, '2026-11-17T14:30:00Z').disparos.find((d) => d.regra === 'consulta-dia')!.texto!, /^Bom dia, Maria\. A sua consulta de hoje está marcada para 17\/11 às 14:30\./);
});

test('consulta: não repete, e remarcar (chave nova) avisa de novo', () => {
  const feitos = ['consulta-vespera|2026-11-17T14:30'];
  assert.deepEqual(regras(rodar(conv({ attrs: CONSULTA }), '2026-11-16T17:40:00Z', {}, feitos)), []);
  const remarcada = conv({ attrs: { ...CONSULTA, hora_consulta: '16:00' } });
  assert.deepEqual(regras(rodar(remarcada, '2026-11-16T19:00:00Z', {}, feitos)), ['consulta-vespera']);
});

test('consulta: atraso máximo de 2 h; nunca depois da própria consulta', () => {
  const c = conv({ attrs: CONSULTA });
  assert.deepEqual(regras(rodar(c, '2026-11-16T19:30:00Z')), ['consulta-vespera']); // alvo + 2 h
  assert.deepEqual(rodar(c, '2026-11-16T19:31:00Z').perdidas, ['consulta-vespera']);
  assert.deepEqual(regras(rodar(c, '2026-11-16T19:31:00Z')), []);
  // preparo: alvo 13:30 Belém; às 14:31 Belém (já passou da hora da consulta) não vale
  const feitos = ['consulta-vespera|2026-11-17T14:30', 'consulta-dia|2026-11-17T14:30'];
  assert.deepEqual(regras(rodar(c, '2026-11-17T17:29:00Z', {}, feitos)), ['consulta-preparo']);
  assert.deepEqual(regras(rodar(c, '2026-11-17T17:31:00Z', {}, feitos)), []);
});

test('consulta: fora da janela espera; passou do atraso máximo, perde', () => {
  const tarde = conv({ attrs: { ...CONSULTA, hora_consulta: '20:30' } }); // véspera às 20:30 de Belém (fecha às 20:00)
  assert.deepEqual(regras(rodar(tarde, '2026-11-16T23:45:00Z')), []);
  assert.deepEqual(regras(rodar(tarde, '2026-11-17T11:00:00Z')), []); // 08:00 do dia: 11,5 h depois
  // 08:00 de consulta: 3 h antes seria 05:00 (fechado) e já passou de 2 h quando abre
  const cedo = conv({ attrs: { ...CONSULTA, hora_consulta: '08:00' } });
  assert.deepEqual(regras(rodar(cedo, '2026-11-17T11:00:00Z', {}, ['consulta-vespera|2026-11-17T08:00'])), []);
  // domingo fechado: consulta de segunda 14:00, véspera no domingo, não manda na segunda
  const seg = conv({ attrs: { ...CONSULTA, data_consulta: '2026-11-16', hora_consulta: '14:00' } });
  assert.deepEqual(regras(rodar(seg, '2026-11-15T17:00:00Z')), []);
  assert.deepEqual(regras(rodar(seg, '2026-11-16T11:00:00Z')), []);
});

test('consulta sem hora: só a véspera, 09:00 do dia anterior; o texto leva só a data', () => {
  const c = conv({ attrs: { ...CONSULTA, hora_consulta: '' } });
  assert.deepEqual(regras(rodar(c, '2026-11-16T11:59:00Z')), []);
  const r = rodar(c, '2026-11-16T12:00:00Z');
  assert.deepEqual(regras(r), ['consulta-vespera']);
  assert.match(r.disparos[0]!.texto!, /Data e horário: 17\/11\n/);
  assert.deepEqual(regras(rodar(c, '2026-11-17T14:30:00Z', {}, ['consulta-vespera|2026-11-17'])), []); // dia e preparo não existem sem hora
});

test('consulta: etapa e situação que não valem', () => {
  assert.deepEqual(regras(rodar(conv({ attrs: { ...CONSULTA, situacao_consulta: 'Desmarcado' } }), '2026-11-16T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...CONSULTA, situacao_consulta: 'Não compareceu' } }), '2026-11-16T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...CONSULTA, etapa: 'Perdido' } }), '2026-11-16T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...CONSULTA, etapa: 'Fechou', situacao_consulta: '' } }), '2026-11-16T17:30:00Z')), ['consulta-vespera']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...CONSULTA, data_consulta: '' } }), '2026-11-16T17:30:00Z')), []);
});

test('consulta: contato sem nome (só telefone) não recebe', () => {
  const r = rodar(conv({ attrs: CONSULTA, nome: '+55 94 99999-0000' }), '2026-11-16T17:30:00Z');
  assert.equal(r.disparos[0]!.texto, null);
  assert.deepEqual(r.disparos[0]!.faltando, ['nome do contato']);
});

// ── 9–10: falta ────────────────────────────────────────────────────────────────────────────────────

test('falta-mesmo-dia: ao ver «Não compareceu» no dia da consulta', () => {
  const attrs = { etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-17', hora_consulta: '14:30' };
  const v = { situacao_consulta: visto('Não compareceu', '2026-11-17T20:00:00Z') };
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-17T20:00:00Z', v)), ['falta-mesmo-dia']);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-17T20:00:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-17T20:00:00Z', true) })), []);
  // marcada no dia seguinte: o texto diz "de hoje", então não manda
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-18T13:00:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-18T13:00:00Z') })), []);
});

test('falta-48h: 48 h depois da consulta, sem-follow-up segura', () => {
  const attrs = { situacao_consulta: 'Não compareceu', data_consulta: '2026-11-17', hora_consulta: '14:30' };
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T17:29:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T17:30:00Z')), ['falta-48h']);
  assert.deepEqual(regras(rodar(conv({ attrs, etiquetas: ['sem-follow-up'] }), '2026-11-19T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T17:30:00Z', {}, ['falta-48h|2026-11-17T14:30'])), []);
});

// ── 11–14: depois do atendimento ───────────────────────────────────────────────────────────────────

const ATENDIDO = { etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-17', hora_consulta: '14:30' };

test('pós-atendimento 24 h; decisão 4, 7 e 30 dias DEPOIS da consulta', () => {
  const c = conv({ attrs: ATENDIDO });
  assert.deepEqual(regras(rodar(c, '2026-11-18T17:29:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-18T17:30:00Z')), ['pos-atendimento']);
  assert.deepEqual(regras(rodar(c, '2026-11-21T17:30:00Z')), ['decisao-4d']);
  assert.deepEqual(regras(rodar(c, '2026-11-24T17:30:00Z')), ['decisao-7d']);
  assert.deepEqual(regras(rodar(c, '2026-12-17T17:30:00Z')), ['decisao-30d']);
  assert.deepEqual(regras(rodar(c, '2026-11-21T16:30:00Z')), []);
  assert.match(rodar(c, '2026-11-21T17:30:00Z').disparos[0]!.texto!, /Vamos agendar seu retorno\?/);
});

test('decisão: etapa Pós-consulta vale; sem-follow-up segura as decisões mas não o pós-atendimento; outra situação não vale', () => {
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, etapa: 'Pós-consulta' } }), '2026-11-21T17:30:00Z')), ['decisao-4d']);
  assert.deepEqual(regras(rodar(conv({ attrs: ATENDIDO, etiquetas: ['sem-follow-up'] }), '2026-11-21T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: ATENDIDO, etiquetas: ['sem-follow-up'] }), '2026-11-18T17:30:00Z')), ['pos-atendimento']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, situacao_consulta: 'Agendado' } }), '2026-11-18T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, etapa: 'Agendado' } }), '2026-11-18T17:30:00Z')), []);
  // consulta sem hora conta como meio-dia
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, hora_consulta: '' } }), '2026-11-18T15:00:00Z')), ['pos-atendimento']);
});

// ── 15–17: espera e SDR ────────────────────────────────────────────────────────────────────────────

test('espera-retomar: no dia 09:00 pelo motivo; retomada 2 três dias depois às 18:00', () => {
  const attrs = { retomar_em: '2026-11-18', motivo_espera: 'Exames' };
  const c = conv({ attrs });
  assert.deepEqual(regras(rodar(c, '2026-11-18T11:59:00Z')), []);
  const r = rodar(c, '2026-11-18T12:00:00Z');
  assert.deepEqual(regras(r), ['espera-retomar']);
  assert.match(r.disparos[0]!.texto!, /ia fazer o exame/);
  for (const [motivo, trecho] of [
    ['Viajando', /estava viajando/],
    ['Vai decidir', /ia pensar com calma/],
    ['Financeiro agora não', /estava apertado/],
  ] as const) {
    assert.match(rodar(conv({ attrs: { ...attrs, motivo_espera: motivo } }), '2026-11-18T12:00:00Z').disparos[0]!.texto!, trecho);
  }
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, motivo_espera: 'Outro' } }), '2026-11-18T12:00:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { retomar_em: '2026-11-18' } }), '2026-11-18T12:00:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-18T12:00:00Z', {}, ['espera-retomar|retomar@2026-11-18'])), []);
  assert.deepEqual(regras(rodar(c, '2026-11-21T20:59:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-21T21:00:00Z')), ['espera-retomada2']); // sábado 18:00
  assert.deepEqual(regras(rodar(conv({ attrs, etiquetas: ['sem-follow-up'] }), '2026-11-18T12:00:00Z')), []);
});

test('espera-retomada2: quem respondeu depois da 1ª retomada não recebe a 2ª', () => {
  const respondeu: MensagemResumo = { saida: false, privada: false, autorId: 5, autorTipo: 'contact', criadaEm: Z('2026-11-19T14:00:00Z') };
  const attrs = { retomar_em: '2026-11-18', motivo_espera: 'Exames' };
  assert.deepEqual(regras(rodar(conv({ attrs, ultima: respondeu }), '2026-11-21T21:00:00Z')), []);
  const antes: MensagemResumo = { ...respondeu, criadaEm: Z('2026-11-10T14:00:00Z') };
  assert.deepEqual(regras(rodar(conv({ attrs, ultima: antes }), '2026-11-21T21:00:00Z')), ['espera-retomada2']);
});

test('SDR por etiqueta: ao ver a etiqueta nova; o nome de quem atende vem do assignee', () => {
  const v = { 'etiqueta:retomada': visto('sim', T0) };
  const r = rodar(conv({ etiquetas: ['retomada'], atendente: 'Ana' }), T0, v);
  assert.deepEqual(regras(r), ['sdr-retomada']);
  assert.match(r.disparos[0]!.texto!, /^Oi, Maria! Aqui é Ana, da Doutor Hérnia\./);
  const sem = rodar(conv({ etiquetas: ['retomada'], atendente: null }), T0, v);
  assert.equal(sem.disparos[0]!.texto, null);
  assert.deepEqual(sem.disparos[0]!.faltando, ['atendente atribuído à conversa']);
  assert.deepEqual(regras(rodar(conv({ etiquetas: ['retomada'] }), T0, { 'etiqueta:retomada': visto('sim', T0, true) })), []);
  assert.deepEqual(regras(rodar(conv({ etiquetas: ['retomada', 'sem-follow-up'] }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ etiquetas: [] }), T0, v)), []);
  // reativação também é «follow-up»
  assert.deepEqual(regras(rodar(conv({ etiquetas: ['reativacao', 'sem-follow-up'] }), T0, { 'etiqueta:reativacao': visto('sim', T0) })), []);
});

test('SDR: confirmar-retorno usa a próxima sessão (ou a consulta); boas-vindas pede o programa', () => {
  const v = { 'etiqueta:confirmar-retorno': visto('sim', T0) };
  const a = rodar(conv({ etiquetas: ['confirmar-retorno'], attrs: { proxima_sessao: '2026-11-20', hora_sessao: '10:00' } }), T0, v);
  assert.match(a.disparos[0]!.texto!, /retorno está agendado para 20\/11 às 10:00, na unidade Parauapebas/);
  const b = rodar(conv({ etiquetas: ['confirmar-retorno'], attrs: { data_consulta: '2026-11-19', hora_consulta: '09:00' } }), T0, v);
  assert.match(b.disparos[0]!.texto!, /agendado para 19\/11 às 09:00/);
  const c = rodar(conv({ etiquetas: ['boas-vindas'], attrs: { proxima_sessao: '2026-11-20' } }), T0, { 'etiqueta:boas-vindas': visto('sim', T0) });
  assert.equal(c.disparos[0]!.texto, null);
  assert.match(c.disparos[0]!.faltando.join(), /programa/);
  const d = rodar(conv({ etiquetas: ['boas-vindas'], attrs: { proxima_sessao: '2026-11-20', programa: 'Coluna Forte' } }), T0, { 'etiqueta:boas-vindas': visto('sim', T0) });
  assert.match(d.disparos[0]!.texto!, /programa Coluna Forte está confirmada/);
});

// ── tratamento ─────────────────────────────────────────────────────────────────────────────────────

const TRAT = { funil: 'Tratamento', fechou_tratamento: true };

test('tratamento: regra de tratamento não vale para quem está no comercial, e a comercial não vale para quem trata', () => {
  const alta = { data_alta: '2026-11-10' };
  assert.deepEqual(regras(rodar(conv({ attrs: alta }), '2026-11-11T13:00:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, ...TRAT } }), '2026-11-18T17:30:00Z')), []);
});

test('tratamento-boas-vindas: quando fechou_tratamento passa a true', () => {
  const v = { fechou_tratamento: visto('sim', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs: TRAT }), T0, v)), ['tratamento-boas-vindas']);
  assert.deepEqual(regras(rodar(conv({ attrs: TRAT }), T0, { fechou_tratamento: visto('sim', T0, true) })), []);
  assert.deepEqual(regras(rodar(conv({ attrs: TRAT }), T0, v, ['tratamento-boas-vindas|fechou@2026-11-16T12:00:00.000Z'])), []);
  assert.match(rodar(conv({ attrs: TRAT }), T0, v).disparos[0]!.texto!, /^Olá, Maria\. Seja bem-vindo\(a\) ao seu tratamento/);
});

test('primeira-sessao: categoria Sessão, nenhuma realizada, uma vez por proxima_sessao', () => {
  const attrs = { ...TRAT, categoria_consulta: 'Sessão', proxima_sessao: '2026-11-20', hora_sessao: '10:00' };
  const v = { proxima_sessao: visto('2026-11-20T10:00', T0) };
  const r = rodar(conv({ attrs }), T0, v);
  assert.ok(regras(r).includes('primeira-sessao'));
  assert.match(r.disparos.find((d) => d.regra === 'primeira-sessao')!.texto!, /Data e horário: 20\/11 às 10:00\nUnidade: Doutor Hérnia Parauapebas\nChegue 10 minutos antes/);
  assert.ok(!regras(rodar(conv({ attrs: { ...attrs, sessoes_realizadas: 2 } }), T0, v)).includes('primeira-sessao'));
  assert.ok(!regras(rodar(conv({ attrs: { ...attrs, categoria_consulta: 'Avaliação' } }), T0, v)).includes('primeira-sessao'));
  assert.ok(!regras(rodar(conv({ attrs }), T0, v, ['primeira-sessao|primeira@2026-11-20T10:00'])).includes('primeira-sessao'));
  // remarcou a sessão: outra chave
  const remarcada = { ...attrs, proxima_sessao: '2026-11-21' };
  assert.ok(regras(rodar(conv({ attrs: remarcada }), T0, { proxima_sessao: visto('2026-11-21T10:00', T0) }, ['primeira-sessao|primeira@2026-11-20T10:00'])).includes('primeira-sessao'));
  assert.ok(!regras(rodar(conv({ attrs }), T0, { proxima_sessao: visto('2026-11-20T10:00', T0, true) })).includes('primeira-sessao'));
});

test('sessão: véspera 24 h, dia 3 h antes; dia precisa de hora', () => {
  const attrs = { ...TRAT, proxima_sessao: '2026-11-20', hora_sessao: '10:00' };
  const c = conv({ attrs });
  assert.deepEqual(regras(rodar(c, '2026-11-19T12:59:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-19T13:00:00Z')), ['sessao-vespera']);
  assert.match(rodar(c, '2026-11-19T13:00:00Z').disparos[0]!.texto!, /A sua sessão é amanhã\.\nData e horário: 20\/11 às 10:00/);
  assert.deepEqual(regras(rodar(c, '2026-11-20T10:00:00Z', {}, ['sessao-vespera|2026-11-20T10:00'])), []); // 07:00 de Belém: fechado
  assert.deepEqual(regras(rodar(c, '2026-11-20T11:00:00Z', {}, ['sessao-vespera|2026-11-20T10:00'])), ['sessao-dia']);
  const semHora = conv({ attrs: { ...TRAT, proxima_sessao: '2026-11-20' } });
  assert.deepEqual(regras(rodar(semHora, '2026-11-19T12:00:00Z')), ['sessao-vespera']);
  assert.deepEqual(regras(rodar(semHora, '2026-11-20T11:00:00Z', {}, ['sessao-vespera|2026-11-20'])), []);
});

test('aderência no meio: uma vez, quando passa de metade (previstas ≥ 2)', () => {
  const attrs = { ...TRAT, sessoes_previstas: 10, sessoes_realizadas: 5 };
  const v = { aderencia_meio: visto('sim', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, v)), ['sessao-aderencia-meio']);
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, v, ['sessao-aderencia-meio|meio'])), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, sessoes_realizadas: 4 } }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, sessoes_previstas: 1, sessoes_realizadas: 1 } }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, { aderencia_meio: visto('sim', T0, true) })), []);
});

test('alta: conclusão ao ver; NPS no dia seguinte 10:00; retorno 60 dias 09:00', () => {
  const attrs = { ...TRAT, data_alta: '2026-11-16' };
  const v = { data_alta: visto('2026-11-16', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, v)), ['alta-conclusao']);
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, { data_alta: visto('2026-11-16', T0, true) })), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-17T12:59:00Z', {}, ['alta-conclusao|alta@2026-11-16'])), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-17T13:00:00Z', {}, ['alta-conclusao|alta@2026-11-16'])), ['alta-nps']);
  // 60 dias depois de 16/11 = 15/01/2027 (sexta), 09:00 Belém
  assert.deepEqual(regras(rodar(conv({ attrs }), '2027-01-15T11:59:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2027-01-15T12:00:00Z')), ['alta-retorno-60d']);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2027-01-15T12:00:00Z', {}, ['alta-retorno-60d|alta@2026-11-16'])), []);
});

test('vencimento: 3 dias antes e no dia, 09:00; precisa do valor e da chave Pix', () => {
  const attrs = { ...TRAT, vencimento: '2026-11-20', valor_parcela: 450 };
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-17T11:59:00Z')), []);
  const t3 = rodar(conv({ attrs }), '2026-11-17T12:00:00Z');
  assert.deepEqual(regras(t3), ['vencimento-3d']);
  assert.match(t3.disparos[0]!.texto!, /vence em 20\/11\.\nValor: R\$ 450\nPagamento: pix@parau\.com/);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-20T12:00:00Z')), ['vencimento-hoje']);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-20T12:00:00Z', {}, ['vencimento-hoje|venc@2026-11-20'])), []);
  const semValor = rodar(conv({ attrs: { ...attrs, valor_parcela: null } }), '2026-11-17T12:00:00Z');
  assert.equal(semValor.disparos[0]!.texto, null);
  assert.deepEqual(semValor.disparos[0]!.faltando, ['valor da parcela (valor_parcela)']);
  const semPix = rodar(conv({ attrs }), '2026-11-17T12:00:00Z', {}, [], { ...U, pixKey: null });
  assert.match(semPix.disparos[0]!.faltando[0]!, /chave Pix/);
});

test('campo faltando: depois da nota do seco (regra!falta) não repete, e a mensagem de verdade continua possível', () => {
  const attrs = { ...TRAT, vencimento: '2026-11-20' };
  const feitos = [`vencimento-3d${SUFIXO_FALTA}|venc@2026-11-20`];
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-17T12:00:00Z', {}, feitos)), []);
  // preencheu o valor depois: a nota de "falta" não atrapalha
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, valor_parcela: 300 } }), '2026-11-17T13:00:00Z', {}, feitos)), ['vencimento-3d']);
});

// ── nota do seco ───────────────────────────────────────────────────────────────────────────────────

test('nota do seco: texto renderizado ou o que falta', () => {
  const ok = rodar(conv({ attrs: CONSULTA }), '2026-11-16T17:30:00Z').disparos[0]!;
  assert.ok(notaDoSeco(ok).startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora:\n\nOlá, Maria. A sua consulta é amanhã.'));
  const falta = rodar(conv({ attrs: CONSULTA, nome: '+5594' }), '2026-11-16T17:30:00Z').disparos[0]!;
  assert.equal(notaDoSeco(falta), '🧪 [SECO] Régua «consulta-vespera» — NÃO enviaria agora, falta: nome do contato.');
});

test('renderizar: modelo desconhecido não vira texto', () => {
  assert.equal(renderizar('parau_nao_existe', conv(), U).texto, null);
});

// ── memória (visto) ────────────────────────────────────────────────────────────────────────────────

test('atualizarVistos: na partida tudo é inicial; depois, só o que muda é novo', () => {
  const agora = Z('2026-11-16T12:00:00Z');
  const c = conv({ attrs: { etapa: 'Perdido', fechou_tratamento: true }, etiquetas: ['retomada', 'quente'] });
  const p1 = atualizarVistos(c, new Map(), agora, { primeiraVez: true, desde: null });
  assert.equal(p1.vistos.get('etapa')!.inicial, true);
  assert.equal(p1.vistos.get('etiqueta:retomada')!.inicial, true);
  assert.ok(p1.vistos.has('_visto'));
  assert.equal(p1.vistos.has('etiqueta:quente'), false);

  const depois = Z('2026-11-16T12:10:00Z');
  const c2 = conv({ attrs: { etapa: 'Agendado' }, etiquetas: ['retomada'] });
  const p2 = atualizarVistos(c2, p1.vistos, depois, { primeiraVez: false, desde: agora });
  assert.equal(p2.vistos.get('etapa')!.valor, 'Agendado');
  assert.equal(p2.vistos.get('etapa')!.inicial, false);
  assert.deepEqual(p2.vistos.get('etapa')!.desde, depois);
  assert.equal(p2.vistos.has('fechou_tratamento'), false); // saiu
  assert.equal(p2.vistos.get('etiqueta:retomada')!.inicial, true); // não mudou
  assert.deepEqual(p2.mudancas.map((m) => `${m.tipo}:${m.campo}`).sort(), ['atualizar:etapa', 'remover:fechou_tratamento']);
  // sem mudança nenhuma = nada a gravar
  assert.deepEqual(atualizarVistos(c2, p2.vistos, depois, { primeiraVez: false, desde: agora }).mudancas, []);
});

test('atualizarVistos: conversa nunca vista — nascida depois da partida é nova; mais velha é inicial', () => {
  const partida = Z('2026-11-16T12:00:00Z');
  const velha = { ...conv({ attrs: { etapa: 'Perdido' } }), criadaEm: Z('2026-10-01T00:00:00Z') };
  const nova = { ...conv({ attrs: { etapa: 'Perdido' } }), criadaEm: Z('2026-11-16T12:05:00Z') };
  const agora = Z('2026-11-16T12:10:00Z');
  assert.equal(atualizarVistos(velha, new Map(), agora, { primeiraVez: false, desde: partida }).vistos.get('etapa')!.inicial, true);
  assert.equal(atualizarVistos(nova, new Map(), agora, { primeiraVez: false, desde: partida }).vistos.get('etapa')!.inicial, false);
  // conversa conhecida, mas sem etapa: quando ganha uma, é novo (mesmo sendo velha)
  const conhecida = new Map<string, Visto>([['_visto', { valor: '1', desde: partida, inicial: true }]]);
  assert.equal(atualizarVistos(velha, conhecida, agora, { primeiraVez: false, desde: partida }).vistos.get('etapa')!.inicial, false);
});

test('integração: o ciclo de uma conversa que entra em Perdido depois da partida dispara 48 h depois', () => {
  const partida = Z('2026-11-16T12:00:00Z');
  const base = { ...conv({ attrs: {} }), criadaEm: Z('2026-10-01T00:00:00Z') };
  const k0 = atualizarVistos(base, new Map(), partida, { primeiraVez: true, desde: null });
  const perdeu = { ...base, attrs: { etapa: 'Perdido' } };
  const k1 = atualizarVistos(perdeu, k0.vistos, Z('2026-11-16T12:10:00Z'), { primeiraVez: false, desde: partida });
  assert.deepEqual(regras(decidirRegua(perdeu, { vistos: k1.vistos, feitos: new Set() }, Z('2026-11-18T12:10:00Z'), U)), ['followup-48h']);
});

// ── sinal interno ──────────────────────────────────────────────────────────────────────────────────

const msg = (o: Partial<MensagemResumo>): MensagemResumo => ({ saida: true, privada: false, autorId: 7, autorTipo: 'user', criadaEm: Z('2026-11-16T12:00:00Z'), ...o });

test('respondeu-pelo-celular: põe quando a última saída é do usuário 7, tira quando é de outro agente', () => {
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({}) })), 'por');
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({}), etiquetas: ['respondeu-pelo-celular'] })), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ autorId: 2 }), etiquetas: ['respondeu-pelo-celular'] })), 'tirar');
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ autorId: 2 }) })), null);
  // paciente escreveu por último, nota privada (as do seco) ou bot: não muda nada
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ saida: false, autorId: 3, autorTipo: 'contact' }), etiquetas: ['respondeu-pelo-celular'] })), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ privada: true, autorId: 2 }), etiquetas: ['respondeu-pelo-celular'] })), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ autorTipo: 'agent_bot' }) })), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: null })), null);
});

// ── a conversa do Chatwoot ─────────────────────────────────────────────────────────────────────────

test('conversaDoChatwoot: lê a listagem; ignora grupo e o bot do Evolution', () => {
  const raw = {
    id: 55,
    created_at: 1_790_000_000,
    labels: ['quente'],
    custom_attributes: { etapa: 'Agendado' },
    meta: { sender: { name: 'Maria', phone_number: '+5594999990000', identifier: '5594999990000@s.whatsapp.net' }, assignee: { name: 'Ana' } },
    last_non_activity_message: { message_type: 1, private: false, created_at: 1_790_000_100, sender: { id: 7, type: 'user' } },
  };
  const c = conversaDoChatwoot(raw)!;
  assert.equal(c.id, 55);
  assert.equal(c.atendente, 'Ana');
  assert.deepEqual(c.etiquetas, ['quente']);
  assert.equal(c.ultima!.autorId, 7);
  assert.equal(c.ultima!.saida, true);
  assert.equal(c.ultima!.criadaEm.getTime(), 1_790_000_100_000);
  assert.equal(conversaDoChatwoot({ ...raw, meta: { sender: { identifier: '120363@g.us' } } }), null);
  assert.equal(conversaDoChatwoot({ ...raw, additional_attributes: { type: 'group' } }), null);
  assert.equal(conversaDoChatwoot({ ...raw, meta: { sender: { name: 'Bot', phone_number: '+123456' } } }), null);
  assert.equal(conversaDoChatwoot({ nada: 1 }), null);
  assert.equal(conversaDoChatwoot({ ...raw, last_non_activity_message: { message_type: 2 } })!.ultima, null);
  assert.equal(conversaDoChatwoot({ ...raw, last_non_activity_message: null })!.ultima, null);
});
