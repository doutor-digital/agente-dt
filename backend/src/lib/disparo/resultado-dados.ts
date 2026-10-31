/**
 * Lê o mundo para o resultado de uma onda (`resultado.ts` faz as contas): nosso banco, as tabelas de custo da Meta
 * (`whatsapp_template_daily`, `whatsapp_cost_daily`, gravadas pelo sync diário), o Kommo e a franquia. SÓ LEITURA: não chama a
 * Meta (lê o que o sync gravou), não escreve em lugar nenhum e não toca no envio.
 *
 * O que é caro (Kommo, franquia, câmbio) fica em cache de poucos minutos por onda; o resto vem do banco a cada abertura.
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { createKommoClient } from '../../services/kommo.service.js';
import { searchSchedules, somarDias } from '../../services/spine.service.js';
import { cotacaoDoDolar } from '../campanha/coleta.js';
import { dataLocalISO } from '../feriados.js';
import { fusoDaUnidade } from '../fuso.js';
import { credenciaisDaUnidade, urlDaGraph } from '../whatsapp-meta.js';
import { freiosDoAmbiente } from './freios.js';
import { modoDaUnidade } from './modo.js';
import { motivoSemNumero } from './painel.js';
import {
  atribuirMeta, contarAgendaram, contarResponderam, mensagensPorCartao, umaLinhaPorDia, custoDaOnda, diasDosEnvios, enviosPorHora, funilDoBanco,
  type AgendamentoNaFranquia,
} from './resultado.js';

export const CACHE_MS = 5 * 60_000;
/** Falha não fica 5 minutos presa na tela, mas também não deixa cada abertura martelar o Kommo/franquia. */
export const CACHE_DA_FALHA_MS = 60_000;
/** A API da franquia recusa intervalo maior que 100 dias; 90 de folga (ver `franquia.ts`). */
const DIAS_DE_AGENDA = 90;

export interface Resultado {
  onda: { id: string; estado: string; unidade: string; unidadeNome: string; campanha: string; campanhaNome: string; etiqueta: string; aprovadaEm: string | null; aprovadaPor: string | null; pausaMotivo: string | null };
  funil: {
    selecionados: number; enviados: number; falhas: number; pendentes: number; saiu: number; descartados: number;
    entregues: number | null; lidas: number | null; responderam: number | null; agendaram: number | null;
  };
  custo: { usd: number | null; brl: number | null; porResposta: number | null; porAgendamento: number | null; atualizadoEm: string | null };
  porHora: Array<{ hora: string; enviados: number }>;
  freios: { janela: string; tetoPorHora: number; tetoPorDia: number; maxSair: number; enviadosUltimaHora: number; enviadosUltimas24h: number };
  fontes: {
    entregues: 'meta-template-analytics' | 'indisponivel';
    custo: 'meta-pricing-analytics' | 'indisponivel';
    responderam: 'kommo' | 'indisponivel';
    agendaram: 'franquia' | 'indisponivel';
    /** de onde veio o dólar do `brl`; 'indisponivel' = o custo vem só em US$ */
    cambio: 'awesomeapi' | 'indisponivel';
    /** quando a Meta atualizou pela última vez as linhas de entregues/lidas (a mais antiga delas); null se indisponível */
    entreguesAtualizadoEm: string | null;
    /** quando o que é caro (Kommo, franquia, câmbio, Meta) foi lido; fica em cache por alguns minutos */
    atualizadoEm: string;
    /** por que um número ficou `null`, ou o limite de um número que veio (ex.: "limite inferior"); null = sem ressalva */
    notas: { entregues: string | null; custo: string | null; responderam: string | null; agendaram: string | null };
  };
  atualizadoEm: string;
}

export interface Externos {
  responderam: number | null;
  agendaram: number | null;
  cambio: number | null;
  /** categoria do modelo na Meta (MARKETING, UTILITY…); null = não deu para saber */
  categoriaDoModelo: string | null;
  notaResponderam: string | null;
  notaAgendaram: string | null;
  lidoEm: Date;
}

