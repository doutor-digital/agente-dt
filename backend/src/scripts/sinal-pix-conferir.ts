/**
 * CONFERE, SÓ LENDO, se as unidades estão prontas para o sinal Pix da Sofia 2.0 — antes de ligar a flag.
 *
 * Para cada unidade (as 13 do Sofia 2.0, ou as de `--slugs=a,b`): o que as fontes dão (preço no dia e antecipado), se o sinal valeria
 * (`sinalDaUnidade` com R$ 50), de onde viria a chave do Asaas (a da própria unidade ou a da clínica dona, no caso do "Resgate") e se a
 * franquia está ligada. Não imprime chave nem texto de fonte; não escreve nada.
 *
 * Uso (no contêiner do agente): node dist/scripts/sinal-pix-conferir.js [--slugs=doutor-hernia-araguaina,araguaina-resgate]
 */
import { prisma } from '../lib/prisma.js';
import { precosDaConsulta, sinalDaUnidade } from '../agent/prompt-composer.js';
import { unidadeDona } from '../agent/rede-doutor-hernia.js';

const PADRAO = [
  'doutor-hernia-araguaina', 'doutor-hernia-acailandia', 'doutor-hernia-imperatriz', 'doutor-hernia-maraba', 'doutor-hernia-porto', 'doutor-hernia-balsas', 'doutor-hernia-canaa',
  'araguaina-resgate', 'acailandia-resgate', 'maraba-resgate', 'porto-resgate', 'balsas-resgate', 'canaa-resgate',
];

async function main() {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--slugs='));
  const slugs = arg ? arg.slice(8).split(',').map((s) => s.trim()).filter(Boolean) : PADRAO;
  const units = await prisma.unit.findMany({ where: { slug: { in: slugs } } });
  const chaves = await prisma.chaveDeIntegracao.findMany({ where: { provedor: 'asaas' }, select: { unitId: true, finalDaChave: true, ultimoErro: true } });
  const porUnit = new Map(chaves.map((c) => [c.unitId, c]));
  const porSlug = new Map(units.map((u) => [u.slug, u]));
  const donas = await prisma.unit.findMany({ where: { slug: { in: slugs.map(unidadeDona) } }, select: { id: true, slug: true } });
  const donaPorSlug = new Map(donas.map((d) => [d.slug, d.id]));

  const linhas = slugs.map((slug) => {
    const u = porSlug.get(slug);
    if (!u) return { slug, achou: false };
    const p = precosDaConsulta(u);
    const propria = porUnit.get(u.id);
    const dona = unidadeDona(u.slug);
    const daDona = dona !== u.slug ? porUnit.get(donaPorSlug.get(dona) ?? '') : undefined;
    const sinal = sinalDaUnidade({ ...u, sinalPixCentavos: 5000 });
    return {
      slug,
      ativa: u.isActive,
      flagAtual: u.sinalPixCentavos,
      franquiaLigada: u.spineEnabled,
      taxaDeReserva: u.spineBookingRequiresPayment,
      aceitaAntecipado: u.acceptsAdvancePayment,
      precosLidos: p ? `no dia ${p.noDia} / antecipado ${p.antecipado}` : 'NÃO LEU (sem sinal: a Sofia não ganha a ferramenta)',
      sinalValeria: sinal ? `R$ ${sinal.sinal} agora + R$ ${sinal.restoNoDia} no dia (R$ ${sinal.comSinal} com sinal; R$ ${sinal.noDia} sem)` : 'não',
      chaveAsaas: propria ? `própria ${propria.finalDaChave}${propria.ultimoErro ? ` (erro: ${propria.ultimoErro})` : ''}` : daDona ? `da clínica dona ${dona} ${daDona.finalDaChave}` : 'NENHUMA (a equipe manda o Pix)',
    };
  });
  console.table(linhas);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
