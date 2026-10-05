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
import { horariosParaWidget, marcarPeloWidget } from '../lib/marcacao-widget.js';
import { chaveConfere, janelaDoPeriodo, janelaExplicita, limparNome, resumirAuditoria, resumoDaAgenda, termosDeBusca } from '../lib/widget-agenda.js';
import { chaveTelefone, normalizar } from '../lib/franquia-sync.js';
import { createKommoClient, type KommoTalkMessage } from '../services/kommo.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { CAMPO_MOTIVO_NAO_AGENDAMENTO, autorDaMensagem, interpretarResposta, montarPrompt, type FalaDaConversa } from '../lib/sugestao-motivo.js';

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

/**
 * "A franquia foi lida há quantos minutos?" — o relógio do sincronizador, pra aparecer no cartão e na
 * Conferência. Sem isto a SDR registra na franquia e fica olhando o cartão sem saber se já passou a hora.
 */
export async function widgetSyncHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const { relogioDoSync } = await import('../lib/franquia-sync-worker.js');
  const r = relogioDoSync(unit.slug);
  const agora = Date.now();
  const minutosAtras = r.ultimaEm ? Math.max(0, Math.round((agora - Date.parse(r.ultimaEm)) / 60_000)) : null;
  res.json({
    ...r,
    minutosAtras,
    proximaEmMin: minutosAtras === null ? r.intervaloMin : Math.max(0, r.intervaloMin - minutosAtras),
    ligado: !!(unit.spineEnabled && unit.spineToken),
    agora: new Date().toISOString(),
  });
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


// ── "Marcar consulta" de dentro do cartão (unidade sem Sofia) — ver lib/marcacao-widget.ts ──

/** Escritas contam à parte e bem mais apertado que as leituras: 10 marcações por minuto por ip+unidade. */
const marcacoes = new Map<string, { n: number; desde: number }>();
function excedeuMarcacao(chave: string): boolean {
  const agora = Date.now();
  const t = marcacoes.get(chave);
  if (!t || agora - t.desde > JANELA_MS) { marcacoes.set(chave, { n: 1, desde: agora }); return false; }
  t.n += 1;
  return t.n > 10;
}

/** GET /public/widget/:slug/horarios?de=AAAA-MM-DD&dias=7 → a grade livre que a Sofia também vê. */
export async function widgetHorariosHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: unit.spineTimezone || 'America/Sao_Paulo' });
  const pedido = typeof req.query.de === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.de) ? req.query.de : hoje;
  const de = pedido < hoje ? hoje : pedido; // agenda no passado não existe
  const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 14);
  if (!unit.spineEnabled || !unit.spineToken) { res.status(409).json({ error: 'franquia não conectada nesta unidade' }); return; }
  res.json({ de, dias: await horariosParaWidget(unit, de, dias), fuso: unit.spineTimezone || 'America/Sao_Paulo' });
}

/** POST /public/widget/:slug/marcar {leadId, nome, telefone, data, hora, cidade?, uf?, responsavel?} */
export async function widgetMarcarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  if (excedeuMarcacao(`${req.ip}:${unit.slug}`)) { res.status(429).json({ error: 'muitas marcações seguidas — aguarde um minuto' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const leadId = Number(b.leadId);
  if (!Number.isInteger(leadId) || leadId <= 0) { res.status(400).json({ error: 'leadId inválido' }); return; }
  const texto = (k: string, max = 120) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, max) : '');
  const r = await marcarPeloWidget(unit, {
    leadId,
    nome: texto('nome'),
    telefone: texto('telefone', 30),
    data: texto('data', 10),
    hora: texto('hora', 5),
    cidade: texto('cidade', 80) || null,
    uf: texto('uf', 30) || null,
    responsavel: texto('responsavel', 60) || null,
    idCategory: Number.isInteger(Number(b.idCategory)) && Number(b.idCategory) > 0 ? Number(b.idCategory) : null,
  });
  res.status(r.ok ? 200 : 409).json(r);
}


