import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartaoTemConsulta } from './agendamento-perdido-worker.js';

const comData = (segundos: unknown, nome = '◷ Data da Consulta') => ({
  custom_fields_values: [{ field_id: 1, field_name: nome, values: [{ value: segundos }] }],
});

// 06/10/2026 10:14 BRT — a oferta do lead 28088906 da Açailândia
const oferta = new Date('2026-10-06T13:14:09Z');

test('consulta marcada depois da oferta: não é agendamento perdido', () => {
  // consulta #3738045, quarta 07/10 13:00 BRT
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-07T16:00:00Z') / 1000), oferta), true);
});

test('consulta no mesmo dia, mais tarde, também conta', () => {
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-06T19:00:00Z') / 1000), oferta), true);
});

test('consulta de outro ciclo (antes da oferta) não esconde o alerta', () => {
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-08-20T13:00:00Z') / 1000), oferta), false);
});

test('cartão sem data, com valor quebrado ou sem campos: alerta segue', () => {
  assert.equal(cartaoTemConsulta({ custom_fields_values: [] }, oferta), false);
  assert.equal(cartaoTemConsulta({ custom_fields_values: null }, oferta), false);
  assert.equal(cartaoTemConsulta(comData(''), oferta), false);
  assert.equal(cartaoTemConsulta(comData('abc'), oferta), false);
  assert.equal(cartaoTemConsulta(null, oferta), false);
});

test('outro campo de data não é confundido com a consulta', () => {
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-07T16:00:00Z') / 1000, '◷ Retomar em'), oferta), false);
});

test('folga de fuso: rastro gravado 3 h adiantado não vira alerta', () => {
  const ofertaComFusoErrado = new Date('2026-10-06T16:14:09Z');
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-06T15:00:00Z') / 1000), ofertaComFusoErrado), true);
});

test('faltou de manhã e a IA ofereceu de tarde: consulta velha não cala o alerta', () => {
  // consulta 08:00 BRT, oferta 15:00 BRT do mesmo dia — 7 h antes, fora da folga de 4 h
  const ofertaTarde = new Date('2026-10-06T18:00:00Z');
  assert.equal(cartaoTemConsulta(comData(Date.parse('2026-10-06T11:00:00Z') / 1000), ofertaTarde), false);
});

test('aceita a data em ms, em ISO e o nome do campo sem o símbolo', () => {
  const quarta = Date.parse('2026-10-07T16:00:00Z');
  assert.equal(cartaoTemConsulta(comData(quarta), oferta), true);
  assert.equal(cartaoTemConsulta(comData('2026-10-07T13:00:00-03:00'), oferta), true);
  assert.equal(cartaoTemConsulta(comData(quarta / 1000, 'Data da Consulta'), oferta), true);
});

test('Telegram: unidade, nome do cartão, hora local da oferta e link do cartão', async () => {
  const { textoTelegramPerdido } = await import('./agendamento-perdido-worker.js');
  const texto = textoTelegramPerdido({
    unidade: 'Doutor Hérnia Olímpia',
    subdominio: 'olimpiasp',
    leadId: 5646431,
    nomeDoCartao: 'Anderson 19/10/2026',
    ofereceuEm: new Date('2026-10-19T11:49:14.275Z'),
    fuso: 'America/Sao_Paulo',
  });
  assert.match(texto, /Agendamento perdido · Doutor Hérnia Olímpia/);
  assert.match(texto, /Anderson 19\/10\/2026 — a IA ofereceu horário \(08:49\)/);
  assert.match(texto, /https:\/\/olimpiasp\.kommo\.com\/leads\/detail\/5646431$/);
});

test('Telegram: cartão sem nome e conta sem subdomínio ainda dizem qual lead', async () => {
  const { textoTelegramPerdido } = await import('./agendamento-perdido-worker.js');
  const texto = textoTelegramPerdido({ unidade: 'Serra', subdominio: null, leadId: 42, nomeDoCartao: '  ', ofereceuEm: new Date(), fuso: 'America/Sao_Paulo' });
  assert.match(texto, /^⚠️ Agendamento perdido · Serra\nlead 42 — /);
  assert.ok(!texto.includes('kommo.com'));
});

// ── Filtro de alarme falso (chave agendamento-perdido-filtro), com os alertas reais de 19–20/10/2026 ──

test('filtro: quem adiou e ganhou ⊘ Motivo da espera não é agendamento perdido (Fabiano, Canaã 28448840: "Deixa para próximo")', async () => {
  const { motivoParaNaoAvisar } = await import('./agendamento-perdido-worker.js');
  assert.match(String(motivoParaNaoAvisar({ pacienteRespondeu: true, adiou: true }, 18 * 60 + 30)), /adiou/);
});

test('filtro: quem nunca respondeu depois da oferta fica com a régua de follow-up (Ana Regina, Parauapebas 28812098)', async () => {
  const { motivoParaNaoAvisar } = await import('./agendamento-perdido-worker.js');
  assert.match(String(motivoParaNaoAvisar({ pacienteRespondeu: false, adiou: false }, 23 * 60 + 30)), /não respondeu/);
});

test('filtro: de madrugada espera a manhã (Adriano, Marabá 28476550, alerta às 02:15)', async () => {
  const { motivoParaNaoAvisar } = await import('./agendamento-perdido-worker.js');
  const respondeu = { pacienteRespondeu: true, adiou: false };
  assert.match(String(motivoParaNaoAvisar(respondeu, 2 * 60 + 15)), /madrugada/);
  assert.match(String(motivoParaNaoAvisar(respondeu, 7 * 60 + 30)), /madrugada/, '07:30 ainda é cedo (Rosineide, Bebedouro 6437933)');
  assert.match(String(motivoParaNaoAvisar(respondeu, 21 * 60)), /madrugada/, '21:00 já é silêncio');
  assert.equal(motivoParaNaoAvisar(respondeu, 8 * 60), null, 'às 08:00 avisa');
  assert.equal(motivoParaNaoAvisar(respondeu, 20 * 60 + 59), null);
});

