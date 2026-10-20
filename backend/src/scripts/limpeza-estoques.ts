/**
 * Limpeza ÚNICA dos estoques parados (auditoria da Açailândia, 16/10/2026, item 11b).
 *
 * As regras são as do worker (`parados-estoques.ts` + `avaliarDoEstoque`): este script só as passa no estoque
 * inteiro de uma vez, sem o teto de 10 por varredura, e mostra o que faria — por etapa, com contagem e até 5
 * exemplos (só o id do cartão, nunca nome ou telefone).
 *
 * POR PADRÃO SÓ CONFERE. Nada é escrito no Kommo, na franquia ou no banco: além de não chamar nada que grave, o
 * cliente do Prisma nasce com toda escrita barrada (create/update/upsert/delete), então nem o log de aviso grava.
 *
 * GRAVAR exige o ok do João (é a limpeza que a auditoria deixou pra decisão dele) e dois sinais de propósito:
 * `--gravar` e `--confirmo=<o mesmo slug>`. Grava pela mesma porta do worker (relê a etapa antes de mexer, põe
 * NO_FOLLOW_UP antes do status, motivo no cartão, nota), com pausa entre cartões. Não olha a chave da tela: é
 * uma ação manual. Rode primeiro sem `--gravar` e leia a saída.
 *
 *   node dist/scripts/limpeza-estoques.js --unidade=doutor-hernia-acailandia
 *   node dist/scripts/limpeza-estoques.js --unidade=doutor-hernia-acailandia --regras=falta,agendado,retorno --max=200
 *   node dist/scripts/limpeza-estoques.js --unidade=doutor-hernia-acailandia --regras=falta --gravar --confirmo=doutor-hernia-acailandia
 *
 * `--regras` = falta, agendado, retorno, tratamento, dormente (padrão: todas). `--max` = quantos cartões cada regra
 * avalia A FUNDO (eventos do Kommo + franquia) — padrão 60, pra a conferência não pesar na API da franquia; os
 * candidatos pelo cartão são contados todos e a saída diz quantos ficaram sem avaliar.
 */
const argv = process.argv.slice(2);
const arg = (nome: string) => (argv.find((a) => a.startsWith(`--${nome}=`)) ?? '').split('=').slice(1).join('=');
const GRAVAR = argv.includes('--gravar');

/** Operações do Prisma que escrevem: no modo conferir, qualquer uma delas falha antes de chegar ao banco. */
const ESCRITAS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

/**
 * Só leitura no banco: o cliente do Prisma que TODO o código usa (`lib/prisma.ts` pega o de `globalThis.__prisma__`
 * se já houver um) nasce aqui, com as escritas barradas. Tem de vir antes de qualquer import que abra o Prisma.
 */
async function prismaSoLeitura(): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const base = new PrismaClient({ log: ['error'] });
  globalThis.__prisma__ = base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (ESCRITAS.has(operation)) throw new Error(`só conferir: ${model}.${operation} barrado`);
          return query(args);
        },
      },
    },
  }) as unknown as typeof base;
}

type Regra = 'falta' | 'agendado' | 'retorno' | 'tratamento' | 'dormente';
const TODAS: Regra[] = ['falta', 'agendado', 'retorno', 'tratamento', 'dormente'];

interface Grupo {
  n: number;
  exemplos: string[];
}

function somar(mapa: Map<string, Grupo>, chave: string, exemplo: string) {
  const g = mapa.get(chave) ?? { n: 0, exemplos: [] };
  g.n++;
  if (g.exemplos.length < 5) g.exemplos.push(exemplo);
  mapa.set(chave, g);
}

