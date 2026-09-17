import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LeadFieldRule } from '@prisma/client';
import { capturaUnificada, coergirValor, descricaoRegistrarCampo, linhaDoCampo } from './captura-unificada.js';

function regra(p: Partial<LeadFieldRule>): LeadFieldRule {
  return {
    id: 'r1', unitId: 'u1', kommoFieldId: 1, kommoFieldName: 'Campo', kommoFieldType: 'text', kommoFieldEnums: null,
    toolName: 'registra_campo', instruction: 'Quando o paciente disser.', valueHint: null, examples: [], enabled: true,
    updatesLeadTitle: false, createdAt: new Date(), updatedAt: new Date(), ...p,
  } as LeadFieldRule;
}
const QUALIF = regra({ kommoFieldName: '★ Qualificação (Quente/Morno/Frio)', kommoFieldType: 'select', toolName: 'registra_qualificacao', instruction: 'Assim que der pra classificar o interesse do paciente.', kommoFieldEnums: [{ id: 1, value: 'Quente' }, { id: 2, value: 'Morno' }, { id: 3, value: 'Frio' }] });

describe('capturaUnificada (env por unidade)', () => {
  it('liga por slug ou com *, e desliga sem env', () => {
    delete process.env.CAPTURA_UNIFICADA_SLUGS;
    assert.equal(capturaUnificada('doutor-hernia-imperatriz'), false);
    process.env.CAPTURA_UNIFICADA_SLUGS = ' doutor-hernia-imperatriz , doutor-hernia-serra';
    assert.equal(capturaUnificada('doutor-hernia-imperatriz'), true);
    assert.equal(capturaUnificada('doutor-hernia-balsas'), false);
    process.env.CAPTURA_UNIFICADA_SLUGS = '*';
    assert.equal(capturaUnificada('qualquer'), true);
    delete process.env.CAPTURA_UNIFICADA_SLUGS;
  });
});

describe('coergirValor', () => {
  it('select: casa sem acento/caixa e por prefixo; recusa o que não existe listando as opções', () => {
    assert.deepEqual(coergirValor(QUALIF, 'quente'), { ok: true, valor: 'Quente' });
    assert.deepEqual(coergirValor(QUALIF, 'MORNO'), { ok: true, valor: 'Morno' });
    const r = coergirValor(QUALIF, 'gelado');
    assert.equal(r.ok, false);
    assert.match((r as { erro: string }).erro, /Quente \| Morno \| Frio/);
  });
  it('número aceita "R$ 1.500,50"; data aceita DD/MM/AAAA e ISO', () => {
    assert.deepEqual(coergirValor(regra({ kommoFieldType: 'monetary' }), 'R$ 1.500,50'), { ok: true, valor: 1500.5 });
    assert.deepEqual(coergirValor(regra({ kommoFieldType: 'numeric' }), '54 anos'.replace(/\D/g, '')), { ok: true, valor: 54 });
    assert.deepEqual(coergirValor(regra({ kommoFieldType: 'date' }), '18/09/2026'), { ok: true, valor: '2026-09-18' });
    assert.deepEqual(coergirValor(regra({ kommoFieldType: 'date_time' }), '18/09/2026 14:00'), { ok: true, valor: '2026-09-18T14:00:00' });
    assert.deepEqual(coergirValor(regra({ kommoFieldType: 'date' }), '2026-09-18'), { ok: true, valor: '2026-09-18' });
    assert.equal(coergirValor(regra({ kommoFieldType: 'date' }), 'quinta').ok, false);
  });
  it('multiselect separa por ; e valida cada opção', () => {
    const ms = regra({ kommoFieldType: 'multiselect', kommoFieldEnums: [{ id: 1, value: 'Lombar' }, { id: 2, value: 'Cervical' }] });
    assert.deepEqual(coergirValor(ms, 'lombar; cervical'), { ok: true, valor: ['Lombar', 'Cervical'] });
    assert.equal(coergirValor(ms, 'lombar; joelho').ok, false);
  });
  it('texto vazio é erro; texto comum passa cortado em 2000', () => {
    assert.equal(coergirValor(regra({}), '   ').ok, false);
    assert.deepEqual(coergirValor(regra({}), 'dor há 3 meses'), { ok: true, valor: 'dor há 3 meses' });
  });
});

describe('descrição da ferramenta única', () => {
  it('uma linha por campo, com opções nos selects, e bem menor que 30 schemas', () => {
    const l = linhaDoCampo(QUALIF);
    assert.match(l, /^• registra_qualificacao: /);
    assert.match(l, /Opções: Quente \| Morno \| Frio\./);
    const d = descricaoRegistrarCampo([QUALIF, regra({ toolName: 'registra_queixa', instruction: 'x'.repeat(400) })]);
    assert.match(d, /Campos:\n• registra_qualificacao/);
    assert.ok(d.length < 900, `descrição com ${d.length} chars`);
    assert.match(d, /…/, 'instrução longa é encurtada');
  });
});
