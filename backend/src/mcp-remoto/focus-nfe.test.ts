import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroFocus } from '../lib/integracoes/focus-nfe.js';
import { armazemDeNotasPrisma, type BancoDeNotas, type LinhaDaNota } from './focus-nfe-armazem.js';
import { armazemDeNotasEmMemoria, focusEmMemoria } from './focus-nfe-falso.js';
import { PERFIS_FISCAIS } from './focus-nfe-perfis.js';
import {
  LivroDeNotas, criarContextoFocus, dadosFiscais, limitesDoAmbiente, listarNotas, notasPorHora, patchDaConsulta, resolverContaFocus, tetoPorDiaFocus, tetoPorNota, urlDoXml, verNota,
  type ContaFocus, type NotaGuardada,
} from './focus-nfe.js';

const UNI = 'doutor-hernia-acailandia';
const AGORA = Date.parse('2026-11-26T15:00:00Z');

function nota(sobre: Partial<NotaGuardada> = {}): NotaGuardada {
  return {
    referencia: 'ddnf1', unidade: UNI, ambiente: 'homologacao', status: 'autorizado', serieDps: 1, numeroDps: 1, valorCentavos: 15000, dataCompetencia: '2026-11-25', tomadorMascarado: '***.***.247-**', origem: null,
    chaveDuplicata: 'x', criadoPor: 'a@b.c', criadoEm: new Date(AGORA - 3_600_000).toISOString(), numeroNfse: '10', codigoVerificacao: 'ABC', urlConsulta: 'https://www.nfse.gov.br/c?x=1',
    urlDanfse: 'https://focusnfe.s3.sa-east-1.amazonaws.com/x.pdf', caminhoXml: '/arquivos/x/y-nfse.xml', emitidaEm: null, canceladaEm: null, revisao: null, ultimoEvento: null, erro: null, ...sobre,
  };
}

function montar(op: { ambiente?: 'homologacao' | 'producao'; semCnpj?: boolean; serie?: number } = {}) {
  const { focus, fonte } = focusEmMemoria();
  const armazem = armazemDeNotasEmMemoria();
  const conta: ContaFocus = {
    slug: UNI, nome: 'Açailândia', ambiente: op.ambiente ?? 'homologacao', ...(op.semCnpj ? {} : { cnpj: '63130582000140', municipio: '2100055' }), ...(op.serie !== undefined ? { serieDps: op.serie } : {}), numeroInicial: 1,
    perfil: PERFIS_FISCAIS[UNI]!, fonte,
  };
  const ctx = criarContextoFocus(new Map([[UNI, conta]]), armazem, { agora: () => AGORA, webhookConfigurado: true });
  return { ctx, focus, armazem, conta };
}
const LIM = { tetoNota: () => 5000, tetoDia: () => 20000, porHora: () => 20 };

test('limites: padrões 5.000 por nota, 20.000 por dia, 20 por hora; vazio/lixo = padrão; notas por hora 0 ou lixo = DESLIGADO', () => {
  assert.deepEqual([tetoPorNota({}), tetoPorDiaFocus({}), notasPorHora({})], [5000, 20000, 20]);
  assert.deepEqual([tetoPorNota({ FOCUS_NFE_TETO_NOTA_REAIS: '300' }), tetoPorDiaFocus({ FOCUS_NFE_TETO_DIA_REAIS: 'lixo' })], [300, 20000]);
  assert.equal(notasPorHora({ FOCUS_NFE_NOTAS_POR_HORA: '0' }), 0);
  assert.equal(notasPorHora({ FOCUS_NFE_NOTAS_POR_HORA: 'abc' }), 0);
  assert.equal(limitesDoAmbiente({ FOCUS_NFE_NOTAS_POR_HORA: '3' }).porHora(), 3);
});

test('livro: recusada e erro não gastam o teto de valor, mas contam no limite por hora; cancelada gasta', () => {
  const l = new LivroDeNotas([
    { valorCentavos: 10000, status: 'autorizado', em: AGORA - 1000 },
    { valorCentavos: 5000, status: 'recusada', em: AGORA - 1000 },
    { valorCentavos: 7000, status: 'erro_autorizacao', em: AGORA - 1000 },
    { valorCentavos: 2000, status: 'cancelado', em: AGORA - 1000 },
    { valorCentavos: 9000, status: 'autorizado', em: AGORA - 30 * 3_600_000 },
  ]);
  assert.equal(l.somaDoDia(AGORA), 120);
  assert.equal(l.naHora(AGORA), 4);
});

