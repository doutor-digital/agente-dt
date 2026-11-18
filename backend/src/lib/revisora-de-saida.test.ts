import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoriaRevisavel,
  consolidar,
  cumprimentoForaDeHora,
  dadosDaRevisao,
  decidirPeloEstado,
  descreverFalas,
  descreverPrecos,
  descreverStatus,
  escolherRevisora,
  falasParaARevisora,
  ferramentasDoTurnoComResultado,
  horaLocalDaUnidade,
  lerVeredito,
  promptDaRevisora,
  REGRAS,
  REGRAS_DO_MODELO,
  SCHEMA_DA_REVISORA,
  type EntradaDaRevisora,
  type MensagemDoBanco,
} from './revisora-de-saida.js';
import { montarPedidoAnthropic, SCHEMA_DO_JUIZ, MAX_TOKENS_DO_JUIZ } from './juiz-da-ia.js';

// ── a lista ───────────────────────────────────────────────────────────────────────────────────────

test('a lista tem as 8 regras pedidas, e só a 8 é de código', () => {
  assert.deepEqual(
    REGRAS.map((r) => r.id),
    [
      'preco_contraditorio',
      'sem_custo',
      'horario_antes_da_dor',
      'paciente_em_tratamento_como_lead',
      'diagnostico_ou_ps',
      'promessa_sem_acao',
      'por_cima_da_equipe',
      'cumprimento_fora_de_hora',
    ],
  );
  assert.deepEqual(REGRAS.filter((r) => r.porCodigo).map((r) => r.id), ['cumprimento_fora_de_hora']);
  assert.equal(REGRAS_DO_MODELO.length, 7);
});

test('o prompt cita cada regra do modelo, o caso real do preço, e manda aprovar na dúvida', () => {
  const p = promptDaRevisora();
  for (const id of REGRAS_DO_MODELO) assert.ok(p.includes(id), `falta ${id}`);
  assert.ok(!p.includes('1. cumprimento_fora_de_hora'), 'a regra de código não vai para o modelo');
  assert.match(p, /R\$ 250 garantindo com sinal de R\$ 250 antecipado/);
  assert.match(p, /Na dúvida, APROVE/);
  assert.match(p, /NÃO é erro/);
});

test('o schema só aceita ids das regras do modelo e exige tudo (OpenAI strict / Anthropic)', () => {
  const s = SCHEMA_DA_REVISORA as any;
  assert.deepEqual(s.properties.veredito.enum, ['aprova', 'barraria']);
  assert.deepEqual(s.properties.violacoes.items.properties.regra.enum, [...REGRAS_DO_MODELO]);
  assert.deepEqual(s.required, ['veredito', 'violacoes']);
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.violacoes.items.additionalProperties, false);
});

// ── leitura estrita ───────────────────────────────────────────────────────────────────────────────

test('lerVeredito: aprova sem violações', () => {
  assert.deepEqual(lerVeredito('{"veredito":"aprova","violacoes":[]}'), { veredito: 'aprova', violacoes: [] });
});

test('lerVeredito: barraria com violação válida', () => {
  const r = lerVeredito('{"veredito":"barraria","violacoes":[{"regra":"sem_custo","motivo":"disse que é grátis","trecho":"sem custo"}]}');
  assert.ok(r);
  assert.equal(r.veredito, 'barraria');
  assert.deepEqual(r.violacoes, [{ regra: 'sem_custo', motivo: 'disse que é grátis', trecho: 'sem custo', origem: 'modelo' }]);
});

test('lerVeredito: JSON quebrado, vazio, texto solto e array são SEM veredito, nunca barraria', () => {
  for (const ruim of ['', 'barraria', '{"veredito":"barraria"', '[]', 'null', '"barraria"', '{"veredito":"barraria","violacoes":[{"regra":"sem_custo"']) {
    assert.equal(lerVeredito(ruim), null, ruim);
  }
});

test('lerVeredito: veredito desconhecido ou ausente é null', () => {
  assert.equal(lerVeredito('{"veredito":"talvez","violacoes":[]}'), null);
  assert.equal(lerVeredito('{"violacoes":[]}'), null);
  assert.equal(lerVeredito('{"veredito":"BARRARIA","violacoes":[]}'), null);
});

