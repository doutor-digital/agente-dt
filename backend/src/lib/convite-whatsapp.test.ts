import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Unit } from '@prisma/client';
import {
  chaveDoConvite,
  convidarParaWhatsapp,
  nomeDaClinicaDaUnidade,
  _esquecerFreiosParaTeste,
  ehComentario,
  sinalDePaciente,
  telefoneNaFranquia,
  type DepsDoConvite,
  type LeituraDoCartao,
  type PedidoDoConvite,
} from './convite-whatsapp.js';
import {
  _esquecerDecisoesParaTeste,
  DIAS_ENTRE_CONVITES,
  ID_CONVITE_WHATSAPP,
  canalDoConvite,
  conviteFalaNaUnidade,
  conviteWhatsappEstado,
  fraseDeOrigem,
  linkDoWhatsapp,
  nomeDaClinica,
  numeroDaUnidade,
  numeroDoWhatsapp,
  textoDoConvite,
  textoPreEscrito,
} from './convite-whatsapp-estado.js';
import { decidirCanal, sofiaSoWhatsappEfetivo, sofiaSoWhatsappEstado, pacienteDeRedeSocialCalado, _esquecerOrigensParaTeste } from './sofia-so-whatsapp.js';
import { _esquecerOBancoParaTeste, _semearParaTeste } from './automacoes-estado.js';
import { automacaoPorId, verificarCatalogo } from './automacoes.js';
import { casarFala, lerListaDeTextos } from './origem-texto-pronto.js';

const SLUG = 'doutor-hernia-salto';
const ROTA = { kommoSalesbotId: 10, kommoReplyFieldId: 20, kommoBypassSalesbot: false };
const NUMERO = '5511999990000';

beforeEach(() => {
  _semearParaTeste([]);
  _esquecerOrigensParaTeste();
  _esquecerFreiosParaTeste();
  _esquecerDecisoesParaTeste();
});
after(() => _esquecerOBancoParaTeste());

const unidade = (extra: Partial<Unit> = {}): Unit =>
  ({
    id: 'u-salto',
    slug: SLUG,
    name: 'Doutor Hérnia Salto',
    kommoSubdomain: 'doutorherniasalto',
    kommoSalesbotId: 10,
    kommoReplyFieldId: 20,
    kommoBypassSalesbot: false,
    igWhatsappNumber: '(11) 99999-0000',
    fbWhatsappNumber: null,
    pausaAte: null,
    pausaDesde: null,
    ...extra,
  }) as unknown as Unit;

const pedido = (extra: Partial<PedidoDoConvite> = {}): PedidoDoConvite => ({
  unit: unidade(),
  leadId: 777,
  origem: 'instagram_business',
  tipoDaMensagem: 'text',
  isChatMessage: true,
  chatId: 'chat-1',
  talkId: '9',
  contactId: '5',
  ...extra,
});

/** Portas de mentira que contam o que foi chamado. Padrão: tudo livre. */
function portas(sobre: Partial<DepsDoConvite> & { leitura?: Partial<LeituraDoCartao> } = {}) {
  const { leitura, ...over } = sobre;
  const w = { jaConvidado: 0, soltou: 0, reivindicou: [] as string[], cartao: 0, equipe: 0, franquia: 0, enviou: [] as string[], simulou: [] as Array<Record<string, unknown>> };
  const reivindicadas = new Set<string>();
  const deps: DepsDoConvite = {
    jaConvidado: async (c) => (w.jaConvidado++, reivindicadas.has(c)),
    reivindicar: async (c) => {
      w.reivindicou.push(c);
      if (reivindicadas.has(c)) return 'perdeu';
      reivindicadas.add(c);
      return 'ganhou';
    },
    soltar: async (c) => void (w.soltou++, reivindicadas.delete(c)),
    cartao: async () => (w.cartao++, { pausado: false, etapaPermite: true, temIdClient: false, telefone: null, ...(leitura ?? {}) }),
    equipeJaFalou: async () => (w.equipe++, false),
    pacienteNaFranquia: async () => (w.franquia++, 'nao' as const),
    clinica: () => 'Doutor Hérnia Salto',
    enviar: async (_u, _p, texto) => (w.enviou.push(texto), 'entregue'),
    simular: (_u, s) => void w.simulou.push(s as unknown as Record<string, unknown>),
    ...over,
  };
  return { w, deps };
}

