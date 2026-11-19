/**
 * A régua do Chatwoot (função pura): cada regra dispara no alvo e não antes, não repete, respeita o atraso máximo,
 * o `sem-follow-up`, a janela de horário, muda de chave ao remarcar e não manda texto com campo faltando.
 * Datas: 2026-11-16 é segunda; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arquivoComEtapa,
  ehArquivo,
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

test('prepagamento pendente: «até amanhã» só para consulta de OUTRO dia, e confere a hora em que SAI; consulta no mesmo dia não recebe; o recado inicial não é afetado', () => {
  const v = { etapa: visto('Agendado', T0) };
  const feitos = ['prepagamento|agendado@2026-11-16T12:00:00.000Z'];
  const consultaEm = (dia: string, hora: string) => ({ ...AGENDADO, data_consulta: dia, hora_consulta: hora });
  const pend = (attrs: Record<string, unknown>, agora = '2026-11-16T15:00:00Z') => regras(rodar(conv({ attrs }), agora, v, feitos)).includes('prepagamento-pendente');
  // consulta amanhã: sai (o texto «até amanhã» é verdade)
  assert.equal(pend(consultaEm('2026-11-17', '14:30')), true);
  assert.equal(pend(consultaEm('2026-11-17', '08:00')), true);
  // consulta HOJE, não importa a hora: «até amanhã» seria mentira — não sai
  for (const hora of ['18:00', '13:30', '12:30', '11:00']) assert.equal(pend(consultaEm('2026-11-16', hora)), false, `hoje às ${hora}`);
  // sem hora e hoje: idem
  assert.equal(pend({ ...AGENDADO, data_consulta: '2026-11-16', hora_consulta: '' }), false);
  // o primeiro recado do pré-pagamento sai igual
  assert.ok(regras(rodar(conv({ attrs: consultaEm('2026-11-16', '12:30') }), T0, v)).includes('prepagamento'));
  // enviado mais tarde (ainda dentro dos 12 h de tolerância) para consulta de hoje: também não
  assert.equal(pend(consultaEm('2026-11-16', '23:00'), '2026-11-16T22:00:00Z'), false);
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
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({}) }), 'doutor-hernia-parauapebas'), 'por');
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({}), etiquetas: ['respondeu-pelo-celular'] }), 'doutor-hernia-parauapebas'), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ autorId: 2 }), etiquetas: ['respondeu-pelo-celular'] }), 'doutor-hernia-parauapebas'), 'tirar');
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ autorId: 2 }) }), 'doutor-hernia-parauapebas'), null);
  // paciente escreveu por último, nota privada (as do seco) ou bot: não muda nada
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ saida: false, autorId: 3, autorTipo: 'contact' }), etiquetas: ['respondeu-pelo-celular'] }), 'doutor-hernia-parauapebas'), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ privada: true, autorId: 2 }), etiquetas: ['respondeu-pelo-celular'] }), 'doutor-hernia-parauapebas'), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: msg({ autorTipo: 'agent_bot' }) }), 'doutor-hernia-parauapebas'), null);
  assert.equal(decidirEtiquetaCelular(conv({ ultima: null }), 'doutor-hernia-parauapebas'), null);
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

test('ehArquivo / arquivoComEtapa: só etiqueta historico + atividade antes do corte; etapa faz entrar no funil', () => {
  const antes = Math.floor(Date.parse('2026-11-12T12:00:00Z') / 1000);
  const depois = Math.floor(Date.parse('2026-11-14T12:00:00Z') / 1000);
  assert.equal(ehArquivo({ labels: ['historico'], last_activity_at: antes }), true);
  assert.equal(ehArquivo({ labels: ['historico'], last_activity_at: depois }), false, 'paciente escreveu de novo: viva');
  assert.equal(ehArquivo({ labels: ['outra'], last_activity_at: antes }), false, 'sem a etiqueta não é arquivo');
  assert.equal(ehArquivo({ labels: ['historico'] }), true, 'sem data conta como arquivo');
  assert.equal(ehArquivo(null), false);
  assert.equal(arquivoComEtapa({ labels: ['historico'], last_activity_at: antes, custom_attributes: { etapa: 'Perdido' } }), true);
  assert.equal(arquivoComEtapa({ labels: ['historico'], last_activity_at: antes, custom_attributes: { etapa: ' ' } }), false);
  assert.equal(arquivoComEtapa({ labels: ['historico'], last_activity_at: depois, custom_attributes: { etapa: 'Perdido' } }), false, 'viva não é arquivo');
});

test('ehArquivo: histórico importado do Instagram/Messenger (meta_conversation_id) é SEMPRE arquivo, mesmo com atividade depois de 14/11', () => {
  const depois = Math.floor(Date.parse('2026-11-18T12:00:00Z') / 1000);
  const meta = { meta_conversation_id: 'aWdfZAG1' };
  assert.equal(ehArquivo({ labels: ['historico'], last_activity_at: depois, additional_attributes: meta }), true, 'última mensagem de 18/11: continua arquivo');
  assert.equal(arquivoComEtapa({ labels: ['historico'], last_activity_at: depois, additional_attributes: meta, custom_attributes: { etapa: 'Perdido' } }), true);
  assert.equal(ehArquivo({ labels: ['outra'], last_activity_at: depois, additional_attributes: meta }), false, 'sem a etiqueta (a equipe tirou) volta a ser conversa normal');
  assert.equal(ehArquivo({ labels: ['historico'], last_activity_at: depois, additional_attributes: { meta_conversation_id: '' } }), false);
  assert.equal(ehArquivo({ labels: ['historico'], last_activity_at: depois, additional_attributes: {} }), false, 'WhatsApp unificado: regra antiga (corte de 14/11) intacta');
});

// ── arquivo com consulta de pé é paciente vivo ──

test('ehArquivo: historico parado com consulta de hoje em diante OU dos últimos 35 dias (situação viva) não é arquivo; Desmarcado, vazio e consulta mais velha são', () => {
  const antes = Math.floor(Date.parse('2026-11-12T12:00:00Z') / 1000);
  const agora = Z('2026-11-15T02:30:00Z'); // sábado 14/11 23:30 em Belém (domingo em UTC)
  const h = (attrs: Record<string, unknown>) => ({ labels: ['historico'], last_activity_at: antes, custom_attributes: attrs });
  assert.equal(ehArquivo(h({}), agora), true);
  for (const s of ['Agendado', 'Confirmado', 'Remarcado']) assert.equal(ehArquivo(h({ data_consulta: '2026-11-16', situacao_consulta: s }), agora), false, s);
  assert.equal(ehArquivo(h({ data_consulta: '2026-11-16T03:00:00.000Z', situacao_consulta: 'Agendado' }), agora), false);
  assert.equal(ehArquivo(h({ data_consulta: '2026-11-14', situacao_consulta: 'Agendado' }), agora), false, 'hoje em Belém (14/11) conta, embora em UTC já seja dia 15');
  // recém-encerrada: a régua ainda tem falta, pós-atendimento e decisão, e a agenda ainda grava o desfecho
  for (const s of ['Atendido', 'Não compareceu', 'Agendado']) assert.equal(ehArquivo(h({ data_consulta: '2026-11-13', situacao_consulta: s }), agora), false, `ontem ${s}`);
  assert.equal(ehArquivo(h({ data_consulta: '2026-10-10', situacao_consulta: 'Atendido' }), agora), false, '35 dias atrás ainda vale (14/11 - 35 = 10/10)');
  assert.equal(ehArquivo(h({ data_consulta: '2026-10-09', situacao_consulta: 'Atendido' }), agora), true, '36 dias: arquivo');
  // Desmarcado e sem situação continuam arquivo; lixo também
  assert.equal(ehArquivo(h({ data_consulta: '2026-11-16', situacao_consulta: 'Desmarcado' }), agora), true);
  assert.equal(ehArquivo(h({ data_consulta: '2026-11-16' }), agora), true);
  assert.equal(ehArquivo(h({ data_consulta: '2026-11-13', situacao_consulta: '' }), agora), true);
  assert.equal(ehArquivo(h({ data_consulta: 'lixo', situacao_consulta: 'Agendado' }), agora), true);
  // sem a etiqueta não era arquivo; com atividade nova continua não sendo
  assert.equal(ehArquivo({ labels: [], last_activity_at: antes, custom_attributes: {} }, agora), false);
  assert.equal(arquivoComEtapa({ ...h({ data_consulta: '2026-11-16', situacao_consulta: 'Agendado', etapa: 'Agendado' }) }), false, 'vivo não é arquivo (nem «com etapa»)');
});

test('historico com consulta de pé: lembretes de horário saem; o que a conversa já mostra é inicial e NÃO dispara regra de «entrou em etapa»', () => {
  const partida = Z('2026-11-14T23:00:00Z');
  const hist = {
    ...conv({ attrs: { etapa: 'Agendado', situacao_consulta: 'Agendado', data_consulta: '2026-11-16', hora_consulta: '13:30', pagamento_antecipado: 'sim' }, etiquetas: ['historico', 'retomada'] }),
    criadaEm: Z('2026-10-01T12:00:00Z'),
  };
  const primeira = Z('2026-11-15T12:00:00Z');
  const k = atualizarVistos(hist, new Map(), primeira, { primeiraVez: false, desde: partida });
  assert.equal(k.vistos.get('etapa')!.inicial, true);
  assert.equal(k.vistos.get('etiqueta:retomada')!.inicial, true);
  // segunda 16/11, consulta 13:30 Belém: dia = 10:30 (13:30Z), preparo = 12:30 (15:30Z); véspera de domingo já passou
  const d1 = decidirRegua(hist, { vistos: k.vistos, feitos: new Set() }, Z('2026-11-16T13:35:00Z'), U);
  assert.deepEqual(regras(d1), ['consulta-dia']);
  const d2 = decidirRegua(hist, { vistos: k.vistos, feitos: new Set() }, Z('2026-11-16T15:35:00Z'), U);
  assert.deepEqual(regras(d2), ['consulta-preparo']);
  // nada de prepagamento (entrou em Agendado), SDR por etiqueta nem outras regras «ao entrar»
  assert.equal(d1.disparos.some((x) => ['prepagamento', 'prepagamento-pendente', 'sdr-retomada'].includes(x.regra)), false);
  // o mesmo paciente com consulta amanhã: a véspera (24 h antes) sai
  const amanha = { ...hist, attrs: { ...hist.attrs, data_consulta: '2026-11-17' } };
  const ka = atualizarVistos(amanha, new Map(), primeira, { primeiraVez: false, desde: partida });
  assert.deepEqual(regras(decidirRegua(amanha, { vistos: ka.vistos, feitos: new Set() }, Z('2026-11-16T16:35:00Z'), U)), ['consulta-vespera']);
});

test('historico com consulta JÁ PASSADA vista pela 1ª vez: nada de falta, pós-atendimento nem decisão por estado antigo; consulta do dia da 1ª vista em diante vale', () => {
  const partida = Z('2026-11-14T22:00:00Z');
  const vista = Z('2026-11-15T02:30:00Z'); // sábado 14/11 23:30 em Belém
  const doHistorico = (attrs: Record<string, unknown>) => ({ ...conv({ attrs, etiquetas: ['historico'] }), criadaEm: Z('2026-10-01T12:00:00Z') });
  const varrer = (c: ConversaRegua, de: Date, ate: Date) => {
    const k = atualizarVistos(c, new Map(), de, { primeiraVez: false, desde: partida });
    assert.equal(k.vistos.get('_visto')!.inicial, true);
    const feitos = new Set<string>();
    const disparos: string[] = [];
    for (let t = de.getTime(); t <= ate.getTime(); t += 10 * 60_000) {
      for (const x of decidirRegua(c, { vistos: k.vistos, feitos }, new Date(t), U).disparos) {
        feitos.add(`${x.regra}|${x.chave}`);
        disparos.push(x.regra);
      }
    }
    return disparos;
  };
  const ate = Z('2026-12-20T00:00:00Z');
  // 13/11 Atendido (etapas em que a Kommo manda pós-atendimento e decisão): nada
  for (const etapa of ['Compareceu', 'Pós-consulta', 'Novo lead', '']) {
    assert.deepEqual(varrer(doHistorico({ etapa, situacao_consulta: 'Atendido', data_consulta: '2026-11-13', hora_consulta: '14:30' }), vista, ate), [], `Atendido 13/11 ${etapa}`);
  }
  // 13/11 Não compareceu: nada de «falta» (nem 48 h)
  assert.deepEqual(varrer(doHistorico({ etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-13', hora_consulta: '14:30' }), vista, ate), []);
  assert.deepEqual(varrer(doHistorico({ etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-13' }), vista, ate), []);
  // 16/11 (depois do dia da 1ª vista) Atendido: pós-atendimento (D+1) e decisão 4d/7d valem; a consulta é posterior à 1ª vista
  const futura = varrer(doHistorico({ etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-16', hora_consulta: '14:30' }), vista, ate);
  assert.deepEqual(futura, ['pos-atendimento', 'decisao-4d', 'decisao-7d']);
  // o dia da 1ª vista também conta (consulta de hoje, marcada Atendido à noite)
  assert.deepEqual(varrer(doHistorico({ etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-14', hora_consulta: '09:00' }), vista, ate), ['decisao-4d', 'decisao-7d']);
  // controle: a MESMA conversa de 13/11 Atendido, mas nascida depois da partida (não inicial), manda o pós-atendimento — é a trava que segura
  const nova = { ...conv({ attrs: { etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-13', hora_consulta: '14:30' } }), criadaEm: Z('2026-11-14T19:00:00Z') };
  const kn = atualizarVistos(nova, new Map(), Z('2026-11-14T20:00:00Z'), { primeiraVez: false, desde: Z('2026-11-14T10:00:00Z') });
  assert.equal(kn.vistos.get('_visto')!.inicial, false);
  assert.ok(decidirRegua(nova, { vistos: kn.vistos, feitos: new Set() }, Z('2026-11-14T20:30:00Z'), U).disparos.some((x) => x.regra === 'pos-atendimento'));
});

test('falta no mesmo dia: a chave é a da consulta — marcar «Não compareceu», desfazer e marcar de novo não manda duas vezes', () => {
  const attrs = { etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-16', hora_consulta: '13:30' };
  const a = rodar(conv({ attrs }), '2026-11-16T20:00:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-16T19:00:00Z') });
  assert.deepEqual(regras(a), ['falta-mesmo-dia']);
  // marcou de novo meia hora depois (desde novo): a mesma chave, já feita
  const b = rodar(conv({ attrs }), '2026-11-16T20:00:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-16T19:30:00Z') }, [`falta-mesmo-dia|${a.disparos[0]!.chave}`]);
  assert.deepEqual(regras(b), []);
  assert.match(a.disparos[0]!.chave, /^faltou@2026-11-16/);
});

// ── SESSÃO vinda da agenda (categoria Sessão): véspera + «hoje», sem preparo, sem os textos de consulta ──

const SESSAO = { categoria_consulta: 'Sessão', data_consulta: '2026-11-19', hora_consulta: '09:30', situacao_consulta: 'Agendado' };
const CHAVE_SESSAO = '2026-11-19T09:30';

/** varre de `de` a `ate` de 10 em 10 min, acumulando o «feitos»; devolve regra → quantas vezes saiu */
function varrerSessao(c: ConversaRegua, de: string, ate: string, v: Record<string, Visto> = {}, feitos: string[] = []) {
  const f = new Set(feitos);
  const saiu: Array<{ regra: string; modelo: string; texto: string | null; quando: string }> = [];
  for (let t = Z(de).getTime(); t <= Z(ate).getTime(); t += 10 * 60_000) {
    for (const x of decidirRegua(c, { vistos: vistos(v), feitos: f }, new Date(t), U).disparos) {
      f.add(`${x.regra}|${x.chave}`);
      saiu.push({ regra: x.regra, modelo: x.modelo, texto: x.texto, quando: new Date(t).toISOString() });
    }
  }
  return saiu;
}