test('lerVeredito: barraria sem violação válida é null (não se infere barraria)', () => {
  assert.equal(lerVeredito('{"veredito":"barraria","violacoes":[]}'), null);
  assert.equal(lerVeredito('{"veredito":"barraria"}'), null);
  assert.equal(lerVeredito('{"veredito":"barraria","violacoes":[{"regra":"inventada","motivo":"x","trecho":""}]}'), null);
  assert.equal(lerVeredito('{"veredito":"barraria","violacoes":[{"regra":"sem_custo","motivo":"  ","trecho":""}]}'), null);
});

test('lerVeredito: aprova COM violações é inconsistente → null', () => {
  assert.equal(lerVeredito('{"veredito":"aprova","violacoes":[{"regra":"sem_custo","motivo":"x","trecho":"y"}]}'), null);
});

test('lerVeredito: a regra 8 vinda do modelo é descartada (é de código); as outras ficam; regra repetida vale uma vez', () => {
  const r = lerVeredito(
    JSON.stringify({
      veredito: 'barraria',
      violacoes: [
        { regra: 'cumprimento_fora_de_hora', motivo: 'bom dia à tarde', trecho: 'bom dia' },
        { regra: 'promessa_sem_acao', motivo: 'vou ver a agenda', trecho: 'vou ver' },
        { regra: 'promessa_sem_acao', motivo: 'de novo', trecho: 'x' },
      ],
    }),
  );
  assert.ok(r);
  assert.deepEqual(r.violacoes.map((v) => v.regra), ['promessa_sem_acao']);
  assert.equal(r.violacoes[0]!.motivo, 'vou ver a agenda');
});

test('lerVeredito: motivo e trecho gigantes são cortados', () => {
  const r = lerVeredito(JSON.stringify({ veredito: 'barraria', violacoes: [{ regra: 'sem_custo', motivo: 'm'.repeat(5000), trecho: 't'.repeat(5000) }] }));
  assert.ok(r);
  assert.equal(r.violacoes[0]!.motivo.length, 400);
  assert.equal(r.violacoes[0]!.trecho.length, 300);
});

// ── regra 8, em código ────────────────────────────────────────────────────────────────────────────

const as = (hora: number, min = 0) => ({ hora, min });

test('cumprimento: "bom dia" às 14h é erro (o caso de Salto)', () => {
  const v = cumprimentoForaDeHora('Bom dia! Tudo bem? Como posso te ajudar?', as(14));
  assert.ok(v);
  assert.equal(v.regra, 'cumprimento_fora_de_hora');
  assert.equal(v.origem, 'codigo');
  assert.match(v.motivo, /14:00/);
});

test('cumprimento: cada saudação na sua janela passa', () => {
  assert.equal(cumprimentoForaDeHora('Bom dia!', as(7)), null);
  assert.equal(cumprimentoForaDeHora('Boa tarde!', as(15)), null);
  assert.equal(cumprimentoForaDeHora('Boa noite!', as(21)), null);
  assert.equal(cumprimentoForaDeHora('Boa noite!', as(2)), null);
});

test('cumprimento: janelas se sobrepõem na virada (11h40 boa tarde, 12h10 bom dia, 17h40 boa noite não são erro)', () => {
  assert.equal(cumprimentoForaDeHora('Boa tarde!', as(11, 40)), null);
  assert.equal(cumprimentoForaDeHora('Bom dia!', as(12, 10)), null);
  assert.equal(cumprimentoForaDeHora('Boa noite!', as(17, 40)), null);
});

test('cumprimento: fora das janelas é erro nas três saudações', () => {
  assert.ok(cumprimentoForaDeHora('Bom dia', as(12, 30)));
  assert.ok(cumprimentoForaDeHora('Bom dia', as(23)));
  assert.ok(cumprimentoForaDeHora('Boa tarde', as(9)));
  assert.ok(cumprimentoForaDeHora('Boa tarde', as(19)));
  assert.ok(cumprimentoForaDeHora('Boa noite', as(10)));
  assert.ok(cumprimentoForaDeHora('Boa noite', as(16)));
});

