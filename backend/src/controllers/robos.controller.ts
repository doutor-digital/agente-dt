/**
 * Tela «Robôs» no menu do Chatwoot (pedido do João, 14/11/2026): os robôs da régua por unidade — ver, ligar/desligar, mudar o tempo e o
 * modelo (só administrador do Chatwoot), e o que já foi enviado. A página é `lib/robos-pagina.ts`; a regra de negócio, `lib/robos-estado.ts`.
 * Todas as rotas pedem o LOGIN do Chatwoot (cabeçalhos X-CW-*) e que a pessoa atenda uma caixa da unidade pedida (`atendenteDaUnidade`).
 *
 *   GET  /api/public/robos?slug=            os robôs da unidade (estado, tempo, modelos, contagem de 7 dias) + se a pessoa pode mexer
 *   POST /api/public/robos/:regra           { slug, ligado? | tempo? | modelo? } — só administrador
 *   GET  /api/public/robos/enviados?slug=   o que a régua fez nos últimos 7 dias nas caixas da unidade
 */
import type { Request, Response } from 'express';
import { logger } from '../lib/logger.js';
import { chamar, contaChatwootDaUnidade, contaChatwootDoAmbiente, contextoDaUnidade, contextoDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_CLOUD } from '../lib/chatwoot-regua.js';
import { TEXTOS_PARAU } from '../lib/chatwoot-regua-textos.js';
import { chatDoChatwoot } from '../lib/chatwoot-regua-worker.js';
import { paginaDosRobos } from '../lib/robos-pagina.js';
import { atendenteDaUnidade } from './aprendizados.controller.js';
import { automacoesDaUnidade, bancoDasAutomacoes, comTeto, mudarAutomacao, HISTORICO_RECENTE_MS, type ParteQueFalhou } from '../lib/robos-automacoes.js';
import { estadoGravado, panoramaDaUnidade, recarregarAutomacoes } from '../lib/automacoes-estado.js';
import { bancoDosRobos, caixasDaUnidade, enviadosDaUnidade, mudarRobo, podeMexerNosRobos, visaoDosRobos, type Aprovados } from '../lib/robos-estado.js';

const slugDe = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 80) : '');

/** O contexto da CONTA da unidade (cada clínica tem a sua): Parauapebas = o do ambiente, como sempre. null = unidade sem conta/token válidos (não chama o Chatwoot). */
function ctx(slug: string): ContextoChatwoot | null {
  const base = contextoDoAmbiente();
  return base ? contextoDaUnidade(base, slug) : null;
}

/** A página (iframe do menu do Chatwoot). */
export function paginaRobosHandler(_req: Request, res: Response): void {
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">CRM não configurado.</p>');
    return;
  }
  res.type('html').set('Cache-Control', 'no-store').send(paginaDosRobos(new URL(conta.url).origin));
}

// ── modelos aprovados da unidade (1 min de cache: a tela não bate no Chatwoot a cada clique) ────────

const VALIDADE_APROVADOS_MS = 60_000;
const cacheAprovados = new Map<string, { ate: number; valor: Aprovados | null }>();

/**
 * Os modelos aprovados nas caixas de WhatsApp Cloud da unidade (o que o Chatwoot diz em `inbox.message_templates`). Unidade sem caixa Cloud
 * (só texto livre): todos os modelos que a régua conhece valem. null = não deu para ler.
 */
async function aprovadosDaUnidade(slug: string): Promise<Aprovados | null> {
  const feito = cacheAprovados.get(slug);
  if (feito && feito.ate > Date.now()) return feito.valor;
  const c = ctx(slug);
  let valor: Aprovados | null = null;
  if (c) {
    const cloud = caixasDaUnidade(slug).filter((x) => CAIXAS_CLOUD.has(x));
    if (!cloud.length) valor = new Map(Object.keys(TEXTOS_PARAU).map((m) => [m, null] as const));
    else {
      try {
        const chat = chatDoChatwoot(c);
        const uniao = new Map<string, number | null>();
        for (const caixa of cloud) for (const [nome, n] of await chat.templatesAprovados(caixa)) if (!uniao.has(nome)) uniao.set(nome, n);
        valor = uniao;
      } catch (e) {
        logger.warn({ err: String(e), slug }, 'robos: não consegui ler os modelos aprovados');
      }
    }
  }
  cacheAprovados.set(slug, { ate: Date.now() + VALIDADE_APROVADOS_MS, valor });
  return valor;
}

// ── nome do paciente (uma busca por conversa, guardada por 10 min) ──────────────────────────────────

const cacheNomes = new Map<string, { ate: number; nome: string | null }>();

