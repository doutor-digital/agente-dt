import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AxiosInstance } from 'axios';
import { KommoApiError, KommoClient } from '../services/kommo.service.js';
import {
  ETIQUETAS_DE_ROBO_SEM_SETA,
  TETO_DE_ROBO_POR_HORA,
  acharNaConta,
  cabeEtiquetaDeRobo,
  etiquetasDeRoboDaUnidade,
  chaveDaEtiqueta,
  ehEtiquetaDeRobo,
  etiquetaNoCartao,
  lerPedidoDeEtiqueta,
  limparCacheDasEtiquetas,
  notaDaEtiquetaDeRobo,
  porEtiqueta,
  tirarEtiqueta,
  type KommoDasEtiquetas,
} from './ponte-etiquetas.js';

// O mesmo `etiquetas.js` que a extensão carrega: a regra do ▶ tem de ser a mesma dos dois lados.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const daExtensao = createRequire(import.meta.url)(new URL('etiquetas.js', EXTENSAO).pathname) as {
  ehDeRobo(nome: string, lista?: string[]): boolean;
  PERGUNTA_DO_ROBO: string;
};

const DA_CONTA = ['LOMBAR', 'CERVICAL', 'META', '▶ Retomada', '▶ Confirmação', 'Aderência meio'];

/** Um Kommo falso: as etiquetas da conta, as do cartão, e tudo que foi pedido. */
function kommoFalso(opcoes: { conta?: string[]; cartao?: string[]; semCartao?: boolean; naoGrava?: boolean; notaFalha?: boolean; addFalha?: boolean } = {}) {
  let conta = opcoes.conta ?? DA_CONTA;
  let cartao = [...(opcoes.cartao ?? ['LOMBAR'])];
  const chamadas: unknown[][] = [];
  const k: KommoDasEtiquetas & { chamadas: unknown[][]; trocarConta(c: string[]): void } = {
    chamadas,
    trocarConta: (c) => { conta = c; },
    listLeadTags: async () => { chamadas.push(['listar']); return conta.map((name) => ({ name })); },
    getLead: async (id) => {
      chamadas.push(['ler', id]);
      if (opcoes.semCartao) throw new KommoApiError('getLead: 404', 404, {});
      return { id, _embedded: { tags: cartao.map((name) => ({ name })) } };
    },
    addTag: async ({ leadId, tag }) => {
      chamadas.push(['por', leadId, tag]);
      if (opcoes.addFalha) throw new KommoApiError('addTag: 502', 502, {});
      if (!opcoes.naoGrava) cartao.push(tag);
    },
    removeTag: async (leadId, tag) => { chamadas.push(['tirar', leadId, tag]); if (!opcoes.naoGrava) cartao = cartao.filter((t) => t !== tag); },
    addLeadNote: async (leadId, texto) => { chamadas.push(['nota', leadId, texto]); if (opcoes.notaFalha) throw new Error('kommo fora'); return { id: 1 }; },
  };
  return k;
}

const pedido = (nome: string, extra: Partial<{ confirmado: boolean; por: string | null }> = {}) => ({ leadId: 123, nome, por: 'Ana', confirmado: false, ...extra });

beforeEach(() => limparCacheDasEtiquetas());

