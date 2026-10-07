import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  comChaveReserva,
  ehFalhaDeChave,
  chaveReservaAnthropic,
  resetarAvisosDaReserva,
  type AvisoReserva,
} from './chave-reserva.js';
import { ehFalhaDeInfra } from './circuito.js';
import { FALLBACK_INDISPONIVEL, LlmTimeoutError } from './llm-policy.js';

/**
 * 05/10/2026: a chave Anthropic da Taubaté venceu (validade de 30 dias) e a Sofia respondeu ~82
 * vezes "tive uma instabilidade" das 9h às 16h. A Anthropic estava de pé — só a chave estava morta.
 */

const UNIDADE = { id: 'u-taubate', slug: 'taubate', anthropicApiKey: 'sk-ant-da-unidade' };
const RESERVA = 'sk-ant-reserva-de-teste';
const AGORA = 1_000_000_000;

/** Erro no formato que o SDK 0.91 + @langchain/anthropic 1.3.29 lançam (conferido com chave falsa). */
function erroDaApi(status: number, tipo: string, mensagem: string): Error {
  const corpo = JSON.stringify({ type: 'error', error: { type: tipo, message: mensagem }, request_id: null });
  return Object.assign(new Error(`${status} ${corpo}`), {
    status,
    type: tipo,
    error: JSON.parse(corpo),
  });
}

const chaveVencida = () => erroDaApi(401, 'authentication_error', 'API key is invalid.');

function chamadas<T>(respostas: Array<T | Error>) {
  const chaves: Array<string | null> = [];
  const chamar = async (chave: string | null): Promise<T> => {
    chaves.push(chave);
    const r = respostas[chaves.length - 1];
    if (r === undefined) throw new Error('chamada a mais — laço?');
    if (r instanceof Error) throw r;
    return r;
  };
  return { chaves, chamar };
}

const ENV_ANTES = process.env.ANTHROPIC_RESERVE_API_KEY;

beforeEach(() => {
  resetarAvisosDaReserva();
  delete process.env.ANTHROPIC_RESERVE_API_KEY;
});

afterEach(() => {
  if (ENV_ANTES === undefined) delete process.env.ANTHROPIC_RESERVE_API_KEY;
  else process.env.ANTHROPIC_RESERVE_API_KEY = ENV_ANTES;
});

// ── o que conta como "a chave/conta não serve" ──────────────────────────────

test('chave vencida/revogada (401) é falha de chave', () => {
  assert.deepEqual(ehFalhaDeChave(chaveVencida()), { status: 401, tipo: 'authentication_error' });
});

test('403, 402 e falta de crédito também são falha de chave/conta', () => {
  assert.deepEqual(ehFalhaDeChave(erroDaApi(403, 'permission_error', 'Forbidden')), {
    status: 403,
    tipo: 'permission_error',
  });
  assert.deepEqual(ehFalhaDeChave(erroDaApi(402, 'billing_error', 'Billing issue')), {
    status: 402,
    tipo: 'billing_error',
  });
  const semCredito = erroDaApi(
    400,
    'invalid_request_error',
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  );
  assert.deepEqual(ehFalhaDeChave(semCredito), { status: 400, tipo: 'sem_credito' });
  const tetoDaConta = erroDaApi(
    400,
    'invalid_request_error',
    'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
  );
  assert.deepEqual(ehFalhaDeChave(tetoDaConta), { status: 400, tipo: 'sem_credito' });
});

test('reconhece mesmo quando só sobrou a mensagem ("401 {...}")', () => {
  const embrulhado = new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
  assert.deepEqual(ehFalhaDeChave(embrulhado), { status: 401, tipo: 'authentication_error' });
});

test('erro passageiro NÃO é falha de chave — isso é do circuito', () => {
  assert.equal(ehFalhaDeChave(erroDaApi(429, 'rate_limit_error', 'This request would exceed the rate limit for your organization')), null);
  assert.equal(ehFalhaDeChave(erroDaApi(529, 'overloaded_error', 'Overloaded')), null);
  assert.equal(ehFalhaDeChave(erroDaApi(500, 'api_error', 'Internal server error')), null);
  assert.equal(ehFalhaDeChave(new LlmTimeoutError(35000)), null);
  assert.equal(ehFalhaDeChave(new Error('connect ETIMEDOUT 1.2.3.4:443')), null);
  assert.equal(ehFalhaDeChave(new Error('Connection error.')), null);
});

