/**
 * Auditoria de produção em Petrópolis (14/10/2026) — os três achados do sincronizador franquia → Kommo:
 *   1. a ficha (`GET /api/clients/{id}`) era relida a cada 15 min e a MESMA data de nascimento regravada;
 *   2. dois pacientes que dividem o WhatsApp gravavam, alternando, no mesmo cartão (1292772);
 *   3. a rua ia para `## ENDEREÇO` (o título do bloco) em vez de `⌂ Endereço`.
 *
 * Tudo contra uma franquia FALSA local (conta as leituras da ficha) e um Kommo falso (anota as gravações) —
 * nenhuma requisição sai da máquina.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Unit } from '@prisma/client';

import { _interno, camposDaConta, cartaoDeOutroPaciente, campoDaConta, idClientDoCartao, TAG_CONFLITO, type CampoBruto } from './franquia-sync-worker.js';
import { ehCabecalhoDeGrupo } from './franquia-sync.js';
import { nascimentoEmEpoch, idadeHoje } from './paciente-para-cartao.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';

// ── a franquia falsa ───────────────────────────────────────────────────────────
const fichas = new Map<number, Record<string, unknown>>();
const clientesNaBusca: Array<{ idClient: number; name: string; whatsapp: string }> = [];
let leiturasDaFicha: number[] = [];
let servidor: http.Server;
let base = '';

before(async () => {
  servidor = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const ficha = /^\/api\/clients\/(\d+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && ficha) {
      const id = Number(ficha[1]);
      leiturasDaFicha.push(id);
      res.end(JSON.stringify({ data: { data: fichas.get(id) ?? null } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/clients/search') {
      res.end(JSON.stringify({ data: { data: clientesNaBusca } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

let seqUnidade = 0;
/** Unidade nova por teste: a memória de "sem dado na ficha" é por unidade e não vaza de um teste pro outro. */
const unidade = () => ({ id: `unidade-teste-${++seqUnidade}`, slug: 'petropolis-teste', name: 'Teste', spineBaseUrl: base, spineToken: 'token-falso', spineTimezone: 'America/Sao_Paulo' }) as unknown as Unit;

// ── a conta do Kommo (como a de Petrópolis: o separador vem DEPOIS do campo de verdade) ──
const ID = { ENDERECO: 355944, SEPARADOR: 356004, SEXO: 1, NASC: 2, IDADE: 3, CIDADE: 4, ESTADO: 5, ORIGEM: 6, STATUS: 7, QUEIXA: 8, VALOR: 9, TRAT: 10, FISIO: 13, PREVISTAS: 14, ULTIMA: 15, COMPARECEU: 16, FALTAS: 17, IDCLIENT: 18 };
const CAMPOS_BRUTOS: CampoBruto[] = [
  { id: ID.ENDERECO, name: '⌂ Endereço', type: 'text' },
  { id: 900, name: '*PACIENTE*', type: 'text' },
  { id: ID.SEPARADOR, name: '## ENDEREÇO', type: 'text' },
  { id: ID.SEXO, name: '⚥ Sexo', type: 'select', enums: [{ id: 11, value: 'Feminino' }, { id: 12, value: 'Masculino' }] },
  { id: ID.NASC, name: '◷ Data de nascimento', type: 'date' },
  { id: ID.IDADE, name: '# Idade', type: 'numeric' },
  { id: ID.CIDADE, name: '⌂ Cidade', type: 'text' },
  { id: ID.ESTADO, name: '⌂ Estado', type: 'text' },
  { id: ID.ORIGEM, name: '⚑ Origem na franquia', type: 'text' },
  { id: ID.STATUS, name: '✓ Status do paciente', type: 'select', enums: [{ id: 71, value: 'Ativo' }] },
  { id: ID.QUEIXA, name: '✎ Queixa', type: 'textarea' },
  { id: ID.VALOR, name: '¤ Valor do tratamento', type: 'numeric' },
  { id: ID.TRAT, name: '⚕ Tratamento fechado', type: 'text' },
  { id: ID.FISIO, name: '⚕ Fisioterapeuta', type: 'select', enums: [{ id: 131, value: 'DRA. ANA LIMA' }] },
  { id: ID.PREVISTAS, name: '# Sessões previstas', type: 'numeric' },
  { id: ID.ULTIMA, name: '◷ Última sessão marcada', type: 'date' },
  { id: ID.COMPARECEU, name: '✓ Compareceu à última sessão marcada', type: 'select', enums: [{ id: 161, value: 'Sim' }, { id: 162, value: 'Não' }] },
  { id: ID.FALTAS, name: '# Nº de faltas em sessão', type: 'numeric' },
  { id: ID.IDCLIENT, name: '⚙ idClient (franquia)', type: 'numeric' },
  { id: 901, name: '##^Sessões', type: 'text' },
];
const CAMPOS = camposDaConta(CAMPOS_BRUTOS);

