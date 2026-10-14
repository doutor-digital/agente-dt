import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { AxiosInstance } from 'axios';
import { KommoApiError, KommoClient } from '../services/kommo.service.js';
import {
  CAMPOS_DA_LIGACAO,
  RESULTADOS_DA_LIGACAO,
  RITMO_DAS_LIGACOES,
  agenteDaPonte,
  camposDaLigacaoNaConta,
  lerPedidoDeLigacao,
  limparCacheDosCampos,
  montarGravacaoDaLigacao,
  notaDaLigacao,
  registrarLigacao,
  type DefinicaoDeCampo,
  type KommoDaLigacao,
} from './ponte-ligacao.js';

// O mesmo `ligacao.js` que a extensão carrega: o ritmo padrão e os resultados têm de ser os mesmos.
const EXTENSAO = new URL('../../../extensao-ponte/', import.meta.url);
const daExtensao = createRequire(import.meta.url)(new URL('ligacao.js', EXTENSAO).pathname) as {
  RITMO_PADRAO: { intervaloS: number; tetoPorHora: number };
  RESULTADOS: Array<{ id: string }>;
  ritmoDe(r: unknown): { intervaloS: number; tetoPorHora: number };
};

/** Os campos ☎ de Açailândia, como estão na conta (ids e opções conferidos em 14/10/2026). */
const ACAILANDIA: DefinicaoDeCampo[] = [
  { id: 2448886, name: '☎ Última ligação', type: 'date_time', enums: [] },
  {
    id: 2448888,
    name: '☎ Resultado',
    type: 'select',
    enums: [
      { id: 1843630, value: 'Atendida' },
      { id: 1843632, value: 'Não atendida' },
      { id: 1843634, value: 'Caixa postal' },
      { id: 1843636, value: 'Falha' },
      { id: 1843638, value: 'Ocupado' },
      { id: 1843640, value: 'Número inválido' },
    ],
  },
  { id: 2448890, name: '☎ Duração da conversa', type: 'text', enums: [] },
  { id: 2448894, name: '☎ Agente', type: 'text', enums: [] },
  { id: 2448896, name: '☎ Campanha 3C', type: 'text', enums: [] },
  { id: 2448898, name: '☎ Tentativas', type: 'numeric', enums: [] },
  { id: 2448900, name: '☎ Gravação', type: 'url', enums: [] },
  // um campo "Resultado" SEM o ☎ não pode ser confundido com o da ligação
  { id: 999, name: 'Resultado', type: 'select', enums: [{ id: 1, value: 'Atendida' }] },
];

const agora = new Date('2026-10-14T13:00:00.000Z');
const EPOCH = Math.floor(agora.getTime() / 1000);

/** Um cartão que a discadora 3C já ligou (valores de um cartão real de Açailândia). */
const LIGADO_PELA_3C = [
  { field_id: 2448886, values: [{ value: 1786991605 }] },
  { field_id: 2448888, values: [{ value: 'Caixa postal' }] },
  { field_id: 2448890, values: [{ value: '0s' }] },
  { field_id: 2448896, values: [{ value: 'Lead Açailândia' }] },
  { field_id: 2448898, values: [{ value: '1' }] },
  { field_id: 2448900, values: [{ value: 'https://exemplo/gravacao' }] },
];

beforeEach(() => limparCacheDosCampos());

describe('ligação pela Ponte — o ritmo', () => {
  it('padrão 40 s e 40 por hora — o mesmo da extensão — com piso e teto', () => {
    assert.deepEqual({ ...RITMO_DAS_LIGACOES }, { intervaloS: 40, tetoPorHora: 40 });
    assert.deepEqual(daExtensao.RITMO_PADRAO, { intervaloS: 40, tetoPorHora: 40 });
    assert.deepEqual(daExtensao.ritmoDe(RITMO_DAS_LIGACOES), { intervaloS: 40, tetoPorHora: 40 });
  });

  it('os resultados da extensão são os que o servidor aceita', () => {
    assert.deepEqual(daExtensao.RESULTADOS.map((r) => r.id), Object.keys(RESULTADOS_DA_LIGACAO));
  });
});

