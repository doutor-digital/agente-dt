/**
 * O sinal por LINK DA INFINITEPAY (sinal-infinitepay.ts + o ramo novo de `gerarSinalPix`): usa o `criarLink` DE VERDADE do conector (tetos, trava, duplicata,
 * portão de unidade, intenção gravada antes), com o armazém em memória e a InfinitePay falsa. Sem banco, sem rede.
 * Sem `deps.infinitepay` (o padrão) o resultado é o do Asaas, igual ao de sempre.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroInfinitepay, type PedidoDeLink } from './integracoes/infinitepay.js';
import { contaInfinitepayDaConfig, criarContextoInfinitepay, type ContaInfinitepay } from '../mcp-remoto/infinitepay.js';
import { criarEscritaInfinitepay, descricaoLimpa } from '../mcp-remoto/infinitepay-escrita.js';
import { armazemEmMemoria } from '../mcp-remoto/infinitepay-falso.js';
import { urlDoAviso } from '../mcp-remoto/infinitepay-webhook.js';
import { acompanharRemarcacao, gerarSinalPix, type BancoDoSinal, type DepsDoSinal, type LinhaDoSinal } from './sinal-pix.js';
import { motivoDaTarefaDoSinal } from '../agent/sinal-pix-tool.js';
import { clienteDoCartao, criadorDeLinkDoSinal, depsDoSinalPorVia, descricaoDoSinal, nomeParaAPagina, telefoneParaAPagina } from './sinal-infinitepay.js';

const UNI = 'doutor-hernia-acailandia';
const UNIT = { id: 'u1', slug: UNI, name: 'Doutor Hérnia Açailândia', sinalPixCentavos: 5000, spineTimezone: 'America/Sao_Paulo' };
const AGORA = new Date('2026-11-26T15:00:00Z'); // 12h em Brasília
const CONSULTA = '2026-11-30T09:00';
const PIX_VALIDO = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865406' + '50.00' + '5802BR5913CLINICA TESTE6009SAO PAULO62070503***63041D3F';

function bancoFalso() {
  const rows: LinhaDoSinal[] = [];
  let n = 0;
  const banco: BancoDoSinal = {
    findMany: async ({ where }) => rows.filter((l) => l.clinica === where.clinica && l.leadId === where.leadId && where.status.in.includes(l.status) && l.criadoEm >= where.criadoEm.gte),
    count: async ({ where }) => rows.filter((l) => l.clinica === where.clinica && l.criadoEm >= where.criadoEm.gte).length,
    create: async ({ data }) => {
      const l: LinhaDoSinal = { id: `s${++n}`, paymentId: null, status: 'pendente', criadoEm: AGORA, pagoEm: null, avisadoEm: null, ...data };
      rows.push(l);
      return l;
    },
    updateMany: async ({ where, data }) => {
      const l = rows.find((r) => r.id === where.id);
      if (l) Object.assign(l, data);
      return { count: l ? 1 : 0 };
    },
    deleteMany: async ({ where }) => {
      const i = rows.findIndex((r) => r.id === where.id);
      if (i >= 0) rows.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    },
  };
  return { banco, rows };
}

/** A InfinitePay e o conector de verdade, a rede falsa. `criar` simula a resposta da InfinitePay. */
function infinitepay(op: { criar?: (p: PedidoDeLink) => Promise<{ url: string }>; unidades?: string[]; tetoDia?: number; porHora?: number } = {}) {
  const pedidos: PedidoDeLink[] = [];
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: {
      consultar: async () => ({ sucesso: true, pago: true }),
      testar: async () => undefined,
      criarLink: async (p) => {
        pedidos.push(p as PedidoDeLink);
        return op.criar ? op.criar(p as PedidoDeLink) : { url: `https://checkout.infinitepay.io/dhacailandia?lenc=${p.orderNsu}` };
      },
    },
  };
  void contaInfinitepayDaConfig;
  const armazem = armazemEmMemoria();
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  const esc = criarEscritaInfinitepay({
    armazem,
    agora: () => AGORA.getTime(),
    unidades: () => new Set(op.unidades ?? [UNI]),
    tetoDia: () => op.tetoDia ?? 20000,
    porHora: () => op.porHora ?? 20,
    alertar: async () => true,
    urlDoWebhook: (u, o) => urlDoAviso('https://conector.exemplo.com', 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres', u, o),
  });
  return { ctx, esc, pedidos, armazem };
}

