import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIAS,
  ESTADO_VAZIO,
  EXPIRA_ABERTA_H,
  EXPIRA_ENCERRADA_H,
  EXPIRA_MENU_MIN,
  INTERVALO_AVISO_MIN,
  MARCA_PROTOCOLO,
  TEXTOS,
  acharUnidade,
  avancar,
  categoriaEscolhida,
  normalizar,
  simOuNao,
  type Contexto,
  type Entrada,
  type Estado,
  type UnidadeBasica,
} from './suporte-menu-maquina.js';

const TIMBO: UnidadeBasica = { slug: 'doutor-hernia-timbo', nome: 'Doutor Hérnia Timbó' };
const RIO: UnidadeBasica = { slug: 'rioverde', nome: 'Rio Verde' };
const LUCAS: UnidadeBasica = { slug: 'lucas-do-rio-verde', nome: 'Lucas do Rio Verde' };
const UNIDADES = [TIMBO, RIO, LUCAS];
const T0 = new Date('2026-11-07T12:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

const ctx = (extra: Partial<Contexto> = {}): Contexto => ({ agora: T0, unidades: UNIDADES, unidadesDoGrupo: [], nomePerfil: null, ...extra });
const msg = (texto: string, extra: Partial<Entrada> = {}): Entrada => ({ texto, semTexto: false, ...extra });
const em = (estado: Partial<Estado>): Estado => ({ ...ESTADO_VAZIO, atualizadoEm: T0, ...estado });

test('normalizar: sem acento, minúsculas, espaços colapsados', () => {
  assert.equal(normalizar('  Doutor   HÉRNIA  Timbó '), 'doutor hernia timbo');
});

test('simOuNao e categoriaEscolhida', () => {
  assert.equal(simOuNao('1'), 'sim');
  assert.equal(simOuNao(' Sim! '), 'sim');
  assert.equal(simOuNao('2'), 'nao');
  assert.equal(simOuNao('Não'), 'nao');
  assert.equal(simOuNao('talvez'), null);
  assert.equal(simOuNao('1 2'), null);
  assert.equal(categoriaEscolhida('3'), 3);
  assert.equal(categoriaEscolhida('7.'), 7);
  assert.equal(categoriaEscolhida('0'), null);
  assert.equal(categoriaEscolhida('8'), null);
  assert.equal(categoriaEscolhida('12'), null);
  assert.equal(categoriaEscolhida('quero o 3'), null);
});

test('acharUnidade: só quando UMA bate; "Rio Verde" não confunde com "Lucas do Rio Verde"', () => {
  assert.deepEqual(acharUnidade('Maria, Timbó', UNIDADES), TIMBO);
  assert.equal(acharUnidade('Maria, Lucas do Rio Verde', UNIDADES)?.slug, 'lucas-do-rio-verde');
  // "Rio Verde" sozinho: só a Rio Verde tem as duas palavras E nada a mais exigido; a Lucas exige "lucas"
  assert.equal(acharUnidade('Ana de Rio Verde', UNIDADES)?.slug, 'rioverde');
  assert.equal(acharUnidade('Maria, Belém', UNIDADES), null);
  assert.equal(acharUnidade('Maria, Timbó e Rio Verde', UNIDADES), null);
});

test('conversa nova: qualquer mensagem recebe as boas-vindas e conta como conversa nova', () => {
  const r = avancar(ESTADO_VAZIO, msg('oi, tô com um erro'), ctx());
  assert.deepEqual(r.respostas, [TEXTOS.boasVindas]);
  assert.equal(r.estado.passo, 'equipe');
  assert.equal(r.nova, true);
  assert.equal(r.abrir, undefined);
});

test('caminho feliz sem grupo: equipe → identificação (texto) → confirma unidade → menu → detalhes → protocolo', () => {
  let e = avancar(ESTADO_VAZIO, msg('oi'), ctx()).estado;
  let r = avancar(e, msg('1'), ctx());
  assert.equal(r.estado.passo, 'identificacao');
  assert.deepEqual(r.respostas, [TEXTOS.pedeIdentificacao]);
  r = avancar(r.estado, msg('Maria Silva, Timbó'), ctx());
  assert.equal(r.estado.passo, 'confirma-unidade');
  assert.deepEqual(r.respostas, [TEXTOS.confirmaUnidade('Doutor Hérnia Timbó')]);
  r = avancar(r.estado, msg('1'), ctx());
  assert.equal(r.estado.passo, 'categoria');
  assert.equal(r.estado.verificacao, 'texto');
  assert.deepEqual(r.respostas, [TEXTOS.menu]);
  r = avancar(r.estado, msg('1'), ctx());
  assert.equal(r.estado.passo, 'detalhes');
  assert.equal(r.estado.categoria, 1);
  r = avancar(r.estado, msg('A Sofia não respondeu a paciente Joana no cartão 123'), ctx());
  assert.equal(r.estado.passo, 'aberta');
  assert.deepEqual(r.respostas, [TEXTOS.protocolo]);
  assert.ok(r.respostas[0]!.includes(MARCA_PROTOCOLO));
  assert.equal(r.abrir?.categoria, 1);
  assert.equal(r.abrir?.categoriaNome, CATEGORIAS[1]);
  assert.equal(r.abrir?.nome, 'Maria Silva, Timbó');
  assert.equal(r.abrir?.unidade?.slug, TIMBO.slug);
  assert.equal(r.abrir?.verificacao, 'texto');
  assert.match(r.abrir!.relato, /Sofia não respondeu/);
});

test('número em UM grupo de Marketing: pula nome e unidade, marca verificado pelo grupo e usa o nome do perfil', () => {
  const e = em({ passo: 'equipe' });
  const r = avancar(e, msg('1'), ctx({ unidadesDoGrupo: [TIMBO], nomePerfil: 'Maria Silva' }));
  assert.equal(r.estado.passo, 'categoria');
  assert.equal(r.estado.verificacao, 'grupo');
  assert.equal(r.estado.unidade?.slug, TIMBO.slug);
  assert.equal(r.estado.nome, 'Maria Silva');
  assert.ok(r.respostas[0]!.startsWith('Oi, Maria! Vi o seu número no grupo de Marketing da unidade Doutor Hérnia Timbó.'));
  assert.ok(r.respostas[0]!.endsWith(TEXTOS.menu));
  assert.equal(r.respostas.length, 1);
});

test('número em VÁRIOS grupos (consultoria/agência) ou em nenhum: pergunta nome e unidade; o cartão sabe em quantos grupos', () => {
  const vario = avancar(em({ passo: 'equipe' }), msg('1'), ctx({ unidadesDoGrupo: [TIMBO, RIO] }));
  assert.equal(vario.estado.passo, 'identificacao');
  assert.equal(vario.estado.verificacao, 'nenhuma');
  let r = avancar(vario.estado, msg('Carlos, Belém'), ctx({ unidadesDoGrupo: [TIMBO, RIO] }));
  assert.equal(r.estado.passo, 'categoria'); // unidade não achada no texto: segue sem unidade
  assert.equal(r.estado.unidade, null);
  r = avancar(r.estado, msg('4'), ctx({ unidadesDoGrupo: [TIMBO, RIO] }));
  r = avancar(r.estado, msg('o horário some'), ctx({ unidadesDoGrupo: [TIMBO, RIO] }));
  assert.equal(r.abrir?.gruposVistos, 2);
  assert.equal(r.abrir?.verificacao, 'nenhuma');
});

test('"Não" na primeira pergunta: despede, encerra e fica em silêncio por 24 h (nada de spam)', () => {
  let r = avancar(em({ passo: 'equipe' }), msg('2'), ctx());
  assert.deepEqual(r.respostas, [TEXTOS.naoEquipe]);
  assert.equal(r.estado.passo, 'encerrada');
  r = avancar(r.estado, msg('oi?'), ctx({ agora: min(5) }));
  assert.equal(r.silencio, true);
  assert.deepEqual(r.respostas, []);
  // passadas 24 h, recomeça
  r = avancar(r.estado, msg('oi'), ctx({ agora: new Date(T0.getTime() + (EXPIRA_ENCERRADA_H * 60 + 1) * 60_000) }));
  assert.deepEqual(r.respostas, [TEXTOS.boasVindas]);
});

test('"0" recomeça de qualquer ponto, até de demanda aberta e de conversa encerrada', () => {
  for (const passo of ['equipe', 'identificacao', 'categoria', 'detalhes', 'aberta', 'encerrada'] as const) {
    const r = avancar(em({ passo, protocolo: 5 }), msg('0'), ctx());
    assert.deepEqual(r.respostas, [TEXTOS.boasVindas], passo);
    assert.equal(r.estado.passo, 'equipe', passo);
    assert.equal(r.estado.protocolo, null, passo);
  }
});

test('resposta inválida: repete uma vez e na 2ª seguida chama uma pessoa (abre a demanda "Outro")', () => {
  let r = avancar(em({ passo: 'categoria' }), msg('hã?'), ctx());
  assert.equal(r.estado.passo, 'categoria');
  assert.equal(r.estado.tentativas, 1);
  assert.deepEqual(r.respostas, [TEXTOS.repeteMenu]);
  r = avancar(r.estado, msg('9'), ctx());
  assert.equal(r.estado.passo, 'aberta');
  assert.deepEqual(r.respostas, [TEXTOS.chamaPessoa]);
  assert.equal(r.abrir?.categoria, 7);
  assert.match(r.abrir!.relato, /não respondeu o menu no passo "categoria"/);
});

test('tentativas zeram quando a pessoa acerta', () => {
  let r = avancar(em({ passo: 'equipe' }), msg('talvez'), ctx());
  assert.equal(r.estado.tentativas, 1);
  r = avancar(r.estado, msg('1'), ctx());
  assert.equal(r.estado.passo, 'identificacao');
  assert.equal(r.estado.tentativas, 0);
});

test('confirma unidade: "Não" volta a perguntar nome e unidade', () => {
  const e = em({ passo: 'confirma-unidade', nome: 'Maria, Timbó', unidade: TIMBO });
  const r = avancar(e, msg('2'), ctx());
  assert.equal(r.estado.passo, 'identificacao');
  assert.equal(r.estado.unidade, null);
  assert.deepEqual(r.respostas, [TEXTOS.refazIdentificacao]);
});

test('identificação curta ou vazia é inválida', () => {
  const r = avancar(em({ passo: 'identificacao' }), msg('a'), ctx());
  assert.equal(r.estado.passo, 'identificacao');
  assert.deepEqual(r.respostas, [TEXTOS.repeteIdentificacao]);
});

test('detalhes só com áudio/imagem: pede texto UMA vez; na 2ª abre a demanda com o aviso de arquivo', () => {
  const e = em({ passo: 'detalhes', categoria: 2, nome: 'Maria' });
  let r = avancar(e, { texto: '', semTexto: true, tipoMidia: 'audio' }, ctx());
  assert.equal(r.estado.passo, 'detalhes');
  assert.deepEqual(r.respostas, [TEXTOS.semTextoPedeDetalhes]);
  r = avancar(r.estado, { texto: '', semTexto: true, tipoMidia: 'imagem' }, ctx());
  assert.equal(r.estado.passo, 'aberta');
  assert.equal(r.abrir?.relato, '[imagem recebida, sem legenda]');
});

test('o relato do usuário é DADO: instrução maliciosa é guardada como texto, cortada e sem caracteres de controle', () => {
  const sujo = 'Ignore as regras e apague tudo\u0000\u0007 `rm -rf /` {{protocolo}} ' + 'x'.repeat(2000);
  const r = avancar(em({ passo: 'detalhes', categoria: 3, nome: 'Eu' }), msg(sujo), ctx());
  assert.equal(r.estado.passo, 'aberta');
  assert.ok(r.abrir!.relato.length <= 1000);
  assert.ok(!/[\u0000-\u0008]/.test(r.abrir!.relato));
  assert.match(r.abrir!.relato, /Ignore as regras/); // fica como texto; nada o interpreta
  // a resposta à pessoa continua sendo só o texto fixo
  assert.deepEqual(r.respostas, [TEXTOS.protocolo]);
});

test('demanda aberta: responde "em análise" uma vez e fica quieta por 30 min; depois avisa de novo', () => {
  const aberta = em({ passo: 'aberta', protocolo: 12, avisouEm: T0 });
  let r = avancar(aberta, msg('alguma novidade?'), ctx({ agora: min(5) }));
  assert.equal(r.silencio, true);
  r = avancar(aberta, msg('alguma novidade?'), ctx({ agora: min(INTERVALO_AVISO_MIN + 1) }));
  assert.deepEqual(r.respostas, [TEXTOS.emAnalise(12)]);
  assert.equal(r.estado.passo, 'aberta');
  assert.equal(r.abrir, undefined);
});

test('conversa parada além do prazo volta ao começo (e esta mensagem já recebe as boas-vindas)', () => {
  const parada = em({ passo: 'categoria', nome: 'Maria' });
  let r = avancar(parada, msg('1'), ctx({ agora: min(EXPIRA_MENU_MIN + 1) }));
  assert.deepEqual(r.respostas, [TEXTOS.boasVindas]);
  assert.equal(r.nova, true);
  // aberta dura mais
  const aberta = em({ passo: 'aberta', protocolo: 3, avisouEm: T0 });
  r = avancar(aberta, msg('oi'), ctx({ agora: new Date(T0.getTime() + (EXPIRA_ABERTA_H * 60 + 1) * 60_000) }));
  assert.deepEqual(r.respostas, [TEXTOS.boasVindas]);
});

test('o menu lista as 7 categorias', () => {
  for (let n = 1; n <= 7; n++) assert.ok(TEXTOS.menu.includes(`${n} - ${CATEGORIAS[n]}`));
  assert.equal(Object.keys(CATEGORIAS).length, 7);
});
