/**
 * Núcleo da ROTINA DIÁRIA dos robôs (pedido do João, 06/11/2026): "todo dia os bots trabalham em favor das meninas".
 *
 * O gatilho do Kommo só dispara em EVENTO (entrar na etapa, data do cartão, etiqueta). Escapam quem já estava na etapa quando o
 * gatilho nasceu, quem tem o campo de data vazio, quem está parado numa etapa sem gatilho de tempo. A rotina varre o funil de
 * cada unidade, em horário comercial, e põe a etiqueta ▶ do degrau da vez; quem manda a mensagem é o robô do Kommo amarrado à
 * etiqueta (a mesma mecânica do `etiquetas-auto`).
 *
 * São TRÊS réguas, cada uma num PR e numa chave do catálogo (desligável por unidade): esquecidos por etapa
 * (`rotina-etapas-worker.ts`), ex-lead (`rotina-exlead-worker.ts`) e aniversário (`rotina-aniversario-worker.ts`). Este arquivo é
 * o que elas DIVIDEM e é idêntico nos três PRs: a marca, o teto do dia, o "não junto de outro toque no mesmo dia", as travas
 * do cartão e o único caminho de escrita (`tocar`). Quem entrar primeiro leva o arquivo; os outros entram sem conflito.
 *
 * REGRAS QUE VALEM PARA TODAS
 *  - A MARCA é um rastro em `execution_traces` por degrau, gravado ANTES da etiqueta: não gravou, não sai. O id leva a PESSOA
 *    (o contato do Kommo), não o cartão: dois cartões da mesma pessoa (PERDIDO + QUALIFICAÇÃO) não recebem dois modelos no mesmo dia
 *    e dividem os degraus da mesma régua.
 *  - O TETO por unidade por dia (30) é a contagem dessas marcas — sobrevive a deploy e a réplica e soma as três réguas (a Meta
 *    derruba a qualidade do número com disparo em massa; o número é um só). Mais um teto por varredura.
 *  - SECO NÃO ESCREVE NADA: só registra «etiquetaria»/«pularia» (tela de Automações). Tem teto próprio, POR DIA (um conjunto em
 *    memória por unidade e dia), que não gasta a vaga de uma régua ligada.
 *  - Etiqueta que a conta não tem = não faz nada (o `tags_to_add` do Kommo CRIA a etiqueta solta, sem robô).
 *  - O gatilho de etiqueta de cada conta só se lê com sessão (`/ajax/v4/triggers/bots`): não dá para conferir daqui. Cada régua
 *    tem uma chave de «degraus prontos» na unidade.
 *
 * Tudo que é PURO (cartão + relógio → decisão) está no topo e testa sem Kommo nem banco.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { caixinhaMarcada, createKommoClient } from '../services/kommo.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { carregarFunis, type Funis } from './franquia-sync-worker.js';
import { grupoDaUnidade, type GrupoDoCrm } from './crm-compartilhado.js';
import { acharNaConta, etiquetaNoCartao, etiquetasDaConta } from './ponte-etiquetas.js';
import type { NaFranquia } from './parados-worker.js';
import type { fichaDoPaciente } from '../services/spine.service.js';
import { dentroDoHorario } from './sla-alert-worker.js';
import { emPausa } from './pausa-unidade.js';
import { normalizarNome } from './kommo-schema.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { valorDoCampo } from './ponte-fila.js';
import { comConsultaFutura } from './trava-perda.js';
import { diaDaRetomada, diaDoCampoData, hojeNaUnidade, retomarEmDoCartao } from './espera-retomada.js';
import { ETIQUETAS_DE_NAO_CONTATAR } from './sofia-fecha-quente-morno.js';
import { ETIQUETA_CURRICULO } from './nao-paciente.js';
import { CAMPO, TAG_SEM_REGUA, nomesDoCampo } from './parados.js';
import { epochDoCartao } from './paciente-para-cartao.js';

export const DIA_S = 86_400;
export const HORA_S = 3600;
export const MAX_TOQUES = 3;
export const TETO_DIA_PADRAO = 30;
export const POR_VARREDURA_PADRAO = 10;
export const ID_ROTINA_ANIVERSARIO = 'rotina-aniversario';
/** Dias de atraso que o aniversário aceita: a unidade fechada no sábado, no domingo ou no feriado (sábado + segunda feriado = 3 dias) cumprimenta no 1º dia útil. */
export const ATRASO_MAX_ANIVERSARIO_DIAS = 3;
/** Equipe falou há menos que isto = gente com o paciente: a rotina não atravessa. */
export const HORAS_DA_EQUIPE = 48;
/** Qualquer mensagem NOSSA (Sofia, equipe ou robô) há menos que isto = já falaram com ele hoje. */
export const HORAS_DE_QUALQUER_FALA = 24;
/** Cartões que gastam chamada ao Kommo por régua e etapa e varredura: o limitador do Kommo é da rede inteira (lição de 04/11). */
export const MAX_AVALIACOES = Number(process.env.ROTINA_ROBOS_MAX_AVALIACOES) || 40;

