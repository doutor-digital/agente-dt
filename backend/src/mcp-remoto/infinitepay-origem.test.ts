/** A referência de ORIGEM do link (`origemRef`): pedir de novo com a mesma referência devolve o MESMO link. É o que protege o clique duplo do Caixa. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroInfinitepay, type PedidoDeLink } from '../lib/integracoes/infinitepay.js';
import { criarContextoInfinitepay, type ContaInfinitepay } from './infinitepay.js';
import { criarEscritaInfinitepay, criarLink, origemSubstituivel } from './infinitepay-escrita.js';
import { armazemEmMemoria } from './infinitepay-falso.js';
import { urlDoAviso } from './infinitepay-webhook.js';

const UNI = 'doutor-hernia-acailandia';
const AGORA = Date.parse('2026-11-26T15:00:00Z');
const QUEM = { id: 'caixa' };

function montar(op: { criar?: (p: Omit<PedidoDeLink, 'handle'>, n: number) => Promise<{ url: string; slug?: string }>; unidades?: string[] } = {}) {
  const pedidos: Array<Omit<PedidoDeLink, 'handle'>> = [];
  const conta: ContaInfinitepay = {
    slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false,
    fonte: {
      consultar: async () => ({ sucesso: true, pago: true }),
      testar: async () => undefined,
      criarLink: async (p) => {
        pedidos.push(p);
        return op.criar ? op.criar(p, pedidos.length) : { url: `https://checkout.infinitepay.io/dd/${p.orderNsu}` };
      },
    },
  };
  const armazem = armazemEmMemoria();
  const ctx = criarContextoInfinitepay(new Map([[UNI, conta]]), armazem);
  let agora = AGORA;
  const esc = criarEscritaInfinitepay({
    armazem, agora: () => agora, unidades: () => new Set(op.unidades ?? [UNI]), porHora: () => 20, tetoLink: () => 5000, tetoDia: () => 20000, alertar: async () => true,
    urlDoWebhook: (u, o) => urlDoAviso('https://conector.exemplo.com', 'segredo', u, o),
  });
  return { ctx, esc, armazem, pedidos, avanca: (ms: number) => (agora += ms) };
}

const PEDIDO = { valor: 150, descricao: 'Consulta - ref ABC', origemRef: 'cx-lanc-1' };

test('mesma origemRef duas vezes: UM link na InfinitePay e a segunda resposta traz o mesmo endereço', async () => {
  const m = montar();
  const a = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  const b = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  assert.equal(m.pedidos.length, 1, 'a InfinitePay foi chamada uma vez só');
  assert.equal(m.armazem.linhas.length, 1);
  assert.equal(b.url, a.url);
  assert.equal(b.orderNsu, a.orderNsu);
  assert.equal(b.criado, false);
  assert.equal((b as { jaExistia?: boolean }).jaExistia, true);
});

test('clique duplo ao mesmo tempo: as duas chamadas voltam com o mesmo link e só uma vai à InfinitePay', async () => {
  const m = montar();
  const [a, b] = await Promise.all([criarLink(m.ctx, m.esc, QUEM, PEDIDO), criarLink(m.ctx, m.esc, QUEM, PEDIDO)]);
  assert.equal(m.pedidos.length, 1);
  assert.equal(a.orderNsu, b.orderNsu);
});

test('mesma origemRef com valor diferente: recusa (o link existente é de outro valor)', async () => {
  const m = montar();
  await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { ...PEDIDO, valor: 151 }), /diferente do valor pedido/);
  assert.equal(m.pedidos.length, 1);
});

test('origemRefs diferentes são links diferentes', async () => {
  const m = montar();
  const a = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  const b = await criarLink(m.ctx, m.esc, QUEM, { ...PEDIDO, origemRef: 'cx-lanc-2', descricao: 'Consulta - ref DEF' });
  assert.notEqual(a.orderNsu, b.orderNsu);
  assert.equal(m.pedidos.length, 2);
});

test('resposta incerta da InfinitePay (intenção): pedir de novo NÃO cria outro; o link pode existir lá', async () => {
  const m = montar({ criar: async () => { throw new ErroInfinitepay('timeout', null); } });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, PEDIDO), /pode ter sido criado/);
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, PEDIDO), /resultado não ficou claro/);
  assert.equal(m.pedidos.length, 1);
});

test('recusa certa da InfinitePay (422): a mesma origemRef pode tentar de novo; a linha recusada fica de histórico com a referência trocada', async () => {
  const m = montar({ criar: async (_p, n) => { if (n === 1) throw new ErroInfinitepay('a InfinitePay respondeu 422', 422); return { url: 'https://checkout.infinitepay.io/dd/ok' }; } });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, PEDIDO), /Nada foi criado/);
  m.avanca(1000);
  const b = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  assert.equal(b.criado, true);
  assert.equal(m.pedidos.length, 2);
  assert.equal(m.armazem.linhas.length, 2);
  assert.equal(m.armazem.linhas.filter((l) => l.origemRef === PEDIDO.origemRef).length, 1, 'só a viva guarda a referência');
});

test('link CANCELADO NÃO libera a referência (o webhook ainda aceita «pago» depois do cancelamento): devolve o MESMO link, nunca cria um segundo pagável', async () => {
  const m = montar();
  const a = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  await m.armazem.aplicarEvento(UNI, a.orderNsu, { evento: 'canceled', paraStatus: 'cancelado', deStatus: ['criado'] });
  m.avanca(1000);
  const b = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  assert.equal(b.criado, false);
  assert.equal(b.orderNsu, a.orderNsu);
  assert.equal((b as { status?: string }).status, 'cancelado');
  assert.equal(m.pedidos.length, 1, 'a InfinitePay não foi chamada de novo');
  assert.equal(origemSubstituivel({ status: 'cancelado', validoAte: null }, 0), false);
  // e se o pagamento chega depois do cancelamento, o MESMO link recebe (só existe um)
  const pago = await m.armazem.aplicarEvento(UNI, a.orderNsu, { evento: 'paid', paraStatus: 'pago', deStatus: ['intencao', 'criado', 'cancelado'] });
  assert.equal(pago.atual?.status, 'pago');
  assert.equal(m.armazem.linhas.filter((l) => l.origemRef === PEDIDO.origemRef).length, 1);
});

test('link VENCIDO sem pagamento libera a referência (outro link); link PAGO nunca é substituído; link já existente sem validade gravada devolve texto', async () => {
  const m = montar();
  const a = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  m.avanca(8 * 86_400_000);
  const c = await criarLink(m.ctx, m.esc, QUEM, { ...PEDIDO, descricao: 'Consulta - ref ABC3' });
  assert.equal(c.criado, true);
  assert.notEqual(c.orderNsu, a.orderNsu);
  assert.equal(m.armazem.linhas.filter((l) => l.origemRef === PEDIDO.origemRef).length, 1, 'só o vivo guarda a referência');
  await m.armazem.aplicarEvento(UNI, c.orderNsu, { evento: 'paid', paraStatus: 'pago', deStatus: ['criado'] });
  m.avanca(30 * 86_400_000);
  const d = await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  assert.equal(d.criado, false);
  assert.equal(d.orderNsu, c.orderNsu);
  assert.equal(typeof d.validoAte, 'string');
  // linha sem validade (sem o campo): ainda devolve um texto (o sinal da Sofia faz `.slice` nele)
  const semValidade = montar();
  semValidade.armazem.linhas.push({ orderNsu: 'x-1', unidade: UNI, status: 'criado', url: 'https://checkout.infinitepay.io/x', valorCentavos: 15000, descricao: 'Consulta - ref ABC', validoAte: null, criadoPor: 'u', criadoEm: new Date(AGORA).toISOString(), invoiceSlug: null, transactionNsu: null, formaPagamento: null, parcelas: null, valorPagoCentavos: null, reciboUrl: null, revisao: null, pagoEm: null, liquidadoEm: null, ultimoEvento: null, erro: null, origemRef: PEDIDO.origemRef, chave: null, criadoEmMs: AGORA });
  const e = await criarLink(semValidade.ctx, semValidade.esc, QUEM, PEDIDO);
  assert.equal(typeof e.validoAte, 'string');
  assert.match(e.validoAte, /^\d{4}-\d{2}-\d{2}T/);
});

test('o portão da unidade vale também para quem repete: unidade desligada não devolve link nenhum', async () => {
  const m = montar();
  await criarLink(m.ctx, m.esc, QUEM, PEDIDO);
  const fechado = criarEscritaInfinitepay({ armazem: m.armazem, unidades: () => new Set() });
  await assert.rejects(() => criarLink(m.ctx, fechado, QUEM, PEDIDO), /não está ligada na unidade/);
});

test('origemRef inválida é recusada antes de qualquer coisa', async () => {
  const m = montar();
  for (const ruim of ['', 'com espaço', 'x'.repeat(81), '-comeca', 'acentuação']) {
    await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { ...PEDIDO, origemRef: ruim }), /origemRef/);
  }
  assert.equal(m.pedidos.length, 0);
  assert.equal(m.armazem.linhas.length, 0);
});

test('com origemRef, dois pedidos DIFERENTES com o mesmo valor e a mesma descrição NÃO são duplicata (cada paciente tem o seu link)', async () => {
  const m = montar();
  const a = await criarLink(m.ctx, m.esc, QUEM, { valor: 150, descricao: 'Sessão de fisioterapia', origemRef: 'cx-paciente-1' });
  const b = await criarLink(m.ctx, m.esc, QUEM, { valor: 150, descricao: 'Sessão de fisioterapia', origemRef: 'cx-paciente-2' });
  assert.equal(b.criado, true);
  assert.notEqual(a.orderNsu, b.orderNsu);
  assert.notEqual(a.url, b.url);
  assert.equal(m.pedidos.length, 2);
});

test('sem origemRef nada muda: dois pedidos iguais seguem recusados pela regra dos 10 minutos', async () => {
  const m = montar();
  await criarLink(m.ctx, m.esc, QUEM, { valor: 150, descricao: 'Consulta - ref ABC' });
  await assert.rejects(() => criarLink(m.ctx, m.esc, QUEM, { valor: 150, descricao: 'Consulta - ref ABC' }), /link igual/);
});