function asaasFalso(falha?: Error) {
  const chamadas: Array<{ metodo: string; caminho: string }> = [];
  const escrever = (async (_c: string, _k: string, metodo: string, caminho: string) => {
    chamadas.push({ metodo, caminho });
    if (falha) throw falha;
    return { id: 'qr_1', payload: PIX_VALIDO };
  }) as unknown as DepsDoSinal['escrever'];
  const ler = (async () => ({ data: [{ key: 'chave-pix', status: 'ACTIVE' }] })) as unknown as NonNullable<DepsDoSinal['ler']>;
  return { escrever, ler, chamadas };
}

function montar(op: Parameters<typeof infinitepay>[0] & { asaasFalha?: Error; cliente?: { nome?: string; telefone?: string }; semServidor?: boolean } = {}) {
  const ip = infinitepay(op);
  const db = bancoFalso();
  const asaas = asaasFalso(op.asaasFalha);
  const criador = criadorDeLinkDoSinal(undefined, {
    servidor: () => (op.semServidor ? null : { ctx: ip.ctx, esc: ip.esc }),
    cliente: async () => {
      return op.cliente ?? { nome: 'Maria da Silva', telefone: '+5599981234567' };
    },
  });
  const deps: DepsDoSinal = {
    banco: db.banco,
    chave: async () => ({ unitId: 'u1', slug: UNI, chave: '$aact_chave_secreta_de_teste_0000000000' }),
    escrever: asaas.escrever,
    ler: asaas.ler,
    agora: () => AGORA,
    esperar: async () => undefined,
    infinitepay: criador,
  };
  return { ip, db, asaas, deps };
}

test('com sinalVia=infinitepay: cria o link de R$ 50 pelo conector, grava a linha como infinitepay e NÃO toca no Asaas', async () => {
  const m = montar();
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(r.tipo, 'link');
  if (r.tipo !== 'link') return;
  assert.equal(r.via, 'infinitepay');
  assert.equal(r.novo, true);
  assert.equal(r.valor, 50);
  assert.equal(r.venceEm, '2026-11-29', 'a véspera da consulta, como o Pix do Asaas');
  assert.equal(r.fallback, undefined);
  assert.match(r.url, /^https:\/\/checkout\.infinitepay\.io\//);
  assert.equal(m.asaas.chamadas.length, 0, 'o Asaas nem foi chamado');
  // o pedido que foi para a InfinitePay: R$ 50, pagamento único, vence a tempo, com o webhook assinado e a página já preenchida
  assert.equal(m.ip.pedidos.length, 1);
  const p = m.ip.pedidos[0]!;
  assert.deepEqual(p.itens.map((i) => i.precoCentavos), [5000]);
  assert.equal(p.pagamentoUnico, true);
  assert.match(p.webhookUrl ?? '', /\/infinitepay\/webhook\/doutor-hernia-acailandia\//);
  assert.deepEqual(p.cliente, { nome: 'Maria da Silva', telefone: '+5599981234567' });
  assert.equal(p.semEndereco, true);
  assert.match(p.validoAte ?? '', /^2026-11-29T23:59:59-03:00$/);
  // a linha do sinal: a reserva virou o link, ligada ao order_nsu do livro da InfinitePay
  assert.equal(m.db.rows.length, 1);
  const l = m.db.rows[0]!;
  assert.equal(l.via, 'infinitepay');
  assert.equal(l.status, 'pendente');
  assert.equal(l.linkId, p.orderNsu);
  assert.equal(l.url, r.url);
  assert.equal(l.valorCentavos, 5000);
  assert.equal(l.consultaEm, CONSULTA);
  const livro = await m.ip.armazem.porOrderNsu(UNI, p.orderNsu);
  assert.equal(livro?.status, 'criado');
  assert.equal(livro?.criadoPor, 'usuario:sofia-sinal');
});

test('um link por consulta: o pedido repetido devolve o MESMO link aberto e não cria outro (nem na InfinitePay, nem no Asaas)', async () => {
  const m = montar();
  const a = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  const b = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(a.tipo, 'link');
  assert.equal(b.tipo, 'link');
  if (a.tipo !== 'link' || b.tipo !== 'link') return;
  assert.equal(b.novo, false);
  assert.equal(b.url, a.url);
  assert.equal(b.via, 'infinitepay', 'o texto da Sofia sabe que é link');
  assert.equal(m.ip.pedidos.length, 1);
  assert.equal(m.asaas.chamadas.length, 0);
  assert.equal(m.db.rows.length, 1);
});

test('dois pedidos juntos do mesmo paciente: um link só', async () => {
  const m = montar();
  const [a, b] = await Promise.all([gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps), gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps)]);
  assert.equal(m.ip.pedidos.length, 1);
  assert.equal(a.tipo === 'link' && b.tipo === 'link' && a.url === b.url, true);
});

