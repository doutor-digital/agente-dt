/**
 * Funil de etapas encaixado no Chatwoot (Dashboard App) — ver `lib/funil-chatwoot.ts`.
 *
 * Página `GET /funil` (item "Funil" do menu e aba "Funil" da conversa; visual no molde do funil do Kommo) e as rotas dela:
 *   GET  /api/public/funil/quadro?caixa=<id>   colunas por etapa (até 200 conversas), soma em R$, situação da tarefa
 *   GET  /api/public/funil/caixas              caixas de entrada (o filtro do topo)
 *   GET  /api/public/funil/conversa/:id        a ficha do lead (campos, contato, histórico, tarefas)
 *   POST /api/public/funil/mover               { conversaId, etapa } — grava a etapa e deixa nota interna
 *   POST /api/public/funil/campos              { conversaId, campos } — qualificação, valor, motivo da perda
 *   POST /api/public/funil/responsavel         { conversaId, agenteId }
 *   POST /api/public/funil/nota | mensagem     { conversaId, texto } — mensagem só com o login da pessoa
 *   POST /api/public/funil/tarefa              { conversaId, texto, venceEm, responsavel? }; POST …/tarefa/:id/feita { feita }
 *   POST /api/public/funil/novo                { nome, telefone, caixaId, etapa } — adição rápida (só com login)
 * Todas pedem OU o cabeçalho X-Funil-Chave (derivada do token do Chatwoot — a aba da conversa) OU o login do próprio Chatwoot
 * (X-CW-Token/Client/Uid — o item "Funil" do menu, ver `GET /funil/menu.js`); sem Chatwoot configurado, 404.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { contaChatwootDoAmbiente, criarContextoChatwoot, chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { createHash } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { conversasDasPaginas, diaEmBelem, montarHoje } from '../lib/chatwoot-hoje.js';
import {
  credenciaisDeAnuncio,
  emailDoPerfil,
  montarGestor,
  montarMarketing,
  montarOportunidades,
  papelNaConta,
  podeVerGestao,
  referralDasMensagens,
  resolverPeriodo,
  somarFaturado,
  criadaNaJanela,
  type Faturado,
  type JanelaDoPeriodo,
  type Investido,
  type LinhaAnuncio,
  type Referral,
} from '../lib/chatwoot-gestor.js';
import { gastoDaConta, gastoDiarioDaConta } from '../lib/meta-anuncios.js';
import { TELAS_CSS, TELAS_JS } from '../lib/chatwoot-telas-ui.js';
import { instanteNoFuso, searchTreatments } from '../services/spine.service.js';
import { CAIXAS_HISTORICO, CAIXAS_REGUA, CAMPO_PARTIDA } from '../lib/chatwoot-regua.js';
import { assistenteJs } from '../lib/chatwoot-assistente-ui.js';
import {
  ATRIBUTO_ETAPA,
  MAX_PAGINAS,
  camposParaGravar,
  cartaoDaConversa,
  chaveConfere,
  desdeAEtapa,
  etapasDoAtributo,
  historicoDasMensagens,
  idsDasPaginas,
  montarQuadro,
  nomeSeTemConta,
  notaDaMudanca,
  sessaoDosCabecalhos,
  situacaoDaTarefa,
  telefoneParaCadastro,
  valoresDoAtributo,
  type SessaoChatwoot,
  type SituacaoTarefa,
} from '../lib/funil-chatwoot.js';

let ctx: ContextoChatwoot | null | undefined;
function contexto(): ContextoChatwoot | null {
  if (ctx === undefined) {
    const conta = contaChatwootDoAmbiente();
    ctx = conta ? criarContextoChatwoot(conta) : null;
  }
  return ctx;
}

// 30 chaves erradas por ip a cada 10 min
const erros = new Map<string, { n: number; desde: number }>();
function bloqueado(ip: string): boolean {
  const t = erros.get(ip);
  return !!t && Date.now() - t.desde < 10 * 60_000 && t.n >= 30;
}
function errou(ip: string): void {
  const t = erros.get(ip);
  if (!t || Date.now() - t.desde > 10 * 60_000) erros.set(ip, { n: 1, desde: Date.now() });
  else t.n += 1;
}

// Login do Chatwoot já conferido: hash da sessão → nome (5 min). Consequência aceita: quem sai do Chatwoot (ou é tirado da
// conta) ainda vê o funil por até 5 min nesta aba.
const sessoes = new Map<string, { nome: string; id: number | null; papel: string | null; email: string | null; ate: number }>();
const SESSAO_VALE_MS = 5 * 60_000;
// Teto GLOBAL de consultas ao /profile do Chatwoot (sessão ainda não conferida). Não é por ip: sem `trust proxy`, atrás do
// Traefik, o ip é o mesmo para todo mundo. Sessão já conferida (no cache) nunca esbarra nele.
const MAX_CONFERENCIAS_POR_MIN = 120;
let conferencias = { n: 0, desde: 0 };

type Conferencia = { nome: string; id: number | null; papel: string | null; email: string | null } | 'invalida' | 'sem-conta' | 'indisponivel' | 'excesso';

async function quemEstaLogado(c: ContextoChatwoot, s: SessaoChatwoot): Promise<Conferencia> {
  const k = createHash('sha256').update(`${s.token}|${s.client}|${s.uid}`).digest('hex');
  const t = sessoes.get(k);
  if (t && t.ate > Date.now()) return { nome: t.nome, id: t.id, papel: t.papel, email: t.email };
  if (Date.now() - conferencias.desde > 60_000) conferencias = { n: 0, desde: Date.now() };
  if (++conferencias.n > MAX_CONFERENCIAS_POR_MIN) return 'excesso';
  let r: globalThis.Response;
  try {
    r = await c.fetch(`${c.conta!.url}/api/v1/profile`, {
      headers: { 'access-token': s.token, client: s.client, uid: s.uid, 'token-type': 'Bearer', Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return 'indisponivel';
  }
  // só "o Chatwoot recusou o login" é sessão inválida; queda, timeout e 5xx não são culpa de quem está usando
  if (r.status === 401 || r.status === 403) return 'invalida';
  if (!r.ok) return 'indisponivel';
  const perfil = (await r.json().catch(() => null)) as { id?: unknown; name?: unknown; email?: unknown; accounts?: unknown } | null;
  const nome = nomeSeTemConta(perfil, c.conta!.conta);
  const id = Number(perfil?.id);
  // login válido, mas de quem não é desta conta: não é sessão vencida ("entre de novo" nunca resolveria)
  if (!nome) return 'sem-conta';
  if (sessoes.size > 500) sessoes.clear();
  const idOk = Number.isInteger(id) && id > 0 ? id : null;
  const papel = papelNaConta(perfil, c.conta!.conta);
  const email = emailDoPerfil(perfil);
  sessoes.set(k, { nome, id: idOk, papel, email, ate: Date.now() + SESSAO_VALE_MS });
  return { nome, id: idOk, papel, email };
}

/**
 * Quem pode: a chave do funil (aba da conversa; quem = o que a página manda) ou o login do Chatwoot (item do menu; quem = o
 * nome do perfil). O limitador de 30 erros vale só para CHAVE errada — sessão recusada não trava o funil de ninguém.
 */
/**
 * Quem está usando. Com o login do Chatwoot (`sessao`), TODA chamada ao Chatwoot vai com o login da pessoa: ela só vê e mexe
 * nas caixas a que tem acesso lá (a SDR da unidade não enxerga as outras). Só o link avulso do João (chave) usa o token da conta.
 */
interface Acesso {
  c: ContextoChatwoot;
  logado: string | null;
  /** id do usuário no Chatwoot (o filtro "Minhas" compara por ele, não pelo nome) */
  logadoId: number | null;
  sessao: SessaoChatwoot | null;
  /** papel nesta conta (`administrator` | `agent`) e e-mail — só com o login do Chatwoot; decidem quem vê Gestor e Marketing */
  papel?: string | null;
  email?: string | null;
}

async function autorizado(req: Request, res: Response): Promise<Acesso | null> {
  const c = contexto();
  if (!c?.conta) {
    res.status(404).json({ error: 'funil desligado (Chatwoot não configurado)' });
    return null;
  }
  const chave = req.get('x-funil-chave');
  if (chave) {
    const ip = req.ip ?? '?';
    if (bloqueado(ip)) {
      res.status(429).json({ error: 'muitas tentativas — aguarde 10 minutos' });
      return null;
    }
    if (chaveConfere(c.conta.token, chave)) return { c, logado: null, logadoId: null, sessao: null };
    errou(ip);
    res.status(403).json({ error: 'chave do funil inválida' });
    return null;
  }
  const sessao = sessaoDosCabecalhos((n) => req.get(n));
  if (!sessao) {
    res.status(403).json({ error: 'abra o funil pelo Chatwoot' });
    return null;
  }
  const r = await quemEstaLogado(c, sessao);
  if (typeof r === 'object') return { c, logado: r.nome, logadoId: r.id, sessao, papel: r.papel, email: r.email };
  recusarSessao(res, r, 403);
  return null;
}

/** A resposta para uma sessão que não passou. O funil recusa login inválido com 403; a assistente, com 401. */
function recusarSessao(res: Response, r: Exclude<Conferencia, object>, statusInvalida: 401 | 403): void {
  if (r === 'invalida') res.status(statusInvalida).json({ error: 'entre no Chatwoot de novo (sessão expirada)', sessao: 'invalida' });
  else if (r === 'sem-conta') res.status(403).json({ error: 'seu usuário do Chatwoot não tem acesso a esta conta — peça para a Suzanne', sessao: 'sem-conta' });
  else if (r === 'excesso') res.status(429).json({ error: 'muitos acessos agora — tente em 1 minuto' });
  else res.status(502).json({ error: 'não consegui falar com o Chatwoot agora' });
}

/**
 * Só o login do Chatwoot (nunca a chave do funil): quem mexe com conversa pelo login da PRÓPRIA pessoa. Serve à assistente da
 * atendente, que precisa saber quem é e que caixas ela vê. Sem login = 401 (o funil usa 403; aqui a página tenta pedir de novo).
 */
export interface Atendente {
  c: ContextoChatwoot;
  sessao: SessaoChatwoot;
  nome: string;
  id: number | null;
}

export async function sessaoDaAtendente(req: Request, res: Response): Promise<Atendente | null> {
  const c = contexto();
  if (!c?.conta) {
    res.status(404).json({ error: 'assistente desligada (Chatwoot não configurado)' });
    return null;
  }
  const sessao = sessaoDosCabecalhos((n) => req.get(n));
  if (!sessao) {
    res.status(401).json({ error: 'abra a assistente pelo Chatwoot (entre no Chatwoot de novo)', sessao: 'invalida' });
    return null;
  }
  const r = await quemEstaLogado(c, sessao);
  if (typeof r === 'object') return { c, sessao, nome: r.nome, id: r.id };
  recusarSessao(res, r, 401);
  return null;
}

async function definicoes(a: Acesso): Promise<unknown[]> {
  // attribute_model=0: atributo de CONVERSA
  const d = await cw(a, 'GET', 'custom_attribute_definitions', { query: { attribute_model: '0' } }).catch(() => []);
  return Array.isArray(d) ? d : [];
}

/** Chama o Chatwoot com o login da pessoa (menu/aba) ou, só no link avulso do João, com o token da conta. */
function cw(a: Acesso, metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', caminho: string, o: { corpo?: unknown; query?: Record<string, string> } = {}) {
  return chamar(a.c, metodo, caminho, { ...o, sessao: a.sessao });
}

function falhou(res: Response, e: unknown, oQue: string, extra: Record<string, unknown> = {}): void {
  const status = (e as { status?: number })?.status;
  logger.warn({ err: String(e), ...extra }, `funil: ${oQue} falhou`);
  if (status === 401 || status === 403 || status === 404) {
    res.status(404).json({ error: 'você não tem acesso a esta conversa (ou ela não existe mais)' });
    return;
  }
  res.status(502).json({ error: 'não consegui falar com o Chatwoot agora' });
}

async function vencimentosAbertos(conta: number, ids: number[]): Promise<Map<number, SituacaoTarefa>> {
  const mapa = new Map<number, SituacaoTarefa>();
  if (!ids.length) return mapa;
  const ts = await prisma.funilTarefa
    .findMany({ where: { conta, conversaId: { in: ids }, feita: false }, select: { conversaId: true, venceEm: true } })
    .catch((e: unknown) => {
      logger.warn({ err: String(e) }, 'funil: não li as tarefas (cartões saem sem a situação)');
      return [] as Array<{ conversaId: number; venceEm: Date }>;
    });
  const por = new Map<number, Date[]>();
  for (const t of ts) por.set(t.conversaId, [...(por.get(t.conversaId) ?? []), t.venceEm]);
  const agora = new Date();
  for (const [id, vs] of por) mapa.set(id, situacaoDaTarefa(vs, agora));
  return mapa;
}

/**
 * As páginas da listagem de conversas, caixa por caixa, SEM as caixas de histórico (CAIXAS_HISTORICO: o histórico antigo do
 * celular importado do Kapso — milhares de conversas resolvidas que encheriam o funil e o "Chegaram hoje" e deixariam tudo lento).
 * Com ?caixa=, só ela (caixa de histórico pedida direto = nada).
 */
async function paginasDasCaixas(a: Acesso, caixa: number): Promise<unknown[]> {
  return (await lerCaixas(a, caixa, MAX_PAGINAS)).paginas;
}

/** As caixas (e as páginas de cada uma) que a pessoa lê; `cortou` = alguma caixa tinha mais conversas que o teto de páginas. */
async function lerCaixas(a: Acesso, caixa: number, maxPaginas: number, soDeUnidades = false, lote = 1): Promise<{ paginas: unknown[]; cortou: boolean }> {
  let ids: number[];
  const vale = (id: number) => Number.isInteger(id) && !CAIXAS_HISTORICO.has(id) && (!soDeUnidades || !!CAIXAS_REGUA[id]);
  if (Number.isInteger(caixa) && caixa > 0) ids = vale(caixa) ? [caixa] : [];
  else {
    const r = (await cw(a, 'GET', 'inboxes')) as any;
    ids = (Array.isArray(r?.payload) ? r.payload : []).map((i: any) => Number(i.id)).filter(vale);
  }
  const paginas: unknown[] = [];
  let cortou = false;
  for (const id of ids) {
    // `lote` páginas por vez (as telas de gestão pedem 4: as páginas não dependem umas das outras e 600 conversas em fila levariam
    // dezenas de segundos); o quadro e o Hoje seguem uma por vez, como sempre
    for (let p = 1; p <= maxPaginas; p += lote) {
      const numeros = Array.from({ length: Math.min(lote, maxPaginas - p + 1) }, (_, i) => p + i);
      const lidas = (await Promise.all(numeros.map((n) => cw(a, 'GET', 'conversations', { query: { status: 'all', assignee_type: 'all', inbox_id: String(id), page: String(n) } })))) as any[];
      let acabou = false;
      for (const pg of lidas) {
        paginas.push(pg);
        if ((pg?.data?.payload?.length ?? 0) < 25) acabou = true;
      }
      if (acabou) break;
      if (p + lote - 1 >= maxPaginas) cortou = true;
    }
  }
  return { paginas, cortou };
}

export async function funilQuadroHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  try {
    const defs = await definicoes(a);
    const lista = etapasDoAtributo(defs);
    const paginas = await paginasDasCaixas(a, Number(req.query.caixa));
    const tarefas = await vencimentosAbertos(a.c.conta!.conta, idsDasPaginas(paginas));
    res.json({ ...montarQuadro(paginas, lista, tarefas), chatwoot: a.c.conta!.url, conta: a.c.conta!.conta, eu: a.logado, euId: a.logadoId, podeEscrever: !!a.sessao });
  } catch (e) {
    falhou(res, e, 'quadro');
  }
}

/**
 * Tela "Hoje" (design Início do painel da Lia): números do dia, «A Lia separou», «Faça agora» e «Por usuário hoje», com o login
 * da própria pessoa (só as caixas que ela enxerga). «Agendaram hoje» vem da memória da régua (entrou em Agendado hoje).
 */
