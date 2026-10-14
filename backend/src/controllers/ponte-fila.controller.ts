/**
 * Ponte, fase 2 — a FILA DO DIA (13/10/2026). `GET /api/public/widget/:slug/ponte/fila`, com a chave da unidade.
 *
 * Quem a atendente precisa chamar ou ligar hoje, por etapa do funil COMERCIAL. As regras e os prazos estão em
 * `lib/ponte-fila.ts`; aqui só se lê o Kommo e o banco. SÓ LEITURA.
 *
 * Custo, porque o limitador do Kommo é UM só para o processo (cada chamada a mais atrasa a Sofia):
 *   - cache de `PRAZOS_DA_FILA.cacheMs` (2 min) por CONTA do Kommo — unidades que dividem a conta dividem a fila;
 *   - várias atendentes pedindo junto viram UMA montagem (a mesma promessa);
 *   - por montagem: 4 etapas (1–2 páginas cada), as conversas mexidas na janela (1–4 páginas), quem entrou em
 *     EM NEGOCIAÇÃO no prazo (1 página), os cartões das conversas não lidas (1–2) e os telefones de quem aparece
 *     (1–3). ~9 a 18 chamadas, no ritmo do limitador.
 *
 * Nome e telefone dos pacientes saem na resposta (é para ligar), mas não vão para o log.
 *
 * 0.4.0: `GET /api/public/widget/:slug/ponte/contador` — o número no ícone da extensão (pacientes esperando resposta):
 * a MESMA conta do grupo "sem resposta" (`candidatosSemResposta`), cache de 90 s por conta, e a fila guardada serve
 * quando é recente. Só leitura; falha do Kommo = `total: null` (a extensão mostra "?", nunca 0).
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { unidadeDaPonte } from './widget-franquia.controller.js';
import { dadosDaConta } from './ponte.controller.js';
import { createKommoClient, type KommoClient, type KommoLead, type KommoTalk } from '../services/kommo.service.js';
import { funilComercial } from '../lib/ponte-cartao.js';
import { normalizarNome } from '../lib/kommo-schema.js';
import { ETAPA } from '../lib/franquia-move.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import {
  DIA_S,
  MAX_NAO_LIDAS,
  PRAZOS_DA_FILA,
  candidatosSemResposta,
  cartaoDaFila,
  contarSemResposta,
  conversaPorCartao,
  janelaDeConversasDias,
  montarGrupos,
  regraConfirmar,
  regraFaltou,
  regraNegociacao,
  regraRetomar,
  semTelefoneConfirmado,
  telefoneParaMostrar,
  telefoneParaWhatsapp,
  type CandidatoDaFila,
  type CartaoDaFila,
  type ContagemSemResposta,
  type IdDoGrupo,
  type LeitoresDoSemResposta,
  type Pista,
} from '../lib/ponte-fila.js';
import { RITMO_DAS_LIGACOES } from '../lib/ponte-ligacao.js';
import { contaDaUnidade } from '../lib/ponte-cache.js';

/** Páginas de 250 cartões por etapa, dos mais novos para os mais velhos. 4 = 1.000 cartões; passou disso, avisa. */
const MAX_PAGINAS_POR_ETAPA = 4;
/** Páginas de 250 conversas, das mais novas para as mais antigas, até a janela de conversas. */
const MAX_PAGINAS_DE_CONVERSAS = 4;
const LIMITE_DA_FILA = { balde: 'ponte-fila', max: 60 };

interface ItemDaResposta {
  leadId: number;
  nome: string;
  etapa: string;
  motivo: string;
  detalhe: string;
  /** ISO da referência; o painel mostra "há quanto tempo" quando `passado`. */
  quando: string;
  passado: boolean;
  /** Só dígitos, com o país (para o link do WhatsApp). */
  telefone: string | null;
  /** Como mostrar e copiar: "(99) 90000-0043". */
  telefoneVisivel: string | null;
  /**
   * O Kommo AFIRMA que não há telefone (cartão sem contato, ou contato lido sem número válido). Falso com
   * `telefone: null` = não deu para ler agora — o painel não pode tratar como "sem telefone".
   */
  semTelefone: boolean;
  link: string;
}

