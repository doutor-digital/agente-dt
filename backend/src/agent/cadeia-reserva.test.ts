import { readFileSync } from 'node:fs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  montarCadeia,
  percorrerCadeia,
  reservasGlobais,
  cadeiaCompletaLigada,
  rotuloDoProvedor,
  resumoDasTentativas,
  CadeiaEsgotadaError,
  chaveDeSaldo,
  origemDoPrincipal,
  tratarFalhaDoPrincipal,
  CHAVE_SALDO_RESERVA_ANTHROPIC,
  type PassoDaCadeia,
  type ReservasGlobais,
} from './cadeia-reserva.js';
import { abrirCircuito, circuitoAberto, resetarCircuitos, estadoDoCircuito, ehFalhaDeInfra, registrarFalha, CircuitoDeSaldoAbertoError } from './circuito.js';
import { escolherPlanoB, type UnitCreds } from './llm-policy.js';
import { alvoDoReescritor } from './pos-processamento-plano-b.js';

const SEM_RESERVA: ReservasGlobais = { anthropic: null, google: null };
const COM_GOOGLE: ReservasGlobais = { anthropic: null, google: 'g-reserva' };
const COM_AS_DUAS: ReservasGlobais = { anthropic: 'a-reserva', google: 'g-reserva' };

const base: UnitCreds = {
  llmProvider: 'anthropic',
  anthropicApiKey: 'a-unidade',
  anthropicModel: 'claude-opus-4-8',
  openaiApiKey: null,
  openaiModel: 'gpt-4o-mini',
  googleApiKey: null,
  googleModel: 'gemini-2.5-flash',
};

const ordem = (passos: PassoDaCadeia[]) => passos.map((p) => `${p.provider}:${p.origemChave}`);

beforeEach(() => resetarCircuitos());

// ---- montarCadeia -----------------------------------------------------------------------------

test('sem env nova a cadeia é EXATAMENTE o plano B de hoje, em todos os cenários', () => {
  const cenarios: Array<[UnitCreds, boolean]> = [
    [base, true],
    [base, false],
    [{ ...base, googleApiKey: 'g' }, true],
    [{ ...base, googleApiKey: 'g' }, false],
    [{ ...base, llmProvider: 'google', googleApiKey: 'g' }, true],
    [{ ...base, llmProvider: 'google', googleApiKey: 'g', anthropicApiKey: null }, true],
    [{ ...base, llmProvider: 'openai', anthropicApiKey: null, googleApiKey: 'g' }, true],
    [{ ...base, llmProvider: 'openai', anthropicApiKey: null }, true],
    [{ ...base, llmProvider: null, anthropicApiKey: null, openaiApiKey: 'o' }, true],
  ];
  for (const [unit, env] of cenarios) {
    const legado = escolherPlanoB(unit, env);
    const cadeia = montarCadeia({ unit, principal: 'anthropic', temChaveOpenAiNoAmbiente: env, reservas: SEM_RESERVA });
    assert.equal(cadeia.length, legado ? 1 : 0, JSON.stringify({ unit, env }));
    if (legado) {
      assert.equal(cadeia[0].provider, legado.provider);
      assert.equal(cadeia[0].modelName, legado.modelName);
      assert.deepEqual(cadeia[0].credenciais, {});
    }
  }
});

test('26/11: Anthropic principal sem OpenAI no ambiente e só a chave reserva do Google — o Google responde', () => {
  const cadeia = montarCadeia({ unit: base, principal: 'anthropic', temChaveOpenAiNoAmbiente: false, reservas: COM_GOOGLE });
  assert.deepEqual(ordem(cadeia), ['google:reserva-global']);
  assert.equal(cadeia[0].modelName, 'gemini-2.5-flash');
  assert.deepEqual(cadeia[0].credenciais, { googleApiKey: 'g-reserva' });
});

test('com reserva global: principal Anthropic cai para OpenAI e depois Google (ordem Anthropic, OpenAI, Google)', () => {
  const cadeia = montarCadeia({ unit: base, principal: 'anthropic', temChaveOpenAiNoAmbiente: true, reservas: COM_GOOGLE });
  assert.deepEqual(ordem(cadeia), ['openai:ambiente', 'google:reserva-global']);
});

