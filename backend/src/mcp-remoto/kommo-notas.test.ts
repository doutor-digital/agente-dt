import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarContextoKommo, kommoNotas, textoDaNota, type FonteKommo, type UnidadeKommo } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';
import type { KommoLead, NotaKommo } from '../services/kommo.service.js';

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Marabá, lead 29029780 (26/10): o que a API devolveu de verdade, mais uma nota da SDR e uma ligação.
const NOTAS: NotaKommo[] = [
  { id: 3, note_type: 'common', created_by: 0, created_at: t('2026-10-26T17:40:56Z'), params: { text: '⏸ O paciente continuou escrevendo com a IA pausada e ninguém respondeu. Última mensagem: &quot;Preciso remarcar&quot;' } },
  { id: 2, note_type: 'call_out', created_by: 7, created_at: t('2026-10-25T14:00:00Z'), params: { phone: '+5594999990000', duration: 95 } },
  { id: 1, note_type: 'common', created_by: 7, created_at: t('2026-10-20T12:00:00Z'), params: { text: 'Paciente prefere à tarde' } },
];

function comNotas(leads: KommoLead[], pedidos: Array<{ limite: number; periodo?: { desde?: number; ate?: number } }> = []): FonteKommo {
  return {
    ...fonteFalsa(leads),
    notas: async (_leadId, limite, periodo) => {
      pedidos.push({ limite, ...(periodo ? { periodo } : {}) });
      const dentro = NOTAS.filter((n) => (periodo?.desde === undefined || n.created_at >= periodo.desde) && (periodo?.ate === undefined || n.created_at <= periodo.ate));
      return { notas: dentro.slice(0, limite), truncado: dentro.length > limite };
    },
  };
}

test('textoDaNota: desfaz o HTML escapado do Kommo e descreve nota sem texto', () => {
  assert.equal(textoDaNota(NOTAS[0]!), '⏸ O paciente continuou escrevendo com a IA pausada e ninguém respondeu. Última mensagem: "Preciso remarcar"');
  assert.equal(textoDaNota(NOTAS[1]!), '[+5594999990000, 95 s]');
  assert.equal(textoDaNota({ id: 9, note_type: 'attachment', created_by: 7, created_at: 0, params: { original_name: 'exame.pdf' } }), '[anexo: exame.pdf]');
  assert.equal(textoDaNota({ id: 9, note_type: 'common', created_by: 7, created_at: 0, params: null }), '[sem texto]');
});

test('kommo_notas: mais recentes primeiro, autor pelo nome (0 = robô), tipo legível, hora no fuso da unidade', async () => {
  const ctx = criarContextoKommo(new Map([['doutor-hernia-maraba', unidadeKommo('doutor-hernia-maraba', comNotas([leadFalso(29029780, '2026-10-26T17:36:00Z')]))]]));
  const r = await kommoNotas(ctx, { unidade: 'maraba', leadId: 29029780 });
  assert.equal(r.mostrando, 3);
  assert.deepEqual(r.notas[0], {
    quando: '26/10/2026, 14:40',
    tipo: 'nota',
    autor: 'robô/integração',
    texto: '⏸ O paciente continuou escrevendo com a IA pausada e ninguém respondeu. Última mensagem: "Preciso remarcar"',
  });
  assert.equal(r.notas[1]!.tipo, 'ligação feita');
  assert.equal(r.notas[2]!.autor, 'Júlia SDR');
  assert.equal(r.ficaramDeFora, undefined);
  assert.match(r.aviso, /registrada com o seu usuário/);
});

test('kommo_notas: padrão 30, limite e período viram pedido à fonte; avisa quando ficou nota de fora', async () => {
  const pedidos: Array<{ limite: number; periodo?: { desde?: number; ate?: number } }> = [];
  const ctx = criarContextoKommo(new Map([['doutor-hernia-maraba', unidadeKommo('doutor-hernia-maraba', comNotas([leadFalso(29029780, '2026-10-26T17:36:00Z')], pedidos))]]));
  await kommoNotas(ctx, { unidade: 'maraba', leadId: 29029780 });
  const um = await kommoNotas(ctx, { unidade: 'maraba', leadId: 29029780, limite: 1 });
  assert.equal(um.mostrando, 1);
  assert.match(String(um.ficaramDeFora), /notas mais antigas/);
  const p = await kommoNotas(ctx, { unidade: 'maraba', leadId: 29029780, inicio: '2026-10-25', fim: '2026-10-25' });
  assert.equal(p.mostrando, 1);
  assert.deepEqual(p.periodo, { inicio: '2026-10-25', fim: '2026-10-25' });
  assert.equal(pedidos[0]!.limite, 30);
  assert.equal(pedidos[2]!.limite, 500);
  // 25/10 inteiro em São Paulo: 03:00 UTC do dia 25 até 02:59:59 UTC do dia 26
  assert.deepEqual(pedidos[2]!.periodo, { desde: t('2026-10-25T03:00:00Z'), ate: t('2026-10-26T02:59:59Z') });
});

test('kommo_notas: data inválida e fim antes do início são recusados', async () => {
  const ctx = criarContextoKommo(new Map([['doutor-hernia-maraba', unidadeKommo('doutor-hernia-maraba', comNotas([leadFalso(1, '2026-10-26T12:00:00Z')]))]]));
  await assert.rejects(kommoNotas(ctx, { unidade: 'maraba', leadId: 1, inicio: '26/10/2026' }));
  await assert.rejects(kommoNotas(ctx, { unidade: 'maraba', leadId: 1, inicio: '2026-10-26', fim: '2026-10-25' }), /fim antes do início/);
});

test('kommo_notas: conta sem leitura de notas diz isso, não quebra', async () => {
  const ctx = criarContextoKommo(new Map([['doutor-hernia-maraba', unidadeKommo('doutor-hernia-maraba', fonteFalsa([leadFalso(1, '2026-10-26T12:00:00Z')]))]]));
  await assert.rejects(kommoNotas(ctx, { unidade: 'maraba', leadId: 1 }), /não tem a leitura de notas ligada/);
});

test('kommo_notas em conta dividida: cartão da outra unidade é recusado e as notas nem são baixadas', async () => {
  const MEMBROS = [
    { slug: 'doutor-hernia-caxias', rotulo: 'Caxias' },
    { slug: 'doutor-hernia-petropolis', rotulo: 'Petrópolis' },
  ];
  const lead = leadFalso(2, '2026-10-10T12:00:00Z', { custom_fields_values: [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: 'Caxias' }] }] });
  const pedidos: Array<{ limite: number }> = [];
  const fonte = comNotas([lead], pedidos);
  const petro: UnidadeKommo = { ...unidadeKommo('doutor-hernia-petropolis', fonte), divisao: { rotulo: 'Petrópolis', membros: MEMBROS } };
  const caxias: UnidadeKommo = { ...unidadeKommo('doutor-hernia-caxias', fonte), conta: 'doutor-hernia-petropolis', divisao: { rotulo: 'Caxias', membros: MEMBROS } };
  const ctx = criarContextoKommo(new Map([[petro.slug, petro], [caxias.slug, caxias]]));
  await assert.rejects(kommoNotas(ctx, { unidade: 'petropolis', leadId: 2 }), /é de Caxias.*unidade="doutor-hernia-caxias"/);
  assert.equal(pedidos.length, 0);
  const ok = await kommoNotas(ctx, { unidade: 'caxias', leadId: 2 });
  assert.equal(ok.unidadeDeAtendimento, 'Caxias');
  assert.equal(pedidos.length, 1);
});