interface GrupoDaResposta {
  id: IdDoGrupo;
  etapa: string;
  rotulo: string;
  total: number;
  itens: ItemDaResposta[];
  /** Algo não pôde ser lido (teto de páginas, Kommo fora): o grupo pode ter gente a mais ou a menos. */
  aviso?: string;
}

interface RespostaDaFila {
  unidade: string;
  atualizadoEm: string;
  tz: string;
  prazos: { confirmarDiasAntes: number; negociacaoParadaDias: number; semRespostaHoras: number };
  grupos: GrupoDaResposta[];
  /** Os telefones não puderam ser lidos agora: a fila sai assim mesmo, mas NÃO fica em cache. */
  avisoTelefones?: string;
}

const cache = new Map<string, { em: number; corpo: RespostaDaFila }>();
const emAndamento = new Map<string, Promise<RespostaDaFila>>();

/** Os avisos de cada grupo, juntos (um não apaga o outro). */
class Avisos {
  private readonly porGrupo = new Map<IdDoGrupo, string[]>();
  add(grupo: IdDoGrupo, texto: string): void {
    const l = this.porGrupo.get(grupo) ?? [];
    if (!l.includes(texto)) l.push(texto);
    this.porGrupo.set(grupo, l);
  }
  de(grupo: IdDoGrupo): string | undefined {
    const l = this.porGrupo.get(grupo);
    return l?.length ? l.join(' ') : undefined;
  }
}

async function leadsDaEtapa(kommo: KommoClient, pipelineId: number, statusId: number): Promise<{ leads: KommoLead[]; completa: boolean }> {
  const leads: KommoLead[] = [];
  for (let page = 1; page <= MAX_PAGINAS_POR_ETAPA; page++) {
    // os mais novos primeiro: se o teto cortar, corta os cartões mais velhos (os menos acionáveis)
    const pag = await kommo.listLeadsPorEtapa(pipelineId, statusId, 250, page, true, 'desc');
    leads.push(...pag);
    if (pag.length < 250) return { leads, completa: true };
  }
  return { leads, completa: false };
}