export async function funilHojeHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  try {
    const paginas = await paginasDasCaixas(a, Number(req.query.caixa));
    const conversas = conversasDasPaginas(paginas);
    const agora = Date.now();
    const inicioDoDia = new Date(Date.parse(`${diaEmBelem(agora)}T03:00:00Z`));
    const ids = conversas.map((c) => Number(c.id));
    const agendadas = ids.length
      ? await prisma.chatwootReguaVisto.findMany({
          where: { conversationId: { in: ids }, campo: 'etapa', valor: 'Agendado', inicial: false, desde: { gte: inicioDoDia } },
          select: { conversationId: true },
        })
      : [];
    res.json({ ...montarHoje(conversas, agora, new Set(agendadas.map((x) => x.conversationId))), eu: a.logado, chatwoot: a.c.conta!.url, conta: a.c.conta!.conta });
  } catch (e) {
    falhou(res, e, 'hoje');
  }
}

// ── Oportunidades · Marketing · Gestor (13/11/2026) ───────────────────────────────────────────────────────────────
// Sempre com o login da própria pessoa (só as caixas dela). Marketing e Gestor ainda exigem ser administrador da conta ou estar
// em CHATWOOT_GESTORES — checado AQUI, no servidor, não só no menu. Nada de dado de paciente em log.

/** Resposta pronta por pessoa+tela por 45 s, e pedido igual em andamento vira um só: o botão de atualizar não vira rajada no Chatwoot. */
const prontas = new Map<string, { ate: number; v: unknown }>();
const emAndamento = new Map<string, Promise<unknown>>();
async function memo<T>(chave: string, vale: number, fn: () => Promise<T>): Promise<T> {
  const hit = prontas.get(chave);
  if (hit && hit.ate > Date.now()) return hit.v as T;
  const andando = emAndamento.get(chave);
  if (andando) return (await andando) as T;
  const p = fn();
  emAndamento.set(chave, p);
  try {
    const v = await p;
    if (prontas.size > 300) prontas.clear();
    prontas.set(chave, { ate: Date.now() + vale, v });
    return v;
  } finally {
    emAndamento.delete(chave);
  }
}
const VALE_TELA_MS = 45_000;

/** Só com o login do Chatwoot (a chave avulsa do funil não abre estas telas). */
async function autorizadoComLogin(req: Request, res: Response): Promise<Acesso | null> {
  const a = await autorizado(req, res);
  if (!a) return null;
  if (!a.sessao) {
    res.status(403).json({ error: 'esta tela abre pelo menu do Chatwoot, com o seu login' });
    return null;
  }
  return a;
}

async function autorizadoGestao(req: Request, res: Response): Promise<Acesso | null> {
  const a = await autorizadoComLogin(req, res);
  if (!a) return null;
  if (!podeVerGestao(a.papel, a.email, process.env.CHATWOOT_GESTORES)) {
    res.status(403).json({ error: 'esta tela é só para a gestão. Peça acesso à Suzanne.', semPermissao: true });
    return null;
  }
  return a;
}

function falhouLista(res: Response, e: unknown, oQue: string): void {
  logger.warn({ err: String(e) }, `funil: ${oQue} falhou`);
  res.status(502).json({ error: 'não consegui falar com o Chatwoot agora — tente de novo em instantes' });
}

export async function funilOportunidadesHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizadoComLogin(req, res);
  if (!a) return;
  try {
    const agora = Date.now();
    const v = await memo(`op|${a.logadoId ?? a.logado}`, VALE_TELA_MS, async () => {
      const conversas = conversasDasPaginas(await paginasDasCaixas(a, 0));
      return { ...montarOportunidades(conversas, agora), eu: a.logado, chatwoot: a.c.conta!.url, conta: a.c.conta!.conta };
    });
    res.json(v);
  } catch (e) {
    falhouLista(res, e, 'oportunidades');
  }
}

// Campanha de cada conversa: o `referral` está na 1ª mensagem do paciente e nunca muda — guarda (só ids de anúncio e título).
// Só guarda o «não tem» quando a conversa foi lida até o começo; se faltou ler (conversa longa), não guarda: senão ela ficaria
// «sem campanha» até o servidor reiniciar.
const referralGuardado = new Map<number, Referral | null>();
const MAX_LEITURAS_POR_PEDIDO = 150;
const MAX_PAGINAS_DE_MENSAGENS = 10;

async function lerReferral(a: Acesso, conversaId: number): Promise<{ ref: Referral | null; completo: boolean }> {
  const todas: unknown[] = [];
  let antes: number | undefined;
  let completo = false;
  for (let p = 0; p < MAX_PAGINAS_DE_MENSAGENS; p++) {
    const r = (await cw(a, 'GET', `conversations/${conversaId}/messages`, { query: antes ? { before: String(antes) } : {} })) as any;
    const lista: any[] = Array.isArray(r?.payload) ? r.payload : [];
    todas.push(...lista);
    if (lista.length < 20) {
      completo = true;
      break;
    }
    const menor = Math.min(...lista.map((m) => Number(m?.id)).filter((n) => Number.isFinite(n)));
    if (!Number.isFinite(menor)) break;
    antes = menor;
  }
  const ref = referralDasMensagens(todas);
  return { ref, completo: completo || ref !== null };
}

/** Lê a campanha das conversas dadas, na ordem recebida (as mais novas primeiro), até o teto; o resto é contado para o aviso. */
async function referralsDe(a: Acesso, ids: number[]): Promise<{ mapa: Map<number, Referral | null>; semLer: number; falhas: number }> {
  const mapa = new Map<number, Referral | null>();
  const faltam: number[] = [];
  for (const id of ids) {
    if (referralGuardado.has(id)) mapa.set(id, referralGuardado.get(id)!);
    else faltam.push(id);
  }
  const alvo = faltam.slice(0, MAX_LEITURAS_POR_PEDIDO);
  let falhas = 0;
  let proximo = 0;
  const trabalhador = async () => {
    for (;;) {
      const i = proximo++;
      if (i >= alvo.length) return;
      try {
        const { ref, completo } = await lerReferral(a, alvo[i]!);
        mapa.set(alvo[i]!, ref);
        if (completo) {
          if (referralGuardado.size > 5000) referralGuardado.clear();
          referralGuardado.set(alvo[i]!, ref);
        } else falhas++; // conversa longa demais para ler até o começo: fica sem campanha agora, e tenta de novo no próximo pedido
      } catch {
        falhas++;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, trabalhador));
  return { mapa, semLer: Math.max(0, faltam.length - alvo.length), falhas };
}

const slugDaCaixa = (c: any): string | null => CAIXAS_REGUA[Number(c?.inbox_id)] ?? null;

/** As conversas das caixas de unidade que a pessoa enxerga (com o login dela), e os slugs dessas unidades. */
async function conversasDasUnidades(a: Acesso, caixa: number): Promise<{ conversas: any[]; slugs: string[]; cortou: boolean }> {
  const { paginas, cortou } = await lerCaixas(a, caixa, 24, true, 4);
  const conversas = conversasDasPaginas(paginas).filter((c) => slugDaCaixa(c));
  return { conversas, slugs: [...new Set(conversas.map(slugDaCaixa).filter((s): s is string => !!s))], cortou };
}

/** As conversas criadas na janela, as mais novas primeiro (é a ordem em que a campanha é lida). */
const doPeriodoDe = (conversas: any[], j: JanelaDoPeriodo) =>
  conversas.filter((c) => criadaNaJanela(c, j)).sort((x, y) => Number(y.created_at) - Number(x.created_at));

/** O Gestor lida com dinheiro por dia: «Manhã» (18h de ontem até agora) não cabe nele, vira «Fim do dia». */
const periodoDe = (req: Request, soDias = false) => {
  const p = resolverPeriodo(typeof req.query.periodo === 'string' ? req.query.periodo : '', Date.now());
  return soDias && p.chave === 'manha' ? resolverPeriodo('fimdia', Date.now()) : p;
};
const caixaDe = (req: Request) => (Number.isInteger(Number(req.query.caixa)) ? Number(req.query.caixa) : 0);

function avisosDeLeitura(o: { cortou: boolean; semLer: number; falhas: number }): string[] {
  const l: string[] = [];
  if (o.cortou) l.push('A caixa tem mais conversas do que a tela lê de uma vez: os números podem estar abaixo do real.');
  if (o.semLer > 0) l.push(`${o.semLer} conversa(s) do período ficaram sem leitura da campanha (limite por pedido) e entraram em «Sem campanha gravada». Atualize para ler mais.`);
  if (o.falhas > 0) l.push(`${o.falhas} conversa(s) não puderam ser lidas até o começo agora e entraram em «Sem campanha gravada».`);
  return l;
}

// Investido (Meta) e Faturado (franquia), por unidade. Cada fonte falha sozinha: a tela diz qual e por quê, e calcula o resto.
async function gastosDasUnidades(slugs: string[], de: string, ate: string): Promise<{ investido: Investido; linhas: LinhaAnuncio[] }> {
  if (!slugs.length) return { investido: { estado: 'conectar', valor: null, moeda: null, motivo: 'Nenhuma caixa com unidade ligada.' }, linhas: [] };
  const linhas: LinhaAnuncio[] = [];
  const faltam: string[] = [];
  const erros: string[] = [];
  const moedas = new Set<string>();
  const avisos: string[] = [];
  let leu = 0;
  await Promise.all(
    slugs.map(async (slug) => {
      const cred = credenciaisDeAnuncio(slug, process.env, await tokenDeAnuncioDaUnidade(slug));
      if ('falta' in cred) {
        faltam.push(...cred.falta);
        return;
      }
      const g = await gastoDaConta(cred.conta, cred.token, de, ate);
      if (!g.ok) {
        erros.push(g.motivo);
        return;
      }
      leu++;
      if (g.moeda) moedas.add(g.moeda);
      if (g.parcial) avisos.push('a lista de anúncios passou do limite de leitura: o valor pode estar abaixo do real');
      linhas.push(...g.linhas);
    }),
  );
  if (leu === 0 && erros.length) return { investido: { estado: 'erro', valor: null, moeda: null, motivo: erros[0]! }, linhas: [] };
  if (leu === 0) return { investido: { estado: 'conectar', valor: null, moeda: null, motivo: `Falta ligar a conta de anúncios: preencher ${[...new Set(faltam)].join(' e ')} no servidor.` }, linhas: [] };
  // somar real com dólar daria um número sem sentido: nesse caso, não mostra
  if (moedas.size > 1) return { investido: { estado: 'erro', valor: null, moeda: null, motivo: 'as contas de anúncios usam moedas diferentes; escolha uma caixa por vez' }, linhas: [] };
  const total = Math.round(linhas.reduce((t, l) => t + l.gasto, 0) * 100) / 100;
  const nota = [...(faltam.length ? [`falta ligar ${[...new Set(faltam)].join(' e ')}`] : []), ...erros, ...new Set(avisos)].join('; ');
  return { investido: { estado: 'ok', valor: total, moeda: [...moedas][0] ?? null, motivo: nota || null }, linhas };
}

/** O token de anúncios da unidade guardado no banco (units.meta_access_token); null se não houver. Lido a cada consulta (é uma linha só). */
async function tokenDeAnuncioDaUnidade(slug: string): Promise<string | null> {
  const u = await prisma.unit.findUnique({ where: { slug }, select: { metaAccessToken: true } }).catch(() => null);
  return u?.metaAccessToken?.trim() || null;
}

/** O gasto por dia da(s) conta(s) de anúncios no intervalo; null se nenhuma unidade tem a conta ligada ou a Meta não respondeu. */
async function gastoDiarioDasUnidades(slugs: string[], de: string, ate: string): Promise<{ porDia: Record<string, number>; total: number } | null> {
  const porDia: Record<string, number> = {};
  let leu = 0;
  await Promise.all(
    slugs.map(async (slug) => {
      const cred = credenciaisDeAnuncio(slug, process.env, await tokenDeAnuncioDaUnidade(slug));
      if ('falta' in cred) return;
      const g = await gastoDiarioDaConta(cred.conta, cred.token, de, ate);
      if (!g.ok) return;
      leu++;
      for (const [dia, v] of Object.entries(g.porDia)) porDia[dia] = Math.round(((porDia[dia] ?? 0) + v) * 100) / 100;
    }),
  );
  return leu ? { porDia, total: Math.round(Object.values(porDia).reduce((t, v) => t + v, 0) * 100) / 100 } : null;
}

const faturadoPronto = new Map<string, { ate: number; v: Faturado }>();
async function faturadoDasUnidades(slugs: string[], de: string, ate: string): Promise<Faturado> {
  if (!slugs.length) return { valor: null, fonte: null, motivo: 'Nenhuma caixa com unidade ligada.' };
  const chave = `${[...slugs].sort().join(',')}|${de}|${ate}`;
  const hit = faturadoPronto.get(chave);
  if (hit && hit.ate > Date.now()) return hit.v;
  let valor = 0;
  let leu = 0;
  const notas: string[] = [];
  const porDia: Record<string, number> = {};
  await Promise.all(
    slugs.map(async (slug) => {
      const unit = await prisma.unit.findUnique({ where: { slug } }).catch(() => null);
      if (!unit?.spineToken) {
        notas.push('a unidade não tem acesso à franquia');
        return;
      }
      const tz = unit.spineTimezone || 'America/Belem';
      const r = await searchTreatments(unit, { de, ate });
      if (!r.ok) {
        notas.push(`a franquia não respondeu (${(r.error ?? 'erro').slice(0, 60)})`);
        return;
      }
      const s = somarFaturado(r.data?.treatments ?? [], de, ate, (iso) => {
        const t = new Date(iso);
        return Number.isNaN(t.getTime()) ? null : instanteNoFuso(t, tz).slice(0, 10);
      });
      valor += s.valor;
      for (const [dia, v] of Object.entries(s.porDia)) porDia[dia] = Math.round(((porDia[dia] ?? 0) + v) * 100) / 100;
      leu++;
      if (r.data?.truncada) notas.push('a franquia tinha mais páginas que o limite: o valor pode estar abaixo do real');
      if (s.semPreco > 0) notas.push(`${s.semPreco} tratamento(s) sem preço na franquia ficaram de fora`);
    }),
  );
  const v: Faturado = leu ? { valor: Math.round(valor * 100) / 100, fonte: 'franquia', motivo: notas.join('; ') || null, porDia } : { valor: null, fonte: null, motivo: notas.join('; ') || 'franquia indisponível' };
  if (leu) faturadoPronto.set(chave, { ate: Date.now() + 10 * 60_000, v });
  if (faturadoPronto.size > 100) faturadoPronto.clear();
  return v;
}

/** Conversas que entraram em «Agendado» na janela (memória da régua). Em fatias: a lista de ids pode passar do limite de parâmetros do banco. */
async function agendadasNaJanela(ids: number[], j: JanelaDoPeriodo): Promise<Set<number>> {
  const achadas = new Set<number>();
  for (let i = 0; i < ids.length; i += 5000) {
    const linhas = await prisma.chatwootReguaVisto.findMany({
      where: { conversationId: { in: ids.slice(i, i + 5000) }, campo: 'etapa', valor: 'Agendado', inicial: false, desde: { gte: new Date(j.inicioMs), lte: new Date(j.fimMs) } },
      select: { conversationId: true },
    });
    for (const l of linhas) achadas.add(l.conversationId);
  }
  return achadas;
}

export async function funilMarketingHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizadoGestao(req, res);
  if (!a) return;
  try {
    const periodo = periodoDe(req);
    const caixa = caixaDe(req);
    const v = await memo(`mk|${a.logadoId ?? a.logado}|${periodo.chave}|${caixa}`, VALE_TELA_MS, async () => {
      const { conversas, slugs, cortou } = await conversasDasUnidades(a, caixa);
      const ids = conversas.map((c) => Number(c.id));
      const [agendadas, agendadasAntes, partida, lidos, gastos] = await Promise.all([
        agendadasNaJanela(ids, periodo),
        agendadasNaJanela(ids, periodo.anterior),
        prisma.chatwootReguaVisto.findFirst({ where: { conversationId: 0, campo: CAMPO_PARTIDA }, orderBy: { desde: 'asc' }, select: { desde: true } }).catch(() => null),
        referralsDe(a, doPeriodoDe(conversas, periodo).map((c) => Number(c.id))),
        gastosDasUnidades(slugs, periodo.de, periodo.ate),
      ]);
      const rel = montarMarketing(
        {
          conversas,
          referrals: lidos.mapa,
          anuncios: new Map<string, LinhaAnuncio>(gastos.linhas.map((l) => [l.anuncioId, l])),
          periodo,
          agendaramNoPeriodo: agendadas,
          // leitura cortada = a janela anterior pode estar incompleta: sem comparação em vez de comparação errada
          agendaramNoPeriodoAnterior: cortou ? null : agendadasAntes,
        },
        Date.now(),
      );
      return {
        ...rel,
        avisos: avisosDeLeitura({ cortou, semLer: lidos.semLer, falhas: lidos.falhas }),
        registroDesde: partida?.desde ? diaEmBelem(partida.desde.getTime()) : null,
        eu: a.logado,
      };
    });
    res.json(v);
  } catch (e) {
    falhouLista(res, e, 'marketing');
  }
}

