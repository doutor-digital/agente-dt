/**
 * Tela «Tarefas» do Chatwoot (18/11/2026): mensagem AGENDADA ao paciente, ligação com lembrete e lembrete simples, para as meninas da recepção. A página é
 * `lib/tarefas-pagina.ts` (menu do CRM e aba dentro da conversa); o robô que manda e lembra é `lib/crm-tarefas-worker.ts` (automação `chatwoot-tarefas`,
 * seco de fábrica). Aqui a tela funciona sempre — criar, listar, editar, cancelar, registrar o resultado da ligação —, em qualquer modo.
 *
 * TODAS as rotas pedem o LOGIN do Chatwoot (X-CW-*, credencial ANTES da conta, `?conta=N`) e que a pessoa atenda uma caixa da unidade pedida. Toda tarefa é
 * conferida contra a unidade E a conta da sessão: tarefa de outra clínica é «não encontrada».
 *
 *   GET  /api/public/tarefas?slug=                  a unidade, o modo do robô, as atendentes, as tarefas (abertas + feitas há pouco)
 *   GET  /api/public/tarefas/contexto?slug=&conversa=N | &contato=N   a conversa (caixa, janela de 24 h) para agendar
 *   GET  /api/public/tarefas/buscar?slug=&q=        procura contato por nome ou telefone
 *   GET  /api/public/tarefas/modelos?slug=&caixa=   os modelos APROVADOS da caixa
 *   POST /api/public/tarefas                        cria
 *   POST /api/public/tarefas/:id/editar|cancelar|confirmar|feita|resultado
 *   POST /api/public/tarefas/zap                    { slug, agenteId, telefone|null } — só administrador da Doutor Digital
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { CrmTarefa, Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { chamar, contaChatwootDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_HISTORICO, CAIXAS_REGUA, conversaDoChatwoot } from '../lib/chatwoot-regua.js';
import { caixasDaUnidade } from '../lib/robos-estado.js';
import { chatDoChatwoot } from '../lib/chatwoot-regua-worker.js';
import { caixaWhatsappOficial, modelosDaCaixa } from '../lib/disparo/chatwoot/canal.js';
import { ehAdministradorDD } from '../lib/disparo/chatwoot/ajuste.js';
import { ctxDaUnidadeNoCrm } from '../lib/disparo/chatwoot/onda.js';
import { conversaDoPublico } from '../lib/disparo/chatwoot/publico.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { comTeto } from '../lib/robos-automacoes.js';
import { paginaDasTarefas } from '../lib/tarefas-pagina.js';
import { modoDasTarefas } from '../lib/crm-tarefas-worker.js';
import {
  ESTADOS_ABERTOS,
  MAX_TEXTO,
  RESULTADOS,
  TIPOS,
  atrasoMaximoDaMensagemMs,
  grupoDaTarefa,
  janelaDeEnvio,
  janelaGarantida,
  localParaUtc,
  modeloAPartirDe,
  problemaNoPedido,
  proximaAbertura,
  telefoneDaMenina,
  telefoneMascarado,
  utcParaLocal,
  type Tipo,
} from '../lib/crm-tarefas/regras.js';
import { atendenteDaUnidade } from './aprendizados.controller.js';

const TETO_MS = 6_000;
const DEMOROU = 'o CRM demorou demais para responder — tente de novo em instantes';
const lerComTeto = <T>(p: Promise<T>, ms = TETO_MS): Promise<T | null> => comTeto<T | null>(p, ms, null, { propagarErro: true });

const slugDe = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const numeroDe = (v: unknown): number => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : NaN;
};
const idDe = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : '');

/** A página (iframe do menu do Chatwoot e aba da conversa). */
export function paginaTarefasHandler(_req: Request, res: Response): void {
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">CRM não configurado.</p>');
    return;
  }
  res.type('html').set('Cache-Control', 'no-store').send(paginaDasTarefas(new URL(conta.url).origin));
}

type Resolvida = { unit: Unit; conta: number; ctx: ContextoChatwoot; a: NonNullable<Awaited<ReturnType<typeof atendenteDaUnidade>>>['a']; email: string | null; nome: string; id: number; fuso: string };

async function resolver(req: Request, res: Response, slug: string): Promise<Resolvida | null> {
  const r = await atendenteDaUnidade(req, res, slug);
  if (!r) return null;
  const ctx = ctxDaUnidadeNoCrm(r.unit.slug);
  if (!ctx?.conta) {
    res.status(422).json({ error: 'esta unidade não tem conta válida no CRM' });
    return null;
  }
  if (!r.a.id) {
    res.status(422).json({ error: 'não consegui saber quem é você no CRM' });
    return null;
  }
  return { unit: r.unit, conta: ctx.conta.conta, ctx, a: r.a, email: r.a.email ?? null, nome: r.a.nome || 'atendente', id: r.a.id, fuso: fusoDaUnidade(r.unit) };
}

