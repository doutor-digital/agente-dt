import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DEMANDAS_NO_TEXTO,
  PREFIXO_DO_LEASE,
  TENTATIVAS_POR_HORARIO,
  TTL_DO_LEASE_EM_ENVIO_MS,
  TTL_DO_LEASE_ENVIADO_MS,
  haQuanto,
  horarioDaVez,
  memoriaNova,
  modoDoLembrete,
  montarLembrete,
  passoDoLembrete,
  umaLinha,
  valorDoLembreteReconhecido,
  type DemandaAberta,
  type DepsLembrete,
} from './suporte-lembrete.js';
import { SEM_PAUSA, type EstadoPausa } from './suporte-pausa.js';
import { modoDoSuporte } from './suporte-menu.js';

// São Paulo = UTC−3 o ano todo (sem horário de verão desde 2019)
const as9h = new Date('2026-11-11T12:00:00Z');
const as9h59 = new Date('2026-11-11T12:59:00Z');
const as10h = new Date('2026-11-11T13:00:00Z');
const as17h = new Date('2026-11-11T20:00:00Z');
const as8h59 = new Date('2026-11-11T11:59:00Z');
const as21h = new Date('2026-11-11T00:00:00Z'); // 21h do dia 10 em SP

const demanda = (n: number, extra: Partial<DemandaAberta> = {}): DemandaAberta => ({
  protocolo: n,
  nome: 'Maria',
  unidade: 'Doutor Hérnia Timbó',
  relato: 'A Sofia não respondeu a paciente Joana',
  desde: new Date(as9h.getTime() - 5 * 3_600_000),
  status: 'aberta',
  ...extra,
});

test('modoDoLembrete: nasce desligado; só "seco" e "ligado" ligam; mesma regra do SUPORTE_MENU (maiúsculas ok, aspas não)', () => {
  assert.equal(modoDoLembrete(undefined), 'desligado');
  assert.equal(modoDoLembrete(''), 'desligado');
  assert.equal(modoDoLembrete('qualquer coisa'), 'desligado');
  assert.equal(modoDoLembrete('seco'), 'seco');
  assert.equal(modoDoLembrete(' LIGADO '), 'ligado');
  assert.equal(modoDoLembrete('"ligado"'), modoDoSuporte('"ligado"'), 'as duas chaves leem o valor do mesmo jeito');
  assert.equal(valorDoLembreteReconhecido('ligado'), true);
  assert.equal(valorDoLembreteReconhecido('talvez'), false);
});

test('horarioDaVez: a hora cheia inteira das 9h e das 17h de São Paulo; o resto do dia não', () => {
  assert.equal(horarioDaVez(as9h)?.chave, '2026-11-11:09');
  assert.equal(horarioDaVez(as9h59)?.chave, '2026-11-11:09');
  assert.equal(horarioDaVez(as17h)?.chave, '2026-11-11:17');
  assert.equal(horarioDaVez(as8h59), null);
  assert.equal(horarioDaVez(as10h), null);
  assert.equal(horarioDaVez(as21h), null);
});

test('horarioDaVez: usa o dia de São Paulo, não o de Greenwich (17h SP = 20h UTC; 9h SP = 12h UTC)', () => {
  assert.equal(horarioDaVez(new Date('2026-11-11T20:30:00Z'))?.dia, '2026-11-11');
  // 02:00 UTC do dia 12 ainda é 23h do dia 11 em SP: não é horário de lembrete
  assert.equal(horarioDaVez(new Date('2026-11-12T02:00:00Z')), null);
});

test('haQuanto', () => {
  const t = new Date('2026-11-11T12:00:00Z');
  const antes = (min: number) => new Date(t.getTime() - min * 60_000);
  assert.equal(haQuanto(antes(0), t), '0 min');
  assert.equal(haQuanto(antes(42), t), '42 min');
  assert.equal(haQuanto(antes(60), t), '1 h');
  assert.equal(haQuanto(antes(5 * 60 + 30), t), '5 h');
  assert.equal(haQuanto(antes(24 * 60), t), '1 d');
  assert.equal(haQuanto(antes(2 * 24 * 60 + 3 * 60), t), '2 d 3 h');
  assert.equal(haQuanto(new Date(t.getTime() + 60_000), t), '0 min', 'relógio adiantado não dá número negativo');
});

