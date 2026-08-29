import { test } from 'node:test';
import assert from 'node:assert/strict';

import { montarContexto, avaliarLead, NOMES_CAMPO } from './card-validation-worker.js';

/**
 * As regras novas vêm do fluxograma operacional: são os furos que fazem o
 * relatório das 20h não fechar.
 *
 * A parte difícil não é disparar, é NÃO disparar. Alerta que toca à toa vira
 * alerta que ninguém olha — e aí o que importa passa junto.
 */

const ID = Object.fromEntries(Object.keys(NOMES_CAMPO).map((k, i) => [k, 1000 + i])) as Record<
  keyof typeof NOMES_CAMPO,
  number
>;

const CTX = montarContexto(
  (Object.entries(NOMES_CAMPO) as Array<[keyof typeof NOMES_CAMPO, string]>).map(([k, nome]) => ({
    id: ID[k],
    name: nome,
  })),
  [
    {
      id: 10,
      name: 'COMERCIAL',
      statuses: [
        { id: 21, name: 'AGENDADO' },
        { id: 22, name: 'COMPARECEU' },
      ],
    },
    { id: 11, name: 'TRATAMENTO', statuses: [{ id: 31, name: 'EM TRATAMENTO' }] },
  ],
);

/** Monta um lead com os campos pedidos, no funil e etapa indicados. */
function lead(status: number, campos: Partial<Record<keyof typeof NOMES_CAMPO, string>>) {
  return {
    id: 1,
    pipeline_id: 10,
    status_id: status,
    custom_fields_values: Object.entries(campos).map(([k, v]) => ({
      field_id: ID[k as keyof typeof NOMES_CAMPO],
      values: [{ value: v }],
    })),
  } as never;
}

const achou = (l: never, key: string) => avaliarLead(l, CTX).some((x) => x.key === key);

// ── compareceu sem semáforo ─────────────────────────────────────────────────

test('atendido com tratamento indicado e sem semáforo vira alerta', () => {
  const l = lead(22, { SITUACAO_CONSULTA: 'Atendido', TRAT_INDICADO: '03 Meses — LOMBAR CRÔNICO' });
  assert.equal(achou(l, 'G_compareceu_sem_semaforo'), true);
});

test('com semáforo preenchido não alerta', () => {
  const l = lead(22, {
    SITUACAO_CONSULTA: 'Atendido',
    TRAT_INDICADO: '03 Meses — LOMBAR CRÔNICO',
    SEMAFORO: 'VERDE — fechou e pagou tudo',
  });
  assert.equal(achou(l, 'G_compareceu_sem_semaforo'), false);
});

test('atendido SEM tratamento indicado não alerta — não houve indicação a classificar', () => {
  const l = lead(22, { SITUACAO_CONSULTA: 'Atendido' });
  assert.equal(achou(l, 'G_compareceu_sem_semaforo'), false);
});

test('quem ainda não foi atendido não é cobrado por semáforo', () => {
  // A regra segue a SITUAÇÃO da consulta, não a etapa: medido em produção, a
  // etapa COMPARECEU fica vazia porque o card não para nela.
  const l = lead(21, { SITUACAO_CONSULTA: 'Agendado', TRAT_INDICADO: '03 Meses — LOMBAR CRÔNICO' });
  assert.equal(achou(l, 'G_compareceu_sem_semaforo'), false);
});

// ── fechou sem valor ────────────────────────────────────────────────────────

test('fechou tratamento e não lançou valor vira alerta', () => {
  assert.equal(achou(lead(22, { FECHOU_TRAT: 'Sim' }), 'H_fechou_sem_valor'), true);
});

test('fechou com valor lançado não alerta', () => {
  const l = lead(22, { FECHOU_TRAT: 'Sim', VALOR_TRAT: '3500' });
  assert.equal(achou(l, 'H_fechou_sem_valor'), false);
});

test('quem NÃO fechou não é cobrado por valor', () => {
  assert.equal(achou(lead(22, { FECHOU_TRAT: 'Não' }), 'H_fechou_sem_valor'), false);
});

// ── laranja sem retorno ─────────────────────────────────────────────────────

test('laranja sem data de retorno vira alerta', () => {
  const l = lead(22, { SEMAFORO: 'LARANJA — não fechou: falta exame ou retorno' });
  assert.equal(achou(l, 'I_laranja_sem_retorno'), true);
});

test('laranja COM retorno com exames não alerta', () => {
  const l = lead(22, {
    SEMAFORO: 'LARANJA — não fechou: falta exame ou retorno',
    DATA_RETORNO_EXAMES: '1790000000',
  });
  assert.equal(achou(l, 'I_laranja_sem_retorno'), false);
});

test('outra cor sem retorno não alerta — só laranja depende de exame', () => {
  const l = lead(22, { SEMAFORO: 'AMARELO — não fechou: dinheiro, família, vai pensar' });
  assert.equal(achou(l, 'I_laranja_sem_retorno'), false);
});

// ── conta que não pode quebrar ──────────────────────────────────────────────

test('lead sem campo nenhum não explode e não inventa alerta das regras novas', () => {
  const novas = ['G_compareceu_sem_semaforo', 'H_fechou_sem_valor', 'I_laranja_sem_retorno'];
  const achados = avaliarLead(lead(22, {}), CTX).map((x) => x.key);
  assert.equal(novas.some((k) => achados.includes(k)), false);
});
