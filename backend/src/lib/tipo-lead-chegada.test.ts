/**
 * ⬢ Tipo de lead na chegada (06/11/2026).
 *
 * O que estes testes prendem:
 *  - Cadastro = pessoa nova; Resgate = já na franquia (pelo telefone) OU 1º contato há mais de 90 dias (cartão, nome com data,
 *    campo "Data do primeiro contato" ou OUTRO cartão do mesmo contato);
 *  - VALE O DA CHEGADA: só grava em campo vazio, relê antes de gravar, e o campos-sdr (agendamento) com o campo preenchido só
 *    registra confere/diverge; "Transferido de outra unidade" ninguém toca;
 *  - nunca chuta: franquia com erro, sem telefone, sem nome, nome comum demais ou cartões do contato ilegíveis = não grava;
 *  - seco não grava; desligado nem lê o Kommo; conta sem a opção não grava; a franquia é buscada UMA vez por cartão.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';

import { CAMPOS_SDR, planejarCamposSdr } from './campos-sdr.js';
import type { Estado } from './automacoes-estado.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { Achado } from './paciente-existente.js';
import {
  CAMPO_PRIMEIRO_CONTATO,
  CAMPO_TIPO_LEAD,
  decidirTipoDaChegada,
  franquiaConhece,
  opcaoDaConta,
  resgatePelaIdade,
  type RespostaDaFranquia,
} from './tipo-lead-chegada.js';
import { _limparParaTeste, tipoNaChegadaConta, type DepsDoTipo, type KommoDoTipo } from './tipo-lead-chegada-worker.js';

const DIA = 86_400;
const AGORA = Date.parse('2026-11-06T15:00:00Z') / 1000;
const ID_TIPO = 111;
const ID_PRIMEIRO = 222;
const OPCOES = [{ id: 1, value: 'Resgate' }, { id: 2, value: 'Cadastro' }, { id: 3, value: 'TRANSFERIDO DE OUTRA UNIDADE' }];

const unit = { id: 'u1', slug: 'doutor-hernia-timbo', spineEnabled: true, spineToken: 'tok' } as unknown as Unit;

beforeEach(() => _limparParaTeste());

// ── o cartão e o Kommo de mentira ─────────────────────────────────────────────────────────────────

interface Cartao {
  id: number;
  name?: string;
  criadoHa?: number; // segundos antes de AGORA
  tipo?: string | null;
  primeiroContato?: number | null;
  contato?: number | null;
  status?: number;
}

function lead(c: Cartao): KommoLead {
  const campos: NonNullable<KommoLead['custom_fields_values']> = [];
  if (c.tipo) campos.push({ field_id: ID_TIPO, values: [{ value: c.tipo }] });
  if (c.primeiroContato) campos.push({ field_id: ID_PRIMEIRO, values: [{ value: c.primeiroContato }] });
  return {
    id: c.id,
    name: c.name ?? 'Lead 06/11/2026',
    status_id: c.status ?? 100,
    pipeline_id: 1,
    created_at: AGORA - (c.criadoHa ?? 600),
    custom_fields_values: campos,
    _embedded: c.contato === null ? { contacts: [] } : { contacts: [{ id: c.contato ?? c.id * 10, is_main: true }] },
  };
}

interface Mundo {
  cartoes: Cartao[];
  /** contatoId → { nome, telefone } */
  contatos?: Record<number, { nome: string | null; telefone: string | null }>;
  /** contatoId → ids dos cartões do contato (incluindo o próprio) ; null = não conseguiu ler */
  doContato?: Record<number, number[] | null>;
  /** cartões "de fora" (outros do contato) */
  outros?: Cartao[];
  semOpcoes?: boolean;
  tipoDoCampo?: 'select' | 'text';
  semCampo?: boolean;
  /** valor que o getLead devolve na releitura (a SDR escolheu no meio) */
  releitura?: string | null;
  setFalha?: boolean;
}

