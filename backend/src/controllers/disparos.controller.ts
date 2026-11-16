/**
 * Tela «Disparos» do menu do Chatwoot (16/11/2026): o «Broadcast» do CRM — filtrar a lista, escolher um modelo APROVADO do WhatsApp, ver a
 * prévia por pessoa, aprovar e acompanhar o envio em ondas. A página é `lib/disparos-pagina.ts`; o motor é o do disparo de campanha
 * (`lib/disparo/*`), com a origem «chatwoot» (`lib/disparo/chatwoot/*`): freios, parada por SAIR, franquia e a trava do modo seco são os dele.
 *
 * TODAS as rotas pedem o LOGIN do Chatwoot (cabeçalhos X-CW-*, credencial ANTES da conta, `?conta=N`) e que a pessoa atenda uma caixa da unidade
 * pedida (`atendenteDaUnidade`). Todo id de onda é conferido contra a unidade E a conta da sessão: onda de outra clínica é «não encontrada».
 *
 *   GET  /api/public/disparos?slug=                        a unidade: modo, caixas, quem aprova, freios, os disparos recentes
 *   GET  /api/public/disparos/opcoes?slug=&caixa=          etiquetas, atributos da conversa e modelos aprovados da caixa
 *   POST /api/public/disparos/contar                       { slug, filtro } → quantos e quem sai (contagem rápida, nada é gravado)
 *   POST /api/public/disparos/ondas                        { slug, nome, filtro, modelo } → monta o disparo (202; a lista é montada em segundo plano)
 *   GET  /api/public/disparos/ondas/:id?slug=              o disparo: números, exclusões, prévia por pessoa, tabela, o que falta para aprovar
 *   POST /api/public/disparos/ondas/:id/aprovar            { slug, total, impressao } — só quem pode (ver `lib/disparo/chatwoot/ajuste.ts`)
 *   POST /api/public/disparos/ondas/:id/cancelar           { slug, motivo? }
 *   GET  /api/public/disparos/relatorio?slug=              o relatório de cada campanha: enviadas, entregues, lidas, responderam (72 h), pediram para sair, falharam
 *   POST /api/public/disparos/ajuste                       { slug, gerenteAprova?, tierDoNumero? } — só administrador da Doutor Digital
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { chamar, contaChatwootDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_CLOUD } from '../lib/chatwoot-regua.js';
import { caixasDaUnidade } from '../lib/robos-estado.js';
import { freiosDoAmbiente } from '../lib/disparo/freios.js';
import { cancelarOnda, definicaoDaOnda } from '../lib/disparo/onda.js';
import { motivoSemNumero, telefoneMascarado } from '../lib/disparo/painel.js';
import { textoFinal, valoresDasVariaveis } from '../lib/disparo/regras.js';
import { caixaWhatsappOficial, conferirModeloDaOnda, modelosDaCaixa } from '../lib/disparo/chatwoot/canal.js';
import { ajusteDaUnidade, ehAdministradorDD, freiosComOTier, gravarAjuste, quemAprova, tetoDoTier, tierValido } from '../lib/disparo/chatwoot/ajuste.js';
import { ATRIBUTOS_USUAIS, filtroSchema } from '../lib/disparo/chatwoot/filtro.js';
import { abrirOndaChatwoot, aprovarOndaChatwoot, concluirMontagemChatwoot, ctxDaUnidadeNoCrm, depsDoPublico, MAXIMO_POR_DISPARO, ORIGEM_CRM, PREFIXO_CUSTO_DESCONHECIDO } from '../lib/disparo/chatwoot/onda.js';
import { orcamentoDeGasto, precoEmReaisDoBanco } from '../lib/disparo/chatwoot/gasto.js';
import { estimativaDeReserva, estimativaDoDisparo, precoDeReservaBrl, ritmoDaOnda, tetoReaisPorDia, type EstimativaDeCusto } from '../lib/disparo/chatwoot/custo.js';
import { modoDoDisparoNoCrm } from '../lib/disparo/chatwoot/porto.js';
import { taxasDoRelatorio } from '../lib/disparo/chatwoot/relatorio.js';
import { lerEnviosPorHora, lerNumerosDosDisparos, NUMEROS_VAZIOS } from '../lib/disparo/chatwoot/relatorio-banco.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { calcularPublico, rotuloDaExclusaoNoCrm } from '../lib/disparo/chatwoot/publico.js';
import { paginaDosDisparos } from '../lib/disparos-pagina.js';
import { comTeto } from '../lib/robos-automacoes.js';
import { atendenteDaUnidade } from './aprendizados.controller.js';

/**
 * TETO DE TEMPO em toda leitura do CRM (o Chatwoot lento não pode pendurar a tela nem o servidor: o incidente do #350). Cada parte tem o seu;
 * estourou, a parte vem vazia (`null`) e a tela diz que está parcial — o resto abre. A chamada abandonada ainda termina sozinha (limite de 60 s do `chamar`).
 */
