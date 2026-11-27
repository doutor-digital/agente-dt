/**
 * Confirmação na manhã da consulta: QUEM recebe, QUANDO e o que a mensagem diz. Funções puras (confirmacao-manha.ts).
 * O que cada teste protege está no título; os de «Caxias e Petrópolis» e «nunca confirma o que o paciente não deu» são as duas regras do João.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const m = await import('./confirmacao-manha.js');
const { AUTOMACOES, verificarCatalogo } = await import('./automacoes.js');
const { prefixoDoToque, chaveDaConfirmacao } = await import('./confirmacao-d1.js');

const HOJE = '2026-11-30';
const base = (over: Partial<import('./confirmacao-manha.js').FatosDaManha> = {}): import('./confirmacao-manha.js').FatosDaManha => ({
  estado: 'ligado',
  vespera: 'servidor',
  clinicaAtendendo: true,
  consulta: { estado: 'confirmada', quando: `${HOJE}T14:30` },
  agoraLocal: `${HOJE}T10:00`,
  perguntouHoje: false,
  etapaSemVespera: false,
  desistiu: false,
  confirmadaNaFranquia: null,
  confirmouNoWhatsapp: false,
  pediuParaRemarcar: false,
  ...over,
});

test('a janela: hoje, de 5 h a 1 h 30 antes — nem antes, nem em cima da hora, nem outro dia', () => {
  const q = `${HOJE}T14:30`;
  assert.equal(m.dentroDaJanelaDaManha(q, `${HOJE}T09:30`), true, '5 h antes');
  assert.equal(m.dentroDaJanelaDaManha(q, `${HOJE}T09:29`), false, 'mais de 5 h antes: ainda cedo');
  assert.equal(m.dentroDaJanelaDaManha(q, `${HOJE}T13:00`), true, '1 h 30 antes');
  assert.equal(m.dentroDaJanelaDaManha(q, `${HOJE}T13:01`), false, 'em cima da hora: sem margem para remarcar');
  assert.equal(m.dentroDaJanelaDaManha(q, `${HOJE}T15:00`), false, 'a consulta já passou');
  assert.equal(m.dentroDaJanelaDaManha(`2026-12-01T14:30`, `${HOJE}T10:00`), false, 'consulta de amanhã é da véspera');
  assert.equal(m.dentroDaJanelaDaManha('lixo', `${HOJE}T10:00`), false);
});

test('prefiltro barato pelo horário gravado: poupa a franquia de quem está longe da janela, sem descartar o que pode estar velho', () => {
  assert.equal(m.talvezDentroDaJanela(`${HOJE}T14:30`, `${HOJE}T10:00`), true);
  assert.equal(m.talvezDentroDaJanela(`${HOJE}T10:20`, `${HOJE}T10:00`), false, 'em cima da hora');
  assert.equal(m.talvezDentroDaJanela(`${HOJE}T08:00`, `${HOJE}T10:00`), false, 'já passou');
  assert.equal(m.talvezDentroDaJanela(`${HOJE}T18:00`, `${HOJE}T09:00`), false, 'muito cedo (9 h antes)');
  assert.equal(m.talvezDentroDaJanela(null, `${HOJE}T10:00`), true, 'sem horário gravado: deixa a franquia decidir');
});

test('caso feliz: pergunta quem tem consulta hoje, confirmada na franquia, e ainda não respondeu nada', () => {
  assert.deepEqual(m.decidirManha(base()), { acao: 'mandar' });
});

test('chave desligada nunca manda; «só no papel» chega até «mandar» (quem não manda é o worker, que só anota)', () => {
  assert.deepEqual(m.decidirManha(base({ estado: 'desligado' })), { acao: 'pular', motivo: 'desligada' });
  assert.deepEqual(m.decidirManha(base({ estado: 'seco' })), { acao: 'mandar' });
});

test('véspera pelo robô do Kommo: o lembrete do dia já é dele, o servidor não pergunta de novo', () => {
  assert.deepEqual(m.decidirManha(base({ vespera: 'robo-kommo' })), { acao: 'pular', motivo: 'robo_do_kommo' });
});

test('NUNCA pergunta sobre data não verificada: consulta que a franquia não devolveu agora (nao_confirmada) ou sem horário', () => {
  assert.equal(m.decidirManha(base({ consulta: { estado: 'nao_confirmada', quando: `${HOJE}T14:30` } })).acao, 'pular');
  assert.equal(m.decidirManha(base({ consulta: { estado: 'confirmada', quando: null } })).acao, 'pular');
  assert.equal(m.decidirManha(base({ consulta: null })).acao, 'pular');
});

test('respeita o silêncio da clínica: fechada = não manda', () => {
  assert.deepEqual(m.decidirManha(base({ clinicaAtendendo: false })), { acao: 'pular', motivo: 'clinica_fechada' });
});

test('uma pergunta por consulta: se a da manhã já saiu, não repete', () => {
  assert.deepEqual(m.decidirManha(base({ perguntouHoje: true })), { acao: 'pular', motivo: 'ja_perguntou' });
});

test('quem já confirmou NÃO recebe: franquia CONFIRMADO, «Agendamento confirmado» recente ou «confirmo» à véspera', () => {
  assert.equal(m.decidirManha(base({ confirmadaNaFranquia: 'consulta já CONFIRMADA na franquia' })).acao, 'pular');
  assert.deepEqual(m.decidirManha(base({ confirmouNoWhatsapp: true })), { acao: 'pular', motivo: 'confirmou_no_whatsapp' });
});

test('quem pediu para remarcar, escreveu que não vem ou está em etapa de cancelado/perdido não recebe «você consegue vir?»', () => {
  assert.deepEqual(m.decidirManha(base({ pediuParaRemarcar: true })), { acao: 'pular', motivo: 'pediu_para_remarcar' });
  assert.deepEqual(m.decidirManha(base({ desistiu: true })), { acao: 'pular', motivo: 'desistiu' });
  assert.deepEqual(m.decidirManha(base({ etapaSemVespera: true })), { acao: 'pular', motivo: 'etapa' });
});

test('CAXIAS e PETRÓPOLIS ficam fora mesmo com a lista «*» no ambiente — as duas chaves', () => {
  const env = { CONFIRMACAO_MANHA_SLUGS: '*', REMARCAR_OFERTA_SLUGS: '*' } as NodeJS.ProcessEnv;
  for (const slug of ['doutor-hernia-caxias', 'doutor-hernia-petropolis']) {
    assert.equal(m.estadoDaManha(slug, env), 'desligado', slug);
    assert.equal(m.estadoDoPlano(slug, 'remarcar-oferta', env.REMARCAR_OFERTA_SLUGS), 'desligado', slug);
  }
  assert.equal(m.estadoDaManha('doutor-hernia-olimpia', env), 'ligado');
});

test('nasce DESLIGADA: sem variável e sem linha na tela, nenhuma unidade recebe', () => {
  assert.equal(m.estadoDaManha('doutor-hernia-olimpia', {} as NodeJS.ProcessEnv), 'desligado');
});

test('o texto: hoje, horário da franquia, sem «amanhã», sem emoji de 4 bytes, e só promete outro horário se a oferta está ligada', () => {
  const args = { nome: 'Maria', quando: `${HOJE}T14:30`, especialista: 'Carla', endereco: 'Rua A, 10', horaDoEnvio: 10 };
  const sem = m.textoConfirmacaoManha({ ...args, oferece: false, comBotoes: false });
  assert.match(sem, /^Bom dia, Maria!/);
  assert.match(sem, /\*hoje, às 14:30\* com Carla/);
  assert.match(sem, /Rua A, 10/);
  assert.match(sem, /Responda \*1\* para confirmar ou \*2\* se não conseguir\./);
  assert.doesNotMatch(sem, /amanh/i);
  assert.doesNotMatch(sem, /outro horário/);
  assert.doesNotMatch(sem, /[\u{10000}-\u{10FFFF}]/u);
  const com = m.textoConfirmacaoManha({ ...args, oferece: true, comBotoes: false });
  assert.match(com, /que eu te ofereço outro horário/);
  const botoes = m.textoConfirmacaoManha({ ...args, oferece: true, comBotoes: true });
  assert.match(botoes, /Toque em um dos botões/);
  assert.doesNotMatch(botoes, /Responda \*1\*/);
  assert.match(m.textoConfirmacaoManha({ ...args, nome: null, horaDoEnvio: 13, oferece: false, comBotoes: false }), /^Boa tarde! Passando/);
});