describe('ligação pela Ponte — os campos ☎ (pelo nome)', () => {
  it('acha os campos ☎ pelo nome, sem confundir com um "Resultado" sem ☎', () => {
    const c = camposDaLigacaoNaConta(ACAILANDIA);
    assert.equal(c.ultima?.id, 2448886);
    assert.equal(c.resultado?.id, 2448888);
    assert.equal(c.tentativas?.id, 2448898);
    assert.equal(c.agente?.id, 2448894);
    assert.equal(c.campanha?.id, 2448896);
    assert.equal(camposDaLigacaoNaConta([{ id: 999, name: 'Resultado', type: 'select' }]).resultado, undefined);
  });

  it('cartão que a 3C ligou: data de agora, a opção do resultado, tentativas + 1, agente "Ponte · Ana" e a campanha 3C ESVAZIADA', () => {
    const g = montarGravacaoDaLigacao({ defs: ACAILANDIA, atuais: LIGADO_PELA_3C, resultado: 'nao-atendeu', por: 'Ana', agora });
    assert.deepEqual(g.campos, [
      { field_id: 2448886, values: [{ value: EPOCH }] },
      { field_id: 2448888, values: [{ enum_id: 1843632 }] },
      { field_id: 2448898, values: [{ value: 2 }] },
      { field_id: 2448894, values: [{ value: 'Ponte · Ana' }] },
      { field_id: 2448896, values: null },
    ]);
    assert.equal(g.tentativas, 2);
    assert.deepEqual(g.avisos, []);
    // gravação e duração da 3C não são tocadas
    assert.ok(!g.campos.some((c) => c.field_id === 2448900 || c.field_id === 2448890));
  });

  it('cartão nunca ligado: tentativas = 1 e a campanha 3C fica como está (vazia)', () => {
    const g = montarGravacaoDaLigacao({ defs: ACAILANDIA, atuais: [], resultado: 'atendeu', por: null, agora });
    assert.deepEqual(g.campos.find((c) => c.field_id === 2448898), { field_id: 2448898, values: [{ value: 1 }] });
    assert.deepEqual(g.campos.find((c) => c.field_id === 2448888), { field_id: 2448888, values: [{ enum_id: 1843630 }] });
    assert.deepEqual(g.campos.find((c) => c.field_id === 2448894), { field_id: 2448894, values: [{ value: 'Ponte' }] });
    assert.equal(g.campos.find((c) => c.field_id === 2448896), undefined);
  });

  it('cada resultado vai para a opção certa de Açailândia', () => {
    const opcao = (r: keyof typeof RESULTADOS_DA_LIGACAO) =>
      (montarGravacaoDaLigacao({ defs: ACAILANDIA, atuais: [], resultado: r, por: 'Ana', agora }).campos.find((c) => c.field_id === 2448888)?.values?.[0] as { enum_id: number }).enum_id;
    assert.equal(opcao('atendeu'), 1843630);
    assert.equal(opcao('nao-atendeu'), 1843632);
    assert.equal(opcao('caixa-postal'), 1843634);
    assert.equal(opcao('numero-errado'), 1843640);
  });

  it('conta sem a opção do resultado: esvazia o ☎ Resultado (não deixa o antigo ao lado da data nova) e avisa', () => {
    const defs = ACAILANDIA.map((d) => (d.id === 2448888 ? { ...d, enums: [{ id: 1, value: 'Atendida' }] } : d));
    const g = montarGravacaoDaLigacao({ defs, atuais: LIGADO_PELA_3C, resultado: 'caixa-postal', por: 'Ana', agora });
    assert.deepEqual(g.campos.find((c) => c.field_id === 2448888), { field_id: 2448888, values: null });
    assert.match(g.avisos[0], /não tem a opção "Caixa postal"/);
  });

  it('conta sem os campos ☎: nada a gravar (só a nota)', () => {
    const g = montarGravacaoDaLigacao({ defs: [{ id: 1, name: 'Cidade', type: 'text' }], atuais: [], resultado: 'atendeu', por: 'Ana', agora });
    assert.deepEqual(g, { campos: [], tentativas: null, avisos: [] });
    const soCampanha = montarGravacaoDaLigacao({ defs: [{ id: 5, name: '☎ Campanha 3C', type: 'text' }], atuais: [{ field_id: 5, values: [{ value: 'X' }] }], resultado: 'atendeu', por: 'Ana', agora });
    assert.deepEqual(soCampanha.campos, [], 'só esvaziar a campanha não é gravar a ligação');
  });

  it('tentativas com lixo no campo contam do zero', () => {
    const g = montarGravacaoDaLigacao({ defs: ACAILANDIA, atuais: [{ field_id: 2448898, values: [{ value: 'abc' }] }], resultado: 'atendeu', por: 'Ana', agora });
    assert.equal(g.tentativas, 1);
  });

  it('nota e agente', () => {
    assert.equal(notaDaLigacao('nao-atendeu', 'Ana'), '☎ Ligação pela Ponte: não atendeu · por Ana');
    assert.equal(notaDaLigacao('numero-errado', null), '☎ Ligação pela Ponte: número errado');
    assert.equal(agenteDaPonte('Ana'), 'Ponte · Ana');
    assert.equal(CAMPOS_DA_LIGACAO.campanha, '☎ Campanha 3C');
  });

  it('o pedido: lead, um dos 4 resultados e quem ("pular" não existe no servidor)', () => {
    assert.deepEqual(lerPedidoDeLigacao({ leadId: 5, resultado: 'caixa-postal', por: ' Ana ' }), { ok: true, pedido: { leadId: 5, resultado: 'caixa-postal', por: 'Ana' } });
    assert.deepEqual(lerPedidoDeLigacao({ leadId: 5, resultado: 'pular' }), { ok: false, erro: 'resultado inválido' });
    assert.deepEqual(lerPedidoDeLigacao({ leadId: 5, resultado: 'toString' }), { ok: false, erro: 'resultado inválido' });
    assert.deepEqual(lerPedidoDeLigacao({ resultado: 'atendeu' }), { ok: false, erro: 'lead inválido' });
  });
});