test('cumprimento: acento, caixa e "Oi, " na frente não escondem', () => {
  assert.ok(cumprimentoForaDeHora('OI, BOM DIA!', as(16)));
  assert.ok(cumprimentoForaDeHora('Olá! Boa noite 😊', as(10)));
});

test('cumprimento: despedida no meio/fim da mensagem NÃO é saudação ("tenha uma boa noite" às 16h)', () => {
  assert.equal(cumprimentoForaDeHora('Combinado, te espero lá. Tenha uma boa noite!', as(16)), null);
  assert.equal(cumprimentoForaDeHora('Qualquer coisa me chama. Um bom dia pra você', as(15)), null);
});

test('cumprimento: nome antes do cumprimento NÃO esconde ("Oi, Maria! Bom dia", "Olá, tudo bem? Boa tarde")', () => {
  assert.ok(cumprimentoForaDeHora('Oi, Maria! Bom dia! Como posso te ajudar?', as(15)));
  assert.ok(cumprimentoForaDeHora('Oi Maria, bom dia', as(15)));
  assert.ok(cumprimentoForaDeHora('Olá, tudo bem? Boa tarde', as(9)));
  assert.equal(cumprimentoForaDeHora('Oi, Maria! Bom dia!', as(8)), null);
});

test('cumprimento: no fim de uma frase longa (mais de 40 caracteres antes) não é saudação; "desejo/tenha/um" antes é despedida', () => {
  assert.equal(cumprimentoForaDeHora('Combinado, a equipe confirma o horário com você ainda hoje. Boa noite', as(15)), null);
  assert.equal(cumprimentoForaDeHora('Te desejo boa tarde', as(9)), null);
  assert.equal(cumprimentoForaDeHora('Fico por aqui, um bom dia', as(15)), null);
});

test('cumprimento: no começo de uma linha do meio vale; frase sem saudação é null', () => {
  assert.ok(cumprimentoForaDeHora('Entendi sua dor.\nBom dia, aliás!', as(15)));
  assert.equal(cumprimentoForaDeHora('A consulta é na terça às 10h.', as(15)), null);
  assert.equal(cumprimentoForaDeHora('', as(15)), null);
});

test('horaLocalDaUnidade: Boa Vista (UTC-4) e São Paulo no mesmo instante', () => {
  const t = new Date('2026-11-18T17:30:00Z'); // quarta
  const sp = horaLocalDaUnidade(t, 'America/Sao_Paulo');
  assert.deepEqual([sp.hora, sp.min, sp.diaDaSemana], [14, 30, 'quarta-feira']);
  const bv = horaLocalDaUnidade(t, 'America/Boa_Vista');
  assert.deepEqual([bv.hora, bv.min], [13, 30]);
  assert.equal(horaLocalDaUnidade(t, 'fuso/invalido').hora, 14);
  assert.equal(horaLocalDaUnidade(t, null).hora, 14);
});

// ── consolidar e estado ───────────────────────────────────────────────────────────────────────────

const viol = (regra: any, origem: 'modelo' | 'codigo' = 'modelo') => ({ regra, motivo: 'm', trecho: 't', origem });

test('consolidar: modelo aprova e código nada = aprova', () => {
  assert.deepEqual(consolidar({ veredito: 'aprova', violacoes: [] }, []), { veredito: 'aprova', violacoes: [] });
});

test('consolidar: modelo sem veredito e código nada = sem_veredito (nunca aprova por omissão, nunca barraria)', () => {
  assert.deepEqual(consolidar(null, []), { veredito: 'sem_veredito', violacoes: [] });
});

test('consolidar: o código acha o bom dia mesmo com o modelo fora do ar', () => {
  const r = consolidar(null, [viol('cumprimento_fora_de_hora', 'codigo')]);
  assert.equal(r.veredito, 'barraria');
  assert.deepEqual(r.violacoes.map((v) => v.regra), ['cumprimento_fora_de_hora']);
});

