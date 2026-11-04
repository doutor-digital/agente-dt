/**
 * Página `/ia/:slug` — a recepção vê, no celular, se a Sofia e as colunas do Kommo estão certas.
 * Pedido de Timbó (04/11/2026): "a IA está fazendo os processos certos? colocando nas colunas certas? aqui não
 * sabemos ver isso". Mesmo desenho da `/pausa/:slug`: HTML servido pelo backend + `GET /api/public/ia/:slug` com o
 * código de 6 dígitos da unidade. SÓ LEITURA: nada aqui escreve no Kommo nem no banco.
 *
 * De onde vem cada número:
 *   - HOJE (banco do agente, fuso da unidade): conversas respondidas = cartões com passo "Resposta entregue ao
 *     paciente" / "Resposta enviada em áudio"; passadas para a equipe = cartões com passo "IA pausada no lead"
 *     (o handoff); pausadas pela equipe = `pausas_da_equipe` abertas.
 *   - COLUNAS, MUDANÇAS e CONFERIR (Kommo): cartões abertos (até 12 páginas de 250), mudanças de coluna do dia
 *     (`/events`, até 3 páginas de 100) e funis/usuários (cache de 10 min compartilhado com a Ponte).
 *   Os números de HOJE (banco) têm cache de 60 s por unidade: várias recepções abrindo juntas não repetem a consulta.
 *
 * Custo no Kommo — o limitador é UM só para o processo e a Sofia divide com esta página:
 *   - o Kommo é lido no máximo 1× a cada 5 min por conta (falha: 60 s sem perguntar de novo; e a última leitura boa
 *     continua na tela, marcada como antiga);
 *   - uma montagem de cada vez em todo o processo (`criarFilaDeUm`) e sempre uma chamada após a outra, nunca em
 *     paralelo: a Sofia espera, no pior caso, UMA chamada desta página;
 *   - cliente `createKommoClientSemFreio`: 403/429 desta página não aciona o freio global (30 s para a rede toda);
 *     ao primeiro 403/429 a montagem para de chamar;
 *   - teto de páginas e prazo de 60 s para a montagem inteira (que roda por trás: quem pede espera no máximo 12 s e a página pergunta de novo).
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { dataLocalISO } from '../lib/feriados.js';
import { createKommoClientSemFreio, KommoApiError } from '../services/kommo.service.js';
import { dadosDaConta } from './ponte.controller.js';
import { funilComercial } from '../lib/ponte-cartao.js';
import { contaDaUnidade } from '../lib/ponte-cache.js';
import { codigoConfere, criarLimiteDeTentativas } from '../lib/codigo-publico.js';
import {
  CacheQueAguentaFalha,
  PRAZOS_DA_PAGINA_IA,
  candidatosCartaoVazio,
  cartaoDaPagina,
  conferir,
  contarPorColuna,
  criarFilaDeUm,
  etapasAbertas,
  inicioDoDiaEpoch,
  resumirMudancas,
  type CartaoDaPagina,
  type ColunasDoFunil,
  type MovimentoDaIa,
  type MudancaLida,
  type ResumoDasMudancas,
} from '../lib/ia-unidade.js';

const limite = criarLimiteDeTentativas();
/** Os números de hoje (banco), 60 s por unidade e dia: a recepção abre, atualiza e a página repete sozinha. */
const cacheHoje = new CacheQueAguentaFalha<HojeDaIa>(60_000, 10_000);
const emFila = criarFilaDeUm();

// ── HOJE: o banco do agente ──────────────────────────────────────────────────────────────────────────────

export interface HojeDaIa {
  /** conversas (cartões) em que a Sofia entregou resposta hoje */
  respondidas: number;
  /** conversas que a Sofia passou para a equipe hoje (handoff) */
  passadasParaEquipe: number;
  /** cartões em que a Sofia está pausada AGORA porque a equipe falou com o paciente */
  pausadasAgora: number;
  /** quantas pausas desse tipo começaram hoje */
  pausadasHoje: number;
}

