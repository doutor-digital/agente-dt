/**
 * Ligação pelo WhatsApp — o caminho inteiro com Meta, Kommo e banco FALSOS: pedir permissão, ligar, receber o
 * webhook, encerrar, registrar no cartão, travar o paciente e o vigia pausar a fila. Nenhuma chamada sai daqui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encerrarLigacao,
  estadoDaLigacao,
  fecharSemRetorno,
  iniciarLigacao,
  marcarPergunta,
  montarFila,
  montarPainel,
  pedirPermissao,
  receberEventos,
  type Contexto,
  type KommoLigacoes,
  type LinhaConfig,
  type LinhaLigacao,
  type LinhaPaciente,
  type MetaLigacoes,
  type Repositorio,
} from './ligacao-whatsapp-servico.js';
import { lerWebhookDeLigacoes, type PermissaoNaMeta } from './ligacao-whatsapp-meta.js';

const UNIT = { id: 'u1', slug: 'doutor-hernia-acailandia', nome: 'Doutor Hérnia Açailândia', tz: 'America/Sao_Paulo' };
const TEL_JOAO = '5563991021043';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';

// ── banco falso ──

function repoFalso() {
  const ligacoes = new Map<string, LinhaLigacao>();
  const pacientes = new Map<string, LinhaPaciente>();
  let config: LinhaConfig | null = null;
  let seq = 0;
  const repo: Repositorio = {
    async config() { return config; },
    async paciente(_u, chave) { return pacientes.get(chave) ?? null; },
    async salvarPaciente(unitId, chave, dados) {
      const atual = pacientes.get(chave) ?? {
        unitId, chaveTelefone: chave, telefone: dados.telefone, leadId: null, nome: null, permissao: 'sem', permissaoAte: null, permanente: false,
        respondeuEm: null, pedidosEm: [], conferidaEm: null, perguntouEm: null, naoAtendidasSeguidas: 0, ultimaNaoAtendidaEm: null, ultimaLigacaoEm: null, ultimoResultado: null,
      };
      const novo = { ...atual, ...dados } as LinhaPaciente;
      pacientes.set(chave, novo);
      return novo;
    },
    async criarLigacao(d) {
      const id = `lig${++seq}`;
      const agora = relogio.agora;
      const l: LinhaLigacao = {
        ...d, id, waCallId: null, status: 'iniciando', resultado: null, sdpResposta: null, tocouEm: null, atendidaEm: null, encerradaEm: null,
        duracaoSeg: null, erro: null, registradaEm: null, kommoRegistro: null, criadaEm: agora, atualizadaEm: agora,
      };
      ligacoes.set(id, l);
      return l;
    },
    async ligacao(id) { return ligacoes.get(id) ?? null; },
    async ligacaoPorWaId(w) { return [...ligacoes.values()].find((l) => l.waCallId === w) ?? null; },
    async atualizarLigacao(id, dados) {
      const l = { ...ligacoes.get(id)!, ...dados, atualizadaEm: relogio.agora };
      ligacoes.set(id, l);
      return l;
    },
    async reservarFinalizacao(id, quando) {
      const l = ligacoes.get(id);
      if (!l || l.registradaEm) return false;
      ligacoes.set(id, { ...l, registradaEm: quando });
      return true;
    },
    async aberta(_u, chave, desde) {
      return [...ligacoes.values()].filter((l) => l.chaveTelefone === chave && l.status !== 'encerrada' && l.criadaEm >= desde).pop() ?? null;
    },
    async ultima(_u, chave) { return [...ligacoes.values()].filter((l) => l.chaveTelefone === chave).pop() ?? null; },
    async resultadosEntre(_u, de, ate) {
      return [...ligacoes.values()].filter((l) => l.status === 'encerrada' && l.criadaEm >= de && l.criadaEm < ate).map((l) => l.resultado);
    },
    async pausarFila(_u, ate, motivo, agora) {
      if (config?.filaPausadaAte && config.filaPausadaAte > agora) return false;
      config = { ...(config ?? { taxaMinima: null, amostraMinima: null, maxSemAtender: null, textoPermissao: null, modeloPermissao: null, filaPausadaAte: null, filaPausadaMotivo: null }), filaPausadaAte: ate, filaPausadaMotivo: motivo };
      return true;
    },
    async comPermissao() { return [...pacientes.values()].filter((p) => p.permissao === 'aceita' && p.leadId); },
    async abertasParadas(antes) { return [...ligacoes.values()].filter((l) => l.status !== 'encerrada' && l.atualizadaEm < antes); },
  };
  return { repo, ligacoes, pacientes, setConfig: (c: Partial<LinhaConfig>) => { config = { taxaMinima: null, amostraMinima: null, maxSemAtender: null, textoPermissao: null, modeloPermissao: null, filaPausadaAte: null, filaPausadaMotivo: null, ...c }; } };
}

const relogio = { agora: new Date('2026-10-08T14:00:00Z') };
const avancar = (min: number) => { relogio.agora = new Date(relogio.agora.getTime() + min * 60_000); };

// ── Meta e Kommo falsos ──

function metaFalsa(permissao: PermissaoNaMeta) {
  const chamadas: Array<{ op: string; args: unknown[] }> = [];
  let n = 0;
  const meta: MetaLigacoes & { permissaoAtual: PermissaoNaMeta; recusarLigacao: number | null; recusarPedido: number | null } = {
    permissaoAtual: permissao,
    recusarLigacao: null,
    recusarPedido: null,
    async iniciar(para, sdp, opaco) {
      chamadas.push({ op: 'iniciar', args: [para, sdp, opaco] });
      if (meta.recusarLigacao) return { ok: false, codigo: meta.recusarLigacao, mensagem: 'x' };
      return { ok: true, dado: { callId: `wacid.${++n}` } };
    },
    async encerrar(callId) { chamadas.push({ op: 'encerrar', args: [callId] }); return { ok: true }; },
    async permissao(para) { chamadas.push({ op: 'permissao', args: [para] }); return { ok: true, dado: meta.permissaoAtual }; },
    async pedirPermissao(para, texto) {
      chamadas.push({ op: 'pedir', args: [para, texto] });
      if (meta.recusarPedido) return { ok: false, codigo: meta.recusarPedido };
      meta.permissaoAtual = { ...meta.permissaoAtual, podePedir: false }; // a Meta conta o pedido do lado dela
      return { ok: true };
    },
    async pedirPermissaoPorModelo(para, modelo) { chamadas.push({ op: 'modelo', args: [para, modelo] }); return { ok: true }; },
  };
  return { meta, chamadas };
}

function kommoFalso(telefone = '+55 63 99102-1043') {
  const registros: Array<Record<string, unknown>> = [];
  const notas: string[] = [];
  const tarefas: string[] = [];
  const estado = { ultimaMsg: null as number | null, registrarFalha: false };
  const kommo: KommoLigacoes = {
    async contatoDoLead() { return { contatoId: 900, telefone, nome: 'JOÃO TESTE 08/10/2026' }; },
    async ultimaMensagemDesde(_c, desde) { return estado.ultimaMsg && estado.ultimaMsg >= desde ? estado.ultimaMsg : null; },
    async registrarChamada(corpo) {
      registros.push(corpo);
      return estado.registrarFalha ? { ids: [], erros: [{ detail: 'contato não encontrado' }] } : { ids: [555], erros: [] };
    },
    async nota(_l, t) { notas.push(t); },
    async tarefa(_l, t) { tarefas.push(t); },
  };
  return { kommo, registros, notas, tarefas, estado };
}

const ACEITA: PermissaoNaMeta = { estado: 'aceita', ate: new Date('2026-10-15T14:00:00Z'), permanente: false, podeLigar: true, podePedir: false };
const SEM: PermissaoNaMeta = { estado: 'sem', ate: null, permanente: false, podeLigar: false, podePedir: true };

function montar(opts: { modo?: Contexto['modo']; permissao?: PermissaoNaMeta; telefone?: string; teste?: string[] } = {}) {
  relogio.agora = new Date('2026-10-08T14:00:00Z');
  const b = repoFalso();
  const m = metaFalsa(opts.permissao ?? ACEITA);
  const k = kommoFalso(opts.telefone);
  const ctx: Contexto = {
    unit: UNIT, modo: opts.modo ?? 'ligado', meta: m.meta, kommo: k.kommo, repo: b.repo,
    numerosDeTeste: opts.teste ?? ['91021043'], gravar: false, agora: () => relogio.agora, log: () => undefined,
  };
  return { ctx, ...b, ...m, ...k };
}

/** A SDR perguntou "Posso te ligar agora?" e o paciente respondeu em seguida. */
async function combinar(t: { ctx: Contexto; estado: { ultimaMsg: number | null } }) {
  await marcarPergunta(t.ctx, 1);
  t.estado.ultimaMsg = Math.floor(relogio.agora.getTime() / 1000);
}