test('sinal já pago (por qualquer caminho) não gera outro link: ja-pago', async () => {
  const m = montar();
  await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  m.db.rows[0]!.status = 'pago';
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.deepEqual(r, { tipo: 'ja-pago' });
  assert.equal(m.ip.pedidos.length, 1);
});

test('pacientes diferentes no mesmo horário NÃO esbarram na trava de "link igual em 10 minutos" (a descrição é de cada um)', async () => {
  const m = montar();
  const a = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  const b = await gerarSinalPix(UNIT, 6924325, CONSULTA, m.deps);
  assert.equal(a.tipo === 'link' && a.via === 'infinitepay', true);
  assert.equal(b.tipo === 'link' && b.via === 'infinitepay', true, 'o segundo paciente também sai pela InfinitePay');
  assert.equal(m.ip.pedidos.length, 2);
  assert.equal(m.asaas.chamadas.length, 0);
});

// ── o fallback: o paciente nunca fica sem como pagar ──────────────────────────────────────────────────────────────────────────

const CASOS: Array<[string, Parameters<typeof montar>[0], RegExp]> = [
  ['a InfinitePay RECUSA o pedido (422) mesmo sem nome e telefone', { cliente: {}, criar: async () => { throw new ErroInfinitepay('a InfinitePay respondeu 422 (valor inválido)', 422); } }, /422/],
  ['a InfinitePay recusa a chave (403)', { criar: async () => { throw new ErroInfinitepay('a InfinitePay recusou a chave (403)', 403); } }, /403/],
  ['a InfinitePay pede para ir mais devagar (429)', { criar: async () => { throw new ErroInfinitepay('a InfinitePay pediu para ir mais devagar (429)', 429); } }, /429/],
  ['a criação de link NÃO está ligada na unidade (INFINITEPAY_ESCRITA_UNIDADES)', { unidades: [] }, /não está ligada na unidade/],
  ['o teto do dia da InfinitePay estoura', { tetoDia: 10 }, /teto do dia/],
  ['o limite de links por hora é 0 (criação desligada)', { porHora: 0 }, /DESLIGADA/],
  ['o conector da InfinitePay ainda não subiu neste processo', { semServidor: true }, /não foi carregada/],
];
for (const [nome, op, motivo] of CASOS) {
  test(`fallback: ${nome} → sai o Pix do Asaas (copia e cola) e o motivo fica registrado`, async () => {
    const m = montar(op);
    const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
    assert.equal(r.tipo, 'link');
    if (r.tipo !== 'link') return;
    assert.equal(r.via, undefined, 'o que o paciente recebe é o Pix do Asaas');
    assert.equal(r.copiaECola, true);
    assert.equal(r.url, PIX_VALIDO);
    assert.match(r.fallback ?? '', motivo);
    assert.deepEqual(m.asaas.chamadas.map((c) => c.caminho), ['/pix/qrCodes/static']);
    // a mesma linha (a reserva) virou o Pix do Asaas: nada de linha órfã da InfinitePay
    assert.equal(m.db.rows.length, 1);
    assert.equal(m.db.rows[0]!.via ?? 'asaas', 'asaas');
    assert.equal(m.db.rows[0]!.status, 'pendente');
  });
}

