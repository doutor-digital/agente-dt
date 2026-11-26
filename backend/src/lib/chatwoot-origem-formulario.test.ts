/**
 * Origem «Formulário» (caso Capivari): o texto pronto do formulário do site, sem referral, grava Origem = «Formulário» + etiqueta.
 * Nunca sobrescreve origem existente (anúncio!), só nas primeiras falas, só com a opção na lista da conta, seco não grava, desligado não lê nada.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { preencherFormulario, padroesDoFormulario, falaParaFormulario, limparCacheDoFormulario, ORIGEM_FORMULARIO, ETIQUETA_FORMULARIO } = await import('./chatwoot-origem.js');
beforeEach(() => limparCacheDoFormulario());
const { automacaoPorId, verificarCatalogo } = await import('./automacoes.js');
const { casarFala } = await import('./origem-texto-pronto.js');

const TEXTO = 'Olá! Meu nome é Ana, moro em Capivari e estou com dor na coluna. Vim pelo formulário e quero saber mais.';
const E = { slug: 'doutor-hernia-capivari', contato: 77, conversa: 900, texto: TEXTO };

function portas(o: { estado?: 'desligado' | 'seco' | 'ligado'; estadoOrigem?: 'desligado' | 'seco' | 'ligado'; contatos?: Array<Record<string, unknown>>; falas?: string[] | null; opcoes?: string[] | null; intents?: unknown } = {}) {
  const gravados: Array<[number, Record<string, string>]> = [];
  const etiquetas: Array<[number, string[]]> = [];
  let leituras = 0;
  let falasLidas = 0;
  const lista = o.contatos ?? [{}];
  return {
    gravados,
    etiquetas,
    lidas: () => leituras,
    falasLidas: () => falasLidas,
    p: {
      estado: () => o.estado ?? 'ligado',
      estadoOrigem: () => o.estadoOrigem ?? 'ligado',
      padroes: async () => padroesDoFormulario(o.intents),
      opcoesDaOrigem: async () => (o.opcoes === undefined ? ['Meta Ads', ORIGEM_FORMULARIO] : o.opcoes),
      falasDoPaciente: async () => { falasLidas++; return o.falas === undefined ? [TEXTO] : o.falas; },
      contato: async () => lista[Math.min(leituras++, lista.length - 1)]!,
      gravar: async (c: number, campos: Record<string, string>) => { gravados.push([c, campos]); },
      etiquetar: async (c: number, e: string[]) => { etiquetas.push([c, e]); },
    },
  };
}

test('catálogo: chatwoot-formulario existe, tem seco, nasce desligado, e o catálogo continua válido', () => {
  const a = automacaoPorId('chatwoot-formulario');
  assert.ok(a && a.temSeco && a.quandoVazio === 'desligado' && a.chave === 'CHATWOOT_FORMULARIO_SLUGS');
  assert.deepEqual(verificarCatalogo(), []);
});

test('reconhece o texto do formulário da GAC (no meio da fala, sem acento, em maiúsculas) e não casa com outra coisa', () => {
  const padroes = padroesDoFormulario(undefined);
  assert.ok(casarFala(TEXTO, padroes));
  assert.ok(casarFala('OLA! MEU NOME E JOSE... VIM PELO FORMULARIO', padroes));
  assert.equal(casarFala('Bom dia, vim pelo anúncio', padroes), null);
  assert.equal(casarFala('revim pelo formularios', padroes), null, 'palavras inteiras');
  assert.equal(casarFala('Oi', padroes), null);
});

test('padrão por unidade: as entradas «Formulário» de origem_por_texto valem no lugar do padrão; outras origens não entram', () => {
  const intents = { origem_por_texto: [
    { texto: 'Preenchi o cadastro no site da clínica', origem: 'Formulário', contem: true },
    { texto: 'Olá estava navegando e gostaria de mais informações', origem: 'Site' },
  ] };
  const padroes = padroesDoFormulario(intents);
  assert.equal(padroes.length, 1);
  assert.ok(casarFala('Oi, preenchi o cadastro no site da clínica ontem', padroes));
  assert.equal(casarFala(TEXTO, padroes), null, 'o padrão da unidade substitui o de sempre');
  assert.equal(padroesDoFormulario({ origem_por_texto: [{ texto: 'Olá estava navegando e gostaria de mais', origem: 'Site' }] }).length, 1, 'sem entrada «Formulário»: o de sempre');
});

test('webhook: só fala de paciente (incoming, não privada, com texto) numa caixa de unidade', () => {
  const caixas = { 3: 'doutor-hernia-capivari' } as const;
  const base = { event: 'message_created', message_type: 'incoming', private: false, content: TEXTO, conversation: { id: 900, inbox_id: 3 }, sender: { id: 77 } };
  assert.deepEqual(falaParaFormulario(base, caixas), { slug: 'doutor-hernia-capivari', conversa: 900, contato: 77, texto: TEXTO });
  assert.equal(falaParaFormulario({ ...base, message_type: 'outgoing' }, caixas), null);
  assert.equal(falaParaFormulario({ ...base, private: true }, caixas), null);
  assert.equal(falaParaFormulario({ ...base, content: '  ' }, caixas), null);
  assert.equal(falaParaFormulario({ ...base, conversation: { id: 900, inbox_id: 9 } }, caixas), null);
  assert.equal(falaParaFormulario({ ...base, event: 'message_updated' }, caixas), null);
});

test('ligado: contato sem origem → grava Origem = Formulário e põe a etiqueta', async () => {
  const x = portas();
  assert.equal(await preencherFormulario(E, x.p), 'gravado');
  assert.deepEqual(x.gravados, [[77, { origem: ORIGEM_FORMULARIO, origem_palpite: 'formulario-texto' }]]);
  assert.deepEqual(x.etiquetas, [[900, [ETIQUETA_FORMULARIO]]]);
});

test('NUNCA sobrescreve origem de anúncio (nem a da equipe): contato com origem → não grava e não etiqueta', async () => {
  for (const origem of ['Meta Ads', 'Indicação', ORIGEM_FORMULARIO]) {
    const x = portas({ contatos: [{ origem }] });
    assert.equal(await preencherFormulario(E, x.p), 'nada', origem);
    assert.equal(x.gravados.length, 0);
    assert.equal(x.etiquetas.length, 0);
  }
});

test('corrida: o anúncio gravou a origem enquanto líamos → relê na hora de gravar e desiste', async () => {
  const x = portas({ contatos: [{}, { origem: 'Meta Ads' }] });
  assert.equal(await preencherFormulario(E, x.p), 'nada');
  assert.equal(x.gravados.length, 0);
});

test('seco não grava nem etiqueta; desligado não lê nada; CHATWOOT_FORMULARIO=0 desliga', async () => {
  const s = portas({ estado: 'seco' });
  assert.equal(await preencherFormulario(E, s.p), 'seco');
  assert.equal(s.gravados.length + s.etiquetas.length, 0);
  const d = portas({ estado: 'desligado' });
  assert.equal(await preencherFormulario(E, d.p), 'desligado');
  assert.equal(d.lidas() + d.falasLidas(), 0);
  const z = portas();
  assert.equal(await preencherFormulario(E, z.p, { CHATWOOT_FORMULARIO: '0' }), 'desligado');
  assert.equal(z.gravados.length, 0);
});

test('texto que não é do formulário: não lê a conversa nem o contato (barato)', async () => {
  const x = portas();
  assert.equal(await preencherFormulario({ ...E, texto: 'Bom dia, quero marcar consulta' }, x.p), 'nada');
  assert.equal(x.lidas() + x.falasLidas(), 0);
});

test('só as primeiras falas: «vim pelo formulário» depois de 3 falas, ou conversa longa/ilegível, não vira origem', async () => {
  const tarde = portas({ falas: ['Oi', 'Quero saber o valor', 'Qual o endereço?', TEXTO] });
  assert.equal(await preencherFormulario(E, tarde.p), 'nada');
  const longa = portas({ falas: null });
  assert.equal(await preencherFormulario(E, longa.p), 'nada');
  assert.equal(tarde.gravados.length + longa.gravados.length, 0);
  const cedo = portas({ falas: ['Oi', TEXTO] });
  assert.equal(await preencherFormulario(E, cedo.p), 'gravado');
});

test('sem a opção «Formulário» na lista de Origem da conta (ou lista ilegível): não grava valor fora da lista', async () => {
  for (const opcoes of [['Meta Ads', 'Google'], null]) {
    limparCacheDoFormulario();
    const x = portas({ opcoes });
    assert.equal(await preencherFormulario(E, x.p), 'sem-opcao');
    assert.equal(x.gravados.length + x.etiquetas.length, 0);
  }
});

test('falha ao gravar não lança; falha na etiqueta não desfaz a origem', async () => {
  const x = portas();
  const p1 = { ...x.p, gravar: async () => { throw new Error('Chatwoot fora'); } };
  assert.equal(await preencherFormulario(E, p1), 'nada');
  const p2 = { ...x.p, etiquetar: async () => { throw new Error('etiqueta falhou'); } };
  assert.equal(await preencherFormulario(E, p2), 'gravado');
  assert.equal(x.gravados.length, 1);
});

test('a opção da lista da conta manda no texto: «formulario» na lista → grava «formulario» (o valor exato dela)', async () => {
  const x = portas({ opcoes: ['Meta Ads', 'formulario'] });
  assert.equal(await preencherFormulario(E, x.p), 'gravado');
  assert.deepEqual(x.gravados, [[77, { origem: 'formulario', origem_palpite: 'formulario-texto' }]]);
});

test('a mesma conversa não refaz leitura nem log nas falas seguintes (seco, gravado ou sem a opção)', async () => {
  const s = portas({ estado: 'seco' });
  assert.equal(await preencherFormulario(E, s.p), 'seco');
  const lidasAntes = s.lidas() + s.falasLidas();
  assert.equal(await preencherFormulario(E, s.p), 'nada');
  assert.equal(s.lidas() + s.falasLidas(), lidasAntes, 'nenhuma leitura nova');
  limparCacheDoFormulario();
  const sem = portas({ opcoes: ['Meta Ads'] });
  assert.equal(await preencherFormulario(E, sem.p), 'sem-opcao');
  assert.equal(await preencherFormulario(E, sem.p), 'nada');
});

test('lista de Origem ilegível (erro do Chatwoot) NÃO fica decidida: a próxima fala tenta de novo', async () => {
  const x = portas({ opcoes: null });
  assert.equal(await preencherFormulario(E, x.p), 'sem-opcao');
  const l = x.lidas();
  assert.equal(await preencherFormulario(E, x.p), 'sem-opcao', 'não virou «nada»: leu de novo');
  assert.ok(x.lidas() > l);
});

// ── palpite não vale mais que prova: o referral do anúncio substitui «Formulário» ─────────────────────────────────

const { decidirOrigem, preencherOrigem, ehPalpiteDeFormulario, portasDoFormulario, tamanhoDasDecisoes } = await import('./chatwoot-origem.js');
const V_TAMANHO = () => tamanhoDasDecisoes();
const { prisma } = await import('./prisma.js');

test('decidirOrigem: «Formulário» (palpite) + anúncio comprovado → «Meta Ads» + campanha e conjunto; outra origem preenchida segue intocável', () => {
  const nomes = { campanha: 'Camp X', conjunto: 'Conj Y' };
  const palpite = { origem_palpite: 'formulario-texto' };
  assert.deepEqual(decidirOrigem({ origem: 'Formulário', ...palpite }, nomes), { origem: 'Meta Ads', origem_palpite: '', campanha_nome: 'Camp X', conjunto: 'Conj Y' }, 'o marcador do palpite sai junto');
  assert.deepEqual(decidirOrigem({ origem: ' formulario ', ...palpite }, null), { origem: 'Meta Ads', origem_palpite: '' }, 'sem os nomes da Meta, ao menos a origem');
  assert.equal(decidirOrigem({ origem: 'Formulário' }, nomes), null, 'SEM o marcador é «Formulário» da equipe: intocável');
  assert.equal(decidirOrigem({ origem: 'Indicação' }, nomes), null);
  assert.equal(decidirOrigem({ origem: 'Orgânico' }, nomes), null);
  assert.equal(ehPalpiteDeFormulario({ origem: 'Formulário', origem_palpite: 'formulario-texto' }) && ehPalpiteDeFormulario({ origem: 'formulario', origem_palpite: 'formulario-texto' }), true);
  assert.equal(ehPalpiteDeFormulario({ origem: 'Formulário' }), false, 'sem marcador: foi a equipe');
  assert.equal(ehPalpiteDeFormulario({ origem: 'Meta Ads', origem_palpite: 'formulario-texto' }) || ehPalpiteDeFormulario({}), false);
});

test('«Formulário» foi gravado primeiro; DEPOIS chega o referral (Kapso falhou na hora, retroativo trouxe) → origem vira «Meta Ads» + campanha', async () => {
  // 1) o texto pronto grava o palpite
  const contato: Record<string, unknown> = {};
  const f = portas();
  f.p.gravar = async (c: number, campos: Record<string, string>) => { Object.assign(contato, campos); };
  f.p.contato = async () => ({ ...contato });
  assert.equal(await preencherFormulario(E, f.p), 'gravado');
  assert.equal(contato.origem, 'Formulário');
  assert.equal(contato.origem_palpite, 'formulario-texto', 'o robô marca que a origem é palpite dele');
  // 2) o referral chega depois
  const gravados: Array<Record<string, string>> = [];
  const ref = { anuncio: '120200000000000001', ctwaClid: 'Afd', tipo: 'ad', titulo: 'Dor?', url: null, quando: 1 };
  const p = {
    estado: () => 'ligado' as const,
    contato: async () => ({ ...contato }),
    nomes: async () => ({ campanha: 'Campanha Real', conjunto: 'Conjunto Real' }),
    gravar: async (_c: number, campos: Record<string, string>) => { gravados.push(campos); Object.assign(contato, campos); },
  };
  assert.equal(await preencherOrigem({ slug: E.slug, contato: 77, conversa: 900, ref }, p), 'trocou-palpite');
  assert.deepEqual(gravados, [{ origem: 'Meta Ads', origem_palpite: '', campanha_nome: 'Campanha Real', conjunto: 'Conjunto Real' }]);
  assert.equal(contato.origem, 'Meta Ads');
  // e o palpite não volta: o formulário relê e vê «Meta Ads»
  limparCacheDoFormulario();
  assert.equal(await preencherFormulario(E, f.p), 'nada');
  assert.equal(contato.origem, 'Meta Ads');
});

test('padrões da unidade: ERRO do banco não fica em cache por 10 min (a próxima fala lê de novo e usa o padrão da unidade)', async () => {
  const original = (prisma as any).unit;
  let chamadas = 0;
  const intents = { origem_por_texto: [{ texto: 'Preenchi o cadastro no site da clínica', origem: 'Formulário', contem: true }] };
  Object.defineProperty(prisma, 'unit', { value: { findUnique: async () => { chamadas++; if (chamadas === 1) throw new Error('banco fora'); return { pipelineIntents: intents }; } }, configurable: true, writable: true });
  try {
    const portasReais = portasDoFormulario({ conta: null } as never, { contato: async () => ({}), gravar: async () => undefined } as never, async () => undefined);
    const antes = await portasReais.padroes('doutor-hernia-x');
    assert.ok(casarFala(TEXTO, antes), 'com o banco fora vale o padrão de sempre');
    const depois = await portasReais.padroes('doutor-hernia-x');
    assert.equal(chamadas, 2, 'não ficou em cache: leu de novo');
    assert.ok(casarFala('oi, preenchi o cadastro no site da clínica ontem', depois) && !casarFala(TEXTO, depois), 'e agora vale o padrão da unidade');
    await portasReais.padroes('doutor-hernia-x');
    assert.equal(chamadas, 2, 'leitura boa fica em cache');
  } finally {
    Object.defineProperty(prisma, 'unit', { value: original, configurable: true, writable: true });
  }
});

test('«sem opção»: no SECO é só info («[SECO] … não gravaria»), no ligado é warn de configuração', async () => {
  const { logger } = await import('./logger.js');
  const w = mock.method(logger, 'warn', () => undefined);
  const i = mock.method(logger, 'info', () => undefined);
  try {
    await preencherFormulario(E, portas({ estado: 'seco', opcoes: ['Meta Ads'] }).p);
    assert.equal(w.mock.calls.length, 0, 'seco não alarma');
    assert.ok(i.mock.calls.some((c) => String(c.arguments[1]).includes('[SECO]') && String(c.arguments[1]).includes('não tem a opção')));
    limparCacheDoFormulario();
    await preencherFormulario(E, portas({ estado: 'ligado', opcoes: ['Meta Ads'] }).p);
    assert.equal(w.mock.calls.length, 1, 'ligado avisa');
  } finally {
    w.mock.restore();
    i.mock.restore();
  }
});

test('«Formulário» ESCOLHIDO À MÃO pela equipe (sem o marcador do robô) + referral de anúncio → continua «Formulário»; nada é gravado', async () => {
  const gravados: Array<Record<string, string>> = [];
  const ref = { anuncio: '120200000000000001', ctwaClid: 'Afd', tipo: 'ad', titulo: 'Dor?', url: null, quando: 1 };
  const p = {
    estado: () => 'ligado' as const,
    contato: async () => ({ origem: 'Formulário' }),
    nomes: async () => ({ campanha: 'Campanha Real', conjunto: 'Conjunto Real' }),
    gravar: async (_c: number, campos: Record<string, string>) => { gravados.push(campos); },
  };
  assert.equal(await preencherOrigem({ slug: E.slug, contato: 77, conversa: 900, ref }, p), 'nada');
  assert.deepEqual(gravados, []);
});

test('o mapa de conversas decididas tem TETO: nunca passa de 2.000 entradas', async () => {
  const x = portas();
  for (let i = 0; i < 2300; i++) { await preencherFormulario({ ...E, conversa: 10_000 + i }, x.p); }
  const z = portas({ opcoes: ['Meta Ads'] }); // 'sem opção' também decide: mesmo teto
  for (let i = 0; i < 300; i++) { await preencherFormulario({ ...E, conversa: 50_000 + i }, z.p); }
  assert.equal(x.gravados.length, 2300, 'nenhuma decisão perdeu o trabalho');
  assert.ok(V_TAMANHO() <= 2000, `mapa com ${V_TAMANHO()}`);
});

test('o palpite SÓ roda com `chatwoot-origem` LIGADO (é ele que troca o palpite pelo referral): desligado ou em seco → não lê nada, não grava', async () => {
  for (const estadoOrigem of ['desligado', 'seco'] as const) {
    const x = portas({ estadoOrigem });
    assert.equal(await preencherFormulario(E, x.p), 'origem-desligada', estadoOrigem);
    assert.equal(x.lidas() + x.falasLidas() + x.gravados.length + x.etiquetas.length, 0);
  }
  assert.equal(await preencherFormulario(E, portas({ estadoOrigem: 'ligado' }).p), 'gravado');
});
