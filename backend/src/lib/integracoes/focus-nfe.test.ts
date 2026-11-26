import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErroFocus, FOCUS_HOMOLOGACAO, FOCUS_PRODUCAO, cancelarNota, consultarCnpj, consultarEmpresa, consultarNota, emitirNota, lerContasDoAmbiente, limparTexto, listarGatilhos, testarToken,
  unidadesLigadasDaFocus,
} from './focus-nfe.js';

const TOKEN = 'TOKENdeTESTE1234567890abcdefghij';
const CRED_H = { token: TOKEN, ambiente: 'homologacao' as const };
const CRED_P = { token: TOKEN, ambiente: 'producao' as const };

interface Chamada {
  url: string;
  metodo: string;
  autorizacao: string | null;
  corpo: unknown;
}
const json = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function falsa(respostas: Array<Response | Error | (() => Response | Promise<Response>)>) {
  const chamadas: Chamada[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), metodo: String(init?.method), autorizacao: new Headers(init?.headers).get('authorization'), corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = respostas[Math.min(chamadas.length - 1, respostas.length - 1)]!;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  }) as typeof fetch;
  return { fetcher, chamadas };
}
const op = (fetcher: typeof fetch) => ({ fetcher, esperaMs: 0 });

// ----------------------------------------------------------------- autenticação e ambientes (conforme a documentação)

