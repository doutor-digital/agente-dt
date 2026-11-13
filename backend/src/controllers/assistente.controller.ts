/**
 * Assistente em tempo real da atendente no Chatwoot — as rotas (a lógica está em `lib/chatwoot-assistente.ts`, a tela em
 * `lib/chatwoot-assistente-ui.ts`). Versão 1: só LÊ e sugere. Nada é enviado ao paciente, nada é gravado no Chatwoot ou no Kommo.
 *   GET  /assistente                              a página do painel (iframe do botão que entra pelo `menu.js`)
 *   GET  /api/public/assistente/estado            { ligada } — o botão só aparece se for true
 *   POST /api/public/assistente/sugerir           { conversaId } — uma resposta proposta, para a atendente revisar
 *   POST /api/public/assistente/perguntar         { pergunta, conversaId?, historico? } — tirar dúvida
 *
 * Segurança (mesmo esquema do funil): só o login do Chatwoot da PRÓPRIA pessoa (X-CW-Token/Client/Uid), conferido no /profile;
 * a conversa e as caixas são lidas COM esse login, então ela só alcança o que já vê no Chatwoot. Sem login = 401. A unidade
 * vem da caixa da conversa (`CAIXAS_REGUA`), nunca do pedido. Teto de chamadas ao modelo por pessoa por dia, em memória.
 * Desligada por padrão: só vale para as unidades de `CHATWOOT_ASSISTENTE_SLUGS` (lista separada por vírgula, ou `*`).
 */
import { estadoDaPausa, pausar, portaDaPausaDoChatwoot, reativar } from '../lib/chatwoot-pausa.js';
import { avaliacaoMuda, bancoDeAvaliacoes, ehNota, limparTextoDaAvaliacao } from '../lib/sofia-avaliacoes.js';
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import type { SessaoChatwoot } from '../lib/funil-chatwoot.js';
import { conversaLidaDoChatwoot, type ConversaLida } from '../lib/chatwoot-porta.js';
import { CAIXAS_REGUA } from '../lib/chatwoot-regua.js';
import { diaEmBelem } from '../lib/chatwoot-hoje.js';
import { gradeDoDia, hojeLocal } from '../agent/agenda-tools.js';
import { travaDaAgendaDaIa } from '../lib/crm-compartilhado.js';
import { rodarTesteDaSofia } from './playground.controller.js';
import { paginaDaAssistente } from '../lib/chatwoot-assistente-ui.js';
import { sessaoDaAtendente, type Atendente } from './funil.controller.js';
import {
  artigosPublicados,
  criarTeto,
  linhasDaConversa,
  sugerirResposta,
  tirarDuvida,
  type Artigo,
  type DepsDaAssistente,
  type LinhaDaConversa,
  type ResultadoDaAssistente,
  type Teto,
} from '../lib/chatwoot-assistente.js';

// ── o Chatwoot, SÓ LEITURA, com o login da atendente ───────────────────────────────────────────────

export interface PortaDeLeitura {
  /** A conversa e a caixa dela. LANÇA (com `status`) se o Chatwoot recusar: ela não vê esta conversa. */
  conversa(id: number): Promise<{ lida: ConversaLida; caixa: number | null }>;
  /** As mensagens da conversa (payload cru do Chatwoot). */
  mensagens(id: number): Promise<unknown>;
  /** Os ids das caixas que ELA vê. */
  caixas(): Promise<number[]>;
}

const MENSAGENS_POR_PAGINA = 20;
const MENSAGENS_PAGINAS = 2;