// ─── configuração por unidade ─────────────────────────────────────────────────────────────────────

/**
 * A tela de unidade guarda hoje em `pipelineIntents` {chave: inteiro positivo}. A configuração da rotina vai ali, sem migração:
 * `rotina_teto_dia` aqui; os prazos e os «degraus prontos» de cada régua no arquivo dela. Ausente = o padrão do João.
 */
export interface ConfigBase {
  teto: number;
  porVarredura: number;
}

export function inteiro(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function intentsDe(pipelineIntents: unknown): Record<string, unknown> {
  return (pipelineIntents && typeof pipelineIntents === 'object' && !Array.isArray(pipelineIntents) ? pipelineIntents : {}) as Record<string, unknown>;
}

export const limitar = (v: number | null, max: number, padrao: number) => (v === null ? padrao : Math.min(v, max));

export function configBase(pipelineIntents: unknown, env: Record<string, string | undefined> = process.env): ConfigBase {
  const intents = intentsDe(pipelineIntents);
  return {
    teto: limitar(inteiro(intents.rotina_teto_dia) ?? inteiro(env.ROTINA_ROBOS_TETO_DIA), 500, TETO_DIA_PADRAO),
    porVarredura: limitar(inteiro(env.ROTINA_ROBOS_POR_VARREDURA), 100, POR_VARREDURA_PADRAO),
  };
}

// ─── a marca (1 por PESSOA, régua, degrau e silêncio) ─────────────────────────────────────────────

export const PREFIXO_DA_MARCA = 'rotina-';

/** A pessoa do cartão: o contato principal (dois cartões do mesmo contato são a mesma pessoa); sem contato, o próprio cartão. */
export const contatoPrincipal = (l: Pick<KommoLead, '_embedded'>): number | null => {
  const cs = l._embedded?.contacts ?? [];
  return (cs.find((c) => c.is_main) ?? cs[0])?.id ?? null;
};

export function pessoaDoCartao(lead: Pick<KommoLead, 'id' | '_embedded'>): string {
  const c = contatoPrincipal(lead);
  return c ? `c${c}` : `l${lead.id}`;
}

/** A franquia tem algo deste paciente — consulta futura, tratamento em andamento ou QUALQUER agendamento/tratamento no histórico? (a regra única do «nunca agendou») */
export function franquiaTemHistorico(f: Pick<NaFranquia, 'temHistorico' | 'consultaFutura' | 'emAndamento'>): boolean {
  return !!f.temHistorico || f.consultaFutura || f.emAndamento;
}

/** `rotina-<unidade>-<pessoa>-<régua>-<degrau>-<âncora>`; âncora = a última mensagem do paciente (epoch s), ou o ano no aniversário. */
export function idDaMarca(unitId: string, pessoa: string, chave: string, toque: number, tp: number): string {
  return `${PREFIXO_DA_MARCA}${unitId}-${pessoa}-${chave}-${toque}-${tp}`;
}

export interface MarcaLida {
  pessoa: string;
  chave: string;
  toque: number;
  /** quando saiu (epoch s) */
  em: number;
}

/** Lê pessoa, régua e degrau do FIM do id (o id da unidade pode ter hífen). `null` = não é marca da rotina. */
export function lerMarca(id: string, criadaEm: Date): MarcaLida | null {
  if (!id.startsWith(PREFIXO_DA_MARCA)) return null;
  const partes = id.split('-');
  if (partes.length < 6) return null;
  const pessoa = partes[partes.length - 4];
  const chave = partes[partes.length - 3];
  const toque = Number(partes[partes.length - 2]);
  if (!pessoa || !chave || !Number.isInteger(toque) || toque < 1) return null;
  return { pessoa, chave, toque, em: Math.floor(criadaEm.getTime() / 1000) };
}

/** As marcas desta régua que valem para o silêncio de AGORA: as de depois da âncora (a última mensagem dele). Ele escreveu = zera. */
export function marcasDoSilencio(marcas: readonly MarcaLida[], chave: string, ancora: number): Array<{ toque: number; em: number }> {
  return marcas.filter((m) => m.chave === chave && m.em > ancora).map((m) => ({ toque: m.toque, em: m.em }));
}

// ─── o que o CARTÃO diz (sem chamada nenhuma) ─────────────────────────────────────────────────────

/** Etiquetas que dizem "não mande nada pra este paciente" (as do `etiquetas-auto` + as das outras travas). */
const NAO_CONTATAR = [
  'NO_FOLLOW_UP',
  'NAO_PERTURBAR',
  'BLOQUEADO_WHATSAPP',
  'Fluxo · Opt-out WhatsApp',
  ...ETIQUETAS_DE_NAO_CONTATAR,
  TAG_SEM_REGUA,
  ETIQUETA_CURRICULO,
  'Fora do escopo',
].map(normalizarNome);

/**
 * Motivos de perda que a SDR ou a IA escolhem quando o caso ESTÁ ENCERRADO — insistir é spam. Os cinco do João (06/11/2026)
 * mais os de risco que o resto da casa já trata como intocáveis. "Sem condições financeiras" NÃO está aqui: a perda-ia a trata
 * como trabalhável (decisão de 02/10).
 */
const MOTIVOS_MORTOS = [
  'Outra cidade',
  'Mora em outra cidade',
  'Clicou por engano',
  'Outra patologia',
  'Plano de Saúde',
  'Sem interesse',
  'Bandeira vermelha',
  'Financeiramente vulnerável',
  'Assinou contrato',
  'Caso enviado para a franquia',
  'Informação para terceiro',
].map(normalizarNome);

export type Cartao = Pick<KommoLead, 'custom_fields_values' | '_embedded'>;

function tags(lead: Cartao): string[] {
  return (lead._embedded?.tags ?? []).map((t) => normalizarNome(t.name ?? ''));
}

export function temEtiqueta(lead: Cartao, nome: string): boolean {
  return tags(lead).includes(normalizarNome(nome));
}

/** O motivo de perda "morto" que o cartão carrega (nos dois campos ⊘), ou null. */
export function motivoMorto(lead: Cartao): string | null {
  for (const campo of [CAMPO.MOTIVO_NAO_AGENDAMENTO, CAMPO.MOTIVO_NAO_FECHAMENTO]) {
    for (const nome of nomesDoCampo(campo)) {
      const v = String(valorDoCampo(lead.custom_fields_values, nome) ?? '').trim();
      if (v && MOTIVOS_MORTOS.includes(normalizarNome(v))) return v;
    }
  }
  return null;
}

export interface RazaoDeFicar {
  /** curto, estável: vira a chave do contador do resumo */
  codigo: string;
  texto: string;
}

export interface OpcoesDeCartao {
  agora: number;
  tz: string;
  pausarIaFieldId: number | null;
  /** confere o motivo de perda "morto" (ex-lead e aniversário); as réguas por etapa não olham PERDIDO */
  conferirMotivoMorto?: boolean;
  /** aniversário: só as travas de "não contatar" — Pausar IA, ◷ Retomar em e consulta futura NÃO impedem um parabéns */
  soNaoContatar?: boolean;
}

/** Por que o cartão NÃO recebe toque — só o que se vê nele, de graça. `null` = pode seguir para o que custa chamada. */
export function porQueNaoTocar(lead: Cartao, o: OpcoesDeCartao): RazaoDeFicar | null {
  const t = tags(lead);
  if (NAO_CONTATAR.some((n) => t.includes(n))) return { codigo: 'nao-contatar', texto: 'etiqueta de não contatar, currículo ou fora do escopo' };
  if (/^\s*sim\s*$/i.test(String(valorDoCampo(lead.custom_fields_values, '✓ Opt-out WhatsApp') ?? ''))) {
    return { codigo: 'opt-out', texto: 'paciente pediu para não receber mensagens (✓ Opt-out WhatsApp)' };
  }
  if (o.conferirMotivoMorto) {
    const m = motivoMorto(lead);
    if (m) return { codigo: 'motivo-morto', texto: `perdido por «${m}»: caso encerrado` };
  }
  if (o.soNaoContatar) return null;
  if (o.pausarIaFieldId !== null) {
    const campo = (lead.custom_fields_values ?? []).find((c) => c.field_id === o.pausarIaFieldId);
    if (caixinhaMarcada(campo?.values?.[0]?.value)) return { codigo: 'pausar-ia', texto: '«Pausar IA» marcado: tem gente com o paciente' };
  }
  const dia = diaDaRetomada(retomarEmDoCartao(lead.custom_fields_values), o.agora, o.tz);
  if (dia === 'futuro' || dia === 'hoje') return { codigo: 'retomar-em', texto: `◷ Retomar em ${dia === 'hoje' ? 'é hoje' : 'está no futuro'}: alguém decidiu esperar` };
  if (comConsultaFutura(lead, o.agora)) return { codigo: 'consulta-futura-cartao', texto: 'consulta futura no cartão' };
  return null;
}

/** Cartão que MOSTRA que o paciente já passou por consulta ou tratamento (a franquia confere depois). */
export function cartaoMostraConsulta(lead: Cartao): boolean {
  const c = lead.custom_fields_values;
  const preenchido = (nome: string) => {
    const v = valorDoCampo(c, nome);
    return v !== undefined && v !== null && String(v).trim() !== '' && String(v) !== 'false' && String(v) !== '0';
  };
  return [CAMPOS_SYNC.DATA_CONSULTA, CAMPOS_SYNC.SITUACAO, CAMPOS_SYNC.COMPARECEU, CAMPOS_SYNC.TRAT_FECHADO, CAMPOS_SYNC.FECHOU_TRAT].some(preenchido);
}

// ─── aniversário (puro; o núcleo precisa porque as outras réguas cedem o dia do aniversário) ──────

/** Nascimento do cartão (epoch s do campo ◷ Data de nascimento; NEGATIVO para quem nasceu antes de 1970), ou null. */
export function nascimentoDoCartao(lead: Cartao): number | null {
  const v = valorDoCampo(lead.custom_fields_values, '◷ Data de nascimento');
  return v == null ? null : epochDoCartao(String(v));
}

/** O dia (AAAA-MM-DD) que a ficha da franquia diz (ISO ou dd/mm/aaaa), ou null. */
export function diaDeNascimentoDaFicha(bruto: string | null | undefined): string | null {
  const s = String(bruto ?? '').trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  return iso && !Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) ? iso : null;
}