const ligar = (estado: 'ligado' | 'seco' = 'ligado') => _semearParaTeste([{ slug: SLUG, automacao: ID_CONVITE_WHATSAPP, estado }]);

// ── a chave e o catálogo ──────────────────────────────────────────────────────────────────────

test('a chave nasce DESLIGADA em toda unidade, está no catálogo com modo seco e o catálogo continua válido', () => {
  const a = automacaoPorId(ID_CONVITE_WHATSAPP);
  assert.ok(a);
  assert.equal(a.chave, 'CONVITE_WHATSAPP_SLUGS');
  assert.equal(a.temSeco, true);
  assert.equal(a.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(), []);
  assert.equal(conviteWhatsappEstado(SLUG, undefined), 'desligado');
  assert.equal(conviteWhatsappEstado('doutor-hernia-tatui', ''), 'desligado');
});

// ── texto, número, link ───────────────────────────────────────────────────────────────────────

test('canal: Instagram e Facebook/Messenger; WhatsApp e desconhecido não são canal do robô', () => {
  assert.equal(canalDoConvite('instagram_business'), 'Instagram');
  assert.equal(canalDoConvite('Channel::Instagram'), 'Instagram');
  assert.equal(canalDoConvite('facebook'), 'Facebook');
  assert.equal(canalDoConvite('Channel::FacebookPage'), 'Facebook');
  assert.equal(canalDoConvite('messenger'), 'Facebook');
  for (const o of ['waba', 'com.amocrm.amocrmwa', '', null, undefined, 'telegram']) assert.equal(canalDoConvite(o), null, String(o));
});

test('número: normaliza o que o cadastro guarda; NUNCA completa nem inventa dígito', () => {
  assert.equal(numeroDoWhatsapp('(11) 99999-0000'), '5511999990000');
  assert.equal(numeroDoWhatsapp('+55 11 99999-0000'), '5511999990000');
  assert.equal(numeroDoWhatsapp('5511999990000'), '5511999990000');
  assert.equal(numeroDoWhatsapp('11999990000'), '5511999990000');
  assert.equal(numeroDoWhatsapp('559984064332'), '559984064332', '12 dígitos (fixo ou celular antigo) passa como está: não se acrescenta o 9');
  for (const ruim of ['', null, undefined, '12345', '98130015', '5599', 'sem número', '(00) 99999-9999']) assert.equal(numeroDoWhatsapp(ruim), null, String(ruim));
});

test('o número do canal vale; sem ele, o do outro canal; sem nenhum, null', () => {
  assert.equal(numeroDaUnidade({ igWhatsappNumber: '(94) 98432-5883', fbWhatsappNumber: '(11) 91111-2222' }, 'Facebook'), '5511911112222');
  assert.equal(numeroDaUnidade({ igWhatsappNumber: '(94) 98432-5883', fbWhatsappNumber: null }, 'Facebook'), '5594984325883');
  assert.equal(numeroDaUnidade({ igWhatsappNumber: null, fbWhatsappNumber: '' }, 'Instagram'), null);
  assert.equal(numeroDaUnidade(null, 'Instagram'), null);
});

