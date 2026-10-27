import { test } from 'node:test';
import assert from 'node:assert/strict';

import { avaliarDia, montarDiario, montarSemanal, num1, pct, somarAvaliacoes, somarMensagens } from './texto.js';
import { somarDias } from './dias.js';
import type { DadosDiarios, DadosSemanais, DiaAvaliado, DiaMensagens } from './tipos.js';

const ONTEM = '2026-10-26'; // segunda

/** Um dia "normal": 230 avaliadas, 100 avaliáveis, nota 6,4. */
function diaAv(dia: string, o: Partial<DiaAvaliado> = {}): DiaAvaliado {
  return { dia, total: 230, semSofia: 85, sumiu: 45, avaliaveis: 100, mediaAvaliaveis: 6.4, ...o };
}
function diaMsg(dia: string, o: Partial<DiaMensagens> = {}): DiaMensagens {
  return {
    dia,
    conversasComPaciente: 400,
    conversasSemSofia: 28,
    mensagensPaciente: 2000,
    mensagensPacienteVazias: 280,
    mensagensSofia: 3000,
    sinais: { repetidas: 3, vazamento: 2, falha: 7 },
    ...o,
  };
}

function normal(sobre: { ontemAv?: Partial<DiaAvaliado>; ontemMsg?: Partial<DiaMensagens>; vespera?: Partial<DiaAvaliado> } = {}): DadosDiarios {
  const dias = Array.from({ length: 8 }, (_, i) => somarDias(ONTEM, i - 7)); // 19/10 .. 26/10
  return {
    dia: ONTEM,
    avaliacoes: dias.map((d) => diaAv(d, d === ONTEM ? sobre.ontemAv : d === somarDias(ONTEM, -1) ? sobre.vespera : {})),
    mensagens: dias.map((d) => diaMsg(d, d === ONTEM ? sobre.ontemMsg : {})),
    piores: [
      { nome: 'Serra', media: 5.1, avaliaveis: 9 },
      { nome: 'Mossoró', media: 5.3, avaliaveis: 7 },
      { nome: 'Canaã', media: 5.5, avaliaveis: 6 },
    ],
    pior: {
      nota: 2.4,
      unidade: 'Serra',
      primeiroNome: 'Maria',
      final4: '8888',
      leadId: '123456',
      trecho: ['Paciente: quanto custa?', 'Sofia: Vou acolher a sua dor antes de soltar o valor.'],
    },
  };
}

test('formatação: vírgula decimal e porcentagem sem casa', () => {
  assert.equal(num1(6.44), '6,4');
  assert.equal(num1(6), '6,0');
  assert.equal(pct(7, 100), '7%');
  assert.equal(pct(0, 0), '–');
});

test('a média é ponderada pelas avaliáveis de cada dia, não a média das médias', () => {
  const t = somarAvaliacoes([diaAv('a', { avaliaveis: 90, mediaAvaliaveis: 7 }), diaAv('b', { avaliaveis: 10, mediaAvaliaveis: 3 })]);
  assert.equal(t.avaliaveis, 100);
  assert.ok(Math.abs((t.media ?? 0) - 6.6) < 1e-9);
  assert.equal(somarAvaliacoes([diaAv('c', { avaliaveis: 0, mediaAvaliaveis: null })]).media, null);
});

test('dia normal: 4 linhas, sem alerta, e diz quantas ficaram fora da nota e por quê', () => {
  const texto = montarDiario(normal());
  const linhas = texto.split('\n');
  assert.equal(linhas.length, 4, texto);
  assert.doesNotMatch(texto, /⚠️/);
  assert.match(linhas[0], /26\/10 \(seg\).*tudo igual/);
  assert.match(linhas[1], /230 avaliadas/);
  assert.match(linhas[1], /nota 6,4 só das 100 avaliáveis/);
  assert.match(linhas[1], /85 avaliações de conversas em que a Sofia nem chegou a falar, 45 em que o paciente sumiu/);
  assert.match(linhas[2], /Conversas do dia em que o paciente escreveu e a Sofia não falou no dia: 7%/);
  assert.match(linhas[2], /vazias: 14%/);
  assert.match(linhas[2], /sinais de erro: 12/);
  assert.match(linhas[3], /Serra 5,1 \(9\) · Mossoró 5,3 \(7\) · Canaã 5,5 \(6\)/);
});

test('o juiz parou (como em 25/10): menos da metade da média dos 7 dias vira alerta no topo', () => {
  const d = normal({ ontemAv: { total: 40, avaliaveis: 20 } });
  assert.ok(avaliarDia(d).alertas.some((a) => /juiz avaliou só 40/.test(a)));
  const parou = normal({ ontemAv: { total: 0, avaliaveis: 0, semSofia: 0, sumiu: 0, mediaAvaliaveis: null } });
  const texto = montarDiario(parou);
  assert.match(texto.split('\n')[0], /^⚠️/);
  assert.match(texto, /não avaliou nada ontem/);
  // exatamente a metade ainda não é "parou"
  assert.deepEqual(avaliarDia(normal({ ontemAv: { total: 115 } })).alertas.filter((a) => /juiz/.test(a)), []);
});

