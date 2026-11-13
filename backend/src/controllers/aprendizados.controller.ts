/**
 * Página pública `/aprendizados/:slug`: a própria unidade ensina a Sofia (pedido da dona de Timbó, 11/11/2026).
 * Mesmo molde da pausa (`pausa.controller.ts`): sem login, protegida pelo código de 6 dígitos da unidade e pela trava
 * de tentativas por ip+unidade. Nasce desligada: chave `aprendizados-pela-unidade` por unidade (automacoes.ts).
 *
 * Por que não o conector do claude.ai: ele não filtra por unidade (Kommo, Asaas, RH de TODAS as clínicas) — dar acesso
 * a uma unidade seria vazamento. Aqui a pessoa só vê e mexe nas regras da unidade dela.
 *
 * Fluxo: escreve a regra → prévia (a Sofia responde a falas de exemplo sem e com a regra; nada gravado) → salva.
 * A regra entra no bloco `<aprendizados>` do prompt (`renderLessons`), com a trava de pronto-socorro de sempre.
 * As travas que a unidade não desliga moram em `lib/aprendizados-unidade.ts`. Cada regra salva ou desligada avisa o João.
 */
import { sessaoDaAtendente } from './funil.controller.js';
import { leituraComLogin } from './assistente.controller.js';
import { CAIXAS_REGUA } from '../lib/chatwoot-regua.js';
import { ETIQUETA_PAUSA } from '../lib/chatwoot-pausa.js';
import { chamar, contaChatwootDoAmbiente } from '../mcp-remoto/chatwoot.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { enviarTelegram } from '../lib/telegram.js';
import { MAX_LICOES_NO_PROMPT } from '../services/lessons.service.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import {
  CHAVE_APRENDIZADOS,
  FALAS_DE_EXEMPLO,
  MAX_CARACTERES,
  MAX_FALAS_DA_PREVIA,
  MAX_REGRAS_DA_UNIDADE,
  SOURCE_DA_UNIDADE,
  cabePrevia,
  devolverPrevia,
  normalizarRegra,
  previasRestantes,
  recusaDaRegra,
} from '../lib/aprendizados-unidade.js';
import {
  MAX_CARACTERES_DA_FALA,
  MAX_MENSAGENS_DA_CONVERSA,
  cabeResposta,
  descreverAcao,
  devolverResposta,
  entrarEmAndamento,
  maxRespostasTeste,
  prepararHistorico,
  respostasRestantes,
  sairDeAndamento,
} from '../lib/conversa-de-teste.js';
import { RECUSA_DA_ENTRADA, RESPOSTA_NEUTRA, ecoDoPrompt, pedeOPrompt } from '../lib/conversa-de-teste-trava.js';
import { esc, unidadePublica } from './pausa.controller.js';
import { rodarTesteDaSofia } from './playground.controller.js';

function ligadaPara(slug: string): boolean {
  return automacaoLigada(slug, CHAVE_APRENDIZADOS, process.env.APRENDIZADOS_PELA_UNIDADE_SLUGS);
}

/**
 * Aviso ao João de cada regra salva/desligada: é o que compensa a trava ser heurística. Pelo Telegram (DD-Avisos), não pelo
 * WhatsApp do alertas2, que está desconectado desde 09/11 (achado do sênior no #265). Falha só vai para o log.
 */
function avisar(texto: string): void {
  void enviarTelegram(texto, { canal: 'avisos' }).then((ok) => {
    if (!ok) logger.warn({ texto: texto.slice(0, 120) }, 'aprendizados: aviso ao João NÃO saiu no Telegram');
  });
}

/** Regras ligadas da unidade (todas as origens): passar de MAX_LICOES_NO_PROMPT = a nova ficaria fora do prompt real. */
function ligadasNoTotal(unitId: string): Promise<number> {
  return prisma.unitLesson.count({ where: { unitId, enabled: true } });
}

function fuso(unit: Unit): string {
  return unit.spineTimezone ?? 'America/Sao_Paulo';
}

/**
 * Pelo Chatwoot (tela "Testar a IA" no menu, 13/11/2026): vale o LOGIN da própria atendente no lugar do código, desde que ela
 * atenda uma caixa desta unidade. O nome dela vira o «por» de quem mudou (não dá para escrever outro). Não depende da chave
 * `aprendizados-pela-unidade` (ela fecha a página PÚBLICA com código; aqui o acesso é o login do Chatwoot).
 */
async function unidadePeloChatwoot(req: Request, res: Response, slug: string): Promise<Unit | null> {
  const a = await sessaoDaAtendente(req, res);
  if (!a) return null;
  let caixas: number[];
  try {
    caixas = await leituraComLogin(a.c, a.sessao).caixas();
  } catch {
    res.status(502).json({ error: 'não consegui ler as suas caixas no Chatwoot' });
    return null;
  }
  if (!caixas.some((cx) => CAIXAS_REGUA[cx] === slug)) {
    res.status(403).json({ error: 'você não atende esta unidade' });
    return null;
  }
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return null;
  }
  if (req.body && typeof req.body === 'object') (req.body as Record<string, unknown>).por = a.nome.slice(0, 80) || 'atendente';
  return unit;
}

/** Chave desligada = a unidade "não existe" aqui, antes de olhar código (não dá para sondar). */
async function unidadeComChave(req: Request, res: Response): Promise<Unit | null> {
  const slug = String(req.params.slug ?? '');
  // login do Chatwoot (menu "Testar a IA") no lugar do código; sem o cabeçalho, segue o caminho público de sempre
  if (typeof req.get === 'function' && req.get('X-CW-Token')) return unidadePeloChatwoot(req, res, slug);
  if (!ligadaPara(slug)) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return null;
  }
  return unidadePublica(req, res);
}

async function estado(unit: Unit) {
  const regras = await prisma.unitLesson.findMany({
    where: { unitId: unit.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, content: true, enabled: true, source: true, createdAt: true },
  });
  return {
    unidade: unit.name,
    slug: unit.slug,
    regras: regras.map((r) => ({
      id: r.id,
      content: r.content,
      enabled: r.enabled,
      daUnidade: r.source === SOURCE_DA_UNIDADE,
      createdAt: r.createdAt,
    })),
    previasRestantes: previasRestantes(unit.slug, fuso(unit)),
    falasDeExemplo: FALAS_DE_EXEMPLO,
    maxCaracteres: MAX_CARACTERES,
    conversa: {
      restantes: respostasRestantes(unit.slug, fuso(unit)),
      maximo: maxRespostasTeste(),
      maxFala: MAX_CARACTERES_DA_FALA,
      maxMensagens: MAX_MENSAGENS_DA_CONVERSA,
    },
  };
}

