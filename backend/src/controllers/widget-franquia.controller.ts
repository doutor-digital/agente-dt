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
import { chaveConfere, janelaDoPeriodo, janelaExplicita, limparNome, resumirAuditoria, resumoDaAgenda, termosDeBusca } from '../lib/widget-agenda.js';
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
  origem: 'vinculo' | 'nome+telefone' | 'nome';
}

async function porVinculo(unit: Unit, leadId: number | null): Promise<PacienteAchado | null> {
  if (!leadId) return null;
  const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
  return link?.spineIdClient ? { idClient: link.spineIdClient, origem: 'vinculo' } : null;
}

async function porNomeETelefone(unit: Unit, titulo: string, nome: string, telefone: string): Promise<PacienteAchado | null> {
  const chave = chaveTelefone(telefone);
  const termos = termosDeBusca(titulo, nome);
  if (!termos.length) return null;
  const alvoNomes = new Set([normalizar(limparNome(titulo)), normalizar(limparNome(nome))].filter(Boolean));
  let porNomeExato: PacienteAchado | null = null;
  for (const termo of termos) {
    // até 100 por página: "Sandra" sozinho passa fácil de 20 pacientes, e ela ficava de fora (caso real, 16/09)
    const r = await SpineService.searchClients(unit, termo, 100);
    if (!r.ok) continue;
    const lista = (r.data?.clients ?? []).filter((c) => c.idClient);
    if (chave) {
      const casam = lista.filter((c) => c.whatsapp && chaveTelefone(c.whatsapp) === chave);
      if (casam.length === 1) return { idClient: casam[0].idClient!, origem: 'nome+telefone' };
      if (casam.length > 1) {
        const exato = casam.find((c) => alvoNomes.has(normalizar(c.name)));
        return { idClient: (exato ?? casam[0]).idClient!, origem: 'nome+telefone' };
      }
    }
    // sem telefone que case: aceita só se o nome completo bater exatamente e for um só
    if (!porNomeExato) {
      const exatos = lista.filter((c) => alvoNomes.has(normalizar(c.name)));
      if (exatos.length === 1) porNomeExato = { idClient: exatos[0].idClient!, origem: 'nome' };
    }
  }
  return porNomeExato;
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
  const titulo = typeof req.query.titulo === 'string' ? req.query.titulo.slice(0, 120) : '';   // título do cartão ("NOME 03/08/2026")
  const telefone = typeof req.query.telefone === 'string' ? req.query.telefone.slice(0, 40) : '';
  const tz = unit.spineTimezone ?? 'America/Sao_Paulo';

  try {
    // Dois caminhos, sempre: o vínculo que a Sofia gravou E a busca por nome+telefone. Caso real (16/09): o vínculo
    // apontava pra um cadastro sem agenda (343253) e a paciente de verdade, em tratamento, era outro cadastro (320555).
    // Fica o cadastro que tem agenda; se os dois existem e são diferentes, a franquia tem paciente em dobro → avisar.
    const [vinc, busca] = await Promise.all([porVinculo(unit, leadId), porNomeETelefone(unit, titulo, nome, telefone)]);
    const candidatos = [vinc, busca].filter((c, i, a): c is PacienteAchado => !!c && a.findIndex((x) => x && x.idClient === c.idClient) === i);
    if (!candidatos.length) {
      res.json({ unidade: unit.name, franquia: true, tz, agora: new Date(), paciente: null });
      return;
    }
    const detalhes = await Promise.all(candidatos.map(async (c) => ({ c, det: await SpineService.getClient(unit, c.idClient) })));
    const validos = detalhes.filter((d) => d.det.ok && d.det.data?.client);
    if (!validos.length) {
      res.json({ unidade: unit.name, franquia: true, tz, agora: new Date(), paciente: null, erro: detalhes.some((d) => !d.det.ok) ? 'franquia indisponível' : undefined });
      return;
    }
    validos.sort((a, b) => (b.det.data!.client!.schedules.length - a.det.data!.client!.schedules.length));
    const achado = validos[0].c;
    const cli = validos[0].det.data!.client!;
    const duplicadoNaFranquia = validos.length > 1;
    if (duplicadoNaFranquia) logger.info({ unit: unit.slug, leadId, ids: validos.map((v) => v.c.idClient) }, 'widget: paciente com dois cadastros na franquia');
    const agenda = resumoDaAgenda(cli.schedules, new Date());
    const trat = (await tratamentosDaUnidade(unit)).find((t) => (t.idClient && t.idClient === cli.idClient) || (t.clientName && cli.name && normalizar(t.clientName) === normalizar(cli.name))) ?? null;
    res.json({
      unidade: unit.name,
      franquia: true,
      tz,
      agora: new Date(),
      paciente: { idClient: cli.idClient, nome: cli.name, whatsapp: cli.whatsapp ? `…${chaveTelefone(cli.whatsapp).slice(-4)}` : null, origem: achado.origem },
      duplicadoNaFranquia,
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

// ── "Números da unidade" (16/09/2026, João: "se elas vissem os números na própria Kommo, iam ver o que está errado") ──
// `GET /api/public/widget/:slug/numeros?periodo=hoje|semana|mes` → os cards do dashboard pra esta unidade, com a
// conferência e a lista nominal de quem explica a diferença, vindos de `internal/audit/kpis` do dashboard (.NET).
// Mesma fonte do dashboard, então o número que a SDR vê no Kommo é o que a gestora vê no painel. SÓ LEITURA.
const cacheNumeros = new Map<string, { em: number; corpo: unknown }>();
const NUMEROS_TTL_MS = 120_000;

function unitIdNoDashboard(unit: Unit): number | null {
  if (!env.DASHBOARD_UNIT_IDS || !unit.kommoSubdomain) return null;
  try {
    // o .env da VPS é lido pelo bash no deploy E pelo docker (env_file): o JSON vai entre aspas simples, e o docker
    // pode entregar as aspas junto — tira antes de interpretar (16/09: deploy da v1.95.0 caiu por isso)
    const bruto = env.DASHBOARD_UNIT_IDS.trim().replace(/^['"]|['"]$/g, '');
    const mapa = JSON.parse(bruto) as Record<string, number>;
    const id = mapa[unit.kommoSubdomain];
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    logger.warn('widget: DASHBOARD_UNIT_IDS não é JSON válido');
    return null;
  }
}

export async function widgetNumerosHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const tz = unit.spineTimezone ?? 'America/Sao_Paulo';
  const janela = janelaExplicita(req.query.de, req.query.ate) ?? janelaDoPeriodo(typeof req.query.periodo === 'string' ? req.query.periodo : undefined, new Date(), tz);
  const base = { unidade: unit.name, slug: unit.slug, tz, periodo: janela, agora: new Date() };

  const unitId = unitIdNoDashboard(unit);
  if (!env.DASHBOARD_API_URL || !env.DASHBOARD_ADMIN_KEY || !unitId) {
    res.json({ ...base, dashboard: false, motivo: !unitId ? 'unidade sem ligação com o dashboard' : 'ponte com o dashboard não configurada' });
    return;
  }
  const chave = `${unitId}:${janela.de}:${janela.ate}`;
  const c = cacheNumeros.get(chave);
  if (c && Date.now() - c.em < NUMEROS_TTL_MS) {
    res.json({ ...base, dashboard: true, cache: true, ...(c.corpo as object) });
    return;
  }
  try {
    const url = `${env.DASHBOARD_API_URL.replace(/\/$/, '')}/internal/audit/kpis?unitId=${unitId}&de=${janela.de}&ate=${janela.ate}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25_000);
    const r = await fetch(url, { headers: { 'X-Admin-Key': env.DASHBOARD_ADMIN_KEY, Accept: 'application/json' }, signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) {
      logger.warn({ unit: unit.slug, status: r.status }, 'widget: dashboard respondeu erro na auditoria de KPIs');
      res.status(502).json({ ...base, dashboard: true, error: 'dashboard indisponível' });
      return;
    }
    const corpo = { ...resumirAuditoria(await r.json()), lidoEm: new Date() };
    cacheNumeros.set(chave, { em: Date.now(), corpo });
    res.json({ ...base, dashboard: true, cache: false, ...corpo });
  } catch (err) {
    logger.warn({ err, unit: unit.slug }, 'widget: falha ao ler os números do dashboard');
    res.status(502).json({ ...base, dashboard: true, error: 'dashboard indisponível' });
  }
}
