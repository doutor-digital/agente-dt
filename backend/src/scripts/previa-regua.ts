/**
 * PRÉVIA DO DIA da régua do CRM: o que ela MANDARIA nas próximas 24 h a uma unidade. SÓ LÊ (Chatwoot, banco e Kommo): não manda nada, não grava nada.
 * Serve para aprovar antes de ligar a régua. A saída não tem telefone (modelo, primeiro nome, horário do compromisso, quando sairia).
 *
 *   node dist/scripts/previa-regua.js --unidade=doutor-hernia-parauapebas            # as próximas 24 h
 *   node dist/scripts/previa-regua.js --unidade=<slug> --horas=48 --json
 *   opções: --sem-kommo (não confere o cartão ativo no Kommo)
 */
import { prisma } from '../lib/prisma.js';
import { CAIXAS_REGUA } from '../lib/chatwoot-regua.js';
import { armazemDoBanco, chatDoChatwoot, dadosDaUnidadeDaRegua, kommoDaRegua } from '../lib/chatwoot-regua-worker.js';
import { formatarPrevia, HORAS_DA_PREVIA, previaDaCaixa } from '../lib/chatwoot-regua-previa.js';
import { ajustesDaUnidade, bancoDosRobos } from '../lib/robos-estado.js';
import { recarregarAutomacoes } from '../lib/automacoes-estado.js';
import { contextoDaCaixa, contextoDoAmbiente } from '../mcp-remoto/chatwoot.js';

function argumento(nome: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x === `--${nome}` || x.startsWith(`--${nome}=`));
  return a === undefined ? undefined : a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
}

async function main(): Promise<void> {
  const slug = argumento('unidade');
  if (!slug) {
    console.error('Uso: --unidade=<slug> [--horas=24] [--json] [--sem-kommo]');
    process.exit(2);
  }
  const horas = Number(argumento('horas') ?? HORAS_DA_PREVIA);
  if (!Number.isFinite(horas) || horas <= 0 || horas > 168) {
    console.error('--horas precisa estar entre 1 e 168');
    process.exit(2);
  }
  const caixa = Object.entries(CAIXAS_REGUA).find(([, s]) => s === slug)?.[0];
  if (!caixa) {
    console.error(`A unidade ${slug} não tem caixa na régua (CAIXAS_REGUA).`);
    process.exit(2);
  }
  const base = contextoDoAmbiente();
  const ctx = base ? contextoDaCaixa(base, Number(caixa)) : null;
  if (!ctx?.conta) {
    console.error(`O Chatwoot não está configurado para a caixa ${caixa} neste servidor.`);
    process.exit(2);
  }
  await recarregarAutomacoes();
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit) {
    console.error(`Unidade ${slug} não encontrada.`);
    process.exit(2);
  }
  const agora = new Date();
  const ajustes = await ajustesDaUnidade(bancoDosRobos(), slug);
  const r = await previaDaCaixa(
    { armazem: armazemDoBanco(), chat: chatDoChatwoot(ctx), ...(argumento('sem-kommo') === undefined ? { kommo: kommoDaRegua(unit) } : {}) },
    Number(caixa),
    dadosDaUnidadeDaRegua(unit, slug),
    agora,
    horas,
    ajustes,
  );
  if (argumento('json') !== undefined) console.log(JSON.stringify({ unidade: slug, agora, horas, ...r }, null, 2));
  else console.log(formatarPrevia(r, slug, agora, horas));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