test('principal OpenAI: Anthropic (reserva global) entra antes do Google', () => {
  const unit = { ...base, llmProvider: 'openai', anthropicApiKey: null };
  const cadeia = montarCadeia({ unit, principal: 'openai', temChaveOpenAiNoAmbiente: true, reservas: COM_AS_DUAS });
  // o plano B de hoje (Google da unidade? não tem; Anthropic? não tem) é nulo: tudo vem da reserva, na ordem
  assert.deepEqual(ordem(cadeia), ['anthropic:reserva-global', 'google:reserva-global']);
  assert.deepEqual(cadeia[0].credenciais, { anthropicApiKey: 'a-reserva' });
});

test('principal Google: Anthropic, depois OpenAI', () => {
  const unit = { ...base, llmProvider: 'google', googleApiKey: 'g-unidade', anthropicApiKey: null };
  const cadeia = montarCadeia({ unit, principal: 'google', temChaveOpenAiNoAmbiente: true, reservas: COM_AS_DUAS });
  assert.deepEqual(ordem(cadeia), ['openai:ambiente', 'anthropic:reserva-global']);
});

test('a chave da unidade vem antes da global do mesmo provedor', () => {
  const unit = { ...base, googleApiKey: 'g-da-unidade' };
  const cadeia = montarCadeia({ unit, principal: 'anthropic', temChaveOpenAiNoAmbiente: true, reservas: COM_GOOGLE });
  assert.deepEqual(ordem(cadeia), ['openai:ambiente', 'google:unidade', 'google:reserva-global']);
  assert.deepEqual(cadeia[1].credenciais, {});
  assert.deepEqual(cadeia[2].credenciais, { googleApiKey: 'g-reserva' });
});

test('chave de OpenAI da unidade é "unidade"; só a do ambiente é "ambiente"', () => {
  const unit = { ...base, openaiApiKey: 'o-unidade' };
  const cadeia = montarCadeia({ unit, principal: 'anthropic', temChaveOpenAiNoAmbiente: true, reservas: COM_GOOGLE });
  assert.equal(cadeia[0].origemChave, 'unidade');
});

test('nunca repete provedor nem inclui o principal na parte nova; teto de cada passo é o do plano B', () => {
  for (const principal of ['anthropic', 'openai', 'google'] as const) {
    const unit = { ...base, llmProvider: principal, googleApiKey: 'g', openaiApiKey: 'o' };
    const cadeia = montarCadeia({ unit, principal, temChaveOpenAiNoAmbiente: true, reservas: COM_AS_DUAS, timeoutMs: 1234 });
    const passos = cadeia.map((p) => `${p.provider}:${p.origemChave}`);
    assert.equal(new Set(passos).size, passos.length, `repetiu em ${principal}: ${passos}`);
    assert.ok(cadeia.every((p) => p.provider !== principal || p.origemChave !== 'reserva-global'), 'o principal não entra de novo pela reserva global');
    assert.ok(cadeia.every((p) => p.timeoutMs === 1234));
  }
});

test('só ANTHROPIC_RESERVE_API_KEY (já existente) também liga a cadeia completa', () => {
  const unit = { ...base, llmProvider: 'openai', anthropicApiKey: null };
  const cadeia = montarCadeia({
    unit,
    principal: 'openai',
    temChaveOpenAiNoAmbiente: true,
    reservas: { anthropic: 'a-reserva', google: null },
  });
  assert.deepEqual(ordem(cadeia), ['anthropic:reserva-global']);
});

test('reservasGlobais lê o ambiente na hora e ignora valor em branco', () => {
  const antes = { g: process.env.AGENT_RESERVE_GOOGLE_KEY, a: process.env.ANTHROPIC_RESERVE_API_KEY };
  try {
    delete process.env.AGENT_RESERVE_GOOGLE_KEY;
    delete process.env.ANTHROPIC_RESERVE_API_KEY;
    assert.deepEqual(reservasGlobais(), SEM_RESERVA);
    assert.equal(cadeiaCompletaLigada(reservasGlobais()), false);
    process.env.AGENT_RESERVE_GOOGLE_KEY = '   ';
    assert.equal(reservasGlobais().google, null);
    process.env.AGENT_RESERVE_GOOGLE_KEY = ' g-chave ';
    assert.deepEqual(reservasGlobais(), { anthropic: null, google: 'g-chave' });
    assert.equal(cadeiaCompletaLigada(reservasGlobais()), true);
  } finally {
    if (antes.g === undefined) delete process.env.AGENT_RESERVE_GOOGLE_KEY;
    else process.env.AGENT_RESERVE_GOOGLE_KEY = antes.g;
    if (antes.a === undefined) delete process.env.ANTHROPIC_RESERVE_API_KEY;
    else process.env.ANTHROPIC_RESERVE_API_KEY = antes.a;
  }
});

