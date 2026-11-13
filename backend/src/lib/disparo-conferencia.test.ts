import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  avisosDaRegraDeCliente,
  conferenciaDaUnidade,
  ehCliente,
  regraDeClienteDoAmbiente,
  unidadeConfere,
  type LeitorDeLead,
} from './disparo/conferencia.js';
import { ROTULO_DA_EXCLUSAO, triar } from './disparo/regras.js';
import type { FranquiaPorta } from './disparo/franquia.js';
import { SPINE_STATUS } from '../services/spine.service.js';

const JURIDICO = 14026239;
const COMERCIAL = 13964971;
const CONTRATO_ASSINADO = 108260519;
const GANHO = 142;
const PERDIDO = 143;
const REGRA = `magalhaes-advocacia=${JURIDICO},${COMERCIAL}/${CONTRATO_ASSINADO},${COMERCIAL}/${GANHO}`;
const env = (v: string) => ({ DISPARO_REGRA_CLIENTE: v }) as NodeJS.ProcessEnv;

const ESCRITORIO = { id: 'u-mag', slug: 'magalhaes-advocacia', spineToken: null } as unknown as Unit;
const CLINICA = { id: 'u-cl', slug: 'doutor-hernia-canaa', spineToken: 'tok' } as unknown as Unit;
const PESSOA = { leadId: 10, nomeCompleto: 'Maria da Silva', telefone: '5563991021043' };

const noFunil = (pipeline_id: number, status_id: number): LeitorDeLead => async () => ({ pipeline_id, status_id });
const confere = (unit: Unit, ambiente: NodeJS.ProcessEnv, ler: LeitorDeLead, p: { leadId: number | null; nomeCompleto: string; telefone: string } = PESSOA) => conferenciaDaUnidade(unit, { env: ambiente, ler })(p);

test('escritório (sem franquia, com regra): cliente do funil jurídico, em QUALQUER etapa (inclusive 142/143), fica de fora', async () => {
  for (const etapa of [1, 77777, GANHO, PERDIDO]) {
    assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(JURIDICO, etapa)), 'ja-cliente', `etapa ${etapa}`);
  }
});

test('escritório: no Comercial, "6 - Contrato assinado" e "Fechado - ganho" são clientes', async () => {
  assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(COMERCIAL, CONTRATO_ASSINADO)), 'ja-cliente');
  assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(COMERCIAL, GANHO)), 'ja-cliente');
});

test('escritório: "Fechado - perdido" (143) do Comercial é LIVRE — reengajar perdido é o objetivo; lead novo também', async () => {
  assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(COMERCIAL, PERDIDO)), 'livre');
  assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(COMERCIAL, 99999)), 'livre', 'etapa qualquer do Comercial');
  assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(555, GANHO)), 'livre', 'ganho de OUTRO funil não é regra');
});

test('escritório: o lead é lido FRESCO a cada conferência (quem fechou contrato depois da montagem sai na hora do envio)', async () => {
  let etapa = 5;
  let leituras = 0;
  const ler: LeitorDeLead = async () => (leituras++, { pipeline_id: COMERCIAL, status_id: etapa });
  const conferir = conferenciaDaUnidade(ESCRITORIO, { env: env(REGRA), ler });
  assert.equal(await conferir(PESSOA), 'livre');
  etapa = CONTRATO_ASSINADO;
  assert.equal(await conferir(PESSOA), 'ja-cliente');
  assert.equal(leituras, 2);
});

test('escritório: Kommo falhou (lança, vem vazio ou sem funil/etapa) = indisponivel, NUNCA livre', async () => {
  assert.equal(await confere(ESCRITORIO, env(REGRA), async () => { throw new Error('kommo 500'); }), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(REGRA), async () => null), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(REGRA), async () => ({})), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(REGRA), async () => ({ pipeline_id: COMERCIAL })), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(REGRA), noFunil(COMERCIAL, 5), { ...PESSOA, leadId: null }), 'indisponivel', 'sem cartão não há o que olhar');
});

test('sem franquia e SEM regra = indisponivel para todos (como hoje); regra de outra unidade não vale; regra inválida não vale', async () => {
  let leu = false;
  const ler: LeitorDeLead = async () => ((leu = true), { pipeline_id: 1, status_id: 1 });
  assert.equal(await confere(ESCRITORIO, {} as NodeJS.ProcessEnv, ler), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(`outra-unidade=${JURIDICO}`), ler), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(`magalhaes-advocacia=${JURIDICO},abc`), ler), 'indisponivel', 'item ruim invalida a entrada toda');
  assert.equal(await confere(ESCRITORIO, env(`${JURIDICO}`), ler), 'indisponivel', 'formato global/antigo: ninguém');
  assert.equal(leu, false, 'sem regra nem toca no Kommo');
  assert.equal(unidadeConfere(ESCRITORIO, {} as NodeJS.ProcessEnv), false);
  assert.equal(unidadeConfere(ESCRITORIO, env(REGRA)), true);
});