test('consolidar: junta modelo + código, sem repetir a mesma regra', () => {
  const r = consolidar({ veredito: 'barraria', violacoes: [viol('sem_custo')] }, [viol('cumprimento_fora_de_hora', 'codigo')]);
  assert.deepEqual(r.violacoes.map((v) => v.regra), ['sem_custo', 'cumprimento_fora_de_hora']);
});

test('estado: desligado não revisa; seco revisa; ligado AINDA só registra (e avisa)', () => {
  assert.equal(decidirPeloEstado('desligado').revisar, false);
  const seco = decidirPeloEstado('seco');
  assert.deepEqual([seco.revisar, seco.acao, seco.modo, seco.aviso], [true, 'so_registrar', 'seco', undefined]);
  const ligado = decidirPeloEstado('ligado');
  assert.deepEqual([ligado.revisar, ligado.acao, ligado.modo], [true, 'so_registrar', 'seco']);
  assert.match(ligado.aviso ?? '', /ainda não existe/);
});

// ── quem revisa ───────────────────────────────────────────────────────────────────────────────────

test('escolherRevisora: chave Anthropic da unidade → Haiku 5.5; sem chave → gpt-4o-mini', () => {
  const a = escolherRevisora({}, { anthropicApiKey: ' sk-ant-x ', llmProvider: 'anthropic' });
  assert.deepEqual([a.provedor, a.modelo, a.apiKeyAnthropic], ['anthropic', 'claude-haiku-5-5', 'sk-ant-x']);
  const o = escolherRevisora({}, { anthropicApiKey: null });
  assert.deepEqual([o.provedor, o.modelo, o.apiKeyAnthropic], ['openai', 'gpt-4o-mini', null]);
});

test('escolherRevisora: unidade que opera em OpenAI NÃO usa a chave Anthropic que por acaso tem (Imperatriz resgate); provedor vazio = openai', () => {
  const o = escolherRevisora({}, { anthropicApiKey: 'sk-ant-velha', llmProvider: 'openai' });
  assert.deepEqual([o.provedor, o.apiKeyAnthropic], ['openai', null]);
  assert.equal(escolherRevisora({}, { anthropicApiKey: 'k' }).provedor, 'openai');
  assert.equal(escolherRevisora({}, { anthropicApiKey: 'k', llmProvider: 'google' }).provedor, 'openai');
  assert.equal(escolherRevisora({ REVISORA_ANTHROPIC_API_KEY: 'k' }, { anthropicApiKey: null, llmProvider: 'openai' }).provedor, 'anthropic', 'opt-in explícito vale');
});

test('categoriaRevisavel: saúde e categoria vazia (Caxias, Tatuí) sim; advocacia e outras não', () => {
  assert.equal(categoriaRevisavel('saude'), true);
  assert.equal(categoriaRevisavel(' saude '), true);
  assert.equal(categoriaRevisavel(null), true);
  assert.equal(categoriaRevisavel(''), true);
  assert.equal(categoriaRevisavel('advocacia'), false);
  assert.equal(categoriaRevisavel('energia_solar'), false);
});

test('escolherRevisora: ANTHROPIC_API_KEY solta e JUDGE_PROVIDER NÃO a ligam (só a chave da unidade ou REVISORA_ANTHROPIC_API_KEY)', () => {
  assert.equal(escolherRevisora({ ANTHROPIC_API_KEY: 'k', JUDGE_PROVIDER: 'anthropic' }, null).provedor, 'openai');
  assert.equal(escolherRevisora({ REVISORA_ANTHROPIC_API_KEY: 'k' }, null).provedor, 'anthropic');
});

test('escolherRevisora: REVISORA_MODEL só vale no provedor certo', () => {
  assert.equal(escolherRevisora({ REVISORA_MODEL: 'gpt-4.1-mini' }, null).modelo, 'gpt-4.1-mini');
  assert.equal(escolherRevisora({ REVISORA_MODEL: 'gpt-4.1-mini' }, { anthropicApiKey: 'k', llmProvider: 'anthropic' }).modelo, 'claude-haiku-5-5');
  assert.equal(escolherRevisora({ REVISORA_MODEL: 'claude-sonnet-5-5' }, null).modelo, 'gpt-4o-mini');
  assert.equal(escolherRevisora({ REVISORA_MODEL: 'claude-sonnet-5-5' }, { anthropicApiKey: 'k', llmProvider: 'anthropic' }).modelo, 'claude-sonnet-5-5');
});

