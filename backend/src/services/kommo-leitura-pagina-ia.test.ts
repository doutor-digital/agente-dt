import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { KommoApiError, buildHttp, createKommoClient, createKommoClientSemFreio } from './kommo.service.js';

// Página /ia/:slug (04/11/2026): lê o Kommo da unidade SEM poder congelar o Kommo da Sofia. O limitador (180 ms) e o
// freio (kommoBackoff) são de módulo — um 403/429 desta página não pode empurrar a fila de ninguém.

const UNIT = {
  kommoSubdomain: 'timbosc', kommoAccessToken: 't', kommoSalesbotId: null, kommoReplyFieldId: null,
  kommoBypassSalesbot: false, kommoSalesbotExecuteEnabled: false,
} as never;

/** Kommo falso: guarda o que foi pedido; `status` 200 devolve `corpo`, outro status vira erro do Axios. */
function kommoFalso(resposta: (config: InternalAxiosRequestConfig, n: number) => { status: number; corpo?: unknown }) {
  const pedidos: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (config) => {
    pedidos.push(config);
    const { status, corpo } = resposta(config, pedidos.length);
    const response = { data: corpo ?? '', status, statusText: '', headers: {}, config };
    if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
    return response;
  };
  return { adapter, pedidos };
}

const duracao = async (f: () => Promise<unknown>) => {
  const t = Date.now();
  await f().catch(() => undefined);
  return Date.now() - t;
};

test('mudancasDeEtapaDesde: lê o autor, o nome do cartão que o Kommo já manda e de → para (formato de Timbó, 04/11)', async () => {
  const k = kommoFalso(() => ({
    status: 200,
    corpo: {
      _embedded: {
        events: [
          {
            id: '01m6ktnvm51b8r7adwbxhpb57e', type: 'lead_status_changed', entity_id: 5368768, entity_type: 'lead', created_by: 0, created_at: 1793814359,
            value_after: [{ lead_status: { id: 112321359, pipeline_id: 14523243 } }],
            value_before: [{ lead_status: { id: 112321351, pipeline_id: 14523243 } }],
            _embedded: { entity: { id: 5368768, name: 'João Augusto 04/11/2026' } },
          },
          { id: 'b', entity_id: 5, created_by: 15905863, created_at: 5, value_after: [{ lead_status: { id: 1, pipeline_id: 2 } }] },
          { id: 'lixo', entity_id: 'x' },
        ],
      },
    },
  }));
  const kommo = createKommoClientSemFreio(UNIT, { adapter: k.adapter });
  const r = await kommo.mudancasDeEtapaDesde(1793800000, 1);
  assert.deepEqual(r.eventos[0], {
    id: '01m6ktnvm51b8r7adwbxhpb57e', leadId: 5368768, nome: 'João Augusto 04/11/2026', por: 0, em: 1793814359,
    de: { pipelineId: 14523243, statusId: 112321351 }, para: { pipelineId: 14523243, statusId: 112321359 },
  });
  assert.equal(r.eventos[1].por, 15905863);
  assert.equal(r.eventos[1].de, null);
  assert.equal(r.eventos.length, 2, 'evento sem cartão válido é ignorado');
  assert.equal(r.temMais, false);
  const p = k.pedidos[0].params as Record<string, unknown>;
  assert.equal(p['filter[type]'], 'lead_status_changed');
  assert.equal(p['filter[created_at][from]'], 1793800000);
  assert.equal(p.limit, 100);
  assert.equal(p.with, 'lead_name', 'sem isto o Kommo não manda o nome do cartão');
  assert.equal(p['order[created_at]'], 'desc');
  // 204 (sem eventos) vem como corpo vazio
  const vazio = createKommoClientSemFreio(UNIT, { adapter: kommoFalso(() => ({ status: 204 })).adapter });
  assert.deepEqual(await vazio.mudancasDeEtapaDesde(1, 1), { eventos: [], temMais: false });
});

test('listLeadsAbertosPagina: uma página de 250, do id mais novo, só nas colunas abertas pedidas', async () => {
  const k = kommoFalso(() => ({ status: 200, corpo: { _embedded: { leads: [{ id: 9, name: 'Lead #9', status_id: 112321351, pipeline_id: 14523243 }] } } }));
  const kommo = createKommoClientSemFreio(UNIT, { adapter: k.adapter });
  const leads = await kommo.listLeadsAbertosPagina([{ pipelineId: 14523243, statusId: 112321351 }, { pipelineId: 14540271, statusId: 112322687 }], 2);
  assert.equal(leads.length, 1);
  const p = k.pedidos[0].params as Record<string, unknown>;
  assert.equal(p.limit, 250);
  assert.equal(p.page, 2);
  assert.equal(p['order[id]'], 'desc');
  assert.equal(p['filter[statuses][1][status_id]'], 112322687);
  assert.equal(p['filter[statuses][1][pipeline_id]'], 14540271);
  // Kommo fora: LANÇA (página vazia quer dizer "acabou", nunca "deu erro")
  const fora = createKommoClientSemFreio(UNIT, { adapter: kommoFalso(() => ({ status: 500 })).adapter });
  await assert.rejects(fora.listLeadsAbertosPagina([], 1), KommoApiError);
});

test('403/429 da página NÃO congela o Kommo: a chamada seguinte (a da Sofia) sai na hora; no cliente comum, o 429 a segura', async () => {
  // 1) cliente da página: 403 de bloqueio (sem "scope", o que aciona o freio de 30 s) e 429 com retry_after
  const pagina = createKommoClientSemFreio(UNIT, {
    adapter: kommoFalso((_c, n) => (n === 1 ? { status: 403, corpo: { title: 'Forbidden' } } : { status: 429, corpo: { retry_after: 3 } })).adapter,
  });
  await assert.rejects(pagina.mudancasDeEtapaDesde(1, 1), KommoApiError);
  await assert.rejects(pagina.mudancasDeEtapaDesde(1, 1), KommoApiError);
  const sofia = buildHttp({ slug: 's', subdomain: 'outra', accessToken: 't', salesbotId: null, replyFieldId: null, bypassSalesbot: false, salesbotExecuteEnabled: false }, {
    adapter: kommoFalso(() => ({ status: 200, corpo: { ok: true } })).adapter,
  });
  const msSofia = await duracao(() => sofia.get('/leads/1'));
  assert.ok(msSofia < 1000, `a Sofia esperou ${msSofia} ms depois do erro da página`);

  // 2) controle: o cliente COMUM, no mesmo 429 (retry_after 3 → freio de 3 s), segura a chamada seguinte
  const comum = createKommoClient(UNIT);
  assert.ok(comum, 'cliente comum existe');
  const comHttp = buildHttp({ slug: 'c', subdomain: 'timbosc', accessToken: 't', salesbotId: null, replyFieldId: null, bypassSalesbot: false, salesbotExecuteEnabled: false }, {
    adapter: kommoFalso(() => ({ status: 429, corpo: { retry_after: 3 } })).adapter,
  });
  await assert.rejects(comHttp.get('/x'));
  const msControle = await duracao(() => sofia.get('/leads/1'));
  assert.ok(msControle >= 2000, `no cliente comum o 429 devia segurar a fila; esperou só ${msControle} ms`);
});
