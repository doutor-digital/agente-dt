/**
 * A rotina diária dos robôs — o worker (regras puras e a explicação inteira em `rotina-robos.ts`).
 *
 * De 30 em 30 minutos, DENTRO do horário comercial de cada unidade, varre as unidades que têm alguma das três réguas
 * ligada ou em «só no papel» e põe a etiqueta ▶ do degrau da vez. Quem manda a mensagem é o robô do Kommo amarrado à
 * etiqueta; aqui só se decide QUEM, QUANDO e QUAL degrau.
 *
 * FONTE DO "PARADO" (a que o resto do código já usa): o evento `incoming_chat_message` do CONTATO PRINCIPAL no Kommo
 * (`ultimaMensagemDoContatoDesde`, a mesma do `parados` e da ligação pelo WhatsApp) — uma chamada por cartão e janela
 * curta. "Equipe conversando" e "falaram com ele hoje" saem das conversas oficiais (`/talks`, a leitura da perda-ia e
 * do botão «Sugerir motivo»), lidas só do cartão que já passou por tudo o que é barato. O banco do agente entra como
 * peneira de graça: conversa com mensagem nas últimas 24 h não chega a gastar chamada.
 *
 * ORDEM DAS CONFERÊNCIAS (do barato ao caro): o próprio cartão (etiquetas, opt-out, motivo morto, Pausar IA, ◷ Retomar
 * em, consulta futura) → banco (conversa recente, marcas) → evento de mensagem do paciente (1 chamada) → o degrau da vez
 * → conversa oficial → franquia. O que sobra é relido do Kommo logo antes de escrever.
 *
 * A MARCA é um rastro em `execution_traces` por degrau, gravado ANTES da etiqueta: não gravou, não sai. O teto do dia é
 * a contagem dessas marcas — resiste a deploy e a réplica, e soma as TRÊS réguas (a Meta derruba a qualidade do número
 * com disparo em massa; o número é um só).
 *
 * SECO NÃO ESCREVE NADA no Kommo nem marca: só registra «etiquetaria»/«pularia» (tela de Automações) e conta no resumo.
 * Cada régua tem o próprio estado — seco numa, ligada noutra — e o seco de uma nunca abre o caminho da outra.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { fichaDoPaciente } from '../services/spine.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { carregarFunis, idClientDoCartao, type Funis } from './franquia-sync-worker.js';
import { ETAPA, TRATAMENTO_EM_ANDAMENTO } from './franquia-move.js';
import { grupoDaUnidade, pularCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { acharNaConta, etiquetaNoCartao, etiquetasDaConta } from './ponte-etiquetas.js';
import { lerFalasDoCartao } from './conversa-do-cartao.js';
import { franquiaDoPaciente, type NaFranquia } from './parados-worker.js';
import { dentroDoHorario } from './sla-alert-worker.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { hojeNaUnidade } from './espera-retomada.js';
import {
  CHAVE_ANIVERSARIO,
  CHAVE_EXLEAD,
  ENTRADA_EXLEAD_DIAS,
  ETAPAS_DO_EXLEAD,
  ETIQUETAS_EXLEAD,
  ETIQUETAS_RETOMADA,
  ETIQUETA_ANIVERSARIO,
  ETIQUETA_ANIVERSARIO_TRATAMENTO,
  ID_ROTINA_ANIVERSARIO,
  ID_ROTINA_ETAPAS,
  ID_ROTINA_EXLEAD,
  MAX_SILENCIO_ETAPAS_DIAS,
  PREFIXO_DA_MARCA,
  REGUAS_POR_ETAPA,
  aniversarioHoje,
  aniversarioNoDia,
  diaDeNascimentoDaFicha,
  cartaoMostraConsulta,
  configDaUnidade,
  decidirToque,
  idDaMarca,
  lerMarca,
  marcasDoSilencio,
  naJanelaDoAniversario,
  nascimentoDoCartao,
  porQueNaoTocar,
  statusDeFalecido,
  type ConfigDaRotina,
  type MarcaLida,
  type OpcoesDeCartao,
} from './rotina-robos.js';

const SWEEP_MS = Number(process.env.ROTINA_ROBOS_SWEEP_MS) || 30 * 60_000;
const PRIMEIRA_VARREDURA_MS = 10 * 60_000;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const FUNIS_TTL_MS = 10 * 60_000;
const MAX_PAGINAS = 6;
const MAX_PAGINAS_ANIVERSARIO = 12;
/** Cartões que gastam chamada ao Kommo por régua e etapa e varredura: o limitador do Kommo é da rede inteira (lição de 04/11). */
export const MAX_AVALIACOES = Number(process.env.ROTINA_ROBOS_MAX_AVALIACOES) || 40;
const DIA_S = 86_400;
const HORA_S = 3600;
/** Equipe falou há menos que isto = gente com o paciente: a rotina não atravessa. */
export const HORAS_DA_EQUIPE = 48;
/** Qualquer mensagem NOSSA (Sofia, equipe ou robô) há menos que isto = já falaram com ele hoje. */
export const HORAS_DE_QUALQUER_FALA = 24;

export const estadoDasEtapas = (slug: string, raw: string | undefined = process.env.ROTINA_ROBOS_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_ETAPAS, raw);
export const estadoDoExLead = (slug: string, raw: string | undefined = process.env.ROTINA_EXLEAD_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_EXLEAD, raw);
export const estadoDoAniversario = (slug: string, raw: string | undefined = process.env.ROTINA_ANIVERSARIO_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_ANIVERSARIO, raw);

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

