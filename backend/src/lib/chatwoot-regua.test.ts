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
  camposDoModelo,
  janelaDe24hAberta,
  paraParametro,
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

test('falta-48h: 48 h depois da consulta, só nas etapas da consulta; sem-follow-up segura', () => {
  const attrs = { etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-17', hora_consulta: '14:30' };
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T17:29:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T17:30:00Z')), ['falta-48h']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, etapa: 'Fechou' } }), '2026-11-19T17:30:00Z')), ['falta-48h']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, etapa: 'Perdido' } }), '2026-11-19T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs, etiquetas: ['sem-follow-up'] }), '2026-11-19T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T17:30:00Z', {}, ['falta-48h|2026-11-17T14:30'])), []);
});

test('véspera em «Fechou» usa o texto de véspera da SESSÃO (igual ao Kommo em GANHO)', () => {
  const r = rodar(conv({ attrs: { ...CONSULTA, etapa: 'Fechou' } }), '2026-11-16T17:30:00Z');
  assert.deepEqual(regras(r), ['consulta-vespera']);
  assert.equal(r.disparos[0]!.modelo, 'parau_sessao_lembrete_vespera');
  assert.match(r.disparos[0]!.texto!, /A sua sessão é amanhã/);
});

// ── depois do atendimento ──────────────────────────────────────────────────────────────────────────

const ATENDIDO = { etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-17', hora_consulta: '14:30' };

test('pós-atendimento 24 h (só Compareceu); decisão 4 e 7 dias (Compareceu/Pós-consulta); 30 dias (Pós-consulta/Perdido)', () => {
  const c = conv({ attrs: ATENDIDO });
  assert.deepEqual(regras(rodar(c, '2026-11-18T17:29:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-18T17:30:00Z')), ['pos-atendimento']);
  assert.deepEqual(regras(rodar(c, '2026-11-21T17:30:00Z')), ['decisao-4d']);
  assert.deepEqual(regras(rodar(c, '2026-11-24T17:30:00Z')), ['decisao-7d']);
  assert.deepEqual(regras(rodar(c, '2026-12-17T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, etapa: 'Pós-consulta' } }), '2026-12-17T17:30:00Z')), ['decisao-30d']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, etapa: 'Perdido' } }), '2026-12-17T17:30:00Z')), ['decisao-30d']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, etapa: 'Pós-consulta' } }), '2026-11-18T17:30:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-21T16:30:00Z')), []);
  assert.match(rodar(c, '2026-11-21T17:30:00Z').disparos[0]!.texto!, /Vamos agendar seu retorno\?/);
});

test('espera-retomar: no dia 09:00 pelo motivo; retomada 2 com 81 h (D+3 09:00)', () => {
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
  assert.deepEqual(regras(rodar(c, '2026-11-18T12:00:00Z', {}, ['espera-retomar|retomar@2026-11-18'])), []);
  assert.deepEqual(regras(rodar(c, '2026-11-21T11:59:00Z')), []);
  assert.deepEqual(regras(rodar(c, '2026-11-21T12:00:00Z')), ['espera-retomada2']); // sábado 09:00
  assert.deepEqual(regras(rodar(conv({ attrs, etiquetas: ['sem-follow-up'] }), '2026-11-18T12:00:00Z')), []);
});

const QUALIFICA = { etapa: 'Sofia qualifica' };

test('SDR por etiqueta: ao ver a etiqueta nova, só nas etapas do gatilho; o nome de quem atende vem do assignee', () => {
  const v = { 'etiqueta:retomada': visto('sim', T0) };
  const r = rodar(conv({ attrs: QUALIFICA, etiquetas: ['retomada'], atendente: 'Ana' }), T0, v);
  assert.deepEqual(regras(r), ['sdr-retomada']);
  assert.match(r.disparos[0]!.texto!, /^Oi, Maria! Aqui é Ana, da Doutor Hérnia\./);
  const sem = rodar(conv({ attrs: QUALIFICA, etiquetas: ['retomada'], atendente: null }), T0, v);
  assert.equal(sem.disparos[0]!.texto, null);
  assert.deepEqual(sem.disparos[0]!.faltando, ['atendente atribuído à conversa']);
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, etiquetas: ['retomada'] }), T0, { 'etiqueta:retomada': visto('sim', T0, true) })), []);
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, etiquetas: ['retomada', 'sem-follow-up'] }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, etiquetas: [] }), T0, v)), []);
  // fora das etapas do gatilho
  assert.deepEqual(regras(rodar(conv({ attrs: { etapa: 'Compareceu' }, etiquetas: ['retomada'] }), T0, v)), []);
  // «Não compareceu» vale para retomada e reativação
  assert.deepEqual(regras(rodar(conv({ attrs: { etapa: 'Agendado', situacao_consulta: 'Não compareceu' }, etiquetas: ['reativacao'] }), T0, { 'etiqueta:reativacao': visto('sim', T0) })), ['sdr-reativacao']);
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, etiquetas: ['reativacao', 'sem-follow-up'] }), T0, { 'etiqueta:reativacao': visto('sim', T0) })), []);
});