async function montarHoje(unit: Pick<Unit, 'id'>, inicio: Date): Promise<HojeDaIa> {
  const [linhas, pausadasAgora, pausadasHoje] = await Promise.all([
    prisma.$queryRaw<Array<{ respondidas: bigint; passadas: bigint }>>`
      select
        count(distinct t.lead_id) filter (where (s.title like 'Resposta entregue ao paciente via%' and strpos(s.title, 'lead_note') = 0) or s.title like '🔊 Resposta enviada em áudio%') as respondidas,
        count(distinct t.lead_id) filter (where s.title like 'IA pausada no lead%') as passadas
      from execution_steps s
      join execution_traces t on t.id = s.trace_id
      where t.unit_id = ${unit.id}
        and s.created_at >= ${inicio}
        and (s.title like 'Resposta entregue ao paciente via%' or s.title like '🔊 Resposta enviada em áudio%' or s.title like 'IA pausada no lead%')`,
    prisma.pausaDaEquipe.count({ where: { unitId: unit.id, encerradaEm: null } }),
    prisma.pausaDaEquipe.count({ where: { unitId: unit.id, pausadoEm: { gte: inicio } } }),
  ]);
  return {
    respondidas: Number(linhas[0]?.respondidas ?? 0),
    passadasParaEquipe: Number(linhas[0]?.passadas ?? 0),
    pausadasAgora,
    pausadasHoje,
  };
}

// ── KOMMO: colunas, mudanças do dia e conferir ───────────────────────────────────────────────────────────

export interface KommoDaPagina {
  colunas: ColunasDoFunil[] | null;
  /** cartões abertos lidos */
  cartoesLidos: number;
  /** passou do teto de páginas: a contagem é dos cartões mais novos */
  cartoesParcial: boolean;
  mudancas: (Omit<ResumoDasMudancas, 'lista'> & { lista: Array<ResumoDasMudancas['lista'][number] & { link: string }>; parcial: boolean }) | null;
  conferir: {
    total: number;
    grupos: Array<{ regra: string; titulo: string; total: number; itens: Array<{ leadId: number; nome: string; oQueFazer: string; link: string }> }>;
  } | null;
  /** o que não pôde ser lido (cada item vira um aviso na tela) */
  avisos: string[];
  /** algum bloco falhou agora (não por teto): a leitura vale pouco tempo e a próxima tenta de novo cedo */
  incompleto: boolean;
}

const cacheKommo = new CacheQueAguentaFalha<KommoDaPagina>(PRAZOS_DA_PAGINA_IA.cacheKommoMs, PRAZOS_DA_PAGINA_IA.cacheFalhaMs);

const linkDoCartao = (unit: Pick<Unit, 'kommoSubdomain'>, id: number) => `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${id}`;

/** Passos "Lead movido para etapa" (e o handoff automático) que a Sofia gravou hoje nestes cartões. */
async function movimentosDaSofia(unit: Pick<Unit, 'id' | 'kommoSubdomain'>, leadIds: number[], desdeEpoch: number): Promise<MovimentoDaIa[]> {
  if (!leadIds.length) return [];
  const irmas = unit.kommoSubdomain
    ? (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id)
    : [];
  const passos = await prisma.executionStep.findMany({
    where: {
      kind: 'KOMMO_ACTION',
      createdAt: { gte: new Date((desdeEpoch - 600) * 1000) },
      OR: [{ title: { startsWith: 'Lead movido para etapa' } }, { title: { startsWith: 'Handoff automático' } }],
      trace: { unitId: { in: [...new Set([unit.id, ...irmas])] }, leadId: { in: [...new Set(leadIds)].map(String) } },
    },
    select: { createdAt: true, payload: true, trace: { select: { leadId: true } } },
  });
  const out: MovimentoDaIa[] = [];
  for (const p of passos) {
    const statusId = Number((p.payload as { statusId?: unknown } | null)?.statusId);
    const leadId = Number(p.trace.leadId);
    if (Number.isInteger(statusId) && Number.isInteger(leadId)) out.push({ leadId, statusId, em: Math.floor(p.createdAt.getTime() / 1000) });
  }
  return out;
}

/** Cartões "vazios" em que a Sofia conversou nos últimos dias: têm mensagem, então não são vazios. */
async function comConversaRecente(unit: Pick<Unit, 'id' | 'kommoSubdomain'>, leadIds: number[], agora: Date): Promise<Set<number>> {
  if (!leadIds.length) return new Set();
  const irmas = unit.kommoSubdomain
    ? (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id)
    : [];
  const desde = new Date(agora.getTime() - PRAZOS_DA_PAGINA_IA.cartaoVazioDias * 86_400_000);
  const convs = await prisma.conversation.findMany({
    where: { unitId: { in: [...new Set([unit.id, ...irmas])] }, leadId: { in: leadIds.map(String) }, lastMessageAt: { gte: desde } },
    select: { leadId: true },
  });
  return new Set(convs.map((c) => Number(c.leadId)));
}