test('montarPedidoAnthropic: com schema/maxTokens da revisora; sem eles, o do juiz como sempre', () => {
  const p = montarPedidoAnthropic({ modelo: 'claude-haiku-5-5', system: 's', user: 'u', esforco: 'low', schema: SCHEMA_DA_REVISORA, maxTokens: 700 });
  assert.equal(p.max_tokens, 700);
  assert.equal(p.output_config.format.schema, SCHEMA_DA_REVISORA);
  assert.deepEqual(p.thinking, { type: 'disabled' });
  const j = montarPedidoAnthropic({ modelo: 'claude-haiku-5-5', system: 's', user: 'u', esforco: null });
  assert.equal(j.max_tokens, MAX_TOKENS_DO_JUIZ);
  assert.equal(j.output_config.format.schema, SCHEMA_DO_JUIZ);
});

// ── a entrada ─────────────────────────────────────────────────────────────────────────────────────

const base = (over: Partial<EntradaDaRevisora> = {}): EntradaDaRevisora => ({
  nomeDaUnidade: 'Doutor Hérnia Caxias',
  textoEnviado: 'Oi! Me conta onde está doendo?',
  hora: { hora: 14, min: 5, diaDaSemana: 'quarta-feira' },
  ferramentas: [],
  falas: [],
  inicioVisivel: true,
  precos: { noDia: 350, antecipado: 250, sinal: 50, restoNoDia: 200 },
  trechoDaFicha: null,
  endereco: 'Rua A, 10',
  chavePix: null,
  status: null,
  ...over,
});

test('descreverPrecos: com sinal diz total vs sinal; sem sinal; sem tabela', () => {
  const com = descreverPrecos({ noDia: 350, antecipado: 250, sinal: 50, restoNoDia: 200 });
  assert.match(com, /R\$ 350 no dia/);
  assert.match(com, /SINAL de R\$ 50/);
  assert.match(com, /TOTAL com sinal é R\$ 250/);
  assert.match(descreverPrecos({ noDia: 350, antecipado: 250, sinal: null, restoNoDia: null }), /pagando antecipado.*Não há sinal/);
  assert.match(descreverPrecos(null), /Não há tabela estruturada/);
});

test('descreverStatus: cada situação, e a ausência de dado manda a regra 4 não se aplicar', () => {
  assert.match(descreverStatus(null), /NÃO se aplica/);
  assert.match(descreverStatus({ emTratamento: false, jaAtendido: false, consultaMarcada: null }), /NÃO se aplica/);
  const s = descreverStatus({ emTratamento: true, jaAtendido: true, consultaMarcada: 'quinta às 10h' });
  assert.match(s, /JÁ TEM TRATAMENTO/);
  assert.match(s, /JÁ FOI ATENDIDO/);
  assert.match(s, /quinta às 10h/);
});

test('descreverFalas: autor, "há N min" e a nota sobre o início da conversa', () => {
  const t = descreverFalas(
    [
      { autor: 'paciente', texto: 'Oi', haMin: 4 },
      { autor: 'equipe', texto: 'Já te respondo', haMin: 0 },
    ],
    false,
  );
  assert.match(t, /\[PACIENTE, há 4 min\]: Oi/);
  assert.match(t, /\[EQUIPE \(pessoa da clínica\), agora há pouco\]/);
  assert.match(t, /na dúvida, aprove/);
  assert.match(descreverFalas([{ autor: 'sofia', texto: 'x', haMin: null }], true), /\[Sofia\]: x[\s\S]*ESTÁ nas falas/);
  assert.match(descreverFalas([], true), /primeira resposta/);
});