const epoch = (iso: string) => String(Date.parse(iso) / 1000);

function cartao(id: number, valores: Partial<Record<keyof typeof ID, string>>, tags: string[] = []): KommoLead {
  return {
    id,
    custom_fields_values: Object.entries(valores).map(([k, v]) => ({ field_id: ID[k as keyof typeof ID], values: [{ value: v }] })),
    _embedded: { tags: tags.map((name, i) => ({ id: i + 1, name })) },
  } as unknown as KommoLead;
}

/** O cartão "em dia" do jeito que a auditoria achou: tudo cheio menos os três campos que nunca se preenchem. */
function cartaoEmDia(id: number): KommoLead {
  return cartao(id, {
    SEXO: 'Feminino', NASC: epoch('1980-05-10T03:00:00Z'), IDADE: String(idadeHoje(nascimentoEmEpoch('1980-05-10'))),
    ENDERECO: 'Rua do Imperador, 100', CIDADE: 'Petrópolis', ESTADO: 'RJ', ORIGEM: 'Instagram', STATUS: 'Ativo',
    QUEIXA: 'DOR LOMBAR', VALOR: '1500', FISIO: 'DRA. ANA LIMA', ULTIMA: epoch('2026-10-01T12:00:00Z'), COMPARECEU: 'Sim',
    // vazios de propósito: ⚕ Tratamento fechado, # Nº de faltas em sessão, # Sessões previstas
  });
}

const FICHA = {
  idClient: 357882, name: 'PACIENTE TESTE', gender: 'F', birthdate: '10/05/1980', address: 'Rua do Imperador', addressNumber: '100',
  addressCity: 'Petrópolis', addressUf: 'RJ', source: 'Instagram', status: 'Ativo', schedules: [], treatments: [],
};

interface Gravacao { leadId: number; campo: number; valor: unknown }
function kommoFalso(extra: Partial<Record<string, unknown>> = {}) {
  const gravacoes: Gravacao[] = [];
  const etiquetas: Array<{ leadId: number; tags: string[] }> = [];
  const notas: Array<{ leadId: number; texto: string }> = [];
  const kommo = {
    setLeadCustomFieldValue: async (leadId: number, campo: number, _tipo: string, valor: unknown) => { gravacoes.push({ leadId, campo, valor }); },
    addTag: async ({ leadId, tags }: { leadId: number; tags: string[] }) => { etiquetas.push({ leadId, tags }); },
    addLeadNote: async (leadId: number, texto: string) => { notas.push({ leadId, texto }); return { id: 1 }; },
    ...extra,
  } as unknown as KommoClient;
  return { kommo, gravacoes, etiquetas, notas };
}

type Ctx = Parameters<typeof _interno.espelharPaciente>[0];
function varredura(unit: Unit, kommo: KommoClient): Ctx {
  return {
    unit, kommo, funis: null, mapa: {}, ops: { fisio: [], categoria: [], tratamento: [] }, agoraEpoch: Math.floor(Date.now() / 1000),
    resumo: { unit: unit.slug, em: '', agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 },
    camposPorNome: CAMPOS,
  } as Ctx;
}

// ── 1. regravação inútil + N+1 na franquia ─────────────────────────────────────
test('cartão em dia não lê a ficha nem regrava nada (os três campos que nunca se preenchem não pedem a ficha)', async () => {
  fichas.set(357882, FICHA);
  leiturasDaFicha = [];
  const unit = unidade();
  const { kommo, gravacoes } = kommoFalso();
  for (let v = 0; v < 3; v++) await _interno.espelharPaciente(varredura(unit, kommo), 1, cartaoEmDia(1), 357882);
  assert.deepEqual(leiturasDaFicha, [], 'nenhuma leitura da ficha em 3 varreduras');
  assert.deepEqual(gravacoes, [], 'nenhuma gravação no Kommo');
});

