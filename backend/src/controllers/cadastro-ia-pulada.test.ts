/**
 * O cadastro do lead na franquia quando a IA NÃO fala no turno (fora do horário, pausa, etapa não liberada, equipe falou).
 * Antes ele só rodava no fim do turno em que a IA falou: em Petrópolis, onde de dia quem atende é a SDR, quase todo lead do
 * dia nunca seria cadastrado. Sem banco e sem Kommo: as dependências são trocadas.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import type { AnuncioDeOrigem } from '../agent/anuncio-de-origem.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { _limparCacheParaTeste, type DepsDoCadastro } from '../lib/cadastro-todo-lead.js';
import { cadastrarQuandoIaPulada } from './webhook.controller.js';

const PET = { id: 'u-pet', slug: 'petropolis', spineSyncLeads: true } as unknown as Unit;
const PACIENTE = '5524988887777';
const INTERNO = '5524999990001';
const DE_ANUNCIO: AnuncioDeOrigem = { titulo: null, anuncio: null, campanha: 'DH Petrópolis · Coluna', plataforma: 'Instagram', origem: 'Meta-Instagram' };

function deps(telefone = PACIENTE): DepsDoCadastro {
  return {
    situacaoNaFranquia: async () => 'nova',
    telefoneDaConversa: async () => telefone,
    casamentoLigado: () => true,
    unidadesDoTelefone: async () => ['petropolis'],
    anuncioDoLead: async () => DE_ANUNCIO,
    falasDoPaciente: async () => ['Olá, quero agendar uma avaliação'],
    avaliarPelaIa: async () => ({ decisao: 'duvida', motivo: 'x' }),
  };
}

const ligar = (estado: 'ligado' | 'seco') => _semearParaTeste([{ slug: 'petropolis', automacao: 'cadastro-todo-lead', estado }]);

beforeEach(() => {
  _semearParaTeste([]);
  _limparCacheParaTeste();
  process.env.NUMEROS_INTERNOS = `recepcao:${INTERNO.slice(-11)}`;
});

test('IA pulada + lead de anúncio: cadastra como LEAD (soLead), nunca como paciente', async () => {
  ligar('ligado');
  const chamadas: Array<{ leadId: number; soLead?: boolean }> = [];
  const r = await cadastrarQuandoIaPulada({ unit: PET, leadId: 10, isChatMessage: true }, async (_u, leadId, o) => void chamadas.push({ leadId, soLead: o.soLead }), deps());
  await r?.execucao;
  assert.deepEqual(chamadas, [{ leadId: 10, soLead: true }]);
});

test('IA pulada + número interno: não cadastra', async () => {
  ligar('ligado');
  let n = 0;
  const r = await cadastrarQuandoIaPulada({ unit: PET, leadId: 11, isChatMessage: true }, async () => void n++, deps(INTERNO));
  await r?.execucao;
  assert.equal(n, 0);
  assert.equal(r?.decisao.criar, false);
});

test('IA pulada + SECO: decide e loga, não cadastra', async () => {
  ligar('seco');
  let n = 0;
  const r = await cadastrarQuandoIaPulada({ unit: PET, leadId: 12, isChatMessage: true }, async () => void n++, deps());
  await r?.execucao;
  assert.equal(n, 0);
});

test('IA pulada + chave DESLIGADA: regra de 26/09 (não agendou → não cria)', async () => {
  let n = 0;
  const r = await cadastrarQuandoIaPulada({ unit: PET, leadId: 13, isChatMessage: true }, async () => void n++, deps());
  await r?.execucao;
  assert.equal(n, 0);
});

test('webhook que não é mensagem do paciente (campo/etapa), lead inválido e unidade sem espelhamento: nem tenta', async () => {
  ligar('ligado');
  let n = 0;
  const sync = async () => void n++;
  assert.equal(await cadastrarQuandoIaPulada({ unit: PET, leadId: 14, isChatMessage: false }, sync, deps()), null);
  assert.equal(await cadastrarQuandoIaPulada({ unit: PET, leadId: 0, isChatMessage: true }, sync, deps()), null);
  assert.equal(await cadastrarQuandoIaPulada({ unit: { ...PET, spineSyncLeads: false } as unknown as Unit, leadId: 15, isChatMessage: true }, sync, deps()), null);
  assert.equal(n, 0);
});

test('o sincronizador que explode não derruba o turno', async () => {
  ligar('ligado');
  const r = await cadastrarQuandoIaPulada({ unit: PET, leadId: 16, isChatMessage: true }, async () => {
    throw new Error('franquia fora');
  }, deps());
  await r?.execucao; // o erro é engolido pelo gancho; nada propaga
  assert.ok(r);
});

// ── a ligação: cada saída "IA pulada" do processAgent devolve TURNO_PULADO ─────────────────────────

test('ligação: toda saída em que a IA é pulada (horário, pausa da unidade, pausa do cartão, etapa, regra global, equipe falou) devolve TURNO_PULADO', () => {
  const src = readFileSync(new URL('./webhook.controller.ts', import.meta.url), 'utf8');
  const marcas = [
    "'agente pulado (pausa da unidade)'",
    "'agente pulado (fora do horário comercial)'",
    "'agente pulado (IA Pausada)'",
    "'agente pulado (etapa fora da allowlist kommoAllowedStatusIds)'",
    "'agente pulado (regra global pause_in_stages)'",
    "'agente pulado (a equipe falou com o paciente)'",
  ];
  for (const m of marcas) {
    const i = src.indexOf(m);
    assert.ok(i > 0, `não achei ${m}`);
    const proximoReturn = /return[^;]*;/.exec(src.slice(i));
    assert.equal(proximoReturn?.[0], 'return TURNO_PULADO;', `${m} deve devolver TURNO_PULADO`);
  }
  // E a etapa calada (GANHO/ALTA/cancelado) NÃO cadastra: é cartão da jornada, não lead novo.
  const calada = src.indexOf("'agente pulado (etapa calada pelo nome)'");
  assert.equal(/return[^;]*;/.exec(src.slice(calada))?.[0], 'return;');
  // O wrapper público é quem cadastra.
  assert.match(src, /const r = await processarTurno\(args\);\s+if \(r === TURNO_PULADO\) await cadastrarQuandoIaPulada\(args\);/);
});