test('o texto é o aprovado pelo João e o link leva o «Vim pelo <canal>» (acento codificado)', () => {
  const t = textoDoConvite({ clinica: nomeDaClinica('Salto/SP'), numero: NUMERO, canal: 'Instagram' });
  assert.equal(
    t,
    'Oi! 😊 Aqui é da Doutor Hérnia Salto. Para te atender mais rápido e já ver os horários, continue pelo nosso WhatsApp: 👉 https://wa.me/5511999990000?text=Ol%C3%A1!%20Vim%20pelo%20Instagram%20e%20quero%20saber%20mais.',
  );
  assert.match(linkDoWhatsapp(NUMERO, 'Facebook'), /^https:\/\/wa\.me\/5511999990000\?text=Ol%C3%A1!%20Vim%20pelo%20Facebook%20e%20quero%20saber%20mais\.$/);
  assert.equal(decodeURIComponent(linkDoWhatsapp(NUMERO, 'Facebook').split('text=')[1]!), textoPreEscrito('Facebook'));
  assert.ok(t.length < 240, 'cabe em uma bolha (o modo bypass cortaria em 240; o robô não usa bypass, mas o texto não pode crescer à toa)');
  assert.equal(nomeDaClinica(''), 'Doutor Hérnia');
  assert.equal(nomeDaClinica('Canaã dos Carajás/PA'), 'Doutor Hérnia Canaã dos Carajás');
});

test('a frase que o lead manda no WhatsApp é reconhecida pelo rastreio de origem que JÁ existe (origem-texto-pronto, contem: true) — sem código novo no Kommo', () => {
  const lista = lerListaDeTextos({
    origem_por_texto: [
      { texto: fraseDeOrigem('Instagram'), origem: 'Instagram', anuncio: false, contem: true },
      { texto: fraseDeOrigem('Facebook'), origem: 'Facebook', anuncio: false, contem: true },
    ],
  });
  assert.equal(lista.length, 2, 'as duas frases têm tamanho de sobra (mínimo 15 letras)');
  assert.equal(casarFala(textoPreEscrito('Instagram'), lista)?.origem, 'Instagram');
  assert.equal(casarFala(textoPreEscrito('Facebook'), lista)?.origem, 'Facebook');
  assert.equal(casarFala('Olá! Vim pelo Instagram e quero saber mais. Vocês atendem sábado?', lista)?.origem, 'Instagram', 'o lead pode acrescentar algo');
  assert.equal(casarFala('Olá, vim pelo site e quero saber mais', lista), null);
});

// ── a chave desligada não muda nada ───────────────────────────────────────────────────────────

test('DESLIGADA: não lê o cartão, não consulta o banco, não envia, não grava nada — a conversa do Instagram segue como hoje', async () => {
  const { w, deps } = portas();
  const r = await convidarParaWhatsapp(pedido(), deps);
  assert.deepEqual(r, { tipo: 'desligado' });
  assert.deepEqual({ ...w, enviou: w.enviou.length, simulou: w.simulou.length }, { jaConvidado: 0, soltou: 0, reivindicou: [], cartao: 0, equipe: 0, franquia: 0, enviou: 0, simulou: 0 });
});

test('DESLIGADA: a Sofia segue calada só pela chave própria (o robô não muda nada nela)', () => {
  const u = { slug: SLUG, igWhatsappNumber: '(11) 99999-0000', ...ROTA };
  assert.equal(sofiaSoWhatsappEfetivo(u), 'desligado');
  assert.equal(conviteFalaNaUnidade(u), false);
  _semearParaTeste([{ slug: SLUG, automacao: 'sofia-so-whatsapp', estado: 'seco' }]);
  assert.equal(sofiaSoWhatsappEfetivo(u), 'seco', 'a chave própria vale como sempre');
  _semearParaTeste([{ slug: SLUG, automacao: 'sofia-so-whatsapp', estado: 'ligado' }]);
  assert.equal(sofiaSoWhatsappEfetivo({ slug: SLUG }), 'ligado');
});

// ── a Sofia e o robô não falam os dois ────────────────────────────────────────────────────────

test('robô LIGADO com número: a Sofia se cala no Instagram/Facebook (webhook e envios por iniciativa própria)', async () => {
  ligar('ligado');
  const u = { id: 'u1', slug: SLUG, igWhatsappNumber: '(11) 99999-0000', ...ROTA };
  assert.equal(sofiaSoWhatsappEstado(SLUG, undefined), 'desligado', 'a chave própria da Sofia não foi ligada');
  assert.equal(sofiaSoWhatsappEfetivo(u), 'ligado');
  assert.deepEqual(decidirCanal(sofiaSoWhatsappEfetivo(u), 'instagram_business'), { acao: 'calar', origem: 'instagram_business' });
  assert.deepEqual(decidirCanal(sofiaSoWhatsappEfetivo(u), 'waba'), { acao: 'segue' }, 'WhatsApp nunca é calado');
  assert.equal(await pacienteDeRedeSocialCalado(u, 3, { origem: async () => 'facebook' }), true, 'a escada/reativação/cutucada também não falam por cima');
});

