import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroInfinitepay, criarLinkNaInfinitepay, type PedidoDeLink } from '../lib/integracoes/infinitepay.js';
import { criarContextoInfinitepay, contaInfinitepayDaConfig, type ContaInfinitepay } from './infinitepay.js';
import {
  chaveDeDuplicata,
  criarEscritaInfinitepay,
  criarLink,
  descricaoLimpa,
  linksPorHora,
  registrarEscritaInfinitepaySePermitido,
  tetoPorDiaInfinitepay,
  tetoPorLink,
  unidadesComEscritaInfinitepay,
  validoAteDe,
} from './infinitepay-escrita.js';
import { armazemEmMemoria } from './infinitepay-falso.js';
import { assinaturaDoAviso, urlDoAviso } from './infinitepay-webhook.js';

const CHAVE = 'inchk_FIXTURE0123456789abcdefghijklmnopqrstu';
const UNI = 'doutor-hernia-acailandia';
// 26/11/2026 12:00 em Brasília
const AGORA = Date.parse('2026-11-26T15:00:00Z');
const QUEM = { id: 'u1', email: 'lia@exemplo.com' };

function montar(op: { criar?: (p: Omit<PedidoDeLink, 'handle'>) => Promise<{ url: string; slug?: string }>; unidades?: string[]; agora?: () => number; porHora?: number; tetoLink?: number; tetoDia?: number; semWebhook?: boolean } = {}) {
  const pedidos: Array<Omit<PedidoDeLink, 'handle'>> = [];
  const avisos: string[] = [];
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: {
      consultar: async () => ({ sucesso: true, pago: true }),
      testar: async () => undefined,
      criarLink: async (p) => {
        pedidos.push(p);
        return op.criar ? op.criar(p) : { url: `https://checkout.infinitepay.io/dd/${p.orderNsu}` };
      },
    },
  };
  const armazem = armazemEmMemoria();
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  const esc = criarEscritaInfinitepay({
    armazem,
    agora: op.agora ?? (() => AGORA),
    unidades: () => new Set(op.unidades ?? [UNI]),
    porHora: () => op.porHora ?? 20,
    tetoLink: () => op.tetoLink ?? 5000,
    tetoDia: () => op.tetoDia ?? 20000,
    alertar: async (t) => (avisos.push(t), true),
    ...(op.semWebhook ? {} : { urlDoWebhook: (u, o) => urlDoAviso('https://conector.exemplo.com', 'segredo', u, o) }),
  });
  return { ctx, esc, armazem, pedidos, avisos };
}

test('portão: sem a unidade em INFINITEPAY_ESCRITA_UNIDADES nada é criado e a InfinitePay nem é chamada', async () => {
  const m = montar({ unidades: [] });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 100, descricao: 'Consulta' }), /não está ligada na unidade/);
  assert.equal(m.pedidos.length, 0);
  assert.equal(m.armazem.linhas.length, 0, 'nem a intenção foi gravada');
});

test('portão: o padrão do ambiente é desligado — vazio, ausente e "*" não ligam nada', () => {
  assert.equal(unidadesComEscritaInfinitepay({}).size, 0);
  assert.equal(unidadesComEscritaInfinitepay({ INFINITEPAY_ESCRITA_UNIDADES: '' }).size, 0);
  assert.equal(unidadesComEscritaInfinitepay({ INFINITEPAY_ESCRITA_UNIDADES: '*, todas*' }).size, 0);
  assert.deepEqual([...unidadesComEscritaInfinitepay({ INFINITEPAY_ESCRITA_UNIDADES: ' Doutor-Hernia-Acailandia , x ' })], ['doutor-hernia-acailandia', 'x']);
  // o estado de produção sem o ambiente ligado: nada criado mesmo com a conta e o armazém no lugar
  const sem = criarEscritaInfinitepay({ armazem: armazemEmMemoria() });
  assert.equal(sem.unidades().size, 0);
});

test('portão da ferramenta: não escritor nunca vê; escritor só vê se alguma unidade está ligada; a função recusa de novo ao chamar', () => {
  const nomes: string[] = [];
  const server = { registerTool: (n: string) => nomes.push(n) } as never;
  const ligada = montar();
  assert.equal(registrarEscritaInfinitepaySePermitido(server, ligada.ctx, ligada.esc, 'u1', new Set(['outro']), (() => undefined) as never), false);
  const desligada = montar({ unidades: [] });
  assert.equal(registrarEscritaInfinitepaySePermitido(server, desligada.ctx, desligada.esc, 'u1', new Set(['u1']), (() => undefined) as never), false);
  assert.deepEqual(nomes, []);
  assert.equal(registrarEscritaInfinitepaySePermitido(server, ligada.ctx, ligada.esc, 'u1', new Set(['u1']), (() => undefined) as never), true);
  assert.deepEqual(nomes, ['infinitepay_criar_link']);
});