// ─── o que cada régua conta ───────────────────────────────────────────────────────────────────────

export interface ResumoDaRegua {
  /** cartões olhados (da etapa ou do universo) */
  lidos: number;
  /** barrados só pelo cartão/banco, sem gastar chamada, por motivo */
  barrados: Record<string, number>;
  /** cartões que gastaram chamada ao Kommo */
  avaliados: number;
  /** degrau → quantos recebem (ligado: receberam) */
  porToque: Record<string, number>;
  esperando: number;
  esgotadas: number;
  foraDaJanela: number;
  /** venceu, mas uma conferência cara (equipe, franquia) ou a conta (etiqueta, gatilho) segurou */
  seguradas: Record<string, number>;
  acimaDoTeto: number;
  erros: number;
}

const resumoNovo = (): ResumoDaRegua => ({ lidos: 0, barrados: {}, avaliados: 0, porToque: {}, esperando: 0, esgotadas: 0, foraDaJanela: 0, seguradas: {}, acimaDoTeto: 0, erros: 0 });
const conta = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);

/** Quanto cabe hoje e nesta varredura: UM contador para as três réguas. */
interface Teto {
  restanteHoje: number;
  restanteNaVarredura: number;
}

export interface Ctx {
  unit: Unit;
  kommo: Pick<KommoClient, 'listLeadsPorEtapa' | 'ultimaMensagemDoContatoDesde' | 'listTalks' | 'listTalkMessages' | 'getLead' | 'addTag' | 'removeTag' | 'addLeadNote'>;
  funis: Funis;
  grupo: GrupoDoCrm | null;
  agora: number;
  tz: string;
  cfg: ConfigDaRotina;
  pausarIaFieldId: number | null;
  /** as etiquetas de cartão que a CONTA tem — o `tags_to_add` do Kommo CRIA a que não existe */
  tagsDaConta: readonly string[];
  teto: Teto;
  franquia?: (unit: Unit, leadId: number, nome: string | null, agora: number) => Promise<NaFranquia>;
  ficha?: typeof fichaDoPaciente;
}

// ─── cache em memória: o que já foi olhado não volta a gastar chamada até a hora em que pode mudar ──

const vistoAte = new Map<string, number>();
function jaVisto(unitId: string, regua: string, leadId: number, agora: number): boolean {
  const k = `${unitId}:${regua}:${leadId}`;
  const ate = vistoAte.get(k);
  if (ate !== undefined && ate > agora) return true;
  if (ate !== undefined) vistoAte.delete(k);
  return false;
}
function marcarVisto(unitId: string, regua: string, leadId: number, ateEpoch: number): void {
  if (vistoAte.size > 50_000) {
    const agora = Math.floor(Date.now() / 1000);
    for (const [k, v] of vistoAte) if (v <= agora) vistoAte.delete(k);
  }
  vistoAte.set(`${unitId}:${regua}:${leadId}`, ateEpoch);
}
/** Para o teste começar limpo. */
export function _limparCacheDaRotina(): void {
  vistoAte.clear();
  funisCache.clear();
  aniversariantes.clear();
}

const funisCache = new Map<string, { em: number; funis: Funis }>();
async function funisDaConta(unit: Unit, kommo: KommoClient): Promise<Funis | null> {
  const hit = funisCache.get(unit.id);
  if (hit && Date.now() - hit.em < FUNIS_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo);
  if (funis) funisCache.set(unit.id, { em: Date.now(), funis });
  return funis;
}

// ─── banco: marcas, teto do dia, conversa recente ─────────────────────────────────────────────────

/** Marcas (de todas as réguas) dos cartões, dos últimos `dias` dias. */
async function marcasDosCartoes(unitId: string, leadIds: number[], agora: number, dias: number): Promise<Map<number, MarcaLida[]>> {
  const mapa = new Map<number, MarcaLida[]>();
  if (leadIds.length === 0) return mapa;
  const linhas = await prisma.executionTrace.findMany({
    where: { unitId, leadId: { in: leadIds.map(String) }, id: { startsWith: PREFIXO_DA_MARCA }, createdAt: { gte: new Date((agora - dias * DIA_S) * 1000) } },
    select: { id: true, leadId: true, createdAt: true },
  });
  for (const l of linhas) {
    const leadId = Number(l.leadId);
    const m = lerMarca(l.id, leadId, l.createdAt);
    if (m) mapa.set(leadId, [...(mapa.get(leadId) ?? []), m]);
  }
  return mapa;
}

/** Marcas de HOJE (dia local da unidade), com o cartão: dá o teto do dia e a regra "não junto com outro toque no mesmo dia". */
async function marcasDeHoje(unit: Unit, agora: number, tz: string): Promise<Array<{ leadId: number; id: string }>> {
  const linhas = await prisma.executionTrace.findMany({
    where: { unitId: unit.id, id: { startsWith: PREFIXO_DA_MARCA }, createdAt: { gte: new Date((agora - 48 * HORA_S) * 1000) } },
    select: { id: true, leadId: true, createdAt: true },
  });
  const hoje = hojeNaUnidade(agora, tz);
  return linhas.filter((l) => hojeNaUnidade(Math.floor(l.createdAt.getTime() / 1000), tz) === hoje).map((l) => ({ leadId: Number(l.leadId), id: l.id }));
}