test('robô LIGADO mas SEM número cadastrado: a Sofia NÃO é calada (o lead não pode ficar sem ninguém)', async () => {
  ligar('ligado');
  const u = { id: 'u1', slug: SLUG, igWhatsappNumber: null, fbWhatsappNumber: ' ' };
  assert.equal(sofiaSoWhatsappEfetivo(u), 'desligado');
  assert.equal(await pacienteDeRedeSocialCalado(u, 3, { origem: async () => 'facebook' }), false);
});

test('robô LIGADO com número mas SEM Salesbot (ou em modo bypass): a Sofia NÃO é calada — o convite não sairia', () => {
  ligar('ligado');
  const base = { slug: SLUG, igWhatsappNumber: '(11) 99999-0000' };
  assert.equal(sofiaSoWhatsappEfetivo({ ...base, ...ROTA }), 'ligado');
  assert.equal(sofiaSoWhatsappEfetivo({ ...base, ...ROTA, kommoSalesbotId: null }), 'desligado');
  assert.equal(sofiaSoWhatsappEfetivo({ ...base, ...ROTA, kommoReplyFieldId: null }), 'desligado');
  assert.equal(sofiaSoWhatsappEfetivo({ ...base, ...ROTA, kommoBypassSalesbot: true }), 'desligado');
  assert.equal(sofiaSoWhatsappEfetivo(base), 'desligado', 'objeto sem os campos (select estreito): não cala');
});

test('robô em SECO: não cala a Sofia (ninguém fala no lugar dela ainda)', () => {
  ligar('seco');
  assert.equal(sofiaSoWhatsappEfetivo({ slug: SLUG, igWhatsappNumber: '(11) 99999-0000', ...ROTA }), 'desligado');
});

// ── SECO ──────────────────────────────────────────────────────────────────────────────────────

test('SECO: decide tudo, registra «mandaria» com o texto, NÃO envia e NÃO gasta a marca de «uma vez»', async () => {
  ligar('seco');
  const { w, deps } = portas();
  const r = await convidarParaWhatsapp(pedido(), deps);
  assert.equal(r.tipo, 'seco');
  assert.equal(w.enviou.length, 0);
  assert.deepEqual(w.reivindicou, [], 'ligar depois ainda convida esta conversa');
  assert.equal(w.simulou.length, 1);
  assert.equal(w.simulou[0]!.acao, 'mandaria');
  assert.equal(w.simulou[0]!.alvo, 'mensagem');
  assert.match(String(w.simulou[0]!.valor), /^Oi! 😊 Aqui é da Doutor Hérnia Salto\./);
  assert.match(String(w.simulou[0]!.valor), /wa\.me\/5511999990000\?text=/);
});

test('SECO: quando NÃO mandaria, registra o motivo (a tela mostra «pularia»)', async () => {
  ligar('seco');
  const { w, deps } = portas({ equipeJaFalou: async () => true });
  const r = await convidarParaWhatsapp(pedido(), deps);
  assert.deepEqual(r, { tipo: 'ignorou', motivo: 'equipe-ja-falou', detalhe: undefined });
  assert.equal(w.simulou[0]!.acao, 'pularia');
  assert.match(String(w.simulou[0]!.motivo), /equipe já respondeu/);
});

// ── LIGADO: manda uma vez ─────────────────────────────────────────────────────────────────────