test('SDR: confirmar-retorno (retorno pós-tratamento ou funil Tratamento) e boas-vindas (Compareceu/Pós-consulta/Fechou ou Tratamento)', () => {
  const v = { 'etiqueta:confirmar-retorno': visto('sim', T0) };
  const RET = { categoria_consulta: 'Retorno após tratamento' };
  const a = rodar(conv({ etiquetas: ['confirmar-retorno'], attrs: { ...RET, proxima_sessao: '2026-11-20', hora_sessao: '10:00' } }), T0, v);
  assert.match(a.disparos[0]!.texto!, /retorno está agendado para 20\/11 às 10:00, na unidade Parauapebas/);
  const b = rodar(conv({ etiquetas: ['confirmar-retorno'], attrs: { ...RET, data_consulta: '2026-11-19', hora_consulta: '09:00' } }), T0, v);
  assert.match(b.disparos[0]!.texto!, /agendado para 19\/11 às 09:00/);
  assert.deepEqual(regras(rodar(conv({ etiquetas: ['confirmar-retorno'], attrs: QUALIFICA }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ etiquetas: ['confirmar-retorno'], attrs: { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-20' } }), T0, v)), ['sdr-confirmar-retorno']);
  const vb = { 'etiqueta:boas-vindas': visto('sim', T0) };
  const c = rodar(conv({ etiquetas: ['boas-vindas'], attrs: { etapa: 'Compareceu', proxima_sessao: '2026-11-20' } }), T0, vb);
  assert.equal(c.disparos[0]!.texto, null);
  assert.match(c.disparos[0]!.faltando.join(), /programa/);
  const d = rodar(conv({ etiquetas: ['boas-vindas'], attrs: { etapa: 'Fechou', proxima_sessao: '2026-11-20', programa: 'Coluna Forte' } }), T0, vb);
  assert.match(d.disparos.find((x) => x.regra === 'sdr-boas-vindas')!.texto!, /programa Coluna Forte está confirmada/);
  assert.deepEqual(regras(rodar(conv({ etiquetas: ['boas-vindas'], attrs: QUALIFICA }), T0, vb)), []);
});

// ── tratamento (atributo etapa_tratamento) ─────────────────────────────────────────────────────────

const TRAT = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento' };

test('tratamento: a régua comercial não vale para quem trata; retorno 60 dias vale pela categoria', () => {
  assert.deepEqual(regras(rodar(conv({ attrs: { ...ATENDIDO, ...TRAT } }), '2026-11-18T17:30:00Z')), []);
  const alta = { categoria_consulta: 'Retorno após tratamento', data_alta: '2026-11-16' };
  // 60 dias depois de 16/11 = 15/01/2027 (sexta), 09:00 Belém
  assert.deepEqual(regras(rodar(conv({ attrs: alta }), '2027-01-15T11:59:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: alta }), '2027-01-15T12:00:00Z')), ['alta-retorno-60d']);
  assert.deepEqual(regras(rodar(conv({ attrs: alta }), '2027-01-15T12:00:00Z', {}, ['alta-retorno-60d|alta@2026-11-16'])), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { data_alta: '2026-11-16' } }), '2027-01-15T12:00:00Z')), []);
});

test('sessão: 3 h antes da próxima sessão, só «Em tratamento» e com hora', () => {
  const attrs = { ...TRAT, proxima_sessao: '2026-11-20', hora_sessao: '14:00' };
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-20T13:59:00Z')), []);
  const r = rodar(conv({ attrs }), '2026-11-20T14:00:00Z');
  assert.deepEqual(regras(r), ['sessao-dia']);
  assert.match(r.disparos[0]!.texto!, /20\/11 às 14:00/);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, hora_sessao: '' } }), '2026-11-20T14:00:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, etapa_tratamento: 'Alta' } }), '2026-11-20T14:00:00Z')), []);
});

test('aderência no meio (chegou a etiqueta) e falta na sessão (passou a Não): uma vez', () => {
  const vm = { 'etiqueta:aderencia-meio': visto('sim', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs: TRAT, etiquetas: ['aderencia-meio'] }), T0, vm)), ['sessao-aderencia-meio']);
  assert.deepEqual(regras(rodar(conv({ attrs: TRAT, etiquetas: ['aderencia-meio'] }), T0, vm, ['sessao-aderencia-meio|meio@2026-11-16T12:00:00.000Z'])), []);
  assert.deepEqual(regras(rodar(conv({ attrs: TRAT, etiquetas: ['aderencia-meio'] }), T0, { 'etiqueta:aderencia-meio': visto('sim', T0, true) })), []);
  const falta = { ...TRAT, compareceu_ultima_sessao: 'Não' };
  const r = rodar(conv({ attrs: falta }), T0, { compareceu_ultima_sessao: visto('Não', T0) });
  assert.deepEqual(regras(r), ['sessao-falta']);
  assert.match(r.disparos[0]!.texto!, /^Olá, Maria\./);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...TRAT, compareceu_ultima_sessao: 'Sim' } }), T0, { compareceu_ultima_sessao: visto('Sim', T0) })), []);
});