test('filtro: quem respondeu e ficou sem consulta continua avisando (Fernanda, Mossoró 5660603: "vou falar com meu marido")', async () => {
  const { motivoParaNaoAvisar } = await import('./agendamento-perdido-worker.js');
  assert.equal(motivoParaNaoAvisar({ pacienteRespondeu: true, adiou: false }, 17 * 60), null);
});

test('filtro: a hora da unidade sai do fuso dela (Boa Vista é uma hora antes de Brasília)', async () => {
  const { minutosNoFuso } = await import('./agendamento-perdido-worker.js');
  const meiaNoiteEmBrasilia = new Date('2026-10-20T03:00:00Z');
  assert.equal(minutosNoFuso('America/Sao_Paulo', meiaNoiteEmBrasilia), 0);
  assert.equal(minutosNoFuso('America/Boa_Vista', meiaNoiteEmBrasilia), 23 * 60);
});

test('filtro: nasce desligado na rede toda; a lista do .env liga', async () => {
  const { estadoDoFiltro } = await import('./agendamento-perdido-worker.js');
  assert.equal(estadoDoFiltro('doutor-hernia-canaa', ''), 'desligado');
  assert.equal(estadoDoFiltro('doutor-hernia-canaa', 'doutor-hernia-canaa'), 'ligado');
  assert.equal(estadoDoFiltro('doutor-hernia-mossoro', 'doutor-hernia-canaa'), 'desligado');
});

test('filtro: a janela cobre a madrugada inteira — a oferta das 20h ainda está nela às 8h do dia seguinte', async () => {
  const { janelaEfetivaH } = await import('./agendamento-perdido-worker.js');
  assert.equal(janelaEfetivaH(24, 90), 24, 'o padrão não muda');
  // Janela de 6 h configurada à mão: 20:00 + 90 min de carência = 21:30 (silêncio) → só às 08:00, 12 h depois.
  assert.ok(janelaEfetivaH(6, 90) >= 13.5);
});

// ── Para quem cada candidato vira aviso: vigia de sempre × recepção (aviso-clinica-agendamento) ──

test('quemAvisar: o vigia fica EXATAMENTE como era — desligado avisa tudo, seco só anota o pularia, ligado pula quem tem motivo, e quem já foi avisado nunca repete', async () => {
  const { quemAvisar } = await import('./agendamento-perdido-worker.js');
  const adiou = { pacienteRespondeu: true, adiou: true };
  const respondeu = { pacienteRespondeu: true, adiou: false };
  const base = { jaAvisado: false, avisaClinica: false, minutosLocais: 14 * 60 };
  assert.deepEqual(quemAvisar({ ...base, filtro: 'desligado', c: adiou }), { paraVigia: true, paraClinica: false, pularia: null });
  assert.equal(quemAvisar({ ...base, filtro: 'seco', c: adiou }).paraVigia, true);
  assert.match(String(quemAvisar({ ...base, filtro: 'seco', c: adiou }).pularia), /adiou/);
  assert.deepEqual(quemAvisar({ ...base, filtro: 'ligado', c: adiou }), { paraVigia: false, paraClinica: false, pularia: null });
  assert.deepEqual(quemAvisar({ ...base, filtro: 'ligado', c: respondeu }), { paraVigia: true, paraClinica: false, pularia: null });
  assert.deepEqual(quemAvisar({ ...base, filtro: 'desligado', c: respondeu, jaAvisado: true }), { paraVigia: false, paraClinica: false, pularia: null });
});

test('quemAvisar: a recepção usa a MESMA decisão do filtro, sempre — até com o filtro do vigia desligado — e o «já avisado» do vigia não a cala', async () => {
  const { quemAvisar } = await import('./agendamento-perdido-worker.js');
  const base = { jaAvisado: false, avisaClinica: true, minutosLocais: 14 * 60 };
  for (const filtro of ['desligado', 'seco', 'ligado'] as const) {
    assert.equal(quemAvisar({ ...base, filtro, c: { pacienteRespondeu: true, adiou: true } }).paraClinica, false, 'adiou: ' + filtro);
    assert.equal(quemAvisar({ ...base, filtro, c: { pacienteRespondeu: false, adiou: false } }).paraClinica, false, 'não respondeu: ' + filtro);
    assert.equal(quemAvisar({ ...base, filtro, c: { pacienteRespondeu: true, adiou: false }, minutosLocais: 2 * 60 }).paraClinica, false, 'madrugada: ' + filtro);
    assert.equal(quemAvisar({ ...base, filtro, c: { pacienteRespondeu: true, adiou: false } }).paraClinica, true, 'respondeu e ficou sem consulta: ' + filtro);
  }
  // o vigia já avisou esse lead (nota + Telegram) numa varredura anterior: a recepção ainda pode ser avisada na manhã seguinte
  assert.deepEqual(quemAvisar({ ...base, filtro: 'ligado', jaAvisado: true, c: { pacienteRespondeu: true, adiou: false } }), { paraVigia: false, paraClinica: true, pularia: null });
  // chave desligada (ou oferta já avisada): nada para a recepção
  assert.equal(quemAvisar({ ...base, avisaClinica: false, filtro: 'ligado', c: { pacienteRespondeu: true, adiou: false } }).paraClinica, false);
});
