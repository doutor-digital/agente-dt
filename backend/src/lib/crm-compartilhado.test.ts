import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  _semearCrmParaTeste,
  _zerarSemUnidadeParaTeste,
  cartoesSemUnidade,
  grupoDe,
  membroDoRotulo,
  pularCartao,
  unidadeDoCartao,
  unidadeDonaPeloCartaoId,
  unidadeParaOCartao,
  valorDaUnidadeNoCartao,
  veredictoDoCartao,
  type GrupoDoCrm,
  type MembroDoCrm,
} from './crm-compartilhado.js';

// Petrópolis é a dona do Kommo; Caxias usa o Kommo dela. Imperatriz é uma unidade comum, de um token só.
const PETRO = 'u-petropolis';
const CAXIAS = 'u-caxias';
const ITZ = 'u-imperatriz';
const MEMBROS: MembroDoCrm[] = [
  { unitId: PETRO, contaUnitId: PETRO, rotulo: 'Petrópolis' },
  { unitId: CAXIAS, contaUnitId: PETRO, rotulo: 'Caxias' },
];
const GRUPO = grupoDe(PETRO, MEMBROS) as GrupoDoCrm;

const unidade = (id: string, extra: Partial<Unit> = {}): Unit =>
  ({ id, slug: id, name: id, spineEnabled: true, spineToken: `token-${id}`, kommoAccessToken: id === PETRO ? 'kommo' : null, ...extra }) as Unit;

// o cartão do Kommo, com o campo «⌂ Unidade de atendimento» (e o antigo «⌂ Unidade», que NÃO é o mesmo)
const cartao = (valor: string | null, extras: Array<{ field_name: string; value: unknown }> = [], id = 101) => ({
  id,
  name: 'MARIA DA SILVA 14/10',
  custom_fields_values: [
    { field_id: 264810, field_name: '⌂ Unidade', values: [{ value: 'Petrópolis' }] },
    ...(valor === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: valor }] }]),
    ...extras.map((e, i) => ({ field_id: 900 + i, field_name: e.field_name, values: [{ value: e.value }] })),
  ],
});

beforeEach(() => {
  _semearCrmParaTeste(MEMBROS);
  _zerarSemUnidadeParaTeste();
});

// ── o grupo ──────────────────────────────────────────────────────────────────────────────────────────────────
test('grupoDe: a dona e a irmã veem o mesmo grupo; unidade comum não tem grupo', () => {
  assert.deepEqual(grupoDe(CAXIAS, MEMBROS), GRUPO);
  assert.equal(GRUPO.contaUnitId, PETRO);
  assert.equal(GRUPO.membros.length, 2);
  assert.equal(grupoDe(ITZ, MEMBROS), null);
  assert.equal(grupoDe(PETRO, []), null, 'tabela vazia = ninguém dividido (o estado de hoje em produção)');
});

// ── o campo do cartão ────────────────────────────────────────────────────────────────────────────────────────
test('valorDaUnidadeNoCartao: lê o «⌂ Unidade de atendimento» pelo nome, não o «⌂ Unidade» antigo', () => {
  assert.equal(valorDaUnidadeNoCartao(cartao('Caxias')), 'Caxias');
  assert.equal(valorDaUnidadeNoCartao(cartao(null)), null, 'só o campo antigo preenchido = vazio');
  assert.equal(valorDaUnidadeNoCartao(cartao('   ')), null);
  assert.equal(valorDaUnidadeNoCartao({ custom_fields_values: null }), null);
  assert.equal(valorDaUnidadeNoCartao(null), null);
});

// ── de quem é o cartão ───────────────────────────────────────────────────────────────────────────────────────
test('veredicto: cartão de Caxias é de Caxias e NÃO de Petrópolis (acento e caixa não importam)', () => {
  assert.deepEqual(veredictoDoCartao(GRUPO, CAXIAS, 'Caxias'), { tipo: 'desta', rotulo: 'Caxias' });
  assert.deepEqual(veredictoDoCartao(GRUPO, PETRO, 'CAXIAS'), { tipo: 'outra', rotulo: 'Caxias', unitId: CAXIAS });
  assert.deepEqual(veredictoDoCartao(GRUPO, PETRO, 'petropolis'), { tipo: 'desta', rotulo: 'Petrópolis' });
  assert.deepEqual(veredictoDoCartao(GRUPO, CAXIAS, 'Petrópolis'), { tipo: 'outra', rotulo: 'Petrópolis', unitId: PETRO });
});