async function ligarEAcabar(t: ReturnType<typeof montar>, como: 'atende' | 'nao-atende' | 'recusa', confirmar = true) {
  const r = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: confirmar });
  assert.equal(r.ok, true, JSON.stringify(r));
  const l = await t.repo.ligacao((r as { ligacaoId: string }).ligacaoId);
  const callId = l!.waCallId!;
  const ev: Array<Record<string, unknown>> = [{ id: callId, event: 'connect', timestamp: '1', session: { sdp_type: 'answer', sdp: 'v=0\r\nanswer' } }];
  await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, calls: ev, statuses: [{ id: callId, type: 'call', status: 'RINGING', timestamp: '2' }] } }] }] }));
  if (como === 'atende') await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, statuses: [{ id: callId, type: 'call', status: 'ACCEPTED', timestamp: '3' }] } }] }] }));
  if (como === 'recusa') await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, statuses: [{ id: callId, type: 'call', status: 'REJECTED', timestamp: '3' }] } }] }] }));
  await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, calls: [{ id: callId, event: 'terminate', status: 'COMPLETED', duration: como === 'atende' ? 95 : 0, timestamp: '4' }] } }] }] }));
  return (await t.repo.ligacao(l!.id))!;
}

// ── os testes ──

test('pedir permissão: manda a interativa, guarda o horário, nota no cartão e respeita 1 por 24 h', async () => {
  const t = montar({ permissao: SEM });
  const r = await pedirPermissao(t.ctx, { leadId: 1, kommoUserId: 77, nomeSdr: 'Giulia' });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(t.chamadas.filter((c) => c.op === 'pedir').length, 1);
  assert.equal(t.chamadas.find((c) => c.op === 'pedir')!.args[0], TEL_JOAO, 'telefone vem do contato do cartão, no formato da Meta');
  assert.equal(t.pacientes.get('91021043')!.permissao, 'pedida');
  assert.equal(t.notas.length, 1, 'a mensagem da Meta não aparece no chat do Kommo: vira nota');
  const r2 = await pedirPermissao(t.ctx, { leadId: 1, kommoUserId: 77, nomeSdr: 'Giulia' });
  assert.equal(r2.ok, false);
  assert.match(r2.motivo, /1 pedido por dia/);
  assert.equal(t.chamadas.filter((c) => c.op === 'pedir').length, 1, 'o 2º pedido nem chega na Meta');
});

