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
 */
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { unidadeDoWidget } from './widget-franquia.controller.js';
import { dadosDaConta } from './ponte.controller.js';
import { createKommoClient, type KommoClient, type KommoLead, type KommoTalk } from '../services/kommo.service.js';
import { funilComercial } from '../lib/ponte-cartao.js';
import { normalizarNome } from '../lib/kommo-schema.js';
import { ETAPA } from '../lib/franquia-move.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import {
  DIA_S,
  PRAZOS_DA_FILA,
  cartaoDaFila,
  etapaDoSemResposta,
  montarGrupos,
  regraConfirmar,
  regraFaltou,
  regraNegociacao,
  regraRetomar,
  regraSemResposta,
  telefoneParaMostrar,
  telefoneParaWhatsapp,
  type CandidatoDaFila,
  type CartaoDaFila,
  type IdDoGrupo,
  type Pista,
} from '../lib/ponte-fila.js';

/** Páginas de 250 cartões por etapa, dos mais novos para os mais velhos. 4 = 1.000 cartões; passou disso, avisa. */
const MAX_PAGINAS_POR_ETAPA = 4;
/** Páginas de 250 conversas, das mais novas para as mais antigas, até a janela de conversas. */
const MAX_PAGINAS_DE_CONVERSAS = 4;
/**
 * Cartões das conversas não lidas que vale buscar (5 lotes de 50), antes de saber a etapa. Medido em 25/09: a
 * conta com mais conversas não lidas tinha 92 (Bebedouro) — o teto só corta numa pilha bem maior, e avisa.
 */
const MAX_NAO_LIDAS = 250;

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
  /** Como mostrar e copiar: "(63) 99102-1043". */
  telefoneVisivel: string | null;
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

/** A conversa mais recente de cada cartão (as conversas do Kommo apontam para o cartão em `entity_id`). */
function conversaPorCartao(conversas: KommoTalk[]): Map<number, KommoTalk> {
  const m = new Map<number, KommoTalk>();
  for (const t of conversas) {
    if (t.entity_type && t.entity_type !== 'lead') continue;
    const id = Number(t.entity_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const atual = m.get(id);
    if (!atual || (t.updated_at ?? 0) > (atual.updated_at ?? 0)) m.set(id, t);
  }
  return m;
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

async function montarFila(unit: Unit): Promise<RespostaDaFila> {
  const kommo = createKommoClient(unit);
  const tz = fusoDaUnidade(unit);
  const agora = new Date();
  const agoraEpoch = Math.floor(agora.getTime() / 1000);
  const prazos = PRAZOS_DA_FILA;
  // a janela de conversas cobre pelo menos o prazo da negociação (senão "sem conversa na janela" não diria nada)
  const janelaDias = Math.max(prazos.janelaConversasDias, prazos.negociacaoParadaDias + 1);

  const conta = await dadosDaConta(unit, kommo);
  const comercial = funilComercial(conta.funis);
  if (!comercial) throw new Error('a conta não tem o funil COMERCIAL');
  const statusPorNome = new Map(comercial.statuses.map((s) => [normalizarNome(s.name), s]));
  const statusPorId = new Map(comercial.statuses.map((s) => [s.id, s]));
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

  // ── sem resposta: conversa não lida há mais de N horas, cartão na entrada ou em EM QUALIFICAÇÃO ──
  try {
    const limite = agoraEpoch - prazos.semRespostaHoras * 3600;
    const todas = [...conversas.entries()]
      .filter(([, t]) => t.is_read === false && t.is_in_work !== false && (t.updated_at ?? 0) <= limite)
      .sort((a, b) => (a[1].updated_at ?? 0) - (b[1].updated_at ?? 0));
    if (todas.length > MAX_NAO_LIDAS) {
      avisos.add('sem-resposta', `Há mais de ${MAX_NAO_LIDAS} conversas não lidas na conta: olhei as que esperam há mais tempo.`);
    }
    const naoLidas = todas.slice(0, MAX_NAO_LIDAS);
    if (naoLidas.length) {
      const ids = naoLidas.map(([id]) => id);
      const [leads, sofia] = await Promise.all([kommo.listLeadsPorIds(ids, { contatos: true }), ultimaFalaDaSofia(unit, ids)]);
      const porId = new Map(leads.map((l) => [l.id, l]));
      for (const [id, t] of naoLidas) {
        const lead = porId.get(id);
        if (!lead || lead.pipeline_id !== comercial.id) continue;
        const status = statusPorId.get(lead.status_id);
        if (!status || !etapaDoSemResposta(status.name, status.type)) continue;
        const pista = regraSemResposta(
          { lida: t.is_read === true, aberta: t.is_in_work !== false, atualizadaEpoch: t.updated_at ?? 0 },
          sofia.get(id) ?? null,
          agora,
          tz,
          prazos,
        );
        if (pista) candidatos.push({ grupo: 'sem-resposta', cartao: cartaoDaFila(lead, status.name), pista });
      }
    }
  } catch (err) {
    avisos.add('sem-resposta', 'O Kommo não respondeu as conversas agora.');
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: falha no "sem resposta"');
  }

  const grupos = montarGrupos(candidatos, prazos);

  // ── telefones só de quem aparece (lotes de 50) ──
  const contatos = grupos.flatMap((g) => g.itens.map((i) => i.cartao.contatoId)).filter((id): id is number => id !== null);
  const telefones = await kommo.telefonesDosContatos(contatos).catch((err) => {
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
            link: `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${c.id}`,
          };
        }),
        ...(aviso ? { aviso } : {}),
      };
    }),
  };
  logger.info(
    { unit: unit.slug, grupos: Object.fromEntries(corpo.grupos.map((g) => [g.id, g.total])), conversasCompletas },
    'ponte fila: montada',
  );
  return corpo;
}

export async function ponteFilaHandler(req: Request, res: Response): Promise<void> {
  const unit = await unidadeDoWidget(req, res, LIMITE_DA_FILA);
  if (!unit) return;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) {
    res.status(409).json({ error: 'unidade sem Kommo conectado' });
    return;
  }
  // a fila é da CONTA: unidades que dividem o Kommo (comercial e resgate) veem a mesma
  const conta = unit.kommoSubdomain.trim().toLowerCase();
  const guardada = cache.get(conta);
  if (guardada && Date.now() - guardada.em < PRAZOS_DA_FILA.cacheMs) {
    res.json({ ...guardada.corpo, unidade: unit.name, cache: true });
    return;
  }
  try {
    let p = emAndamento.get(conta);
    if (!p) {
      p = montarFila(unit)
        .then((corpo) => {
          cache.set(conta, { em: Date.now(), corpo });
          return corpo;
        })
        .finally(() => emAndamento.delete(conta));
      emAndamento.set(conta, p);
    }
    res.json({ ...(await p), unidade: unit.name, cache: false });
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'ponte fila: falha ao montar');
    res.status(502).json({ error: 'kommo indisponível' });
  }
}
