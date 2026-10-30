import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import {
  FOLGA_DA_MARCACAO_MS,
  VALIDADE_DA_PAUSA_MS,
  _limparAdiadas,
  avaliarPausaAberta,
  descreverUltimaFala,
  iaAtendeNaEtapa,
  minutosDaVolta,
  notaDaVolta,
  passouTempoSemEquipe,
  ultimaFalaDaEquipe,
  varrerVolta,
  type DepsDaVolta,
} from './pausa-equipe-volta.js';
import { _semearParaTeste } from './automacoes-estado.js';
import type { PausaAberta, DesfechoDaPausa } from './pausa-equipe-registro.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { Simulacao } from './so-no-papel.js';

/**
 * Pedido do João (30/10/2026): a Sofia volta sozinha 1 h depois da última fala da equipe — mas só a pausa que a
 * própria automação `pausa-equipe` fez, e só onde a IA atende. O cenário-base é o de Bebedouro (lead 6374469):
 * a Melissa fala pelo celular às 10:25 e a conversa morre ali.
 */

const SLUG = 'doutor-hernia-bebedouro';
const LEAD = 6374469;
const em = (hhmm: string) => new Date(`2026-10-30T${hhmm}:00-03:00`);
const unidade = {
  id: 'u-beb',
  slug: SLUG,
  kommoSubdomain: 'doutorherniabebedouro',
  kommoPausedFieldId: 777,
  kommoAllowedStatusIds: [100, 200],
  spineTimezone: 'America/Sao_Paulo',
  pausaDesde: null,
  pausaAte: null,
} as unknown as Unit;

let seq = 0;
const fala = (quando: Date, texto = 'Olá, tudo bem? Aqui é a Melissa, da clínica.', nome = 'Melissa', autor: MensagemOficial['autor'] = 'equipe'): MensagemOficial => ({
  id: String(++seq), em: quando, direcao: 'saida', autor, autorNome: nome, texto, anexo: null, status: null,
});
const entrada = (quando: Date, texto = 'quanto custa?'): MensagemOficial => ({
  id: String(++seq), em: quando, direcao: 'entrada', autor: 'paciente', autorNome: '', texto, anexo: null, status: null,
});

const linha = (over: Partial<PausaAberta> = {}): PausaAberta =>
  ({
    id: 'p1',
    unitId: unidade.id,
    kommoLeadId: LEAD,
    pausadoEm: em('10:26'),
    falaEm: em('10:25'),
    falaAutor: 'Melissa',
    encerradaEm: null,
    desfecho: null,
    criadoEm: em('10:26'),
    unit: unidade,
    ...over,
  }) as PausaAberta;

interface Registro {
  desmarcados: number[];
  notas: string[];
  encerradas: Array<[string, DesfechoDaPausa]>;
  simulacoes: Simulacao[];
  chamadas: string[];
}

/** Kommo falso: tudo que a varredura lê ou escreve passa por aqui. */
function fake(
  agora: Date,
  over: Partial<DepsDaVolta> = {},
  msgs: MensagemOficial[] = [fala(em('10:25'))],
): { deps: DepsDaVolta; r: Registro } {
  const r: Registro = { desmarcados: [], notas: [], encerradas: [], simulacoes: [], chamadas: [] };
  const deps: DepsDaVolta = {
    agora: () => agora,
    estado: () => 'ligado',
    minutos: () => 60,
    mensagens: async () => (r.chamadas.push('mensagens'), msgs),
    pausaMarcadaAgora: async () => (r.chamadas.push('marcada'), true),
    pausaMexidaDesde: async () => (r.chamadas.push('mexida'), false),
    pausaComData: async () => (r.chamadas.push('data'), false),
    etapa: async () => (r.chamadas.push('etapa'), { atende: true, motivo: null, descricao: 'COMERCIAL / EM ATENDIMENTO (funil 1)' }),
    desmarcar: async (_u, lead) => void r.desmarcados.push(lead),
    anotar: async (_u, _l, texto) => void r.notas.push(texto),
    encerrar: async (id, d) => void r.encerradas.push([id, d]),
    simular: (_u, _a, s) => void r.simulacoes.push(s),
    ...over,
  };
  return { deps, r };
}

