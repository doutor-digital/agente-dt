/**
 * O worker da RÉGUA no Chatwoot (`chatwoot-regua`): a cada 10 min lê as conversas da caixa de cada unidade que estiver
 * em «seco» ou «ligado» e aplica `decidirRegua` (chatwoot-regua.ts, onde estão as regras e as explicações).
 *
 *  - SECO: em vez de mandar ao paciente, deixa uma NOTA PRIVADA na conversa («🧪 [SECO] Régua … — enviaria agora: …») e registra no banco.
 *  - LIGADO: manda a mensagem pública. Implementado, mas ninguém liga agora.
 *  - Reaproveita o cliente do Chatwoot do conector (`mcp-remoto/chatwoot.ts`, env CHATWOOT_API_TOKEN / CHATWOOT_CONTA_ID / CHATWOOT_URL): sem env novo.
 *    Sem token, o worker nem sobe.
 *  - Nunca repete: a linha de `chatwoot_regua_disparo` é GRAVADA ANTES de agir (UNIQUE conversa+regra+chave); duas cópias do servidor
 *    não mandam em dobro. Seco que falha ao deixar a nota desfaz a linha (tenta no próximo ciclo). Ligado com resposta de erro do
 *    Chatwoot (4xx) também desfaz; erro sem resposta (tempo esgotado: pode ter ido) NÃO desfaz — melhor uma mensagem a menos que duas.
 *  - Tetos por ciclo (mensagens e etiquetas): se um defeito soltar tudo de uma vez, vaza só um pouco por ciclo.
 *  - Sinal interno (sempre ao vivo quando a régua não está desligada): etiqueta `respondeu-pelo-celular`.
 */
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { precosDaConsulta } from '../agent/prompt-composer.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import {
  atualizarVistos,
  CAIXAS_REGUA,
  CAMPO_PARTIDA,
  conversaDoChatwoot,
  decidirEtiquetaCelular,
  decidirRegua,
  ETIQUETA_CELULAR,
  ID_REGUA,
  notaDoSeco,
  SUFIXO_FALTA,
  type ConversaRegua,
  type DadosDaUnidade,
  type Mudanca,
  type Visto,
} from './chatwoot-regua.js';

const SWEEP_MS = Number(process.env.CHATWOOT_REGUA_SWEEP_MS) || 10 * 60_000;
const PRIMEIRA_VARREDURA_MS = 150_000;
/** 25 conversas por página. */
const MAX_PAGINAS = 200;
export const MAX_MENSAGENS_POR_CICLO = 60;
export const MAX_ETIQUETAS_POR_CICLO = 100;
/** Quanto do histórico de disparos o ciclo carrega para conferir repetição (a UNIQUE do banco vale para sempre). */
const DIAS_DE_FEITOS = 130;
const PAUSA_ENTRE_ESCRITAS_MS = 120;

// ── portas (trocáveis no teste) ────────────────────────────────────────────────────────────────────

export interface LinhaVista {
  conversationId: number;
  campo: string;
  valor: string;
  desde: Date;
  inicial: boolean;
}

export interface Armazem {
  vistos(caixa: number): Promise<LinhaVista[]>;
  salvar(caixa: number, mudancas: Array<Mudanca & { conversationId: number }>): Promise<void>;
  feitos(caixa: number, desde: Date): Promise<Array<{ conversationId: number; regra: string; chave: string }>>;
  /** false = já existia (outra cópia do servidor ou ciclo anterior) */
  registrar(l: { caixa: number; conversationId: number; regra: string; chave: string; modo: string; texto: string }): Promise<boolean>;
  desfazer(conversationId: number, regra: string, chave: string): Promise<void>;
}

export interface Chat {
  /** uma página (25) da listagem da caixa; vazia = acabou */
  pagina(caixa: number, pagina: number): Promise<unknown[]>;
  mensagem(conversationId: number, texto: string, privada: boolean): Promise<void>;
  etiquetas(conversationId: number, etiquetas: string[]): Promise<void>;
}

