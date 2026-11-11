import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgrupadorDeAvisos,
  INTERVALO_AVISO_MS,
  JANELA_AGRUPAR_MS,
  MAX_TEXTO_AVISO,
  anexarComplemento,
  marcaDeHora,
  montarAvisoComplemento,
} from './suporte-complemento.js';
import { MAX_RELATO } from './suporte-menu-maquina.js';

const QUANDO = new Date('2026-11-11T17:32:00Z'); // 14:32 em Brasília

test('marcaDeHora: horário de Brasília', () => {
  assert.equal(marcaDeHora(QUANDO), '11/11 14:32');
});

test('anexarComplemento: junta ao relato com a hora e devolve o que gravou', () => {
  const a = anexarComplemento('primeira parte', 'segunda parte', QUANDO);
  assert.equal(a.relato, 'primeira parte\n\n— complemento (11/11 14:32) —\nsegunda parte');
  assert.equal(a.gravado, 'segunda parte');
  assert.equal(a.cortado, false);
  assert.equal(a.cheio, false);
});

test('anexarComplemento: o total nunca passa do teto; o que não cabe é cortado e sinalizado', () => {
  const base = 'a'.repeat(MAX_RELATO - 100);
  const a = anexarComplemento(base, 'b'.repeat(500), QUANDO);
  assert.equal(a.relato.length, MAX_RELATO);
  assert.equal(a.cortado, true);
  assert.equal(a.cheio, false);
  assert.ok(a.gravado.length > 0 && a.gravado.length < 500);
});

test('anexarComplemento: texto vazio não é "cheio" nem "cortado" (nada a gravar, relato intacto)', () => {
  const a = anexarComplemento('abc', '', QUANDO);
  assert.deepEqual(a, { relato: 'abc', gravado: '', cortado: false, cheio: false });
});

test('Agrupador: centenas de balões curtos ainda cabem no Telegram (cada parte conta aspas e quebra)', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  for (let i = 0; i < 800; i++) ag.adicionar(compl('ok'));
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.ok(r.enviados[0]!.length < 3500, `${r.enviados[0]!.length}`);
  assert.match(r.enviados[0]!, /800 mensagens novas/);
  assert.match(r.enviados[0]!, /só o começo/);
});

test('anexarComplemento: relato no teto = nada gravado (cheio)', () => {
  const base = 'a'.repeat(MAX_RELATO);
  const a = anexarComplemento(base, 'mais', QUANDO);
  assert.equal(a.relato, base);
  assert.equal(a.cheio, true);
  assert.equal(a.cortado, true);
  assert.equal(a.gravado, '');
});

test('anexarComplemento: não corta no meio de um emoji', () => {
  const cab = '\n\n— complemento (11/11 14:32) —\n'.length;
  const base = 'a'.repeat(MAX_RELATO - cab - 3);
  // sobram 3 posições: "ab" + metade do emoji (2 unidades) não cabe inteiro
  const a = anexarComplemento(base, 'ab😀cd', QUANDO);
  assert.equal(a.gravado, 'ab');
  assert.ok(!/[\ud800-\udbff]$/.test(a.relato));
});

test('montarAvisoComplemento: texto curto, em linha, com a ressalva de dado; avisa teto e demanda já resolvida', () => {
  const t = montarAvisoComplemento(7, { nome: 'Maria', partes: ['linha 1 ⏎ linha 2', 'outra'], tamanho: 20, truncou: false, mensagens: 2, cortou: true, resolvida: true });
  assert.match(t, /^➕ Complemento da demanda #7 — 2 mensagens novas de Maria/);
  assert.match(t, /já estava marcada como resolvida/);
  assert.match(t, /«linha 1 ⏎ linha 2»/);
  assert.match(t, /«outra»/);
  assert.match(t, /passou do limite de 8000/);
  assert.doesNotMatch(t, /só o começo/);
  assert.ok(t.length < 3500);
});

test('anexarComplemento: sobrou tão pouco que o 1º emoji não cabe = cheio, sem cabeçalho solto', () => {
  const cab = '\n\n— complemento (11/11 14:32) —\n'.length;
  const base = 'a'.repeat(MAX_RELATO - cab - 1); // sobra 1 posição: meia surrogate
  const a = anexarComplemento(base, '😀 oi', QUANDO);
  assert.equal(a.cheio, true);
  assert.equal(a.relato, base);
});

// relógio e agendador falsos
function criar() {
  const r = { agora: 1_000_000, enviados: [] as string[], fila: [] as Array<{ em: number; fn: () => void }> };
  const ag = new AgrupadorDeAvisos({
    agora: () => r.agora,
    agendar: (ms, fn) => r.fila.push({ em: r.agora + ms, fn }),
    enviar: async (t) => {
      r.enviados.push(t);
      return true;
    },
  });
  /** anda o relógio até `ate` e dispara o que venceu */
  const andar = async (ate: number) => {
    r.agora = ate;
    for (const item of [...r.fila].sort((a, b) => a.em - b.em)) {
      if (item.em <= ate) {
        r.fila.splice(r.fila.indexOf(item), 1);
        item.fn();
        await new Promise((res) => setImmediate(res));
      }
    }
  };
  return { r, ag, andar };
}
const compl = (texto: string, extra = {}) => ({ protocolo: 5, nome: 'Maria', texto, cortado: false, status: 'aberta', ...extra });

test('Agrupador: 3 balões em poucos segundos = UM aviso só, depois da janela', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  ag.adicionar(compl('um'));
  r.agora = t0 + 3000;
  ag.adicionar(compl('dois'));
  r.agora = t0 + 6000;
  ag.adicionar(compl('três'));
  assert.equal(r.fila.length, 1, 'um só agendamento');
  await andar(t0 + JANELA_AGRUPAR_MS - 1);
  assert.equal(r.enviados.length, 0, 'ainda na janela');
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.equal(r.enviados.length, 1);
  assert.match(r.enviados[0]!, /3 mensagens novas/);
  assert.match(r.enviados[0]!, /«um»[\s\S]*«dois»[\s\S]*«três»/);
});