/** Quando a Sofia falou por último com cada cartão (epoch s), nesta unidade e nas irmãs da mesma conta. */
async function ultimaFalaDaSofia(unit: Unit, leadIds: number[]): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  if (!leadIds.length) return m;
  const irmas = unit.kommoSubdomain
    ? (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id)
    : [unit.id];
  const convs = await prisma.conversation.findMany({
    where: { unitId: { in: [...new Set([unit.id, ...irmas])] }, leadId: { in: leadIds.map(String) } },
    select: { leadId: true, messages: { where: { role: 'assistant' }, orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
  });
  for (const c of convs) {
    const t = c.messages[0]?.createdAt;
    if (!t) continue;
    const id = Number(c.leadId);
    const s = Math.floor(t.getTime() / 1000);
    if (s > (m.get(id) ?? 0)) m.set(id, s);
  }
  return m;
}

/** Os leitores do "sem resposta" (fila e contador): os cartões no Kommo e a última fala da Sofia no banco. */
function leitoresDoSemResposta(unit: Unit, kommo: KommoClient): LeitoresDoSemResposta {
  return {
    cartoes: (ids) => kommo.listLeadsPorIds(ids, { contatos: true }),
    falaDaSofia: (ids) => ultimaFalaDaSofia(unit, ids),
  };
}

async function montarFila(unit: Unit): Promise<RespostaDaFila> {
  const kommo = createKommoClient(unit);
  const tz = fusoDaUnidade(unit);
  const agora = new Date();
  const agoraEpoch = Math.floor(agora.getTime() / 1000);
  const prazos = PRAZOS_DA_FILA;
  // a janela de conversas cobre pelo menos o prazo da negociação (senão "sem conversa na janela" não diria nada)
  const janelaDias = janelaDeConversasDias(prazos);

  const conta = await dadosDaConta(unit, kommo);
  const comercial = funilComercial(conta.funis);
  if (!comercial) throw new Error('a conta não tem o funil COMERCIAL');
  const statusPorNome = new Map(comercial.statuses.map((s) => [normalizarNome(s.name), s]));
  const avisos = new Avisos();
  const candidatos: CandidatoDaFila[] = [];

  // ── as conversas mexidas na janela: servem ao "sem resposta" e ao "parado" da negociação ──
  let conversas: Map<number, KommoTalk> = new Map();
  let conversasCompletas = false;
  try {
    const r = await kommo.listarConversasDesde(agoraEpoch - janelaDias * DIA_S, MAX_PAGINAS_DE_CONVERSAS);
    conversas = conversaPorCartao(r.conversas);
    conversasCompletas = r.completa;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: não consegui ler as conversas');
  }
  if (!conversasCompletas) {
    avisos.add('sem-resposta', `Não consegui ler todas as conversas dos últimos ${janelaDias} dias: pode faltar gente aqui.`);
    avisos.add('negociacao', 'Não consegui ler todas as conversas: alguém aqui pode ter conversado nos últimos dias.');
  }

  // ── EM NEGOCIAÇÃO: quem ENTROU na etapa dentro do prazo (o "acabou de chegar" dos parados) ──
  const negociacao = statusPorNome.get(normalizarNome(ETAPA.NEGOCIACAO));
  let entraramNaNegociacao: Set<number> | null = null;
  if (negociacao) {
    try {
      const r = await kommo.cartoesQueEntraramNaEtapaDesde(agoraEpoch - prazos.negociacaoParadaDias * DIA_S, {
        pipelineId: comercial.id,
        statusId: negociacao.id,
      });
      if (r.completa) entraramNaNegociacao = r.ids;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: não consegui ler quem entrou em EM NEGOCIAÇÃO');
    }
    if (!entraramNaNegociacao) {
      avisos.add('negociacao', 'Não consegui ler as mudanças de etapa: usei a última alteração do cartão, e pode faltar gente aqui.');
    }
  }

  // ── as quatro etapas lidas pelo nome ──
  const regras: Array<{ grupo: IdDoGrupo; etapa: string; pista: (c: CartaoDaFila) => Pista | null }> = [
    { grupo: 'retomar', etapa: ETAPA.ESPERA, pista: (c) => regraRetomar(c, agora, tz) },
    { grupo: 'confirmar', etapa: ETAPA.AGENDADO, pista: (c) => regraConfirmar(c, agora, tz, prazos) },
    { grupo: 'faltou', etapa: ETAPA.NAO_COMPARECEU, pista: (c) => regraFaltou(c, agora, tz) },
    {
      grupo: 'negociacao',
      etapa: ETAPA.NEGOCIACAO,
      pista: (c) =>
        regraNegociacao(
          c,
          {
            ultimaConversaEpoch: conversas.get(c.id)?.updated_at ?? null,
            entrouNaEtapaNoPrazo: entraramNaNegociacao ? entraramNaNegociacao.has(c.id) : null,
            janelaDias,
          },
          agora,
          tz,
          prazos,
        ),
    },
  ];
  for (const r of regras) {
    const status = statusPorNome.get(normalizarNome(r.etapa));
    if (!status) {
      avisos.add(r.grupo, `A conta não tem a etapa ${r.etapa} no funil ${comercial.name}.`);
      continue;
    }
    try {
      const { leads, completa } = await leadsDaEtapa(kommo, comercial.id, status.id);
      if (!completa) avisos.add(r.grupo, `A etapa tem mais de ${MAX_PAGINAS_POR_ETAPA * 250} cartões: olhei só os mais novos.`);
      for (const lead of leads) {
        const c = cartaoDaFila(lead, status.name);
        const pista = r.pista(c);
        if (pista) candidatos.push({ grupo: r.grupo, cartao: c, pista });
      }
    } catch (err) {
      avisos.add(r.grupo, 'O Kommo não respondeu esta etapa agora.');
      logger.warn({ err: String(err), unit: unit.slug, etapa: r.etapa }, 'ponte fila: falha ao ler a etapa');
    }
  }

  // ── sem resposta: conversa não lida há mais de N horas, cartão na entrada ou em EM QUALIFICAÇÃO (a mesma conta
  // do contador do ícone — `candidatosSemResposta`) ──
  try {
    const r = await candidatosSemResposta(conversas, comercial, leitoresDoSemResposta(unit, kommo), agora, tz, prazos);
    if (r.cortado) avisos.add('sem-resposta', `Há mais de ${MAX_NAO_LIDAS} conversas não lidas na conta: olhei as que esperam há mais tempo.`);
    candidatos.push(...r.candidatos);
  } catch (err) {
    avisos.add('sem-resposta', 'O Kommo não respondeu as conversas agora.');
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: falha no "sem resposta"');
  }

  const grupos = montarGrupos(candidatos, prazos);

  // ── telefones só de quem aparece (lotes de 50) ──
  const contatos = grupos.flatMap((g) => g.itens.map((i) => i.cartao.contatoId)).filter((id): id is number => id !== null);
  // falha ao ler NÃO é "sem telefone": marca, avisa, e a fila não entra no cache
  let telefonesLidos = true;
  const telefones = await kommo.telefonesDosContatos(contatos).catch((err) => {
    telefonesLidos = false;
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: sem os telefones agora');
    return new Map<number, string>();
  });

  const corpo: RespostaDaFila = {
    unidade: unit.name,
    atualizadoEm: agora.toISOString(),
    tz,
    prazos: {
      confirmarDiasAntes: prazos.confirmarDiasAntes,
      negociacaoParadaDias: prazos.negociacaoParadaDias,
      semRespostaHoras: prazos.semRespostaHoras,
    },
    grupos: grupos.map((g) => {
      const aviso = avisos.de(g.def.id);
      return {
        id: g.def.id,
        etapa: g.def.id === 'sem-resposta' ? `entrada / ${g.def.etapa}` : g.def.etapa,
        rotulo: g.def.rotulo,
        total: g.total,
        itens: g.itens.map(({ cartao: c, pista }) => {
          const tel = telefoneParaWhatsapp(c.contatoId !== null ? telefones.get(c.contatoId) : null);
          return {
            leadId: c.id,
            nome: c.nome,
            etapa: c.etapa,
            motivo: g.def.rotulo,
            detalhe: pista.detalhe,
            quando: new Date(pista.quando * 1000).toISOString(),
            passado: pista.quando <= agoraEpoch && !pista.semTempo,
            telefone: tel,
            telefoneVisivel: tel ? telefoneParaMostrar(tel) : null,
            semTelefone: semTelefoneConfirmado(tel, c.contatoId, telefonesLidos),
            link: `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${c.id}`,
          };
        }),
        ...(aviso ? { aviso } : {}),
      };
    }),
    ...(telefonesLidos ? {} : { avisoTelefones: 'Não consegui ler os telefones agora: tente de novo (Atualizar).' }),
  };
  logger.info(
    { unit: unit.slug, grupos: Object.fromEntries(corpo.grupos.map((g) => [g.id, g.total])), conversasCompletas },
    'ponte fila: montada',
  );
  return corpo;
}

export async function ponteFilaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_DA_FILA);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  // a fila é da CONTA: unidades que dividem o Kommo (comercial e resgate) veem a mesma
  const conta = unit.kommoSubdomain.trim().toLowerCase();
  const guardada = cache.get(conta);
  if (guardada && Date.now() - guardada.em < PRAZOS_DA_FILA.cacheMs) {
    res.json({ ...guardada.corpo, unidade: unit.name, ritmo: RITMO_DAS_LIGACOES, cache: true });
    return;
  }
  try {
    let p = emAndamento.get(conta);
    if (!p) {
      p = montarFila(unit)
        .then((corpo) => {
          // sem os telefones a fila sai, mas não fica 2 min em cache: o próximo "Atualizar" tenta de novo
          if (!corpo.avisoTelefones) cache.set(conta, { em: Date.now(), corpo });
          return corpo;
        })
        .finally(() => emAndamento.delete(conta));
      emAndamento.set(conta, p);
    }
    // fase 3: o ritmo da fila de ligações ("Começar a ligar") vai junto — quem conta é a extensão
    res.json({ ...(await p), unidade: unit.name, ritmo: RITMO_DAS_LIGACOES, cache: false });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: falha ao montar');
    res.status(502).json({ error: 'kommo indisponível' });
  }
}