test('fallback: se a InfinitePay (recusa certa) E o Asaas falham, o resultado é a falha de sempre (a equipe envia o Pix)', async () => {
  const m = montar({ criar: async () => { throw new ErroInfinitepay('a InfinitePay respondeu 422', 422); }, asaasFalha: new Error('Asaas fora') });
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(r.tipo, 'falhou');
  assert.equal(m.db.rows.length, 0, 'a reserva é largada');
});

test('sem os dados do paciente (o Kommo não respondeu) o link sai do mesmo jeito pela InfinitePay, com a página sem preencher', async () => {
  const m = montar();
  const kommoFora = { getLead: async () => { throw new Error('Kommo 502'); }, getContactBasico: async () => ({ nome: null, telefone: null }) } as never;
  const deps = { ...m.deps, infinitepay: criadorDeLinkDoSinal(kommoFora, { servidor: () => ({ ctx: m.ip.ctx, esc: m.ip.esc }) }) };
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, deps);
  assert.equal(r.tipo === 'link' && r.via, 'infinitepay');
  assert.equal(m.ip.pedidos[0]!.cliente, undefined);
  assert.equal(m.asaas.chamadas.length, 0);
});

test('a InfinitePay RECUSA o pedido com nome/telefone (400): tenta UMA vez sem eles e o sinal continua saindo pela InfinitePay', async () => {
  let chamadas = 0;
  const m = montar({
    criar: async () => {
      if (++chamadas === 1) throw new ErroInfinitepay('a InfinitePay respondeu 400 (customer inválido)', 400);
      return { url: 'https://checkout.infinitepay.io/dhacailandia?lenc=segunda' };
    },
  });
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(r.tipo === 'link' && r.via, 'infinitepay');
  assert.equal(m.ip.pedidos.length, 2);
  assert.ok(m.ip.pedidos[0]!.cliente, 'a primeira tentativa levava nome e telefone');
  assert.equal(m.ip.pedidos[1]!.cliente, undefined, 'a segunda vai sem');
  assert.notEqual(m.ip.pedidos[0]!.orderNsu, m.ip.pedidos[1]!.orderNsu);
  assert.equal(m.asaas.chamadas.length, 0);
  assert.equal(m.db.rows.length, 1);
  assert.equal(m.db.rows[0]!.linkId, m.ip.pedidos[1]!.orderNsu, 'a linha do sinal é a do link que existe');
});

test('só a recusa 400/422 repete sem nome e telefone: timeout, 5xx e chave recusada NÃO repetem (vão direto para o Asaas)', async () => {
  for (const erro of [new ErroInfinitepay('a InfinitePay recusou a chave (403)', 403), new ErroInfinitepay('a InfinitePay respondeu 503', 503), new ErroInfinitepay('a InfinitePay não respondeu a tempo')]) {
    const m = montar({ criar: async () => { throw erro; } });
    await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
    assert.equal(m.ip.pedidos.length, 1, erro.message);
  }
});