test('rótulo: a reserva global aparece separada em llm_calls', () => {
  assert.equal(rotuloDoProvedor({ provider: 'google', origemChave: 'reserva-global' }), 'google-reserva');
  assert.equal(rotuloDoProvedor({ provider: 'google', origemChave: 'unidade' }), 'google');
  assert.equal(rotuloDoProvedor({ provider: 'openai', origemChave: 'ambiente' }), 'openai');
});

// ---- percorrerCadeia --------------------------------------------------------------------------

function passo(provider: PassoDaCadeia['provider'], extra: Partial<PassoDaCadeia> = {}): PassoDaCadeia {
  return { provider, modelName: `${provider}-modelo`, origemChave: 'unidade', credenciais: {}, timeoutMs: 100, ...extra };
}

const erroSaldo = () => Object.assign(new Error('429 You have no credits remaining'), { status: 429 });

test('tenta na ordem e devolve o primeiro que responde, com o histórico', async () => {
  const chamados: string[] = [];
  const r = await percorrerCadeia({
    passos: [passo('openai'), passo('google'), passo('anthropic')],
    comCircuito: true,
    unitId: 'u1',
    chamar: async (p) => {
      chamados.push(p.provider);
      if (p.provider === 'openai') throw erroSaldo();
      return `resposta-${p.provider}`;
    },
  });
  assert.deepEqual(chamados, ['openai', 'google']);
  assert.equal(r.resposta, 'resposta-google');
  assert.equal(r.passo.provider, 'google');
  assert.deepEqual(r.tentativas.map((t) => `${t.provider}:${t.resultado}`), ['openai:saldo', 'google:respondeu']);
  assert.equal(resumoDasTentativas(r.tentativas), 'openai (sem saldo/cota) → google');
});

test('erro de saldo pula NA HORA (sem esperar o teto) e abre o circuito daquele provedor', async () => {
  const t0 = Date.now();
  const r = await percorrerCadeia({
    passos: [passo('openai', { timeoutMs: 5_000 }), passo('google', { timeoutMs: 5_000 })],
    comCircuito: true,
    unitId: 'u1',
    chamar: async (p) => {
      if (p.provider === 'openai') throw erroSaldo();
      return 'ok';
    },
  });
  assert.ok(Date.now() - t0 < 500, 'não pode ter esperado o teto de 5 s');
  assert.equal(r.passo.provider, 'google');
  assert.equal(circuitoAberto('openai:u1'), true);
  assert.equal(circuitoAberto('google:u1'), false);
});

test('na mensagem seguinte o provedor sem saldo nem é chamado (circuito aberto)', async () => {
  abrirCircuito('openai:u1');
  const chamados: string[] = [];
  const r = await percorrerCadeia({
    passos: [passo('openai'), passo('google')],
    comCircuito: true,
    unitId: 'u1',
    chamar: async (p) => {
      chamados.push(p.provider);
      return 'ok';
    },
  });
  assert.deepEqual(chamados, ['google']);
  assert.deepEqual(r.tentativas.map((t) => t.resultado), ['circuito-aberto', 'respondeu']);
});

test('timeout do passo vai para o próximo e conta como falha de infra (três seguidas abrem)', async () => {
  const lenta = () => new Promise<string>((res) => setTimeout(() => res('tarde'), 300));
  for (let i = 0; i < 3; i++) {
    const r = await percorrerCadeia({
      passos: [passo('openai', { timeoutMs: 20 }), passo('google')],
      comCircuito: true,
      unitId: 'u1',
      chamar: async (p) => (p.provider === 'openai' ? lenta() : 'ok'),
    });
    assert.equal(r.tentativas[0].resultado, 'timeout');
  }
  assert.equal(circuitoAberto('openai'), true);
  const estado = estadoDoCircuito().find((e) => e.provedor === 'openai');
  assert.equal(estado?.aberto, true);
});

