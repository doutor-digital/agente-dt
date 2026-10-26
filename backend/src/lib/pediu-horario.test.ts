/**
 * "Pediu horário": a etiqueta que o fluxo da Meta lê. O que importa provar:
 *  - em "só no papel" NADA vai ao Kommo (o risco de uma automação seca que grava);
 *  - desligada, nem registra;
 *  - ligada, põe a etiqueta certa UMA vez por cartão por dia e uma falha não vira repetição eterna nem derruba a Sofia.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { sinalizarPediuHorario, esquecerPediuHorario, ETIQUETA_PEDIU_HORARIO, ID_AUTOMACAO, type DepsPediuHorario } from './pediu-horario.js';
import { AUTOMACOES, automacaoPorId, verificarCatalogo } from './automacoes.js';

const unit = { id: 'u1', slug: 'doutor-hernia-balsas' };

function montar(estado: 'ligado' | 'seco' | 'desligado', t = { agora: 1_800_000_000_000 }) {
  const tags: unknown[] = [];
  const simulacoes: unknown[] = [];
  const kommo = {
    addTag: async (p: unknown) => {
      tags.push(p);
    },
  };
  const deps: DepsPediuHorario = {
    estado: () => estado,
    simular: ((_u: unknown, _id: string, s: unknown) => {
      simulacoes.push(s);
    }) as DepsPediuHorario['simular'],
    agora: () => t.agora,
  };
  return { tags, simulacoes, kommo, deps, t };
}

beforeEach(() => esquecerPediuHorario());

test('seco: registra "etiquetaria" para a tela e NÃO escreve no Kommo', async () => {
  const x = montar('seco');
  assert.equal(await sinalizarPediuHorario(unit, 123, x.kommo, x.deps), 'seco');
  assert.equal(x.tags.length, 0, 'o seco não pode gravar etiqueta');
  assert.equal(x.simulacoes.length, 1);
  assert.deepEqual(
    { acao: (x.simulacoes[0] as any).acao, alvo: (x.simulacoes[0] as any).alvo, leadId: (x.simulacoes[0] as any).leadId },
    { acao: 'etiquetaria', alvo: ETIQUETA_PEDIU_HORARIO, leadId: 123 },
  );
});

test('desligado: não registra nem escreve', async () => {
  const x = montar('desligado');
  assert.equal(await sinalizarPediuHorario(unit, 123, x.kommo, x.deps), 'desligado');
  assert.equal(x.tags.length + x.simulacoes.length, 0);
});

test('ligado: põe a etiqueta exata no cartão, uma vez por dia', async () => {
  const x = montar('ligado');
  assert.equal(await sinalizarPediuHorario(unit, 123, x.kommo, x.deps), 'marcou');
  assert.deepEqual(x.tags, [{ leadId: 123, tag: 'IA · Pediu horário' }]);
  assert.equal(await sinalizarPediuHorario(unit, 123, x.kommo, x.deps), 'repetido');
  assert.equal(x.tags.length, 1, 'cada PATCH dispara webhook do Kommo: não repetir');
  assert.equal(await sinalizarPediuHorario(unit, 456, x.kommo, x.deps), 'marcou', 'outro cartão segue');
  x.t.agora += 25 * 3600_000;
  assert.equal(await sinalizarPediuHorario(unit, 123, x.kommo, x.deps), 'marcou', 'passado um dia, vale de novo');
});

test('ligado: falha do Kommo não lança e deixa tentar de novo na próxima consulta', async () => {
  const x = montar('ligado');
  let falhar = true;
  const kommo = {
    addTag: async (p: unknown) => {
      if (falhar) throw new Error('429');
      x.tags.push(p);
    },
  };
  assert.equal(await sinalizarPediuHorario(unit, 123, kommo, x.deps), 'falhou');
  falhar = false;
  assert.equal(await sinalizarPediuHorario(unit, 123, kommo, x.deps), 'marcou');
  assert.equal(x.tags.length, 1);
});

test('sem cartão ou sem cliente do Kommo: não faz nada, mesmo ligado', async () => {
  const x = montar('ligado');
  assert.equal(await sinalizarPediuHorario(unit, undefined, x.kommo, x.deps), 'sem-cartao');
  assert.equal(await sinalizarPediuHorario(unit, 0, x.kommo, x.deps), 'sem-cartao');
  assert.equal(await sinalizarPediuHorario(unit, 123, undefined, x.deps), 'sem-cartao');
  assert.equal(x.tags.length, 0);
});

test('catálogo: a automação existe, nasce em "só no papel" e o catálogo continua válido', () => {
  const a = automacaoPorId(ID_AUTOMACAO);
  assert.ok(a, 'entrou no catálogo (senão fica invisível na tela)');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'seco');
  assert.equal(a.chave, 'CAPI_PEDIU_HORARIO_SLUGS');
  assert.deepEqual(verificarCatalogo(AUTOMACOES), []);
});