export interface PessoaEnviada {
  kommoLeadId: number | null;
  nomeCompleto: string | null;
  enviadoEm: Date;
}

/** As leituras lentas, trocáveis no teste. */
export interface Leituras {
  agora: () => Date;
  cambio: () => Promise<number | null>;
  /** hora (epoch s) de cada mensagem RECEBIDA, por cartão, desde `desdeEpoch`. Lança se o Kommo falhar. */
  mensagensRecebidas: (unit: Unit, leadIds: number[], desdeEpoch: number) => Promise<Map<number, number[]>>;
  /** a categoria do modelo na Meta (uma consulta pequena, filtrada pelo nome); null se não deu para saber */
  categoriaDoModelo: (unit: Unit, template: string, idioma: string) => Promise<string | null>;
  /** a agenda da franquia no intervalo, ou null se não deu para ler por inteiro (falha ou cortada no teto) */
  agenda: (unit: Unit, de: string, ate: string) => Promise<AgendamentoNaFranquia[] | null>;
}

export const LEITURAS_DE_VERDADE: Leituras = {
  agora: () => new Date(),
  cambio: cotacaoDoDolar,
  mensagensRecebidas: async (unit, leadIds, desdeEpoch) => {
    const kommo = createKommoClient(unit);
    const cartoes = await kommo.listLeadsPorIds(leadIds, { contatos: true });
    const contatoDoCartao = new Map<number, number>();
    for (const l of cartoes) {
      const c = l._embedded?.contacts?.find((x) => x.is_main) ?? l._embedded?.contacts?.[0];
      if (c) contatoDoCartao.set(l.id, c.id);
    }
    const contatos = [...new Set(contatoDoCartao.values())];
    return mensagensPorCartao(contatoDoCartao, await kommo.eventosDeChat(contatos, desdeEpoch));
  },
  categoriaDoModelo: async (unit, template, idioma) => {
    const cred = credenciaisDaUnidade(unit);
    const waba = unit.metaWabaId?.trim();
    if (!cred || !waba) return null;
    try {
      const r = await fetch(urlDaGraph(`${waba}/message_templates?name=${encodeURIComponent(template)}&fields=name,language,category&limit=50`), { headers: { Authorization: `Bearer ${cred.token}` }, signal: AbortSignal.timeout(15_000) });
      const corpo = (await r.json().catch(() => null)) as { data?: Array<{ name?: string; language?: string; category?: string }> } | null;
      if (!r.ok || !Array.isArray(corpo?.data)) return null;
      const c = corpo.data.find((m) => m.name === template && m.language === idioma)?.category;
      return typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : null;
    } catch {
      return null;
    }
  },
  agenda: async (unit, de, ate) => {
    const r = await searchSchedules(unit, { initialDate: de, endDate: ate, rowsPerPage: 100 });
    if (!r.ok || !r.data || r.data.truncada) return null;
    return r.data.schedules;
  },
};