function montar(m: Mundo) {
  const chamadas = { lista: 0, contatosBasicos: 0, contatoComCartoes: 0, listLeadsPorIds: 0, getLead: 0, gravacoes: [] as Array<{ leadId: number; valor: string }> };
  const todos = [...m.cartoes, ...(m.outros ?? [])];
  const kommo = {
    async listLeadsNaJanela() {
      chamadas.lista++;
      return { leads: m.cartoes.map(lead), truncado: false };
    },
    async listLeadCustomFieldsTyped() {
      const campos: Array<{ id: number; name: string; type: string; code: null; enums: Array<{ id: number; value: string }> }> = [
        { id: ID_PRIMEIRO, name: CAMPO_PRIMEIRO_CONTATO, type: 'date', code: null, enums: [] },
      ];
      if (!m.semCampo) {
        campos.push({
          id: ID_TIPO,
          name: CAMPO_TIPO_LEAD,
          type: m.tipoDoCampo ?? 'select',
          code: null,
          enums: m.semOpcoes ? [{ id: 3, value: 'TRANSFERIDO DE OUTRA UNIDADE' }] : OPCOES,
        });
        // o campo antigo, sem o símbolo, não pode ser confundido com o novo
        campos.push({ id: 999, name: 'Tipo de lead', type: 'select', code: null, enums: [] });
      }
      return campos;
    },
    async contatosBasicos(ids: number[]) {
      chamadas.contatosBasicos++;
      const mapa = new Map<number, { nome: string | null; telefone: string | null }>();
      for (const id of ids) if (m.contatos?.[id]) mapa.set(id, m.contatos[id]!);
      return mapa;
    },
    async contatoComCartoes(id: number) {
      chamadas.contatoComCartoes++;
      const ids = m.doContato?.[id];
      if (ids === null) return null;
      return { id, nome: null, telefone: null, telefones: [], leadIds: ids ?? [] };
    },
    async listLeadsPorIds(ids: number[]) {
      chamadas.listLeadsPorIds++;
      return todos.filter((c) => ids.includes(c.id)).map(lead);
    },
    async getLead(id: number) {
      chamadas.getLead++;
      const base = lead(m.cartoes.find((c) => c.id === id)!);
      if (m.releitura !== undefined) base.custom_fields_values = m.releitura ? [{ field_id: ID_TIPO, values: [{ value: m.releitura }] }] : [];
      return base;
    },
    async setLeadCustomFieldValue(leadId: number, _campo: number, _tipo: string, valor: string | number | string[]) {
      if (m.setFalha) throw new Error('kommo 500');
      chamadas.gravacoes.push({ leadId, valor: String(valor) });
    },
  } as unknown as KommoDoTipo;
  return { kommo, chamadas };
}

function depsDe(opcoes: {
  estado?: Estado;
  franquia?: (e: { titulo: string; nomeDoContato: string | null; telefone: string | null }) => Promise<RespostaDaFranquia>;
  jaAgendou?: boolean;
  dono?: 'recusa';
}) {
  const buscas: Array<{ titulo: string; nomeDoContato: string | null; telefone: string | null }> = [];
  const simulacoes: Array<{ leadId: number; acao: string; valor?: unknown; motivo?: string | null }> = [];
  const deps: DepsDoTipo = {
    estadoDe: () => opcoes.estado ?? 'ligado',
    donoDoCartao: async () =>
      opcoes.dono === 'recusa' ? { tipo: 'recusa', codigo: 'sem_unidade', motivo: 'sem unidade' } : { tipo: 'sem-divisao', unit },
    jaAgendou: async () => opcoes.jaAgendou ?? false,
    franquiaConhece: async (_u, e) => {
      buscas.push(e);
      return opcoes.franquia ? opcoes.franquia(e) : { resultado: 'nao', motivo: 'o telefone não está na franquia' };
    },
    registrar: ((_u: unknown, _a: string, s: { leadId: number; acao: string; valor?: unknown; motivo?: string | null }) => {
      simulacoes.push(s);
    }) as DepsDoTipo['registrar'],
  };
  return { deps, buscas, simulacoes };
}

const CONTATO = { nome: 'Stefany Silva', telefone: '+55 47 99999-1234' };
const rodar = (m: Mundo, d: ReturnType<typeof depsDe>) => {
  const { kommo, chamadas } = montar(m);
  return tipoNaChegadaConta({ unit, membros: null, kommo, deps: d.deps, agora: AGORA, pausaMs: 0 }).then((resumo) => ({ resumo, chamadas }));
};

// ── os casos do João ──────────────────────────────────────────────────────────────────────────────

test('pessoa nova (franquia não conhece, 1º contato recente) → Cadastro', async () => {
  const d = depsDe({});
  const { resumo, chamadas } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, d);
  assert.deepEqual(chamadas.gravacoes, [{ leadId: 1, valor: 'Cadastro' }]);
  assert.equal(resumo?.gravados, 1);
  assert.equal(d.buscas.length, 1);
  assert.equal(d.buscas[0]!.telefone, CONTATO.telefone);
});