/** Toques de OUTROS robôs hoje (etiquetas-auto) no mesmo cartão também contam para "não junto com outro toque". */
async function toquesDoEtiquetasAutoHoje(unitId: string, leadIds: number[], agora: number, tz: string): Promise<Set<number>> {
  if (leadIds.length === 0) return new Set();
  const linhas = await prisma.executionTrace.findMany({
    where: { unitId, leadId: { in: leadIds.map(String) }, id: { startsWith: 'etiqueta-' }, createdAt: { gte: new Date((agora - 48 * HORA_S) * 1000) } },
    select: { leadId: true, createdAt: true },
  });
  const hoje = hojeNaUnidade(agora, tz);
  return new Set(linhas.filter((l) => hojeNaUnidade(Math.floor(l.createdAt.getTime() / 1000), tz) === hoje).map((l) => Number(l.leadId)));
}

async function ultimasMensagensNoBanco(unitId: string, leadIds: number[]): Promise<Map<number, number>> {
  if (leadIds.length === 0) return new Map();
  const linhas = await prisma.conversation.findMany({
    where: { unitId, leadId: { in: leadIds.map(String) } },
    select: { leadId: true, lastMessageAt: true },
  });
  return new Map(linhas.map((l) => [Number(l.leadId), Math.floor(l.lastMessageAt.getTime() / 1000)]));
}

// ─── pôr a etiqueta (o único caminho de escrita) ──────────────────────────────────────────────────

interface Toque {
  lead: KommoLead;
  /** o id da automação (a tela mostra por régua) */
  automacao: string;
  /** a régua dentro do id da marca */
  chave: string;
  toque: number;
  etiqueta: string;
  /** a última mensagem do paciente (epoch s) — ou o ano, no aniversário */
  tp: number;
  /** quem leva a marca: o cartão, ou a pessoa (aniversário: o contato, para 2 cartões da mesma pessoa não receberem 2) */
  quem: number | string;
  etapa: string;
  motivo: string;
  /** depois de reler o cartão, ainda vale? `null` = sim */
  aindaVale: (fresco: KommoLead) => string | null;
}

type Resultado = 'ok' | 'teto' | 'sem-etiqueta' | 'segurou' | 'falhou';

async function gravarMarca(unit: Unit, t: Toque): Promise<boolean> {
  const id = idDaMarca(unit.id, t.quem, t.chave, t.toque, t.tp);
  try {
    await prisma.executionTrace.create({
      data: {
        id,
        unitId: unit.id,
        leadId: String(t.lead.id),
        threadId: id,
        input: { origem: t.automacao },
        channel: 'manual',
        status: 'SUCCESS',
        steps: { create: { sequence: 0, kind: 'KOMMO_ACTION', title: `ROTINA · ${t.etiqueta} — ${t.motivo}`, payload: { leadId: t.lead.id, etiqueta: t.etiqueta, chave: t.chave, toque: t.toque, motivo: t.motivo } } },
      },
    });
    return true;
  } catch (err) {
    logger.warn({ err: String(err), leadId: t.lead.id, chave: t.chave, toque: t.toque }, 'rotina: não gravei a marca — etiqueta não sai');
    return false;
  }
}

async function soltarMarca(unit: Unit, t: Toque): Promise<void> {
  await prisma.executionTrace.delete({ where: { id: idDaMarca(unit.id, t.quem, t.chave, t.toque, t.tp) } }).catch(() => undefined);
}

/**
 * Põe (ou, no seco, só registra) um toque. Confere a conta, o teto e o cartão fresco; grava a marca ANTES; se a etiqueta
 * não sair, solta a marca. Devolve o que aconteceu para o resumo.
 */
export async function tocar(ctx: Ctx, seco: boolean, t: Toque, r: ResumoDaRegua): Promise<Resultado> {
  const { unit, kommo } = ctx;
  const alvo = `${t.toque}º toque · ${t.etiqueta}`;
  const noPapel = (acao: 'etiquetaria' | 'pularia', motivo: string) => registrarSimulacao(unit, t.automacao, { leadId: t.lead.id, acao, alvo, deEtapa: t.etapa, valor: t.toque, motivo });

  // etiqueta que a conta não tem: não faz nada (o `tags_to_add` criaria uma etiqueta solta, sem robô)
  const daConta = acharNaConta(t.etiqueta, [...ctx.tagsDaConta]);
  if (!daConta) {
    conta(r.seguradas, 'sem-etiqueta-na-conta');
    if (seco) noPapel('pularia', `a conta não tem a etiqueta ${t.etiqueta}`);
    return 'sem-etiqueta';
  }
  if (ctx.teto.restanteHoje <= 0 || (!seco && ctx.teto.restanteNaVarredura <= 0)) {
    r.acimaDoTeto++;
    if (seco) noPapel('pularia', `teto do dia (${ctx.cfg.teto}): sairia amanhã`);
    return 'teto';
  }
  if (seco) {
    ctx.teto.restanteHoje--;
    conta(r.porToque, String(t.toque));
    noPapel('etiquetaria', t.motivo);
    return 'ok';
  }

  // a conversa levou segundos: relê o cartão e confere de novo antes de escrever
  const fresco = await kommo.getLead(t.lead.id);
  const razao = t.aindaVale(fresco);
  if (razao) {
    conta(r.seguradas, 'mudou-antes-de-escrever');
    logger.info({ unit: unit.slug, leadId: t.lead.id, razao }, 'rotina: o cartão mudou enquanto eu conferia — não pus');
    return 'segurou';
  }
  if (!(await gravarMarca(unit, t))) return 'falhou';
  try {
    // o gatilho é "etiqueta ADICIONADA": se a do ciclo anterior ainda está lá, tira antes (mesmo desenho do `etiquetas-auto`)
    const jaTem = etiquetaNoCartao(daConta, (fresco._embedded?.tags ?? []).map((x) => x.name));
    if (jaTem) await kommo.removeTag(t.lead.id, jaTem);
    await kommo.addTag({ leadId: t.lead.id, tag: daConta });
  } catch (err) {
    await soltarMarca(unit, t);
    r.erros++;
    logger.warn({ err: String(err), unit: unit.slug, leadId: t.lead.id, etiqueta: daConta }, 'rotina: falha ao pôr a etiqueta — soltei a marca');
    return 'falhou';
  }
  ctx.teto.restanteHoje--;
  ctx.teto.restanteNaVarredura--;
  conta(r.porToque, String(t.toque));
  await kommo.addLeadNote(t.lead.id, `🤖 Rotina diária: etiqueta ${daConta} (${t.toque}º toque) — ${t.motivo}.`).catch(() => undefined);
  logger.info({ unit: unit.slug, leadId: t.lead.id, etiqueta: daConta, toque: t.toque, regua: t.chave }, 'rotina: etiqueta posta');
  await pausa();
  return 'ok';
}

