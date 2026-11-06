import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pularSeARotinaJaCuidou, soDestaUnidade } from './etiquetas-auto-worker.js';
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

test('Reativação e Rotina «ex-lead»: o etiquetas-auto só PULA o que a rotina JÁ cuidou (marca da pessoa); o resto segue saindo daqui', async () => {
  const unit = { id: 'u', slug: 'u' } as never;
  const lead = { id: 5, _embedded: { contacts: [{ id: 77, is_main: true }] } } as unknown as KommoLead;
  const coloca = { tipo: 'coloca', etiqueta: '▶ Reativação', chave: 'reativacao:5:1', motivo: '30 dias' } as const;
  let perguntou = '';
  const jaTocou = async (_u: string, pessoa: string) => {
    perguntou = pessoa;
    return true;
  };
  const pulado = await pularSeARotinaJaCuidou(unit, lead, coloca, jaTocou);
  assert.equal(pulado.tipo, 'pula');
  assert.match(pulado.motivo, /Rotina diária/);
  assert.equal(perguntou, 'c77', 'a pergunta é por PESSOA (contato), não por cartão');
  // a rotina ainda não alcançou (lista cortada, Pausar IA, nunca escreveu...): continua saindo daqui — nenhum buraco
  assert.deepEqual(await pularSeARotinaJaCuidou(unit, lead, coloca, async () => false), coloca);
  // não consegui ler as marcas: na dúvida não manda (a janela de 2 dias tenta de novo)
  assert.equal((await pularSeARotinaJaCuidou(unit, lead, coloca, async () => { throw new Error('banco fora'); })).tipo, 'pula');
  const pula = { ...coloca, tipo: 'pula' } as const;
  assert.equal(await pularSeARotinaJaCuidou(unit, lead, pula, async () => { throw new Error('não deve chamar'); }), pula);
});