test('criar: manda valor em centavos, pagamento único, validade de 7 dias, webhook assinado; grava e devolve a URL', async () => {
  const m = montar();
  const r = await criarLink(m.ctx, m.esc, QUEM, { valor: 150.5, descricao: '  Consulta   de avaliação ' });
  assert.equal(r.criado, true);
  assert.match(r.url, /^https:\/\/checkout\.infinitepay\.io\/dd\/dd-20261126-[0-9a-f]{10}$/);
  const p = m.pedidos[0]!;
  assert.deepEqual(p.itens, [{ quantidade: 1, precoCentavos: 15050, descricao: 'Consulta de avaliação' }]);
  assert.equal(p.pagamentoUnico, true);
  assert.equal(p.pix, true);
  assert.equal(p.parcelasSemTaxa, 0);
  assert.equal(p.validoAte, '2026-12-03T23:59:59-03:00');
  assert.equal(p.webhookUrl?.startsWith('https://conector.exemplo.com/infinitepay/webhook/doutor-hernia-acailandia/'), true);
  assert.ok(p.webhookUrl!.endsWith(`/${assinaturaDoAviso('segredo', UNI, p.orderNsu)}`));
  const l = m.armazem.linhas[0]!;
  assert.equal(l.status, 'criado');
  assert.equal(l.url, r.url);
  assert.equal(l.criadoPor, 'lia@exemplo.com');
  assert.equal(r.valor, 150.5);
  assert.match(r.aviso, /não deixa cancelar link/);
  assert.equal(m.avisos.length, 0, 'link pequeno não avisa o Telegram');
});

test('criar: link acima de 50% do teto avisa o Telegram do João', async () => {
  const m = montar();
  await criarLink(m.ctx, m.esc, QUEM, { valor: 2600, descricao: 'Tratamento completo' });
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /acima de 50% do teto/);
});

test('criar: opções — só cartão, parcelas absorvidas, validade e referência própria', async () => {
  const m = montar();
  await criarLink(m.ctx, m.esc, QUEM, { valor: 100, descricao: 'Sessão', pix: false, parcelasSemTaxa: 3, validadeDias: 30, referencia: 'pedido-77' });
  const p = m.pedidos[0]!;
  assert.equal(p.pix, false);
  assert.equal(p.parcelasSemTaxa, 3);
  assert.equal(p.orderNsu, 'pedido-77');
  assert.equal(p.validoAte, '2026-12-26T23:59:59-03:00');
});

test('teto por link: R$ 5.000,01 é recusado ANTES de chamar a InfinitePay e nada fica gravado', async () => {
  const m = montar();
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 5000.01, descricao: 'Pacote' }), /passa do teto por link/);
  assert.equal(m.pedidos.length, 0);
  assert.equal(m.armazem.linhas.length, 0);
  await criarLink(m.ctx, m.esc, QUEM, { valor: 5000, descricao: 'Pacote' });
  assert.equal(m.pedidos.length, 1, 'exatamente o teto passa');
});

test('teto do dia: o 5º link de R$ 5.000 estoura os R$ 20.000 do dia; no dia seguinte o teto zera', async () => {
  let agora = AGORA;
  const m = montar({ agora: () => agora });
  for (const d of ['A', 'B', 'C', 'D']) await criarLink(m.ctx, m.esc, QUEM, { valor: 5000, descricao: `Pacote ${d}`, referencia: `p-${d}` });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 1, descricao: 'Mais um' }), /teto do dia/);
  assert.equal(m.pedidos.length, 4);
  agora = Date.parse('2026-11-27T15:00:00Z');
  await criarLink(m.ctx, m.esc, QUEM, { valor: 1, descricao: 'Mais um' });
  assert.equal(m.pedidos.length, 5);
});

