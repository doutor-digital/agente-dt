/**
 * `lembretesDoServidor`: a ÚNICA fonte da verdade de quais lembretes de consulta ESTE servidor manda para a unidade (o reminder-worker decide por ela e a
 * pausa da unidade a usa para dizer o que para). Casos: véspera pelo servidor, véspera pelo robô da Kommo, D-2 liberado, sem Kommo, dia útil anterior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { lembretesDoServidor } = await import('./reminder-worker.js');
const { lembretesDaPausa } = await import('../controllers/agente-pausa.controller.js');

const kommo = { slug: 'timbo', spineEnabled: true, spineToken: 'tok' };
// chave `confirmacao-d1` («consulta»): desligado = a véspera sai do servidor; qualquer outro estado = o robô de 24 h da Kommo manda
const D1 = 'CONFIRMACAO_D1_SLUGS';

test('véspera pelo SERVIDOR (chave desligada): roda, vespera=servidor, sem D-2', () => {
  const q = lembretesDoServidor(kommo, {} as NodeJS.ProcessEnv);
  assert.equal(q.roda, true);
  assert.equal(q.vespera, 'servidor');
  assert.equal(q.d2, false);
});

test('véspera pelo ROBÔ DA KOMMO (chave fora de «desligado»): vespera=robo-kommo, a pausa não a alcança', () => {
  const envs = [{ [D1]: 'timbo' }, { [D1]: '*' }] as NodeJS.ProcessEnv[];
  for (const env of envs) assert.equal(lembretesDoServidor(kommo, env).vespera, 'robo-kommo', JSON.stringify(env));
});

test('D-2 só quando o reforço está liberado (CONFIRMACAO_D2_SLUGS) e a unidade não é de «dia útil anterior»', () => {
  assert.equal(lembretesDoServidor(kommo, { CONFIRMACAO_D2_SLUGS: 'timbo' } as NodeJS.ProcessEnv).d2, true);
  assert.equal(lembretesDoServidor(kommo, { CONFIRMACAO_D2_SLUGS: '*' } as NodeJS.ProcessEnv).d2, true);
  assert.equal(lembretesDoServidor(kommo, { CONFIRMACAO_D2_SLUGS: 'outra' } as NodeJS.ProcessEnv).d2, false);
});

test('SEM Kommo (spine desligado ou sem token da franquia): o worker não varre, nada daqui para com a pausa', () => {
  assert.equal(lembretesDoServidor({ slug: 'timbo', spineEnabled: false, spineToken: 'tok' }, {} as NodeJS.ProcessEnv).roda, false);
  assert.equal(lembretesDoServidor({ slug: 'timbo', spineEnabled: true, spineToken: null }, {} as NodeJS.ProcessEnv).roda, false);
});

test('o que a pausa PARA (lembretesDaPausa) sai da mesma função: servidor, robô da Kommo, D-2 e sem Kommo', () => {
  const antes = { ...process.env };
  try {
    delete process.env[D1];
    delete process.env.CONFIRMACAO_D2_SLUGS;
    assert.deepEqual(lembretesDaPausa(kommo), { vesperaServidor: true, vesperaRoboKommo: false, d2Servidor: false }, 'véspera pelo servidor');
    process.env.CONFIRMACAO_D2_SLUGS = 'timbo';
    assert.deepEqual(lembretesDaPausa(kommo), { vesperaServidor: true, vesperaRoboKommo: false, d2Servidor: true }, 'D-2 liberado');
    process.env[D1] = 'timbo';
    assert.deepEqual(lembretesDaPausa(kommo), { vesperaServidor: false, vesperaRoboKommo: true, d2Servidor: true }, 'véspera pelo robô da Kommo (a pausa não a alcança)');
    assert.deepEqual(lembretesDaPausa({ slug: 'timbo', spineEnabled: false, spineToken: null }), { vesperaServidor: false, vesperaRoboKommo: false, d2Servidor: false }, 'sem Kommo');
  } finally {
    for (const k of [D1, 'CONFIRMACAO_D2_SLUGS']) if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k];
  }
});
