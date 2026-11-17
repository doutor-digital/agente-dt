import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cotacaoDoDolar, FONTES_DO_DOLAR } from './cotacao-dolar.js';

type Resp = { ok: boolean; json: () => Promise<unknown> };
const ok = (corpo: unknown): Resp => ({ ok: true, json: async () => corpo });
const status = (n: number): Resp => ({ ok: n >= 200 && n < 300, json: async () => ({ status: n, code: 'QuotaExceeded' }) });

/** Uma «rede» por URL: o que cada fonte devolve (ou lança), e quem foi chamado. */
function rede(porFonte: Record<string, Resp | Error>) {
  const chamadas: string[] = [];
  const buscar = async (url: string) => {
    const f = FONTES_DO_DOLAR.find((x) => x.url === url)!;
    chamadas.push(f.nome);
    const r = porFonte[f.nome];
    if (r === undefined || r instanceof Error) throw r ?? new Error('sem rede');
    return r;
  };
  return { buscar, chamadas };
}

const BCB = [{ data: '16/11/2026', valor: '5.7324' }];
const AWESOME = { USDBRL: { bid: '5.80' } };
const ER = { result: 'success', rates: { BRL: 5.75 } };

describe('cotacaoDoDolar — três fontes', () => {
  it('o Banco Central respondeu: vale ele, sem chamar as outras', async () => {
    const r = rede({ bcb: ok(BCB), awesomeapi: ok(AWESOME), 'er-api': ok(ER) });
    assert.equal(await cotacaoDoDolar(r.buscar), 5.7324);
    assert.deepEqual(r.chamadas, ['bcb']);
  });

  it('o 17/11: BCB fora e awesomeapi com 429 (cota) → vale a terceira', async () => {
    const r = rede({ bcb: new Error('timeout'), awesomeapi: status(429), 'er-api': ok(ER) });
    assert.equal(await cotacaoDoDolar(r.buscar), 5.75);
    assert.deepEqual(r.chamadas, ['bcb', 'awesomeapi', 'er-api']);
  });

  it('BCB com resposta vazia ou formato mudado → passa para a próxima', async () => {
    for (const corpo of [[], {}, [{ data: 'x' }], null, 'html']) {
      const r = rede({ bcb: ok(corpo), awesomeapi: ok(AWESOME) });
      assert.equal(await cotacaoDoDolar(r.buscar), 5.8, JSON.stringify(corpo));
    }
  });

  it('valor fora do plausível (leitura errada) não vale: nem 0, nem negativo, nem centavos, nem 580', async () => {
    for (const valor of ['0', '-5', '0.17', '580', 'NaN']) {
      const r = rede({ bcb: ok([{ valor }]), awesomeapi: status(429), 'er-api': status(500) });
      assert.equal(await cotacaoDoDolar(r.buscar), null, valor);
    }
  });

  it('nenhuma fonte respondeu → null (quem chama usa a reserva), e não lança', async () => {
    const r = rede({ bcb: new Error('x'), awesomeapi: new Error('y'), 'er-api': status(503) });
    assert.equal(await cotacaoDoDolar(r.buscar), null);
  });

  it('json() que lança (corpo não é JSON) não derruba: próxima fonte', async () => {
    const quebrado: Resp = { ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    const r = rede({ bcb: quebrado, awesomeapi: ok(AWESOME) });
    assert.equal(await cotacaoDoDolar(r.buscar), 5.8);
  });

  it('toda chamada leva prazo (AbortSignal), para uma fonte pendurada não pendurar a tela', async () => {
    const sinais: unknown[] = [];
    await cotacaoDoDolar(async (_u, init) => { sinais.push(init.signal); return ok(BCB); });
    assert.ok(sinais[0] instanceof AbortSignal);
  });
});