describe('etiquetas da Ponte — as regras', () => {
  it('▶ é etiqueta de robô (e ►); para as ▶ a regra é a MESMA da extensão', () => {
    for (const nome of ['▶ Retomada', ' ▶Retomada', '► Retomada', 'LOMBAR', 'Retomada ▶', '', '▶️ Retomada']) {
      assert.equal(ehEtiquetaDeRobo(nome, []), daExtensao.ehDeRobo(nome), nome);
    }
    assert.equal(ehEtiquetaDeRobo('▶ Retomada'), true);
    assert.equal(ehEtiquetaDeRobo('LOMBAR'), false);
    assert.equal(daExtensao.PERGUNTA_DO_ROBO, 'Esta etiqueta faz o robô mandar uma mensagem para o paciente. Pôr mesmo assim?');
  });

  it('"Aderência meio" dispara bot sem ter ▶: é de robô (sem diferença de maiúscula ou acento), aqui e na extensão', () => {
    assert.deepEqual([...ETIQUETAS_DE_ROBO_SEM_SETA], ['Aderência meio']);
    for (const nome of ['Aderência meio', 'ADERENCIA MEIO', ' aderência  meio ']) {
      assert.equal(ehEtiquetaDeRobo(nome), true, nome);
      assert.equal(daExtensao.ehDeRobo(nome, [...ETIQUETAS_DE_ROBO_SEM_SETA]), true, `extensão: ${nome}`);
    }
    assert.equal(ehEtiquetaDeRobo('Aderência'), false);
  });

  it('a lista da unidade: a fixa + PONTE_ETIQUETAS_DE_ROBO (todas) + PONTE_ETIQUETAS_DE_ROBO_<SLUG> (só ela)', () => {
    const amb = { PONTE_ETIQUETAS_DE_ROBO: 'Lembrete sessão; NPS', PONTE_ETIQUETAS_DE_ROBO_DOUTOR_HERNIA_ACAILANDIA: 'Pesquisa Google,Aderência meio' };
    assert.deepEqual(etiquetasDeRoboDaUnidade('doutor-hernia-acailandia', amb), ['Aderência meio', 'Lembrete sessão', 'NPS', 'Pesquisa Google']);
    assert.deepEqual(etiquetasDeRoboDaUnidade('doutor-hernia-serra', amb), ['Aderência meio', 'Lembrete sessão', 'NPS']);
    assert.deepEqual(etiquetasDeRoboDaUnidade('x', {}), ['Aderência meio']);
    assert.equal(ehEtiquetaDeRobo('nps', etiquetasDeRoboDaUnidade('x', amb)), true);
  });

  it('acha o nome EXATO da conta; sem diferença de maiúscula/espaço só se for uma; o ▶ conta', () => {
    assert.equal(acharNaConta('LOMBAR', DA_CONTA), 'LOMBAR');
    assert.equal(acharNaConta(' lombar ', DA_CONTA), 'LOMBAR');
    assert.equal(acharNaConta('▶ retomada', DA_CONTA), '▶ Retomada');
    assert.equal(acharNaConta('Retomada', DA_CONTA), null, '"Retomada" não é "▶ Retomada"');
    assert.equal(acharNaConta('NOVA', DA_CONTA), null);
    assert.equal(acharNaConta('meta', ['META', 'Meta']), null, 'duas parecidas: não escolhe sozinho');
    assert.equal(chaveDaEtiqueta('▶️  Retomada '), '▶ retomada');
  });

  it('etiqueta no cartão: devolve o nome como está no cartão', () => {
    assert.equal(etiquetaNoCartao('lombar', ['LOMBAR']), 'LOMBAR');
    assert.equal(etiquetaNoCartao('META', ['LOMBAR']), null);
  });

  it('o pedido: lead, nome, quem e a confirmação explícita (só `true` vale)', () => {
    assert.deepEqual(lerPedidoDeEtiqueta({ leadId: '123', nome: ' ▶ Retomada ', por: 'Ana', confirmado: true }), {
      ok: true,
      pedido: { leadId: 123, nome: '▶ Retomada', por: 'Ana', confirmado: true },
    });
    assert.equal((lerPedidoDeEtiqueta({ leadId: 1, nome: 'X', confirmado: 'sim' }) as { pedido: { confirmado: boolean } }).pedido.confirmado, false);
    assert.deepEqual(lerPedidoDeEtiqueta({ nome: 'X' }), { ok: false, erro: 'lead inválido' });
    assert.deepEqual(lerPedidoDeEtiqueta({ leadId: 1, nome: '   ' }), { ok: false, erro: 'etiqueta inválida' });
    assert.deepEqual(lerPedidoDeEtiqueta(null), { ok: false, erro: 'lead inválido' });
  });

  it('a nota da ▶ diz quem pôs', () => {
    assert.equal(notaDaEtiquetaDeRobo('▶ Retomada', 'Ana'), 'Etiqueta ▶ Retomada posta pela Ponte · por Ana');
    assert.equal(notaDaEtiquetaDeRobo('▶ Retomada', null), 'Etiqueta ▶ Retomada posta pela Ponte · por extensão Ponte');
  });
});