test('veredicto: campo vazio não é de ninguém; valor desconhecido também não', () => {
  assert.deepEqual(veredictoDoCartao(GRUPO, PETRO, null), { tipo: 'sem-unidade' });
  assert.deepEqual(veredictoDoCartao(GRUPO, CAXIAS, null), { tipo: 'sem-unidade' });
  assert.deepEqual(veredictoDoCartao(GRUPO, PETRO, 'Rio'), { tipo: 'nao-configurada', valor: 'Rio' });
});

test('veredicto: dona sem a sua linha não mexe em cartão nenhum (configuração pela metade)', () => {
  const soCaxias = grupoDe(PETRO, [MEMBROS[1]]);
  assert.deepEqual(veredictoDoCartao(soCaxias, PETRO, 'Petrópolis'), { tipo: 'sem-rotulo' });
  assert.deepEqual(veredictoDoCartao(soCaxias, PETRO, 'Caxias'), { tipo: 'sem-rotulo' });
});

test('veredicto: unidade comum, de um token só — tudo é dela, como sempre', () => {
  assert.deepEqual(veredictoDoCartao(null, ITZ, null), { tipo: 'sem-divisao' });
  assert.deepEqual(veredictoDoCartao(null, ITZ, 'Caxias'), { tipo: 'sem-divisao' });
});

// ── Kommo → franquia: com que unidade escrever ───────────────────────────────────────────────────────────────
const deps = (units: Record<string, Unit>) => ({
  grupo: async (id: string) => grupoDe(id, MEMBROS),
  carregar: async (id: string) => units[id] ?? null,
});

test('unidadeDoCartao: cartão de Caxias (pedido chega por Petrópolis) escreve com o token de CAXIAS, conferido', async () => {
  const petro = unidade(PETRO);
  const caxias = unidade(CAXIAS);
  const r = await unidadeDoCartao(petro, cartao('Caxias'), deps({ [CAXIAS]: caxias }));
  assert.equal(r.tipo, 'unidade');
  if (r.tipo !== 'unidade') return;
  assert.equal(r.unit.id, CAXIAS);
  assert.equal(r.unit.spineToken, 'token-u-caxias');
  assert.equal(r.unit.escritaConferida, true);
  assert.equal(r.rotulo, 'Caxias');
});

test('unidadeDoCartao: cartão de Petrópolis escreve com o token de PETRÓPOLIS, conferido', async () => {
  const petro = unidade(PETRO);
  const r = await unidadeDoCartao(petro, cartao('Petrópolis'), deps({}));
  assert.equal(r.tipo, 'unidade');
  if (r.tipo !== 'unidade') return;
  assert.equal(r.unit.id, PETRO);
  assert.equal(r.unit.spineToken, 'token-u-petropolis');
  assert.equal(r.unit.escritaConferida, true);
});

test('unidadeDoCartao: campo vazio RECUSA com a frase para a SDR — nunca escolhe pelo telefone', async () => {
  const r = await unidadeDoCartao(unidade(PETRO), cartao(null), deps({ [CAXIAS]: unidade(CAXIAS) }));
  assert.equal(r.tipo, 'recusa');
  if (r.tipo !== 'recusa') return;
  assert.equal(r.codigo, 'sem_unidade');
  assert.match(r.motivo, /Escolha a ⌂ Unidade de atendimento do cartão \(Petrópolis ou Caxias\)/);
  assert.match(r.motivo, /Nada foi marcado/);
});

test('unidadeDoCartao: unidade do cartão sem franquia conectada (ou valor desconhecido) recusa', async () => {
  const semToken = await unidadeDoCartao(unidade(PETRO), cartao('Caxias'), deps({ [CAXIAS]: unidade(CAXIAS, { spineToken: null }) }));
  assert.equal(semToken.tipo, 'recusa');
  if (semToken.tipo === 'recusa') assert.equal(semToken.codigo, 'unidade_sem_franquia');
  const desconhecida = await unidadeDoCartao(unidade(PETRO), cartao('Rio de Janeiro'), deps({}));
  assert.equal(desconhecida.tipo, 'recusa');
  if (desconhecida.tipo === 'recusa') assert.equal(desconhecida.codigo, 'unidade_sem_franquia');
});