test('já cadastrada na franquia pelo telefone → Resgate', async () => {
  const d = depsDe({ franquia: async () => ({ resultado: 'sim', motivo: 'já cadastrada na franquia (idClient 77, pelo telefone)' }) });
  const { chamadas } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, d);
  assert.deepEqual(chamadas.gravacoes, [{ leadId: 1, valor: 'Resgate' }]);
});

test('1º contato há mais de 90 dias → Resgate, sem gastar a busca na franquia (nome com data, campo e outro cartão)', async () => {
  // a) a data que a SDR escreveu no nome
  const a = depsDe({});
  const ra = await rodar({ cartoes: [{ id: 1, name: 'Rosimar 14/5/2026' }], contatos: { 10: CONTATO } }, a);
  assert.deepEqual(ra.chamadas.gravacoes, [{ leadId: 1, valor: 'Resgate' }]);
  assert.equal(a.buscas.length, 0);
  assert.equal(ra.chamadas.contatoComCartoes, 0, 'nem os outros cartões: o próprio cartão já bastou');

  _limparParaTeste();
  // b) o campo "◷ Data do primeiro contato"
  const b = depsDe({});
  const rb = await rodar({ cartoes: [{ id: 2, primeiroContato: AGORA - 200 * DIA }], contatos: { 20: CONTATO } }, b);
  assert.deepEqual(rb.chamadas.gravacoes, [{ leadId: 2, valor: 'Resgate' }]);
  assert.equal(b.buscas.length, 0);

  _limparParaTeste();
  // c) OUTRO cartão do mesmo contato, criado há 200 dias
  const c = depsDe({});
  const rc = await rodar(
    { cartoes: [{ id: 3 }], outros: [{ id: 300, criadoHa: 200 * DIA }], contatos: { 30: CONTATO }, doContato: { 30: [3, 300] } },
    c,
  );
  assert.deepEqual(rc.chamadas.gravacoes, [{ leadId: 3, valor: 'Resgate' }]);
  assert.equal(c.buscas.length, 0);
});

test('outro cartão do mesmo contato de 30 dias NÃO faz Resgate (só passa dos 90)', async () => {
  const d = depsDe({});
  const r = await rodar({ cartoes: [{ id: 3 }], outros: [{ id: 300, criadoHa: 30 * DIA }], contatos: { 30: CONTATO }, doContato: { 30: [3, 300] } }, d);
  assert.deepEqual(r.chamadas.gravacoes, [{ leadId: 3, valor: 'Cadastro' }]);
});

test('campo já preenchido: não toca (nem lê a franquia)', async () => {
  const d = depsDe({});
  const { resumo, chamadas } = await rodar({ cartoes: [{ id: 1, tipo: 'Cadastro' }], contatos: { 10: CONTATO } }, d);
  assert.equal(chamadas.gravacoes.length, 0);
  assert.equal(resumo?.jaPreenchidos, 1);
  assert.equal(d.buscas.length, 0);
});

test('"Transferido de outra unidade" é manual: nunca sobrescreve', async () => {
  const d = depsDe({});
  const { chamadas } = await rodar({ cartoes: [{ id: 1, tipo: 'TRANSFERIDO DE OUTRA UNIDADE', name: 'Maria 01/01/2026' }], contatos: { 10: CONTATO } }, d);
  assert.equal(chamadas.gravacoes.length, 0);
  assert.equal(d.buscas.length, 0);
});

test('a SDR escolheu no meio da rodada: a releitura antes de gravar vence, não sobrescreve', async () => {
  const d = depsDe({});
  const { chamadas, resumo } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO }, releitura: 'Resgate' }, d);
  assert.equal(chamadas.gravacoes.length, 0);
  assert.equal(resumo?.jaPreenchidos, 1);
});