test('LIGADO: manda o convite, e a 2ª mensagem do mesmo lead NÃO manda de novo (uma vez por conversa)', async () => {
  ligar('ligado');
  const { w, deps } = portas();
  const a = await convidarParaWhatsapp(pedido(), deps);
  assert.equal(a.tipo, 'enviou');
  assert.equal(w.enviou.length, 1);
  assert.match(w.enviou[0]!, /Aqui é da Doutor Hérnia Salto/);
  assert.deepEqual(w.reivindicou, [chaveDoConvite(unidade(), 777)]);
  const lidoAntes = w.cartao;
  const b = await convidarParaWhatsapp(pedido(), deps);
  assert.deepEqual(b, { tipo: 'ignorou', motivo: 'ja-convidado', detalhe: undefined });
  assert.equal(w.enviou.length, 1);
  assert.equal(w.cartao, lidoAntes, 'quem já foi convidado não custa nenhuma leitura do Kommo');
});

test('LIGADO: a marca vale 7 dias e é por CONTA do Kommo (comercial e resgate dividem o cartão: um convite só)', () => {
  assert.equal(DIAS_ENTRE_CONVITES, 7);
  const comercial = unidade({ id: 'u-1', slug: 'doutor-hernia-canaa', kommoSubdomain: 'doutorherniacanaa' });
  const resgate = unidade({ id: 'u-2', slug: 'canaa-resgate', kommoSubdomain: 'doutorherniacanaa' });
  assert.equal(chaveDoConvite(comercial, 5), chaveDoConvite(resgate, 5));
  assert.notEqual(chaveDoConvite(comercial, 5), chaveDoConvite(comercial, 6));
});

test('LIGADO: duas mensagens ao mesmo tempo — só uma envia (a marca é atômica)', async () => {
  ligar('ligado');
  const { w, deps } = portas({ jaConvidado: async () => false }); // as duas passam pela leitura barata
  const [a, b] = await Promise.all([convidarParaWhatsapp(pedido(), deps), convidarParaWhatsapp(pedido(), deps)]);
  assert.equal(w.enviou.length, 1);
  assert.deepEqual([a.tipo, b.tipo].sort(), ['enviou', 'ignorou']);
});

test('LIGADO: Facebook usa o texto do Facebook', async () => {
  ligar('ligado');
  const { w, deps } = portas();
  await convidarParaWhatsapp(pedido({ origem: 'facebook' }), deps);
  assert.match(w.enviou[0]!, /Vim%20pelo%20Facebook/);
});

// ── os NUNCA ──────────────────────────────────────────────────────────────────────────────────

async function umNao(motivo: string, over: Partial<DepsDoConvite> & { leitura?: Partial<LeituraDoCartao> } = {}, ped: Partial<PedidoDoConvite> = {}) {
  ligar('ligado');
  _esquecerDecisoesParaTeste(); // cada caso é uma conversa nova (o robô lembra o «não» definitivo por 1 h)
  const { w, deps } = portas(over);
  const r = await convidarParaWhatsapp(pedido(ped), deps);
  assert.equal(r.tipo, 'ignorou', motivo);
  assert.equal((r as { motivo: string }).motivo, motivo);
  assert.equal(w.enviou.length, 0, `${motivo}: nada enviado`);
  assert.deepEqual(w.reivindicou, [], `${motivo}: a marca de «uma vez» não é gasta`);
  return w;
}

test('NUNCA: WhatsApp, origem desconhecida e mensagem que não é de chat', async () => {
  for (const origem of ['waba', 'com.amocrm.amocrmwa', null]) {
    const w = await umNao('nao-e-rede-social', {}, { origem });
    assert.equal(w.cartao, 0, 'nem lê o cartão');
  }
  await umNao('nao-e-rede-social', {}, { isChatMessage: false });
});

test('NUNCA: comentário em post (só mensagem direta)', async () => {
  assert.equal(ehComentario('comment'), true);
  assert.equal(ehComentario('instagram_comment'), true);
  assert.equal(ehComentario('text'), false);
  assert.equal(ehComentario(null), false);
  await umNao('comentario', {}, { tipoDaMensagem: 'instagram_comment' });
});

test('NUNCA: unidade em pausa', async () => {
  await umNao('unidade-pausada', {}, { unit: unidade({ pausaDesde: new Date(Date.now() - 3600_000), pausaAte: new Date(Date.now() + 3600_000) }) });
});

