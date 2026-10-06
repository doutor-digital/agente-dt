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
import type { Contexto } from '../franquia-mcp/contexto.js';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { Cache } from '../franquia-mcp/ritmo.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { armazemPrisma } from './armazem-prisma.js';
import { executar } from './ferramenta.js';
import { criarContextoKommo, registrarFerramentasKommo, type UnidadeKommo } from './kommo.js';
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
      },
    });
  }
  logger.info({ contas: contas.size, mesmaConta: descartadas }, 'mcp-remoto: contas do Kommo carregadas (uma por conta)');
  return contas;
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
    extras: (server, auditar) => {
      registrarFerramentasKommo(server, kommo, auditar);
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