test('sessão da agenda: véspera (texto de sessão) e «hoje» 3 h antes, sem preparo — em qualquer etapa comercial', () => {
  for (const etapa of [undefined, 'Novo lead', 'Sofia qualifica', 'Esperando humano', 'Agendado', 'Confirmado', 'Fechou', 'Compareceu']) {
    const c = conv({ attrs: { ...SESSAO, ...(etapa ? { etapa } : {}) } });
    const r = varrerSessao(c, '2026-11-17T00:00:00Z', '2026-11-19T23:00:00Z');
    assert.deepEqual(r.map((x) => `${x.regra}:${x.modelo}`), ['consulta-vespera:parau_sessao_lembrete_vespera', 'sessao-dia:parau_sessao_confirmacao_dia'], String(etapa));
  }
  const r = varrerSessao(conv({ attrs: SESSAO }), '2026-11-17T00:00:00Z', '2026-11-19T23:00:00Z');
  assert.equal(r[0]!.quando, '2026-11-18T12:30:00.000Z'); // véspera: 24 h antes (09:30 de 18/11 em Belém)
  assert.match(r[0]!.texto!, /^Olá, Maria\. A sua sessão é amanhã\.\nData e horário: 19\/11 às 09:30\nEstá tudo certo\?$/);
  assert.equal(r[1]!.quando, '2026-11-19T11:00:00.000Z'); // 3 h antes seria 06:30; a janela abre às 08:00 e o atraso máximo ainda cobre
  assert.match(r[1]!.texto!, /^Bom dia, Maria\. A sua sessão de hoje está marcada para 19\/11 às 09:30\.\nEstá tudo certo\?$/);
  assert.equal(r.some((x) => x.regra === 'consulta-preparo' || /consulta/.test(x.modelo)), false);
});