test('autenticação: HTTP Basic com o token como usuário e a SENHA EM BRANCO (base64 de "token:")', async () => {
  const { fetcher, chamadas } = falsa([json(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' })]);
  await consultarNota(CRED_H, 'ddnfabc123', op(fetcher));
  assert.equal(chamadas[0]!.autorizacao, `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`);
  assert.ok(Buffer.from(chamadas[0]!.autorizacao!.slice(6), 'base64').toString().endsWith(':'), 'os dois pontos finais (senha vazia) são intencionais');
});

test('ambientes: homologação e produção têm URL base própria e o prefixo /v2; o token nunca vai na URL', async () => {
  const h = falsa([json(404, {})]);
  const p = falsa([json(404, {})]);
  await consultarNota(CRED_H, 'ref1', op(h.fetcher));
  await consultarNota(CRED_P, 'ref1', op(p.fetcher));
  assert.equal(h.chamadas[0]!.url, `${FOCUS_HOMOLOGACAO}/v2/nfsen/ref1`);
  assert.equal(p.chamadas[0]!.url, `${FOCUS_PRODUCAO}/v2/nfsen/ref1`);
  assert.equal(FOCUS_HOMOLOGACAO, 'https://homologacao.focusnfe.com.br');
  assert.equal(FOCUS_PRODUCAO, 'https://api.focusnfe.com.br');
  assert.ok(!h.chamadas[0]!.url.includes(TOKEN));
});

test('referência: só letras e números (a Focus recusa o resto); nada é chamado com uma inválida', async () => {
  const { fetcher, chamadas } = falsa([json(404, {})]);
  for (const ruim of ['', 'a b', 'a/b', '../x', 'ação', 'x'.repeat(51)]) await assert.rejects(() => consultarNota(CRED_H, ruim, op(fetcher)), /referência inválida/);
  await assert.rejects(() => emitirNota(CRED_H, 'a?b=1', {}, op(fetcher)), /referência inválida/);
  await assert.rejects(() => cancelarNota(CRED_H, 'a/b', 'x'.repeat(20), op(fetcher)), /referência inválida/);
  assert.equal(chamadas.length, 0);
});

// ----------------------------------------------------------------- consultar

test('consultar: 200 devolve os campos documentados (autorizada); 404 = referência desconhecida (null)', async () => {
  const autorizada = {
    cnpj_prestador: '12345678000123', ref: 'ddnfabc', numero_rps: '73895', serie_rps: '1', tipo_rps: '1', status: 'autorizado', numero: '74798', codigo_verificacao: 'ABC123',
    data_emissao: '2026-03-30T11:25:14-03:00', url: 'https://www.nfse.gov.br/consultapublica/?tpc=1&chave=42054', caminho_xml_nota_fiscal: '/arquivos/123_1/202603/XMLsNFSe/NFS42054-nfse.xml',
    url_danfse: 'https://focusnfe.s3.sa-east-1.amazonaws.com/arquivos/123_1/202603/DANFSEs/NFS42054.pdf',
  };
  const { fetcher } = falsa([json(200, autorizada)]);
  const n = await consultarNota(CRED_P, 'ddnfabc', op(fetcher));
  assert.deepEqual(n, {
    status: 'autorizado', ref: 'ddnfabc', numero: '74798', codigoVerificacao: 'ABC123', dataEmissao: '2026-03-30T11:25:14-03:00', urlConsulta: 'https://www.nfse.gov.br/consultapublica/?tpc=1&chave=42054',
    urlDanfse: 'https://focusnfe.s3.sa-east-1.amazonaws.com/arquivos/123_1/202603/DANFSEs/NFS42054.pdf', caminhoXml: '/arquivos/123_1/202603/XMLsNFSe/NFS42054-nfse.xml',
  });
  const nao = falsa([json(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' })]);
  assert.equal(await consultarNota(CRED_P, 'ddnfzzz', op(nao.fetcher)), null);
});

test('consultar: erro_autorizacao traz a lista de erros (codigo, mensagem, correcao)', async () => {
  const { fetcher } = falsa([json(200, { status: 'erro_autorizacao', ref: 'r1', erros: [{ codigo: 'E0014', mensagem: 'Conjunto de Série, Número ... já existe', correcao: null }] })]);
  const n = await consultarNota(CRED_H, 'r1', op(fetcher));
  assert.equal(n?.status, 'erro_autorizacao');
  assert.deepEqual(n?.erros, [{ codigo: 'E0014', mensagem: 'Conjunto de Série, Número ... já existe' }]);
});

test('consultar: leitura TEM nova tentativa limitada (3) em 503, e depois falha em português; 401 não repete e fala do outro ambiente', async () => {
  const { fetcher, chamadas } = falsa([new Response('x', { status: 503 })]);
  await assert.rejects(() => consultarNota(CRED_H, 'r1', op(fetcher)), /respondeu 503/);
  assert.equal(chamadas.length, 3);
  const ok = falsa([new Response('x', { status: 503 }), json(200, { status: 'processando_autorizacao', ref: 'r1' })]);
  assert.equal((await consultarNota(CRED_H, 'r1', op(ok.fetcher)))?.status, 'processando_autorizacao');
  assert.equal(ok.chamadas.length, 2);
  const u = falsa([new Response('HTTP Basic: Access denied', { status: 401 })]);
  await assert.rejects(() => consultarNota(CRED_H, 'r1', op(u.fetcher)), /não reconheceu o token \(401\).*OUTRO ambiente/);
  assert.equal(u.chamadas.length, 1);
});

test('consultar: um 200 que não é JSON (proxy) não vira nota', async () => {
  const { fetcher } = falsa([new Response('<html>manutenção</html>', { status: 200 })]);
  await assert.rejects(() => consultarNota(CRED_H, 'r1', op(fetcher)), /formato inesperado/);
});

// ----------------------------------------------------------------- emitir: NUNCA repete

test('emitir: POST /v2/nfsen?ref= com o corpo em JSON; 202 = aceita (processando_autorizacao)', async () => {
  const { fetcher, chamadas } = falsa([json(202, { cnpj_prestador: '12345678000123', ref: 'ddnf1', status: 'processando_autorizacao' })]);
  const r = await emitirNota(CRED_H, 'ddnf1', { valor_servico: 1 }, op(fetcher));
  assert.equal(r.status, 'processando_autorizacao');
  assert.equal(chamadas[0]!.metodo, 'POST');
  assert.equal(chamadas[0]!.url, `${FOCUS_HOMOLOGACAO}/v2/nfsen?ref=ddnf1`);
  assert.deepEqual(chamadas[0]!.corpo, { valor_servico: 1 });
});

test('emitir: NUNCA tenta de novo (503, timeout e rede: uma chamada só) — repetir poderia emitir duas notas', async () => {
  for (const resposta of [new Response('x', { status: 503 }), new Response('x', { status: 429 }), Object.assign(new Error('t'), { name: 'TimeoutError' }), new Error('ECONNRESET')]) {
    const { fetcher, chamadas } = falsa([resposta]);
    await assert.rejects(() => emitirNota(CRED_P, 'ddnf1', {}, { fetcher, esperaMs: 0, tentativas: 3 }), ErroFocus);
    assert.equal(chamadas.length, 1, 'uma tentativa só');
  }
});

test('emitir: 400/422 trazem {codigo, mensagem} da Focus e viram recusa com o status (nada foi emitido)', async () => {
  const a = falsa([json(400, { codigo: 'requisicao_invalida', mensagem: 'O campo dfe.prestador.cpf_cnpj é obrigatório.' })]);
  await assert.rejects(() => emitirNota(CRED_H, 'r', {}, op(a.fetcher)), (e: unknown) => e instanceof ErroFocus && e.status === 400 && e.codigo === 'requisicao_invalida' && /campo dfe\.prestador\.cpf_cnpj é obrigatório/.test(e.message));
  const b = falsa([json(422, { codigo: 'erro_validacao', mensagem: 'Já existe um DPS com esta referência.' })]);
  await assert.rejects(() => emitirNota(CRED_H, 'r', {}, op(b.fetcher)), (e: unknown) => e instanceof ErroFocus && e.status === 422 && /Já existe um DPS/.test(e.message));
});

test('emitir: um 200 sem o status documentado (proxy) é INCERTO (status null), não aceita', async () => {
  const { fetcher } = falsa([json(200, { ok: true })]);
  await assert.rejects(() => emitirNota(CRED_P, 'r', {}, op(fetcher)), (e: unknown) => e instanceof ErroFocus && e.status === null);
});

// ----------------------------------------------------------------- cancelar

test('cancelar: DELETE /v2/nfsen/{ref} com {justificativa}; síncrono; `cancelado` e `erro_cancelamento` voltam como resultado; NÃO repete', async () => {
  const ok = falsa([json(200, { status: 'cancelado' })]);
  assert.deepEqual(await cancelarNota(CRED_H, 'ddnf1', 'Emissão em duplicidade', op(ok.fetcher)), { status: 'cancelado' });
  assert.equal(ok.chamadas[0]!.metodo, 'DELETE');
  assert.equal(ok.chamadas[0]!.url, `${FOCUS_HOMOLOGACAO}/v2/nfsen/ddnf1`);
  assert.deepEqual(ok.chamadas[0]!.corpo, { justificativa: 'Emissão em duplicidade' });
  const negado = falsa([json(200, { status: 'erro_cancelamento', erros: [{ codigo: 'V999', mensagem: 'NFSe fora do prazo de cancelamento permitido', correcao: null }] })]);
  const r = await cancelarNota(CRED_H, 'ddnf1', 'Emissão em duplicidade', op(negado.fetcher));
  assert.equal(r.status, 'erro_cancelamento');
  assert.equal(r.erros?.[0]?.codigo, 'V999');
  const queda = falsa([new Response('x', { status: 503 })]);
  await assert.rejects(() => cancelarNota(CRED_H, 'ddnf1', 'Emissão em duplicidade', { fetcher: queda.fetcher, esperaMs: 0 }), ErroFocus);
  assert.equal(queda.chamadas.length, 1);
  const nf = falsa([json(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' })]);
  await assert.rejects(() => cancelarNota(CRED_H, 'x', 'Emissão em duplicidade', op(nf.fetcher)), (e: unknown) => e instanceof ErroFocus && e.status === 404);
});

// ----------------------------------------------------------------- o token nunca aparece

test('o token nunca aparece em erro, nem se a Focus o repetir na mensagem ou no corpo', async () => {
  const eco = falsa([json(422, { codigo: 'erro_validacao', mensagem: `token ${TOKEN} inválido; Authorization: Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}; CPF 12345678909` })]);
  await assert.rejects(
    () => emitirNota(CRED_P, 'r', {}, op(eco.fetcher)),
    (e: unknown) => {
      const m = (e as Error).message;
      assert.ok(!m.includes(TOKEN), m);
      assert.ok(!m.includes(Buffer.from(`${TOKEN}:`).toString('base64')), m);
      assert.ok(!m.includes('12345678909'), 'documento inteiro também não sai');
      return true;
    },
  );
  assert.equal(limparTexto(`x ${TOKEN} y`, TOKEN), 'x [token] y');
  assert.ok(!limparTexto('Authorization: Basic QUJDREVGR0hJSktMTU5PUA==').includes('QUJDREVG'));
});

test('timeout e rede: mensagem em português, sem URL com token', async () => {
  const t = falsa([Object.assign(new Error('t'), { name: 'TimeoutError' })]);
  await assert.rejects(() => emitirNota(CRED_P, 'r', {}, op(t.fetcher)), /não respondeu a tempo/);
  const r = falsa([new Error(`falha em https://x?token=${TOKEN}`)]);
  await assert.rejects(() => emitirNota(CRED_P, 'r', {}, op(r.fetcher)), (e: unknown) => !(e as Error).message.includes(TOKEN) && /rede/.test((e as Error).message));
});

// ----------------------------------------------------------------- leituras auxiliares

test('testarToken: 404 de referência inexistente = token aceito; 401 = recusado; é um GET', async () => {
  const ok = falsa([json(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' })]);
  await testarToken(CRED_H, op(ok.fetcher));
  assert.equal(ok.chamadas[0]!.metodo, 'GET');
  const no = falsa([new Response('HTTP Basic: Access denied', { status: 401 })]);
  await assert.rejects(() => testarToken(CRED_H, op(no.fetcher)), /não reconheceu o token/);
});

test('listarGatilhos, consultarCnpj e consultarEmpresa: formatos documentados', async () => {
  const g = falsa([json(200, [{ id: 'Vj5rmkBq', url: 'https://x/focus-nfe/webhook/u/seg', authorization: null, authorization_header: null, event: 'nfsen', cnpj: '12345678000123' }])]);
  assert.deepEqual(await listarGatilhos(CRED_P, op(g.fetcher)), [{ event: 'nfsen', cnpj: '12345678000123', url: 'https://x/focus-nfe/webhook/u/seg' }]);
  const c = falsa([json(200, { razao_social: 'MAGALHAES CLINICA', cnpj: '63130582000140', situacao_cadastral: 'ativa', cnae_principal: '8650004', optante_simples_nacional: true, optante_mei: false, endereco: { codigo_ibge: '2100055', nome_municipio: 'Açailândia' } })]);
  assert.deepEqual(await consultarCnpj(CRED_P, '63.130.582/0001-40', op(c.fetcher)), { razaoSocial: 'MAGALHAES CLINICA', situacao: 'ativa', optanteSimples: true, optanteMei: false, cnaePrincipal: '8650004', codigoIbge: '2100055', municipio: 'Açailândia' });
  assert.equal(c.chamadas[0]!.url, `${FOCUS_PRODUCAO}/v2/cnpjs/63130582000140`);
  const vazia = falsa([json(200, [])]);
  assert.equal(await consultarEmpresa(CRED_P, '63130582000140', op(vazia.fetcher)), null);
  const e = falsa([json(200, [{ cnpj: '63130582000140', habilita_nfsen_producao: false, habilita_nfsen_homologacao: true, serie_nfsen_homologacao: 1, proximo_numero_nfsen_homologacao: 5, inscricao_municipal: '123', certificado_valido_ate: '2027-01-01T00:00:00-03:00' }])]);
  assert.deepEqual(await consultarEmpresa(CRED_P, '63130582000140', op(e.fetcher)), {
    habilitaNfsenHomologacao: true, habilitaNfsenProducao: false, inscricaoMunicipal: '123', certificadoValidoAte: '2027-01-01T00:00:00-03:00', serieNfsenHomologacao: 1, proximoNumeroNfsenHomologacao: 5,
  });
  await assert.rejects(() => consultarCnpj(CRED_P, '123', op(c.fetcher)), /CNPJ inválido/);
});

// ----------------------------------------------------------------- ambiente do servidor

const UNIDADES = [
  { slug: 'doutor-hernia-acailandia', nome: 'Açailândia', ativa: true },
  { slug: 'doutor-hernia-timbo', nome: 'Timbó', ativa: true },
  { slug: 'doutor-hernia-balsas', nome: 'Balsas', ativa: false },
];

test('ambiente: SEM variáveis nada é carregado (tudo desligado, igual a hoje)', () => {
  assert.equal(unidadesLigadasDaFocus({}).size, 0);
  const r = lerContasDoAmbiente(UNIDADES, {});
  assert.equal(r.contas.size, 0);
  assert.deepEqual(r.ignoradas, []);
  // vazia, "*" e lixo não ligam nada
  assert.equal(unidadesLigadasDaFocus({ FOCUS_NFE_UNIDADES: '' }).size, 0);
  assert.equal(unidadesLigadasDaFocus({ FOCUS_NFE_UNIDADES: '*, todas*' }).size, 0);
});

test('ambiente: token + FOCUS_NFE_UNIDADES; o padrão é HOMOLOGAÇÃO; só vira conta a unidade da lista', () => {
  const e = { FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia', FOCUS_NFE_TOKEN_ACAILANDIA: TOKEN, FOCUS_NFE_TOKEN_TIMBO: 'OUTROtoken1234567890abcdefghij' };
  const r = lerContasDoAmbiente(UNIDADES, e);
  assert.deepEqual([...r.contas.keys()], ['doutor-hernia-acailandia']);
  assert.equal(r.contas.get('doutor-hernia-acailandia')!.ambiente, 'homologacao');
  assert.equal(r.contas.get('doutor-hernia-acailandia')!.numeroInicial, 1);
  assert.deepEqual(r.ignoradas, [{ variavel: 'FOCUS_NFE_TOKEN_TIMBO', motivo: 'a unidade doutor-hernia-timbo não está em FOCUS_NFE_UNIDADES' }]);
});

test('ambiente: FOCUS_NFE_AMBIENTE_<UNIDADE> aceita só homologacao|producao; qualquer outra coisa deixa a conta DE FORA (nunca cai em produção nem no padrão)', () => {
  const base = { FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia', FOCUS_NFE_TOKEN_ACAILANDIA: TOKEN };
  assert.equal(lerContasDoAmbiente(UNIDADES, { ...base, FOCUS_NFE_AMBIENTE_ACAILANDIA: 'producao' }).contas.get('doutor-hernia-acailandia')!.ambiente, 'producao');
  assert.equal(lerContasDoAmbiente(UNIDADES, { ...base, FOCUS_NFE_AMBIENTE_ACAILANDIA: 'Homologacao' }).contas.get('doutor-hernia-acailandia')!.ambiente, 'homologacao');
  for (const ruim of ['produção', 'prod', 'true', '1']) {
    const r = lerContasDoAmbiente(UNIDADES, { ...base, FOCUS_NFE_AMBIENTE_ACAILANDIA: ruim });
    assert.equal(r.contas.size, 0, ruim);
    assert.match(r.ignoradas[0]!.motivo, /use homologacao ou producao/);
  }
});

test('ambiente: CNPJ, município, série e número inicial entram validados; o valor inválido é ignorado SEM eco', () => {
  const e = {
    FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia', FOCUS_NFE_TOKEN_ACAILANDIA: TOKEN, FOCUS_NFE_CNPJ_ACAILANDIA: '63.130.582/0001-40', FOCUS_NFE_MUNICIPIO_ACAILANDIA: '2100055',
    FOCUS_NFE_SERIE_DPS_ACAILANDIA: '900', FOCUS_NFE_NUMERO_INICIAL_ACAILANDIA: '7',
  };
  const c = lerContasDoAmbiente(UNIDADES, e).contas.get('doutor-hernia-acailandia')!;
  assert.deepEqual([c.cnpj, c.municipio, c.serieDps, c.numeroInicial], ['63130582000140', '2100055', 900, 7]);
  const ruim = lerContasDoAmbiente(UNIDADES, { ...e, FOCUS_NFE_SERIE_DPS_ACAILANDIA: '50000', FOCUS_NFE_MUNICIPIO_ACAILANDIA: 'abc', FOCUS_NFE_CNPJ_ACAILANDIA: '123' });
  const conta = ruim.contas.get('doutor-hernia-acailandia')!;
  assert.deepEqual([conta.cnpj, conta.municipio, conta.serieDps], [undefined, undefined, undefined]);
  assert.equal(ruim.ignoradas.length, 3);
  assert.ok(!JSON.stringify(ruim.ignoradas).includes('50000'));
});

test('ambiente: o mesmo token em duas unidades, unidade inativa e nome ambíguo ficam de fora (um token, uma unidade)', () => {
  const e = { FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia,doutor-hernia-timbo,doutor-hernia-balsas', FOCUS_NFE_TOKEN_ACAILANDIA: TOKEN, FOCUS_NFE_TOKEN_TIMBO: TOKEN, FOCUS_NFE_TOKEN_BALSAS: 'BALSAStoken1234567890abcdefghij', FOCUS_NFE_TOKEN_CLINICA: 'x'.repeat(30) };
  const r = lerContasDoAmbiente([...UNIDADES, { slug: 'norte-clinica', nome: 'N', ativa: true }, { slug: 'sul-clinica', nome: 'S', ativa: true }], e);
  assert.deepEqual([...r.contas.keys()], ['doutor-hernia-acailandia']);
  const motivos = r.ignoradas.map((i) => i.motivo).join(' | ');
  assert.match(motivos, /um token, uma unidade/);
  assert.match(motivos, /inativa/);
  assert.match(motivos, /ambígua/);
  assert.ok(!motivos.includes(TOKEN), 'o token nunca vai para o motivo');
});

test('ambiente: token com formato estranho é ignorado; variável de ambiente/CNPJ sem token é ignorada', () => {
  const r = lerContasDoAmbiente(UNIDADES, { FOCUS_NFE_UNIDADES: 'doutor-hernia-acailandia', FOCUS_NFE_TOKEN_ACAILANDIA: 'curto', FOCUS_NFE_AMBIENTE_TIMBO: 'producao' });
  assert.equal(r.contas.size, 0);
  assert.equal(r.ignoradas.length, 2);
});