const conversaSchema = z.object({
  messages: z
    // folga grande de propósito: o corte (fala da Sofia) e a recusa (fala do paciente) são de `prepararHistorico`, com mensagem própria
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(30_000) }))
    .min(1)
    .max(200),
});

type RodarTeste = typeof rodarTesteDaSofia;

/**
 * Conversa livre de TESTE com a Sofia (aba "Conversar com a Sofia" da página). Mesmo núcleo da prévia e do playground do
 * painel: ferramentas simuladas, agenda fictícia, nada para Kommo/franquia/Asaas/WhatsApp, e SEM `leadId` (nenhuma leitura
 * de cartão ou de paciente real entra no prompt). O histórico vem do navegador e não é gravado; só o custo da chamada
 * (`llm_calls`, sem trace de conversa) fica, como na prévia. `rodar` entra por parâmetro para o teste provar que o caminho
 * é o do sandbox.
 */
export function criarConversaHandler(rodar: RodarTeste) {
  return async function conversaHandler(req: Request, res: Response): Promise<void> {
    const unit = await unidadeComChave(req, res);
    if (!unit) return;
    const parsed = conversaSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'pedido inválido' });
      return;
    }
    const historico = prepararHistorico(parsed.data.messages);
    if (!historico.ok) {
      res.status(400).json({ error: historico.erro });
      return;
    }
    // trava de entrada: quem pede o texto da Sofia não chega ao modelo, não gasta cota nem dinheiro (e não entra no histórico)
    if (historico.messages.some((m) => m.role === 'user' && pedeOPrompt(m.content))) {
      logger.warn({ evento: 'conversa_teste', desfecho: 'recusada_entrada', unit: unit.slug }, 'aprendizados: conversa de teste barrou pedido do texto interno da Sofia');
      res.status(422).json({ error: RECUSA_DA_ENTRADA });
      return;
    }
    const tz = fuso(unit);
    if (!entrarEmAndamento(unit.slug)) {
      res.status(429).json({ error: 'A Sofia ainda está respondendo outra conversa desta unidade. Espere uns segundos e envie de novo.', restantes: respostasRestantes(unit.slug, tz) });
      return;
    }
    // a vaga de "respondendo" é liberada no `finally`, a não ser que a chamada ao modelo fique pendurada depois do prazo: aí quem
    // libera é ela terminar (senão o prazo deixaria acumular chamadas). Qualquer erro no caminho libera.
    let vagaComAChamada = false;
    let liberada = false;
    const liberar = () => {
      if (!liberada) {
        liberada = true;
        sairDeAndamento(unit.slug);
      }
    };
    let cobrada = false;
    let promptCompleto: string | undefined;
    // o modelo só é chamado depois que o prompt é montado: antes disso, nenhum custo — a resposta volta para o teto
    const devolverSeNaoCustou = () => {
      if (cobrada && promptCompleto === undefined) devolverResposta(unit.slug, tz);
    };
    let prazo: NodeJS.Timeout | undefined;
    try {
      if (!cabeResposta(unit.slug, tz)) {
        res.status(429).json({ error: `As ${maxRespostasTeste()} respostas de teste de hoje acabaram. Amanhã libera de novo.`, restantes: 0 });
        return;
      }
      cobrada = true;
      const PRAZO_MS = 90_000;
      const estourou = new Promise<'prazo'>((ok) => {
        prazo = setTimeout(() => ok('prazo'), PRAZO_MS);
      });
      vagaComAChamada = true;
      const trabalho = (async () => rodar(unit, historico.messages, { aoMontarPrompt: (p) => (promptCompleto = p) }))().finally(liberar);
      const r = await Promise.race([trabalho, estourou]);
      if (r === 'prazo') {
        // a chamada pode terminar e custar: não devolve a resposta ao teto
        logger.warn({ unit: unit.slug }, 'aprendizados: a conversa de teste passou do prazo');
        res.status(504).json({ error: 'A Sofia demorou demais para responder. Espere um pouco e tente de novo (esta resposta pode ter contado no limite de hoje).', restantes: respostasRestantes(unit.slug, tz) });
        return;
      }
      if (!r.ok) {
        // falha DEPOIS de montar o prompt pode ter custado até 5 iterações: não devolve (falha repetida não gasta dinheiro de graça)
        devolverSeNaoCustou();
        logger.warn({ unit: unit.slug, erro: r.error, status: r.status }, 'aprendizados: a conversa de teste falhou');
        res.status(502).json({ error: 'A Sofia não respondeu agora. Tente de novo em instantes.', restantes: respostasRestantes(unit.slug, tz) });
        return;
      }
      // `evento: conversa_teste` + `desfecho` (entregue | barrada_eco): taxa de bloqueio = barrada_eco / (entregue + barrada_eco)
      logger.info(
        { evento: 'conversa_teste', desfecho: 'respondida', unit: unit.slug, turnos: historico.messages.length, iteracoes: r.meta.iterations, tokens: r.meta.tokens, costUsd: r.meta.costUsd, ms: r.meta.totalLatencyMs },
        'aprendizados: resposta de teste',
      );
      // trava de saída: resposta que repete o prompt (trecho literal ou marcador de bloco) vira neutra; já custou, fica na cota
      if (ecoDoPrompt(r.reply, promptCompleto)) {
        logger.warn({ evento: 'conversa_teste', desfecho: 'barrada_eco', unit: unit.slug, promptCapturado: promptCompleto !== undefined }, 'aprendizados: conversa de teste barrou resposta que repetia o prompt');
        res.json({ reply: RESPOSTA_NEUTRA, acoes: [], restantes: respostasRestantes(unit.slug, tz) });
        return;
      }
      res.json({
        reply: r.reply,
        acoes: r.actions.map((a) => descreverAcao(a)),
        restantes: respostasRestantes(unit.slug, tz),
      });
    } catch (err) {
      devolverSeNaoCustou();
      logger.error({ err, unit: unit.slug }, 'aprendizados: a conversa de teste quebrou');
      if (!res.headersSent) res.status(500).json({ error: 'A Sofia não respondeu agora. Tente de novo em instantes.', restantes: respostasRestantes(unit.slug, tz) });
    } finally {
      clearTimeout(prazo);
      if (!vagaComAChamada) liberar();
    }
  };
}