const ehBloqueio = (err: unknown) => err instanceof KommoApiError && (err.status === 429 || err.status === 403);

async function montarKommo(unit: Unit, tz: string, agora: Date): Promise<KommoDaPagina> {
  const P = PRAZOS_DA_PAGINA_IA;
  const kommo = createKommoClientSemFreio(unit);
  const prazo = Date.now() + P.prazoDaMontagemMs;
  const avisos: string[] = [];
  let bloqueado = false;
  let incompleto = false;
  /** Cada leitura passa por aqui: depois do primeiro 403/429 ou do prazo estourado, nenhuma chamada nova sai. */
  const chamar = async <T>(f: () => Promise<T>): Promise<T> => {
    if (bloqueado) throw new Error('parei de chamar o Kommo');
    if (Date.now() > prazo) throw new Error('O Kommo demorou demais.');
    try {
      return await f();
    } catch (err) {
      if (ehBloqueio(err)) bloqueado = true;
      throw err;
    }
  };

  const conta = await dadosDaConta(unit, kommo);
  if (!conta.funis.length) throw new Error('não consegui ler os funis do Kommo');
  // sem a lista de usuários, todo `created_by` viraria "usuário removido": avisa e a leitura vale pouco tempo
  if (conta.usuarios.size === 0) {
    incompleto = true;
    avisos.push('Não consegui ler os nomes da equipe no Kommo agora: as mudanças feitas por pessoas podem aparecer sem o nome.');
  }
  const comercial = funilComercial(conta.funis);
  const nomeDaColuna = new Map<string, { nome: string; comercial: boolean }>();
  for (const f of conta.funis) for (const s of f.statuses ?? []) nomeDaColuna.set(`${f.id}:${s.id}`, { nome: s.name, comercial: f.id === comercial?.id });
  const funis = conta.funis.map((f) => ({ id: f.id, name: f.name, is_archive: f.is_archive, is_main: f.is_main, statuses: f.statuses ?? [] }));

  // ── cartões abertos (cada página vira cartão enxuto na hora: o lead cru, com todos os campos, não fica na memória) ──
  let cartoes: CartaoDaPagina[] | null = null;
  let posicoes: Array<{ pipeline_id: number; status_id: number }> = [];
  let cartoesParcial = false;
  try {
    const etapas = etapasAbertas(funis);
    const lidos: CartaoDaPagina[] = [];
    const onde: typeof posicoes = [];
    const vistos = new Set<number>();
    for (let page = 1; page <= P.maxPaginasDeCartoes; page++) {
      const pag = await chamar(() => kommo.listLeadsAbertosPagina(etapas, page));
      for (const l of pag) {
        // cartão novo nascendo durante a leitura empurra a lista: o último de uma página reaparece na seguinte
        if (vistos.has(l.id)) continue;
        vistos.add(l.id);
        const c = nomeDaColuna.get(`${l.pipeline_id}:${l.status_id}`);
        lidos.push(cartaoDaPagina(l, c?.nome ?? '', c?.comercial ?? false));
        onde.push({ pipeline_id: l.pipeline_id, status_id: l.status_id });
      }
      if (pag.length < 250) break;
      if (page === P.maxPaginasDeCartoes) cartoesParcial = true;
    }
    cartoes = lidos;
    posicoes = onde;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ia-unidade: não consegui ler os cartões');
    incompleto = true;
    avisos.push('Não consegui ler os cartões do Kommo agora: as colunas e o "Conferir" ficaram de fora.');
  }
  if (cartoes && cartoesParcial) {
    avisos.push(`A conta tem mais de ${P.maxPaginasDeCartoes * 250} cartões abertos: contei só os mais novos, os números das colunas podem estar abaixo do real.`);
  }

  // ── mudanças de coluna do dia ──
  const inicio = inicioDoDiaEpoch(agora, tz);
  let mudancasLidas: MudancaLida[] | null = null;
  let mudancasParcial = false;
  try {
    const lidas: MudancaLida[] = [];
    for (let page = 1; page <= P.maxPaginasDeMudancas; page++) {
      const r = await chamar(() => kommo.mudancasDeEtapaDesde(inicio, page));
      lidas.push(...r.eventos.map((e) => ({ leadId: e.leadId, nome: e.nome, por: e.por, em: e.em, de: e.de, para: e.para })));
      if (!r.temMais) break;
      if (page === P.maxPaginasDeMudancas) mudancasParcial = true;
    }
    mudancasLidas = lidas;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ia-unidade: não consegui ler as mudanças de coluna');
    incompleto = true;
    avisos.push('Não consegui ler as mudanças de coluna de hoje agora.');
  }
  if (mudancasParcial) avisos.push(`Hoje houve mais de ${P.maxPaginasDeMudancas * 100} mudanças de coluna: a contagem é das mais recentes.`);

  // nada do Kommo veio: isto é falha (o cache guarda a última leitura boa e não pergunta de novo por 60 s)
  if (!cartoes && !mudancasLidas) throw new Error('o Kommo não respondeu');

  // ── o que o NOSSO banco sabe: quais mudanças foram da Sofia e quais cartões "vazios" têm conversa ──
  const mudancas = mudancasLidas
    ? await (async () => {
        const movimentos = await movimentosDaSofia(unit, mudancasLidas.map((m) => m.leadId), inicio).catch((err) => {
          logger.warn({ err: String(err), unit: unit.slug }, 'ia-unidade: sem os movimentos da Sofia no banco');
          incompleto = true;
          avisos.push('Não consegui separar as mudanças da Sofia agora: elas aparecem como "robô automático".');
          return [] as MovimentoDaIa[];
        });
        const resumo = resumirMudancas(mudancasLidas, {
          usuarios: conta.usuarios,
          movimentosDaIa: movimentos,
          nomeDaColuna: (p, s) => nomeDaColuna.get(`${p}:${s}`)?.nome ?? null,
          tz,
        });
        return { ...resumo, lista: resumo.lista.map((l) => ({ ...l, link: linkDoCartao(unit, l.leadId) })), parcial: mudancasParcial };
      })()
    : null;

  let conferirPronto: KommoDaPagina['conferir'] = null;
  let colunas: ColunasDoFunil[] | null = null;
  if (cartoes) {
    colunas = contarPorColuna(posicoes, funis);
    if (!comercial) avisos.push('A conta não tem um funil COMERCIAL: o "Conferir" ficou de fora.');
    else {
      const vazios = await comConversaRecente(unit, candidatosCartaoVazio(cartoes, agora), agora).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug }, 'ia-unidade: sem as conversas recentes no banco');
        incompleto = true;
        avisos.push('Não consegui conferir as conversas dos cartões vazios agora: a lista deles pode estar maior que a real.');
        return new Set<number>();
      });
      const r = conferir(cartoes, { agora, etapasDaConta: comercial.statuses.map((s) => s.name), comConversaRecente: vazios });
      conferirPronto = {
        total: r.total,
        grupos: r.grupos.map((g) => ({ ...g, itens: g.itens.map((i) => ({ ...i, link: linkDoCartao(unit, i.leadId) })) })),
      };
    }
  }

  logger.info(
    { unit: unit.slug, cartoes: cartoes?.length ?? null, mudancas: mudancasLidas?.length ?? null, conferir: conferirPronto?.total ?? null, avisos: avisos.length },
    'ia-unidade: montada',
  );
  return { colunas, cartoesLidos: cartoes?.length ?? 0, cartoesParcial, mudancas, conferir: conferirPronto, avisos, incompleto };
}