describe('ligação pela Ponte — gravar no Kommo', () => {
  function kommoFalso(opcoes: { camposFalham?: boolean; notaFalha?: boolean; semCartao?: boolean; defs?: DefinicaoDeCampo[] } = {}) {
    const chamadas: unknown[][] = [];
    const k: KommoDaLigacao & { chamadas: unknown[][] } = {
      chamadas,
      listarCamposDoCartao: async () => { chamadas.push(['campos']); return opcoes.defs ?? ACAILANDIA; },
      getLead: async (id) => {
        chamadas.push(['ler', id]);
        if (opcoes.semCartao) throw new KommoApiError('404', 404, {});
        return { id, custom_fields_values: LIGADO_PELA_3C };
      },
      gravarCamposDoLead: async (id, campos) => { chamadas.push(['gravar', id, campos.length]); if (opcoes.camposFalham) throw new Error('400'); },
      addLeadNote: async (id, texto) => { chamadas.push(['nota', id, texto]); if (opcoes.notaFalha) throw new Error('fora'); },
    };
    return k;
  }
  const pedido = { leadId: 123, resultado: 'nao-atendeu' as const, por: 'Ana' };

  it('campos num PATCH só + nota', async () => {
    const k = kommoFalso();
    const r = await registrarLigacao('acai', k, pedido, agora);
    assert.deepEqual(r, { ok: true, leadId: 123, resultado: 'nao-atendeu', campos: true, nota: true, tentativas: 2, avisos: [] });
    assert.deepEqual(k.chamadas, [['ler', 123], ['campos'], ['gravar', 123, 5], ['nota', 123, '☎ Ligação pela Ponte: não atendeu · por Ana']]);
  });

  it('os campos da conta ficam em cache por conta (a 2ª ligação não relê)', async () => {
    const k = kommoFalso();
    await registrarLigacao('acai', k, pedido, agora);
    await registrarLigacao('acai', k, pedido, agora);
    assert.equal(k.chamadas.filter((c) => c[0] === 'campos').length, 1);
  });

  it('os campos falharam: a nota ainda vai (a ligação não some) e avisa', async () => {
    const r = await registrarLigacao('acai', kommoFalso({ camposFalham: true }), pedido, agora);
    assert.equal(r.ok && r.campos, false);
    assert.equal(r.ok && r.nota, true);
    assert.equal(r.ok && r.tentativas, null);
    assert.match((r as { avisos: string[] }).avisos.join(' '), /ficou só na nota/);
  });

  it('nada gravou: erro (a atendente tenta de novo)', async () => {
    const r = await registrarLigacao('acai', kommoFalso({ camposFalham: true, notaFalha: true }), pedido, agora);
    assert.deepEqual(r, { ok: false, status: 502, erro: 'não consegui gravar a ligação no Kommo agora' });
  });

  it('conta sem os campos ☎: só a nota, com aviso', async () => {
    const k = kommoFalso({ defs: [{ id: 1, name: 'Cidade', type: 'text' }] });
    const r = await registrarLigacao('outra', k, pedido, agora);
    assert.equal(r.ok && r.campos, false);
    assert.ok(!k.chamadas.some((c) => c[0] === 'gravar'));
    assert.match((r as { avisos: string[] }).avisos[0], /não tem os campos ☎/);
  });

  it('cartão apagado: 404, nada gravado', async () => {
    const k = kommoFalso({ semCartao: true });
    assert.deepEqual(await registrarLigacao('acai', k, pedido, agora), { ok: false, status: 404, erro: 'cartão não encontrado no Kommo' });
    assert.ok(!k.chamadas.some((c) => c[0] === 'gravar' || c[0] === 'nota'));
  });

  it('o PATCH de verdade: `custom_fields_values` na raiz, com `null` para esvaziar', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    const http = { patch: async (url: string, body: unknown) => { patches.push({ url, body }); return { data: {} }; } } as unknown as AxiosInstance;
    const cliente = new KommoClient({ subdomain: 'teste', accessToken: 't' } as never, http);
    await cliente.gravarCamposDoLead(123, [{ field_id: 2448896, values: null }, { field_id: 2448898, values: [{ value: 2 }] }]);
    await cliente.gravarCamposDoLead(123, []);
    assert.deepEqual(patches, [{ url: '/leads/123', body: { custom_fields_values: [{ field_id: 2448896, values: null }, { field_id: 2448898, values: [{ value: 2 }] }] } }]);
  });
});