/**
 * É aniversário hoje, no fuso da unidade? `dia` = AAAA-MM-DD do nascimento. Com `atrasoMax`, vale também o aniversário dos últimos
 * N dias (o 1º dia útil depois do fim de semana ou do feriado) — a marca de «1 por ano» impede o repique. 29/02 comemora em 28/02
 * nos anos sem bissexto. Ano absurdo (futuro, antes de 1900) = não manda: data digitada errada é pior que não mandar.
 */
export function aniversarioNoDia(dia: string | null, agora: number, tz: string, atrasoMax = 0): boolean {
  if (!dia) return false;
  const ano = Number(dia.slice(0, 4));
  const anoAgora = Number(hojeNaUnidade(agora, tz).slice(0, 4));
  if (!Number.isFinite(ano) || ano < 1900 || ano >= anoAgora) return false;
  const md = dia.slice(5);
  for (let k = 0; k <= atrasoMax; k++) {
    const hoje = hojeNaUnidade(agora - k * DIA_S, tz);
    const anoDoDia = Number(hoje.slice(0, 4));
    const bissexto = (anoDoDia % 4 === 0 && anoDoDia % 100 !== 0) || anoDoDia % 400 === 0;
    if (md === hoje.slice(5) || (md === '02-29' && !bissexto && hoje.slice(5) === '02-28')) return true;
  }
  return false;
}