beforeEach(() => {
  _semearParaTeste([]);
  _limparAdiadas();
});

// ── PAUSA_EQUIPE_VOLTA_MIN ──────────────────────────────────────────────────────────────────────

test('PAUSA_EQUIPE_VOLTA_MIN: padrão 60; valor válido vale; lixo e ≤ 0 voltam ao padrão', () => {
  assert.equal(minutosDaVolta({}), 60);
  assert.equal(minutosDaVolta({ PAUSA_EQUIPE_VOLTA_MIN: '90' }), 90);
  assert.equal(minutosDaVolta({ PAUSA_EQUIPE_VOLTA_MIN: '0' }), 60);
  assert.equal(minutosDaVolta({ PAUSA_EQUIPE_VOLTA_MIN: '-5' }), 60);
  assert.equal(minutosDaVolta({ PAUSA_EQUIPE_VOLTA_MIN: 'abc' }), 60);
});

// ── o tempo (PURA) ──────────────────────────────────────────────────────────────────────────────

const doRegistro = { em: em('10:25'), autorNome: 'Melissa' };

test('≥ 1 h desde a última fala humana da equipe: passou (exatamente 60 min já vale)', () => {
  const msgs = [fala(em('10:25')), entrada(em('11:00'))];
  assert.equal(passouTempoSemEquipe(msgs, doRegistro, em('11:25')).passou, true);
  assert.equal(passouTempoSemEquipe(msgs, doRegistro, em('12:40')).passou, true);
});

test('< 1 h: não passou, e diz quanto falta', () => {
  const d = passouTempoSemEquipe([fala(em('10:25'))], doRegistro, em('11:10'));
  assert.equal(d.passou, false);
  if (!d.passou) assert.equal(d.faltamMs, 15 * 60_000);
});

test('fala NOVA da equipe empurra a volta: a conta é da última fala, não da que pausou', () => {
  const msgs = [fala(em('10:25')), fala(em('12:20'), 'Posso te ligar agora?', 'Talita')];
  const d = passouTempoSemEquipe(msgs, doRegistro, em('12:40'));
  assert.equal(d.passou, false);
  assert.equal(d.ultima.autorNome, 'Talita');
  assert.equal(passouTempoSemEquipe(msgs, doRegistro, em('13:20')).passou, true);
});

test('Salesbot, régua e resposta automática do WhatsApp Business não empurram a volta', () => {
  const ausencia = 'Nosso horário de atendimento é de segundas à sexta, 07h às 19h. Não estamos disponíveis no momento, retornaremos assim que possível.';
  const msgs = [
    fala(em('10:25')),
    entrada(new Date(em('12:30').getTime())),
    fala(new Date(em('12:30').getTime() + 2_000), ausencia, 'WhatsApp Business'),
    fala(em('12:31'), 'Oi! Sou a Sofia 😊', 'Salesbot', 'sofia'),
  ];
  assert.equal(ultimaFalaDaEquipe(msgs, doRegistro).em.getTime(), em('10:25').getTime());
  assert.equal(passouTempoSemEquipe(msgs, doRegistro, em('12:40')).passou, true);
});

test('conversa lida em janela curta que não traz mais a fala antiga: vale a fala do registro', () => {
  assert.deepEqual(ultimaFalaDaEquipe([entrada(em('11:00'))], doRegistro), doRegistro);
});

// ── a etapa (PURA) ──────────────────────────────────────────────────────────────────────────────

const sem = new Set<string>();
const conta = (...listas: number[][]) => listas.map((l) => ({ kommoAllowedStatusIds: l }));
const base = { funis: null, etapasPausadasGlobal: sem, caladaAtiva: false } as const;

test('etapa permitida pela allowlist: a IA atende', () => {
  assert.deepEqual(iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([100, 200]), posicao: { statusId: 100, pipelineId: 1 } }), { atende: true });
});

test('etapa fora da allowlist: não atende', () => {
  assert.deepEqual(iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([100, 200]), posicao: { statusId: 300, pipelineId: 1 } }), {
    atende: false,
    motivo: 'fora_da_allowlist',
  });
});

