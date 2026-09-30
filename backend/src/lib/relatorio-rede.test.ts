import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SPINE_STATUS, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { analisar, CAMPOS_ANALISE, type AnaliseUnidade, type LeadDoKommo } from './relatorio-rede-analise.js';
import {
  categoriaDe,
  dataValida,
  montarMensagens,
  motivoLegivel,
  coletarRede,
  coletarUnidade,
  montarTexto,
  moeda,
  resumirAgenda,
  resumirTratamentos,
  taxaDeComparecimento,
  totaisDaRede,
  type Fontes,
  type UnidadeParaColeta,
  type UnidadeRelatada,
} from './relatorio-rede.js';

const HOJE = '2026-09-30';
const AMANHA = '2026-10-01';

function ag(dia: string, idStatus: number | null, categoryName: string | null): SpineSchedule {
  return {
    idSchedule: 1, idTreatment: null, idStatus, statusName: null, clientName: 'Paciente Teste', categoryName,
    physicalTherapist: null, dateAttendanceUtc: null, dateAttendanceLocal: null, dayLocal: dia, timeLocal: '10:00',
    isBusy: true, requiresManualValidation: false,
  };
}

test('categoria: sessão, retorno e avaliação — a ordem evita falso positivo', () => {
  assert.equal(categoriaDe('SESSÃO'), 'sessao');
  assert.equal(categoriaDe('Sessao'), 'sessao');
  assert.equal(categoriaDe('RETORNO COM EXAMES'), 'retorno');
  assert.equal(categoriaDe('Retorno após tratamento'), 'retorno');
  assert.equal(categoriaDe('AVALIAÇÃO'), 'avaliacao');
  assert.equal(categoriaDe('REAVALIAÇÃO'), 'avaliacao');
  assert.equal(categoriaDe('Qualquer outra coisa'), null);
  assert.equal(categoriaDe(null), null);
});

test('agenda: cada status cai no balde certo e desmarcada sai de "marcadas"', () => {
  const r = resumirAgenda([
    ag(HOJE, SPINE_STATUS.ATENDIDO, 'AVALIAÇÃO'),
    ag(HOJE, SPINE_STATUS.ATENDIDO, 'AVALIAÇÃO'),
    ag(HOJE, SPINE_STATUS.NAO_COMPARECEU, 'AVALIAÇÃO'),
    ag(HOJE, SPINE_STATUS.AGENDADO, 'AVALIAÇÃO'),
    ag(HOJE, SPINE_STATUS.CONFIRMADO, 'AVALIAÇÃO'),
    ag(HOJE, SPINE_STATUS.DESMARCADO, 'AVALIAÇÃO'),
    ag(HOJE, SPINE_STATUS.REMARCADO, 'AVALIAÇÃO'),
  ], HOJE, AMANHA);
  assert.deepEqual(r.avaliacao, { marcadas: 5, atendidas: 2, faltas: 1, abertas: 2, desmarcadas: 2 });
});

test('agenda: status desconhecido ou ausente conta como em aberto, não some', () => {
  const r = resumirAgenda([ag(HOJE, 99, 'SESSÃO'), ag(HOJE, null, 'SESSÃO')], HOJE, AMANHA);
  assert.equal(r.sessao.abertas, 2);
  assert.equal(r.sessao.marcadas, 2);
});

test('agenda: amanhã só conta o que não foi desmarcado, por categoria', () => {
  const r = resumirAgenda([
    ag(AMANHA, SPINE_STATUS.AGENDADO, 'AVALIAÇÃO'),
    ag(AMANHA, SPINE_STATUS.CONFIRMADO, 'SESSÃO'),
    ag(AMANHA, SPINE_STATUS.CONFIRMADO, 'SESSÃO'),
    ag(AMANHA, SPINE_STATUS.DESMARCADO, 'AVALIAÇÃO'),
    ag(AMANHA, SPINE_STATUS.REMARCADO, 'SESSÃO'),
  ], HOJE, AMANHA);
  assert.deepEqual(r.amanha, { avaliacao: 1, sessao: 2, retorno: 0 });
  assert.equal(r.avaliacao.marcadas, 0, 'amanhã não entra na conta de hoje');
});