test('sessão da agenda: Atendido/Desmarcado não lembram (Remarcado é igual ao main: de pé); Perdido, Frio, Alta e cancelado não recebem; consulta que não é Sessão segue a régua de consulta', () => {
  const sem = (attrs: Record<string, unknown>) => varrerSessao(conv({ attrs: { ...SESSAO, ...attrs } }), '2026-11-17T00:00:00Z', '2026-11-19T23:00:00Z').map((x) => x.regra);
  assert.deepEqual(sem({ situacao_consulta: 'Desmarcado' }), []);
  assert.deepEqual(sem({ situacao_consulta: 'Atendido' }), []);
  assert.deepEqual(sem({ etapa: 'Perdido' }), []);
  assert.deepEqual(sem({ etapa: 'Frio' }), []);
  assert.deepEqual(sem({ etapa_tratamento: 'Alta' }), []);
  assert.deepEqual(sem({ etapa_tratamento: 'Tratamento cancelado' }), []);
  // controle: a MESMA agenda como Avaliação, em Agendado, monta consulta-vespera/dia/preparo (textos de consulta)
  const av = varrerSessao(conv({ attrs: { ...SESSAO, categoria_consulta: 'Avaliação', etapa: 'Agendado' } }), '2026-11-17T00:00:00Z', '2026-11-19T23:00:00Z');
  assert.deepEqual(av.map((x) => x.regra), ['consulta-vespera', 'consulta-dia', 'consulta-preparo']);
  assert.ok(av.every((x) => /consulta/.test(x.modelo)));
});