test('COM franquia o comportamento é o de sempre: a franquia responde, o Kommo não é tocado, nem com regra de cliente na unidade', async () => {
  let leu = false;
  const ler: LeitorDeLead = async () => ((leu = true), { pipeline_id: JURIDICO, status_id: GANHO });
  const franquia = (agenda: 'falha' | Array<{ clientName: string; dateAttendanceUtc: string; idStatus: number }>): FranquiaPorta => ({
    searchSchedules: (async () => (agenda === 'falha' ? { ok: false, error: 'fora do ar' } : { ok: true, data: { schedules: agenda, pages: 1, total: 0 } })) as unknown as FranquiaPorta['searchSchedules'],
    searchTreatments: (async () => ({ ok: true, data: { treatments: [] } })) as unknown as FranquiaPorta['searchTreatments'],
    idClientDoLead: (async () => null) as unknown as FranquiaPorta['idClientDoLead'],
    getClient: (async () => ({ ok: true, data: { client: { schedules: [], treatments: [] } } })) as unknown as FranquiaPorta['getClient'],
  });
  const amanha = new Date(Date.now() + 86_400_000).toISOString();
  const comRegra = env(`doutor-hernia-canaa=${JURIDICO}`);
  const c = (f: FranquiaPorta) => conferenciaDaUnidade(CLINICA, { env: comRegra, ler, franquia: f })(PESSOA);
  assert.equal(await c(franquia([])), 'livre', 'franquia livre = livre, mesmo o cartão estando no funil da regra');
  assert.equal(await c(franquia([{ clientName: 'Maria da Silva', dateAttendanceUtc: amanha, idStatus: SPINE_STATUS.AGENDADO }])), 'consulta-futura');
  assert.equal(await c(franquia('falha')), 'indisponivel');
  assert.equal(leu, false);
  assert.equal(unidadeConfere(CLINICA, {} as NodeJS.ProcessEnv), true);
});

test('o valor de config da Magalhães: funil inteiro + duas etapas; várias unidades na mesma variável', () => {
  const regra = regraDeClienteDoAmbiente('magalhaes-advocacia', env(`outra=1; ${REGRA} \n`))!;
  assert.deepEqual([...regra.funis], [JURIDICO]);
  assert.deepEqual([...regra.etapas].sort(), [`${COMERCIAL}/${GANHO}`, `${COMERCIAL}/${CONTRATO_ASSINADO}`].sort());
  assert.equal(ehCliente(regra, { pipeline_id: JURIDICO, status_id: PERDIDO }), true);
  assert.equal(ehCliente(regra, { pipeline_id: COMERCIAL, status_id: PERDIDO }), false);
  assert.deepEqual(avisosDaRegraDeCliente(env(REGRA)), []);
  assert.equal(avisosDaRegraDeCliente(env(`${JURIDICO}; magalhaes-advocacia=x`)).length, 2, 'avisa entrada global e entrada com item ruim');
  assert.equal(regraDeClienteDoAmbiente('magalhaes-advocacia', env(`magalhaes-advocacia=${COMERCIAL}/0`)), null, 'etapa 0 é erro de digitação: entrada inteira inválida');
  assert.equal(avisosDaRegraDeCliente(env(`${REGRA};${REGRA}`)).length, 1, 'avisa slug repetido');
});

test('triagem: "ja-cliente" fica de fora, é contado com rótulo próprio, e indisponível não entra', async () => {
  const cand = (leadId: number, nome: string, tel: string) => ({ leadId, nome, telefoneBruto: tel });
  const etapas: Record<number, [number, number] | 'falha'> = { 1: [JURIDICO, 5], 2: [COMERCIAL, PERDIDO], 3: 'falha' };
  const franquia = conferenciaDaUnidade(ESCRITORIO, {
    env: env(REGRA),
    ler: async (id) => {
      const e = etapas[id];
      if (e === 'falha') throw new Error('kommo fora');
      return { pipeline_id: e[0], status_id: e[1] };
    },
  });
  const r = await triar(
    [cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Joana Lima', '5563992021043'), cand(3, 'Ana Costa', '5563993021043')],
    { jaNaCampanha: new Set(), pediramSair: new Set(), franquia: (e) => franquia({ leadId: e.leadId, nomeCompleto: e.nomeCompleto, telefone: e.telefone }) },
  );
  assert.deepEqual(r.elegiveis.map((e) => e.nome), ['Joana']);
  assert.deepEqual(r.fora, { 'ja-cliente': 1, 'franquia-indisponivel': 1 });
  assert.match(ROTULO_DA_EXCLUSAO['ja-cliente'], /cliente/);
});