test('a marca da manhã é própria: não se confunde com a da véspera nem a do reforço, e carrega o horário', () => {
  assert.equal(prefixoDoToque('d0'), 'confirmacao_d0');
  assert.equal(chaveDaConfirmacao('d0', `${HOJE}T14:30:59`), `confirmacao_d0:${HOJE}T14:30`);
  assert.notEqual(chaveDaConfirmacao('d0', `${HOJE}T14:30`), chaveDaConfirmacao('d1', `${HOJE}T14:30`));
});

test('as duas chaves estão no catálogo: nascem desligadas, têm modo seco e exigem o seco antes', () => {
  for (const id of ['confirmacao-manha', 'remarcar-oferta']) {
    const a = AUTOMACOES.find((x) => x.id === id);
    assert.ok(a, id);
    assert.equal(a!.quandoVazio, 'desligado');
    assert.equal(a!.temSeco, true);
    assert.equal(a!.exigeSecoAntes, true);
    assert.equal(a!.risco, 'manda-mensagem');
  }
  assert.deepEqual(verificarCatalogo(), []);
});

test('o seco usa a MESMA conta do envio: janela aberta = texto; fechada com modelo = modelo; fechada sem modelo = não manda nada', () => {
  assert.equal(m.canalDaManha(true, null), 'texto');
  assert.equal(m.canalDaManha(true, 123), 'texto');
  assert.equal(m.canalDaManha(false, 123), 'modelo');
  assert.equal(m.canalDaManha(false, null), 'sem_modelo');
});