test('franquia com erro: NÃO grava (nunca chuta Cadastro) e tenta de novo depois', async () => {
  let n = 0;
  const d = depsDe({
    franquia: async () => {
      n++;
      return n === 1 ? { resultado: 'desconhecido', motivo: 'a franquia não respondeu' } : { resultado: 'nao', motivo: 'o telefone não está na franquia' };
    },
  });
  const m: Mundo = { cartoes: [{ id: 1 }], contatos: { 10: CONTATO } };
  const r1 = await rodar(m, d);
  assert.equal(r1.chamadas.gravacoes.length, 0);
  assert.equal(r1.resumo?.adiados, 1);
  // 10 minutos depois a franquia voltou
  const { kommo, chamadas } = montar(m);
  await tipoNaChegadaConta({ unit, membros: null, kommo, deps: d.deps, agora: AGORA + 11 * 60, pausaMs: 0 });
  assert.deepEqual(chamadas.gravacoes, [{ leadId: 1, valor: 'Cadastro' }]);
});

test('franquia que lança também não vira Cadastro', async () => {
  const d = depsDe({ franquia: async () => { throw new Error('ECONNRESET'); } });
  const { chamadas } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, d);
  assert.equal(chamadas.gravacoes.length, 0);
});

test('os outros cartões do contato ilegíveis: não prova que é nova, não grava', async () => {
  const d = depsDe({});
  const { chamadas } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO }, doContato: { 10: null } }, d);
  assert.equal(chamadas.gravacoes.length, 0);
  assert.equal(d.buscas.length, 1, 'a franquia foi consultada, mas sem a prova dos outros cartões não decide');
});

test('seco: decide e registra "gravaria", mas não grava', async () => {
  const d = depsDe({ estado: 'seco' });
  const { chamadas, resumo } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, d);
  assert.equal(chamadas.gravacoes.length, 0);
  assert.equal(chamadas.getLead, 0, 'seco nem relê o cartão para gravar');
  assert.equal(resumo?.simulados, 1);
  assert.deepEqual(d.simulacoes.map((s) => [s.leadId, s.acao, s.valor]), [[1, 'gravaria', 'Cadastro']]);
});

test('desligado: nem lê o Kommo', async () => {
  const d = depsDe({ estado: 'desligado' });
  const { resumo, chamadas } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, d);
  assert.equal(resumo, null);
  assert.equal(chamadas.lista, 0);
  assert.equal(d.buscas.length, 0);
});

test('conta sem a opção "Cadastro"/"Resgate": não grava e registra', async () => {
  const d = depsDe({});
  const { chamadas, resumo } = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO }, semOpcoes: true }, d);
  assert.equal(chamadas.gravacoes.length, 0);
  assert.equal(resumo?.semOpcao, 1);
  assert.equal(d.simulacoes[0]?.acao, 'pularia');
});

test('conta sem o campo, ou com o campo como texto: não grava', async () => {
  const d = depsDe({});
  assert.equal((await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO }, semCampo: true }, d)).resumo, null);
  _limparParaTeste();
  const r = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO }, tipoDoCampo: 'text' }, d);
  assert.equal(r.resumo, null);
  assert.equal(r.chamadas.gravacoes.length, 0);
});

test('a franquia é buscada UMA vez por cartão, mesmo em várias varreduras (seco repete o cartão a cada rodada)', async () => {
  const d = depsDe({ estado: 'seco' });
  const m: Mundo = { cartoes: [{ id: 1 }], contatos: { 10: CONTATO } };
  for (let i = 0; i < 4; i++) {
    const { kommo } = montar(m);
    await tipoNaChegadaConta({ unit, membros: null, kommo, deps: d.deps, agora: AGORA + i * 180, pausaMs: 0 });
  }
  assert.equal(d.buscas.length, 1);
});

test('uma falha de gravação não vira Cadastro nem trava: conta o erro e o cartão volta na próxima rodada com a decisão guardada', async () => {
  const d = depsDe({});
  const r1 = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO }, setFalha: true }, d);
  assert.equal(r1.resumo?.erros, 1);
  const r2 = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, d);
  assert.deepEqual(r2.chamadas.gravacoes, [{ leadId: 1, valor: 'Cadastro' }]);
  assert.equal(d.buscas.length, 1, 'a decisão ficou guardada: sem nova busca na franquia');
});

test('cartão que já agendou fica com o campos-sdr; cartão perdido é ignorado; conta dividida sem unidade espera', async () => {
  const agendou = depsDe({ jaAgendou: true });
  const a = await rodar({ cartoes: [{ id: 1 }], contatos: { 10: CONTATO } }, agendou);
  assert.equal(a.chamadas.gravacoes.length, 0);
  assert.equal(agendou.buscas.length, 0);

  const perdido = depsDe({});
  const p = await rodar({ cartoes: [{ id: 2, status: 143 }], contatos: { 20: CONTATO } }, perdido);
  assert.equal(p.chamadas.gravacoes.length, 0);

  const semUnidade = depsDe({ dono: 'recusa' });
  const s = await rodar({ cartoes: [{ id: 3 }], contatos: { 30: CONTATO } }, semUnidade);
  assert.equal(s.chamadas.gravacoes.length, 0);
  assert.equal(s.resumo?.semUnidade, 1);
});

