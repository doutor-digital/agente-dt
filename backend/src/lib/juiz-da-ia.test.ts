import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatAnthropic } from '@langchain/anthropic';

import {
  autorDaFala,
  avaliabilidadeDaConversa,
  custoComFallback,
  DESCARTE_ESGOTADO_MS,
  DESCARTE_ERRO_MS,
  MAX_TENTATIVAS_ERRO,
  Descartes,
  escolherJuiz,
  esforcoDoJuiz,
  falaReal,
  interpretarSaidaDoJuiz,
  montarPedidoAnthropic,
  respostaCortada,
  SCHEMA_DO_JUIZ,
  textoDaResposta,
} from './juiz-da-ia.js';
import { AVISO_PARA_IA } from './mensagem-nao-renderizada.js';

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });

// ── provedor ─────────────────────────────────────────────────────────────────────────────────────

test('padrão: sem JUDGE_PROVIDER é o juiz de hoje (openai, gpt-4o-mini)', () => {
  const e = escolherJuiz({}, { anthropicApiKey: 'sk-ant-x' });
  assert.equal(e.provedor, 'openai');
  assert.equal(e.modelo, 'gpt-4o-mini');
  assert.equal(e.apiKeyAnthropic, null);
});

test('JUDGE_MODEL continua valendo no openai; valor estranho de provedor também é openai', () => {
  assert.equal(escolherJuiz({ JUDGE_MODEL: 'gpt-5-mini' }, null).modelo, 'gpt-5-mini');
  assert.equal(escolherJuiz({ JUDGE_PROVIDER: 'Anthropic ' }, { anthropicApiKey: 'k' }).provedor, 'anthropic');
  assert.equal(escolherJuiz({ JUDGE_PROVIDER: 'claude' }, { anthropicApiKey: 'k' }).provedor, 'openai');
});

test('anthropic: Haiku 5.5, chave da unidade primeiro, depois env', () => {
  const e = escolherJuiz({ JUDGE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'env' }, { anthropicApiKey: 'unidade' });
  assert.equal(e.provedor, 'anthropic');
  assert.equal(e.modelo, 'claude-haiku-5-5');
  assert.equal(e.apiKeyAnthropic, 'unidade');
  assert.equal(escolherJuiz({ JUDGE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'env' }, { anthropicApiKey: null }).apiKeyAnthropic, 'env');
});

test('anthropic: JUDGE_MODEL só sobrescreve se for claude (gpt-… na Messages API seria 404)', () => {
  const env = { JUDGE_PROVIDER: 'anthropic' };
  const unit = { anthropicApiKey: 'k' };
  assert.equal(escolherJuiz({ ...env, JUDGE_MODEL: 'claude-haiku-4-5' }, unit).modelo, 'claude-haiku-4-5');
  assert.equal(escolherJuiz({ ...env, JUDGE_MODEL: 'gpt-4o-mini' }, unit).modelo, 'claude-haiku-5-5');
});

test('anthropic sem chave nenhuma cai para openai e diz por quê', () => {
  const e = escolherJuiz({ JUDGE_PROVIDER: 'anthropic' }, { anthropicApiKey: '  ' });
  assert.equal(e.provedor, 'openai');
  assert.equal(e.modelo, 'gpt-4o-mini');
  assert.match(e.motivoDoFallback ?? '', /anthropicApiKey/);
});

test('plano B: anthropic sem chave com JUDGE_MODEL=claude-… volta ao modelo padrão da OpenAI, não manda claude para a OpenAI', () => {
  const e = escolherJuiz({ JUDGE_PROVIDER: 'anthropic', JUDGE_MODEL: 'claude-haiku-5-5' }, { anthropicApiKey: null });
  assert.equal(e.provedor, 'openai');
  assert.equal(e.modelo, 'gpt-4o-mini');
  assert.equal(escolherJuiz({ JUDGE_PROVIDER: 'anthropic', JUDGE_MODEL: 'gpt-5-mini' }, null).modelo, 'gpt-5-mini'); // gpt-… configurado é mantido
});

test('esforço: low por padrão, off desliga o parâmetro, lixo vira low', () => {
  assert.equal(esforcoDoJuiz({}), 'low');
  assert.equal(esforcoDoJuiz({ JUDGE_ANTHROPIC_EFFORT: 'HIGH' }), 'high');
  assert.equal(esforcoDoJuiz({ JUDGE_ANTHROPIC_EFFORT: 'off' }), null);
  assert.equal(esforcoDoJuiz({ JUDGE_ANTHROPIC_EFFORT: 'xhigh' }), 'low');
});

// ── pedido ───────────────────────────────────────────────────────────────────────────────────────