// ── Os passos que o widget ENSINA no cartão, e o "entendi" de cada pessoa ──
//
// O professor só serve se souber parar: o widget pergunta o que esta pessoa já entendeu e esconde
// esses passos para sempre. Chave = usuário do Kommo (`amouser_id`), não navegador, para a mesma
// pessoa não recomeçar em outro computador.

/** GET /public/widget/:slug/passos?u=<amouser_id> → ids já marcados por essa pessoa. */
export async function widgetPassosHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const u = Number(req.query.u);
  if (!Number.isInteger(u) || u <= 0) { res.json({ entendidos: [] }); return; }
  const linhas = await prisma.widgetPasso.findMany({
    where: { unitId: unit.id, kommoUserId: u },
    select: { passo: true },
  });
  res.json({ entendidos: linhas.map((l) => l.passo) });
}

/** POST /public/widget/:slug/passos {u, passo} — idempotente: clicar duas vezes não é erro. */
export async function widgetPassoEntendiHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const u = Number(b.u);
  const passo = typeof b.passo === 'string' ? b.passo.slice(0, 60) : '';
  if (!Number.isInteger(u) || u <= 0 || !/^[\w.-]+$/.test(passo)) {
    res.status(400).json({ error: 'u (usuário do Kommo) e passo são obrigatórios' });
    return;
  }
  await prisma.widgetPasso
    .create({ data: { unitId: unit.id, kommoUserId: u, passo } })
    .catch(() => undefined);   // unique: já tinha marcado, e isso é sucesso
  res.json({ ok: true });
}


// ── Sugestão do motivo do não agendamento pela IA (05/10/2026) ──
//
// A IA SUGERE, a SDR CONFIRMA (decisão do João). Só gasta IA quando a SDR clica em "Sugerir motivo". "Usar" grava
// o campo e registra sugerido × escolhido no log — é assim que se mede se a IA está ajudando. Regras e medição em
// `lib/sugestao-motivo.ts`.

const MODELO_SUGESTAO = 'claude-sonnet-5';
const CACHE_SUGESTAO_MS = 30 * 60_000;
const cacheSugestao = new Map<string, { em: number; corpo: unknown }>();
const cacheOpcoes = new Map<string, { em: number; campo: { id: number; enums: Array<{ id: number; value: string }> } | null }>();

async function campoDoMotivo(unit: Unit) {
  const c = cacheOpcoes.get(unit.id);
  if (c && Date.now() - c.em < 10 * 60_000) return c.campo;
  const campos = await createKommoClient(unit).listLeadCustomFieldsTyped();
  const f = campos.find((x) => x.name.trim() === CAMPO_MOTIVO_NAO_AGENDAMENTO) ?? null;
  const campo = f && f.enums.length ? { id: f.id, enums: f.enums } : null;
  cacheOpcoes.set(unit.id, { em: Date.now(), campo });
  return campo;
}

async function conversaOficial(unit: Unit, leadId: number): Promise<{ falas: FalaDaConversa[]; ultimaId: string }> {
  const kommo = createKommoClient(unit);
  const talks = (await kommo.listTalks(leadId)).slice(0, 5);
  const msgs: KommoTalkMessage[] = [];
  for (const t of talks) msgs.push(...(await kommo.listTalkMessages(Number((t as { talk_id?: number; id?: number }).talk_id ?? (t as { id?: number }).id), 100)));
  msgs.sort((a, b) => a.created_at - b.created_at);
  const falas: FalaDaConversa[] = [];
  let audios = 0;
  for (const m of msgs) {
    let texto = (m.text ?? '').replace(/\s+/g, ' ').trim();
    const anexo = m.attachment?.type;
    if (anexo === 'voice' && m.attachment?.link && audios < 6) {
      audios++;
      const t = await transcribeAudio(unit, m.attachment.link).catch(() => null);
      if (t?.text) texto = `${texto} (áudio) ${t.text}`.trim();
      else texto = `${texto} [áudio]`.trim();
    } else if (anexo) {
      texto = `${texto} [${anexo === 'picture' ? 'imagem' : anexo === 'file' ? 'arquivo' : anexo}]`.trim();
    }
    if (texto) falas.push({ autor: autorDaMensagem(m.author), texto: texto.slice(0, 600) });
  }
  return { falas, ultimaId: msgs.length ? String(msgs[msgs.length - 1].id) : 'vazia' };
}