test('erro que não é saldo nem infra (ex.: pedido inválido) segue pro próximo SEM mexer no circuito', async () => {
  const r = await percorrerCadeia({
    passos: [passo('openai'), passo('google')],
    comCircuito: true,
    unitId: 'u1',
    chamar: async (p) => {
      if (p.provider === 'openai') throw Object.assign(new Error('400 bad request'), { status: 400 });
      return 'ok';
    },
  });
  assert.equal(r.tentativas[0].resultado, 'erro');
  assert.equal(circuitoAberto('openai'), false);
});

test('sucesso fecha o circuito do reserva', async () => {
  abrirCircuito('google:u1', Date.now() - 200_000); // já venceu: a sonda passa
  const r = await percorrerCadeia({ passos: [passo('google')], comCircuito: true, unitId: 'u1', chamar: async () => 'ok' });
  assert.equal(r.passo.provider, 'google');
  assert.equal(circuitoAberto('google:u1'), false);
});

test('todos falham: lança CadeiaEsgotadaError com todas as tentativas e o último erro', async () => {
  await assert.rejects(
    percorrerCadeia({
      passos: [passo('openai'), passo('google')],
      comCircuito: true,
      unitId: 'u1',
      chamar: async () => {
        throw erroSaldo();
      },
    }),
    (e) => {
      assert.ok(e instanceof CadeiaEsgotadaError);
      assert.deepEqual(e.tentativas.map((t) => t.resultado), ['saldo', 'saldo']);
      assert.match(String(e.ultimoErro), /no credits remaining/);
      return true;
    },
  );
});

test('sem circuito (cadeia desligada = plano B de hoje): nunca consulta nem mexe no circuito', async () => {
  abrirCircuito('openai:u1'); // aberto, mas o plano B de hoje nunca olhou pra isso
  const chamados: string[] = [];
  await assert.rejects(
    percorrerCadeia({
      passos: [passo('openai')],
      comCircuito: false,
      unitId: 'u1',
      chamar: async (p) => {
        chamados.push(p.provider);
        throw erroSaldo();
      },
    }),
    CadeiaEsgotadaError,
  );
  assert.deepEqual(chamados, ['openai']);

  resetarCircuitos();
  await assert.rejects(
    percorrerCadeia({ passos: [passo('google')], comCircuito: false, unitId: 'u1', chamar: async () => { throw erroSaldo(); } }),
    CadeiaEsgotadaError,
  );
  assert.equal(circuitoAberto('google:u1'), false, 'saldo no plano B de hoje não abre circuito');
});

test('cadeia vazia lança CadeiaEsgotadaError (quem chama decide o fallback)', async () => {
  await assert.rejects(percorrerCadeia({ passos: [], comCircuito: true, unitId: 'u1', chamar: async () => 'x' }), CadeiaEsgotadaError);
});

test('a reescrita do bastidor leva a chave reserva global (senão o createChatModel cairia no OpenAI)', () => {
  const vistas: Array<{ llmProvider?: string; googleApiKey?: string | null }> = [];
  const alvo = alvoDoReescritor({
    unit: { llmProvider: 'anthropic', googleApiKey: null },
    modelName: 'claude-opus-4-8',
    provedorAtivo: 'anthropic',
    planoBEmUso: { provider: 'google', modelName: 'gemini-2.5-flash', credenciais: { googleApiKey: 'g-reserva' } },
    criarModelo: (u: { llmProvider?: string; googleApiKey?: string | null }) => {
      vistas.push(u);
      return 'modelo';
    },
    maxTokens: 400,
  });
  assert.equal(alvo.provider, 'google');
  assert.deepEqual(vistas[0], { llmProvider: 'google', googleApiKey: 'g-reserva' });
});