let TETO_DA_PARTE_MS = 6_000;
let TETO_DA_CONFERENCIA_MS = 8_000;
/** Só para o teste: tetos curtos. */
export const _definirTetosDeTempo = (parteMs: number, conferenciaMs: number): void => {
  TETO_DA_PARTE_MS = parteMs;
  TETO_DA_CONFERENCIA_MS = conferenciaMs;
};
const PRAZO_DA_CONTAGEM_MS = 25_000;
/** `null` = ESTOUROU o teto. Erro de verdade (401 de token caído, 404, 5xx) PROPAGA: «o CRM recusou» não pode aparecer como «demorou». */
const lerComTeto = <T>(p: Promise<T>, ms = TETO_DA_PARTE_MS): Promise<T | null> => comTeto<T | null>(p, ms, null, { propagarErro: true });
/** Etiquetas e atributos são opcionais (a tela abre sem eles), MAS acesso recusado (401/403) não pode passar calado: propaga. */
const soRecusaPropaga = (e: unknown): null => {
  const s = (e as { status?: number } | null)?.status;
  if (s === 401 || s === 403) throw e;
  return null;
};
/** O que dizer de um erro de leitura do CRM: acesso recusado (token caído) é outra coisa que «não consegui ler». */
export function recusaDoErro(e: unknown, oQue: string): { status: number; erro: string } {
  const status = (e as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return { status: 502, erro: 'o CRM recusou o acesso desta unidade (token caído ou sem permissão): avise a Doutor Digital' };
  return { status: 502, erro: `não consegui ${oQue} no CRM agora` };
}
const DEMOROU = 'o CRM demorou demais para responder — tente de novo em instantes';
/** A conferência do modelo com teto: estourar é «não consegui ler» (transitório), nunca «modelo reprovado». */
const conferirComTeto: typeof conferirModeloDaOnda = (ctx, caixa, def) => comTeto(conferirModeloDaOnda(ctx, caixa, def), TETO_DA_CONFERENCIA_MS, { ok: false as const, transitorio: true as const, motivo: DEMOROU });

const slugDe = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const idDe = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : '');

/** A página (iframe do menu do Chatwoot). */
export function paginaDisparosHandler(_req: Request, res: Response): void {
  const conta = contaChatwootDoAmbiente();
  if (!conta) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">CRM não configurado.</p>');
    return;
  }
  res.type('html').set('Cache-Control', 'no-store').send(paginaDosDisparos(new URL(conta.url).origin));
}

type Resolvida = { unit: Unit; conta: number; ctx: ContextoChatwoot; email: string | null; papel: string | null; nome: string };

/** A pessoa atende a unidade E a unidade tem conta própria válida no CRM. Escreve a recusa e devolve null se não. */
async function resolver(req: Request, res: Response, slug: string): Promise<Resolvida | null> {
  const r = await atendenteDaUnidade(req, res, slug);
  if (!r) return null;
  // a conta e o contexto da unidade são resolvidos UMA vez por pedido: os handlers usam este `ctx`, não outro
  const ctx = ctxDaUnidadeNoCrm(r.unit.slug);
  if (!ctx?.conta) {
    res.status(422).json({ error: 'esta unidade não tem conta válida no CRM' });
    return null;
  }
  return { unit: r.unit, conta: ctx.conta.conta, ctx, email: r.a.email ?? null, papel: r.a.papel ?? null, nome: r.a.nome || 'atendente' };
}


function contagemPorEstado(linhas: Array<{ ondaId: string; estado: string; _count: number }>): Map<string, Record<string, number>> {
  const m = new Map<string, Record<string, number>>();
  for (const l of linhas) m.set(l.ondaId, { ...(m.get(l.ondaId) ?? {}), [l.estado]: l._count });
  return m;
}

