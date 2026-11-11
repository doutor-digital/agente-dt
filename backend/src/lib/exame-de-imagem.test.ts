import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCAO_DO_EXAME,
  LINHA_DA_VISAO,
  ehLeituraDeExame,
  exameDeImagemLigado,
  grupoDoExame,
  linkDoCartao,
  mandarNoGrupo,
  textoDaTarefa,
  textoDoGrupo,
} from './exame-de-imagem.js';
import { promptDaVisao } from '../services/vision.service.js';

// Pedido da dona de Timbó (10/11/2026), decisão do João (11/11/2026): exame de imagem no chat → pausa + alerta no grupo.

test('chave desligada: o prompt da visão é o de sempre; ligada só na unidade da lista', () => {
  assert.doesNotMatch(promptDaVisao(), /EXAME DE IMAGEM:/);
  assert.equal(promptDaVisao(false), promptDaVisao());
  const ligado = promptDaVisao(true);
  assert.match(ligado, /EXAME DE IMAGEM:/);
  assert.ok(ligado.includes(LINHA_DA_VISAO));
  // a regra do comprovante continua lá, e a última linha (no máximo 4 frases) continua a última
  assert.match(ligado, /COMPROVANTE:/);
  assert.match(ligado.split('\n').at(-1) ?? '', /No máximo 4 frases/);

  const antes = process.env.EXAME_DE_IMAGEM_SLUGS;
  process.env.EXAME_DE_IMAGEM_SLUGS = 'doutor-hernia-timbo';
  try {
    assert.equal(exameDeImagemLigado({ slug: 'doutor-hernia-timbo' }), true);
    assert.equal(exameDeImagemLigado({ slug: 'doutor-hernia-outra' }), false);
  } finally {
    if (antes === undefined) delete process.env.EXAME_DE_IMAGEM_SLUGS;
    else process.env.EXAME_DE_IMAGEM_SLUGS = antes;
  }
  assert.equal(exameDeImagemLigado({ slug: 'doutor-hernia-timbo' }), antes?.includes('doutor-hernia-timbo') ?? false);
});

test('o que é exame: só a leitura com a marca; comprovante e foto do corpo não', () => {
  assert.equal(ehLeituraDeExame('EXAME DE IMAGEM: ressonância da coluna lombar, laudo cita protrusão L4-L5.'), true);
  assert.equal(ehLeituraDeExame('  exame de imagem: raio-X da cervical'), true);
  assert.equal(ehLeituraDeExame('COMPROVANTE: Pix de R$ 50,00 para Clínica X'), false);
  assert.equal(ehLeituraDeExame('Foto das costas de uma pessoa, sem marcas visíveis.'), false);
  assert.equal(ehLeituraDeExame('Pedido médico de ressonância magnética da coluna.'), false);
  assert.equal(ehLeituraDeExame(null), false);
});

test('instrução ao modelo: pausar, uma frase, sem interpretar, sem prazo', () => {
  assert.match(INSTRUCAO_DO_EXAME, /pausar_ia/);
  assert.match(INSTRUCAO_DO_EXAME, /NÃO comente nem interprete o exame/);
  assert.match(INSTRUCAO_DO_EXAME, /NÃO prometa prazo/);
  assert.match(INSTRUCAO_DO_EXAME, /<sinal_de_alerta> vale antes/);
  assert.doesNotMatch(INSTRUCAO_DO_EXAME, /sinalDeAlerta: true/);
});

test('textos do grupo e da tarefa', () => {
  const leituras = ['EXAME DE IMAGEM: ressonância lombar', 'EXAME DE IMAGEM: laudo da mesma ressonância'];
  const g = textoDoGrupo({ unidade: 'Doutor Hérnia Timbó', leadId: 123, link: linkDoCartao({ kommoSubdomain: 'timbosc' }, 123), leituras });
  assert.match(g, /Exame de imagem recebido — Doutor Hérnia Timbó/);
  assert.match(g, /https:\/\/timbosc\.kommo\.com\/leads\/detail\/123/);
  assert.match(g, /ressonância lombar \| laudo da mesma ressonância/);
  assert.doesNotMatch(g, /EXAME DE IMAGEM:/);
  assert.equal(linkDoCartao({ kommoSubdomain: null }, 1), null);
  const t = textoDaTarefa('doutor-hernia-timbo', leituras);
  assert.match(t, /^ALERTA · doutor-hernia-timbo · Exame de imagem/);
  assert.doesNotMatch(t, /LIGAR AGORA/);
});

test('grupo por unidade e envio pela Evolution (sem config = não manda, nunca lança)', async () => {
  assert.equal(grupoDoExame('doutor-hernia-timbo', '{"doutor-hernia-timbo":"120363000000000000@g.us"}'), '120363000000000000@g.us');
  assert.equal(grupoDoExame('doutor-hernia-outra', '{"doutor-hernia-timbo":"x@g.us"}'), null);
  assert.equal(grupoDoExame('doutor-hernia-timbo', 'não é json'), null);
  assert.equal(grupoDoExame('doutor-hernia-timbo', ''), null);

  const nomes = ['EXAME_DE_IMAGEM_EVOLUTION_URL', 'EXAME_DE_IMAGEM_EVOLUTION_HEADER', 'EXAME_DE_IMAGEM_EVOLUTION_VALUE', 'EVOLUTION_ALERT_HEADER', 'EVOLUTION_ALERT_VALUE'];
  const antes = Object.fromEntries(nomes.map((k) => [k, process.env[k]]));
  try {
    for (const k of nomes) delete process.env[k];
    let chamou = 0;
    const post = (async () => {
      chamou++;
      return {};
    }) as never;
    assert.equal(await mandarNoGrupo('g@g.us', 'oi', { post }), false);
    assert.equal(chamou, 0);

    process.env.EXAME_DE_IMAGEM_EVOLUTION_URL = 'https://evo.exemplo/message/sendText/inst';
    process.env.EVOLUTION_ALERT_HEADER = 'apikey';
    process.env.EVOLUTION_ALERT_VALUE = 'segredo';
    const enviados: unknown[] = [];
    const postOk = (async (url: string, corpo: unknown, cfg: { headers: Record<string, string> }) => {
      enviados.push({ url, corpo, apikey: cfg.headers.apikey });
      return {};
    }) as never;
    assert.equal(await mandarNoGrupo('g@g.us', 'oi', { post: postOk }), true);
    assert.deepEqual(enviados, [{ url: 'https://evo.exemplo/message/sendText/inst', corpo: { number: 'g@g.us', text: 'oi' }, apikey: 'segredo' }]);

    const postFalha = (async () => {
      throw new Error('500');
    }) as never;
    assert.equal(await mandarNoGrupo('g@g.us', 'oi', { post: postFalha }), false);
  } finally {
    for (const k of nomes) {
      if (antes[k] === undefined) delete process.env[k];
      else process.env[k] = antes[k];
    }
  }
});