/**
 * O ANO do aniversário que vale agora (o do dia que casou, não o de hoje): quem faz anos em 31/12 e é cumprimentado em 02/01 tem a
 * marca de «1 por ano» do ano em que fez anos — senão no 31/12 seguinte ela já existiria e o parabéns daquele ano se perderia.
 */
export function anoDoAniversario(dia: string | null, agora: number, tz: string, atrasoMax = 0): number | null {
  if (!dia) return null;
  const md = dia.slice(5);
  for (let k = 0; k <= atrasoMax; k++) {
    const hoje = hojeNaUnidade(agora - k * DIA_S, tz);
    const ano = Number(hoje.slice(0, 4));
    const bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
    if (md === hoje.slice(5) || (md === '02-29' && !bissexto && hoje.slice(5) === '02-28')) return ano;
  }
  return null;
}

/** Aniversário a partir de um campo `date` do Kommo (epoch s, meia-noite no fuso da conta). */
export function aniversarioHoje(nascimento: number | null, agora: number, tz: string, atrasoMax = 0): boolean {
  return nascimento === null ? false : aniversarioNoDia(diaDoCampoData(nascimento), agora, tz, atrasoMax);
}

export const estadoDoAniversario = (slug: string, raw: string | undefined = process.env.ROTINA_ANIVERSARIO_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_ANIVERSARIO, raw);

// ─── contexto, resumo, cache ──────────────────────────────────────────────────────────────────────

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
  /** a varredura parou porque o teto do dia acabou: o resto não foi nem avaliado */
  paradoPeloTeto: boolean;
  erros: number;
}

export const resumoNovo = (): ResumoDaRegua => ({ lidos: 0, barrados: {}, avaliados: 0, porToque: {}, esperando: 0, esgotadas: 0, foraDaJanela: 0, seguradas: {}, acimaDoTeto: 0, paradoPeloTeto: false, erros: 0 });
export const conta = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);

export type KommoDoNucleo = Pick<
  KommoClient,
  | 'listLeadsPorEtapa'
  | 'ultimaMensagemDoContatoDesde'
  | 'ultimaMudancaDeEtapa'
  | 'listTalks'
  | 'listTalkMessages'
  | 'listLeadsPorIds'
  | 'getLead'
  | 'addTag'
  | 'removeTag'
  | 'addLeadNote'