function resumoDosFreios(unit: Unit, tier: string | null) {
  const f = freiosComOTier(freiosDoAmbiente(), tier);
  return {
    janela: `${f.janelaInicio}h às ${f.janelaFim}h${f.soDiasUteis ? ', segunda a sexta, sem feriado nacional' : ''}`,
    tetoPorHora: f.tetoPorHora,
    tetoPorDia: f.tetoPorDia,
    maxSair: f.maxSair,
    falhasSeguidas: f.falhasSeguidas,
    tier,
    tetoDoTier: tetoDoTier(tier),
    comAgenda: !!unit.spineToken,
    tetoReaisDia: tetoReaisPorDia(),
    diasUteis: f.soDiasUteis,
  };
}

/** O custo estimado do disparo e o ritmo (quantas saem por dia, em quantos dias acaba) — o que a tela mostra ANTES de aprovar. Nunca lança: falha vira estimativa com o preço de reserva. */
async function custoERitmo(unit: Unit, onda: { categoriaModelo: string | null; total: number }, tier: string | null) {
  const custo: EstimativaDeCusto = await comTeto(estimativaDoDisparo(unit.id, onda.categoriaModelo, onda.total), TETO_DA_PARTE_MS, null).then((c) => c ?? estimativaDeReserva(onda.categoriaModelo, onda.total));
  const tetoReais = tetoReaisPorDia();
  // O preço do teto é o do NÚMERO (o maior entre as unidades que o dividem), o mesmo que a rodada usa; sem leitura, a reserva da categoria. O ritmo e o orçamento usam ele.
  const precoDoTeto = (await comTeto(precoEmReaisDoBanco(unit.id, onda.categoriaModelo).catch(() => null), TETO_DA_PARTE_MS, null)) ?? precoDeReservaBrl(onda.categoriaModelo);
  const ritmo = ritmoDaOnda({ pessoas: onda.total, freios: freiosComOTier(freiosDoAmbiente(), tier), tetoReais, porMensagemBrl: Math.max(precoDoTeto, custo.porMensagemBrl ?? 0) });
  // O que já foi gasto nas últimas 24 h NESTE NÚMERO (todas as ondas, por categoria) e quantas ainda cabem: a MESMA conta que a rodada usa para parar (`orcamentoDeGasto`).
  const orcamento = await comTeto(
    orcamentoDeGasto({ unitId: unit.id, agora: new Date(), tetoReais, precoAtual: precoDoTeto, preco: precoEmReaisDoBanco }).catch(() => null),
    TETO_DA_PARTE_MS,
    null,
  );
  return { custo, ritmo: { ...ritmo, dias: Number.isFinite(ritmo.dias) ? ritmo.dias : null }, orcamento };
}

// ── a unidade ───────────────────────────────────────────────────────────────────────────────────────────────────

export async function disparosHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    const ctx = r.ctx;
    const ajuste = await ajusteDaUnidade(r.unit.id);
    const caixas = await Promise.all(
      caixasDaUnidade(r.unit.slug)
        .filter((c) => CAIXAS_CLOUD.has(c))
        .map(async (id) => {
          try {
            const c = await lerComTeto(caixaWhatsappOficial(ctx, id));
            if (!c) return { id, nome: `caixa ${id}`, oficial: false, motivo: DEMOROU };
            return c.ok ? { id, nome: c.nome, oficial: true, motivo: null } : { id, nome: `caixa ${id}`, oficial: false, motivo: c.motivo };
          } catch (e) {
            return { id, nome: `caixa ${id}`, oficial: false, motivo: recusaDoErro(e, 'ler a caixa').erro };
          }
        }),
    );
    const ondas = await prisma.disparoOnda.findMany({
      where: { unitId: r.unit.id, origem: ORIGEM_CRM, contaChatwoot: r.conta },
      orderBy: { criadoEm: 'desc' },
      take: 30,
      select: { id: true, estado: true, total: true, etiqueta: true, criadoEm: true, pausaMotivo: true, template: true, campanha: { select: { nome: true } } },
    });
    const porEstado = ondas.length ? await prisma.disparoDestinatario.groupBy({ by: ['ondaId', 'estado'], where: { ondaId: { in: ondas.map((o) => o.id) } }, _count: true, orderBy: { ondaId: 'asc' } }) : [];
    const contagens = contagemPorEstado(porEstado as Array<{ ondaId: string; estado: string; _count: number }>);
    const quem = quemAprova({ email: r.email, papel: r.papel }, ajuste);
    res.set('Cache-Control', 'no-store').json({
      unidade: { slug: r.unit.slug, nome: r.unit.name },
      modo: modoDoDisparoNoCrm(r.unit.slug),
      papel: r.papel,
      podeAprovar: quem.ok,
      podeAjustar: ehAdministradorDD(r.email),
      ajuste,
      freios: resumoDosFreios(r.unit, ajuste.tierDoNumero),
      caixas,
      disparos: ondas.map((o) => ({
        id: o.id,
        nome: o.campanha.nome,
        estado: o.estado,
        total: o.total,
        filtro: o.etiqueta,
        modelo: o.template,
        criadoEm: o.criadoEm,
        motivo: o.pausaMotivo ? motivoSemNumero(o.pausaMotivo) : null,
        enviados: contagens.get(o.id)?.enviado ?? 0,
      })),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'disparos: a unidade falhou');
    res.status(502).json({ error: 'não consegui ler os disparos agora' });
  }
}