export function leituraComLogin(c: ContextoChatwoot, sessao: SessaoChatwoot): PortaDeLeitura {
  return {
    async conversa(id) {
      const raw = (await chamar(c, 'GET', `conversations/${id}`, { sessao })) as { inbox_id?: unknown } | null;
      const lida = conversaLidaDoChatwoot(raw);
      if (!lida) throw Object.assign(new Error('conversa não encontrada'), { status: 404 });
      const caixa = Number(raw?.inbox_id);
      return { lida, caixa: Number.isInteger(caixa) && caixa > 0 ? caixa : null };
    },
    // O Chatwoot devolve as 20 mais recentes por vez; `before` pede as anteriores a uma mensagem. Até 2 páginas (40), para a
    // queixa, a cidade e o horário que o paciente deu no começo não ficarem de fora numa conversa longa.
    async mensagens(id) {
      let todas: unknown[] = [];
      let antes: string | undefined;
      for (let pagina = 0; pagina < MENSAGENS_PAGINAS; pagina++) {
        const r = (await chamar(c, 'GET', `conversations/${id}/messages`, { sessao, query: antes ? { before: antes } : {} })) as { payload?: unknown } | null;
        const lote = Array.isArray(r?.payload) ? r!.payload : [];
        todas = [...lote, ...todas];
        const menor = Math.min(...lote.map((m: any) => Number(m?.id)).filter((n: number) => Number.isInteger(n) && n > 0));
        if (lote.length < MENSAGENS_POR_PAGINA || !Number.isFinite(menor)) break;
        antes = String(menor);
      }
      return { payload: todas };
    },
    async caixas() {
      const r = (await chamar(c, 'GET', 'inboxes', { sessao })) as { payload?: unknown } | null;
      return (Array.isArray(r?.payload) ? r!.payload : []).map((i: any) => Number(i?.id)).filter((n: number) => Number.isInteger(n) && n > 0);
    },
  };
}

// ── Central de Ajuda (portal `ajuda`), lida com o token da conta: é conteúdo de ajuda, não conversa de paciente ──

const PORTAL_AJUDA = 'ajuda';
const AJUDA_VALE_MS = 10 * 60_000;
const AJUDA_MAX_PAGINAS = 4;
const AJUDA_FALHA_VALE_MS = 60_000;

export function ajudaDoPortal(c: ContextoChatwoot): () => Promise<Artigo[]> {
  let cache: { em: number; artigos: Artigo[] } | null = null;
  let lendo: Promise<Artigo[]> | null = null;
  let falhou: { em: number; erro: unknown } | null = null;
  const ler = async (): Promise<Artigo[]> => {
    const vistos = new Map<number, Artigo>();
    for (let pagina = 1; pagina <= AJUDA_MAX_PAGINAS; pagina++) {
      const r = await chamar(c, 'GET', `portals/${PORTAL_AJUDA}/articles`, { query: { page: String(pagina) } });
      const novos = artigosPublicados(r).filter((a) => !vistos.has(a.id));
      if (!novos.length) break; // acabou (ou o Chatwoot repetiu a mesma página)
      novos.forEach((a) => vistos.set(a.id, a));
    }
    return [...vistos.values()];
  };
  return async () => {
    if (cache && Date.now() - cache.em < AJUDA_VALE_MS) return cache.artigos;
    // portal fora do ar: não refaz 4 chamadas de 60 s a cada pergunta; a falha vale por 1 minuto (e a pergunta SABE que falhou)
    if (falhou && Date.now() - falhou.em < AJUDA_FALHA_VALE_MS) throw falhou.erro;
    lendo ??= ler()
      .then((artigos) => {
        cache = { em: Date.now(), artigos };
        falhou = null;
        return artigos;
      })
      .catch((erro) => {
        falhou = { em: Date.now(), erro };
        throw erro;
      })
      .finally(() => {
        lendo = null;
      });
    return lendo;
  };
}

// ── quem está ligado ───────────────────────────────────────────────────────────────────────────────

export function assistenteLigadaPara(slug: string, lista = process.env.CHATWOOT_ASSISTENTE_SLUGS): boolean {
  const slugs = (lista ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return slugs.includes('*') || slugs.includes(slug);
}

// ── os handlers ────────────────────────────────────────────────────────────────────────────────────

export interface DepsDosHandlers {
  autenticar: (req: Request, res: Response) => Promise<Pick<Atendente, 'nome' | 'id' | 'sessao'> & { leitura: PortaDeLeitura } | null>;
  unidade: (slug: string) => Promise<Unit | null>;
  assistente: DepsDaAssistente;
  teto: Teto;
  /** o dia (AAAA-MM-DD, Belém) em que o teto conta */
  dia: () => string;
  ligadaPara: (slug: string) => boolean;
}

const sugerirSchema = z.object({ conversaId: z.number().int().positive() });
const perguntarSchema = z.object({
  pergunta: z.string().trim().min(2).max(1000),
  conversaId: z.number().int().positive().nullish(),
  historico: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(3000) }))
    .max(10)
    .optional(),
});

