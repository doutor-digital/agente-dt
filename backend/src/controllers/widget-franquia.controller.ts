/**
 * Rotas públicas (com chave por unidade) pros widgets privados do Kommo.
 *
 * `GET /api/public/widget/:slug/ping`      → confere a chave (o widget testa ao instalar)
 * `GET /api/public/widget/:slug/paciente`  → o que a franquia sabe do paciente do cartão:
 *   consulta marcada (data, hora, status, fisioterapeuta), última consulta, sessões e
 *   tratamento em andamento. SÓ LEITURA: nada aqui escreve na franquia nem no Kommo.
 *
 * Como casa o paciente: 1) `lead` → vínculo `spine_lead_links` (o que a Sofia gravou);
 * 2) `nome` → busca por nome na franquia e confere os 8 últimos dígitos do `telefone`.
 *
 * Chave: header `X-Widget-Key` (ou `?chave=`), HMAC do slug com SESSION_JWT_SECRET
 * (ver `lib/widget-agenda.ts`). Sem chave certa: 403. 60 chamadas por ip+unidade a cada minuto.
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { SpineService, type SpineTreatment } from '../services/spine.service.js';
import { chaveConfere, resumoDaAgenda } from '../lib/widget-agenda.js';
import { chaveTelefone, normalizar } from '../lib/franquia-sync.js';

const chamadas = new Map<string, { n: number; desde: number }>();
const JANELA_MS = 60_000;
const MAX_POR_MINUTO = 60;

function excedeu(chave: string): boolean {
  const agora = Date.now();
  const t = chamadas.get(chave);
  if (!t || agora - t.desde > JANELA_MS) {
    chamadas.set(chave, { n: 1, desde: agora });
    return false;
  }
  t.n += 1;
  return t.n > MAX_POR_MINUTO;
}

async function unidadeDoWidget(req: Request, res: Response): Promise<Unit | null> {
  const slug = String(req.params.slug ?? '');
  if (excedeu(`${req.ip}:${slug}`)) {
    res.status(429).json({ error: 'muitas chamadas — aguarde um minuto' });
    return null;
  }
  const recebida = req.header('x-widget-key') ?? (typeof req.query.chave === 'string' ? req.query.chave : undefined);
  if (!chaveConfere(slug, env.SESSION_JWT_SECRET, recebida)) {
    res.status(403).json({ error: 'chave inválida' });
    return null;
  }
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return null;
  }
  return unit;
}

export async function widgetPingHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  res.json({ ok: true, unidade: unit.name, slug: unit.slug, franquia: !!(unit.spineEnabled && unit.spineToken), agora: new Date() });
}

// ── tratamentos EM ANDAMENTO: a rota da franquia devolve a unidade inteira; guarda 5 min por unidade ──
const cacheTratamentos = new Map<string, { em: number; lista: SpineTreatment[] }>();
async function tratamentosDaUnidade(unit: Unit): Promise<SpineTreatment[]> {
  const c = cacheTratamentos.get(unit.id);
  if (c && Date.now() - c.em < 5 * 60_000) return c.lista;
  const r = await SpineService.searchTreatments(unit);
  const lista = r.ok ? (r.data?.treatments ?? []) : c?.lista ?? [];
  cacheTratamentos.set(unit.id, { em: Date.now(), lista });
  return lista;
}

interface PacienteAchado {
  idClient: number;
  origem: 'vinculo' | 'nome+telefone';
}

async function acharPaciente(unit: Unit, leadId: number | null, nome: string, telefone: string): Promise<PacienteAchado | null> {
  if (leadId) {
    const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
    if (link?.spineIdClient) return { idClient: link.spineIdClient, origem: 'vinculo' };
  }
  const chave = chaveTelefone(telefone);
  if (!nome.trim() || !chave) return null;
  // nome completo e, se não achar, só o primeiro nome (a franquia grava "MARIA DA SILVA", o Kommo "Maria")
  const tentativas = [nome.trim(), nome.trim().split(/\s+/)[0]].filter((t, i, a) => t.length >= 3 && a.indexOf(t) === i);
  for (const termo of tentativas) {
    const r = await SpineService.searchClients(unit, termo);
    if (!r.ok) continue;
    const casam = (r.data?.clients ?? []).filter((c) => c.idClient && c.whatsapp && chaveTelefone(c.whatsapp) === chave);
    if (casam.length === 1) return { idClient: casam[0].idClient!, origem: 'nome+telefone' };
    if (casam.length > 1) {
      const exato = casam.find((c) => normalizar(c.name) === normalizar(nome));
      return { idClient: (exato ?? casam[0]).idClient!, origem: 'nome+telefone' };
    }
  }
  return null;
}

export async function widgetPacienteHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  if (!unit.spineEnabled || !unit.spineToken) {
    res.json({ unidade: unit.name, franquia: false, paciente: null });
    return;
  }
  const leadId = Number(req.query.lead) || null;
  const nome = typeof req.query.nome === 'string' ? req.query.nome.slice(0, 120) : '';
  const telefone = typeof req.query.telefone === 'string' ? req.query.telefone.slice(0, 40) : '';
  const tz = unit.spineTimezone ?? 'America/Sao_Paulo';

  try {
    const achado = await acharPaciente(unit, leadId, nome, telefone);
    if (!achado) {
      res.json({ unidade: unit.name, franquia: true, tz, agora: new Date(), paciente: null });
      return;
    }
    const det = await SpineService.getClient(unit, achado.idClient);
    if (!det.ok || !det.data?.client) {
      res.json({ unidade: unit.name, franquia: true, tz, agora: new Date(), paciente: null, erro: det.ok ? undefined : 'franquia indisponível' });
      return;
    }
    const cli = det.data.client;
    const agenda = resumoDaAgenda(cli.schedules, new Date());
    const trat = (await tratamentosDaUnidade(unit)).find((t) => (t.idClient && t.idClient === cli.idClient) || (t.clientName && cli.name && normalizar(t.clientName) === normalizar(cli.name))) ?? null;
    res.json({
      unidade: unit.name,
      franquia: true,
      tz,
      agora: new Date(),
      paciente: { idClient: cli.idClient, nome: cli.name, whatsapp: cli.whatsapp ? `…${chaveTelefone(cli.whatsapp).slice(-4)}` : null, origem: achado.origem },
      agenda,
      tratamento: trat
        ? { categoria: trat.category, fisioterapeuta: trat.staffName, status: trat.statusName, local: trat.local, grau: trat.degree, valor: trat.price }
        : null,
    });
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'widget: falha ao montar a agenda do paciente');
    res.status(502).json({ error: 'franquia indisponível' });
  }
}