// Contrato do grafo (mesmo estilo de pos-processamento-plano-b.test.ts): a ligação não pode sumir em refatoração.
test('graph.ts: o plano B sai da cadeia; o que o circuito aprende sai de tratarFalhaDoPrincipal', () => {
  const src = readFileSync(new URL('./graph.ts', import.meta.url), 'utf8').replace(/\s+/g, '');
  assert.ok(src.includes('constcadeiaViva=cadeiaCompletaLigada(reservasGlobais());'));
  assert.ok(src.includes('tratarFalhaDoPrincipal({err,provider:providerasProvedor,saldoKey:saldoDoPrincipal,cadeiaViva,reservaFalhouPorOutroMotivo})'));
  assert.ok(src.includes('percorrerCadeia({passos:passosDeReserva,comCircuito:cadeiaViva,'));
  assert.ok(src.includes('thrownewCircuitoDeSaldoAbertoError(saldoDoPrincipal)'), 'circuito de saldo aberto tem de ter erro próprio (não conta como infra)');
  assert.ok(!src.includes('escolherPlanoB('), 'o grafo voltou a escolher um plano B só, fora da cadeia');
  assert.ok(!/planoB:passosDeReserva\[0\],/.test(src), 'o rastro não pode levar o passo inteiro (tem a chave reserva)');
});

test('abrirCircuito corta na hora e volta sozinho depois do descanso', () => {
  const agora = 5_000_000;
  abrirCircuito('anthropic', agora, 1000);
  assert.equal(circuitoAberto('anthropic', agora + 999), true);
  assert.equal(circuitoAberto('anthropic', agora + 1000), false);
});

test('saldo é da CHAVE: a conta sem saldo de uma unidade não corta o provedor das outras', async () => {
  const sempreSaldo = async () => {
    throw erroSaldo();
  };
  await assert.rejects(
    percorrerCadeia({ passos: [passo('anthropic')], comCircuito: true, unitId: 'taubate', chamar: sempreSaldo }),
    CadeiaEsgotadaError,
  );
  assert.equal(circuitoAberto(chaveDeSaldo('anthropic', 'unidade', 'taubate')), true);

  // outra unidade, com a chave Anthropic DELA: não pode ser pulada
  const r = await percorrerCadeia({ passos: [passo('anthropic')], comCircuito: true, unitId: 'salto', chamar: async () => 'ok' });
  assert.equal(r.tentativas[0].resultado, 'respondeu');
  // nem o circuito de infra do provedor foi tocado
  assert.equal(circuitoAberto('anthropic'), false);
});

test('chave compartilhada (ambiente / reserva global) corta para todos que a usam', async () => {
  await assert.rejects(
    percorrerCadeia({ passos: [passo('openai', { origemChave: 'ambiente' })], comCircuito: true, unitId: 'a', chamar: async () => { throw erroSaldo(); } }),
    CadeiaEsgotadaError,
  );
  const r = await percorrerCadeia({
    passos: [passo('openai', { origemChave: 'ambiente' }), passo('google', { origemChave: 'reserva-global' })],
    comCircuito: true,
    unitId: 'b',
    chamar: async () => 'ok',
  });
  assert.deepEqual(r.tentativas.map((t) => t.resultado), ['circuito-aberto', 'respondeu']);
  assert.equal(chaveDeSaldo('google', 'reserva-global', 'b'), 'google:reserva');
});

test('origem da chave do principal: OpenAI sem chave própria usa a do ambiente', () => {
  assert.equal(origemDoPrincipal('openai', { openaiApiKey: null }), 'ambiente');
  assert.equal(origemDoPrincipal('openai', { openaiApiKey: 'o' }), 'unidade');
  assert.equal(origemDoPrincipal('anthropic', { openaiApiKey: null }), 'unidade');
});

// ---- o que o circuito aprende com a falha do principal (defeitos 2 e 5 da revisão) -------------------

const base429 = () => erroSaldo();

test('uma unidade sem crédito NUNCA corta o provedor da rede: pular por circuito de saldo não conta como falha de infra', () => {
  const saldoKey = chaveDeSaldo('anthropic', 'unidade', 'taubate');
  abrirCircuito(saldoKey);
  const pulo = new CircuitoDeSaldoAbertoError(saldoKey);
  assert.equal(ehFalhaDeInfra(pulo), false);
  // 10 mensagens da unidade sem crédito: o provedor continua de pé para as outras unidades
  for (let i = 0; i < 10; i++) {
    assert.equal(tratarFalhaDoPrincipal({ err: pulo, provider: 'anthropic', saldoKey, cadeiaViva: true, reservaFalhouPorOutroMotivo: false }), 'nenhum');
  }
  assert.equal(circuitoAberto('anthropic'), false);
  assert.equal(estadoDoCircuito().find((e) => e.provedor === 'anthropic')?.falhasSeguidas, 0);
});

