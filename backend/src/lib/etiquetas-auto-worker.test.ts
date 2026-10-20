import { test } from 'node:test';
import assert from 'node:assert/strict';

import { soDestaUnidade } from './etiquetas-auto-worker.js';
import { grupoDe, type GrupoDoCrm, type MembroDoCrm } from './crm-compartilhado.js';
import type { KommoLead } from '../services/kommo.service.js';

// Kommo dividido (20/10/2026): a etiqueta dispara o robô do Kommo, que manda o modelo da unidade (endereço, Pix).
const MEMBROS: MembroDoCrm[] = [
  { unitId: 'u-petro', contaUnitId: 'u-petro', rotulo: 'Petrópolis', slug: 'doutor-hernia-petropolis' },
  { unitId: 'u-caxias', contaUnitId: 'u-petro', rotulo: 'Caxias', slug: 'doutor-hernia-caxias' },
];
const GRUPO = grupoDe('u-petro', MEMBROS) as GrupoDoCrm;

const decisao = (id: number, unidade: string | null) => ({
  lead: {
    id,
    name: `cartão ${id}`,
    custom_fields_values: unidade === null ? [] : [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: unidade }] }],
  } as unknown as KommoLead,
  etiqueta: 'BOAS_VINDAS',
});

const QUATRO = [decisao(1, 'Petrópolis'), decisao(2, 'Caxias'), decisao(3, null), decisao(4, 'Rio')];

test('etiquetas no Kommo dividido: Petrópolis só etiqueta o cartão de Petrópolis; Caxias, vazio e estranho ficam de fora', () => {
  const fora: { deOutraUnidade?: number; semUnidade?: number } = {};
  const r = soDestaUnidade(GRUPO, 'u-petro', QUATRO, fora);
  assert.deepEqual(r.map((x) => x.lead.id), [1]);
  assert.equal(fora.deOutraUnidade, 2, 'Caxias e o valor que ninguém usa');
  assert.equal(fora.semUnidade, 1);
});

test('etiquetas no Kommo de uma unidade só: nada muda (o campo nem é lido)', () => {
  const r = soDestaUnidade(null, 'u-imperatriz', QUATRO);
  assert.equal(r, QUATRO, 'a mesma lista');
});