test('dadosDaRevisao: leva unidade, hora local, tabela, status, ferramentas, falas e o texto enviado', () => {
  const u = dadosDaRevisao(
    base({
      ferramentas: [{ nome: 'consultar_horarios', resultado: 'terça 10h livre' }, { nome: 'pausar_ia' }],
      falas: [{ autor: 'paciente', texto: 'tem horário amanhã?', haMin: 1 }],
      trechoDaFicha: 'Consulta R$ 350',
      status: { emTratamento: true, jaAtendido: false, consultaMarcada: null },
    }),
  );
  assert.match(u, /UNIDADE: Doutor Hérnia Caxias/);
  assert.match(u, /quarta-feira, 14:05/);
  assert.match(u, /SINAL de R\$ 50/);
  assert.match(u, /- consultar_horarios → terça 10h livre\n- pausar_ia/);
  assert.match(u, /\[PACIENTE, há 1 min\]: tem horário amanhã\?/);
  assert.match(u, /TRECHO DA FICHA[\s\S]*Consulta R\$ 350/);
  assert.match(u, /Endereço: Rua A, 10/);
  assert.match(u, /JÁ TEM TRATAMENTO/);
  assert.match(u, /"""\nOi! Me conta onde está doendo\?\n"""/);
});

test('dadosDaRevisao: texto enviado gigante é cortado', () => {
  const u = dadosDaRevisao(base({ textoEnviado: 'a'.repeat(10_000) }));
  assert.ok(u.length < 6_000);
});

// ── falas do banco ────────────────────────────────────────────────────────────────────────────────

const agora = new Date('2026-11-18T15:00:00Z');
const msg = (role: string, content: string, minAtras: number, meta?: unknown): MensagemDoBanco => ({
  role,
  content,
  meta,
  createdAt: new Date(agora.getTime() - minAtras * 60_000),
});

test('falasParaARevisora: tira a resposta que acabou de ser gravada, ordena do mais antigo e acha o autor pelo meta', () => {
  const r = falasParaARevisora(
    [
      msg('assistant', 'Resposta nova', 0),
      msg('assistant', 'A gente atende até as 18h', 3, { autor: 'equipe', origem: 'kommo_talks' }),
      msg('user', 'qual o horário?', 4),
      msg('assistant', 'Oi, sou a Sofia', 6, { via: 'salesbot' }),
      msg('assistant', 'Sua consulta é amanhã', 10, { origem: 'confirmacao_d1' }),
    ],
    'Resposta nova',
    agora,
    { linhasPedidas: 30 },
  );
  assert.deepEqual(
    r.falas.map((f) => [f.autor, f.texto, f.haMin]),
    [
      ['automacao', 'Sua consulta é amanhã', 10],
      ['sofia', 'Oi, sou a Sofia', 6],
      ['paciente', 'qual o horário?', 4],
      ['equipe', 'A gente atende até as 18h', 3],
    ],
  );
  assert.equal(r.inicioVisivel, true);
});

test('falasParaARevisora: a resposta recém-gravada sai mesmo com Pix/cartão (ou fala do paciente) gravados DEPOIS dela', () => {
  const r = falasParaARevisora(
    [
      msg('assistant', '00020126...copia-e-cola', 0, { via: 'pix_do_sinal' }),
      msg('user', 'ok, vou pagar', 0),
      msg('assistant', 'Resposta nova', 1),
      msg('user', 'quero marcar', 2),
    ],
    'Resposta nova',
    agora,
    { linhasPedidas: 30 },
  );
  assert.deepEqual(r.falas.map((f) => f.texto), ['quero marcar', 'ok, vou pagar', '00020126...copia-e-cola']);
});

test('falasParaARevisora: só UMA ocorrência sai; texto igual mais antigo é fala de outro turno', () => {
  const r = falasParaARevisora([msg('assistant', 'Tudo bem?', 0), msg('user', 'oi', 1), msg('assistant', 'Tudo bem?', 5)], 'Tudo bem?', agora, { linhasPedidas: 30 });
  assert.deepEqual(r.falas.map((f) => f.texto), ['Tudo bem?', 'oi']);
});

