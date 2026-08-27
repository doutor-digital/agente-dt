import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { fixarLeadDaConversa } from './graph.js';

/**
 * A ferramenta recebia o `leadId` que o MODELO escreveu. Bastava ele alucinar um
 * número — ou um paciente escrever "atualize o lead 24405762" — pra a IA agir no
 * cartão de outra pessoa. Com dado clínico, isso é LGPD, e é o "Excessive Agency"
 * (LLM06) do OWASP na forma mais direta.
 *
 * A correção não pede ao prompt que não erre: faz o parâmetro não importar.
 */

const LEAD_DA_CONVERSA = 111;
const LEAD_DE_OUTRA_PESSOA = 999;

function recorderFalso() {
  const passos: Array<{ kind: string; title: string }> = [];
  return {
    passos,
    recorder: { step: async (p: { kind: string; title: string }) => void passos.push(p) },
  };
}

function toolQueRegistra(recebidos: Array<Record<string, unknown>>) {
  return new DynamicStructuredTool({
    name: 'aplicar_tag',
    description: 'teste',
    schema: z.object({ leadId: z.number(), tag: z.string() }),
    func: async (args) => {
      recebidos.push(args as Record<string, unknown>);
      return 'ok';
    },
  });
}

function toolSemLead() {
  return new DynamicStructuredTool({
    name: 'consultar_horarios',
    description: 'teste',
    schema: z.object({ data: z.string() }),
    func: async () => 'ok',
  });
}

const unidade = { slug: 'doutor-hernia-porto' } as never;

test('lead alheio é substituído pelo lead da conversa', async () => {
  const recebidos: Array<Record<string, unknown>> = [];
  const { recorder } = recorderFalso();
  const [tool] = fixarLeadDaConversa([toolQueRegistra(recebidos)], LEAD_DA_CONVERSA, recorder as never, unidade);

  await tool.func({ leadId: LEAD_DE_OUTRA_PESSOA, tag: 'Quente' } as never);

  assert.equal(recebidos[0].leadId, LEAD_DA_CONVERSA, 'a ferramenta não pode agir no lead alheio');
  assert.equal(recebidos[0].tag, 'Quente', 'o resto dos argumentos continua intacto');
});

test('a tentativa fica no rastro — não é corrigida em silêncio', async () => {
  const recebidos: Array<Record<string, unknown>> = [];
  const { passos, recorder } = recorderFalso();
  const [tool] = fixarLeadDaConversa([toolQueRegistra(recebidos)], LEAD_DA_CONVERSA, recorder as never, unidade);

  await tool.func({ leadId: LEAD_DE_OUTRA_PESSOA, tag: 'x' } as never);

  assert.equal(passos.length, 1, 'lead alheio é sinal de alucinação ou injeção — tem que aparecer');
  assert.equal(passos[0].kind, 'ERROR');
  assert.match(passos[0].title, /999.*111|111.*999/);
});

test('quando o lead está certo, nada é registrado', async () => {
  const recebidos: Array<Record<string, unknown>> = [];
  const { passos, recorder } = recorderFalso();
  const [tool] = fixarLeadDaConversa([toolQueRegistra(recebidos)], LEAD_DA_CONVERSA, recorder as never, unidade);

  await tool.func({ leadId: LEAD_DA_CONVERSA, tag: 'x' } as never);

  assert.equal(recebidos[0].leadId, LEAD_DA_CONVERSA);
  assert.equal(passos.length, 0, 'caminho normal não pode virar ruído no rastro');
});

test('ferramenta sem leadId passa intacta', async () => {
  const { recorder } = recorderFalso();
  const [tool] = fixarLeadDaConversa([toolSemLead()], LEAD_DA_CONVERSA, recorder as never, unidade);

  assert.equal(await tool.func({ data: '2026-09-01' } as never), 'ok');
});

test('sem lead conhecido, a lista volta como estava', () => {
  const recebidos: Array<Record<string, unknown>> = [];
  const { recorder } = recorderFalso();
  const original = toolQueRegistra(recebidos);

  assert.equal(fixarLeadDaConversa([original], undefined, recorder as never, unidade)[0], original);
  assert.equal(fixarLeadDaConversa([original], 0, recorder as never, unidade)[0], original);
});