test('sessão da agenda: sem hora só a véspera (09:00 do dia anterior), com a data no texto', () => {
  const r = varrerSessao(conv({ attrs: { ...SESSAO, hora_consulta: undefined } }), '2026-11-17T00:00:00Z', '2026-11-19T23:00:00Z');
  assert.deepEqual(r.map((x) => x.regra), ['consulta-vespera']);
  assert.equal(r[0]!.quando, '2026-11-18T12:00:00.000Z');
  assert.match(r[0]!.texto!, /Data e horário: 19\/11\n/);
});

test('sessão da agenda NÃO monta falta/pós/decisão de consulta', () => {
  const todas = (attrs: Record<string, unknown>, v: Record<string, Visto> = {}) => varrerSessao(conv({ attrs }), '2026-11-19T00:00:00Z', '2026-12-30T00:00:00Z', v).map((x) => x.regra);
  assert.deepEqual(todas({ ...SESSAO, situacao_consulta: 'Atendido', etapa: 'Pós-consulta' }, {}), []);
  assert.deepEqual(todas({ ...SESSAO, situacao_consulta: 'Atendido', etapa: 'Compareceu' }, {}), []);
  // Não compareceu com a etapa Agendado, visto no dia: só a falta DE SESSÃO (nada de falta-mesmo-dia nem falta-48h)
  const v = { situacao_consulta: visto('Não compareceu', '2026-11-19T20:00:00Z') };
  assert.deepEqual(todas({ ...SESSAO, situacao_consulta: 'Não compareceu', etapa: 'Agendado' }, v), ['sessao-falta']);
});

