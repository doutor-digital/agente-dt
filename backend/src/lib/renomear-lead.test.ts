import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dataCurta, estadoDoCartao, estadoMaisFraco, nomeDeGente, planejarRenomeacao } from './renomear-lead.js';
import { renomearConta, type KommoDoRenomear } from './renomear-lead-worker.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { MembroDoCrm } from './crm-compartilhado.js';

const TZ = 'America/Sao_Paulo';
// 26/10/2026 14:00 em Brasília = 17:00 UTC
const AGORA = Date.UTC(2026, 9, 26, 17, 0, 0) / 1000;

test('dataCurta: dd/mm/aa no fuso da unidade, não em UTC', () => {
  assert.equal(dataCurta(AGORA, TZ), '26/10/26');
  // 27/10 01:30 UTC ainda é 26/10 22:30 em Brasília
  assert.equal(dataCurta(Date.UTC(2026, 9, 27, 1, 30) / 1000, TZ), '26/10/26');
  // e em Boa Vista (UTC-4) 27/10 03:30 UTC ainda é 26/10
  assert.equal(dataCurta(Date.UTC(2026, 9, 27, 3, 30) / 1000, 'America/Boa_Vista'), '26/10/26');
});

test('nomeDeGente: os nomes de verdade da amostra das SDRs passam, com capitalização normal', () => {
  assert.equal(nomeDeGente('Carla Ruth'), 'Carla Ruth');
  assert.equal(nomeDeGente('Simone Katia'), 'Simone Katia');
  assert.equal(nomeDeGente('Sérgio Luis'), 'Sérgio Luis');
  assert.equal(nomeDeGente('Perpétua Fernandes'), 'Perpétua Fernandes');
  assert.equal(nomeDeGente('Marlucia'), 'Marlucia');
  assert.equal(nomeDeGente('Vera Lucia Hilario'), 'Vera Lucia Hilario');
  assert.equal(nomeDeGente('Lage Josy'), 'Lage Josy');
  assert.equal(nomeDeGente('silvia leticia Rocha'), 'Silvia Leticia Rocha');
  assert.equal(nomeDeGente('  MARIA   DA SILVA '), 'Maria da Silva');
  assert.equal(nomeDeGente("joão d'ávila"), "João D'Ávila");
  assert.equal(nomeDeGente('ana-maria souza'), 'Ana-Maria Souza');
  assert.equal(nomeDeGente('Maria Paz'), 'Maria Paz', 'Paz/Vida/Dia sozinhos são sobrenome');
  assert.equal(nomeDeGente('João Vida'), 'João Vida');
  assert.equal(nomeDeGente('Ana Dia'), 'Ana Dia');
  assert.equal(nomeDeGente('Sueli Jesus'), 'Sueli Jesus', 'Jesus é sobrenome comum — só a frase "é Fiel" derruba');
  assert.equal(nomeDeGente('Cláudio McDonald'), 'Cláudio McDonald', 'maiúscula no meio é como a pessoa escreveu');
});

test('nomeDeGente: os lixos da amostra e do mundo real viram null (melhor "Lead" do que lixo)', () => {
  for (const lixo of [
    'Sueli Jesus é Fiel....',
    'Deus é  Deus',
    'Deus é Deus',
    '-',
    '',
    '   ',
    null,
    undefined,
    '.',
    '🙏🏼',
    'Maria 🌹',
    'Joana ❤',
    '+55 24 99999-9999',
    '5524999999999',
    'Ana 2',
    'Ana e Pedro',
    'Maria Jose da Silva Santos Oliveira', // 5 palavras
    'Bom dia',
    'Boa Tarde',
    'Paz e Bem',
    'Luz e Paz',
    'Dr. Hérnia',
    'Doutor Hérnia',
    'Clínica Central',
    'Contato #123',
    'Lead',
    'Kkkkkk',
    'Aaaaa Bbbbb',
    'Mrs Dlt',
    'J',
    'M R',
    'Ana!',
    'Ana, Maria',
    'Oi, tudo bem?',
    'a'.repeat(70),
  ]) {
    assert.equal(nomeDeGente(lixo), null, `deveria recusar ${JSON.stringify(lixo)}`);
  }
});

