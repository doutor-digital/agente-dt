/**
 * Etapas de uma conta do CRM com os nomes da Kommo (Timbó, conta 3). Roda DENTRO do contêiner do agente, na VPS, chamado por `ops/etapas-conta/rodar-na-vps.sh`
 * (que faz o psql no banco do Chatwoot). Aqui só: o mapa em `unit_chatwoot.etapas` e a DECISÃO (o SQL sai em linhas `SQL `, o registro para desfazer em linhas `REG `).
 * Dado de paciente não entra: a entrada do plano tem só id, etapa, etiquetas e a 1ª linha da nota («Na Kommo: funil › etapa»). Nada é impresso além de contagens.
 *
 *   node dist/scripts/etapas-conta.js mapa-ler        [--unidade=slug]
 *   node dist/scripts/etapas-conta.js mapa-gravar     [--unidade=slug] [--gravar]      (sem --gravar só mostra)
 *   node dist/scripts/etapas-conta.js mapa-restaurar  [--unidade=slug] --gravar         (lê a linha REG unit_etapas no stdin)
 *   node dist/scripts/etapas-conta.js plano           [--unidade=slug] [--conta=3]     (lê o JSON do extrato no stdin; imprime LOG, SQL e REG)
 *   node dist/scripts/etapas-conta.js desfazer                                         (lê as linhas REG no stdin; imprime SQL)
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { mapaDaColuna, problemasDoMapa } from '../lib/chatwoot-etapas.js';
import { ETAPAS_DE_TIMBO_NA_COLUNA } from '../lib/chatwoot-etapas-timbo.js';
import { listasDosAtributos, planoDasConversas, planoDasPastas, sqlDaMigracao, sqlDoDesfazer, type ConversaParaMigrar, type PastaParaMigrar } from '../lib/etapas-migracao.js';

const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const tem = (n: string): boolean => process.argv.includes(`--${n}`);
const log = (t: string) => console.log(`LOG ${t}`);
class ErroDeUso extends Error {}

/** Por unidade: o mapa que a Kommo dela tem. Só Timbó tem hoje (outra clínica entra aqui, com o mapa lido da Kommo dela). */
const MAPAS_POR_UNIDADE: Record<string, unknown> = { 'doutor-hernia-timbo': ETAPAS_DE_TIMBO_NA_COLUNA };

async function lerStdin(): Promise<string> {
  const partes: Buffer[] = [];
  for await (const c of process.stdin) partes.push(c as Buffer);
  return Buffer.concat(partes).toString('utf8');
}

async function unidade(slug: string) {
  const u = await prisma.unit.findUnique({ where: { slug }, select: { id: true } });
  if (!u) throw new ErroDeUso('unidade desconhecida');
  const cfg = await prisma.unitChatwoot.findUnique({ where: { unitId: u.id } });
  if (!cfg?.contaId || cfg.contaId <= 1) throw new ErroDeUso('a unidade não tem conta própria do Chatwoot (conta 1 = Parauapebas: nunca tem mapa)');
  return { id: u.id, conta: cfg.contaId, etapas: cfg.etapas };
}

