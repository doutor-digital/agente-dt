/**
 * Conexão de uma unidade com o Bling, pela linha de comando (dentro do container do agente).
 *
 *   BLING_CLIENT_ID=… BLING_CLIENT_SECRET=… node dist/scripts/bling.js app hm-tecnologia
 *   node dist/scripts/bling.js link   hm-tecnologia   → link que o administrador do Bling abre (vale 10 min)
 *   node dist/scripts/bling.js status hm-tecnologia   → situação da conexão (sem segredos)
 *   node dist/scripts/bling.js teste  hm-tecnologia   → lê o nome da empresa no Bling
 *
 * O Client ID e o Client Secret vêm do ambiente para não ficarem no histórico do terminal nem no código.
 */
import { prisma } from '../lib/prisma.js';
import { iniciarAutorizacao, salvarAppDoBling, statusDoBling } from '../lib/bling/conexao.js';
import { blingGet } from '../lib/bling/cliente.js';

const [acao, slug] = process.argv.slice(2);
if (!acao || !slug) {
  console.error('Uso: node dist/scripts/bling.js <app|link|status|teste> <slug>');
  process.exit(2);
}

try {
  if (acao === 'app') {
    await salvarAppDoBling(slug, process.env.BLING_CLIENT_ID ?? '', process.env.BLING_CLIENT_SECRET ?? '');
    console.log(`✅ aplicativo do Bling gravado em ${slug}. Agora: node dist/scripts/bling.js link ${slug}`);
  } else if (acao === 'link') {
    const { link, unidade } = await iniciarAutorizacao(slug);
    console.log(`Abra logado como administrador do Bling da ${unidade} (vale 10 min):\n${link}`);
  } else if (acao === 'status') {
    console.log(JSON.stringify(await statusDoBling(slug), null, 2));
  } else if (acao === 'teste') {
    const u = await prisma.unit.findUnique({ where: { slug }, select: { id: true } });
    if (!u) throw new Error(`unidade "${slug}" não existe`);
    const r = await blingGet<{ data?: { nome?: string; fantasia?: string } }>(u.id, '/empresas/me/dados-basicos');
    console.log(`✅ conectado: ${r?.data?.fantasia || r?.data?.nome || '(sem nome)'}`);
  } else {
    console.error(`ação desconhecida: ${acao}`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
