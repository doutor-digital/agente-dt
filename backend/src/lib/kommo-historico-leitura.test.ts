/**
 * Leitura da Kommo para o histórico (escopo B): quem entra, o contato, a conversa e o relatório do seco — contra uma Kommo de mentira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KommoLead, KommoPipeline, KommoTalk, KommoTalkMessage } from '../services/kommo.service.js';
import { exportar, inicioDosFechados, lerConversa, lerSelecao, MAX_PAGINAS, POR_PAGINA, type Ambiente, type PortaKommo } from './kommo-historico-leitura.js';
import type { LinhaDoCartao } from './kommo-historico-crm.js';

const AGORA = new Date('2026-11-25T15:00:00Z');
const SEG = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const PIPES: KommoPipeline[] = [
  { id: 1, name: 'COMERCIAL', statuses: [{ id: 10, name: 'EM QUALIFICAÇÃO' }, { id: 11, name: 'AGENDADO' }, { id: 142, name: 'GANHO / CONCLUÍDO' }, { id: 143, name: 'PERDIDO' }] } as KommoPipeline,
  { id: 2, name: 'TRATAMENTO', statuses: [{ id: 20, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] } as KommoPipeline,
];

function lead(id: number, pipeline: number, status: number, extra: Partial<KommoLead> = {}): KommoLead {
  return { id, name: `Lead ${id}`, status_id: status, pipeline_id: pipeline, created_at: SEG('2026-10-01T00:00:00Z'), updated_at: SEG('2026-11-20T00:00:00Z'), ...extra } as KommoLead;
}

interface Chamadas { abertas: number; fechadas: number; talks: number; msgs: number }

function kommoDeMentira(leads: KommoLead[], opcoes: { telefones?: Record<number, string | null>; semConversa?: Set<number>; msgsPorLead?: number } = {}) {
  const c: Chamadas = { abertas: 0, fechadas: 0, talks: 0, msgs: 0 };
  const abertos = leads.filter((l) => l.status_id !== 142 && l.status_id !== 143);
  const fechados = leads.filter((l) => l.status_id === 142 || l.status_id === 143);
  const paginar = (lista: KommoLead[], page: number) => lista.slice((page - 1) * POR_PAGINA, page * POR_PAGINA);
  const porta: PortaKommo = {
    listPipelines: async () => PIPES,
    listLossReasons: async () => [{ id: 900, name: 'Sem interesse' }],
    listUsers: async () => [{ id: 5, name: 'Camily' }],
    listLeadsAbertosPagina: async (_e, page = 1) => (c.abertas++, paginar(abertos, page)),
    listLeadsDasEtapasDesde: async (_e, desde, page = 1) => (c.fechadas++, paginar(fechados.filter((l) => (l.updated_at ?? 0) >= desde), page)),
    listLeadsPorIds: async (ids) => leads.filter((l) => ids.includes(l.id)).map((l) => ({ ...l, _embedded: { contacts: [{ id: 1000 + l.id, is_main: true }] } })),
    contatosBasicos: async (ids) => new Map(ids.map((i) => [i, { nome: `Paciente ${i - 1000}`, telefone: opcoes.telefones && (i - 1000) in opcoes.telefones ? opcoes.telefones[i - 1000]! : `4799${String(i).padStart(7, '0')}` }])),
    listTalks: async (id) => {
      c.talks++;
      if (opcoes.semConversa?.has(id)) throw new Error('403');
      return [{ talk_id: id * 10, updated_at: 5 } as KommoTalk];
    },
    listTalkMessages: async (talkId) => {
      c.msgs++;
      return Array.from({ length: opcoes.msgsPorLead ?? 3 }, (_, i) => ({ id: `${talkId}-${i}`, type: 'x', text: `m${i}`, created_at: 100 + i, author: { type: i % 2 ? 'internal' : 'external' } }) as KommoTalkMessage);
    },
  };
  const amb: Ambiente = { porta, pausa: async () => undefined, agora: () => AGORA, log: () => undefined };
  return { amb, c };
}

test('janela dos fechados: hoje menos 6 meses de calendário', () => {
  assert.equal(inicioDosFechados(AGORA), SEG('2026-05-25T15:00:00Z'));
  assert.equal(inicioDosFechados(new Date('2026-08-31T10:00:00Z')), SEG('2026-03-03T10:00:00Z') /* 31/02 vira 03/03 */);
});

test('escopo B: todos os abertos (os dois funis) + ganhos/perdidos fechados nos últimos 6 meses; fechado mais velho fica fora', () => {
  const { amb } = kommoDeMentira([
    lead(1, 1, 10), lead(2, 1, 11), lead(3, 2, 20),
    lead(4, 1, 142, { closed_at: SEG('2026-10-01T00:00:00Z') }),
    lead(5, 1, 143, { closed_at: SEG('2026-06-01T00:00:00Z') }),
    lead(6, 2, 142, { closed_at: SEG('2026-04-01T00:00:00Z'), updated_at: SEG('2026-11-01T00:00:00Z') }), // updated recente, FECHADO há 7 meses
  ]);
  return lerSelecao(amb).then((s) => {
    assert.deepEqual(s.cartoes.map((c) => c.id).sort(), [1, 2, 3, 4, 5]);
    assert.equal(s.fechadosForaDaJanela, 1);
    const c4 = s.cartoes.find((c) => c.id === 4)!;
    assert.equal(c4.funil, 'COMERCIAL');
    assert.equal(c4.etapa, 'GANHO / CONCLUÍDO');
    assert.equal(s.cartoes.find((c) => c.id === 6), undefined);
  });
});