async function main() {
  if (!GRAVAR) await prismaSoLeitura();
  const { prisma } = await import('../lib/prisma.js');
  const { createKommoClient } = await import('../services/kommo.service.js');
  const { contaDoKommo, grupoDaUnidade, pularCartao } = await import('../lib/crm-compartilhado.js');
  const { carregarFunis } = await import('../lib/franquia-sync-worker.js');
  const { recarregarAutomacoes } = await import('../lib/automacoes-estado.js');
  const w = await import('../lib/parados-worker.js');

  const slug = arg('unidade');
  if (!slug) throw new Error('falta --unidade=<slug>');
  if (GRAVAR && arg('confirmo') !== slug) throw new Error('para gravar: --gravar --confirmo=<o mesmo slug> (e só com o ok do João)');
  const regras = (arg('regras') ? arg('regras').split(',').map((r) => r.trim()) : TODAS) as Regra[];
  for (const r of regras) if (!TODAS.includes(r)) throw new Error(`regra desconhecida: ${r}`);
  const max = Number(arg('max')) || 60;

  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit) throw new Error(`unidade ${slug} não existe`);
  await recarregarAutomacoes();
  const conta = await contaDoKommo(unit);
  if (!conta.kommoAccessToken) throw new Error(`${slug} sem token do Kommo`);
  const kommo = createKommoClient(conta);
  const grupo = await grupoDaUnidade(unit.id);
  const unidadesDaConta = await prisma.unit.findMany({ where: { kommoSubdomain: conta.kommoSubdomain } });
  const funis = await carregarFunis(kommo);
  if (!funis) throw new Error('não achei o funil COMERCIAL');
  const agora = Math.floor(Date.now() / 1000);
  const ctx = { unit, kommo, unidadesDaConta, agora };
  // a mesma trava do worker: cartão em CONFLITO_FRANQUIA espera a SDR escolher o paciente
  const trava = await w.travaDoConflito(ctx);

  console.log(`\n${GRAVAR ? 'GRAVANDO' : 'SÓ CONFERINDO (nada é escrito)'} · ${slug} · ${new Date().toISOString()} · até ${max} avaliações a fundo por regra\n`);
  const totais = new Map<string, number>();

  for (const regra of regras) {
    const etapas = w.etapasDoEstoque(funis).filter((e) => e.regra === regra);
    if (etapas.length === 0) {
      console.log(`## ${regra}: a conta não tem a etapa — pulei\n`);
      continue;
    }
    const resultado = new Map<string, Grupo>();
    let naEtapa = 0;
    let candidatos = 0;
    let avaliados = 0;
    let gravados = 0;
    const foraDoCorte = { deOutraUnidade: 0, semUnidade: 0 };
    for (const e of etapas) {
      for (let page = 1; page <= 40; page++) {
        const leads = await kommo.listLeadsPorEtapa(e.pipelineId, e.statusId, 250, page, true);
        for (const lead of leads) {
          naEtapa++;
          if (pularCartao(grupo, unit.id, lead, foraDoCorte)) continue;
          if (!w.candidatoDoEstoque(regra, lead, e.nome, agora, unit.spineTimezone)) {
            somar(resultado, 'fica · o cartão não é candidato (data, situação, retomada ou idade)', String(lead.id));
            continue;
          }
          if (trava.travado(lead)) {
            somar(resultado, 'fica · travado por CONFLITO_FRANQUIA (a SDR escolhe o paciente)', String(lead.id));
            continue;
          }
          candidatos++;
          if (avaliados >= max) {
            somar(resultado, `sem avaliar · passou do --max=${max}`, String(lead.id));
            continue;
          }
          avaliados++;
          try {
            const a = await w.avaliarDoEstoque(ctx, regra, lead, e.nome);
            const d = a.decisao;
            const destino = d
              ? `→ ${d.para}${d.motivoPerda ? ` · ${d.motivoPerda}` : ''}${d.para === 'PERDIDO' ? (d.semRegua ? ' · sem régua (NO_FOLLOW_UP)' : ' · com a régua de PERDIDO') : ''}`
              : a.filaDeAlta
                ? `→ fila da página /alta (${a.filaDeAlta === 'ALTA' ? 'candidato a ALTA' : 'parou no meio'})`
                : `fica · ${a.fica}`;
            somar(resultado, destino, `${lead.id}${d ? ` (${d.regra})` : ''}`);
            if (GRAVAR && (d || a.filaDeAlta)) {
              if (await trava.travouAgora(lead)) {
                console.log(`   ${lead.id}: travou por CONFLITO_FRANQUIA agora — não gravei`);
                continue;
              }
              if (await w.aplicarDoEstoque(ctx, funis, a, lead, false)) gravados++;
              await new Promise((r) => setTimeout(r, 400));
            }
          } catch (err) {
            somar(resultado, 'erro · pulei (API do Kommo ou da franquia)', `${lead.id}: ${String(err).slice(0, 120)}`);
          }
        }
        if (leads.length < 250) break;
      }
    }
    console.log(`## ${regra} — ${etapas.map((e) => e.nome).join(' + ')}: ${naEtapa} na etapa · ${candidatos} candidatos pelo cartão · ${avaliados} avaliados a fundo${GRAVAR ? ` · ${gravados} gravados` : ''}`);
    if (foraDoCorte.deOutraUnidade || foraDoCorte.semUnidade) console.log(`   (Kommo dividido: ${foraDoCorte.deOutraUnidade} de outra unidade, ${foraDoCorte.semUnidade} sem unidade — fora)`);
    for (const [chave, g] of [...resultado].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`   ${String(g.n).padStart(5)}  ${chave}`);
      for (const ex of g.exemplos) console.log(`          ${ex}`);
      if (chave.startsWith('→')) totais.set(chave, (totais.get(chave) ?? 0) + g.n);
    }
    console.log('');
  }

  console.log('## total do que mexeria (dos avaliados a fundo)');
  for (const [chave, n] of totais) console.log(`   ${String(n).padStart(5)}  ${chave}`);
  if (!GRAVAR) console.log('\nNada foi gravado. Para gravar, só com o ok do João: --gravar --confirmo=<slug>.');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
