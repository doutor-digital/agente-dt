import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { deduzirRegiaoDaQueixa, espelharEtiquetaRegiao, NOME_CAMPO_REGIAO } from './regiao-dor.service.js';
import type { KommoClient } from './kommo.service.js';

const ENUMS = [
  { id: 540872, value: 'Cervical' },
  { id: 540874, value: 'Lombar' },
  { id: 540876, value: 'Torácica' },
  { id: 540878, value: 'Outra' },
  { id: 540880, value: 'Não informada' },
];

type Chamada = { metodo: string; args: unknown[] };

/** Kommo falso: só o que o serviço toca. `tipo` é o tipo do campo "⚕ Região da dor" na conta. */
function kommoFalso(tipo: 'select' | 'multiselect', valorNoCartao: string | null = null) {
  const chamadas: Chamada[] = [];
  const kommo = {
    listLeadCustomFields: async () => ({ _embedded: { custom_fields: [{ id: 616648, name: NOME_CAMPO_REGIAO }] } }),
    listPipelines: async () => [],
    listLeadCustomFieldsTyped: async () => [{ id: 616648, name: NOME_CAMPO_REGIAO, type: tipo, code: null, enums: ENUMS }],
    getLead: async () => ({
      id: 1,
      custom_fields_values: valorNoCartao ? [{ field_id: 616648, values: [{ value: valorNoCartao }] }] : [],
    }),
    setLeadCustomFieldValue: async (...args: unknown[]) => void chamadas.push({ metodo: 'set', args }),
    addTag: async (...args: unknown[]) => void chamadas.push({ metodo: 'addTag', args }),
    removeTag: async (...args: unknown[]) => void chamadas.push({ metodo: 'removeTag', args }),
  };
  return { kommo: kommo as unknown as KommoClient, chamadas };
}

// o esquema da unidade é guardado por id: um id por teste
const unidade = (id: string) => ({ id, slug: id }) as unknown as Unit;

test('dedução da queixa em campo MULTISELECT (Timbó): grava como lista, com o enum da opção', async () => {
  const { kommo, chamadas } = kommoFalso('multiselect');
  const r = await deduzirRegiaoDaQueixa(unidade('u-multi'), kommo, 1, 'dor lombar há 3 meses', 0);
  assert.equal(r, 'Lombar');
  const set = chamadas.find((c) => c.metodo === 'set');
  assert.deepEqual(set?.args, [1, 616648, 'multiselect', ['Lombar'], ENUMS]);
  assert.deepEqual(chamadas.find((c) => c.metodo === 'addTag')?.args, [{ leadId: 1, tag: 'lombar' }]);
});

test('dedução da queixa em campo SELECT (Serra/Imperatriz): continua igual — select, texto, sem enums', async () => {
  const { kommo, chamadas } = kommoFalso('select');
  const r = await deduzirRegiaoDaQueixa(unidade('u-select'), kommo, 1, 'dor no pescoço', 0);
  assert.equal(r, 'Cervical');
  assert.deepEqual(chamadas.find((c) => c.metodo === 'set')?.args, [1, 616648, 'select', 'Cervical']);
});

test('dedução não sobrescreve região que a Sofia já gravou (select ou multiselect)', async () => {
  for (const tipo of ['select', 'multiselect'] as const) {
    const { kommo, chamadas } = kommoFalso(tipo, 'Cervical');
    assert.equal(await deduzirRegiaoDaQueixa(unidade(`u-ja-${tipo}`), kommo, 1, 'dor lombar', 0), null);
    assert.equal(chamadas.length, 0);
  }
});

test('etiqueta: a captura do multiselect entrega LISTA e a etiqueta entra (antes tirava as duas)', async () => {
  const { kommo, chamadas } = kommoFalso('multiselect');
  await espelharEtiquetaRegiao(kommo, 1, ['Lombar']);
  assert.deepEqual(chamadas, [
    { metodo: 'addTag', args: [{ leadId: 1, tag: 'lombar' }] },
    { metodo: 'removeTag', args: [1, 'cervical'] },
  ]);
});

test('etiqueta: o caminho do select (texto) segue igual', async () => {
  const { kommo, chamadas } = kommoFalso('select');
  await espelharEtiquetaRegiao(kommo, 1, 'Cervical');
  assert.deepEqual(chamadas, [
    { metodo: 'addTag', args: [{ leadId: 1, tag: 'cervical' }] },
    { metodo: 'removeTag', args: [1, 'lombar'] },
  ]);
});
