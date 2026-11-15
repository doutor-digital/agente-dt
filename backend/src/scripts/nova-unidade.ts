/**
 * NOVA UNIDADE NO CRM (kit de unidade, 14/11/2026): lê o questionário, valida e monta TUDO que a unidade precisa.
 *
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml>                    # SECO (padrão): imprime o plano, não grava nada
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml> --offline           # seco sem consultar banco nem Chatwoot (assume conta vazia)
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml> --aplicar           # executa, etapa por etapa, perguntando antes de cada uma
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml> --aplicar --sim     # sem perguntar (só depois de ler o plano)
 *   npx tsx src/scripts/nova-unidade.ts --gerar-schema                          # regrava ops/kit-unidade/questionario.schema.json
 *
 * Fase 1: o seco está completo; o --aplicar executa os passos de BANCO e deixa como ESQUELETO os que dependem de API externa
 * (caixa/atendentes/pastas no Chatwoot, modelos na Meta/Kapso, subdomínio na VPS) — o plano diz quais são.
 * O seco só LÊ (SELECT / GET). Segredo nunca é lido nem impresso: do ambiente só se confere se a variável EXISTE.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { AUTOMACOES } from '../lib/automacoes.js';
import { executarPlano, relatorioFinal, type BancoPorta } from '../lib/kit-unidade/executar.js';
import { montarPlano, textoDoPlano, type EstadoAtual } from '../lib/kit-unidade/plano.js';
import { lerQuestionario, questionarioMascarado, type Questionario } from '../lib/kit-unidade/questionario.js';
import { esquemaJson } from '../lib/kit-unidade/schema-json.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_DO_REPO = resolve(AQUI, '../../..');
const CAMINHO_SCHEMA = join(RAIZ_DO_REPO, 'ops/kit-unidade/questionario.schema.json');
const CAMINHO_MOLDE = join(RAIZ_DO_REPO, 'ops/kit-unidade/molde-sofia/bloco-conversa.md');

function argumentos(argv: string[]) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  return { arquivo: argv.find((a) => !a.startsWith('--')), flags };
}

export function lerMolde(caminho = CAMINHO_MOLDE): string | null {
  return existsSync(caminho) ? readFileSync(caminho, 'utf8') : null;
}

/** O estado atual, SÓ LEITURA. Parte que falha ou não está configurada fica `undefined` (= não consultado). */
async function lerEstado(q: Questionario): Promise<EstadoAtual> {
  const estado: EstadoAtual = {
    segredos: Object.fromEntries([q.franquia.token_env, q.meta.token_env, q.meta.conta_env, q.meta.dataset_id_env].map((v) => [v, !!process.env[v]?.trim()])),
  };
  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import('../lib/prisma.js');
      const u = await prisma.unit.findUnique({ where: { slug: q.unidade.slug }, include: { chatwoot: { include: { caixas: true } }, automacoes: true } });
      estado.banco = {
        unidade: u ? { id: u.id, campos: u as unknown as Record<string, unknown> } : null,
        configChatwoot: u?.chatwoot
          ? { prefixoModelos: u.chatwoot.prefixoModelos, metaAgendamentosDia: u.chatwoot.metaAgendamentosDia, kapsoPhoneNumberId: u.chatwoot.kapsoPhoneNumberId, wabaId: u.chatwoot.wabaId, envSufixo: u.chatwoot.envSufixo, dadosModelos: (u.chatwoot.dadosModelos ?? {}) as Record<string, unknown> }
          : null,
        caixasRegistradas: u?.chatwoot?.caixas.map((c) => c.caixaId) ?? [],
        automacoes: Object.fromEntries((u?.automacoes ?? []).map((a) => [a.automacao, a.estado])),
        sofia: (u ?? {}) as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error(`(não consegui ler o banco: ${(err as Error).message} — o plano assume que nada existe)`);
    }
  }
  const { contaChatwootDoAmbiente, criarContextoChatwoot, chamar } = await import('../mcp-remoto/chatwoot.js');
  const conta = contaChatwootDoAmbiente();
  if (conta) {
    try {
      const ctx = criarContextoChatwoot(conta);
      const lista = async (caminho: string, query?: Record<string, string>): Promise<any[]> => {
        const r = (await chamar(ctx, 'GET', caminho, { query })) as any;
        return Array.isArray(r) ? r : Array.isArray(r?.payload) ? r.payload : [];
      };
      const [etiquetas, atrC, atrK, caixas, times, agentes, prontas, regras] = await Promise.all([
        lista('labels'),
        lista('custom_attribute_definitions', { attribute_model: '0' }),
        lista('custom_attribute_definitions', { attribute_model: '1' }),
        lista('inboxes'),
        lista('teams'),
        lista('agents'),
        lista('canned_responses'),
        lista('automation_rules'),
      ]);
      estado.chatwoot = {
        etiquetas: etiquetas.map((e) => String(e.title)),
        atributosConversa: atrC.map((a) => String(a.attribute_key)),
        atributosContato: atrK.map((a) => String(a.attribute_key)),
        caixas: caixas.map((c) => ({ id: Number(c.id), nome: String(c.name) })),
        times: times.map((t) => String(t.name)),
        agentes: Object.fromEntries(agentes.map((a) => [String(a.email).toLowerCase(), { id: Number(a.id), nome: String(a.name) }])),
        pastas: {}, // a pasta é da pessoa: com o token de administração não dá para listar a dela
        mensagensProntas: prontas.map((p) => String(p.short_code)),
        automacoesDaConta: regras.length,
      };
    } catch (err) {
      console.error(`(não consegui ler o Chatwoot: ${(err as Error).message} — o plano assume que nada existe)`);
    }
  }
  return estado;
}