test('agenda: dia fora da janela é ignorado e categoria desconhecida é contada à parte', () => {
  const r = resumirAgenda([ag('2026-09-29', SPINE_STATUS.ATENDIDO, 'AVALIAÇÃO'), ag(HOJE, SPINE_STATUS.ATENDIDO, 'EXAME')], HOJE, AMANHA);
  assert.equal(r.avaliacao.marcadas, 0);
  assert.equal(r.semCategoria, 1);
});

test('comparecimento: quem ainda está em aberto não entra na conta, e sem desfecho é null', () => {
  assert.equal(taxaDeComparecimento({ marcadas: 10, atendidas: 6, faltas: 2, abertas: 2, desmarcadas: 0 }), 0.75);
  assert.equal(taxaDeComparecimento({ marcadas: 3, atendidas: 0, faltas: 0, abertas: 3, desmarcadas: 0 }), null);
});

const dia = (iso: string) => iso.slice(0, 10);
function trat(created: string | null, price: number | null, statusName: string | null = 'EM ANDAMENTO'): SpineTreatment {
  return { idTreatment: 1, idClient: 1, clientName: 'P', category: null, local: null, degree: null, staffName: null, statusName, price, created };
}

test('tratamento: só criado hoje, cancelado não é venda, preço ausente não quebra a soma', () => {
  const r = resumirTratamentos([
    trat('2026-09-30T14:00:00Z', 2400),
    trat('2026-09-30T15:00:00Z', null),
    trat('2026-09-30T16:00:00Z', 1800, 'CANCELADO'),
    trat('2026-09-29T14:00:00Z', 9999),
    trat(null, 5000),
  ], HOJE, dia);
  assert.deepEqual(r, { fechadosHoje: 2, valorHoje: 2400 });
});

test('moeda: sem centavos, separador de milhar brasileiro', () => {
  assert.match(moeda(18400), /^R\$ 18\.400$/);
  assert.match(moeda(0), /^R\$ 0$/);
});

function unidade(nome: string, o: Partial<UnidadeRelatada> = {}): UnidadeRelatada {
  return {
    slug: nome.toLowerCase(), nome, leadsNovos: 5,
    agenda: resumirAgenda([
      ag(HOJE, SPINE_STATUS.ATENDIDO, 'AVALIAÇÃO'), ag(HOJE, SPINE_STATUS.NAO_COMPARECEU, 'AVALIAÇÃO'),
      ag(HOJE, SPINE_STATUS.ATENDIDO, 'SESSÃO'), ag(AMANHA, SPINE_STATUS.AGENDADO, 'AVALIAÇÃO'),
    ], HOJE, AMANHA),
    tratamentos: { fechadosHoje: 1, valorHoje: 2400 }, analise: null, falhas: [], detalhes: [], ...o,
  };
}

test('totais: soma a rede e trata unidade sem agenda como zero, sem NaN', () => {
  const t = totaisDaRede([unidade('Serra'), unidade('Marabá'), unidade('Balsas', { agenda: null, leadsNovos: null, tratamentos: null })]);
  assert.equal(t.leadsNovos, 10);
  assert.equal(t.avaliacao.atendidas, 2);
  assert.equal(t.avaliacao.faltas, 2);
  assert.equal(t.tratamentos.valorHoje, 4800);
  assert.equal(t.amanha.avaliacao, 2);
  assert.equal(t.unidadesNoRelatorio, 3);
});