// ── opções do filtro e modelos ──────────────────────────────────────────────────────────────────────────────────

export async function disparosOpcoesHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  const caixa = Number(req.query.caixa);
  if (!Number.isInteger(caixa) || caixa <= 0 || !caixasDaUnidade(r.unit.slug).includes(caixa) || !CAIXAS_CLOUD.has(caixa)) {
    res.status(404).json({ error: 'caixa não encontrada nesta unidade' });
    return;
  }
  const ctx = r.ctx;
  try {
    const oficial = await lerComTeto(caixaWhatsappOficial(ctx, caixa));
    if (!oficial) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    if (!oficial.ok) {
      res.status(422).json({ error: oficial.motivo });
      return;
    }
    const [etiquetas, defs, modelos] = await Promise.all([
      lerComTeto(chamar(ctx, 'GET', 'labels').catch(soRecusaPropaga)),
      lerComTeto(chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: '0' } }).catch(soRecusaPropaga)),
      lerComTeto(modelosDaCaixa(ctx, caixa)),
    ]);
    if (!modelos) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    const titulos = Array.isArray((etiquetas as { payload?: unknown[] } | null)?.payload) ? ((etiquetas as { payload: Array<{ title?: unknown }> }).payload.map((l) => String(l?.title ?? '')).filter(Boolean)) : [];
    const lista = Array.isArray(defs) ? (defs as Array<{ attribute_key?: unknown; attribute_display_name?: unknown; attribute_values?: unknown }>) : [];
    const atributos = new Map<string, { chave: string; nome: string; valores: string[] | null }>();
    for (const d of lista) {
      const chave = String(d?.attribute_key ?? '');
      if (!/^[a-z][a-z0-9_]{0,59}$/.test(chave)) continue;
      const valores = Array.isArray(d.attribute_values) ? d.attribute_values.map(String).filter(Boolean).slice(0, 60) : null;
      atributos.set(chave, { chave, nome: String(d?.attribute_display_name ?? chave).slice(0, 60), valores: valores && valores.length ? valores : null });
    }
    for (const chave of ATRIBUTOS_USUAIS) if (!atributos.has(chave)) atributos.set(chave, { chave, nome: chave, valores: null });
    res.set('Cache-Control', 'no-store').json({ etiquetas: titulos.sort((a, b) => a.localeCompare(b)).slice(0, 200), atributos: [...atributos.values()].slice(0, 60), modelos });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'disparos: opções falharam');
    {
      const m = recusaDoErro(e, 'ler as etiquetas e os modelos');
      res.status(m.status).json({ error: m.erro });
    }
  }
}

// ── contar (rápido, só leitura) ─────────────────────────────────────────────────────────────────────────────────

const emContagem = new Set<string>();
/** Contagens ao mesmo tempo, SOMANDO as unidades: cada uma lê a caixa inteira do Chatwoot (a parte por unidade não protege o servidor de muitas unidades). */
export const MAX_CONTAGENS_SIMULTANEAS = 3;
/** Reserva uma vaga de contagem: uma por unidade e `MAX_CONTAGENS_SIMULTANEAS` no total. */
export function reservarContagem(unitId: string): 'ok' | 'unidade' | 'global' {
  if (emContagem.has(unitId)) return 'unidade';
  if (emContagem.size >= MAX_CONTAGENS_SIMULTANEAS) return 'global';
  emContagem.add(unitId);
  return 'ok';
}
export const liberarContagem = (unitId: string): void => void emContagem.delete(unitId);
const AMOSTRA = 8;

