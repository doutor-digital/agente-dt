/**
 * Gera o código de 6 dígitos da página de pausa para cada unidade ativa que ainda não
 * tem, e imprime slug · código · link. Não troca código existente (use --renovar <slug>).
 *
 *   node dist/scripts/gerar-codigos-pausa.js [--host https://agente-vps.doutordigitalconsultoria.com] [--renovar slug]
 */
import { prisma } from '../lib/prisma.js';
import { gerarCodigoPausa } from '../lib/pausa-unidade.js';

const args = process.argv.slice(2);
const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : 'https://agente-vps.doutordigitalconsultoria.com';
const renovar = args.includes('--renovar') ? args[args.indexOf('--renovar') + 1] : null;

const units = await prisma.unit.findMany({
  where: { isActive: true, slug: { startsWith: 'doutor-hernia-' } },
  orderBy: { slug: 'asc' },
  select: { id: true, slug: true, name: true, pausaCodigo: true },
});
for (const u of units) {
  let codigo = u.pausaCodigo;
  if (!codigo || u.slug === renovar) {
    codigo = gerarCodigoPausa();
    await prisma.unit.update({ where: { id: u.id }, data: { pausaCodigo: codigo } });
  }
  console.log(`${u.name}\t${codigo}\t${host}/pausa/${u.slug}`);
}
await prisma.$disconnect();
