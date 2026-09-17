import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lerAnuncioDoLead,
  origemJaConhecida,
  renderAnuncioDeOrigem,
  resumoDaOrigem,
  tituloUtil,
  type AnuncioDeOrigem,
} from './anuncio-de-origem.js';

// ids reais de Mossoró — em outra conta são outros, por isso tudo passa por nome
const IDS: Record<string, number> = {
  '⌂ Título do anúncio': 273014,
  '⌂ Anúncio (ad)': 273010,
  '⌂ Campanha': 273006,
  '⌂ Plataforma de origem': 273008,
  '⚑ Origem': 273004,
};
const porNome = (n: string) => IDS[n] ?? null;

const campos = (m: Record<number, string>) =>
  Object.entries(m).map(([id, value]) => ({ field_id: Number(id), values: [{ value }] }));

test('lê o título do anúncio pelo nome do campo', () => {
  const a = lerAnuncioDoLead(
    campos({ 273014: 'Dor ciática há anos?', 273008: 'Instagram', 273006: 'DH Mossoró · Coluna' }),
    porNome,
  );
  assert.equal(a?.titulo, 'Dor ciática há anos?');
  assert.equal(a?.plataforma, 'Instagram');
  assert.equal(a?.campanha, 'DH Mossoró · Coluna');
});

test('cartão sem nenhum dado de anúncio devolve null', () => {
  assert.equal(lerAnuncioDoLead(campos({ 999999: 'qualquer coisa' }), porNome), null);
  assert.equal(lerAnuncioDoLead([], porNome), null);
  assert.equal(lerAnuncioDoLead(null, porNome), null);
});

test('campo vazio não conta como preenchido', () => {
  assert.equal(lerAnuncioDoLead(campos({ 273014: '   ' }), porNome), null);
});

test('conta em outra unidade: o mesmo nome, outro id', () => {
  // o que quebrava antes era chumbar 273014; aqui o id vem do esquema da conta
  const outros = (n: string) => (n === '⌂ Título do anúncio' ? 888777 : null);
  const a = lerAnuncioDoLead(campos({ 888777: 'Hérnia de disco sem cirurgia' }), outros);
  assert.equal(a?.titulo, 'Hérnia de disco sem cirurgia');
});

test('origem só é "conhecida" quando o rastreio gravou algo', () => {
  assert.equal(origemJaConhecida(null), false);
  assert.equal(origemJaConhecida({ titulo: null, anuncio: null, campanha: null, plataforma: 'Instagram', origem: null }), false);
  assert.equal(origemJaConhecida({ titulo: 'x', anuncio: null, campanha: null, plataforma: null, origem: null }), true);
  assert.equal(origemJaConhecida({ titulo: null, anuncio: null, campanha: null, plataforma: null, origem: 'Meta-Instagram' }), true);
});

const COMPLETO: AnuncioDeOrigem = {
  titulo: 'Dor ciática há anos?',
  anuncio: 'AN04 · ciática',
  campanha: 'DH Mossoró · Coluna',
  plataforma: 'Instagram',
  origem: 'Meta-Instagram',
};

test('o bloco traz o título e manda abrir pelo assunto', () => {
  const t = renderAnuncioDeOrigem(COMPLETO);
  assert.match(t, /Dor ciática há anos\?/);
  assert.match(t, /JÁ NO ASSUNTO/);
});

test('o bloco PROÍBE contar que sabe do clique', () => {
  // "vi que você clicou no anúncio" soa vigilância e derruba a conversa
  const t = renderAnuncioDeOrigem(COMPLETO);
  assert.match(t, /PROIBIDO/);
  assert.match(t, /vigilância/);
});

test('o bloco PROÍBE perguntar como conheceu', () => {
  assert.match(renderAnuncioDeOrigem(COMPLETO), /como você nos conheceu/i);
});

test('manda seguir a queixa do paciente se divergir do anúncio', () => {
  assert.match(renderAnuncioDeOrigem(COMPLETO), /vale mais que a segmenta/i);
});

test('sem anúncio nenhum, bloco vazio — nada entra no prompt', () => {
  assert.equal(renderAnuncioDeOrigem(null), '');
});

test('só a origem, sem título: não promete abrir pelo assunto', () => {
  const t = renderAnuncioDeOrigem({ titulo: null, anuncio: null, campanha: null, plataforma: null, origem: 'Meta-Facebook' });
  assert.match(t, /Meta-Facebook/);
  assert.doesNotMatch(t, /JÁ NO ASSUNTO/);
});

test('o bloco não ensina colchete nenhum', () => {
  // o guardrail de lacuna derruba mensagem com "[...]"; o prompt não pode inspirar isso
  assert.doesNotMatch(renderAnuncioDeOrigem(COMPLETO), /\[[^\]]*\]/);
});

test('resumo da origem junta o que existe', () => {
  assert.equal(resumoDaOrigem(COMPLETO), 'Instagram · DH Mossoró · Coluna · AN04 · ciática');
  assert.equal(
    resumoDaOrigem({ titulo: null, anuncio: null, campanha: null, plataforma: null, origem: 'Meta-Facebook' }),
    'Meta-Facebook',
  );
});

// --- o título só serve se for promessa de verdade (medido 17/09/2026) ---

test('títulos genéricos NÃO viram gancho', () => {
  // 86% dos 554 leads medidos tinham um destes
  for (const t of ['Converse conosco', 'Converse Conosco', 'Fale com a gente', 'Clique aqui',
                   'Doutor Hérnia Unidade Araguaína', 'api.whatsapp.com', 'AGENDAR CONSULTA']) {
    assert.equal(tituloUtil(t), null, `"${t}" deveria ser descartado`);
  }
});

test('promessa de verdade passa', () => {
  assert.equal(tituloUtil('Dor ciática há anos? Tem tratamento sem cirurgia'), 'Dor ciática há anos? Tem tratamento sem cirurgia');
  assert.equal(tituloUtil('Hérnia de disco sem cirurgia e sem medicação'), 'Hérnia de disco sem cirurgia e sem medicação');
});

test('duas palavras não é promessa', () => {
  assert.equal(tituloUtil('Dor lombar'), null);
});

test('título genérico não derruba a origem — só o gancho', () => {
  const a = lerAnuncioDoLead(campos({ 273014: 'Converse conosco', 273008: 'instagram', 273006: 'ENG | WPP' }), porNome);
  assert.equal(a?.titulo, null, 'o título genérico foi descartado');
  assert.equal(origemJaConhecida(a), true, 'mas ainda sabemos que veio de anúncio');
  const t = renderAnuncioDeOrigem(a);
  assert.doesNotMatch(t, /Converse conosco/, 'o ruído não entra no prompt');
  assert.doesNotMatch(t, /JÁ NO ASSUNTO/, 'sem promessa, não promete abrir pelo assunto');
  assert.match(t, /como você nos conheceu/i, 'mas segue proibindo a pergunta');
});