// ─── as duas réguas de silêncio (etapas e ex-lead) usam o mesmo motor ─────────────────────────────

const contatoPrincipal = (l: KommoLead): number | null => {
  const cs = l._embedded?.contacts ?? [];
  return (cs.find((c) => c.is_main) ?? cs[0])?.id ?? null;
};

interface ParamsDoSilencio {
  automacao: string;
  chave: string;
  etapa: string;
  dias: readonly number[];
  etiquetas: readonly string[];
  prontos: number;
  entradaAteDias: number;
  /** quantos dias para trás procurar a última mensagem do paciente */
  janelaOlhadaDias: number;
  opcoesDoCartao: Partial<OpcoesDeCartao>;
  /** só do ex-lead: quem já teve consulta no cartão ou na franquia não é ex-lead */
  soQuemNuncaAgendou: boolean;
  /** marcas de outras fontes que valem como degrau já enviado (a Reativação do `etiquetas-auto`) */
  marcasExtras?: (ctx: Ctx, leads: KommoLead[]) => Promise<Map<number, MarcaLida[]>>;
}

export async function varrerSilencio(ctx: Ctx, seco: boolean, p: ParamsDoSilencio, leads: KommoLead[], r: ResumoDaRegua): Promise<void> {
  const { unit, kommo, agora, tz } = ctx;
  r.lidos += leads.length;
  const opcoes: OpcoesDeCartao = { agora, tz, pausarIaFieldId: ctx.pausarIaFieldId, ...p.opcoesDoCartao };

  // 1) o cartão, de graça
  let fila: KommoLead[] = [];
  for (const lead of leads) {
    if (pularCartao(ctx.grupo, unit.id, lead, {})) continue; // Kommo dividido: só os cartões desta unidade
    if (jaVisto(unit.id, p.chave, lead.id, agora)) continue;
    const razao = porQueNaoTocar(lead, opcoes);
    if (razao) {
      conta(r.barrados, razao.codigo);
      continue;
    }
    // no dia do aniversário o cartão é do toque de aniversário: nada de retomada junto
    if (aniversarioHoje(nascimentoDoCartao(lead), agora, tz)) {
      conta(r.barrados, 'aniversario-hoje');
      continue;
    }
    if (p.soQuemNuncaAgendou && cartaoMostraConsulta(lead)) {
      conta(r.barrados, 'ja-teve-consulta-no-cartao');
      marcarVisto(unit.id, p.chave, lead.id, agora + 7 * DIA_S);
      continue;
    }
    fila.push(lead);
  }

  // 2) o banco, de graça: conversa com mensagem nas últimas 24 h não é esquecida; marcas dizem em que degrau está
  const ids = fila.map((l) => l.id);
  const [ultimas, marcas, extras, hojeAutoTouch] = await Promise.all([
    ultimasMensagensNoBanco(unit.id, ids),
    marcasDosCartoes(unit.id, ids, agora, 200),
    p.marcasExtras ? p.marcasExtras(ctx, fila) : Promise.resolve(new Map<number, MarcaLida[]>()),
    toquesDoEtiquetasAutoHoje(unit.id, ids, agora, tz),
  ]);
  const hoje = new Set((await marcasDeHoje(unit, agora, tz)).map((m) => m.leadId));
  fila = fila.filter((lead) => {
    if (hoje.has(lead.id) || hojeAutoTouch.has(lead.id)) {
      conta(r.barrados, 'ja-recebeu-toque-hoje');
      return false;
    }
    const ultima = ultimas.get(lead.id);
    if (ultima !== undefined && agora - ultima < HORA_S * HORAS_DE_QUALQUER_FALA) {
      conta(r.barrados, 'conversa-nas-ultimas-24h');
      return false;
    }
    // régua toda enviada e ninguém falou depois do último degrau: acabou, sem gastar chamada
    const dela = (marcas.get(lead.id) ?? []).filter((m) => m.chave === p.chave);
    const ultimoEm = dela.reduce((m, x) => Math.max(m, x.em), 0);
    if (dela.some((m) => m.toque >= p.dias.length) && (ultima === undefined || ultima <= ultimoEm)) {
      r.esgotadas++;
      marcarVisto(unit.id, p.chave, lead.id, agora + 12 * HORA_S);
      return false;
    }
    return true;
  });
  fila.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  // 3) o caro, no teto: a mensagem do paciente (1 chamada), o degrau da vez, a conversa, a franquia
  let leituras = 0;
  for (const lead of fila) {
    if (leituras >= MAX_AVALIACOES) break;
    if (!seco && ctx.teto.restanteNaVarredura <= 0) break;
    const contato = contatoPrincipal(lead);
    if (contato === null) {
      conta(r.barrados, 'sem-contato');
      continue;
    }
    leituras++;
    r.avaliados++;
    try {
      const tp = await kommo.ultimaMensagemDoContatoDesde(contato, agora - p.janelaOlhadaDias * DIA_S);
      const dosCartao = [...(marcas.get(lead.id) ?? []), ...(extras.get(lead.id) ?? [])];
      const d = decidirToque({
        agora,
        dias: p.dias,
        etiquetas: p.etiquetas,
        prontos: p.prontos,
        ultimaDoPaciente: tp,
        marcas: tp === null ? [] : marcasDoSilencio(dosCartao, p.chave, tp),
        entradaAteDias: p.entradaAteDias,
      });
      if (d.tipo === 'fora') {
        r.foraDaJanela++;
        marcarVisto(unit.id, p.chave, lead.id, agora + DIA_S);
        continue;
      }
      if (d.tipo === 'esgotada') {
        r.esgotadas++;
        marcarVisto(unit.id, p.chave, lead.id, agora + 12 * HORA_S);
        continue;
      }
      if (d.tipo === 'espera') {
        r.esperando++;
        marcarVisto(unit.id, p.chave, lead.id, d.ate ?? agora + 6 * HORA_S);
        continue;
      }
      const alvo = `${d.toque}º toque · ${d.etiqueta}`;
      if (d.tipo === 'sem-gatilho') {
        conta(r.seguradas, 'sem-gatilho-confirmado');
        if (seco) registrarSimulacao(unit, p.automacao, { leadId: lead.id, acao: 'pularia', alvo, deEtapa: p.etapa, valor: d.toque, motivo: `o ${d.toque}º degrau ainda não tem robô e gatilho confirmados nesta conta (rotina_toques_prontos)` });
        marcarVisto(unit.id, p.chave, lead.id, agora + 6 * HORA_S);
        continue;
      }

      // venceu: agora as conferências que custam chamada. Qualquer uma que segure registra o motivo (no seco, na tela).
      const segura = async (codigo: string, motivo: string, horas = 6) => {
        conta(r.seguradas, codigo);
        if (seco) registrarSimulacao(unit, p.automacao, { leadId: lead.id, acao: 'pularia', alvo, deEtapa: p.etapa, valor: d.toque, motivo });
        marcarVisto(unit.id, p.chave, lead.id, agora + horas * HORA_S);
      };
      if (await leadPausadoPorJanela(unit.id, lead.id)) {
        await segura('lead-pausado', 'a recepção pausou este cartão');
        continue;
      }
      const { falas } = await lerFalasDoCartao(kommo, lead.id, { maxTalks: 2 });
      const equipe = falas.some((f) => f.autor === 'EQUIPE' && (f.em ?? 0) >= agora - HORAS_DA_EQUIPE * HORA_S);
      if (equipe) {
        await segura('equipe-conversando', `a equipe falou com o paciente nas últimas ${HORAS_DA_EQUIPE} h`);
        continue;
      }
      if (falas.some((f) => f.autor !== 'PACIENTE' && (f.em ?? 0) >= agora - HORAS_DE_QUALQUER_FALA * HORA_S)) {
        await segura('falaram-hoje', `já falaram com o paciente nas últimas ${HORAS_DE_QUALQUER_FALA} h`);
        continue;
      }
      if (falas.some((f) => f.autor === 'PACIENTE' && (f.em ?? 0) > (tp ?? 0))) {
        await segura('paciente-escreveu', 'o paciente escreveu agora há pouco');
        continue;
      }
      const f = await (ctx.franquia ?? franquiaDoPaciente)(unit, lead.id, lead.name ?? null, agora);
      if (f.consultaFutura || f.emAndamento) {
        await segura('franquia-segura', f.emAndamento ? 'tratamento em andamento na franquia' : 'consulta futura na franquia', 12);
        continue;
      }
      if (p.soQuemNuncaAgendou && f.temHistorico) {
        await segura('ja-agendou-na-franquia', 'a franquia tem agendamento ou tratamento deste paciente: não é ex-lead', 24 * 7);
        continue;
      }

      const aindaVale = (fresco: KommoLead): string | null => {
        if (fresco.status_id !== lead.status_id || fresco.pipeline_id !== lead.pipeline_id) return 'mudou de etapa';
        const razao = porQueNaoTocar(fresco, { ...opcoes, agora: Math.floor(Date.now() / 1000) });
        return razao ? razao.texto : null;
      };
      const motivo = d.atrasado
        ? `${d.silencioDias} dias sem o paciente escrever (pelo calendário já passou do prazo; entra pelo ${d.toque}º degrau)`
        : `${d.silencioDias} dias sem o paciente escrever em ${p.etapa}`;
      const res = await tocar(ctx, seco, { lead, automacao: p.automacao, chave: p.chave, toque: d.toque, etiqueta: d.etiqueta, tp: tp as number, quem: lead.id, etapa: p.etapa, motivo, aindaVale }, r);
      if (res === 'teto' && !seco) break;
      if (res === 'ok' || res === 'segurou') marcarVisto(unit.id, p.chave, lead.id, agora + 6 * HORA_S);
    } catch (err) {
      r.erros++;
      // erro do Kommo ou da franquia num cartão: pula o cartão, nunca vira "pode mandar"
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, regua: p.chave }, 'rotina: erro num cartão — pulei');
    }
  }
}

