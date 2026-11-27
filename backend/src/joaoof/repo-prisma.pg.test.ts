/**
 * O repositório de produção contra um Postgres de verdade. Só roda com `JOAOOF_TESTE_PG=1` e um DATABASE_URL de teste que já tenha as
 * migrations (nunca aponte para produção: o teste apaga as linhas `joaoof_*`). Sem a chave, é pulado — a suíte padrão não tem banco.
 *   docker run -d --name pg-j -e POSTGRES_PASSWORD=t -e POSTGRES_USER=t -e POSTGRES_DB=t -p 127.0.0.1:55432:5432 postgres:18
 *   DATABASE_URL=postgresql://t:t@127.0.0.1:55432/t pnpm exec prisma migrate deploy
 *   JOAOOF_TESTE_PG=1 DATABASE_URL=… pnpm exec tsx --test src/joaoof/repo-prisma.pg.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const ligado = process.env.JOAOOF_TESTE_PG === '1' && /127\.0\.0\.1|localhost/.test(process.env.DATABASE_URL ?? '');

test('repo-prisma contra Postgres real', { skip: !ligado && 'defina JOAOOF_TESTE_PG=1 e um DATABASE_URL local' }, async (t) => {
  const { prisma } = await import('../lib/prisma.js');
  const { repoPrisma } = await import('./repo-prisma.js');
  await prisma.$executeRawUnsafe('TRUNCATE joaoof_demandas, joaoof_memorias, joaoof_avisos, joaoof_conversa, joaoof_estado RESTART IDENTITY');

  await t.test('demanda: cria com número sequencial, trecho mascarado; repetição só soma com mensagem nova', async () => {
    const d = await repoPrisma.criarDemanda({ titulo: 'Sofia parou em Parauapebas', categoria: 'problema_ia', prioridade: 'urgente', unidadeSlug: 'doutor-hernia-parauapebas', trecho: 'ligue 94 99533-4370 já', fonteRefs: ['m1'], prazo: '2026-11-30' });
    assert.equal(d.numero, 1);
    assert.equal(d.prazo, '2026-11-30');
    assert.doesNotMatch(d.trecho, /99533/);
    await repoPrisma.atualizarDemanda(1, { repeticao: { fonteRefs: ['m2'] } });
    await repoPrisma.atualizarDemanda(1, { repeticao: { fonteRefs: ['m2'] } });
    await repoPrisma.atualizarDemanda(1, { repeticao: { fonteRefs: [] } }); // sem mensagem não soma
    const r = (await repoPrisma.buscarDemanda(1))!;
    assert.equal(r.repeticoes, 2);
    assert.deepEqual(r.fonteRefs, ['m1', 'm2']);
    const feita = (await repoPrisma.atualizarDemanda(1, { status: 'feita' }))!;
    assert.ok(feita.resolvidaEm);
    assert.equal((await repoPrisma.atualizarDemanda(1, { status: 'aberta' }))!.resolvidaEm, null);
    assert.equal(await repoPrisma.atualizarDemanda(99, { status: 'feita' }), null);
  });

  await t.test('listar: ordem por prioridade e filtros', async () => {
    await repoPrisma.criarDemanda({ titulo: 'Relatório semanal atrasado', prioridade: 'baixa' });
    const l = await repoPrisma.listarDemandas({ status: ['aberta'] });
    assert.deepEqual(l.map((d) => d.numero), [1, 2]);
    assert.equal((await repoPrisma.listarDemandas({ texto: 'relatório' })).length, 1);
    assert.equal((await repoPrisma.listarDemandas({ texto: 'relatorio' })).length, 1); // sem acento acha com acento
    assert.equal((await repoPrisma.listarDemandas({ unidadeSlug: 'doutor-hernia-parauapebas' })).length, 1);
  });

  await t.test('memória: busca textual em português sem extensão, atualiza a mesma chave e esquece', async () => {
    await repoPrisma.guardarMemoria({ tipo: 'preferencia', assunto: 'Relatório de tráfego', texto: 'Quem faz os relatórios de tráfego pago é a Suzanne.' });
    await repoPrisma.guardarMemoria({ tipo: 'preferencia', assunto: 'relatório de tráfego', texto: 'Quem faz os relatórios de tráfego pago agora é a Lia.' });
    const achou = await repoPrisma.buscarMemoria('quem faz relatório');
    assert.equal(achou.length, 1);
    assert.match(achou[0]!.texto, /Lia/);
    assert.equal((await repoPrisma.buscarMemoria('relatorios')).length, 1); // sem acento cai no ILIKE
    assert.equal((await repoPrisma.buscarMemoria('cardápio do almoço')).length, 0);
    assert.equal(await repoPrisma.esquecerMemoria(achou[0]!.id), true);
    assert.equal((await repoPrisma.buscarMemoria('relatório')).length, 0);
  });

  await t.test('limite no banco: com mais demandas que o limite, as URGENTES novas não somem; texto livre sai mascarado', async () => {
    for (let i = 0; i < 12; i++) await repoPrisma.criarDemanda({ titulo: `Pedido de rotina numero ${i} sem pressa nenhuma`, prioridade: 'baixa' });
    const u = await repoPrisma.criarDemanda({ titulo: 'Risco a paciente: ligar 94 99217-1305 CPF 123.456.789-09', prioridade: 'urgente', solicitante: 'Zé 94992171305' });
    assert.doesNotMatch(u.titulo + u.solicitante, /\d{8}/);
    const top = await repoPrisma.listarDemandas({ status: ['aberta'], limite: 5 });
    // as duas urgentes (a antiga #1 e a nova) vêm primeiro mesmo com limite 5 e 15 abertas: o corte não leva a mais nova embora
    assert.deepEqual(top.slice(0, 2).map((d) => d.numero), [1, u.numero]);
    assert.equal(top.length, 5);
    await repoPrisma.atualizarDemanda(u.numero, { status: 'feita' });
    const hoje = new Date(Date.now() - 3600_000);
    assert.equal((await repoPrisma.listarDemandas({ status: ['feita'], resolvidaDesde: hoje })).length, 1);
    assert.equal((await repoPrisma.listarDemandas({ status: ['feita'], resolvidaDesde: new Date(Date.now() + 3600_000) })).length, 0);
  });

  await t.test('campos que o João mexeu ficam registrados (travam a triagem); a conversa é gravada mascarada', async () => {
    const d = await repoPrisma.criarDemanda({ titulo: 'Pedido de arte para o Natal', prioridade: 'normal' });
    await repoPrisma.atualizarDemanda(d.numero, { prioridade: 'alta' }, true);
    await repoPrisma.atualizarDemanda(d.numero, { prazo: '2026-12-10' }, true);
    await repoPrisma.atualizarDemanda(d.numero, { notaJoao: 'ok' }); // a triagem: não trava nada
    assert.deepEqual((await repoPrisma.buscarDemanda(d.numero))!.camposDoJoao.sort(), ['prazo', 'prioridade']);
    await repoPrisma.anexarConversa('joao', 'liga pro paciente 94 99217-1305');
    const u = await repoPrisma.ultimasDaConversa(1);
    assert.doesNotMatch(u[0]!.texto, /\d{8}/);
  });

  await t.test('referências antigas NÃO são esquecidas: a mesma mensagem velha não conta de novo (limite de 500)', async () => {
    const d = await repoPrisma.criarDemanda({ titulo: 'Queixa antiga repetida muitas vezes', prioridade: 'normal' });
    for (let i = 0; i < 70; i++) await repoPrisma.atualizarDemanda(d.numero, { repeticao: { fonteRefs: [`r${i}`] } });
    const antes = (await repoPrisma.buscarDemanda(d.numero))!;
    assert.equal(antes.repeticoes, 71);
    await repoPrisma.atualizarDemanda(d.numero, { repeticao: { fonteRefs: ['r0'] } }); // a primeira de todas, lida de novo
    assert.equal((await repoPrisma.buscarDemanda(d.numero))!.repeticoes, 71);
  });

  await t.test('vigia da rede: chamadas joaoof.* NÃO contam (nem boas, nem com erro); as da rede (chat.completions) contam', async () => {
    const { criarLeituraDoBanco } = await import('../lib/vigia-rede-banco.js');
    await prisma.$executeRawUnsafe('TRUNCATE llm_calls');
    const ins = (endpoint: string | null, status: string, model: string, min: number) =>
      prisma.$executeRawUnsafe(`INSERT INTO llm_calls (id, provider, model, endpoint, status, created_at) VALUES ($1, 'x', $2, $3, $4, (now() at time zone 'UTC') - ($5 || ' minutes')::interval)`, `t${Math.random()}`, model, endpoint, status, String(min));
    await ins('joaoof.triagem', 'success', 'claude-haiku-4-5', 1);
    await ins('joaoof.resposta', 'error', 'claude-sonnet-5', 2);
    await ins('chat.completions', 'success', 'claude-opus-4-8', 3); // a IA da rede (a coluna é NOT NULL, mas o filtro tem coalesce por segurança)
    await ins('chat.completions', 'error', 'gpt-4o-mini', 4);
    const leitura = criarLeituraDoBanco();
    const agora = new Date();
    const tot = await leitura.totaisPorFamilia(agora, 60);
    assert.deepEqual(tot.anthropic, { ok: 1, erro: 0 }); // só a da rede
    assert.deepEqual(tot.openai, { ok: 0, erro: 1 });
    assert.equal((await leitura.errosAgrupados(agora, 60)).filter((e) => e.familia === 'anthropic').length, 0);
    const ult = await leitura.ultimoSucesso(agora);
    assert.ok(ult.anthropic); // a da rede
    await prisma.$executeRawUnsafe(`DELETE FROM llm_calls WHERE endpoint = 'chat.completions' AND model LIKE 'claude%'`);
    assert.equal((await leitura.ultimoSucesso(agora)).anthropic, null); // sobrou só a do Joaoof: «IA parada» não é escondida por ela
  });

  await t.test('FUSO: o aviso grava reservado_em/criado_em em UTC (não hora local), a reserva velha se mede em UTC e «resolvidas hoje» não desloca 3 h', async () => {
    await repoPrisma.registrarAviso({ tipo: 'resumo', chave: 'fuso1', texto: 'x', enviado: false, seco: false });
    const [l] = await prisma.$queryRawUnsafe<Array<{ dif: number }>>(`SELECT abs(extract(epoch from ((now() at time zone 'utc') - reservado_em)))::float AS dif FROM joaoof_avisos WHERE chave = 'fuso1'`);
    assert.ok(l!.dif < 60, `reservado_em deveria estar em UTC (dif ${l!.dif}s)`);
    assert.equal(await repoPrisma.reivindicarReenvio('resumo', 'fuso1', 120), false); // acabou de reservar
    await prisma.$executeRawUnsafe(`UPDATE joaoof_avisos SET reservado_em = (now() at time zone 'utc') - interval '3 minutes' WHERE chave = 'fuso1'`);
    assert.equal(await repoPrisma.reivindicarReenvio('resumo', 'fuso1', 120), true);
    // resolvidaDesde: uma demanda resolvida AGORA tem de entrar em «desde 1 h atrás» e NÃO entrar em «desde daqui a 1 h»
    const d = await repoPrisma.criarDemanda({ titulo: 'Demanda resolvida agora mesmo para o teste de fuso', prioridade: 'normal' });
    await repoPrisma.atualizarDemanda(d.numero, { status: 'feita' });
    assert.equal((await repoPrisma.listarDemandas({ status: ['feita'], resolvidaDesde: new Date(Date.now() - 3600_000) })).some((x) => x.numero === d.numero), true);
    assert.equal((await repoPrisma.listarDemandas({ status: ['feita'], resolvidaDesde: new Date(Date.now() + 3600_000) })).some((x) => x.numero === d.numero), false);
    assert.equal((await repoPrisma.listarDemandas({ status: ['feita'], resolvidaDesde: new Date(Date.now() + 2 * 3600_000 + 3 * 3600_000) })).length, 0); // com o bug antigo (±3 h) isto vazava
  });

  await t.test('memória: «Relatório» e «relatorio» são a MESMA (sem acento dos dois lados), sem extensão; texto do aviso mascarado', async () => {
    await repoPrisma.guardarMemoria({ tipo: 'decisao', assunto: 'Relatório de tráfego do Natal', texto: 'primeira versão da regra' });
    await repoPrisma.guardarMemoria({ tipo: 'decisao', assunto: 'RELATORIO DE TRAFEGO DO NATAL', texto: 'segunda versão da regra' });
    const achadas = await repoPrisma.buscarMemoria('segunda versão');
    assert.equal(achadas.length, 1);
    assert.equal(await prisma.joaoofMemoria.count({ where: { tipo: 'decisao', ativa: true } }), 1);
    await repoPrisma.registrarAviso({ tipo: 'resposta', chave: 'mask1', texto: 'liguei 94 99217-1305', enviado: true, seco: true });
    assert.doesNotMatch((await prisma.joaoofAviso.findUnique({ where: { tipo_chave: { tipo: 'resposta', chave: 'mask1' } } }))!.texto, /\d{8}/);
  });

  await t.test('aviso: reenvio só para UMA instância (UPDATE condicional) e só depois da reserva envelhecer', async () => {
    await repoPrisma.registrarAviso({ tipo: 'resumo', chave: 'r1', texto: 'x', enviado: false, seco: false });
    assert.equal(await repoPrisma.reivindicarReenvio('resumo', 'r1', 120), false); // reserva recente: outra instância pode estar enviando
    await prisma.$executeRawUnsafe(`UPDATE joaoof_avisos SET reservado_em = now() - interval '5 minutes' WHERE chave = 'r1'`);
    const [a, b] = await Promise.all([repoPrisma.reivindicarReenvio('resumo', 'r1', 120), repoPrisma.reivindicarReenvio('resumo', 'r1', 120)]);
    assert.deepEqual([a, b].sort(), [false, true]); // só uma ganha
    await repoPrisma.marcarAvisoEnviado('resumo', 'r1', true);
    assert.equal(await repoPrisma.reivindicarReenvio('resumo', 'r1', 0), false);
  });

  await t.test('aviso: o par (tipo, chave) é único — o segundo registro perde', async () => {
    assert.equal(await repoPrisma.registrarAviso({ tipo: 'urgente', chave: 'd:1', texto: 'a', enviado: false, seco: false }), true);
    assert.equal(await repoPrisma.registrarAviso({ tipo: 'urgente', chave: 'd:1', texto: 'a', enviado: false, seco: false }), false);
    assert.deepEqual(await repoPrisma.buscarAviso('urgente', 'd:1'), { enviado: false, seco: false });
    await repoPrisma.marcarAvisoEnviado('urgente', 'd:1', true);
    assert.equal((await repoPrisma.buscarAviso('urgente', 'd:1'))!.enviado, true);
    assert.equal(await repoPrisma.buscarAviso('urgente', 'nao-existe'), null);
  });

  await t.test('conversa guarda só as últimas 40; estado é chave → JSON; unidades vêm do seed', async () => {
    for (let i = 0; i < 45; i++) await repoPrisma.anexarConversa(i % 2 ? 'joao' : 'joaoof', `fala ${i}`);
    const u = await repoPrisma.ultimasDaConversa(100);
    assert.equal(u.length, 40);
    assert.equal(u[u.length - 1]!.texto, 'fala 44');
    await repoPrisma.gravarEstado('k', { n: 2 });
    await repoPrisma.gravarEstado('k', { n: 3 });
    assert.deepEqual(await repoPrisma.lerEstado('k'), { n: 3 });
    assert.equal(await repoPrisma.lerEstado('nada'), null);
    assert.equal((await repoPrisma.unidades()).length, 3);
  });
});

after(async () => {
  if (ligado) await (await import('../lib/prisma.js')).prisma.$disconnect();
});
before(() => {});
