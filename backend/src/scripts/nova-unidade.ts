/**
 * NOVA UNIDADE NO CRM (kit de unidade, 14/11/2026): lê o questionário, valida e monta TUDO que a unidade precisa.
 *
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml>                    # SECO (padrão): imprime o plano, não grava nada
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml> --offline           # seco sem consultar banco nem Chatwoot (assume conta vazia)
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml> --aplicar           # executa, etapa por etapa, perguntando antes de cada uma
 *   npx tsx src/scripts/nova-unidade.ts <questionario.yaml> --aplicar --sim     # sem perguntar (só depois de ler o plano)
 *   ... --sobrescrever                                                          # troca também o que a unidade JÁ tem preenchido e deixa tocar numa unidade ATIVA
 *     (sem a flag: numa unidade que existe só se preenche campo VAZIO, e a ATIVA é recusada)
 *   npx tsx src/scripts/nova-unidade.ts --gerar-schema                          # regrava ops/kit-unidade/questionario.schema.json
 *
 * Fase 2: o --aplicar executa o banco E o Chatwoot (conta própria da clínica pela API de plataforma, etiquetas, atributos, automações, mensagens
 * prontas, caixa, time, atendentes, robô, webhook e aba do Funil) E os modelos na Meta via Kapso. Fica MANUAL: número, subdomínio, segredos da VPS,
 * franquia, pastas. Com `whatsapp.modo: demonstracao` (clínica de vitrine) a caixa é API e os modelos ficam em SECO.
 *   ... --ligar-robo       liga o robô Sofia na caixa (só depois do teste da Sofia)
 * Variáveis: CHATWOOT_URL/CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID (a conta de REFERÊNCIA, só leitura), CHATWOOT_PLATFORM_TOKEN (criar conta e usuário),
 * KAPSO_API_KEY (caixa e modelos), KIT_SEGREDOS_DIR (o cofre dos segredos gerados), MCP_URL_PUBLICA (o endereço do agente).
 * O seco só LÊ (SELECT / GET). Segredo nunca é lido nem impresso: do ambiente só se confere se a variável EXISTE.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { AUTOMACOES } from '../lib/automacoes.js';
import { executarPlano, relatorioFinal, type BancoPorta } from '../lib/kit-unidade/executar.js';
import { contaHttp, contaHttpSoLeitura, plataformaHttp } from '../lib/kit-unidade/chatwoot-http.js';
import { kapsoHttp } from '../lib/kit-unidade/kapso-http.js';
import type { PortasExternas } from '../lib/kit-unidade/portas.js';
import { segredosEmArquivo } from '../lib/kit-unidade/segredos.js';
import { ADMINS_DD_PADRAO, listaDaResposta, urlDoWebhook } from '../lib/kit-unidade/fase2.js';
import { sufixoDoQuestionario } from '../lib/kit-unidade/questionario.js';
import { montarPlano, textoDoPlano, type EstadoAtual } from '../lib/kit-unidade/plano.js';
import { lerQuestionario, questionarioMascarado, type Questionario } from '../lib/kit-unidade/questionario.js';
import { esquemaJson } from '../lib/kit-unidade/schema-json.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ_DO_REPO = resolve(AQUI, '../../..');
const CAMINHO_SCHEMA = join(RAIZ_DO_REPO, 'ops/kit-unidade/questionario.schema.json');
const CAMINHO_MOLDE = join(RAIZ_DO_REPO, 'ops/kit-unidade/molde-sofia/bloco-conversa.md');

/** O endereço do agente (de onde o Chatwoot da clínica chama): a origem de MCP_URL_PUBLICA, ou o padrão. */
function urlDoAgente(): string {
  try {
    return process.env.MCP_URL_PUBLICA ? new URL(process.env.MCP_URL_PUBLICA).origin : 'https://agente-vps.doutordigitalconsultoria.com';
  } catch {
    return 'https://agente-vps.doutordigitalconsultoria.com';
  }
}