export interface DepsDoCiclo {
  armazem: Armazem;
  chat: Chat;
  pausa: (ms: number) => Promise<void>;
}

export function armazemDoBanco(): Armazem {
  return {
    async vistos(caixa) {
      return prisma.chatwootReguaVisto.findMany({ where: { caixa }, select: { conversationId: true, campo: true, valor: true, desde: true, inicial: true } });
    },
    async salvar(caixa, mudancas) {
      const criar = mudancas.filter((m): m is Extract<Mudanca, { tipo: 'criar' }> & { conversationId: number } => m.tipo === 'criar');
      for (let i = 0; i < criar.length; i += 500) {
        await prisma.chatwootReguaVisto.createMany({
          data: criar.slice(i, i + 500).map((m) => ({ caixa, conversationId: m.conversationId, campo: m.campo, valor: m.valor, desde: m.desde, inicial: m.inicial })),
          skipDuplicates: true,
        });
      }
      const resto = mudancas.filter((m) => m.tipo !== 'criar');
      for (let i = 0; i < resto.length; i += 100) {
        await prisma.$transaction(
          resto.slice(i, i + 100).map((m) =>
            m.tipo === 'atualizar'
              ? prisma.chatwootReguaVisto.updateMany({ where: { caixa, conversationId: m.conversationId, campo: m.campo }, data: { valor: m.valor, desde: m.desde, inicial: false } })
              : prisma.chatwootReguaVisto.deleteMany({ where: { caixa, conversationId: m.conversationId, campo: m.campo } }),
          ),
        );
      }
    },
    async feitos(caixa, desde) {
      return prisma.chatwootReguaDisparo.findMany({ where: { caixa, criadoEm: { gte: desde } }, select: { conversationId: true, regra: true, chave: true } });
    },
    async registrar(l) {
      try {
        await prisma.chatwootReguaDisparo.create({ data: l });
        return true;
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') return false;
        throw err;
      }
    },
    async desfazer(conversationId, regra, chave) {
      await prisma.chatwootReguaDisparo.deleteMany({ where: { conversationId, regra, chave } });
    },
  };
}

export function chatDoChatwoot(ctx: ContextoChatwoot): Chat {
  return {
    async pagina(caixa, pagina) {
      const r = (await chamar(ctx, 'GET', 'conversations', {
        query: { inbox_id: String(caixa), status: 'all', assignee_type: 'all', page: String(pagina) },
      })) as { data?: { payload?: unknown[] }; payload?: unknown[] } | null;
      const lista = r?.data?.payload ?? r?.payload ?? [];
      return Array.isArray(lista) ? lista : [];
    },
    async mensagem(conversationId, texto, privada) {
      await chamar(ctx, 'POST', `conversations/${conversationId}/messages`, { corpo: { content: texto, message_type: 'outgoing', private: privada } });
    },
    async etiquetas(conversationId, etiquetas) {
      // o Chatwoot SUBSTITUI a lista inteira: quem chama manda a lista completa
      await chamar(ctx, 'POST', `conversations/${conversationId}/labels`, { corpo: { labels: etiquetas } });
    },
  };
}

// ── o ciclo ────────────────────────────────────────────────────────────────────────────────────────

export interface ResumoDoCiclo {
  conversas: number;
  truncada: boolean;
  disparos: number;
  faltando: number;
  perdidas: Record<string, number>;
  etiquetas: number;
  falhas: number;
  primeiraVez: boolean;
}

async function lerConversas(chat: Chat, caixa: number): Promise<{ conversas: ConversaRegua[]; truncada: boolean }> {
  const vistas = new Set<number>();
  const conversas: ConversaRegua[] = [];
  for (let p = 1; p <= MAX_PAGINAS; p++) {
    const pagina = await chat.pagina(caixa, p);
    if (pagina.length === 0) return { conversas, truncada: false };
    for (const raw of pagina) {
      const c = conversaDoChatwoot(raw);
      if (!c || vistas.has(c.id)) continue;
      vistas.add(c.id);
      conversas.push(c);
    }
  }
  return { conversas, truncada: true };
}