async function cartoesDaEtapa(kommo: Ctx['kommo'], alvo: { pipelineId: number; statusId: number }): Promise<KommoLead[]> {
  const out: KommoLead[] = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const pag = await kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true, 'desc');
    out.push(...pag);
    if (pag.length < 250) break;
  }
  return out;
}

/** Régua 1: esquecidos por etapa. */
export async function varrerEtapas(ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>): Promise<void> {
  if (!acharNaConta(ETIQUETAS_RETOMADA[0], [...ctx.tagsDaConta])) {
    logger.warn({ unit: ctx.unit.slug, etiqueta: ETIQUETAS_RETOMADA[0] }, 'rotina: a conta não tem a etiqueta do 1º toque — nada a fazer nas etapas');
    resumo.etapas = { ...resumoNovo(), seguradas: { 'sem-etiqueta-na-conta': 1 } };
    return;
  }
  for (const regua of REGUAS_POR_ETAPA) {
    const r = (resumo[regua.chave] = resumoNovo());
    const alvo = ctx.funis.idDe('COMERCIAL', regua.etapa);
    if (!alvo) continue;
    const dias = ctx.cfg.etapas[regua.chave];
    await varrerSilencio(
      ctx,
      seco,
      {
        automacao: ID_ROTINA_ETAPAS,
        chave: regua.chave,
        etapa: regua.etapa,
        dias,
        etiquetas: ETIQUETAS_RETOMADA,
        prontos: ctx.cfg.toquesProntosEtapas,
        entradaAteDias: MAX_SILENCIO_ETAPAS_DIAS,
        janelaOlhadaDias: MAX_SILENCIO_ETAPAS_DIAS + dias[dias.length - 1],
        opcoesDoCartao: {},
        soQuemNuncaAgendou: false,
      },
      await cartoesDaEtapa(ctx.kommo, alvo),
      r,
    );
  }
}