test('pedido inválido e modelo inexistente NÃO são falha de chave — outra chave não resolveria', () => {
  assert.equal(ehFalhaDeChave(erroDaApi(400, 'invalid_request_error', 'prompt is too long: 250000 tokens')), null);
  assert.equal(ehFalhaDeChave(erroDaApi(404, 'not_found_error', 'model: claude-xyz')), null);
  assert.equal(ehFalhaDeChave(null), null);
});

test('chave e infraestrutura nunca são a mesma coisa (reserva e circuito não brigam)', () => {
  const amostras = [
    chaveVencida(),
    erroDaApi(403, 'permission_error', 'x'),
    erroDaApi(402, 'billing_error', 'x'),
    erroDaApi(400, 'invalid_request_error', 'Your credit balance is too low'),
    erroDaApi(429, 'rate_limit_error', 'rate limit'),
    erroDaApi(529, 'overloaded_error', 'Overloaded'),
    erroDaApi(500, 'api_error', 'x'),
    new LlmTimeoutError(1),
  ];
  for (const e of amostras) {
    assert.ok(!(ehFalhaDeChave(e) && ehFalhaDeInfra(e)), `classificado nos dois lados: ${e.message}`);
  }
});

// ── a troca de chave ─────────────────────────────────────────────────────────

test('chave da unidade vencida → refaz UMA vez com a reserva e responde', async () => {
  const { chaves, chamar } = chamadas<string>([chaveVencida(), 'resposta da reserva']);
  const avisos: AvisoReserva[] = [];
  let usou: unknown = null;

  const r = await comChaveReserva({
    unidade: UNIDADE,
    provedor: 'anthropic',
    chamar,
    chaveReserva: RESERVA,
    avisar: (a) => avisos.push(a),
    aoUsarReserva: (falha) => {
      usou = falha;
    },
    agora: AGORA,
  });

  assert.equal(r, 'resposta da reserva');
  assert.deepEqual(chaves, [null, RESERVA], 'primeiro a da unidade, depois a reserva');
  assert.deepEqual(usou, { status: 401, tipo: 'authentication_error' });
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].evento, 'usando-reserva');
  assert.equal(avisos[0].slug, 'taubate');
  assert.ok(!JSON.stringify(avisos).includes(RESERVA), 'a chave nunca vai pro aviso');
  assert.ok(!JSON.stringify(avisos).includes(UNIDADE.anthropicApiKey), 'nem a da unidade');
});

test('lê a reserva de ANTHROPIC_RESERVE_API_KEY', async () => {
  process.env.ANTHROPIC_RESERVE_API_KEY = `  ${RESERVA}  `;
  assert.equal(chaveReservaAnthropic(), RESERVA, 'espaço em volta (copiar e colar) não estraga');

  const { chaves, chamar } = chamadas<string>([chaveVencida(), 'ok']);
  const r = await comChaveReserva({ unidade: UNIDADE, provedor: 'anthropic', chamar, avisar: () => {}, agora: AGORA });
  assert.equal(r, 'ok');
  assert.deepEqual(chaves, [null, RESERVA]);
});

test('sem a variável → igual a hoje: o erro original sobe e nada é refeito', async () => {
  assert.equal(chaveReservaAnthropic(), null);
  const erro = chaveVencida();
  const { chaves, chamar } = chamadas<string>([erro]);
  const avisos: AvisoReserva[] = [];

  await assert.rejects(
    comChaveReserva({ unidade: UNIDADE, provedor: 'anthropic', chamar, avisar: (a) => avisos.push(a), agora: AGORA }),
    (e) => e === erro,
  );
  assert.deepEqual(chaves, [null]);
  assert.equal(avisos.length, 0);
});

test('variável vazia conta como sem reserva', async () => {
  process.env.ANTHROPIC_RESERVE_API_KEY = '   ';
  assert.equal(chaveReservaAnthropic(), null);
});

test('erro passageiro → NÃO usa a reserva (fica com o circuito/plano B de hoje)', async () => {
  for (const passageiro of [
    erroDaApi(529, 'overloaded_error', 'Overloaded'),
    erroDaApi(429, 'rate_limit_error', 'rate limit'),
    erroDaApi(503, 'api_error', 'Service Unavailable'),
    new LlmTimeoutError(35000),
  ]) {
    const { chaves, chamar } = chamadas<string>([passageiro]);
    await assert.rejects(
      comChaveReserva({ unidade: UNIDADE, provedor: 'anthropic', chamar, chaveReserva: RESERVA, avisar: () => {}, agora: AGORA }),
      (e) => e === passageiro,
    );
    assert.deepEqual(chaves, [null], `usou a reserva em ${passageiro.message}`);
  }
});