const statusDoErro = (e: unknown): number | undefined => (e as { status?: number })?.status;

type Resolvida = { ok: true; unit: Unit; linhas: LinhaDaConversa[]; lida: ConversaLida | null } | { ok: false; status: number; error: string };

export function criarHandlersDoAssistente(d: DepsDosHandlers) {
  /**
   * Qual unidade vale: a da caixa da conversa (lida com o login dela) ou, sem conversa, a única ligada entre as caixas que ela vê.
   * `sugerir` PRECISA da conversa (e da unidade dela). `perguntar` usa a conversa só como contexto: se a caixa dela não tem a
   * assistente, a dúvida ("como marco perdido?") ainda vale, e cai para as caixas que ela vê.
   */
  async function resolver(quem: { leitura: PortaDeLeitura }, conversaId: number | null | undefined, modo: 'sugerir' | 'perguntar'): Promise<Resolvida> {
    if (conversaId) {
      let c: Awaited<ReturnType<PortaDeLeitura['conversa']>> | null;
      try {
        c = await quem.leitura.conversa(conversaId);
      } catch (e) {
        if (![401, 403, 404].includes(statusDoErro(e) ?? 0)) throw e;
        // o Chatwoot nega com 401 (sem permissão), 403 ou 404 (não existe): para SUGERIR é recusa; a DÚVIDA não depende da conversa
        if (modo === 'sugerir') return { ok: false, status: 403, error: 'você não tem acesso a esta conversa (ou ela não existe mais)' };
        c = null;
      }
      const slug = c?.caixa ? CAIXAS_REGUA[c.caixa] : undefined;
      const unit = c && slug && d.ligadaPara(slug) ? await d.unidade(slug) : null;
      if (c && unit) {
        const linhas = !c.lida.interno && !c.lida.grupo ? linhasDaConversa(await quem.leitura.mensagens(conversaId)) : [];
        return { ok: true, unit, linhas, lida: c.lida };
      }
      if (modo === 'sugerir') {
        return { ok: false, status: 422, error: slug ? 'a assistente ainda não está ligada para esta unidade' : 'a assistente ainda não atende a caixa desta conversa' };
      }
    }
    const slugs = [...new Set((await quem.leitura.caixas()).map((c) => CAIXAS_REGUA[c]).filter((s): s is string => !!s && d.ligadaPara(s)))];
    if (slugs.length !== 1) {
      return { ok: false, status: 422, error: slugs.length ? 'abra uma conversa para eu saber de qual unidade você fala' : 'a assistente ainda não está ligada para as suas caixas' };
    }
    const unit = await d.unidade(slugs[0]!);
    if (!unit) return { ok: false, status: 422, error: 'não achei a unidade' };
    return { ok: true, unit, linhas: [], lida: null };
  }

  /** Gasta uma chamada do dia da pessoa e devolve a chave dela (para devolver depois); se acabou, responde 429 e devolve null. */
  function gastar(quem: Pick<Atendente, 'id' | 'sessao'>, res: Response): string | null {
    const chave = String(quem.id ?? quem.sessao.uid);
    const dia = d.dia();
    if (!d.teto.gastar(chave, dia).ok) {
      res.status(429).json({ error: 'você já usou todas as perguntas de hoje à assistente — volte amanhã ou peça à gerente' });
      return null;
    }
    return chave;
  }

  /** Quem já usou tudo hoje nem chega a ler a conversa no Chatwoot. */
  function esgotou(quem: Pick<Atendente, 'id' | 'sessao'>, res: Response): boolean {
    if (!d.teto.esgotado(String(quem.id ?? quem.sessao.uid), d.dia())) return false;
    res.status(429).json({ error: 'você já usou todas as perguntas de hoje à assistente — volte amanhã ou peça à gerente' });
    return true;
  }

  /** Falha ao LER o Chatwoot (antes de gastar o modelo). 401 aqui = o login dela venceu. */
  const falhaGeral = (res: Response, e: unknown, acao: string, extra: Record<string, unknown>) => {
    // nunca o conteúdo do paciente: só o erro e onde
    logger.warn({ err: String(e).slice(0, 300), acao, ...extra }, 'assistente: falhou');
    if (statusDoErro(e) === 401) res.status(401).json({ error: 'entre no Chatwoot de novo (sessão expirada)', sessao: 'invalida' });
    else res.status(502).json({ error: 'não consegui falar com o Chatwoot agora' });
  };

  return {
    async estado(req: Request, res: Response): Promise<void> {
      const quem = await d.autenticar(req, res);
      if (!quem) return;
      try {
        const slugs = (await quem.leitura.caixas()).map((c) => CAIXAS_REGUA[c]).filter((s): s is string => !!s && d.ligadaPara(s));
        res.json({ ligada: slugs.length > 0 });
      } catch (e) {
        falhaGeral(res, e, 'estado', {});
      }
    },

    async sugerir(req: Request, res: Response): Promise<void> {
      const quem = await d.autenticar(req, res);
      if (!quem) return;
      const p = sugerirSchema.safeParse(req.body);
      if (!p.success) {
        res.status(400).json({ error: 'conversa inválida' });
        return;
      }
      if (esgotou(quem, res)) return;
      const t0 = Date.now();
      try {
        const r = await resolver(quem, p.data.conversaId, 'sugerir');
        if (!r.ok) {
          res.status(r.status).json({ error: r.error });
          return;
        }
        // contato interno (a equipe falando com o número da unidade) e grupo não são paciente: sem sugestão, sem gastar modelo
        if (r.lida?.interno || r.lida?.grupo) {
          res.json({
            semSugestao: r.lida.interno ? 'interno' : 'grupo',
            aviso: r.lida.interno
              ? 'Esta conversa tem a etiqueta "interno" (a equipe falando com o número da unidade). Não é um paciente, então não sugiro resposta.'
              : 'Esta conversa é um grupo, não um paciente. Não sugiro resposta.',
          });
          return;
        }
        if (!r.linhas.length) {
          res.json({ semSugestao: 'vazia', aviso: 'Esta conversa ainda não tem mensagens para eu ler.' });
          return;
        }
        const chave = gastar(quem, res);
        if (!chave) return;
        const out = await comModelo(chave, 'sugerir', r.unit, p.data.conversaId, () => sugerirResposta(d.assistente, { unit: r.unit, linhas: r.linhas, nomeDoPaciente: r.lida?.nome ?? '' }));
        responder(res, out, chave, 'sugerir', r.unit, p.data.conversaId, t0, (o) => ({ sugestao: o.texto, nota: o.nota, avisos: o.avisos, fontes: o.fontes }));
      } catch (e) {
        falhaGeral(res, e, 'sugerir', { conversa: p.data.conversaId });
      }
    },

    async perguntar(req: Request, res: Response): Promise<void> {
      const quem = await d.autenticar(req, res);
      if (!quem) return;
      const p = perguntarSchema.safeParse(req.body);
      if (!p.success) {
        res.status(400).json({ error: 'escreva a sua dúvida (até 1000 letras)' });
        return;
      }
      if (esgotou(quem, res)) return;
      const t0 = Date.now();
      try {
        const r = await resolver(quem, p.data.conversaId, 'perguntar');
        if (!r.ok) {
          res.status(r.status).json({ error: r.error });
          return;
        }
        const chave = gastar(quem, res);
        if (!chave) return;
        // a conversa de antes entra de cabeça para baixo se começar por fala da assistente: o modelo exige começar pela pessoa
        const antes = (p.data.historico ?? []).slice(-8);
        while (antes.length && antes[0]!.role !== 'user') antes.shift();
        const out = await comModelo(chave, 'perguntar', r.unit, p.data.conversaId ?? null, () => tirarDuvida(d.assistente, { unit: r.unit, falas: [...antes, { role: 'user', content: p.data.pergunta }], linhas: r.linhas }));
        responder(res, out, chave, 'perguntar', r.unit, p.data.conversaId ?? null, t0, (o) => ({ resposta: o.texto, fontes: o.fontes }));
      } catch (e) {
        falhaGeral(res, e, 'perguntar', { conversa: p.data.conversaId ?? null });
      }
    },
  };

  /** O modelo (ou o que ele usa: banco, base de conhecimento) lançou: a pessoa não perde a chamada e a culpa não é do Chatwoot. */
  async function comModelo(chave: string, acao: string, unit: Unit, conversa: number | null, f: () => Promise<ResultadoDaAssistente>): Promise<ResultadoDaAssistente> {
    try {
      return await f();
    } catch (e) {
      logger.warn({ err: String(e).slice(0, 300), acao, unidade: unit.slug, conversa }, 'assistente: o modelo lançou');
      return { ok: false, status: 502, error: 'a assistente não conseguiu responder agora — tente de novo em instantes' };
    }
  }

  function responder(
    res: Response,
    out: ResultadoDaAssistente,
    chave: string,
    acao: string,
    unit: Unit,
    conversa: number | null,
    t0: number,
    corpo: (o: Extract<ResultadoDaAssistente, { ok: true }>) => Record<string, unknown>,
  ): void {
    if (!out.ok) {
      // o modelo não foi usado: a chamada volta para a pessoa
      d.teto.devolver(chave, d.dia());
      logger.warn({ acao, unidade: unit.slug, conversa, quem: chave, status: out.status, erro: out.error }, 'assistente: sem resposta');
      res.status(out.status).json({ error: out.error });
      return;
    }
    // sem o texto: só quem, onde, quanto custou e de onde veio
    logger.info({ acao, unidade: unit.slug, conversa, quem: chave, ms: Date.now() - t0, modelo: out.modelo, tokens: out.tokens, fontes: out.fontes.length, avisos: out.avisos.length }, 'assistente: respondeu');
    res.json(corpo(out));
  }
}

