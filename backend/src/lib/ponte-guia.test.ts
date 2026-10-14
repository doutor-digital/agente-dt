import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { KommoApiError } from '../services/kommo.service.js';
import {
  AVISO_DOS_ROBOS,
  CAMPO_PENDENCIA,
  ETIQUETA_SEM_MENSAGEM,
  campoDaSdr,
  campoPorNome,
  ehCabecalho,
  etapasQueCobram,
  gravarCamposPelaPonte,
  guiaDoCartao,
  lerPedidoDeCampos,
  lerPedidoDeMover,
  limparTetoDeMovimentos,
  meiaNoiteNoFuso,
  mensagensDaUnidade,
  montarGuia,
  motivoDePerdaCasado,
  moverPelaPonte,
  notaDoMovimento,
  obrigatoriosParaEntrar,
  planejarCampos,
  quemPreenche,
  type CartaoDoGuia,
  type ContaDoGuia,
  type FunilDoGuia,
  type KommoDoGuia,
  type PedidoDeMover,
} from './ponte-guia.js';
import type { DefinicaoDeCampo } from './ponte-ligacao.js';

// O mesmo `guia.js` que a extensão carrega: o aviso dos robôs e a leitura do número digitado são os mesmos.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const daExtensao = createRequire(import.meta.url)(new URL('guia.js', EXTENSAO).pathname) as {
  AVISO_DOS_ROBOS: string;
  numeroDigitado(v: string): number | null;
};

const TZ = 'America/Sao_Paulo';

// ── Açailândia, como está na conta (funis e ids de etapa conferidos pelo MCP só-leitura em 14/10/2026) ──
const COM = 13795975;
const TRAT = 14304315;
const ST = {
  entrada: 106446875,
  qualificacao: 106809907,
  espera: 111237819,
  conferir: 112480015,
  agendado: 106809915,
  naoCompareceu: 110846015,
  compareceu: 110468747,
  negociacao: 106810351,
  retorno: 106810363,
  ganho: 142,
  perdido: 143,
  emTratamento: 110468755,
} as const;

const FUNIS: FunilDoGuia[] = [
  {
    id: COM,
    name: 'COMERCIAL',
    is_main: true,
    statuses: [
      { id: ST.entrada, name: 'Incoming leads', sort: 10, type: 1 },
      { id: ST.qualificacao, name: 'EM QUALIFICAÇÃO', sort: 20, type: 0 },
      { id: ST.espera, name: 'EM ESPERA', sort: 30, type: 0 },
      { id: ST.conferir, name: 'CONFERIR NA FRANQUIA', sort: 40, type: 0 },
      { id: ST.agendado, name: 'AGENDADO', sort: 50, type: 0 },
      { id: ST.naoCompareceu, name: 'NÃO COMPARECEU', sort: 60, type: 0 },
      { id: ST.compareceu, name: 'COMPARECEU', sort: 70, type: 0 },
      { id: ST.negociacao, name: 'EM NEGOCIAÇÃO', sort: 80, type: 0 },
      { id: ST.retorno, name: 'RETORNO PÓS-TRATAMENTO', sort: 90, type: 0 },
      { id: ST.ganho, name: 'GANHO / CONCLUIDO', sort: 10000, type: 0 },
      { id: ST.perdido, name: 'PERDIDO', sort: 11000, type: 0 },
    ],
  },
  {
    id: TRAT,
    name: 'TRATAMENTO',
    statuses: [
      { id: 110468751, name: 'Incoming leads', sort: 10, type: 1 },
      { id: ST.emTratamento, name: 'EM TRATAMENTO', sort: 20, type: 0 },
      { id: 142, name: 'ALTA', sort: 10000, type: 0 },
      { id: 143, name: 'TRATAMENTO CANCELADO', sort: 11000, type: 0 },
    ],
  },
];

const em = (...l: Array<[number, number]>) => l.map(([pipeline_id, status_id]) => ({ pipeline_id, status_id }));
const todasMenos = (...fica: number[]) => em(...FUNIS[0].statuses.filter((s) => !fica.includes(s.id)).map((s) => [COM, s.id] as [number, number]));

