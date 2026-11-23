/**
 * Leitura do funil (23/11/2026: a aba «Funil» levava ~11 s por abertura): a leitura guardada devolve EXATAMENTE o que a leitura de antes
 * devolvia (mesmas páginas, mesma regra de parada, mesmo filtro de arquivo), e a memória guarda/junta/renova/invalida como o combinado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { lerPaginasCruas, MemoriaDeLeitura, semArquivo } = await import('./funil-leitura.js');
const { ehArquivo, arquivoComEtapa } = await import('./chatwoot-regua.js');

const AGORA = Math.floor(Date.now() / 1000);
const ANTIGO = Math.floor(Date.parse('2026-10-01T12:00:00Z') / 1000); // antes do corte do histórico (14/11)
const viva = (id: number, extra: Record<string, unknown> = {}) => ({ id, status: 'open', labels: [], last_activity_at: AGORA - 60, custom_attributes: {}, ...extra });
const arquivo = (id: number, etapa?: string) => ({ id, status: 'resolved', labels: ['historico'], last_activity_at: ANTIGO, custom_attributes: etapa ? { etapa } : {} });

/** Um Chatwoot de mentira: por caixa, a lista de páginas (cada uma com até 25). Conta os pedidos. */
function chatwootDeMentira(caixas: Record<number, any[][]>) {
  const pedidos: string[] = [];
  const buscar = async (caminho: string, query: Record<string, string> = {}) => {
    pedidos.push(`${caminho}?inbox=${query.inbox_id}&page=${query.page}`);
    const paginas = caixas[Number(query.inbox_id)] ?? [];
    return { data: { payload: paginas[Number(query.page) - 1] ?? [], meta: { all_count: 999 } } };
  };
  return { buscar, pedidos };
}
const cheia = (f: (i: number) => any, de: number) => Array.from({ length: 25 }, (_, i) => f(de + i));

/** A leitura de ANTES (a que estava em `lerCaixas`), copiada como oráculo: filtra o arquivo página a página, mede o fim pela crua. */
async function leituraDeAntes(buscar: (c: string, q: Record<string, string>) => Promise<any>, ids: number[], maxPaginas: number, lote: number, modo: 'fora' | 'com-etapa') {
  const paginas: unknown[] = [];
  let cortou = false;
  for (const id of ids) {
    for (let p = 1; p <= maxPaginas; p += lote) {
      const numeros = Array.from({ length: Math.min(lote, maxPaginas - p + 1) }, (_, i) => p + i);
      const lidas = await Promise.all(numeros.map((n) => buscar('conversations', { status: 'all', assignee_type: 'all', inbox_id: String(id), page: String(n) })));
      let acabou = false;
      for (const pg of lidas) {
        const crua: any[] = Array.isArray(pg?.data?.payload) ? pg.data.payload : [];
        if (crua.length < 25) acabou = true;
        if (crua.length > 0 && crua.every((c) => ehArquivo(c))) acabou = true;
        const fica = crua.filter((c) => !ehArquivo(c) || (modo === 'com-etapa' && arquivoComEtapa(c)));
        paginas.push(fica.length === crua.length ? pg : { ...pg, data: { ...pg.data, payload: fica } });
      }
      if (acabou) break;
      if (p + lote - 1 >= maxPaginas) cortou = true;
    }
  }
  return { paginas, cortou };
}

const CAIXAS = {
  // caixa 3 (como o oficial de Parauapebas): vivas e histórico misturados, depois uma página só de histórico (a leitura para)
  3: [
    [...cheia((i) => viva(i), 1).slice(0, 19), ...cheia((i) => arquivo(i, i % 2 ? 'Agendado' : undefined), 100).slice(0, 6)],
    [...cheia((i) => viva(i), 200).slice(0, 8), ...cheia((i) => arquivo(i), 300).slice(0, 17)],
    cheia((i) => arquivo(i, i === 410 ? 'Fechou' : undefined), 400),
    cheia((i) => viva(i), 500), // NUNCA lida: a página anterior já era só arquivo
  ],
  // Instagram: 1ª página inteira de arquivo (importação)
  7: [cheia((i) => arquivo(i), 700)],
  // caixa curta: uma página incompleta
  2: [[viva(900), viva(901)]],
  // caixa que passa do teto de páginas (todas vivas)
  5: Array.from({ length: 10 }, (_, k) => cheia((i) => viva(i), 1000 + k * 25)),
};