const PASTA_DO_COFRE = process.env.KIT_SEGREDOS_DIR?.trim() || null;
const noCofre = (nome: string): boolean => !!PASTA_DO_COFRE && existsSync(join(PASTA_DO_COFRE, nome));

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
    segredos: Object.fromEntries(
      [q.franquia.token_env, q.meta.token_env, q.meta.conta_env, q.meta.dataset_id_env, `CHATWOOT_API_TOKEN_${sufixoDoQuestionario(q)}`, 'KAPSO_API_KEY'].map((v) => [v, !!process.env[v]?.trim() || noCofre(v)]),
    ),
    plataforma: !!process.env.CHATWOOT_PLATFORM_TOKEN?.trim(),
  };
  if (process.env.DATABASE_URL) {
    try {
      const { prisma } = await import('../lib/prisma.js');
      const u = await prisma.unit.findUnique({ where: { slug: q.unidade.slug }, include: { chatwoot: { include: { caixas: true } }, automacoes: true } });
      estado.banco = {
        unidade: u ? { id: u.id, campos: u as unknown as Record<string, unknown> } : null,
        configChatwoot: u?.chatwoot
          ? { subdominio: u.chatwoot.subdominio, prefixoModelos: u.chatwoot.prefixoModelos, metaAgendamentosDia: u.chatwoot.metaAgendamentosDia, kapsoPhoneNumberId: u.chatwoot.kapsoPhoneNumberId, wabaId: u.chatwoot.wabaId, envSufixo: u.chatwoot.envSufixo, dadosModelos: (u.chatwoot.dadosModelos ?? {}) as Record<string, unknown>, contaId: u.chatwoot.contaId }
          : null,
        caixasRegistradas: u?.chatwoot?.caixas.map((c) => c.caixaId) ?? [],
        automacoes: Object.fromEntries((u?.automacoes ?? []).map((a) => [a.automacao, a.estado])),
        sofia: (u ?? {}) as unknown as Record<string, unknown>,
      };
    } catch (err) {
      console.error(`(não consegui ler o banco: ${(err as Error).message} — o plano assume que nada existe)`);
    }
  }
  // O que a conta da CLÍNICA já tem (não a de referência): conta ainda sem id = conta que vai nascer vazia
  const contaDaClinica = estado.banco?.configChatwoot?.contaId ?? null;
  const urlDoChatwoot = (process.env.CHATWOOT_URL?.trim() || 'https://atendimento.doutordigitalconsultoria.com').replace(/\/+$/, '');
  const nomeToken = `CHATWOOT_API_TOKEN_${sufixoDoQuestionario(q)}`;
  const token = process.env[nomeToken]?.trim() || (PASTA_DO_COFRE && noCofre(nomeToken) ? readFileSync(join(PASTA_DO_COFRE, nomeToken), 'utf8').trim() : '');
  if (estado.banco && contaDaClinica === null) {
    estado.chatwoot = { etiquetas: [], atributosConversa: [], atributosContato: [], caixas: [], times: [], agentes: {}, pastas: {}, mensagensProntas: [], automacoesDaConta: 0 };
  } else if (contaDaClinica !== null && token) {
    try {
      const conta = contaHttp(urlDoChatwoot, contaDaClinica, token);
      const lista = async (caminho: string, query?: Record<string, string>): Promise<any[]> => {
        const r = (await conta.get(caminho, query)) as any;
        return Array.isArray(r) ? r : Array.isArray(r?.payload) ? r.payload : [];
      };
      const [etiquetas, atrC, atrK, caixas, times, agentes, prontas, regras, webhooks, abas] = await Promise.all([
        lista('labels'),
        lista('custom_attribute_definitions', { attribute_model: '0' }),
        lista('custom_attribute_definitions', { attribute_model: '1' }),
        lista('inboxes'),
        lista('teams'),
        lista('agents'),
        lista('canned_responses'),
        lista('automation_rules'),
        conta.get('webhooks').then((r) => listaDaResposta(r, 'webhooks')),
        lista('dashboard_apps'),
      ]);
      estado.chatwoot = {
        etiquetas: etiquetas.map((e) => String(e.title)),
        atributosConversa: atrC.map((a) => String(a.attribute_key)),
        atributosContato: atrK.map((a) => String(a.attribute_key)),
        caixas: caixas.map((c) => ({ id: Number(c.id), nome: String(c.name), robo: !!c.agent_bot })),
        times: times.map((t) => String(t.name)),
        agentes: Object.fromEntries(agentes.map((a) => [String(a.email).toLowerCase(), { id: Number(a.id), nome: String(a.name) }])),
        pastas: {}, // a pasta é da pessoa: com o token de administração não dá para listar a dela
        mensagensProntas: prontas.map((p) => String(p.short_code)),
        automacoesDaConta: regras.length,
        webhookDaConta: (webhooks as any[]).some((w) => String(w.url) === urlDoWebhook({ urlDoAgente: urlDoAgente() } as never, token)),
        abas: (abas as any[]).map((a) => String(a.title)),
      };
    } catch (err) {
      console.error(`(não consegui ler a conta ${contaDaClinica} do Chatwoot: ${(err as Error).message} — o plano assume que nada existe)`);
    }
  }
  return estado;
}

