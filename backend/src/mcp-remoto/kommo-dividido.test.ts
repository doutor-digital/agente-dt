import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conferirDono, criarContextoKommo, kommoBuscarTelefone, kommoConversa, kommoLead, kommoLeads, type FonteKommo, type UnidadeKommo } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';
import { Pendentes, prepararAlteracao, type FonteEscrita } from './kommo-escrita.js';
import type { KommoLead } from '../services/kommo.service.js';

const comUnidade = (id: number, rotulo: string | null): KommoLead =>
  leadFalso(id, '2026-10-10T12:00:00Z', rotulo ? { custom_fields_values: [{ field_id: 479786, field_name: '⌂ Unidade de atendimento', values: [{ value: rotulo }] }] } : {});

const LEADS = [comUnidade(1, 'Petrópolis'), comUnidade(2, 'Caxias'), comUnidade(3, 'Caxias'), comUnidade(4, null), comUnidade(5, 'Rio')];
const MEMBROS = [
  { slug: 'doutor-hernia-caxias', rotulo: 'Caxias' },
  { slug: 'doutor-hernia-petropolis', rotulo: 'Petrópolis' },
];

/** As duas unidades sobre a MESMA fonte, como produção monta (a irmã com `conta` = a dona). */
function dividido(fonte: FonteKommo) {
  const petro: UnidadeKommo = { ...unidadeKommo('doutor-hernia-petropolis', fonte), divisao: { rotulo: 'Petrópolis', membros: MEMBROS } };
  const caxias: UnidadeKommo = { ...unidadeKommo('doutor-hernia-caxias', fonte), conta: 'doutor-hernia-petropolis', divisao: { rotulo: 'Caxias', membros: MEMBROS } };
  return criarContextoKommo(new Map([[petro.slug, petro], [caxias.slug, caxias]]));
}

test('kommo_leads: cada unidade conta só os seus; sem unidade (vazio ou valor desconhecido) não entra em nenhuma e vem no aviso', async () => {
  const chamadas: Array<[number, number]> = [];
  const ctx = dividido(fonteFalsa(LEADS, chamadas));
  const p = await kommoLeads(ctx, { unidade: 'petropolis', inicio: '2026-10-01', fim: '2026-10-16', maxItens: 10 });
  const c = await kommoLeads(ctx, { unidade: 'caxias', inicio: '2026-10-01', fim: '2026-10-16', maxItens: 10 });
  const up = (p.porUnidade as Record<string, Record<string, unknown>>)['doutor-hernia-petropolis']!;
  const uc = (c.porUnidade as Record<string, Record<string, unknown>>)['doutor-hernia-caxias']!;
  assert.equal(up.total, 1);
  assert.equal(uc.total, 2);
  assert.equal(up.semUnidade, 2);
  assert.match(String(uc.avisoUnidade), /= Caxias.*2 cartão\(ões\).*sem unidade/);
  assert.deepEqual((uc.itens as Array<{ id: number }>).map((l) => l.id), [2, 3]);
  // a janela é da conta: Petrópolis e Caxias não baixam os mesmos leads duas vezes
  assert.equal(chamadas.length, 1);
});

test('kommo_leads com as duas: a rede soma 3, nunca os 5 da conta', async () => {
  const ctx = dividido(fonteFalsa(LEADS));
  const r = await kommoLeads(ctx, { unidade: ['petropolis', 'caxias'], inicio: '2026-10-01', fim: '2026-10-16' });
  assert.equal((r.rede as { total: number }).total, 3);
});