test('a leitura crua + o filtro do arquivo dá EXATAMENTE o que a leitura de antes dava (mesmas páginas, mesma parada, mesmo «cortou»), nos dois modos e com lote 1 e 4', async () => {
  for (const lote of [1, 4]) {
    for (const modo of ['fora', 'com-etapa'] as const) {
      for (const ids of [[2, 3, 5, 7], [3], [7], [5], [2, 7]]) {
        const novo = chatwootDeMentira(CAIXAS);
        const antigo = chatwootDeMentira(CAIXAS);
        const crua = await lerPaginasCruas(novo.buscar, ids, 8, lote);
        const antes = await leituraDeAntes(antigo.buscar, ids, 8, lote, modo);
        assert.deepEqual(crua.paginas.map((p) => semArquivo(p, modo)), antes.paginas, `lote ${lote} · ${modo} · caixas ${ids}`);
        assert.equal(crua.cortou, antes.cortou, `cortou: lote ${lote} · ${modo} · caixas ${ids}`);
        assert.deepEqual(novo.pedidos, antigo.pedidos, 'os MESMOS pedidos ao Chatwoot, na mesma ordem');
        assert.equal(crua.pedidos, antigo.pedidos.length);
      }
    }
  }
  // a regra de parada de hoje continua: a página de arquivo fecha a caixa 3 e a seguinte nunca é lida
  const c = chatwootDeMentira(CAIXAS);
  await lerPaginasCruas(c.buscar, [3, 7], 8, 1);
  assert.deepEqual(c.pedidos, ['conversations?inbox=3&page=1', 'conversations?inbox=3&page=2', 'conversations?inbox=3&page=3', 'conversations?inbox=7&page=1']);
  // o arquivo COM etapa ainda entra no quadro e o sem etapa não
  const quadro = (await lerPaginasCruas(chatwootDeMentira(CAIXAS).buscar, [3], 8)).paginas.map((p) => semArquivo(p, 'com-etapa'));
  const ids = quadro.flatMap((p: any) => p.data.payload.map((x: any) => x.id));
  assert.ok(ids.includes(410) && ids.includes(101), 'arquivo com etapa fica no quadro');
  assert.ok(!ids.includes(102), 'arquivo sem etapa sai');
});

// ── a memória ───────────────────────────────────────────────────────────────────────────────────

function memoria() {
  let agora = 1_000_000;
  const falhas: unknown[] = [];
  const m = new MemoriaDeLeitura<number>(20_000, 120_000, () => agora, (e) => falhas.push(e));
  let buscas = 0;
  const buscar = async () => ++buscas;
  return { m, buscar, falhas, passar: (ms: number) => { agora += ms; }, buscas: () => buscas };
}

test('memória: pedidos juntos viram UMA leitura; fresca serve direto; conta e conjunto de caixas diferentes não se misturam', async () => {
  const { m, buscar, buscas } = memoria();
  const r = await Promise.all([m.obter(1, 'a', buscar), m.obter(1, 'a', buscar), m.obter(1, 'a', buscar)]);
  assert.deepEqual(r.map((x) => x.valor), [1, 1, 1]);
  assert.deepEqual(r.map((x) => x.de).sort(), ['junto', 'junto', 'lido']);
  assert.deepEqual(await m.obter(1, 'a', buscar), { valor: 1, de: 'fresco' });
  assert.equal((await m.obter(1, 'b', buscar)).valor, 2, 'outro conjunto de caixas = outra leitura');
  assert.equal((await m.obter(2, 'a', buscar)).valor, 3, 'outra conta = outra leitura');
  assert.equal(buscas(), 3);
});