test('falasParaARevisora: limita a 6 e avisa que o começo não está visível', () => {
  const muitas = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'user' : 'assistant', `f${i}`, i + 1));
  const r = falasParaARevisora(muitas, 'outra coisa', agora, { linhasPedidas: 30 });
  assert.equal(r.falas.length, 6);
  assert.equal(r.falas[5]!.texto, 'f0'); // a mais nova por último
  assert.equal(r.inicioVisivel, false);
});

test('inicioVisivel decide pelo que o BANCO devolveu, não pelo recorte filtrado: mídia vazia no meio não esconde nem finge o começo', () => {
  // conversa curta (5 linhas < 30 pedidas) cheia de mídia sem texto: o banco acabou → o começo ESTÁ visível
  const comMidia = [msg('user', '', 1), msg('user', '', 2), msg('assistant', 'Resposta nova', 0), msg('user', '  ', 3), msg('user', 'oi', 4), msg('user', '', 5)];
  assert.equal(falasParaARevisora(comMidia, 'Resposta nova', agora, { linhasPedidas: 30 }).inicioVisivel, true);

  // o banco devolveu o pedido CHEIO (30 de 30) e quase tudo é mídia vazia: sobram 3 falas (< 6), mas há mais antigas → NÃO visível
  const cheio = Array.from({ length: 30 }, (_, i) => (i % 10 === 0 ? msg('user', `fala${i}`, i + 1) : msg('user', '', i + 1)));
  const r = falasParaARevisora(cheio, 'x', agora, { linhasPedidas: 30 });
  assert.equal(r.falas.length, 3);
  assert.equal(r.inicioVisivel, false);

  // banco acabou (31 < 40) mas há mais de 6 falas com texto: o corte de 6 deixou as antigas de fora → NÃO visível
  const longa = Array.from({ length: 12 }, (_, i) => msg('user', `f${i}`, i + 1));
  assert.equal(falasParaARevisora(longa, 'x', agora, { linhasPedidas: 40 }).inicioVisivel, false);

  // exatamente 6 falas e o banco acabou: visível
  assert.equal(falasParaARevisora(longa.slice(0, 6), 'x', agora, { linhasPedidas: 40 }).inicioVisivel, true);
});

test('falasParaARevisora: ignora system e mensagem vazia', () => {
  const r = falasParaARevisora([msg('system', 'segredo', 1), msg('user', '   ', 2), msg('user', 'oi', 3)], 'x', agora, { linhasPedidas: 30 });
  assert.deepEqual(r.falas.map((f) => f.texto), ['oi']);
});

// ── ferramentas do turno ──────────────────────────────────────────────────────────────────────────

const tipo = (t: string, extra: object) => ({ getType: () => t, ...extra });

test('ferramentasDoTurnoComResultado: só depois da última fala do paciente, com o resultado por id', () => {
  const mensagens = [
    tipo('human', { content: 'oi' }),
    tipo('ai', { content: '', tool_calls: [{ name: 'ferramenta_velha', id: 'v1' }] }),
    tipo('tool', { content: 'velho', tool_call_id: 'v1' }),
    tipo('ai', { content: 'oi!' }),
    tipo('human', { content: 'tem horário?' }),
    tipo('ai', { content: '', tool_calls: [{ name: 'consultar_horarios', id: 'a1' }, { name: 'pausar_ia', id: 'a2' }] }),
    tipo('tool', { content: 'terça 10h livre', tool_call_id: 'a1' }),
    tipo('ai', { content: 'Terça 10h?' }),
  ];
  assert.deepEqual(ferramentasDoTurnoComResultado(mensagens), [{ nome: 'consultar_horarios', resultado: 'terça 10h livre' }, { nome: 'pausar_ia' }]);
});

test('ferramentasDoTurnoComResultado: lista vazia, lixo e resultado enorme', () => {
  assert.deepEqual(ferramentasDoTurnoComResultado([]), []);
  assert.deepEqual(ferramentasDoTurnoComResultado([null, undefined, {}]), []);
  const r = ferramentasDoTurnoComResultado([tipo('ai', { tool_calls: [{ name: 'x', id: '1' }] }), tipo('tool', { content: 'z'.repeat(5000), tool_call_id: '1' })]);
  assert.ok((r[0]!.resultado ?? '').length <= 321);
});