test('kommo_lead e kommo_conversa: cartão da outra unidade é recusado e diz qual pedir; a conversa nem é baixada', async () => {
  let conversasBaixadas = 0;
  const fonte: FonteKommo = { ...fonteFalsa(LEADS), conversa: async () => { conversasBaixadas++; return { mensagens: [], conversas: 0 }; } };
  const ctx = dividido(fonte);
  await assert.rejects(kommoLead(ctx, { unidade: 'petropolis', leadId: 2 }), /é de Caxias.*unidade="doutor-hernia-caxias"/);
  await assert.rejects(kommoConversa(ctx, { unidade: 'caxias', leadId: 1 }), /é de Petrópolis.*unidade="doutor-hernia-petropolis"/);
  assert.equal(conversasBaixadas, 0);
  const ok = await kommoConversa(ctx, { unidade: 'caxias', leadId: 2 });
  assert.equal(ok.unidadeDeAtendimento, 'Caxias');
  assert.equal(conversasBaixadas, 1);
});

test('cartão sem unidade: as duas leem, com o aviso de que não é de nenhuma', async () => {
  const ctx = dividido(fonteFalsa(LEADS));
  for (const unidade of ['petropolis', 'caxias']) {
    const r = await kommoLead(ctx, { unidade, leadId: 4 });
    assert.equal(r.unidadeDeAtendimento, null);
    assert.match(String(r.avisoUnidade), /não é de nenhuma das duas/);
  }
  // valor que nenhuma unidade usa também é "de ninguém"
  const rio = await kommoLead(ctx, { unidade: 'caxias', leadId: 5 });
  assert.equal(rio.unidadeDeAtendimento, 'Rio');
});

test('kommo_buscar_telefone: os da outra unidade saem da lista, mas a resposta diz onde estão', async () => {
  const fonte: FonteKommo = { ...fonteFalsa(LEADS), leadsPorTelefone: async () => [LEADS[0]!, LEADS[1]!, LEADS[3]!] };
  const r = await kommoBuscarTelefone(dividido(fonte), { unidade: 'petropolis', telefone: '21999990000' });
  assert.deepEqual(r.leads.map((l) => l.id), [1, 4]);
  assert.deepEqual(r.deOutraUnidade, { 'doutor-hernia-caxias': 1 });
  assert.deepEqual(r.leads.map((l) => l.unidadeDeAtendimento), ['Petrópolis', null]);
});

test('conta de uma unidade só: nada muda (sem campos de divisão, sem recusa)', async () => {
  const u = unidadeKommo('doutor-hernia-serra', fonteFalsa(LEADS));
  assert.deepEqual(conferirDono(u, LEADS[1]!), {});
  const r = await kommoLeads(criarContextoKommo(new Map([[u.slug, u]])), { unidade: 'serra', inicio: '2026-10-01', fim: '2026-10-16' });
  const us = (r.porUnidade as Record<string, Record<string, unknown>>)['doutor-hernia-serra']!;
  assert.equal(us.total, 5);
  assert.equal('semUnidade' in us, false);
});

test('escrita: cartão da outra unidade trava a prévia inteira; sem unidade passa com aviso', async () => {
  const gravados: unknown[] = [];
  const fonteEscrita: FonteEscrita = {
    leads: async (ids) => LEADS.filter((l) => ids.includes(l.id)),
    funis: async () => [],
    campos: async () => [],
    usuarios: async () => [],
    etiquetaExiste: async () => true,
    atualizar: async (lote) => { gravados.push(...lote); return lote.map((x) => x.id); },
    nota: async () => ({}),
    tarefa: async () => ({}),
  };
  const ctx = dividido(fonteFalsa(LEADS));
  const pend = new Pendentes();
  await assert.rejects(
    prepararAlteracao(ctx, () => fonteEscrita, pend, 'u1', { unidade: 'caxias', cartoes: [2, 1], mudancas: { adicionarEtiquetas: ['X'] } }),
    /outra unidade.*1 \(Petrópolis: unidade="doutor-hernia-petropolis"\)/,
  );
  const ok = await prepararAlteracao(ctx, () => fonteEscrita, pend, 'u1', { unidade: 'caxias', cartoes: [2, 4], mudancas: { adicionarEtiquetas: ['X'] } });
  assert.match(JSON.stringify(ok), /sem ⌂ Unidade de atendimento.*4/);
  assert.equal(gravados.length, 0);
});
