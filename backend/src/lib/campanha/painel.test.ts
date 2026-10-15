import { test } from 'node:test';
import assert from 'node:assert/strict';
import { juntarComATela, montarPainel, type Foto } from './painel.js';

const linha = (grupo: string, rotulo: string, ordem: number, extra: Record<string, unknown> = {}) => ({
  grupo, rotulo, ordem, diaDoEnvio: '2026-10-13', naTransmissao: 8, enviadas: 5, entregues: null, lidas: null, falhas: null, custoUsd: null,
  respondidasKommo: null, responderam: 1, sairam: 0, agendaram: 0, compareceram: 0, tratamentos: 0, receita: 0,
  sofiaMinMediana: 1, equipeEntrou: 1, equipeMinMediana: 359, ...extra,
});
const foto = (unidade: string, nome: string, linhas: ReturnType<typeof linha>[]): Foto => ({
  unidade, nome, qualidade: null, limiteDeEnvio: null, linhas, avisos: [], coletadoEm: '2026-10-16T20:00:00Z', cambio: 5.09,
  conversas: [{ grupo: 'rodada-1', nome: '<script>x</script>', respondeuEm: 1, sofiaMin: 1, equipeMin: 359, saiu: false, agendou: false, compareceu: false }],
});

test('página: grupos do mais recente para o mais antigo, nome escapado, custo em reais', () => {
  const unidades = [
    foto('doutor-hernia-canaa', 'Doutor Hérnia Canaã', [linha('rodada-1', '1ª rodada (13–14/10)', 0), linha('dia-1', 'Dia 1', 1, { agendaram: 2, custoUsd: 1.25 })]),
  ];
  const html = montarPainel({ nome: 'Outubro Rosa', fim: '2026-10-31' }, '2026-10-16', unidades);
  assert.ok(html.indexOf('Dia 1') < html.indexOf('1ª rodada'));
  assert.ok(!html.includes('<script>x</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Foto de 16/10/2026'));
  assert.match(html, /R\$\s?6,36/); // 1,25 × 5,09
  assert.ok(html.includes('6 h')); // 359 min
});

test('página sem coleta ainda não quebra', () => {
  const html = montarPainel({ nome: 'Outubro Rosa', fim: '2026-10-31' }, null, []);
  assert.ok(html.includes('Ainda sem coleta'));
});

test('números da tela do Kommo entram por cima dos do robô, só no grupo informado', () => {
  const f = foto('x', 'X', [linha('rodada-1', 'r', 0), linha('dia-1', 'd', 1)]);
  const j = juntarComATela(f, { 'dia-1': { entregues: 18, lidas: 9, custoUsd: 1.2 } });
  assert.deepEqual([j.linhas[1]!.entregues, j.linhas[1]!.lidas, j.linhas[1]!.custoUsd, j.linhas[1]!.enviadas], [18, 9, 1.2, 5]);
  assert.equal(j.linhas[0]!.entregues, null);
});