test('recusa 400 mesmo quando só a opção de endereço foi enviada (sem nome nem telefone): repete UMA vez sem ela e o sinal sai pela InfinitePay', async () => {
  let n = 0;
  const m = montar({ cliente: {}, criar: async (p) => { if (++n === 1) throw new ErroInfinitepay('a InfinitePay respondeu 400 (options inválidas)', 400); return { url: `https://checkout.infinitepay.io/x?lenc=${p.orderNsu}` }; } });
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(r.tipo === 'link' && r.via, 'infinitepay');
  assert.equal(m.ip.pedidos.length, 2);
  assert.equal(m.ip.pedidos[0]!.semEndereco, true);
  assert.equal(m.ip.pedidos[1]!.semEndereco, undefined, 'a segunda vai sem a opção');
  assert.equal(m.asaas.chamadas.length, 0);
});

// ── a criação SEM RESPOSTA CLARA: o link pode existir, então NÃO sai o Pix do Asaas (cobrança em dobro) ─────────────────────────────

for (const [nome, erro] of [
  ['5xx', () => new ErroInfinitepay('a InfinitePay respondeu 503', 503)],
  ['timeout', () => new ErroInfinitepay('a InfinitePay não respondeu a tempo')],
  ['resposta sem URL', () => new ErroInfinitepay('a InfinitePay respondeu sem a URL do link. O link PODE ter sido criado: confira no app da InfinitePay antes de repetir.', 200)],
] as const) {
  test(`criação incerta (${nome}): NÃO manda o Pix do Asaas nem cria outro link; guarda a referência como «incerto» e pede à equipe para conferir`, async () => {
    const m = montar({ criar: async () => { throw erro(); } });
    const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
    assert.equal(r.tipo, 'falhou');
    if (r.tipo !== 'falhou') return;
    assert.equal(r.motivo, 'incerto');
    assert.match(r.detalhe, /pode existir: conferir no app antes de cobrar de novo/);
    assert.equal(m.asaas.chamadas.length, 0, 'nenhum Pix do Asaas');
    // a linha guarda a referência do link que talvez exista (o aviso de pagamento dele ainda dará a baixa)
    assert.equal(m.db.rows.length, 1);
    assert.equal(m.db.rows[0]!.status, 'incerto');
    assert.equal(m.db.rows[0]!.via, 'infinitepay');
    assert.equal(m.db.rows[0]!.linkId, m.ip.pedidos[0]!.orderNsu);
    // «não recebi»: o pedido repetido NÃO cria link novo nem Pix — segue segurando o sinal
    const de_novo = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
    assert.equal(de_novo.tipo === 'falhou' && de_novo.motivo, 'incerto');
    assert.equal(m.ip.pedidos.length, 1);
    assert.equal(m.asaas.chamadas.length, 0);
    assert.equal(m.db.rows.length, 1);
  });
}

test('criação incerta de UM paciente não segura o sinal de OUTRO', async () => {
  let n = 0;
  const m = montar({ criar: async (p) => { if (++n === 1) throw new ErroInfinitepay('a InfinitePay respondeu 503', 503); return { url: `https://checkout.infinitepay.io/x?lenc=${p.orderNsu}` }; } });
  await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  const outro = await gerarSinalPix(UNIT, 6924325, CONSULTA, m.deps);
  assert.equal(outro.tipo === 'link' && outro.via, 'infinitepay');
});

// ── a validade REAL do link é o vencimento do sinal: um link aberto nunca é duplicado ────────────────────────────────────────────────