function recusaDoErro(e: unknown, oQue: string): { status: number; erro: string } {
  const status = (e as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return { status: 502, erro: 'o CRM recusou o acesso desta unidade (token caído ou sem permissão): avise a Doutor Digital' };
  return { status: 502, erro: `não consegui ${oQue} no CRM agora` };
}

// ── as atendentes da unidade ─────────────────────────────────────────────────────────────────────────────────

interface Atendente {
  id: number;
  nome: string;
}
const cacheDeAtendentes = new Map<string, { ate: number; v: Atendente[] }>();
const ehCelularDaUnidade = (nome: string): boolean => nome.trim().startsWith('📱');

/** Quem pode cuidar de uma tarefa: os membros das caixas da unidade (e, se não deu para ler, todas as atendentes da conta). Sem o «📱 Celular da unidade». */
async function atendentesDaUnidade(r: Resolvida): Promise<Atendente[]> {
  const k = `${r.conta}|${r.unit.slug}`;
  const feito = cacheDeAtendentes.get(k);
  if (feito && feito.ate > Date.now()) return feito.v;
  const lista = new Map<number, Atendente>();
  const pegar = (x: unknown): void => {
    const o = x as { id?: unknown; name?: unknown; available_name?: unknown } | null;
    const id = Number(o?.id);
    const nome = String(o?.name ?? o?.available_name ?? '').trim();
    if (Number.isInteger(id) && id > 0 && nome && !ehCelularDaUnidade(nome)) lista.set(id, { id, nome: nome.slice(0, 80) });
  };
  let leu = false;
  for (const caixa of caixasDaUnidade(r.unit.slug)) {
    try {
      const m = (await lerComTeto(chamar(r.ctx, 'GET', `inbox_members/${caixa}`))) as { payload?: unknown[] } | null;
      if (Array.isArray(m?.payload)) {
        leu = true;
        m.payload.forEach(pegar);
      }
    } catch {
      /* tenta a lista da conta abaixo */
    }
  }
  if (!leu || lista.size === 0) {
    const todas = (await lerComTeto(chamar(r.ctx, 'GET', 'agents'))) as unknown[] | null;
    if (Array.isArray(todas)) todas.forEach(pegar);
  }
  pegar({ id: r.id, name: r.nome });
  const v = [...lista.values()].sort((a, b) => a.nome.localeCompare(b.nome));
  cacheDeAtendentes.set(k, { ate: Date.now() + 60_000, v });
  return v;
}

/** Só para o teste. */
export const _esquecerAtendentes = (): void => cacheDeAtendentes.clear();

// ── a tarefa para a tela ─────────────────────────────────────────────────────────────────────────────────────

function paraATela(t: CrmTarefa, agora: Date, fuso: string, comZap: Set<number>, j = janelaDeEnvio()) {
  const tipo = t.tipo as Tipo;
  const sai = tipo === 'mensagem' ? proximaAbertura(t.quando, fuso, j) : t.quando;
  return {
    id: t.id,
    tipo,
    estado: t.estado,
    grupo: grupoDaTarefa(t, agora, fuso),
    conversaId: t.conversaId,
    caixa: t.caixa,
    contato: t.contatoNome,
    quando: t.quando.toISOString(),
    quandoLocal: utcParaLocal(t.quando, fuso),
    /** a mensagem só fala com o paciente dentro do horário: quando o horário combinado cai fora dele, aqui está quando vai sair */
    saiEm: sai.getTime() !== t.quando.getTime() ? sai.toISOString() : null,
    responsavel: { id: t.responsavelId, nome: t.responsavelNome, temZap: comZap.has(t.responsavelId) },
    texto: t.texto,
    modelo: t.modeloNome ? { nome: t.modeloNome, idioma: t.modeloIdioma ?? '', texto: t.modeloTexto ?? '', variaveis: t.modeloVariaveis } : null,
    motivo: t.motivo,
    simulado: t.simulado,
    lembreteEm: t.lembreteEm ? t.lembreteEm.toISOString() : null,
    lembreteResumo: t.lembreteResumo,
    enviadaEm: t.enviadaEm ? t.enviadaEm.toISOString() : null,
    resultado: t.resultado,
    resultadoPor: t.resultadoPor,
    criadoPor: t.criadoPor,
  };
}

const tarefaDaUnidade = (r: Resolvida, id: string) => (id ? prisma.crmTarefa.findFirst({ where: { id, unitId: r.unit.id, conta: r.conta } }) : Promise.resolve(null));

// ── a unidade e a lista ──────────────────────────────────────────────────────────────────────────────────────

export async function tarefasHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    const agora = new Date();
    const [abertas, recentes, zaps, atendentes] = await Promise.all([
      prisma.crmTarefa.findMany({ where: { unitId: r.unit.id, conta: r.conta, estado: { in: [...ESTADOS_ABERTOS] } }, orderBy: { quando: 'asc' }, take: 300 }),
      prisma.crmTarefa.findMany({ where: { unitId: r.unit.id, conta: r.conta, estado: { notIn: [...ESTADOS_ABERTOS] }, atualizadoEm: { gte: new Date(agora.getTime() - 14 * 86_400_000) } }, orderBy: { atualizadoEm: 'desc' }, take: 100 }),
      prisma.crmTarefaZap.findMany({ where: { conta: r.conta }, select: { agenteId: true, telefone: true } }),
      atendentesDaUnidade(r).catch(() => [] as Atendente[]),
    ]);
    const comZap = new Set(zaps.map((z) => z.agenteId));
    const j = janelaDeEnvio();
    res.set('Cache-Control', 'no-store').json({
      unidade: { slug: r.unit.slug, nome: r.unit.name },
      agora: agora.toISOString(),
      fuso: r.fuso,
      modo: modoDasTarefas(r.unit.slug),
      janela: { inicio: j.inicio, fim: j.fim },
      atrasoMaxMin: Math.round(atrasoMaximoDaMensagemMs() / 60_000),
      eu: { id: r.id, nome: r.nome },
      papel: r.a.papel ?? null,
      podeCadastrarZap: ehAdministradorDD(r.email),
      atendentes: atendentes.map((a) => ({ ...a, temZap: comZap.has(a.id), zap: ehAdministradorDD(r.email) ? telefoneMascarado(zaps.find((z) => z.agenteId === a.id)?.telefone ?? '') || null : null })),
      tarefas: [...abertas, ...recentes].map((t) => paraATela(t, agora, r.fuso, comZap, j)),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'tarefas: a unidade falhou');
    res.status(502).json({ error: 'não consegui ler as tarefas agora' });
  }
}