export const publicAprendizadosConversaHandler = criarConversaHandler(rodarTesteDaSofia);

const previaSchema = z.object({
  regra: z.string().max(MAX_CARACTERES * 2),
  falas: z.array(z.string().trim().max(500)).max(MAX_FALAS_DA_PREVIA).optional(),
});

const salvarSchema = z.object({
  regra: z.string().max(MAX_CARACTERES * 2),
  por: z.string().trim().min(2).max(80),
});

const ligarSchema = z.object({
  enabled: z.boolean(),
  por: z.string().trim().min(2).max(80),
});

// ── rotas públicas (com código) ─────────────────────────────────────────────
export async function publicAprendizadosHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  res.json(await estado(unit));
}

export async function publicAprendizadosPreviaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  const parsed = previaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'pedido inválido' });
    return;
  }
  const regra = normalizarRegra(parsed.data.regra);
  const recusa = recusaDaRegra(regra);
  if (recusa) {
    res.status(422).json({ error: recusa });
    return;
  }
  const falas = (parsed.data.falas ?? []).filter(Boolean);
  const usar = (falas.length > 0 ? falas : [...FALAS_DE_EXEMPLO]).slice(0, MAX_FALAS_DA_PREVIA);
  if ((await ligadasNoTotal(unit.id)) >= MAX_LICOES_NO_PROMPT) {
    res.status(422).json({ error: `A Sofia já tem ${MAX_LICOES_NO_PROMPT} regras ligadas nesta unidade, o máximo que ela lê. Desligue uma antes.` });
    return;
  }
  if (!cabePrevia(unit.slug, fuso(unit))) {
    res.status(429).json({ error: 'As prévias de hoje acabaram. Amanhã libera de novo — ou salve a regra e acompanhe as conversas.' });
    return;
  }
  // "antes" e "depois" de cada fala em paralelo: a pessoa espera uma vez só; com prazo, para a página não ficar presa
  const PRAZO_MS = 120_000;
  let prazo: NodeJS.Timeout | undefined;
  const estourou = new Promise<'prazo'>((ok) => {
    prazo = setTimeout(() => ok('prazo'), PRAZO_MS);
  });
  const todas = Promise.all(
    usar.map(async (fala) => {
      const msgs = [{ role: 'user' as const, content: fala }];
      const [antes, depois] = await Promise.all([
        rodarTesteDaSofia(unit, msgs),
        rodarTesteDaSofia(unit, msgs, { aprendizadosExtras: [regra] }),
      ]);
      return { fala, antes, depois };
    }),
  );
  const corrida = await Promise.race([todas, estourou]).finally(() => clearTimeout(prazo));
  if (corrida === 'prazo') {
    devolverPrevia(unit.slug, fuso(unit));
    logger.warn({ unit: unit.slug }, 'aprendizados: a prévia passou de 2 min');
    res.status(504).json({ error: 'A Sofia demorou demais para responder a prévia. Tente de novo em instantes (esta não contou).' });
    return;
  }
  const rodadas = corrida;
  const falhou = rodadas.find((r) => !r.antes.ok || !r.depois.ok);
  if (falhou) {
    devolverPrevia(unit.slug, fuso(unit));
    const erro = !falhou.antes.ok ? falhou.antes : !falhou.depois.ok ? falhou.depois : null;
    logger.warn({ unit: unit.slug, erro }, 'aprendizados: a prévia falhou');
    res.status(502).json({ error: 'A Sofia não respondeu a prévia agora. Tente de novo em instantes (esta não contou).' });
    return;
  }
  logger.info({ unit: unit.slug, regra }, 'aprendizados: prévia rodada');
  res.json({
    regra,
    resultados: rodadas.map((r) => ({
      fala: r.fala,
      antes: r.antes.ok ? r.antes.reply : '',
      depois: r.depois.ok ? r.depois.reply : '',
    })),
    previasRestantes: previasRestantes(unit.slug, fuso(unit)),
  });
}

export async function publicAprendizadosSalvarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  const parsed = salvarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Escreva a regra e o seu nome.' });
    return;
  }
  const regra = normalizarRegra(parsed.data.regra);
  const recusa = recusaDaRegra(regra);
  if (recusa) {
    res.status(422).json({ error: recusa });
    return;
  }
  const ligadas = await prisma.unitLesson.count({ where: { unitId: unit.id, source: SOURCE_DA_UNIDADE, enabled: true } });
  if (ligadas >= MAX_REGRAS_DA_UNIDADE) {
    res.status(422).json({ error: `Já são ${ligadas} regras ligadas. Desligue uma que não vale mais antes de criar outra.` });
    return;
  }
  const total = await ligadasNoTotal(unit.id);
  if (total >= MAX_LICOES_NO_PROMPT) {
    res.status(422).json({ error: `A Sofia já tem ${total} regras ligadas nesta unidade, o máximo que ela lê. Desligue uma antes de criar outra.` });
    return;
  }
  const igual = await prisma.unitLesson.findFirst({ where: { unitId: unit.id, content: regra, enabled: true } });
  if (igual) {
    res.status(409).json({ error: 'Essa regra já está ligada.' });
    return;
  }
  const criada = await prisma.unitLesson.create({ data: { unitId: unit.id, content: regra, source: SOURCE_DA_UNIDADE, enabled: true } });
  const por = parsed.data.por;
  logger.info({ unit: unit.slug, por, lessonId: criada.id, regra }, 'aprendizados: regra salva pela unidade');
  avisar(`🧠 ${unit.name}: ${por} ensinou a Sofia (página de aprendizados)\n"${regra}"`);
  res.json(await estado(unit));
}