test('faltasLigadas: só LIGADO conta (seco não muda nada para o paciente), e Caxias/Petrópolis nunca', () => {
  const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
  assert.equal(m.faltasLigadas('doutor-hernia-olimpia', env({})), false);
  assert.equal(m.faltasLigadas('doutor-hernia-olimpia', env({ CONFIRMACAO_MANHA_SLUGS: 'doutor-hernia-olimpia' })), true);
  assert.equal(m.faltasLigadas('doutor-hernia-olimpia', env({ REMARCAR_OFERTA_SLUGS: '*' })), true);
  assert.equal(m.faltasLigadas('doutor-hernia-caxias', env({ CONFIRMACAO_MANHA_SLUGS: '*', REMARCAR_OFERTA_SLUGS: '*' })), false);
});

test('o painel mostra Caxias e Petrópolis como «fora» (desligado, sem como ligar), mesmo com «*»', async () => {
  const { panoramaDaUnidade } = await import('./automacoes-estado.js');
  const env = { CONFIRMACAO_MANHA_SLUGS: '*', REMARCAR_OFERTA_SLUGS: '*' } as NodeJS.ProcessEnv;
  for (const slug of ['doutor-hernia-caxias', 'doutor-hernia-petropolis']) {
    for (const id of ['confirmacao-manha', 'remarcar-oferta']) {
      const l = panoramaDaUnidade(slug, env).find((x) => x.id === id)!;
      assert.equal(l.estado, 'desligado', `${slug} ${id}`);
      assert.equal(l.fora, true);
    }
  }
  const o = panoramaDaUnidade('doutor-hernia-olimpia', env).find((x) => x.id === 'confirmacao-manha')!;
  assert.equal(o.estado, 'ligado');
  assert.equal(o.fora, false);
  assert.equal(panoramaDaUnidade('doutor-hernia-caxias', env).find((x) => x.id === 'parados')!.fora, false, 'outras automações não mudam');
});

test('tentativa que não chegou ao paciente (nota interna, modelo falhou, sem modelo) não se repete a cada varredura de 15 min', () => {
  assert.deepEqual(m.decidirManha(base({ tentouHaPouco: true })), { acao: 'pular', motivo: 'tentou_ha_pouco' });
  assert.deepEqual(m.decidirManha(base({ tentouHaPouco: false })), { acao: 'mandar' });
});

test('a saudação acompanha a hora: bom dia, boa tarde, boa noite', () => {
  const t = (h: number) => m.textoConfirmacaoManha({ nome: null, quando: `${HOJE}T19:30`, horaDoEnvio: h, oferece: false, comBotoes: false });
  assert.match(t(9), /^Bom dia!/);
  assert.match(t(14), /^Boa tarde!/);
  assert.match(t(18), /^Boa noite!/);
});