/** Os campos da Açailândia que importam ao guia (ids reais do cartão; obrigatórios como a API devolve). */
const DEFS: DefinicaoDeCampo[] = [
  { id: 2459001, name: '*EM QUALIFICAÇÃO*', type: 'text', sort: 100 },
  { id: 2449912, name: '★ Qualificação (Quente/Morno/Frio)', type: 'select', sort: 101, enums: [{ id: 1845412, value: 'Quente' }, { id: 1845414, value: 'Morno' }, { id: 1845416, value: 'Frio' }] },
  { id: 2449910, name: '✎ Queixa', type: 'textarea', sort: 103 },
  { id: 2449924, name: '✎ Observações', type: 'textarea', sort: 104, hidden_statuses: todasMenos(ST.qualificacao) },
  { id: 2459002, name: '*EM ESPERA*', type: 'text', sort: 110 },
  { id: 2454156, name: '⊘ Motivo da espera', type: 'select', sort: 111, enums: [{ id: 1852302, value: 'Exames' }, { id: 1852306, value: 'Viajando' }, { id: 1852312, value: 'Outro' }] },
  { id: 2454154, name: '◷ Retomar em', type: 'date', sort: 112 },
  { id: 2459003, name: '*AGENDADO*', type: 'text', sort: 120 },
  // ⚠ obrigatório "de teste" em AGENDADO, para provar o cumulativo (na Açailândia de verdade, o de AGENDADO não grudou)
  { id: 2449931, name: '⬢ Tipo de agendamento', type: 'select', sort: 121, enums: [{ id: 1845440, value: 'Cadastro' }, { id: 1845442, value: 'Resgate' }], required_statuses: em([COM, ST.agendado]) },
  { id: 2449930, name: '¤ Valor da Consulta', type: 'monetary', sort: 122, required_statuses: em([COM, ST.ganho], [TRAT, ST.emTratamento]) },
  { id: 2449932, name: '¤ Pagamento antecipado', type: 'select', sort: 123, enums: [{ id: 1845450, value: 'Sim' }, { id: 1845452, value: 'Não' }] },
  { id: 2449934, name: '◷ Data da Consulta', type: 'date_time', sort: 124, is_api_only: true },
  { id: 2459004, name: '## CONSULTA', type: 'text', sort: 125 },
  { id: 2449950, name: '⚕ Tratamento indicado', type: 'select', sort: 130, enums: [{ id: 1845460, value: 'Programa 10 sessões' }], required_statuses: em([COM, ST.compareceu]) },
  { id: 2459970, name: '⊘ Motivo da falta', type: 'select', sort: 135, enums: [{ id: 1863200, value: 'Esqueceu' }] },
  { id: 2449884, name: '⊘ Motivo de não fechamento do tratamento', type: 'select', sort: 140, enums: [{ id: 1864274, value: 'Sem resposta após consulta' }] },
  { id: 2449960, name: '◉ Semáforo', type: 'select', sort: 150, enums: [{ id: 1845480, value: 'VERDE' }], required_statuses: em([COM, ST.ganho]) },
  { id: 2449942, name: '⊘ Motivo do não agendamento', type: 'select', sort: 160, enums: [{ id: 1845470, value: 'Não deu continuidade ao atendimento' }, { id: 1845472, value: 'Sem interesse' }] },
  // ⚠ obrigatório no ALTA (142 do TRATAMENTO): NÃO pode contar para o GANHO (142 do COMERCIAL)
  { id: 2449990, name: '✓ Deixou avaliação (Google)', type: 'select', sort: 170, enums: [{ id: 1, value: 'Sim' }], required_statuses: em([TRAT, 142]) },
  { id: 2459990, name: CAMPO_PENDENCIA, type: 'textarea', sort: 900 },
  { id: 2449974, name: 'Pausar IA', type: 'checkbox', sort: 901 },
  { id: 2449998, name: '⚑ Origem', type: 'select', sort: 950, is_api_only: true, enums: [{ id: 1845680, value: 'Meta-Instagram' }] },
  { id: 2448888, name: '☎ Resultado', type: 'select', sort: 960, enums: [{ id: 1843630, value: 'Atendida' }] },
];

const CONTA_ACAI = { slug: 'doutor-hernia-acailandia', kommoSubdomain: 'doutorherniaacailandia' };

function conta(extra: Partial<ContaDoGuia> = {}, defs: DefinicaoDeCampo[] = DEFS): ContaDoGuia {
  return { conta: 'doutorherniaacailandia', defs, funis: FUNIS, tz: TZ, mensagens: mensagensDaUnidade(CONTA_ACAI, {}), ...extra };
}

function cartao(statusId: number, valores: Record<number, { value?: unknown; enum_id?: number }> = {}, extra: Partial<CartaoDoGuia> = {}): CartaoDoGuia {
  return {
    id: 28593652,
    name: 'Paciente de Teste 14/10/2026',
    pipeline_id: COM,
    status_id: statusId,
    custom_fields_values: Object.entries(valores).map(([id, v]) => ({ field_id: Number(id), values: [v] })),
    _embedded: { tags: [] },
    ...extra,
  };
}

/** Um Kommo falso que guarda o cartão e aplica o que for gravado. */
function kommoFalso(inicial: CartaoDoGuia, opcoes: { naoMove?: boolean; naoGrava?: boolean; moverFalha?: boolean } = {}) {
  let lead: CartaoDoGuia = JSON.parse(JSON.stringify(inicial));
  const chamadas: unknown[][] = [];
  const aplicar = (campos: Array<{ field_id: number; values: Array<Record<string, unknown>> | null }>) => {
    if (opcoes.naoGrava) return;
    const outros = (lead.custom_fields_values ?? []).filter((c) => !campos.some((g) => g.field_id === c.field_id));
    lead = { ...lead, custom_fields_values: [...outros, ...campos.filter((c) => c.values).map((c) => ({ field_id: c.field_id, values: c.values as Array<{ value?: unknown; enum_id?: number }> }))] };
  };
  const k: KommoDoGuia & { chamadas: unknown[][]; atual(): CartaoDoGuia } = {
    chamadas,
    atual: () => lead,
    getLead: async (id) => {
      chamadas.push(['ler', id]);
      return JSON.parse(JSON.stringify(lead));
    },
    gravarCamposDoLead: async (id, campos) => {
      chamadas.push(['campos', id, campos]);
      aplicar(campos);
    },
    moverCartao: async (id, p) => {
      chamadas.push(['mover', id, p]);
      if (opcoes.moverFalha) throw new KommoApiError('moverCartao: 502', 502, {});
      if (p.campos) aplicar(p.campos);
      if (!opcoes.naoMove) lead = { ...lead, status_id: p.statusId, pipeline_id: p.pipelineId };
    },
    addLeadNote: async (id, texto) => {
      chamadas.push(['nota', id, texto]);
      return { id: 1 };
    },
    listLossReasons: async () => {
      chamadas.push(['motivos']);
      return [{ id: 37797716, name: 'Sem interesse' }, { id: 37797696, name: 'Não interagiu' }];
    },
  };
  return k;
}

