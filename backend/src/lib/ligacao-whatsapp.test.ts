/**
 * Ligação pelo WhatsApp — as regras (travas, permissão, resultado, registro no Kommo, vigia) e o webhook.
 * Nada aqui chama a Meta nem o Kommo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PADROES,
  ajustesDaUnidade,
  chaveDoTelefone,
  contaComoSemAtender,
  decidirLigacao,
  diaNoFuso,
  estadoDoCombinado,
  numerosDeTeste,
  permissaoAgora,
  podePedirPermissao,
  proximoContador,
  registroParaKommo,
  resultadoDaLigacao,
  statusNoKommo,
  taxaDeAtendimento,
  telefoneMascarado,
  telefoneParaMeta,
  textoDoCombinado,
  travaDoPaciente,
  vigiaDecide,
  type PedidoDeLigacao,
} from './ligacao-whatsapp.js';
import { lerPermissao, lerWebhookDeLigacoes, numerosDoWebhook } from './ligacao-whatsapp-meta.js';

const H = 3_600_000;
const agora = new Date('2026-10-08T15:00:00Z');
const aj = ajustesDaUnidade(null);

// ── telefone ──

test('telefone: formato da Meta com 55, chave DDD + 8 dígitos e máscara', () => {
  assert.equal(telefoneParaMeta('(63) 99102-1043'), '5563991021043');
  assert.equal(telefoneParaMeta('+55 63 99102-1043'), '5563991021043');
  assert.equal(telefoneParaMeta('63 9102-1043'), '556391021043');
  assert.equal(telefoneParaMeta('063 99102-1043'), '5563991021043', 'DDD com o zero na frente');
  assert.equal(telefoneParaMeta('123'), null);
  assert.equal(telefoneParaMeta(''), null);
  assert.equal(chaveDoTelefone('5563991021043'), '6391021043');
  assert.equal(chaveDoTelefone('556391021043'), '6391021043', 'com e sem o nono dígito casam');
  assert.notEqual(chaveDoTelefone('5511991021043'), chaveDoTelefone('5563991021043'), 'mesmo final em DDD diferente = outro paciente');
  assert.equal(telefoneMascarado('5563991021043'), '…1043');
  assert.deepEqual(numerosDeTeste(undefined), ['6391021043'], 'sem variável: o número do João');
  assert.deepEqual(numerosDeTeste('"5563991021043, (11) 98888-7777"'), ['6391021043', '1188887777']);
  assert.ok(numerosDeTeste(undefined).includes(chaveDoTelefone('+55 63 99102-1043')), 'o contato do João casa com a lista de teste');
});

// ── ajustes ──

test('ajustes: padrão é 2 sem atender, teto 3 (uma antes do corte da Meta), 50% em 6 ligações', () => {
  assert.deepEqual(aj, { maxSemAtender: 2, tetoSemAtender: 3, taxaMinima: 50, amostraMinima: 6 });
  assert.equal(ajustesDaUnidade({ maxSemAtender: 9 }).maxSemAtender, 2, 'valor fora da faixa volta ao padrão');
  assert.equal(ajustesDaUnidade({ maxSemAtender: 3 }).tetoSemAtender, 3, 'nunca passa de 3 — a Meta corta na 4ª');
  assert.equal(ajustesDaUnidade({ taxaMinima: 70, amostraMinima: 10 }).taxaMinima, 70);
});

// ── permissão ──

test('permissão: aceita vencida vira "caiu"; permanente não vence', () => {
  const base = { permissao: 'aceita', permanente: false, pedidosEm: [] };
  assert.equal(permissaoAgora({ ...base, permissaoAte: new Date(agora.getTime() + H) }, agora).estado, 'aceita');
  assert.equal(permissaoAgora({ ...base, permissaoAte: new Date(agora.getTime() - H) }, agora).estado, 'caiu');
  assert.equal(permissaoAgora({ ...base, permanente: true, permissaoAte: null }, agora).estado, 'aceita');
  assert.equal(permissaoAgora(null, agora).estado, 'sem');
});

test('pedido de permissão: 1 a cada 24 h e 2 a cada 7 dias', () => {
  assert.equal(podePedirPermissao([], agora, 'sem').ok, true);
  const ontemCedo = new Date(agora.getTime() - 20 * H);
  const r1 = podePedirPermissao([ontemCedo], agora, 'pedida');
  assert.equal(r1.ok, false);
  assert.equal(!r1.ok && r1.liberaEm?.getTime(), ontemCedo.getTime() + 24 * H);
  const r2 = podePedirPermissao([new Date(agora.getTime() - 5 * 24 * H), new Date(agora.getTime() - 2 * 24 * H)], agora, 'pedida');
  assert.equal(r2.ok, false, 'dois na semana: espera o mais antigo sair da janela');
  assert.equal(r2.usados7d, 2);
  const r3 = podePedirPermissao([new Date(agora.getTime() - 8 * 24 * H), new Date(agora.getTime() - 2 * 24 * H)], agora, 'caiu');
  assert.equal(r3.ok, true, 'pedido de 8 dias atrás já não conta');
  assert.equal(podePedirPermissao([], agora, 'aceita').ok, false, 'quem já deu permissão não recebe outro pedido');
  // a Meta zera a conta quando uma ligação conecta: quando ela responde, ela manda
  assert.equal(podePedirPermissao([ontemCedo], agora, 'caiu', true).ok, true);
  assert.equal(podePedirPermissao([], agora, 'sem', false).ok, false);
});

// ── trava 1: combinar ──

test('combinar: só "respondeu" quando o paciente escreveu DEPOIS da pergunta, e vale 30 min', () => {
  const perguntou = new Date(agora.getTime() - 10 * 60_000);
  assert.equal(estadoDoCombinado(null, null, agora), 'nao-perguntou');
  assert.equal(estadoDoCombinado(perguntou, null, agora), 'esperando');
  assert.equal(estadoDoCombinado(perguntou, new Date(perguntou.getTime() - 60_000), agora), 'esperando', 'mensagem de antes da pergunta não vale');
  assert.equal(estadoDoCombinado(perguntou, new Date(agora.getTime() - 5 * 60_000), agora), 'respondeu');
  assert.equal(estadoDoCombinado(new Date(agora.getTime() - 3 * H), new Date(agora.getTime() - 2.5 * H), agora), 'vencido');
  assert.equal(estadoDoCombinado(new Date(agora.getTime() - 3 * H), null, agora), 'vencido');
});

test('texto do combinado: primeiro nome, sem a data do título nem "Lead"', () => {
  assert.equal(textoDoCombinado('MARIA DA SILVA 03/08/2026'), 'Oi, Maria! Posso te ligar agora pelo WhatsApp? É rapidinho.');
  assert.equal(textoDoCombinado('Lead #123'), 'Oi! Posso te ligar agora pelo WhatsApp? É rapidinho.');
  assert.equal(textoDoCombinado(null), 'Oi! Posso te ligar agora pelo WhatsApp? É rapidinho.');
});

// ── trava 2: "1 de 2 sem atender" ──

test('trava 2: a 2ª seguida sem atender trava; ele escrever libera UMA; a 3ª trava de vez', () => {
  const t0 = travaDoPaciente({ naoAtendidasSeguidas: 0, ultimaNaoAtendidaEm: null, escreveuDepois: false }, aj);
  assert.equal(t0.travado, false);
  const t1 = travaDoPaciente({ naoAtendidasSeguidas: 1, ultimaNaoAtendidaEm: agora, escreveuDepois: false }, aj);
  assert.equal(t1.travado, false);
  assert.equal(t1.rotulo, '1 de 2 sem atender');
  const t2 = travaDoPaciente({ naoAtendidasSeguidas: 2, ultimaNaoAtendidaEm: agora, escreveuDepois: false }, aj);
  assert.equal(t2.travado, true);
  assert.equal(t2.firme, false);
  const t2b = travaDoPaciente({ naoAtendidasSeguidas: 2, ultimaNaoAtendidaEm: agora, escreveuDepois: true }, aj);
  assert.equal(t2b.travado, false, 'paciente escreveu depois: libera uma tentativa');
  const t3 = travaDoPaciente({ naoAtendidasSeguidas: 3, ultimaNaoAtendidaEm: agora, escreveuDepois: true }, aj);
  assert.equal(t3.travado, true);
  assert.equal(t3.firme, true, 'na 3ª mensagem solta não libera — a 4ª a Meta corta a permissão');
  const t3ok = travaDoPaciente({ naoAtendidasSeguidas: 3, ultimaNaoAtendidaEm: agora, escreveuDepois: true, combinouDepois: true }, aj);
  assert.equal(t3ok.travado, false, 'respondeu ao "Posso te ligar agora?" depois da 3ª: libera (com permissão permanente não há outra saída)');
});

test('contador: atendeu zera, não atendeu e recusou somam, falha técnica não mexe', () => {
  assert.equal(proximoContador(1, 'atendida'), 0);
  assert.equal(proximoContador(1, 'nao_atendida'), 2);
  assert.equal(proximoContador(1, 'recusada'), 2);
  assert.equal(proximoContador(1, 'falhou'), 1);
  assert.equal(contaComoSemAtender('falhou'), false);
});

// ── decisão de ligar ──

const liberado: PedidoDeLigacao = {
  modo: 'ligado', numeroDeTeste: false, temCredencial: true, telefoneValido: true, permissao: 'aceita', metaDeixa: true,
  trava: travaDoPaciente({ naoAtendidasSeguidas: 0, ultimaNaoAtendidaEm: null, escreveuDepois: false }, aj),
  combinado: 'respondeu', confirmouSemCombinar: false, origem: 'cartao', filaPausada: false, emAndamento: false,
};

test('decidir: tudo certo liga sem aviso', () => {
  assert.deepEqual(decidirLigacao(liberado), { ok: true, semCombinar: false });
});

test('decidir: sem combinar pede confirmação; confirmado liga marcando "sem combinar"', () => {
  const d = decidirLigacao({ ...liberado, combinado: 'esperando' });
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.codigo, 'combinar');
  assert.equal(!d.ok && d.precisaConfirmar, true);
  assert.deepEqual(decidirLigacao({ ...liberado, combinado: 'nao-perguntou', confirmouSemCombinar: true }), { ok: true, semCombinar: true });
});

test('decidir: a ordem dos "não" — desligada, teste, permissão, Meta, trava, fila', () => {
  const cod = (p: Partial<PedidoDeLigacao>) => {
    const d = decidirLigacao({ ...liberado, ...p });
    return d.ok ? 'ok' : d.codigo;
  };
  assert.equal(cod({ modo: 'desligado' }), 'desligada');
  assert.equal(cod({ modo: 'seco' }), 'so-teste', 'só no papel: paciente de verdade não recebe ligação');
  assert.equal(cod({ modo: 'seco', numeroDeTeste: true }), 'ok', 'só no papel: o número de teste liga');
  assert.equal(cod({ temCredencial: false }), 'sem-credencial');
  assert.equal(cod({ permissao: 'pedida' }), 'sem-permissao');
  assert.equal(cod({ permissao: 'caiu' }), 'sem-permissao');
  assert.equal(cod({ metaDeixa: false }), 'meta-nao-deixa');
  assert.equal(cod({ trava: travaDoPaciente({ naoAtendidasSeguidas: 2, ultimaNaoAtendidaEm: agora, escreveuDepois: false }, aj) }), 'travado');
  assert.equal(cod({ emAndamento: true }), 'em-andamento');
  assert.equal(cod({ origem: 'fila', filaPausada: true }), 'fila-pausada');
  assert.equal(cod({ origem: 'cartao', filaPausada: true }), 'ok', 'a pausa do vigia é da FILA; pelo cartão segue com as travas');
  assert.equal(cod({ origem: 'cartao', filaPausada: true, combinado: 'esperando', confirmouSemCombinar: true }), 'combinar-obrigatorio', 'com a fila pausada, sem combinar não sai nem pelo cartão');
  assert.equal(cod({ trava: travaDoPaciente({ naoAtendidasSeguidas: 2, ultimaNaoAtendidaEm: agora, escreveuDepois: false }, aj), combinado: 'esperando', confirmouSemCombinar: true }), 'travado', 'confirmar o aviso não fura a trava');
});

// ── resultado e registro no Kommo ──

test('resultado: ACCEPTED ou duração > 0 = atendida; recusou; nem tocou = falhou; tocou e não atendeu', () => {
  assert.equal(resultadoDaLigacao({ atendidaEm: agora, duracaoSeg: 0, recusada: false, falhaTecnica: false }), 'atendida');
  assert.equal(resultadoDaLigacao({ atendidaEm: null, duracaoSeg: 42, recusada: false, falhaTecnica: false }), 'atendida');
  assert.equal(resultadoDaLigacao({ atendidaEm: null, duracaoSeg: 0, recusada: true, falhaTecnica: false }), 'recusada');
  assert.equal(resultadoDaLigacao({ atendidaEm: null, duracaoSeg: null, recusada: false, falhaTecnica: true }), 'falhou');
  assert.equal(resultadoDaLigacao({ atendidaEm: null, duracaoSeg: null, recusada: false, falhaTecnica: false }), 'nao_atendida');
});

test('registro no Kommo: saída, status 4/6/7, telefone com +, SDR como autor', () => {
  assert.equal(statusNoKommo('atendida'), 4);
  assert.equal(statusNoKommo('nao_atendida'), 6);
  assert.equal(statusNoKommo('recusada'), 7);
  const r = registroParaKommo({
    id: 'abc', waCallId: 'wacid.X', telefone: '5563991021043', duracaoSeg: 151.4, criadaEm: agora, kommoUserId: 77,
    resultado: 'atendida', texto: 'Ligação pelo WhatsApp atendida · 2min 31s',
  });
  assert.deepEqual(r, {
    direction: 'outbound', uniq: 'wacid.X', duration: 151, source: 'DD · Ligação WhatsApp', phone: '+5563991021043',
    call_status: 4, call_result: 'Ligação pelo WhatsApp atendida · 2min 31s', created_at: Math.floor(agora.getTime() / 1000),
    responsible_user_id: 77, created_by: 77,
  });
  const semSdr = registroParaKommo({ id: 'abc', waCallId: null, telefone: '5563991021043', duracaoSeg: null, criadaEm: agora, kommoUserId: null, resultado: 'nao_atendida', texto: 'x' });
  assert.equal(semSdr.uniq, 'dd-abc');
  assert.equal('created_by' in semSdr, false);
});

// ── trava 3: vigia ──

test('vigia: só julga com amostra; abaixo do mínimo pausa; falha técnica não entra na conta', () => {
  assert.deepEqual(taxaDeAtendimento(['atendida', 'nao_atendida', 'falhou', null]), { total: 2, atendidas: 1, taxa: 50 });
  const poucas = taxaDeAtendimento(['nao_atendida', 'nao_atendida', 'nao_atendida']);
  assert.equal(vigiaDecide(poucas, aj).pausar, false, '3 ligações não dizem nada');
  const ruim = taxaDeAtendimento(['atendida', 'nao_atendida', 'nao_atendida', 'recusada', 'nao_atendida', 'atendida']);
  assert.equal(ruim.taxa, 33);
  const v = vigiaDecide(ruim, aj);
  assert.equal(v.pausar, true);
  assert.match(v.motivo, /2 de 6/);
  const boa = taxaDeAtendimento(['atendida', 'atendida', 'nao_atendida', 'atendida', 'nao_atendida', 'atendida']);
  assert.equal(vigiaDecide(boa, aj).pausar, false);
});

test('dia no fuso: meia-noite de São Paulo e de amanhã', () => {
  const d = diaNoFuso(new Date('2026-10-08T02:30:00Z'), 'America/Sao_Paulo'); // 23:30 do dia 07 em SP
  assert.equal(d.inicio.toISOString(), '2026-10-07T03:00:00.000Z');
  assert.equal(d.fim.toISOString(), '2026-10-08T03:00:00.000Z');
  const b = diaNoFuso(new Date('2026-10-08T15:00:00Z'), 'America/Boa_Vista');
  assert.equal(b.inicio.toISOString(), '2026-10-08T04:00:00.000Z');
});

test('padrões batem com o combinado com o João', () => {
  assert.equal(PADROES.pedidosPor24h, 1);
  assert.equal(PADROES.pedidosPor7d, 2);
  assert.equal(PADROES.maxSemAtender, 2);
});

// ── Meta: permissão e webhook ──

test('GET call_permissions: concedida temporária com data, ações', () => {
  const p = lerPermissao({
    messaging_product: 'whatsapp',
    permission: { status: 'temporary', expiration_time: 1760000000 },
    actions: [
      { action_name: 'send_call_permission_request', can_perform_action: false },
      { action_name: 'start_call', can_perform_action: true },
    ],
  });
  assert.equal(p.estado, 'aceita');
  assert.equal(p.ate?.getTime(), 1760000000 * 1000);
  assert.equal(p.permanente, false);
  assert.equal(p.podeLigar, true);
  assert.equal(p.podePedir, false);
  assert.equal(lerPermissao({ permission: { status: 'no_permission' } }).estado, 'sem');
  assert.equal(lerPermissao({ permission: { status: 'permanent' } }).permanente, true);
  const semData = lerPermissao({ permission: { status: 'temporary' } });
  assert.equal(semData.permanente, false, 'temporária sem data NÃO vira permanente');
  assert.ok(semData.ate && semData.ate.getTime() > Date.now(), 'vale os 7 dias da doc');
});

const webhook = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '932240156628996' }, ...value } }] }],
});

test('webhook: connect com resposta SDP, status de toque/atendeu e terminate com duração', () => {
  const ev = lerWebhookDeLigacoes(webhook({
    calls: [
      { id: 'wacid.1', to: '5563991021043', from: '5599991063655', event: 'connect', timestamp: '1760000000', direction: 'BUSINESS_INITIATED', session: { sdp_type: 'answer', sdp: 'v=0\r\n' }, biz_opaque_callback_data: 'lig1' },
      { id: 'wacid.1', event: 'terminate', status: 'COMPLETED', duration: 95, start_time: '1760000010', end_time: '1760000105', timestamp: '1760000105' },
    ],
    statuses: [
      { id: 'wacid.1', type: 'call', status: 'RINGING', timestamp: '1760000002', recipient_id: '5563991021043' },
      { id: 'wamid.x', type: 'message', status: 'read' },
    ],
  }));
  assert.equal(ev.length, 3, 'status de mensagem comum fica de fora');
  const c = ev.find((e) => e.tipo === 'connect');
  assert.ok(c && c.tipo === 'connect' && c.sdp === 'v=0\r\n' && c.sdpTipo === 'answer' && c.opaco === 'lig1');
  const t = ev.find((e) => e.tipo === 'terminate');
  assert.ok(t && t.tipo === 'terminate' && t.duracaoSeg === 95 && t.status === 'COMPLETED');
  const s = ev.find((e) => e.tipo === 'status');
  assert.ok(s && s.tipo === 'status' && s.status === 'RINGING');
  assert.deepEqual(numerosDoWebhook(webhook({})), ['932240156628996']);
});

test('webhook: resposta do paciente ao pedido de permissão', () => {
  const ev = lerWebhookDeLigacoes({
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P' }, messages: [
      { from: '556391021043', id: 'wamid.1', timestamp: '1760000000', type: 'interactive', interactive: { type: 'call_permission_reply', call_permission_reply: { response: 'accept', is_permanent: false, expiration_timestamp: 1760604800, response_source: 'user_action' } } },
      { from: '556391021043', id: 'wamid.2', timestamp: '1760000001', type: 'text', text: { body: 'oi' } },
    ] } }] }],
  });
  assert.equal(ev.length, 1);
  const p = ev[0];
  assert.ok(p.tipo === 'permissao' && p.resposta === 'aceita' && p.ate?.getTime() === 1760604800 * 1000 && p.permanente === false);
});