/** O id da conversa é POR CONTA: a chave leva a unidade (a conta dela), senão a conversa 5 de uma clínica serviria o nome da 5 de outra. */
async function nomeDaConversa(slug: string, id: number): Promise<string | null> {
  const chave = `${slug}|${id}`;
  const feito = cacheNomes.get(chave);
  if (feito && feito.ate > Date.now()) return feito.nome;
  const c = ctx(slug);
  if (!c) return null;
  const r = (await chamar(c, 'GET', `conversations/${id}`)) as { meta?: { sender?: { name?: unknown } } } | null;
  const n = typeof r?.meta?.sender?.name === 'string' && r.meta.sender.name.trim() ? r.meta.sender.name.trim().slice(0, 80) : null;
  if (cacheNomes.size > 2000) cacheNomes.clear();
  cacheNomes.set(chave, { ate: Date.now() + 10 * 60_000, nome: n });
  return n;
}

// ── rotas ─────────────────────────────────────────────────────────────────────────────────────────

export async function robosHandler(req: Request, res: Response): Promise<void> {
  const r = await atendenteDaUnidade(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    const visao = await visaoDosRobos(bancoDosRobos(), r.unit.slug, { aprovados: await aprovadosDaUnidade(r.unit.slug) });
    res.set('Cache-Control', 'no-store').json({ unidade: { slug: r.unit.slug, nome: r.unit.name }, pode: podeMexerNosRobos(r.a.papel), ...visao });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'robos: lista falhou');
    res.status(502).json({ error: 'não consegui ler os robôs agora' });
  }
}

export async function robosEnviadosHandler(req: Request, res: Response): Promise<void> {
  const r = await atendenteDaUnidade(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    res.set('Cache-Control', 'no-store').json(await enviadosDaUnidade(bancoDosRobos(), r.unit.slug, (id) => nomeDaConversa(r.unit.slug, id)));
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'robos: enviados falhou');
    res.status(502).json({ error: 'não consegui ler os envios agora' });
  }
}

export async function robosMudarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; ligado?: unknown; tempo?: unknown; modelo?: unknown };
  const r = await atendenteDaUnidade(req, res, slugDe(corpo.slug));
  if (!r) return;
  try {
    // só consulta o Chatwoot por modelos aprovados quando o pedido troca o modelo
    const aprovados = corpo.modelo !== undefined ? await aprovadosDaUnidade(r.unit.slug) : null;
    const res2 = await mudarRobo(bancoDosRobos(), {
      slug: r.unit.slug,
      regra: String(req.params.regra ?? ''),
      papel: r.a.papel,
      por: r.a.nome || 'administrador',
      ligado: corpo.ligado,
      tempo: corpo.tempo,
      modelo: corpo.modelo,
      aprovados,
    });
    if (!res2.ok) {
      res.status(res2.status).json({ error: res2.erro });
      return;
    }
    logger.info({ unit: r.unit.slug, regra: res2.regra, quem: r.a.id, nome: r.a.nome, ligado: corpo.ligado, tempo: corpo.tempo, modelo: corpo.modelo }, 'robos: robô alterado pela tela');
    res.json({ ok: true, regra: res2.regra });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'robos: mudar falhou');
    res.status(502).json({ error: 'não consegui gravar agora' });
  }
}

// ── aba «Automações» ────────────────────────────────────────────────────────────────────────────────

interface RegraNativa {
  id: number;
  nome: string;
  descricao: string;
  ativa: boolean;
  evento: string;
}

/**
 * Teto de cada parte da aba «Automações»: estourou, a parte aparece vazia (regras nativas: só o link; histórico e «quem mexeu»: aviso na tela) e a
 * aba abre. Pior caso: recarregar (0,5 s) + as partes que correm juntas (1,2 s do banco, 1,5 s das regras nativas) ≈ 2 s, fora o login. Em 23/11/2026 a aba levou 5,5–7,3 s porque o
 * histórico (14 buscas na mesma janela do log) não tinha teto aqui nem para «quem mexeu», que esperava na fila do mesmo pool.
 */
const TETO_DA_ABA_MS = 1500;
const TETO_DO_RECARREGAR_MS = 500;

/** As regras nativas do Chatwoot (Configurações → Automação), só leitura. Falhou ao ler: lista vazia + o link. */
async function regrasNativas(slug: string): Promise<{ regras: RegraNativa[]; lidas: boolean }> {
  const c = ctx(slug);
  if (!c) return { regras: [], lidas: false };
  try {
    const r = (await chamar(c, 'GET', 'automation_rules')) as { payload?: unknown[] } | null;
    const lista = Array.isArray(r?.payload) ? (r.payload as Array<{ id?: unknown; name?: unknown; description?: unknown; active?: unknown; event_name?: unknown }>) : [];
    return {
      lidas: true,
      regras: lista.map((x) => ({ id: Number(x?.id) || 0, nome: String(x?.name ?? '').slice(0, 120), descricao: String(x?.description ?? '').slice(0, 300), ativa: x?.active === true, evento: String(x?.event_name ?? '') })),
    };
  } catch (e) {
    logger.warn({ err: String(e) }, 'robos: não consegui ler as regras nativas do Chatwoot');
    return { regras: [], lidas: false };
  }
}