>;

export interface MarcasDaUnidade {
  /** todas as marcas da rotina nos últimos 200 dias, por pessoa */
  porPessoa: Map<string, MarcaLida[]>;
  /** quantas marcas saíram HOJE (dia local da unidade): é o teto do dia */
  feitasHoje: number;
  /** pessoas que já receberam algum toque hoje — da rotina OU do `etiquetas-auto` */
  pessoasHoje: Set<string>;
}

export interface Ctx {
  unit: Unit;
  kommo: KommoDoNucleo;
  funis: Funis;
  grupo: GrupoDoCrm | null;
  agora: number;
  tz: string;
  base: ConfigBase;
  pausarIaFieldId: number | null;
  /** as etiquetas de cartão que a CONTA tem — o `tags_to_add` do Kommo CRIA a que não existe */
  tagsDaConta: readonly string[];
  /** quantos cabem nesta varredura (o teto do dia vem das marcas) */
  restanteNaVarredura: number;
  /** a régua de aniversário está LIGADA nesta unidade (as outras cedem o dia do aniversário a ela) */
  aniversarioLigado?: boolean;
  marcas?: Promise<MarcasDaUnidade>;
  /** pessoas tocadas nesta varredura (a marca nova ainda não está na leitura do banco) */
  tocados?: Set<string>;
  franquia?: (unit: Unit, leadId: number, nome: string | null, agora: number) => Promise<NaFranquia>;
  ficha?: typeof fichaDoPaciente;
}

const vistoAte = new Map<string, number>();
export function jaVisto(unitId: string, regua: string, leadId: number, agora: number): boolean {
  const k = `${unitId}:${regua}:${leadId}`;
  const ate = vistoAte.get(k);
  if (ate !== undefined && ate > agora) return true;
  if (ate !== undefined) vistoAte.delete(k);
  return false;
}
export function marcarVisto(unitId: string, regua: string, leadId: number, ateEpoch: number): void {
  if (vistoAte.size > 50_000) {
    const agora = Math.floor(Date.now() / 1000);
    for (const [k, v] of vistoAte) if (v <= agora) vistoAte.delete(k);
  }
  vistoAte.set(`${unitId}:${regua}:${leadId}`, ateEpoch);
}

/** O que o «só no papel» já simulou HOJE, por unidade e dia: `pessoa → chave do toque`. É o teto simulado por DIA. */
const simulados = new Map<string, Map<string, string>>();
function simuladosDe(ctx: Ctx): Map<string, string> {
  const dia = `${ctx.unit.id}:${hojeNaUnidade(ctx.agora, ctx.tz)}`;
  for (const k of simulados.keys()) if (k !== dia && k.startsWith(`${ctx.unit.id}:`)) simulados.delete(k);
  let m = simulados.get(dia);
  if (!m) simulados.set(dia, (m = new Map()));
  return m;
}

const funisCache = new Map<string, { em: number; funis: Funis }>();
const FUNIS_TTL_MS = 10 * 60_000;
export async function funisDaConta(unit: Unit, kommo: KommoClient): Promise<Funis | null> {
  const hit = funisCache.get(unit.id);
  if (hit && Date.now() - hit.em < FUNIS_TTL_MS) return hit.funis;
  const funis = await carregarFunis(kommo);
  if (funis) funisCache.set(unit.id, { em: Date.now(), funis });
  return funis;
}

/** Para o teste começar limpo. */
export function _limparCacheDaRotina(): void {
  vistoAte.clear();
  funisCache.clear();
  simulados.clear();
}

// ─── banco: marcas, teto do dia, conversa recente ─────────────────────────────────────────────────

/**
 * Todas as marcas da unidade (200 dias) numa leitura só, por varredura: dá os degraus por PESSOA, o teto do dia e o «não junto de
 * outro toque no mesmo dia» — inclusive o toque do `etiquetas-auto` (marca `etiqueta-…`, por cartão: o cartão vira pessoa lendo o
 * contato no Kommo; se a leitura falhar, vale o cartão).
 */