/** Kommo, franquia e câmbio. Cada fonte falha sozinha: uma fora do ar não derruba as outras. */
export async function lerExternos(unit: Unit, pessoas: ReadonlyArray<PessoaEnviada>, l: Leituras, modelo: { template: string; idioma: string }): Promise<Externos> {
  const out: Externos = { responderam: null, agendaram: null, cambio: null, categoriaDoModelo: null, notaResponderam: null, notaAgendaram: null, lidoEm: l.agora() };
  out.cambio = await l.cambio().catch(() => null);
  out.categoriaDoModelo = await l.categoriaDoModelo(unit, modelo.template, modelo.idioma).catch(() => null);
  if (pessoas.length === 0) {
    out.notaResponderam = out.notaAgendaram = 'ninguém recebeu ainda';
    return out;
  }
  const primeiro = new Date(Math.min(...pessoas.map((p) => p.enviadoEm.getTime())));

  const comCartao = pessoas.filter((p): p is PessoaEnviada & { kommoLeadId: number } => p.kommoLeadId !== null);
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) out.notaResponderam = 'unidade sem Kommo configurado';
  else if (comCartao.length === 0) out.notaResponderam = 'nenhum destinatário tem cartão no Kommo';
  else {
    try {
      const entradas = await l.mensagensRecebidas(unit, [...new Set(comCartao.map((p) => p.kommoLeadId))], Math.floor(primeiro.getTime() / 1000));
      out.responderam = contarResponderam(comCartao.map((p) => ({ leadId: p.kommoLeadId, enviadoEm: p.enviadoEm })), entradas);
      const sem = pessoas.length - comCartao.length;
      if (sem > 0) out.notaResponderam = `limite inferior: ${sem} destinatário(s) sem cartão no Kommo não entram na conta`;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'disparo/resultado: não consegui ler as respostas no Kommo');
      out.notaResponderam = 'o Kommo não respondeu';
    }
  }

  if (!unit.spineToken) out.notaAgendaram = 'unidade sem token da franquia';
  else {
    try {
      const de = dataLocalISO(primeiro, fusoDaUnidade(unit));
      const agenda = await l.agenda(unit, de, somarDias(de, DIAS_DE_AGENDA));
      if (!agenda) out.notaAgendaram = 'a agenda da franquia não veio por inteiro (falha ou cortada no teto de páginas)';
      else {
        const { agendaram, semConferir } = contarAgendaram(pessoas, agenda);
        out.agendaram = agendaram;
        out.notaAgendaram = `limite inferior: casa pelo nome inteiro na agenda de avaliações, até ${DIAS_DE_AGENDA} dias depois do 1º envio, e supõe que quem já tinha consulta futura foi barrado no envio${semConferir ? `; ${semConferir} pessoa(s) sem nome e sobrenome ou com nome repetido na onda ficaram sem conferir` : ''}`;
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'disparo/resultado: não consegui ler a agenda da franquia');
      out.notaAgendaram = 'a franquia não respondeu';
    }
  }
  return out;
}

// ── cache por onda ─────────────────────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, { ate: number; valor: Promise<Externos> }>();

/** Só para o teste. */
export function _limparCache(): void {
  cache.clear();
}

function externosEmCache(ondaId: string, agora: number, ler: () => Promise<Externos>): Promise<Externos> {
  for (const [k, v] of cache) if (v.ate <= agora) cache.delete(k);
  const guardado = cache.get(ondaId);
  if (guardado) return guardado.valor;
  const valor = ler();
  const entrada = { ate: agora + CACHE_MS, valor };
  cache.set(ondaId, entrada);
  // Quem falhou em alguma fonte fica pouco tempo; e a leitura que estoura é descartada (a próxima tenta de novo).
  valor.then(
    (e) => {
      if (e.responderam === null || e.agendaram === null || e.cambio === null || e.categoriaDoModelo === null) entrada.ate = Math.min(entrada.ate, agora + CACHE_DA_FALHA_MS);
    },
    () => cache.delete(ondaId),
  );
  return valor;
}

// ── a leitura inteira ──────────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ESTADOS_QUE_RECEBERAM = ['enviado', 'saiu'];

