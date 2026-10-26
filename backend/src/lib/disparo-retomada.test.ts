import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recusaDaRetomada, respostaParaTela, type SituacaoParaRetomar } from './disparo/retomada.js';
import { montarPainelDaOnda, type DadosDoPainel } from './disparo/painel.js';
import { FREIOS_PADRAO } from './disparo/freios.js';

const AGORA = new Date(Date.UTC(2026, 9, 27, 15));
const OK: SituacaoParaRetomar = { aprovador: true, estado: 'pausada', pausaCausa: 'sair', aprovadaEm: new Date(Date.UTC(2026, 9, 26, 15)), validadeDias: 7, agora: AGORA, sairamAgora: 4, sairamVisto: 4 };

test('retomar: a pausa por SAIR de uma onda aprovada há pouco, vista pelo aprovador, pode voltar', () => {
  assert.equal(recusaDaRetomada(OK), null);
});

test('retomar: cada recusa tem o seu motivo e o seu status', () => {
  assert.equal(recusaDaRetomada({ ...OK, aprovador: false })?.status, 403, 'quem não está em DISPARO_APROVADORES (o Claude, a chave de serviço)');
  assert.equal(recusaDaRetomada({ ...OK, estado: 'aprovada' })?.status, 409, 'só pausada');
  assert.equal(recusaDaRetomada({ ...OK, estado: 'cancelada' })?.status, 409);
  for (const causa of ['falhas', 'vencida', null]) assert.equal(recusaDaRetomada({ ...OK, pausaCausa: causa })?.status, 422, `causa ${causa}: cancele e remonte`);
  assert.match(recusaDaRetomada({ ...OK, aprovadaEm: new Date(AGORA.getTime() - 8 * 86_400_000) })?.erro ?? '', /passou de 7 dias/);
  assert.equal(recusaDaRetomada({ ...OK, aprovadaEm: null })?.status, 422);
  // sobra de validade: com 1 hora restante a onda pararia de novo, como "vencida" (sem retomada) — melhor recusar agora
  const quaseVencida = new Date(AGORA.getTime() - (7 * 86_400_000 - 3_600_000));
  assert.match(recusaDaRetomada({ ...OK, aprovadaEm: quaseVencida })?.erro ?? '', /vence em menos de um dia/);
  const comFolga = new Date(AGORA.getTime() - (7 * 86_400_000 - 2 * 86_400_000));
  assert.equal(recusaDaRetomada({ ...OK, aprovadaEm: comFolga }), null);
  assert.equal(recusaDaRetomada({ ...OK, validadeDias: 1, aprovadaEm: new Date(AGORA.getTime() - 3_600_000) }), null, 'validade curta: a margem é metade dela, não 1 dia');
  assert.equal(recusaDaRetomada({ ...OK, sairamAgora: 5 })?.status, 409, 'chegou mais um SAIR depois que a tela abriu');
  assert.equal(recusaDaRetomada({ ...OK, sairamVisto: undefined })?.status, 409, 'sem o número que a tela mostrou, não vale');
  assert.equal(recusaDaRetomada({ ...OK, sairamVisto: '4' })?.status, 409, 'número como texto não vale');
});

test('a resposta do SAIR vai para a tela em uma linha, curta e sem número que pareça telefone', () => {
  assert.equal(respostaParaTela('  SAIR  '), 'SAIR');
  assert.equal(respostaParaTela('não quero mais receber\n\nmeu zap é 63 99102-1043'), 'não quero mais receber meu zap é •••');
  assert.equal(respostaParaTela(null), '');
  const longa = respostaParaTela('a'.repeat(300));
  assert.equal(longa.length, 140);
  assert.ok(longa.endsWith('…'));
});

function dados(sobre: Omit<Partial<DadosDoPainel>, 'onda'> & { onda?: Partial<DadosDoPainel['onda']> } = {}): DadosDoPainel {
  const { onda, ...resto } = sobre;
  return {
    onda: { id: 'o1', estado: 'pausada', total: 20, etiqueta: 'rosa', impressao: 'x', aprovadaPor: 'joao@x.com', aprovadaEm: new Date(Date.UTC(2026, 9, 26, 15)), pausaMotivo: '4 pessoas responderam SAIR (limite 3): unidade parada até o João decidir', pausaCausa: 'sair', template: 't', idioma: 'pt_BR', textoModelo: 'Oi {{1}}!', variaveis: ['primeiroNome'], cabecalho: null, ...onda },
    campanhaNome: 'Outubro Rosa',
    unidade: { slug: 'doutor-hernia-canaa', nome: 'Doutor Hérnia Canaã' },
    modo: 'ligado',
    freios: FREIOS_PADRAO,
    resumo: {},
    contagem: { pendente: 10, enviado: 6, saiu: 4 },
    simulados: 0,
    amostra: [{ nome: 'Ana', telefone: '5563991021043' }],
    saidas: [
      { nome: 'Maria', resposta: 'SAIR', quando: null },
      { nome: 'Lúcia', resposta: 'não quero mais receber <b>isso</b>', quando: null },
      { nome: 'Rosa', resposta: '', quando: null },
      { nome: 'Joana', resposta: 'parar', quando: null },
    ],
    conferenciaMeta: { ok: true },
    podeAprovar: true,
    listaDeTeste: null,
    ...resto,
  };
}