// ── contexto de uma conversa, busca de contato, modelos ──────────────────────────────────────────────────────

interface Alvo {
  conversaId: number;
  caixa: number;
  contatoId: number | null;
  nome: string;
}

type ErroHttp = { status: number; erro: string; extra?: Record<string, unknown> };

/** A conversa com o LOGIN da pessoa (se ela não enxerga, não agenda) e dentro das caixas desta unidade. */
async function lerAlvo(r: Resolvida, conversaId: number): Promise<Alvo | ErroHttp> {
  let raw: any;
  try {
    raw = await lerComTeto(chamar(r.a.c, 'GET', `conversations/${conversaId}`, { sessao: r.a.sessao }));
  } catch (e) {
    const s = (e as { status?: number })?.status;
    if (s === 401 || s === 403 || s === 404) return { status: 404, erro: 'você não tem acesso a esta conversa (ou ela não existe mais)' };
    return { status: 502, erro: 'não consegui ler a conversa no CRM agora' };
  }
  if (!raw) return { status: 504, erro: DEMOROU };
  const caixa = Number(raw?.inbox_id);
  if (CAIXAS_REGUA[caixa] !== r.unit.slug) return { status: 403, erro: 'esta conversa não é de uma caixa desta unidade' };
  if (CAIXAS_HISTORICO.has(caixa)) return { status: 422, erro: 'esta conversa é do histórico antigo do celular: não dá para agendar por ela' };
  const conv = conversaDoPublico(raw);
  if (!conv) return { status: 422, erro: 'esta conversa é de um grupo ou não tem contato: não dá para agendar' };
  return { conversaId, caixa, contatoId: conv.contatoId, nome: (conversaDoChatwoot(raw)?.nome || 'Contato').slice(0, 120) };
}

/** A conversa mais recente do contato dentro das caixas desta unidade. */
async function conversaDoContato(r: Resolvida, contatoId: number): Promise<Alvo | ErroHttp> {
  let lista: unknown;
  try {
    lista = await lerComTeto(chamar(r.a.c, 'GET', `contacts/${contatoId}/conversations`, { sessao: r.a.sessao }));
  } catch (e) {
    const s = (e as { status?: number })?.status;
    if (s === 401 || s === 403 || s === 404) return { status: 404, erro: 'contato não encontrado' };
    return { status: 502, erro: 'não consegui ler as conversas do contato no CRM agora' };
  }
  if (!lista) return { status: 504, erro: DEMOROU };
  const itens = Array.isArray((lista as { payload?: unknown[] })?.payload) ? ((lista as { payload: Array<{ id?: unknown; inbox_id?: unknown; last_activity_at?: unknown }> }).payload) : [];
  const daUnidade = itens
    .filter((c) => CAIXAS_REGUA[Number(c?.inbox_id)] === r.unit.slug && !CAIXAS_HISTORICO.has(Number(c?.inbox_id)) && Number.isInteger(Number(c?.id)))
    .sort((a, b) => (Number(b?.last_activity_at) || 0) - (Number(a?.last_activity_at) || 0));
  if (!daUnidade.length) return { status: 422, erro: 'este contato ainda não tem conversa nesta unidade: abra a conversa dele no CRM e agende por lá' };
  return lerAlvo(r, Number(daUnidade[0]!.id));
}