test('pedir permissão fora da janela: usa o modelo aprovado se a unidade tiver um', async () => {
  const t = montar({ permissao: SEM });
  t.meta.recusarPedido = 131047;
  const semModelo = await pedirPermissao(t.ctx, { leadId: 1, kommoUserId: null, nomeSdr: null });
  assert.equal(semModelo.ok, false);
  assert.match(semModelo.motivo, /janela de 24 h/);
  t.setConfig({ modeloPermissao: 'permissao_ligacao:pt_BR' });
  const comModelo = await pedirPermissao(t.ctx, { leadId: 1, kommoUserId: null, nomeSdr: null });
  assert.equal(comModelo.ok, true);
  assert.equal(comModelo.via, 'modelo');
});

test('modo "só no papel": paciente de verdade não recebe pedido nem ligação; o número de teste sim', async () => {
  const t = montar({ modo: 'seco', telefone: '+55 99 98888-7777' });
  const p = await pedirPermissao(t.ctx, { leadId: 1, kommoUserId: 77, nomeSdr: 'Giulia' });
  assert.equal(p.ok, false);
  await combinar(t);
  const l = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: true });
  assert.equal(l.ok, false);
  assert.equal(!l.ok && l.codigo, 'so-teste');
  assert.equal(t.chamadas.filter((c) => c.op === 'iniciar' || c.op === 'pedir').length, 0, 'nada saiu para a Meta');

  const j = montar({ modo: 'seco' }); // contato = número do João
  await combinar(j);
  const ok = await iniciarLigacao(j.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  assert.equal(ok.ok, true);
});

