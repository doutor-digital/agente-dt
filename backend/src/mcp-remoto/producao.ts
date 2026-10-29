/**
 * O conector remoto com as peças de produção: login do console, unidades da franquia e contas do
 * Kommo do banco, o cérebro e o relatório cruzado. Só é chamado quando `MCP_URL_PUBLICA` está definida.
 */
import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { login } from '../services/auth.service.js';
import { chaveTelefone, normalizarNome, panoramaDaUnidade, parecencaDeNome, type Panorama } from '../services/cerebro.service.js';
import { createKommoClient } from '../services/kommo.service.js';
import { historicoOficial } from '../services/kommo-talks.service.js';
import type { Contexto } from '../franquia-mcp/contexto.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { armazemPrisma } from './armazem-prisma.js';
import { executar } from './ferramenta.js';
import { criarContextoKommo, registrarFerramentasKommo, type UnidadeKommo } from './kommo.js';
import { criarContextoBling, registrarFerramentasBling, type ContaBling } from './bling.js';
import { registrarIntegracoes } from './integracoes.js';
import { registrarMetaEventos, type FonteRastreio } from './meta-eventos.js';
import { Pendentes, registrarEscritaKommo, type FonteEscrita } from './kommo-escrita.js';
import { registrarDisparo } from './disparo.js';
import { fonteDeDisparo } from './disparo-producao.js';
import type { KommoClient } from '../services/kommo.service.js';
import { PrismaClient } from '@prisma/client';
import { criarContextoAsaas, registrarFerramentasAsaas, type ContaAsaas } from './asaas.js';
import { asaasGet } from '../lib/integracoes/asaas.js';
import { criarContextoConvenia, registrarFerramentasConvenia, type ContaConvenia } from './convenia.js';
import { conveniaGet } from '../lib/integracoes/convenia.js';
import { criarContextoTiquetaque, registrarFerramentasTiquetaque, type ContaTiquetaque } from './tiquetaque.js';
import { tiquetaqueGet } from '../lib/integracoes/tiquetaque.js';
import { contasComChave } from '../lib/integracoes/chaves.js';
import { lerConfigSistemas, sistemasChamar } from '../lib/integracoes/sistemas.js';
import { criarContextoSistemas, PendentesSistemas, registrarEscritaSistemas, registrarLeituraSistemas, type ContaSistemas } from './sistemas.js';
import { contaEvolutionDoAmbiente, criarContextoEvolution, EVENTO_DE_ENVIO, registrarFerramentasEvolution } from './evolution.js';
import { blingGet } from '../lib/bling/cliente.js';
import type { Usuario } from './provedor.js';
import { registrarRelatorio, type DepsRelatorio } from './relatorio.js';
import { montarConectorRemoto } from './servidor.js';
import { acharSlug, umaPorChave, umaPorToken } from './unidades.js';

const BASE_URL_FRANQUIA = 'https://app-api-prod.doutorhernia.com.br';
const FUSO = 'America/Sao_Paulo';

function comoUsuario(u: User): Usuario {
  return { id: u.id, email: u.email, nome: u.name, papel: u.role, ativo: u.isActive };
}

/**
 * Unidades ativas com token da franquia, UMA por franquia (ver `umaPorToken`). O token fica neste
 * processo: nunca sai em resposta.
 */
async function unidadesDoBanco(): Promise<Map<string, Unidade>> {
  const linhas = await prisma.unit.findMany({
    where: { isActive: true, spineToken: { not: null } },
    select: { slug: true, name: true, spineToken: true, spineBaseUrl: true, spineTimezone: true },
    orderBy: { slug: 'asc' },
  });
  const todas: Unidade[] = [];
  for (const u of linhas) {
    const token = u.spineToken?.trim();
    if (!token) continue;
    todas.push({ slug: u.slug, nome: u.name, token, fuso: u.spineTimezone || FUSO, baseUrl: (u.spineBaseUrl || BASE_URL_FRANQUIA).replace(/\/+$/, '') });
  }
  const { ficam, descartadas } = umaPorToken(todas);
  logger.info({ franquias: ficam.size, mesmaFranquia: descartadas }, 'mcp-remoto: unidades carregadas (uma por token)');
  return ficam;
}