/** GET /public/widget/:slug/sugestao-motivo?lead=<id> → { motivo, frase, travado, opcoes } */
export async function widgetSugestaoMotivoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  if (!automacaoLigada(unit.slug, 'sugestao-motivo', process.env.SUGESTAO_MOTIVO_SLUGS)) { res.status(404).json({ error: 'desligada nesta unidade' }); return; }
  const leadId = Number(req.query.lead);
  if (!Number.isInteger(leadId) || leadId <= 0) { res.status(400).json({ error: 'lead inválido' }); return; }
  const chave = unit.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!chave) { res.status(503).json({ error: 'unidade sem chave da IA' }); return; }
  try {
    const campo = await campoDoMotivo(unit);
    if (!campo) { res.status(404).json({ error: `a conta não tem o campo "${CAMPO_MOTIVO_NAO_AGENDAMENTO}"` }); return; }
    const opcoes = campo.enums.map((e) => e.value);
    const { falas, ultimaId } = await conversaOficial(unit, leadId);
    const k = `${unit.id}:${leadId}:${ultimaId}`;
    const c = cacheSugestao.get(k);
    if (c && Date.now() - c.em < CACHE_SUGESTAO_MS) { res.json(c.corpo); return; }
    if (cacheSugestao.size > 2_000) cacheSugestao.clear();

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODELO_SUGESTAO, max_tokens: 200, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: montarPrompt(falas, opcoes) }] }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await resp.json()) as { content?: Array<{ text?: string }>; error?: unknown };
    if (data.error) throw new Error(`Anthropic: ${JSON.stringify(data.error).slice(0, 160)}`);
    const sug = interpretarResposta((data.content ?? []).map((x) => x.text ?? '').join(''), falas, opcoes);
    const corpo = sug ? { ...sug, opcoes } : { motivo: null, frase: '', travado: false, opcoes };
    cacheSugestao.set(k, { em: Date.now(), corpo });
    logger.info({ unit: unit.slug, leadId, sugerido: sug?.motivo ?? null, travado: sug?.travado ?? false, falas: falas.length }, 'sugestao-motivo: sugerida');
    res.json(corpo);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'sugestao-motivo: falhou');
    res.status(502).json({ error: 'não consegui sugerir agora' });
  }
}

/** POST /public/widget/:slug/sugestao-motivo/usar { leadId, motivo, sugerido } → grava o campo e registra a escolha */
export async function widgetUsarMotivoHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res);
  if (!unit) return;
  if (!automacaoLigada(unit.slug, 'sugestao-motivo', process.env.SUGESTAO_MOTIVO_SLUGS)) { res.status(404).json({ error: 'desligada nesta unidade' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const leadId = Number(b.leadId);
  if (!Number.isInteger(leadId) || leadId <= 0) { res.status(400).json({ error: 'leadId inválido' }); return; }
  try {
    const campo = await campoDoMotivo(unit);
    if (!campo) { res.status(404).json({ error: 'campo não encontrado' }); return; }
    const opcao = campo.enums.find((e) => normalizar(e.value) === normalizar(String(b.motivo ?? '')));
    if (!opcao) { res.status(400).json({ error: 'motivo fora da lista da conta' }); return; }
    await createKommoClient(unit).setLeadCustomFieldValue(leadId, campo.id, 'select', opcao.value, campo.enums);
    const sugerido = typeof b.sugerido === 'string' ? b.sugerido.slice(0, 120) : null;
    logger.info({ unit: unit.slug, leadId, sugerido, escolhido: opcao.value, aceitou: !!sugerido && normalizar(sugerido) === normalizar(opcao.value) }, 'sugestao-motivo: usada');
    res.json({ ok: true, motivo: opcao.value });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'sugestao-motivo: falha ao gravar');
    res.status(502).json({ error: 'não consegui gravar no cartão' });
  }
}
