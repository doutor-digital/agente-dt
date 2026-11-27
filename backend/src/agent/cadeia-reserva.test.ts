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
  type PassoDaCadeia,
  type ReservasGlobais,
} from './cadeia-reserva.js';
import { abrirCircuito, circuitoAberto, resetarCircuitos, estadoDoCircuito } from './circuito.js';
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
  assert.deepEqual(ordem(cadeia), ['openai:ambiente', 'google:unidade']);
  assert.deepEqual(cadeia[1].credenciais, {});
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
    const provedores = cadeia.map((p) => p.provider);
    assert.equal(new Set(provedores).size, provedores.length, `repetiu em ${principal}: ${provedores}`);
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

// Contrato do grafo (mesmo estilo de pos-processamento-plano-b.test.ts): o plano B passa pela cadeia, e o circuito/saldo só com a cadeia ligada.
test('graph.ts: o plano B sai da cadeia; saldo abre o circuito só com a chave reserva global configurada', () => {
  const src = readFileSync(new URL('./graph.ts', import.meta.url), 'utf8').replace(/\s+/g, '');
  assert.ok(src.includes('constcadeiaViva=cadeiaCompletaLigada(reservasGlobais());'));
  assert.ok(src.includes('if(cadeiaViva&&ehErroDeSaldoOuCota(err)){'));
  assert.ok(src.includes('abrirCircuito(saldoDoPrincipal);'), 'saldo do principal tem de abrir o circuito DA CHAVE, não do provedor');
  assert.ok(src.includes('percorrerCadeia({passos:passosDeReserva,comCircuito:cadeiaViva,'));
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