/** O cliente do Kommo de cada conta, para a escrita (a leitura usa a `fonte` da UnidadeKommo). */
const clientesKommo = new Map<string, KommoClient>();

/** Contas do Kommo, UMA por conta (subdomínio): resgate, financeiro e tratamento são funis da mesma conta. */
async function contasKommoDoBanco(): Promise<Map<string, UnidadeKommo>> {
  const linhas = await prisma.unit.findMany({
    where: { isActive: true, kommoSubdomain: { not: null }, kommoAccessToken: { not: null } },
    orderBy: { slug: 'asc' },
  });
  const comConta = linhas.filter((u) => u.kommoSubdomain?.trim() && u.kommoAccessToken?.trim());
  const { ficam, descartadas } = umaPorChave(comConta, (u) => String(u.kommoSubdomain).trim().toLowerCase());
  const contas = new Map<string, UnidadeKommo>();
  for (const [slug, u] of ficam) {
    const cliente = createKommoClient(u);
    clientesKommo.set(slug, cliente);
    contas.set(slug, {
      slug,
      nome: u.name,
      fuso: u.spineTimezone || FUSO,
      slugsDaFranquia: u.slugsDaFranquia,
      fonte: {
        leadsNaJanela: (campo, de, ate, maxPaginas) => cliente.listLeadsNaJanela(campo, de, ate, maxPaginas, true),
        telefonesDosContatos: (ids) => cliente.telefonesDosContatos(ids),
        funis: () => cliente.listPipelines(),
        lead: (id) => cliente.getLead(id),
        leadsPorTelefone: (tel) => cliente.listLeadsPorTelefone(tel, 50),
        usuarios: () => cliente.listUsers(),
        conversa: (leadId, limite, periodo) => historicoOficial(cliente, leadId, limite, periodo),
        notas: (leadId, limite, periodo) => cliente.listarNotasDoLead(leadId, limite, periodo),
      },
    });
  }
  await dividirContas(contas);
  logger.info({ contas: contas.size, mesmaConta: descartadas }, 'mcp-remoto: contas do Kommo carregadas (uma por conta)');
  return contas;
}

/**
 * Um Kommo para duas unidades (Petrópolis e Caxias, `unit_crm_compartilhado`): cada membro vira uma unidade do
 * conector com a divisão — vê e altera só os cartões com o seu «⌂ Unidade de atendimento». A irmã não tem
 * credencial de Kommo: usa o cliente da conta. Nenhuma entrada SEM divisão sobra para a conta (nem se alguém copiar
 * as credenciais para a irmã e o `umaPorChave` guardar a conta com o slug dela). Se a tabela não responder, a carga
 * falha inteira e a anterior fica (melhor que voltar a misturar as duas).
 * Mesma regra dos robôs (`lib/crm-compartilhado`): vale a linha `ativo`; unidade desligada continua dona dos seus
 * cartões (a outra não os vê), só não ganha entrada no conector; a dona sem rótulo próprio não vê cartão nenhum.
 */
