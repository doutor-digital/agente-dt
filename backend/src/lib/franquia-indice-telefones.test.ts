/**
 * Índice de telefones da franquia (06/11/2026).
 *
 * O que estes testes prendem:
 *  - a chave são os últimos 8 dígitos (com e sem o nono dígito dão a mesma); cada telefone guarda o cadastro MAIS ANTIGO;
 *  - a carga lê TODOS os pacientes e os leads em janelas de ≤100 dias, e só então marca o índice como completo;
 *  - carga cortada pelo teto (páginas de pacientes, páginas da janela, chamadas) ou com erro NUNCA marca completo;
 *  - índice com mais de 36 h não é fresco; o incremental só vale com a ordem "do mais antigo ao mais novo" confirmada;
 *  - pausa entre as chamadas (a franquia não pode sentir) e espaçamento das novas tentativas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import type { SpineItemTelefone, SpinePaginaTelefones } from '../services/spine.service.js';
import {
  COMPLETA_A_CADA_MS,
  DIAS_POR_JANELA,
  ESPERA_APOS_CORTE_MS,
  ESPERA_APOS_ERRO_MS,
  MAX_PAGINAS_PACIENTES,
  MAX_PAGINAS_POR_JANELA,
  REFAZER_APOS_MS,
  VALIDADE_MS,
  carregarIndice,
  chaveDoTelefone,
  consultarIndice,
  entradasDosItens,
  indiceFresco,
  janelasDeLeads,
  precisaCarregar,
  totalDePaginas,
  type Armazem,
  type BuscarPagina,
  type Entrada,
  type StatusDoIndice,
} from './franquia-indice-telefones.js';

const H = 3_600_000;
const T0 = Date.parse('2026-11-06T12:00:00Z');
const unit = { id: 'u1', slug: 'doutor-hernia-timbo' } as Pick<Unit, 'id' | 'slug'>;

function armazemEmMemoria() {
  let status: StatusDoIndice | null = null;
  const linhas = new Map<string, Entrada>();
  const armazem: Armazem = {
    async lerStatus() {
      return status;
    },
    async salvarStatus(_u, patch) {
      status = {
        completoEm: null, cargaCompletaEm: null, tentativaEm: null, clientesTotal: null, leadsAte: null, resultado: null,
        ...status,
        ...Object.fromEntries(Object.entries(patch).filter(([k]) => !['pacientes', 'leads', 'erro'].includes(k))),
      } as StatusDoIndice;
    },
    async gravar(_u, entradas) {
      let n = 0;
      for (const e of entradas) {
        const k = `${e.chave}|${e.origem}`;
        const atual = linhas.get(k);
        // o mesmo contrato do SQL de verdade: a data MAIS ANTIGA vence e "sem data" ganha a que chegar
        if (!atual) {
          linhas.set(k, e);
          n++;
        } else if (e.criado && (!atual.criado || e.criado < atual.criado)) linhas.set(k, e);
      }
      return n;
    },
    async procurar(_u, chave) {
      return [...linhas.values()].filter((e) => e.chave === chave);
    },
  };
  return { armazem, status: () => status, linhas, definirStatus: (s: StatusDoIndice | null) => (status = s) };
}

const item = (id: number, fone: string | null, created: string | null = '2025-01-10T12:00:00Z'): SpineItemTelefone => ({ id, whatsapp: fone, created });
const ok = (itens: SpineItemTelefone[], totalPages: number | null = 1, total: number | null = itens.length): { ok: true; data: SpinePaginaTelefones } => ({
  ok: true,
  data: { itens, totalPages, total },
});

interface Franquia {
  pacientes?: SpineItemTelefone[][]; // por página
  leads?: (janela: { initialDate: string; endDate: string }, page: number) => { itens: SpineItemTelefone[]; totalPages: number };
  falhaNaPagina?: number;
  totalDePacientes?: number;
}

function franquiaFalsa(f: Franquia) {
  const chamadas: Array<{ tipo: string; page: number; initialDate?: string; endDate?: string }> = [];
  const buscar: BuscarPagina = async (e, page) => {
    chamadas.push({ tipo: e.tipo, page, ...(e.tipo === 'lead' ? { initialDate: e.initialDate, endDate: e.endDate } : {}) });
    if (e.tipo === 'paciente') {
      if (f.falhaNaPagina === page) return { ok: false, error: '500: franquia fora' };
      const paginas = f.pacientes ?? [[]];
      return ok(paginas[page - 1] ?? [], paginas.length, f.totalDePacientes ?? paginas.flat().length);
    }
    if (!f.leads) return ok([], 1, 0);
    const r = f.leads({ initialDate: e.initialDate, endDate: e.endDate }, page);
    return ok(r.itens, r.totalPages, r.itens.length);
  };
  return { buscar, chamadas };
}

const depsDe = (a: ReturnType<typeof armazemEmMemoria>, buscar: BuscarPagina, extra: { agora?: number; maxChamadas?: number } = {}) => {
  const pausas: number[] = [];
  return {
    pausas,
    deps: { armazem: a.armazem, buscar, pausa: async (ms: number) => void pausas.push(ms), agora: () => extra.agora ?? T0, maxChamadas: extra.maxChamadas },
  };
};

// ── a chave e as entradas ─────────────────────────────────────────────────────────────────────

test('a chave são os últimos 8 dígitos: com e sem o nono dígito, com e sem +55 — e telefone curto não vira chave', () => {
  const k = chaveDoTelefone('+55 47 99999-1234');
  assert.equal(k, '99991234');
  assert.equal(chaveDoTelefone('(47) 9999-1234'), k);
  assert.equal(chaveDoTelefone('554799991234'), k);
  assert.equal(chaveDoTelefone('1234'), null);
  assert.equal(chaveDoTelefone(null), null);
});

test('entradas: uma por telefone e origem, a mais antiga; sem data nunca substitui uma com data; sem telefone fora', () => {
  const e = entradasDosItens(
    [
      item(1, '+5547999991234', '2025-06-01T00:00:00Z'),
      item(2, '47 99999-1234', '2024-01-01T00:00:00Z'), // mesma pessoa, cadastro mais antigo
      item(3, '47 99999-1234', null),
      item(4, null),
      item(5, '12'),
      item(6, '+5511988887777', '2025-01-01T00:00:00Z'),
    ],
    'paciente',
  );
  assert.equal(e.length, 2);
  const a = e.find((x) => x.chave === '99991234')!;
  assert.equal(a.id, 2);
  assert.equal(a.origem, 'paciente');
  assert.equal(a.criado?.toISOString(), '2024-01-01T00:00:00.000Z');
});

test('janelas de leads: cada uma com no máximo 100 dias (a franquia recusa mais), da mais antiga à mais nova, sem buraco', () => {
  const j = janelasDeLeads('2023-11-07', '2026-11-06');
  assert.ok(j.length >= 12);
  assert.equal(j[0]!.de, '2023-11-07');
  assert.equal(j[j.length - 1]!.ate, '2026-11-06');
  for (let i = 0; i < j.length; i++) {
    const dias = (Date.parse(j[i]!.ate) - Date.parse(j[i]!.de)) / 86_400_000 + 1;
    assert.ok(dias <= DIAS_POR_JANELA && dias <= 100, `janela ${i} com ${dias} dias`);
    if (i > 0) assert.equal((Date.parse(j[i]!.de) - Date.parse(j[i - 1]!.ate)) / 86_400_000, 1, 'sem buraco entre janelas');
  }
});

// ── a carga ────────────────────────────────────────────────────────────────────────────────

test('carga completa: lê todas as páginas de pacientes e as janelas de leads, grava e só então marca completo', async () => {
  const a = armazemEmMemoria();
  const f = franquiaFalsa({
    pacientes: [[item(1, '+5547999991111')], [item(2, '+5547999992222')], [item(3, '+5547999993333')]],
    leads: (j) => (j.endDate >= '2026-11-01' ? { itens: [item(90, '+5547999994444', '2026-10-30T00:00:00Z')], totalPages: 1 } : { itens: [], totalPages: 1 }),
  });
  const { deps, pausas } = depsDe(a, f.buscar);
  const r = await carregarIndice(unit, deps);
  assert.equal(r.resultado, 'ok');
  assert.equal(r.modo, 'completa');
  assert.equal(r.pacientes, 3);
  assert.equal(r.leads, 1);
  assert.equal(a.status()?.completoEm?.getTime(), T0);
  assert.equal(a.status()?.cargaCompletaEm?.getTime(), T0);
  assert.equal(a.status()?.clientesTotal, 3);
  assert.equal((await a.armazem.procurar('u1', '99992222'))[0]?.origem, 'paciente');
  assert.equal((await a.armazem.procurar('u1', '99994444'))[0]?.origem, 'lead');
  // pausa entre TODAS as chamadas (menos a primeira)
  assert.equal(pausas.length, f.chamadas.length - 1);
  assert.ok(pausas.every((p) => p > 0));
  // toda janela de leads respeitou o limite de 100 dias
  for (const c of f.chamadas.filter((x) => x.tipo === 'lead')) {
    assert.ok((Date.parse(c.endDate!) - Date.parse(c.initialDate!)) / 86_400_000 + 1 <= 100);
  }
});

test('carga respeita o teto de páginas de pacientes: base grande demais é CORTADA e o índice não fica completo', async () => {
  const a = armazemEmMemoria();
  const f = franquiaFalsa({ pacientes: Array.from({ length: MAX_PAGINAS_PACIENTES + 1 }, () => [item(1, '+5547999991111')]) });
  const { deps } = depsDe(a, f.buscar);
  const r = await carregarIndice(unit, deps);
  assert.equal(r.resultado, 'cortado');
  assert.equal(f.chamadas.length, 1, 'não gasta 400 chamadas para chegar a um índice que não vale');
  assert.equal(a.status()?.completoEm ?? null, null);
  assert.equal(a.status()?.resultado, 'cortado');
});

test('carga respeita o teto de páginas por janela de leads: cortada, nunca completa', async () => {
  const a = armazemEmMemoria();
  const f = franquiaFalsa({ pacientes: [[item(1, '+5547999991111')]], leads: () => ({ itens: [item(9, '+5547999995555')], totalPages: MAX_PAGINAS_POR_JANELA + 1 }) });
  const { deps } = depsDe(a, f.buscar);
  const r = await carregarIndice(unit, deps);
  assert.equal(r.resultado, 'cortado');
  assert.equal(a.status()?.completoEm ?? null, null);
  assert.ok(f.chamadas.filter((c) => c.tipo === 'lead').length <= 1);
});

test('carga respeita o teto de chamadas', async () => {
  const a = armazemEmMemoria();
  const f = franquiaFalsa({ pacientes: Array.from({ length: 10 }, (_, i) => [item(i + 1, `+55479999${String(1000 + i)}`)]) });
  const { deps } = depsDe(a, f.buscar, { maxChamadas: 4 });
  const r = await carregarIndice(unit, deps);
  assert.equal(r.resultado, 'cortado');
  assert.equal(f.chamadas.length, 4);
  assert.equal(a.status()?.completoEm ?? null, null);
});

test('erro da franquia no meio: não marca completo, guarda o que já leu e registra o erro', async () => {
  const a = armazemEmMemoria();
  const f = franquiaFalsa({ pacientes: [[item(1, '+5547999991111')], [item(2, '+5547999992222')], [item(3, '+5547999993333')]], falhaNaPagina: 2 });
  const { deps } = depsDe(a, f.buscar);
  const r = await carregarIndice(unit, deps);
  assert.equal(r.resultado, 'erro');
  assert.equal(a.status()?.completoEm ?? null, null);
  assert.equal(a.status()?.resultado, 'erro');
  assert.equal((await a.armazem.procurar('u1', '99991111')).length, 1, 'a página 1 ficou gravada (idempotente)');
});

test('franquia que não informa o total de páginas e devolve página CHEIA: não dá para saber se leu tudo → erro', async () => {
  const a = armazemEmMemoria();
  const cheia = Array.from({ length: 100 }, (_, i) => item(i + 1, `+55479999${String(1000 + i)}`));
  const buscar: BuscarPagina = async (e) => (e.tipo === 'paciente' ? ok(cheia, null, null) : ok([], 1, 0));
  const r = await carregarIndice(unit, depsDe(a, buscar).deps);
  assert.equal(r.resultado, 'erro');
  assert.equal(a.status()?.completoEm ?? null, null);
});

test('incremental: depois da carga inteira lê só o fim dos pacientes (ordem crescente confirmada) e os leads recentes', async () => {
  const a = armazemEmMemoria();
  const pagina = (n: number) => Array.from({ length: 2 }, (_, i) => item(n * 10 + i, `+55479999${n}${i}00`, `2025-0${n}-0${i + 1}T00:00:00Z`));
  const base = Array.from({ length: 6 }, (_, i) => pagina(i + 1));
  const f1 = franquiaFalsa({ pacientes: base, totalDePacientes: 600 });
  await carregarIndice(unit, depsDe(a, f1.buscar).deps);
  assert.equal(a.status()?.clientesTotal, 600);

  // um dia depois: 20 pacientes novos no fim
  const f2 = franquiaFalsa({ pacientes: [...base, pagina(7)], totalDePacientes: 620 });
  const r = await carregarIndice(unit, depsDe(a, f2.buscar, { agora: T0 + 24 * H }).deps);
  assert.equal(r.modo, 'incremental');
  const lidas = f2.chamadas.filter((c) => c.tipo === 'paciente').map((c) => c.page);
  assert.deepEqual(lidas, [1, 6, 7], 'página 1 (para a ordem e o total) + a partir da página onde parou, com uma de folga');
  const leads = f2.chamadas.filter((c) => c.tipo === 'lead');
  assert.ok(leads.length <= 2, 'só os leads dos últimos dias');
  assert.equal(a.status()?.completoEm?.getTime(), T0 + 24 * H);
  assert.equal(a.status()?.cargaCompletaEm?.getTime(), T0, 'a carga completa continua sendo a de antes');
});

test('incremental com a ordem não confirmada (ou a base encolheu): refaz a carga completa em vez de arriscar', async () => {
  const a = armazemEmMemoria();
  const decrescente = [[item(1, '+5547999990001', '2025-03-01T00:00:00Z'), item(2, '+5547999990002', '2025-01-01T00:00:00Z')], [item(3, '+5547999990003', '2024-01-01T00:00:00Z')]];
  await carregarIndice(unit, depsDe(a, franquiaFalsa({ pacientes: decrescente, totalDePacientes: 150 }).buscar).deps);
  const f2 = franquiaFalsa({ pacientes: decrescente, totalDePacientes: 150 });
  const r = await carregarIndice(unit, depsDe(a, f2.buscar, { agora: T0 + 24 * H }).deps);
  assert.equal(r.modo, 'completa');
  assert.deepEqual(f2.chamadas.filter((c) => c.tipo === 'paciente').map((c) => c.page), [1, 2]);
});

test('depois de 7 dias a carga volta a ser completa', async () => {
  const a = armazemEmMemoria();
  const f = franquiaFalsa({ pacientes: [[item(1, '+5547999990001', '2025-01-01T00:00:00Z'), item(2, '+5547999990002', '2025-02-01T00:00:00Z')]] });
  await carregarIndice(unit, depsDe(a, f.buscar).deps);
  const r = await carregarIndice(unit, depsDe(a, f.buscar, { agora: T0 + COMPLETA_A_CADA_MS + H }).deps);
  assert.equal(r.modo, 'completa');
});

// ── consulta e freshness ───────────────────────────────────────────────────────────────────

test('índice fresco = carga inteira há no máximo 36 h; velho, nunca montado ou cortado não autoriza', async () => {
  assert.equal(indiceFresco({ completoEm: new Date(T0 - 35 * H) }, T0), true);
  assert.equal(indiceFresco({ completoEm: new Date(T0 - VALIDADE_MS - 1) }, T0), false);
  assert.equal(indiceFresco({ completoEm: null }, T0), false);
  assert.equal(indiceFresco(null, T0), false);

  const a = armazemEmMemoria();
  a.definirStatus({ completoEm: new Date(T0 - 40 * H), cargaCompletaEm: null, tentativaEm: null, clientesTotal: 1, leadsAte: null, resultado: 'ok' });
  const velho = await consultarIndice('u1', '99991234', a.armazem, T0);
  assert.equal(velho.fresco, false);
  assert.equal(velho.idadeHoras, 40);
  const nunca = await consultarIndice('u1', '99991234', armazemEmMemoria().armazem, T0);
  assert.equal(nunca.fresco, false);
  assert.equal(nunca.idadeHoras, null);

  // carga cortada depois de uma boa: o `completoEm` antigo é o que vale — e envelhece
  const f = franquiaFalsa({ pacientes: Array.from({ length: MAX_PAGINAS_PACIENTES + 1 }, () => []) });
  await carregarIndice(unit, depsDe(a, f.buscar, { agora: T0 }).deps);
  assert.equal(a.status()?.completoEm?.getTime(), T0 - 40 * H, 'carga cortada não renova o completoEm');
});

test('quando carregar: nunca carregou → sim; recente → não; 20 h → sim; erro espera 1 h; corte espera 24 h', () => {
  const base: StatusDoIndice = { completoEm: new Date(T0 - 2 * H), cargaCompletaEm: null, tentativaEm: new Date(T0 - 2 * H), clientesTotal: 1, leadsAte: null, resultado: 'ok' };
  assert.equal(precisaCarregar(null, T0), true);
  assert.equal(precisaCarregar(base, T0), false);
  assert.equal(precisaCarregar({ ...base, completoEm: new Date(T0 - REFAZER_APOS_MS - 1), tentativaEm: new Date(T0 - REFAZER_APOS_MS - 1) }, T0), true);
  const velho = { ...base, completoEm: new Date(T0 - 30 * H) };
  assert.equal(precisaCarregar({ ...velho, resultado: 'erro', tentativaEm: new Date(T0 - 10 * 60_000) }, T0), false);
  assert.equal(precisaCarregar({ ...velho, resultado: 'erro', tentativaEm: new Date(T0 - ESPERA_APOS_ERRO_MS - 1) }, T0), true);
  assert.equal(precisaCarregar({ ...velho, resultado: 'cortado', tentativaEm: new Date(T0 - 5 * H) }, T0), false);
  assert.equal(precisaCarregar({ ...velho, resultado: 'cortado', tentativaEm: new Date(T0 - ESPERA_APOS_CORTE_MS - 1) }, T0), true);
  assert.equal(precisaCarregar({ ...base, completoEm: null, tentativaEm: null, resultado: null }, T0), true);
});

test('total de páginas: o informado; o total dividido; página curta = a única; página cheia sem total = não sei', () => {
  const pg = (n: number, totalPages: number | null, total: number | null) => ({ itens: Array.from({ length: n }, (_, i) => item(i + 1, '+5547999991111')), totalPages, total });
  assert.equal(totalDePaginas(pg(100, 7, 650)), 7);
  assert.equal(totalDePaginas(pg(100, null, 650)), 7);
  assert.equal(totalDePaginas(pg(40, null, null)), 1);
  assert.equal(totalDePaginas(pg(0, null, null)), 1);
  assert.equal(totalDePaginas(pg(100, null, null)), null);
});

test('leads: janela cheia sem o total de páginas NÃO é tratada como uma página só — a carga falha e não fica completa', async () => {
  const a = armazemEmMemoria();
  const cheia = Array.from({ length: 100 }, (_, i) => item(i + 1, `+55479999${String(1000 + i)}`));
  const buscar: BuscarPagina = async (e) => (e.tipo === 'paciente' ? ok([item(1, '+5547999991111')]) : ok(cheia, null, null));
  const r = await carregarIndice(unit, depsDe(a, buscar).deps);
  assert.equal(r.resultado, 'erro');
  assert.equal(a.status()?.completoEm ?? null, null);
});

test('regravar: a data mais antiga vence e uma linha sem data ganha a que chegar depois', async () => {
  const a = armazemEmMemoria();
  await a.armazem.gravar('u1', [{ chave: '99991111', origem: 'paciente', id: 1, criado: null }]);
  await a.armazem.gravar('u1', [{ chave: '99991111', origem: 'paciente', id: 2, criado: new Date('2025-05-01T00:00:00Z') }]);
  await a.armazem.gravar('u1', [{ chave: '99991111', origem: 'paciente', id: 3, criado: new Date('2025-09-01T00:00:00Z') }]);
  await a.armazem.gravar('u1', [{ chave: '99991111', origem: 'paciente', id: 4, criado: new Date('2024-01-01T00:00:00Z') }]);
  const [e] = await a.armazem.procurar('u1', '99991111');
  assert.equal(e!.id, 4);
  assert.equal(e!.criado?.toISOString(), '2024-01-01T00:00:00.000Z');
});
