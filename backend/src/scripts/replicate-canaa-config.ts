import { prisma } from '../lib/prisma.js';

const DST_SLUG = process.env.DST_SLUG || 'doutor-hernia-canaa';
const SRC_REGRAS = 'doutor-hernia-serra';
const SRC_CONTEUDO = 'doutor-hernia-imperatriz';

const APLICAR = process.argv.includes('--apply');
const INCLUIR_PRECO = process.argv.includes('--incluir-preco');

const TEM_PRECO = /R\$\s*\d/;

function norm(texto: string): string {
  return (texto || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
}

async function kommoGet(subdominio: string, token: string, caminho: string): Promise<any> {
  const resp = await fetch(`https://${subdominio}.kommo.com/api/v4/${caminho}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Kommo ${subdominio} ${caminho} -> HTTP ${resp.status}`);
  return resp.json();
}

async function main() {
  const dst = await prisma.unit.findUnique({ where: { slug: DST_SLUG } });
  const srcRegras = await prisma.unit.findUnique({ where: { slug: SRC_REGRAS } });
  const srcConteudo = await prisma.unit.findUnique({ where: { slug: SRC_CONTEUDO } });
  if (!dst || !srcRegras || !srcConteudo) throw new Error('unidade origem ou destino não encontrada');
  if (!dst.kommoSubdomain || !dst.kommoAccessToken) throw new Error('destino sem credencial Kommo');

  console.log(`treino de ${DST_SLUG} — modo ${APLICAR ? 'APLICAR' : 'DRY-RUN'}`);
  const pulados: string[] = [];

  const camposDst = (
    await kommoGet(dst.kommoSubdomain, dst.kommoAccessToken, 'leads/custom_fields?limit=250&order[id]=asc')
  )._embedded.custom_fields as Array<{ id: number; name: string; type: string; enums?: Array<{ id: number; value: string }> }>;
  const campoPorNome = new Map(camposDst.map((f) => [norm(f.name), f]));

  const regras = await prisma.leadFieldRule.findMany({ where: { unitId: srcRegras.id } });
  const jaTem = new Set(
    (await prisma.leadFieldRule.findMany({ where: { unitId: dst.id }, select: { toolName: true } })).map((r) => r.toolName),
  );
  console.log(`\n[1/4] regras de captura — ${regras.length} na origem, ${jaTem.size} já no destino`);

  const novasRegras = [];
  for (const regra of regras) {
    if (jaTem.has(regra.toolName)) continue;
    const alvo = campoPorNome.get(norm(regra.kommoFieldName));
    if (!alvo) {
      pulados.push(`regra ${regra.toolName}: campo "${regra.kommoFieldName}" não existe em Canaã`);
      continue;
    }
    const enumsDst = (alvo.enums || []).map((e) => ({ id: e.id, value: e.value }));
    novasRegras.push({
      unitId: dst.id,
      kommoFieldId: alvo.id,
      kommoFieldName: alvo.name,
      kommoFieldType: alvo.type,
      kommoFieldEnums: enumsDst.length > 0 ? enumsDst : undefined,
      toolName: regra.toolName,
      instruction: regra.instruction,
      valueHint: regra.valueHint,
      examples: regra.examples,
      enabled: regra.enabled,
      updatesLeadTitle: regra.updatesLeadTitle,
    });
    console.log(`  + ${regra.toolName} -> ${alvo.name} (${alvo.id}${enumsDst.length ? `, ${enumsDst.length} opções` : ''})`);
  }
  if (APLICAR && novasRegras.length > 0) {
    for (const r of novasRegras) await prisma.leadFieldRule.create({ data: r as never });
  }

  const kb = await prisma.knowledgeBaseEntry.findMany({ where: { unitId: srcConteudo.id } });
  const kbTem = new Set(
    (await prisma.knowledgeBaseEntry.findMany({ where: { unitId: dst.id }, select: { question: true } })).map((e) => norm(e.question)),
  );
  const kbNovas = kb.filter((e) => {
    if (kbTem.has(norm(e.question))) return false;
    if (!INCLUIR_PRECO && TEM_PRECO.test(e.answer)) {
      pulados.push(`conhecimento "${e.question}": tem preço em reais`);
      return false;
    }
    return true;
  });
  console.log(`\n[2/4] conhecimento — ${kbNovas.length} de ${kb.length} (embedding vem junto, não recalcula)`);
  if (APLICAR && kbNovas.length > 0) {
    await prisma.knowledgeBaseEntry.createMany({
      data: kbNovas.map((e) => ({ unitId: dst.id, question: e.question, answer: e.answer, embedding: e.embedding })),
    });
  }

  const tpls = await prisma.messageTemplate.findMany({ where: { unitId: srcConteudo.id } });
  const tplTem = new Set(
    (await prisma.messageTemplate.findMany({ where: { unitId: dst.id }, select: { name: true } })).map((t) => norm(t.name)),
  );
  const tplNovos = tpls.filter((t) => {
    if (tplTem.has(norm(t.name))) return false;
    if (!INCLUIR_PRECO && TEM_PRECO.test(t.response)) {
      pulados.push(`template "${t.name}": tem preço em reais`);
      return false;
    }
    return true;
  });
  console.log(`\n[3/4] templates — ${tplNovos.length} de ${tpls.length}`);
  for (const t of tplNovos) console.log(`  + ${t.name}`);
  if (APLICAR && tplNovos.length > 0) {
    await prisma.messageTemplate.createMany({
      data: tplNovos.map((t) => ({ unitId: dst.id, name: t.name, triggerKeywords: t.triggerKeywords, response: t.response })),
    });
  }

  const nomeEtapaOrigem = new Map<number, string>();
  if (srcConteudo.kommoSubdomain && srcConteudo.kommoAccessToken) {
    const pls = (await kommoGet(srcConteudo.kommoSubdomain, srcConteudo.kommoAccessToken, 'leads/pipelines'))._embedded.pipelines;
    for (const p of pls) for (const s of p._embedded.statuses) nomeEtapaOrigem.set(s.id, s.name);
  }
  const plsDst = (await kommoGet(dst.kommoSubdomain, dst.kommoAccessToken, 'leads/pipelines'))._embedded.pipelines;
  const etapaDstPorNome = new Map<string, number>();
  for (const p of plsDst) for (const s of p._embedded.statuses) etapaDstPorNome.set(norm(s.name), s.id);
  const motivosDst = (await kommoGet(dst.kommoSubdomain, dst.kommoAccessToken, 'leads/loss_reasons?limit=250'))._embedded.loss_reasons;
  const motivoDstPorNome = new Map<string, number>(motivosDst.map((m: any) => [norm(m.name), m.id]));

  const fus = await prisma.followUpRule.findMany({ where: { unitId: srcConteudo.id } });
  console.log(`\n[4/4] follow-up — ${fus.length} na origem (todas chegam desligadas)`);
  for (const fu of fus) {
    let statusId: number | undefined = fu.statusId === 142 || fu.statusId === 143 ? fu.statusId : undefined;
    if (statusId === undefined) {
      const nome = nomeEtapaOrigem.get(fu.statusId);
      statusId = nome ? etapaDstPorNome.get(norm(nome)) : undefined;
      if (statusId === undefined) {
        pulados.push(`follow-up da etapa ${fu.statusId} (${nome ?? 'nome desconhecido'}): sem etapa equivalente em Canaã`);
        continue;
      }
    }
    let lossReasonId: number | null = null;
    if (fu.lossReasonName) {
      lossReasonId = motivoDstPorNome.get(norm(fu.lossReasonName)) ?? null;
      if (lossReasonId === null) {
        pulados.push(`follow-up "${fu.lossReasonName}": motivo de perda não existe em Canaã`);
        continue;
      }
    }
    const existe = await prisma.followUpRule.findFirst({ where: { unitId: dst.id, statusId, lossReasonId } });
    if (existe) continue;
    console.log(`  + etapa ${statusId}${fu.lossReasonName ? ` / ${fu.lossReasonName}` : ''} (${(fu.steps as unknown[]).length} passos)`);
    if (APLICAR) {
      await prisma.followUpRule.create({
        data: {
          unitId: dst.id, statusId, lossReasonId, lossReasonName: fu.lossReasonName,
          enabled: false, steps: fu.steps as never, notes: fu.notes,
        },
      });
    }
  }

  if (pulados.length > 0) {
    console.log('\nNÃO COPIADO (precisa de decisão humana):');
    for (const p of pulados) console.log(`  · ${p}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('❌ replicate-canaa-config falhou:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