async function dividirContas(contas: Map<string, UnidadeKommo>): Promise<void> {
  const linhas = await prisma.unitCrmCompartilhado.findMany({
    where: { ativo: true },
    select: { rotulo: true, unit: { select: { slug: true, name: true, spineTimezone: true, isActive: true } }, conta: { select: { slug: true } } },
    orderBy: { rotulo: 'asc' },
  });
  const porConta = new Map<string, typeof linhas>();
  for (const l of linhas) porConta.set(l.conta.slug, [...(porConta.get(l.conta.slug) ?? []), l]);
  for (const [contaSlug, grupo] of porConta) {
    const slugsDoGrupo = new Set([contaSlug, ...grupo.map((g) => g.unit.slug)]);
    // a entrada que ficou com a conta: pela dona ou por qualquer membro que caiu no mesmo subdomínio
    const base = [...contas.values()].find((u) => u.slugsDaFranquia.some((s) => slugsDoGrupo.has(s)));
    const cliente = base && clientesKommo.get(base.slug);
    if (!base || !cliente) {
      logger.warn({ conta: contaSlug }, 'mcp-remoto: conta dividida sem Kommo carregado — as unidades dela ficam sem Kommo');
      continue;
    }
    contas.delete(base.slug);
    const membros = grupo.map((g) => ({ slug: g.unit.slug, rotulo: g.rotulo }));
    if (!membros.some((m) => m.slug === contaSlug)) {
      logger.warn({ conta: contaSlug }, 'mcp-remoto: a dona da conta dividida não tem rótulo — fica sem Kommo no conector');
    }
    for (const g of grupo) {
      if (!g.unit.isActive) continue;
      clientesKommo.set(g.unit.slug, cliente);
      contas.set(g.unit.slug, {
        slug: g.unit.slug,
        nome: g.unit.name,
        fuso: g.unit.spineTimezone || base.fuso,
        // a dona leva os outros slugs da conta (resgate…); a irmã só o dela
        slugsDaFranquia: g.unit.slug === contaSlug ? [contaSlug, ...base.slugsDaFranquia.filter((s) => !slugsDoGrupo.has(s))] : [g.unit.slug],
        fonte: base.fonte,
        conta: contaSlug,
        divisao: { rotulo: g.rotulo, membros },
      });
    }
  }
}

/** Empresas com o Bling autorizado (refresh token salvo). A fila de 3 req/s e a renovação do token são do `blingGet`. */
async function contasBlingDoBanco(): Promise<Map<string, ContaBling>> {
  const linhas = await prisma.blingConexao.findMany({
    where: { refreshToken: { not: null } },
    include: { unit: { select: { slug: true, name: true, isActive: true } } },
  });
  const contas = new Map<string, ContaBling>();
  for (const l of linhas) {
    if (!l.unit.isActive) continue;
    contas.set(l.unit.slug, { slug: l.unit.slug, nome: l.unit.name, fonte: { get: (caminho, query) => blingGet(l.unitId, caminho, query ?? {}) } });
  }
  logger.info({ contas: contas.size }, 'mcp-remoto: contas do Bling carregadas');
  return contas;
}

/** Clínicas com a chave do Asaas no painel de integrações. A chave fica só em memória, decifrada aqui. */
async function contasAsaasDoBanco(): Promise<Map<string, ContaAsaas>> {
  const contas = new Map<string, ContaAsaas>();
  for (const c of await contasComChave('asaas')) {
    contas.set(c.slug, { slug: c.slug, nome: c.nome, fonte: { get: (caminho, query) => asaasGet(c.unitId, c.chave, caminho, query ?? {}) } });
  }
  logger.info({ contas: contas.size }, 'mcp-remoto: contas do Asaas carregadas');
  return contas;
}

/** Empresas com o token do Convênia (RH) no painel de integrações. O token fica só em memória, decifrado aqui. */
async function contasConveniaDoBanco(): Promise<Map<string, ContaConvenia>> {
  const contas = new Map<string, ContaConvenia>();
  for (const c of await contasComChave('convenia')) {
    contas.set(c.slug, { slug: c.slug, nome: c.nome, fonte: { get: (caminho, query) => conveniaGet(c.unitId, c.chave, caminho, query ?? {}) } });
  }
  logger.info({ contas: contas.size }, 'mcp-remoto: contas do Convênia carregadas');
  return contas;
}

/** Contas com o token do Tiquetaque (ponto) no painel de integrações. O token fica só em memória, decifrado aqui. */
async function contasTiquetaqueDoBanco(): Promise<Map<string, ContaTiquetaque>> {
  const contas = new Map<string, ContaTiquetaque>();
  for (const c of await contasComChave('tiquetaque')) {
    contas.set(c.slug, { slug: c.slug, nome: c.nome, fonte: { get: (caminho, query) => tiquetaqueGet(c.unitId, c.chave, caminho, query ?? {}) } });
  }
  logger.info({ contas: contas.size }, 'mcp-remoto: contas do Tiquetaque carregadas');
  return contas;
}

/**
 * Sistema novo de RH/Caixa/Financeiro (servidor próprio) com a URL e a chave de administração no painel de integrações. A chave
 * fica só em memória, decifrada aqui; configuração ilegível vira aviso no log (sem o conteúdo) e a conta fica de fora.
 */
