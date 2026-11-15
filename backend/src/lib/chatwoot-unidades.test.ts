/**
 * Configuração do CRM por unidade: Parauapebas migrada para a configuração tem de se comportar EXATAMENTE como quando estava escrita
 * no código (mesmos mapas, mesmas decisões da régua, mesmos textos); uma segunda unidade entra sem tocar na primeira; linha ruim no
 * banco nunca derruba Parauapebas.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  aplicarConfigs,
  CAIXAS_CAPI,
  CAIXAS_CLOUD,
  CAIXAS_HISTORICO,
  CAIXAS_REGUA,
  configDaLinha,
  conflitosEntreUnidades,
  ehUsuarioCelular,
  GERENTE_DA_CAIXA,
  INSTANCIA_CAIXA,
  mesclarComSemente,
  META_AGENDAMENTOS_POR_CAIXA,
  nomeDoModeloNaMeta,
  numerosDoKapsoConfigurados,
  problemasDaConfig,
  SEMENTE_PARAUAPEBAS,
  sufixoEnvDaUnidade,
  type ConfigChatwootUnidade,
} from './chatwoot-unidades.js';
import { decidirEtiquetaCelular, decidirRegua, renderizar, USUARIO_CELULAR, type ConversaRegua, type DadosDaUnidade } from './chatwoot-regua.js';
import { TEXTOS_PARAU } from './chatwoot-regua-textos.js';
import { textosDoSlug } from './chatwoot-modelos.js';
import { numerosDoKapso } from '../controllers/kapso-proxy.controller.js';
import { numerosDoKapso as numerosDoKapsoReferral } from './kapso-referral.js';
import { sufixoDaUnidade } from './chatwoot-capi.js';
import { sufixoDaUnidade as sufixoDoGestor } from './chatwoot-gestor.js';
import { eventoDePausa } from './chatwoot-pausa.js';
import { estadoDuplicados } from './chatwoot-duplicados.js';

const SLUG_PARAU = 'doutor-hernia-parauapebas';

const SERRA: ConfigChatwootUnidade = {
  slug: 'doutor-hernia-serra',
  prefixoModelos: 'serra_',
  usuarioCelularId: 17,
  gerenteId: 14,
  metaAgendamentosDia: 8,
  kapsoPhoneNumberId: '999888777666555',
  wabaId: '111222333444555',
  envSufixo: 'SERRA',
  dadosModelos: { nome: 'Doutor Hérnia Serra', cidade: 'Serra', endereco: 'Av. Central, 10 — Laranjeiras, Serra/ES, 29000-000', mapa: 'https://maps.example/serra' },
  caixas: [
    { id: 12, tipo: 'cloud' },
    { id: 13, tipo: 'historico' },
  ],
};

afterEach(() => aplicarConfigs([SEMENTE_PARAUAPEBAS]));

// ── Parauapebas: idêntica ao que estava escrito no código ────────────────────────────────────────

test('semente de Parauapebas: os mapas derivados são exatamente os que estavam no código', () => {
  assert.deepEqual({ ...CAIXAS_REGUA }, { 2: SLUG_PARAU, 3: SLUG_PARAU });
  assert.deepEqual([...CAIXAS_CLOUD], [3]);
  assert.deepEqual([...CAIXAS_HISTORICO], [4]);
  assert.deepEqual({ ...GERENTE_DA_CAIXA }, { 2: 4, 3: 4 });
  assert.deepEqual({ ...META_AGENDAMENTOS_POR_CAIXA }, { 2: 5, 3: 5 });
  assert.deepEqual({ ...INSTANCIA_CAIXA }, { 'parauapebas-unidade': 2 });
  assert.deepEqual({ ...CAIXAS_CAPI }, { 3: { slug: SLUG_PARAU, waba: '2146287749563217' } });
  assert.equal(USUARIO_CELULAR, 7);
  assert.equal(ehUsuarioCelular(7), true);
  assert.equal(ehUsuarioCelular(8), false);
  assert.equal(ehUsuarioCelular(null), false);
  assert.equal(sufixoEnvDaUnidade(SLUG_PARAU), 'PARAUAPEBAS');
  assert.deepEqual(problemasDaConfig(SEMENTE_PARAUAPEBAS), []);
});

test('os mapas de sempre são os MESMOS objetos que os módulos antigos exportam (atualização no lugar)', async () => {
  const regua = await import('./chatwoot-regua.js');
  const capi = await import('./chatwoot-capi.js');
  const hoje = await import('./chatwoot-hoje.js');
  const lida = await import('./chatwoot-lida.js');
  assert.equal(regua.CAIXAS_REGUA, CAIXAS_REGUA);
  assert.equal(regua.CAIXAS_CLOUD, CAIXAS_CLOUD);
  assert.equal(regua.CAIXAS_HISTORICO, CAIXAS_HISTORICO);
  assert.equal(regua.GERENTE_DA_CAIXA, GERENTE_DA_CAIXA);
  assert.equal(capi.CAIXAS_CAPI, CAIXAS_CAPI);
  assert.equal(hoje.META_AGENDAMENTOS_POR_CAIXA, META_AGENDAMENTOS_POR_CAIXA);
  assert.equal(lida.INSTANCIA_CAIXA, INSTANCIA_CAIXA);
});

test('sufixo das variáveis da Meta: igual ao de antes para todas as unidades, nos três lugares que o calculavam', () => {
  for (const [slug, suf] of [
    [SLUG_PARAU, 'PARAUAPEBAS'],
    ['doutor-hernia-serra', 'SERRA'],
    ['doutor-hernia-rio-verde', 'RIO_VERDE'],
    ['doutor-hernia-boa-vista', 'BOA_VISTA'],
    ['outra-marca', 'OUTRA_MARCA'],
  ] as const) {
    assert.equal(sufixoEnvDaUnidade(slug), suf);
    assert.equal(sufixoDaUnidade(slug), suf);
    assert.equal(sufixoDoGestor(slug), suf);
  }
});

test('números do Kapso: sem variável de ambiente é o de Parauapebas, como era o padrão; com variável, ela manda (como antes)', () => {
  assert.deepEqual(numerosDoKapso({}), ['1212928641906230']);
  assert.deepEqual(numerosDoKapsoReferral({}), ['1212928641906230']);
  assert.deepEqual(numerosDoKapso({ KAPSO_PHONE_NUMBER_IDS: '5551112222333, 1212928641906230' }), ['5551112222333', '1212928641906230']);
  assert.deepEqual(numerosDoKapso({ KAPSO_PHONE_NUMBER_IDS: '5551112222333' }), ['5551112222333']);
  // unidade nova configurada: sem a variável, o número dela entra
  aplicarConfigs(mesclarComSemente([SERRA]));
  assert.deepEqual(numerosDoKapso({}), ['1212928641906230', '999888777666555']);
});

test('a régua decide e escreve o MESMO com os textos da configuração e com os textos de sempre', () => {
  const U0: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
  const U1: DadosDaUnidade = { ...U0, textos: textosDoSlug(SLUG_PARAU), prefixoModelos: 'parau_' };
  assert.ok(U1.textos, 'Parauapebas tem textos na configuração');
  const conversa = (attrs: Record<string, unknown>, etiquetas: string[] = []): ConversaRegua => ({
    id: 10,
    nome: 'maria da silva',
    etiquetas,
    attrs,
    criadaEm: new Date('2026-10-01T12:00:00Z'),
    atendente: 'Ana',
    ultima: null,
  });
  const CONSULTA = { etapa: 'Agendado', situacao_consulta: 'Confirmado', data_consulta: '2026-11-17', hora_consulta: '14:30' };
  const FEITOS_VESPERA = ['consulta-vespera|2026-11-17T14:30'];
  const FEITOS_DIA = [...FEITOS_VESPERA, 'consulta-dia|2026-11-17T14:30'];
  const TRAT = { funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-20', hora_sessao: '14:00' };
  const cenarios: Array<[string, ConversaRegua, string, string[], Map<string, { valor: string; desde: Date; inicial: boolean }>]> = [
    ['véspera da consulta', conversa(CONSULTA), '2026-11-16T17:30:00Z', [], new Map()],
    ['dia da consulta', conversa(CONSULTA), '2026-11-17T14:30:00Z', FEITOS_VESPERA, new Map()],
    ['preparo', conversa(CONSULTA), '2026-11-17T16:30:00Z', FEITOS_DIA, new Map()],
    ['sessão do dia', conversa(TRAT), '2026-11-20T14:00:00Z', [], new Map()],
    ['alta: conclusão', conversa({ funil: 'Tratamento', etapa_tratamento: 'Alta' }), '2026-11-16T12:00:00Z', [], new Map([['etapa_tratamento', { valor: 'Alta', desde: new Date('2026-11-16T12:00:00Z'), inicial: false }]])],
    ['sem dados', conversa({ etapa: 'Novo lead' }), '2026-11-16T14:00:00Z', [], new Map()],
  ];
  let comTexto = 0;
  for (const [nome, c, agora, feitos, vistos] of cenarios) {
    const a = decidirRegua(c, { vistos, feitos: new Set(feitos) }, new Date(agora), U0);
    const b = decidirRegua(c, { vistos, feitos: new Set(feitos) }, new Date(agora), U1);
    assert.deepEqual(b, a, `cenário «${nome}»: a decisão mudou`);
    comTexto += a.disparos.filter((d) => d.texto !== null).length;
  }
  assert.ok(comTexto >= 5, `os cenários têm de disparar mensagens de verdade (disparou ${comTexto})`);
  // e para os 33 modelos, o texto e as variáveis de cada um
  const completa = conversa({ data_consulta: '2026-11-17', hora_consulta: '09:00', proxima_sessao: '2026-11-18', hora_sessao: '10:00', data_retorno: '2026-11-20', programa: 'Coluna Forte', vencimento: '2026-11-25', valor_parcela: '150' });
  for (const modelo of Object.keys(TEXTOS_PARAU)) {
    assert.deepEqual(renderizar(modelo, completa, U1), renderizar(modelo, completa, U0), modelo);
  }
});

test('o nome do modelo na Meta: Parauapebas não muda; outra unidade troca só o prefixo', () => {
  assert.equal(nomeDoModeloNaMeta('parau_consulta_preparo', 'parau_'), 'parau_consulta_preparo');
  assert.equal(nomeDoModeloNaMeta('parau_consulta_preparo', undefined), 'parau_consulta_preparo');
  assert.equal(nomeDoModeloNaMeta('parau_consulta_preparo', 'serra_'), 'serra_consulta_preparo');
  assert.equal(nomeDoModeloNaMeta('outro_nome', 'serra_'), 'outro_nome');
});

test('o seed da migration tem os mesmos valores que a semente do código', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20261114190100_unit_chatwoot/migration.sql'), 'utf8');
  const s = SEMENTE_PARAUAPEBAS;
  for (const trecho of [
    `'${s.prefixoModelos}', ${s.usuarioCelularId}, ${s.gerenteId}, ${s.metaAgendamentosDia}, '${s.kapsoPhoneNumberId}', '${s.wabaId}', '${s.envSufixo}'`,
    JSON.stringify(s.dadosModelos),
    ...s.caixas.map((c) => `(${c.id}, '${c.tipo}', ${c.instanciaEvolution ? `'${c.instanciaEvolution}'` : 'NULL'})`),
    `'${s.slug}'`,
  ]) {
    assert.ok(sql.includes(trecho), `a migration não tem: ${trecho}`);
  }
});

// ── uma segunda unidade ──────────────────────────────────────────────────────────────────────────

test('uma segunda unidade entra sem mexer na primeira, e cada mapa aponta para a dona certa', () => {
  aplicarConfigs(mesclarComSemente([SERRA]));
  assert.deepEqual({ ...CAIXAS_REGUA }, { 2: SLUG_PARAU, 3: SLUG_PARAU, 12: 'doutor-hernia-serra' });
  assert.deepEqual([...CAIXAS_CLOUD].sort((a, b) => a - b), [3, 12]);
  assert.deepEqual([...CAIXAS_HISTORICO].sort((a, b) => a - b), [4, 13]);
  assert.deepEqual({ ...GERENTE_DA_CAIXA }, { 2: 4, 3: 4, 12: 14 });
  assert.deepEqual({ ...META_AGENDAMENTOS_POR_CAIXA }, { 2: 5, 3: 5, 12: 8 });
  assert.deepEqual({ ...CAIXAS_CAPI }, { 3: { slug: SLUG_PARAU, waba: '2146287749563217' }, 12: { slug: 'doutor-hernia-serra', waba: '111222333444555' } });
  assert.equal(ehUsuarioCelular(17), true);
  assert.equal(ehUsuarioCelular(7), true);
  assert.deepEqual(numerosDoKapsoConfigurados(), ['1212928641906230', '999888777666555']);
  // a pausa e a etiqueta do celular enxergam o usuário da outra unidade
  const evento = eventoDePausa({ event: 'message_created', message_type: 'outgoing', conversation: { id: 5, inbox_id: 12 }, sender: { id: 17, type: 'user' } });
  assert.deepEqual(evento?.autor, { tipo: 'celular' });
  assert.equal(evento?.slug, 'doutor-hernia-serra');
  const c: ConversaRegua = { id: 1, nome: 'x', etiquetas: [], attrs: {}, criadaEm: new Date(), atendente: null, ultima: { saida: true, privada: false, autorId: 17, autorTipo: 'user', criadaEm: new Date(), texto: 'oi' } as never };
  assert.equal(decidirEtiquetaCelular(c), 'por');
});

test('a unidade nova usa o prefixo e o texto dela, e nada de Parauapebas', () => {
  aplicarConfigs(mesclarComSemente([SERRA]));
  const textos = textosDoSlug('doutor-hernia-serra');
  assert.ok(textos);
  assert.deepEqual(Object.keys(textos).sort(), Object.keys(TEXTOS_PARAU).sort());
  for (const [nome, t] of Object.entries(textos)) {
    assert.ok(!/Parauapebas|Rua C|share\.google|68515/.test(t), `${nome} ainda tem dado de Parauapebas`);
  }
  assert.ok(textos.parau_consulta_lembrete_vespera!.includes('Av. Central, 10'));
  assert.ok(textos.parau_consulta_lembrete_vespera!.includes('https://maps.example/serra'));
  assert.ok(textos.parau_alta_pesquisa_nps!.includes('Doutor Hérnia Serra'));
  assert.ok(textos.parau_sdr_confirmacao_retorno!.includes('na unidade Serra'));
  // e Parauapebas continua com os dela
  assert.deepEqual(textosDoSlug(SLUG_PARAU), { ...TEXTOS_PARAU });
});

// ── linha ruim no banco ──────────────────────────────────────────────────────────────────────────

test('linha ruim ou conflitante é ignorada com aviso e NUNCA tira Parauapebas', () => {
  const avisos: string[] = [];
  const aviso = (m: string, s: string) => avisos.push(`${s}: ${m}`);
  const roubaCaixa: ConfigChatwootUnidade = { ...SERRA, slug: 'doutor-hernia-ladra', prefixoModelos: 'ladra_', envSufixo: 'LADRA', caixas: [{ id: 3, tipo: 'cloud' }] };
  const mesmoPrefixo: ConfigChatwootUnidade = { ...SERRA, slug: 'doutor-hernia-zcopia', caixas: [{ id: 30, tipo: 'cloud' }] };
  const semCaixa: ConfigChatwootUnidade = { ...SERRA, slug: 'doutor-hernia-vazia', prefixoModelos: 'vazia_', caixas: [] };
  const lista = mesclarComSemente([SERRA, roubaCaixa, mesmoPrefixo, semCaixa], aviso);
  assert.deepEqual(lista.map((c) => c.slug), [SLUG_PARAU, 'doutor-hernia-serra']);
  assert.equal(avisos.length, 3);
  assert.ok(avisos.some((a) => a.includes('a caixa 3 já é de doutor-hernia-parauapebas')));
  assert.ok(avisos.some((a) => a.includes('o prefixo serra_ já é de doutor-hernia-serra')));
  assert.ok(avisos.some((a) => a.includes('sem nenhuma caixa')));
});

test('a linha de Parauapebas no banco vence a semente; se ela vier ruim, a semente continua valendo', () => {
  const editada: ConfigChatwootUnidade = { ...SEMENTE_PARAUAPEBAS, gerenteId: 99 };
  assert.equal(mesclarComSemente([editada]).find((c) => c.slug === SLUG_PARAU)?.gerenteId, 99);
  const ruim: ConfigChatwootUnidade = { ...SEMENTE_PARAUAPEBAS, caixas: [] };
  assert.equal(mesclarComSemente([ruim]).find((c) => c.slug === SLUG_PARAU)?.gerenteId, 4);
});

test('validação: prefixo, sufixo, mapa, números e dados do modelo', () => {
  const ruim: ConfigChatwootUnidade = { ...SERRA, prefixoModelos: 'Serra', envSufixo: 'serra-x', kapsoPhoneNumberId: 'abc', wabaId: '1', dadosModelos: { ...SERRA.dadosModelos, mapa: 'http://x', endereco: ' ' } };
  const p = problemasDaConfig(ruim).join(' | ');
  assert.match(p, /prefixo dos modelos inválido/);
  assert.match(p, /sufixo das variáveis inválido/);
  assert.match(p, /link https/);
  assert.match(p, /falta endereco/);
  assert.match(p, /número do Kapso/);
  assert.match(p, /WABA inválida/);
  assert.deepEqual(problemasDaConfig(SERRA), []);
  assert.equal(conflitosEntreUnidades([SEMENTE_PARAUAPEBAS, SERRA]).size, 0);
});

test('da linha do banco para a configuração (campos do JSON que faltam viram vazio, que a validação recusa)', () => {
  const c = configDaLinha({
    unitId: 'u1',
    prefixoModelos: 'serra_',
    usuarioCelularId: null,
    gerenteId: null,
    metaAgendamentosDia: null,
    kapsoPhoneNumberId: null,
    wabaId: null,
    envSufixo: 'SERRA',
    dadosModelos: { nome: 'X', cidade: 'Y' },
    unit: { slug: 'doutor-hernia-serra' },
    caixas: [{ caixaId: 12, tipo: 'cloud', instanciaEvolution: null }],
  });
  assert.equal(c.slug, 'doutor-hernia-serra');
  assert.deepEqual(c.caixas, [{ id: 12, tipo: 'cloud', instanciaEvolution: null }]);
  assert.match(problemasDaConfig(c).join('|'), /falta endereco/);
});

test('conflito é decidido por ORDEM FIXA (Parauapebas primeiro, depois por slug) e unidade descartada não segura caixa de ninguém', () => {
  const ladra: ConfigChatwootUnidade = { ...SERRA, slug: 'doutor-hernia-aaa', prefixoModelos: 'aaa_', envSufixo: 'AAA', caixas: [{ id: 12, tipo: 'cloud' }, { id: 3, tipo: 'cloud' }] };
  const legitima: ConfigChatwootUnidade = { ...SERRA, slug: 'doutor-hernia-zzz', prefixoModelos: 'zzz_', envSufixo: 'ZZZ', caixas: [{ id: 12, tipo: 'cloud' }] };
  // qualquer ordem de chegada do banco dá o mesmo resultado
  for (const entrada of [[ladra, legitima], [legitima, ladra]]) {
    const lista = mesclarComSemente(entrada);
    assert.deepEqual(lista.map((c) => c.slug), [SLUG_PARAU, 'doutor-hernia-zzz']);
  }
  // a descartada (que queria a 3 de Parauapebas) não ficou dona da caixa 12: a «zzz» entra
  const ruins = conflitosEntreUnidades([SEMENTE_PARAUAPEBAS, ladra, legitima]);
  assert.deepEqual([...ruins.keys()], ['doutor-hernia-aaa']);
});

test('duplicados: com mais de uma unidade, vale o estado MAIS RESTRITO (junção não tem volta)', () => {
  const antes = process.env.CHATWOOT_DUPLICADOS_SLUGS;
  try {
    process.env.CHATWOOT_DUPLICADOS_SLUGS = SLUG_PARAU;
    assert.equal(estadoDuplicados(), 'ligado', 'só Parauapebas: o estado dela, como sempre');
    aplicarConfigs(mesclarComSemente([SERRA]));
    assert.equal(estadoDuplicados(), 'desligado', 'a unidade nova não está na lista: segura as duas');
    process.env.CHATWOOT_DUPLICADOS_SLUGS = `${SLUG_PARAU},doutor-hernia-serra`;
    assert.equal(estadoDuplicados(), 'ligado');
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_DUPLICADOS_SLUGS;
    else process.env.CHATWOOT_DUPLICADOS_SLUGS = antes;
  }
});

test('a migration pode rodar de novo sem quebrar (chaves estrangeiras protegidas)', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20261114190100_unit_chatwoot/migration.sql'), 'utf8');
  assert.equal((sql.match(/duplicate_object/g) ?? []).length, 2);
  assert.ok(!/^ALTER TABLE .* ADD CONSTRAINT/m.test(sql), 'ADD CONSTRAINT solto (fora de DO) quebra na segunda execução');
});
