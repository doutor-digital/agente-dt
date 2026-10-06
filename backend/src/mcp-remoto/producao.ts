/**
 * O conector remoto com as peças de produção: login do console, usuários e unidades do banco.
 * Só é chamado quando `MCP_URL_PUBLICA` está definida.
 */
import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import type { User } from '@prisma/client';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { login } from '../services/auth.service.js';
import type { Unidade } from '../franquia-mcp/unidade.js';
import { armazemPrisma } from './armazem-prisma.js';
import type { Usuario } from './provedor.js';
import { montarConectorRemoto } from './servidor.js';

const BASE_URL_FRANQUIA = 'https://app-api-prod.doutorhernia.com.br';

function comoUsuario(u: User): Usuario {
  return { id: u.id, email: u.email, nome: u.name, papel: u.role, ativo: u.isActive };
}

/** Unidades ativas com token da franquia. O token fica neste processo: nunca sai em resposta. */
async function unidadesDoBanco(): Promise<Map<string, Unidade>> {
  const linhas = await prisma.unit.findMany({
    where: { isActive: true, spineToken: { not: null } },
    select: { slug: true, name: true, spineToken: true, spineBaseUrl: true, spineTimezone: true },
    orderBy: { slug: 'asc' },
  });
  const unidades = new Map<string, Unidade>();
  for (const u of linhas) {
    const token = u.spineToken?.trim();
    if (!token) continue;
    unidades.set(u.slug, {
      slug: u.slug,
      nome: u.name,
      token,
      fuso: u.spineTimezone || 'America/Sao_Paulo',
      baseUrl: (u.spineBaseUrl || BASE_URL_FRANQUIA).replace(/\/+$/, ''),
    });
  }
  return unidades;
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
  const { urlMcp } = await montarConectorRemoto(app, {
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
  });
  logger.info({ url: urlMcp.href }, 'mcp-remoto: conector no ar (unidades carregando em segundo plano)');
}