// ── a ligação com o mundo real ─────────────────────────────────────────────────────────────────────

let reais: ReturnType<typeof criarHandlersDoAssistente> | null = null;
const tetoReal = criarTeto();

function handlersReais() {
  if (reais) return reais;
  let lerAjuda: (() => Promise<Artigo[]>) | null | undefined;
  reais = criarHandlersDoAssistente({
    async autenticar(req, res) {
      const a = await sessaoDaAtendente(req, res);
      return a ? { nome: a.nome, id: a.id, sessao: a.sessao, leitura: leituraComLogin(a.c, a.sessao) } : null;
    },
    unidade: (slug) => prisma.unit.findUnique({ where: { slug } }),
    assistente: {
      rodarTeste: rodarTesteDaSofia,
      grade: gradeDoDia as unknown as DepsDaAssistente['grade'],
      contaDividida: (unit) => travaDaAgendaDaIa(unit),
      // a Central de Ajuda é lida com o token da conta (uma vez a cada 10 min), não com o login de quem perguntou
      ajuda: async () => {
        if (lerAjuda === undefined) {
          const conta = contaChatwootDoAmbiente();
          lerAjuda = conta ? ajudaDoPortal(criarContextoChatwoot(conta)) : null;
        }
        return lerAjuda ? lerAjuda() : [];
      },
      hoje: hojeLocal,
    },
    teto: tetoReal,
    dia: () => diaEmBelem(Date.now()),
    ligadaPara: (slug) => assistenteLigadaPara(slug),
  });
  return reais;
}