test('buraco que a franquia não tem como tapar: lê a ficha uma vez, não grava, e não relê na varredura seguinte', async () => {
  fichas.set(357883, { ...FICHA, idClient: 357883 }); // sem avaliação (queixa) e sem preço
  leiturasDaFicha = [];
  const unit = unidade();
  const { kommo, gravacoes } = kommoFalso();
  const semQueixaNemValor = () => {
    const l = cartaoEmDia(2);
    l.custom_fields_values = (l.custom_fields_values ?? []).filter((f) => f.field_id !== ID.QUEIXA && f.field_id !== ID.VALOR);
    return l;
  };
  await _interno.espelharPaciente(varredura(unit, kommo), 2, semQueixaNemValor(), 357883);
  assert.deepEqual(leiturasDaFicha, [357883], '1ª varredura: uma leitura');
  assert.deepEqual(gravacoes, [], 'nascimento igual (outro formato) não é regravado');
  for (let v = 0; v < 4; v++) await _interno.espelharPaciente(varredura(unit, kommo), 2, semQueixaNemValor(), 357883);
  assert.deepEqual(leiturasDaFicha, [357883], 'as 4 varreduras seguintes não relêem a ficha');

  // buraco NOVO (a SDR apagou a cidade): aí vale ler de novo, e a cidade volta
  const semCidade = semQueixaNemValor();
  semCidade.custom_fields_values = (semCidade.custom_fields_values ?? []).filter((f) => f.field_id !== ID.CIDADE);
  await _interno.espelharPaciente(varredura(unit, kommo), 2, semCidade, 357883);
  assert.deepEqual(leiturasDaFicha, [357883, 357883]);
  assert.deepEqual(gravacoes, [{ leadId: 2, campo: ID.CIDADE, valor: 'Petrópolis' }]);
});

test('a mesma ficha é lida no máximo uma vez por varredura', async () => {
  fichas.set(357884, { ...FICHA, idClient: 357884 });
  leiturasDaFicha = [];
  const unit = unidade();
  const { kommo } = kommoFalso();
  const ctx = varredura(unit, kommo);
  const vazio = (id: number) => cartao(id, {});
  await _interno.espelharPaciente(ctx, 3, vazio(3), 357884);
  await _interno.espelharPaciente(ctx, 4, vazio(4), 357884);
  assert.deepEqual(leiturasDaFicha, [357884]);
});

// ── 3. separador nunca é alvo ──────────────────────────────────────────────────
test('ehCabecalhoDeGrupo: os cabeçalhos do agrupamento NOVA, e só eles', () => {
  for (const n of ['## ENDEREÇO', '##ENDEREÇO', '##^Sessões', '##!', '*TRATAMENTO*', '*^KOMMO CRM*', '**!', '*!', '  ## CONSULTA']) {
    assert.equal(ehCabecalhoDeGrupo(n), true, n);
  }
  for (const n of ['⌂ Endereço', '# Idade', '# Nº de faltas em sessão', '◷ Data da Consulta', 'Endereço', '', null]) {
    assert.equal(ehCabecalhoDeGrupo(n), false, String(n));
  }
});

test('a rua vai para ⌂ Endereço, nunca para o separador ## ENDEREÇO', async () => {
  fichas.set(357885, { ...FICHA, idClient: 357885 });
  const unit = unidade();
  const { kommo, gravacoes } = kommoFalso();
  await _interno.espelharPaciente(varredura(unit, kommo), 5, cartao(5, {}), 357885);
  // (o número não vem: `fichaDoPaciente` não lê `addressNumber` — lacuna antiga, fora deste conserto)
  assert.ok(gravacoes.some((g) => g.campo === ID.ENDERECO && String(g.valor).startsWith('Rua do Imperador')), 'a rua foi para ⌂ Endereço');
  assert.ok(!gravacoes.some((g) => [ID.SEPARADOR, 900, 901].includes(g.campo)), 'nada foi gravado em cabeçalho');
});

test('cartão com a rua no separador (os 105 de Petrópolis): o ⌂ Endereço vazio é preenchido e o separador não é tocado', async () => {
  fichas.set(357886, { ...FICHA, idClient: 357886 });
  const unit = unidade();
  const { kommo, gravacoes } = kommoFalso();
  const l = cartaoEmDia(6);
  l.custom_fields_values = [
    ...(l.custom_fields_values ?? []).filter((f) => f.field_id !== ID.ENDERECO),
    { field_id: ID.SEPARADOR, values: [{ value: 'Rua do Imperador, 100' }] },
  ] as KommoLead['custom_fields_values'];
  await _interno.espelharPaciente(varredura(unit, kommo), 6, l, 357886);
  assert.deepEqual(gravacoes.map((g) => g.campo), [ID.ENDERECO], 'só o ⌂ Endereço — o separador não é tocado');
});