// ── 0.4.0: o contador do ícone da extensão ──

/** Cada atendente pergunta a cada ~5 min (`chrome.alarms`); várias atendentes dividem a conta. */
const LIMITE_DO_CONTADOR = { balde: 'ponte-contador', max: 30 };
/** O contador de uma conta é contado no máximo uma vez a cada 90 s (as unidades da mesma conta dividem). */
export const CACHE_DO_CONTADOR_MS = 90_000;
const cacheDoContador = new Map<string, { em: number; corpo: ContagemSemResposta }>();
const contadorEmAndamento = new Map<string, Promise<ContagemSemResposta>>();

/**
 * A Fila de hoje montada há pouco já contou o "sem resposta": usa o total dela (é a mesma regra) e não pergunta ao
 * Kommo de novo. Só quando o grupo não tem aviso — aviso é leitura incompleta ou falha, e aí o contador conta sozinho.
 */
function contagemDaFilaGuardada(conta: string): { em: number; corpo: ContagemSemResposta } | null {
  const g = cache.get(conta);
  if (!g || Date.now() - g.em >= CACHE_DO_CONTADOR_MS) return null;
  const grupo = g.corpo.grupos.find((x) => x.id === 'sem-resposta');
  if (!grupo || grupo.aviso) return null;
  return { em: g.em, corpo: { total: grupo.total, completo: true } };
}