test('nota caiu: compara com a véspera E com a média dos 7 dias, só quando há avaliáveis suficientes', () => {
  const caiu = normal({ ontemAv: { mediaAvaliaveis: 5.7 } });
  const a = avaliarDia(caiu).alertas;
  assert.ok(a.some((x) => /caiu de 6,4 para 5,7/.test(x)), a.join('|'));
  assert.ok(a.some((x) => /abaixo da média dos 7 dias \(6,4\)/.test(x)));

  // queda pequena (0,3) não alerta
  assert.deepEqual(avaliarDia(normal({ ontemAv: { mediaAvaliaveis: 6.1 } })).alertas, []);
  // com 4 avaliáveis a média é ruído: não compara
  assert.deepEqual(avaliarDia(normal({ ontemAv: { mediaAvaliaveis: 2, avaliaveis: 4 } })).alertas, []);
});

test('nota boa não é alerta: melhora some com o ⚠️', () => {
  const texto = montarDiario(normal({ ontemAv: { mediaAvaliaveis: 7.5 } }));
  assert.doesNotMatch(texto, /⚠️/);
  assert.match(texto, /nota 7,5/);
});

test('Sofia sem falar e mensagens vazias: alerta só com alta de 5 pontos ou mais', () => {
  const a = avaliarDia(normal({ ontemMsg: { conversasSemSofia: 80, mensagensPacienteVazias: 600 } })).alertas;
  assert.ok(a.some((x) => /Sofia sem falar no dia subiu para 20%/.test(x)), a.join('|'));
  assert.ok(a.some((x) => /vazias subiram para 30%/.test(x)));
  assert.deepEqual(avaliarDia(normal({ ontemMsg: { conversasSemSofia: 36 } })).alertas, []); // 9% contra 7%
  // base pequena: não conclui nada
  assert.deepEqual(avaliarDia(normal({ ontemMsg: { conversasComPaciente: 10, conversasSemSofia: 9 } })).alertas, []);
});

test('sinais de erro: alerta quando passa de 1,5× a média E de +5; dia calmo não', () => {
  const a = avaliarDia(normal({ ontemMsg: { sinais: { repetidas: 10, vazamento: 8, falha: 9 } } })).alertas;
  assert.ok(a.some((x) => /sinais de erro da Sofia: 27 ontem, o esperado para o movimento do dia era 12,0/.test(x)), a.join('|'));
  assert.deepEqual(avaliarDia(normal({ ontemMsg: { sinais: { repetidas: 5, vazamento: 4, falha: 8 } } })).alertas, []); // 17 < 1,5×12
  assert.deepEqual(
    avaliarDia({ ...normal(), mensagens: normal().mensagens.map((m) => diaMsg(m.dia, { sinais: { repetidas: 0, vazamento: 0, falha: 0 } })) }).alertas,
    [],
  );
});

test('sinais de erro seguem o MOVIMENTO: dia com o dobro de mensagens e o dobro de sinais não é dia pior', () => {
  const movimentado = normal({ ontemMsg: { mensagensSofia: 6000, mensagensPaciente: 4000, sinais: { repetidas: 6, vazamento: 4, falha: 14 } } });
  assert.deepEqual(avaliarDia(movimentado).alertas, []);
  // o mesmo número de sinais num dia de pouco movimento já é ruim
  const calmo = normal({ ontemMsg: { mensagensSofia: 1000, sinais: { repetidas: 6, vazamento: 4, falha: 14 } } });
  assert.ok(avaliarDia(calmo).alertas.some((x) => /sinais de erro/.test(x)));
});

test('juiz parou: domingo/segunda baixos não disparam se o mesmo dia da semana passada também era baixo', () => {
  const d = normal({ ontemAv: { total: 100 } }); // 100 < metade de 230
  assert.ok(avaliarDia(d).alertas.some((a) => /pode ter parado/.test(a)), 'sem o histórico do dia, alerta');
  // semana passada, mesmo dia (19/10): 160 → 100 não é menos da metade de 160
  const segundaFraca = { ...d, avaliacoes: d.avaliacoes.map((x) => (x.dia === '2026-10-19' ? { ...x, total: 160 } : x)) };
  assert.deepEqual(avaliarDia(segundaFraca).alertas.filter((a) => /juiz/.test(a)), []);
  // mas 40 é menos da metade dos dois
  const parou = { ...segundaFraca, avaliacoes: segundaFraca.avaliacoes.map((x) => (x.dia === ONTEM ? { ...x, total: 40 } : x)) };
  assert.ok(avaliarDia(parou).alertas.some((a) => /pode ter parado/.test(a)));
});