test('texto: só negrito com *, sem itálico e sem markdown de título', () => {
  const txt = montarTexto({ data: HOJE, unidades: [unidade('Serra'), unidade('Marabá')], semFranquia: [] });
  assert.ok(txt.startsWith('📊 *RELATÓRIO DA REDE · 30/09 · 18h*'));
  assert.ok(!/(^|\n)#/.test(txt), 'sem # de título');
  assert.ok(!/_[^_\n]+_/.test(txt), 'sem _itálico_');
  assert.ok(!/\*\*/.test(txt), 'sem ** duplo');
  assert.match(txt, /Comparecimento: 50% \(2 de 4\)/);
  assert.match(txt, /Tratamentos fechados hoje: 2 · R\$ 4\.800/);
});

test('texto: singular quando é um só (1 falta, não 1 faltas)', () => {
  const u = unidade('Serra', { agenda: resumirAgenda([ag(HOJE, SPINE_STATUS.NAO_COMPARECEU, 'AVALIAÇÃO'), ag(HOJE, SPINE_STATUS.NAO_COMPARECEU, 'SESSÃO')], HOJE, AMANHA) });
  const txt = montarTexto({ data: HOJE, unidades: [u], semFranquia: [] });
  assert.match(txt, /· 1 falta ·/);
  assert.ok(!/\b1 faltas\b/.test(txt), 'sobrou "1 faltas"');
});

test('texto: unidades em ordem alfabética, independente da ordem de chegada', () => {
  const txt = montarTexto({ data: HOJE, unidades: [unidade('Serra'), unidade('Açailândia'), unidade('Marabá')], semFranquia: [] });
  const i = (n: string) => txt.indexOf(`*${n}* ·`);
  assert.ok(i('Açailândia') < i('Marabá') && i('Marabá') < i('Serra'));
});

test('texto: falha vira aviso com o nome da unidade, não um zero que parece resultado', () => {
  const cega = unidade('Balsas', { agenda: null, tratamentos: null, falhas: ['agenda da franquia não respondeu (502)'] });
  const txt = montarTexto({ data: HOJE, unidades: [unidade('Serra'), cega], semFranquia: ['Petrópolis'] });
  assert.match(txt, /\*Balsas\* · franquia indisponível/);
  assert.match(txt, /\*ATENÇÃO\*/);
  assert.match(txt, /• Balsas: agenda da franquia não respondeu \(502\)/);
  assert.match(txt, /• Sem franquia conectada, fora deste relatório: Petrópolis/);
});

test('texto: sem nenhum problema, não existe o bloco ATENÇÃO', () => {
  const txt = montarTexto({ data: HOJE, unidades: [unidade('Serra')], semFranquia: [] });
  assert.ok(!txt.includes('ATENÇÃO'));
});

test('texto: dia sem desfecho não mostra 0%, mostra que ninguém tem desfecho ainda', () => {
  const aberta = unidade('Serra', { agenda: resumirAgenda([ag(HOJE, SPINE_STATUS.AGENDADO, 'AVALIAÇÃO')], HOJE, AMANHA) });
  const txt = montarTexto({ data: HOJE, unidades: [aberta], semFranquia: [] });
  assert.match(txt, /Comparecimento: — \(ninguém com desfecho ainda\)/);
});

test('texto: 17 unidades — cada mensagem fica abaixo de 4.000 caracteres', () => {
  const muitas = Array.from({ length: 17 }, (_, i) => unidade(`Unidade Numero ${i + 1}`, { analise: ANALISE_CHEIA }));
  const msgs = montarMensagens({ data: HOJE, inicioJanela: '2026-09-24', unidades: muitas, semFranquia: [] });
  assert.equal(msgs.length, 2);
  for (const m of msgs) assert.ok(m.length < 4000, `mensagem com ${m.length} caracteres`);
});

test('mensagens: sem dado do Kommo em nenhuma unidade, sai só o placar', () => {
  assert.equal(montarMensagens({ data: HOJE, inicioJanela: '2026-09-24', unidades: [unidade('Serra')], semFranquia: [] }).length, 1);
});

/* ───── análise dos 7 dias (campos do cartão) ───── */

// ids de mentira: o nome do campo vira id pela posição na lista
const NOMES = Object.values(CAMPOS_ANALISE).map((ns) => ns[0] as string);
const ID = (nome: string) => 1000 + NOMES.indexOf(nome);
const acha = (nome: string) => (NOMES.includes(nome) ? ID(nome) : null);
const C = {
  qual: CAMPOS_ANALISE.qualificacao[0], motivo: CAMPOS_ANALISE.motivoNaoAgendamento[0], data: CAMPOS_ANALISE.dataConsulta[0],
  sit: CAMPOS_ANALISE.situacao[0], prova: CAMPOS_ANALISE.pgComprovante[0], intencao: CAMPOS_ANALISE.pgIntencao[0],
  falta: CAMPOS_ANALISE.motivoFalta[0], naoFechou: CAMPOS_ANALISE.motivoNaoFechamento[0],
};
let seq = 0;
function lead(campos: Record<string, unknown>, created_at = 150): LeadDoKommo {
  return { id: ++seq, created_at, custom_fields_values: Object.entries(campos).map(([n, v]) => ({ field_id: ID(n), values: [{ value: v }] })) };
}
const JANELA = { deUnix: 100, ateUnix: 200 };

test('análise: qualificação conta quente, morno, frio e vazio, sem confundir com a data da qualificação', () => {
  const a = analisar({ ...JANELA, acha, truncado: false, mexidos: [], criados: [
    lead({ [C.qual]: 'Quente' }), lead({ [C.qual]: 'Quente' }), lead({ [C.qual]: 'Morno' }), lead({ [C.qual]: 'Frio' }), lead({}),
  ] });
  assert.deepEqual(a.leads, { total: 5, quente: 2, morno: 1, frio: 1, semQualificacao: 1 });
});

test('análise: objeção ranqueada e SEMPRE com a cobertura (quantos registraram)', () => {
  const a = analisar({ ...JANELA, acha, truncado: false, mexidos: [], criados: [
    lead({ [C.motivo]: 'Sem condições financeira' }), lead({ [C.motivo]: 'Sem condições financeira' }), lead({ [C.motivo]: 'Outra cidade' }), lead({}), lead({}),
  ] });
  assert.equal(a.objecoes.registradas, 3);
  assert.deepEqual(a.objecoes.ranking[0], ['Sem condições financeira', 2]);
});

test('análise: consulta fora da janela ou sem data não entra; o mesmo cartão duas vezes conta uma', () => {
  const dentro = lead({ [C.data]: 150, [C.sit]: 'Atendido' });
  const a = analisar({ ...JANELA, acha, truncado: false, criados: [], mexidos: [
    dentro, dentro, lead({ [C.data]: 99, [C.sit]: 'Atendido' }), lead({ [C.data]: 201, [C.sit]: 'Atendido' }), lead({ [C.sit]: 'Atendido' }),
  ] });
  assert.equal(a.consultas.total, 1);
});

test('análise: situação da consulta cai no balde certo, inclusive vazia', () => {
  const a = analisar({ ...JANELA, acha, truncado: false, criados: [], mexidos: [
    lead({ [C.data]: 150, [C.sit]: 'Atendido' }), lead({ [C.data]: 150, [C.sit]: 'Não compareceu' }),
    lead({ [C.data]: 150, [C.sit]: 'Desmarcado' }), lead({ [C.data]: 150, [C.sit]: 'Remarcado' }),
    lead({ [C.data]: 150, [C.sit]: 'Confirmado' }), lead({ [C.data]: 150 }),
  ] });
  assert.deepEqual(a.consultas, { total: 6, atendidas: 1, faltas: 1, desmarcadas: 2, abertas: 1, semSituacao: 1 });
});

test('análise: "pagou" é o COMPROVANTE; dizer que vai pagar não conta como pago (o caso da Serra)', () => {
  const a = analisar({ ...JANELA, acha, truncado: false, criados: [], mexidos: [
    lead({ [C.data]: 150, [C.sit]: 'Atendido', [C.prova]: 'Sim', [C.intencao]: 'Sim' }),
    lead({ [C.data]: 150, [C.sit]: 'Atendido', [C.prova]: 'Sim' }),
    lead({ [C.data]: 150, [C.sit]: 'Não compareceu', [C.prova]: 'Não', [C.intencao]: 'Sim' }),
    lead({ [C.data]: 150, [C.sit]: 'Não compareceu', [C.intencao]: 'Sim' }),
    lead({ [C.data]: 150, [C.sit]: 'Atendido', [C.prova]: 'SIM' }),
  ] });
  assert.equal(a.antecipado.comprovante, 3, '"SIM" maiúsculo também vale');
  assert.equal(a.antecipado.disseQueIaPagar, 3);
  assert.deepEqual(a.antecipado.pagou, { atendidas: 3, faltas: 0 });
  assert.deepEqual(a.antecipado.naoPagou, { atendidas: 0, faltas: 2 }, 'intenção sem comprovante fica em "não pagou"');
});

test('análise: motivo da falta só das faltas, motivo de não fechar só dos atendidos', () => {
  const a = analisar({ ...JANELA, acha, truncado: false, criados: [], mexidos: [
    lead({ [C.data]: 150, [C.sit]: 'Não compareceu', [C.falta]: 'Esqueceu' }),
    lead({ [C.data]: 150, [C.sit]: 'Atendido', [C.falta]: 'Esqueceu', [C.naoFechou]: 'Achou caro' }),
  ] });
  assert.deepEqual(a.faltas, { registradas: 1, base: 1, ranking: [['Esqueceu', 1]] });
  assert.deepEqual(a.naoFechou, { registradas: 1, base: 1, ranking: [['Achou caro', 1]] });
});

test('análise: conta sem um campo avisa qual é, e aceita o nome antigo do motivo de não fechamento', () => {
  const semNoShow = (nome: string) => (nome === C.falta ? null : nome === '⊘ Motivo de não fechamento' ? 777 : nome === C.naoFechou ? null : acha(nome));
  const a = analisar({ ...JANELA, acha: semNoShow, truncado: true, criados: [], mexidos: [] });
  assert.deepEqual(a.camposAusentes, [C.falta]);
  assert.equal(a.truncado, true);
});

const ANALISE_CHEIA: AnaliseUnidade = analisar({ ...JANELA, acha, truncado: false,
  criados: [lead({ [C.qual]: 'Quente', [C.motivo]: 'Sem condições financeira' }), lead({ [C.qual]: 'Frio' })],
  mexidos: [
    lead({ [C.data]: 150, [C.sit]: 'Atendido', [C.prova]: 'Sim' }),
    lead({ [C.data]: 150, [C.sit]: 'Não compareceu', [C.falta]: 'Trabalho' }),
  ] });

test('texto da análise: objeção vem com "registrado em X de Y" e comparecimento separa quem pagou', () => {
  const [, analise] = montarMensagens({ data: HOJE, inicioJanela: '2026-09-24', unidades: [unidade('Serra', { analise: ANALISE_CHEIA })], semFranquia: [] });
  assert.ok(analise!.startsWith('🔎 *ANÁLISE · ÚLTIMOS 7 DIAS (24/09 a 30/09)*'));
  assert.match(analise!, /Principal objeção \(não agendou\):\* Sem condições financeira 1 · registrado em 1 de 2 leads sem consulta/);
  assert.match(analise!, /quem pagou antes 100% \(1 de 1\) · quem não pagou 0% \(0 de 1\)/);
  assert.match(analise!, /Por que faltaram:\* Trabalho 1 · registrado em 1 de 1 faltas/);
  assert.ok(!/_[^_\n]+_/.test(analise!), 'sem _itálico_');
});

test('texto da análise: ninguém registrou o motivo é dito com todas as letras, não vira "nenhuma objeção"', () => {
  const vazia = analisar({ ...JANELA, acha, truncado: false, criados: [lead({}), lead({})], mexidos: [] });
  const [, analise] = montarMensagens({ data: HOJE, inicioJanela: '2026-09-24', unidades: [unidade('Serra', { analise: vazia })], semFranquia: [] });
  assert.match(analise!, /ninguém registrou o motivo \(0 de 2 leads sem consulta\)/);
  assert.match(analise!, /quem pagou antes — \(nenhum caso\)/);
});

test('análise: objeção só conta quem NÃO agendou; não fechar só conta quem não fechou', () => {
  const a = analisar({ ...JANELA, acha, truncado: false,
    criados: [lead({ [C.data]: 150 }), lead({ [C.motivo]: 'Outra cidade' }), lead({})],
    mexidos: [
      lead({ [C.data]: 150, [C.sit]: 'Atendido', [CAMPOS_ANALISE.fechouTratamento[0]]: 'Sim' }),
      lead({ [C.data]: 150, [C.sit]: 'Atendido', [C.naoFechou]: 'Achou caro' }),
    ] });
  assert.deepEqual([a.objecoes.registradas, a.objecoes.base], [1, 2], 'quem tem data de consulta não entra na base');
  assert.deepEqual([a.naoFechou.registradas, a.naoFechou.base], [1, 1], 'quem fechou não entra na base');
});

test('data: só aceita dia que existe', () => {
  assert.equal(dataValida('2026-09-30'), true);
  assert.equal(dataValida('2026-13-01'), false);
  assert.equal(dataValida('2026-02-30'), false);
  assert.equal(dataValida('30/09/2026'), false);
  assert.equal(dataValida(undefined), false);
});

test('erro para a chefe em palavras de gente; o técnico fica para o João', () => {
  assert.equal(motivoLegivel(new Error('listLeadsNaJanela(updated_at, 1759201200): Request failed with status code 429')), 'limite de chamadas atingido');
  assert.equal(motivoLegivel('403: IP nao autorizado'), 'acesso recusado');
  assert.equal(motivoLegivel(new Error('timeout of 30000ms exceeded')), 'não respondeu a tempo');
  assert.equal(motivoLegivel(new Error('502 Bad Gateway')), 'o sistema deles está com erro');
});

/* ───── coleta com fontes de mentira ───── */

const U = (slug: string): UnidadeParaColeta => ({ slug, name: slug, spineTimezone: 'America/Sao_Paulo' });

function fontes(o: Partial<Fontes> = {}): Fontes {
  return {
    agenda: async () => ({ ok: true, schedules: [ag(HOJE, SPINE_STATUS.ATENDIDO, 'AVALIAÇÃO')] }),
    tratamentos: async () => ({ ok: true, treatments: [] }),
    kommo: async () => ({ criados: [{ id: 1, created_at: 100 }, { id: 2, created_at: 100 }, { id: 3, created_at: 5 }], mexidos: [], acha: () => null, truncado: false }),
    dia: (_u, iso) => iso.slice(0, 10),
    calendario: () => ({ hoje: HOJE, amanha: AMANHA, deUnix: 50, ateUnix: 200, inicioJanela: '2026-09-24', janelaDeUnix: 1 }),
    ...o,
  };
}

test('coleta: cada fonte falha sozinha — Kommo fora não apaga a agenda', async () => {
  const r = await coletarUnidade(U('serra'), fontes({ kommo: async () => { throw new Error('403 Forbidden'); } }));
  assert.equal(r.leadsNovos, null);
  assert.equal(r.analise, null);
  assert.equal(r.agenda?.avaliacao.atendidas, 1);
  assert.equal(r.falhas.length, 1);
  assert.match(r.falhas[0]!, /Kommo não respondeu/);
});

test('coleta: leads novos = criados HOJE, não os 7 dias inteiros', async () => {
  const r = await coletarUnidade(U('serra'), fontes());
  assert.equal(r.leadsNovos, 2, 'o lead criado antes de hoje fica fora da conta do dia');
  assert.equal(r.analise?.leads.total, 3, 'mas entra na análise dos 7 dias');
});

test('coleta: franquia fora não apaga os leads, e explica o motivo', async () => {
  const r = await coletarUnidade(U('serra'), fontes({
    agenda: async () => ({ ok: false, error: '403: IP nao autorizado' }),
    tratamentos: async () => { throw new Error('timeout'); },
  }));
  assert.equal(r.leadsNovos, 2);
  assert.equal(r.agenda, null);
  assert.equal(r.tratamentos, null);
  assert.equal(r.falhas.length, 2);
  assert.equal(r.falhas[0], 'agenda da franquia não respondeu (acesso recusado)');
  assert.match(r.detalhes[0]!, /403: IP nao autorizado/, 'o erro cru vai para os detalhes');
  assert.ok(!r.falhas.join(' ').includes('403'), 'nada técnico no texto da chefe');
});

test('coleta da rede: nunca passa do limite de simultâneas e devolve todas as unidades', async () => {
  let ativas = 0, pico = 0;
  const f = fontes({
    agenda: async () => {
      ativas++; pico = Math.max(pico, ativas);
      await new Promise((r) => setTimeout(r, 15));
      ativas--;
      return { ok: true, schedules: [] };
    },
  });
  const r = await coletarRede(Array.from({ length: 9 }, (_, i) => U(`u${i}`)), f, { simultaneas: 2, pausaMs: 0 });
  assert.equal(r.length, 9);
  assert.ok(pico <= 2, `pico de ${pico} chamadas simultâneas à franquia`);
});

test('coleta da rede: unidade que trava vira aviso, e a outra fila segue trabalhando', async () => {
  const f = fontes({
    agenda: async (u) => {
      if (u.slug === 'lenta') await new Promise((r) => setTimeout(r, 400));
      return { ok: true, schedules: [] };
    },
  });
  const r = await coletarRede([U('a'), U('lenta'), U('b')], f, { simultaneas: 2, pausaMs: 0, limiteUnidadeMs: 60 });
  assert.equal(r.length, 3, 'as três voltam');
  const lenta = r.find((x) => x.slug === 'lenta')!;
  assert.equal(lenta.agenda, null);
  assert.match(lenta.falhas[0]!, /demorou mais de/);
  assert.equal(r.find((x) => x.slug === 'a')!.falhas.length, 0);
});

test('coleta: unidade sem Kommo conectado não é falha, só fica sem análise', async () => {
  const r = await coletarUnidade(U('serra'), fontes({ kommo: async () => null }));
  assert.equal(r.semKommo, true);
  assert.equal(r.analise, null);
  assert.equal(r.falhas.length, 0);
});

test('coleta da rede: unidade que estoura o tempo NÃO libera uma terceira em paralelo', async () => {
  let ativas = 0, pico = 0;
  const f = fontes({
    agenda: async (u) => {
      ativas++; pico = Math.max(pico, ativas);
      await new Promise((r) => setTimeout(r, u.slug === 'lenta' ? 120 : 10));
      ativas--;
      return { ok: true, schedules: [] };
    },
  });
  await coletarRede([U('lenta'), U('a'), U('b'), U('c'), U('d')], f, { simultaneas: 2, pausaMs: 0, limiteUnidadeMs: 30 });
  assert.ok(pico <= 2, `pico de ${pico} unidades ao mesmo tempo`);
});

/**
 * A armadilha que já custou um deploy verde que não fazia nada: rota pendurada DEPOIS do
 * `apiRouter.use(requireAuth)` nunca lê a chave de serviço. O n8n receberia 401 para sempre.
 */
test('rota: está montada ACIMA do requireAuth global, senão a chave de serviço nunca vale', () => {
  const src = readFileSync(new URL('../routes/api.routes.ts', import.meta.url), 'utf8');
  const rota = src.indexOf("apiRouter.get('/relatorios/rede-diaria'");
  const guarda = src.indexOf('apiRouter.use(requireAuth)');
  assert.ok(rota > 0, 'rota não encontrada');
  assert.ok(guarda > 0, 'apiRouter.use(requireAuth) não encontrado');
  assert.ok(rota < guarda, 'a rota tem de vir antes do use(requireAuth)');
  assert.match(src, /'\/relatorios\/rede-diaria',\s*chaveDeServicoOuSessao\(requireAuth, requireSuperAdmin\)/);
});