test('pendência de documento: exame pedido e avisado, 120 h depois da consulta', () => {
  const attrs = { ...TRAT, motivo_nao_fechamento: 'Solicitado exames', data_consulta: '2026-11-11', hora_consulta: '14:30' };
  // 11/11 14:30 Belém + 120 h = 16/11 17:30 UTC (segunda)
  assert.deepEqual(regras(rodar(conv({ attrs, etiquetas: ['pendencia-exame-avisado'] }), '2026-11-16T17:29:00Z')), []);
  assert.deepEqual(regras(rodar(conv({ attrs, etiquetas: ['pendencia-exame-avisado'] }), '2026-11-16T17:30:00Z')), ['pendencia-documento']);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-16T17:30:00Z')), []);
});

test('alta: conclusão ao entrar em Alta; NPS 48 h depois, só sem avaliação no Google', () => {
  const attrs = { funil: 'Tratamento', etapa_tratamento: 'Alta' };
  const v = { etapa_tratamento: visto('Alta', T0) };
  const chave = 'alta@2026-11-16T12:00:00.000Z';
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, v)), ['alta-conclusao']);
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, { etapa_tratamento: visto('Alta', T0, true) })), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-18T11:59:00Z', v, [`alta-conclusao|${chave}`])), []);
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-18T12:00:00Z', v, [`alta-conclusao|${chave}`])), ['alta-nps']);
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, deixou_avaliacao_google: true } }), '2026-11-18T12:00:00Z', v, [`alta-conclusao|${chave}`])), []);
});

test('cancelamento: acolhimento ao entrar; retorno marcado → véspera 09:00 com a data', () => {
  const attrs = { funil: 'Tratamento', etapa_tratamento: 'Tratamento cancelado' };
  const v = { etapa_tratamento: visto('Tratamento cancelado', T0) };
  assert.deepEqual(regras(rodar(conv({ attrs }), T0, v)), ['cancelamento-acolhimento']);
  const comRetorno = { ...attrs, data_retorno: '2026-11-20' };
  const feito = ['cancelamento-acolhimento|cancelou@2026-11-16T12:00:00.000Z'];
  assert.deepEqual(regras(rodar(conv({ attrs: comRetorno }), '2026-11-19T11:59:00Z', v, feito)), []);
  const r = rodar(conv({ attrs: comRetorno }), '2026-11-19T12:00:00Z', v, feito);
  assert.deepEqual(regras(r), ['cancelamento-retorno']);
  assert.match(r.disparos[0]!.texto!, /20\/11/);
});

test('campo faltando: depois da nota do seco (regra!falta) não repete, e a mensagem de verdade continua possível', () => {
  const v = { 'etiqueta:retomada': visto('sim', T0) };
  const feitos = [`sdr-retomada${SUFIXO_FALTA}|retomada@2026-11-16T12:00:00.000Z`];
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, etiquetas: ['retomada'], atendente: null }), T0, v, feitos)), []);
  // atribuíram a conversa depois: a nota de "falta" não atrapalha
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, etiquetas: ['retomada'], atendente: 'Ana' }), T0, v, feitos)), ['sdr-retomada']);
});

