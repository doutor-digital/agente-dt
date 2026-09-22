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

// ── cartão enxuto: campo que não existe na conta não pode virar cobrança ────
//
// O cartão enxuto (laboratório `doutorherniakommo` e Petrópolis `doutorhernialvp`) não tem 10 dos
// campos do cartão antigo — conferido pela API dos dois em 22/09/2026. Regra que procura o campo
// pelo NOME lia "vazio" e acusava TODO lead que entrasse na etapa. Aqui cada regra afetada é
// testada em par: no cartão antigo continua acusando o mesmo; no enxuto, sem o campo, fica calada.

const AUSENTES_NO_ENXUTO = [
  'AGENDOU',
  'FECHOU_TRAT',
  'COMPARECEU_ULT',
  'PG_ANTECIPADO',
  'DATA_CANCEL',
  'MOTIVO_CANCEL_TRAT',
  'SEMAFORO',
  'TRAT_INDICADO',
  'DATA_RETORNO',
  'DATA_RETORNO_EXAMES',
] as const;

/** Mesmo campo, nome novo: no enxuto o "do tratamento" saiu do fim do nome. */
const NOME_NO_ENXUTO: Partial<Record<keyof typeof NOMES_CAMPO, string>> = {
  MOTIVO_NAO_FECH: '⊘ Motivo de não fechamento',
};

const PIPES = [
  { id: 10, name: 'COMERCIAL', statuses: [{ id: 21, name: 'AGENDADO' }] },
  { id: 11, name: 'TRATAMENTO', statuses: [{ id: 31, name: 'EM TRATAMENTO' }] },
];

const CTX_ENXUTO = montarContexto(
  (Object.keys(NOMES_CAMPO) as Array<keyof typeof NOMES_CAMPO>)
    .filter((k) => !(AUSENTES_NO_ENXUTO as readonly string[]).includes(k))
    .map((k) => ({ id: ID[k], name: NOME_NO_ENXUTO[k] ?? NOMES_CAMPO[k] })),
  PIPES,
);

/** Mesmo lead, mas num funil escolhido (o TRATAMENTO é outro funil, id 11). */
function leadEm(
  pipeline: number,
  status: number,
  campos: Partial<Record<keyof typeof NOMES_CAMPO, string>>,
) {
  return { ...(lead(status, campos) as object), pipeline_id: pipeline } as never;
}

const erroDe = (l: never, key: string, ctx = CTX) =>
  avaliarLead(l, ctx).find((x) => x.key === key)?.erro ?? null;

const GANHO = 142;
const PERDIDO = 143;

// GANHO — usava "✓ Fechou tratamento", que o enxuto não tem
test('GANHO no cartão antigo continua cobrando fechamento, tratamento e forma de pagamento', () => {
  const erro = erroDe(lead(GANHO, {}), 'B_ganho_sem_fechamento');
  assert.ok(erro?.includes('"Fechou tratamento" não está Sim'));
  assert.ok(erro?.includes('"Tratamento fechado" vazio'));
  assert.ok(erro?.includes('"Forma de pagamento" vazia'));
});

test('GANHO no cartão enxuto com o cartão em ordem não vira alerta nenhum', () => {
  const l = lead(GANHO, { TRAT_FECHADO: '03 Meses — LOMBAR', FORMA_PAGAMENTO: 'Pix' });
  assert.deepEqual(avaliarLead(l, CTX_ENXUTO), []);
});

test('GANHO no enxuto ainda cobra o que existe lá, mas nunca "✓ Fechou tratamento"', () => {
  const erro = erroDe(lead(GANHO, {}), 'B_ganho_sem_fechamento', CTX_ENXUTO);
  assert.ok(erro?.includes('"Tratamento fechado" vazio'));
  assert.equal(erro?.includes('Fechou tratamento'), false);
});

// TRATAMENTO CANCELADO — usava "◷ Data do cancelamento" e o motivo, que o enxuto não tem
test('TRATAMENTO CANCELADO no cartão antigo continua cobrando data e motivo', () => {
  const erro = erroDe(leadEm(11, PERDIDO, {}), 'F_cancelado_sem_dados');
  assert.ok(erro?.includes('"Data do cancelamento" vazia'));
  assert.ok(erro?.includes('"Motivo do cancelamento" vazio'));
});

test('TRATAMENTO CANCELADO no cartão enxuto fica calado — os campos não existem lá', () => {
  assert.deepEqual(avaliarLead(leadEm(11, PERDIDO, {}), CTX_ENXUTO), []);
});

// PERDIDO — o motivo de não fechamento mudou de nome, e o nome novo tem que contar
test('PERDIDO sem motivo nenhum continua sendo apontado nos dois cartões', () => {
  assert.ok(erroDe(lead(PERDIDO, {}), 'C_perdido_sem_motivo'));
  assert.ok(erroDe(lead(PERDIDO, {}), 'C_perdido_sem_motivo', CTX_ENXUTO));
});

test('PERDIDO com "⊘ Motivo de não fechamento" (nome do enxuto) conta como preenchido', () => {
  const l = lead(PERDIDO, { MOTIVO_NAO_FECH: 'Achou caro' });
  assert.equal(erroDe(l, 'C_perdido_sem_motivo', CTX_ENXUTO), null);
  assert.equal(erroDe(l, 'C_perdido_sem_motivo'), null);
});

test('conta sem nenhum campo de motivo não é cobrada por motivo de perda', () => {
  const semMotivos = montarContexto([{ id: ID.SITUACAO_CONSULTA, name: NOMES_CAMPO.SITUACAO_CONSULTA }], PIPES);
  assert.equal(erroDe(lead(PERDIDO, {}), 'C_perdido_sem_motivo', semMotivos), null);
});

// AGENDADO — as regras A e A2 valem no enxuto, mas só pelos campos que existem lá
test('AGENDADO no cartão enxuto, com tipo, situação e data de agendamento, não vira alerta', () => {
  const l = lead(21, {
    TIPO_AGENDAMENTO: 'Cadastro',
    SITUACAO_CONSULTA: 'Agendado',
    AGENDADO_SDR_EM: String(Math.floor(Date.now() / 1000) - 3600),
  });
  assert.deepEqual(avaliarLead(l, CTX_ENXUTO), []);
});

test('conta sem "◷ Agendado pela SDR em" não é cobrada por ele', () => {
  const semData = montarContexto(
    [{ id: ID.TIPO_AGENDAMENTO, name: NOMES_CAMPO.TIPO_AGENDAMENTO }],
    PIPES,
  );
  const l = lead(21, { TIPO_AGENDAMENTO: 'Cadastro' });
  assert.deepEqual(avaliarLead(l, semData), []);
});

// Semáforo — sem o campo não há desfecho a classificar
test('conta sem "◉ Semáforo" não é cobrada por semáforo nem por retorno', () => {
  const semSemaforo = montarContexto(
    [
      { id: ID.SITUACAO_CONSULTA, name: NOMES_CAMPO.SITUACAO_CONSULTA },
      { id: ID.TRAT_INDICADO, name: NOMES_CAMPO.TRAT_INDICADO },
    ],
    PIPES,
  );
  const l = lead(22, { SITUACAO_CONSULTA: 'Atendido', TRAT_INDICADO: '03 Meses — LOMBAR' });
  assert.deepEqual(avaliarLead(l, semSemaforo), []);
});
