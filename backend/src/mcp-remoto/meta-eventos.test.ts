import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDaUnidade, metaEventos, metaEventosDoLead, montarPainelDeEventos, type FonteRastreio } from './meta-eventos.js';

test('nomes de unidade: slug, nome curto e o nome do n8n viram a mesma chave', () => {
  assert.equal(chaveDaUnidade('doutor-hernia-boa-vista'), 'boavista');
  assert.equal(chaveDaUnidade('Rio Verde'), 'rioverde');
  assert.equal(chaveDaUnidade('Açailândia'), 'acailandia');
  assert.equal(chaveDaUnidade('todas'), 'todas');
});

test('painel: soma por evento e status, alerta recusa, silêncio de 48 h e clique sem lead quente', () => {
  const agora = new Date('2026-10-16T15:00:00Z');
  const r = montarPainelDeEventos(
    [
      { unidade: 'balsas', event_name: 'LeadSubmitted', status: 'enviado', n: 16, ultimo: new Date('2026-10-16T12:00:00Z') },
      { unidade: 'balsas', event_name: 'AddToCart', status: 'falhou', n: 2, ultimo: null },
      { unidade: 'serra', event_name: 'ViewContent', status: 'enviado', n: 40, ultimo: new Date('2026-10-12T12:00:00Z') },
    ],
    [{ unidade: 'serra', cliques: 50, pessoas: 45 }],
    null,
    agora,
  );
  assert.equal(r.porUnidade.balsas!.eventos.LeadSubmitted!.enviados, 16);
  assert.equal(r.porUnidade.balsas!.eventos.AddToCart!.falharam, 2);
  assert.ok(r.porUnidade.balsas!.alertas.some((a) => /recusado/.test(a)));
  assert.ok(r.porUnidade.serra!.alertas.some((a) => /48 h/.test(a)));
  assert.ok(r.porUnidade.serra!.alertas.some((a) => /nenhum lead quente/.test(a)));
  assert.equal(r.rede.enviados.LeadSubmitted, 16);
  assert.equal(r.rede.falharam, 2);
  assert.deepEqual(r.rede.comAlerta.sort(), ['balsas', 'serra']);
});

test('consulta: filtro por unidade vai como lista, período no fuso de São Paulo; unidade sem rastreio dá erro claro', async () => {
  const chamadas: Array<[string, unknown[]]> = [];
  const fonte: FonteRastreio = {
    async consultar<T>(sql: string, ...p: unknown[]) {
      chamadas.push([sql, p]);
      if (/distinct unidade/.test(sql)) return [{ unidade: 'serra' }] as T[];
      return [] as T[];
    },
  };
  await assert.rejects(() => metaEventos(fonte, { unidade: 'xpto', inicio: '2026-10-01', fim: '2026-10-16' }), /sem rastreio/);
  assert.deepEqual(chamadas[0]![1][2], ['xpto']);
  assert.equal((chamadas[0]![1][0] as Date).toISOString(), '2026-10-01T03:00:00.000Z');
  const r = await metaEventos(fonte, { unidade: 'todas', inicio: '2026-10-01', fim: '2026-10-16' });
  assert.equal(r.rede.unidades, 0);
});

test('lead: eventos com data local e o motivo do que não saiu', async () => {
  const fonte: FonteRastreio = {
    async consultar<T>(sql: string) {
      if (/from capi_envios/.test(sql)) return [{ unidade: 'maraba', event_name: 'ViewContent', status: 'enviado', http_status: 200, reservado_em: new Date('2026-10-13T15:32:00Z'), enviado_em: new Date('2026-10-13T15:32:05Z'), ctwa_clid: 'abc', erro: null }] as T[];
      return [{ motivo: 'sem_ctwa_clid', event_name: 'LeadSubmitted', vezes: 3, ultima: new Date('2026-10-14T12:00:00Z') }] as T[];
    },
  };
  const r = await metaEventosDoLead(fonte, { leadId: 25286132 });
  assert.equal(r.veioDeAnuncio, true);
  assert.equal(r.eventos[0]!.em, '13/10/2026, 12:32');
  assert.match(r.naoSairam[0]!.motivo, /clique em anúncio/);
});