test('quando piorou: ⚠️ no topo, a pior conversa entra com 1º nome e 4 dígitos — nunca o telefone', () => {
  const texto = montarDiario(normal({ ontemAv: { mediaAvaliaveis: 5.5 } }));
  const linhas = texto.split('\n');
  assert.match(linhas[0], /^⚠️ Sofia, resumo de 26\/10 \(seg\): piorou/);
  assert.match(linhas[1], /^• nota caiu/);
  assert.match(texto, /Pior conversa avaliável: nota 2,4, Serra \(Maria, final 8888, cartão 123456\)/);
  assert.match(texto, /Paciente: quanto custa\?/);
  assert.match(texto, /Sofia: Vou acolher/);
  assert.doesNotMatch(texto, /\d{9,}/, 'nenhuma sequência longa de dígitos (telefone) no texto');
});

test('sem nome de gente e sem telefone, a pior conversa ainda sai (como "paciente")', () => {
  const d = normal({ ontemAv: { mediaAvaliaveis: 5.5 } });
  d.pior = { ...d.pior!, primeiroNome: null, final4: null };
  assert.match(montarDiario(d), /\(paciente, cartão 123456\)/);
});

test('sem unidade com avaliáveis suficientes e sem nota: o texto diz, não inventa', () => {
  const d = normal({ ontemAv: { total: 20, avaliaveis: 0, mediaAvaliaveis: null, semSofia: 15, sumiu: 5 } });
  d.piores = [];
  const texto = montarDiario(d);
  assert.match(texto, /sem nota: nenhuma conversa avaliável/);
  assert.match(texto, /nenhuma unidade com conversas avaliáveis suficientes/);
});

test('juiz parado há mais de uma semana não vira "tudo igual" (a média dos 7 dias já é zero)', () => {
  const d = normal();
  const parado = {
    ...d,
    avaliacoes: d.avaliacoes.map((x) => ({ ...x, total: 0, semSofia: 0, sumiu: 0, avaliaveis: 0, mediaAvaliaveis: null })),
  };
  const texto = montarDiario(parado);
  assert.match(texto.split('\n')[0], /^⚠️/);
  assert.match(texto, /nenhuma conversa nos últimos 8 dias — está parado/);
});

test('sem os 7 dias anteriores o cabeçalho não diz "tudo igual" (não há com o que comparar)', () => {
  const d = normal();
  const so = { ...d, avaliacoes: d.avaliacoes.filter((x) => x.dia === ONTEM), mensagens: d.mensagens.filter((x) => x.dia === ONTEM) };
  assert.match(montarDiario(so).split('\n')[0], /sem os 7 dias anteriores para comparar/);
});

test('soma de mensagens junta os sinais por categoria', () => {
  const t = somarMensagens([diaMsg('a'), diaMsg('b')]);
  assert.deepEqual(t.sinais, { repetidas: 6, vazamento: 4, falha: 14 });
  assert.equal(t.conversas, 800);
});

// ── semanal ────────────────────────────────────────────────────────────────────────────────────────
test('semanal: nota só das avaliáveis, faixas com conversão, sinais, comparação com a semana anterior', () => {
  const fim = '2026-10-30'; // sexta; o resumo sai no sábado 31/10
  const dias = Array.from({ length: 14 }, (_, i) => somarDias(fim, i - 13));
  const d: DadosSemanais = {
    fim,
    avaliacoes: dias.map((x, i) => diaAv(x, i < 7 ? { mediaAvaliaveis: 6.0, total: 220 } : { mediaAvaliaveis: 6.4 })),
    mensagens: dias.map((x) => diaMsg(x)),
    faixas: [
      { faixa: 'baixa', conversas: 120, ganhos: 6, comConsulta: 12 },
      { faixa: 'media', conversas: 400, ganhos: 40, comConsulta: 80 },
      { faixa: 'alta', conversas: 180, ganhos: 36, comConsulta: 72 },
    ],
    piores: [{ nome: 'Serra', media: 5.0, avaliaveis: 22 }],
  };
  const texto = montarSemanal(d);
  assert.match(texto, /semana de 24\/10 \(sáb\) a 30\/10 \(sex\)/);
  assert.match(texto, /Juiz: 1\.610 avaliadas \(semana anterior 1\.540\)/);
  assert.match(texto, /Só 700 \(43%\) medem a Sofia/);
  assert.match(texto, /595 avaliações de conversas em que ela nem chegou a falar e 315 em que o paciente sumiu/);
  assert.match(texto, /Nota média \(só avaliáveis\): 6,4 — semana anterior 6,0/);
  assert.match(texto, /nota baixa \(menos de 5\): 120 conversas, 5% viraram ganho, 10% com consulta marcada/);
  assert.match(texto, /nota alta \(7 ou mais\): 180 conversas, 20% viraram ganho, 40% com consulta marcada/);
  assert.match(texto, /Sinais de erro: 84 \(repetidas 21, raciocínio vazado 14, .* 49\); semana anterior 84/);
  assert.match(texto, /Piores unidades da semana: Serra 5,0 \(22\)/);
});