test('Agrupador: no máximo 1 aviso por demanda a cada INTERVALO; o que chega no meio vai no aviso seguinte, sem se perder', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  ag.adicionar(compl('a'));
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.equal(r.enviados.length, 1);
  // 1 min depois: chega outro; o aviso só sai 5 min depois do anterior
  r.agora = t0 + 60_000;
  ag.adicionar(compl('b'));
  ag.adicionar(compl('c'));
  await andar(t0 + JANELA_AGRUPAR_MS + INTERVALO_AVISO_MS - 1);
  assert.equal(r.enviados.length, 1);
  await andar(t0 + JANELA_AGRUPAR_MS + INTERVALO_AVISO_MS);
  assert.equal(r.enviados.length, 2);
  assert.match(r.enviados[1]!, /2 mensagens novas/);
  assert.match(r.enviados[1]!, /«b»[\s\S]*«c»/);
});

test('Agrupador: demandas diferentes não se seguram umas às outras', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  ag.adicionar(compl('a'));
  ag.adicionar(compl('x', { protocolo: 6 }));
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.equal(r.enviados.length, 2);
});

test('Agrupador: texto enorme vira aviso que cabe no Telegram e diz onde está o resto', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  for (let i = 0; i < 20; i++) ag.adicionar(compl('w'.repeat(1000)));
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.equal(r.enviados.length, 1);
  assert.ok(r.enviados[0]!.length < 3500, `${r.enviados[0]!.length}`);
  assert.match(r.enviados[0]!, /20 mensagens novas/);
  assert.match(r.enviados[0]!, /inteiro está no painel/);
  assert.ok(MAX_TEXTO_AVISO < 3500);
});

test('Agrupador: quebras de linha contam como o que vão ocupar (3 caracteres): aviso com muitas linhas curtas ainda cabe no Telegram', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  for (let i = 0; i < 6; i++) ag.adicionar(compl('a\nb\nc\nd\ne\nf\n'.repeat(120)));
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.ok(r.enviados[0]!.length < 3500, `${r.enviados[0]!.length}`);
  assert.match(r.enviados[0]!, /só o começo/);
  assert.match(r.enviados[0]!, /6 mensagens novas/);
});

test('Agrupador: texto que cabe EXATAMENTE no teto não ganha o aviso de "só o começo"', async () => {
  const { r, ag, andar } = criar();
  const t0 = r.agora;
  ag.adicionar(compl('q'.repeat(MAX_TEXTO_AVISO)));
  await andar(t0 + JANELA_AGRUPAR_MS);
  assert.doesNotMatch(r.enviados[0]!, /só o começo/);
});

test('Agrupador: telegram que recusa (false) é registrado e não trava a demanda', async () => {
  const fila: Array<() => void> = [];
  const ag = new AgrupadorDeAvisos({ agora: () => 1, agendar: (_ms, fn) => fila.push(fn), enviar: async () => false });
  ag.adicionar(compl('a'));
  fila[0]!();
  await new Promise((res) => setImmediate(res));
  ag.adicionar(compl('b'));
  assert.equal(fila.length, 2);
});

test('Agrupador: erro no envio não lança nem trava a demanda', async () => {
  const fila: Array<() => void> = [];
  const ag = new AgrupadorDeAvisos({
    agora: () => 1,
    agendar: (_ms, fn) => fila.push(fn),
    enviar: async () => {
      throw new Error('telegram fora');
    },
  });
  ag.adicionar(compl('a'));
  fila[0]!();
  await new Promise((res) => setImmediate(res));
  ag.adicionar(compl('b'));
  assert.equal(fila.length, 2, 'a demanda aceita novo aviso depois');
});