test('teto do dia: o dia é o de Brasília (02:30 UTC ainda é o dia anterior)', async () => {
  const noite = Date.parse('2026-11-27T02:30:00Z'); // 26/11 23:30 em Brasília
  const m = montar({ agora: () => noite });
  for (const d of ['A', 'B', 'C', 'D']) await criarLink(m.ctx, m.esc, QUEM, { valor: 5000, descricao: `Pacote ${d}`, referencia: `p-${d}` });
  const depois = Date.parse('2026-11-27T04:00:00Z'); // 27/11 01:00 em Brasília: dia novo
  const m2 = { ...m, esc: { ...m.esc, agora: () => depois } };
  await criarLink(m2.ctx, m2.esc, QUEM, { valor: 100, descricao: 'Dia novo' });
  assert.equal(m.pedidos.length, 5);
});

test('concorrência: três pedidos de R$ 9.000 ao mesmo tempo — só dois cabem nos R$ 20.000 e o terceiro é recusado', async () => {
  const m = montar({ tetoLink: 9000 });
  const r = await Promise.allSettled([
    criarLink(m.ctx, m.esc, QUEM, { valor: 9000, descricao: 'Pacote 1' }),
    criarLink(m.ctx, m.esc, QUEM, { valor: 9000, descricao: 'Pacote 2' }),
    criarLink(m.ctx, m.esc, QUEM, { valor: 9000, descricao: 'Pacote 3' }),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
  assert.equal(m.pedidos.length, 2);
});

test('link igual em menos de 10 minutos é recusado e devolve o link que já existe; depois de 10 minutos passa', async () => {
  let agora = AGORA;
  const m = montar({ agora: () => agora });
  const primeiro = await criarLink(m.ctx, m.esc, QUEM, { valor: 200, descricao: 'Consulta' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 200, descricao: 'consulta' }), (e: Error) => /feito há menos de 10 minutos/.test(e.message) && e.message.includes(primeiro.url));
  assert.equal(m.pedidos.length, 1);
  agora += 11 * 60_000;
  await criarLink(m.ctx, m.esc, QUEM, { valor: 200, descricao: 'Consulta' });
  assert.equal(m.pedidos.length, 2);
  assert.notEqual(chaveDeDuplicata(UNI, 20000, 'Consulta'), chaveDeDuplicata('outra', 20000, 'Consulta'), 'a duplicata é por unidade');
});

test('referência repetida na unidade é recusada, mesmo com valor e descrição diferentes', async () => {
  const m = montar();
  await criarLink(m.ctx, m.esc, QUEM, { valor: 100, descricao: 'Sessão 1', referencia: 'ped-1' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 300, descricao: 'Outra coisa', referencia: 'ped-1' }), /já foi usada/);
  assert.equal(m.pedidos.length, 1);
});

test('limite por hora: o 3º link da hora é recusado com limite 2; 0 desliga a criação', async () => {
  const m = montar({ porHora: 2 });
  await criarLink(m.ctx, m.esc, QUEM, { valor: 10, descricao: 'Link 1' });
  await criarLink(m.ctx, m.esc, QUEM, { valor: 10, descricao: 'Link 2' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 10, descricao: 'Link 3' }), /limite de 2 links por hora/);
  const off = montar({ porHora: 0 });
  await assert.rejects(() => criarLink(off.ctx, off.esc, QUEM, { valor: 10, descricao: 'Link' }), /DESLIGADA/);
  assert.equal(off.pedidos.length, 0);
});

test('a InfinitePay recusa (403): fica "falhou", não gasta teto e a resposta diz que nada foi criado, sem a chave', async () => {
  const conta = contaInfinitepayDaConfig({ slug: UNI, nome: 'A', chave: CHAVE }, { fetcher: (async () => new Response(JSON.stringify({ message: `Forbidden ${CHAVE}` }), { status: 403 })) as unknown as typeof fetch });
  const m = montar();
  m.ctx.contas.set(UNI, conta);
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 4000, descricao: 'Pacote' }), (e: Error) => /Nada foi criado/.test(e.message) && !e.message.includes('inchk_FIXTURE'));
  assert.equal(m.armazem.linhas[0]!.status, 'falhou');
  assert.equal(m.avisos.length, 0);
  // não gastou o teto: 5 de R$ 4.000 (20.000) ainda cabem, com a recusa do primeiro fora da conta
  const ok = montar();
  ok.armazem.linhas.push(...m.armazem.linhas);
  for (const d of ['A', 'B', 'C', 'D', 'E']) await criarLink(ok.ctx, ok.esc, QUEM, { valor: 4000, descricao: `Pacote ${d}`, referencia: `x-${d}` });
  assert.equal(ok.pedidos.length, 5);
});

