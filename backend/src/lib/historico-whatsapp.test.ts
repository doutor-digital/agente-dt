import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URL_PADRAO, contaDoHistorico, falasDoEvolution, jidsDoTelefone } from './historico-whatsapp.js';

test('contaDoHistorico: acha a unidade na lista; fora dela, null', () => {
  const env = { HISTORICO_EVO: 'doutor-hernia-caxias=historico-caxias:ABC123; doutor-hernia-x=inst2:k2' };
  assert.deepEqual(contaDoHistorico('doutor-hernia-caxias', env), { url: URL_PADRAO, instancia: 'historico-caxias', chave: 'ABC123' });
  assert.deepEqual(contaDoHistorico('doutor-hernia-x', { ...env, HISTORICO_EVO_URL: 'https://evo.exemplo.com/' })?.url, 'https://evo.exemplo.com');
  assert.equal(contaDoHistorico('doutor-hernia-timbo', env), null);
  assert.equal(contaDoHistorico('doutor-hernia-caxias', {}), null);
  assert.equal(contaDoHistorico('a', { HISTORICO_EVO: 'a=semchave' }), null);
});

test('jidsDoTelefone: com e sem o 9 do celular', () => {
  assert.deepEqual(jidsDoTelefone('+55 (21) 97366-6631'), ['5521973666631@s.whatsapp.net', '552173666631@s.whatsapp.net']);
  assert.deepEqual(jidsDoTelefone('2173666631'), ['552173666631@s.whatsapp.net', '5521973666631@s.whatsapp.net']);
  assert.deepEqual(jidsDoTelefone(null), []);
  assert.deepEqual(jidsDoTelefone('123'), []);
});

test('falasDoEvolution: só texto, só antes do corte, em ordem, os dois lados', () => {
  const ate = Date.parse('2026-11-12T20:00:00Z');
  const s = (iso: string) => Date.parse(iso) / 1000;
  const f = falasDoEvolution(
    [
      { key: { fromMe: false }, messageTimestamp: s('2026-11-10T13:05:00Z'), message: { extendedTextMessage: { text: 'quanto custa?' } } },
      { key: { fromMe: false }, messageTimestamp: s('2026-11-10T13:00:00Z'), message: { conversation: 'oi, boa tarde' } },
      { key: { fromMe: true }, messageTimestamp: s('2026-11-10T13:10:00Z'), message: { conversation: 'R$ 200, com R$ 50 de sinal' } },
      { key: { fromMe: false }, messageTimestamp: s('2026-11-10T13:20:00Z'), message: {} },
      { key: { fromMe: false }, messageTimestamp: s('2026-11-12T21:00:00Z'), message: { conversation: 'depois do Lite' } },
    ],
    ate,
    'America/Sao_Paulo',
  );
  assert.deepEqual(f.map((x) => [x.de, x.texto]), [
    ['paciente', 'oi, boa tarde'],
    ['paciente', 'quanto custa?'],
    ['equipe', 'R$ 200, com R$ 50 de sinal'],
  ]);
  assert.equal(f[0]!.hora, '10/11 10:00');
});

test('falasDoEvolution: guarda só as últimas', () => {
  const regs = Array.from({ length: 60 }, (_, i) => ({ key: { fromMe: i % 2 === 0 }, messageTimestamp: 1_700_000_000 + i * 60, message: { conversation: `m${i}` } }));
  const f = falasDoEvolution(regs, Date.now(), 'America/Sao_Paulo', 40);
  assert.equal(f.length, 40);
  assert.equal(f.at(-1)!.texto, 'm59');
});
