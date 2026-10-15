import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Duas regras de rota que já morderam o projeto (ver "chave de serviço × ordem das rotas"):
 * - o retorno do Bling é PÚBLICO e tem de ficar ACIMA do `apiRouter.use(requireAuth)` — abaixo dele o
 *   navegador do administrador do Bling levaria 401 e o código de 1 minuto se perderia;
 * - gravar o aplicativo e gerar o link ESCREVEM: só sessão de SUPER_ADMIN, nunca a chave de serviço.
 */
const src = readFileSync(new URL('../../routes/api.routes.ts', import.meta.url), 'utf8');
const authGlobal = src.indexOf('apiRouter.use(requireAuth);');

test('retorno do Bling é público e fica acima do requireAuth global', () => {
  const i = src.indexOf("apiRouter.get('/bling/callback', blingCallbackHandler);");
  assert.ok(i > 0 && authGlobal > 0 && i < authGlobal);
});

test('rotas do Bling que escrevem exigem sessão de SUPER_ADMIN (sem chave de serviço)', () => {
  assert.match(src, /apiRouter\.put\('\/bling\/:slug\/app', requireAuth, requireSuperAdmin, blingAppHandler\)/);
  assert.match(src, /apiRouter\.post\('\/bling\/:slug\/autorizar', requireAuth, requireSuperAdmin, blingAutorizarHandler\)/);
  assert.doesNotMatch(src, /'\/bling\/:slug\/(app|autorizar)',\s*chaveDeServicoOuSessao/);
});