test('planejarRenomeacao: a amostra real das SDRs, caso a caso', () => {
  const d = '24/10/26';
  const plano = (contato: string | null, nomesDoDia: string[] = []) =>
    planejarRenomeacao({ nomeDoLead: 'Lead #22647811', nomeDoContato: contato, data: d, nomesDoDia })?.para;
  assert.equal(plano('Carla Ruth'), 'Carla Ruth 24/10/26');
  assert.equal(plano('Simone Katia'), 'Simone Katia 24/10/26');
  assert.equal(plano('Sérgio Luis'), 'Sérgio Luis 24/10/26');
  assert.equal(plano('Perpétua Fernandes'), 'Perpétua Fernandes 24/10/26');
  assert.equal(plano('Marlucia'), 'Marlucia 24/10/26');
  assert.equal(plano('Vera Lucia Hilario'), 'Vera Lucia Hilario 24/10/26');
  assert.equal(plano('Lage Josy'), 'Lage Josy 24/10/26');
  assert.equal(plano('silvia leticia Rocha'), 'Silvia Leticia Rocha 24/10/26');
  // lixos → "Lead dd/mm/aa", nunca o lixo
  assert.equal(plano('Sueli Jesus é Fiel....'), 'Lead 24/10/26');
  assert.equal(plano('Deus é  Deus'), 'Lead 24/10/26');
  assert.equal(plano('-'), 'Lead 24/10/26');
  assert.equal(plano(null), 'Lead 24/10/26');
});

test('planejarRenomeacao: numeração "Lead 2 …" pelo MAIOR número já usado no dia, mesmo com ano de 2 dígitos', () => {
  const plano = (nomesDoDia: string[]) => planejarRenomeacao({ nomeDoLead: 'Lead #1', nomeDoContato: '-', data: '24/10/26', nomesDoDia })?.para;
  assert.equal(plano([]), 'Lead 24/10/26');
  assert.equal(plano(['Maria 24/10/26', 'Lead 25/10/26']), 'Lead 24/10/26', 'nome de gente e outro dia não contam');
  assert.equal(plano(['Lead 24/10/26']), 'Lead 2 24/10/26');
  assert.equal(plano(['Lead 24/10/26', 'Lead 2 24/10/26', 'Lead 5 24/10/26']), 'Lead 6 24/10/26');
});

test('planejarRenomeacao: nome que a SDR já deu NUNCA é tocado', () => {
  for (const nome of ['Simone Katia 26/10/26', 'Mauriza', 'Carla Ruth', 'Lead 26/10/26', 'Lead 2 26/10/2026', 'Sem Nome 24/10/26']) {
    assert.equal(planejarRenomeacao({ nomeDoLead: nome, nomeDoContato: 'Outra Pessoa', data: '26/10/26', nomesDoDia: [] }), null, nome);
  }
  // os do Kommo ainda são "sem nome"
  for (const nome of ['Lead #22647811', 'Lead 22647811', 'Lead', '', null]) {
    assert.ok(planejarRenomeacao({ nomeDoLead: nome, nomeDoContato: 'Ana Paula', data: '26/10/26', nomesDoDia: [] }), String(nome));
  }
});

// ── qual chave vale para o cartão ────────────────────────────────────────────────────────────────────────────