export async function funilGestorHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizadoGestao(req, res);
  if (!a) return;
  try {
    const periodo = periodoDe(req, true);
    const caixa = caixaDe(req);
    const v = await memo(`gs|${a.logadoId ?? a.logado}|${periodo.chave}|${caixa}`, VALE_TELA_MS, async () => {
      const { conversas, slugs, cortou } = await conversasDasUnidades(a, caixa);
      const [lidos, gastos, faturado, diario, gastosAntes, faturadoAntes] = await Promise.all([
        referralsDe(a, doPeriodoDe(conversas, periodo).map((c) => Number(c.id))),
        gastosDasUnidades(slugs, periodo.de, periodo.ate),
        faturadoDasUnidades(slugs, periodo.de, periodo.ate),
        periodo.de !== periodo.ate ? gastoDiarioDasUnidades(slugs, periodo.de, periodo.ate) : Promise.resolve(null),
        gastoDiarioDasUnidades(slugs, periodo.anterior.de, periodo.anterior.ate),
        faturadoDasUnidades(slugs, periodo.anterior.de, periodo.anterior.ate),
      ]);
      const investido: Investido = gastos.investido.estado === 'ok' && diario ? { ...gastos.investido, porDia: diario.porDia } : gastos.investido;
      const painel = montarGestor({
        anterior: cortou
          ? null
          : { investido: gastosAntes ? { estado: 'ok', valor: gastosAntes.total, moeda: null, motivo: null } : { estado: 'conectar', valor: null, moeda: null, motivo: null }, faturado: faturadoAntes },
        conversas,
        referrals: lidos.mapa,
        gastos: gastos.investido.estado === 'ok' ? gastos.linhas : null,
        investido,
        faturadoFranquia: faturado,
        periodo,
      });
      return { ...painel, avisos: avisosDeLeitura({ cortou, semLer: lidos.semLer, falhas: lidos.falhas }), eu: a.logado };
    });
    res.json(v);
  } catch (e) {
    falhouLista(res, e, 'gestor');
  }
}

/**
 * O menu pergunta aqui se mostra «Marketing» e «Gestor» (a lista de gestores nunca vai no `menu.js`, que é público). Só visibilidade:
 * o servidor confere de novo em cada pedido de dado.
 */
export async function funilGestaoHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizadoComLogin(req, res);
  if (!a) return;
  res.set('Cache-Control', 'no-store').json({ gestao: podeVerGestao(a.papel, a.email, process.env.CHATWOOT_GESTORES) });
}

export async function funilCaixasHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  try {
    const r = (await cw(a, 'GET', 'inboxes')) as any;
    const lista = Array.isArray(r?.payload) ? r.payload : [];
    res.json(lista.filter((i: any) => !CAIXAS_HISTORICO.has(Number(i.id))).map((i: any) => ({ id: i.id, nome: String(i.name ?? `Caixa ${i.id}`) })));
  } catch (e) {
    falhou(res, e, 'caixas');
  }
}

const idSchema = z.coerce.number().int().positive();

/** A ficha do lead: conversa, contato, histórico, tarefas, listas dos campos e responsáveis possíveis. */
export async function funilConversaHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: 'conversa inválida' });
    return;
  }
  try {
    const [conv, msgs, defs, agentes] = await Promise.all([
      cw(a, 'GET', `conversations/${id.data}`) as Promise<any>,
      cw(a, 'GET', `conversations/${id.data}/messages`) as Promise<any>,
      definicoes(a),
      (cw(a, 'GET', 'agents') as Promise<any>).catch(() => []),
    ]);
    const lista = etapasDoAtributo(defs);
    const cartao = cartaoDaConversa(conv, lista);
    const historico = historicoDasMensagens(msgs);
    const contato = conv?.meta?.sender ?? {};
    const tarefas = await prisma.funilTarefa.findMany({
      where: { conta: a.c.conta!.conta, conversaId: id.data },
      orderBy: [{ feita: 'asc' }, { venceEm: 'asc' }],
      take: 50,
    });
    res.json({
      cartao,
      etapas: lista,
      desdeEtapa: desdeAEtapa(historico, cartao.etapa, cartao.criado),
      atributos: conv?.custom_attributes ?? {},
      responsavelId: Number(conv?.meta?.assignee?.id) || null,
      caixaId: cartao.caixaId,
      contato: {
        nome: cartao.nome,
        telefone: cartao.telefone,
        email: typeof contato.email === 'string' ? contato.email : null,
        avatar: cartao.avatar,
        atributos: contato.custom_attributes && typeof contato.custom_attributes === 'object' ? contato.custom_attributes : {},
      },
      listas: {
        qualificacao: valoresDoAtributo(defs, 'qualificacao'),
        motivo_nao_agendamento: valoresDoAtributo(defs, 'motivo_nao_agendamento'),
      },
      agentes: (Array.isArray(agentes) ? agentes : []).map((g: any) => ({ id: Number(g.id), nome: String(g.available_name ?? g.name ?? g.id) })),
      historico,
      tarefas: tarefas.map((t) => ({ id: t.id, texto: t.texto, venceEm: t.venceEm, responsavel: t.responsavel, feita: t.feita })),
      chatwoot: a.c.conta!.url,
      conta: a.c.conta!.conta,
      podeEscrever: !!a.sessao,
    });
  } catch (e) {
    falhou(res, e, 'ficha', { conversa: id.data });
  }
}

const moverSchema = z.object({
  conversaId: z.number().int().positive(),
  etapa: z.string().trim().min(1).max(60),
  quem: z.string().trim().max(80).nullable().optional(),
});

/** Lê os atributos atuais e grava a mistura (o Chatwoot troca o objeto inteiro: sem isto, os outros campos sumiam). */
async function gravarAtributos(a: Acesso, conversaId: number, mudar: Record<string, unknown>): Promise<Record<string, unknown>> {
  const conv = (await cw(a, 'GET', `conversations/${conversaId}`)) as any;
  const atuais = (conv?.custom_attributes && typeof conv.custom_attributes === 'object' ? conv.custom_attributes : {}) as Record<string, unknown>;
  const novos: Record<string, unknown> = { ...atuais };
  for (const [k, v] of Object.entries(mudar)) {
    if (v === null) delete novos[k];
    else novos[k] = v;
  }
  await cw(a, 'POST', `conversations/${conversaId}/custom_attributes`, { corpo: { custom_attributes: novos } });
  return atuais;
}

export async function funilMoverHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const p = moverSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  // logado pelo Chatwoot: vale o nome do perfil, não o que a página mandou
  const quem = a.logado ?? p.data.quem ?? null;
  try {
    const lista = etapasDoAtributo(await definicoes(a));
    if (!lista.includes(p.data.etapa)) {
      res.status(400).json({ error: `etapa desconhecida: ${p.data.etapa}` });
      return;
    }
    const conv = (await cw(a, 'GET', `conversations/${p.data.conversaId}`)) as any;
    const atual = conv?.custom_attributes?.[ATRIBUTO_ETAPA];
    const de = typeof atual === 'string' && lista.includes(atual) ? atual : lista[0]!;
    if (de === p.data.etapa) {
      res.json({ ok: true, igual: true });
      return;
    }
    await gravarAtributos(a, p.data.conversaId, { [ATRIBUTO_ETAPA]: p.data.etapa });
    await cw(a, 'POST', `conversations/${p.data.conversaId}/messages`, {
      corpo: { content: notaDaMudanca(de, p.data.etapa, quem), private: true, message_type: 'outgoing' },
    }).catch((e) => logger.warn({ err: String(e), conversa: p.data.conversaId }, 'funil: a nota interna falhou (a etapa foi gravada)'));
    logger.info({ conversa: p.data.conversaId, de, para: p.data.etapa, quem }, 'funil: etapa mudada');
    res.json({ ok: true, de, para: p.data.etapa });
  } catch (e) {
    falhou(res, e, 'mover', { conversa: p.data.conversaId });
  }
}

const camposSchema = z.object({ conversaId: z.number().int().positive(), campos: z.record(z.string(), z.unknown()) });

export async function funilCamposHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const p = camposSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  try {
    const conf = camposParaGravar(p.data.campos, await definicoes(a));
    if (!conf.ok) {
      res.status(400).json({ error: conf.erro });
      return;
    }
    await gravarAtributos(a, p.data.conversaId, conf.campos);
    logger.info({ conversa: p.data.conversaId, campos: Object.keys(conf.campos), quem: a.logado }, 'funil: campos gravados');
    res.json({ ok: true });
  } catch (e) {
    falhou(res, e, 'campos', { conversa: p.data.conversaId });
  }
}

const responsavelSchema = z.object({ conversaId: z.number().int().positive(), agenteId: z.number().int().positive().nullable() });

export async function funilResponsavelHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const p = responsavelSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  try {
    await cw(a, 'POST', `conversations/${p.data.conversaId}/assignments`, { corpo: { assignee_id: p.data.agenteId } });
    res.json({ ok: true });
  } catch (e) {
    falhou(res, e, 'responsável', { conversa: p.data.conversaId });
  }
}

const textoSchema = z.object({ conversaId: z.number().int().positive(), texto: z.string().trim().min(1).max(4000) });

/** Nota interna (só a equipe vê). */
export async function funilNotaHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const p = textoSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'escreva a nota' });
    return;
  }
  try {
    await cw(a, 'POST', `conversations/${p.data.conversaId}/messages`, { corpo: { content: p.data.texto, private: true, message_type: 'outgoing' } });
    res.json({ ok: true });
  } catch (e) {
    falhou(res, e, 'nota', { conversa: p.data.conversaId });
  }
}

/** Mensagem para a paciente (sai pelo WhatsApp da caixa). Só com o login da pessoa (no Chatwoot fica o nome de quem mandou). */
export async function funilMensagemHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  if (!a.sessao) {
    res.status(403).json({ error: 'para mandar mensagem, abra o funil pelo Chatwoot (com o seu login)' });
    return;
  }
  const p = textoSchema.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'escreva a mensagem' });
    return;
  }
  try {
    await cw(a, 'POST', `conversations/${p.data.conversaId}/messages`, { corpo: { content: p.data.texto, private: false, message_type: 'outgoing' } });
    logger.info({ conversa: p.data.conversaId, quem: a.logado }, 'funil: mensagem enviada pela ficha');
    res.json({ ok: true });
  } catch (e) {
    falhou(res, e, 'mensagem', { conversa: p.data.conversaId });
  }
}

/** Confere que a pessoa enxerga a conversa (com o login dela, o Chatwoot recusa conversa de caixa alheia). */
async function enxerga(a: Acesso, conversaId: number): Promise<void> {
  await cw(a, 'GET', `conversations/${conversaId}`);
}

const tarefaSchema = z.object({
  conversaId: z.number().int().positive(),
  texto: z.string().trim().min(1).max(300),
  venceEm: z.coerce.date(),
  responsavel: z.string().trim().max(80).nullable().optional(),
});

export async function funilTarefaHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const p = tarefaSchema.safeParse(req.body);
  if (!p.success || Number.isNaN(p.data.venceEm.getTime())) {
    res.status(400).json({ error: 'escreva a tarefa e escolha o dia e a hora' });
    return;
  }
  try {
    await enxerga(a, p.data.conversaId);
    const t = await prisma.funilTarefa.create({
      data: {
        conta: a.c.conta!.conta,
        conversaId: p.data.conversaId,
        texto: p.data.texto,
        venceEm: p.data.venceEm,
        responsavel: p.data.responsavel || a.logado,
        criadoPor: a.logado,
      },
    });
    res.json({ ok: true, id: t.id });
  } catch (e) {
    falhou(res, e, 'tarefa', { conversa: p.data.conversaId });
  }
}

const feitaSchema = z.object({ feita: z.boolean() });

export async function funilTarefaFeitaHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  const id = idSchema.safeParse(req.params.id);
  const p = feitaSchema.safeParse(req.body);
  if (!id.success || !p.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  try {
    const t = await prisma.funilTarefa.findFirst({ where: { id: id.data, conta: a.c.conta!.conta } });
    if (!t) {
      res.status(404).json({ error: 'tarefa não encontrada' });
      return;
    }
    await enxerga(a, t.conversaId);
    await prisma.funilTarefa.update({ where: { id: t.id }, data: { feita: p.data.feita, feitaEm: p.data.feita ? new Date() : null } });
    res.json({ ok: true });
  } catch (e) {
    falhou(res, e, 'tarefa feita', { tarefa: id.data });
  }
}

const novoSchema = z.object({
  nome: z.string().trim().min(1).max(80),
  telefone: z.string().trim().min(8).max(30),
  caixaId: z.number().int().positive(),
  etapa: z.string().trim().min(1).max(60),
});

/** Adição rápida: cria o contato e a conversa (sem mandar nada para a pessoa) já na etapa da coluna. */
export async function funilNovoHandler(req: Request, res: Response): Promise<void> {
  const a = await autorizado(req, res);
  if (!a) return;
  if (!a.sessao) {
    res.status(403).json({ error: 'para criar lead, abra o funil pelo Chatwoot (com o seu login)' });
    return;
  }
  const p = novoSchema.safeParse(req.body);
  const telefone = p.success ? telefoneParaCadastro(p.data.telefone) : null;
  if (!p.success || !telefone) {
    res.status(400).json({ error: 'preencha o nome, o telefone com DDD e a caixa' });
    return;
  }
  try {
    const lista = etapasDoAtributo(await definicoes(a));
    if (!lista.includes(p.data.etapa)) {
      res.status(400).json({ error: `etapa desconhecida: ${p.data.etapa}` });
      return;
    }
    const r = (await cw(a, 'POST', 'contacts', { corpo: { name: p.data.nome, phone_number: telefone, inbox_id: p.data.caixaId } })) as any;
    const contato = r?.payload?.contact ?? r?.payload;
    const origem = r?.payload?.contact_inbox?.source_id ?? contato?.contact_inboxes?.[0]?.source_id;
    if (!contato?.id || !origem) throw new Error('o Chatwoot não devolveu o contato');
    const conv = (await cw(a, 'POST', 'conversations', {
      corpo: { source_id: origem, inbox_id: p.data.caixaId, contact_id: contato.id, custom_attributes: { [ATRIBUTO_ETAPA]: p.data.etapa } },
    })) as any;
    logger.info({ conversa: conv?.id, etapa: p.data.etapa, quem: a.logado }, 'funil: lead criado pela adição rápida');
    res.json({ ok: true, conversaId: conv?.id ?? null });
  } catch (e) {
    const msg = String(e);
    if (/phone_number|taken|already/i.test(msg)) {
      res.status(409).json({ error: 'já existe um contato com esse telefone — procure pelo nome na busca' });
      return;
    }
    falhou(res, e, 'adição rápida');
  }
}

export function paginaFunilHandler(_req: Request, res: Response): void {
  if (!contexto()?.conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Funil desligado.</p>');
    return;
  }
  res.type('html').send(
    PAGINA.replace('__ORIGEM_CW__', JSON.stringify(new URL(contexto()!.conta!.url).origin))
      .split('/*__TELAS_CSS__*/').join(TELAS_CSS)
      .split('/*__TELAS_JS__*/').join(TELAS_JS),
  );
}