test('conta sem allowlist nenhuma: sem restrição (como o webhook)', () => {
  assert.deepEqual(iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([]), posicao: { statusId: 300, pipelineId: 1 } }), { atende: true });
});

test('Kommo dividido: basta UMA unidade da conta atender a etapa', () => {
  const r = iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([100], [300]), posicao: { statusId: 300, pipelineId: 1 } });
  assert.deepEqual(r, { atende: true });
});

test('regra global pause_in_stages: por status e por funil:status', () => {
  const a = iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([]), posicao: { statusId: 100, pipelineId: 1 }, etapasPausadasGlobal: new Set(['*:100']) });
  const b = iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([]), posicao: { statusId: 100, pipelineId: 1 }, etapasPausadasGlobal: new Set(['1:100']) });
  const c = iaAtendeNaEtapa({ ...base, unidadesDaConta: conta([]), posicao: { statusId: 100, pipelineId: 1 }, etapasPausadasGlobal: new Set(['2:100']) });
  assert.deepEqual([a, b, c], [
    { atende: false, motivo: 'regra_global' },
    { atende: false, motivo: 'regra_global' },
    { atende: true },
  ]);
});

test('etapa fechada (GANHO / ALTA / CANCELADO) com a chave sofia-calada: não atende, mesmo estando na allowlist', () => {
  const alta = iaAtendeNaEtapa({
    ...base, caladaAtiva: true, unidadesDaConta: conta([142, 100]), posicao: { statusId: 142, pipelineId: 2, etapa: 'ALTA', funil: 'TRATAMENTO' },
  });
  const ganho = iaAtendeNaEtapa({
    ...base, caladaAtiva: true, unidadesDaConta: conta([]), posicao: { statusId: 555, pipelineId: 1, etapa: 'GANHO / CONCLUÍDO', funil: 'COMERCIAL' },
  });
  assert.deepEqual([alta, ganho], [
    { atende: false, motivo: 'etapa_calada' },
    { atende: false, motivo: 'etapa_calada' },
  ]);
});

test('143 do TRATAMENTO (CANCELADO) não é o PERDIDO do comercial que a allowlist libera', () => {
  const funis = { pipelineDoStatus: (id: number) => (id === 100 ? 1 : null), nomeDoFunil: (id: number) => (id === 1 ? 'COMERCIAL' : 'TRATAMENTO') };
  const perdidoComercial = iaAtendeNaEtapa({ ...base, funis, unidadesDaConta: conta([100, 143]), posicao: { statusId: 143, pipelineId: 1 } });
  const canceladoTratamento = iaAtendeNaEtapa({ ...base, funis, unidadesDaConta: conta([100, 143]), posicao: { statusId: 143, pipelineId: 2 } });
  assert.deepEqual([perdidoComercial, canceladoTratamento], [{ atende: true }, { atende: false, motivo: 'fora_da_allowlist' }]);
});

// ── texto ───────────────────────────────────────────────────────────────────────────────────────

test('a nota diz o tempo e quem foi a última', () => {
  const quem = descreverUltimaFala({ em: em('10:25'), autorNome: 'Melissa' }, em('11:30'));
  assert.equal(quem, 'Melissa às 10:25');
  assert.equal(
    notaDaVolta(60, quem),
    'IA voltou: 1 h sem mensagem da equipe (última: Melissa às 10:25). A Sofia volta a responder quando o paciente escrever.',
  );
  assert.match(notaDaVolta(45, quem), /^IA voltou: 45 min sem mensagem/);
  assert.equal(descreverUltimaFala({ em: em('10:25'), autorNome: 'WhatsApp Business' }, em('11:30')), 'o celular da clínica (WhatsApp Business) às 10:25');
  assert.equal(descreverUltimaFala({ em: em('10:25'), autorNome: '' }, new Date('2026-10-31T09:00:00-03:00')), 'a equipe em 30/10 às 10:25');
});

// ── a varredura, com Kommo falso ────────────────────────────────────────────────────────────────