test('resolver a conta: sem contas, ambígua e desconhecida dizem o que fazer', () => {
  assert.throws(() => resolverContaFocus(criarContextoFocus(new Map(), armazemDeNotasEmMemoria()), undefined), /nenhuma unidade com a Focus NFe ligada/);
  const m = montar();
  assert.equal(resolverContaFocus(m.ctx, undefined).slug, UNI);
  assert.equal(resolverContaFocus(m.ctx, 'acailandia').slug, UNI);
  assert.throws(() => resolverContaFocus(m.ctx, 'timbo'), /sem Focus NFe/);
});

test('focus_dados_fiscais: ambiente em maiúsculas, token aceito, perfil, o que a contabilidade informa, sem token nenhum; nada é escrito', async () => {
  const m = montar();
  m.focus.gatilhos = [{ event: 'nfsen', url: `https://x.exemplo.com/focus-nfe/webhook/${UNI}/segredo` }];
  const r = (await dadosFiscais(m.ctx, LIM, {})) as Record<string, unknown>;
  assert.equal(r.ambiente, 'HOMOLOGAÇÃO');
  assert.match(String(r.avisoDoAmbiente), /NÃO tem validade fiscal/);
  assert.equal(r.tokenNaFocus, 'aceito');
  assert.deepEqual(r.webhook, { segredoConfigurado: true, cadastradoNaFocus: true });
  assert.ok(JSON.stringify(r).includes('040802'));
  assert.ok((r.oQueAContabilidadeInforma as string[]).some((x) => /aliquotaIss.*PENDENTE/.test(x)));
  assert.ok(!(r.oQueAContabilidadeInforma as string[]).some((x) => /codigoTributacaoNacional/.test(x)), 'o perfil já traz o cTribNac');
  assert.ok(!JSON.stringify(r).includes('/focus-nfe/webhook/') && !JSON.stringify(r).includes('x.exemplo.com'), 'a URL do gatilho (com o segredo) nunca sai');
  assert.equal(m.focus.emitidas.length + m.focus.cancelamentos.length, 0);
  assert.deepEqual(r.faltaConfigurar, []);
  // produção sem série e token recusado aparecem como pendência
  const p = montar({ ambiente: 'producao' });
  p.focus.tokenRecusado = true;
  const rp = (await dadosFiscais(p.ctx, LIM, {})) as { ambiente: string; faltaConfigurar: string[]; cuidados: string[]; tokenNaFocus: { recusado: string } };
  assert.equal(rp.ambiente, 'PRODUÇÃO');
  assert.ok(rp.faltaConfigurar.some((x) => /FOCUS_NFE_SERIE_DPS/.test(x)));
  assert.match(rp.tokenNaFocus.recusado, /não reconheceu o token/);
  assert.ok(rp.cuidados.some((x) => /NÃO foi aceito/.test(x)));
});

test('focus_dados_fiscais: série diferente da Focus e município diferente do cadastro público viram cuidado', async () => {
  const m = montar({ serie: 900, ambiente: 'producao' });
  m.focus.empresa = { serieNfsenProducao: 1, proximoNumeroNfsenProducao: 40, habilitaNfsenProducao: true };
  m.focus.cadastro = { situacao: 'ativa', codigoIbge: '9999999' };
  const r = (await dadosFiscais(m.ctx, LIM, {})) as { cuidados: string[]; proximoNumeroNaFocus: number };
  assert.ok(r.cuidados.some((x) => /série configurada no conector \(900\).*\(1\)/.test(x)));
  assert.ok(r.cuidados.some((x) => /9999999/.test(x)));
  assert.equal(r.proximoNumeroNaFocus, 40);
});

test('focus_notas: lista o livro local com documento mascarado e diz o que a API não lista; filtra por status e período', async () => {
  const m = montar();
  m.armazem.linhas.push(nota({ referencia: 'a1' }), nota({ referencia: 'a2', status: 'cancelado' }), nota({ referencia: 'a3', criadoEm: '2026-10-01T12:00:00.000Z' }));
  const r = (await listarNotas(m.ctx, {})) as { quantidade: number; notas: Array<{ tomador: string; ambiente: string }>; limitesDaApi: string; somaDasNotasAtivas: string };
  assert.equal(r.quantidade, 3);
  assert.ok(r.notas.every((n) => n.tomador === '***.***.247-**' && n.ambiente === 'HOMOLOGAÇÃO'));
  assert.match(r.limitesDaApi, /não lista notas da NFS-e Nacional/);
  assert.equal(((await listarNotas(m.ctx, { status: 'cancelado' })) as { quantidade: number }).quantidade, 1);
  assert.equal(((await listarNotas(m.ctx, { de: '2026-11-01', ate: '2026-11-30' })) as { quantidade: number }).quantidade, 2);
  await assert.rejects(() => listarNotas(m.ctx, { de: '2026-12-01', ate: '2026-11-01' }), /invertido/);
  await assert.rejects(() => listarNotas(m.ctx, { status: 'qualquer' }), /status inválido/);
  // notas de OUTRO ambiente nunca entram na lista deste
  m.armazem.linhas.push(nota({ referencia: 'p1', ambiente: 'producao' }));
  assert.equal(((await listarNotas(m.ctx, {})) as { quantidade: number }).quantidade, 3);
});