// ── a API ────────────────────────────────────────────────────────────────────────────────────────────────

const MENSAGEM_KOMMO_FORA = 'Dados do Kommo indisponíveis agora. Tente de novo em alguns minutos.';

export async function iaApiHandler(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const slug = String(req.params.slug ?? '');
  const chave = `${req.ip}:${slug}`;
  // 1º acha a unidade: slug inventado dá 404 e não conta nada (senão encheria o mapa de tentativas)
  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ error: 'unidade não encontrada' });
    return;
  }
  // 2º o bloqueio por erros, antes de olhar o código; só ERRO de código conta (acertar zera)
  if (limite.bloqueado(chave)) {
    res.status(429).json({ error: 'muitas tentativas — aguarde 10 minutos' });
    return;
  }
  // o código vai no cabeçalho (não aparece no log de acesso); a consulta fica para teste à mão, como na /pausa
  const recebido = req.header('x-codigo') ?? req.query.codigo;
  if (!codigoConfere(unit.pausaCodigo, recebido)) {
    limite.registrarErro(chave);
    res.status(403).json({ error: 'código inválido' });
    return;
  }
  limite.limpar(chave);

  const agora = new Date();
  const tz = fusoDaUnidade(unit);
  const inicioDoDia = inicioDoDiaEpoch(agora, tz);
  const lidoHoje = await cacheHoje.obter(`${unit.id}|${inicioDoDia}`, () => montarHoje(unit, new Date(inicioDoDia * 1000)));
  if (!lidoHoje.ok) {
    logger.error({ motivo: lidoHoje.motivo, unit: unit.slug }, 'ia-unidade: falha ao ler o banco');
    res.status(500).json({ error: 'não consegui ler os números de hoje' });
    return;
  }
  const hoje = lidoHoje.valor;

  let kommo: Record<string, unknown>;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    kommo = { ok: false, motivo: 'Esta unidade ainda não tem o Kommo ligado.' };
  } else {
    const conta = contaDaUnidade(unit) || unit.id;
    const chaveDoCache = `${conta}|${tz}|${dataLocalISO(agora, tz)}`;
    const lendo = cacheKommo.obter(chaveDoCache, () => emFila(() => montarKommo(unit, tz, agora)), (v) =>
      v.incompleto ? PRAZOS_DA_PAGINA_IA.cacheFalhaMs : PRAZOS_DA_PAGINA_IA.cacheKommoMs,
    );
    // A leitura segue por trás mesmo que este pedido desista de esperar (e enche o cache para o próximo).
    const demorou = Symbol('demorou');
    let espera: ReturnType<typeof setTimeout> | undefined;
    const leitura = await Promise.race([
      lendo,
      new Promise<typeof demorou>((resolve) => {
        espera = setTimeout(() => resolve(demorou), PRAZOS_DA_PAGINA_IA.esperaDoPedidoMs);
      }),
    ]);
    clearTimeout(espera);
    if (leitura === demorou) {
      const antiga = cacheKommo.espiar(chaveDoCache);
      kommo = antiga
        ? { ok: true, lidoEm: new Date(antiga.lidoEm).toISOString(), desatualizado: true, atualizando: true, ...antiga.valor }
        : { ok: false, carregando: true, motivo: 'Lendo o Kommo… na primeira vez pode levar até 1 minuto.' };
    } else if (!leitura.ok) {
      logger.warn({ unit: unit.slug, motivo: leitura.motivo }, 'ia-unidade: Kommo indisponível');
      kommo = { ok: false, motivo: MENSAGEM_KOMMO_FORA };
    } else {
      kommo = {
        ok: true,
        lidoEm: new Date(leitura.lidoEm).toISOString(),
        desatualizado: leitura.desatualizado,
        ...(leitura.desatualizado ? { motivo: MENSAGEM_KOMMO_FORA } : {}),
        ...leitura.valor,
      };
    }
  }

  res.json({
    unidade: unit.name,
    slug: unit.slug,
    tz,
    geradoEm: agora.toISOString(),
    renovaACadaMin: Math.round(PRAZOS_DA_PAGINA_IA.cacheKommoMs / 60_000),
    hoje,
    kommo,
  });
}