export async function lerResultado(ondaId: string, l: Leituras = LEITURAS_DE_VERDADE): Promise<Resultado | null> {
  const onda = await prisma.disparoOnda.findUnique({ where: { id: ondaId }, include: { unit: true, campanha: { select: { slug: true, nome: true } } } });
  if (!onda) return null;
  const agora = l.agora();
  const unit = onda.unit;
  const freios = freiosDoAmbiente();

  const [porEstado, saiuQueRecebeu, recebidos, incertos, horas] = await Promise.all([
    prisma.disparoDestinatario.groupBy({ by: ['estado'], where: { ondaId }, _count: true }),
    prisma.disparoDestinatario.count({ where: { ondaId, estado: 'saiu', enviadoEm: { not: null } } }),
    prisma.disparoDestinatario.aggregate({ where: { ondaId, estado: { in: ESTADOS_QUE_RECEBERAM }, enviadoEm: { not: null } }, _count: true, _min: { enviadoEm: true }, _max: { enviadoEm: true } }),
    // `falhou` COM hora de envio e `enviando` (reivindicado, hora gravada, sem resposta da Meta ainda): a Meta pode ter aceitado.
    prisma.disparoDestinatario.count({ where: { ondaId, estado: { in: ['falhou', 'enviando'] }, enviadoEm: { not: null } } }),
    prisma.disparoDestinatario.findMany({ where: { ondaId, estado: { in: ESTADOS_QUE_RECEBERAM }, enviadoEm: { not: null } }, select: { enviadoEm: true } }),
  ]);
  const funil = funilDoBanco(Object.fromEntries(porEstado.map((g) => [g.estado, g._count])), saiuQueRecebeu);

  // Os tetos são do NÚMERO de WhatsApp: as unidades que dividem o número somam (como em `porto.contarNaJanela`).
  const doMesmoNumero = unit.metaPhoneNumberId?.trim()
    ? (await prisma.unit.findMany({ where: { metaPhoneNumberId: unit.metaPhoneNumberId.trim() }, select: { id: true } })).map((u) => u.id)
    : [unit.id];
  const campoDaJanela = modoDaUnidade(unit.slug) === 'ligado' ? 'enviadoEm' : 'simuladoEm';
  const naJanela = (desde: Date) => prisma.disparoDestinatario.count({ where: { unitId: { in: doMesmoNumero }, [campoDaJanela]: { gte: desde } } });
  const [naUltimaHora, nasUltimas24h] = await Promise.all([naJanela(new Date(agora.getTime() - 3_600_000)), naJanela(new Date(agora.getTime() - 86_400_000))]);

  // Kommo, franquia e câmbio: o caro. Em cache por onda.
  const externos = await externosEmCache(ondaId, agora.getTime(), async () => {
    const pessoas = await prisma.disparoDestinatario.findMany({
      where: { ondaId, estado: { in: ESTADOS_QUE_RECEBERAM }, enviadoEm: { not: null } },
      select: { kommoLeadId: true, nomeCompleto: true, enviadoEm: true },
    });
    return lerExternos(unit, pessoas.map((p) => ({ kommoLeadId: p.kommoLeadId, nomeCompleto: p.nomeCompleto, enviadoEm: p.enviadoEm! })), l, { template: onda.template, idioma: onda.idioma });
  });

  // Meta: entregue/lida/custo por dia e por modelo, atribuídos só quando a conta fecha (ver `atribuirMeta`).
  const primeiro = recebidos._min.enviadoEm;
  const ultimo = recebidos._max.enviadoEm;
  let meta = atribuirMeta({ confirmados: 0, incertos: 0, deOutrasOndas: 0, deOutrasOndasDoModelo: 0 }, [], []);
  if (primeiro && ultimo) {
    const { de, ate, fimExclusivo } = diasDosEnvios(primeiro, ultimo);
    const daConta = unit.metaWabaId
      ? (await prisma.unit.findMany({ where: { metaWabaId: unit.metaWabaId }, select: { id: true } })).map((u) => u.id)
      : [unit.id];
    const deOutras = { unitId: { in: [...new Set([unit.id, ...daConta])] }, ondaId: { not: ondaId }, enviadoEm: { gte: de, lt: fimExclusivo } };
    const [deOutrasOndas, doMesmoModelo, linhasDoModelo, linhasDeCusto] = await Promise.all([
      prisma.disparoDestinatario.count({ where: deOutras }),
      // Outro modelo não entra no `sent` deste (a Meta separa por modelo), mas entra no custo (que é por categoria).
      prisma.disparoDestinatario.count({ where: { ...deOutras, onda: { template: onda.template } } }),
      prisma.whatsappTemplateDaily.findMany({
        where: { unitId: unit.id, date: { gte: de, lte: ate }, templateName: onda.template, language: { in: [onda.idioma, ''] } },
        select: { date: true, language: true, sent: true, delivered: true, read: true, syncedAt: true },
      }),
      prisma.whatsappCostDaily.findMany({
        where: { unitId: unit.id, date: { gte: de, lte: ate }, pricingCategory: { startsWith: 'MARKETING', mode: 'insensitive' } },
        select: { pricingCategory: true, volume: true, costUsd: true, syncedAt: true },
      }),
    ]);
    // Tabela vazia para o modelo: a unidade nunca gravou nada (sync parado, token sem escopo) ou só falta o modelo/dia?
    const semNada = {
      template: linhasDoModelo.length === 0 ? (await prisma.whatsappTemplateDaily.count({ where: { unitId: unit.id } })) === 0 : false,
      custo: linhasDeCusto.length === 0 ? (await prisma.whatsappCostDaily.count({ where: { unitId: unit.id } })) === 0 : false,
    };
    meta = atribuirMeta(
      { confirmados: recebidos._count, incertos, deOutrasOndas, deOutrasOndasDoModelo: doMesmoModelo },
      umaLinhaPorDia(linhasDoModelo, onda.idioma),
      linhasDeCusto.map((c) => ({ ...c, costUsd: Number(c.costUsd) })),
      { ...semNada, categoriaDoModelo: externos.categoriaDoModelo },
    );
  }

  const custo = custoDaOnda(meta.custoUsd, externos.cambio, externos.responderam, externos.agendaram);
  const notaDoCusto = [
    meta.notaCusto,
    meta.custoUsd !== null && custo.brl === null ? 'câmbio indisponível agora; custo em US$ apenas' : null,
    custo.brl !== null && custo.porResposta === null ? 'sem custo por resposta: ' + (externos.responderam === null ? 'as respostas não foram medidas' : 'ninguém respondeu ainda') : null,
    custo.brl !== null && custo.porAgendamento === null ? 'sem custo por agendamento: ' + (externos.agendaram === null ? 'os agendamentos não foram medidos' : 'nenhum agendamento ainda') : null,
  ].filter((n): n is string => !!n).join('; ') || null;
  return {
    onda: {
      id: onda.id, estado: onda.estado, unidade: unit.slug, unidadeNome: unit.name, campanha: onda.campanha.slug, campanhaNome: onda.campanha.nome, etiqueta: onda.etiqueta,
      aprovadaEm: iso(onda.aprovadaEm), aprovadaPor: onda.aprovadaPor, pausaMotivo: onda.pausaMotivo ? motivoSemNumero(onda.pausaMotivo) : null,
    },
    funil: { ...funil, entregues: meta.entregues, lidas: meta.lidas, responderam: externos.responderam, agendaram: externos.agendaram },
    custo: { ...custo, atualizadoEm: iso(meta.custoAtualizadoEm) },
    porHora: enviosPorHora(horas.map((h) => h.enviadoEm!)),
    freios: {
      janela: `${freios.janelaInicio}h às ${freios.janelaFim}h${freios.soDiasUteis ? ', segunda a sexta, sem feriado nacional' : ''}`,
      tetoPorHora: freios.tetoPorHora, tetoPorDia: freios.tetoPorDia, maxSair: freios.maxSair,
      enviadosUltimaHora: naUltimaHora, enviadosUltimas24h: nasUltimas24h,
    },
    fontes: {
      entregues: meta.entregues === null ? 'indisponivel' : 'meta-template-analytics',
      custo: meta.custoUsd === null ? 'indisponivel' : 'meta-pricing-analytics',
      responderam: externos.responderam === null ? 'indisponivel' : 'kommo',
      agendaram: externos.agendaram === null ? 'indisponivel' : 'franquia',
      cambio: custo.brl === null ? 'indisponivel' : 'awesomeapi',
      entreguesAtualizadoEm: iso(meta.entreguesAtualizadoEm),
      atualizadoEm: externos.lidoEm.toISOString(),
      notas: { entregues: meta.notaEntregues, custo: notaDoCusto, responderam: externos.notaResponderam, agendaram: externos.notaAgendaram },
    },
    atualizadoEm: agora.toISOString(),
  };
}