test('unidadeDoCartao: unidade comum segue igual — a mesma unidade, sem marca, sem ler campo', async () => {
  const itz = unidade(ITZ);
  const r = await unidadeDoCartao(itz, cartao(null), { grupo: async () => null, carregar: async () => { throw new Error('não deveria carregar'); } });
  assert.equal(r.tipo, 'sem-divisao');
  assert.equal(r.unit, itz, 'o mesmo objeto: nada muda para quem tem um token só');
  assert.equal((r.unit as Unit & { escritaConferida?: boolean }).escritaConferida, undefined);
});

test('unidadeParaOCartao: conta dividida sem cartão no pedido recusa; unidade comum nem lê o Kommo', async () => {
  const semLead = await unidadeParaOCartao(unidade(PETRO), null, async () => { throw new Error('não deveria ler'); });
  assert.equal(semLead.tipo, 'recusa');
  const itz = await unidadeParaOCartao(unidade(ITZ), 123, async () => { throw new Error('não deveria ler'); });
  assert.equal(itz.tipo, 'sem-divisao');
  const naoLeu = await unidadeParaOCartao(unidade(PETRO), 123, async () => null);
  assert.equal(naoLeu.tipo, 'recusa');
});

// ── evento que chega pela dona e só diz o número do cartão (webhook status_lead, 20/10) ──────────────────────
test('membroDoRotulo: o rótulo do cartão diz o membro, venha o evento por quem vier; vazio e estranho = null', () => {
  assert.equal(membroDoRotulo(GRUPO, 'CAXIAS')?.unitId, CAXIAS);
  assert.equal(membroDoRotulo(GRUPO, 'petropolis')?.unitId, PETRO);
  assert.equal(membroDoRotulo(GRUPO, null), null);
  assert.equal(membroDoRotulo(GRUPO, 'Rio'), null);
});

test('unidadeDonaPeloCartaoId: Caxias → a unidade Caxias; Petrópolis → a própria; vazio, estranho ou ilegível → ninguém', async () => {
  const petro = unidade(PETRO);
  const caxias = unidade(CAXIAS);
  const carregar = async (id: string) => (id === CAXIAS ? caxias : id === PETRO ? petro : null);
  const ler = (valor: string | null) => async () => cartao(valor);
  assert.equal(await unidadeDonaPeloCartaoId(petro, 1, ler('Caxias'), carregar), caxias);
  assert.equal(await unidadeDonaPeloCartaoId(petro, 1, ler('Petrópolis'), carregar), petro);
  assert.equal(await unidadeDonaPeloCartaoId(petro, 1, ler(null), carregar), null, 'só o «⌂ Unidade» antigo não conta');
  assert.equal(await unidadeDonaPeloCartaoId(petro, 1, ler('Rio'), carregar), null);
  assert.equal(await unidadeDonaPeloCartaoId(petro, 1, async () => null, carregar), null);
  assert.equal(await unidadeDonaPeloCartaoId(petro, 1, async () => { throw new Error('Kommo fora'); }, carregar), null);
});

test('unidadeDonaPeloCartaoId: unidade de um token só é a própria, sem ler o cartão', async () => {
  const itz = unidade(ITZ);
  assert.equal(await unidadeDonaPeloCartaoId(itz, 1, async () => { throw new Error('não deveria ler'); }), itz);
});

// ── franquia → Kommo: o portão dos robôs e a lista da SDR ────────────────────────────────────────────────────
test('pularCartao: cada unidade só mexe no seu cartão; a de um token só nunca pula', () => {
  const resumo: { deOutraUnidade?: number; semUnidade?: number } = {};
  assert.equal(pularCartao(GRUPO, CAXIAS, cartao('Caxias'), resumo), false);
  assert.equal(pularCartao(GRUPO, PETRO, cartao('Caxias'), resumo), true);
  assert.equal(pularCartao(GRUPO, PETRO, cartao('Petrópolis'), resumo), false);
  assert.equal(resumo.deOutraUnidade, 1);
  assert.equal(pularCartao(null, ITZ, cartao(null), resumo), false);
  assert.equal(pularCartao(null, ITZ, cartao('Caxias'), resumo), false);
});