const PAGINA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Funil · Doutor Digital</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--fundo:#f8f9fb;--painel:#ffffff;--cartao:#ffffff;--linha:#e4e7ec;--txt:#1f2d3d;--fraco:#64748b;--link:#1f73d6;--azul:#1f93ff;--rosa:#d93036;--amarelo:#c27803;--verde:#1f8a54;--suave:#f1f4f8;--sombra:0 1px 2px rgba(16,24,40,.06)}
*{box-sizing:border-box}[hidden]{display:none!important}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif;background:var(--fundo);color:var(--txt)}
button,select,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--link);outline-offset:1px}
.topo{display:flex;align-items:center;gap:10px;min-height:56px;padding:8px 60px 8px 20px;border-bottom:1px solid var(--linha);flex-wrap:wrap;background:var(--painel)}
.topo h1{font-size:17px;margin:0 6px 0 0;font-weight:600}
.campo-topo{height:34px;padding:0 10px;border:1px solid var(--linha);border-radius:8px;background:var(--painel)}
.busca{flex:1;min-width:160px;max-width:420px}
.chip{height:34px;padding:0 12px;border:1px solid var(--linha);border-radius:8px;background:transparent;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--rosa)}
.chip.on{border-color:var(--rosa);background:#fdecec}
#msg{color:var(--fraco);font-size:13px}
.dir{margin-left:auto;display:flex;gap:10px;align-items:center}
.bt{height:34px;padding:0 14px;border-radius:8px;font-weight:600;font-size:13px;border:1px solid var(--linha);background:var(--painel);cursor:pointer}
.bt.azul{background:var(--azul);border-color:var(--azul);color:#fff}
.bt:disabled{opacity:.5;cursor:default}
.quadro{flex:1;display:flex;gap:14px;padding:0 20px 20px;overflow:auto}
.col{flex:0 0 290px;display:flex;flex-direction:column}
.col .cab{position:sticky;top:0;z-index:1;background:var(--fundo);padding:16px 2px 8px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.col .cab b{font-size:13.5px;font-weight:600}.col .cab b::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--cor,#9aa9b8);margin-right:7px;vertical-align:1px}
.col .cab .ln{display:none}
.col .cab small{color:var(--fraco);font-size:12.5px;margin-left:auto}
.col.alvo{background:#eaf4ff;border-radius:10px}
.rap{flex:0 0 auto;margin:4px 0 8px;border:1px dashed #cfd6df;border-radius:8px;min-height:36px;display:grid;place-items:center;cursor:pointer;background:transparent;width:100%;color:var(--fraco)}
.rap:hover{border-color:var(--link);color:var(--link)}
.formr{display:flex;flex-direction:column;gap:6px;margin:4px 0 8px;padding:10px;border:1px solid var(--linha);border-radius:8px;background:var(--painel);box-shadow:var(--sombra)}
.formr input,.formr select{height:32px;padding:0 8px;border:1px solid var(--linha);background:var(--painel);border-radius:6px}
.formr div{display:flex;gap:6px}
.k{flex:0 0 auto;position:relative;background:var(--cartao);border:1px solid var(--linha);border-radius:10px;margin-bottom:8px;padding:11px 12px 11px 54px;cursor:pointer;min-height:72px;box-shadow:var(--sombra)}
.k{transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease,opacity .16s ease}
.k:hover{border-color:#c5cfdb;box-shadow:0 6px 16px rgba(16,24,40,.10);transform:translateY(-2px)}
.k.novo{animation:entra .32s cubic-bezier(.2,.8,.2,1) backwards;animation-delay:calc(var(--i,0) * 35ms)}
@keyframes entra{from{transform:translateY(8px)}to{transform:none}}
.k.arrastando{opacity:.55;transform:rotate(2.5deg) scale(1.02);box-shadow:0 12px 28px rgba(16,24,40,.18)}
.k.chegou{animation:chegou 1.1s ease-out}
@keyframes chegou{0%{box-shadow:0 0 0 0 rgba(31,147,255,.55)}70%{box-shadow:0 0 0 10px rgba(31,147,255,0)}100%{box-shadow:var(--sombra)}}
.col{transition:background .15s ease;border-radius:10px}
.col.alvo{background:#eaf4ff;outline:2px dashed #9ccbff;outline-offset:-2px}
.fantasma{flex:0 0 290px;padding-top:16px}
.fantasma i{display:block;height:74px;border-radius:10px;margin-bottom:8px;background:linear-gradient(90deg,#eef1f5 0,#f7f9fb 40%,#eef1f5 80%);background-size:300% 100%;animation:brilho 1.2s ease-in-out infinite}
.fantasma i:first-child{height:18px;width:55%;margin-bottom:14px}
@keyframes brilho{from{background-position:100% 0}to{background-position:0 0}}
.lead:not([hidden]){animation:desliza .26s cubic-bezier(.2,.8,.2,1)}
@keyframes desliza{from{transform:translateX(24px)}to{transform:none}}
.k .esperando{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--rosa);margin-right:6px;vertical-align:1px;animation:pulsa 1.6s ease-in-out infinite}
@keyframes pulsa{0%,100%{opacity:1}50%{opacity:.35}}
.k.esta{border-color:var(--link)}
.k .av{position:absolute;left:12px;top:12px;width:32px;height:32px;border-radius:50%;background:var(--avf,#eef1f5);color:var(--av,#64748b);display:grid;place-items:center;font-weight:600;font-size:12px;overflow:hidden}
.k .av img,.pessoa .av img{width:100%;height:100%;object-fit:cover}
.k .l1{display:flex;gap:8px}.k .ct{font-size:12.5px;color:var(--fraco);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k .dt{margin-left:auto;color:var(--fraco);font-size:12.5px;white-space:nowrap}
.k .dt.esp{color:var(--rosa);font-weight:700}
.k .ld{color:var(--txt);font-weight:600;font-size:14px;margin:1px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tags{display:flex;gap:4px;flex-wrap:wrap}
.tags span{background:var(--suave);color:#4a5565;font-size:11.5px;padding:1px 7px;border-radius:10px}
.k .bal{display:block;max-width:calc(100% - 52px);margin-top:7px;background:var(--suave);color:#3c4858;border-radius:8px;padding:3px 9px;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:max-content}
.k .st{position:absolute;right:11px;bottom:11px;display:flex;align-items:center;gap:4px;font-size:12px;color:var(--amarelo)}
.k .st::after{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.k .st.vencida{color:var(--rosa)}.k .st.hoje,.k .st.futura{color:var(--verde)}
.vazio{color:var(--fraco);text-align:center;padding:18px 6px;font-size:13px}
/* ficha */
.lead{flex:1;display:flex;min-height:0}
.esq{flex:0 0 360px;background:var(--painel);border-right:1px solid var(--linha);display:flex;flex-direction:column;overflow-y:auto}
.esq .t{display:flex;align-items:center;gap:10px;padding:16px 20px 6px;font-size:19px;font-weight:600}
.esq .t button{background:none;border:0;color:var(--fraco);font-size:22px;cursor:pointer;padding:0 4px}
.esq .tags{padding:0 20px}
.etapa{margin:12px 20px 0}.etapa small{color:var(--fraco);text-transform:uppercase;font-size:12px}
.etapa .nm{display:flex;align-items:center;gap:8px}
.etapa select{flex:1;background:var(--suave);border:1px solid var(--linha);border-radius:8px;font-weight:600;font-size:14px;padding:6px 8px;cursor:pointer}
.etapa select option{background:var(--painel)}
.etapa em{font-style:normal;color:var(--fraco);white-space:nowrap}
.prog{display:flex;gap:3px;margin-top:8px}.prog span{flex:1;height:4px;border-radius:2px;background:#e4e7ec}.prog span.f{background:var(--azul)}
.abas{display:flex;gap:16px;padding:16px 20px 0;border-bottom:1px solid var(--linha)}
.abas button{background:none;border:0;padding:0 0 9px;color:var(--fraco);font-weight:500;cursor:pointer}
.abas button.on{color:var(--link);font-weight:600;border-bottom:2px solid var(--link)}
.cp{display:grid;grid-template-columns:120px 1fr;gap:8px 10px;padding:14px 20px;font-size:14px;align-items:center}
.cp label{color:var(--fraco)}
.cp select,.cp input{background:var(--painel);border:1px solid var(--linha);border-radius:6px;padding:5px 8px;width:100%}
.cp select option{background:var(--painel)}
.cp span{word-break:break-word}
.pessoa{padding:12px 20px;border-top:1px solid var(--linha)}
.pessoa .n{display:flex;align-items:center;gap:10px;font-weight:700}
.pessoa .av{width:34px;height:34px;border-radius:50%;background:var(--avf,#eef1f5);color:var(--av,#64748b);display:grid;place-items:center;font-size:12px;font-weight:600;overflow:hidden}
.pessoa .cp{padding:10px 0 0}
.rodape{margin-top:auto;display:flex;justify-content:space-around;align-items:center;padding:12px;border-top:1px solid var(--linha);background:var(--fundo)}
.rodape a,.rodape button{color:var(--link);font-weight:500;background:none;border:0;cursor:pointer;text-decoration:none;font-size:14px}
.feed{flex:1;display:flex;flex-direction:column;min-width:0}
.rol{flex:1;overflow-y:auto;padding:16px 22px;display:flex;flex-direction:column;gap:10px;background:var(--fundo)}
.dia{align-self:center;background:var(--painel);border:1px solid var(--linha);border-radius:10px;padding:0 10px;font-size:12.5px;color:var(--fraco)}
.m{max-width:66%;padding:8px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.m small{display:block;color:var(--fraco);font-size:12px;margin-bottom:2px;white-space:normal}
.m.ela{align-self:flex-start;background:var(--painel);border:1px solid var(--linha)}.m.nos{align-self:flex-end;background:#1f93ff;color:#fff}.m.nos small{color:#dcebff}
.sis{align-self:center;color:var(--fraco);font-size:12.5px;text-align:center}
.nota{align-self:stretch;background:#fff8e6;border:1px solid #fde4a8;border-radius:8px;padding:7px 12px;white-space:pre-wrap;word-break:break-word}
.nota small{display:block;color:#8a6d1c;font-size:12px}
.tf{align-self:stretch;display:flex;align-items:center;gap:10px;background:var(--painel);border:1px solid var(--linha);border-left:3px solid var(--verde);border-radius:8px;padding:7px 12px}
.tf.vencida{background:#fdecec;border-left-color:var(--rosa)}
.tf.feita{opacity:.55;text-decoration:line-through}
.tf small{margin-left:auto;color:var(--fraco);white-space:nowrap}.tf.vencida small{color:var(--rosa);font-weight:700}
.comp{border-top:1px solid var(--linha);padding:10px 22px 14px;background:var(--painel)}
.comp .tb{display:flex;gap:18px;margin-bottom:8px}
.comp .tb button{background:none;border:0;color:var(--fraco);cursor:pointer;padding:0}
.comp .tb button.on{color:var(--link);font-weight:600}
.comp textarea{width:100%;height:64px;background:var(--painel);border:1px solid var(--linha);border-radius:8px;padding:8px 10px;resize:vertical}
.comp .linha2{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.comp .linha2 input,.comp .linha2 select{height:34px;padding:0 8px;background:var(--painel);border:1px solid var(--linha);border-radius:8px}
.comp .linha2 .bt{margin-left:auto}
.aviso{color:var(--fraco);font-size:12.5px}
@media (max-width:760px){.lead{flex-direction:column}.esq{flex:0 0 auto;max-height:45vh}.col{flex-basis:260px}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

/* ── quadro (redesenho: raias, cartão limpo) ── */
body{background:#f4f6f9}
.topo{box-shadow:0 1px 0 var(--linha);border-bottom:0}
.quadro{gap:12px;padding:14px 16px 20px;align-items:flex-start}
.col{flex:0 0 288px;background:#eef1f5;border-radius:12px;max-height:100%;display:flex;flex-direction:column;border-top:3px solid var(--cor,#94a3b8)}
.col .cab{position:static;display:block;background:transparent;padding:10px 12px 8px;text-align:left}
.col .t1{display:flex;align-items:center;gap:8px}
.col .nomeEtapa{font-weight:600;font-size:13.5px;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.col .qtd{font-size:12px;font-weight:600;color:#475467;background:#fff;border:1px solid var(--linha);border-radius:10px;padding:0 7px;line-height:18px}
.col .mais{margin-left:auto;width:26px;height:26px;border-radius:8px;border:0;background:transparent;color:#475467;display:grid;place-items:center;cursor:pointer;transition:background .15s,color .15s}
.col .mais:hover{background:#fff;color:var(--azul)}
.col .soma{font-size:12px;color:var(--fraco);margin-top:2px;font-variant-numeric:tabular-nums}
.col .lista{overflow-y:auto;padding:2px 8px 10px;display:flex;flex-direction:column;gap:8px;min-height:120px}
.col.alvo{background:#e3efff;outline:2px dashed #8cc2ff;outline-offset:-3px}
.k{position:relative;background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:10px 12px 9px;margin:0;min-height:0;box-shadow:0 1px 2px rgba(16,24,40,.05)}
.k.espera{box-shadow:inset 3px 0 0 var(--rosa),0 1px 2px rgba(16,24,40,.05)}
.k.esta{border-color:var(--azul)}
.k .l1{display:flex;align-items:center;gap:8px}
.k .av{position:static;flex:0 0 24px;width:24px;height:24px;font-size:10.5px}
.k .ld{flex:1;min-width:0;margin:0;font-size:14px;font-weight:600;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k .dt{flex:0 0 auto;font-size:12px;color:var(--fraco);font-variant-numeric:tabular-nums}
.k.espera .dt{color:var(--rosa);font-weight:600}
.k .msgk{margin:6px 0 0;font-size:13px;line-height:1.4;color:#5b6676;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.k .msgk.dela{color:#344054}
.k .pe{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:9px;font-size:12px;color:var(--fraco)}
.k .valor{color:#067647;font-weight:600;font-variant-numeric:tabular-nums}
.k .qual{display:inline-flex;align-items:center;gap:4px}
.k .qual::before{content:"";width:6px;height:6px;border-radius:50%;background:#94a3b8}
.k .q-quente::before{background:#e5484d}.k .q-morno::before{background:#f59e0b}.k .q-frio::before{background:#3b82f6}
.k .tarefa{display:inline-flex;align-items:center;gap:4px}
.k .tarefa.sem{color:#667085}.k .tarefa.vencida{color:var(--rosa);font-weight:600}.k .tarefa.hoje{color:#b54708;font-weight:600}.k .tarefa.futura{color:#067647}
.k .etq{max-width:84px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.k .resp{margin-left:auto;width:22px;height:22px;border-radius:50%;background:#f2f4f7;border:1px solid #e4e7ec;color:#475467;display:grid;place-items:center;font-size:9.5px;font-weight:700}
.col .vazio{border:1px dashed #d0d5dd;border-radius:10px;padding:16px 8px;color:#667085;font-size:12.5px;text-align:center}
.formr{margin:0;border-radius:10px}
.fantasma{flex:0 0 288px;background:#eef1f5;border-radius:12px;padding:12px 8px}

/* ── topo com resumo e filtros; ações rápidas; coluna recolhida ── */
.topo{display:block;padding:10px 60px 10px 20px;background:#fff}
.topo .linha-a,.topo .linha-b{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.topo .linha-b{margin-top:10px}
.topo h1{font-size:18px;font-weight:700;letter-spacing:-.01em;margin-right:8px}
.resumo{display:flex;gap:6px;flex-wrap:wrap}
.resumo .num{display:flex;align-items:baseline;gap:6px;height:34px;padding:0 12px;border:1px solid var(--linha);border-radius:10px;background:#fff;cursor:pointer;transition:border-color .15s,background .15s}
.resumo .num:disabled{cursor:default}
.resumo .num b{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.resumo .num span{font-size:12px;color:var(--fraco)}
.resumo .num.alerta b{color:var(--rosa)}
.resumo .num:not(:disabled):hover{border-color:#c5cfdb}
.resumo .num.on{border-color:var(--azul);background:#eef6ff}
.topo .dir{margin-left:auto;display:flex;align-items:center;gap:8px}
.atual{font-size:12px;color:#667085}
.ic{width:34px;height:34px;border-radius:10px;border:1px solid var(--linha);background:#fff;cursor:pointer;font-size:16px;color:#475467;transition:transform .3s}
.ic:hover{transform:rotate(90deg)}
.busca-c{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid var(--linha);border-radius:10px;background:#fff;min-width:220px;flex:0 1 280px}
.busca-c span{color:#98a2b3;font-size:15px}
.busca-c input{border:0;outline:0;flex:1;min-width:0;background:transparent;height:30px}
.busca-c:focus-within{border-color:var(--azul);box-shadow:0 0 0 3px rgba(31,147,255,.15)}
.filtros{display:flex;gap:6px;flex-wrap:wrap}
#ordem{width:auto;flex:0 0 auto}
.filtros .chip{height:30px;padding:0 11px;border-radius:15px;font-size:12.5px;border:1px solid var(--linha);background:#fff;color:#475467}
.filtros .chip::before{display:none}
.filtros .chip:hover{border-color:#c5cfdb}
.filtros .chip.on{background:var(--txt);border-color:var(--txt);color:#fff}
.k .acoes{position:absolute;top:8px;right:8px;display:flex;gap:4px;opacity:0;transform:translateY(-2px);transition:opacity .15s,transform .15s;pointer-events:none}
.k:hover .acoes,.k:focus-within .acoes{opacity:1;transform:none;pointer-events:auto}
.k .acoes button,.k .acoes a{width:26px;height:26px;border-radius:8px;border:1px solid var(--linha);background:#fff;display:grid;place-items:center;font-size:13px;color:#475467;cursor:pointer;text-decoration:none;box-shadow:0 1px 3px rgba(16,24,40,.08)}
.k .acoes button:hover,.k .acoes a:hover{border-color:var(--azul);color:var(--azul)}
.k:hover .dt{visibility:hidden}
.col .nomeEtapa{background:none;border:0;padding:0;cursor:pointer;text-align:left;font:inherit;font-weight:600;font-size:13.5px}
.col.fechada{flex:0 0 46px;cursor:default}
.col.fechada .cab{padding:12px 6px}
.col.fechada .t1{flex-direction:column;gap:10px}
.col.fechada .nomeEtapa{writing-mode:vertical-rl;transform:rotate(180deg);max-height:220px}
.col.fechada .mais,.col.fechada .soma,.col.fechada .lista{display:none}

/* ── acabamento do topo: a fonte do Chatwoot (Inter) e tudo na mesma altura (34px), mesma borda, mesmo arredondamento ── */
.topo .linha-a,.topo .linha-b{gap:8px}
.topo h1{font-size:18px;line-height:34px;margin-right:4px}
.resumo{gap:8px}
.resumo .num{align-items:center;border-radius:8px;padding:0 12px;font-family:inherit}
.resumo .num span{font-size:12.5px}
.campo-topo{height:34px;border-radius:8px;padding:0 32px 0 12px;font-size:13.5px;color:var(--txt);-webkit-appearance:none;appearance:none;cursor:pointer;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%2364748b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 11px center}
.campo-topo:hover{border-color:#c5cfdb}
.campo-topo:focus{outline:0;border-color:var(--azul);box-shadow:0 0 0 3px rgba(31,147,255,.15)}
#caixa{min-width:200px}
.busca-c{border-radius:8px;flex:1 1 240px;max-width:400px;min-width:200px}
.busca-c input{font-size:13.5px}
.busca-c input::placeholder{color:#98a2b3}
.filtros{gap:8px}
.filtros .chip{height:34px;border-radius:8px;padding:0 12px;font-size:13px;font-weight:500}
.ic,.bt{border-radius:8px}
.ic{display:grid;place-items:center}
#msg{margin-left:auto;font-size:12.5px;color:var(--fraco);white-space:nowrap}

/* ── tela HOJE (design Início do painel da Lia) ── */
.quadro.hoje{display:block;overflow:auto;padding:22px 28px 48px}
.hj-sauda h2{font-size:22px;font-weight:700;margin:0;letter-spacing:-.01em}
.hj-sauda p{margin:2px 0 0;color:var(--fraco)}
.hj-nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.hj-num{border-radius:12px;padding:12px 14px;background:#fff;border:1px solid var(--linha)}
.hj-num small{font-size:12.5px;color:#475467}
.hj-num b{display:block;font-size:26px;font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}
.hj-num.azul{background:#eef4ff;border-color:#dfe8fb}.hj-num.amar{background:#fdf3e7;border-color:#f6e5cf}.hj-num.verde{background:#e9f6ee;border-color:#d4ecdd}
.hj-meta-de{font-size:14px;font-weight:600;color:#475467}
.hj-meta-barra{height:6px;border-radius:3px;background:#d4ecdd;margin:6px 0 4px;overflow:hidden}.hj-meta-barra i{display:block;height:100%;background:#12855a;border-radius:3px}
.hj-num small.hj-meta-txt{display:block;font-size:11.5px}
.hj-lia{background:#0f1a3a;color:#fff;border-radius:14px;padding:14px 16px;margin-bottom:16px}
.hj-lia h3,.hj-box h3{margin:0 0 12px;font-size:15px;font-weight:700}
.hj-lia-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.hj-lia-card{background:#1d2b55;border:0;border-radius:10px;padding:12px 14px;color:#fff;text-align:left;cursor:pointer;font:inherit}
.hj-lia-card:hover{background:#26386c}
.hj-lia-card b{display:block;font-size:22px;font-weight:700}
.hj-lia-card span{font-size:14px}
.hj-lista{background:#fff;color:var(--txt);border-radius:10px;padding:4px 14px;margin-top:12px}
.hj-box{background:#fff;border:1px solid var(--linha);border-radius:14px;padding:14px 16px;margin-bottom:16px}
.hj-linha{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--linha)}
.hj-lista .hj-linha:first-child,.hj-box h3+.hj-linha{border-top:0}
.hj-linha>div{flex:1;min-width:0}
.hj-linha .nm{font-weight:600}
.det{font-size:12.5px;color:var(--fraco)}
.hj-tab{width:100%;border-collapse:collapse}
.hj-tab th{font-size:12px;color:#475467;text-align:left;font-weight:600;padding:8px}
.hj-tab td{padding:9px 8px;border-top:1px solid var(--linha);font-variant-numeric:tabular-nums}

@media (max-width:760px){.col{flex-basis:260px}.topo{padding-right:56px}}
/*__TELAS_CSS__*/
</style></head><body>
<div class="topo" id="topo">
  <div class="linha-a">
    <h1>Funil</h1>
    <div class="resumo" id="resumo"></div>
    <div class="dir"><span id="atual" class="atual"></span><button id="recarregar" class="ic" type="button" title="Atualizar agora" aria-label="Atualizar agora">↻</button><button id="novo" class="bt azul" type="button" hidden title="Novo lead (N)">+ Novo lead</button></div>
  </div>
  <div class="linha-b">
    <select id="caixa" class="campo-topo" aria-label="Caixa de entrada"><option value="">Todas as caixas</option></select>
    <label class="busca-c"><span aria-hidden="true">⌕</span><input id="busca" placeholder="Buscar nome ou telefone" title="Atalho: /" aria-label="Buscar"></label>
    <div class="filtros" id="filtros" role="group" aria-label="Filtros"></div>
    <select id="ordem" class="campo-topo" aria-label="Ordenar"><option value="recente">Mais recentes</option><option value="espera">Esperando há mais tempo</option><option value="valor">Maior valor</option></select>
    <span id="msg" role="status"></span>
  </div>
</div>
<main class="quadro" id="quadro"></main>
<section class="lead" id="lead" hidden></section>
<script>
(function(){
  var q=new URLSearchParams(location.search), K=q.get('k')||'', MENU=q.get('menu')==='1', TELA=['hoje','oport','mkt','gestor'].indexOf(q.get('tela'))>=0?q.get('tela'):'', ORIGEM_CW=__ORIGEM_CW__, DENTRO=window.parent!==window;
  var S=null, iniciado=false, timer=null, morta=null, dados=null, caixas=[], aberta=null, ficha=null, filtro='', recolhidas={}, atualizadoEm=0, arrastando=null, formNaColuna=null, aba='principal', modo='mensagem', ctxConversa=null;
  var CORES=['#64748b','#1f93ff','#d97706','#7c3aed','#4f46e5','#16a34a','#15803d','#0d9488','#db2777','#dc2626','#94a3b8'];
  var AV=[['#1f73d6','#e6f1ff'],['#c2410c','#fff0e6'],['#15803d','#e8f7ee'],['#7c3aed','#f1ebff'],['#be185d','#fdebf3'],['#0f766e','#e6f6f4'],['#a16207','#fdf6e3'],['#4338ca','#eceeff']];
  var vistos=null, chegou=null;
  function $(id){ return document.getElementById(id); }
  function el(t,c,x){ var e=document.createElement(t); if(c) e.className=c; if(x!=null) e.textContent=x; return e; }
  function msg(t){ $('msg').textContent=t||''; }
  function cabecalhos(){ var h={'Content-Type':'application/json'}; if(S){ h['X-CW-Token']=S.token; h['X-CW-Client']=S.client; h['X-CW-Uid']=S.uid; } else if(K) h['X-Funil-Chave']=K; return h; }
  function pedirSessao(){ if(DENTRO){ try{ window.parent.postMessage({event:'funil:pede-sessao'},ORIGEM_CW); }catch(e){} } }
  async function api(m,p,b){
    var r=await fetch('/api/public/funil/'+p,{method:m,headers:cabecalhos(),body:b?JSON.stringify(b):undefined});
    var j=await r.json().catch(function(){ return {}; });
    if(r.status===403&&S&&j.sessao==='invalida'){ morta=S.token; S=null; parar(); iniciado=false; pedirSessao(); }
    if(r.status===403&&S&&j.sessao==='sem-conta') parar();
    if(!r.ok){ var er=new Error(j.error||('erro '+r.status)); er.status=r.status; er.semPermissao=!!j.semPermissao; throw er; }
    return j;
  }
  function parar(){ if(timer){ clearInterval(timer); timer=null; } }
  function brl(v){ return 'R$ '+Number(v||0).toLocaleString('pt-BR',{maximumFractionDigits:2}); }
  function doisd(n){ return (n<10?'0':'')+n; }
  function quando(s){
    if(!s) return ''; var d=new Date(s*1000), hoje=new Date(), ontem=new Date(Date.now()-864e5);
    var hm=doisd(d.getHours())+':'+doisd(d.getMinutes());
    if(d.toDateString()===hoje.toDateString()) return 'Hoje '+hm;
    if(d.toDateString()===ontem.toDateString()) return 'Ontem '+hm;
    return doisd(d.getDate())+'/'+doisd(d.getMonth()+1)+'/'+d.getFullYear();
  }
  function iniciais(n){ var p=String(n||'?').trim().split(' ').filter(Boolean); return ((p[0]||'?')[0]+((p[1]||'')[0]||'')).toUpperCase(); }
  function avatar(box,nome,url,id){ var cor=AV[id%AV.length]; box.style.setProperty('--av',cor[0]); box.style.setProperty('--avf',cor[1]); if(url){ var i=el('img'); i.src=url; i.alt=''; i.onerror=function(){ i.remove(); box.textContent=iniciais(nome); }; box.appendChild(i); } else box.textContent=iniciais(nome); }
  function linkCw(id){ return dados&&dados.chatwoot? (dados.chatwoot+'/app/accounts/'+dados.conta+'/conversations/'+id) : (ficha? ficha.chatwoot+'/app/accounts/'+ficha.conta+'/conversations/'+id : '#'); }
  function textoTarefa(t){ return t.tipo==='vencida'? (t.dias>0? t.dias+'d':'hoje') : t.tipo==='hoje'? 'hoje' : t.tipo==='futura'? '' : ''; }
  function tituloTarefa(t){ return t.tipo==='sem'? 'Sem tarefas' : t.tipo==='vencida'? 'Tarefa vencida' : t.tipo==='hoje'? 'Tarefa para hoje' : 'Tarefa agendada'; }
  function esperando(k){ return k.ultimaDela && (Date.now()/1000-k.atividade)>15*60; }
  var FILTROS=[['minhas','Minhas'],['esperando','Esperando resposta'],['atrasada','Tarefa atrasada'],['semtarefa','Sem tarefa'],['quente','Quentes']];
  function passa(k){
    if(!filtro) return true;
    if(filtro==='minhas') return !!dados.euId && k.responsavelId===dados.euId;
    if(filtro==='esperando') return esperando(k);
    if(filtro==='atrasada') return k.tarefa.tipo==='vencida';
    if(filtro==='semtarefa') return k.tarefa.tipo==='sem';
    if(filtro==='quente') return /quente/i.test(k.qualificacao||'');
    return true;
  }
  function ordenar(a,b){ var o=$('ordem').value; if(o==='espera') return (esperando(b)-esperando(a))||(a.atividade-b.atividade); if(o==='valor') return (b.valor-a.valor)||(b.atividade-a.atividade); return b.atividade-a.atividade; }
  function guardar(){ try{ localStorage.setItem('funil:recolhidas',JSON.stringify(recolhidas)); localStorage.setItem('funil:ordem',$('ordem').value); }catch(e){} }
  try{ recolhidas=JSON.parse(localStorage.getItem('funil:recolhidas')||'{}')||{}; var oSalva=localStorage.getItem('funil:ordem'); if(oSalva) setTimeout(function(){ $('ordem').value=oSalva; },0); }catch(e){}
  function desenharResumo(){
    var todos=[]; dados.colunas.forEach(function(c){ todos=todos.concat(c.cartoes); });
    var nEsp=todos.filter(esperando).length, nAtr=todos.filter(function(k){ return k.tarefa.tipo==='vencida'; }).length, soma=todos.reduce(function(t,k){ return t+k.valor; },0);
    var r=$('resumo'); r.textContent='';
    [['',String(todos.length),'leads'],['',brl(soma),'no funil'],['esperando',String(nEsp),'esperando resposta'],['atrasada',String(nAtr),'tarefas atrasadas']].forEach(function(x){
      var b=el('button','num'+(x[0]&&filtro===x[0]?' on':'')+(x[0]==='esperando'&&nEsp?' alerta':'')+(x[0]==='atrasada'&&nAtr?' alerta':'')); b.type='button';
      b.appendChild(el('b',null,x[1])); b.appendChild(el('span',null,x[2]));
      if(x[0]) b.onclick=function(){ filtro=filtro===x[0]?'':x[0]; desenhar(); }; else b.disabled=true;
      r.appendChild(b);
    });
    var f=$('filtros'); f.textContent='';
    FILTROS.forEach(function(x){ if(x[0]==='minhas'&&!dados.euId) return; var b=el('button','chip'+(filtro===x[0]?' on':''),x[1]); b.type='button'; b.setAttribute('aria-pressed',String(filtro===x[0])); b.onclick=function(){ filtro=filtro===x[0]?'':x[0]; desenhar(); }; f.appendChild(b); });
  }
  setInterval(function(){ if(atualizadoEm) $('atual').textContent='atualizado há '+Math.max(0,Math.round((Date.now()-atualizadoEm)/1000))+' s'; },5000);

  // ── quadro ────────────────────────────────────────────────────────────────
  async function mover(id,etapa){ msg('Gravando…'); try{ await api('POST','mover',{conversaId:id,etapa:etapa}); msg('Movido para '+etapa+'.'); chegou=id; await carregar(); }catch(e){ msg(e.message); } }
  function formRapida(col,etapa){
    var f=el('form','formr'); var nome=el('input'); nome.placeholder='Nome'; nome.required=true; var tel=el('input'); tel.placeholder='Telefone com DDD'; tel.required=true; tel.inputMode='tel';
    var cx=el('select'); caixas.forEach(function(c){ var o=el('option',null,c.nome); o.value=c.id; cx.appendChild(o); }); if($('caixa').value) cx.value=$('caixa').value;
    var lin=el('div'), ok=el('button','bt azul','Criar'), nao=el('button','bt','Cancelar'); ok.type='submit'; nao.type='button';
    nao.onclick=function(){ formNaColuna=null; desenhar(); };
    f.onsubmit=async function(ev){ ev.preventDefault(); ok.disabled=true; msg('Criando…'); try{ await api('POST','novo',{nome:nome.value,telefone:tel.value,caixaId:Number(cx.value),etapa:etapa}); formNaColuna=null; msg('Lead criado.'); await carregar(); }catch(e){ msg(e.message); ok.disabled=false; } };
    lin.appendChild(ok); lin.appendChild(nao); f.appendChild(nome); f.appendChild(tel); if(caixas.length>1) f.appendChild(cx); else cx.hidden=true, f.appendChild(cx); f.appendChild(lin);
    setTimeout(function(){ nome.focus(); },0); return f;
  }
  function relativo(s){
    if(!s) return ''; var seg=Math.max(0,Date.now()/1000-s);
    if(seg<60) return 'agora'; if(seg<3600) return 'há '+Math.floor(seg/60)+' min'; if(seg<86400) return 'há '+Math.floor(seg/3600)+' h';
    var d=new Date(s*1000), ontem=new Date(Date.now()-864e5); if(d.toDateString()===ontem.toDateString()) return 'ontem';
    var dd=Math.floor(seg/86400); return seg<7*86400? 'há '+dd+(dd===1?' dia':' dias') : doisd(d.getDate())+'/'+doisd(d.getMonth()+1);
  }
  var NS='http://www.w3.org/2000/svg';
  function icone(caminho){ var v=document.createElementNS(NS,'svg'); v.setAttribute('viewBox','0 0 16 16'); v.setAttribute('width','13'); v.setAttribute('height','13'); v.setAttribute('aria-hidden','true'); var p=document.createElementNS(NS,'path'); p.setAttribute('d',caminho); p.setAttribute('fill','none'); p.setAttribute('stroke','currentColor'); p.setAttribute('stroke-width','1.6'); p.setAttribute('stroke-linecap','round'); v.appendChild(p); return v; }
  var RELOGIO='M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11M8 5v3.2l2 1.3', MAIS='M8 3.5v9M3.5 8h9';
  function desenhar(){
    var ordem=0;
    var termo=$('busca').value.trim().toLowerCase(), box=$('quadro'); box.textContent='';
    var nEsp=0;
    dados.colunas.forEach(function(col,i){
      var c=el('section','col'); c.style.setProperty('--cor',CORES[i%CORES.length]);
      var vis=col.cartoes.filter(function(k){ if(!passa(k)) return false; return !termo || k.nome.toLowerCase().indexOf(termo)>=0 || (k.telefone||'').replace(/[^0-9]/g,'').indexOf(termo.replace(/[^0-9]/g,'')||'x')>=0; }).sort(ordenar);
      if(recolhidas[col.etapa]) c.classList.add('fechada');
      var cab=el('header','cab'), t1=el('div','t1');
      var ne=el('button','nomeEtapa',col.etapa); ne.type='button'; ne.title=recolhidas[col.etapa]?'Abrir a coluna':'Recolher a coluna'; ne.onclick=function(){ recolhidas[col.etapa]=!recolhidas[col.etapa]; guardar(); desenhar(); }; t1.appendChild(ne); t1.appendChild(el('span','qtd',String(vis.length)));
      if(dados.podeEscrever){ var mais=el('button','mais'); mais.type='button'; mais.title='Adicionar lead em '+col.etapa; mais.setAttribute('aria-label','Adicionar lead em '+col.etapa); mais.appendChild(icone(MAIS)); mais.onclick=function(){ formNaColuna=formNaColuna===col.etapa?null:col.etapa; desenhar(); }; t1.appendChild(mais); }
      cab.appendChild(t1); if(col.soma) cab.appendChild(el('div','soma',brl(col.soma))); c.appendChild(cab);
      var lista=el('div','lista');
      if(dados.podeEscrever&&formNaColuna===col.etapa) lista.appendChild(formRapida(c,col.etapa));
      c.addEventListener('dragover',function(ev){ ev.preventDefault(); c.classList.add('alvo'); });
      c.addEventListener('dragleave',function(ev){ if(!c.contains(ev.relatedTarget)) c.classList.remove('alvo'); });
      c.addEventListener('drop',function(ev){ ev.preventDefault(); c.classList.remove('alvo'); if(arrastando&&arrastando.etapa!==col.etapa) mover(arrastando.id,col.etapa); });
      vis.forEach(function(k){
        var esp=esperando(k), novo=!vistos||!vistos[k.id];
        var d=el('article','k'+(esp?' espera':'')+(ctxConversa===k.id?' esta':'')+(novo?' novo':'')+(chegou===k.id?' chegou':'')); d.style.setProperty('--i',String(Math.min(ordem++,24))); d.draggable=true; d.tabIndex=0; d.setAttribute('role','button'); d.setAttribute('aria-label','Abrir '+k.nome);
        d.addEventListener('dragstart',function(){ arrastando=k; setTimeout(function(){ d.classList.add('arrastando'); },0); });
        d.addEventListener('dragend',function(){ d.classList.remove('arrastando'); setTimeout(function(){ arrastando=null; },0); });
        d.addEventListener('click',function(){ abrirConversa(k.id); });
        d.addEventListener('keydown',function(ev){ if(ev.key==='Enter'&&ev.target===d) abrirConversa(k.id); });
        var topo=el('div','l1'), av=el('span','av'); avatar(av,k.nome,k.avatar,k.id); topo.appendChild(av);
        topo.appendChild(el('span','ld',k.nome));
        var dt=el('time','dt',relativo(k.atividade)); dt.title=quando(k.atividade)+(esp?' · esperando resposta':''); topo.appendChild(dt); d.appendChild(topo);
        if(k.ultimaMensagem) d.appendChild(el('p','msgk'+(k.ultimaDela?' dela':''),k.ultimaMensagem));
        var pe=el('div','pe');
        if(k.valor) pe.appendChild(el('span','valor',brl(k.valor)));
        if(k.qualificacao){ var ql=el('span','qual q-'+k.qualificacao.toLowerCase().replace(/[^a-z]/g,''),k.qualificacao); pe.appendChild(ql); }
        if(k.tarefa.tipo!=='sem'){ var tf=el('span','tarefa '+k.tarefa.tipo); tf.appendChild(icone(RELOGIO)); tf.appendChild(document.createTextNode(k.tarefa.tipo==='vencida'?(k.tarefa.dias>0?'atrasada '+k.tarefa.dias+'d':'atrasada'):k.tarefa.tipo==='hoje'?'hoje':'agendada')); tf.title=tituloTarefa(k.tarefa); pe.appendChild(tf); }
        else { var sm=el('span','tarefa sem'); sm.appendChild(icone(RELOGIO)); sm.appendChild(document.createTextNode('sem tarefa')); pe.appendChild(sm); }
        if(k.etiquetas.length) pe.appendChild(el('span','etq','#'+k.etiquetas[0]+(k.etiquetas.length>1?' +'+(k.etiquetas.length-1):'')));
        if(k.responsavel){ var rp=el('span','resp',iniciais(k.responsavel)); rp.title='Responsável: '+k.responsavel; pe.appendChild(rp); }
        d.appendChild(pe);
        var ac=el('div','acoes'), prox=dados.etapas[dados.etapas.indexOf(k.etapa)+1];
        if(prox&&/perd/i.test(prox)) prox=null; // o → nunca leva para Perdido (perder é decisão, não clique sem querer)
        if(prox&&dados.podeEscrever){ var bp=el('button',null,'→'); bp.type='button'; bp.title='Mover para '+prox; bp.setAttribute('aria-label','Mover para '+prox); bp.onclick=function(ev){ ev.stopPropagation(); mover(k.id,prox); }; ac.appendChild(bp); }
        if(dados.podeEscrever){ var bt=el('button',null,'⏰'); bt.type='button'; bt.title='Tarefa: ligar amanhã às 9h'; bt.setAttribute('aria-label','Criar tarefa para amanhã às 9h'); bt.onclick=async function(ev){ ev.stopPropagation(); var am=new Date(Date.now()+864e5); am.setHours(9,0,0,0); if(bt.disabled) return; bt.disabled=true; msg('Criando tarefa…'); try{ await api('POST','tarefa',{conversaId:k.id,texto:'Ligar para '+k.nome,venceEm:am.toISOString()}); msg('Tarefa criada para amanhã 9h.'); carregar(); }catch(e){ msg(e.message); bt.disabled=false; } }; ac.appendChild(bt); }
        var ab=el('a',null,'↗'); ab.href=linkCw(k.id); ab.target='_top'; ab.title='Abrir a conversa'; ab.setAttribute('aria-label','Abrir a conversa'); ab.draggable=false; ab.onclick=function(ev){ ev.stopPropagation(); }; ac.appendChild(ab);
        d.appendChild(ac);
        lista.appendChild(d);
      });
      if(!vis.length&&formNaColuna!==col.etapa) lista.appendChild(el('div','vazio',termo||filtro?'Nada com esse filtro':'Arraste um lead para cá'));
      c.appendChild(lista);
      box.appendChild(c);
    });
    desenharResumo();
    var vs={}; dados.colunas.forEach(function(c){ c.cartoes.forEach(function(x){ vs[x.id]=1; }); }); vistos=vs; chegou=null;
    // trava: com animação ou sem (aba em segundo plano pausa animação), em 1,5 s todo cartão fica visível
    setTimeout(function(){ Array.prototype.forEach.call(document.querySelectorAll('.k.novo'),function(x){ x.classList.remove('novo'); }); },1500);
  }
  async function carregar(){
    if(!S&&!K){ msg(DENTRO?'Entre no Chatwoot para ver o funil.':'Abra o funil pelo Chatwoot.'); return; }
    if(TELA==='hoje'){ await carregarHoje(); return; }
    if(TELA){ await carregarTela(); return; }
    try{
      dados=await api('GET','quadro'+($('caixa').value?('?caixa='+encodeURIComponent($('caixa').value)):''));
      $('novo').hidden=!dados.podeEscrever; atualizadoEm=Date.now(); $('atual').textContent='atualizado agora'; desenhar(); if(!$('msg').textContent||/Carregando/.test($('msg').textContent)) msg(dados.total+' leads');
    }catch(e){ msg(e.message); if(!dados){ var qd=$('quadro'); qd.textContent=''; qd.appendChild(el('div','vazio',e.message)); } }
  }

  // ── ficha do lead ─────────────────────────────────────────────────────────
  function ver(lead){ $('lead').hidden=!lead; $('quadro').hidden=lead; $('topo').hidden=lead; }
  // clicar no lead abre a CONVERSA NORMAL do Chatwoot (pedido do João, 12/11): no menu, o Chatwoot fecha o funil e navega;
  // fora dele (aba da conversa, link avulso), abre a conversa na janela de cima
  function abrirConversa(id){
    if(MENU&&DENTRO){ try{ window.parent.postMessage({event:'funil:abrir-conversa',id:id},ORIGEM_CW); return; }catch(e){} }
    var u=linkCw(id); if(u==='#'){ abrirFicha(id); return; }
    var a=document.createElement('a'); a.href=u; a.target='_top'; a.rel='noopener'; document.body.appendChild(a); a.click(); a.remove();
  }
  async function abrirFicha(id){ aberta=id; aba='principal'; modo='mensagem'; ver(true); $('lead').textContent=''; $('lead').appendChild(el('div','vazio','Carregando…')); await recarregarFicha(); }
  async function recarregarFicha(){ if(!aberta) return; try{ ficha=await api('GET','conversa/'+aberta); desenharFicha(); }catch(e){ $('lead').textContent=''; var v=el('div','vazio',e.message); $('lead').appendChild(v); var b=el('button','bt','Voltar ao funil'); b.onclick=fecharFicha; v.appendChild(el('br')); v.appendChild(b); } }
  function fecharFicha(){ aberta=null; ficha=null; ver(false); carregar(); }
  async function acao(m,p,b,ok){ try{ await api(m,p,b); if(ok) ok(); await recarregarFicha(); }catch(e){ alerta(e.message); } }
  function alerta(t){ var a=document.querySelector('.comp .aviso'); if(a) a.textContent=t; else msg(t); }
  function linhaCampo(box,rot,ctl){ box.appendChild(el('label',null,rot)); box.appendChild(ctl); }
  function seletor(opcoes,atual,vazio,aoMudar){ var s=el('select'); if(vazio!=null){ var o0=el('option',null,vazio); o0.value=''; s.appendChild(o0); } opcoes.forEach(function(o){ var op=el('option',null,o.nome||o); op.value=o.id!=null?o.id:o; s.appendChild(op); }); s.value=atual==null?'':String(atual); s.onchange=function(){ aoMudar(s.value); }; return s; }
  function desenharFicha(){
    var f=ficha, k=f.cartao, L=$('lead'); L.textContent='';
    var esq=el('div','esq'), t=el('div','t'), vt=el('button',null,'‹'); vt.type='button'; vt.title='Voltar ao funil'; vt.onclick=fecharFicha; t.appendChild(vt); t.appendChild(el('span',null,k.nome)); esq.appendChild(t);
    var tg=el('div','tags'); k.etiquetas.forEach(function(x){ tg.appendChild(el('span',null,x)); }); esq.appendChild(tg);
    var et=el('div','etapa'), cx=caixas.filter(function(c){ return c.id===f.caixaId; })[0]; et.appendChild(el('small',null,cx?cx.nome:'Funil'));
    var nm=el('div','nm'), sel=seletor(f.etapas,k.etapa,null,function(v){ acao('POST','mover',{conversaId:k.id,etapa:v}); }); nm.appendChild(sel);
    var dias=Math.max(0,Math.floor((Date.now()/1000-(f.desdeEtapa||k.criado))/86400)); nm.appendChild(el('em',null,'('+dias+(dias===1?' dia)':' dias)'))); et.appendChild(nm);
    var pg=el('div','prog'), idx=f.etapas.indexOf(k.etapa); f.etapas.forEach(function(_,i){ pg.appendChild(el('span',i<=idx?'f':null)); }); et.appendChild(pg); esq.appendChild(et);
    var abas=el('div','abas'); [['principal','Principal'],['paciente','Paciente'],['origem','Origem'],['estatisticas','Estatísticas']].forEach(function(a){ var b=el('button',aba===a[0]?'on':null,a[1]); b.type='button'; b.onclick=function(){ aba=a[0]; desenharFicha(); }; abas.appendChild(b); }); esq.appendChild(abas);
    var cp=el('div','cp'), at=f.atributos||{}, ca=f.contato.atributos||{};
    if(aba==='principal'){
      linhaCampo(cp,'Responsável',seletor(f.agentes,f.responsavelId,'—',function(v){ acao('POST','responsavel',{conversaId:k.id,agenteId:v?Number(v):null}); }));
      var val=el('input'); val.value=k.valor?String(k.valor).replace('.',','):''; val.placeholder='R$ 0'; val.inputMode='decimal';
      val.onchange=function(){ acao('POST','campos',{conversaId:k.id,campos:{valor_fechado:val.value}}); }; linhaCampo(cp,'Venda',val);
      linhaCampo(cp,'Qualificação',seletor(f.listas.qualificacao,at.qualificacao,'—',function(v){ acao('POST','campos',{conversaId:k.id,campos:{qualificacao:v||null}}); }));
      if(/perd/i.test(k.etapa)||at.motivo_nao_agendamento) linhaCampo(cp,'Motivo da perda',seletor(f.listas.motivo_nao_agendamento,at.motivo_nao_agendamento,'—',function(v){ acao('POST','campos',{conversaId:k.id,campos:{motivo_nao_agendamento:v||null}}); }));
      linhaCampo(cp,'Unidade',el('span',null,ca.unidade||'—'));
    } else if(aba==='paciente'){
      linhaCampo(cp,'Telefone',el('span',null,f.contato.telefone||'—')); linhaCampo(cp,'E-mail',el('span',null,f.contato.email||'—'));
      Object.keys(ca).forEach(function(c){ if(['origem','campanha_codigo','campanha_nome','conjunto','criativo','unidade'].indexOf(c)<0) linhaCampo(cp,c.replace(/_/g,' '),el('span',null,String(ca[c]))); });
    } else if(aba==='origem'){
      [['origem','Origem'],['campanha_nome','Campanha'],['campanha_codigo','Código'],['conjunto','Conjunto'],['criativo','Criativo'],['unidade','Unidade']].forEach(function(c){ linhaCampo(cp,c[1],el('span',null,ca[c[0]]!=null&&ca[c[0]]!==''?String(ca[c[0]]):'—')); });
    } else {
      var abertas=f.tarefas.filter(function(x){ return !x.feita; }).length;
      linhaCampo(cp,'Criado em',el('span',null,quando(k.criado))); linhaCampo(cp,'Dias no funil',el('span',null,String(Math.floor((Date.now()/1000-k.criado)/86400))));
      linhaCampo(cp,'Mensagens',el('span',null,String(f.historico.filter(function(h){ return h.tipo==='ela'||h.tipo==='nos'; }).length))); linhaCampo(cp,'Tarefas abertas',el('span',null,String(abertas)));
      linhaCampo(cp,'Responsável',el('span',null,k.responsavel||'—'));
    }
    esq.appendChild(cp);
    var ps=el('div','pessoa'), n=el('div','n'), av=el('span','av'); avatar(av,k.nome,f.contato.avatar,k.id); n.appendChild(av); n.appendChild(el('span',null,k.nome)); ps.appendChild(n);
    var cp2=el('div','cp'); linhaCampo(cp2,'Telefone',el('span',null,f.contato.telefone||'—')); ps.appendChild(cp2); esq.appendChild(ps);
    var rod=el('div','rodape'), ab=el('a',null,'Abrir no Chatwoot'); ab.href=linkCw(k.id); ab.target='_top'; rod.appendChild(ab);
    var perdido=f.etapas.filter(function(e){ return /perd/i.test(e); })[0];
    if(perdido&&perdido!==k.etapa){ var bp=el('button',null,'✕ Perdido'); bp.type='button'; bp.onclick=function(){ aba='principal'; acao('POST','mover',{conversaId:k.id,etapa:perdido}); }; rod.appendChild(bp); }
    esq.appendChild(rod); L.appendChild(esq);

    var feed=el('div','feed'), rol=el('div','rol'), agora=Date.now();
    f.tarefas.forEach(function(x){
      var venc=!x.feita&&new Date(x.venceEm).getTime()<agora, d=el('div','tf'+(x.feita?' feita':venc?' vencida':''));
      var cb=el('input'); cb.type='checkbox'; cb.checked=x.feita; cb.setAttribute('aria-label','Tarefa feita'); cb.onchange=function(){ acao('POST','tarefa/'+x.id+'/feita',{feita:cb.checked}); };
      d.appendChild(cb); d.appendChild(el('span',null,x.texto+(x.responsavel?' · '+x.responsavel:'')));
      var v=new Date(x.venceEm); d.appendChild(el('small',null,(venc?'venceu ':'')+doisd(v.getDate())+'/'+doisd(v.getMonth()+1)+' '+doisd(v.getHours())+':'+doisd(v.getMinutes())));
      rol.appendChild(d);
    });
    var diaAnt='';
    f.historico.forEach(function(h){
      var d=new Date(h.quando*1000), dia=doisd(d.getDate())+'/'+doisd(d.getMonth()+1)+'/'+d.getFullYear(), hm=doisd(d.getHours())+':'+doisd(d.getMinutes());
      if(dia!==diaAnt){ rol.appendChild(el('span','dia',dia)); diaAnt=dia; }
      if(h.tipo==='sis'){ rol.appendChild(el('div','sis',hm+' '+h.texto)); return; }
      var b=el('div',h.tipo==='nota'?'nota':'m '+h.tipo); b.appendChild(el('small',null,hm+(h.quem?' '+h.quem:'')+(h.tipo==='nota'?' · nota interna':''))); b.appendChild(document.createTextNode(h.texto)); rol.appendChild(b);
    });
    if(!f.historico.length&&!f.tarefas.length) rol.appendChild(el('div','vazio','Nada por aqui ainda.'));
    feed.appendChild(rol);
    var comp=el('div','comp'), tb=el('div','tb');
    [['mensagem','Mensagem'],['nota','Nota'],['tarefa','Tarefa']].forEach(function(m){ var b=el('button',modo===m[0]?'on':null,m[1]); b.type='button'; b.onclick=function(){ modo=m[0]; desenharFicha(); }; tb.appendChild(b); });
    comp.appendChild(tb);
    var ta=el('textarea'); ta.setAttribute('aria-label','Texto'); comp.appendChild(ta);
    var l2=el('div','linha2'), av2=el('span','aviso'), env=el('button','bt azul');
    env.type='button';
    if(modo==='mensagem'){ ta.placeholder='Escreva para '+k.nome+' (sai pelo WhatsApp)…'; env.textContent='Enviar'; if(!f.podeEscrever){ ta.disabled=true; env.disabled=true; av2.textContent='Para mandar mensagem, abra o funil pelo menu do Chatwoot.'; } }
    else if(modo==='nota'){ ta.placeholder='Nota interna — só a equipe vê'; env.textContent='Salvar nota'; }
    else {
      ta.placeholder='O que fazer — ex.: ligar para confirmar o horário'; env.textContent='Criar tarefa';
      var dt=el('input'); dt.type='datetime-local'; var amanha=new Date(Date.now()+864e5); amanha.setHours(9,0,0,0);
      dt.value=amanha.getFullYear()+'-'+doisd(amanha.getMonth()+1)+'-'+doisd(amanha.getDate())+'T09:00'; dt.setAttribute('aria-label','Quando');
      var rs=seletor(f.agentes.map(function(g){ return {id:g.nome,nome:g.nome}; }),null,'Para mim',function(){}); rs.setAttribute('aria-label','Responsável');
      l2.appendChild(dt); l2.appendChild(rs);
      env.onclick=function(){ if(!ta.value.trim()){ av2.textContent='Escreva a tarefa.'; return; } env.disabled=true; acao('POST','tarefa',{conversaId:k.id,texto:ta.value,venceEm:new Date(dt.value).toISOString(),responsavel:rs.value||null}); };
    }
    if(modo!=='tarefa') env.onclick=function(){ if(!ta.value.trim()){ av2.textContent='Escreva algo.'; return; } env.disabled=true; acao('POST',modo==='nota'?'nota':'mensagem',{conversaId:k.id,texto:ta.value}); };
    l2.appendChild(av2); l2.appendChild(env); comp.appendChild(l2); feed.appendChild(comp); L.appendChild(feed);
    rol.scrollTop=rol.scrollHeight;
  }

  // ── começo ────────────────────────────────────────────────────────────────
  $('caixa').addEventListener('change',carregar);
  $('busca').addEventListener('input',function(){ if(dados) desenhar(); });
  $('ordem').addEventListener('change',function(){ guardar(); if(dados) desenhar(); });
  $('recarregar').addEventListener('click',function(){ carregar(); });
  document.addEventListener('keydown',function(e){
    var t=e.target, digitando=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT');
    if(digitando||aberta||e.ctrlKey||e.metaKey||e.altKey) return;
    if(e.key==='/'){ e.preventDefault(); $('busca').focus(); }
    else if((e.key==='n'||e.key==='N')&&!$('novo').hidden){ e.preventDefault(); $('novo').click(); }
  });
  $('novo').addEventListener('click',function(){ if(dados&&dados.etapas.length){ formNaColuna=dados.etapas[0]; delete recolhidas[formNaColuna]; desenhar(); } });
  document.addEventListener('keydown',function(e){ if(e.key!=='Escape') return; if(aberta){ fecharFicha(); return; } if(MENU){ try{ window.parent.postMessage({event:'funil:fechar'},ORIGEM_CW); }catch(x){} } });
  window.addEventListener('message',function(ev){
    try{ var d=typeof ev.data==='string'?JSON.parse(ev.data):ev.data;
      if(d&&d.event==='funil-sessao'&&ev.origin===ORIGEM_CW&&ev.source===window.parent){
        var nova=d.sessao&&d.sessao.token?d.sessao:null;
        if(nova&&nova.token===morta){ msg('Sua sessão do Chatwoot venceu: saia e entre de novo.'); return; }
        S=nova; iniciar(); return; }
      if(!d||d.event!=='appContext') return;
      var x=d.data||{}; var cid=x.conversation&&x.conversation.id||null;
      // aba da conversa: outra conversa aberta no Chatwoot = a ficha passa a ser a dela (nunca fica a ficha da anterior na tela)
      if(cid&&cid!==ctxConversa){ ctxConversa=cid; if(iniciado&&!MENU&&aberta!==cid) abrirFicha(cid); }
    }catch(e){}
  });
  // ── tela HOJE (design Início do painel da Lia) ─────────────────────────────
  async function carregarHoje(){
    try{ var h=await api('GET','hoje'+($('caixa').value?('?caixa='+encodeURIComponent($('caixa').value)):'')); atualizadoEm=Date.now(); $('atual').textContent='atualizado agora'; desenharHoje(h); msg(''); }
    catch(e){ msg(e.message); var qd=$('quadro'); qd.textContent=''; qd.appendChild(el('div','vazio',e.message)); }
  }
  function linhaHoje(i,destaque){
    var l=el('div','hj-linha'), tx=el('div'); tx.appendChild(el('div','nm',i.nome)); tx.appendChild(el('div','det',i.detalhe)); l.appendChild(tx);
    var b=el('button','bt'+(destaque&&i.quente?' azul':''),'Abrir conversa'); b.type='button'; b.onclick=function(){ abrirConversa(i.id); }; l.appendChild(b); return l;
  }
  function desenharHoje(h){
    var qd=$('quadro'); qd.className='quadro hoje'; qd.textContent='';
    var hr=new Date().getHours(), sd=el('div','hj-sauda');
    sd.appendChild(el('h2',null,(hr<12?'Bom dia':hr<18?'Boa tarde':'Boa noite')+(h.eu?', '+String(h.eu).split(' ')[0]:'')));
    sd.appendChild(el('p',null,'O resumo de hoje nas caixas que você atende. Comece por aqui.')); qd.appendChild(sd);
    var nums=el('div','hj-nums');
    [['Chegaram hoje',h.numeros.chegaram,'azul','Conversas que começaram hoje'],['Esperando resposta',h.numeros.esperando,'','O paciente falou e ninguém respondeu ainda'],['Não interagiram',h.numeros.naoInteragiram,'amar','Sem responder há mais de 24 h, ou com a etiqueta sem-resposta'],['Agendaram hoje',h.numeros.agendaram,'verde','Entraram em Agendado hoje'],['Hoje na agenda',h.numeros.naAgenda,'','Consulta marcada para hoje'],['Falta confirmar',h.numeros.faltaConfirmar,'amar','Consulta hoje ou amanhã ainda como Agendado']].forEach(function(x){
      var c=el('div','hj-num'+(x[2]?' '+x[2]:'')); c.title=x[3]; c.appendChild(el('small',null,x[0])); c.appendChild(el('b',null,String(x[1])));
      // meta do dia (Parauapebas: 5 agendamentos): "de 5" + barra + quanto falta
      if (x[0]==='Agendaram hoje' && h.meta){
        var feito=Number(x[1])||0, pct=Math.min(100,Math.round(feito*100/h.meta));
        c.querySelector('b').appendChild(el('span','hj-meta-de',' de '+h.meta));
        var barra=el('div','hj-meta-barra'), enche=el('i'); enche.style.width=pct+'%'; barra.appendChild(enche); c.appendChild(barra);
        c.appendChild(el('small','hj-meta-txt',feito>=h.meta?'Meta do dia batida!':'Meta: '+h.meta+' por dia · faltam '+(h.meta-feito)));
        c.title='Entraram em Agendado hoje. Meta: '+h.meta+' por dia';
      }
      nums.appendChild(c); });
    qd.appendChild(nums);
    var lia=el('section','hj-lia'), lc=el('div','hj-lia-cards'), lista=el('div','hj-lista'); lista.hidden=true;
    lia.appendChild(el('h3',null,'A Lia separou para você hoje'));
    [['naoFecharam','consultaram e não fecharam'],['retorno60','terminaram há 2 meses: agendar retorno'],['verDepois','ficaram de ver depois'],['faltaram','faltaram: remarcar']].forEach(function(x){
      var itens=(h.separou&&h.separou[x[0]])||[], b=el('button','hj-lia-card'); b.type='button';
      b.appendChild(el('b',null,String(itens.length))); b.appendChild(el('span',null,x[1]));
      b.onclick=function(){ var ja=!lista.hidden&&lista.getAttribute('data-k')===x[0]; lista.textContent=''; lista.hidden=ja; lista.setAttribute('data-k',x[0]); if(ja) return;
        if(!itens.length){ lista.appendChild(el('div','hj-linha det','Ninguém nesta lista agora.')); return; } itens.forEach(function(i){ lista.appendChild(linhaHoje(i)); }); };
      lc.appendChild(b); });
    lia.appendChild(lc); lia.appendChild(lista); qd.appendChild(lia);
    var fa=el('section','hj-box'); fa.appendChild(el('h3',null,'Faça agora'));
    if(!h.facaAgora.length) fa.appendChild(el('div','det','Ninguém esperando resposta agora.'));
    h.facaAgora.forEach(function(i){ fa.appendChild(linhaHoje(i,true)); }); qd.appendChild(fa);
    var pu=el('section','hj-box'), t=el('table','hj-tab'), cab=el('tr'); pu.appendChild(el('h3',null,'Por usuário hoje'));
    ['Usuário','Conversas abertas','Esperando','Responderam hoje','Agendaram hoje'].forEach(function(n){ cab.appendChild(el('th',null,n)); }); t.appendChild(cab);
    h.porUsuario.forEach(function(u){ var tr=el('tr'); [u.nome,u.conversas,u.esperando,u.responderamHoje,u.agendaram].forEach(function(v){ tr.appendChild(el('td',null,String(v))); }); t.appendChild(tr); });
    pu.appendChild(t); qd.appendChild(pu);
  }
  /*__TELAS_JS__*/
  if(TELA){ var NOMES={hoje:'Hoje',oport:'Oportunidades',mkt:'Relatório do marketing',gestor:'Painel do gestor'}; if(TELA!=='hoje') document.body.classList.add('tg-pagina'); document.title=NOMES[TELA]+' · Doutor Digital'; var h1=document.querySelector('.topo h1'); if(h1) h1.textContent=NOMES[TELA];
    ['resumo','filtros','ordem'].forEach(function(id){ $(id).hidden=true; }); var bc=document.querySelector('.busca-c'); if(bc) bc.hidden=true;
    if(TELA!=='hoje'){ var lb=document.querySelector('.topo .linha-b'); if(lb) lb.hidden=true; } }
  function iniciar(){
    if(!S&&!K){ carregar(); return; }
    if(iniciado){ if(aberta) recarregarFicha(); else carregar(); return; }
    iniciado=true; msg('Carregando…');
    if(!dados&&!TELA){ var qd=$('quadro'); qd.textContent=''; for(var f=0;f<5;f++){ var fc=el('div','fantasma'); for(var g=0;g<4-(f%3);g++) fc.appendChild(el('i')); qd.appendChild(fc); } }
    if(!TELA||TELA==='hoje') api('GET','caixas').then(function(l){ caixas=l; var s=$('caixa'); while(s.options.length>1) s.remove(1); l.forEach(function(c){ var o=el('option',null,c.nome); o.value=c.id; s.appendChild(o); }); }).catch(function(){});
    if(ctxConversa&&!MENU) abrirFicha(ctxConversa); else carregar();
    if(!timer) timer=setInterval(function(){ if(!aberta) carregar(); },TELA&&TELA!=='hoje'?120000:60000);
  }
  if(DENTRO){
    pedirSessao();
    if(!MENU){ var pedirCtx=function(){ try{ window.parent.postMessage('chatwoot-dashboard-app:fetch-info','*'); }catch(e){} }; pedirCtx();
      document.addEventListener('visibilitychange',function(){ if(!document.hidden) pedirCtx(); }); window.addEventListener('focus',pedirCtx); setInterval(pedirCtx,5000); }
    setTimeout(function(){ if(!S&&!iniciado) iniciar(); },3500);
  } else iniciar();
})();
</script></body></html>
`;

/**
 * Script do item "Funil" no menu da esquerda do Chatwoot. Entra pelo DASHBOARD_SCRIPTS (Super Admin › configuração do
 * Chatwoot): `<script src="https://agente-vps.doutordigitalconsultoria.com/funil/menu.js" defer></script>`. Não mexe no
 * código do Chatwoot: acha o item "Contatos" no menu, põe um "Funil" logo abaixo e, ao clicar, abre o quadro por cima da
 * tela. Passa ao quadro só o login de quem já está logado no Chatwoot (o cookie da sessão dele), e só para este servidor.
 * Se um dia o Chatwoot mudar o menu e o item não achar lugar, aparece um botão "Funil" no canto (nada quebra).
 */
export function menuFunilHandler(_req: Request, res: Response): void {
  const c = contexto();
  if (!c?.conta) {
    res.status(404).type('application/javascript').send('/* funil desligado */');
    return;
  }
  // endereço FIXO (o menu entrega a sessão do Chatwoot só para ele): do .env, nunca do cabeçalho Host do pedido
  let agente = 'https://agente-vps.doutordigitalconsultoria.com';
  try {
    if (env.MCP_URL_PUBLICA) agente = new URL(env.MCP_URL_PUBLICA).origin;
  } catch {
    /* fica o padrão */
  }
  res
    .type('application/javascript')
    .set('Cache-Control', 'public, max-age=300')
    .set('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(montarMenuJs(agente));
}

/**
 * O que o Chatwoot carrega em `GET /funil/menu.js`: o menu (Hoje, Funil, Oportunidades e, para a gestão, Marketing e Gestor) e o botão da assistente da atendente. Dois blocos
 * independentes no MESMO arquivo, porque o DASHBOARD_SCRIPTS da produção carrega só este endereço. Erro de EXECUÇÃO do botão
 * não derruba o menu (o `try`); erro de SINTAXE derrubaria o arquivo todo, por isso o teste `menu.js … PARSEIAM` é obrigatório.
 */
export function montarMenuJs(agente: string): string {
  const origem = JSON.stringify(agente);
  return `${MENU_JS.split('__AGENTE__').join(origem)}\n;try{\n${assistenteJs().split('__AGENTE__').join(origem)}\n}catch(e){}\n`;
}

// String.raw: o que está aqui é o JavaScript que o navegador recebe (as barras das expressões regulares ficam como estão).
const MENU_JS = String.raw`(function(){
  if (window.__funilMenu) return; window.__funilMenu = 1;
  var AGENTE = __AGENTE__, cam = null, fr = null;
  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  // O quadro abre AO LADO do menu da esquerda do Chatwoot (o menu continua à vista e clicável): começa onde o menu termina.
  function margem(){
    var a = document.querySelector('aside'), r = a && a.getBoundingClientRect();
    return r && r.width > 0 && r.right > 0 && r.right < window.innerWidth * 0.5 ? Math.round(r.right) : 0;
  }
  function ajustar(){ if (cam) cam.style.left = margem() + 'px'; }
  // As telas do menu, na ordem: Contatos → Hoje → Funil → Oportunidades → Marketing → Gestor. As marcadas «gestao» só
  // aparecem para administrador da conta ou gestor da lista (e o servidor confere de novo a cada pedido de dados).
  var TELAS = [
    { id: 'hoje', marca: 'data-hoje-menu', nome: 'Hoje', hash: '#hoje', param: 'hoje' },
    { id: 'funil', marca: 'data-funil-menu', nome: 'Funil', hash: '#funil', param: '' },
    { id: 'oport', marca: 'data-oport-menu', nome: 'Oportunidades', hash: '#oportunidades', param: 'oport' },
    { id: 'mkt', marca: 'data-mkt-menu', nome: 'Marketing', hash: '#marketing', param: 'mkt', gestao: true },
    { id: 'gestor', marca: 'data-gestor-menu', nome: 'Gestor', hash: '#gestor', param: 'gestor', gestao: true }
  ];
  function achar(id){ for (var i = 0; i < TELAS.length; i++) if (TELAS[i].id === id) return TELAS[i]; return null; }
  var DE_MENU = TELAS.map(function(t){ return '[' + t.marca + ']'; }).join(', ');
  function marcar(ativo){
    // ativo: id da tela aberta, ou false (nenhuma)
    TELAS.forEach(function(t){
      var item = document.querySelector('[' + t.marca + ']'), link = item && (item.tagName === 'A' ? item : item.querySelector('a'));
      if (link) link.style.background = ativo === t.id ? 'rgba(31,147,255,.12)' : '';
    });
  }
  // fechar REMOVE o quadro: nada fica consultando o Chatwoot escondido; reabrir pede o login de novo
  // aberto fica lembrado NESTA aba (sessionStorage): o Ctrl+R reabre a tela; fechar esquece
  var LEMBRAR = 'funil:aberto', reaberto = false, tela = null, gestao = null;
  function lembrar(valor){ try { if (valor === false) sessionStorage.removeItem(LEMBRAR); else sessionStorage.setItem(LEMBRAR, valor || 'funil'); } catch (e) {} }
  // endereço próprio (pedido do João, 13/11): a tela aberta fica no fim do endereço (…/dashboard#funil) — dá para salvar e mandar o
  // link; replaceState não aciona as rotas do Chatwoot nem cria passo no "voltar"
  function porNoEndereco(t){ try { history.replaceState(history.state, '', location.pathname + location.search + (t ? t.hash : '')); } catch (e) {} }
  function telaDoEndereco(){ for (var i = 0; i < TELAS.length; i++) if (TELAS[i].hash === location.hash) return TELAS[i]; return null; }
  function fechar(){ if (cam) { cam.remove(); cam = null; fr = null; } tela = null; marcar(false); lembrar(false); if (telaDoEndereco()) porNoEndereco(null); }
  function reabrir(){
    if (reaberto) return;
    try {
      // o endereço (…#gestor) vence o que estava lembrado na aba
      var doEnd = telaDoEndereco();
      var v = doEnd ? doEnd.id : sessionStorage.getItem(LEMBRAR), t = achar(v === 'funil' || !v ? 'funil' : v);
      // tela de gestão: espera saber se a pessoa pode (a resposta do perfil vem depois do menu)
      if (t && t.gestao && gestao === null) return;
      reaberto = true;
      if (!v || !t) return;
      if (t.gestao && gestao !== true) { lembrar(false); return; }
      if (/\/app\/accounts\//.test(location.pathname) && sessao()) abrir(null, t.id);
    } catch (e) { reaberto = true; }
  }
  // id: 'funil' (padrão), 'hoje', 'oport', 'mkt' ou 'gestor' (o mesmo quadro, outra tela)
  function abrir(ev, id){
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    var t = achar(typeof id === 'string' ? id : 'funil') || achar('funil');
    if (t.gestao && gestao !== true) return;
    lembrar(t.id);
    var url = AGENTE + '/funil?menu=1' + (t.param ? '&tela=' + t.param : '');
    if (cam && tela !== t.id && fr) { fr.src = url; fr.title = t.nome; }
    tela = t.id;
    porNoEndereco(t);
    if (!cam) {
      cam = document.createElement('div');
      cam.style.cssText = 'position:fixed;top:0;right:0;bottom:0;z-index:2147483000;background:#f5f7fb;display:flex;border-left:1px solid #e3e8ef';
      var x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Fechar (Esc)'; x.setAttribute('aria-label', 'Fechar (Esc)');
      x.style.cssText = 'position:absolute;top:12px;right:14px;z-index:1;width:30px;height:30px;font:16px system-ui,sans-serif;border:1px solid #e3e8ef;border-radius:6px;background:#fff;color:#1f2d3d;cursor:pointer';
      x.onclick = fechar;
      fr = document.createElement('iframe'); fr.src = url; fr.title = t.nome;
      fr.style.cssText = 'flex:1;border:0;width:100%;height:100%';
      cam.appendChild(fr); cam.appendChild(x); document.body.appendChild(cam);
    }
    ajustar(); marcar(t.id);
  }
  window.addEventListener('resize', ajustar);
  // clicar em outro item do menu (Conversas, Contatos…) fecha a tela e o Chatwoot segue para onde a pessoa clicou
  document.addEventListener('click', function(e){
    if (!cam || !e.target || !e.target.closest) return;
    var link = e.target.closest('aside a, nav a');
    if (link && !link.closest(DE_MENU)) fechar();
  }, true);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') fechar(); });
  window.addEventListener('message', function(ev){
    // a sessão vai para o quadro do menu E para a aba "Funil" da conversa (iframe que o Chatwoot cria), só se forem deste servidor
    if (ev.origin !== AGENTE || !ev.source) return;
    // só responde a um iframe DESTA página que seja o funil (o do menu ou a aba "Funil" da conversa); nunca a janela solta
    var doFunil = Array.prototype.some.call(document.querySelectorAll('iframe'), function(f){
      return f.contentWindow === ev.source && String(f.src).indexOf(AGENTE + '/funil') === 0;
    });
    if (!doFunil) return;
    var d = ev.data;
    if (d && d.event === 'funil:pede-sessao') ev.source.postMessage({ event: 'funil-sessao', sessao: sessao() }, AGENTE);
    else if (d && d.event === 'funil:fechar' && fr && ev.source === fr.contentWindow) fechar();
    else if (d && d.event === 'funil:abrir-conversa' && fr && ev.source === fr.contentWindow) {
      // abre a conversa do lead na tela normal do Chatwoot (mesma conta da página); id só número
      var conta = location.pathname.match(/\/app\/accounts\/(\d+)/), id = Number(d.id);
      if (conta && Number.isInteger(id) && id > 0) { fechar(); location.assign('/app/accounts/' + conta[1] + '/conversations/' + id); }
    }
  });
  function trocarTexto(no, texto){
    var w = document.createTreeWalker(no, NodeFilter.SHOW_TEXT), t;
    while ((t = w.nextNode())) { if (t.nodeValue.trim()) { t.nodeValue = texto; return; } }
  }
  // um item novo no menu, copiado do "Contatos" (mesmo visual), posto logo depois do item anterior
  // ícones próprios (traço, no estilo do menu do Chatwoot): sem eles os itens copiados ficariam com o ícone de Contatos
  var ICONES = {
    hoje: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    funil: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M8 7v7"/><path d="M12 7v4"/><path d="M16 7v9"/>',
    oport: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    mkt: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    gestor: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'
  };
  var SEL_ICONE = 'svg, [class^="i-"], [class*=" i-"]';
  function trocarIcone(base, novo, qual){
    var velho = novo.querySelector(SEL_ICONE), orig = base.querySelector(SEL_ICONE);
    if (!velho) return;
    var r = orig && orig.getBoundingClientRect ? orig.getBoundingClientRect() : null, lado = r && r.width ? Math.round(r.width) : 16;
    var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', lado); svg.setAttribute('height', lado);
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    svg.style.flexShrink = '0';
    // mantém as classes de espaçamento do ícone original, sem a classe que desenha o ícone de Contatos
    var cls = String(velho.getAttribute('class') || '').split(/\s+/).filter(function(c){ return c && !/^i-/.test(c); }).join(' ');
    if (cls) svg.setAttribute('class', cls);
    svg.innerHTML = ICONES[qual];
    velho.parentNode.replaceChild(svg, velho);
  }
  function item(base, depois, t){
    var novo = base.cloneNode(true);
    novo.setAttribute(t.marca, '1');
    trocarIcone(base, novo, t.id);
    var link = novo.tagName === 'A' ? novo : novo.querySelector('a');
    if (link) { link.setAttribute('href', t.hash); link.classList.remove('router-link-active', 'router-link-exact-active'); link.removeAttribute('aria-current'); }
    Array.prototype.forEach.call(novo.querySelectorAll('ul, [role="group"]'), function(u){ u.remove(); });
    trocarTexto(novo, t.nome);
    novo.addEventListener('click', function(e){ abrir(e, t.id); }, true);
    depois.parentNode.insertBefore(novo, depois.nextSibling);
    return novo;
  }
  function visivel(t){ return !t.gestao || gestao === true; }
  // Contatos → Hoje → Funil → Oportunidades → (Marketing → Gestor, só gestão)
  function por(){
    if (!TELAS.some(function(t){ return visivel(t) && !document.querySelector('[' + t.marca + ']'); })) return true;
    var a = document.querySelector('aside a[href*="/contacts"], nav a[href*="/contacts"]');
    if (!a) return false;
    var base = a.closest('li') || a, anterior = base;
    TELAS.forEach(function(t){
      var ja = document.querySelector('[' + t.marca + ']');
      if (!visivel(t)) { if (ja) ja.remove(); return; }
      anterior = ja || item(base, anterior, t);
    });
    var reserva = document.querySelector('[data-funil-botao]'); if (reserva) reserva.remove();
    return true;
  }
  function botao(){
    if (document.querySelector('[data-funil-menu], [data-funil-botao]')) return;
    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Funil'; b.setAttribute('data-funil-botao', '1');
    b.style.cssText = 'position:fixed;left:12px;bottom:70px;z-index:2147482999;padding:8px 14px;border-radius:18px;border:0;background:#1f93ff;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    b.onclick = function(ev){ abrir(ev, 'funil'); }; document.body.appendChild(b);
  }
  // Menu enxuto (decisão do João, 12/11/2026): "Campanhas" some para quem não é administrador da conta (as meninas).
  // O papel vem do perfil do próprio Chatwoot (mesma origem, sessão do cookie); sem resposta, nada some.
  // O mesmo perfil decide Marketing e Gestor: administrador, ou e-mail na lista de gestores do servidor.
  var papel = null, pedindoPapel = false;
  // Administrador da conta vê. Os demais: o servidor diz se o e-mail está na lista de gestores (a lista nunca vai neste arquivo, que é público).
  function decidirGestao(p){
    if (papel === 'administrator') return Promise.resolve(true);
    var s = sessao(); if (!s) return Promise.resolve(false);
    return fetch(AGENTE + '/api/public/funil/gestao', { headers: { 'X-CW-Token': s.token, 'X-CW-Client': s.client, 'X-CW-Uid': s.uid } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ return !!(j && j.gestao === true); })
      .catch(function(){ return false; });
  }
  function pedirPapel(){
    if (papel !== null || pedindoPapel) return;
    var s = sessao(), conta = location.pathname.match(/\/app\/accounts\/(\d+)/);
    if (!s || !conta) return;
    pedindoPapel = true;
    fetch('/api/v1/profile', { headers: { 'access-token': s.token, client: s.client, uid: s.uid } })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(p){
        var a = p && Array.isArray(p.accounts) ? p.accounts.filter(function(x){ return String(x.id) === conta[1]; })[0] : null;
        if (!(a && a.role)) return;
        papel = a.role; enxugar();
        return decidirGestao(p).then(function(ok){ gestao = ok; if (por()) { reabrir(); ajustar(); } });
      })
      .catch(function(){})
      .then(function(){ pedindoPapel = false; });
  }
  function enxugar(){
    if (papel === null) { pedirPapel(); return; }
    if (papel === 'administrator') return;
    Array.prototype.forEach.call(document.querySelectorAll('aside .i-lucide-megaphone, nav .i-lucide-megaphone'), function(i){
      var li = i.closest('li'); if (li && li.style.display !== 'none') li.style.display = 'none';
    });
  }
  var espera = null;
  // o menu do Chatwoot nasce depois do script: quando o item entra, reabre a tela se estava aberta (e acerta a margem)
  new MutationObserver(function(){ if (espera) return; espera = setTimeout(function(){ espera = null; enxugar(); if (por()) { reabrir(); ajustar(); } }, 300); }).observe(document.documentElement, { childList: true, subtree: true });
  if (por()) reabrir(); setTimeout(function(){ if (!por() && /\/app\/accounts\//.test(location.pathname)) botao(); reabrir(); }, 8000);
})();`;