test('NUNCA: unidade sem número (ou com número que não parece telefone) — e nada é inventado', async () => {
  await umNao('sem-numero', {}, { unit: unidade({ igWhatsappNumber: null }) });
  await umNao('sem-numero', {}, { unit: unidade({ igWhatsappNumber: '12345' }) });
});

test('NUNCA: unidade sem Salesbot/campo de resposta (viraria nota no cartão) ou em modo bypass (cortaria o link) — o chatId do webhook não é rota', async () => {
  await umNao('sem-rota-de-envio', {}, { unit: unidade({ kommoSalesbotId: null }), chatId: 'chat-1' });
  await umNao('sem-rota-de-envio', {}, { unit: unidade({ kommoReplyFieldId: null }), chatId: 'chat-1' });
  await umNao('sem-rota-de-envio', {}, { unit: unidade({ kommoBypassSalesbot: true }) });
});

test('NUNCA: «Pausar IA» marcado, etapa em que a Sofia não fala, cartão vinculado à franquia', async () => {
  await umNao('cartao-pausado', { leitura: { pausado: true } });
  await umNao('etapa-sem-sofia', { leitura: { etapaPermite: false } });
  await umNao('paciente', { leitura: { temIdClient: true } });
});

test('NUNCA: a equipe já respondeu esta conversa', async () => {
  const w = await umNao('equipe-ja-falou', { equipeJaFalou: async () => true });
  assert.equal(w.franquia, 0);
});

test('NUNCA: paciente em tratamento pelo telefone (a mesma conferência da franquia da Sofia)', async () => {
  await umNao('paciente', { leitura: { telefone: '+5511999990000' }, pacienteNaFranquia: async () => 'sim' });
});

test('FALHA FECHADA: o contato TEM telefone e a franquia não respondeu (índice vencido, ficha que não veio) = não convida', async () => {
  await umNao('nao-consegui-conferir', { leitura: { telefone: '+5511988887777' }, pacienteNaFranquia: async () => 'nao-sei' });
});

test('FALHA FECHADA: telefone do contato que o Kommo não deixou ler NÃO vira «contato sem telefone»', async () => {
  await umNao('nao-consegui-conferir', { cartao: async () => Promise.reject(new Error('429 ao ler o telefone')) });
});

test('o contato tem telefone e a franquia diz que NÃO é paciente: convida', async () => {
  ligar('ligado');
  const { w, deps } = portas({ leitura: { telefone: '+5511988887777' } });
  assert.equal((await convidarParaWhatsapp(pedido(), deps)).tipo, 'enviou');
  assert.equal(w.franquia, 1);
});

test('sem telefone no contato (o normal do Instagram) NÃO consulta a franquia: paciente nunca é achado por nome', async () => {
  ligar('ligado');
  const { w, deps } = portas();
  const r = await convidarParaWhatsapp(pedido(), deps);
  assert.equal(r.tipo, 'enviou');
  assert.equal(w.franquia, 0);
});

test('unidade sem franquia conectada: não há paciente a achar pelo telefone (não é «indisponível»); nada de rede', async () => {
  assert.equal(await telefoneNaFranquia(unidade({ spineEnabled: false } as Partial<Unit>), '+5511988887777'), 'nao');
  assert.equal(await telefoneNaFranquia(unidade({ spineEnabled: true, spineToken: null } as Partial<Unit>), '+5511988887777'), 'nao');
});

test('sinalDePaciente: tratamento ativo, sessão futura ou avaliação recente = paciente; lead, não achou e franquia fora = pode convidar', () => {
  assert.equal(sinalDePaciente({ tipo: 'paciente', idClient: 1, tratamentoAtivo: true, sessaoFutura: false }), true);
  assert.equal(sinalDePaciente({ tipo: 'paciente', idClient: 1, tratamentoAtivo: false, sessaoFutura: true }), true);
  assert.equal(sinalDePaciente({ tipo: 'paciente', idClient: 1, tratamentoAtivo: false, sessaoFutura: false, avaliacaoRecente: true }), true);
  assert.equal(sinalDePaciente({ tipo: 'paciente', idClient: 1, tratamentoAtivo: false, sessaoFutura: false }), false, 'abandonou o tratamento há meses: é lead que volta');
  assert.equal(sinalDePaciente({ tipo: 'lead' }), false);
  assert.equal(sinalDePaciente({ tipo: 'nao_achou' }), false);
  assert.equal(sinalDePaciente({ tipo: 'indisponivel', motivo: 'x' }), false);
});