export async function carregarMarcas(ctx: Ctx): Promise<MarcasDaUnidade> {
  const { unit, agora, tz } = ctx;
  const hoje = hojeNaUnidade(agora, tz);
  const doDia = (d: Date) => hojeNaUnidade(Math.floor(d.getTime() / 1000), tz) === hoje;
  const linhas = await prisma.executionTrace.findMany({
    where: { unitId: unit.id, id: { startsWith: PREFIXO_DA_MARCA }, createdAt: { gte: new Date((agora - 200 * DIA_S) * 1000) } },
    select: { id: true, createdAt: true },
  });
  const porPessoa = new Map<string, MarcaLida[]>();
  const pessoasHoje = new Set<string>();
  let feitasHoje = 0;
  for (const l of linhas) {
    const m = lerMarca(l.id, l.createdAt);
    if (!m) continue;
    const dela = porPessoa.get(m.pessoa);
    if (dela) dela.push(m);
    else porPessoa.set(m.pessoa, [m]);
    if (doDia(l.createdAt)) {
      feitasHoje++;
      pessoasHoje.add(m.pessoa);
    }
  }
  const auto = await prisma.executionTrace.findMany({
    where: { unitId: unit.id, id: { startsWith: 'etiqueta-' }, createdAt: { gte: new Date((agora - 48 * HORA_S) * 1000) } },
    select: { leadId: true, createdAt: true },
  });
  const leadsDoAuto = [...new Set(auto.filter((a) => doDia(a.createdAt)).map((a) => Number(a.leadId)))].filter((n) => n > 0);
  if (leadsDoAuto.length) {
    const cartoes = await ctx.kommo.listLeadsPorIds(leadsDoAuto, { contatos: true }).catch(() => [] as KommoLead[]);
    const achados = new Set(cartoes.map((c) => c.id));
    for (const c of cartoes) pessoasHoje.add(pessoaDoCartao(c));
    for (const id of leadsDoAuto) if (!achados.has(id)) pessoasHoje.add(`l${id}`);
  }
  return { porPessoa, feitasHoje, pessoasHoje };
}

export function marcasDaUnidade(ctx: Ctx): Promise<MarcasDaUnidade> {
  return (ctx.marcas ??= carregarMarcas(ctx));
}

/** Esta pessoa já recebeu um toque hoje (rotina, `etiquetas-auto`, ou nesta varredura)? */
export async function jaRecebeuHoje(ctx: Ctx, pessoa: string): Promise<boolean> {
  return (await marcasDaUnidade(ctx)).pessoasHoje.has(pessoa) || (ctx.tocados?.has(pessoa) ?? false);
}

/** Quantas vagas restam no dia: as marcas de hoje (ligado) ou as marcas mais o que o papel já simulou (seco). */
export async function vagasDoDia(ctx: Ctx, seco: boolean): Promise<number> {
  const m = await marcasDaUnidade(ctx);
  return Math.max(0, ctx.base.teto - m.feitasHoje - (seco ? simuladosDe(ctx).size : (ctx.tocados?.size ?? 0)));
}

/** Pode seguir avaliando? Falso quando o teto do dia acabou (ou, ligado, o da varredura): o resto não gasta nem a chamada. */
export async function cabeMais(ctx: Ctx, seco: boolean): Promise<boolean> {
  if ((await vagasDoDia(ctx, seco)) <= 0) return false;
  return seco || ctx.restanteNaVarredura > 0;
}

export async function ultimasMensagensNoBanco(unitId: string, leadIds: number[]): Promise<Map<number, number>> {
  if (leadIds.length === 0) return new Map();
  const linhas = await prisma.conversation.findMany({
    where: { unitId, leadId: { in: leadIds.map(String) } },
    select: { leadId: true, lastMessageAt: true },
  });
  const mapa = new Map<number, number>();
  for (const l of linhas) {
    const t = Math.floor(l.lastMessageAt.getTime() / 1000);
    mapa.set(Number(l.leadId), Math.max(t, mapa.get(Number(l.leadId)) ?? 0)); // não há chave única (unidade, cartão): vale a mais recente
  }
  return mapa;
}

// ─── pôr a etiqueta (o único caminho de escrita) ──────────────────────────────────────────────────

export interface Toque {
  lead: KommoLead;
  /** o id da automação (a tela mostra por régua) */
  automacao: string;
  /** a régua dentro do id da marca */
  chave: string;
  toque: number;
  etiqueta: string;
  /** a âncora do silêncio (epoch s) — ou o ano, no aniversário */
  tp: number;
  etapa: string;
  motivo: string;
  /** depois de reler o cartão, ainda vale? `null` = sim */
  aindaVale: (fresco: KommoLead) => string | null;
}

export type Resultado = 'ok' | 'teto' | 'sem-etiqueta' | 'segurou' | 'falhou' | 'incerto';

const pausa = () => new Promise((r) => setTimeout(r, 400));