async function contarAgora(unit: Unit): Promise<ContagemSemResposta> {
  const kommo = createKommoClient(unit);
  const conta = await dadosDaConta(unit, kommo);
  return contarSemResposta(
    { ...leitoresDoSemResposta(unit, kommo), conversas: (desde) => kommo.listarConversasDesde(desde, MAX_PAGINAS_DE_CONVERSAS) },
    funilComercial(conta.funis),
    new Date(),
    fusoDaUnidade(unit),
  );
}

/**
 * `GET /api/public/widget/:slug/ponte/contador` → `{ total, completo, atualizadoEm, cache }`: quantos pacientes esperam
 * resposta (o grupo "sem resposta" da Fila de hoje), para o número no ícone da extensão. SÓ LEITURA. `total: null`
 * = o Kommo não respondeu — a extensão mostra "?", nunca um 0 que diria "ninguém esperando". Falha não fica em cache.
 */
export async function ponteContadorHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDaPonte(req, res, LIMITE_DO_CONTADOR);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  const conta = contaDaUnidade(unit);
  const guardado = contagemDaFilaGuardada(conta) ?? cacheDoContador.get(conta) ?? null;
  if (guardado && Date.now() - guardado.em < CACHE_DO_CONTADOR_MS) {
    res.json({ ...guardado.corpo, atualizadoEm: new Date(guardado.em).toISOString(), cache: true });
    return;
  }
  try {
    let p = contadorEmAndamento.get(conta);
    if (!p) {
      p = contarAgora(unit)
        .then((corpo) => {
          if (corpo.total !== null) {
            if (cacheDoContador.size > 500) cacheDoContador.clear();
            cacheDoContador.set(conta, { em: Date.now(), corpo });
          }
          return corpo;
        })
        .finally(() => contadorEmAndamento.delete(conta));
      contadorEmAndamento.set(conta, p);
    }
    const corpo = await p;
    if (corpo.total === null) logger.warn({ unit: unit.slug }, 'ponte contador: o Kommo não respondeu');
    res.json({ ...corpo, atualizadoEm: new Date().toISOString(), cache: false });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte contador: falha');
    res.json({ total: null, completo: false, atualizadoEm: new Date().toISOString(), cache: false });
  }
}