const PETRO: MembroDoCrm = { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' };
const CAXIAS: MembroDoCrm = { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias', slug: 'doutor-hernia-caxias' };
const CONTA = { id: 'u-petro', slug: 'doutor-hernia-petropolis' };
const estados = (m: Record<string, 'ligado' | 'seco' | 'desligado'>) => (slug: string) => m[slug] ?? 'desligado';

test('estadoMaisFraco', () => {
  assert.equal(estadoMaisFraco([]), 'desligado');
  assert.equal(estadoMaisFraco(['ligado', 'ligado']), 'ligado');
  assert.equal(estadoMaisFraco(['ligado', 'seco']), 'seco');
  assert.equal(estadoMaisFraco(['seco', 'desligado', 'ligado']), 'desligado');
});

test('estadoDoCartao: Kommo de uma unidade só vale a chave dela; dividido, a da unidade do cartão', () => {
  const e = estados({ 'doutor-hernia-petropolis': 'ligado', 'doutor-hernia-caxias': 'seco' });
  assert.deepEqual(estadoDoCartao(null, e, null, CONTA), { dono: null, estado: 'ligado' });
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, 'Petrópolis', CONTA), { dono: { id: 'u-petro', slug: 'doutor-hernia-petropolis' }, estado: 'ligado' });
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, 'caxias', CONTA), { dono: { id: 'u-caxias', slug: 'doutor-hernia-caxias' }, estado: 'seco' });
  // sem unidade (ou unidade que ninguém usa): a mais fraca — nunca ligada se a outra está em seco
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, null, CONTA), { dono: null, estado: 'seco' });
  assert.deepEqual(estadoDoCartao([PETRO, CAXIAS], e, 'Niterói', CONTA), { dono: null, estado: 'seco' });
  const soPetro = estados({ 'doutor-hernia-petropolis': 'ligado' });
  assert.equal(estadoDoCartao([PETRO, CAXIAS], soPetro, null, CONTA).estado, 'desligado');
  assert.equal(estadoDoCartao([PETRO, CAXIAS], soPetro, 'Caxias', CONTA).estado, 'desligado');
  assert.equal(estadoDoCartao([PETRO, CAXIAS], soPetro, 'Petrópolis', CONTA).estado, 'ligado');
});

// ── a rodada inteira, com um Kommo falso ─────────────────────────────────────────────────────────────────────

interface Cartao { id: number; nome: string; contato: number | null; unidade?: string; minutosDeVida?: number }

function cenario(cartoes: Cartao[], contatos: Record<number, string | null>, opcoes: { aoRelero?: (id: number) => string } = {}) {
  const gravados: Array<{ id: number; nome: string }> = [];
  const lidos: number[] = [];
  const leads: KommoLead[] = cartoes.map((c) => ({
    id: c.id,
    name: c.nome,
    status_id: 1,
    pipeline_id: 1,
    created_at: AGORA - (c.minutosDeVida ?? 30) * 60,
    custom_fields_values: c.unidade ? [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: c.unidade }] }] : [],
    _embedded: { contacts: c.contato === null ? [] : [{ id: c.contato, is_main: true }] },
  })) as KommoLead[];
  const kommo: KommoDoRenomear = {
    listLeadsNaJanela: async () => ({ leads, truncado: false }),
    contatosBasicos: async (ids: number[]) => new Map(ids.filter((i) => i in contatos).map((i) => [i, { nome: contatos[i], telefone: null }])),
    getLead: async (id: number) => {
      lidos.push(id);
      const l = leads.find((x) => x.id === id)!;
      return { ...l, name: opcoes.aoRelero ? opcoes.aoRelero(id) : l.name } as KommoLead;
    },
    updateLeadName: async (id: number, nome: string) => {
      gravados.push({ id, nome });
    },
  } as unknown as KommoDoRenomear;
  const simulados: Array<{ leadId: number; valor: unknown; slug: string }> = [];
  const registrar = ((unit: { slug: string }, _a: string, s: { leadId: number; valor?: unknown }) => {
    simulados.push({ leadId: s.leadId, valor: s.valor, slug: unit.slug });
  }) as never;
  return { kommo, gravados, lidos, simulados, registrar };
}

const unit = { id: 'u-petro', slug: 'doutor-hernia-petropolis', businessHoursTimezone: TZ, spineTimezone: TZ };
const SEM_NOME = (n: number) => `Lead #${n}`;