export async function publicAprendizadosLigarHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeComChave(req, res);
  if (!unit) return;
  const parsed = ligarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Escreva o seu nome.' });
    return;
  }
  const id = String(req.params.id ?? '');
  // a unidade só mexe no que ela escreveu: as regras do painel (João, reflexão) ficam só para leitura
  const regra = await prisma.unitLesson.findFirst({ where: { id, unitId: unit.id, source: SOURCE_DA_UNIDADE } });
  if (!regra) {
    res.status(404).json({ error: 'regra não encontrada' });
    return;
  }
  if (parsed.data.enabled) {
    // religar passa pelas travas de hoje e pelo teto, como uma regra nova
    const recusa = recusaDaRegra(regra.content);
    if (recusa) {
      res.status(422).json({ error: recusa });
      return;
    }
    const ligadas = await prisma.unitLesson.count({ where: { unitId: unit.id, source: SOURCE_DA_UNIDADE, enabled: true } });
    if (!regra.enabled && ligadas >= MAX_REGRAS_DA_UNIDADE) {
      res.status(422).json({ error: `Já são ${ligadas} regras ligadas. Desligue uma antes.` });
      return;
    }
    if (!regra.enabled && (await ligadasNoTotal(unit.id)) >= MAX_LICOES_NO_PROMPT) {
      res.status(422).json({ error: `A Sofia já tem ${MAX_LICOES_NO_PROMPT} regras ligadas nesta unidade, o máximo que ela lê. Desligue uma antes.` });
      return;
    }
    const igual = await prisma.unitLesson.findFirst({ where: { unitId: unit.id, content: regra.content, enabled: true, NOT: { id: regra.id } } });
    if (igual) {
      res.status(409).json({ error: 'Essa regra já está ligada.' });
      return;
    }
  }
  await prisma.unitLesson.update({ where: { id: regra.id }, data: { enabled: parsed.data.enabled } });
  const por = parsed.data.por;
  logger.info({ unit: unit.slug, por, lessonId: regra.id, enabled: parsed.data.enabled }, 'aprendizados: regra ligada/desligada pela unidade');
  avisar(`🧠 ${unit.name}: ${por} ${parsed.data.enabled ? 'religou' : 'desligou'} a regra (página de aprendizados)\n"${regra.content}"`);
  res.json(await estado(unit));
}

// ── "Testar a IA" no menu do Chatwoot (login da atendente) ──────────────────────

/** As unidades que a atendente atende (pelas caixas que ela vê no Chatwoot) e o nome dela. */
export async function testarIaUnidadesHandler(req: Request, res: Response): Promise<void> {
  const a = await sessaoDaAtendente(req, res);
  if (!a) return;
  try {
    const slugs = [...new Set((await leituraComLogin(a.c, a.sessao).caixas()).map((cx) => CAIXAS_REGUA[cx]).filter((x): x is string => !!x))];
    const units = slugs.length ? await prisma.unit.findMany({ where: { slug: { in: slugs }, isActive: true }, select: { slug: true, name: true } }) : [];
    res.json({ eu: a.nome, unidades: units.map((u) => ({ slug: u.slug, nome: u.name })) });
  } catch (e) {
    logger.warn({ err: String(e) }, 'testar-ia: unidades falhou');
    res.status(502).json({ error: 'não consegui ler as suas caixas no Chatwoot' });
  }
}

/** As conversas abertas com a IA pausada, nas caixas com IA que ela vê (com o login dela). */
export async function testarIaPausadasHandler(req: Request, res: Response): Promise<void> {
  const a = await sessaoDaAtendente(req, res);
  if (!a) return;
  try {
    const caixas = (await leituraComLogin(a.c, a.sessao).caixas()).filter((cx) => CAIXAS_REGUA[cx]);
    const lista: Array<{ id: number; nome: string; por: string | null; em: string | null; atendente: string | null }> = [];
    for (const cx of caixas) {
      for (let pagina = 1; pagina <= 8; pagina++) {
        const r = (await chamar(a.c, 'GET', 'conversations', {
          sessao: a.sessao,
          query: { inbox_id: String(cx), status: 'open', assignee_type: 'all', 'labels[]': ETIQUETA_PAUSA, page: String(pagina) },
        })) as any;
        const lote: any[] = r?.data?.payload ?? [];
        for (const c of lote) {
          if (!(Array.isArray(c?.labels) && c.labels.includes(ETIQUETA_PAUSA))) continue;
          const at = c?.custom_attributes ?? {};
          lista.push({
            id: Number(c.id),
            nome: String(c?.meta?.sender?.name ?? '').trim() || String(c?.meta?.sender?.phone_number ?? '') || `Conversa ${c.id}`,
            por: typeof at.ia_pausada_por === 'string' ? at.ia_pausada_por : null,
            em: typeof at.ia_pausada_em === 'string' ? at.ia_pausada_em : null,
            atendente: c?.meta?.assignee?.name ?? null,
          });
        }
        if (lote.length < 25) break;
      }
    }
    lista.sort((x, y) => String(y.em ?? '').localeCompare(String(x.em ?? '')));
    res.json({ conversas: lista });
  } catch (e) {
    logger.warn({ err: String(e) }, 'testar-ia: pausadas falhou');
    res.status(502).json({ error: 'não consegui ler as conversas pausadas' });
  }
}

/** A página "Testar a IA" (iframe do menu do Chatwoot): a mesma página de ensinar a Sofia, em modo Chatwoot (claro, sem código). */
export function paginaTestarIaHandler(_req: Request, res: Response): void {
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Chatwoot não configurado.</p>');
    return;
  }
  res.type('html').send(paginaHtml('', 'Testar a IA', { chatwoot: new URL(conta.url).origin }));
}

// ── a página ─────────────────────────────────────────────────────────────────
export async function paginaAprendizadosHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const unit = ligadaPara(slug) ? await prisma.unit.findUnique({ where: { slug }, select: { name: true, isActive: true } }) : null;
  if (!unit || !unit.isActive) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Ensinar a Sofia</title><p style="font-family:sans-serif;padding:24px">Página não encontrada.</p>');
    return;
  }
  res.type('html').send(paginaHtml(slug, unit.name));
}