test('pedido: saída estruturada em output_config.format, thinking desligado, SEM temperature', () => {
  const p = montarPedidoAnthropic({ modelo: 'claude-haiku-5-5', system: 'S', user: 'U', esforco: 'low' });
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.deepEqual(p.thinking, { type: 'disabled' });
  assert.equal(p.output_config.effort, 'low');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.output_config.format.schema, SCHEMA_DO_JUIZ);
  assert.deepEqual(p.messages, [{ role: 'user', content: 'U' }]);
  assert.equal(p.system, 'S');
  assert.ok(!('temperature' in p) && !('top_p' in p));
  assert.ok(!('effort' in montarPedidoAnthropic({ modelo: 'm', system: '', user: '', esforco: null }).output_config));
});

test('schema: os mesmos 5 critérios e o veredito que o leitor espera, sem campo extra', () => {
  assert.deepEqual(Object.keys(SCHEMA_DO_JUIZ.properties.scores.properties), ['clareza', 'empatia', 'objecoes', 'cta', 'tom']);
  assert.deepEqual([...SCHEMA_DO_JUIZ.required], ['scores', 'verdict']);
  assert.equal(SCHEMA_DO_JUIZ.additionalProperties, false);
});

test('o LangChain 1.3.29 leva thinking e output_config.format ao payload, sem temperature', () => {
  const p = montarPedidoAnthropic({ modelo: 'claude-haiku-5-5', system: 'S', user: 'U', esforco: 'low' });
  const m = new ChatAnthropic({ apiKey: 'x', model: p.model, maxTokens: p.max_tokens, thinking: p.thinking, outputConfig: p.output_config });
  const inv = m.invocationParams({}) as unknown as Record<string, unknown>;
  assert.deepEqual(inv.output_config, p.output_config);
  assert.deepEqual(inv.thinking, { type: 'disabled' });
  assert.equal(inv.max_tokens, p.max_tokens);
  assert.ok(inv.temperature === undefined || inv.temperature === null, `temperature foi ${String(inv.temperature)}`);
  assert.ok(inv.top_p === undefined || inv.top_p === null);
  assert.ok(inv.top_k === undefined || inv.top_k === null);
});

// ── leitura estrita ──────────────────────────────────────────────────────────────────────────────

const BOA = JSON.stringify({ scores: { clareza: 8, empatia: 7.5, objecoes: 6, cta: 9, tom: 8 }, verdict: 'Boa condução.' });

test('leitura estrita: resposta boa passa e as notas são limitadas a 0–10', () => {
  const r = interpretarSaidaDoJuiz(BOA);
  assert.equal(r?.scores.empatia, 7.5);
  assert.equal(r?.verdict, 'Boa condução.');
  const fora = interpretarSaidaDoJuiz(JSON.stringify({ scores: { clareza: 14, empatia: -3, objecoes: 5, cta: 5, tom: 5 }, verdict: 'x' }));
  assert.equal(fora?.scores.clareza, 10);
  assert.equal(fora?.scores.empatia, 0);
});

test('leitura estrita: tudo que o leitor antigo tratava como nota 0 aqui é null', () => {
  const ruins = [
    '',
    'não é json',
    '{"scores": {"clareza": 8',
    '[]',
    'null',
    '{}',
    '{"verdict":"sem notas"}',
    JSON.stringify({ scores: { clareza: 8, empatia: 8, objecoes: 8, cta: 8 }, verdict: 'falta tom' }),
    JSON.stringify({ scores: { clareza: '8', empatia: 8, objecoes: 8, cta: 8, tom: 8 }, verdict: 'nota em texto' }),
    JSON.stringify({ scores: { clareza: 8, empatia: 8, objecoes: 8, cta: 8, tom: null }, verdict: 'nulo' }),
    JSON.stringify({ scores: { clareza: 8, empatia: 8, objecoes: 8, cta: 8, tom: 8 } }),
    JSON.stringify({ scores: { clareza: 8, empatia: 8, objecoes: 8, cta: 8, tom: 8 }, verdict: '   ' }),
  ];
  for (const r of ruins) assert.equal(interpretarSaidaDoJuiz(r), null, `deveria rejeitar: ${r}`);
});

test('textoDaResposta junta só os blocos text; respostaCortada pega refusal e max_tokens', () => {
  assert.equal(textoDaResposta('abc'), 'abc');
  assert.equal(textoDaResposta([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }]), '{"a":1}');
  assert.equal(textoDaResposta(undefined), '');
  assert.equal(respostaCortada('refusal'), true);
  assert.equal(respostaCortada('max_tokens'), true);
  assert.equal(respostaCortada('end_turn'), false);
  assert.equal(respostaCortada(null), false);
});

