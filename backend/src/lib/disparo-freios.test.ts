import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREIOS_PADRAO, dentroDaJanela, falhasSeguidasDemais, freiosDoAmbiente, passouDoLimiteDeSair, vagas } from './disparo/freios.js';

const SP = 'America/Sao_Paulo';
// 2026-10-21 é uma quarta-feira; 12:00Z = 09:00 em São Paulo.
const quarta = (horaUtc: number, min = 0) => new Date(Date.UTC(2026, 9, 21, horaUtc, min));

test('janela: de madrugada não sai nada, às 9h e às 17h59 sim, às 18h não', () => {
  assert.equal(dentroDaJanela(quarta(6), SP, FREIOS_PADRAO).ok, false, '03h em SP');
  assert.equal(dentroDaJanela(quarta(11, 59), SP, FREIOS_PADRAO).ok, false, '08h59');
  assert.equal(dentroDaJanela(quarta(12), SP, FREIOS_PADRAO).ok, true, '09h00');
  assert.equal(dentroDaJanela(quarta(20, 59), SP, FREIOS_PADRAO).ok, true, '17h59');
  assert.equal(dentroDaJanela(quarta(21), SP, FREIOS_PADRAO).ok, false, '18h00');
});

test('janela: sábado, domingo e feriado nacional ficam de fora', () => {
  const sab = new Date(Date.UTC(2026, 9, 24, 15)); // sáb 24/10, 12h em SP
  const dom = new Date(Date.UTC(2026, 9, 25, 15));
  const feriado = new Date(Date.UTC(2026, 9, 12, 15)); // seg 12/10 — Nossa Senhora Aparecida
  assert.deepEqual(dentroDaJanela(sab, SP, FREIOS_PADRAO), { ok: false, motivo: 'sábado' });
  assert.deepEqual(dentroDaJanela(dom, SP, FREIOS_PADRAO), { ok: false, motivo: 'domingo' });
  assert.deepEqual(dentroDaJanela(feriado, SP, FREIOS_PADRAO), { ok: false, motivo: 'feriado' });
});

test('janela: usa o relógio da UNIDADE (Boa Vista é UTC−4)', () => {
  const t = quarta(12, 30); // 09h30 em SP, 08h30 em Boa Vista
  assert.equal(dentroDaJanela(t, 'America/Boa_Vista', FREIOS_PADRAO).ok, false);
  assert.equal(dentroDaJanela(t, SP, FREIOS_PADRAO).ok, true);
});

test('tetos: por hora e por dia, o menor vence; nunca negativo; lote limita a rodada', () => {
  assert.equal(vagas(FREIOS_PADRAO, 0, 0), 10, 'lote de 10 manda na rodada');
  assert.equal(vagas(FREIOS_PADRAO, 25, 0), 5, 'faltam 5 para 30/h');
  assert.equal(vagas(FREIOS_PADRAO, 0, 97), 3, 'faltam 3 para 100/dia');
  assert.equal(vagas(FREIOS_PADRAO, 30, 30), 0);
  assert.equal(vagas(FREIOS_PADRAO, 99, 500), 0);
});

test('SAIR: com limite 3, a 3ª pessoa ainda não para e a 4ª para', () => {
  assert.equal(passouDoLimiteDeSair(3, FREIOS_PADRAO), false);
  assert.equal(passouDoLimiteDeSair(4, FREIOS_PADRAO), true);
});

test('falhas seguidas: só as ÚLTIMAS N e todas falhas pausam; um envio bom no meio desfaz', () => {
  assert.equal(falhasSeguidasDemais(['falhou', 'falhou', 'falhou', 'falhou', 'falhou'], FREIOS_PADRAO), true);
  assert.equal(falhasSeguidasDemais(['falhou', 'falhou', 'enviado', 'falhou', 'falhou'], FREIOS_PADRAO), false);
  assert.equal(falhasSeguidasDemais(['falhou', 'falhou'], FREIOS_PADRAO), false, 'poucos dados não pausam');
});

test('ambiente: valor ilegível volta ao padrão e nunca vira "sem teto"', () => {
  const f = freiosDoAmbiente({ DISPARO_TETO_HORA: 'abc', DISPARO_TETO_DIA: '-4', DISPARO_JANELA_INICIO: '20', DISPARO_JANELA_FIM: '8', DISPARO_MAX_SAIR: '' } as NodeJS.ProcessEnv);
  assert.equal(f.tetoPorHora, FREIOS_PADRAO.tetoPorHora);
  assert.equal(f.tetoPorDia, FREIOS_PADRAO.tetoPorDia);
  assert.equal(f.janelaInicio, FREIOS_PADRAO.janelaInicio, 'janela invertida volta ao padrão');
  assert.equal(f.janelaFim, FREIOS_PADRAO.janelaFim);
  assert.equal(f.maxSair, FREIOS_PADRAO.maxSair);
  assert.equal(freiosDoAmbiente({ DISPARO_TETO_HORA: '12', DISPARO_SO_DIAS_UTEIS: '0' } as NodeJS.ProcessEnv).tetoPorHora, 12);
  assert.equal(freiosDoAmbiente({ DISPARO_SO_DIAS_UTEIS: '0' } as NodeJS.ProcessEnv).soDiasUteis, false);
});

test('ambiente: o que NÃO valeu é dito (o código volta ao padrão, e o worker avisa no log)', async () => {
  const { avisosDoAmbiente } = await import('./disparo/freios.js');
  assert.deepEqual(avisosDoAmbiente({} as NodeJS.ProcessEnv), []);
  const a = avisosDoAmbiente({ DISPARO_JANELA_INICIO: '19', DISPARO_TETO_HORA: 'abc' } as NodeJS.ProcessEnv);
  assert.equal(a.length, 2);
  assert.match(a[0]!, /JANELA_INICIO\/FIM não valem juntos/);
  assert.match(a[1]!, /DISPARO_TETO_HORA="abc" não vale/);
  assert.deepEqual(avisosDoAmbiente({ DISPARO_JANELA_INICIO: '8', DISPARO_JANELA_FIM: '20', DISPARO_TETO_HORA: '12' } as NodeJS.ProcessEnv), []);
});