test('saldo no principal abre o circuito da CHAVE e não toca no do provedor', () => {
  const saldoKey = chaveDeSaldo('anthropic', 'unidade', 'taubate');
  assert.equal(tratarFalhaDoPrincipal({ err: base429(), provider: 'anthropic', saldoKey, cadeiaViva: true, reservaFalhouPorOutroMotivo: false }), 'saldo-abriu');
  assert.equal(circuitoAberto(saldoKey), true);
  assert.equal(circuitoAberto('anthropic'), false);
  assert.equal(estadoDoCircuito().find((e) => e.provedor === saldoKey)?.aberto, true, 'o painel enxerga o circuito de saldo');
});

test('saldo com a cadeia desligada (sem env nova): não abre nada, como hoje', () => {
  const saldoKey = chaveDeSaldo('anthropic', 'unidade', 'a');
  assert.equal(tratarFalhaDoPrincipal({ err: base429(), provider: 'anthropic', saldoKey, cadeiaViva: false, reservaFalhouPorOutroMotivo: false }), 'nenhum');
  assert.equal(circuitoAberto(saldoKey), false);
  assert.equal(circuitoAberto('anthropic'), false);
});

test('chave reserva da Anthropic que falhou por TIMEOUT não deixa a chave da unidade abrir circuito (a reserva pode estar boa)', () => {
  const saldoKey = chaveDeSaldo('anthropic', 'unidade', 'taubate');
  const r = tratarFalhaDoPrincipal({ err: base429(), provider: 'anthropic', saldoKey, cadeiaViva: true, reservaFalhouPorOutroMotivo: true });
  assert.equal(r, 'nenhum');
  assert.equal(circuitoAberto(saldoKey), false);
});

test('infra continua igual: três falhas seguidas abrem o provedor', () => {
  const timeout = Object.assign(new Error('IA não respondeu em 35000ms'), { name: 'LlmTimeoutError' });
  const saldoKey = chaveDeSaldo('openai', 'ambiente', 'x');
  const r = [1, 2, 3].map(() => tratarFalhaDoPrincipal({ err: timeout, provider: 'openai', saldoKey, cadeiaViva: false, reservaFalhouPorOutroMotivo: false }));
  assert.deepEqual(r, ['nenhum', 'nenhum', 'infra-abriu']);
  assert.equal(circuitoAberto('openai'), true);
  registrarFalha('openai'); // (só para usar o import e provar que a contagem segue por provedor)
});

test('a reserva global da Anthropic sem saldo tem circuito próprio, compartilhado por todas as unidades', () => {
  assert.equal(CHAVE_SALDO_RESERVA_ANTHROPIC, 'anthropic:reserva');
  assert.equal(CHAVE_SALDO_RESERVA_ANTHROPIC, chaveDeSaldo('anthropic', 'reserva-global', 'qualquer-unidade'));
});

// ---- prazo da cadeia inteira -------------------------------------------------------------------

test('prazo total: cada passo ganha só o que sobra e o passo sem tempo nem começa', async () => {
  let agora = 1_000_000;
  const chamados: string[] = [];
  const r = percorrerCadeia({
    passos: [passo('openai', { timeoutMs: 20_000 }), passo('google', { timeoutMs: 20_000 }), passo('anthropic', { timeoutMs: 20_000 })],
    comCircuito: false,
    unitId: 'u',
    prazoAte: agora + 25_000,
    agora: () => agora,
    chamar: async (p) => {
      chamados.push(p.provider);
      agora += 20_000; // cada chamada gasta o teto
      throw new Error('503 service unavailable');
    },
  });
  await assert.rejects(r, (e) => {
    assert.ok(e instanceof CadeiaEsgotadaError);
    // openai gasta 20 s; sobram 5 s: google começa (com teto de 5 s) e gasta; anthropic já não tem tempo
    return true;
  });
  assert.deepEqual(chamados, ['openai', 'google']);
});

test('prazo total: passo com menos de 2 s restantes é registrado como sem-tempo', async () => {
  let agora = 0;
  await assert.rejects(
    percorrerCadeia({
      passos: [passo('openai')],
      comCircuito: false,
      unitId: 'u',
      prazoAte: 1_500,
      agora: () => agora,
      chamar: async () => 'nunca',
    }),
    (e) => e instanceof CadeiaEsgotadaError && e.tentativas[0].resultado === 'sem-tempo',
  );
});