test('campos da conta: cabeçalho some antes de casar por nome; nome exato ganha do normalizado', () => {
  assert.ok(!CAMPOS.some(([, i]) => ehCabecalhoDeGrupo(i.nome)), 'nenhum cabeçalho na lista de alvos');
  assert.equal(campoDaConta(CAMPOS, '⌂ Endereço')?.id, ID.ENDERECO);
  const duplicado = camposDaConta([{ id: 50, name: 'Endereço', type: 'text' }, { id: 51, name: '⌂ Endereço', type: 'text' }]);
  assert.equal(campoDaConta(duplicado, '⌂ Endereço')?.id, 51, 'exato primeiro');
  const mapa = _interno.mapearCampos([{ id: 60, name: '## Situação da consulta', type: 'text' }, { id: 61, name: '✓ Situação da consulta', type: 'select', enums: [] }, { id: 62, name: '◷ Data da Consulta', type: 'date' }]);
  assert.equal(mapa.SITUACAO?.id, 61);
});

// ── 2. dois pacientes no mesmo cartão ──────────────────────────────────────────
test('cartaoDeOutroPaciente: cartão com idClient só aceita esse paciente', () => {
  assert.equal(cartaoDeOutroPaciente(357882, [125923]), true, 'outro paciente: recusa');
  assert.equal(cartaoDeOutroPaciente(357882, [357882]), false, 'o dono: aceita');
  assert.equal(cartaoDeOutroPaciente(357882, [130000, 357882]), false, 'cadastro duplicado do dono: aceita');
  assert.equal(cartaoDeOutroPaciente(null, [125923]), false, 'cartão sem idClient: casamento de sempre');
  assert.equal(cartaoDeOutroPaciente(357882, []), false, 'sem saber quem é o paciente, não há conflito provado');
});

test('idClientDoCartao lê o ⚙ idClient (franquia) do cartão', () => {
  assert.equal(idClientDoCartao(cartao(1292772, { IDCLIENT: '357882' }), CAMPOS), 357882);
  assert.equal(idClientDoCartao(cartao(1, {}), CAMPOS), null);
  assert.equal(idClientDoCartao(cartao(1, { IDCLIENT: 'lixo' }), CAMPOS), null);
});

test('cartão 1292772: idClient divergente é recusado, marcado UMA vez para a SDR, sem dado pessoal', async () => {
  const unit = unidade();
  const { kommo, gravacoes, etiquetas, notas } = kommoFalso();
  const ctx = varredura(unit, kommo);
  const lead = cartao(1292772, { IDCLIENT: '357882' });

  assert.equal(await _interno.recusarOutroPaciente(ctx, 1292772, lead, [125923]), true);
  assert.deepEqual(etiquetas, [{ leadId: 1292772, tags: [TAG_CONFLITO] }]);
  assert.equal(notas.length, 1);
  assert.match(notas[0].texto, /357882/);
  assert.match(notas[0].texto, /125923/);
  assert.deepEqual(gravacoes, [], 'nenhum campo gravado');
  assert.equal(ctx.resumo.conflitos, 1);
  assert.deepEqual(ctx.resumo.exemplosConflito, [1292772], 'o resumo leva só o id do cartão');

  // varredura seguinte: o cartão já tem a etiqueta — recusa de novo, sem repetir etiqueta nem nota
  const marcado = cartao(1292772, { IDCLIENT: '357882' }, [TAG_CONFLITO]);
  assert.equal(await _interno.recusarOutroPaciente(varredura(unit, kommo), 1292772, marcado, [125923]), true);
  assert.equal(etiquetas.length, 1);
  assert.equal(notas.length, 1);

  // o dono do cartão passa
  assert.equal(await _interno.recusarOutroPaciente(varredura(unit, kommo), 1292772, lead, [357882]), false);
});

test('paciente só da agenda (sem idClient): o casamento por telefone diz quem ele é, e o conflito aparece', async () => {
  clientesNaBusca.splice(0, clientesNaBusca.length,
    { idClient: 125923, name: 'FILHO TESTE', whatsapp: '+5524999990000' },
    { idClient: 130000, name: 'FILHO TESTE', whatsapp: '(24) 99999-0000' }, // cadastro duplicado, mesmo telefone
  );
  const { kommo } = kommoFalso({ listLeadsPorTelefone: async () => [{ id: 1292772, updated_at: 1 }] });
  const r = await _interno.resolverPaciente(unidade(), kommo, 'FILHO TESTE', null, []);
  assert.equal(r.leadId, 1292772);
  assert.deepEqual(r.idsClient, [125923, 130000]);
  assert.equal(cartaoDeOutroPaciente(357882, r.idsClient), true);
});