test('memória: passou o fresco, serve o velho NA HORA e renova UMA vez em segundo plano; passou o limite, espera a nova', async () => {
  const { m, passar, buscas } = memoria();
  let solta!: (n: number) => void;
  let n = 0;
  const buscar = () => (++n === 1 ? Promise.resolve(1) : new Promise<number>((r) => { solta = r; }));
  assert.equal((await m.obter(1, 'a', buscar)).valor, 1);
  passar(30_000);
  assert.deepEqual(await m.obter(1, 'a', buscar), { valor: 1, de: 'velho' }, 'não espera a leitura nova');
  assert.deepEqual(await m.obter(1, 'a', buscar), { valor: 1, de: 'velho' });
  assert.equal(n, 2, 'UMA renovação, não uma por pedido');
  solta(2);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await m.obter(1, 'a', buscar), { valor: 2, de: 'fresco' });
  passar(200_000);
  const p = m.obter(1, 'a', buscar);
  solta(3);
  assert.deepEqual(await p, { valor: 3, de: 'lido' }, 'velho demais: lê e espera');
  void buscas;
});

test('memória: renovação que falha mantém o velho (e avisa), erro de leitura não fica guardado', async () => {
  const { m, passar, falhas } = memoria();
  let n = 0;
  const buscar = () => (++n === 2 ? Promise.reject(new Error('Chatwoot caiu')) : Promise.resolve(n));
  assert.equal((await m.obter(1, 'a', buscar)).valor, 1);
  passar(30_000);
  assert.equal((await m.obter(1, 'a', buscar)).valor, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(falhas.length, 1);
  assert.equal((await m.obter(1, 'a', buscar)).valor, 1, 'segue o velho enquanto não vence');
  // erro na leitura de verdade: propaga e a próxima tenta de novo
  const { m: m2 } = memoria();
  await assert.rejects(m2.obter(1, 'x', () => Promise.reject(new Error('x'))));
  assert.equal((await m2.obter(1, 'x', () => Promise.resolve(7))).valor, 7);
});

test('memória: invalidar (escrita no Chatwoot) joga fora o guardado E a leitura que estava em andamento; só da conta que escreveu', async () => {
  const { m, buscar } = memoria();
  await m.obter(1, 'a', buscar);
  await m.obter(2, 'a', buscar);
  m.invalidar(1);
  assert.equal((await m.obter(1, 'a', buscar)).de, 'lido', 'a conta 1 relê');
  assert.equal((await m.obter(2, 'a', buscar)).de, 'fresco', 'a conta 2 não foi afetada');
  // leitura em andamento quando a escrita acontece: o que ela traz já nasceu velho e não fica guardado
  let solta!: (n: number) => void;
  const lenta = new Promise<number>((r) => { solta = r; });
  const p = m.obter(3, 'a', () => lenta);
  m.invalidar(3);
  solta(99);
  assert.equal((await p).valor, 99, 'quem pediu recebe');
  await new Promise((r) => setImmediate(r));
  assert.equal((await m.obter(3, 'a', async () => 100)).valor, 100, 'mas ninguém mais recebe o velho');
});

test('memória: renovação que falhou espera antes de tentar de novo (não vira uma leitura inteira por clique)', async () => {
  const { m, passar } = memoria();
  let n = 0;
  const buscar = () => (++n === 1 ? Promise.resolve(1) : Promise.reject(new Error('Chatwoot lento')));
  await m.obter(1, 'a', buscar);
  passar(30_000);
  await m.obter(1, 'a', buscar); // dispara a renovação que falha
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 2);
  for (let i = 0; i < 5; i++) { await m.obter(1, 'a', buscar); await new Promise((r) => setImmediate(r)); }
  assert.equal(n, 2, 'dentro da espera: nenhuma leitura nova, segue o velho');
  passar(16_000);
  await m.obter(1, 'a', buscar);
  assert.equal(n, 3, 'passada a espera, tenta de novo');
});

test('memória: entrada vencida não fica guardada para sempre', async () => {
  const { m, buscar, passar } = memoria();
  for (let c = 1; c <= 25; c++) await m.obter(c, 'a', buscar);
  passar(200_000);
  await m.obter(99, 'a', buscar);
  assert.ok((m as any).entradas.size < 5, 'as vencidas saíram');
});