async function gravarMarca(unit: Unit, t: Toque, pessoa: string): Promise<boolean> {
  const id = idDaMarca(unit.id, pessoa, t.chave, t.toque, t.tp);
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

async function soltarMarca(unit: Unit, t: Toque, pessoa: string): Promise<void> {
  await prisma.executionTrace.delete({ where: { id: idDaMarca(unit.id, pessoa, t.chave, t.toque, t.tp) } }).catch(() => undefined);
}

/**
 * Põe (ou, no seco, só registra) um toque. Confere a conta, o teto, a pessoa e o cartão fresco; grava a marca ANTES. Se a
 * etiqueta não sair, só solta a marca quando a releitura PROVA que ela não está no cartão; releitura que também falha é
 * «incerto»: a marca fica, não conta como sucesso, não gasta o teto e não escreve a nota.
 */
export async function tocar(ctx: Ctx, seco: boolean, t: Toque, r: ResumoDaRegua): Promise<Resultado> {
  const { unit, kommo } = ctx;
  const pessoa = pessoaDoCartao(t.lead);
  const alvo = `${t.toque}º toque · ${t.etiqueta}`;
  const noPapel = (acao: 'etiquetaria' | 'pularia', motivo: string) => registrarSimulacao(unit, t.automacao, { leadId: t.lead.id, acao, alvo, deEtapa: t.etapa, valor: t.toque, motivo });

  // etiqueta que a conta não tem: não faz nada (o `tags_to_add` criaria uma etiqueta solta, sem robô)
  const daConta = acharNaConta(t.etiqueta, [...ctx.tagsDaConta]);
  if (!daConta) {
    conta(r.seguradas, 'sem-etiqueta-na-conta');
    if (seco) noPapel('pularia', `a conta não tem a etiqueta ${t.etiqueta}`);
    return 'sem-etiqueta';
  }
  // seco: o que o papel JÁ simulou hoje continua nele (varredura após varredura) sem gastar outra vaga
  const jaNoPapel = seco && simuladosDe(ctx).get(pessoa) === `${t.lead.id}:${t.chave}:${t.toque}`;
  if (!jaNoPapel && !(await cabeMais(ctx, seco))) {
    r.acimaDoTeto++;
    if (seco) noPapel('pularia', `teto do dia (${ctx.base.teto}): sairia amanhã`);
    return 'teto';
  }
  // a mesma PESSOA em dois cartões (ex.: PERDIDO + QUALIFICAÇÃO) não recebe dois modelos no mesmo dia
  if (seco) {
    const sim = simuladosDe(ctx);
    const chaveSim = `${t.lead.id}:${t.chave}:${t.toque}`;
    const dono = sim.get(pessoa);
    if ((await jaRecebeuHoje(ctx, pessoa)) || (dono !== undefined && dono !== chaveSim)) {
      conta(r.seguradas, 'mesma-pessoa-hoje');
      noPapel('pularia', 'a mesma pessoa já recebe (ou recebeu) outro toque hoje');
      return 'segurou';
    }
    sim.set(pessoa, chaveSim);
    conta(r.porToque, String(t.toque));
    noPapel('etiquetaria', t.motivo);
    return 'ok';
  }
  if (await jaRecebeuHoje(ctx, pessoa)) {
    conta(r.seguradas, 'mesma-pessoa-hoje');
    return 'segurou';
  }

  // a conversa levou segundos: relê o cartão e confere de novo antes de escrever
  const fresco = await kommo.getLead(t.lead.id);
  const razao = t.aindaVale(fresco);
  if (razao) {
    conta(r.seguradas, 'mudou-antes-de-escrever');
    logger.info({ unit: unit.slug, leadId: t.lead.id, razao }, 'rotina: o cartão mudou enquanto eu conferia — não pus');
    return 'segurou';
  }
  if (!(await gravarMarca(unit, t, pessoa))) return 'falhou';
  const tocados = (ctx.tocados ??= new Set());
  let tentouAdicionar = false;
  try {
    // o gatilho é "etiqueta ADICIONADA": se a do ciclo anterior ainda está lá, tira antes (mesmo desenho do `etiquetas-auto`)
    const jaTem = etiquetaNoCartao(daConta, (fresco._embedded?.tags ?? []).map((x) => x.name));
    if (jaTem) await kommo.removeTag(t.lead.id, jaTem);
    tentouAdicionar = true;
    await kommo.addTag({ leadId: t.lead.id, tag: daConta });
  } catch (err) {
    r.erros++;
    // timeout ou 5xx do addTag pode vir DEPOIS de o Kommo gravar a etiqueta (e o robô mandar o modelo): só solta a marca se a
    // releitura PROVA que a etiqueta não está lá. Releitura que falha = incerto: a marca fica e nada conta como sucesso. Se quem
    // falhou foi o REMOVE (a etiqueta velha continua lá), o add nem rodou: a releitura enganaria ("está lá") — solta a marca.
    const estado = !tentouAdicionar
      ? ('nao' as const)
      : await kommo.getLead(t.lead.id).then(
          (l) => (etiquetaNoCartao(daConta, (l._embedded?.tags ?? []).map((x) => x.name)) !== null ? ('gravou' as const) : ('nao' as const)),
          () => 'incerto' as const,
        );
    logger.warn({ err: String(err), unit: unit.slug, leadId: t.lead.id, etiqueta: daConta, estado }, 'rotina: erro ao pôr a etiqueta');
    if (estado === 'nao') {
      await soltarMarca(unit, t, pessoa);
      return 'falhou';
    }
    tocados.add(pessoa); // a marca ficou: esta pessoa não recebe mais nada hoje
    if (estado === 'incerto') return 'incerto';
  }
  ctx.restanteNaVarredura--;
  tocados.add(pessoa);
  conta(r.porToque, String(t.toque));
  await kommo.addLeadNote(t.lead.id, `🤖 Rotina diária: etiqueta ${daConta} (${t.toque}º toque) — ${t.motivo}.`).catch(() => undefined);
  logger.info({ unit: unit.slug, leadId: t.lead.id, etiqueta: daConta, toque: t.toque, regua: t.chave }, 'rotina: etiqueta posta');
  await pausa();
  return 'ok';
}

// ─── a varredura de uma unidade e o worker (iguais para as três réguas) ───────────────────────────

export interface Regua {
  /** o id da automação no catálogo */
  id: string;
  estado: (slug: string) => Estado;
  /** minutos depois do boot da 1ª varredura: as três réguas não batem no Kommo ao mesmo tempo */
  primeiraEmMin: number;
  rodar: (ctx: Ctx, seco: boolean, resumo: Record<string, ResumoDaRegua>) => Promise<void>;
}

/** Uma varredura por vez POR UNIDADE, entre as três réguas (workers separados): a leitura das marcas e do teto é fresca e ninguém grava por cima. */
const filas = new Map<string, Promise<unknown>>();
export function umPorVez<T>(unitId: string, fn: () => Promise<T>): Promise<T> {
  const anterior = filas.get(unitId) ?? Promise.resolve();
  const minha = anterior.then(fn, fn);
  const cauda = minha.catch(() => undefined);
  filas.set(unitId, cauda);
  void cauda.then(() => {
    if (filas.get(unitId) === cauda) filas.delete(unitId);
  });
  return minha;
}

export function varrerUnidade(regua: Regua, unit: Unit, agora?: number): Promise<Record<string, ResumoDaRegua> | null> {
  return umPorVez(unit.id, () => varrerUnidadeSemFila(regua, unit, agora ?? Math.floor(Date.now() / 1000)));
}

async function varrerUnidadeSemFila(regua: Regua, unit: Unit, agora: number): Promise<Record<string, ResumoDaRegua> | null> {
  const estado = regua.estado(unit.slug);
  if (estado === 'desligado') return null;
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
  const base = configBase(unit.pipelineIntents);
  const ctx: Ctx = {
    unit,
    kommo,
    funis,
    grupo: await grupoDaUnidade(unit.id),
    agora,
    tz: unit.spineTimezone ?? 'America/Sao_Paulo',
    base,
    pausarIaFieldId: unit.kommoPausedFieldId ?? null,
    tagsDaConta: await etiquetasDaConta(unit.kommoSubdomain ?? unit.slug, kommo),
    restanteNaVarredura: base.porVarredura,
    aniversarioLigado: estadoDoAniversario(unit.slug) === 'ligado',
  };
  const resumo: Record<string, ResumoDaRegua> = {};
  await regua.rodar(ctx, estado === 'seco', resumo);
  const m = await marcasDaUnidade(ctx);
  logger.info({ unit: unit.slug, regua: regua.id, estado, teto: base.teto, feitasHoje: m.feitasHoje, resumo }, 'rotina: varredura');
  return resumo;
}

/** O worker de uma régua: varre as unidades ativas de 30 em 30 minutos. */
export function criarWorker(regua: Regua): { start: () => void; stop: () => void } {
  const sweepMs = Number(process.env.ROTINA_ROBOS_SWEEP_MS) || 30 * 60_000;
  let rodando = false;
  let timer: NodeJS.Timeout | null = null;
  let primeira: NodeJS.Timeout | null = null;
  const varrer = async () => {
    if (rodando) return;
    rodando = true;
    try {
      const unidades = await prisma.unit.findMany({ where: { isActive: true } });
      for (const unit of unidades) {
        try {
          await varrerUnidade(regua, unit);
        } catch (err) {
          logger.warn({ err: String(err), unit: unit.slug, regua: regua.id }, 'rotina: varredura da unidade falhou');
        }
      }
    } catch (err) {
      logger.warn({ err: String(err), regua: regua.id }, 'rotina: varredura falhou');
    } finally {
      rodando = false;
    }
  };
  return {
    start() {
      if (timer) return;
      primeira = setTimeout(() => void varrer(), regua.primeiraEmMin * 60_000);
      timer = setInterval(() => void varrer(), sweepMs);
      primeira.unref?.();
      timer.unref?.();
      logger.info({ regua: regua.id, sweepMs }, 'rotina diária dos robôs: worker ligado');
    },
    stop() {
      if (timer) clearInterval(timer);
      if (primeira) clearTimeout(primeira);
      timer = null;
      primeira = null;
    },
  };
}