test('cartão: funil e etapa por nome, responsável, motivo de perda nativo e campos com nome e tipo', async () => {
  const l = lead(7, 1, 143, { closed_at: SEG('2026-11-10T00:00:00Z'), responsible_user_id: 5, loss_reason_id: 900, price: 100, custom_fields_values: [{ field_id: 1, field_name: '✓ Situação da consulta', field_type: 'select', values: [{ value: 'Agendado' }] }] });
  const { amb } = kommoDeMentira([l]);
  const c = (await lerSelecao(amb)).cartoes[0]!;
  assert.equal(c.responsavel, 'Camily');
  assert.equal(c.motivoPerda, 'Sem interesse');
  assert.equal(c.preco, 100);
  assert.deepEqual(c.campos, [{ nome: '✓ Situação da consulta', tipo: 'select', valor: 'Agendado' }]);
});

test('--limite: só os N mais recentes (os fechados também entram na conta)', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10, { updated_at: 10 }), lead(2, 1, 10, { updated_at: 30 }), lead(3, 1, 10, { updated_at: 20 })]);
  const s = await lerSelecao(amb, { limite: 2 });
  assert.deepEqual(s.cartoes.map((c) => c.id), [2, 3]);
});

test('paginação completa (mais de 250 cartões) e o TETO de páginas lança em vez de cortar calado', async () => {
  const muitos = Array.from({ length: POR_PAGINA + 40 }, (_, i) => lead(i + 1, 1, 10));
  const { amb, c } = kommoDeMentira(muitos);
  assert.equal((await lerSelecao(amb)).cartoes.length, POR_PAGINA + 40);
  assert.equal(c.abertas, 2);
  const infinita: Ambiente = { ...amb, porta: { ...amb.porta, listLeadsAbertosPagina: async () => Array.from({ length: POR_PAGINA }, (_, i) => lead(i + 1, 1, 10)) } };
  await assert.rejects(() => lerSelecao(infinita), /passou de \d+ páginas: leitura incompleta/);
  assert.ok(MAX_PAGINAS >= 40);
});

test('a leitura FALHA: o erro sobe (página vazia quer dizer «acabou», nunca «deu erro»)', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  const quebrada: Ambiente = { ...amb, porta: { ...amb.porta, listLeadsAbertosPagina: async () => { throw new Error('kommo fora do ar'); } } };
  await assert.rejects(() => lerSelecao(quebrada), /kommo fora do ar/);
});

test('conversa: as mais recentes primeiro, até 5 conversas; Kommo que não entrega = null (nunca derruba)', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)], { semConversa: new Set([2]) });
  assert.equal((await lerConversa(amb, 1))!.length, 3);
  assert.equal(await lerConversa(amb, 2), null);
});

test('exportar GRAVAR: uma linha por cartão COM telefone, conversa lida, contagens do relatório', async () => {
  const { amb } = kommoDeMentira(
    [lead(1, 1, 10), lead(2, 1, 11), lead(3, 2, 20), lead(4, 1, 11), lead(5, 1, 143, { closed_at: SEG('2026-11-01T00:00:00Z') })],
    { telefones: { 2: null, 3: '12', 4: '47991230001', 1: '47991230001' } }, // 4 e 1 = MESMO telefone em dois cartões
  );
  const linhas: LinhaDoCartao[] = [];
  const r = await exportar(amb, { gravar: true, entregar: (l) => linhas.push(l) });
  assert.equal(r.cartoes, 5);
  assert.equal(r.abertos, 4);
  assert.equal(r.fechados, 1);
  assert.equal(r.semTelefone, 1);
  assert.equal(r.telefoneInvalido, 1);
  assert.equal(r.telefonesRepetidos, 1);
  assert.equal(r.porEtapa['COMERCIAL › AGENDADO'], 2);
  assert.deepEqual(linhas.map((l) => l.lead_id).sort(), [1, 4, 5].sort(), 'só quem tem telefone utilizável (5 tem o número gerado pela mentira)');
  assert.equal(r.linhasGravadas, linhas.length);
  assert.ok(linhas.every((l) => l.mensagens.length === 3));
});

test('exportar SECO: não entrega linha nenhuma, lê só uma amostra das conversas e estima mensagens e duração', async () => {
  const leads = Array.from({ length: 100 }, (_, i) => lead(i + 1, 1, 10));
  const { amb, c } = kommoDeMentira(leads, { msgsPorLead: 4 });
  let t = 0;
  const comRelogio: Ambiente = { ...amb, pausa: async () => { t += 0.25; } };
  const r = await exportar(comRelogio, { gravar: false, entregar: () => assert.fail('o seco não entrega linha') });
  assert.equal(r.cartoes, 100);
  assert.ok(r.amostra > 0 && r.amostra <= 31, `amostra ${r.amostra}`);
  assert.equal(c.talks, r.amostra, 'só leu as conversas da amostra');
  assert.equal(r.mensagensEstimadas, 400, '4 por cartão × 100 cartões');
  assert.equal(r.linhasGravadas, 0);
});

test('o relatório conta os avisos (etapa sem coluna, perdido sem motivo) sem texto de paciente', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 143, { closed_at: SEG('2026-11-01T00:00:00Z') })]);
  const r = await exportar(amb, { gravar: true, entregar: () => undefined });
  assert.equal(r.avisos['perdido-sem-motivo-mapeavel'], 1);
});