export const assistenteEstadoHandler = (req: Request, res: Response) => handlersReais().estado(req, res);
export const assistenteSugerirHandler = (req: Request, res: Response) => handlersReais().sugerir(req, res);
export const assistentePerguntarHandler = (req: Request, res: Response) => handlersReais().perguntar(req, res);

export function paginaAssistenteHandler(_req: Request, res: Response): void {
  const origem = contaChatwootDoAmbiente()?.url;
  if (!origem) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Assistente desligada.</p>');
    return;
  }
  res.type('html').set('Cache-Control', 'no-store').send(paginaDaAssistente(new URL(origem).origin));
}

/**
 * CORS do botão: ele roda na página do Chatwoot e chama poucas rotas com o login da pessoa em cabeçalhos próprios. Só estas rotas,
 * só desta origem (a do Chatwoot), sem credenciais. O painel e as demais rotas são chamados de dentro do iframe, na mesma origem
 * do servidor: não precisam de CORS. `null` = não é com este módulo.
 *  - GET  /api/public/assistente/estado    — o botão aparece?
 *  - GET  /api/public/funil/gestao         — o menu mostra «Marketing» e «Gestor»?
 *  - GET  /api/public/assistente/respostas — quais balões da conversa são da Sofia (👍/👎 no balão, 13/11)
 *  - POST /api/public/assistente/avaliar   — o 👍/👎 do balão
 */