test('trava 1: sem resposta ao "Posso te ligar agora?" pede confirmação; com resposta liga direto', async () => {
  const t = montar();
  await marcarPergunta(t.ctx, 1);
  const semResposta = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  assert.equal(semResposta.ok, false);
  assert.equal(!semResposta.ok && semResposta.precisaConfirmar, true);
  assert.equal(t.chamadas.filter((c) => c.op === 'iniciar').length, 0);
  avancar(2);
  await combinar(t);
  const painel = await montarPainel(t.ctx, 1);
  assert.equal(painel.combinado.estado, 'respondeu');
  assert.equal(painel.decisao.ok, true, 'botão verde');
  const r = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.semCombinar, false);
  const enviada = t.chamadas.find((c) => c.op === 'iniciar')!;
  assert.deepEqual(enviada.args, [TEL_JOAO, SDP, (r as { ligacaoId: string }).ligacaoId]);
});

test('ligação atendida: resposta SDP chega ao navegador, registra no Kommo como "conversou" e zera o contador', async () => {
  const t = montar();
  await combinar(t);
  const r = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  const id = (r as { ligacaoId: string }).ligacaoId;
  const callId = (await t.repo.ligacao(id))!.waCallId!;
  await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, calls: [{ id: callId, event: 'connect', session: { sdp_type: 'answer', sdp: 'v=0\r\nresposta' } }] } }] }] }));
  const durante = await estadoDaLigacao(t.ctx, id);
  assert.equal(durante?.sdpResposta, 'v=0\r\nresposta', 'o navegador pega a resposta SDP pelo estado');

  t.pacientes.get('91021043')!.naoAtendidasSeguidas = 1;
  const l = await ligarEAcabar(t, 'atende');
  assert.equal(l.resultado, 'atendida');
  assert.equal(l.duracaoSeg, 95);
  assert.equal(l.sdpResposta, null, 'SDP apagado no fim');
  assert.equal(t.pacientes.get('91021043')!.naoAtendidasSeguidas, 0);
  const reg = t.registros[t.registros.length - 1];
  assert.equal(reg.call_status, 4);
  assert.equal(reg.duration, 95);
  assert.equal(reg.direction, 'outbound');
  assert.equal(reg.created_by, 77);
});

test('trava 2: duas sem atender travam o paciente; ele escrever libera uma; a 3ª trava de vez', async () => {
  const t = montar();
  const l1 = await ligarEAcabar(t, 'nao-atende');
  assert.equal(l1.resultado, 'nao_atendida');
  assert.equal(t.registros[0].call_status, 6);
  assert.match(String(t.registros[0].call_result), /1 de 2 sem atender/);
  avancar(10);
  const l2 = await ligarEAcabar(t, 'recusa');
  assert.equal(l2.resultado, 'recusada');
  assert.equal(t.pacientes.get('91021043')!.naoAtendidasSeguidas, 2);

  avancar(10);
  const travado = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: true });
  assert.equal(!travado.ok && travado.codigo, 'travado', 'confirmar o aviso não fura a trava');
  const painel = await montarPainel(t.ctx, 1);
  assert.equal(painel.trava.travado, true);

  avancar(5);
  await combinar(t); // paciente escreveu depois da última sem atender
  const l3 = await ligarEAcabar(t, 'nao-atende');
  assert.equal(l3.resultado, 'nao_atendida');
  avancar(5);
  await combinar(t);
  const firme = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: true });
  assert.equal(!firme.ok && firme.codigo, 'travado');
  assert.equal((await montarPainel(t.ctx, 1)).trava.firme, true);

  // permissão nova (o paciente aceitou de novo) recomeça a conta
  await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, messages: [{ from: TEL_JOAO, timestamp: '9', type: 'interactive', interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', expiration_timestamp: 1999999999 } } }] } }] }] }));
  assert.equal(t.pacientes.get('91021043')!.naoAtendidasSeguidas, 0);
});

test('a Meta recusa a ligação: vira "falhou", não conta como sem atender e não vai pro histórico', async () => {
  const t = montar();
  t.meta.recusarLigacao = 138006;
  await combinar(t);
  const r = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  assert.equal(r.ok, false);
  const l = [...t.ligacoes.values()][0];
  assert.equal(l.resultado, 'falhou');
  assert.equal(t.registros.length, 0);
  assert.equal(t.pacientes.get('91021043')!.naoAtendidasSeguidas, 0);
});

test('sem permissão na Meta: não liga, mesmo que o banco diga aceita', async () => {
  const t = montar();
  await montarPainel(t.ctx, 1); // grava "aceita"
  t.meta.permissaoAtual = SEM;
  await combinar(t);
  avancar(2);
  const r = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  assert.equal(!r.ok && r.codigo, 'sem-permissao');
  assert.equal(t.pacientes.get('91021043')!.permissao, 'caiu');
});