const ehErro = (x: Alvo | ErroHttp): x is ErroHttp => 'erro' in x;

export async function tarefasContextoHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  const conversa = numeroDe(req.query.conversa);
  const contato = numeroDe(req.query.contato);
  if (Number.isNaN(conversa) && Number.isNaN(contato)) {
    res.status(400).json({ error: 'diga a conversa ou o contato' });
    return;
  }
  const alvo = !Number.isNaN(conversa) ? await lerAlvo(r, conversa) : await conversaDoContato(r, contato);
  if (ehErro(alvo)) {
    res.status(alvo.status).json({ error: alvo.erro });
    return;
  }
  try {
    const oficial = await lerComTeto(caixaWhatsappOficial(r.ctx, alvo.caixa));
    if (!oficial) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    // sem a leitura (demorou) a última mensagem fica «desconhecida»: o lado SEGURO, que exige modelo
    const ultima = oficial.ok ? await lerComTeto(chatDoChatwoot(r.ctx).ultimaDoPaciente(alvo.conversaId)).catch(() => null) : null;
    const desde = oficial.ok ? modeloAPartirDe(ultima) : null;
    res.set('Cache-Control', 'no-store').json({
      conversaId: alvo.conversaId,
      caixa: alvo.caixa,
      contatoId: alvo.contatoId,
      nome: alvo.nome,
      oficial: oficial.ok,
      ultimaDoPaciente: ultima ? ultima.toISOString() : null,
      exigeModelo: oficial.ok,
      modeloAPartirDe: desde ? desde.toISOString() : null,
      abertas: await prisma.crmTarefa.count({ where: { unitId: r.unit.id, conta: r.conta, conversaId: alvo.conversaId, estado: { in: [...ESTADOS_ABERTOS] } } }),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'tarefas: contexto falhou');
    const m = recusaDoErro(e, 'ler a conversa');
    res.status(m.status).json({ error: m.erro });
  }
}

export async function tarefasBuscarHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  if (q.length < 2) {
    res.json({ contatos: [] });
    return;
  }
  try {
    const x = (await lerComTeto(chamar(r.a.c, 'GET', 'contacts/search', { sessao: r.a.sessao, query: { q, page: '1' } }))) as { payload?: unknown[] } | null;
    if (!x) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    const lista = Array.isArray(x.payload) ? (x.payload as Array<{ id?: unknown; name?: unknown; phone_number?: unknown }>) : [];
    res.set('Cache-Control', 'no-store').json({
      contatos: lista
        .map((c) => ({ id: Number(c?.id), nome: String(c?.name ?? '').trim().slice(0, 80), telefone: typeof c?.phone_number === 'string' ? telefoneMascarado(c.phone_number.replace(/\D/g, '')) : '' }))
        .filter((c) => Number.isInteger(c.id) && c.id > 0 && c.nome)
        .slice(0, 8),
    });
  } catch (e) {
    const m = recusaDoErro(e, 'procurar o contato');
    res.status(m.status).json({ error: m.erro });
  }
}

export async function tarefasModelosHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  const caixa = numeroDe(req.query.caixa);
  if (Number.isNaN(caixa) || !caixasDaUnidade(r.unit.slug).includes(caixa)) {
    res.status(404).json({ error: 'caixa não encontrada nesta unidade' });
    return;
  }
  try {
    const oficial = await lerComTeto(caixaWhatsappOficial(r.ctx, caixa));
    if (!oficial) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    if (!oficial.ok) {
      res.json({ modelos: [], motivo: oficial.motivo });
      return;
    }
    const modelos = await lerComTeto(modelosDaCaixa(r.ctx, caixa));
    if (!modelos) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    res.set('Cache-Control', 'no-store').json({ modelos: modelos.filter((m) => !m.problema).map((m) => ({ nome: m.nome, idioma: m.idioma, texto: m.texto, variaveis: m.variaveis, cabecalho: m.cabecalho, rodape: m.rodape, botoes: m.botoes })) });
  } catch (e) {
    const m = recusaDoErro(e, 'ler os modelos');
    res.status(m.status).json({ error: m.erro });
  }
}