test('focus_notas atualizar=true pergunta à Focus só das notas em processamento', async () => {
  const m = montar();
  m.armazem.linhas.push(nota({ referencia: 'p1', status: 'processando_autorizacao', numeroNfse: null }), nota({ referencia: 'ok1' }));
  m.focus.notas.set('p1', { status: 'processando_autorizacao', ref: 'p1' });
  m.focus.autorizar('p1', '55');
  const r = (await listarNotas(m.ctx, { atualizar: true })) as { atualizadasAgora: number; notas: Array<{ referencia: string; status: string }> };
  assert.equal(r.atualizadasAgora, 1);
  assert.deepEqual(m.focus.consultas, ['p1']);
  assert.equal(r.notas.find((n) => n.referencia === 'p1')!.status, 'autorizado');
});

test('focus_nota: devolve número, código, links do portal, PDF e XML (a base do ambiente + o caminho) e atualiza o livro; Focus fora do ar usa o livro e avisa', async () => {
  const m = montar();
  m.armazem.linhas.push(nota({ referencia: 'ddnfx', status: 'processando_autorizacao', numeroNfse: null, urlDanfse: null, caminhoXml: null, urlConsulta: null }));
  m.focus.notas.set('ddnfx', { status: 'processando_autorizacao', ref: 'ddnfx' });
  m.focus.autorizar('ddnfx', '321');
  const r = (await verNota(m.ctx, { referencia: 'ddnfx' })) as { nota: Record<string, string>; avisoDoAmbiente: string };
  assert.equal(r.nota.status, 'autorizado');
  assert.equal(r.nota.numeroDaNota, '321');
  assert.ok(r.nota.pdf?.startsWith('https://focusnfe.s3'));
  assert.ok(r.nota.consultaNoPortal?.startsWith('https://www.nfse.gov.br'));
  assert.equal(r.nota.xml, 'https://homologacao.focusnfe.com.br/arquivos/teste/XMLsNFSe/ddnfx-nfse.xml');
  assert.match(r.avisoDoAmbiente, /HOMOLOGAÇÃO/);
  m.focus.falhas.consultar = new ErroFocus('rede');
  const off = (await verNota(m.ctx, { referencia: 'ddnfx' })) as { avisoDaConsulta: string; nota: Record<string, string> };
  assert.match(off.avisoDaConsulta, /livro local/);
  assert.equal(off.nota.status, 'autorizado');
  await assert.rejects(() => verNota(m.ctx, { referencia: 'naoexiste' }), /não há nota com a referência/);
  assert.equal(urlDoXml('producao', '/arquivos/a.xml'), 'https://api.focusnfe.com.br/arquivos/a.xml');
  assert.equal(urlDoXml('producao', 'https://outro.exemplo.com/a.xml'), null, 'só o caminho /arquivos/ vira link');
});

test('patchDaConsulta: do aberto vai para qualquer lugar; autorizada só vira cancelada; 404 só vira recusada depois de 30 min', () => {
  const aberta = nota({ status: 'processando_autorizacao', criadoEm: new Date(AGORA - 60_000).toISOString() });
  assert.equal(patchDaConsulta(aberta, { status: 'autorizado', numero: '9', dataEmissao: '2026-11-26T11:00:00-03:00' }, AGORA)?.status, 'autorizado');
  assert.equal(patchDaConsulta(aberta, { status: 'erro_autorizacao', erros: [{ codigo: 'E1', mensagem: 'x' }] }, AGORA)?.erro, 'E1 x');
  assert.equal(patchDaConsulta(aberta, { status: 'processando_autorizacao' }, AGORA), null);
  assert.equal(patchDaConsulta(nota({ status: 'autorizado' }), { status: 'processando_autorizacao' }, AGORA), null, 'não volta atrás');
  assert.equal(patchDaConsulta(nota({ status: 'autorizado' }), { status: 'cancelado' }, AGORA)?.status, 'cancelado');
  assert.equal(patchDaConsulta(nota({ status: 'cancelado' }), { status: 'autorizado' }, AGORA), null);
  assert.equal(patchDaConsulta(aberta, null, AGORA), null, '404 logo depois do pedido ainda pode ser fila');
  const velha = nota({ status: 'incerto', criadoEm: new Date(AGORA - 31 * 60_000).toISOString() });
  assert.equal(patchDaConsulta(velha, null, AGORA)?.status, 'recusada');
  assert.equal(patchDaConsulta(aberta, { status: 'status_novo_da_focus' }, AGORA)?.status, undefined, 'status desconhecido não vira status do livro');
});

