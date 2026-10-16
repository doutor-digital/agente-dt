import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmarAlteracao, dataLocal, Pendentes, prepararAlteracao, valorDoCampo, type FonteEscrita } from './kommo-escrita.js';
import { criarContextoKommo } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';
import type { CampoDoCartaoDaConta, KommoLead } from '../services/kommo.service.js';

const COMERCIAL = { id: 100, name: 'COMERCIAL', statuses: [{ id: 1, name: 'EM QUALIFICAÇÃO' }, { id: 2, name: 'AGENDADO' }, { id: 3, name: 'NÃO COMPARECEU' }] };
const TRATAMENTO = { id: 200, name: 'TRATAMENTO', statuses: [{ id: 9, name: 'EM TRATAMENTO' }] };
const CAMPOS: CampoDoCartaoDaConta[] = [
  { id: 11, name: '★ Qualificação', type: 'select', enums: [{ id: 111, value: 'Quente' }, { id: 112, value: 'Morno' }] },
  { id: 12, name: 'Pausar IA', type: 'checkbox', enums: [] },
  { id: 13, name: 'Retomar em', type: 'date', enums: [] },
  { id: 14, name: 'Motivo da falta', type: 'text', enums: [], required_statuses: [{ pipeline_id: 100, status_id: 3 }] },
];

function montar(leads: KommoLead[]) {
  const gravados: unknown[] = [];
  const notas: Array<[number, string]> = [];
  const tarefas: unknown[] = [];
  let estado = leads.map((l) => ({ ...l }));
  const fonte: FonteEscrita = {
    leads: async (ids) => estado.filter((l) => ids.includes(l.id)),
    funis: async () => [COMERCIAL, TRATAMENTO] as never,
    campos: async () => CAMPOS,
    usuarios: async () => [{ id: 7, name: 'Brenna Kuhnen', email: 'brenna@x' }, { id: 8, name: 'Danielly Amador' }],
    etiquetaExiste: async (n) => n === 'Outubro Rosa · Dia 1',
    atualizar: async (lote) => { gravados.push(...lote); return lote.map((x) => x.id); },
    nota: async (id, t) => { notas.push([id, t]); return {}; },
    tarefa: async (t) => { tarefas.push(t); return {}; },
  };
  const ctx = criarContextoKommo(new Map([['doutor-hernia-maraba', unidadeKommo('doutor-hernia-maraba', fonteFalsa([]))]]));
  return { fonte, ctx, gravados, notas, tarefas, mexer: (id: number, status: number) => { estado = estado.map((l) => (l.id === id ? { ...l, status_id: status } : l)); } };
}

const L = (id: number, extra: Partial<KommoLead> = {}) => leadFalso(id, '2026-10-01', { name: `Lead ${id}`, pipeline_id: 100, status_id: 2, responsible_user_id: 8, ...extra });

test('prévia: resolve etapa, campos, responsável e etiquetas pelo nome — e NÃO grava nada', async () => {
  const { fonte, ctx, gravados } = montar([L(1, { _embedded: { tags: [{ id: 1, name: 'Outubro Rosa · Dia 1' }] } }), L(2)]);
  const pend = new Pendentes();
  const r = await prepararAlteracao(ctx, () => fonte, pend, 'u1', {
    unidade: 'maraba', cartoes: [1, 2],
    mudancas: { etapa: 'nao compareceu', responsavel: 'brenna', campos: { 'qualificação': 'quente', 'Pausar IA': 'sim' }, adicionarEtiquetas: ['Outubro Rosa · Dia 1', 'Outubro Rosa · Agendou'], removerEtiquetas: ['Outubro Rosa · Dia 1'] },
  });
  assert.equal(gravados.length, 0);
  assert.equal(r.mudam, 2);
  assert.match(r.confirmacao, /^[0-9A-F]{8}$/);
  const c1 = r.resumo[0] as Record<string, any>;
  assert.deepEqual(c1.etapa, { de: 'COMERCIAL / AGENDADO', para: 'COMERCIAL / NÃO COMPARECEU' });
  assert.match(c1.atencao, /Motivo da falta/);
  assert.deepEqual(c1.responsavel, { para: 'Brenna Kuhnen' });
  assert.deepEqual(c1.etiquetas, { adicionar: ['Outubro Rosa · Agendou'], remover: ['Outubro Rosa · Dia 1'] });
  assert.ok(r.avisos.some((a) => /Agendou.*será criada/.test(a)));
});