test('rodada em SECO: registra o que renomearia e NÃO escreve no Kommo', async () => {
  const c = cenario(
    [
      { id: 1, nome: SEM_NOME(1), contato: 11 },
      { id: 2, nome: SEM_NOME(2), contato: 12 },
      { id: 3, nome: SEM_NOME(3), contato: 13 },
    ],
    { 11: 'Carla Ruth', 12: 'Deus é  Deus', 13: '-' },
  );
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'seco' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [], 'seco não grava');
  assert.deepEqual(c.lidos, [], 'seco nem relê');
  assert.equal(r?.simulados, 3);
  assert.deepEqual(c.simulados.map((s) => s.valor), ['Carla Ruth 26/10/26', 'Lead 26/10/26', 'Lead 2 26/10/26']);
});

test('rodada LIGADA: grava só o nome, numera os sem nome do dia e nunca toca nome que a SDR deu', async () => {
  const c = cenario(
    [
      { id: 1, nome: 'Simone Katia 26/10/26', contato: 11 }, // SDR já nomeou
      { id: 2, nome: SEM_NOME(2), contato: 12 },
      { id: 3, nome: SEM_NOME(3), contato: 13 },
      { id: 4, nome: 'Mauriza', contato: 14 },
      { id: 5, nome: 'Lead 26/10/26', contato: 15 }, // título nosso de antes: não é "sem nome"
    ],
    { 11: 'Simone Katia', 12: 'Sérgio Luis', 13: 'Sueli Jesus é Fiel....', 14: 'silvia leticia Rocha', 15: '-' },
  );
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [
    { id: 2, nome: 'Sérgio Luis 26/10/26' },
    { id: 3, nome: 'Lead 2 26/10/26' }, // "Lead 26/10/26" do id 5 já existe no dia
  ]);
  assert.equal(r?.gravados, 2);
});

test('rodada LIGADA: a SDR nomeou no meio da varredura — releitura impede de sobrescrever', async () => {
  const c = cenario([{ id: 2, nome: SEM_NOME(2), contato: 12 }], { 12: 'Sérgio Luis' }, { aoRelero: () => 'Sérgio 26/10/26' });
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, []);
  assert.equal(r?.jaNomeados, 1);
});

test('rodada: lead com menos de 3 minutos ou com mais de 24 h fica para as SDRs / para a próxima', async () => {
  const c = cenario(
    [
      { id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 1 },
      { id: 2, nome: SEM_NOME(2), contato: 12, minutosDeVida: 25 * 60 },
      { id: 3, nome: SEM_NOME(3), contato: 13, minutosDeVida: 10 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias' },
  );
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [{ id: 3, nome: 'Célia Dias 26/10/26' }]);
});

test('numeração só conta o MESMO dia local: "Lead" de ontem não vira "Lead 2" hoje', async () => {
  const c = cenario(
    [
      { id: 1, nome: 'Lead 25/10/26', contato: 11, minutosDeVida: 14 * 60 + 5 }, // 25/10 23:55 em Brasília, ontem
      { id: 2, nome: SEM_NOME(2), contato: 12, minutosDeVida: 30 },
    ],
    { 11: 'Ana Paula', 12: '-' },
  );
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [{ id: 2, nome: 'Lead 26/10/26' }]);
});

test('conta dividida: cada cartão vale a chave da SUA unidade; sem unidade vale a mais fraca; desligada não grava', async () => {
  const c = cenario(
    [
      { id: 1, nome: SEM_NOME(1), contato: 11, unidade: 'Petrópolis' },
      { id: 2, nome: SEM_NOME(2), contato: 12, unidade: 'Caxias' },
      { id: 3, nome: SEM_NOME(3), contato: 13 },
    ],
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias' },
  );
  const r = await renomearConta({
    unit,
    membros: [PETRO, CAXIAS],
    kommo: c.kommo,
    estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado', 'doutor-hernia-caxias': 'seco' }),
    agora: AGORA,
    registrar: c.registrar,
  });
  assert.deepEqual(c.gravados, [{ id: 1, nome: 'Ana Paula 26/10/26' }], 'só o de Petrópolis grava');
  assert.deepEqual(c.simulados.map((s) => [s.leadId, s.slug]), [[2, 'doutor-hernia-caxias'], [3, 'doutor-hernia-petropolis']], 'Caxias e o sem unidade ficam no papel');
  assert.equal(r?.gravados, 1);

  const d = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, unidade: 'Caxias' }], { 11: 'Ana Paula' });
  const r2 = await renomearConta({ unit, membros: [PETRO, CAXIAS], kommo: d.kommo, estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado' }), agora: AGORA, registrar: d.registrar });
  assert.deepEqual(d.gravados, []);
  assert.equal(r2?.desligados, 1);
});

