/**
 * "Esse telefone já está na franquia?" — a checagem de duplicado do cadastro no 1º contato (27/11/2026).
 * O que não pode escapar: a secretária que cadastrou primeiro não ganha um segundo cadastro; a busca que falha NÃO libera a criação.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { DIAS_DE_LEADS_RECENTES, _limparRecentesParaTeste, lerRecentes, verificarJaCadastrado, type DepsJaCadastrado, type Recentes } from './franquia-ja-cadastrado.js';
import type { Entrada, RespostaDoIndice } from './franquia-indice-telefones.js';
import type { SpinePaginaTelefones, SpineResult } from '../services/spine.service.js';

const U = { id: 'u-serra', slug: 'doutor-hernia-serra' };
const FONE = '+5511988887777';

const resposta = (entradas: Entrada[], fresco = true): RespostaDoIndice => ({ entradas, fresco, idadeHoras: fresco ? 3 : null });
const entrada = (origem: 'paciente' | 'lead', id: number | null): Entrada => ({ chave: '88887777', origem, id, criado: null });

function deps(o: { indice?: RespostaDoIndice | Error; recentes?: Recentes | Error } = {}): DepsJaCadastrado & { carga: number; recentesLidos: number } {
  const d = {
    carga: 0,
    recentesLidos: 0,
    async indice() { if (o.indice instanceof Error) throw o.indice; return o.indice ?? resposta([]); },
    agendarIndice() { d.carga++; },
    async recentes() { d.recentesLidos++; if (o.recentes instanceof Error) throw o.recentes; return o.recentes ?? new Map(); },
  };
  return d;
}

test('paciente no índice: achou (e o paciente vale mais que o lead do mesmo telefone)', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ indice: resposta([entrada('lead', 7), entrada('paciente', 9)]) }));
  assert.deepEqual(r, { tipo: 'achou', origem: 'paciente', id: 9, por: 'indice' });
});

test('lead no índice: achou', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ indice: resposta([entrada('lead', 7)]) }));
  assert.deepEqual(r, { tipo: 'achou', origem: 'lead', id: 7, por: 'indice' });
});

test('achar no índice vale mesmo com o índice velho (prova positiva não envelhece) e nem lê os recentes', async () => {
  const d = deps({ indice: resposta([entrada('paciente', 9)], false) });
  const r = await verificarJaCadastrado(U, FONE, d);
  assert.equal(r.tipo, 'achou');
  assert.equal(d.recentesLidos, 0);
});

test('SECRETÁRIA CADASTROU PRIMEIRO: não está no índice (carga de ontem), mas está entre os cadastros recentes — não cria', async () => {
  const recentes: Recentes = new Map([['88887777', { origem: 'lead' as const, id: 4321 }]]);
  const d = deps({ indice: resposta([]), recentes });
  const r = await verificarJaCadastrado(U, FONE, d);
  assert.deepEqual(r, { tipo: 'achou', origem: 'lead', id: 4321, por: 'recentes' });
});

test('SECRETÁRIA CADASTROU o paciente depois da carga: também não cria', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ recentes: new Map([['88887777', { origem: 'paciente' as const, id: 55 }]]) }));
  assert.deepEqual(r, { tipo: 'achou', origem: 'paciente', id: 55, por: 'recentes' });
});

test('o telefone casa com e sem 55, com e sem o nono dígito', async () => {
  for (const fone of ['+5511988887777', '5511988887777', '11988887777', '1188887777', '+55 11 8888-7777', '(11) 98888-7777']) {
    const r = await verificarJaCadastrado(U, fone, deps({ indice: resposta([entrada('lead', 7)]) }));
    assert.equal(r.tipo, 'achou', fone);
  }
});

test('em nenhum lugar, com o índice inteiro e os recentes lidos: aí sim pode criar', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ indice: resposta([]), recentes: new Map() }));
  assert.deepEqual(r, { tipo: 'nao' });
});

test('A BUSCA FALHOU (franquia fora / timeout): indeterminado — NÃO cria', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ recentes: new Error('timeout of 30000ms exceeded') }));
  assert.equal(r.tipo, 'indeterminado');
  assert.match((r as { motivo: string }).motivo, /timeout/);
});

test('o índice (banco) falhou: indeterminado — NÃO cria', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ indice: new Error('db fora') }));
  assert.equal(r.tipo, 'indeterminado');
});

test('índice velho ou nunca carregado e o telefone não está nele: não afirma "não existe" — pede a carga e não cria', async () => {
  const d = deps({ indice: resposta([], false) });
  const r = await verificarJaCadastrado(U, FONE, d);
  assert.equal(r.tipo, 'indeterminado');
  assert.equal(d.carga, 1, 'a carga do índice foi pedida');
  assert.equal(d.recentesLidos, 0);
});

test('telefone sem 8 dígitos: não dá para conferir — não cria', async () => {
  assert.equal((await verificarJaCadastrado(U, '123', deps())).tipo, 'indeterminado');
  assert.equal((await verificarJaCadastrado(U, null, deps())).tipo, 'indeterminado');
});

test('telefone achado no índice mas sem id utilizável: não cria (existe, só não dá para ligar)', async () => {
  const r = await verificarJaCadastrado(U, FONE, deps({ indice: resposta([entrada('paciente', null)]) }));
  assert.equal(r.tipo, 'indeterminado');
});

// ── a leitura dos recentes, com a franquia falsa ─────────────────────────────────────────────

type Chamada = { tipo: string; page: number; initialDate?: string };
function franquiaFalsa(o: { leads?: SpinePaginaTelefones[]; pacientes?: SpinePaginaTelefones[]; falhaEm?: 'lead' | 'paciente' }) {
  const chamadas: Chamada[] = [];
  const buscar = async (_u: Unit, e: { tipo: 'paciente' } | { tipo: 'lead'; initialDate: string; endDate: string }, page: number): Promise<SpineResult<SpinePaginaTelefones>> => {
    chamadas.push({ tipo: e.tipo, page, initialDate: e.tipo === 'lead' ? e.initialDate : undefined });
    if (o.falhaEm === e.tipo) return { ok: false, error: '500: fora do ar' };
    const paginas = (e.tipo === 'lead' ? o.leads : o.pacientes) ?? [];
    return { ok: true, data: paginas[page - 1] ?? { itens: [], totalPages: paginas.length || 1, total: 0 } };
  };
  return { chamadas, buscar };
}
const pag = (itens: Array<[number | null, string | null]>, totalPages: number): SpinePaginaTelefones => ({ itens: itens.map(([id, whatsapp]) => ({ id, whatsapp, created: null })), totalPages, total: null });

test('recentes: lê a janela curta de leads e as DUAS últimas páginas de pacientes — poucas chamadas', async () => {
  const f = franquiaFalsa({ leads: [pag([[11, '+5511977776666']], 1)], pacientes: [pag([[1, '+5511900000001']], 40), pag([], 40), pag([[39, '+5511911112222']], 40)] });
  const agora = Date.parse('2026-11-27T15:00:00Z');
  const r = await lerRecentes(U as Unit, agora, f.buscar);
  assert.equal(r.get('77776666')?.id, 11);
  assert.equal(r.size, 1, 'só leads recentes + as 2 últimas páginas de pacientes (a 39 e a 40 vieram vazias/outro)');
  assert.deepEqual(f.chamadas.map((c) => `${c.tipo}:${c.page}`), ['lead:1', 'paciente:1', 'paciente:39', 'paciente:40']);
  assert.equal(f.chamadas[0].initialDate, '2026-11-24');
  assert.equal(DIAS_DE_LEADS_RECENTES, 3);
});

test('recentes: paciente cadastrado ontem à noite (última página) é visto', async () => {
  const f = franquiaFalsa({ leads: [pag([], 1)], pacientes: [pag([[1, '+5511900000001']], 3), pag([], 3), pag([[250, '+5511988887777']], 3)] });
  const r = await lerRecentes(U as Unit, Date.now(), f.buscar);
  assert.equal(r.get('88887777')?.id, 250);
});

test('recentes: franquia com 1 página só de pacientes lê a 1 e pronto', async () => {
  const f = franquiaFalsa({ leads: [pag([], 1)], pacientes: [pag([[3, '+5511988887777']], 1)] });
  const r = await lerRecentes(U as Unit, Date.now(), f.buscar);
  assert.equal(r.get('88887777')?.id, 3);
  assert.equal(f.chamadas.filter((c) => c.tipo === 'paciente').length, 1);
});

test('recentes: erro da franquia (lead OU paciente) LANÇA — quem chama trata como "não deu para conferir"', async () => {
  await assert.rejects(lerRecentes(U as Unit, Date.now(), franquiaFalsa({ falhaEm: 'lead' }).buscar), /fora do ar/);
  await assert.rejects(lerRecentes(U as Unit, Date.now(), franquiaFalsa({ leads: [pag([], 1)], falhaEm: 'paciente' }).buscar), /fora do ar/);
});

test('recentes: janela de leads maior que o teto não vira "não está lá"', async () => {
  const f = franquiaFalsa({ leads: [pag([[1, '+5511900000001']], 9)] });
  await assert.rejects(lerRecentes(U as Unit, Date.now(), f.buscar), /não coube/);
});

beforeEach(() => _limparRecentesParaTeste());