// ── falha fechada ─────────────────────────────────────────────────────────────────────────────

test('FALHA FECHADA: Kommo ou banco que não respondem = não convida (e não gasta a marca)', async () => {
  for (const [nome, over] of [
    ['cartão', { cartao: async () => Promise.reject(new Error('429')) }],
    ['equipe', { equipeJaFalou: async () => Promise.reject(new Error('403')) }],
    ['leitura da marca', { jaConvidado: async () => Promise.reject(new Error('banco fora')) }],
  ] as const) {
    ligar('ligado');
    const { w, deps } = portas(over as Partial<DepsDoConvite>);
    const r = await convidarParaWhatsapp(pedido(), deps);
    assert.equal(r.tipo, 'ignorou', nome);
    assert.equal((r as { motivo: string }).motivo, 'nao-consegui-conferir', nome);
    assert.equal(w.enviou.length, 0, nome);
    assert.deepEqual(w.reivindicou, [], nome);
  }
});

test('FALHA FECHADA: banco que não confirma a marca = não envia', async () => {
  ligar('ligado');
  const { w, deps } = portas({ reivindicar: async () => 'incerto' });
  const r = await convidarParaWhatsapp(pedido(), deps);
  assert.equal((r as { motivo: string }).motivo, 'nao-consegui-conferir');
  assert.equal(w.enviou.length, 0);
});

test('a chave desligada DURANTE a conferência: não envia e não gasta a marca', async () => {
  ligar('ligado');
  const { w, deps } = portas({
    equipeJaFalou: async () => {
      _semearParaTeste([]); // alguém desligou na tela enquanto lia o Kommo
      return false;
    },
  });
  const r = await convidarParaWhatsapp(pedido(), deps);
  assert.equal(r.tipo, 'ignorou');
  assert.equal(w.enviou.length, 0);
  assert.deepEqual(w.reivindicou, [], 'a marca nem chega a ser gasta');
});

test('envio que lança: NÃO solta a marca (pode ter saído) e não repete na próxima mensagem', async () => {
  ligar('ligado');
  let tentativas = 0;
  const { w, deps } = portas({ enviar: async () => (tentativas++, Promise.reject(new Error('timeout'))) });
  const a = await convidarParaWhatsapp(pedido(), deps);
  assert.equal(a.tipo, 'falhou');
  const b = await convidarParaWhatsapp(pedido(), deps);
  assert.equal((b as { motivo: string }).motivo, 'ja-convidado');
  assert.equal(tentativas, 1);
});

test('envio que virou NOTA no cartão: o lead NÃO recebeu → a marca é DEVOLVIDA; a próxima mensagem só tenta de novo depois de 30 min (sem nota em cascata)', async () => {
  ligar('ligado');
  let agora = 1_800_000_000_000;
  let entrega: 'virou-nota' | 'entregue' = 'virou-nota';
  const { w, deps } = portas({ agora: () => new Date(agora), enviar: async (_u, _p, texto) => (w.enviou.push(texto), entrega) });
  const a = await convidarParaWhatsapp(pedido(), deps);
  assert.deepEqual(a, { tipo: 'falhou', detalhe: 'virou nota no cartão' });
  assert.equal(w.soltou, 1);
  agora += 5 * 60_000;
  const b = await convidarParaWhatsapp(pedido(), deps);
  assert.equal((b as { motivo: string }).motivo, 'nao-consegui-conferir', 'dentro dos 30 min: freado');
  assert.equal(w.enviou.length, 1);
  agora += 31 * 60_000;
  entrega = 'entregue';
  const c = await convidarParaWhatsapp(pedido(), deps);
  assert.equal(c.tipo, 'enviou');
  assert.equal(w.enviou.length, 2);
});