test('teto por rodada: importação em massa não vira rajada de buscas na franquia', async () => {
  const d = depsDe({});
  const cartoes = Array.from({ length: 40 }, (_, i) => ({ id: i + 1 }));
  const contatos = Object.fromEntries(cartoes.map((c) => [c.id * 10, CONTATO]));
  const { resumo, chamadas } = await rodar({ cartoes, contatos }, d);
  assert.equal(d.buscas.length, 25);
  assert.equal(chamadas.gravacoes.length, 25);
  assert.equal(resumo?.adiados, 15);
});

// ── as peças puras ────────────────────────────────────────────────────────────────────────────────

test('opção pelo valor, na grafia da conta', () => {
  assert.equal(opcaoDaConta([{ value: 'RESGATE' }, { value: 'Cadastro ' }], 'Resgate'), 'RESGATE');
  assert.equal(opcaoDaConta([{ value: 'Resgate' }], 'Cadastro'), null);
});

test('resgatePelaIdade: o 1º contato é o mais antigo; 90 dias exatos ainda é Cadastro', () => {
  const base = { nome: 'Lead 06/11/2026', criadoEmEpoch: AGORA, primeiroContatoEpoch: null, outros: [] };
  assert.equal(resgatePelaIdade(base), null);
  assert.equal(resgatePelaIdade({ ...base, primeiroContatoEpoch: AGORA - 90 * DIA }), null);
  assert.match(resgatePelaIdade({ ...base, primeiroContatoEpoch: AGORA - 91 * DIA })!, /91 dias/);
  assert.match(resgatePelaIdade({ ...base, outros: [{ nome: 'Ana 02/03/2026', criadoEmEpoch: AGORA - 10 * DIA }] })!, /dias/);
  assert.equal(resgatePelaIdade({ ...base, criadoEmEpoch: null }), null);
});

test('decidirTipoDaChegada: sem prova de "nova" não há Cadastro', () => {
  const nao: RespostaDaFranquia = { resultado: 'nao', motivo: 'o telefone não está na franquia' };
  const base = { pelaIdade: null, outrosLidos: true, franquia: nao, temDataDeChegada: true };
  assert.equal(decidirTipoDaChegada(base).tipo, 'Cadastro');
  assert.equal(decidirTipoDaChegada({ ...base, franquia: { resultado: 'desconhecido', motivo: 'x' } }).tipo, null);
  assert.equal(decidirTipoDaChegada({ ...base, franquia: null }).tipo, null);
  assert.equal(decidirTipoDaChegada({ ...base, outrosLidos: false }).tipo, null);
  assert.equal(decidirTipoDaChegada({ ...base, temDataDeChegada: false }).tipo, null);
  // Resgate não precisa de nada além da prova dele
  assert.equal(decidirTipoDaChegada({ ...base, pelaIdade: '1º contato há 200 dias', outrosLidos: false, franquia: null }).tipo, 'Resgate');
  assert.equal(decidirTipoDaChegada({ ...base, franquia: { resultado: 'sim', motivo: 'na franquia' } }).tipo, 'Resgate');
});

// ── a busca na franquia ───────────────────────────────────────────────────────────────────────────

const buscarCom = (a: Achado | Error) => async () => {
  if (a instanceof Error) throw a;
  return a;
};
const FONE = '+55 47 99999-1234';

test('franquiaConhece: achou/ambíguo = sim; não achou = não', async () => {
  const e = { titulo: 'Lead 06/11/2026', nomeDoContato: 'Stefany Silva', telefone: FONE };
  assert.equal((await franquiaConhece(unit, e, buscarCom({ tipo: 'achou', idClient: 7, nome: 'Stefany Silva' }))).resultado, 'sim');
  assert.equal((await franquiaConhece(unit, e, buscarCom({ tipo: 'ambiguo', candidatos: [{ idClient: 1, nome: 'A' }, { idClient: 2, nome: 'B' }] }))).resultado, 'sim');
  assert.equal((await franquiaConhece(unit, e, buscarCom({ tipo: 'nao_achou' }))).resultado, 'nao');
});