test('sessão da agenda: falta marcada no dia → parau_sessao_falta (chave = o dia da falta); outro dia, inicial, sem-follow-up não muda a regra', () => {
  const attrs = { ...SESSAO, situacao_consulta: 'Não compareceu' };
  const hoje = rodar(conv({ attrs }), '2026-11-19T20:05:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-19T20:00:00Z') });
  assert.deepEqual(regras(hoje), ['sessao-falta']);
  assert.equal(hoje.disparos[0]!.modelo, 'parau_sessao_falta');
  assert.equal(hoje.disparos[0]!.chave, 'faltou-sessao@2026-11-19'); // o dia da falta em Belém
  assert.match(hoje.disparos[0]!.texto!, /^Olá, Maria\. Você não compareceu à sessão de hoje\./);
  // marcada no dia seguinte: o texto diz «hoje», não vale
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-20T15:00:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-20T14:55:00Z') })), []);
  // já era assim na partida (inicial): nada
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T20:05:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-19T20:00:00Z', true) })), []);
  // desmarcar e marcar de novo: a mesma chave, já feita
  assert.deepEqual(regras(rodar(conv({ attrs }), '2026-11-19T20:35:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-19T20:30:00Z') }, [`sessao-falta|${hoje.disparos[0]!.chave}`])), []);
  // em Perdido não manda
  assert.deepEqual(regras(rodar(conv({ attrs: { ...attrs, etapa: 'Perdido' } }), '2026-11-19T20:05:00Z', { situacao_consulta: visto('Não compareceu', '2026-11-19T20:00:00Z') })), []);
});