const statusDoErro = (e: unknown): number | undefined => (e as { status?: number })?.status;

/**
 * Um ciclo de uma caixa. `modo` nunca é «desligado» aqui. Não lança por causa de UMA conversa: a falha dela vira log e conta em `falhas`.
 * Falha ao LISTAR as conversas aborta o ciclo (a memória não é tocada).
 */
export async function cicloDaCaixa(deps: DepsDoCiclo, caixa: number, slug: string, modo: 'seco' | 'ligado', unidade: DadosDaUnidade, agora: Date): Promise<ResumoDoCiclo> {
  const { armazem, chat } = deps;
  const { conversas, truncada } = await lerConversas(chat, caixa);

  // memória: o que já foi visto e o que já foi decidido
  const linhas = await armazem.vistos(caixa);
  const partidaLinha = linhas.find((l) => l.conversationId === 0 && l.campo === CAMPO_PARTIDA);
  const primeiraVez = !partidaLinha;
  const partida = { primeiraVez, desde: partidaLinha?.desde ?? agora };
  const porConversa = new Map<number, Map<string, Visto>>();
  for (const l of linhas) {
    if (l.conversationId === 0) continue;
    const m = porConversa.get(l.conversationId) ?? new Map<string, Visto>();
    m.set(l.campo, { valor: l.valor, desde: l.desde, inicial: l.inicial });
    porConversa.set(l.conversationId, m);
  }
  const feitosLinhas = await armazem.feitos(caixa, new Date(agora.getTime() - DIAS_DE_FEITOS * 86_400_000));
  const feitosPorConversa = new Map<number, Set<string>>();
  for (const f of feitosLinhas) {
    const s = feitosPorConversa.get(f.conversationId) ?? new Set<string>();
    s.add(`${f.regra}|${f.chave}`);
    feitosPorConversa.set(f.conversationId, s);
  }

  const resumo: ResumoDoCiclo = { conversas: conversas.length, truncada, disparos: 0, faltando: 0, perdidas: {}, etiquetas: 0, falhas: 0, primeiraVez };
  const mudancas: Array<Mudanca & { conversationId: number }> = [];
  if (primeiraVez) mudancas.push({ conversationId: 0, tipo: 'criar', campo: CAMPO_PARTIDA, valor: '1', desde: agora, inicial: true });
  const pendentes: Array<{ c: ConversaRegua; vistos: ReadonlyMap<string, Visto> }> = [];
  for (const c of conversas) {
    const r = atualizarVistos(c, porConversa.get(c.id) ?? new Map(), agora, partida);
    for (const m of r.mudancas) mudancas.push({ ...m, conversationId: c.id });
    pendentes.push({ c, vistos: r.vistos });
  }
  // a memória primeiro: se o ciclo falhar depois, o "desde" já está guardado
  await armazem.salvar(caixa, mudancas);

  let mensagens = 0;
  let etiquetas = 0;
  for (const { c, vistos } of pendentes) {
    try {
      const { disparos, perdidas } = decidirRegua(c, { vistos, feitos: feitosPorConversa.get(c.id) ?? new Set() }, agora, unidade);
      for (const r of perdidas) resumo.perdidas[r] = (resumo.perdidas[r] ?? 0) + 1;
      for (const d of disparos) {
        if (mensagens >= MAX_MENSAGENS_POR_CICLO) break;
        const faltou = d.texto === null;
        const regra = faltou ? `${d.regra}${SUFIXO_FALTA}` : d.regra;
        // faltou campo: só o seco avisa (uma vez por chave); ligado não manda nem anota
        if (faltou && modo === 'ligado') continue;
        const nota = notaDoSeco(d);
        const texto = modo === 'seco' ? nota : (d.texto as string);
        const novo = await armazem.registrar({ caixa, conversationId: c.id, regra, chave: d.chave, modo, texto });
        if (!novo) continue;
        mensagens++;
        try {
          await deps.chat.mensagem(c.id, texto, modo === 'seco');
          if (faltou) resumo.faltando++;
          else resumo.disparos++;
          await deps.pausa(PAUSA_ENTRE_ESCRITAS_MS);
        } catch (err) {
          resumo.falhas++;
          const status = statusDoErro(err);
          // seco: tenta de novo no próximo ciclo. Ligado: só desfaz se o Chatwoot RECUSOU (4xx); sem resposta pode ter ido.
          if (modo === 'seco' || (status !== undefined && status >= 400 && status < 500)) await armazem.desfazer(c.id, regra, d.chave).catch(() => undefined);
          logger.warn({ err: String(err), caixa, conversa: c.id, regra: d.regra, modo }, `${ID_REGUA}: não consegui ${modo === 'seco' ? 'deixar a nota' : 'mandar a mensagem'}`);
        }
      }
      // sinal interno: não é mensagem ao paciente
      const et = etiquetas < MAX_ETIQUETAS_POR_CICLO ? decidirEtiquetaCelular(c) : null;
      if (et) {
        const lista = et === 'por' ? [...c.etiquetas, ETIQUETA_CELULAR] : c.etiquetas.filter((x) => x !== ETIQUETA_CELULAR);
        etiquetas++;
        try {
          await deps.chat.etiquetas(c.id, lista);
          resumo.etiquetas++;
          await deps.pausa(PAUSA_ENTRE_ESCRITAS_MS);
        } catch (err) {
          resumo.falhas++;
          logger.warn({ err: String(err), caixa, conversa: c.id }, `${ID_REGUA}: não consegui mexer na etiqueta ${ETIQUETA_CELULAR}`);
        }
      }
    } catch (err) {
      resumo.falhas++;
      logger.warn({ err: String(err), caixa, conversa: c.id }, `${ID_REGUA}: falhou numa conversa — sigo com as outras`);
    }
  }
  logger.info({ slug, caixa, modo, ...resumo }, `${ID_REGUA}: ciclo`);
  return resumo;
}

