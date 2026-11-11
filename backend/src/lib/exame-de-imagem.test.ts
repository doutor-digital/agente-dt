import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCAO_DO_EXAME,
  LINHA_DA_VISAO,
  ehLeituraDeExame,
  exameDeImagemLigado,
  garantirPausaDoExame,
  grupoDoExame,
  linkDoCartao,
  mandarNoGrupo,
  marcarExameNoTurno,
  textoDaTarefa,
  textoDoGrupo,
  tirarExameDoTurno,
} from './exame-de-imagem.js';
import { promptDaVisao } from '../services/vision.service.js';

// Pedido da dona de Timbó (10/11/2026), decisão do João (11/11/2026): exame de imagem no chat → pausa + aviso à equipe.

test('chave desligada: o prompt da visão é o de sempre; ligada só na unidade da lista', () => {
  assert.doesNotMatch(promptDaVisao(), /EXAME DE IMAGEM:/);
  assert.equal(promptDaVisao(false), promptDaVisao());
  const ligado = promptDaVisao(true);
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
});

test('o que é exame: a marca, mesmo com enfeite de markdown ou aspas; comprovante e foto do corpo não', () => {
  for (const sim of [
    'EXAME DE IMAGEM: ressonância da coluna lombar.',
    '  exame de imagem: raio-X da cervical',
    '**EXAME DE IMAGEM:** ressonância lombar',
    '**EXAME DE IMAGEM**: ressonância lombar',
    '"EXAME DE IMAGEM: tomografia"',
    '“EXAME DE IMAGEM: ultrassom”',
    '# EXAME DE IMAGEM: ressonância',
  ]) {
    assert.equal(ehLeituraDeExame(sim), true, sim);
  }
  for (const nao of [
    'COMPROVANTE: Pix de R$ 50,00 para Clínica X',
    '**COMPROVANTE:** Pix — EXAME DE IMAGEM: não',
    'Foto das costas de uma pessoa, sem marcas visíveis.',
    'Pedido médico de ressonância magnética da coluna.',
    'O paciente mandou um EXAME DE IMAGEM: no meio da frase não conta',
    '',
  ]) {
    assert.equal(ehLeituraDeExame(nao), false, nao);
  }
  assert.equal(ehLeituraDeExame(null), false);
});

test('instrução ao modelo: pausar, uma frase, sem interpretar, sem prazo, sem virar sinal de alerta', () => {
  assert.match(INSTRUCAO_DO_EXAME, /pausar_ia/);
  assert.match(INSTRUCAO_DO_EXAME, /NÃO comente nem interprete o exame/);
  assert.match(INSTRUCAO_DO_EXAME, /NÃO prometa prazo/);
  assert.match(INSTRUCAO_DO_EXAME, /<sinal_de_alerta> vale antes/);
  assert.doesNotMatch(INSTRUCAO_DO_EXAME, /sinalDeAlerta: true/);
});

test('grupo e tarefa: sem o conteúdo do exame (LGPD); prefixo do roteador só quando o grupo próprio não recebeu', () => {
  const g = textoDoGrupo({ unidade: 'Doutor Hérnia Timbó', leadId: 123, link: linkDoCartao({ kommoSubdomain: 'timbosc' }, 123) });
  assert.match(g, /Exame de imagem recebido — Doutor Hérnia Timbó/);
  assert.match(g, /https:\/\/timbosc\.kommo\.com\/leads\/detail\/123/);
  assert.match(g, /Fora do horário da IA o paciente ainda não recebeu resposta/);
  assert.doesNotMatch(g, /disse ao paciente/);
  assert.equal(linkDoCartao({ kommoSubdomain: null }, 1), null);

  const comRoteador = textoDaTarefa('doutor-hernia-timbo', true);
  assert.match(comRoteador, /^ALERTA · doutor-hernia-timbo · Exame de imagem/);
  assert.doesNotMatch(comRoteador, /LIGAR AGORA/);
  const semRoteador = textoDaTarefa('doutor-hernia-timbo', false);
  assert.doesNotMatch(semRoteador, /ALERTA/);
  assert.match(semRoteador, /^Exame de imagem enviado pelo paciente/);
});

test('grupo próprio por unidade e envio pela Evolution (sem config = não manda, nunca lança)', async () => {
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

test('pausa garantida no fim do turno: marca a caixinha só se o modelo não marcou; na dúvida, marca', async () => {
  const unit = { slug: 'doutor-hernia-timbo', kommoPausedFieldId: 777 };
  const marcadas: number[] = [];
  const deps = (jaMarcada: boolean | 'erro', marcarFalha = false) => ({
    caixinhaMarcada: async () => {
      if (jaMarcada === 'erro') throw new Error('kommo fora');
      return jaMarcada;
    },
    marcarCaixinha: async (lead: number) => {
      if (marcarFalha) throw new Error('kommo fora');
      marcadas.push(lead);
    },
  });
  assert.equal(await garantirPausaDoExame(unit, 1, deps(true)), 'ja_pausada');
  assert.equal(await garantirPausaDoExame(unit, 2, deps(false)), 'pausou');
  assert.equal(await garantirPausaDoExame(unit, 3, deps('erro')), 'pausou');
  assert.equal(await garantirPausaDoExame(unit, 4, deps(false, true)), 'falhou');
  assert.equal(await garantirPausaDoExame({ slug: 'x', kommoPausedFieldId: null }, 5, deps(false)), 'sem_campo');
  assert.deepEqual(marcadas, [2, 3]);

  // a marca do turno: uma vez só
  marcarExameNoTurno('u1', 10);
  assert.equal(tirarExameDoTurno('u1', 10), true);
  assert.equal(tirarExameDoTurno('u1', 10), false);
  assert.equal(tirarExameDoTurno('u1', 11), false);
});