const mover = (de: number, para: number, extra: Partial<PedidoDeMover> = {}): PedidoDeMover => ({ leadId: 28593652, de, para, campos: [], por: 'Ana', confirmado: true, ...extra });
const nomes = (l: Array<{ nome: string }>) => l.map((c) => c.nome);
const escritas = (k: { chamadas: unknown[][] }) => k.chamadas.filter((c) => c[0] === 'campos' || c[0] === 'mover');

beforeEach(() => limparTetoDeMovimentos());

describe('guia da Ponte — obrigatório é CUMULATIVO', () => {
  it('entrar numa etapa cobra os obrigatórios dela e de TODAS as de antes; GANHO o funil inteiro; PERDIDO só o dele', () => {
    const com = FUNIS[0];
    assert.deepEqual([...etapasQueCobram(com, ST.compareceu)].sort(), [ST.entrada, ST.qualificacao, ST.espera, ST.conferir, ST.agendado, ST.naoCompareceu, ST.compareceu].sort());
    assert.ok(!etapasQueCobram(com, ST.compareceu).has(ST.negociacao), 'etapa DEPOIS não conta');
    assert.ok(etapasQueCobram(com, ST.ganho).has(ST.retorno) && !etapasQueCobram(com, ST.ganho).has(ST.perdido));
    assert.deepEqual([...etapasQueCobram(com, ST.perdido)], [ST.perdido]);

    assert.deepEqual(obrigatoriosParaEntrar(DEFS, com, ST.agendado).map((d) => d.name), ['⬢ Tipo de agendamento']);
    assert.deepEqual(obrigatoriosParaEntrar(DEFS, com, ST.compareceu).map((d) => d.name), ['⬢ Tipo de agendamento', '⚕ Tratamento indicado']);
    // GANHO: tudo do COMERCIAL (Valor da Consulta e Semáforo são de GANHO) — e o 142 do TRATAMENTO (ALTA) não conta
    assert.deepEqual(obrigatoriosParaEntrar(DEFS, com, ST.ganho).map((d) => d.name).sort(), ['¤ Valor da Consulta', '⚕ Tratamento indicado', '⬢ Tipo de agendamento', '◉ Semáforo'].sort());
    assert.deepEqual(obrigatoriosParaEntrar(DEFS, com, ST.perdido), []);
    // o 142 do TRATAMENTO é o ALTA: cobra o dele e o de EM TRATAMENTO (Valor da Consulta), nunca o Semáforo do GANHO
    assert.deepEqual(obrigatoriosParaEntrar(DEFS, FUNIS[1], 142).map((d) => d.name), ['¤ Valor da Consulta', '✓ Deixou avaliação (Google)']);
  });

  it('mover AGENDADO → COMPARECEU cobra o obrigatório de AGENDADO também (e o PATCH não sai sem ele)', async () => {
    const k = kommoFalso(cartao(ST.agendado));
    const r = await moverPelaPonte(conta(), k, mover(ST.agendado, ST.compareceu, { campos: [{ id: 2449950, valor: 1845460 }] }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 422);
    assert.deepEqual(nomes(r.faltam ?? []), ['⬢ Tipo de agendamento']);
    assert.match(r.erro, /falta preencher: ⬢ Tipo de agendamento/);
    assert.deepEqual(escritas(k), [], 'nada foi gravado nem movido');
  });
});

describe('guia da Ponte — campo obrigatório faltando bloqueia o mover', () => {
  it('COMPARECEU sem ⚕ Tratamento indicado: 422 com o que falta, e nada vai para o Kommo', async () => {
    const k = kommoFalso(cartao(ST.agendado, { 2449931: { enum_id: 1845440 } }));
    const r = await moverPelaPonte(conta(), k, mover(ST.agendado, ST.compareceu));
    assert.ok(!r.ok && r.status === 422);
    if (r.ok) return;
    assert.deepEqual(nomes(r.faltam ?? []), ['⚕ Tratamento indicado']);
    assert.equal(r.faltam?.[0].editavel, true, 'a SDR pode preencher ali mesmo');
    assert.deepEqual(escritas(k), []);
  });

  it('com o campo no mesmo pedido: UM PATCH (etapa + campo), relê o cartão, e a nota diz quem fez', async () => {
    const k = kommoFalso(cartao(ST.agendado, { 2449931: { enum_id: 1845440 } }));
    const r = await moverPelaPonte(conta(), k, mover(ST.agendado, ST.compareceu, { campos: [{ id: 2449950, valor: 1845460 }] }));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    const [mov, ...outras] = escritas(k);
    assert.equal(outras.length, 0, 'um PATCH só');
    assert.deepEqual(mov, ['mover', 28593652, { statusId: ST.compareceu, pipelineId: COM, campos: [{ field_id: 2449950, values: [{ enum_id: 1845460 }] }], lossReasonId: null }]);
    assert.equal(k.atual().status_id, ST.compareceu);
    assert.equal(r.para, 'COMPARECEU');
    assert.equal(r.guia.etapa, 'COMPARECEU', 'o guia que volta é o do cartão relido');
    const nota = k.chamadas.find((c) => c[0] === 'nota')?.[2] as string;
    assert.equal(nota, '➜ Etapa mudada pela Ponte: AGENDADO → COMPARECEU · por Ana\nPreenchido junto: ⚕ Tratamento indicado = Programa 10 sessões');
    // depois de gravar, RELÊ
    assert.ok(k.chamadas.filter((c) => c[0] === 'ler').length >= 2);
  });

  it('o que a saída PEDE também trava: EM ESPERA sem ◷ Retomar em não sai', async () => {
    const k = kommoFalso(cartao(ST.qualificacao));
    const r = await moverPelaPonte(conta(), k, mover(ST.qualificacao, ST.espera, { campos: [{ id: 2454156, valor: 1852306 }] }));
    assert.ok(!r.ok && r.status === 422);
    if (r.ok) return;
    assert.deepEqual(nomes(r.faltam ?? []), ['◷ Retomar em']);
    assert.deepEqual(escritas(k), []);
  });

  it('AGENDADO sem ◷ Data da Consulta: a Ponte não inventa consulta (quem preenche é a franquia)', async () => {
    const g = montarGuia({ lead: cartao(ST.qualificacao), defs: DEFS, funis: FUNIS, tz: TZ });
    const agendado = g.saidas.find((s) => s.nome === 'AGENDADO')!;
    const data = agendado.faltam.find((c) => c.nome === '◷ Data da Consulta')!;
    assert.equal(data.editavel, false);
    assert.match(data.dica ?? '', /Marque a consulta primeiro/);
    assert.match(agendado.bloqueio ?? '', /Ainda não dá para mover: ◷ Data da Consulta/);

    const k = kommoFalso(cartao(ST.qualificacao));
    const r = await moverPelaPonte(conta(), k, mover(ST.qualificacao, ST.agendado, { campos: [{ id: 2449934, valor: '2026-10-20' }] }));
    assert.ok(!r.ok && r.status === 403, 'nem dá para mandar a data pela Ponte');
    assert.deepEqual(escritas(k), []);
  });
});

describe('guia da Ponte — consulta que já passou não serve para AGENDADO', () => {
  const AGORA = new Date('2026-10-14T15:00:00.000Z');
  const ontem = meiaNoiteNoFuso('2026-10-13', TZ);
  const amanha = meiaNoiteNoFuso('2026-10-15', TZ) + 9 * 3600;

  it('NÃO COMPARECEU → AGENDADO ("Remarcou") com a consulta de ontem no cartão: trava, e diz para marcar a nova', async () => {
    const lead = cartao(ST.naoCompareceu, { 2449931: { enum_id: 1845440 }, 2449934: { value: ontem } });
    const g = montarGuia({ lead, defs: DEFS, funis: FUNIS, tz: TZ, agora: AGORA });
    const remarcou = g.saidas.find((x) => x.nome === 'AGENDADO')!;
    assert.equal(remarcou.rotulo, 'Remarcou a consulta');
    assert.match(remarcou.bloqueio ?? '', /\(13\/10\/2026\) já passou: marque a nova consulta primeiro/);
    const k = kommoFalso(lead);
    const r = await moverPelaPonte(conta({ agora: AGORA }), k, mover(ST.naoCompareceu, ST.agendado));
    assert.ok(!r.ok && r.status === 422);
    if (!r.ok) assert.match(r.erro, /já passou/);
    assert.deepEqual(escritas(k), []);
  });

  it('com a consulta nova (amanhã) no cartão, move', async () => {
    const lead = cartao(ST.naoCompareceu, { 2449931: { enum_id: 1845440 }, 2449934: { value: amanha } });
    assert.equal(montarGuia({ lead, defs: DEFS, funis: FUNIS, tz: TZ, agora: AGORA }).saidas.find((x) => x.nome === 'AGENDADO')?.bloqueio, null);
    const r = await moverPelaPonte(conta({ agora: AGORA }), kommoFalso(lead), mover(ST.naoCompareceu, ST.agendado));
    assert.ok(r.ok, JSON.stringify(r));
  });

  it('AGENDADO → EM ESPERA ou PERDIDO lembra de desmarcar na franquia (a Ponte não mexe lá)', () => {
    const g = montarGuia({ lead: cartao(ST.agendado), defs: DEFS, funis: FUNIS, tz: TZ });
    for (const nome of ['EM ESPERA', 'PERDIDO']) {
      assert.match(g.saidas.find((x) => x.nome === nome)!.dicas.join(' '), /desmarque a consulta lá também/, nome);
    }
  });
});

describe('guia da Ponte — cabeçalho nunca é alvo', () => {
  it('"##…" e "*…*" são cabeçalho; "# Idade" (número) não', () => {
    for (const n of ['## CONSULTA', '##^Paciente', '##Paciente', '*AGENDADO*', '*AUTOMÁTICO · NÃO PREENCHER', '  ## X']) assert.equal(ehCabecalho(n), true, n);
    for (const n of ['# Idade', '# Nº de faltas', '✎ Queixa', '⊘ Motivo da espera']) assert.equal(ehCabecalho(n), false, n);
  });

  it('cabeçalho não é campo da SDR, não é achado pelo nome e é recusado no gravar (mesmo se a conta o marcasse obrigatório)', () => {
    const comCabecalhoObrigatorio = DEFS.map((d) => (d.name === '## CONSULTA' ? { ...d, required_statuses: em([COM, ST.qualificacao]) } : d));
    const cab = comCabecalhoObrigatorio.find((d) => d.name === '## CONSULTA')!;
    assert.equal(campoDaSdr(cab), false);
    assert.equal(campoPorNome(comCabecalhoObrigatorio, 'CONSULTA'), null, 'o nome normalizado "consulta" não acha o cabeçalho');
    assert.deepEqual(obrigatoriosParaEntrar(comCabecalhoObrigatorio, FUNIS[0], ST.qualificacao), []);
    const g = montarGuia({ lead: cartao(ST.qualificacao), defs: comCabecalhoObrigatorio, funis: FUNIS, tz: TZ });
    assert.ok(!g.faltam.some((c) => c.nome.startsWith('#') || c.nome.startsWith('*')), 'o guia não lista cabeçalho');

    for (const id of [2459004, 2459001]) {
      const r = planejarCampos(comCabecalhoObrigatorio, cartao(ST.qualificacao), [{ id, valor: 'x' }], TZ);
      assert.ok(!r.ok && r.status === 403, String(id));
      if (!r.ok) assert.match(r.erro, /é só um título do cartão/);
    }
  });

  it('campo que não é da SDR é recusado: franquia, sistema, "Apenas API", ☎ (tem rota própria)', () => {
    const casos: Array<[number, RegExp]> = [
      [2449934, /quem preenche é a franquia/],
      [2459990, /quem preenche é o sistema/],
      [2449974, /quem preenche é o sistema/],
      [2449998, /quem preenche é o sistema/],
      [2448888, /quem preenche é o sistema/],
    ];
    for (const [id, erro] of casos) {
      const r = planejarCampos(DEFS, cartao(ST.qualificacao), [{ id, valor: 'x' }], TZ);
      assert.ok(!r.ok && r.status === 403, String(id));
      if (!r.ok) assert.match(r.erro, erro, String(id));
    }
    assert.equal(quemPreenche(DEFS.find((d) => d.id === 2449934)!), 'franquia', 'da franquia, mesmo "Apenas API"');
    assert.equal(quemPreenche(DEFS.find((d) => d.id === 2449998)!), 'robo', '"Apenas API" que não é da franquia');
    assert.equal(quemPreenche({ id: 1, name: '✓ Situação da consulta', type: 'select' }), 'franquia');
    // ⚑ Origem vira da SDR só quando a conta o exige (Imperatriz exige na qualificação)
    assert.equal(campoDaSdr({ id: 2, name: '⚑ Origem', type: 'select', required_statuses: em([COM, ST.qualificacao]) }), true);
    assert.equal(campoDaSdr({ id: 2, name: '⚑ Origem', type: 'select' }), false);
  });
});

describe('guia da Ponte — o que o guia mostra (Açailândia, EM QUALIFICAÇÃO)', () => {
  const lead = cartao(ST.qualificacao, { 2459990: { value: 'Fechou tratamento sem ¤ Valor do tratamento' }, 2449910: { value: 'Dor lombar' } });
  const g = montarGuia({ lead, defs: DEFS, funis: FUNIS, tz: TZ, mensagens: mensagensDaUnidade(CONTA_ACAI, {}) });

  it('a ⚠ Pendência (campo oculto no Kommo) aparece', () => {
    assert.equal(g.pendencia, 'Fechou tratamento sem ¤ Valor do tratamento');
    assert.equal(g.unidade, null, 'Açailândia não tem o campo de unidade');
  });

  it('nesta etapa: só os campos da SDR vazios e visíveis aqui (nada de franquia, robô ou anúncio)', () => {
    assert.deepEqual(nomes(g.faltam), ['★ Qualificação (Quente/Morno/Frio)', '✎ Observações']);
    assert.ok(g.faltam.every((c) => c.editavel && c.quem === 'sdr'));
    assert.deepEqual(g.faltam[0].opcoes?.map((o) => o.valor), ['Quente', 'Morno', 'Frio']);
    // ✎ Observações está ESCONDIDO em EM ESPERA: lá não aparece
    const naEspera = montarGuia({ lead: cartao(ST.espera), defs: DEFS, funis: FUNIS, tz: TZ });
    assert.ok(!naEspera.faltam.some((c) => c.nome === '✎ Observações'));
    assert.deepEqual(nomes(naEspera.faltam), ['⊘ Motivo da espera', '◷ Retomar em']);
  });

  it('as saídas: AGENDADO, EM ESPERA, PERDIDO — com o que cada uma pede, o aviso dos robôs e as mensagens conhecidas', () => {
    assert.deepEqual(g.saidas.map((s) => [s.nome, s.rotulo]), [
      ['AGENDADO', 'Marcou a consulta'],
      ['EM ESPERA', 'Quer, mas depois'],
      ['PERDIDO', 'Não vai seguir'],
    ]);
    const espera = g.saidas[1];
    assert.deepEqual(nomes(espera.faltam), ['⊘ Motivo da espera', '◷ Retomar em']);
    assert.equal(espera.bloqueio, null, 'tudo que falta a SDR preenche ali');
    assert.match(espera.mensagens.join(' '), /Retomar em/);
    const perdido = g.saidas[2];
    assert.deepEqual(nomes(perdido.faltam), ['⊘ Motivo do não agendamento']);
    assert.match(perdido.dicas.join(' '), new RegExp(ETIQUETA_SEM_MENSAGEM));
    assert.match(perdido.mensagens.join(' '), /2 dias depois/);
    assert.equal(g.avisoDosRobos, 'Ao mover, os robôs desta etapa podem mandar mensagem ao paciente.');
    assert.equal(daExtensao.AVISO_DOS_ROBOS, AVISO_DOS_ROBOS, 'o mesmo aviso na extensão');
  });

  it('PERDIDO depois da consulta (motivo no ⊘ de não fechamento): o outro ⊘ não vira pendência', () => {
    const semMotivo = montarGuia({ lead: cartao(ST.perdido), defs: DEFS, funis: FUNIS, tz: TZ });
    assert.deepEqual(nomes(semMotivo.faltam), ['⊘ Motivo do não agendamento']);
    const comMotivo = montarGuia({ lead: cartao(ST.perdido, { 2449884: { enum_id: 1864274 } }), defs: DEFS, funis: FUNIS, tz: TZ });
    assert.deepEqual(nomes(comMotivo.faltam), []);
    assert.deepEqual(comMotivo.saidas.map((x) => x.nome), ['EM QUALIFICAÇÃO', 'EM ESPERA']);
  });

  it('com a etiqueta NO_FOLLOW_UP no cartão, a dica do PERDIDO some', () => {
    const comTag = montarGuia({ lead: cartao(ST.qualificacao, {}, { _embedded: { tags: [{ name: 'NO_FOLLOW_UP' }] } }), defs: DEFS, funis: FUNIS, tz: TZ });
    assert.deepEqual(comTag.saidas.find((s) => s.statusId === ST.perdido)?.dicas, []);
  });

  it('AGENDADO: as saídas são compareceu, faltou, desmarcou (EM ESPERA) e perdido; nunca GANHO', () => {
    const ag = montarGuia({ lead: cartao(ST.agendado, { 2449931: { enum_id: 1845440 } }), defs: DEFS, funis: FUNIS, tz: TZ });
    assert.deepEqual(ag.saidas.map((s) => s.nome), ['COMPARECEU', 'NÃO COMPARECEU', 'EM ESPERA', 'PERDIDO']);
    assert.ok(!ag.saidas.some((s) => s.statusId === ST.ganho));
    // NÃO COMPARECEU sugere o motivo da falta (sem travar)
    const falta = ag.saidas.find((s) => s.nome === 'NÃO COMPARECEU')!;
    assert.deepEqual(nomes(falta.faltam), []);
    assert.deepEqual(nomes(falta.sugere), ['⊘ Motivo da falta']);
  });

  it('GANHO, RETORNO e o funil TRATAMENTO não têm saída pela Ponte (são da franquia e dos robôs)', () => {
    for (const st of [ST.ganho, ST.retorno]) {
      const x = montarGuia({ lead: cartao(st), defs: DEFS, funis: FUNIS, tz: TZ });
      assert.deepEqual(x.saidas, [], String(st));
      assert.match(x.semSaidas ?? '', /da franquia e dos robôs/);
    }
    const trat = montarGuia({ lead: cartao(ST.emTratamento, {}, { pipeline_id: TRAT }), defs: DEFS, funis: FUNIS, tz: TZ });
    assert.deepEqual(trat.saidas, []);
    assert.equal(trat.noComercial, false);
  });
});

describe('guia da Ponte — não move para GANHO nem TRATAMENTO, e só com confirmação', () => {
  it('destino GANHO, RETORNO ou fora das saídas: 403 e nada no Kommo', async () => {
    for (const para of [ST.ganho, ST.retorno, ST.negociacao]) {
      const k = kommoFalso(cartao(ST.qualificacao));
      const r = await moverPelaPonte(conta(), k, mover(ST.qualificacao, para));
      assert.ok(!r.ok && r.status === 403, String(para));
      assert.deepEqual(escritas(k), []);
    }
  });

  it('cartão no funil TRATAMENTO: 409 (a Ponte só move no COMERCIAL)', async () => {
    const k = kommoFalso(cartao(ST.emTratamento, {}, { pipeline_id: TRAT }));
    const r = await moverPelaPonte(conta(), k, mover(ST.emTratamento, 143));
    assert.ok(!r.ok && r.status === 409);
    if (!r.ok) assert.match(r.erro, /só move cartão no COMERCIAL/);
    assert.deepEqual(escritas(k), []);
  });

  it('sem `confirmado`: 409 pedindo confirmação, sem nem ler o cartão', async () => {
    const k = kommoFalso(cartao(ST.qualificacao));
    const r = await moverPelaPonte(conta(), k, mover(ST.qualificacao, ST.perdido, { confirmado: false }));
    assert.ok(!r.ok && r.status === 409 && r.precisaConfirmar);
    assert.deepEqual(k.chamadas, []);
  });

  it('o cartão mudou de etapa desde que o guia abriu: 409, não move', async () => {
    const k = kommoFalso(cartao(ST.agendado));
    const r = await moverPelaPonte(conta(), k, mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(!r.ok && r.status === 409);
    if (!r.ok) assert.match(r.erro, /mudou de etapa \(agora está em AGENDADO\)/);
    assert.deepEqual(escritas(k), []);
  });

  it('PERDIDO com "Sem interesse": vai junto o motivo de perda do Kommo com o mesmo nome', async () => {
    const k = kommoFalso(cartao(ST.qualificacao));
    const r = await moverPelaPonte(conta({ motivosDePerda: () => k.listLossReasons() }), k, mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.motivoDePerda, 'Sem interesse');
    const mov = escritas(k)[0][2] as { lossReasonId: number; statusId: number };
    assert.equal(mov.lossReasonId, 37797716);
    assert.equal(mov.statusId, ST.perdido);
    assert.equal(motivoDePerdaCasado('Não deu continuidade ao atendimento', [{ id: 1, name: 'Sem interesse' }]), null, 'sem nome igual, vai sem');
  });

  it('o Kommo aceitou mas o cartão não andou: erro, e a vaga do teto volta', async () => {
    const k = kommoFalso(cartao(ST.qualificacao), { naoMove: true });
    const r = await moverPelaPonte(conta({ teto: 1 }), k, mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(!r.ok && r.status === 502);
    // a vaga voltou: o próximo cabe no teto de 1
    const k2 = kommoFalso(cartao(ST.qualificacao));
    const r2 = await moverPelaPonte(conta({ teto: 1 }), k2, mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(r2.ok);
  });

  it('teto de movimentos por hora na conta: o segundo passa do teto e é recusado', async () => {
    const um = await moverPelaPonte(conta({ teto: 1 }), kommoFalso(cartao(ST.qualificacao)), mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(um.ok);
    const k = kommoFalso(cartao(ST.qualificacao));
    const dois = await moverPelaPonte(conta({ teto: 1 }), k, mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(!dois.ok && dois.status === 429);
    assert.deepEqual(escritas(k), []);
  });
});

describe('guia da Ponte — Petrópolis × Caxias: unidade vazia pede a unidade ANTES', () => {
  const UNIDADE = { id: 479786, name: '⌂ Unidade de atendimento', type: 'select', sort: 1, enums: [{ id: 386142, value: 'Petrópolis' }, { id: 386144, value: 'Caxias' }] };
  const DEFS_PETRO = [UNIDADE, ...DEFS];
  const contaPetro = () => conta({ conta: 'doutorhernialvp' }, DEFS_PETRO);

  it('o guia diz que falta a unidade (e as opções)', () => {
    const g = montarGuia({ lead: cartao(ST.qualificacao), defs: DEFS_PETRO, funis: FUNIS, tz: TZ });
    assert.deepEqual(g.unidade, { campoId: 479786, nome: '⌂ Unidade de atendimento', opcoes: [{ id: 386142, valor: 'Petrópolis' }, { id: 386144, valor: 'Caxias' }], valor: null, precisa: true });
    const ok = montarGuia({ lead: cartao(ST.qualificacao, { 479786: { enum_id: 386144 } }), defs: DEFS_PETRO, funis: FUNIS, tz: TZ });
    assert.equal(ok.unidade?.precisa, false);
    assert.equal(ok.unidade?.valor, 'Caxias');
  });

  it('gravar outro campo ou mover com a unidade vazia: 409 "escolha primeiro a unidade", nada gravado', async () => {
    const k = kommoFalso(cartao(ST.qualificacao));
    const c = await gravarCamposPelaPonte(contaPetro(), k, { leadId: 28593652, campos: [{ id: 2449924, valor: 'ligar à tarde' }], por: 'Ana' });
    assert.ok(!c.ok && c.status === 409 && c.precisaUnidade);
    const m = await moverPelaPonte(contaPetro(), k, mover(ST.qualificacao, ST.perdido, { campos: [{ id: 2449942, valor: 1845472 }] }));
    assert.ok(!m.ok && m.status === 409 && m.precisaUnidade);
    assert.deepEqual(escritas(k), []);
  });

  it('escolhida a unidade (no mesmo pedido ou antes), segue; trocar a unidade já escolhida é no Kommo', async () => {
    const k = kommoFalso(cartao(ST.qualificacao));
    const c = await gravarCamposPelaPonte(contaPetro(), k, { leadId: 28593652, campos: [{ id: 479786, valor: 386144 }, { id: 2449924, valor: 'ligar à tarde' }], por: 'Ana' });
    assert.ok(c.ok, JSON.stringify(c));
    if (c.ok) assert.deepEqual(c.gravados, [{ nome: '⌂ Unidade de atendimento', texto: 'Caxias' }, { nome: '✎ Observações', texto: 'ligar à tarde' }]);
    const troca = await gravarCamposPelaPonte(contaPetro(), k, { leadId: 28593652, campos: [{ id: 479786, valor: 386142 }], por: 'Ana' });
    assert.ok(!troca.ok && troca.status === 409);
    if (!troca.ok) assert.match(troca.erro, /para trocar, mude no Kommo/);
  });
});

describe('guia da Ponte — gravar campos', () => {
  it('grava só o que mudou (um PATCH), relê o cartão e deixa a nota de quem', async () => {
    const k = kommoFalso(cartao(ST.espera, { 2454156: { enum_id: 1852306 } }));
    const r = await gravarCamposPelaPonte(conta(), k, {
      leadId: 28593652,
      campos: [{ id: 2454156, valor: 1852306 }, { id: 2454154, valor: '2026-10-20' }],
      por: 'Ana',
    });
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual(r.iguais, ['⊘ Motivo da espera'], 'o que já estava igual não vai no PATCH');
    assert.deepEqual(escritas(k), [['campos', 28593652, [{ field_id: 2454154, values: [{ value: 1792465200 }] }]]]);
    assert.deepEqual(r.gravados, [{ nome: '◷ Retomar em', texto: '20/10/2026' }]);
    assert.equal(k.chamadas.find((c) => c[0] === 'nota')?.[2], '✎ Preenchido pela Ponte · por Ana: ◷ Retomar em = 20/10/2026');
    assert.equal(r.nota, true);
    assert.deepEqual(nomes(r.guia.faltam), [], 'o guia novo já não pede o que foi gravado');
  });

  it('nada mudou: não grava, não deixa nota', async () => {
    const k = kommoFalso(cartao(ST.espera, { 2454156: { enum_id: 1852306 } }));
    const r = await gravarCamposPelaPonte(conta(), k, { leadId: 28593652, campos: [{ id: 2454156, valor: 1852306 }], por: null });
    assert.ok(r.ok && r.gravados.length === 0 && r.nota === null);
    assert.deepEqual(escritas(k), []);
  });

  it('o Kommo aceitou mas o valor não aparece na releitura: erro (a SDR não fica achando que gravou)', async () => {
    const k = kommoFalso(cartao(ST.qualificacao), { naoGrava: true });
    const r = await gravarCamposPelaPonte(conta(), k, { leadId: 28593652, campos: [{ id: 2449924, valor: 'ligar à tarde' }], por: 'Ana' });
    assert.ok(!r.ok && r.status === 502);
    if (!r.ok) assert.match(r.erro, /✎ Observações não aparece no cartão/);
  });

  it('valores: texto, número em reais, data no fuso (meia-noite, como o Kommo guarda) e opção da lista', () => {
    // o "◷ Retomar em" de um cartão real da Açailândia (20/10/2026) vale 1792465200 = 20/10 00:00 em São Paulo
    assert.equal(meiaNoiteNoFuso('2026-10-20', TZ), 1792465200);
    assert.equal(meiaNoiteNoFuso('2026-10-20', 'America/Boa_Vista'), 1792465200 + 3600);
    const lead = cartao(ST.agendado);
    const r = planejarCampos(DEFS, lead, [{ id: 2449930, valor: 'R$ 1.250,50' }, { id: 2449932, valor: 1845450 }], TZ);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.gravar.map((g) => g.values), [[{ value: 1250.5 }], [{ enum_id: 1845450 }]]);
      assert.deepEqual(r.gravar.map((g) => g.texto), ['R$ 1.250,50', 'Sim']);
    }
    assert.equal(daExtensao.numeroDigitado('R$ 1.250,50'), 1250.5, 'a extensão lê o número do mesmo jeito');
    const erros: Array<[number, unknown, RegExp]> = [
      [2449930, 'duzentos', /digite só o número/],
      [2454154, '20/10/2026', /escolha a data no calendário/],
      [2454154, '2026-02-30', /escolha a data no calendário/],
      [2449932, 999, /escolha uma das opções/],
      [2449924, '   ', /escreva o texto/],
    ];
    for (const [id, valor, erro] of erros) {
      const x = planejarCampos(DEFS, cartao(ST.qualificacao), [{ id, valor }], TZ);
      assert.ok(!x.ok && x.status === 400, `${id} ${valor}`);
      if (!x.ok) assert.match(x.erro, erro);
    }
  });

  it('cartão apagado: 404', async () => {
    const k = kommoFalso(cartao(ST.qualificacao));
    k.getLead = async () => { throw new KommoApiError('getLead: 404', 404, {}); };
    const r = await guiaDoCartao(conta(), k, 1);
    assert.ok(!r.ok && r.status === 404);
  });
});

describe('guia da Ponte — pedidos e mensagens', () => {
  it('lê os pedidos: lead, etapas, campos (sem repetir), por e confirmado', () => {
    assert.deepEqual(lerPedidoDeMover({ leadId: '28593652', de: 106809907, para: 143, campos: [{ id: 2449942, valor: 1 }], por: '  Ana  ', confirmado: true }), {
      ok: true,
      pedido: { leadId: 28593652, de: 106809907, para: 143, campos: [{ id: 2449942, valor: 1 }], por: 'Ana', confirmado: true },
    });
    assert.equal(lerPedidoDeMover({ leadId: 1, de: 2, para: 3 }).ok && (lerPedidoDeMover({ leadId: 1, de: 2, para: 3 }) as { pedido: PedidoDeMover }).pedido.confirmado, false);
    assert.deepEqual(lerPedidoDeMover({ leadId: 1, para: 3 }), { ok: false, erro: 'etapa inválida' });
    assert.deepEqual(lerPedidoDeCampos({ leadId: 1, campos: [] }), { ok: false, erro: 'nenhum campo para gravar' });
    assert.deepEqual(lerPedidoDeCampos({ leadId: 1, campos: [{ id: 5, valor: 'a' }, { id: 5, valor: 'b' }] }), { ok: false, erro: 'campos inválidos' });
    assert.deepEqual(lerPedidoDeCampos({ leadId: 'x', campos: [{ id: 5, valor: 'a' }] }), { ok: false, erro: 'lead inválido' });
  });

  it('mensagens por etapa: as da conta (Açailândia) e a variável da unidade por cima; JSON ruim é ignorado', () => {
    const acai = mensagensDaUnidade(CONTA_ACAI, {});
    assert.ok((acai.get('agendado') ?? []).some((m) => /Pagamento antecipado/.test(m)));
    assert.equal(mensagensDaUnidade({ slug: 'doutor-hernia-serra', kommoSubdomain: 'drherniaserra' }, {}).size, 0, 'conta sem lista: só o aviso geral');
    const outra = mensagensDaUnidade(
      { slug: 'doutor-hernia-serra', kommoSubdomain: 'drherniaserra' },
      { PONTE_MENSAGENS_DA_ETAPA_DOUTOR_HERNIA_SERRA: JSON.stringify({ 'EM ESPERA': ['No Retomar em: a mensagem do motivo.'], PERDIDO: 'Em 2 dias: retomada.' }) },
    );
    assert.deepEqual(outra.get('emespera'), ['No Retomar em: a mensagem do motivo.']);
    assert.deepEqual(outra.get('perdido'), ['Em 2 dias: retomada.']);
    assert.equal(mensagensDaUnidade(CONTA_ACAI, { PONTE_MENSAGENS_DA_ETAPA_DOUTOR_HERNIA_ACAILANDIA: '{nada' }).get('agendado')?.length, acai.get('agendado')?.length);
  });

  it('nota do movimento sem nome: "por extensão Ponte"', () => {
    assert.equal(notaDoMovimento('EM QUALIFICAÇÃO', 'PERDIDO', [], null), '➜ Etapa mudada pela Ponte: EM QUALIFICAÇÃO → PERDIDO · por extensão Ponte');
  });
});