/**
 * Régua 2: ex-lead que nunca agendou, hoje em PERDIDO ou EM ESPERA. Fica de fora das outras etapas de propósito: a
 * ENTRADA e a EM QUALIFICAÇÃO têm a régua por etapa e o `parados` (90 dias sem mexer → PERDIDO, e aí entra aqui);
 * quem está AGENDADO, COMPARECEU ou EM TRATAMENTO é paciente, não ex-lead.
 */
export async function varrerExLead(ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>): Promise<void> {
  const r = (resumo[CHAVE_EXLEAD] = resumoNovo());
  if (!acharNaConta(ETIQUETAS_EXLEAD[0], [...ctx.tagsDaConta])) {
    logger.warn({ unit: ctx.unit.slug, etiqueta: ETIQUETAS_EXLEAD[0] }, 'rotina: a conta não tem a etiqueta do 1º toque do ex-lead — nada a fazer');
    r.seguradas['sem-etiqueta-na-conta'] = 1;
    return;
  }
  const dias = ctx.cfg.exlead;
  for (const etapa of ETAPAS_DO_EXLEAD) {
    const alvo = etapa === ETAPA.PERDIDO ? { pipelineId: ctx.funis.comercialId, statusId: 143 } : ctx.funis.idDe('COMERCIAL', etapa);
    if (!alvo) continue;
    await varrerSilencio(
      ctx,
      seco,
      {
        automacao: ID_ROTINA_EXLEAD,
        chave: CHAVE_EXLEAD,
        etapa,
        dias,
        etiquetas: ETIQUETAS_EXLEAD,
        prontos: ctx.cfg.toquesProntosExlead,
        entradaAteDias: dias[0] + ENTRADA_EXLEAD_DIAS,
        janelaOlhadaDias: dias[dias.length - 1] + ENTRADA_EXLEAD_DIAS,
        opcoesDoCartao: { conferirMotivoMorto: true },
        soQuemNuncaAgendou: true,
        // a Reativação do `etiquetas-auto` já pode ter mandado o 1º toque deste cartão (ele marca por cartão + data da perda)
        marcasExtras: marcasDaReativacaoAntiga,
      },
      await cartoesDaEtapa(ctx.kommo, alvo),
      r,
    );
  }
}

/** O 1º toque do ex-lead = a ▶ Reativação. Se o `etiquetas-auto` já a pôs neste PERDIDO, o degrau 1 conta como enviado. */
async function marcasDaReativacaoAntiga(ctx: Ctx, leads: KommoLead[]): Promise<Map<number, MarcaLida[]>> {
  const porId = new Map<string, KommoLead>();
  for (const l of leads) if (l.closed_at) porId.set(`etiqueta-${ctx.unit.id}-reativacao:${l.id}:${l.closed_at}`, l);
  const mapa = new Map<number, MarcaLida[]>();
  if (porId.size === 0) return mapa;
  const achadas = await prisma.executionTrace.findMany({ where: { id: { in: [...porId.keys()] } }, select: { id: true, createdAt: true } });
  for (const a of achadas) {
    const lead = porId.get(a.id);
    if (lead) mapa.set(lead.id, [{ leadId: lead.id, chave: CHAVE_EXLEAD, toque: 1, em: Math.floor(a.createdAt.getTime() / 1000) }]);
  }
  return mapa;
}

/**
 * Este cartão nunca agendou? Nem o cartão mostra consulta, nem a franquia tem agendamento ou tratamento dele. Lança se a
 * franquia não responder — "caiu" nunca vira "nunca agendou". Sem franquia na unidade, vale o cartão.
 */
