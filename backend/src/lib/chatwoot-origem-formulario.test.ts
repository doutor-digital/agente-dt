/**
 * Origem «Formulário» (caso Capivari): o texto pronto do formulário do site, sem referral, grava Origem = «Formulário» + etiqueta.
 * Nunca sobrescreve origem existente (anúncio!), só nas primeiras falas, só com a opção na lista da conta, seco não grava, desligado não lê nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { preencherFormulario, padroesDoFormulario, falaParaFormulario, ORIGEM_FORMULARIO, ETIQUETA_FORMULARIO } = await import('./chatwoot-origem.js');
const { automacaoPorId, verificarCatalogo } = await import('./automacoes.js');
const { casarFala } = await import('./origem-texto-pronto.js');

const TEXTO = 'Olá! Meu nome é Ana, moro em Capivari e estou com dor na coluna. Vim pelo formulário e quero saber mais.';
const E = { slug: 'doutor-hernia-capivari', contato: 77, conversa: 900, texto: TEXTO };

function portas(o: { estado?: 'desligado' | 'seco' | 'ligado'; contatos?: Array<Record<string, unknown>>; falas?: string[] | null; opcoes?: string[] | null; intents?: unknown } = {}) {
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
  assert.deepEqual(x.gravados, [[77, { origem: ORIGEM_FORMULARIO }]]);
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