/** `modo.chatwoot` = origem do Chatwoot: página dentro do menu (login do Chatwoot, sem código, visual claro, aba Pausadas). */
export function paginaHtml(slug: string, nome: string, modo: { chatwoot?: string } = {}): string {
  const cw = !!modo.chatwoot;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ensinar a Sofia · ${esc(nome)}</title>
<style>
:root{--bg:#0B0B11;--s1:#13131B;--s2:#1A1A24;--line:#2A2A36;--ink:#F5F5F7;--ink2:#C7C8D1;--muted:#8A8C97;--acc:#3D6BFF;--ok:#04D361;--warn:#E9B949;--red:#F75A68}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;padding:20px 16px 48px}
main{max-width:560px;margin:0 auto}h1{font-size:22px;font-weight:600;margin:6px 0 2px}h2{font-size:16px;font-weight:600;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.card{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 6px;letter-spacing:.02em}
input,textarea{width:100%;background:var(--s2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;padding:12px}
textarea{min-height:96px;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--acc);border-color:transparent}
[hidden]{display:none!important}
button.main{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:var(--acc);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}
button.main.ok{background:var(--ok);color:#06210F}button:disabled{opacity:.55;cursor:default}
.msg{margin-top:10px;padding:10px 12px;border-radius:10px;font-size:14px;white-space:pre-wrap}.msg.ok{background:rgba(4,211,97,.12);color:#8FEFB4}.msg.err{background:rgba(247,90,104,.12);color:#FFB3B9}
.count{float:right;color:var(--muted);font-size:12px}
.regra{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}.regra:first-child{border-top:0}
.regra p{margin:0;flex:1;color:var(--ink2);white-space:pre-wrap;word-break:break-word}.regra.off p{color:var(--muted)}.regra.off .txt{text-decoration:line-through}
.tag{font-size:11px;color:var(--muted);display:block;margin-top:2px}
.sw{flex:none;border:1px solid var(--line);background:var(--s2);color:var(--ink);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}
.sw.on{border-color:var(--ok);color:#8FEFB4}
.res{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.res:first-child{border-top:0;margin-top:0;padding-top:0}
.bolha{border-radius:12px;padding:10px 12px;margin:6px 0;white-space:pre-wrap;word-break:break-word;font-size:15px}
.pac{background:var(--s2)}.antes{background:rgba(138,140,151,.12);color:var(--ink2)}.depois{background:rgba(61,107,255,.16)}
.rot{font-size:12px;color:var(--muted);margin-top:8px}
.foot{color:var(--muted);font-size:12.5px;margin-top:18px}
.abas{display:flex;gap:8px;margin:0 0 14px}.aba{flex:1;min-height:46px;padding:10px 8px;border:1px solid var(--line);background:var(--s1);color:var(--ink2);border-radius:12px;font:inherit;font-weight:600;cursor:pointer}.aba.on{background:var(--acc);border-color:var(--acc);color:#fff}
.aviso{background:rgba(233,185,73,.12);color:#F3D88A;border-radius:10px;padding:10px 12px;font-size:13.5px;margin:8px 0 12px}
.chat{display:flex;flex-direction:column;gap:6px;min-height:120px;max-height:52vh;overflow-y:auto;padding:2px;margin-bottom:10px;-webkit-overflow-scrolling:touch}
.bm{max-width:88%;padding:10px 12px;border-radius:14px;white-space:pre-wrap;word-break:break-word;font-size:15px}
.bm.p{align-self:flex-end;background:var(--acc);color:#fff;border-bottom-right-radius:4px}.bm.s{align-self:flex-start;background:var(--s2);border-bottom-left-radius:4px}.bm.dig{color:var(--muted);font-style:italic}
.chip{align-self:flex-start;font-size:12px;color:var(--warn);background:rgba(233,185,73,.1);border-radius:999px;padding:3px 10px}
button.sec{min-height:46px;padding:10px 14px;border:1px solid var(--line);background:var(--s2);color:var(--ink);border-radius:12px;font:inherit;cursor:pointer}
.linha{display:flex;gap:8px;margin-top:10px}.linha button.main{margin-top:0;flex:2}.linha button.sec{flex:1}
/* modo Chatwoot (menu "Testar a IA"): claro, no visual do Chatwoot, sem o cartão do código */
body.cw{--bg:#f8fafc;--s1:#fff;--s2:#f1f5f9;--line:#e2e8f0;--ink:#0f172a;--ink2:#334155;--muted:#64748b;--acc:#1f93ff;--ok:#12855a;--warn:#b54708;font-size:14.5px;padding:16px 20px 40px}
body.cw main{max-width:760px}body.cw h1{font-size:18px}body.cw #cardCodigo{display:none}
body.cw .card{border-radius:10px}body.cw .aba{min-height:38px;border-radius:8px;font-size:14px}body.cw button.main{border-radius:8px;font-size:14.5px;padding:11px}
body.cw button.main.ok{color:#fff}body.cw .msg.ok{background:#e9f6ee;color:#0b5e3b}body.cw .msg.err{background:#fdeceb;color:#9b1c1c}
body.cw .aviso{background:#fff7ed;color:#7c2d12}body.cw .chip{background:#fff7ed}body.cw .bm.p{color:#fff}body.cw .depois{background:#e8f2ff}
body.cw .sw.on{color:#0b5e3b}
.pz{display:flex;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}.pz:first-child{border-top:0}
.pz div{flex:1;min-width:0}.pz b{display:block}.pz small{color:var(--muted)}
</style></head><body${cw ? ' class="cw"' : ''}><main>
<p class="sub" style="margin:0">Doutor Digital · Sofia</p>
<h1 id="titulo">${esc(nome)}</h1>
<div id="msgTitulo" class="msg" hidden></div>
<p class="sub">${cw ? 'Converse com a Sofia como se fosse o paciente, ensine o que ela deve fazer diferente e veja as conversas em que a IA está pausada. Nada é enviado a paciente.' : 'Ensine a Sofia: escreva o que ela deve fazer diferente, veja a resposta dela antes e depois, e salve.'}</p>

<div class="card" id="cardCodigo">
  <label for="codigo">Código da unidade</label>
  <input id="codigo" inputmode="numeric" maxlength="6" placeholder="6 dígitos" autocomplete="one-time-code">
  <label for="por">Seu nome</label>
  <input id="por" placeholder="Quem está ensinando" maxlength="80">
  <div id="msgTopo" class="msg" hidden></div>
</div>

<div id="corpo" hidden>
<div class="abas" role="tablist">
  <button class="aba on" id="abaEnsinar" role="tab" type="button">Ensinar a Sofia</button>
  <button class="aba" id="abaConversa" role="tab" type="button">Conversar (teste)</button>
  <button class="aba" id="abaPausadas" role="tab" type="button"${cw ? '' : ' hidden'}>IA pausada</button>
</div>

<div id="paneEnsinar">
<div class="card">
  <h2>Nova regra</h2>
  <label for="regra">O que a Sofia deve fazer diferente? <span class="count" id="cnt"></span></label>
  <textarea id="regra" placeholder="Ex.: Quando o paciente disser que vai falar com a família, ofereça mandar o endereço e o valor por escrito para ele mostrar."></textarea>
  <details style="margin-top:10px"><summary style="color:var(--muted);font-size:14px;cursor:pointer">Falas de paciente para testar (pode trocar)</summary>
    <input id="f0" style="margin-top:8px" maxlength="500"><input id="f1" style="margin-top:8px" maxlength="500"><input id="f2" style="margin-top:8px" maxlength="500">
  </details>
  <button class="main" id="btnPrevia">Ver prévia</button>
  <div id="msgPrevia" class="msg" hidden></div>
</div>

<div class="card" id="cardRes" hidden>
  <h2>Prévia</h2>
  <p class="sub" style="margin:0 0 8px">Nada foi gravado ainda. Gostou? Salve abaixo.</p>
  <div id="res"></div>
  <button class="main ok" id="btnSalvar">Salvar regra</button>
  <div id="msgSalvar" class="msg" hidden></div>
</div>

<div class="card">
  <h2>Regras que a Sofia segue nesta unidade</h2>
  <div id="lista"></div>
</div>
</div>

<div id="panePausadas" hidden>
<div class="card">
  <h2>Conversas com a IA pausada</h2>
  <p class="sub" style="margin:0 0 6px">A IA pausa sozinha quando alguém da equipe responde (pelo Chatwoot ou pelo celular) e volta quando a conversa é resolvida. Aqui você reativa antes, se quiser.</p>
  <div id="listaPausadas"></div>
  <div id="msgPausadas" class="msg" hidden></div>
</div>
</div>

<div id="paneConversa" hidden>
<div class="card">
  <h2>Conversar com a Sofia (teste)</h2>
  <div class="aviso"><b>Teste: nada é enviado a paciente.</b> Escreva como o paciente; a Sofia responde com as regras de hoje desta unidade. Agenda e Pix são de mentira e nada vai para o Kommo, a franquia ou o WhatsApp.</div>
  <div id="chat" class="chat" aria-live="polite"></div>
  <div id="msgChat" class="msg" hidden></div>
  <textarea id="fala" rows="2" maxlength="600" aria-label="Fala do paciente" placeholder="Escreva como se fosse o paciente…"></textarea>
  <div class="linha"><button class="main" id="btnEnviar" type="button">Enviar</button><button class="sec" id="btnRecomecar" type="button">Recomeçar</button></div>
  <button class="sec" id="btnRegra" type="button" style="width:100%;margin-top:10px">Transformar isto em regra</button>
  <p class="sub" id="restaChat" style="margin:10px 0 0"></p>
</div>
</div>
</div>

<p class="foot">A regra vale na hora para as próximas conversas desta unidade. Algumas coisas não mudam por aqui e a página avisa: pronto-socorro, sinal de alerta, promessa de cura, valor e desconto, diagnóstico e remédio. A equipe da Doutor Digital é avisada de cada regra salva ou desligada. A conversa de teste fica só neste aparelho (últimas 20 trocas) e some em “Recomeçar”.</p>
</main>
<script>
(function(){
  var SLUG=${JSON.stringify(slug)}; var API='/api/public/aprendizados/'+encodeURIComponent(SLUG);
  var CW=${JSON.stringify(modo.chatwoot ?? '')}, S=null;
  var $=function(id){return document.getElementById(id)};
  var KC='pausa-codigo-'+SLUG, KN='aprendizados-nome-'+SLUG;
  try{ $('codigo').value=localStorage.getItem(KC)||''; $('por').value=localStorage.getItem(KN)||localStorage.getItem('pausa-nome-'+SLUG)||''; }catch(e){}
  var MAX=400, previaDe=null, falasPadrao=[], conv={maxMensagens:40,maxFala:600};
  var KH='aprendizados-conversa-'+SLUG, KA='aprendizados-aba-'+SLUG, historico=[], aguardando=false;
  try{ var h=JSON.parse(localStorage.getItem(KH)||'[]'); if(Array.isArray(h)) historico=h.filter(function(m){return m && (m.role==='user'||m.role==='assistant') && typeof m.content==='string'}).slice(-40); }catch(e){}
  function aviso(id,txt,ok){ var m=$(id); m.textContent=txt; m.className='msg '+(ok?'ok':'err'); m.hidden=false; }
  function some(id){ $(id).hidden=true; }
  function codigo(){ var c=$('codigo').value.trim(); try{ localStorage.setItem(KC,c); localStorage.setItem(KN,$('por').value.trim()); }catch(e){} return c; }
  function cab(){ var h={'Content-Type':'application/json'}; if(CW && S){ h['X-CW-Token']=S.token; h['X-CW-Client']=S.client; h['X-CW-Uid']=S.uid; } return h; }
  async function api(method,path,body,base){ var raiz=base!=null?base:API; var url=raiz+(path||'')+(!CW && method==='GET'?('?codigo='+encodeURIComponent(codigo())):''); var r=await fetch(url,{method:method,headers:cab(),body:method==='GET'?undefined:JSON.stringify(CW?(body||{}):Object.assign({codigo:codigo()},body||{}))}); var j=await r.json().catch(function(){return {}}); if(!r.ok){ var er=new Error(j.error||('erro '+r.status)); er.dados=j; if(CW && r.status===401){ S=null; pedirSessao(); } throw er; } return j; }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; return e; }
  function quando(iso){ var d=new Date(iso); return d.toLocaleDateString('pt-BR'); }
  function mostrar(e){
    MAX=e.maxCaracteres||400; falasPadrao=e.falasDeExemplo||[];
    ['f0','f1','f2'].forEach(function(id,i){ if(!$(id).value) $(id).value=falasPadrao[i]||''; });
    $('corpo').hidden=false; some('msgTopo'); contar();
    var l=$('lista'); l.textContent='';
    if(!e.regras.length){ l.appendChild(el('p','sub','Nenhuma regra ainda.')); }
    e.regras.forEach(function(r){
      var row=el('div','regra'+(r.enabled?'':' off')); var p=el('p'); p.appendChild(el('span','txt',r.content));
      p.appendChild(el('span','tag',(r.daUnidade?'escrita pela unidade':'da equipe Doutor Digital — só leitura')+' · '+quando(r.createdAt)+(r.enabled?'':' · desligada')));
      row.appendChild(p);
      if(r.daUnidade){ var b=el('button','sw'+(r.enabled?' on':''),r.enabled?'Ligada':'Desligada'); b.addEventListener('click',function(){ ligar(r.id,!r.enabled,b); }); row.appendChild(b); }
      l.appendChild(row);
    });
    $('btnPrevia').textContent='Ver prévia'+(e.previasRestantes!=null?(' ('+e.previasRestantes+' hoje)'):'');
    if(e.conversa){
      conv=e.conversa; restaConversa(conv.restantes); renderChat(aguardando);
      // conversa desligada (teto 0): a aba nem aparece
      $('abaConversa').hidden=(conv.maximo===0);
      if(conv.maximo===0 && !$('paneConversa').hidden) aba('ensinar');
    }
  }
  async function carregar(){ if(CW ? (!S || !SLUG) : codigo().length!==6){ $('corpo').hidden=true; return; } try{ mostrar(await api('GET')); }catch(e){ $('corpo').hidden=true; aviso(CW?'msgTitulo':'msgTopo',e.message,false); } }
  function contar(){ var n=$('regra').value.trim().length; $('cnt').textContent=n+'/'+MAX; if(previaDe!==null && $('regra').value.trim()!==previaDe){ $('cardRes').hidden=true; previaDe=null; } }
  async function ligar(id,on,b){ if($('por').value.trim().length<2){ aviso(CW?'msgTitulo':'msgTopo','Escreva o seu nome antes.',false); return; } b.disabled=true; try{ mostrar(await api('POST','/regra/'+encodeURIComponent(id),{enabled:on,por:$('por').value.trim()})); }catch(e){ aviso(CW?'msgTitulo':'msgTopo',e.message,false); b.disabled=false; } }
  $('regra').addEventListener('input',contar);
  // só consulta quando o código muda: cada tentativa gasta da trava de tentativas (a mesma da página de pausa)
  var ultimoCodigo=null;
  function tentar(){ var c=$('codigo').value.trim(); if(c.length===6 && c!==ultimoCodigo){ ultimoCodigo=c; carregar(); } }
  $('codigo').addEventListener('keyup',tentar);
  $('codigo').addEventListener('change',tentar);
  $('btnPrevia').addEventListener('click',async function(){
    var b=this, regra=$('regra').value.trim(); some('msgPrevia');
    if(regra.length<10){ aviso('msgPrevia','Escreva a regra primeiro.',false); return; }
    b.disabled=true; var txt=b.textContent; b.textContent='A Sofia está respondendo… (até 1 minuto)';
    try{
      var falas=['f0','f1','f2'].map(function(id){return $(id).value.trim()}).filter(Boolean);
      var r=await api('POST','/previa',{regra:regra,falas:falas});
      var box=$('res'); box.textContent='';
      r.resultados.forEach(function(x){ var d=el('div','res'); d.appendChild(el('div','rot','Paciente')); d.appendChild(el('div','bolha pac',x.fala)); d.appendChild(el('div','rot','Sofia hoje')); d.appendChild(el('div','bolha antes',x.antes)); d.appendChild(el('div','rot','Sofia com a regra nova')); d.appendChild(el('div','bolha depois',x.depois)); box.appendChild(d); });
      previaDe=regra; $('cardRes').hidden=false; some('msgSalvar'); $('btnSalvar').disabled=false;
      txt='Ver prévia ('+r.previasRestantes+' hoje)';
      $('cardRes').scrollIntoView({behavior:'smooth'});
    }catch(e){ aviso('msgPrevia',e.message,false); }
    finally{ b.disabled=false; b.textContent=txt; }
  });
  $('btnSalvar').addEventListener('click',async function(){
    var b=this; if($('por').value.trim().length<2){ aviso('msgSalvar','Escreva o seu nome lá em cima.',false); return; }
    if(previaDe===null || $('regra').value.trim()!==previaDe){ aviso('msgSalvar','O texto mudou: veja a prévia de novo.',false); return; }
    b.disabled=true;
    try{ mostrar(await api('POST','',{regra:previaDe,por:$('por').value.trim()})); aviso('msgSalvar','Pronto: a Sofia já segue essa regra nas próximas conversas.',true); $('regra').value=''; previaDe=null; contar(); }
    catch(e){ aviso('msgSalvar',e.message,false); b.disabled=false; }
  });
  // ── conversa de teste: o histórico fica no navegador, nunca no servidor ──
  function guardar(){ historico=historico.slice(-(conv.maxMensagens||40)); while(historico.length && historico[0].role!=='user') historico.shift(); try{ localStorage.setItem(KH,JSON.stringify(historico)); }catch(e){} }
  var restam=null;
  function restaConversa(n){ restam=n; $('restaChat').textContent=(n!=null?('Restam '+n+' respostas de teste hoje nesta unidade.'):''); $('btnEnviar').disabled=aguardando||n===0; }
  function renderChat(digitando){
    var c=$('chat'); c.textContent='';
    if(!historico.length && !digitando){ c.appendChild(el('div','bm s dig','Escreva uma fala de paciente, por exemplo: “Oi, quanto custa a consulta?”')); }
    historico.forEach(function(m){
      c.appendChild(el('div','bm '+(m.role==='user'?'p':'s'),m.content));
      (m.a||[]).forEach(function(t){ c.appendChild(el('div','chip','Teste: '+t)); });
    });
    if(digitando) c.appendChild(el('div','bm s dig','A Sofia está escrevendo…'));
    c.scrollTop=c.scrollHeight;
  }
  function aba(qual){
    var c=qual==='conversa', pz=qual==='pausadas'; $('paneEnsinar').hidden=(c||pz); $('paneConversa').hidden=!c; $('panePausadas').hidden=!pz;
    $('abaEnsinar').className='aba'+(!c&&!pz?' on':''); $('abaConversa').className='aba'+(c?' on':''); $('abaPausadas').className='aba'+(pz?' on':'');
    try{ localStorage.setItem(KA,qual); }catch(e){}
    if(c){ renderChat(aguardando); }
    if(pz){ carregarPausadas(); }
  }
  $('abaEnsinar').addEventListener('click',function(){ aba('ensinar'); });
  $('abaConversa').addEventListener('click',function(){ aba('conversa'); });
  $('abaPausadas').addEventListener('click',function(){ aba('pausadas'); });
  // ── modo Chatwoot: sessão pelo menu (postMessage), unidade pelas caixas dela, aba "IA pausada" ──
  function pedirSessao(){ if(CW){ try{ window.parent.postMessage({event:'funil:pede-sessao'},CW); }catch(e){} } }
  function quandoHora(iso){ try{ var d=new Date(iso); return isNaN(d)?'':d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }
  async function carregarPausadas(){
    var l=$('listaPausadas'); l.textContent=''; some('msgPausadas');
    try{
      var r=await api('GET','',null,'/api/public/testar-ia/pausadas');
      if(!r.conversas.length){ l.appendChild(el('p','sub','Nenhuma conversa aberta com a IA pausada.')); return; }
      r.conversas.forEach(function(c){
        var row=el('div','pz'), t=el('div'); t.appendChild(el('b',null,c.nome)); t.appendChild(el('small',null,'Pausada'+(c.por?' por '+c.por:'')+(c.em?' · '+quandoHora(c.em):'')+(c.atendente?' · com '+c.atendente:''))); row.appendChild(t);
        var ab=el('button','sw','Abrir'); ab.type='button'; ab.addEventListener('click',function(){ try{ window.parent.postMessage({event:'funil:abrir-conversa',id:c.id},CW); }catch(e){} }); row.appendChild(ab);
        var re=el('button','sw on','Reativar IA'); re.type='button'; re.addEventListener('click',async function(){ re.disabled=true; try{ await api('POST','',{conversa:c.id,acao:'reativar'},'/api/public/assistente/pausa'); row.remove(); if(!l.children.length) l.appendChild(el('p','sub','Nenhuma conversa aberta com a IA pausada.')); }catch(e){ aviso('msgPausadas',e.message,false); re.disabled=false; } }); row.appendChild(re);
        l.appendChild(row);
      });
    }catch(e){ aviso('msgPausadas',e.message,false); }
  }
  async function entrarPeloChatwoot(){
    try{
      var r=await api('GET','',null,'/api/public/testar-ia/unidades');
      if(!r.unidades.length){ aviso('msgTitulo','Você não atende nenhuma caixa com a Sofia.',false); return; }
      SLUG=r.unidades[0].slug; API='/api/public/aprendizados/'+encodeURIComponent(SLUG); $('por').value=r.eu||'atendente';
      $('titulo').textContent='Testar a IA · '+r.unidades[0].nome;
      await carregar();
      // veio do 👎 do painel da assistente: o texto já vira a nova lição (a prévia continua obrigatória antes de salvar)
      var rasc=null; try{ rasc=localStorage.getItem('testar-ia-rascunho'); localStorage.removeItem('testar-ia-rascunho'); }catch(e){}
      if(rasc){ $('regra').value=rasc; contar(); aba('ensinar'); $('regra').focus(); } else aba('conversa');
    }catch(e){ aviso('msgTitulo',e.message,false); }
  }
  if(CW){
    window.addEventListener('message',function(ev){
      if(ev.origin!==CW || ev.source!==window.parent) return;
      var d=ev.data; if(d && d.event==='funil-sessao'){ var novo=d.sessao && d.sessao.token ? d.sessao : null; var primeira=!S && novo; S=novo; if(primeira) entrarPeloChatwoot(); }
    });
    pedirSessao(); setTimeout(function(){ if(!S) pedirSessao(); },1500);
    // a tela já aberta recebe o rascunho do 👎 (o painel grava no mesmo armazenamento do agente)
    window.addEventListener('storage',function(ev){
      if(ev.key!=='testar-ia-rascunho' || !ev.newValue || !SLUG) return;
      try{ localStorage.removeItem('testar-ia-rascunho'); }catch(e){}
      $('regra').value=ev.newValue; contar(); aba('ensinar'); $('regra').focus();
    });
  }
  // o que vai ao servidor: respostas da Sofia curtas (1500 letras) e no máximo 14 mil letras no total, saindo as mais antigas
  function paraEnviar(){
    var l=historico.map(function(m){return {role:m.role,content:m.role==='assistant'?m.content.slice(0,1500):m.content}});
    var tot=0; l.forEach(function(m){tot+=m.content.length});
    while(l.length>1 && tot>14000){ tot-=l.shift().content.length; }
    return l;
  }
  async function enviar(){
    var t=$('fala').value.trim(); some('msgChat');
    if(aguardando) return;
    if(!t){ aviso('msgChat','Escreva a fala do paciente.',false); return; }
    aguardando=true; $('btnEnviar').disabled=true;
    historico.push({role:'user',content:t}); $('fala').value=''; renderChat(true);
    try{
      var r=await api('POST','/conversa',{messages:paraEnviar()});
      historico.push({role:'assistant',content:r.reply,a:r.acoes||[]}); guardar(); aguardando=false; renderChat(); restaConversa(r.restantes);
    }catch(e){
      historico.pop(); $('fala').value=t; aguardando=false; renderChat(); aviso('msgChat',e.message,false);
      // o servidor diz quantas restam também quando recusa (teto do dia, outra resposta em andamento)
      restaConversa(e.dados && e.dados.restantes!=null ? e.dados.restantes : restam);
    }
    guardar();
  }
  $('btnEnviar').addEventListener('click',enviar);
  $('fala').addEventListener('keydown',function(ev){ if((ev.ctrlKey||ev.metaKey) && ev.key==='Enter'){ ev.preventDefault(); enviar(); } });
  $('btnRecomecar').addEventListener('click',function(){ if(aguardando) return; historico=[]; guardar(); some('msgChat'); renderChat(); });
  // bônus: leva a última fala do paciente para a aba de nova regra, já como fala de teste da prévia
  $('btnRegra').addEventListener('click',function(){
    var ult=''; for(var i=historico.length-1;i>=0;i--){ if(historico[i].role==='user'){ ult=historico[i].content; break; } }
    if(!ult){ aviso('msgChat','Converse primeiro: a regra parte de uma fala do paciente.',false); return; }
    var fala=ult.replace(/[<>]/g,'').replace(/\\s+/g,' ').trim();
    var modelo='Quando o paciente disser algo como “'+fala.slice(0,120)+'”, a Sofia deve ';
    var r=$('regra'), novo=r.value.trim()?(r.value.trim()+'\\n'+modelo):modelo;
    if(novo.length>MAX){ aviso('msgChat','A regra que você já começou na outra aba está grande: salve ou apague antes de transformar isto em regra.',false); return; }
    r.value=novo;
    // a fala de teste só troca se ainda é a de exemplo (ou está vazia): o que a pessoa escreveu ali fica
    if(!$('f0').value || $('f0').value===falasPadrao[0]) $('f0').value=fala.slice(0,500);
    aba('ensinar'); contar(); r.focus(); r.setSelectionRange(r.value.length,r.value.length);
  });
  ultimoCodigo=$('codigo').value.trim()||null; carregar();
  try{ if(localStorage.getItem(KA)==='conversa'){ aba('conversa'); } }catch(e){}
})();
</script></body></html>`;
}