// ── liga/desliga ───────────────────────────────────────────────────────────────────────────────────

export const estadoDaRegua = (slug: string): Estado => estadoDaAutomacao(slug, ID_REGUA, process.env.CHATWOOT_REGUA_SLUGS);

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(ctx: ContextoChatwoot): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const deps: DepsDoCiclo = { armazem: armazemDoBanco(), chat: chatDoChatwoot(ctx), pausa: (ms) => new Promise((r) => setTimeout(r, ms)) };
    for (const [caixaTxt, slug] of Object.entries(CAIXAS_REGUA)) {
      const modo = estadoDaRegua(slug);
      if (modo === 'desligado') continue;
      try {
        const unit = await prisma.unit.findUnique({ where: { slug } });
        if (!unit) {
          logger.warn({ slug }, `${ID_REGUA}: unidade não encontrada`);
          continue;
        }
        const unidade: DadosDaUnidade = { nome: unit.name, pixKey: unit.pixKey, valorAntecipado: precosDaConsulta(unit)?.antecipado ?? null };
        await cicloDaCaixa(deps, Number(caixaTxt), slug, modo, unidade, new Date());
      } catch (err) {
        logger.warn({ err: String(err), slug }, `${ID_REGUA}: ciclo falhou — tento no próximo`);
      }
    }
  } finally {
    rodando = false;
  }
}

export function startChatwootReguaWorker(): void {
  if (timer) return;
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    logger.info(`${ID_REGUA}: sem CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID — worker não sobe`);
    return;
  }
  const ctx = criarContextoChatwoot(conta);
  primeira = setTimeout(() => void varrer(ctx), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(ctx), SWEEP_MS);
  logger.info(`${ID_REGUA}: worker iniciado`);
}

export function stopChatwootReguaWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