test('tudo desligado: nem lê o Kommo', async () => {
  let chamou = false;
  const kommo = { listLeadsNaJanela: async () => { chamou = true; return { leads: [], truncado: false }; } } as unknown as KommoDoRenomear;
  const r = await renomearConta({ unit, membros: [PETRO, CAXIAS], kommo, estadoDe: estados({}), agora: AGORA });
  assert.equal(r, null);
  assert.equal(chamou, false);
});

test('lista cortada (truncada): não renomeia nada — numeração do dia ficaria errada', async () => {
  const c = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11 }], { 11: 'Ana Paula' });
  c.kommo.listLeadsNaJanela = (async () => ({ leads: [], truncado: true })) as never;
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.equal(r, null);
  assert.deepEqual(c.gravados, []);
});

test('contato que não veio na leitura NÃO vira "Lead" logo: espera a próxima rodada', async () => {
  const c = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 10 }], {}); // contatosBasicos devolve mapa vazio
  await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, []);
});

test('o teto de 50 conta só gravações: leads de unidade desligada não tomam a vaga dos da ligada', async () => {
  const cartoes: Cartao[] = [];
  const contatos: Record<number, string> = {};
  for (let i = 1; i <= 60; i++) { cartoes.push({ id: i, nome: SEM_NOME(i), contato: 100 + i, unidade: 'Caxias', minutosDeVida: 600 }); contatos[100 + i] = 'Ana Paula'; }
  cartoes.push({ id: 999, nome: SEM_NOME(999), contato: 999, unidade: 'Petrópolis', minutosDeVida: 5 });
  contatos[999] = 'Zélia Souza';
  const c = cenario(cartoes, contatos);
  await renomearConta({ unit, membros: [PETRO, CAXIAS], kommo: c.kommo, estadoDe: estados({ 'doutor-hernia-petropolis': 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.deepEqual(c.gravados, [{ id: 999, nome: 'Zélia Souza 26/10/26' }]);
});

test('contato que sumiu (apagado/mesclado): espera 30 min e então vira "Lead dd/mm/aa", sem ficar "Lead #123" para sempre', async () => {
  const novo = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 10 }], {});
  await renomearConta({ unit, membros: null, kommo: novo.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: novo.registrar });
  assert.deepEqual(novo.gravados, []);
  const velho = cenario([{ id: 1, nome: SEM_NOME(1), contato: 11, minutosDeVida: 45 }], {});
  await renomearConta({ unit, membros: null, kommo: velho.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: velho.registrar });
  assert.deepEqual(velho.gravados, [{ id: 1, nome: 'Lead 26/10/26' }]);
});

test('falha ao gravar: segue para os outros e para depois de 3 falhas seguidas', async () => {
  const c = cenario(
    [1, 2, 3, 4, 5].map((i) => ({ id: i, nome: SEM_NOME(i), contato: 10 + i })),
    { 11: 'Ana Paula', 12: 'Bia Souza', 13: 'Célia Dias', 14: 'Dora Lima', 15: 'Eva Reis' },
  );
  c.kommo.updateLeadName = (async () => { throw new Error('429'); }) as never;
  const r = await renomearConta({ unit, membros: null, kommo: c.kommo, estadoDe: estados({ [unit.slug]: 'ligado' }), agora: AGORA, registrar: c.registrar });
  assert.equal(r?.erros, 3);
  assert.equal(r?.gravados, 0);
});