test('LIGADO, 1 h sem a equipe, etapa que a IA atende: desmarca "Pausar IA", fecha a linha e deixa a nota — sem mandar nada ao paciente', async () => {
  const { deps, r } = fake(em('11:30'));
  assert.equal(await avaliarPausaAberta(linha(), deps), 'voltou');
  assert.deepEqual(r.desmarcados, [LEAD]);
  assert.deepEqual(r.encerradas, [['p1', 'voltou']]);
  assert.equal(r.notas.length, 1);
  assert.match(r.notas[0], /^IA voltou: 1 h sem mensagem da equipe \(última: Melissa às 10:25\)/);
  assert.deepEqual(r.simulacoes, []);
});

test('menos de 1 h desde a fala que pausou: nem lê o Kommo', async () => {
  const { deps, r } = fake(em('11:10'));
  assert.equal(await avaliarPausaAberta(linha(), deps), 'cedo');
  assert.deepEqual(r.chamadas, []);
  assert.deepEqual(r.desmarcados, []);
});

test('fala nova da equipe na conversa oficial (< 1 h): não volta, e a linha continua aberta', async () => {
  const { deps, r } = fake(em('12:40'), {}, [fala(em('10:25')), fala(em('12:15'), 'Consegui o horário para você', 'Talita')]);
  assert.equal(await avaliarPausaAberta(linha(), deps), 'cedo');
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.encerradas, []);
});

test('etapa que a IA NÃO atende (fechada, fora da allowlist, regra global): não desmarca e a linha continua aberta', async () => {
  const { deps, r } = fake(em('11:30'), { etapa: async () => ({ atende: false, motivo: 'etapa_calada', descricao: 'TRATAMENTO / ALTA' }) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'etapa_nao_atende');
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.notas, []);
  assert.deepEqual(r.encerradas, []);
});

test('pausa MANUAL da SDR: sem linha aberta a varredura nem chega no cartão', async () => {
  const { deps, r } = fake(em('11:30'));
  const total = await varrerVolta(deps, async () => []);
  assert.deepEqual(total, {});
  assert.deepEqual(r.chamadas, []);
  assert.deepEqual(r.desmarcados, []);
});

test('caixinha já desmarcada por gente: fecha a linha sem escrever nada', async () => {
  const { deps, r } = fake(em('11:30'), { pausaMarcadaAgora: async () => false });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'devolvida_por_gente');
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.encerradas, [['p1', 'devolvida_por_gente']]);
});

test('alguém desmarcou e marcou de novo depois da nossa marcação: virou pausa de gente, não desmarca', async () => {
  let desde: Date | null = null;
  const { deps, r } = fake(em('11:30'), { pausaMexidaDesde: async (_u, _l, d) => ((desde = d), true) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'mexida_por_gente');
  assert.equal(desde!.getTime(), em('10:26').getTime() + FOLGA_DA_MARCACAO_MS);
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.encerradas, [['p1', 'mexida_por_gente']]);
});

test('pausa com data (widget) em curso manda: não desmarca e a linha continua aberta', async () => {
  const { deps, r } = fake(em('11:30'), { pausaComData: async () => true });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'pausa_com_data');
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.encerradas, []);
});

test('pausa da unidade (/pausa/:slug) em curso: não desmarca', async () => {
  const pausada = { ...unidade, pausaDesde: null, pausaAte: new Date('2026-10-30T18:00:00-03:00') } as unknown as Unit;
  const { deps, r } = fake(em('11:30'));
  assert.equal(await avaliarPausaAberta(linha({ unit: pausada }), deps), 'unidade_pausada');
  assert.deepEqual(r.chamadas, []);
  assert.deepEqual(r.desmarcados, []);
});

test('SÓ NO PAPEL: confere tudo, não escreve no Kommo nem fecha a linha, só registra "gravaria Pausar IA (volta)"', async () => {
  const { deps, r } = fake(em('11:30'), { estado: () => 'seco' });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'despausaria');
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.notas, []);
  assert.deepEqual(r.encerradas, []);
  assert.equal(r.simulacoes.length, 1);
  assert.equal(r.simulacoes[0].acao, 'gravaria');
  assert.equal(r.simulacoes[0].alvo, 'Pausar IA (volta)');
  assert.equal(r.simulacoes[0].valor, 'Não');
  assert.match(r.simulacoes[0].motivo ?? '', /Melissa às 10:25/);
});