export async function disparosContarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; filtro?: unknown };
  const r = await resolver(req, res, slugDe(corpo.slug));
  if (!r) return;
  const filtro = filtroSchema.safeParse(corpo.filtro);
  if (!filtro.success || !caixasDaUnidade(r.unit.slug).includes(filtro.data.caixa) || !CAIXAS_CLOUD.has(filtro.data.caixa)) {
    res.status(400).json({ error: 'filtro inválido (confira a caixa, as etiquetas e os atributos)' });
    return;
  }
  const ctx = r.ctx;
  // a contagem lê a caixa inteira: uma por unidade e poucas no total
  const vaga = reservarContagem(r.unit.id);
  if (vaga !== 'ok') {
    res.status(429).json({ error: vaga === 'unidade' ? 'já estou contando para esta unidade — espere alguns segundos' : 'há contagens demais acontecendo agora — tente de novo em instantes' });
    return;
  }
  try {
    const oficial = await lerComTeto(caixaWhatsappOficial(ctx, filtro.data.caixa));
    if (!oficial) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    if (!oficial.ok) {
      res.status(422).json({ error: oficial.motivo });
      return;
    }
    const p = await calcularPublico(filtro.data, depsDoPublico(r.unit, ctx), { completo: false, prazo: Date.now() + PRAZO_DA_CONTAGEM_MS });
    res.set('Cache-Control', 'no-store').json({
      lidas: p.lidas,
      truncada: p.truncada,
      noFiltro: p.noFiltro,
      total: p.elegiveis.length,
      parcial: p.parcial,
      fora: Object.entries(p.fora).filter(([, n]) => n).map(([motivo, n]) => ({ motivo, rotulo: rotuloDaExclusaoNoCrm(motivo), n })),
      amostra: p.elegiveis.slice(0, AMOSTRA).map((e) => ({ nome: e.nome, telefone: telefoneMascarado(e.telefone) })),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'disparos: contagem falhou');
    {
      const m = recusaDoErro(e, 'ler as conversas');
      res.status(m.status).json({ error: m.erro });
    }
  } finally {
    liberarContagem(r.unit.id);
  }
}

// ── montar o disparo ────────────────────────────────────────────────────────────────────────────────────────────

const modeloSchema = z.object({
  nome: z.string().min(1).max(512),
  idioma: z.string().min(2).max(12),
  /** "primeiroNome" | "unidade" | "texto:<literal>", um para cada {{n}} */
  variaveis: z.array(z.string().min(1).max(200)).max(10),
});

export async function disparosMontarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; nome?: unknown; filtro?: unknown; modelo?: unknown; maximo?: unknown };
  const r = await resolver(req, res, slugDe(corpo.slug));
  if (!r) return;
  const filtro = filtroSchema.safeParse(corpo.filtro);
  const modelo = modeloSchema.safeParse(corpo.modelo);
  // o MÁXIMO de pessoas é obrigatório (a tela vem com 50): sem ele não monta
  const maximo = z.number().int().min(1).max(MAXIMO_POR_DISPARO).safeParse(corpo.maximo);
  if (!maximo.success) {
    res.status(400).json({ error: `diga o máximo de pessoas deste disparo (de 1 a ${MAXIMO_POR_DISPARO})` });
    return;
  }
  const nome = typeof corpo.nome === 'string' ? corpo.nome : '';
  if (!filtro.success || !modelo.success) {
    res.status(400).json({ error: 'pedido inválido (confira o filtro e o modelo)' });
    return;
  }
  if (modoDoDisparoNoCrm(r.unit.slug) === 'desligado') {
    res.status(422).json({ error: 'os disparos estão DESLIGADOS nesta unidade' });
    return;
  }
  const ctx = r.ctx;
  try {
    // o texto do modelo vem do CRM agora, nunca do navegador
    const doCrm = await lerComTeto(modelosDaCaixa(ctx, filtro.data.caixa), TETO_DA_CONFERENCIA_MS);
    if (!doCrm) {
      res.status(504).json({ error: DEMOROU });
      return;
    }
    const naCaixa = doCrm.find((m) => m.nome === modelo.data.nome && m.idioma === modelo.data.idioma);
    if (!naCaixa) {
      res.status(422).json({ error: 'esse modelo não está aprovado nesta caixa' });
      return;
    }
    if (naCaixa.problema) {
      res.status(422).json({ error: naCaixa.problema });
      return;
    }
    const aberta = await abrirOndaChatwoot({
      unit: r.unit,
      conta: r.conta,
      filtro: filtro.data,
      modelo: { nome: naCaixa.nome, idioma: naCaixa.idioma, texto: naCaixa.texto, variaveis: modelo.data.variaveis, categoria: naCaixa.categoria },
      maximo: maximo.data,
      nome,
      por: r.email ?? r.nome,
      ctx,
      conferirModelo: conferirComTeto,
    });
    if (!aberta.ok) {
      res.status(aberta.status).json({ error: aberta.erro });
      return;
    }
    // Montar leva minutos (uma leitura de mensagens e a franquia por pessoa): responde já; a tela mostra «montando…» até acabar.
    void concluirMontagemChatwoot(aberta.dados.id).catch((err) => logger.error({ err: String(err), onda: aberta.dados.id }, 'disparo-crm: montagem estourou'));
    logger.warn({ unit: r.unit.slug, onda: aberta.dados.id, por: r.email }, 'disparo-crm: disparo montado pela tela');
    res.status(202).json({ ok: true, id: aberta.dados.id });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'disparos: montar falhou');
    {
      const m = recusaDoErro(e, 'ler os modelos');
      res.status(m.status).json({ error: m.erro });
    }
  }
}