test('reserva também falha → sobe o erro ORIGINAL, sem laço, e o turno cai na frase de instabilidade', async () => {
  const original = chaveVencida();
  const daReserva = erroDaApi(401, 'authentication_error', 'API key is invalid.');
  const { chaves, chamar } = chamadas<string>([original, daReserva]);
  const avisos: AvisoReserva[] = [];
  let falhouCom: unknown = null;

  // O mesmo formato do nó do grafo: o que sobe da chamada vai pro catch de hoje (plano B de
  // provedor e, sem ele, a frase de instabilidade).
  const turno = async (): Promise<string> => {
    try {
      return await comChaveReserva({
        unidade: UNIDADE,
        provedor: 'anthropic',
        chamar,
        chaveReserva: RESERVA,
        avisar: (a) => avisos.push(a),
        aoFalharReserva: (_f, e) => {
          falhouCom = e;
        },
        agora: AGORA,
      });
    } catch (e) {
      assert.equal(e, original, 'o catch de hoje recebe o erro da chave da unidade, como antes');
      return FALLBACK_INDISPONIVEL;
    }
  };

  assert.equal(await turno(), FALLBACK_INDISPONIVEL);
  assert.deepEqual(chaves, [null, RESERVA], 'exatamente duas chamadas — a reserva não é retentada');
  assert.equal(falhouCom, daReserva);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].evento, 'reserva-falhou');
  assert.ok(avisos[0].evento === 'reserva-falhou' && avisos[0].erroReserva === '401/authentication_error');
});

test('unidade que não roda Anthropic não usa a reserva Anthropic', async () => {
  const { chaves, chamar } = chamadas<string>([chaveVencida()]);
  await assert.rejects(
    comChaveReserva({ unidade: UNIDADE, provedor: 'google', chamar, chaveReserva: RESERVA, avisar: () => {}, agora: AGORA }),
  );
  assert.deepEqual(chaves, [null]);
});

test('reserva igual à chave da unidade não gasta a segunda chamada', async () => {
  const { chaves, chamar } = chamadas<string>([chaveVencida()]);
  await assert.rejects(
    comChaveReserva({
      unidade: UNIDADE,
      provedor: 'anthropic',
      chamar,
      chaveReserva: UNIDADE.anthropicApiKey,
      avisar: () => {},
      agora: AGORA,
    }),
  );
  assert.deepEqual(chaves, [null]);
});

test('chave da unidade voltou a valer → nem encosta na reserva', async () => {
  const { chaves, chamar } = chamadas<string>(['resposta normal']);
  const r = await comChaveReserva({ unidade: UNIDADE, provedor: 'anthropic', chamar, chaveReserva: RESERVA, avisar: () => {}, agora: AGORA });
  assert.equal(r, 'resposta normal');
  assert.deepEqual(chaves, [null]);
});

// ── a trava do aviso ─────────────────────────────────────────────────────────

test('aviso sai no máximo 1 vez por unidade por hora', async () => {
  const avisos: AvisoReserva[] = [];
  const rodar = (slug: string, agora: number) =>
    comChaveReserva({
      unidade: { ...UNIDADE, slug },
      provedor: 'anthropic',
      chamar: chamadas<string>([chaveVencida(), 'ok']).chamar,
      chaveReserva: RESERVA,
      avisar: (a) => avisos.push(a),
      agora,
    });

  await rodar('taubate', AGORA);
  await rodar('taubate', AGORA + 5 * 60_000);
  await rodar('taubate', AGORA + 59 * 60_000);
  assert.equal(avisos.length, 1, 'chave vencida falha em toda mensagem — o aviso não pode repetir junto');

  await rodar('olimpia', AGORA + 10 * 60_000);
  assert.equal(avisos.length, 2, 'outra unidade tem a trava dela');

  await rodar('taubate', AGORA + 61 * 60_000);
  assert.equal(avisos.length, 3, 'passou a hora: avisa de novo (a chave continua quebrada)');
});

test('falha ao registrar na trilha não derruba a resposta da reserva', async () => {
  const r = await comChaveReserva({
    unidade: UNIDADE,
    provedor: 'anthropic',
    chamar: chamadas<string>([chaveVencida(), 'ok']).chamar,
    chaveReserva: RESERVA,
    avisar: () => {},
    aoUsarReserva: () => {
      throw new Error('banco fora');
    },
    agora: AGORA,
  });
  assert.equal(r, 'ok');
});