test('o rótulo da reserva global vai para a reescrita do bastidor (llm_calls "google-reserva")', () => {
  const alvo = alvoDoReescritor({
    unit: { llmProvider: 'anthropic' },
    modelName: 'm',
    provedorAtivo: 'anthropic',
    planoBEmUso: { provider: 'google', modelName: 'gemini-2.5-flash', credenciais: { googleApiKey: 'g' }, rotulo: 'google-reserva' },
    criarModelo: () => 'modelo',
    maxTokens: 400,
  });
  assert.equal(alvo.provider, 'google-reserva');
});

// ---- revisão da 2ª rodada ------------------------------------------------------------------------

test('teto ENCURTADO pelo prazo da cadeia que estoura é "sem-tempo": não conta como falha do provedor (3 vezes não cortam a rede)', async () => {
  // prazo de 60 ms (piso de 10 ms) com relógio injetado: o teto de 60 s do passo é encurtado para 60 ms e a chamada nunca volta
  const agora = 0;
  const falhasAntes = estadoDoCircuito().find((e) => e.provedor === 'google')?.falhasSeguidas ?? 0;
  for (let i = 0; i < 4; i++) {
    await assert.rejects(
      percorrerCadeia({
        passos: [passo('google', { timeoutMs: 60_000 })],
        comCircuito: true,
        unitId: 'u',
        prazoAte: 60,
        pisoDeTempoMs: 10,
        agora: () => agora,
        chamar: () => new Promise<string>(() => undefined),
      }),
      (e) => e instanceof CadeiaEsgotadaError && e.tentativas[0].resultado === 'sem-tempo',
    );
  }
  assert.equal(circuitoAberto('google'), false, 'o prazo da cadeia não pode cortar o Google da rede');
  assert.equal(estadoDoCircuito().find((e) => e.provedor === 'google')?.falhasSeguidas, falhasAntes);
});

test('timeout no teto INTEIRO do passo (sem encurtar) continua contando como falha de infra', async () => {
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      percorrerCadeia({ passos: [passo('google', { timeoutMs: 15 })], comCircuito: true, unitId: 'u', chamar: () => new Promise<string>(() => undefined) }),
      CadeiaEsgotadaError,
    );
  }
  assert.equal(circuitoAberto('google'), true);
});

test('chave da unidade sem saldo cai na reserva global do MESMO provedor (logo depois dela)', () => {
  const unit = { ...base, llmProvider: 'openai', anthropicApiKey: 'a-unidade', googleApiKey: 'g-unidade' };
  const cadeia = montarCadeia({ unit, principal: 'openai', temChaveOpenAiNoAmbiente: true, reservas: COM_AS_DUAS });
  assert.deepEqual(ordem(cadeia), ['anthropic:unidade', 'anthropic:reserva-global', 'google:unidade', 'google:reserva-global']);
  assert.deepEqual(cadeia[1].credenciais, { anthropicApiKey: 'a-reserva' });
  assert.deepEqual(cadeia[3].credenciais, { googleApiKey: 'g-reserva' });
});

test('reserva global igual à chave da unidade não vira passo repetido; sem reserva global nada muda', () => {
  const unit = { ...base, llmProvider: 'openai', anthropicApiKey: 'mesma' };
  const cadeia = montarCadeia({ unit, principal: 'openai', temChaveOpenAiNoAmbiente: false, reservas: { anthropic: 'mesma', google: null } });
  assert.deepEqual(ordem(cadeia), ['anthropic:unidade']);
  const sem = montarCadeia({ unit, principal: 'openai', temChaveOpenAiNoAmbiente: false, reservas: SEM_RESERVA });
  assert.deepEqual(ordem(sem), ['anthropic:unidade']);
});

test('consultar o circuito não cria entrada (há uma chave de saldo por unidade)', () => {
  resetarCircuitos();
  const antes = estadoDoCircuito().length;
  for (let i = 0; i < 50; i++) circuitoAberto(chaveDeSaldo('anthropic', 'unidade', `u${i}`));
  assert.equal(estadoDoCircuito().length, antes);
});
