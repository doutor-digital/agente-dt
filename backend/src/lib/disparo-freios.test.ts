import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREIOS_PADRAO, avisosDoAmbiente, dentroDaJanela, falhasSeguidasDemais, freiosDaUnidade, freiosDoAmbiente, passouDoLimiteDeSair, tetoPorDiaDaUnidade, vagas } from './disparo/freios.js';

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

test('rodadas seguidas com limite de taxa: padrão 10, muda por DISPARO_LIMITE_DE_TAXA_SEGUIDOS, valor ruim volta ao padrão e é avisado', () => {
  assert.equal(FREIOS_PADRAO.limiteDeTaxaSeguidos, 10);
  assert.equal(freiosDoAmbiente({ DISPARO_LIMITE_DE_TAXA_SEGUIDOS: '4' } as NodeJS.ProcessEnv).limiteDeTaxaSeguidos, 4);
  for (const ruim of ['0', 'abc', '-1', '1000']) assert.equal(freiosDoAmbiente({ DISPARO_LIMITE_DE_TAXA_SEGUIDOS: ruim } as NodeJS.ProcessEnv).limiteDeTaxaSeguidos, 10, ruim);
});

// ── teto de 24 h POR UNIDADE (DISPARO_TETO_DIA_POR_UNIDADE) ─────────────────────────────────────────────────────

const amb = (v: Record<string, string>) => v as NodeJS.ProcessEnv;
const MAG = 'magalhaes-advocacia';

test('teto por unidade: a unidade listada pega o SEU teto; as outras ficam no global; o teto por hora e o resto não mudam', () => {
  const env = amb({ DISPARO_TETO_DIA_POR_UNIDADE: `${MAG}=200` });
  assert.equal(freiosDaUnidade(MAG, env).tetoPorDia, 200);
  assert.equal(freiosDaUnidade('doutor-hernia-canaa', env).tetoPorDia, 100, 'Canaã continua no padrão');
  assert.equal(freiosDaUnidade('doutor-hernia-parauapebas', env).tetoPorDia, 100, 'Parauapebas continua no padrão');
  assert.deepEqual({ ...freiosDaUnidade(MAG, env), tetoPorDia: 0 }, { ...freiosDoAmbiente(env), tetoPorDia: 0 }, 'só o teto de 24 h muda');
  assert.equal(freiosDaUnidade(MAG, env).tetoPorHora, 30);
  assert.equal(freiosDoAmbiente(env).tetoPorDia, 100, 'freiosDoAmbiente (o global) não é tocado');
});

test('teto por unidade: sem a variável, é o global de sempre — inclusive o DISPARO_TETO_DIA do ambiente', () => {
  assert.equal(freiosDaUnidade(MAG, amb({})).tetoPorDia, 100);
  assert.equal(freiosDaUnidade(MAG, amb({ DISPARO_TETO_DIA: '60' })).tetoPorDia, 60);
  assert.equal(freiosDaUnidade(MAG, amb({ DISPARO_TETO_DIA: '60', DISPARO_TETO_DIA_POR_UNIDADE: `${MAG}=200` })).tetoPorDia, 200, 'o da unidade vence o global');
  assert.equal(freiosDaUnidade('outra', amb({ DISPARO_TETO_DIA: '60', DISPARO_TETO_DIA_POR_UNIDADE: `${MAG}=200` })).tetoPorDia, 60);
});

test('teto por unidade: "/" separa as unidades (o ";" quebraria o .env), e ";" e quebra de linha também valem; espaços e separador sobrando não atrapalham', () => {
  for (const lista of ['a=150/b=250', 'a=150;b=250', 'a=150\nb=250', ' a = 150 / b = 250 /', 'a=150//b=250', 'A=150/B=250']) {
    const env = amb({ DISPARO_TETO_DIA_POR_UNIDADE: lista });
    assert.equal(tetoPorDiaDaUnidade('a', env), 150, lista);
    assert.equal(tetoPorDiaDaUnidade('b', env), 250, lista);
    assert.equal(tetoPorDiaDaUnidade('c', env), 100, lista);
    assert.deepEqual(avisosDoAmbiente(env), [], `${lista}: lista boa não gera aviso`);
  }
});

test('teto por unidade: valor ilegível ou fora de 1..10000 é IGNORADO (cai no global, nunca vira "sem teto") e é avisado', () => {
  for (const ruim of ['0', '-5', '10001', 'abc', '', '1e3', '12.5', '200abc', '0x10', ' ']) {
    const env = amb({ DISPARO_TETO_DIA_POR_UNIDADE: `${MAG}=${ruim}` });
    assert.equal(freiosDaUnidade(MAG, env).tetoPorDia, 100, `"${ruim}" cai no global`);
    const a = avisosDoAmbiente(env);
    assert.equal(a.length, 1, `"${ruim}" é avisado`);
    assert.match(a[0]!, /DISPARO_TETO_DIA_POR_UNIDADE.*não vale/);
  }
  // sem "=", slug vazio ou estranho
  for (const ruim of [MAG, '=200', 'mag adv=200', '200']) {
    const env = amb({ DISPARO_TETO_DIA_POR_UNIDADE: ruim });
    assert.equal(freiosDaUnidade(MAG, env).tetoPorDia, 100, ruim);
    assert.equal(avisosDoAmbiente(env).length, 1, ruim);
  }
  // as bordas valem
  assert.equal(tetoPorDiaDaUnidade('a', amb({ DISPARO_TETO_DIA_POR_UNIDADE: 'a=1' })), 1);
  assert.equal(tetoPorDiaDaUnidade('a', amb({ DISPARO_TETO_DIA_POR_UNIDADE: 'a=10000' })), 10_000);
});

test('teto por unidade: uma entrada ruim não derruba as boas; slug repetido vale o primeiro e avisa', () => {
  const env = amb({ DISPARO_TETO_DIA_POR_UNIDADE: `${MAG}=200/b=xx/c=300/c=400` });
  assert.equal(tetoPorDiaDaUnidade(MAG, env), 200);
  assert.equal(tetoPorDiaDaUnidade('b', env), 100);
  assert.equal(tetoPorDiaDaUnidade('c', env), 300);
  const a = avisosDoAmbiente(env);
  assert.equal(a.length, 2);
  assert.match(a[0]!, /"b=xx" não vale/);
  assert.match(a[1]!, /"c" aparece mais de uma vez/);
});

test('teto por unidade: o teto da unidade entra em vagas() — 195 nas 24 h deixam 5 para a Magalhães e 0 para quem está no global', () => {
  const env = amb({ DISPARO_TETO_DIA_POR_UNIDADE: `${MAG}=200` });
  assert.equal(vagas(freiosDaUnidade(MAG, env), 0, 195), 5);
  assert.equal(vagas(freiosDaUnidade('doutor-hernia-canaa', env), 0, 195), 0);
});