test('custo: usa o calculado; se for 0 e o modelo tiver fallback, calcula (US$ 0,10 / 0,50 por MTok)', () => {
  assert.equal(custoComFallback('claude-haiku-5-5', 0.5, 1000, 1000), 0.5);
  // 3.000 tokens de entrada + 300 de saída = 0,0003 + 0,00015
  assert.equal(custoComFallback('claude-haiku-5-5', 0, 3000, 300), 0.00045);
  assert.equal(custoComFallback('modelo-desconhecido', 0, 3000, 300), 0);
});

// ── quem merece nota ─────────────────────────────────────────────────────────────────────────────

test('falaReal: marca de mídia que não abriu não é fala; texto junto com a marca é', () => {
  assert.equal(falaReal(''), '');
  assert.equal(falaReal(null), '');
  assert.equal(falaReal('[cliente mandou uma imagem ou um arquivo, mas não foi possível ler]'), '');
  assert.equal(falaReal('[áudio do cliente — não deu pra ouvir]'), '');
  assert.equal(falaReal('[áudio sem fala detectada]'), '');
  assert.equal(falaReal('[imagem sem conteúdo legível]'), '');
  assert.equal(falaReal(AVISO_PARA_IA), '');
  assert.equal(falaReal('Unable to display this message in CRM. View it in the WhatsApp Business app.'), '');
  assert.equal(falaReal('Já paguei\n\n[cliente mandou uma imagem ou um arquivo, mas não foi possível ler]'), 'Já paguei');
  assert.equal(falaReal('[imagem do cliente]: Radiografia de coluna lombar'), '[imagem do cliente]: Radiografia de coluna lombar');
  assert.equal(falaReal('[áudio do cliente]: tô com dor na coluna'), '[áudio do cliente]: tô com dor na coluna');
});

test('conversa normal é avaliável', () => {
  const r = avaliabilidadeDaConversa([u('Oi, queria saber o preço'), a('Oi! Claro…'), u('Moro em Imperatriz'), a('Perfeito, temos horário…')]);
  assert.deepEqual(r, { avaliavel: true, falasReais: 2, falasDaIa: 2, falasDaEquipe: 0 });
});

test('IA não falou (pausa): não avaliável, não é falha da Sofia', () => {
  const r = avaliabilidadeDaConversa([u('Oi'), u('Alguém aí?'), u('Quero marcar'), u('Por favor')]);
  assert.deepEqual(r, { avaliavel: false, motivo: 'ia_nao_falou', falasReais: 4, falasDaIa: 0, falasDaEquipe: 0 });
});

test('paciente só mandou mídia que não abriu: sem fala real', () => {
  const r = avaliabilidadeDaConversa([
    u('[cliente mandou uma imagem ou um arquivo, mas não foi possível ler]'),
    a('Pode me contar por escrito?'),
    u(AVISO_PARA_IA),
    a('Me conta o que foi?'),
    u(''),
    a('Oi?'),
  ]);
  assert.equal(r.avaliavel, false);
  assert.equal(!r.avaliavel && r.motivo, 'sem_fala_real_do_paciente');
});

test('paciente sumiu depois da 1ª fala: não avaliável; com minFalasReais=1 passa', () => {
  const conv = [u('Oi, quanto custa?'), a('Oi! Tudo bem?'), a('Ainda por aí?'), a('Posso ajudar?')];
  const r = avaliabilidadeDaConversa(conv);
  assert.equal(!r.avaliavel && r.motivo, 'paciente_falou_pouco');
  assert.equal(avaliabilidadeDaConversa(conv, { minFalasReais: 1 }).avaliavel, true);
});

test('lista vazia: não avaliável', () => {
  assert.equal(avaliabilidadeDaConversa([]).avaliavel, false);
});

// ── quem falou (equipe e automação gravadas como assistant) ──────────────────────────────────────

const equipe = (content: string) => ({ role: 'assistant', content, meta: { origem: 'kommo_talks', kommoMessageId: 'x', autor: 'equipe', nome: 'Ana' } });
const lembrete = (content: string) => ({ role: 'assistant', content, meta: { origem: 'confirmacao_d1', via: 'meta' } });
const lembreteKommo = (content: string) => ({ role: 'assistant', content, meta: { origem: 'lembrete_kommo' } });
const sofia = (content: string) => ({ role: 'assistant', content, meta: { via: 'salesbot', botoes: [] } });

test('autorDaFala: autor=equipe e origem kommo_talks são a equipe; confirmacao_* e lembrete_kommo são automação; o resto é a IA', () => {
  assert.equal(autorDaFala(equipe('oi')), 'equipe');
  assert.equal(autorDaFala({ role: 'assistant', content: 'x', meta: { origem: 'kommo_talks' } }), 'equipe');
  assert.equal(autorDaFala(lembrete('x')), 'automacao');
  assert.equal(autorDaFala(lembreteKommo('x')), 'automacao');
  assert.equal(autorDaFala(sofia('x')), 'ia');
  assert.equal(autorDaFala({ role: 'assistant', content: 'x' }), 'ia'); // sem meta (mensagens antigas)
  assert.equal(autorDaFala({ role: 'assistant', content: 'x', meta: [] }), 'ia');
});