async function contasSistemasDoBanco(): Promise<Map<string, ContaSistemas>> {
  const contas = new Map<string, ContaSistemas>();
  for (const c of await contasComChave('sistemas')) {
    try {
      const cfg = lerConfigSistemas(c.chave);
      contas.set(c.slug, { slug: c.slug, nome: c.nome, tela: cfg.tela, fonte: { chamar: (metodo, caminho, o) => sistemasChamar(cfg, metodo, caminho, o) } });
    } catch (err) {
      logger.warn({ slug: c.slug, motivo: err instanceof Error ? err.message : 'inválida' }, 'mcp-remoto: configuração do sistema novo ilegível; cadastre de novo no painel');
    }
  }
  logger.info({ contas: contas.size }, 'mcp-remoto: contas do sistema novo (RH/Caixa) carregadas');
  return contas;
}

/**
 * Banco de rastreio do n8n (eventos para a Meta, cliques em anúncio). Usuário só com SELECT nas tabelas de
 * rastreio; sem a variável, as ferramentas meta_* respondem que a leitura não está ligada.
 */
function fonteDoRastreio(): FonteRastreio | null {
  const url = process.env.RASTREIO_DATABASE_URL;
  if (!url) return null;
  const cliente = new PrismaClient({ datasourceUrl: url });
  return { consultar: (sql, ...params) => cliente.$queryRawUnsafe(sql, ...params) };
}

/**
 * Quem pode ALTERAR cartões pelo conector: os e-mails de MCP_ESCRITA_EMAILS (separados por vírgula) que existem
 * como usuário ativo do console. Sem a variável, ninguém altera — o conector segue só leitura.
 */