// ── criar e editar ───────────────────────────────────────────────────────────────────────────────────────────

const modeloSchema = z.object({
  nome: z.string().min(1).max(512),
  idioma: z.string().min(2).max(12),
  /** "primeiroNome" | "unidade" | "texto:<literal>", um para cada {{n}} */
  variaveis: z.array(z.string().min(1).max(200)).max(10),
});
const camposSchema = z.object({
  slug: z.string(),
  tipo: z.enum(TIPOS),
  quandoLocal: z.string().min(10).max(20),
  responsavelId: z.number().int().positive().optional(),
  texto: z.string().max(MAX_TEXTO + 200).default(''),
  modelo: modeloSchema.nullable().optional(),
});
const criarSchema = camposSchema.extend({ conversaId: z.number().int().positive().optional(), contatoId: z.number().int().positive().optional() }).refine((c) => c.conversaId || c.contatoId, { message: 'diga a conversa ou o contato' });

type Campos = z.infer<typeof camposSchema>;
interface Dados {
  quando: Date;
  responsavelId: number;
  responsavelNome: string;
  texto: string;
  modeloNome: string | null;
  modeloIdioma: string | null;
  modeloTexto: string | null;
  modeloVariaveis: string[];
  aviso: string | null;
}

/** Tudo o que o servidor confere antes de gravar (criar e editar usam a mesma): horário, responsável, texto, modelo e a janela de 24 h. */
async function prepararDados(r: Resolvida, c: Campos, alvo: Alvo, agora: Date): Promise<Dados | ErroHttp> {
  const quando = localParaUtc(c.quandoLocal, r.fuso);
  if (!quando) return { status: 400, erro: 'escolha o dia e a hora' };
  if (quando.getTime() < agora.getTime() - 2 * 60_000) return { status: 400, erro: 'esse horário já passou: escolha um horário daqui para frente' };
  if (quando.getTime() > agora.getTime() + 366 * 86_400_000) return { status: 400, erro: 'o horário passa de um ano: escolha uma data mais perto' };

  const atendentes = await atendentesDaUnidade(r).catch(() => [] as Atendente[]);
  const responsavelId = c.responsavelId ?? r.id;
  const resp = atendentes.find((a) => a.id === responsavelId);
  if (!resp) return { status: 422, erro: 'essa pessoa não atende esta unidade' };

  const texto = c.texto.trim();
  let modelo: Campos['modelo'] = c.modelo ?? null;
  let modeloTexto: string | null = null;
  let aviso: string | null = null;
  if (c.tipo === 'mensagem') {
    let oficial: Awaited<ReturnType<typeof caixaWhatsappOficial>> | null;
    try {
      oficial = await lerComTeto(caixaWhatsappOficial(r.ctx, alvo.caixa));
    } catch (e) {
      return { status: 502, erro: recusaDoErro(e, 'ler a caixa').erro };
    }
    if (!oficial) return { status: 504, erro: DEMOROU };
    if (modelo) {
      if (!oficial.ok) return { status: 422, erro: 'modelo só vale em caixa de WhatsApp oficial: esta caixa manda só texto' };
      // o texto do modelo vem do CRM agora, nunca do navegador
      let doCrm: Awaited<ReturnType<typeof modelosDaCaixa>> | null;
      try {
        doCrm = await lerComTeto(modelosDaCaixa(r.ctx, alvo.caixa));
      } catch (e) {
        return { status: 502, erro: recusaDoErro(e, 'ler os modelos').erro };
      }
      if (!doCrm) return { status: 504, erro: DEMOROU };
      const m = doCrm.find((x) => x.nome === modelo!.nome && x.idioma === modelo!.idioma);
      if (!m) return { status: 422, erro: 'esse modelo não está aprovado nesta caixa' };
      if (m.problema) return { status: 422, erro: m.problema };
      modeloTexto = m.texto;
    }
    const pedido = { tipo: c.tipo, texto, modelo: modelo ? { nome: modelo.nome, idioma: modelo.idioma, texto: modeloTexto ?? '', variaveis: modelo.variaveis } : null };
    const problema = problemaNoPedido(pedido, alvo.nome);
    if (problema) return { status: 422, erro: problema };
    if (oficial.ok && !modelo) {
      // a janela de 24 h só é garantida se o paciente escreveu há pouco: senão a tela OBRIGA o modelo
      let ultima: Date | null = null;
      try {
        ultima = (await lerComTeto(chatDoChatwoot(r.ctx).ultimaDoPaciente(alvo.conversaId))) ?? null;
      } catch {
        ultima = null;
      }
      if (!janelaGarantida(ultima, quando, true)) {
        return { status: 422, erro: 'Nesse horário a janela de 24 h do WhatsApp pode estar fechada e o texto livre não chegaria. Escolha um modelo aprovado: ele é o que sai se a janela fechar.', extra: { exigeModelo: true } };
      }
    }
    const abre = proximaAbertura(quando, r.fuso, janelaDeEnvio());
    if (abre.getTime() !== quando.getTime()) aviso = 'Esse horário é fora de 8h–20h: a mensagem só sai quando o horário de falar com o paciente abrir.';
  } else {
    // ligação e lembrete não usam modelo: pedir um é erro (não some calado)
    const problema = problemaNoPedido({ tipo: c.tipo, texto, modelo: modelo ? { nome: modelo.nome, idioma: modelo.idioma, texto: '', variaveis: modelo.variaveis } : null }, alvo.nome);
    if (problema) return { status: 422, erro: problema };
  }
  return {
    quando,
    responsavelId: resp.id,
    responsavelNome: resp.nome,
    texto,
    modeloNome: modelo ? modelo.nome : null,
    modeloIdioma: modelo ? modelo.idioma : null,
    modeloTexto,
    modeloVariaveis: modelo ? modelo.variaveis : [],
    aviso,
  };
}