test('campo vazio: ninguém mexe e o cartão vai para a lista; casou só com Petrópolis pela origem = sugestão', () => {
  const resumo: { semUnidade?: number } = {};
  const lead = cartao(null, [], 555);
  // o ⚙ idClient do cartão (115714) é um dos ids do paciente que a franquia de Petrópolis casou
  assert.equal(pularCartao(GRUPO, PETRO, lead, resumo, { idsClient: [115714], idDoCartao: 115714 }), true);
  assert.equal(resumo.semUnidade, 1);
  const lista = cartoesSemUnidade(PETRO);
  assert.equal(lista.length, 1);
  assert.deepEqual(lista[0], { leadId: 555, nome: 'MARIA DA SILVA 14/10', casouCom: ['Petrópolis'], nasDuas: false, sugestao: 'Petrópolis' });
});

test('campo vazio e paciente nas DUAS franquias: lista "nas duas", sem sugestão — a SDR decide', () => {
  const lead = cartao(null, [], 777);
  assert.equal(pularCartao(GRUPO, PETRO, lead, {}, { idsClient: [115714], idDoCartao: 115714 }), true);
  assert.equal(pularCartao(GRUPO, CAXIAS, lead, {}, { idsClient: [133558], idDoCartao: 115714 }), true);
  const [e] = cartoesSemUnidade(PETRO);
  assert.equal(e.leadId, 777);
  assert.deepEqual(e.casouCom, ['Caxias', 'Petrópolis']);
  assert.equal(e.nasDuas, true);
  assert.equal(e.sugestao, null);
});

test('revisão, 48 h e parados (sem casar paciente) pulam o cartão vazio mas NÃO o põem na lista', () => {
  const resumo: { semUnidade?: number } = {};
  assert.equal(pularCartao(GRUPO, PETRO, cartao(null, [], 999), resumo), true);
  assert.equal(resumo.semUnidade, 1);
  assert.equal(cartoesSemUnidade(PETRO).length, 0);
});

test('campo vazio sem idClient que confira: lista sem sugestão; entrada vencida some', () => {
  const agora = Date.now();
  pularCartao(GRUPO, CAXIAS, cartao(null, [], 888), {}, { idsClient: [133558], idDoCartao: null });
  assert.equal(cartoesSemUnidade(PETRO, agora)[0].sugestao, null);
  assert.equal(cartoesSemUnidade(PETRO, agora + 25 * 3600_000).length, 0, 'depois de 24 h sem casar de novo, sai da lista');
  assert.equal(cartoesSemUnidade(ITZ).length, 0, 'a lista é por conta do Kommo');
});

// ── a trava do #56 vira RESERVA: vale sem a divisão gravada, sai do caminho com ela ──────────────────────────
test('trava da unidade de atendimento (#56): sem divisão recusa Caxias e vazio; com a divisão, quem decide é o roteamento', async () => {
  const { travaDaUnidadeDeAtendimento } = await import('./trava-unidade-atendimento.js');
  const petro = unidade(PETRO, { slug: 'doutor-hernia-petropolis' });
  const kommoCom = (valor: string | null) => ({ getLead: async () => cartao(valor) as never });

  _semearCrmParaTeste([]); // conta SEM linha em unit_crm_compartilhado: o estado de hoje
  assert.equal((await travaDaUnidadeDeAtendimento(petro, 101, kommoCom('Caxias')))?.codigo, 'unidade_de_outra_cidade');
  assert.equal((await travaDaUnidadeDeAtendimento(petro, 101, kommoCom(null)))?.codigo, 'unidade_vazia');
  assert.equal(await travaDaUnidadeDeAtendimento(petro, 101, kommoCom('Petrópolis')), null);

  _semearCrmParaTeste(MEMBROS); // divisão gravada: a trava sai do caminho (o roteamento e a trava de escrita assumem)
  assert.equal(await travaDaUnidadeDeAtendimento(petro, 101, kommoCom('Caxias')), null);
  assert.equal(await travaDaUnidadeDeAtendimento(petro, 101, kommoCom(null)), null);
  // …e o roteamento continua recusando o vazio e mandando Caxias para o token de Caxias
  const vazio = await unidadeDoCartao(petro, cartao(null), deps({}));
  assert.equal(vazio.tipo, 'recusa');
  const cax = await unidadeDoCartao(petro, cartao('Caxias'), deps({ [CAXIAS]: unidade(CAXIAS) }));
  assert.equal(cax.tipo === 'unidade' && cax.unit.spineToken, 'token-u-caxias');
});