describe('etiquetas da Ponte — pôr', () => {
  it('etiqueta comum que existe na conta: põe, RELÊ o cartão e devolve a lista do Kommo; sem nota', async () => {
    const k = kommoFalso();
    const r = await porEtiqueta('acai', k, pedido('meta'));
    assert.deepEqual(r, { ok: true, leadId: 123, nome: 'META', robo: false, mudou: true, etiquetas: ['LOMBAR', 'META'] });
    assert.deepEqual(k.chamadas, [['listar'], ['ler', 123], ['por', 123, 'META'], ['ler', 123]]);
  });

  it('etiqueta que NÃO existe na conta: recusa, relendo a lista uma vez, e não grava nada (a Ponte não cria)', async () => {
    const k = kommoFalso();
    const r = await porEtiqueta('acai', k, pedido('NOVA'));
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 422);
    assert.match((r as { erro: string }).erro, /não existe/);
    assert.deepEqual(k.chamadas, [['listar'], ['listar']]);
  });

  it('criada no Kommo depois do cache: a releitura acha', async () => {
    const k = kommoFalso();
    await porEtiqueta('acai', k, pedido('META'));
    k.trocarConta([...DA_CONTA, 'NOVA']);
    const r = await porEtiqueta('acai', k, pedido('NOVA'));
    assert.equal(r.ok, true);
  });

  it('▶ sem confirmação: recusa com `precisaConfirmar` e NÃO grava', async () => {
    const k = kommoFalso();
    const r = await porEtiqueta('acai', k, pedido('▶ Retomada'));
    assert.deepEqual(r, { ok: false, status: 409, erro: 'esta etiqueta faz o robô mandar uma mensagem para o paciente: confirme antes', precisaConfirmar: true });
    assert.ok(!k.chamadas.some((c) => c[0] === 'por'));
  });

  it('▶ confirmada: põe e deixa a nota de quem pôs', async () => {
    const k = kommoFalso();
    const r = await porEtiqueta('acai', k, pedido('▶ Retomada', { confirmado: true }));
    assert.deepEqual(r, { ok: true, leadId: 123, nome: '▶ Retomada', robo: true, mudou: true, etiquetas: ['LOMBAR', '▶ Retomada'], nota: true });
    assert.deepEqual(k.chamadas.at(-1), ['nota', 123, 'Etiqueta ▶ Retomada posta pela Ponte · por Ana']);
  });

  it('"Aderência meio" (sem ▶) também pede confirmação, deixa nota e conta no teto', async () => {
    const sem = await porEtiqueta('acai', kommoFalso(), pedido('Aderência meio'));
    assert.equal((sem as { status: number }).status, 409);
    assert.equal((sem as { precisaConfirmar?: boolean }).precisaConfirmar, true);
    const k = kommoFalso();
    const r = await porEtiqueta('acai', k, pedido('aderência meio', { confirmado: true }), { teto: 1 });
    assert.equal(r.ok && r.robo, true);
    assert.deepEqual(k.chamadas.at(-1), ['nota', 123, 'Etiqueta Aderência meio posta pela Ponte · por Ana']);
    const segunda = await porEtiqueta('acai', kommoFalso({ cartao: [] }), { ...pedido('Aderência meio', { confirmado: true }), leadId: 9 }, { teto: 1 });
    assert.equal((segunda as { status: number }).status, 429);
  });

  it('teto com pedidos SIMULTÂNEOS: 10 juntos com teto 3 põem exatamente 3', async () => {
    const kommos = Array.from({ length: 10 }, () => kommoFalso({ cartao: [] }));
    const rs = await Promise.all(kommos.map((k, i) => porEtiqueta('conta-simultanea', k, { ...pedido('▶ Retomada', { confirmado: true }), leadId: 500 + i }, { teto: 3 })));
    assert.equal(rs.filter((r) => r.ok).length, 3);
    assert.equal(rs.filter((r) => !r.ok && r.status === 429).length, 7);
    assert.equal(kommos.filter((k) => k.chamadas.some((c) => c[0] === 'por')).length, 3, 'só 3 chegaram a gravar');
  });

  it('a vaga volta quando nada foi gravado (Kommo falhou, cartão apagado, já tinha a etiqueta)', async () => {
    await assert.rejects(porEtiqueta('conta-vaga', kommoFalso({ addFalha: true, cartao: [] }), pedido('▶ Retomada', { confirmado: true }), { teto: 1 }));
    assert.equal((await porEtiqueta('conta-vaga', kommoFalso({ semCartao: true }), pedido('▶ Retomada', { confirmado: true }), { teto: 1 })).ok, false);
    assert.equal((await porEtiqueta('conta-vaga', kommoFalso({ cartao: ['▶ Retomada'] }), pedido('▶ Retomada', { confirmado: true }), { teto: 1 })).ok, true);
    // as três não gastaram a vaga: esta ainda cabe
    const r = await porEtiqueta('conta-vaga', kommoFalso({ cartao: [] }), pedido('▶ Retomada', { confirmado: true }), { teto: 1 });
    assert.equal(r.ok && r.mudou, true);
    assert.equal(cabeEtiquetaDeRobo('conta-vaga', Date.now(), 1), false);
  });

  it('▶ que já estava no cartão: não grava de novo nem deixa nota', async () => {
    const k = kommoFalso({ cartao: ['▶ Retomada'] });
    const r = await porEtiqueta('acai', k, pedido('▶ Retomada', { confirmado: true }));
    assert.equal(r.ok && r.mudou, false);
    assert.ok(!k.chamadas.some((c) => c[0] === 'por' || c[0] === 'nota'));
  });

  it('o Kommo aceitou mas a releitura não mostra a etiqueta: erro (não diz que pôs)', async () => {
    const k = kommoFalso({ naoGrava: true });
    const r = await porEtiqueta('acai', k, pedido('▶ Retomada', { confirmado: true }));
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 502);
    assert.ok(!k.chamadas.some((c) => c[0] === 'nota'), 'sem etiqueta, sem nota');
  });

  it('nota que falha não desfaz a etiqueta: volta `nota: false`', async () => {
    const k = kommoFalso({ notaFalha: true });
    const r = await porEtiqueta('acai', k, pedido('▶ Retomada', { confirmado: true }));
    assert.equal(r.ok && r.nota, false);
  });

  it('teto de ▶ por hora na conta (chave vazada não vira disparador): a seguinte é recusada sem gravar', async () => {
    assert.equal(TETO_DE_ROBO_POR_HORA, 30);
    for (let i = 0; i < TETO_DE_ROBO_POR_HORA; i++) {
      const r = await porEtiqueta('acai', kommoFalso({ cartao: [] }), { ...pedido('▶ Retomada', { confirmado: true }), leadId: 1000 + i });
      assert.equal(r.ok, true, `▶ nº ${i + 1}`);
    }
    const k = kommoFalso({ cartao: [] });
    const r = await porEtiqueta('acai', k, pedido('▶ Retomada', { confirmado: true }));
    assert.equal((r as { status: number }).status, 429);
    assert.ok(!k.chamadas.some((c) => c[0] === 'por'));
    // etiqueta comum não conta no teto, e outra conta tem o seu
    assert.equal((await porEtiqueta('acai', kommoFalso({ cartao: [] }), pedido('META'))).ok, true);
    assert.equal((await porEtiqueta('outra-conta', kommoFalso({ cartao: [] }), pedido('▶ Retomada', { confirmado: true }))).ok, true);
    // passada a hora, cabe de novo
    assert.equal(cabeEtiquetaDeRobo('acai', Date.now() + 61 * 60_000), true);
  });

  it('cartão apagado: 404', async () => {
    const r = await porEtiqueta('acai', kommoFalso({ semCartao: true }), pedido('META'));
    assert.deepEqual(r, { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' });
  });
});