const MAX_ABERTAS_POR_CONVERSA = 20;

export async function tarefasCriarHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe((req.body as { slug?: unknown } | undefined)?.slug));
  if (!r) return;
  const p = criarSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido (confira o tipo, o horário e a conversa)' });
    return;
  }
  const alvo = p.data.conversaId ? await lerAlvo(r, p.data.conversaId) : await conversaDoContato(r, p.data.contatoId!);
  if (ehErro(alvo)) {
    res.status(alvo.status).json({ error: alvo.erro });
    return;
  }
  const agora = new Date();
  const d = await prepararDados(r, p.data, alvo, agora);
  if ('erro' in d) {
    res.status(d.status).json({ error: d.erro, ...(d.extra ?? {}) });
    return;
  }
  // o mesmo pedido duas vezes (toque duplo, rede lenta) não vira duas tarefas
  const igual = await prisma.crmTarefa.findFirst({
    where: { unitId: r.unit.id, conta: r.conta, conversaId: alvo.conversaId, tipo: p.data.tipo, estado: { in: [...ESTADOS_ABERTOS] }, quando: d.quando, texto: d.texto, modeloNome: d.modeloNome, responsavelId: d.responsavelId },
    select: { id: true },
  });
  if (igual) {
    res.json({ ok: true, id: igual.id, repetida: true, aviso: d.aviso });
    return;
  }
  const abertas = await prisma.crmTarefa.count({ where: { unitId: r.unit.id, conta: r.conta, conversaId: alvo.conversaId, estado: { in: [...ESTADOS_ABERTOS] } } });
  if (abertas >= MAX_ABERTAS_POR_CONVERSA) {
    res.status(422).json({ error: `esta conversa já tem ${MAX_ABERTAS_POR_CONVERSA} tarefas abertas: conclua ou cancele alguma antes` });
    return;
  }
  const t = await prisma.crmTarefa.create({
    data: {
      unitId: r.unit.id,
      conta: r.conta,
      caixa: alvo.caixa,
      conversaId: alvo.conversaId,
      contatoId: alvo.contatoId,
      contatoNome: alvo.nome,
      tipo: p.data.tipo,
      quando: d.quando,
      responsavelId: d.responsavelId,
      responsavelNome: d.responsavelNome,
      texto: d.texto,
      modeloNome: d.modeloNome,
      modeloIdioma: d.modeloIdioma,
      modeloTexto: d.modeloTexto,
      modeloVariaveis: d.modeloVariaveis,
      criadoPor: (r.email ?? r.nome).slice(0, 120),
    },
  });
  logger.info({ unit: r.unit.slug, tarefa: t.id, tipo: t.tipo, por: r.email ?? r.nome }, 'tarefas: criada pela tela');
  res.json({ ok: true, id: t.id, aviso: d.aviso });
}