// ── um disparo ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A onda DESTA unidade e DESTA conta, ou null (e a recusa já escrita): onda de outra clínica é «não encontrada», igual a uma que não existe. */
async function ondaDaUnidade(res: Response, r: Resolvida, id: string) {
  const onda = id
    ? await prisma.disparoOnda.findFirst({ where: { id, unitId: r.unit.id, origem: ORIGEM_CRM, contaChatwoot: r.conta }, include: { campanha: { select: { nome: true } } } })
    : null;
  if (!onda) {
    res.status(404).json({ error: 'disparo não encontrado' });
    return null;
  }
  return onda;
}

const LINHAS_DA_TABELA = 150;

export async function disparosOndaHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  const onda = await ondaDaUnidade(res, r, idDe(req.params.id));
  if (!onda) return;
  try {
    const ajuste = await ajusteDaUnidade(r.unit.id);
    const [linhas, grupos, numerosPorOnda, porHora] = await Promise.all([
      prisma.disparoDestinatario.findMany({
        where: { ondaId: onda.id },
        orderBy: [{ atualizadoEm: 'asc' }, { id: 'asc' }],
        take: LINHAS_DA_TABELA,
        select: { nome: true, telefone: true, estado: true, motivo: true, enviadoEm: true, simuladoEm: true },
      }),
      prisma.disparoDestinatario.groupBy({ by: ['estado'], where: { ondaId: onda.id }, _count: true }),
      // os números vêm AGRUPADOS no banco (nada de ler linhas só para somar; e «receberia» não trava nas 150 da tabela)
      lerNumerosDosDisparos([onda.id]),
      lerEnviosPorHora(onda.id, fusoDaUnidade(r.unit)),
    ]);
    const def = definicaoDaOnda(onda);
    const fontes = def.variaveis;
    const exemplos = linhas.slice(0, 3).map((p) => textoFinal(def.textoModelo, valoresDasVariaveis(fontes, { primeiroNome: p.nome, unidade: r.unit.name })));
    const resumo = (onda.resumo ?? {}) as { candidatos?: number; lidas?: number; truncada?: boolean; fora?: Record<string, number> };
    // o CRM confirma o modelo só enquanto dá para aprovar (uma leitura por abertura da tela, nunca em disparo que já saiu)
    let conferencia: { ok: boolean; motivo?: string } | null = null;
    if (onda.estado === 'montada') {
      conferencia = onda.caixaChatwoot != null ? await conferirComTeto(r.ctx, onda.caixaChatwoot, { template: onda.template, idioma: onda.idioma, textoModelo: onda.textoModelo, variaveis: fontes, categoria: onda.categoriaModelo }) : { ok: false, motivo: 'o disparo não tem caixa gravada' };
    }
    const quem = quemAprova({ email: r.email, papel: r.papel }, ajuste);
    const numeros = numerosPorOnda.get(onda.id) ?? NUMEROS_VAZIOS;
    const { custo, ritmo, orcamento } = await custoERitmo(r.unit, onda, ajuste.tierDoNumero);
    res.set('Cache-Control', 'no-store').json({
      id: onda.id,
      maximo: onda.maximoPessoas,
      custo,
      ritmo,
      // o gasto até agora: enviadas × preço por mensagem. Sem histórico da Meta o preço é o de RESERVA (alto de propósito): então é um teto do gasto, não o gasto — `gastoComReserva` diz isso à tela
      gastoEstimadoBrl: custo.porMensagemBrl !== null ? Math.ceil(custo.porMensagemBrl * numeros.enviadas * 100 - 1e-9) / 100 : null,
      gastoComReserva: custo.reserva,
      // o teto de gasto é POR NÚMERO: o que o número já gastou nas últimas 24 h (todas as ondas) e quantas mensagens ainda cabem
      gastoDoNumero24hBrl: orcamento ? Math.ceil(orcamento.gastoBrl * 100 - 1e-9) / 100 : null,
      cabemPeloGasto: orcamento ? orcamento.cabem : null,
      relatorio: { numeros, taxas: taxasDoRelatorio(numeros), porHora, fuso: fusoDaUnidade(r.unit) },
      nome: onda.campanha.nome,
      estado: onda.estado,
      modo: modoDoDisparoNoCrm(r.unit.slug),
      total: onda.total,
      impressao: onda.impressao,
      filtro: onda.etiqueta,
      modelo: { nome: onda.template, idioma: onda.idioma, texto: onda.textoModelo, variaveis: fontes },
      exemplos,
      pausaMotivo: onda.pausaMotivo ? motivoSemNumero(onda.pausaMotivo) : null,
      pausaCausa: onda.pausaCausa,
      aprovadaPor: onda.aprovadaPor,
      aprovadaEm: onda.aprovadaEm,
      aprovadaModo: onda.aprovadaModo,
      criadoEm: onda.criadoEm,
      candidatos: resumo.candidatos ?? null,
      lidas: resumo.lidas ?? null,
      truncada: resumo.truncada === true,
      fora: Object.entries(resumo.fora ?? {}).filter(([, n]) => n).map(([motivo, n]) => ({ motivo, rotulo: rotuloDaExclusaoNoCrm(motivo), n })),
      contagem: Object.fromEntries(grupos.map((g) => [g.estado, g._count])),
      simulados: numeros.receberiam,
      destinatarios: linhas.map((p) => ({
        nome: p.nome,
        telefone: telefoneMascarado(p.telefone),
        estado: p.estado,
        motivo: p.motivo ? motivoSemNumero(p.motivo) : null,
        enviadoEm: p.enviadoEm,
        simuladoEm: p.simuladoEm,
      })),
      destinatariosMostrados: linhas.length,
      conferencia,
      podeAprovar: quem.ok,
      motivoSemAprovar: quem.ok ? null : quem.motivo,
      freios: resumoDosFreios(r.unit, ajuste.tierDoNumero),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug, onda: onda.id }, 'disparos: ler o disparo falhou');
    res.status(502).json({ error: 'não consegui ler este disparo agora' });
  }
}