test('erros claros: etapa inexistente lista as opções; cartão de outra conta; nada pedido; mais de 50', async () => {
  const { fonte, ctx } = montar([L(1)]);
  const pend = new Pendentes();
  await assert.rejects(() => prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1], mudancas: { etapa: 'FECHADO' } }), /não existe.*AGENDADO/);
  await assert.rejects(() => prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1, 99], mudancas: { nota: 'x' } }), /99/);
  await assert.rejects(() => prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1], mudancas: {} }), /nenhuma mudança/);
  await assert.rejects(() => prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: Array.from({ length: 51 }, (_, i) => i + 1), mudancas: { nota: 'x' } }), /50/);
  await assert.rejects(() => prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1], mudancas: { campos: { 'qualificação': 'Gelado' } } }), /Quente \| Morno/);
});

test('etapa de outro funil: muda o funil junto', async () => {
  const { fonte, ctx } = montar([L(1)]);
  const r = await prepararAlteracao(ctx, () => fonte, new Pendentes(), 'u1', { unidade: 'maraba', cartoes: [1], mudancas: { etapa: 'EM TRATAMENTO' } });
  assert.deepEqual((r.resumo[0] as any).etapa, { de: 'COMERCIAL / AGENDADO', para: 'TRATAMENTO / EM TRATAMENTO' });
});

test('confirmação: grava, cria nota e tarefa, registra antes/depois; código vale uma vez e só para quem preparou', async () => {
  const { fonte, ctx, gravados, notas, tarefas } = montar([L(1), L(2)]);
  const pend = new Pendentes();
  const p = await prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1, 2], mudancas: { etapa: 'NÃO COMPARECEU', nota: 'Faltou dia 16', tarefa: { texto: 'Ligar', prazo: '17/10/2026 10:00' } } });
  await assert.rejects(() => confirmarAlteracao(() => fonte, pend, 'outro', { confirmacao: p.confirmacao }, () => {}), /outro usuário/);
  const p2 = await prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1, 2], mudancas: { etapa: 'NÃO COMPARECEU', nota: 'Faltou dia 16', tarefa: { texto: 'Ligar', prazo: '17/10/2026 10:00' } } });
  const reg: unknown[] = [];
  const r = await confirmarAlteracao(() => fonte, pend, 'u1', { confirmacao: p2.confirmacao.toLowerCase() }, (x) => reg.push(x));
  assert.equal(r.alterados, 2);
  assert.deepEqual(gravados, [{ id: 1, status_id: 3 }, { id: 2, status_id: 3 }]);
  assert.equal(notas.length, 2);
  assert.equal((tarefas[0] as { completeAt: number }).completeAt, dataLocal('2026-10-17 10:00'));
  assert.ok(reg.some((x: any) => x.cartao === 1 && x.antes.etapa === 2 && x.depois.status_id === 3));
  await assert.rejects(() => confirmarAlteracao(() => fonte, pend, 'u1', { confirmacao: p2.confirmacao }, () => {}), /já usado/);
});

test('cartão mexido depois da prévia fica de fora; código vencido não grava', async () => {
  const { fonte, ctx, gravados, mexer } = montar([L(1), L(2)]);
  const pend = new Pendentes();
  const p = await prepararAlteracao(ctx, () => fonte, pend, 'u1', { unidade: 'maraba', cartoes: [1, 2], mudancas: { etapa: 'NÃO COMPARECEU' } });
  mexer(2, 1);
  const r = await confirmarAlteracao(() => fonte, pend, 'u1', { confirmacao: p.confirmacao }, () => {});
  assert.deepEqual(gravados.map((x: any) => x.id), [1]);
  assert.match(r.comErro[0]!.erro!, /mudou/);
  let agora = 0;
  const vencida = new Pendentes(() => agora);
  const p2 = await prepararAlteracao(ctx, () => fonte, vencida, 'u1', { unidade: 'maraba', cartoes: [1], mudancas: { nota: 'x' } });
  agora = 16 * 60_000;
  await assert.rejects(() => confirmarAlteracao(() => fonte, vencida, 'u1', { confirmacao: p2.confirmacao }, () => {}), /venceu/);
});

test('valores e datas no formato do Kommo', () => {
  assert.deepEqual(valorDoCampo(CAMPOS[0]!, 'morno'), [{ enum_id: 112 }]);
  assert.deepEqual(valorDoCampo(CAMPOS[1]!, 'não'), [{ value: false }]);
  assert.deepEqual(valorDoCampo(CAMPOS[3]!, ''), null);
  assert.equal(dataLocal('16/10/2026 09:00'), Date.parse('2026-10-16T09:00:00-03:00') / 1000);
  assert.equal(dataLocal('2026-10-16'), Date.parse('2026-10-16T12:00:00-03:00') / 1000);
  assert.throws(() => dataLocal('amanhã'), /AAAA-MM-DD/);
});