test('SECO: a mesma conversa é decidida uma vez por hora (sem repetir as leituras do Kommo a cada mensagem)', async () => {
  ligar('seco');
  let agora = 1_800_000_000_000;
  const { w, deps } = portas({ agora: () => new Date(agora) });
  assert.equal((await convidarParaWhatsapp(pedido(), deps)).tipo, 'seco');
  assert.deepEqual(await convidarParaWhatsapp(pedido(), deps), { tipo: 'ja-decidido' });
  assert.equal(w.cartao, 1);
  assert.equal(w.simulou.length, 1);
  agora += 61 * 60_000;
  assert.equal((await convidarParaWhatsapp(pedido(), deps)).tipo, 'seco');
  assert.equal(w.cartao, 2);
});

test('LIGADO: depois de um «não» definitivo (a equipe já falou), as mensagens seguintes do lead não repetem as leituras do Kommo por 1 h', async () => {
  ligar('ligado');
  let agora = 1_800_000_000_000;
  let equipeLeu = 0;
  const { w, deps } = portas({ agora: () => new Date(agora), equipeJaFalou: async () => (equipeLeu++, true) });
  for (let i = 0; i < 5; i++) await convidarParaWhatsapp(pedido(), deps);
  assert.equal(w.cartao, 1);
  assert.equal(equipeLeu, 1);
  assert.equal(w.enviou.length, 0);
  agora += 61 * 60_000;
  await convidarParaWhatsapp(pedido(), deps);
  assert.equal(equipeLeu, 2, 'passada 1 h, olha de novo');
});

test('falha passageira («não consegui conferir») NÃO é lembrada: a próxima mensagem tenta de novo', async () => {
  ligar('ligado');
  let falhou = true;
  const { w, deps } = portas({ cartao: async () => (falhou ? Promise.reject(new Error('429')) : { pausado: false, etapaPermite: true, temIdClient: false, telefone: null }) });
  assert.equal((await convidarParaWhatsapp(pedido(), deps) as { motivo: string }).motivo, 'nao-consegui-conferir');
  falhou = false;
  assert.equal((await convidarParaWhatsapp(pedido(), deps)).tipo, 'enviou');
  assert.equal(w.enviou.length, 1);
});

// ── a fiação (o robô só vale se o webhook o chamar e a Sofia usar o estado efetivo) ───────────────

test('fiação: o webhook do Kommo chama o robô e a porta da Sofia usa o estado efetivo', () => {
  const src = readFileSync(new URL('../controllers/webhook.controller.ts', import.meta.url), 'utf8');
  assert.match(src, /import \{ convidarParaWhatsapp \} from '\.\.\/lib\/convite-whatsapp\.js'/);
  assert.match(src, /void convidarParaWhatsapp\(\{[\s\S]{0,400}origem: ctx\.origem,[\s\S]{0,200}tipoDaMensagem: ctx\.tipoDaMensagem/);
  assert.match(src, /estado: sofiaSoWhatsappEfetivo\(unit\)/);
  assert.match(src, /message_type: z\.string\(\)\.optional\(\)/);
});

test('o nome da clínica no texto: o da unidade quando já diz «Doutor Hérnia <cidade>»; senão a cidade do mapa da unidade dona', () => {
  assert.equal(nomeDaClinicaDaUnidade({ slug: 'doutor-hernia-caxias', name: 'Doutor Hérnia Caxias' }), 'Doutor Hérnia Caxias');
  assert.equal(nomeDaClinicaDaUnidade({ slug: 'doutor-hernia-canaa', name: 'Doutor Hérnia Canaã' }), 'Doutor Hérnia Canaã');
  assert.equal(nomeDaClinicaDaUnidade({ slug: 'doutor-hernia-imperatriz', name: 'Comercial' }), 'Doutor Hérnia Imperatriz');
  assert.equal(nomeDaClinicaDaUnidade({ slug: 'balsas-resgate', name: 'Resgate · Balsas' }), 'Doutor Hérnia Balsas');
});