export async function nuncaAgendou(unit: Unit, lead: KommoLead, franquia: Ctx['franquia'] = franquiaDoPaciente, agora = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (cartaoMostraConsulta(lead)) return false;
  const f = await franquia!(unit, lead.id, lead.name ?? null, agora);
  return !f.temHistorico && !f.consultaFutura && !f.emAndamento;
}

// ─── régua 3: aniversário ─────────────────────────────────────────────────────────────────────────

/** `unidade:dia` → cartões que fazem aniversário naquele dia (varrer o funil inteiro uma vez por dia basta). */
const aniversariantes = new Map<string, KommoLead[]>();

/** Paciente de verdade: está no funil TRATAMENTO, ou o cartão mostra consulta, ou tem ⚙ idClient. Lead que nunca consultou não ganha parabéns. */
function ehPaciente(lead: KommoLead, funis: Funis): boolean {
  return (funis.tratamentoId !== null && lead.pipeline_id === funis.tratamentoId) || cartaoMostraConsulta(lead) || idClientDoCartao(lead, []) !== null;
}

async function cartoesDoUniverso(ctx: Ctx): Promise<KommoLead[]> {
  const alvos: Array<{ pipelineId: number; statusId: number }> = [];
  for (const e of [ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU, ETAPA.COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.RETORNO]) {
    const a = ctx.funis.idDe('COMERCIAL', e);
    if (a) alvos.push(a);
  }
  alvos.push({ pipelineId: ctx.funis.comercialId, statusId: 142 }, { pipelineId: ctx.funis.comercialId, statusId: 143 });
  for (const e of [ETAPA.EM_TRATAMENTO, ETAPA.ALTA, ETAPA.CANCELADO]) {
    const a = ctx.funis.idDe('TRATAMENTO', e);
    if (a) alvos.push(a);
  }
  if (ctx.funis.tratamentoId !== null) alvos.push({ pipelineId: ctx.funis.tratamentoId, statusId: 142 }, { pipelineId: ctx.funis.tratamentoId, statusId: 143 });
  const vistos = new Map<number, KommoLead>();
  for (const alvo of alvos) {
    for (let page = 1; page <= MAX_PAGINAS_ANIVERSARIO; page++) {
      const pag = await ctx.kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true, 'desc');
      for (const l of pag) vistos.set(l.id, l);
      if (pag.length < 250) break;
    }
  }
  return [...vistos.values()];
}

export async function varrerAniversario(ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>): Promise<void> {
  const r = (resumo[CHAVE_ANIVERSARIO] = resumoNovo());
  const { unit, agora, tz } = ctx;
  if (!naJanelaDoAniversario(agora, tz)) {
    r.seguradas['fora-da-janela-da-manha'] = 1;
    return;
  }
  if (!acharNaConta(ETIQUETA_ANIVERSARIO, [...ctx.tagsDaConta])) {
    logger.warn({ unit: unit.slug, etiqueta: ETIQUETA_ANIVERSARIO }, 'rotina: a conta não tem a etiqueta de aniversário — nada a fazer');
    r.seguradas['sem-etiqueta-na-conta'] = 1;
    return;
  }
  const dia = hojeNaUnidade(agora, tz);
  const chave = `${unit.id}:${dia}`;
  let doDia = aniversariantes.get(chave);
  if (!doDia) {
    for (const k of aniversariantes.keys()) if (!k.endsWith(`:${dia}`)) aniversariantes.delete(k);
    const todos = await cartoesDoUniverso(ctx);
    r.lidos = todos.length;
    doDia = todos.filter((l) => aniversarioHoje(nascimentoDoCartao(l), agora, tz) && ehPaciente(l, ctx.funis));
    aniversariantes.set(chave, doDia);
  }
  const ano = Number(dia.slice(0, 4));
  const opcoes: OpcoesDeCartao = { agora, tz, pausarIaFieldId: null, conferirMotivoMorto: true, soNaoContatar: true };

  let fila = doDia.filter((l) => {
    if (pularCartao(ctx.grupo, unit.id, l, {})) return false; // Kommo dividido: só os desta unidade
    const razao = porQueNaoTocar(l, opcoes);
    if (razao) {
      conta(r.barrados, razao.codigo);
      return false;
    }
    return true;
  });
  const ids = fila.map((l) => l.id);
  const [hoje, doEtiquetasAuto] = await Promise.all([marcasDeHoje(unit, agora, tz), toquesDoEtiquetasAutoHoje(unit.id, ids, agora, tz)]);
  const comToqueHoje = new Set(hoje.map((m) => m.leadId));
  const quemDe = (l: KommoLead): string => {
    const c = contatoPrincipal(l);
    return c !== null ? `c${c}` : `l${l.id}`;
  };
  const jaDoAno = new Set(
    (await prisma.executionTrace.findMany({ where: { id: { in: fila.map((l) => idDaMarca(unit.id, quemDe(l), CHAVE_ANIVERSARIO, 1, ano)) } }, select: { id: true } })).map((x) => x.id),
  );
  fila = fila.filter((l) => {
    if (jaDoAno.has(idDaMarca(unit.id, quemDe(l), CHAVE_ANIVERSARIO, 1, ano))) {
      conta(r.barrados, 'ja-recebeu-este-ano');
      return false;
    }
    if (comToqueHoje.has(l.id) || doEtiquetasAuto.has(l.id)) {
      conta(r.barrados, 'ja-recebeu-toque-hoje');
      return false;
    }
    return true;
  });

  const tratamentoEm = ctx.funis.tratamentoId !== null ? ctx.funis.idDe('TRATAMENTO', ETAPA.EM_TRATAMENTO) : null;
  for (const lead of fila) {
    if (!seco && ctx.teto.restanteNaVarredura <= 0) break;
    r.avaliados++;
    try {
      let emTratamento = tratamentoEm !== null && lead.pipeline_id === tratamentoEm.pipelineId && lead.status_id === tratamentoEm.statusId;
      // a franquia é o cadastro: confere a data (e se o paciente está vivo e em tratamento) pelo VÍNCULO do cartão, nunca por busca de nome
      const idClient = idClientDoCartao(lead, []);
      if (idClient !== null && unit.spineEnabled && unit.spineToken) {
        const res = await (ctx.ficha ?? fichaDoPaciente)(unit as never, idClient);
        if (!res.ok || !res.data) throw new Error(`franquia não respondeu (paciente ${idClient}): ${res.error ?? 'erro'}`);
        const ficha = res.data.ficha;
        if (statusDeFalecido(ficha.status)) {
          conta(r.barrados, 'falecido-na-franquia');
          continue;
        }
        const nasc = diaDeNascimentoDaFicha(ficha.birthdate);
        if (nasc !== null && !aniversarioNoDia(nasc, agora, tz)) {
          conta(r.seguradas, 'franquia-diz-outra-data');
          continue;
        }
        if (ficha.treatments.some((t) => (t as { idStatus?: number }).idStatus === TRATAMENTO_EM_ANDAMENTO)) emTratamento = true;
      }
      const etiqueta = emTratamento ? ETIQUETA_ANIVERSARIO_TRATAMENTO : ETIQUETA_ANIVERSARIO;
      const aindaVale = (fresco: KommoLead): string | null => {
        const razao = porQueNaoTocar(fresco, { ...opcoes, agora: Math.floor(Date.now() / 1000) });
        return razao ? razao.texto : null;
      };
      const etapa = ctx.funis.nomeDe(lead.pipeline_id, lead.status_id)?.status ?? '';
      const res = await tocar(
        ctx,
        seco,
        { lead, automacao: ID_ROTINA_ANIVERSARIO, chave: CHAVE_ANIVERSARIO, toque: 1, etiqueta, tp: ano, quem: quemDe(lead), etapa, motivo: emTratamento ? 'aniversário (em tratamento: só parabéns, sem convite)' : 'aniversário do paciente', aindaVale },
        r,
      );
      if (res === 'teto' && !seco) break;
    } catch (err) {
      r.erros++;
      logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'rotina: erro no aniversário de um cartão — pulei');
    }
  }
}