test('umaLinha: tira quebras e controles, junta espaços e corta com reticências', () => {
  assert.equal(umaLinha('a\n\nb\t c', 50), 'a b c');
  assert.equal(umaLinha('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
  assert.equal(umaLinha('  curto  ', 50), 'curto');
});

test('montarLembrete: sem demanda aberta não há texto (não manda nada)', () => {
  assert.equal(montarLembrete({ demandas: [], total: 0, reabertas: 0, hora: 9, agora: as9h, pausa: SEM_PAUSA }), null);
});

test('montarLembrete: protocolo, quem, unidade, há quanto tempo e 1 linha do relato', () => {
  const t = montarLembrete({ demandas: [demanda(12)], total: 1, reabertas: 0, hora: 9, agora: as9h, pausa: SEM_PAUSA })!;
  assert.match(t, /^📋 Suporte — 1 demanda aberta \(resumo das 9h\)/);
  assert.match(t, /#12 · Maria · Doutor Hérnia Timbó · há 5 h/);
  assert.match(t, /«A Sofia não respondeu a paciente Joana»/);
  assert.match(t, /Painel: https:\/\/suporte\.doutordigitalconsultoria\.com/);
});

test('montarLembrete: sem nome e sem unidade; reaberta marcada; plural', () => {
  const t = montarLembrete({
    demandas: [demanda(1, { nome: null, unidade: null }), demanda(2, { status: 'reaberta' })],
    total: 2,
    reabertas: 1,
    hora: 17,
    agora: as17h,
    pausa: SEM_PAUSA,
  })!;
  assert.match(t, /2 demandas abertas \(resumo das 17h\) · 1 reaberta/);
  assert.match(t, /#1 · \(sem nome\) · unidade não informada/);
  assert.match(t, /#2 🔁 · Maria/);
});

test('montarLembrete: relato com quebra de linha e texto enorme vira UMA linha curta (e não carrega formatação)', () => {
  const t = montarLembrete({
    demandas: [demanda(3, { relato: `linha 1\nlinha 2\n${'x'.repeat(500)}` })],
    total: 1,
    reabertas: 0,
    hora: 9,
    agora: as9h,
    pausa: SEM_PAUSA,
  })!;
  const linhaDoRelato = t.split('\n').find((l) => l.startsWith('«'))!;
  assert.ok(linhaDoRelato.length <= 115, `linha do relato com ${linhaDoRelato.length}`);
  assert.match(linhaDoRelato, /^«linha 1 linha 2 x+…»$/);
});

test('montarLembrete: passando do teto mostra só as primeiras e manda o resto para o painel; cabe no limite do Telegram (3500)', () => {
  const muitas = Array.from({ length: 40 }, (_, i) => demanda(i + 1, { relato: 'y'.repeat(400), nome: 'N'.repeat(100), unidade: 'U'.repeat(100), desde: new Date(as9h.getTime() - 400 * 3_600_000) }));
  const t = montarLembrete({ demandas: muitas.slice(0, MAX_DEMANDAS_NO_TEXTO), total: 40, reabertas: 0, hora: 9, agora: as9h, pausa: SEM_PAUSA })!;
  assert.match(t, /40 demandas abertas/);
  assert.match(t, new RegExp(`… e mais ${40 - MAX_DEMANDAS_NO_TEXTO} no painel`));
  assert.equal((t.match(/^#\d+/gm) ?? []).length, MAX_DEMANDAS_NO_TEXTO);
  assert.ok(t.length < 3500, `texto com ${t.length} caracteres`);
});

test('montarLembrete: lembra que o menu está pausado', () => {
  const pausa: EstadoPausa = { pausado: true, desde: new Date('2026-11-11T11:00:00Z'), por: 'telegram', ignoradas: 2 };
  const t = montarLembrete({ demandas: [demanda(1)], total: 1, reabertas: 0, hora: 9, agora: as9h, pausa })!;
  assert.match(t, /⏸ Menu PAUSADO desde 11\/11 08:00 — \/voltar para retomar/);
});

// ─── o passo (relógio, lease, envio) ────────────────────────────────────────────────────────────────────

function mundo(opcoes: { modo?: 'desligado' | 'seco' | 'ligado'; agora?: Date; abertas?: DemandaAberta[]; total?: number } = {}) {
  const m = {
    agora: opcoes.agora ?? as9h,
    modo: opcoes.modo ?? 'ligado',
    abertas: opcoes.abertas ?? [demanda(1)],
    total: opcoes.total ?? (opcoes.abertas ?? [demanda(1)]).length,
    lease: 'minha' as 'minha' | 'de-outro' | 'erro',
    telegramOk: true,
    pausaQuebrada: false,
    consultas: 0,
    enviados: [] as string[],
    leases: [] as string[],
    ttls: [] as number[],
    liberados: [] as string[],
    logs: [] as Array<{ nivel: string; mensagem: string }>,
  };
  const deps: DepsLembrete = {
    agora: () => m.agora,
    modo: () => m.modo,
    async demandasAbertas() {
      m.consultas += 1;
      return { demandas: m.abertas, total: m.total, reabertas: m.abertas.filter((x) => x.status === 'reaberta').length };
    },
    pausa: async () => {
      if (m.pausaQuebrada) throw new Error('tabela ausente');
      return SEM_PAUSA;
    },
    async reivindicar(nome, ttlMs) {
      m.leases.push(nome);
      m.ttls.push(ttlMs);
      return m.lease;
    },
    async liberar(nome) {
      m.liberados.push(nome);
    },
    async enviar(texto) {
      if (!m.telegramOk) return false;
      m.enviados.push(texto);
      return true;
    },
    registrar: (nivel, _d, mensagem) => void m.logs.push({ nivel, mensagem }),
  };
  return { m, deps };
}

test('passo: DESLIGADO não consulta o banco nem manda nada, a qualquer hora', async () => {
  const { m, deps } = mundo({ modo: 'desligado' });
  assert.equal(await passoDoLembrete(deps, memoriaNova()), 'desligado');
  assert.equal(m.consultas + m.enviados.length + m.leases.length, 0);
});

test('passo: fora das 9h e 17h não consulta o banco', async () => {
  const { m, deps } = mundo({ agora: as10h });
  assert.equal(await passoDoLembrete(deps, memoriaNova()), 'fora-do-horario');
  assert.equal(m.consultas, 0);
});

test('passo: às 9h com demanda aberta manda UM resumo, com lease do horário; os minutos seguintes da hora não repetem', async () => {
  const { m, deps } = mundo();
  const mem = memoriaNova();
  assert.equal(await passoDoLembrete(deps, mem), 'enviado');
  assert.equal(m.enviados.length, 1);
  assert.deepEqual(m.leases, [`${PREFIXO_DO_LEASE}2026-11-11:09`, `${PREFIXO_DO_LEASE}2026-11-11:09`]);
  // o lease nasce curto (processo que morre no meio do envio não tranca o horário) e é renovado depois do envio
  assert.deepEqual(m.ttls, [TTL_DO_LEASE_EM_ENVIO_MS, TTL_DO_LEASE_ENVIADO_MS]);
  m.agora = as9h59;
  assert.equal(await passoDoLembrete(deps, mem), 'ja-feito');
  assert.equal(m.enviados.length, 1);
  assert.equal(m.consultas, 1, 'nem consulta o banco de novo');
});

test('passo: às 9h e às 17h são dois envios (e dias diferentes também)', async () => {
  const { m, deps } = mundo();
  const mem = memoriaNova();
  await passoDoLembrete(deps, mem);
  m.agora = as17h;
  assert.equal(await passoDoLembrete(deps, mem), 'enviado');
  m.agora = new Date(as9h.getTime() + 24 * 3_600_000);
  assert.equal(await passoDoLembrete(deps, mem), 'enviado');
  assert.equal(m.enviados.length, 3);
});

test('passo: SEM demanda aberta não manda nada, nem pega lease, e não consulta de novo na mesma hora', async () => {
  const { m, deps } = mundo({ abertas: [], total: 0 });
  const mem = memoriaNova();
  assert.equal(await passoDoLembrete(deps, mem), 'sem-demanda');
  assert.equal(await passoDoLembrete(deps, mem), 'ja-feito');
  assert.equal(m.enviados.length + m.leases.length, 0);
  assert.equal(m.consultas, 1);
});

test('passo: SECO monta o texto e só registra no log (não pega lease, não envia)', async () => {
  const { m, deps } = mundo({ modo: 'seco' });
  assert.equal(await passoDoLembrete(deps, memoriaNova()), 'seco');
  assert.equal(m.enviados.length + m.leases.length, 0);
  assert.ok(m.logs.some((l) => /seco/.test(l.mensagem)));
});

test('passo: outro processo já cuida do horário (lease alheio) → não envia', async () => {
  const { m, deps } = mundo();
  m.lease = 'de-outro';
  const mem = memoriaNova();
  assert.equal(await passoDoLembrete(deps, mem), 'de-outro');
  assert.equal(m.enviados.length, 0);
  assert.equal(await passoDoLembrete(deps, mem), 'ja-feito');
});

test('passo: banco fora (lease com erro) não envia e tenta de novo no minuto seguinte', async () => {
  const { m, deps } = mundo();
  m.lease = 'erro';
  const mem = memoriaNova();
  assert.equal(await passoDoLembrete(deps, mem), 'sem-lease');
  m.lease = 'minha';
  m.agora = as9h59;
  assert.equal(await passoDoLembrete(deps, mem), 'enviado');
});

test('passo: Telegram recusou → solta o lease e tenta de novo; passando do teto de tentativas desiste do horário (com erro no log)', async () => {
  const { m, deps } = mundo();
  m.telegramOk = false;
  const mem = memoriaNova();
  for (let i = 1; i < TENTATIVAS_POR_HORARIO; i++) assert.equal(await passoDoLembrete(deps, mem), 'falhou-envio');
  assert.equal(await passoDoLembrete(deps, mem), 'desistiu');
  assert.equal(m.liberados.length, TENTATIVAS_POR_HORARIO);
  assert.ok(m.logs.some((l) => l.nivel === 'error'));
  assert.equal(await passoDoLembrete(deps, mem), 'ja-feito', 'depois de desistir não martela');
});

test('passo: Telegram volta antes do teto → o resumo sai', async () => {
  const { m, deps } = mundo();
  m.telegramOk = false;
  const mem = memoriaNova();
  assert.equal(await passoDoLembrete(deps, mem), 'falhou-envio');
  m.telegramOk = true;
  assert.equal(await passoDoLembrete(deps, mem), 'enviado');
  assert.equal(m.enviados.length, 1);
});

test('montarLembrete: o número de reabertas vem da contagem geral, não só das linhas mostradas', () => {
  const t = montarLembrete({ demandas: [demanda(1)], total: 30, reabertas: 5, hora: 9, agora: as9h, pausa: SEM_PAUSA })!;
  assert.match(t, /30 demandas abertas \(resumo das 9h\) · 5 reabertas/);
});

test('passo: se a leitura da pausa falhar, o resumo sai igual (a pausa é só uma linha informativa)', async () => {
  const { m, deps } = mundo();
  m.pausaQuebrada = true;
  assert.equal(await passoDoLembrete(deps, memoriaNova()), 'enviado');
  assert.equal(m.enviados.length, 1);
  assert.doesNotMatch(m.enviados[0]!, /PAUSADO/);
  assert.ok(m.logs.some((l) => l.nivel === 'warn' && /pausa/.test(l.mensagem)));
});

test('montarLembrete: reaberta conta o tempo desde que foi reaberta, não desde a criação', () => {
  const t = montarLembrete({
    demandas: [demanda(10, { status: 'reaberta', desde: new Date(as9h.getTime() - 20 * 60_000) })],
    total: 1,
    reabertas: 1,
    hora: 9,
    agora: as9h,
    pausa: SEM_PAUSA,
  })!;
  assert.match(t, /#10 🔁 · Maria · Doutor Hérnia Timbó · há 20 min/);
});