async function escritoresDoBanco(): Promise<Set<string>> {
  const emails = (process.env.MCP_ESCRITA_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return new Set();
  const us = await prisma.user.findMany({ where: { email: { in: emails }, isActive: true }, select: { id: true } });
  return new Set(us.map((u) => u.id));
}

/**
 * Quem vê o WhatsApp da Suzanne (evo_*): os e-mails de MCP_EVOLUTION_EMAILS que existem como usuário ativo do console.
 * É o WhatsApp pessoal dela, então a lista é à parte da de quem altera cartões. Sem a variável, ninguém vê.
 */
async function leitoresDoWhatsapp(): Promise<Set<string>> {
  const emails = (process.env.MCP_EVOLUTION_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return new Set();
  const us = await prisma.user.findMany({ where: { email: { in: emails }, isActive: true }, select: { id: true } });
  return new Set(us.map((u) => u.id));
}

const normEtiqueta = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function fonteDeEscrita(slug: string): FonteEscrita {
  const c = clientesKommo.get(slug);
  if (!c) throw new ErroDeEntrada(`conta do Kommo de ${slug} ainda não carregou; tente em instantes`);
  return {
    leads: (ids) => c.listLeadsPorIds(ids),
    funis: () => c.listPipelines(),
    campos: () => c.listarCamposDoCartao(),
    usuarios: () => c.listUsers(),
    etiquetaExiste: async (nome) => (await c.buscarEtiquetas(nome, 1)).some((t) => normEtiqueta(t.name) === normEtiqueta(nome)),
    atualizar: (lote) => c.atualizarLeadsEmLote(lote),
    nota: (id, texto) => c.addLeadNote(id, texto),
    tarefa: (t) => c.createTask(t),
  };
}

async function idsDasUnidades(slugs: string[]): Promise<string[]> {
  return (await prisma.unit.findMany({ where: { slug: { in: slugs } }, select: { id: true } })).map((u) => u.id);
}

function emLotes<T>(xs: T[], n: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < xs.length; i += n) lotes.push(xs.slice(i, i + n));
  return lotes;
}

/** Telefone de cada lead, pelas conversas com a IA (a conversa guarda o número do WhatsApp). */
async function telefonesDosLeads(slugs: string[], leadIds: number[]): Promise<Map<number, string>> {
  const unitIds = await idsDasUnidades(slugs);
  const m = new Map<number, string>();
  for (const lote of emLotes(leadIds, 1000)) {
    const conversas = await prisma.conversation.findMany({
      where: { unitId: { in: unitIds }, leadId: { in: lote.map(String) }, phone: { not: null } },
      select: { leadId: true, phone: true },
    });
    for (const c of conversas) if (c.phone) m.set(Number(c.leadId), c.phone);
  }
  return m;
}

/** Paciente da franquia ligado a cada lead pelo sincronizador. */
async function vinculosDosLeads(slugs: string[], leadIds: number[]): Promise<Map<number, number>> {
  const unitIds = await idsDasUnidades(slugs);
  const m = new Map<number, number>();
  for (const lote of emLotes(leadIds, 1000)) {
    const vs = await prisma.spineLeadLink.findMany({
      where: { unitId: { in: unitIds }, kommoLeadId: { in: lote }, spineIdClient: { not: null } },
      select: { kommoLeadId: true, spineIdClient: true },
    });
    for (const v of vs) if (v.spineIdClient) m.set(v.kommoLeadId, v.spineIdClient);
  }
  return m;
}

/** Recarrega em segundo plano: na subida e a cada 10 min; se falhar, tenta de novo em 30 s. */
function manterAtualizado<T>(carregar: () => Promise<T>, aplicar: (v: T) => void, nome: string): void {
  const rodar = () => {
    carregar()
      .then((v) => {
        aplicar(v);
        setTimeout(rodar, 10 * 60_000).unref();
      })
      .catch((err) => {
        logger.warn({ err }, `mcp-remoto: não consegui ler ${nome}; tento de novo`);
        setTimeout(rodar, 30_000).unref();
      });
  };
  rodar();
}

/**
 * O cérebro: franquia × Kommo conferidos por unidade (quem está sem cartão, ambíguo, sumindo).
 * É pesado na franquia (agenda de 60 dias + tratamentos + cadastro de quem sobrou): cache de 1 h.
 */
function registrarCerebro(server: McpServer, slugs: () => string[], cache: Cache, auditar: Auditar): void {
  const unidadeDoBanco = async (pedido: string) => {
    const slug = acharSlug(slugs(), pedido);
    if (!slug || pedido.trim().toLowerCase() === 'todas') throw new ErroDeEntrada(`informe UMA unidade. Válidas: ${slugs().join(', ')}`);
    const u = await prisma.unit.findUnique({ where: { slug } });
    if (!u) throw new ErroDeEntrada(`unidade ${slug} não encontrada`);
    return u;
  };
  // a mesma leitura serve o panorama e as fichas: abrir 10 fichas não pode virar 10 panoramas na franquia
  const panorama = async (u: Awaited<ReturnType<typeof unidadeDoBanco>>, dias = 60, meses = 6): Promise<{ pano: Panorama; doCache: boolean }> => {
    const chave = `panorama|${u.slug}|${dias}|${meses}`;
    const guardado = cache.pegar<Panorama>(chave);
    if (guardado) return { pano: guardado, doCache: true };
    const pano = await panoramaDaUnidade(u, { dias, meses });
    cache.guardar(chave, pano, 3_600_000);
    return { pano, doCache: false };
  };
  const ro = { readOnlyHint: true, openWorldHint: true };
  server.registerTool(
    'cerebro_panorama',
    {
      title: 'Cérebro: franquia × Kommo de uma unidade',
      description:
        'O retrato de UMA unidade: agenda e tratamentos da franquia conferidos contra os cartões do Kommo. Devolve as contagens ' +
        '(casados por vínculo, por telefone, sem cartão, ambíguos) e a lista "paraOlhar": quem está sem cartão, quem ficou ambíguo ' +
        '(com candidatos e parecença de nome) e quem está sumindo do tratamento (2+ faltas seguidas). Cache de 1 h.',
      inputSchema: {
        unidade: z.string().min(1).describe('slug ou nome curto ("serra")'),
        dias: z.number().int().min(1).max(180).optional().describe('janela da agenda em dias (padrão 60)'),
        meses: z.number().int().min(1).max(12).optional().describe('janela dos tratamentos em meses (padrão 6)'),
      },
      annotations: ro,
    },
    (args) =>
      executar('cerebro_panorama', args, auditar, async () => {
        const { pano, doCache } = await panorama(await unidadeDoBanco(args.unidade), args.dias, args.meses);
        return doCache ? { ...pano, doCache } : pano;
      }),
  );
  server.registerTool(
    'cerebro_paciente',
    {
      title: 'Cérebro: ficha de um paciente marcado',
      description:
        'A ficha de um paciente que o cerebro_panorama marcou (sem cartão, ambíguo ou sumindo): sessões, tratamentos, cartão no Kommo ' +
        'e como foi casado. Aceita o nome COMPLETO ou o telefone; nome parecido devolve só os nomes candidatos, nunca a ficha de outra ' +
        'pessoa. Quem NÃO está na lista do panorama não aparece aqui — use buscar_pacientes e kommo_buscar_telefone pra esses.',
      inputSchema: { unidade: z.string().min(1), busca: z.string().min(2).describe('nome do paciente ou telefone') },
      annotations: ro,
    },
    (args) =>
      executar('cerebro_paciente', args, auditar, async () => {
        const u = await unidadeDoBanco(args.unidade);
        const { pano } = await panorama(u);
        const alvo = normalizarNome(args.busca);
        const tel = chaveTelefone(args.busca);
        const achado =
          pano.paraOlhar.find((p) => normalizarNome(p.nome) === alvo) ?? (tel ? pano.paraOlhar.find((p) => chaveTelefone(p.telefone) === tel) : undefined);
        if (achado) return achado;
        const parecidos = pano.paraOlhar
          .map((p) => ({ nome: p.nome, parecenca: parecencaDeNome(p.nome, args.busca) }))
          .filter((p) => p.parecenca >= 0.6)
          .sort((a, b) => b.parecenca - a.parecenca)
          .slice(0, 5);
        if (parecidos.length) return { naoAchado: args.busca, talvezSeja: parecidos, comoUsar: 'chame de novo com o nome completo de um destes' };
        throw new ErroDeEntrada(`"${args.busca}" não está entre os pacientes que o panorama de ${u.slug} marcou`);
      }),
  );
}

/** Falha ao subir o conector vira log, nunca derruba o agente: a Sofia atendendo vale mais que o conector. */
export async function ligarConectorRemoto(app: Express): Promise<void> {
  if (!env.MCP_URL_PUBLICA) return;
  try {
    await montar(app, env.MCP_URL_PUBLICA);
  } catch (err) {
    logger.error({ err }, 'mcp-remoto: conector NÃO subiu (o resto do agente segue normal)');
  }
}

async function montar(app: Express, urlPublica: string): Promise<void> {
  const kommo = criarContextoKommo(new Map());
  manterAtualizado(contasKommoDoBanco, (contas) => (kommo.unidades = contas), 'as contas do Kommo');
  const bling = criarContextoBling(new Map());
  manterAtualizado(contasBlingDoBanco, (contas) => (bling.contas = contas), 'as contas do Bling');
  const asaas = criarContextoAsaas(new Map());
  const rastreio = fonteDoRastreio();
  let escritores = new Set<string>();
  manterAtualizado(escritoresDoBanco, (s) => (escritores = s), 'quem pode alterar cartões');
  const pendentes = new Pendentes();
  manterAtualizado(contasAsaasDoBanco, (contas) => (asaas.contas = contas), 'as contas do Asaas');
  const convenia = criarContextoConvenia(new Map());
  manterAtualizado(contasConveniaDoBanco, (contas) => (convenia.contas = contas), 'as contas do Convênia');
  const tiquetaque = criarContextoTiquetaque(new Map());
  manterAtualizado(contasTiquetaqueDoBanco, (contas) => (tiquetaque.contas = contas), 'as contas do Tiquetaque');
  // o teto anti-ban conta o que saiu nas últimas 24 h, inclusive antes desta subida do servidor (lido no 1º envio)
  const whatsapp = criarContextoEvolution(contaEvolutionDoAmbiente(), {
    historico: () =>
      prisma.mcpAuditoria
        .findMany({ where: { ferramenta: EVENTO_DE_ENVIO, ok: true, createdAt: { gte: new Date(Date.now() - 86_400_000) } }, select: { createdAt: true } })
        .then((rs) => rs.map((r) => r.createdAt.getTime())),
  });
  let leitoresWhatsapp = new Set<string>();
  if (whatsapp.conta) manterAtualizado(leitoresDoWhatsapp, (s) => (leitoresWhatsapp = s), 'quem vê o WhatsApp');
  const sistemas = criarContextoSistemas();
  manterAtualizado(contasSistemasDoBanco, (contas) => (sistemas.contas = contas), 'as contas do sistema novo');
  const pendentesSistemas = new PendentesSistemas();
  const cacheCerebro = new Cache();
  // o contexto da franquia nasce dentro de montarConectorRemoto; as ferramentas extras só rodam depois
  let franquia: Contexto | undefined;
  const slugs = () => [...new Set([...(franquia?.unidades.keys() ?? []), ...kommo.unidades.keys()])].sort();

  const r = await montarConectorRemoto(app, {
    urlPublica: new URL(urlPublica),
    armazem: armazemPrisma,
    // derivado, não o mesmo: um vazamento do pedido de login não vira sessão do console
    segredo: createHmac('sha256', env.SESSION_JWT_SECRET).update('mcp-remoto:pedido-de-login').digest('hex'),
    retornosPermitidos: env.MCP_RETORNOS_PERMITIDOS,
    hostsCimd: env.MCP_HOSTS_CIMD,
    autenticar: async (email, senha) => comoUsuario(await login(email, senha)),
    buscarUsuario: async (id) => {
      const u = await prisma.user.findUnique({ where: { id } });
      return u ? comoUsuario(u) : null;
    },
    carregarUnidades: unidadesDoBanco,
    franquia: { cliente: { log: (linha) => logger.info({ franquia: linha }, 'mcp-remoto: franquia') } },
    log: logger,
    extras: (server, auditar, quem) => {
      registrarFerramentasKommo(server, kommo, auditar);
      registrarFerramentasBling(server, bling, kommo, auditar);
      registrarFerramentasAsaas(server, asaas, auditar);
      registrarFerramentasConvenia(server, convenia, auditar);
      registrarFerramentasTiquetaque(server, tiquetaque, auditar);
      registrarMetaEventos(server, () => rastreio, auditar);
      const quemSistemas = { usuario: quem.userId, nome: quem.email || `usuario:${quem.userId}` };
      registrarLeituraSistemas(server, sistemas, quemSistemas, auditar);
      if (escritores.has(quem.userId)) {
        registrarEscritaKommo(server, kommo, fonteDeEscrita, pendentes, quem.userId, auditar);
        // Disparo de campanha: preparar e mostrar. Aprovar e retomar NÃO existem aqui (são do João, no painel do console).
        registrarDisparo(server, fonteDeDisparo, `conector:${quem.userId}`, auditar);
        // Sistema novo (RH/Caixa): alterar dados em dois passos, mudar usuário, criar convite — a mesma lista de quem altera cartões.
        registrarEscritaSistemas(server, sistemas, pendentesSistemas, quemSistemas, auditar);
      }
      if (leitoresWhatsapp.has(quem.userId)) registrarFerramentasEvolution(server, whatsapp, quem.userId, auditar);
      registrarIntegracoes(server, () => ({ franquia: franquia?.unidades ?? new Map(), kommo: kommo.unidades, bling: bling.contas, asaas: asaas.contas, convenia: convenia.contas, tiquetaque: tiquetaque.contas, sistemas: sistemas.contas }), auditar);
      registrarCerebro(server, slugs, cacheCerebro, auditar);
      if (franquia) {
        const deps: DepsRelatorio = { franquia, kommo, telefonesDosLeads, vinculosDosLeads };
        registrarRelatorio(server, deps, auditar);
      }
    },
  });
  franquia = r.contexto;
  logger.info({ url: r.urlMcp.href }, 'mcp-remoto: conector no ar (unidades e contas do Kommo carregando em segundo plano)');
}