test('DESLIGADO: não lê nem escreve nada', async () => {
  const { deps, r } = fake(em('11:30'), { estado: () => 'desligado' });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'chave_desligada');
  assert.deepEqual(r.chamadas, []);
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.encerradas, []);
});

test('pausa aberta há mais de 14 dias (mesmo com a chave desligada): fecha como vencida sem tocar no cartão', async () => {
  const { deps, r } = fake(new Date(em('11:30').getTime() + VALIDADE_DA_PAUSA_MS), { estado: () => 'desligado' });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'vencida');
  assert.deepEqual(r.encerradas, [['p1', 'vencida']]);
  assert.deepEqual(r.desmarcados, []);
});

test('não consegui ler a conversa oficial (403, rede): não desmarca e tenta de novo', async () => {
  const { deps, r } = fake(em('11:30'), { mensagens: async () => Promise.reject(new Error('403')) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'nao_conferi');
  assert.deepEqual(r.desmarcados, []);
  assert.deepEqual(r.encerradas, []);
});

test('não consegui ler a etapa: não desmarca (a dúvida é a favor de não mexer)', async () => {
  const { deps, r } = fake(em('11:30'), { etapa: async () => Promise.reject(new Error('500')) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'nao_conferi');
  assert.deepEqual(r.desmarcados, []);
});

test('falha ao desmarcar no Kommo: a linha NÃO fecha (a próxima varredura tenta de novo)', async () => {
  const { deps, r } = fake(em('11:30'), { desmarcar: async () => Promise.reject(new Error('429')) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'nao_conferi');
  assert.deepEqual(r.encerradas, []);
  assert.deepEqual(r.notas, []);
});

test('desmarcou mas a nota falhou: continua "voltou" e a linha está fechada (não desmarca duas vezes)', async () => {
  const { deps, r } = fake(em('11:30'), { anotar: async () => Promise.reject(new Error('rede')) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'voltou');
  assert.deepEqual(r.encerradas, [['p1', 'voltou']]);
});

test('varredura: devolve só quem passou de 1 h; quem não pode voltar não é relido a cada 5 min', async () => {
  const bloqueada = linha({ id: 'p2', kommoLeadId: 2 });
  const pronta = linha({ id: 'p3', kommoLeadId: 3 });
  const recente = linha({ id: 'p4', kommoLeadId: 4, falaEm: em('11:00'), pausadoEm: em('11:01') });
  let leituras = 0;
  const { deps, r } = fake(em('11:30'), {
    etapa: async (_u, lead) => {
      leituras++;
      return lead === 2 ? { atende: false, motivo: 'regra_global', descricao: 'x' } : { atende: true, motivo: null, descricao: 'y' };
    },
  });
  const t1 = await varrerVolta(deps, async () => [bloqueada, pronta, recente]);
  assert.deepEqual(t1, { etapa_nao_atende: 1, voltou: 1, cedo: 1 });
  assert.deepEqual(r.desmarcados, [3]);
  const t2 = await varrerVolta(deps, async () => [bloqueada, recente]);
  assert.deepEqual(t2, { adiada: 1, cedo: 1 });
  assert.equal(leituras, 2);
});

test('equipe seguiu falando: depois de ler a conversa a linha só é relida quando a nova última fala fizer 1 h', async () => {
  const msgs = [fala(em('10:25')), fala(em('12:15'), 'Consegui o horário para você', 'Talita')];
  const { deps, r } = fake(em('12:40'), {}, msgs);
  const l = linha();
  assert.deepEqual(await varrerVolta(deps, async () => [l]), { cedo: 1 });
  assert.deepEqual(await varrerVolta(deps, async () => [l]), { adiada: 1 });
  assert.equal(r.chamadas.filter((c) => c === 'mensagens').length, 1);
});

test('falha ao fechar a linha depois de desmarcar: a nota do cartão sai mesmo assim', async () => {
  const { deps, r } = fake(em('11:30'), { encerrar: async () => Promise.reject(new Error('banco')) });
  assert.equal(await avaliarPausaAberta(linha(), deps), 'voltou');
  assert.equal(r.notas.length, 1);
});