// ----------------------------------------------------------------- o armazém de produção (Prisma) com um banco de mentira

function bancoDeMentira() {
  const linhas: Array<LinhaDaNota & { id: string }> = [];
  const chamadas: string[] = [];
  const tabela = {
    async findMany({ where }: { where: Record<string, unknown> }) {
      chamadas.push('findMany');
      return linhas.filter((l) => l.unitSlug === where.unitSlug && (!where.ambiente || l.ambiente === where.ambiente));
    },
    async findFirst({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, string> }) {
      const st = (where.status as { in?: string[] } | undefined)?.in;
      let r = linhas.filter((l) => Object.entries(where).every(([k, v]) => k === 'status' ? (st ? st.includes(l.status) : l.status === v) : (l as unknown as Record<string, unknown>)[k] === v));
      if (orderBy?.numeroDps === 'desc') r = [...r].sort((a, b) => b.numeroDps - a.numeroDps);
      return r[0] ?? null;
    },
    async create({ data }: { data: Record<string, unknown> }) {
      if (linhas.some((l) => l.unitSlug === data.unitSlug && l.ambiente === data.ambiente && l.referencia === data.referencia)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      linhas.push({ id: String(linhas.length), createdAt: new Date(AGORA), numeroNfse: null, codigoVerificacao: null, urlConsulta: null, urlDanfse: null, caminhoXml: null, emitidaEm: null, canceladaEm: null, revisao: null, ultimoEvento: null, erro: null, ...(data as object) } as never);
      return null;
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const alvo = linhas.filter((l) => l.unitSlug === where.unitSlug && l.ambiente === where.ambiente && l.referencia === where.referencia);
      for (const l of alvo) Object.assign(l, data);
      return { count: alvo.length };
    },
  };
  const db: BancoDeNotas = { focusNota: tabela as never, async $transaction(fn) { chamadas.push('tx'); return fn({ $executeRaw: async (..._a: unknown[]) => (chamadas.push('lock'), 1), focusNota: tabela as never }); } };
  return { db, linhas, chamadas };
}

const PEDIDO = (n: number, ref: string, conferir: () => void = () => undefined) => ({
  unidade: UNI, ambiente: 'homologacao' as const, referencia: ref, chaveDuplicata: `k${n}`, valorCentavos: 100, dataCompetencia: '2026-11-25', tomadorMascarado: '***', origem: null, criadoPor: 'a', agora: AGORA, serieDps: 1, numeroInicial: 1, conferir,
});

test('armazém Prisma: reservar pega a trava, confere ANTES de gravar, numera em sequência e recusa referência repetida', async () => {
  const b = bancoDeMentira();
  const a = armazemDeNotasPrisma(b.db);
  assert.deepEqual(await a.reservar(PEDIDO(1, 'r1')), { serieDps: 1, numeroDps: 1 });
  assert.deepEqual(await a.reservar(PEDIDO(2, 'r2')), { serieDps: 1, numeroDps: 2 });
  assert.deepEqual(b.chamadas.filter((c) => c === 'lock'), ['lock', 'lock']);
  await assert.rejects(() => a.reservar(PEDIDO(3, 'r1')), /referência r1 ou o número da DPS já foi usado/);
  // conferir recusando: nada é gravado
  const antes = b.linhas.length;
  await assert.rejects(() => a.reservar(PEDIDO(4, 'r4', () => { throw new ErroDeEntrada('teto'); })), /teto/);
  assert.equal(b.linhas.length, antes);
  assert.equal(b.linhas[0]!.status, 'intencao');
  // a nota repetida ATIVA chega à conferência
  b.linhas[0]!.chaveDuplicata = 'k9';
  let viu: NotaGuardada | null = null;
  await a.reservar({ ...PEDIDO(9, 'r9', () => undefined), chaveDuplicata: 'k9', conferir: (_l, r) => { viu = r; } });
  assert.equal((viu as NotaGuardada | null)?.referencia, 'r1');
  const upd = await a.atualizar(UNI, 'homologacao', 'r1', { status: 'autorizado', numeroNfse: '5' });
  assert.equal(upd?.status, 'autorizado');
  assert.equal((await a.porReferenciaEmQualquerAmbiente(UNI, 'r1'))?.numeroNfse, '5');
});

test('armazém Prisma: banco que falha vira "nada foi emitido", sem vazar o erro do banco', async () => {
  const b = bancoDeMentira();
  b.db.$transaction = async () => { throw new Error('connection refused postgres://user:senha@db'); };
  await assert.rejects(() => armazemDeNotasPrisma(b.db).reservar(PEDIDO(1, 'r1')), (e: unknown) => e instanceof ErroDeEntrada && /nada foi emitido/.test(e.message) && !/senha/.test(e.message));
});