const ROTAS_DO_BOTAO: Readonly<Record<string, readonly string[]>> = {
  '/api/public/assistente/estado': ['GET'],
  '/api/public/funil/gestao': ['GET'],
  '/api/public/assistente/respostas': ['GET'],
  '/api/public/assistente/avaliar': ['POST'],
};

export function corsDoAssistente(path: string, origem: string, urlChatwoot: string | undefined): { origin: true; credentials: false; allowedHeaders: string[]; methods: string[] } | null {
  const metodos = ROTAS_DO_BOTAO[path];
  if (!metodos || !urlChatwoot) return null;
  try {
    if (new URL(urlChatwoot).origin !== origem) return null;
  } catch {
    return null;
  }
  const comCorpo = metodos.includes('POST');
  return {
    origin: true,
    credentials: false,
    allowedHeaders: comCorpo ? ['X-CW-Token', 'X-CW-Client', 'X-CW-Uid', 'Content-Type'] : ['X-CW-Token', 'X-CW-Client', 'X-CW-Uid'],
    methods: [...metodos, 'OPTIONS'],
  };
}

// ── pausa da IA na conversa (painel da assistente): estado, «Pausar IA (eu assumo)», «Reativar IA» ─────────────────────
// Com o login de quem clicou: a atribuição e as notas saem no nome dela. Só conversa que ela enxerga e de caixa do mapa.

async function conversaDaAtendente(req: Request, res: Response, idBruto: unknown) {
  const a = await sessaoDaAtendente(req, res);
  if (!a) return null;
  const conversa = Number(idBruto);
  if (!Number.isInteger(conversa) || conversa <= 0) {
    res.status(400).json({ error: 'conversa inválida' });
    return null;
  }
  let slug: string;
  try {
    const { caixa } = await leituraComLogin(a.c, a.sessao).conversa(conversa);
    const daCaixa = caixa ? CAIXAS_REGUA[caixa] : undefined;
    if (!daCaixa) {
      res.status(422).json({ error: 'esta conversa não é de uma caixa com IA' });
      return null;
    }
    slug = daCaixa;
  } catch (e) {
    const status = (e as { status?: number })?.status;
    res.status(status === 401 || status === 403 || status === 404 ? 404 : 502).json({ error: 'não consegui abrir esta conversa' });
    return null;
  }
  return { a, conversa, slug, porta: portaDaPausaDoChatwoot(a.c, a.sessao) };
}

export async function assistentePausaEstadoHandler(req: Request, res: Response): Promise<void> {
  const r = await conversaDaAtendente(req, res, req.query.conversa);
  if (!r) return;
  try {
    res.json(estadoDaPausa(await r.porta.conversa(r.conversa)));
  } catch (e) {
    logger.warn({ err: String(e), conversa: r.conversa }, 'assistente: estado da pausa falhou');
    res.status(502).json({ error: 'não consegui ler a conversa' });
  }
}

export async function assistentePausaAcaoHandler(req: Request, res: Response): Promise<void> {
  const acao = String((req.body as { acao?: unknown })?.acao ?? '');
  if (acao !== 'pausar' && acao !== 'reativar') {
    res.status(400).json({ error: 'ação inválida' });
    return;
  }
  const r = await conversaDaAtendente(req, res, (req.body as { conversa?: unknown })?.conversa);
  if (!r) return;
  const eu = r.a.id;
  if (acao === 'pausar' && !eu) {
    res.status(403).json({ error: 'não consegui saber quem é você no Chatwoot: entre de novo' });
    return;
  }
  try {
    const feito =
      acao === 'pausar'
        ? await pausar(r.conversa, { tipo: 'pessoa', id: eu!, nome: r.a.nome }, r.porta)
        : await reativar(r.conversa, r.a.nome, r.porta);
    logger.info({ conversa: r.conversa, acao, feito, quem: r.a.id }, 'assistente: pausa da IA');
    res.json({ ok: true, feito, ...estadoDaPausa(await r.porta.conversa(r.conversa)) });
  } catch (e) {
    logger.warn({ err: String(e), conversa: r.conversa, acao }, 'assistente: pausa da IA falhou');
    res.status(502).json({ error: 'não consegui mudar a pausa agora' });
  }
}