test('só a equipe e as automações falaram: a Sofia não falou (era contado como fala da IA)', () => {
  const r = avaliabilidadeDaConversa([u('Oi, quero marcar'), equipe('Oi! Aqui é a Ana'), u('Quinta serve?'), equipe('Serve sim'), lembrete('Lembrete da consulta')]);
  assert.deepEqual(r, { avaliavel: false, motivo: 'equipe_assumiu', falasReais: 2, falasDaIa: 0, falasDaEquipe: 2 });
  const so = avaliabilidadeDaConversa([u('Oi'), u('Tem horário?'), lembrete('Confirmação'), lembreteKommo('Lembrete')]);
  assert.equal(!so.avaliavel && so.motivo, 'ia_nao_falou'); // automação não conta nem como IA nem como equipe
});

test('a equipe assumiu no meio: falou tanto quanto ou mais que a Sofia -> não avaliável; a Sofia à frente -> avaliável', () => {
  const assumiu = avaliabilidadeDaConversa([u('Oi'), sofia('Oi! Tudo bem?'), u('Quanto custa?'), equipe('Aqui é a Ana, é R$ 250'), u('Ok'), equipe('Marcamos?')]);
  assert.equal(!assumiu.avaliavel && assumiu.motivo, 'equipe_assumiu');
  const empate = avaliabilidadeDaConversa([u('Oi'), sofia('Oi!'), u('Preço?'), equipe('R$ 250')]);
  assert.equal(!empate.avaliavel && empate.motivo, 'equipe_assumiu');
  const sofiaNaFrente = avaliabilidadeDaConversa([u('Oi'), sofia('Oi!'), u('Preço?'), sofia('R$ 250'), equipe('Qualquer dúvida, é a Ana')]);
  assert.equal(sofiaNaFrente.avaliavel, true);
});

test('lembrete de véspera não faz uma conversa sem Sofia virar avaliável', () => {
  const r = avaliabilidadeDaConversa([u('Oi'), u('Alguém?'), lembrete('Lembrete'), lembrete('Lembrete 2'), lembreteKommo('Lembrete 3')]);
  assert.equal(r.avaliavel, false);
});

// ── fila de descartes ────────────────────────────────────────────────────────────────────────────

test('Descartes: lembra até a hora marcada e esquece sozinho', () => {
  const d = new Descartes(10);
  d.lembrar('a', 1_000, 0);
  d.lembrar('b', 5_000, 0);
  assert.deepEqual(d.vigentes(500), ['a', 'b']);
  assert.deepEqual(d.vigentes(1_000), ['b']); // 'a' expirou
});

test('Descartes: acima do teto saem primeiro os VENCIDOS; só depois o que vence antes — nunca um válido por mais tempo', () => {
  const d = new Descartes(3);
  d.lembrar('vence-cedo', 2_000, 0);
  d.lembrar('vencido', 100, 0);
  d.lembrar('longo', 90_000, 0);
  d.lembrar('novo', 50_000, 1_000); // passou do teto; 'vencido' (100 <= 1000) sai, ninguém mais precisa sair
  assert.deepEqual(d.vigentes(1_000).sort(), ['longo', 'novo', 'vence-cedo']);
  d.lembrar('outro', 60_000, 1_000); // agora todos valem: sai o que vence antes ('vence-cedo'), não o mais antigo inserido
  assert.deepEqual(d.vigentes(1_000).sort(), ['longo', 'novo', 'outro']);
});

test('Descartes.falhou: espera 1 h nas primeiras e desiste por 7 dias na última tentativa', () => {
  const d = new Descartes();
  const t0 = 1_000_000;
  for (let i = 1; i < MAX_TENTATIVAS_ERRO; i++) {
    assert.deepEqual(d.falhou('c1', t0), { tentativas: i, esgotada: false });
    assert.deepEqual(d.vigentes(t0 + DESCARTE_ERRO_MS - 1), ['c1']);
    assert.deepEqual(d.vigentes(t0 + DESCARTE_ERRO_MS), []);
  }
  assert.deepEqual(d.falhou('c1', t0), { tentativas: MAX_TENTATIVAS_ERRO, esgotada: true });
  assert.deepEqual(d.vigentes(t0 + DESCARTE_ESGOTADO_MS - 1), ['c1']);
  assert.deepEqual(d.vigentes(t0 + DESCARTE_ESGOTADO_MS), []);
  // outra conversa começa do zero
  assert.deepEqual(d.falhou('c2', t0), { tentativas: 1, esgotada: false });
});