export async function robosAutomacoesHandler(req: Request, res: Response): Promise<void> {
  const inicio = Date.now();
  const r = await atendenteDaUnidade(req, res, slugDe(req.query.slug));
  if (!r) return;
  const msLogin = Date.now() - inicio;
  try {
    // a única chamada rara o bastante para pagar a releitura: quem abriu a aba quer ver o estado agora
    // A aba ficou 60 s em «Carregando…» (15/11): cada parte tem teto e o tempo de cada uma vai para o log, para achar a lenta.
    const t0 = Date.now();
    const ms: Record<string, number> = {};
    const medir = <T>(nome: string, p: Promise<T>): Promise<T> => p.finally(() => { ms[nome] = Date.now() - t0; });
    const parcial: ParteQueFalhou[] = [];
    const hist: { em: number | null } = { em: null };
    // estourou: a aba segue com o estado que o servidor já tinha (a própria tela que muda um interruptor já o recarrega) e AVISA
    if (!(await medir('recarregar', comTeto(recarregarAutomacoes().then(() => true), TETO_DO_RECARREGAR_MS, false)))) parcial.push('estado');
    const [automacoes, nativas] = await Promise.all([
      // o teto de cada leitura do banco (histórico e «quem mexeu», juntas) fica dentro de `automacoesDaUnidade`
      medir('automacoes', automacoesDaUnidade(bancoDasAutomacoes(), r.unit.slug, { aoFalhar: (parte) => parcial.push(parte), aoLerHistorico: (lidoEm) => { hist.em = lidoEm; } })),
      medir('nativas', comTeto(regrasNativas(r.unit.slug), TETO_DA_ABA_MS, { regras: [] as RegraNativa[], lidas: false })),
    ]);
    // os tetos deixam a aba sempre abaixo de 2 s: o estouro de uma parte NÃO pode passar calado (é o que a prova pós-deploy lê no log)
    const total = Date.now() - inicio;
    if (parcial.length || total > 2000) logger.warn({ unit: r.unit.slug, parcial, total, historicoIdadeMs: hist.em === null ? null : Date.now() - hist.em, ms: { login: msLogin, ...ms } }, parcial.length ? 'robos: aba Automações incompleta (parte estourou o teto)' : 'robos: aba Automações demorou');
    const conta = contaChatwootDaUnidade(r.unit.slug);
    res.set('Cache-Control', 'no-store').json({
      unidade: { slug: r.unit.slug, nome: r.unit.name },
      pode: podeMexerNosRobos(r.a.papel),
      automacoes,
      // o que não deu para ler dentro do teto ('ultimas' = histórico das automações, 'mudancas' = quem mexeu por último): a tela avisa em vez de dizer «sem registro»
      parcial,
      // quando o histórico («últimas ações») foi lido: a leitura fica guardada (fresca 1 min, servida como velha até 2 min; mais de 10 s = «velho» para a tela); a tela diz «histórico das HH:MM»
      historicoEm: hist.em === null ? null : new Date(hist.em).toISOString(),
      historicoVelho: hist.em !== null && Date.now() - hist.em > HISTORICO_RECENTE_MS,
      nativas: { ...nativas, link: conta ? `${conta.url}/app/accounts/${conta.conta}/settings/automation/list` : null },
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'robos: automações falhou');
    res.status(502).json({ error: 'não consegui ler as automações agora' });
  }
}

export async function robosAutomacaoMudarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; estado?: unknown; confirmar?: unknown };
  const r = await atendenteDaUnidade(req, res, slugDe(corpo.slug));
  if (!r) return;
  try {
    await recarregarAutomacoes();
    const slug = r.unit.slug;
    const res2 = await mudarAutomacao(bancoDasAutomacoes(), {
      slug,
      id: String(req.params.id ?? ''),
      estado: corpo.estado,
      confirmar: corpo.confirmar,
      papel: r.a.papel,
      por: r.a.nome || 'administrador',
      estadoAtual: (id) => panoramaDaUnidade(slug).find((p) => p.id === id)?.estado ?? estadoGravado(slug, id),
    });
    if (!res2.ok) {
      res.status(res2.status).json({ error: res2.erro, ...(res2.precisaConfirmar ? { precisaConfirmar: true } : {}) });
      return;
    }
    logger.warn({ unit: slug, automacao: res2.id, estado: res2.estado, por: r.a.nome, quemId: r.a.id, via: 'tela Robôs do Chatwoot' }, 'automação alterada pela tela');
    res.json({ ok: true, id: res2.id, estado: res2.estado });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'robos: mudar automação falhou');
    res.status(502).json({ error: 'não consegui gravar agora' });
  }
}
