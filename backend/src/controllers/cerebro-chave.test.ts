/**
 * A chave de serviço do cérebro — e o erro que ela já cometeu uma vez.
 *
 * Na primeira versão a rota ficava pendurada DEPOIS do `apiRouter.use(requireAuth)`. O
 * guarda global respondia 401 antes de qualquer um olhar a chave, então o caminho da
 * chave existia, passava no code review, e nunca rodava: a rotina das 17h tomava 401 e
 * ninguém sabia por quê. O último teste daqui lê o arquivo de rotas e falha se alguém
 * mover as rotas do cérebro pra baixo daquele `use` de novo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.INTERNAL_API_KEY ??= 'chave-de-teste-123';

const { chaveDeServicoOuSessao } = await import('./cerebro.controller.js');

type Req = { header: (n: string) => string | undefined };
const pedido = (cabecalhos: Record<string, string> = {}): Req => ({
  header: (n) => cabecalhos[n.toLowerCase()],
});
const resposta = () => {
  const r = { codigo: 0, corpo: null as unknown };
  return Object.assign(r, {
    status(c: number) { r.codigo = c; return this; },
    json(b: unknown) { r.corpo = b; return this; },
  });
};

test('com a chave certa, pula a cadeia inteira de guardas', () => {
  const passou: string[] = [];
  const guarda = (nome: string) => (_q: never, _s: never, seguir: () => void) => {
    passou.push(nome);
    seguir();
  };
  let chegou = false;
  const mw = chaveDeServicoOuSessao(guarda('auth') as never, guarda('unidade') as never);
  mw(pedido({ 'x-internal-key': 'chave-de-teste-123' }) as never, resposta() as never, () => {
    chegou = true;
  });
  assert.equal(chegou, true);
  assert.deepEqual(passou, [], 'nenhum guarda devia ter rodado');
});

test('aceita a chave no Authorization: Bearer, que é como curl e n8n mandam', () => {
  let chegou = false;
  const mw = chaveDeServicoOuSessao();
  mw(pedido({ authorization: 'Bearer chave-de-teste-123' }) as never, resposta() as never, () => {
    chegou = true;
  });
  assert.equal(chegou, true);
});

test('sem chave, a cadeia roda inteira e na ordem', () => {
  const passou: string[] = [];
  const guarda = (nome: string) => (_q: never, _s: never, seguir: () => void) => {
    passou.push(nome);
    seguir();
  };
  let chegou = false;
  const mw = chaveDeServicoOuSessao(guarda('auth') as never, guarda('unidade') as never);
  mw(pedido() as never, resposta() as never, () => {
    chegou = true;
  });
  assert.deepEqual(passou, ['auth', 'unidade']);
  assert.equal(chegou, true);
});

test('chave errada não vale como chave: cai na cadeia normal', () => {
  const passou: string[] = [];
  const mw = chaveDeServicoOuSessao(((_q: never, _s: never, seguir: () => void) => {
    passou.push('auth');
    seguir();
  }) as never);
  mw(pedido({ 'x-internal-key': 'quase-a-chave' }) as never, resposta() as never, () => {});
  assert.deepEqual(passou, ['auth']);
});

test('guarda que recusa interrompe a cadeia — o handler não roda', () => {
  const res = resposta();
  let chegou = false;
  const recusa = (_q: never, s: ReturnType<typeof resposta>) => {
    s.status(401).json({ error: 'unauthenticated' });
  };
  const depois = (_q: never, _s: never, seguir: () => void) => {
    chegou = true;
    seguir();
  };
  const mw = chaveDeServicoOuSessao(recusa as never, depois as never);
  mw(pedido() as never, res as never, () => {
    chegou = true;
  });
  assert.equal(res.codigo, 401);
  assert.equal(chegou, false, 'a cadeia devia ter parado no guarda que recusou');
});

test('guarda que chama next(erro) não vira passagem livre', () => {
  const passou: string[] = [];
  let repassado: unknown;
  const falha = (_q: never, _s: never, seguir: (e?: unknown) => void) => {
    seguir(new Error('banco caiu'));
  };
  const depois = (_q: never, _s: never, seguir: () => void) => {
    passou.push('depois');
    seguir();
  };
  const mw = chaveDeServicoOuSessao(falha as never, depois as never);
  mw(pedido() as never, resposta() as never, ((e?: unknown) => {
    repassado = e;
  }) as never);
  assert.ok(repassado instanceof Error, 'o erro tinha de subir pro Express');
  assert.deepEqual(passou, [], 'a cadeia não podia continuar depois do erro');
});

test('chave de tamanho diferente não estoura — só recusa', () => {
  let chegou = false;
  const mw = chaveDeServicoOuSessao();
  mw(pedido({ 'x-internal-key': 'curta' }) as never, resposta() as never, () => {
    chegou = true;
  });
  assert.equal(chegou, true, 'sem guarda na cadeia, segue; o que importa é não lançar');
});

test('as rotas do cérebro ficam ACIMA do requireAuth global', () => {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const rotas = readFileSync(join(aqui, '..', 'routes', 'api.routes.ts'), 'utf8');

  const guardaGlobal = rotas.indexOf('apiRouter.use(requireAuth)');
  assert.ok(guardaGlobal > 0, 'não achei o requireAuth global — o teste precisa ser reescrito');

  for (const rota of ['/cerebro/unidades', "'/units/:id/cerebro/panorama'", "'/units/:id/cerebro/paciente'"]) {
    const onde = rotas.indexOf(rota);
    assert.ok(onde > 0, `rota ${rota} sumiu do api.routes.ts`);
    assert.ok(
      onde < guardaGlobal,
      `${rota} está depois do requireAuth global — a chave de serviço volta a tomar 401 antes de ser lida`,
    );
  }
});
