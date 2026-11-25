/**
 * Leitura da Kommo para o histórico (escopo B): quem entra, o contato, a conversa e o relatório do seco — contra uma Kommo de mentira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KommoLead, KommoPipeline, KommoTalk, KommoTalkMessage } from '../services/kommo.service.js';
import { exportar, inicioDosFechados, lerConversa, lerSelecao, MAX_PAGINAS, POR_PAGINA, type Ambiente, type PortaKommo } from './kommo-historico-leitura.js';
import { linhaDoCartao, type LinhaDoCartao } from './kommo-historico-crm.js';

const AGORA = new Date('2026-11-25T15:00:00Z');
const SEG = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const PIPES: KommoPipeline[] = [
  { id: 1, name: 'COMERCIAL', statuses: [{ id: 9, name: 'Incoming leads', type: 1 }, { id: 10, name: 'EM QUALIFICAÇÃO' }, { id: 11, name: 'AGENDADO' }, { id: 142, name: 'GANHO / CONCLUÍDO' }, { id: 143, name: 'PERDIDO' }] } as KommoPipeline,
  { id: 2, name: 'TRATAMENTO', statuses: [{ id: 20, name: 'EM TRATAMENTO' }, { id: 142, name: 'ALTA' }, { id: 143, name: 'TRATAMENTO CANCELADO' }] } as KommoPipeline,
];

function lead(id: number, pipeline: number, status: number, extra: Partial<KommoLead> = {}): KommoLead {
  return { id, name: `Lead ${id}`, status_id: status, pipeline_id: pipeline, created_at: SEG('2026-10-01T00:00:00Z'), updated_at: SEG('2026-11-20T00:00:00Z'), ...extra } as KommoLead;
}

interface Chamadas { abertas: number; fechadas: number; talks: number; msgs: number }

function kommoDeMentira(leads: KommoLead[], opcoes: { telefones?: Record<number, string | null>; semConversa?: Set<number>; msgsPorLead?: number } = {}) {
  const c: Chamadas = { abertas: 0, fechadas: 0, talks: 0, msgs: 0 };
  const paginar = (lista: KommoLead[], page: number) => lista.slice((page - 1) * POR_PAGINA, page * POR_PAGINA);
  const porta: PortaKommo = {
    listPipelines: async () => PIPES,
    listLossReasons: async () => [{ id: 900, name: 'Sem interesse' }],
    listUsers: async () => [{ id: 5, name: 'Camily' }],
    // como a Kommo de verdade: a lista geral NÃO traz a etapa «Incoming leads»
    listLeadsPagina: async (page) => (c.abertas++, paginar([...leads].filter((l) => l.status_id !== 9).sort((x, y) => y.id - x.id), page)),
    listLeadsAbertosPagina: async (etapas, page = 1) => paginar(leads.filter((l) => etapas.some((e) => e.pipelineId === l.pipeline_id && e.statusId === l.status_id)).sort((x, y) => y.id - x.id), page),
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

test('janela dos fechados: hoje menos 6 meses de calendário, com o dia limitado ao último do mês de destino', () => {
  assert.equal(inicioDosFechados(AGORA), SEG('2026-05-25T15:00:00Z'));
  assert.equal(inicioDosFechados(new Date('2026-08-31T10:00:00Z')), SEG('2026-02-28T10:00:00Z'), '31/08 − 6 meses = 28/02 (e não 03/03)');
  assert.equal(inicioDosFechados(new Date('2026-03-31T10:00:00Z')), SEG('2025-09-30T10:00:00Z'));
  assert.equal(inicioDosFechados(new Date('2026-02-10T10:00:00Z')), SEG('2025-08-10T10:00:00Z'), 'vira o ano');
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

test('a seleção vem do mais recente para o mais velho', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10, { updated_at: 10 }), lead(2, 1, 10, { updated_at: 30 }), lead(3, 1, 10, { updated_at: 20 })]);
  assert.deepEqual((await lerSelecao(amb)).cartoes.map((c) => c.id), [2, 3, 1]);
});

test('--limite vale DEPOIS de tirar quem não tem telefone: os N mais recentes QUE TÊM telefone (não grava menos que o pedido)', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10, { updated_at: 10 }), lead(2, 1, 10, { updated_at: 40 }), lead(3, 1, 10, { updated_at: 30 }), lead(4, 1, 10, { updated_at: 20 })], { telefones: { 2: null, 3: '12' } });
  const linhas: LinhaDoCartao[] = [];
  const r = await exportar(amb, { gravar: true, limite: 2, entregar: (l) => linhas.push(l) });
  assert.deepEqual(linhas.map((l) => l.lead_id), [4, 1], 'os mais recentes (2 e 3) estão sem telefone utilizável: entram o 4 e o 1');
  assert.equal(r.cartoes, 4, 'o relatório conta a seleção inteira');
});

test('paginação completa (mais de 250 cartões) e o TETO de páginas lança em vez de cortar calado', async () => {
  const muitos = Array.from({ length: POR_PAGINA + 40 }, (_, i) => lead(i + 1, 1, 10));
  const { amb, c } = kommoDeMentira(muitos);
  assert.equal((await lerSelecao(amb)).cartoes.length, POR_PAGINA + 40);
  assert.equal(c.abertas, 4, '2 páginas × 2 passadas');
  const infinita: Ambiente = { ...amb, porta: { ...amb.porta, listLeadsPagina: async () => Array.from({ length: POR_PAGINA }, (_, i) => lead(i + 1, 1, 10)) } };
  await assert.rejects(() => lerSelecao(infinita), /passou de \d+ páginas: leitura incompleta/);
  assert.ok(MAX_PAGINAS >= 40);
});

test('cartão que MUDA de etapa no meio da leitura não se perde nem se repete (leitura por id, todas as etapas de uma vez)', async () => {
  const muitos = Array.from({ length: POR_PAGINA + 20 }, (_, i) => lead(i + 1, 1, 10));
  const { amb } = kommoDeMentira(muitos);
  let chamada = 0;
  const mexendo: Ambiente = {
    ...amb,
    porta: {
      ...amb.porta,
      listLeadsPagina: async (page) => {
        const r = await amb.porta.listLeadsPagina(page);
        if (++chamada === 1) {
          // depois da 1ª página: um cartão da 2ª página vai para PERDIDO (fechado agora) e um da 1ª é editado
          muitos[5]!.status_id = 143;
          muitos[5]!.closed_at = SEG('2026-11-24T00:00:00Z');
          muitos[3]!.updated_at = SEG('2026-11-25T00:00:00Z');
        }
        return r;
      },
    },
  };
  const s = await lerSelecao(mexendo);
  assert.equal(s.cartoes.length, muitos.length, 'todos aparecem, nenhum duplicado');
  assert.equal(new Set(s.cartoes.map((c) => c.id)).size, muitos.length);
});

test('a etapa «Incoming leads» (que a lista geral não devolve) também entra', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 9), lead(2, 1, 10)]);
  const s = await lerSelecao(amb);
  assert.deepEqual(s.cartoes.map((c) => c.id).sort(), [1, 2]);
  assert.equal(s.cartoes.find((c) => c.id === 1)!.etapa, 'Incoming leads');
});

test('a leitura FALHA: o erro sobe (página vazia quer dizer «acabou», nunca «deu erro»)', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  const quebrada: Ambiente = { ...amb, porta: { ...amb.porta, listLeadsPagina: async () => { throw new Error('kommo fora do ar'); } } };
  await assert.rejects(() => lerSelecao(quebrada), /kommo fora do ar/);
});

test('conversa: as mais recentes primeiro, até 5 conversas; 403/404 (sem conversa) = null', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  assert.equal((await lerConversa(amb, 1))!.length, 3);
  for (const status of [403, 404]) {
    const sem: Ambiente = { ...amb, porta: { ...amb.porta, listTalks: async () => { throw Object.assign(new Error('x'), { status }); } } };
    assert.equal(await lerConversa(sem, 2), null, `http ${status}`);
  }
});

test('conversa lida em PÁGINAS de 100: as «últimas 50» são as últimas de verdade e o total conta tudo', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  const todas = Array.from({ length: 250 }, (_, i) => ({ id: `x${i}`, type: 'incoming', text: `t${i}`, created_at: 1000 + i, author: { type: 'external' } }) as KommoTalkMessage);
  const paginas: number[] = [];
  const longa: Ambiente = { ...amb, porta: { ...amb.porta, listTalkMessages: async (_t, limite = 100, page = 1) => (paginas.push(page), todas.slice((page - 1) * limite, page * limite)) } };
  const msgs = (await lerConversa(longa, 1))!;
  assert.equal(msgs.length, 250);
  assert.deepEqual(paginas, [1, 2, 3]);
  const linha = linhaDoCartao({ id: 1, nome: 'A', funil: 'COMERCIAL', etapa: 'AGENDADO', statusId: 11, preco: 0, criadoEm: 1, atualizadoEm: 2, fechadoEm: null, responsavel: null, motivoPerda: null, etiquetas: [], campos: [] }, { id: 1, nome: 'A', telefone: '47991234567' }, msgs, AGORA);
  assert.equal(linha.mensagens_total, 250);
  assert.equal(linha.mensagens[0]!.id, 'x200');
  assert.equal(linha.mensagens.at(-1)!.id, 'x249');
  assert.ok(linha.nota.includes('as 50 últimas de 250 mensagens'));
});

test('conversa com 2 talks: a 2ª dá 404, mas as mensagens da 1ª, já lidas, ficam', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  const duas: Ambiente = {
    ...amb,
    porta: {
      ...amb.porta,
      listTalks: async () => [{ talk_id: 1, updated_at: 9 } as KommoTalk, { talk_id: 2, updated_at: 5 } as KommoTalk],
      listTalkMessages: async (talkId) => {
        if (talkId === 2) throw Object.assign(new Error('x'), { status: 404 });
        return [{ id: 'm1', type: 'x', text: 'oi', created_at: 1, author: { type: 'external' } } as KommoTalkMessage];
      },
    },
  };
  assert.equal((await lerConversa(duas, 1))!.length, 1);
});

test('exportar: cartão cuja conversa a Kommo engasgou sai com a nota «não entregou» e é CONTADO; 10 falhas seguidas param a exportação', async () => {
  const leads = Array.from({ length: 12 }, (_, i) => lead(i + 1, 1, 10));
  const { amb } = kommoDeMentira(leads);
  const engasga = (quantos: number): Ambiente => {
    let n = 0;
    return { ...amb, pausa: async () => undefined, porta: { ...amb.porta, listTalks: async (id) => { if (n++ < quantos * 3) throw Object.assign(new Error('503'), { status: 503 }); return amb.porta.listTalks(id); } } };
  };
  const linhas: LinhaDoCartao[] = [];
  const r = await exportar(engasga(2), { gravar: true, entregar: (l) => linhas.push(l) });
  assert.equal(r.falhasDeLeitura, 2);
  assert.equal(linhas.filter((l) => l.nota.includes('a Kommo não entregou a conversa')).length, 2);
  assert.equal(linhas.length, 12, 'os cartões sem conversa lida também saem (com a nota dizendo a verdade)');
  await assert.rejects(() => exportar(engasga(99), { gravar: true, entregar: () => undefined }), /conversas seguidas sem leitura/);
});

test('conversa: erro que NÃO é «sem conversa» (429, 5xx, rede) é repetido e, se persistir, SOBE — nunca vira «nenhuma mensagem»', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  let falhas = 2;
  const engasga: Ambiente = { ...amb, porta: { ...amb.porta, listTalks: async (id) => { if (falhas-- > 0) throw Object.assign(new Error('429'), { status: 429 }); return amb.porta.listTalks(id); } } };
  assert.equal((await lerConversa(engasga, 1))!.length, 3, 'passou na 3ª tentativa');
  const sempre: Ambiente = { ...amb, porta: { ...amb.porta, listTalks: async () => { throw Object.assign(new Error('503'), { status: 503 }); } } };
  await assert.rejects(() => lerConversa(sempre, 1), /503/);
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

test('exportar conta quantas conversas NASCEM vivas pela regra de arquivo real (consulta de pé) — pode ser > 0 — e o relatório traz a conta', async () => {
  const { ehArquivo } = await import('./chatwoot-regua.js');
  const campoConsulta = (iso: string) => [{ field_id: 1, field_name: '◷ Data da Consulta', field_type: 'date', values: [{ value: SEG(iso) }] }, { field_id: 2, field_name: '✓ Situação da consulta', field_type: 'select', values: [{ value: 'Agendado' }] }];
  // 1: AGENDADO com consulta de hoje em diante (nasce VIVO); 2: AGENDADO com consulta de 4 meses atrás (arquivo); 3: PERDIDO (arquivo); 4: em qualificação sem consulta (arquivo)
  const { amb } = kommoDeMentira([
    lead(1, 1, 11, { custom_fields_values: campoConsulta('2026-11-28T03:00:00Z') as KommoLead['custom_fields_values'] }),
    lead(2, 1, 11, { custom_fields_values: campoConsulta('2026-07-01T03:00:00Z') as KommoLead['custom_fields_values'] }),
    lead(3, 1, 143, { closed_at: SEG('2026-11-01T00:00:00Z') }),
    lead(4, 1, 10),
  ]);
  const r = await exportar(amb, { gravar: false, arquivo: ehArquivo, entregar: () => undefined });
  assert.equal(r.nascemVivas, 1, 'só o AGENDADO com consulta de pé nasce vivo — a conta PODE ser > 0 (antes a regra tornava o número sempre 0)');
  const r0 = await exportar(amb, { gravar: false, arquivo: () => true, entregar: () => undefined });
  assert.equal(r0.nascemVivas, 0);
  const rTodas = await exportar(amb, { gravar: false, arquivo: () => false, entregar: () => undefined });
  assert.equal(rTodas.nascemVivas, 4);
});

test('o seco mede o DESTINO e o TOPO: consulta de pé vem na frente no mesmo telefone (0 fora do destino) e as vivas cabem nas 200 do quadro', async () => {
  const { ehArquivo } = await import('./chatwoot-regua.js');
  const consulta = (iso: string, situacao = 'Agendado') => [{ field_id: 1, field_name: '◷ Data da Consulta', field_type: 'date_time', values: [{ value: SEG(iso) }] }, { field_id: 2, field_name: '✓ Situação da consulta', field_type: 'select', values: [{ value: situacao }] }] as KommoLead['custom_fields_values'];
  // mesmo telefone: um AGENDADO com consulta de pé (atualizado há tempos) e um cartão aberto mais NOVO sem consulta
  const mesmo = '47991230000';
  const { amb } = kommoDeMentira([
    lead(1, 1, 11, { updated_at: SEG('2026-11-01T00:00:00Z'), custom_fields_values: consulta('2026-11-28T13:00:00Z') }),
    lead(2, 1, 10, { updated_at: SEG('2026-11-24T00:00:00Z') }),
    lead(3, 1, 11, { updated_at: SEG('2026-11-02T00:00:00Z'), custom_fields_values: consulta('2026-11-29T13:00:00Z') }), // 2ª consulta de pé do mesmo paciente
  ], { telefones: { 1: mesmo, 2: mesmo, 3: mesmo } });
  const r = await exportar(amb, { gravar: false, arquivo: ehArquivo, entregar: () => undefined });
  assert.equal(r.consultaDePeForaDoDestino, 0, 'a consulta de pé está na frente do aberto mais novo: o destino é uma consulta de pé');
  assert.equal(r.telefonesComVariasConsultasDePe, 1, 'duas consultas de pé no mesmo telefone: só uma é o destino (aviso para olhar)');
  assert.equal(r.nascemVivas, 2);
  // 250 cartões AGENDADOS com consulta de pé: nascem vivas e vão ao topo; 200 cabem no quadro, 50 não
  const muitos = Array.from({ length: 250 }, (_, i) => lead(i + 1, 1, 11, { updated_at: SEG('2026-11-20T00:00:00Z') + i, custom_fields_values: consulta('2026-11-28T13:00:00Z') }));
  const r2 = await exportar(kommoDeMentira(muitos).amb, { gravar: false, arquivo: ehArquivo, entregar: () => undefined });
  assert.equal(r2.nascemVivas, 250);
  assert.equal(r2.vivasForaDoTopo, 50, 'o quadro/Hoje leem 200: as outras 50 vivas não apareceriam');
  const poucas = await exportar(kommoDeMentira(muitos.slice(0, 12)).amb, { gravar: false, arquivo: ehArquivo, entregar: () => undefined });
  assert.equal(poucas.vivasForaDoTopo, 0);
  // vivas misturadas a 400 arquivadas mais recentes: como as vivas nascem com a hora da importação, ficam NO TOPO (0 fora)
  const mistura = [...muitos.slice(0, 12), ...Array.from({ length: 400 }, (_, i) => lead(1000 + i, 1, 10, { updated_at: SEG('2026-11-25T14:00:00Z') }))];
  const rm = await exportar(kommoDeMentira(mistura).amb, { gravar: false, arquivo: ehArquivo, entregar: () => undefined });
  assert.equal(rm.nascemVivas, 12);
  assert.equal(rm.vivasForaDoTopo, 0);
});

test('lista opcional (motivos de perda e usuários): 403 é engolido com aviso; 5xx/429 repete e, se persistir, SOBE o erro', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 10)]);
  const avisos: string[] = [];
  const sem403: Ambiente = { ...amb, log: (t) => avisos.push(t), porta: { ...amb.porta, listUsers: async () => { throw Object.assign(new Error('x'), { status: 403 }); } } };
  assert.equal((await lerSelecao(sem403)).cartoes.length, 1);
  assert.ok(avisos.some((a) => a.includes('usuários indisponível')));
  let chamadas = 0;
  const engasgada: Ambiente = { ...amb, porta: { ...amb.porta, listLossReasons: async () => { chamadas++; throw Object.assign(new Error('x'), { status: 502 }); } } };
  await assert.rejects(() => lerSelecao(engasgada));
  assert.equal(chamadas, 3, 'tentou 3 vezes antes de subir o erro');
});

test('cartão APAGADO no meio da paginação não faz a leitura pular o seguinte: a 2ª passada recupera e a conta diz quantos', async () => {
  const muitos = Array.from({ length: POR_PAGINA * 2 + 10 }, (_, i) => lead(i + 1, 1, 10));
  const { amb } = kommoDeMentira(muitos);
  // lista por id decrescente: a página 1 traz os ids 510..261; DEPOIS de lê-la, o cartão 300 (já na página 2) é apagado e... o que desliza é o da fronteira
  let viva = [...muitos].sort((x, y) => y.id - x.id);
  let passada1 = true;
  let paginasLidas = 0;
  const porta: PortaKommo = {
    ...amb.porta,
    listLeadsPagina: async (page) => {
      const fatia = viva.slice((page - 1) * POR_PAGINA, page * POR_PAGINA);
      if (passada1 && page === 1) viva = viva.filter((l) => l.id !== 400); // apagado logo depois de a página 1 ser entregue (id 400 está nela)
      if (page === 3) passada1 = false;
      paginasLidas++;
      return fatia;
    },
  };
  const sel = await lerSelecao({ ...amb, porta });
  // sem a 2ª passada, o cartão que estava no topo da página 2 (id 260) deslizou para a página 1 já lida e sumiria
  assert.equal(sel.cartoes.length, muitos.length, 'todos, sem repetir (o apagado já tinha sido lido na 1ª passada: existia quando a leitura começou)');
  assert.ok(sel.cartoes.some((c) => c.id === 260), 'o cartão da fronteira foi recuperado');
  assert.equal(sel.recuperadosNaPaginacao, 1);
  assert.ok(paginasLidas >= 6, 'duas passadas de 3 páginas');
});

test('o relatório conta os avisos (etapa sem coluna, perdido sem motivo) sem texto de paciente', async () => {
  const { amb } = kommoDeMentira([lead(1, 1, 143, { closed_at: SEG('2026-11-01T00:00:00Z') })]);
  const r = await exportar(amb, { gravar: true, entregar: () => undefined });
  assert.equal(r.avisos['perdido-sem-motivo-mapeavel'], 1);
});