test('consulta AMANHÃ: o link vale até o fim do dia seguinte (a API conta em dias inteiros) e esse é o vencimento da linha e o que o paciente ouve — o «não recebi» no dia reaproveita o MESMO link', async () => {
  const m = montar();
  const consultaAmanha = '2026-11-27T09:00';
  const a = await gerarSinalPix(UNIT, 5829035, consultaAmanha, m.deps);
  assert.equal(a.tipo, 'link');
  if (a.tipo !== 'link') return;
  assert.equal(m.ip.pedidos[0]!.validoAte, '2026-11-27T23:59:59-03:00');
  assert.equal(a.venceEm, '2026-11-27', 'o paciente ouve o dia em que o link REALMENTE vence');
  assert.equal(m.db.rows[0]!.venceEm, '2026-11-27', 'e a linha também');
  // no dia seguinte de manhã (ainda dentro da validade do link): o mesmo pedido devolve o mesmo link
  const noDia = { ...m.deps, agora: () => new Date('2026-11-27T11:00:00Z') };
  const b = await gerarSinalPix(UNIT, 5829035, consultaAmanha, noDia);
  assert.equal(b.tipo === 'link' && b.novo, false);
  assert.equal(b.tipo === 'link' && b.url, a.url);
  assert.equal(m.ip.pedidos.length, 1, 'nenhum segundo link pagável');
  assert.equal(m.db.rows.length, 1);
});

test('o telefone que a InfinitePay devolve numa recusa não vai para o log, nem para o motivo do fallback', async () => {
  const m = montar({ criar: async () => { throw new ErroInfinitepay('a InfinitePay respondeu 422 (telefone +5599981234567 inválido)', 422); }, cliente: {} });
  const linhasDeLog: string[] = [];
  const { logger } = await import('./logger.js');
  const orig = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const nivel of ['info', 'warn', 'error'] as const) (logger as never as Record<string, unknown>)[nivel] = (...a: unknown[]) => void linhasDeLog.push(JSON.stringify(a));
  let r;
  try {
    r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  } finally {
    Object.assign(logger, orig);
  }
  assert.equal(r.tipo === 'link' && r.fallback?.includes('99981234567'), false);
  assert.doesNotMatch(linhasDeLog.join('\n'), /99981234567/);
  assert.ok(linhasDeLog.length > 0);
});



test('InfinitePay e Asaas falham: a falha diz que a InfinitePay também falhou (a equipe não caça só chave do Asaas)', async () => {
  const m = montar({ cliente: {}, criar: async () => { throw new ErroInfinitepay('a InfinitePay respondeu 422 (x)', 422); } });
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, { ...m.deps, chave: async () => null });
  assert.equal(r.tipo, 'falhou');
  if (r.tipo !== 'falhou') return;
  assert.equal(r.motivo, 'sem-chave');
  assert.match(r.detalhe, /antes, a InfinitePay falhou: .*422/);
  assert.match(r.fallback ?? '', /422/);
});

// ── sem a opção (o padrão): igual ao de hoje ────────────────────────────────────────────────────────────────────────────────────

test('sem deps.infinitepay: o resultado é o do Asaas, sem via nem fallback nem chamada à InfinitePay (nada mudou)', async () => {
  const m = montar();
  const { infinitepay: _tira, ...semOpcao } = m.deps;
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, semOpcao);
  assert.deepEqual(r, { tipo: 'link', url: PIX_VALIDO, novo: true, valor: 50, venceEm: '2026-11-29', registrado: true, copiaECola: true });
  assert.equal(m.ip.pedidos.length, 0);
  assert.equal(m.db.rows[0]!.via, undefined, 'a linha nasce sem via (o banco põe o padrão asaas)');
});

test('depsDoSinalPorVia: só com a variável, só no Kommo e nunca na conversa do Chatwoot', () => {
  const kommo = { getLead: async () => ({}), getContactBasico: async () => ({ nome: null, telefone: null }) } as never;
  const ligada = { SOFIA_SINAL_VIA_ACAILANDIA: 'infinitepay' };
  assert.equal(depsDoSinalPorVia(UNI, { kommo }, {}), undefined);
  assert.equal(depsDoSinalPorVia(UNI, { kommo }, { SOFIA_SINAL_VIA_ACAILANDIA: 'asaas' }), undefined);
  assert.equal(depsDoSinalPorVia('doutor-hernia-araguaina', { kommo }, ligada), undefined, 'outra unidade');
  assert.equal(depsDoSinalPorVia(UNI, { kommo: undefined }, ligada), undefined, 'sem Kommo (Chatwoot)');
  assert.equal(depsDoSinalPorVia(UNI, { kommo, conversaGarantida: true }, ligada), undefined);
  assert.equal(typeof depsDoSinalPorVia(UNI, { kommo }, ligada)?.infinitepay, 'function');
});