// ── a página ─────────────────────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export async function paginaIaHandler(req: Request, res: Response): Promise<void> {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const slug = String(req.params.slug ?? '');
  const unit = await prisma.unit.findUnique({ where: { slug }, select: { name: true, isActive: true } });
  if (!unit || !unit.isActive) {
    res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Sofia</title><p style="font-family:sans-serif;padding:24px">Unidade não encontrada.</p>');
    return;
  }
  res.type('html').send(paginaHtml(slug, unit.name));
}

export function paginaHtml(slug: string, nome: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Como está a Sofia · ${esc(nome)}</title>
<style>
:root{--bg:#0B0B11;--s1:#13131B;--s2:#1A1A24;--line:#2A2A36;--ink:#F5F5F7;--ink2:#C7C8D1;--muted:#8A8C97;--acc:#3D6BFF;--ok:#04D361;--warn:#E9B949;--red:#F75A68}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;padding:20px 16px 56px}
main{max-width:560px;margin:0 auto}h1{font-size:22px;font-weight:600;margin:6px 0 2px}h2{font-size:17px;font-weight:600;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 18px;font-size:14px}
.card{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
label{display:block;font-size:13px;color:var(--muted);margin:0 0 6px}
input{width:100%;background:var(--s2);border:1px solid var(--line);border-radius:10px;color:var(--ink);font:inherit;padding:12px}
input:focus{outline:2px solid var(--acc);border-color:transparent}
[hidden]{display:none!important}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}.tile{background:var(--s2);border:1px solid var(--line);border-radius:12px;padding:10px 8px;text-align:center}
.tile b{display:block;font-size:26px;line-height:1.1}.tile span{display:block;font-size:12.5px;color:var(--ink2);margin-top:4px}
.nota{color:var(--muted);font-size:13px;margin:8px 0 0}
.lin{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line)}.lin:first-of-type{border-top:0}.lin b{flex:none;min-width:28px;text-align:right}
.funil{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 2px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}.chip{background:var(--s2);border:1px solid var(--line);border-radius:999px;padding:4px 10px;font-size:13px}
.mud{padding:9px 0;border-top:1px solid var(--line)}.mud:first-of-type{border-top:0}.mud .p{font-weight:600}.mud .m{font-size:13.5px;color:var(--ink2)}
.ia{color:#9DB4FF}.equipe{color:#8FEFB4}.robo{color:var(--muted)}.consultoria{color:var(--warn)}
.grupo{margin-top:12px}.grupo h3{font-size:15px;margin:0 0 2px;color:var(--warn)}
.item{padding:8px 0;border-top:1px solid var(--line)}.item:first-of-type{border-top:0}.item a{color:var(--ink);font-weight:600;text-decoration:none;border-bottom:1px dotted var(--muted)}.item .f{font-size:13.5px;color:var(--ink2)}
.ok{background:rgba(4,211,97,.12);color:#8FEFB4;border-radius:10px;padding:10px 12px;font-size:14px}
.aviso{background:rgba(233,185,73,.12);color:#F3D98B;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:10px}
.err{background:rgba(247,90,104,.12);color:#FFB3B9;border-radius:10px;padding:10px 12px;font-size:14px}
button{width:100%;margin-top:6px;padding:14px;border:0;border-radius:12px;background:var(--acc);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer}button:disabled{opacity:.6}
.foot{color:var(--muted);font-size:12.5px;margin-top:14px;text-align:center}
</style></head><body><main>
<p class="sub" style="margin:0">Doutor Digital · Sofia</p>
<h1>${esc(nome)}</h1>
<p class="sub">Veja se a Sofia está atendendo e se os cartões estão nas colunas certas. Só leitura: nada muda aqui.</p>

<div class="card" id="cardCodigo" hidden>
  <label for="codigo">Código da unidade (o mesmo da página de pausar a Sofia)</label>
  <input id="codigo" inputmode="numeric" maxlength="6" placeholder="6 dígitos" autocomplete="one-time-code">
  <button id="btnEntrar">Ver</button>
  <div id="erroCodigo" class="err" hidden style="margin-top:10px"></div>
</div>

<div id="conteudo"></div>

<div class="card" id="rodape" hidden>
  <button id="btnAtualizar">Atualizar</button>
  <p class="foot" id="quando"></p>
</div>
</main>
<script>
(function(){
  var SLUG=${JSON.stringify(slug)}; var API='/api/public/ia/'+encodeURIComponent(SLUG);
  var $=function(id){return document.getElementById(id)};
  // o mesmo aparelho já guardou o código na página de pausar a Sofia: reaproveita
  var KC='pausa-codigo-'+SLUG;
  function lerCodigo(){ try{ return localStorage.getItem(KC)||''; }catch(e){ return ''; } }
  function guardarCodigo(c){ try{ localStorage.setItem(KC,c); }catch(e){} }
  function el(tag,cls,txt){ var e=document.createElement(tag); if(cls) e.className=cls; if(txt!==undefined&&txt!==null) e.textContent=txt; return e; }
  function hora(iso,tz){ try{ return new Intl.DateTimeFormat('pt-BR',{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(iso)); }catch(e){ return ''; } }
  var tentativasAuto=0, timerAuto=null;
  function plural(n,um,varios){ return n===1?um:varios; }

  function cartao(titulo,sub){ var c=el('div','card'); c.appendChild(el('h2','',titulo)); if(sub) c.appendChild(el('p','nota',sub)); return c; }

  function blocoHoje(d){
    var h=d.hoje, c=cartao('Hoje','Conversas de hoje até agora (a contagem recomeça à meia-noite).');
    var t=el('div','tiles');
    [[h.respondidas,'conversas a Sofia respondeu'],[h.passadasParaEquipe,'passou para a equipe'],[h.pausadasAgora,'pausadas agora porque a equipe está atendendo']].forEach(function(x){
      var b=el('div','tile'); b.appendChild(el('b','',String(x[0]))); b.appendChild(el('span','',x[1])); t.appendChild(b); });
    c.appendChild(t);
    c.appendChild(el('p','nota','"Passou para a equipe" é quando a Sofia entrega a conversa para vocês. A pausa termina sozinha 1 hora depois da última fala da equipe.'));
    return c;
  }

  function avisosDoKommo(k){
    var f=document.createDocumentFragment();
    if(!k.ok){ f.appendChild(el('div',k.carregando?'aviso':'err',k.motivo||'Dados do Kommo indisponíveis agora.')); return f; }
    if(k.atualizando){ f.appendChild(el('div','aviso','Atualizando do Kommo… mostrando a leitura das '+hora(k.lidoEm,k._tz)+'.')); }
    else if(k.desatualizado){ f.appendChild(el('div','aviso','Mostrando a última leitura do Kommo ('+hora(k.lidoEm,k._tz)+'): não consegui atualizar agora.')); }
    (k.avisos||[]).forEach(function(a){ f.appendChild(el('div','aviso',a)); });
    return f;
  }

  function blocoColunas(k){
    var c=cartao('Cartões em cada coluna','Só cartões abertos (ganhos e perdidos não entram).');
    (k.colunas||[]).forEach(function(fu){
      c.appendChild(el('div','funil',fu.funil+' · '+fu.total));
      fu.etapas.forEach(function(e){ var l=el('div','lin'); l.appendChild(el('span','',e.nome)); l.appendChild(el('b','',String(e.total))); c.appendChild(l); });
    });
    return c;
  }

  function blocoMudancas(k){
    var m=k.mudancas, c=cartao('Mudanças de coluna hoje','Quem moveu o cartão de uma coluna para outra.');
    if(!m.total){ c.appendChild(el('p','nota','Nenhuma mudança de coluna hoje.')); return c; }
    var chips=el('div','chips');
    m.porTipo.forEach(function(t){ chips.appendChild(el('span','chip '+t.tipo,t.rotulo+': '+t.total)); });
    c.appendChild(chips);
    if(m.pessoas.length){ c.appendChild(el('p','nota','Equipe: '+m.pessoas.map(function(p){return p.nome+' ('+p.total+')';}).join(', '))); }
    var lista=el('div'); lista.style.marginTop='8px';
    m.lista.forEach(function(x){
      var l=el('div','mud'); var a=el('a','p',x.paciente); a.href=x.link; a.target='_blank'; a.rel='noopener noreferrer'; a.style.color='inherit'; a.style.textDecoration='none';
      l.appendChild(a);
      l.appendChild(el('div','m',x.de+' → '+x.para));
      var q=el('div','m '+x.tipo,x.quem+' · '+x.hora); l.appendChild(q);
      lista.appendChild(l); });
    c.appendChild(lista);
    if(m.total>m.lista.length) c.appendChild(el('p','nota','Mostrando as '+m.lista.length+' mais recentes de '+m.total+'.'));
    return c;
  }

  function blocoConferir(k){
    var cf=k.conferir, c=cartao('⚠ Conferir','Cartões que parecem estar na coluna errada ou sem um dado importante.');
    if(!cf.total){ c.appendChild(el('div','ok','Tudo certo: nada para conferir agora.')); return c; }
    cf.grupos.forEach(function(g){
      var gr=el('div','grupo'); gr.appendChild(el('h3','',g.titulo+' ('+g.total+')'));
      if(g.regra==='cartao_vazio'){
        gr.appendChild(el('p','nota',g.total+' '+plural(g.total,'cartão sem nenhum dado e sem mexer há mais de 7 dias','cartões sem nenhum dado e sem mexer há mais de 7 dias')+'. Não precisa abrir um por um: vale fechar ou arquivar em bloco. Exemplos:'));
      }
      g.itens.forEach(function(i){
        var it=el('div','item'); var a=el('a','',i.nome); a.href=i.link; a.target='_blank'; a.rel='noopener noreferrer'; it.appendChild(a);
        it.appendChild(el('div','f',i.oQueFazer)); gr.appendChild(it); });
      if(g.total>g.itens.length && g.regra!=='cartao_vazio') gr.appendChild(el('p','nota','e mais '+(g.total-g.itens.length)+' '+plural(g.total-g.itens.length,'cartão','cartões')+' nesta lista.'));
      c.appendChild(gr);
    });
    return c;
  }

  function mostrar(d){
    var raiz=$('conteudo'); raiz.textContent='';
    raiz.appendChild(blocoHoje(d));
    var k=d.kommo; k._tz=d.tz;
    var av=avisosDoKommo(k); if(av.childNodes.length){ var w=el('div'); w.appendChild(av); raiz.appendChild(w); }
    if(k.ok){
      if(k.colunas) raiz.appendChild(blocoColunas(k));
      if(k.mudancas) raiz.appendChild(blocoMudancas(k));
      if(k.conferir) raiz.appendChild(blocoConferir(k));
    }
    $('rodape').hidden=false;
    // o Kommo ainda está sendo lido (primeira vez, conta grande): pergunta de novo sozinha, sem martelar
    if(timerAuto){ clearTimeout(timerAuto); timerAuto=null; }
    if(k.carregando||k.atualizando){
      if(tentativasAuto<20){ tentativasAuto++; timerAuto=setTimeout(function(){ carregar(); },6000); }
      else { raiz.insertBefore(el('div','aviso','O Kommo está demorando mais que o normal para responder. Toque em Atualizar daqui a alguns minutos.'),raiz.firstChild); }
    } else { tentativasAuto=0; }
    $('quando').textContent='Atualizado às '+hora(d.geradoEm,d.tz)+(k.ok?(' · Kommo lido às '+hora(k.lidoEm,d.tz)+' (renova a cada '+d.renovaACadaMin+' min)'):'');
  }

  // novoCodigo: o que acabou de ser digitado — só vira o código guardado depois que o servidor aceitar
  async function carregar(novoCodigo){
    var cod=novoCodigo||lerCodigo();
    if(!cod){ $('cardCodigo').hidden=false; return; }
    $('btnAtualizar').disabled=true;
    try{
      var r=await fetch(API,{headers:{'x-codigo':cod},cache:'no-store'});
      var j=await r.json().catch(function(){return {};});
      if(r.status===403){ $('cardCodigo').hidden=false; if(!novoCodigo){ $('rodape').hidden=true; $('conteudo').textContent=''; } var e=$('erroCodigo'); e.textContent='Código inválido. Confira os 6 dígitos.'; e.hidden=false; return; }
      if(!r.ok) throw new Error(j.error||('erro '+r.status));
      if(novoCodigo) guardarCodigo(novoCodigo);
      $('cardCodigo').hidden=true; mostrar(j);
    }catch(e){
      var raiz=$('conteudo'); if(!raiz.childNodes.length){ raiz.appendChild(el('div','err',String(e.message||e))); }
      else { raiz.insertBefore(el('div','aviso','Não consegui atualizar agora ('+String(e.message||e)+').'),raiz.firstChild); }
      $('rodape').hidden=false;
    }finally{ $('btnAtualizar').disabled=false; }
  }
  $('btnEntrar').addEventListener('click',function(){ var c=$('codigo').value.trim(); if(!c) return; $('erroCodigo').hidden=true; carregar(c); });
  $('btnAtualizar').addEventListener('click',function(){ tentativasAuto=0; if(timerAuto){ clearTimeout(timerAuto); timerAuto=null; } carregar(); });
  carregar();
})();
</script></body></html>`;
}