export async function disparosAprovarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; total?: unknown; impressao?: unknown; maximo?: unknown; confirmarCustoDesconhecido?: unknown };
  const r = await resolver(req, res, slugDe(corpo.slug));
  if (!r) return;
  const onda = await ondaDaUnidade(res, r, idDe(req.params.id));
  if (!onda) return;
  const a = await aprovarOndaChatwoot(onda.id, { email: r.email, papel: r.papel, total: corpo.total, impressao: corpo.impressao, maximo: corpo.maximo, confirmarCustoDesconhecido: corpo.confirmarCustoDesconhecido }, { conferir: conferirComTeto });
  if (!a.ok) {
    res.status(a.status).json({ error: a.erro, ...(a.erro.startsWith(PREFIXO_CUSTO_DESCONHECIDO) ? { precisaConfirmarCusto: true } : {}) });
    return;
  }
  res.json({ ok: true, estado: a.dados.estado, aprovadaPor: a.dados.aprovadaPor, modo: modoDoDisparoNoCrm(r.unit.slug) });
}

export async function disparosCancelarHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; motivo?: unknown };
  const r = await resolver(req, res, slugDe(corpo.slug));
  if (!r) return;
  const onda = await ondaDaUnidade(res, r, idDe(req.params.id));
  if (!onda) return;
  // parar é sempre seguro, mas não é de qualquer atendente: quem aprova, a administradora da clínica ou quem montou
  const ajuste = await ajusteDaUnidade(r.unit.id);
  const pode = quemAprova({ email: r.email, papel: r.papel }, ajuste).ok || r.papel === 'administrator' || (!!r.email && onda.criadaPor === r.email);
  if (!pode) {
    res.status(403).json({ error: 'só quem aprova, a administradora da clínica ou quem montou o disparo pode cancelá-lo' });
    return;
  }
  const motivo = typeof corpo.motivo === 'string' && corpo.motivo.trim() ? corpo.motivo.trim().slice(0, 200) : 'cancelado pela tela Disparos';
  const c = await cancelarOnda(onda.id, `${motivo} (${r.email ?? r.nome})`);
  if (!c.ok) {
    res.status(c.status).json({ error: c.erro });
    return;
  }
  res.json({ ok: true, estado: c.dados.estado });
}