// ── o que vai para a página e para a descrição ───────────────────────────────────────────────────────────────────────────────────

test('nome e telefone para a página: só o que é nome e telefone de verdade', () => {
  assert.equal(nomeParaAPagina('  Maria   da Silva '), 'Maria da Silva');
  assert.equal(nomeParaAPagina("José D'Ávila-Souza"), "José D'Ávila-Souza");
  assert.equal(nomeParaAPagina('Lead 22261987'), undefined);
  assert.equal(nomeParaAPagina('lead'), undefined);
  assert.equal(nomeParaAPagina('😀'), undefined);
  assert.equal(nomeParaAPagina('Ana 123'), 'Ana');
  assert.equal(nomeParaAPagina(null), undefined);
  assert.equal(telefoneParaAPagina('(99) 98123-4567'), '+5599981234567');
  assert.equal(telefoneParaAPagina('5599981234567'), '+5599981234567');
  assert.equal(telefoneParaAPagina('+55 99 3523-4567'), '+559935234567');
  assert.equal(telefoneParaAPagina('98123-4567'), undefined, 'sem DDD');
  assert.equal(telefoneParaAPagina(''), undefined);
  assert.equal(telefoneParaAPagina('123'), undefined);
});

test('clienteDoCartao: pega o contato PRINCIPAL do cartão; erro ou cartão sem contato = sem dados, nunca lança', async () => {
  const lidos: number[] = [];
  const kommo = {
    getLead: async () => ({ id: 1, _embedded: { contacts: [{ id: 11 }, { id: 22, is_main: true }] } }),
    getContactBasico: async (id: number) => (lidos.push(id), { nome: 'Maria da Silva', telefone: '(99) 98123-4567' }),
  } as never;
  assert.deepEqual(await clienteDoCartao(kommo, 1), { nome: 'Maria da Silva', telefone: '+5599981234567' });
  assert.deepEqual(lidos, [22]);
  assert.deepEqual(await clienteDoCartao({ getLead: async () => ({ id: 1 }), getContactBasico: async () => ({ nome: 'X', telefone: null }) } as never, 1), {});
  assert.deepEqual(await clienteDoCartao({ getLead: async () => { throw new Error('Kommo 502'); }, getContactBasico: async () => ({ nome: null, telefone: null }) } as never, 1), {});
});

test('a descrição do sinal passa no filtro de CPF/telefone do conector para qualquer id de cartão, e é diferente para cada paciente', () => {
  for (const id of [1234567, 5829035, 22261987, 6924325000, 9999999999]) {
    const d = descricaoDoSinal('Açailândia', CONSULTA, id);
    assert.doesNotThrow(() => descricaoLimpa(d), `id ${id}: ${d}`);
    assert.ok(d.length <= 120);
  }
  assert.notEqual(descricaoDoSinal('Açailândia', CONSULTA, 1234567), descricaoDoSinal('Açailândia', CONSULTA, 7654321));
  assert.equal(descricaoDoSinal('Açailândia', CONSULTA, 5829035), `Sinal da consulta - Doutor Hérnia Açailândia - 30/11 09:00 - ref ${(5829035).toString(36).toUpperCase()}`);
  assert.doesNotThrow(() => descricaoLimpa(descricaoDoSinal('Açailândia', null, 5829035)));
});