async function bancoReal(): Promise<BancoPorta> {
  const { prisma } = await import('../lib/prisma.js');
  return {
    async gravarUnidade(slug, nome, campos) {
      const ja = await prisma.unit.findUnique({ where: { slug }, select: { id: true } });
      if (ja) {
        if (Object.keys(campos).length) await prisma.unit.update({ where: { slug }, data: campos as never });
        return { id: ja.id, criada: false };
      }
      const nova = await prisma.unit.create({ data: { slug, name: nome, isActive: false, ...campos } as never, select: { id: true } });
      return { id: nova.id, criada: true };
    },
    async gravarConfigChatwoot(unitId, c) {
      const dados = { prefixoModelos: c.prefixoModelos, metaAgendamentosDia: c.metaAgendamentosDia, kapsoPhoneNumberId: c.kapsoPhoneNumberId, wabaId: c.wabaId, envSufixo: c.envSufixo, dadosModelos: c.dadosModelos as never, atualizadoPor: 'nova-unidade' };
      await prisma.unitChatwoot.upsert({ where: { unitId }, create: { unitId, ...dados }, update: dados });
    },
    async automacoesDaUnidade(unitId) {
      return (await prisma.unitAutomacao.findMany({ where: { unitId }, select: { automacao: true } })).map((a) => a.automacao);
    },
    async criarAutomacoesEmSeco(unitId, ids) {
      const validas = ids.filter((id) => AUTOMACOES.some((a) => a.id === id && a.temSeco));
      await prisma.unitAutomacao.createMany({ data: validas.map((automacao) => ({ unitId, automacao, estado: 'seco', atualizadoPor: 'nova-unidade' })), skipDuplicates: true });
    },
    async sofiaDaUnidade(unitId) {
      return ((await prisma.unit.findUnique({ where: { id: unitId } })) ?? {}) as unknown as Record<string, unknown>;
    },
    async gravarSofia(unitId, campos) {
      await prisma.unit.update({ where: { id: unitId }, data: campos as never });
    },
  };
}

async function main(): Promise<void> {
  const { arquivo, flags } = argumentos(process.argv.slice(2));
  if (flags.has('--gerar-schema')) {
    writeFileSync(CAMINHO_SCHEMA, JSON.stringify(esquemaJson(), null, 2) + '\n');
    console.log(`regravado: ${CAMINHO_SCHEMA}`);
    return;
  }
  if (!arquivo) {
    console.error('uso: nova-unidade.ts <questionario.yaml> [--aplicar] [--sim] [--offline] [--sobrescrever-prompt]   |   --gerar-schema');
    process.exit(2);
  }
  const lido = lerQuestionario(readFileSync(resolve(arquivo), 'utf8'));
  if (!lido.ok) {
    console.error('QUESTIONÁRIO INVÁLIDO:');
    for (const e of lido.erros) console.error(`  - ${e}`);
    process.exit(1);
  }
  const q = lido.q;
  console.log('Questionário (campos sensíveis mascarados):');
  console.log(JSON.stringify(questionarioMascarado(q), null, 2));
  console.log('');
  const estado: EstadoAtual = flags.has('--offline') ? {} : await lerEstado(q);
  const molde = lerMolde();
  const plano = montarPlano(q, estado, { molde });
  console.log(textoDoPlano(plano));
  if (!flags.has('--aplicar')) {
    console.log('\n(SECO: nada foi gravado. Para executar: --aplicar)');
    process.exit(0);
  }
  if (flags.has('--offline')) {
    console.error('\n--aplicar não combina com --offline: sem ler o estado atual não dá para ser idempotente.');
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const sim = flags.has('--sim');
  const resultados = await executarPlano(plano, q, {
    banco: await bancoReal(),
    molde,
    sobrescreverPrompt: flags.has('--sobrescrever-prompt'),
    dizer: (l) => console.log(l),
    confirmar: async (p) => (sim ? true : /^s(im)?$/i.test((await rl.question(`  Aplicar esta etapa (${p.id})? [s/N] `)).trim())),
  });
  rl.close();
  console.log(relatorioFinal(plano, resultados));
  process.exit(resultados.some((r) => r.situacao === 'falhou') ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