// ── internas ───────────────────────────────────────────────────────────────────────────────────────

test('internas: quente parado 3 h; sem resposta 24 h (última é nossa); nota privada não conta como conversa', () => {
  const doPaciente: MensagemResumo = { saida: false, privada: false, autorId: 9, autorTipo: 'contact', criadaEm: Z(T0) };
  const quente = conv({ attrs: { etapa: 'Esperando humano', qualificacao: 'Quente' }, ultima: doPaciente });
  assert.deepEqual(regras(rodar(quente, '2026-11-16T14:59:00Z')), []);
  const q = rodar(quente, '2026-11-16T15:00:00Z');
  assert.deepEqual(regras(q), ['lead-quente-parado']);
  assert.equal(q.disparos[0]!.interna, 'quente-parado');
  assert.match(q.disparos[0]!.texto!, /Lead QUENTE parado há 3 h/);
  assert.deepEqual(regras(rodar(conv({ attrs: { etapa: 'Agendado', qualificacao: 'Quente' }, ultima: doPaciente }), '2026-11-16T15:00:00Z')), []);

  const nossa: MensagemResumo = { saida: true, privada: false, autorId: 2, autorTipo: 'user', criadaEm: Z(T0) };
  const calado = conv({ attrs: QUALIFICA, ultima: nossa });
  assert.deepEqual(regras(rodar(calado, '2026-11-17T11:59:00Z')), []);
  const s = rodar(calado, '2026-11-17T12:00:00Z');
  assert.deepEqual(regras(s), ['sem-resposta-24h']);
  assert.ok(notaDoSeco(s.disparos[0]!).startsWith('🧪 [SECO] Régua «sem-resposta-24h» — faria agora: Paciente sem responder há 24 h'));
  // paciente falou por último: não é "sem resposta"
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, ultima: doPaciente }), '2026-11-17T12:00:00Z')), []);
  // última é nota: não sabe quem falou por último → não dispara sem resposta
  assert.deepEqual(regras(rodar(conv({ attrs: QUALIFICA, ultima: { ...nossa, privada: true } }), '2026-11-17T12:00:00Z')), []);
});