test('nenhum CPF, telefone ou nome vai para o log do criador (só o pedido à InfinitePay leva nome e telefone)', async () => {
  const m = montar({ cliente: { nome: 'Maria da Silva', telefone: '+5599981234567' } });
  const linhasDeLog: string[] = [];
  const { logger } = await import('./logger.js');
  const orig = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const nivel of ['info', 'warn', 'error'] as const) (logger as never as Record<string, unknown>)[nivel] = (...a: unknown[]) => void linhasDeLog.push(JSON.stringify(a));
  try {
    await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
    await gerarSinalPix(UNIT, 6924325, CONSULTA, montar({ criar: async () => { throw new ErroInfinitepay('a InfinitePay respondeu 503', 503); } }).deps);
  } finally {
    Object.assign(logger, orig);
  }
  const todo = linhasDeLog.join('\n');
  assert.ok(linhasDeLog.length > 0, 'o teste enxergou o log');
  assert.doesNotMatch(todo, /Maria|99981234567|\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
});

test('outra geração do MESMO cartão ainda em andamento (comercial e Resgate dividem o cartão): desiste sem mandar a equipe «enviar o Pix» — o motivo diz que já existe um sinal em andamento', async () => {
  const m = montar();
  m.db.rows.push({ id: 'em-curso', unitId: 'u1', clinica: 'doutor-hernia-acailandia', leadId: '5829035', linkId: 'reserva:x', url: '', valorCentavos: 5000, venceEm: '2026-11-29', consultaEm: CONSULTA, status: 'criando', paymentId: null, criadoEm: new Date(AGORA.getTime() - 60_000), pagoEm: null, avisadoEm: null });
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(r.tipo, 'falhou');
  if (r.tipo !== 'falhou') return;
  assert.equal(r.motivo, 'em-andamento');
  assert.match(r.detalhe, /já existe um sinal em andamento/);
  assert.equal(m.ip.pedidos.length, 0);
  assert.equal(m.asaas.chamadas.length, 0);
  assert.equal(motivoDaTarefaDoSinal(r.motivo), 'sinal_em_andamento');
  assert.equal(motivoDaTarefaDoSinal('incerto'), 'sinal_incerto');
  for (const mo of ['sem-chave', 'teto', 'asaas', 'baixa-desligada'] as const) assert.equal(motivoDaTarefaDoSinal(mo), 'sinal_pix_falhou');
});

test('a linha «incerto» não pôde ser gravada: tenta 3 vezes e a falha AVISA que a referência não ficou guardada (nunca em silêncio)', async () => {
  const m = montar({ criar: async () => { throw new ErroInfinitepay('a InfinitePay respondeu 503', 503); } });
  let tentativas = 0;
  const original = m.db.banco.updateMany;
  m.db.banco.updateMany = async (a) => {
    if (a.data.status === 'incerto') {
      tentativas++;
      throw new Error('banco fora');
    }
    return original(a);
  };
  const r = await gerarSinalPix(UNIT, 5829035, CONSULTA, m.deps);
  assert.equal(tentativas, 3);
  assert.equal(r.tipo === 'falhou' && r.motivo, 'incerto');
  assert.match(r.tipo === 'falhou' ? r.detalhe : '', /NÃO ficou guardada no agente/);
  assert.equal(m.asaas.chamadas.length, 0, 'mesmo assim nada de Pix do Asaas');
});

test('remarcação: o sinal «incerto» também acompanha a data nova (a confirmação não sai com a data antiga)', async () => {
  const m = montar();
  m.db.rows.push({ id: 'i1', unitId: 'u1', clinica: 'doutor-hernia-acailandia', leadId: '5829035', linkId: 'sinal-x-1', url: '', valorCentavos: 5000, venceEm: '2026-11-29', consultaEm: '2026-11-30T09:00', status: 'incerto', paymentId: null, criadoEm: AGORA, pagoEm: null, avisadoEm: null, via: 'infinitepay' });
  const n = await acompanharRemarcacao({ slug: UNI }, 5829035, '2026-12-02T10:00', m.db.banco, AGORA);
  assert.equal(n, 1);
  assert.equal(m.db.rows[0]!.consultaEm, '2026-12-02T10:00');
});