// ─── a varredura ──────────────────────────────────────────────────────────────────────────────────

let rodando = false;

export async function varrerUnidade(unit: Unit, agora: number = Math.floor(Date.now() / 1000)): Promise<Record<string, ResumoDaRegua> | null> {
  const estados = { etapas: estadoDasEtapas(unit.slug), exlead: estadoDoExLead(unit.slug), aniversario: estadoDoAniversario(unit.slug) };
  if (Object.values(estados).every((e) => e === 'desligado')) return null;
  if (emPausa(unit) || !dentroDoHorario(unit)) return null; // horário comercial da unidade, feriado e pausa da recepção
  let kommo: KommoClient;
  try {
    kommo = createKommoClient(unit);
  } catch {
    return null;
  }
  const funis = await funisDaConta(unit, kommo);
  if (!funis) {
    logger.warn({ unit: unit.slug }, 'rotina: não achei o funil COMERCIAL — pulei a unidade');
    return null;
  }
  const tz = unit.spineTimezone ?? 'America/Sao_Paulo';
  const cfg = configDaUnidade(unit.pipelineIntents);
  if (cfg.invalidas.length) logger.warn({ unit: unit.slug, invalidas: cfg.invalidas }, 'rotina: prazos inválidos na unidade — usei os padrões');
  const feitosHoje = (await marcasDeHoje(unit, agora, tz)).length;
  const ctx: Ctx = {
    unit,
    kommo,
    funis,
    grupo: await grupoDaUnidade(unit.id),
    agora,
    tz,
    cfg,
    pausarIaFieldId: unit.kommoPausedFieldId ?? null,
    tagsDaConta: await etiquetasDaConta(unit.kommoSubdomain ?? unit.slug, kommo),
    teto: { restanteHoje: Math.max(0, cfg.teto - feitosHoje), restanteNaVarredura: cfg.porVarredura },
  };
  const resumo: Record<string, ResumoDaRegua> = {};
  // aniversário primeiro: é uma vez por ano e não pode perder a vaga do teto para a cobrança do dia
  if (estados.aniversario !== 'desligado') await varrerAniversario(ctx, estados.aniversario === 'seco', resumo);
  if (estados.exlead !== 'desligado') await varrerExLead(ctx, estados.exlead === 'seco', resumo);
  if (estados.etapas !== 'desligado') await varrerEtapas(ctx, estados.etapas === 'seco', resumo);
  logger.info({ unit: unit.slug, estados, teto: cfg.teto, feitosHoje, restanteHoje: ctx.teto.restanteHoje, resumo }, 'rotina: varredura');
  return resumo;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { isActive: true } });
    for (const unit of unidades) {
      try {
        await varrerUnidade(unit);
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug }, 'rotina: varredura da unidade falhou');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'rotina: varredura falhou');
  } finally {
    rodando = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

export function startRotinaRobosWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  primeira.unref?.();
  timer.unref?.();
  logger.info({ sweepMs: SWEEP_MS, maxAvaliacoes: MAX_AVALIACOES }, 'rotina diária dos robôs: worker ligado');
}

export function stopRotinaRobosWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