test('franquiaConhece: erro, resposta ausente, nome comum demais, sem telefone, sem nome e sem franquia = desconhecido', async () => {
  const e = { titulo: 'Lead 06/11/2026', nomeDoContato: 'Stefany Silva', telefone: FONE };
  assert.equal((await franquiaConhece(unit, e, buscarCom({ tipo: 'sem_resposta' }))).resultado, 'desconhecido');
  assert.equal((await franquiaConhece(unit, e, buscarCom({ tipo: 'inconclusivo' }))).resultado, 'desconhecido');
  assert.equal((await franquiaConhece(unit, e, buscarCom(new Error('ECONNRESET')))).resultado, 'desconhecido');
  assert.equal((await franquiaConhece(unit, { ...e, telefone: null }, buscarCom({ tipo: 'nao_achou' }))).resultado, 'desconhecido');
  // título provisório + contato sem nome: nada para buscar (e "Lead" não é nome)
  let buscou = false;
  const r = await franquiaConhece(unit, { ...e, nomeDoContato: null }, async () => { buscou = true; return { tipo: 'nao_achou' }; });
  assert.equal(r.resultado, 'desconhecido');
  assert.equal(buscou, false);
  const semFranquia = { ...unit, spineToken: null } as unknown as Unit;
  assert.equal((await franquiaConhece(semFranquia, e, buscarCom({ tipo: 'nao_achou' }))).resultado, 'desconhecido');
});

test('franquiaConhece: título provisório não vai para a busca; só o primeiro nome pede a busca completa', async () => {
  let recebido: { nome: string; titulo: string; soPrimeiroNome?: boolean } | null = null;
  const espia = async (_u: Unit, nome: string, titulo: string, _f: string, o?: { soPrimeiroNome?: boolean }): Promise<Achado> => {
    recebido = { nome, titulo, soPrimeiroNome: o?.soPrimeiroNome };
    return { tipo: 'nao_achou' };
  };
  await franquiaConhece(unit, { titulo: 'Lead 06/11/2026', nomeDoContato: 'Stefany Silva', telefone: FONE }, espia);
  assert.deepEqual(recebido, { nome: 'Stefany Silva', titulo: '', soPrimeiroNome: false });
  await franquiaConhece(unit, { titulo: 'Lead #5493104', nomeDoContato: 'Stefany', telefone: FONE }, espia);
  assert.deepEqual(recebido, { nome: 'Stefany', titulo: '', soPrimeiroNome: true });
  await franquiaConhece(unit, { titulo: 'Maria Souza 03/11/2026', nomeDoContato: null, telefone: FONE }, espia);
  assert.deepEqual(recebido, { nome: 'Maria Souza', titulo: 'Maria Souza 03/11/2026', soPrimeiroNome: false });
});

// ── o campos-sdr (agendamento) respeita o da chegada ──────────────────────────────────────────────

test('campos-sdr no agendamento: com o Tipo de lead da chegada já no cartão, só registra confere/diverge — nunca grava por cima', () => {
  const plano = (valor: string | null) =>
    planejarCamposSdr({
      campo: (nome) => (nome === CAMPOS_SDR.TIPO_LEAD ? { valor, opcoes: ['Resgate', 'Cadastro', 'TRANSFERIDO DE OUTRA UNIDADE'] } : null),
      nome: 'Maria 10/03/26',
      criadoEmEpoch: AGORA - 20 * DIA,
      primeiroContatoEpoch: null,
      referenciaEpoch: AGORA,
      primeiraVez: true,
      consulta: { categoryName: 'AVALIAÇÃO', idStatus: 1, modifiedBy: null },
      feitoPelaIa: false,
      tratamento: null,
    }).filter((r) => r.campo === CAMPOS_SDR.TIPO_LEAD);
  // o cálculo do agendamento (nome com data de março) diria Resgate; a chegada gravou Cadastro: diverge, sem escrever
  assert.deepEqual(plano('Cadastro').map((r) => r.acao), ['diverge']);
  assert.deepEqual(plano('Resgate').map((r) => r.acao), ['confere']);
  // vazio (a chegada não gravou): o agendamento ainda preenche o buraco
  assert.deepEqual(plano(null).map((r) => r.acao), ['gravar']);
});
