/**
 * A decisão da cutucada depois da equipe (16/11/2026): quem falou por último no WhatsApp Lite, o prazo de 2 h, a idade máxima,
 * o texto que pode sair e a marca de «uma vez por lead». As conversas abaixo têm a FORMA das reais de Petrópolis (autor, nome, hora).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizar } from '../services/kommo-talks-normalizar.js';
import type { KommoTalkMessage } from '../services/kommo.service.js';
import {
  ESPERA_PADRAO_MIN,
  IDADE_MAX_PADRAO_H,
  cartaoComEtiquetaDeRobo,
  configDaCutucada,
  conversaParaOModelo,
  decidirPelaConversa,
  ehEncerramento,
  ehRespostaAutomaticaDoApp,
  etapaDaCutucada,
  idDaMarcaDaCutucada,
  porQueOCartaoFicaQuieto,
  porQueOTextoNaoSai,
  reclassificarFalas,
  sofiaJaFalou,
} from './cutucada-apos-equipe.js';

const T0 = Date.UTC(2026, 10, 16, 13, 0, 0) / 1000; // 10h em Brasília, segunda
const MIN = 60;
const H = 3600;
const cfg = configDaCutucada(null);

let n = 0;
function m(tipo: 'in' | 'sofia' | 'lite' | 'kommo' | 'robo' | 'sessao', em: number, text = 'texto', extra: Partial<KommoTalkMessage> = {}): KommoTalkMessage {
  const autor: Record<string, KommoTalkMessage['author']> = {
    in: { type: 'external', name: 'Alex' },
    sofia: { type: 'bot', name: 'Salesbot' },
    lite: { type: 'bot', name: 'WhatsApp Lite' },
    kommo: { type: 'internal', name: 'Doutor Hérnia Petrópolis' },
    robo: { type: 'bot', name: 'Salesbot' },
    sessao: { type: 'internal', name: 'Doutor Digital' },
  };
  return { id: `m${++n}`, type: tipo === 'in' ? 'incoming' : 'outgoing', text, created_at: em, author: autor[tipo], ...extra };
}
const falas = (msgs: KommoTalkMessage[], envios: number[] = [], flags: { etiqueta?: boolean } = {}) =>
  reclassificarFalas(normalizar(msgs), envios.map((e) => new Date(e * 1000)), { cartaoComEtiquetaDeRobo: !!flags.etiqueta });
const agora = (s: number) => new Date(s * 1000);

// ─── quem falou: a prova em conversas com a forma das reais ──────────────────────────────────────

test('Lite: o celular da SDR é EQUIPE e o Salesbot que casa com um envio nosso é a SOFIA (lead 5948001, 16/11)', () => {
  const fs = falas(
    [m('in', T0, 'Olá estava navegando e gostaria de mais informações'), m('sofia', T0 + 38, 'Oi! Que bom te receber'), m('lite', T0 + 2 * H + 16 * MIN, 'Olá, Bom dia! Me chamo Natalia, da Clínica Doutor Hérnia.')],
    [T0 + 38],
  );
  assert.deepEqual(fs.map((f) => f.autor), ['paciente', 'sofia', 'equipe']);
  assert.equal(sofiaJaFalou(fs), true);
});

test('Salesbot que NÃO casa com envio nosso é robô (régua de ▶ Retomada do Kommo), não Sofia e não equipe (lead 5806575)', () => {
  const fs = falas([m('lite', T0, 'Conforme a ligação, aguardo o senhor'), m('robo', T0 + 10 * H, 'Oi, Alex! Aqui é , da Doutor Hérnia. Tentei te ligar agora há pouco')], []);
  assert.equal(fs[1].autor, 'robo');
  assert.equal(decidirPelaConversa(fs, agora(T0 + 14 * H), cfg).tipo, 'pular');
});

test('a janela de casamento com o envio é a mesma do resto da casa (3 min): a Sofia 10 min depois do registro já não casa', () => {
  const fs = falas([m('sofia', T0 + 10 * MIN, 'Oi!')], [T0]);
  assert.equal(fs[0].autor, 'robo');
  assert.equal(falas([m('sofia', T0 + 2 * MIN, 'Oi!')], [T0])[0].autor, 'sofia');
});

test('sessão «Doutor Digital»: é a Sofia só se casa com um envio; senão é a equipe usando o mesmo login', () => {
  assert.equal(falas([m('sessao', T0, 'nota de voz')], [T0 + 30])[0].autor, 'sofia');
  assert.equal(falas([m('sessao', T0, 'oi, aqui é a Mariana')], [])[0].autor, 'equipe');
});

test('saudação/ausência automática do app Lite NÃO é a equipe (o texto real de Petrópolis, 23 em 3 dias)', () => {
  const aviso = 'Agradecemos o seu contato! \nNosso atendimento é de segunda a sexta de 07:30 às 19:30 e aos sábados de 08:00 às 12:00.';
  const fs = falas([m('lite', T0, 'Pode ser amanhã?'), m('in', T0 + H, 'Pode'), m('lite', T0 + H + 4, aviso)]);
  assert.deepEqual(fs.map((f) => f.autor), ['equipe', 'paciente', 'robo']);
  assert.equal(decidirPelaConversa(fs, agora(T0 + 6 * H), cfg).tipo, 'pular'); // o paciente falou e o app respondeu sozinho: não é a SDR
});

test('resposta rápida e curta da SDR pelo celular continua sendo gente (não vira «resposta automática»)', () => {
  const fs = falas([m('in', T0, 'Quanto custa?'), m('lite', T0 + 6, 'Já te explico!')]);
  assert.equal(fs[1].autor, 'equipe');
  const texts = normalizar([m('in', T0, 'oi'), m('lite', T0 + 3, 'Agradecemos o seu contato! Nosso atendimento é de segunda a sexta')]);
  assert.equal(ehRespostaAutomaticaDoApp(texts[1], texts), true);
});

test('o usuário do Kommo é equipe; com a etiqueta ▶ Retomada no cartão, ou com texto de robô conhecido, é robô', () => {
  const dela = 'Bom dia! Me chamo Mariana, sou secretária da Clínica Doutor Hérnia e vi seu contato.';
  assert.equal(falas([m('kommo', T0, dela)])[0].autor, 'equipe');
  assert.equal(falas([m('kommo', T0, dela)], [], { etiqueta: true })[0].autor, 'robo');
  assert.equal(falas([m('kommo', T0, 'Oi! Passando novamente porque vi que você procurou ajuda para sua coluna.')])[0].autor, 'robo');
  assert.equal(falas([m('kommo', T0, 'Olá, bom dia! Vi que você demonstrou interesse no nosso tratamento, tentei contato com você, mas não tive retorno')])[0].autor, 'robo');
});

test('a etiqueta de robô: ▶ Retomada, ▶ Retomada 2 e ▶ Retomada 3', () => {
  const tag = (name: string) => ({ _embedded: { tags: [{ id: 1, name }] } });
  assert.equal(cartaoComEtiquetaDeRobo(tag('▶ Retomada')), true);
  assert.equal(cartaoComEtiquetaDeRobo(tag('▶ Retomada 3')), true);
  assert.equal(cartaoComEtiquetaDeRobo(tag('PETRÓPOLIS')), false);
  assert.equal(cartaoComEtiquetaDeRobo({}), false);
});

// ─── a decisão pela conversa ──────────────────────────────────────────────────────────────────────

test('equipe por último há 2 h exatas: cutuca; 1 min antes: espera, e diz até quando', () => {
  const fs = falas([m('in', T0, 'oi'), m('lite', T0 + 5 * MIN, 'Para que eu possa te ajudar, qual é a sua dor?')]);
  const exato = decidirPelaConversa(fs, agora(T0 + 5 * MIN + ESPERA_PADRAO_MIN * MIN), cfg);
  assert.equal(exato.tipo, 'cutucar');
  const antes = decidirPelaConversa(fs, agora(T0 + 5 * MIN + ESPERA_PADRAO_MIN * MIN - 60), cfg);
  assert.deepEqual(antes, { tipo: 'pular', porque: 'dentro_do_prazo', depoisDe: (T0 + 5 * MIN + ESPERA_PADRAO_MIN * MIN) * 1000 });
});

test('o prazo é configurável por unidade (pipelineIntents.cutucada_espera_min) e a idade máxima também', () => {
  assert.deepEqual(configDaCutucada(null), { esperaMin: ESPERA_PADRAO_MIN, idadeMaxH: IDADE_MAX_PADRAO_H });
  assert.deepEqual(configDaCutucada({ cutucada_espera_min: 90, cutucada_idade_max_h: 30 }), { esperaMin: 90, idadeMaxH: 30 });
  assert.deepEqual(configDaCutucada({ cutucada_espera_min: 'abc', cutucada_idade_max_h: -3 }), { esperaMin: ESPERA_PADRAO_MIN, idadeMaxH: IDADE_MAX_PADRAO_H });
  const fs = falas([m('lite', T0, 'Posso te ajudar com algo mais?')]);
  assert.equal(decidirPelaConversa(fs, agora(T0 + 95 * MIN), configDaCutucada({ cutucada_espera_min: 90 })).tipo, 'cutucar');
});

test('paciente por último, Sofia por último e robô por último: NÃO é caso', () => {
  const eq = m('lite', T0, 'Qual a sua dor?');
  assert.deepEqual(decidirPelaConversa(falas([eq, m('in', T0 + 10 * MIN, 'Na lombar')]), agora(T0 + 5 * H), cfg), { tipo: 'pular', porque: 'paciente_falou_por_ultimo' });
  assert.deepEqual(decidirPelaConversa(falas([eq, m('sofia', T0 + 10 * MIN, 'Entendi!')], [T0 + 10 * MIN]), agora(T0 + 5 * H), cfg), { tipo: 'pular', porque: 'sofia_falou_por_ultimo' });
  assert.deepEqual(decidirPelaConversa(falas([eq, m('robo', T0 + 10 * MIN, 'Oi, Maria! Aqui é , da Doutor Hérnia.')], []), agora(T0 + 5 * H), cfg), { tipo: 'pular', porque: 'robo_falou_por_ultimo' });
  assert.deepEqual(decidirPelaConversa([], agora(T0), cfg), { tipo: 'pular', porque: 'sem_conversa' });
});

test('equipe → Sofia (a nossa própria cutucada) → silêncio: a Sofia ficou por último, não cutuca de novo', () => {
  const fs = falas([m('lite', T0, 'Qual a sua dor?'), m('sofia', T0 + 2 * H, 'Conseguiu ver?')], [T0 + 2 * H]);
  assert.equal(decidirPelaConversa(fs, agora(T0 + 9 * H), cfg).tipo, 'pular');
});

test('fala da equipe com mais de 48 h não vira cutucada (e a noite + o domingo cabem: sábado 18h50 → segunda 9h = 38 h)', () => {
  const fs = falas([m('lite', T0, 'Qual a sua dor?')]);
  assert.deepEqual(decidirPelaConversa(fs, agora(T0 + 49 * H), cfg), { tipo: 'pular', porque: 'fala_muito_antiga' });
  assert.equal(decidirPelaConversa(fs, agora(T0 + 38 * H), cfg).tipo, 'cutucar');
});

test('equipe se despediu («beleza», «obrigada, bom fim de semana»): não é pergunta no ar, não cutuca; áudio e pergunta sem «?» cutucam', () => {
  for (const t of ['beleza', 'Obrigada!! Bom final se semana', 'Ok, combinado!', 'Perfeito']) {
    assert.equal(ehEncerramento({ texto: t, anexo: null }), true, t);
    assert.deepEqual(decidirPelaConversa(falas([m('lite', T0, t)]), agora(T0 + 3 * H), cfg), { tipo: 'pular', porque: 'fala_de_encerramento' }, t);
  }
  assert.equal(ehEncerramento({ texto: 'Consigo um horário para senhora amanhã às 17 horas, a senhora consegue', anexo: null }), false);
  assert.equal(ehEncerramento({ texto: 'Ok, e como estão as dores?', anexo: null }), false);
  assert.equal(ehEncerramento({ texto: '', anexo: 'voice' }), false);
  assert.equal(decidirPelaConversa(falas([m('lite', T0, '', { attachment: { type: 'voice' } })]), agora(T0 + 3 * H), cfg).tipo, 'cutucar');
});

test('o caso real do lead 5806575, hora a hora: ligação combinada → robô falou → paciente → SDR por último', () => {
  const fs = falas([
    m('lite', T0, 'Olá, Sr Alex. Me chamo Giovana, da Clínica Doutor Hérnia.'),
    m('in', T0 + 3 * H, 'Bom dia, Vou te ligar.'),
    m('lite', T0 + 3 * H + 5 * MIN, 'Conforme a ligação, aguardo o senhor conversar com ele'),
  ]);
  assert.equal(decidirPelaConversa(fs, agora(T0 + 3 * H + 30 * MIN), cfg).tipo, 'pular');
  assert.equal(decidirPelaConversa(fs, agora(T0 + 5 * H + 6 * MIN), cfg).tipo, 'cutucar');
});

// ─── o cartão ─────────────────────────────────────────────────────────────────────────────────────

test('etapas da cutucada: a entrada (com os dois nomes) e EM QUALIFICAÇÃO, mais nenhuma', () => {
  for (const e of ['Incoming leads', 'Etapa de leads de entrada', 'EM QUALIFICAÇÃO', 'em qualificacao']) assert.equal(etapaDaCutucada(e), true, e);
  for (const e of ['EM ESPERA', 'AGENDADO', 'PERDIDO', 'EM TRATAMENTO', 'ALTA', 'COMPARECEU', '', null, undefined]) assert.equal(etapaDaCutucada(e), false, String(e));
});

const AGORA_S = T0 + 3 * H;
const base = { agora: AGORA_S, tz: 'America/Sao_Paulo', pausarIaFieldId: 246730 };
const cartao = (o: { tags?: string[]; campos?: Array<{ field_id?: number; field_name: string; value: unknown }> } = {}) => ({
  _embedded: { tags: (o.tags ?? []).map((name, i) => ({ id: i + 1, name })) },
  custom_fields_values: (o.campos ?? []).map((c) => ({ field_id: c.field_id ?? 9, field_name: c.field_name, values: [{ value: c.value }] })),
});

test('o cartão que fica quieto: NO_FOLLOW_UP, NAO_PERTURBAR, CURRÍCULO, opt-out, Pausar IA, consulta futura, ◷ Retomar em de hoje em diante', () => {
  assert.equal(porQueOCartaoFicaQuieto(cartao(), base), null);
  assert.equal(porQueOCartaoFicaQuieto(cartao({ tags: ['PETRÓPOLIS', '▶ Retomada'] }), base), null, 'a etiqueta ▶ Retomada sozinha não segura o cartão');
  assert.equal(porQueOCartaoFicaQuieto(cartao({ tags: ['NO_FOLLOW_UP'] }), base)?.codigo, 'nao-contatar');
  assert.equal(porQueOCartaoFicaQuieto(cartao({ tags: ['NAO_PERTURBAR'] }), base)?.codigo, 'nao-contatar');
  assert.equal(porQueOCartaoFicaQuieto(cartao({ tags: ['CURRÍCULO'] }), base)?.codigo, 'nao-contatar');
  assert.equal(porQueOCartaoFicaQuieto(cartao({ campos: [{ field_name: '✓ Opt-out WhatsApp', value: 'Sim' }] }), base)?.codigo, 'opt-out');
  assert.equal(porQueOCartaoFicaQuieto(cartao({ campos: [{ field_id: 246730, field_name: 'Pausar IA', value: true }] }), base)?.codigo, 'pausar-ia');
  // ◷ Retomar em: hoje e futuro seguram; ontem libera
  const retomar = (epoch: number) => cartao({ campos: [{ field_name: '◷ Retomar em', value: epoch }] });
  assert.equal(porQueOCartaoFicaQuieto(retomar(T0), base)?.codigo, 'retomar-em');
  assert.equal(porQueOCartaoFicaQuieto(retomar(T0 + 3 * 86_400), base)?.codigo, 'retomar-em');
  assert.equal(porQueOCartaoFicaQuieto(retomar(T0 - 2 * 86_400), base), null);
  // consulta futura no cartão (data de amanhã, situação Agendado) segura; consulta que já passou não
  const consulta = (epoch: number, situacao: string) => cartao({ campos: [{ field_name: '◷ Data da Consulta', value: epoch }, { field_name: '✓ Situação da consulta', value: situacao }] });
  assert.equal(porQueOCartaoFicaQuieto(consulta(T0 + 86_400, 'Agendado'), base)?.codigo, 'consulta-futura-cartao');
  assert.equal(porQueOCartaoFicaQuieto(consulta(T0 - 86_400, 'Agendado'), base), null);
});

// ─── o texto ──────────────────────────────────────────────────────────────────────────────────────

test('o texto que sai: curto, termina em pergunta, sem preço/Pix/sinal, sem ligação que a conversa não citou', () => {
  const conv = 'ATENDENTE DA CLÍNICA (humana): Para que eu possa te ajudar, qual é a sua dor?';
  assert.equal(porQueOTextoNaoSai('Oi! Aqui é a Sofia, da equipe da clínica. Conseguiu ver a pergunta da nossa atendente sobre a sua dor?', conv), null);
  assert.equal(porQueOTextoNaoSai('Oi, tudo bem? Conseguiu pensar no que a nossa atendente perguntou? 😊', conv), null);
  assert.match(porQueOTextoNaoSai('Oi! Podemos conversar sobre a sua dor.', conv) ?? '', /pergunta/);
  assert.match(porQueOTextoNaoSai('Oi! A consulta custa R$ 200, podemos marcar?', conv) ?? '', /valor/);
  assert.match(porQueOTextoNaoSai('Oi! Posso te mandar o Pix para garantir a vaga?', conv) ?? '', /valor/);
  assert.match(porQueOTextoNaoSai('Oi! Quer pagar o sinal para reservar o horário?', conv) ?? '', /valor/);
  assert.match(porQueOTextoNaoSai('Oi! Tentamos ligar para você, conseguimos falar agora?', conv) ?? '', /ligação/);
  assert.equal(porQueOTextoNaoSai('Oi! Como combinado na ligação, ainda quer conversar com a nossa atendente?', 'PACIENTE: Bom dia, vou te ligar.'), null);
  assert.match(porQueOTextoNaoSai('Oi?', conv) ?? '', /curto/);
  assert.match(porQueOTextoNaoSai(`${'Oi, tudo bem com você? '.repeat(20)}`, conv) ?? '', /300/);
});

test('a conversa para o modelo: quem é quem, o áudio da equipe aparece como marca e o limite de falas vale', () => {
  const fs = falas([m('in', T0, 'Quero saber'), m('sofia', T0 + 10, 'Oi!'), m('lite', T0 + H, '', { attachment: { type: 'voice' } })], [T0 + 10]);
  assert.equal(conversaParaOModelo(fs), 'PACIENTE: Quero saber\nVOCÊ (Sofia): Oi!\nATENDENTE DA CLÍNICA (humana): [áudio]');
  assert.equal(conversaParaOModelo(fs, 1), 'ATENDENTE DA CLÍNICA (humana): [áudio]');
});

test('a marca de «uma vez por lead» é um id estável por unidade e lead (chave primária = idempotência)', () => {
  assert.equal(idDaMarcaDaCutucada('u1', 5806575), 'cutucada-apos-equipe-u1-5806575');
  assert.notEqual(idDaMarcaDaCutucada('u1', 1), idDaMarcaDaCutucada('u2', 1));
});