test('tela: onda parada por SAIR mostra quem pediu (primeiro nome + o que escreveu) e oferece Retomar ao aprovador', () => {
  const html = montarPainelDaOnda(dados());
  assert.match(html, /Quem pediu SAIR \(4\)/);
  for (const nome of ['Maria', 'Lúcia', 'Rosa', 'Joana']) assert.ok(html.includes(`<td class="esq">${nome}</td>`), nome);
  assert.match(html, /a mensagem não está gravada/);
  assert.ok(!html.includes('<b>isso</b>'), 'o que o paciente escreveu é escapado');
  assert.match(html, /<button id="retomar" >Retomar esta onda \(aceito os 4 pedidos/);
  assert.match(html, /chamar\('retomar',\{sairam:saiu\}\)/);
  assert.match(html, /const saiu=4/);
});

test('tela: sem ser aprovador, ou com a Meta sem conferir, o Retomar vem travado', () => {
  assert.match(montarPainelDaOnda(dados({ podeAprovar: false })), /<button id="retomar" disabled>/);
  assert.match(montarPainelDaOnda(dados({ conferenciaMeta: { ok: false, motivo: 'texto mudou' } })), /<button id="retomar" disabled>/);
  assert.match(montarPainelDaOnda(dados({ conferenciaMeta: null })), /<button id="retomar" disabled>/);
});

test('tela: pausa por outro motivo NÃO tem Retomar; diz para cancelar e montar de novo', () => {
  for (const causa of ['falhas', 'vencida', null]) {
    const html = montarPainelDaOnda(dados({ onda: { pausaCausa: causa }, saidas: [] }));
    assert.ok(!html.includes('id="retomar"'), `causa ${causa}`);
    assert.match(html, /não é por SAIR: não tem retomada/);
  }
});

test('tela: onda aprovada ou concluída nunca mostra o botão; a lista de SAIR aparece sempre que a campanha tem algum', () => {
  const aprovada = montarPainelDaOnda(dados({ onda: { estado: 'aprovada', pausaCausa: null, pausaMotivo: null } }));
  assert.ok(!aprovada.includes('id="retomar"'));
  assert.match(aprovada, /Quem pediu SAIR \(4\)/);
  assert.ok(!montarPainelDaOnda(dados({ saidas: [] })).includes('Quem pediu SAIR'));
});

test('tela: onda já retomada diz por quem e quantos SAIR ele viu', () => {
  const html = montarPainelDaOnda(dados({ onda: { estado: 'aprovada', pausaCausa: null, pausaMotivo: null, retomadaPor: 'joao@x.com', retomadaEm: new Date(Date.UTC(2026, 9, 27, 14)), sairAceitos: 4 } }));
  assert.match(html, /Retomada por joao@x\.com .* vendo 4 pedido\(s\) de SAIR/);
});

// ── as rotas (mesmo estilo do disparo-padrao: lê o arquivo) ──
const rotas = readFileSync(new URL('../routes/api.routes.ts', import.meta.url), 'utf8');

test('RETOMAR exige sessão de super-admin e nunca aceita a chave de serviço (o Claude não retoma)', () => {
  assert.match(rotas, /apiRouter\.post\('\/disparo\/ondas\/:id\/retomar', requireAuth, requireSuperAdmin, disparoOndaRetomarHandler\)/);
  assert.doesNotMatch(rotas, /'\/disparo\/ondas\/:id\/retomar',\s*chaveDeServicoOuSessao/);
  const global = rotas.indexOf('apiRouter.use(requireAuth);');
  const i = rotas.indexOf("'/disparo/ondas/:id/retomar'");
  assert.ok(i > 0 && global > 0 && i < global);
});

test('tela: mostra a oferta que a Sofia vai saber (ou avisa que a campanha não tem)', () => {
  const com = montarPainelDaOnda(dados({ oferta: 'Consulta por R$ 150 até 31/10 <script>x</script>' }));
  assert.match(com, /O que a Sofia vai saber da oferta/);
  assert.match(com, /Consulta por R\$ 150 até 31\/10 &lt;script&gt;/);
  assert.match(montarPainelDaOnda(dados({ oferta: null })), /não tem texto de oferta/);
});