test('sem resposta clara (timeout): fica "intencao", CONTA no teto, avisa o João e a resposta manda conferir no app', async () => {
  const m = montar({ criar: async () => { throw new ErroInfinitepay('a InfinitePay não respondeu a tempo'); } });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 4000, descricao: 'Pacote' }), /pode ter sido criado/);
  assert.equal(m.armazem.linhas[0]!.status, 'intencao');
  assert.equal(m.avisos.length, 1);
  assert.match(m.avisos[0]!, /PODE existir/);
  const usado = (await m.armazem.ler(UNI, AGORA)).somaDoDia(AGORA);
  assert.equal(usado, 4000, 'a dúvida conta para o teto');
});

test('validação: valor, descrição, validade, parcelas e referência ruins são recusados antes de gravar', async () => {
  const m = montar();
  const casos: Array<[Parameters<typeof criarLink>[3], RegExp]> = [
    [{ valor: 0.5, descricao: 'Consulta' }, /abaixo de R\$ 1,00/],
    [{ valor: 10.123, descricao: 'Consulta' }, /2 casas decimais/],
    [{ valor: Number.NaN, descricao: 'Consulta' }, /valor inválido/],
    [{ valor: 10, descricao: 'Consulta do CPF 123.456.789-09' }, /sem CPF|não pode ter CPF/],
    [{ valor: 10, descricao: 'ligar 63 99999-8888 hoje' }, /não pode ter CPF/],
    [{ valor: 10, descricao: 'maria@exemplo.com' }, /não pode ter CPF/],
    [{ valor: 10, descricao: 'ab' }, /ao menos 3/],
    [{ valor: 10, descricao: 'Consulta', validadeDias: 0 }, /validadeDias/],
    [{ valor: 10, descricao: 'Consulta', validadeDias: 91 }, /validadeDias/],
    [{ valor: 10, descricao: 'Consulta', parcelasSemTaxa: 13 }, /parcelasSemTaxa/],
    [{ valor: 10, descricao: 'Consulta', referencia: 'com espaço' }, /referencia/],
  ];
  for (const [a, re] of casos) await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, a), re);
  assert.equal(m.pedidos.length, 0);
  assert.equal(m.armazem.linhas.length, 0);
});

test('sem endereço público o link nasce sem aviso automático e a resposta diz isso', async () => {
  const m = montar({ semWebhook: true });
  const r = await criarLink(m.ctx, m.esc, QUEM, { valor: 10, descricao: 'Link' });
  assert.equal(m.pedidos[0]!.webhookUrl, undefined);
  assert.match(r.avisoAutomatico, /sem aviso automático/);
});

test('conta sem criarLink (config antiga) recusa; unidade ambígua ou desconhecida recusa', async () => {
  const m = montar();
  const sem = { ...m.ctx.contas.get(UNI)!, fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined } } as ContaInfinitepay;
  m.ctx.contas.set(UNI, sem);
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 10, descricao: 'Link' }), /não tem a criação de link/);
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { unidade: 'timbo', valor: 10, descricao: 'Link' }), /sem InfinitePay/);
});

test('sem o banco dos links, a escrita não anda (teto que não lê o banco não é teto)', async () => {
  const esc = criarEscritaInfinitepay({ unidades: () => new Set([UNI]) });
  const m = montar();
  await assert.rejects(() => criarLink(m.ctx, esc, QUEM, { valor: 10, descricao: 'Link' }), /subiu sem o banco/);
  assert.equal(m.pedidos.length, 0);
});

test('ambiente: tetos e limite por hora — vazio, 0 e lixo caem no padrão (nunca ilimitado); formato brasileiro vale', () => {
  assert.equal(tetoPorLink({}), 5000);
  assert.equal(tetoPorLink({ INFINITEPAY_TETO_OPERACAO_REAIS: '0' }), 5000);
  assert.equal(tetoPorLink({ INFINITEPAY_TETO_OPERACAO_REAIS: 'abc' }), 5000);
  assert.equal(tetoPorLink({ INFINITEPAY_TETO_OPERACAO_REAIS: '1.500,50' }), 1500.5);
  assert.equal(tetoPorDiaInfinitepay({}), 20000);
  assert.equal(tetoPorDiaInfinitepay({ INFINITEPAY_TETO_DIA_REAIS: '-3' }), 20000);
  assert.equal(tetoPorDiaInfinitepay({ INFINITEPAY_TETO_DIA_REAIS: '20.000' }), 20000);
  assert.equal(linksPorHora({}), 20);
  assert.equal(linksPorHora({ INFINITEPAY_LINKS_POR_HORA: '5' }), 5);
  assert.equal(linksPorHora({ INFINITEPAY_LINKS_POR_HORA: '0' }), 0);
  assert.equal(linksPorHora({ INFINITEPAY_LINKS_POR_HORA: 'lixo' }), 0, 'lixo = desligado, como no Asaas');
});