async function bancoReal(): Promise<BancoPorta> {
  const { prisma } = await import('../lib/prisma.js');
  return {
    async lerUnidade(slug) {
      const u = await prisma.unit.findUnique({ where: { slug } });
      return u ? { id: u.id, ativa: u.isActive === true, campos: u as unknown as Record<string, unknown> } : null;
    },
    // `campos` já vem filtrado por `protecao.ts` (só o que está vazio, ou tudo com --sobrescrever): aqui só se grava o que foi dado
    async gravarUnidade(slug, nome, campos, soNaCriacao = {}) {
      const ja = await prisma.unit.findUnique({ where: { slug }, select: { id: true } });
      if (ja) {
        if (Object.keys(campos).length) await prisma.unit.update({ where: { slug }, data: campos as never });
        return { id: ja.id, criada: false };
      }
      const nova = await prisma.unit.create({ data: { slug, name: nome, isActive: false, ...soNaCriacao, ...campos } as never, select: { id: true } });
      return { id: nova.id, criada: true };
    },
    async lerConfigChatwoot(unitId) {
      const c = await prisma.unitChatwoot.findUnique({ where: { unitId } });
      return c ? { subdominio: c.subdominio, prefixoModelos: c.prefixoModelos, metaAgendamentosDia: c.metaAgendamentosDia, kapsoPhoneNumberId: c.kapsoPhoneNumberId, wabaId: c.wabaId, envSufixo: c.envSufixo, dadosModelos: (c.dadosModelos ?? {}) as Record<string, unknown>, contaId: c.contaId, gerenteId: c.gerenteId, usuarioCelularId: c.usuarioCelularId } : null;
    },
    async gravarConfigChatwoot(unitId, c, criar) {
      const dados = { ...c, ...(c.dadosModelos ? { dadosModelos: c.dadosModelos as never } : {}), atualizadoPor: 'nova-unidade' };
      if (criar) await prisma.unitChatwoot.create({ data: { unitId, ...dados } as never });
      else await prisma.unitChatwoot.update({ where: { unitId }, data: dados as never });
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
    async caixasRegistradas(unitId) {
      return (await prisma.unitChatwootCaixa.findMany({ where: { unitId }, select: { caixaId: true } })).map((c) => c.caixaId);
    },
    async registrarCaixa(unitId, caixa) {
      await prisma.unitChatwootCaixa.upsert({ where: { caixaId: caixa.id }, update: {}, create: { caixaId: caixa.id, unitId, tipo: caixa.tipo } });
    },
  };
}

/** As portas do mundo de fora, com o que o ambiente tem. Parte que falta fica `null` (o passo que precisa dela fica BLOQUEADO, nunca finge). */
async function portasExternas(): Promise<PortasExternas> {
  const { contaChatwootDoAmbiente } = await import('../mcp-remoto/chatwoot.js');
  const ambiente = contaChatwootDoAmbiente();
  const url = (process.env.CHATWOOT_URL?.trim() || 'https://atendimento.doutordigitalconsultoria.com').replace(/\/+$/, '');
  const platform = process.env.CHATWOOT_PLATFORM_TOKEN?.trim();
  const kapso = process.env.KAPSO_API_KEY?.trim();
  const { randomBytes } = await import('node:crypto');
  const agente = urlDoAgente();
  return {
    plataforma: platform ? plataformaHttp(url, platform) : null,
    abrirConta: (conta, token) => contaHttp(url, conta, token),
    referencia: ambiente ? contaHttpSoLeitura(ambiente.url, ambiente.conta, ambiente.token) : null,
    contaDoAmbiente: ambiente?.conta ?? null,
    adminsDD: (process.env.KIT_ADMINS_DD?.trim() ? process.env.KIT_ADMINS_DD.split(',').map((m) => m.trim()).filter(Boolean) : ADMINS_DD_PADRAO),
    kapso: kapso ? kapsoHttp(kapso) : null,
    segredos: segredosEmArquivo(PASTA_DO_COFRE),
    urlDoAgente: agente,
    urlDoChatwoot: url,
    gerarSenha: () => `Aa1!${randomBytes(18).toString('base64url')}`,
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
    console.error('uso: nova-unidade.ts <questionario.yaml> [--aplicar] [--sim] [--offline] [--sobrescrever] [--sobrescrever-prompt] [--ligar-robo]   |   --gerar-schema');
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
  const plano = montarPlano(q, estado, { molde, sobrescrever: flags.has('--sobrescrever') });
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
    sobrescrever: flags.has('--sobrescrever'),
    externas: await portasExternas(),
    ligarRobo: flags.has('--ligar-robo'),
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