test('registro no Kommo: telefone que não casa vira nota no cartão; webhook repetido não registra duas vezes', async () => {
  const t = montar();
  t.estado.registrarFalha = true;
  const l = await ligarEAcabar(t, 'atende');
  assert.equal(l.kommoRegistro, 'nota');
  assert.equal(t.notas.length, 1);
  await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, calls: [{ id: l.waCallId, event: 'terminate', status: 'COMPLETED', duration: 95 }] } }] }] }));
  assert.equal(t.registros.length, 1, 'terminate repetido (retry da Meta) é ignorado');
});

test('trava 3: taxa do dia abaixo de 50% em 6 ligações pausa a fila e abre UMA tarefa de alerta', async () => {
  const t = montar();
  for (const como of ['atende', 'nao-atende', 'atende', 'nao-atende', 'nao-atende'] as const) {
    await combinar(t);
    await ligarEAcabar(t, como);
    t.pacientes.get('91021043')!.naoAtendidasSeguidas = 0; // isola a trava 2 deste teste
    avancar(3);
  }
  assert.equal(t.tarefas.length, 0, '5 ligações ainda não é amostra');
  await combinar(t);
  await ligarEAcabar(t, 'nao-atende'); // 2 de 6 = 33%
  assert.equal(t.tarefas.length, 1);
  assert.match(t.tarefas[0], /^ALERTA · doutor-hernia-acailandia · ☎ Hoje só 2 de 6/);
  const fila = await montarFila(t.ctx);
  assert.equal(fila.pausada, true);
  t.pacientes.get('91021043')!.naoAtendidasSeguidas = 0;
  avancar(3);
  await combinar(t);
  const daFila = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'fila', confirmouSemCombinar: false });
  assert.equal(!daFila.ok && daFila.codigo, 'fila-pausada');
  await ligarEAcabar(t, 'nao-atende'); // pelo cartão segue; outra não atendida não abre 2ª tarefa
  assert.equal(t.tarefas.length, 1);
});

test('fila "Ligar próximo": só quem tem permissão válida, sem trava e sem ligação nas últimas 2 h', async () => {
  const t = montar();
  await montarPainel(t.ctx, 1);
  let fila = await montarFila(t.ctx);
  assert.equal(fila.itens.length, 1);
  assert.equal(fila.itens[0].telefone, '…1043', 'a fila não mostra o telefone inteiro');
  await combinar(t);
  await ligarEAcabar(t, 'atende');
  fila = await montarFila(t.ctx);
  assert.equal(fila.itens.length, 0, 'acabou de ligar');
  avancar(3 * 60);
  fila = await montarFila(t.ctx);
  assert.equal(fila.itens.length, 1);
});

test('desligar antes de a Meta responder fecha a conta; ligação esquecida é fechada pelo vigia', async () => {
  const t = montar();
  await combinar(t);
  const r = await iniciarLigacao(t.ctx, { leadId: 1, sdp: SDP, kommoUserId: 77, nomeSdr: 'Giulia', origem: 'cartao', confirmouSemCombinar: false });
  const id = (r as { ligacaoId: string }).ligacaoId;
  await encerrarLigacao(t.ctx, id);
  assert.equal(t.chamadas.filter((c) => c.op === 'encerrar').length, 1, 'pede à Meta para encerrar');
  assert.equal((await t.repo.ligacao(id))!.status, 'chamando', 'quem fecha é o webhook terminate');
  avancar(1);
  const cedo = await fecharSemRetorno(t.ctx, (await t.repo.ligacao(id))!);
  assert.equal(cedo, false);
  avancar(5);
  const fechou = await fecharSemRetorno(t.ctx, (await t.repo.ligacao(id))!);
  assert.equal(fechou, true);
  const l = (await t.repo.ligacao(id))!;
  assert.equal(l.status, 'encerrada');
  assert.equal(l.resultado, 'nao_atendida');
  assert.match(l.erro ?? '', /vigia/);
});

test('webhook de outra unidade ou ligação desconhecida é ignorado', async () => {
  const t = montar();
  const r = await receberEventos(t.ctx, lerWebhookDeLigacoes({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'P' }, calls: [{ id: 'wacid.nao-existe', event: 'terminate', status: 'COMPLETED' }] } }] }] }));
  assert.deepEqual(r, { tratados: 0, ignorados: 1 });
});