async function main(): Promise<void> {
  const modo = process.argv[2] ?? '';
  const slug = arg('unidade') ?? 'doutor-hernia-timbo';
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) throw new ErroDeUso('unidade inválida');

  if (modo === 'desfazer') {
    const linhas = (await lerStdin()).split('\n').filter((l) => l.startsWith('REG ')).map((l) => l.slice(4));
    for (const l of sqlDoDesfazer(linhas.filter((x) => !x.includes('"tipo":"unit_etapas"'))).split('\n').filter(Boolean)) console.log(`SQL ${l}`);
    log(`DESFAZER linhas_do_registro=${linhas.length}`);
    return;
  }

  const u = await unidade(slug);
  const bruto = MAPAS_POR_UNIDADE[slug];
  if (!bruto) throw new ErroDeUso('esta unidade não tem mapa de etapas cadastrado no código');
  const problemas = problemasDoMapa(bruto);
  if (problemas.length) throw new ErroDeUso(`o mapa do código é inválido: ${problemas.join('; ')}`);
  const mapa = mapaDaColuna(bruto)!;

  if (modo === 'mapa-ler') {
    log(`MAPA unidade=${slug} conta=${u.conta} gravado=${u.etapas ? 'sim' : 'não'} igual_ao_do_codigo=${JSON.stringify(u.etapas) === JSON.stringify(bruto) ? 'sim' : 'não'}`);
    return;
  }
  if (modo === 'mapa-gravar') {
    log(`MAPA ${tem('gravar') ? 'GRAVANDO' : 'em seco: gravaria'} o mapa de ${slug} (conta ${u.conta})`);
    console.log(`REG ${JSON.stringify({ tipo: 'unit_etapas', unidade: slug, antes: u.etapas ?? null })}`);
    if (tem('gravar')) await prisma.unitChatwoot.update({ where: { unitId: u.id }, data: { etapas: bruto as Prisma.InputJsonValue } });
    return;
  }
  if (modo === 'mapa-restaurar') {
    const reg = (await lerStdin()).split('\n').find((l) => l.startsWith('REG ') && l.includes('"tipo":"unit_etapas"'));
    if (!reg) throw new ErroDeUso('o registro não tem a linha unit_etapas');
    const r = JSON.parse(reg.slice(4)) as { unidade: string; antes: unknown };
    if (r.unidade !== slug) throw new ErroDeUso('o registro é de outra unidade');
    log(`MAPA ${tem('gravar') ? 'RESTAURANDO' : 'em seco: restauraria'} o valor de antes (${r.antes === null ? 'nulo = molde' : 'um mapa'})`);
    if (tem('gravar')) await prisma.unitChatwoot.update({ where: { unitId: u.id }, data: { etapas: r.antes === null ? Prisma.DbNull : (r.antes as Prisma.InputJsonValue) } });
    return;
  }
  if (modo === 'plano') {
    const conta = Number(arg('conta') ?? u.conta);
    if (conta !== u.conta) throw new ErroDeUso('a conta pedida não é a da unidade');
    const entrada = JSON.parse(await lerStdin()) as { tagEsperandoHumano?: boolean; listasAntes: { etapa: string[] | null; etapa_tratamento: string[] | null }; conversas: ConversaParaMigrar[]; pastas: PastaParaMigrar[] };
    const conv = planoDasConversas(entrada.conversas, mapa);
    // a etiqueta que a migração PÕE tem de existir (a Tag é global; sem ela o INSERT seria um no-op silencioso e o resumo mentiria)
    if (conv.trocas.some((t) => t.poeEtiqueta) && entrada.tagEsperandoHumano !== true) throw new ErroDeUso('a etiqueta esperando-humano não existe (tabela tags): crie-a na conta antes (kit) — nada foi gravado');
    const pastas = planoDasPastas(entrada.pastas, mapa);
    log(`PLANO conversas_lidas=${entrada.conversas.length} conversas_a_trocar=${conv.trocas.length} pastas_lidas=${entrada.pastas.length} pastas_a_trocar=${pastas.length}`);
    for (const [k, n] of Object.entries(conv.contagem).sort()) log(`TROCA ${k} = ${n}`);
    for (const [k, n] of Object.entries(conv.intactas).sort()) log(`INTACTA ${k} = ${n} (a etapa delas NÃO está na lista nova do atributo: o seletor do Chatwoot não as oferece; decida antes de gravar)`);
    for (const p of pastas) log(`PASTA ${p.id} ${p.nome}`);
    log(`LISTAS etapa=${listasDosAtributos(mapa).etapa.length} valores, etapa_tratamento=${listasDosAtributos(mapa).etapa_tratamento.length} valores (antes: ${entrada.listasAntes.etapa?.length ?? 'não existe'} / ${entrada.listasAntes.etapa_tratamento?.length ?? 'não existe'})`);
    const { sql, registro } = sqlDaMigracao({ conta, listasAntes: entrada.listasAntes, listas: listasDosAtributos(mapa), trocas: conv.trocas, pastas });
    for (const l of sql.split('\n').filter(Boolean)) console.log(`SQL ${l}`);
    for (const r of registro) console.log(`REG ${r}`);
    return;
  }
  throw new ErroDeUso('modo desconhecido (mapa-ler | mapa-gravar | mapa-restaurar | plano | desfazer)');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    log('FIM');
  })
  .catch(async (e) => {
    log(`ERRO FATAL (${e instanceof ErroDeUso ? e.message : e instanceof Error ? e.name : 'erro'})`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