// ── relatório por campanha ──────────────────────────────────────────────────────────────────────────────────────

export async function disparosRelatorioHandler(req: Request, res: Response): Promise<void> {
  const r = await resolver(req, res, slugDe(req.query.slug));
  if (!r) return;
  try {
    const ondas = await prisma.disparoOnda.findMany({
      where: { unitId: r.unit.id, origem: ORIGEM_CRM, contaChatwoot: r.conta },
      orderBy: { criadoEm: 'desc' },
      take: 30,
      select: { id: true, estado: true, total: true, template: true, categoriaModelo: true, criadoEm: true, aprovadaEm: true, campanha: { select: { nome: true } } },
    });
    const numerosPorOnda = await lerNumerosDosDisparos(ondas.map((o) => o.id)); // agrupado no banco: não lê linha nenhuma
    // o preço por mensagem de cada categoria (uma leitura por categoria): gasto estimado = enviadas × preço. Sem histórico da Meta o preço é o de RESERVA (alto de propósito):
    // `gastoComReserva` rotula o valor como teto do gasto, não como o gasto
    const categorias = [...new Set(ondas.map((o) => o.categoriaModelo).filter((c): c is string => !!c))];
    const precos = await Promise.all(categorias.map((cat) => comTeto(estimativaDoDisparo(r.unit.id, cat, 1), TETO_DA_PARTE_MS, null)));
    const precoPorCategoria = new Map<string, { preco: number | null; reserva: boolean }>(categorias.map((cat, i) => [cat, { preco: precos[i]?.porMensagemBrl ?? null, reserva: precos[i]?.reserva ?? false }]));
    res.set('Cache-Control', 'no-store').json({
      modo: modoDoDisparoNoCrm(r.unit.slug),
      campanhas: ondas.map((o) => {
        const numeros = numerosPorOnda.get(o.id) ?? NUMEROS_VAZIOS;
        const { preco, reserva } = (o.categoriaModelo ? precoPorCategoria.get(o.categoriaModelo) : null) ?? { preco: null, reserva: false };
        return { id: o.id, nome: o.campanha.nome, estado: o.estado, modelo: o.template, categoria: o.categoriaModelo, criadoEm: o.criadoEm, aprovadaEm: o.aprovadaEm, numeros, taxas: taxasDoRelatorio(numeros), gastoEstimadoBrl: preco !== null ? Math.ceil(preco * numeros.enviadas * 100 - 1e-9) / 100 : null, gastoComReserva: reserva };
      }),
    });
  } catch (e) {
    logger.warn({ err: String(e), unit: r.unit.slug }, 'disparos: relatório falhou');
    res.status(502).json({ error: 'não consegui montar o relatório agora' });
  }
}

// ── ajuste da unidade ───────────────────────────────────────────────────────────────────────────────────────────

export async function disparosAjusteHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as { slug?: unknown; gerenteAprova?: unknown; tierDoNumero?: unknown };
  const r = await resolver(req, res, slugDe(corpo.slug));
  if (!r) return;
  if (!ehAdministradorDD(r.email)) {
    res.status(403).json({ error: 'só a administração da Doutor Digital muda este ajuste' });
    return;
  }
  const dados: { gerenteAprova?: boolean; tierDoNumero?: string | null } = {};
  if (corpo.gerenteAprova !== undefined) {
    if (typeof corpo.gerenteAprova !== 'boolean') {
      res.status(400).json({ error: 'gerenteAprova precisa ser verdadeiro ou falso' });
      return;
    }
    dados.gerenteAprova = corpo.gerenteAprova;
  }
  if (corpo.tierDoNumero !== undefined) {
    if (corpo.tierDoNumero !== null && !tierValido(corpo.tierDoNumero)) {
      res.status(400).json({ error: 'o TIER é como a Meta escreve: TIER_250, TIER_1K, TIER_10K…' });
      return;
    }
    dados.tierDoNumero = corpo.tierDoNumero === null ? null : (corpo.tierDoNumero as string).trim().toUpperCase();
  }
  if (!Object.keys(dados).length) {
    res.status(400).json({ error: 'nada para mudar' });
    return;
  }
  const novo = await gravarAjuste(r.unit.id, dados, r.email ?? r.nome);
  logger.warn({ unit: r.unit.slug, por: r.email, dados }, 'disparo-crm: ajuste da unidade alterado pela tela');
  res.json({ ok: true, ajuste: novo });
}