test('descrição e validade: normaliza espaços e conta o fim do dia em Brasília', () => {
  assert.equal(descricaoLimpa('  A   B  C '), 'A B C');
  assert.equal(validoAteDe(Date.parse('2026-11-27T02:30:00Z'), 1).iso, '2026-11-27T23:59:59-03:00', '23:30 de 26/11 em Brasília + 1 dia = 27/11');
});

// ----------------------------------------------------------------- o cliente HTTP de POST /links

function falso(status: number, corpo: unknown) {
  const vistas: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => (vistas.push({ url, init }), new Response(JSON.stringify(corpo), { status }))) as unknown as typeof fetch;
  return { f, vistas };
}

test('POST /links: corpo no formato da InfinitePay, chave só no cabeçalho, URL lida da resposta', async () => {
  const { f, vistas } = falso(200, { url: 'https://checkout.infinitepay.io/clinica/abc', slug: 'abc' });
  const r = await criarLinkNaInfinitepay(
    CHAVE,
    { orderNsu: 'o1', itens: [{ quantidade: 1, precoCentavos: 12345, descricao: 'Consulta' }], webhookUrl: 'https://c.exemplo.com/w', validoAte: '2026-12-03T23:59:59-03:00', pix: false, parcelasSemTaxa: 2 },
    { fetcher: f },
  );
  assert.deepEqual(r, { url: 'https://checkout.infinitepay.io/clinica/abc', slug: 'abc' });
  assert.equal(vistas[0]!.url, 'https://api.checkout.infinitepay.io/links');
  assert.equal((vistas[0]!.init.headers as Record<string, string>)['X-Api-Key'], CHAVE);
  const corpo = JSON.parse(String(vistas[0]!.init.body));
  assert.deepEqual(corpo, {
    order_nsu: 'o1',
    items: [{ quantity: 1, price: 12345, description: 'Consulta' }],
    webhook: { url: 'https://c.exemplo.com/w', events: ['paid', 'settled', 'refunded', 'canceled', 'payment_failed'] },
    options: { valid_until: '2026-12-03T23:59:59-03:00', single_payment: true, payment_methods_enabled: ['credit_card'], assured_installments: 2 },
  });
  assert.equal(JSON.stringify(corpo).includes('inchk_'), false);
});

test('POST /links: aceita a URL dentro de data; resposta sem URL é erro que avisa "PODE ter sido criado"; 403 não repete a chave', async () => {
  const dentro = await criarLinkNaInfinitepay(CHAVE, { orderNsu: 'o', itens: [{ quantidade: 1, precoCentavos: 100, descricao: 'x' }] }, { fetcher: falso(201, { data: { checkout_url: 'https://pay.infinitepay.io/z' } }).f });
  assert.equal(dentro.url, 'https://pay.infinitepay.io/z');
  await assert.rejects(
    () => criarLinkNaInfinitepay(CHAVE, { orderNsu: 'o', itens: [{ quantidade: 1, precoCentavos: 100, descricao: 'x' }] }, { fetcher: falso(200, { ok: true }).f }),
    (e: unknown) => e instanceof ErroInfinitepay && /PODE ter sido criado/.test(e.message) && e.status === 200,
  );
  await assert.rejects(
    () => criarLinkNaInfinitepay(CHAVE, { orderNsu: 'o', itens: [{ quantidade: 1, precoCentavos: 100, descricao: 'x' }] }, { fetcher: falso(403, { message: CHAVE }).f }),
    (e: unknown) => e instanceof ErroInfinitepay && e.status === 403 && !e.message.includes('inchk_FIXTURE'),
  );
  // uma URL http (não https) não vale
  await assert.rejects(() => criarLinkNaInfinitepay(CHAVE, { orderNsu: 'o', itens: [{ quantidade: 1, precoCentavos: 100, descricao: 'x' }] }, { fetcher: falso(200, { url: 'http://inseguro' }).f }), /sem a URL/);
});