test('interna: entrou em «Fechou» sem «Fechou tratamento» → pendência', () => {
  const v = { etapa: visto('Fechou', T0) };
  const r = rodar(conv({ attrs: { etapa: 'Fechou' } }), T0, v);
  assert.deepEqual(regras(r), ['pendencia-fechou']);
  assert.equal(r.disparos[0]!.interna, 'pendencia-fechou');
  assert.deepEqual(regras(rodar(conv({ attrs: { etapa: 'Fechou', fechou_tratamento: true } }), T0, v)), []);
  assert.deepEqual(regras(rodar(conv({ attrs: { etapa: 'Fechou' } }), T0, { etapa: visto('Fechou', T0, true) })), []);
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
  const c = conv({ attrs: { etapa: 'Perdido', compareceu_ultima_sessao: 'Não' }, etiquetas: ['retomada', 'quente'] });
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
  assert.equal(p2.vistos.has('compareceu_ultima_sessao'), false); // saiu
  assert.equal(p2.vistos.get('etiqueta:retomada')!.inicial, true); // não mudou
  assert.deepEqual(p2.mudancas.map((m) => `${m.tipo}:${m.campo}`).sort(), ['atualizar:etapa', 'remover:compareceu_ultima_sessao']);
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

// ── caixa de WhatsApp Cloud: janela de 24 h e variáveis do template ─────────────────────────────────

test('camposDoModelo: cada campo distinto, na ordem em que aparece (a ordem de {{1}}, {{2}}… do template)', () => {
  assert.deepEqual(camposDoModelo('parau_lead_reengajamento_48h'), ['contact.name']);
  assert.deepEqual(camposDoModelo('parau_consulta_prepagamento'), ['contact.name', 'lead.cf.2450736', 'lead.cf.2451104']);
  assert.deepEqual(camposDoModelo('parau_sdr_boas_vindas_programa'), ['contact.name', 'lead.cf.2450750', 'lead.cf.2450928']);
  assert.deepEqual(camposDoModelo('parau_sdr_reativacao_lead_frio'), ['contact.name', 'lead.cf.2450732']);
  assert.deepEqual(camposDoModelo('nao_existe'), []);
  // todo campo de todo modelo tem valor na régua (nenhum cai no «sem correspondente»)
  for (const nome of Object.keys(TEXTOS_PARAU)) {
    const r = renderizar(nome, conv({ attrs: { programa: 'Coluna Forte' } }), U);
    assert.ok(!r.faltando.some((f) => f.includes('sem correspondente')), nome);
  }
});

test('renderizar: as variáveis saem na ordem do template e com os mesmos valores do texto', () => {
  const r = renderizar('parau_consulta_prepagamento', conv({ attrs: { data_consulta: '2026-11-17', hora_consulta: '14:30' } }), U);
  assert.deepEqual(r.variaveis, ['Maria', '17/11 às 14:30', 'R$ 250']);
  assert.ok(r.texto!.includes('Data e horário: 17/11 às 14:30') && r.texto!.includes('é R$ 250.'));
  // falta campo: nem texto nem variáveis
  const sem = renderizar('parau_consulta_prepagamento', conv({ attrs: {} }), U);
  assert.equal(sem.texto, null);
  assert.equal(sem.variaveis, null);
  assert.deepEqual(sem.faltando, ['data da consulta (data_consulta)']);
  // modelo só com o nome
  assert.deepEqual(renderizar('parau_consulta_pos_atendimento', conv(), U).variaveis, ['Maria']);
});

test('paraParametro: uma linha, sem aspas nem < > (o Chatwoot os apagaria), no máximo 1000 caracteres', () => {
  assert.equal(paraParametro("D'Ávila\nSilva"), 'D’Ávila Silva');
  assert.equal(paraParametro('a   b\t"c" <d>'), 'a b ”c” d');
  assert.equal(paraParametro('x'.repeat(2000)).length, 1000);
  assert.equal(paraParametro('<>'), '');
});

test('janelaDe24hAberta: conta da última mensagem do paciente, com 15 min de folga; nunca escreveu = fechada', () => {
  const agora = Z('2026-11-16T12:00:00Z');
  assert.equal(janelaDe24hAberta(Z('2026-11-16T10:00:00Z'), agora), true);
  assert.equal(janelaDe24hAberta(Z('2026-11-15T12:30:00Z'), agora), true); // 23 h 30
  assert.equal(janelaDe24hAberta(Z('2026-11-15T12:10:00Z'), agora), false); // 23 h 50: dentro da folga
  assert.equal(janelaDe24hAberta(Z('2026-11-15T11:59:00Z'), agora), false); // 24 h 01
  assert.equal(janelaDe24hAberta(null, agora), false);
  assert.equal(janelaDe24hAberta(new Date('lixo'), agora), false);
});

test('notaDoSeco com via: diz se iria como texto ou como template, com {{1}}=…', () => {
  const attrs = { etapa: 'Agendado', situacao_consulta: 'Confirmado', data_consulta: '2026-11-17', hora_consulta: '14:30' };
  const d = decidirRegua(conv({ attrs }), { vistos: new Map(), feitos: new Set() }, Z('2026-11-16T17:30:00Z'), U).disparos[0]!;
  assert.equal(d.modelo, 'parau_consulta_lembrete_vespera');
  assert.ok(notaDoSeco(d, { tipo: 'texto' }).startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora, como TEXTO (janela de 24 h aberta):\n\nOlá, Maria.'));
  const t = notaDoSeco(d, { tipo: 'template', nome: d.modelo, variaveis: d.variaveis!, aprovado: true });
  assert.ok(t.startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora pelo template parau_consulta_lembrete_vespera com {{1}}=Maria, {{2}}=17/11 às 14:30 (janela de 24 h fechada):\n\nOlá, Maria.'));
  assert.ok(!t.includes('não está aprovado'));
  assert.ok(notaDoSeco(d, { tipo: 'template', nome: d.modelo, variaveis: d.variaveis!, aprovado: false }).includes('ainda não está aprovado na Meta'));
  // sem via (caixa sem janela): a nota de sempre
  assert.ok(notaDoSeco(d).startsWith('🧪 [SECO] Régua «consulta-vespera» — enviaria agora:\n\nOlá, Maria.'));
});