// ── avaliar uma resposta da Sofia (👍/👎) ─────────────────────────────────────────────────────────────────
// Pelo balão da mensagem (com `mensagem` = id da resposta) ou pelo painel (sem ela: a ÚLTIMA resposta gravada da Sofia na conversa).
// Grava em `sofia_avaliacao` (uma por pessoa e mensagem) e alimenta a tela Agente. 👎 nova (ou que mudou) deixa NOTA PRIVADA na
// conversa no nome de quem avaliou — ANTES de gravar: se a nota falhar, nada fica gravado e a nova tentativa manda de novo.
export async function assistenteAvaliarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { conversa?: unknown; nota?: unknown; texto?: unknown; mensagem?: unknown };
  const nota = corpo.nota;
  const texto = limparTextoDaAvaliacao(typeof corpo.texto === 'string' ? corpo.texto : '');
  if (!ehNota(nota)) {
    res.status(400).json({ error: 'avaliação inválida' });
    return;
  }
  if (nota === 'ruim' && (texto ?? '').length < 5) {
    res.status(400).json({ error: 'escreva o que estava errado' });
    return;
  }
  const idPedido = corpo.mensagem == null ? null : Number(corpo.mensagem);
  if (idPedido !== null && !(Number.isInteger(idPedido) && idPedido > 0)) {
    res.status(400).json({ error: 'mensagem inválida' });
    return;
  }
  const r = await conversaDaAtendente(req, res, corpo.conversa);
  if (!r) return;
  try {
    let mensagem = idPedido;
    if (mensagem !== null) {
      if (!(await bancoDeAvaliacoes.respostaDaSofia(mensagem, r.conversa))) {
        res.status(404).json({ error: 'esta mensagem não é uma resposta da Sofia nesta conversa' });
        return;
      }
    } else mensagem = await bancoDeAvaliacoes.ultimaRespostaDaSofia(r.conversa);
    const quemId = r.a.id ?? null;
    if (mensagem === null && nota === 'boa') {
      // 👍 do painel sem resposta da Sofia gravada (conversa de antes do registro): não há o que juntar, só o log
      logger.info({ conversa: r.conversa, nota, quem: quemId }, 'assistente: 👍 sem resposta gravada — só no log');
      res.json({ ok: true });
      return;
    }
    const ja = mensagem !== null && quemId ? await bancoDeAvaliacoes.minhaAvaliacao(mensagem, quemId) : null;
    const muda = avaliacaoMuda(ja, nota, texto);
    if (nota === 'ruim' && muda) await r.porta.nota(r.conversa, `👎 Resposta da Sofia avaliada como ruim por ${r.a.nome}: ${texto}`);
    if (muda) await bancoDeAvaliacoes.gravarAvaliacao({ slug: r.slug, conversa: r.conversa, mensagem, nota, texto, quemId, quemNome: r.a.nome || 'atendente' }, ja);
    logger.info({ conversa: r.conversa, mensagem, nota, quem: quemId, tam: (texto ?? '').length, muda }, 'assistente: avaliação da Sofia');
    res.json({ ok: true });
  } catch (e) {
    logger.warn({ err: String(e), conversa: r.conversa }, 'assistente: não consegui gravar a avaliação');
    res.status(502).json({ error: 'não consegui registrar agora' });
  }
}

/** As respostas da Sofia na conversa aberta (ids dos balões) e o que cada uma já recebeu — para o 👍/👎 no balão. */
export async function assistenteRespostasHandler(req: Request, res: Response): Promise<void> {
  const r = await conversaDaAtendente(req, res, req.query.conversa);
  if (!r) return;
  try {
    res.set('Cache-Control', 'no-store').json({ respostas: await bancoDeAvaliacoes.respostasDaSofiaNaConversa(r.conversa, r.a.id ?? null) });
  } catch (e) {
    logger.warn({ err: String(e), conversa: r.conversa }, 'assistente: não consegui ler as respostas da Sofia');
    res.status(502).json({ error: 'não consegui ler agora' });
  }
}