describe('etiquetas da Ponte — tirar', () => {
  it('tira (também ▶, sem confirmação) com o nome como está no cartão, e relê', async () => {
    const k = kommoFalso({ cartao: ['LOMBAR', '▶ Retomada'] });
    const r = await tirarEtiqueta(k, pedido('▶ retomada'));
    assert.deepEqual(r, { ok: true, leadId: 123, nome: '▶ Retomada', robo: true, mudou: true, etiquetas: ['LOMBAR'] });
    assert.deepEqual(k.chamadas, [['ler', 123], ['tirar', 123, '▶ Retomada'], ['ler', 123]]);
  });

  it('não estava no cartão: nada a gravar', async () => {
    const k = kommoFalso();
    const r = await tirarEtiqueta(k, pedido('META'));
    assert.equal(r.ok && r.mudou, false);
    assert.ok(!k.chamadas.some((c) => c[0] === 'tirar'));
  });

  it('continua no cartão depois de tirar: erro', async () => {
    const r = await tirarEtiqueta(kommoFalso({ naoGrava: true }), pedido('LOMBAR'));
    assert.equal(r.ok, false);
  });
});

describe('etiquetas da Ponte — a ARMADILHA do Kommo (o PATCH de verdade)', () => {
  function clienteFalso() {
    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    const http = {
      patch: async (url: string, body: Record<string, unknown>) => { patches.push({ url, body }); return { data: {} }; },
      get: async () => ({ data: {} }),
      post: async () => ({ data: {} }),
    } as unknown as AxiosInstance;
    return { cliente: new KommoClient({ subdomain: 'teste', accessToken: 't' } as never, http), patches };
  }

  it('`tags_to_add` e `tags_to_delete` vão na RAIZ do corpo — nunca em `_embedded` (que substitui todas)', async () => {
    const { cliente, patches } = clienteFalso();
    await cliente.addTag({ leadId: 123, tag: '▶ Retomada' });
    await cliente.removeTag(123, 'LOMBAR');
    assert.deepEqual(patches, [
      { url: '/leads/123', body: { tags_to_add: [{ name: '▶ Retomada' }] } },
      { url: '/leads/123', body: { tags_to_delete: [{ name: 'LOMBAR' }] } },
    ]);
    for (const p of patches) assert.equal('_embedded' in p.body, false);
  });
});