export async function tarefasEditarHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe((req.body as { slug?: unknown } | undefined)?.slug));
  if (!r) return;
  const t = await tarefaDaUnidade(r, idDe(req.params.id));
  if (!t) {
    res.status(404).json({ error: 'tarefa não encontrada' });
    return;
  }
  const p = camposSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido (confira o tipo e o horário)' });
    return;
  }
  if (t.estado !== 'pendente' && t.estado !== 'aguardando') {
    res.status(409).json({ error: t.estado === 'enviando' ? 'a mensagem está saindo agora: espere alguns segundos' : 'esta tarefa já terminou: crie outra' });
    return;
  }
  if (p.data.tipo !== t.tipo) {
    res.status(400).json({ error: 'não dá para trocar o tipo da tarefa: cancele e crie outra' });
    return;
  }
  const alvo: Alvo = { conversaId: t.conversaId, caixa: t.caixa, contatoId: t.contatoId, nome: t.contatoNome };
  const d = await prepararDados(r, p.data, alvo, new Date());
  if ('erro' in d) {
    res.status(d.status).json({ error: d.erro, ...(d.extra ?? {}) });
    return;
  }
  // só edita enquanto ainda está parada (o robô pode ter pego no meio)
  const mexeu = await prisma.crmTarefa.updateMany({
    where: { id: t.id, estado: { in: ['pendente', 'aguardando'] } },
    data: {
      quando: d.quando,
      responsavelId: d.responsavelId,
      responsavelNome: d.responsavelNome,
      texto: d.texto,
      modeloNome: d.modeloNome,
      modeloIdioma: d.modeloIdioma,
      modeloTexto: d.modeloTexto,
      modeloVariaveis: d.modeloVariaveis,
      // mudou o combinado: o robô decide de novo, lembra de novo e a confirmação de atraso não vale mais
      estado: 'pendente',
      motivo: null,
      simuladoEm: null,
      simulado: null,
      lembreteEm: null,
      lembreteResumo: null,
      confirmadaEm: null,
      tentativas: 0,
    },
  });
  if (mexeu.count !== 1) {
    res.status(409).json({ error: 'a tarefa mudou enquanto você editava: abra de novo' });
    return;
  }
  res.json({ ok: true, aviso: d.aviso });
}

// ── cancelar, confirmar, feita, resultado ────────────────────────────────────────────────────────────────────

/** Muda o estado só se a tarefa ainda está num dos estados esperados (o robô pode ter agido no meio). */
async function mudar(res: Response, r: Resolvida, t: CrmTarefa, de: string[], dados: Record<string, unknown>, quando409: string): Promise<boolean> {
  const x = await prisma.crmTarefa.updateMany({ where: { id: t.id, unitId: r.unit.id, conta: r.conta, estado: { in: de } }, data: dados });
  if (x.count !== 1) {
    res.status(409).json({ error: quando409 });
    return false;
  }
  return true;
}
const por = (r: Resolvida): string => (r.email ?? r.nome).slice(0, 120);

async function daTarefa(req: Request, res: Response): Promise<{ r: Resolvida; t: CrmTarefa } | null> {
  const r = await resolver(req, res, slugDe((req.body as { slug?: unknown } | undefined)?.slug));
  if (!r) return null;
  const t = await tarefaDaUnidade(r, idDe(req.params.id));
  if (!t) {
    res.status(404).json({ error: 'tarefa não encontrada' });
    return null;
  }
  return { r, t };
}

export async function tarefasCancelarHandler(req: Request, res: Response): Promise<void> {
  const x = await daTarefa(req, res);
  if (!x) return;
  if (x.t.estado === 'enviando') {
    res.status(409).json({ error: 'a mensagem está saindo agora: espere alguns segundos' });
    return;
  }
  if (!(await mudar(res, x.r, x.t, ['pendente', 'aguardando'], { estado: 'cancelada', motivo: `cancelada por ${x.r.nome}` }, 'esta tarefa já terminou'))) return;
  res.json({ ok: true });
}

/** Tarefa atrasada demais que o robô segurou: a menina diz que AINDA quer. O atraso passa a contar daqui. */
export async function tarefasConfirmarHandler(req: Request, res: Response): Promise<void> {
  const x = await daTarefa(req, res);
  if (!x) return;
  if (x.t.estado !== 'aguardando') {
    res.status(409).json({ error: 'esta tarefa não está esperando confirmação' });
    return;
  }
  if (!(await mudar(res, x.r, x.t, ['aguardando'], { estado: 'pendente', motivo: null, confirmadaEm: new Date(), simuladoEm: null, simulado: null, tentativas: 0 }, 'a tarefa mudou: abra de novo'))) return;
  logger.warn({ unit: x.r.unit.slug, tarefa: x.t.id, por: por(x.r) }, 'tarefas: atraso confirmado pela atendente');
  res.json({ ok: true });
}

/** «Já fiz»: a menina fez por fora (mandou do celular, ligou). */
export async function tarefasFeitaHandler(req: Request, res: Response): Promise<void> {
  const x = await daTarefa(req, res);
  if (!x) return;
  if (x.t.estado === 'enviando') {
    res.status(409).json({ error: 'a mensagem está saindo agora: espere alguns segundos' });
    return;
  }
  if (!(await mudar(res, x.r, x.t, ['pendente', 'aguardando'], { estado: 'feita', motivo: `feita por ${x.r.nome}`, resultadoPor: por(x.r), resultadoEm: new Date() }, 'esta tarefa já terminou'))) return;
  res.json({ ok: true });
}