test('sessão da agenda × caminhos que já existem: mesmo nome de regra e mesma chave → a mesma sessão não sai duas vezes', () => {
  const chave = CHAVE_SESSAO;
  // (a) etapa «Fechou» (véspera de sessão do caminho antigo): a véspera nova tem a mesma regra e chave
  const fechou = conv({ attrs: { ...SESSAO, etapa: 'Fechou' } });
  assert.deepEqual(varrerSessao(fechou, '2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z').map((x) => x.regra), ['consulta-vespera']);
  assert.deepEqual(varrerSessao(fechou, '2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z', {}, [`consulta-vespera|${chave}`]), [], 'a véspera do caminho antigo já saiu');
  // (b) «Em tratamento» com proxima_sessao igual à consulta da agenda: um só sessao-dia (no mesmo ciclo e entre ciclos)
  const emTrat = conv({ attrs: { ...SESSAO, etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-19', hora_sessao: '09:30' } });
  const d = decidirRegua(emTrat, { vistos: new Map(), feitos: new Set() }, Z('2026-11-19T11:05:00Z'), U);
  assert.deepEqual(regras(d), ['sessao-dia']);
  assert.equal(d.disparos[0]!.chave, chave);
  assert.deepEqual(regras(decidirRegua(emTrat, { vistos: new Map(), feitos: new Set([`sessao-dia|${chave}`]) }, Z('2026-11-19T11:05:00Z'), U)), []);
  // (c) «Em tratamento» com a próxima sessão DIFERENTE da consulta da agenda: vale só o campo que a equipe mantém
  const outra = conv({ attrs: { ...SESSAO, etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-26', hora_sessao: '10:00' } });
  const o = varrerSessao(outra, '2026-11-18T00:00:00Z', '2026-11-26T23:00:00Z');
  assert.deepEqual(o.map((x) => x.regra), ['sessao-dia']);
  assert.match(o[0]!.texto!, /26\/11 às 10:00/);
});

test('sessão da agenda: {{1}} nome e {{2}} «data às hora» saem de data_consulta/hora_consulta quando proxima_sessao está vazia; campo faltando segue o caminho de falta', () => {
  const c = conv({ attrs: SESSAO });
  for (const m of ['parau_sessao_lembrete_vespera', 'parau_sessao_confirmacao_dia']) {
    const r = renderizar(m, c, U);
    assert.deepEqual(r.variaveis, ['Maria', '19/11 às 09:30'], m);
    assert.deepEqual(r.faltando, []);
  }
  // contato sem nome (só telefone): falta, não inventa
  const semNome = renderizar('parau_sessao_lembrete_vespera', conv({ attrs: SESSAO, nome: '+5594999990000' }), U);
  assert.equal(semNome.texto, null);
  assert.deepEqual(semNome.faltando, ['nome do contato']);
  // e o disparo vem com texto nulo + o que falta (o worker deixa a nota no seco / não manda no ligado)
  const d = decidirRegua(conv({ attrs: SESSAO, nome: '+5594999990000' }), { vistos: new Map(), feitos: new Set() }, Z('2026-11-18T12:40:00Z'), U);
  assert.deepEqual(regras(d), ['consulta-vespera']);
  assert.equal(d.disparos[0]!.texto, null);
  // em tratamento, a proxima_sessao da equipe continua mandando no texto
  assert.deepEqual(renderizar('parau_sessao_lembrete_vespera', conv({ attrs: { ...SESSAO, etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-26', hora_sessao: '10:00' } }), U).variaveis, ['Maria', '26/11 às 10:00']);
});

test('texto de sessão: o {{2}} é a data+hora que DECIDIU o envio; os outros modelos que usam o mesmo campo seguem como no main', () => {
  // Em tratamento SEM proxima_sessao, com data_retorno velho: o lembrete da agenda mostra a data da agenda
  const emTrat = conv({ attrs: { ...SESSAO, etapa_tratamento: 'Em tratamento', data_retorno: '2026-10-01' } });
  const v = decidirRegua(emTrat, { vistos: new Map(), feitos: new Set() }, Z('2026-11-18T12:40:00Z'), U);
  assert.deepEqual(regras(v), ['consulta-vespera']);
  assert.match(v.disparos[0]!.texto!, /Data e horário: 19\/11 às 09:30/);
  assert.doesNotMatch(v.disparos[0]!.texto!, /01\/10/);
  assert.deepEqual(v.disparos[0]!.variaveis, ['Maria', '19/11 às 09:30']);
  // cancelado com categoria Sessão: o retorno do cancelamento mostra data_retorno, não a data da sessão
  const canc = { ...SESSAO, etapa_tratamento: 'Tratamento cancelado', data_retorno: '2026-11-25' };
  const r = renderizar('parau_cancelamento_retorno_confirmado', conv({ attrs: canc }), U);
  assert.match(r.texto!, /Data e horário: 25\/11\n/);
  assert.deepEqual(r.variaveis, ['Maria', '25/11']);
  // confirmação de retorno da SDR (categoria Sessão, sem proxima_sessao): data_retorno, depois consulta — como no main
  assert.match(renderizar('parau_sdr_confirmacao_retorno', conv({ attrs: { ...SESSAO, data_retorno: '2026-11-25' } }), U).texto!, /agendado para 25\/11,/);
  assert.match(renderizar('parau_sdr_confirmacao_retorno', conv({ attrs: SESSAO }), U).texto!, /agendado para 19\/11 às 09:30,/);
  // «Em tratamento» com proxima_sessao igual à consulta da agenda: o texto do sessao-dia é a sessão da equipe
  const igual = conv({ attrs: { ...SESSAO, etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-19', hora_sessao: '09:30' } });
  const d = decidirRegua(igual, { vistos: new Map(), feitos: new Set() }, Z('2026-11-19T11:05:00Z'), U);
  assert.match(d.disparos[0]!.texto!, /19\/11 às 09:30/);
  // renderizar sem o momento do envio (chamada direta) = comportamento do main
  assert.deepEqual(renderizar('parau_sessao_lembrete_vespera', conv({ attrs: { ...SESSAO, data_retorno: '2026-11-25' } }), U).variaveis, ['Maria', '25/11']);
});

test('falta de sessão: agenda e «compareceu_ultima_sessao» são o MESMO envio (regra e chave do dia da falta); falta de outro dia não cala a de hoje; Alta/cancelado não', () => {
  const base = { ...SESSAO, situacao_consulta: 'Não compareceu', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-19', hora_sessao: '09:30' };
  // 10:00 a agenda marca Não compareceu → manda
  const v1 = { situacao_consulta: visto('Não compareceu', '2026-11-19T13:00:00Z') };
  const a = decidirRegua(conv({ attrs: base }), { vistos: vistos(v1), feitos: new Set() }, Z('2026-11-19T13:05:00Z'), U);
  assert.deepEqual(regras(a), ['sessao-falta']);
  const feitos = new Set([`sessao-falta|${a.disparos[0]!.chave}`]);
  // 15:00 a equipe marca compareceu_ultima_sessao = Não no mesmo dia → não manda de novo
  const v2 = { ...v1, compareceu_ultima_sessao: visto('Não', '2026-11-19T18:00:00Z') };
  const b = decidirRegua(conv({ attrs: { ...base, compareceu_ultima_sessao: 'Não' } }), { vistos: vistos(v2), feitos }, Z('2026-11-19T18:05:00Z'), U);
  assert.deepEqual(regras(b), []);
  // a ordem inversa (equipe primeiro, agenda depois): idem
  const c1 = decidirRegua(conv({ attrs: { ...base, compareceu_ultima_sessao: 'Não' } }), { vistos: vistos({ compareceu_ultima_sessao: visto('Não', '2026-11-19T13:00:00Z') }), feitos: new Set() }, Z('2026-11-19T13:05:00Z'), U);
  assert.deepEqual(regras(c1), ['sessao-falta']);
  assert.equal(c1.disparos[0]!.chave, a.disparos[0]!.chave);
  assert.deepEqual(regras(decidirRegua(conv({ attrs: { ...base, compareceu_ultima_sessao: 'Não' } }), { vistos: vistos(v2), feitos: new Set([`sessao-falta|${c1.disparos[0]!.chave}`]) }, Z('2026-11-19T18:05:00Z'), U)), []);
  // dois caminhos no MESMO ciclo: um só disparo
  assert.equal(decidirRegua(conv({ attrs: { ...base, compareceu_ultima_sessao: 'Não' } }), { vistos: vistos({ ...v1, compareceu_ultima_sessao: visto('Não', '2026-11-19T13:00:00Z') }), feitos: new Set() }, Z('2026-11-19T13:05:00Z'), U).disparos.length, 1);
  // uma falta ANTERIOR (outro dia) com compareceu_ultima_sessao «Não» não cala a falta de hoje
  const ontem = `sessao-falta|faltou-sessao@2026-11-12`;
  assert.deepEqual(regras(decidirRegua(conv({ attrs: base }), { vistos: vistos(v1), feitos: new Set([ontem]) }, Z('2026-11-19T13:05:00Z'), U)), ['sessao-falta']);
  assert.deepEqual(regras(decidirRegua(conv({ attrs: { ...base, compareceu_ultima_sessao: 'Não' } }), { vistos: vistos({ ...v1, compareceu_ultima_sessao: visto('Não', '2026-11-12T13:00:00Z') }), feitos: new Set([ontem]) }, Z('2026-11-19T13:05:00Z'), U)), ['sessao-falta']);
  // Alta e tratamento cancelado: a falta da agenda também não vale
  for (const etapa_tratamento of ['Alta', 'Tratamento cancelado']) {
    assert.deepEqual(regras(decidirRegua(conv({ attrs: { ...base, etapa_tratamento } }), { vistos: vistos(v1), feitos: new Set() }, Z('2026-11-19T13:05:00Z'), U)), [], etapa_tratamento);
  }
});

test('trocar o modelo na tela Robôs não faz o texto perder a data do envio (vale para QUALQUER modelo do robô, não só os de sessão pelo nome)', () => {
  // consulta de 18/11 14:30, com uma «próxima sessão» velha no cartão; a véspera sai 24 h antes (17/11 14:30 Belém = 17:30Z)
  const attrs = { etapa: 'Agendado', situacao_consulta: 'Agendado', data_consulta: '2026-11-18', hora_consulta: '14:30', proxima_sessao: '2026-10-01', hora_sessao: '08:00' };
  const trocas = [
    ['parau_consulta_lembrete_vespera', 'parau_sessao_lembrete_vespera'], // consulta → texto de sessão (usa o campo da sessão)
    ['parau_consulta_lembrete_vespera', 'parau_consulta_lembrete_vespera'], // sem troca
  ] as const;
  for (const [de, para] of trocas) {
    const ajustes = { modelos: new Map([[`consulta-vespera|${de}`, para]]) };
    const d = decidirRegua(conv({ attrs }), { vistos: new Map(), feitos: new Set() }, Z('2026-11-17T17:35:00Z'), U, ajustes).disparos.find((x) => x.regra === 'consulta-vespera')!;
    assert.equal(d.modelo, para);
    assert.match(d.texto!, /18\/11 às 14:30/, para);
    assert.doesNotMatch(d.texto!, /01\/10/, para);
  }
  // o inverso: o robô de sessão (Em tratamento, a próxima sessão da equipe) com um modelo de consulta mostra a data da SESSÃO
  const sessao = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '10:00', data_consulta: '2026-09-01', hora_consulta: '08:00' };
  const aj = { modelos: new Map([['sessao-dia|parau_sessao_confirmacao_dia', 'parau_consulta_confirmacao_dia']]) };
  const s2 = decidirRegua(conv({ attrs: sessao }), { vistos: new Map(), feitos: new Set() }, Z('2026-11-18T11:05:00Z'), U, aj).disparos.find((x) => x.regra === 'sessao-dia')!;
  assert.equal(s2.modelo, 'parau_consulta_confirmacao_dia');
  assert.match(s2.texto!, /18\/11 às 10:00/);
  assert.doesNotMatch(s2.texto!, /01\/09/);
});

test('resumoDaMensagem: a mensagem de espera da demora vale como NOTA para a régua (não é conversa: não inicia «sem resposta 24 h»)', async () => {
  const { resumoDaMensagem } = await import('./chatwoot-regua.js');
  const { textoDaEspera } = await import('./crm-demora/marca.js');
  const nossa = { message_type: 1, private: false, content: textoDaEspera('Maria'), created_at: 1_790_000_000, sender: { id: 2, type: 'user' } };
  assert.equal(resumoDaMensagem(nossa)?.privada, true);
  assert.equal(resumoDaMensagem({ ...nossa, content: 'Oi, Maria! Sua consulta é amanhã.' })?.privada, false, 'mensagem nossa de verdade segue como pública');
  assert.equal(resumoDaMensagem({ ...nossa, message_type: 0 })?.privada, false, 'o paciente repetindo a frase não vira nota');
});