const resultadoSchema = z.object({
  slug: z.string(),
  resultado: z.enum(RESULTADOS),
  /** a próxima tentativa (obrigatória em «remarcar»; opcional em «não atendeu») */
  proximaLocal: z.string().min(10).max(20).nullable().optional(),
});

/** O resultado da ligação. «Não atendeu» pode já criar a próxima tentativa; «remarcar» exige o novo horário. */
export async function tarefasResultadoHandler(req: Request, res: Response): Promise<void> {
  const x = await daTarefa(req, res);
  if (!x) return;
  const { r, t } = x;
  const p = resultadoSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'diga o resultado: atendeu, não atendeu ou remarcar' });
    return;
  }
  if (t.tipo !== 'ligacao') {
    res.status(400).json({ error: 'só ligação tem resultado' });
    return;
  }
  if (p.data.resultado === 'remarcar' && !p.data.proximaLocal) {
    res.status(400).json({ error: 'para remarcar, escolha o novo dia e hora' });
    return;
  }
  let proxima: Date | null = null;
  if (p.data.proximaLocal) {
    proxima = localParaUtc(p.data.proximaLocal, r.fuso);
    if (!proxima || proxima.getTime() < Date.now() - 2 * 60_000) {
      res.status(400).json({ error: 'escolha um dia e hora daqui para frente para a próxima ligação' });
      return;
    }
  }
  const agora = new Date();
  if (!(await mudar(res, r, t, ['pendente', 'aguardando'], { estado: 'feita', resultado: p.data.resultado, resultadoEm: agora, resultadoPor: por(r), motivo: null }, 'esta ligação já tem resultado'))) return;
  let proximaId: string | null = null;
  if (proxima) {
    const n = await prisma.crmTarefa.create({
      data: {
        unitId: t.unitId, conta: t.conta, caixa: t.caixa, conversaId: t.conversaId, contatoId: t.contatoId, contatoNome: t.contatoNome, tipo: 'ligacao', quando: proxima,
        responsavelId: t.responsavelId, responsavelNome: t.responsavelNome, texto: t.texto, criadoPor: por(r),
      },
    });
    proximaId = n.id;
  }
  logger.info({ unit: r.unit.slug, tarefa: t.id, resultado: p.data.resultado, proxima: proximaId }, 'tarefas: resultado da ligação');
  res.json({ ok: true, proximaId });
}

// ── o WhatsApp das meninas ───────────────────────────────────────────────────────────────────────────────────

export async function tarefasZapHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; agenteId?: unknown; telefone?: unknown };
  const r = await resolver(req, res, slugDe(corpo.slug));
  if (!r) return;
  if (!ehAdministradorDD(r.email)) {
    res.status(403).json({ error: 'só a administração da Doutor Digital cadastra o WhatsApp das atendentes' });
    return;
  }
  const agenteId = typeof corpo.agenteId === 'number' ? corpo.agenteId : NaN;
  if (!Number.isInteger(agenteId) || agenteId <= 0) {
    res.status(400).json({ error: 'escolha a atendente' });
    return;
  }
  const a = (await atendentesDaUnidade(r).catch(() => [] as Atendente[])).find((x) => x.id === agenteId);
  if (!a) {
    res.status(404).json({ error: 'essa pessoa não atende esta unidade' });
    return;
  }
  if (corpo.telefone === null || corpo.telefone === '') {
    await prisma.crmTarefaZap.deleteMany({ where: { conta: r.conta, agenteId } });
    logger.warn({ unit: r.unit.slug, agente: agenteId, por: r.email }, 'tarefas: WhatsApp da atendente removido');
    res.json({ ok: true, removido: true });
    return;
  }
  const tel = telefoneDaMenina(corpo.telefone);
  if (!tel) {
    res.status(400).json({ error: 'telefone inválido: DDD e número, só dígitos (ex.: 94 99999-0000)' });
    return;
  }
  await prisma.crmTarefaZap.upsert({
    where: { conta_agenteId: { conta: r.conta, agenteId } },
    create: { conta: r.conta, agenteId, agenteNome: a.nome, telefone: tel, atualizadoPor: (r.email ?? r.nome).slice(0, 120) },
    update: { agenteNome: a.nome, telefone: tel, atualizadoPor: (r.email ?? r.nome).slice(0, 120) },
  });
  logger.warn({ unit: r.unit.slug, agente: agenteId, por: r.email }, 'tarefas: WhatsApp da atendente cadastrado');
  res.json({ ok: true, final: telefoneMascarado(tel) });
}
