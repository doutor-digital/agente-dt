/**
 * Sincronizador franquia → Kommo.
 *
 * A cada 15 min, por unidade com token da franquia e slug liberado em
 * `FRANQUIA_SYNC_SLUGS` (lista separada por vírgula; `*` = todas; vazio = desligado):
 *   1. lê os agendamentos de D-3 a D+45 e os tratamentos em andamento;
 *   2. casa cada paciente com um lead do Kommo — primeiro pelo vínculo que a
 *      Sofia já gravou (spine_lead_links), senão pelo telefone do paciente;
 *   3. fase 1: decide o que escrever com `planejarEscritas` (puro) e grava campo a campo;
 *   4. fase 2 (só em `FRANQUIA_MOVE_SLUGS`): decide com `planejarMovimento` (puro) e MOVE a
 *      etapa do cartão — mover dispara bots e o Purchase do n8n, por isso é por unidade.
 *
 * Nunca sobrescreve texto livre da SDR: só os campos listados em CAMPOS_SYNC.
 * O que a franquia não sabe, fica como está.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { escritasDoPaciente, idadeADesencalhar } from './paciente-para-cartao.js';
import { escritasDoTratamento } from './tratamento-para-cartao.js';
import { acharCampoDeSessao, escritasDeSessoes } from './sessoes-para-cartao.js';
import { planejarAtendimento, type CampoCandidato } from './atendimento-para-cartao.js';
import { abrirSessaoTela, montarAvisoDaTela, type AtendimentoTela, type ProblemaDaTela, type SessaoTela } from './franquia-tela.js';
import { avisarJoao } from './alerta-whatsapp.js';
import { planejarCamposSdr, type CampoAtual } from './campos-sdr.js';
import { fichaDoPaciente } from '../services/spine.service.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead, type KommoLeadCustomField } from '../services/kommo.service.js';
import { SPINE_STATUS, SpineService, instanteNoFuso, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { CAMPOS_SYNC, chaveTelefone, ehConsulta, escolherConsulta, melhorTratamento, nomeDaFranquia, nomeParaBusca, normalizar, planejarEscritas, type CampoSync } from './franquia-sync.js';
import { ETAPA, JORNADA, MOTIVO_PERDA, horasAteNegociacao, estadoDoMove, planejarMovimento, tratamentoAberto, tratamentoFinalizado, type EtapaAtual, type Funil, type Movimento, type TratamentoParaEtapa } from './franquia-move.js';
import { normalizarNome } from './kommo-schema.js';
import { fecharComoPerdido } from './parados-worker.js';
import { TAG_SEM_REGUA, type DecisaoParado } from './parados.js';
import { automacaoLigada, estadoDaAutomacao } from './automacoes-estado.js';

const SWEEP_MS = 15 * 60_000;
const PRIMEIRA_MS = 90_000;
const DIAS_ATRAS = 3;
const DIAS_FRENTE = 45;
const MAX_PACIENTES_POR_VARREDURA = 400;
const PAUSA_ENTRE_ESCRITAS_MS = 150;
/** Gentileza com o servidor da franquia (o PHP deles é lento): uma página a cada 1,5 s. */
const PAUSA_ENTRE_LEITURAS_TELA_MS = 1500;
/** Cada cartão com sessão a atualizar custa até ~10 PATCH; o teto espalha a 1ª varredura de uma unidade grande por várias. */
const MAX_SESSOES_POR_VARREDURA = Number(process.env.FRANQUIA_SESSOES_MAX) || 60;
const CACHE_LEAD_MS = 6 * 60 * 60_000;
/** Cada atendimento lido da tela da franquia é 1 página (~300 KB): o teto espalha a 1ª varredura por várias e o cache evita reler o mesmo. */
const MAX_TELA_POR_VARREDURA = Number(process.env.FRANQUIA_TELA_MAX) || 80;
const CACHE_TELA_MS = 3 * 60 * 60_000;
const cacheTela = new Map<string, { em: number; atendimento: AtendimentoTela }>();
/** O mesmo problema só vira WhatsApp de novo depois de 6 h — a causa costuma ser uma só (senha vencida, tela mudou). */
const AVISO_TELA_INTERVALO_MS = 6 * 60 * 60_000;

async function avisarProblemaDaTela(unit: Pick<Unit, 'slug' | 'name'>, tipo: ProblemaDaTela): Promise<void> {
  await avisarJoao(montarAvisoDaTela(unit.name || unit.slug, tipo), `franquia-tela:${unit.slug}:${tipo}`, AVISO_TELA_INTERVALO_MS).catch(() => undefined);
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

/**
 * Quem está sendo varrido AGORA → quando começou (epoch ms).
 *
 * Era uma flag booleana única (`rodando`) para a varredura inteira, e isso fazia três estragos ao
 * mesmo tempo (diagnosticados pelo João em 28/09/2026): enquanto UMA unidade era varrida, toda
 * outra tentativa morria — inclusive a batida automática de 15 em 15 min —, e morria em silêncio.
 * Como cada unidade leva ~15 min e são 6, a volta completa dava ~1h30 e quem caísse no fim da fila
 * ficava sem vez. E o `soSlug` do "forçar agora" só era aplicado DENTRO do laço, depois da trava:
 * forçar Taubaté esperava a varredura inteira de outra unidade — ou seja, quase nunca funcionava.
 *
 * Sendo por unidade, duas unidades diferentes varrem em paralelo sem se atrapalhar, e o que a trava
 * impede passa a ser só o que ela sempre devia impedir: varrer a MESMA unidade duas vezes ao mesmo
 * tempo, que duplicaria escrita no Kommo.
 */
const emVoo = new Map<string, number>();

/** Quem está em voo agora, para a tela de operação dizer por que a fila não andou. */
export function varredurasEmVoo(): Array<{ unit: string; desdeMs: number }> {
  const agora = Date.now();
  return [...emVoo.entries()].map(([unit, desde]) => ({ unit, desdeMs: agora - desde }));
}

export interface LinhaDoPanorama {
  slug: string;
  nome: string;
  ligado: boolean;
  /** há quantos ms esta unidade está sendo varrida AGORA, ou null se não está */
  emVooHaMs: number | null;
  /**
   * Em quantos ms o relógio DESTA unidade dispara. Substituiu a "posição na fila": desde 29/09/2026
   * cada unidade tem o próprio relógio, então fila não existe mais e mostrá-la seria mentira.
   */
  proximaEmMs: number | null;
  vezesHoje: number;
  ultimaEm: string | null;
  ultimaMs: number | null;
  escritas: number | null;
  movimentos: number | null;
  semLead: number | null;
  erros: number | null;
}

/**
 * Tudo que a tela de operação da franquia precisa, numa chamada só: quem está rodando agora, quem
 * é o próximo, quantas vezes cada unidade já rodou hoje e o que a última passada fez.
 *
 * A `posicaoNaFila` usa a MESMA ordenação de `varrer` — se as duas divergirem, a tela mente sobre
 * quem vai primeiro, que é justamente a pergunta que ela existe para responder.
 */
export async function panoramaDoSync(): Promise<LinhaDoPanorama[]> {
  const units = await prisma.unit.findMany({
    where: { spineEnabled: true, spineToken: { not: null }, kommoAccessToken: { not: null } },
    select: { slug: true, name: true },
  });
  const agora = Date.now();
  const ligadas = units.filter((u) => automacaoLigada(u.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS));

  return units
    .map((u) => {
      const r = relogio.get(u.slug);
      const ligado = ligadas.some((l) => l.slug === u.slug);
      const desde = emVoo.get(u.slug);
      const proxima = proximaEm.get(u.slug);
      return {
        slug: u.slug,
        nome: u.name,
        ligado,
        emVooHaMs: desde === undefined ? null : agora - desde,
        proximaEmMs: proxima === undefined ? null : Math.max(0, proxima - agora),
        vezesHoje: r?.vezesHoje ?? 0,
        ultimaEm: r?.ultima?.em ?? null,
        ultimaMs: r?.ms ?? null,
        escritas: r?.ultima?.escritas ?? null,
        movimentos: r?.ultima?.movimentos ?? null,
        semLead: r?.ultima?.semLead ?? null,
        erros: r?.ultima?.erros ?? null,
      };
    })
    .sort((a, b) => Number(b.ligado) - Number(a.ligado) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

export interface ResumoSync {
  unit: string;
  em: string;
  agendamentos: number;
  tratamentos: number;
  pacientes: number;
  comLead: number;
  semLead: number;
  escritas: number;
  erros: number;
  exemplosSemLead: string[];
  /** fase 2: cartões movidos de etapa nesta varredura (0 quando a unidade não está em FRANQUIA_MOVE_SLUGS) */
  movimentos: number;
  /** fase 1c: cartões cujas sessões/tratamento foram atualizados nesta varredura (teto `MAX_SESSOES_POR_VARREDURA`) */
  sessoes?: number;
  /** fase 1d: atendimentos lidos da TELA da franquia (forma de pagamento, retorno, motivo) nesta varredura */
  tela?: number;
  /** fase 1e (teste): campos da SDR calculados — quantos gravaria, quantos conferem e quantos divergem do que a SDR pôs */
  camposSdr?: { gravaria: number; confere: number; diverge: number };
  /** cartões em que a fase 1e escreveu nesta varredura (teto `MAX_CAMPOS_SDR_POR_VARREDURA`) */
  camposSdrCartoes?: number;
  /** fase 2: cartões antigos em AGENDADO (fora da janela D-3) revisados pelo histórico do paciente (23/09/2026) */
  revisados: number;
  /** move em seco: "DE → PARA" → quantos cartões se moveriam nesta varredura (só aparece quando há) */
  simulados?: Record<string, number>;
}
const ultimoResumo = new Map<string, ResumoSync>();
export function resumoDoSync(): ResumoSync[] {
  return [...ultimoResumo.values()];
}

/**
 * Relógio da varredura, por unidade — pedido do João (23/09/2026): "quero saber, dentro do Kommo,
 * há quantos minutos rodou e quantas vezes já rodou hoje". Vive na memória do processo: reiniciou o
 * serviço, a contagem do dia recomeça (e o widget diz isso com o `desde`).
 */
export interface RelogioSync {
  /** fim da última varredura desta unidade */
  ultimaEm: string | null;
  /** quanto tempo ela levou */
  ultimaMs: number | null;
  /** cartões movidos e campos gravados na última */
  ultimosMovimentos: number;
  ultimasEscritas: number;
  /** quantas varreduras desta unidade desde a virada do dia (fuso da unidade) */
  vezesHoje: number;
  /** de quantos em quantos minutos ela roda */
  intervaloMin: number;
  /** quando este processo começou a contar */
  desde: string;
}
interface EntradaRelogio {
  vezesHoje: number;
  dia: string;
  ultima: ResumoSync | null;
  ms: number | null;
  /**
   * Quando esta unidade foi TENTADA pela última vez — deu certo ou não. É por aqui que a fila
   * ordena, e a distinção importa: se ordenasse pela última varredura BEM-SUCEDIDA, uma unidade com
   * credencial vencida nunca registraria sucesso, voltaria ao topo a cada 15 min e passaria a vida
   * na frente de quem está só esperando a vez.
   */
  tentativaEpoch: number;
}
const relogio = new Map<string, EntradaRelogio>();
const processoDesde = new Date().toISOString();

function anotarVarredura(unit: Unit, r: ResumoSync, ms: number): void {
  const dia = instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo').slice(0, 10);
  const atual = relogio.get(unit.slug);
  const vezesHoje = atual && atual.dia === dia ? atual.vezesHoje + 1 : 1;
  relogio.set(unit.slug, { vezesHoje, dia, ultima: r, ms, tentativaEpoch: Date.now() });
}

/** Carimba a tentativa mesmo quando a varredura estourou — ver `tentativaEpoch`. */
function anotarTentativa(slug: string): void {
  const atual = relogio.get(slug);
  if (atual) atual.tentativaEpoch = Date.now();
  else relogio.set(slug, { vezesHoje: 0, dia: '', ultima: null, ms: null, tentativaEpoch: Date.now() });
}

/**
 * Quando esta unidade foi tentada pela última vez. Quem nunca foi tentada devolve 0 e por isso vai
 * para a FRENTE da fila — é o que acaba com o "a última nunca chega a vez".
 */
function ultimaTentativa(slug: string): number {
  return relogio.get(slug)?.tentativaEpoch ?? 0;
}

export function relogioDoSync(slug: string): RelogioSync {
  const r = relogio.get(slug);
  return {
    ultimaEm: r?.ultima?.em ?? null,
    ultimaMs: r?.ms ?? null,
    ultimosMovimentos: r?.ultima?.movimentos ?? 0,
    ultimasEscritas: r?.ultima?.escritas ?? 0,
    vezesHoje: r?.vezesHoje ?? 0,
    intervaloMin: Math.round(SWEEP_MS / 60_000),
    desde: processoDesde,
  };
}

/** paciente (nome normalizado) → lead do Kommo, por unidade; evita repetir a busca por telefone a cada 15 min */
const cacheLead = new Map<string, { leadId: number | null; expiraEm: number }>();


type CampoInfo = Pick<KommoLeadCustomField, 'id' | 'type' | 'enums'>;
type MapaCampos = Partial<Record<CampoSync, CampoInfo>>;

export interface CampoBruto {
  id: number;
  name: string;
  type: string;
  enums?: Array<{ id: number; value: string }> | null;
}

/**
 * Monta o mapa a partir da lista BRUTA do Kommo. "◷ Data da Consulta" e
 * "◷ Agendado pela SDR em" são `date_time` na Imperatriz — tipo que a listagem
 * tipada descarta (foi por isso que a 1ª varredura pulou a unidade); no PATCH o
 * formato é o mesmo do `date` (unix em segundos), então gravamos como `date`.
 */
function mapearCampos(campos: CampoBruto[]): MapaCampos {
  const porNome = new Map(campos.map((c) => [normalizar(c.name), c]));
  const out: MapaCampos = {};
  for (const [chave, nome] of Object.entries(CAMPOS_SYNC) as Array<[CampoSync, string]>) {
    const c = porNome.get(normalizar(nome));
    if (!c) continue;
    const type = c.type === 'date_time' ? 'date' : c.type;
    if (!['date', 'select', 'monetary', 'numeric', 'text', 'textarea', 'radiobutton'].includes(type)) continue;
    out[chave] = { id: c.id, type: type as KommoLeadCustomField['type'], enums: (c.enums ?? []).map((e) => ({ id: e.id, value: e.value })) };
  }
  return out;
}

function valoresDoLead(lead: KommoLead, mapa: MapaCampos): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [chave, nome] of Object.entries(CAMPOS_SYNC) as Array<[CampoSync, string]>) {
    const info = mapa[chave];
    if (!info) continue;
    const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === info.id);
    const v = cf?.values?.[0]?.value;
    out[nome] = v === null || v === undefined || v === '' ? null : String(v);
  }
  return out;
}

async function telefoneDoPaciente(unit: Unit, nome: string, idClient: number | null): Promise<string | null> {
  if (idClient) {
    const r = await SpineService.getClient(unit, idClient);
    if (r.ok && r.data?.client?.whatsapp) return r.data.client.whatsapp;
  }
  const r = await SpineService.searchClients(unit, nome);
  if (!r.ok || !r.data) return null;
  const alvo = normalizar(nome);
  const exatos = r.data.clients.filter((c) => normalizar(c.name) === alvo && c.whatsapp);
  const fones = [...new Set(exatos.map((c) => chaveTelefone(c.whatsapp)))];
  // dois pacientes homônimos com telefones diferentes: não arrisca
  return fones.length === 1 ? exatos[0].whatsapp : null;
}

async function leadPorTelefone(kommo: KommoClient, telefone: string): Promise<number | null> {
  const chave = chaveTelefone(telefone);
  if (!chave) return null;
  const leads = await kommo.listLeadsPorTelefone(telefone);
  if (leads.length === 0) return null;
  const ordenados = [...leads].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  if (ordenados.length === 1) return ordenados[0].id;
  // vários leads: confirma o telefone do contato dos 3 mais recentes
  for (const l of ordenados.slice(0, 3)) {
    const contato = l._embedded?.contacts?.[0]?.id;
    if (!contato) continue;
    const fone = await kommo.getContactPhone(contato);
    if (fone && chaveTelefone(fone) === chave) return l.id;
  }
  return ordenados[0].id;
}

/**
 * Acha o cartão do paciente: primeiro pelo vínculo que a Sofia gravou, depois pelo telefone/nome.
 * Exportada porque a carga de implantação (`franquia-carga.service`) precisa da MESMA resposta para
 * saber quem ainda não tem cartão — duplicar esse casamento seria criar cartão em cima de quem já tem.
 */
export async function resolverLead(unit: Unit, kommo: KommoClient, nome: string, idClient: number | null, idsSchedule: number[]): Promise<number | null> {
  const chaveCache = `${unit.id}:${normalizar(nome)}`;
  const hit = cacheLead.get(chaveCache);
  if (hit && hit.expiraEm > Date.now()) return hit.leadId;

  let leadId: number | null = null;
  if (idsSchedule.length > 0) {
    const link = await prisma.spineLeadLink.findFirst({
      where: { unitId: unit.id, spineIdSchedule: { in: idsSchedule } },
      orderBy: { updatedAt: 'desc' },
    });
    if (link) leadId = link.kommoLeadId;
  }
  if (leadId === null && idClient) {
    const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, spineIdClient: idClient }, orderBy: { updatedAt: 'desc' } });
    if (link) leadId = link.kommoLeadId;
  }
  if (leadId === null) {
    const fone = await telefoneDoPaciente(unit, nome, idClient);
    if (fone) leadId = await leadPorTelefone(kommo, fone);
  }
  cacheLead.set(chaveCache, { leadId, expiraEm: Date.now() + CACHE_LEAD_MS });
  return leadId;
}

function opcoes(mapa: MapaCampos) {
  const vals = (c: CampoSync) => (mapa[c]?.enums ?? []).map((e) => e.value);
  return { fisio: vals('FISIO'), categoria: vals('CATEGORIA'), tratamento: vals('TRAT_FECHADO') };
}

// ── fase 2: mover etapa ──

/** Funis e etapas da conta, pelo NOME: o principal é o COMERCIAL; o outro tem que se chamar TRATAMENTO. */
export interface Funis {
  comercialId: number;
  tratamentoId: number | null;
  status: Map<string, { id: number; nome: string }>; // chave `${funil}:${nomeNormalizado}`
  nomeDe: (pipelineId: number, statusId: number) => EtapaAtual | null;
  idDe: (funil: Funil, etapa: string) => { pipelineId: number; statusId: number } | null;
}

export async function carregarFunis(kommo: KommoClient): Promise<Funis | null> {
  const pipes = await kommo.listPipelines();
  const comercial = pipes.find((p) => p.is_main) ?? pipes.find((p) => normalizarNome(p.name) === normalizarNome('COMERCIAL'));
  if (!comercial) return null;
  const tratamento = pipes.find((p) => normalizarNome(p.name) === normalizarNome('TRATAMENTO')) ?? null;
  const status = new Map<string, { id: number; nome: string }>();
  const inverso = new Map<string, EtapaAtual>();
  const registrar = (funil: Funil, p: { id: number; statuses?: Array<{ id: number; name: string }> }) => {
    for (const s of p.statuses ?? []) {
      status.set(`${funil}:${normalizarNome(s.name)}`, { id: s.id, nome: s.name });
      inverso.set(`${p.id}:${s.id}`, { funil, status: s.name });
    }
  };
  registrar('COMERCIAL', comercial);
  if (tratamento) registrar('TRATAMENTO', tratamento);
  return {
    comercialId: comercial.id,
    tratamentoId: tratamento?.id ?? null,
    status,
    nomeDe: (pipelineId, statusId) => inverso.get(`${pipelineId}:${statusId}`) ?? null,
    idDe: (funil, etapa) => {
      const s = status.get(`${funil}:${normalizarNome(etapa)}`);
      const pipelineId = funil === 'COMERCIAL' ? comercial.id : tratamento?.id;
      return s && pipelineId ? { pipelineId, statusId: s.id } : null;
    },
  };
}

const cacheDetalhe = new Map<string, { treatments: TratamentoParaEtapa[]; schedules: SpineSchedule[]; expiraEm: number }>();
const CACHE_DETALHE_MS = 60 * 60_000;

/**
 * O `/treatments/search` só devolve o mês corrente e a agenda só D-3…D+45. Pra decidir
 * GANHO → EM TRATAMENTO e EM TRATAMENTO → ALTA precisamos do histórico do paciente,
 * que só o detalhe (`GET /clients/{id}`) traz. Uma chamada por paciente por hora.
 */
export async function historicoDoPaciente(unit: Unit, idClient: number | null): Promise<{ treatments: TratamentoParaEtapa[]; schedules: SpineSchedule[] } | null> {
  if (!idClient) return null;
  const k = `${unit.id}:${idClient}`;
  const hit = cacheDetalhe.get(k);
  if (hit && hit.expiraEm > Date.now()) return hit;
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok || !r.data?.client) return null;
  const out = { treatments: r.data.client.treatments, schedules: r.data.client.schedules, expiraEm: Date.now() + CACHE_DETALHE_MS };
  cacheDetalhe.set(k, out);
  return out;
}

/** Todo "moveria" do seco (do move ou da revisão) conta aqui, pra o `simulados` do resumo nunca subestimar o volume. */
function contarSimulado(resumo: ResumoSync, de: string, para: string): void {
  const chave = `${de || '?'} → ${para}`;
  resumo.simulados = { ...resumo.simulados, [chave]: (resumo.simulados?.[chave] ?? 0) + 1 };
}

export async function aplicarMovimento(unit: Unit, kommo: KommoClient, funis: Funis, leadId: number, mov: Movimento, resumo: ResumoSync, deEtapa = ''): Promise<void> {
  const alvo = funis.idDe(mov.funil, mov.para);
  if (!alvo) {
    logger.warn({ unit: unit.slug, leadId, para: mov.para, funil: mov.funil }, 'franquia-move: etapa não existe nesta conta — não movi');
    return;
  }
  // Move em seco (tela de Automações): é o ÚNICO portão por onde todo movimento passa — cartão normal,
  // passagem das 48 h e revisão do histórico —, então nenhum caminho novo escapa dele.
  if (estadoDoMove(unit.slug) === 'seco') {
    contarSimulado(resumo, deEtapa, mov.para);
    logger.info({ unit: unit.slug, leadId, de: deEtapa, para: mov.para, funil: mov.funil, motivo: mov.motivo, motivoPerda: mov.motivoPerda, semRegua: mov.semRegua }, 'franquia-move [seco]: moveria');
    return;
  }
  // PERDIDO pela jornada (fato velho na franquia): mesmo fecho do worker de parados — motivo de perda,
  // etiqueta NO_FOLLOW_UP quando o fato é velho demais pra régua, nota no cartão, confere a etapa antes.
  if (normalizarNome(mov.para) === normalizarNome(ETAPA.PERDIDO)) {
    const d: DecisaoParado = { para: 'PERDIDO', regra: mov.motivo, dias: mov.dias ?? 0, motivoPerda: mov.motivoPerda, semRegua: mov.semRegua === true };
    try {
      if (await fecharComoPerdido(unit, kommo, funis, leadId, deEtapa, d, false)) {
        resumo.movimentos++;
        logger.info({ unit: unit.slug, leadId, de: deEtapa, motivo: mov.motivo, motivoPerda: mov.motivoPerda, semRegua: d.semRegua }, 'franquia-move: cartão fechado como PERDIDO pela jornada');
      }
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId }, 'franquia-move: falha ao fechar como PERDIDO');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
    return;
  }
  try {
    // sem régua (ex-paciente → ALTA): a etiqueta NO_FOLLOW_UP entra ANTES da mudança, é ela que os gatilhos da etapa leem
    if (mov.semRegua) await kommo.addTag({ leadId, tags: [TAG_SEM_REGUA] }).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-move: não consegui etiquetar NO_FOLLOW_UP'));
    await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
    resumo.movimentos++;
    logger.info({ unit: unit.slug, leadId, para: mov.para, funil: mov.funil, motivo: mov.motivo, semRegua: mov.semRegua === true }, 'franquia-move: cartão movido');
  } catch (err) {
    resumo.erros++;
    logger.warn({ err, unit: unit.slug, leadId, para: mov.para }, 'franquia-move: falha ao mover');
  }
  await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
}

/**
 * Regra das 48 h vista pelo Kommo: quem está em COMPARECEU com a consulta atendida há mais de
 * N horas e sem tratamento espelhado vai pra EM NEGOCIAÇÃO. Usa só o que a fase 1 já gravou no
 * cartão, então cobre também quem foi atendido antes da janela da agenda (D-3).
 */
/** lead → idClient resolvido por busca (positivo ou negativo), por unidade; evita repetir a busca a cada 15 min */
const cacheIdClient = new Map<string, { idClient: number | null; expiraEm: number }>();

/**
 * A busca da franquia é por TRECHO CONTÍGUO do nome: "Edvania Pardinho" não acha "EDVANIA MARIA PARDINHO",
 * "Felipe Criste" não acha "FELIPE SANTANA CRISTE", ponto final e espaço duplo derrubam. E o cartão pode
 * ter DUAS pessoas ("MARIA DA PENHA - ALEXANDRO SANT ANA": o paciente era o segundo — achado do João,
 * 23/09/2026). Então: cada pessoa do título vira um bloco de termos, do mais específico ao mais largo,
 * incluindo o SOBRENOME — a franquia escreve o primeiro nome diferente ("ALEXSANDRO" × "ALEXANDRO") e
 * só "SANT ANA" acha. Quem decide entre os candidatos é o telefone.
 */
export function termosDeBuscaDoNome(nome: string | null | undefined): string[] {
  const base = nomeParaBusca(nome);
  if (!base) return [];
  const pessoas = base.split(/\s+[/\-–]\s+|\//).map((p) => p.trim()).filter((p) => p.length >= 3);
  const termos: string[] = [];
  for (const p of pessoas) {
    const w = p.split(' ').filter(Boolean);
    termos.push(p);
    if (w.length > 2) termos.push(w.slice(0, 2).join(' '));
    if (w.length >= 2) termos.push(w.slice(-2).join(' '));
    if (w[0] && w[0].length >= 3) termos.push(w[0]);
    // o SOBRENOME sozinho: "LUVAS LINHARES" é erro de digitação de "LUCAS LINHARES" e só "LINHARES" acha.
    // Partícula ("da", "de", "dos") não serve de busca.
    const ult = w[w.length - 1];
    if (w.length >= 2 && ult && ult.length >= 4) termos.push(ult);
  }
  return [...new Set(termos)].filter((t) => t.length >= 3).slice(0, MAX_TERMOS_DE_BUSCA);
}

/** Entre cadastros DUPLICADOS do mesmo paciente (mesmo nome e telefone), fica o que tem a consulta mais recente. */
async function escolherEntreDuplicados(unit: Unit, cands: Array<{ idClient: number | null }>): Promise<number | null> {
  let melhor: { idClient: number; epoch: number } | null = null;
  for (const c of cands) {
    if (!c.idClient) continue;
    const hist = await historicoDoPaciente(unit, c.idClient);
    const epoch = Math.max(0, ...(hist?.schedules ?? []).map((s) => (s.dateAttendanceUtc ? Date.parse(s.dateAttendanceUtc) : 0)));
    if (!melhor || epoch > melhor.epoch || (epoch === melhor.epoch && c.idClient > melhor.idClient)) melhor = { idClient: c.idClient, epoch };
  }
  return melhor?.idClient ?? null;
}

export type ClienteFranquia = { idClient: number | null; name: string | null; whatsapp: string | null };

export type EscolhaPaciente =
  | { tipo: 'achou'; idClient: number; por: 'telefone' | 'nome' }
  /** vários no mesmo telefone: quem decide é o histórico mais recente (precisa de rede) */
  | { tipo: 'desempatar'; candidatos: ClienteFranquia[] }
  | { tipo: 'nenhum'; motivo: 'sem candidatos' | 'homonimos' | 'nome nao casa' };

/**
 * PURA: dado o que a franquia devolveu, qual é o paciente deste cartão.
 *
 * Regra do João (23/09/2026): **o telefone é a medida padrão** — bateu o número, é ele, o nome não
 * importa. Sem telefone conhecido, só nome exato e único vale. E nome exato com telefone DIFERENTE
 * do que o cartão conhece é homônimo, nunca casa (a "MARIA DA PENHA" de 2019 não é a de agosto).
 *
 * `fone` e os telefones dos candidatos entram já normalizados por `chaveTelefone`; `alvos` são os
 * termos do título já normalizados por `nomeDaFranquia`.
 */
export function escolherPaciente(candidatos: ClienteFranquia[], fone: string, alvos: Set<string>): EscolhaPaciente {
  const vivos = candidatos.filter((c) => c.idClient);
  if (vivos.length === 0) return { tipo: 'nenhum', motivo: 'sem candidatos' };
  const casaNome = (c: ClienteFranquia) => alvos.has(nomeDaFranquia(c.name));
  if (fone) {
    const pf = vivos.filter((c) => chaveTelefone(c.whatsapp) === fone);
    if (pf.length === 1) return { tipo: 'achou', idClient: pf[0].idClient as number, por: 'telefone' };
    if (pf.length > 1) {
      const certo = pf.filter(casaNome);
      return { tipo: 'desempatar', candidatos: certo.length > 0 ? certo : pf };
    }
  }
  const exatos = vivos.filter((c) => casaNome(c) && (!fone || !chaveTelefone(c.whatsapp) || chaveTelefone(c.whatsapp) === fone));
  if (exatos.length === 1) return { tipo: 'achou', idClient: exatos[0].idClient as number, por: 'nome' };
  return { tipo: 'nenhum', motivo: exatos.length > 1 ? 'homonimos' : 'nome nao casa' };
}

async function procurarPaciente(unit: Unit, nome: string | null, extra?: { kommo?: KommoClient; contatoId?: number | null }): Promise<number | null> {
  const termos = termosDeBuscaDoNome(nome);
  if (termos.length === 0) return null;
  // telefone do contato do Kommo × whatsapp da franquia: casa mesmo quando a SDR escreveu o nome diferente
  let fone = '';
  if (extra?.kommo && extra.contatoId) {
    try {
      fone = chaveTelefone(await extra.kommo.getContactPhone(extra.contatoId));
    } catch {
      fone = '';
    }
  }
  const alvos = new Set(termosDeBuscaDoNome(nome).map(normalizar));
  // acumula os candidatos de TODOS os termos: parar no 1º que devolve alguém escondia o paciente
  // quando o cartão tinha dois nomes (o João achou isso no "MARIA DA PENHA - ALEXANDRO SANT ANA")
  const vistos = new Map<number, ClienteFranquia>();
  // atalho: assim que UM candidato bate o telefone, é ele — não gasta as buscas restantes
  const porFone = () => (fone ? [...vistos.values()].filter((c) => chaveTelefone(c.whatsapp) === fone) : []);
  for (const termo of termos) {
    const r = await SpineService.searchClients(unit, termo, 50);
    // erro da API não é "não achei": lança, pra ninguém guardar negativo nem mandar o cartão pra CONFERIR
    if (!r.ok || !r.data) throw new Error(`franquia clients/search falhou: ${r.ok ? 'sem dados' : r.error}`);
    for (const c of r.data.clients) if (c.idClient) vistos.set(c.idClient, c);
    // achou pelo telefone: é ele, não precisa gastar mais chamada
    if (porFone().length === 1) return porFone()[0].idClient;
  }
  const escolha = escolherPaciente([...vistos.values()], fone, alvos);
  if (escolha.tipo === 'achou') return escolha.idClient;
  if (escolha.tipo === 'desempatar') return escolherEntreDuplicados(unit, escolha.candidatos);
  return null;
}

/**
 * idClient do paciente na franquia: pelo vínculo que a Sofia gravou; senão pelo nome do cartão sem a
 * data que a SDR escreve, casando por telefone (quando o contato é conhecido) ou por nome exato único.
 */
export async function idClientDoLead(unit: Unit, leadId: number, nome: string | null, extra?: { kommo?: KommoClient; contatoId?: number | null }): Promise<number | null> {
  const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
  if (link?.spineIdClient) return link.spineIdClient;
  const chave = `${unit.id}:${leadId}`;
  const hit = cacheIdClient.get(chave);
  if (hit && hit.expiraEm > Date.now()) return hit.idClient;
  const idClient = await procurarPaciente(unit, nome, extra);
  cacheIdClient.set(chave, { idClient, expiraEm: Date.now() + CACHE_LEAD_MS });
  return idClient;
}

/** O paciente tem consulta (avaliação/retorno) marcada pra frente? Quem tem retorno marcado não vai pra EM NEGOCIAÇÃO (decisão do João, 18/09). */
export function temConsultaFutura(schedules: SpineSchedule[], agoraEpoch: number): boolean {
  return schedules.some((s) => {
    if (!s.dateAttendanceUtc || !ehConsulta(s)) return false;
    const t = Math.floor(Date.parse(s.dateAttendanceUtc) / 1000);
    return Number.isFinite(t) && t > agoraEpoch && (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO);
  });
}

/**
 * Regra das 48 h vista pelo Kommo: quem está em COMPARECEU com a consulta atendida há mais de
 * N horas e sem tratamento espelhado vai pra EM NEGOCIAÇÃO. Usa o que a fase 1 já gravou no
 * cartão (cobre quem foi atendido antes da janela D-3) e, quando conhece o paciente na franquia,
 * confere o histórico: retorno futuro marcado segura o cartão, mesmo além dos 45 dias da agenda.
 */
async function passarNegociacao(unit: Unit, kommo: KommoClient, funis: Funis, mapa: MapaCampos, resumo: ResumoSync): Promise<void> {
  const compareceu = funis.idDe('COMERCIAL', ETAPA.COMPARECEU);
  if (!compareceu) return;
  const horas = horasAteNegociacao();
  const agora = Math.floor(Date.now() / 1000);
  for (let page = 1; page <= 20; page++) {
    const leads = await kommo.listLeadsPorEtapa(compareceu.pipelineId, compareceu.statusId, 250, page);
    if (leads.length === 0) break;
    for (const lead of leads) {
      const v = valoresDoLead(lead, mapa);
      const dataConsulta = Number(v[CAMPOS_SYNC.DATA_CONSULTA] ?? NaN);
      const situacao = normalizar(v[CAMPOS_SYNC.SITUACAO]);
      const fechou = normalizar(v[CAMPOS_SYNC.FECHOU_TRAT]) === 'sim' || !!v[CAMPOS_SYNC.TRAT_FECHADO];
      if (!Number.isFinite(dataConsulta) || situacao !== 'atendido' || fechou) continue;
      if ((agora - dataConsulta) / 3600 < horas) continue;
      try {
        const idClient = await idClientDoLead(unit, lead.id, lead.name ?? null);
        const hist = await historicoDoPaciente(unit, idClient);
        // retorno marcado OU tratamento ainda aberto (pendente/em andamento) segura; cancelado e finalizado não (achado do Codex, 18/09)
        if (hist && (temConsultaFutura(hist.schedules, agora) || hist.treatments.some(tratamentoAberto))) continue;
      } catch (err) {
        logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'franquia-move: não consegui conferir a franquia antes das 48 h — seguindo pelo cartão');
      }
      await aplicarMovimento(unit, kommo, funis, lead.id, { funil: 'COMERCIAL', para: ETAPA.NEGOCIACAO, motivo: `atendido há ${Math.floor((agora - dataConsulta) / 3600)} h sem tratamento (pelo cartão)` }, resumo, ETAPA.COMPARECEU);
    }
    if (leads.length < 250) break;
  }
}

interface CtxSync {
  unit: Unit;
  kommo: KommoClient;
  funis: Funis | null;
  mapa: MapaCampos;
  ops: ReturnType<typeof opcoes>;
  agoraEpoch: number;
  resumo: ResumoSync;
  /**
   * Todos os campos de lead da conta, indexados pelo nome normalizado. O `mapa` acima só
   * conhece os campos da CONSULTA; o espelho da PESSOA precisa de outros sete, e criar uma
   * segunda constante só pra eles duplicaria a mesma lista em dois lugares.
   */
  camposPorNome?: Array<[string, { id: number; /** nome cru, com o símbolo */ nome?: string; type: KommoLeadCustomField['type']; /** tipo como o Kommo diz (date_time continua date_time; `type` o mapeia pra date) */ rawType?: string; enums: Array<{ id: number; value: string }> }]>;
  /** Sessão na tela da franquia, aberta na primeira vez que um cartão precisa dela (login por varredura, por unidade). */
  tela?: { sessao: SessaoTela | null; aberta: boolean };
  /** `FRANQUIA_REVISAO_SECO=1`: a revisão pelo histórico só registra o que faria (campos e etapa); a varredura normal não muda */
  seco?: boolean;
}

function revisaoSeca(raw: string | undefined = process.env.FRANQUIA_REVISAO_SECO): boolean {
  return /^(1|true|sim)$/i.test((raw ?? '').trim());
}

type Historico = NonNullable<Awaited<ReturnType<typeof historicoDoPaciente>>>;

interface PacienteDoCartao {
  nome: string;
  idClient: number | null;
  consultas: SpineSchedule[];
  tratamento: SpineTreatment | null;
}

/** Os campos do cartão que descrevem a PESSOA — preenchidos pela ficha da franquia. */
const CAMPOS_PESSOA = [
  '⚥ Sexo', '◷ Data de nascimento', '# Idade', '⌂ Endereço',
  '⌂ Cidade', '⌂ Estado', '⚑ Origem na franquia', '✓ Status do paciente',
  // O bloco TRATAMENTO vem da mesma ficha — se algum destes está vazio, vale a chamada.
  '✎ Queixa', '¤ Valor do tratamento', '⚕ Tratamento fechado', '⚕ Fisioterapeuta',
  '# Sessões previstas', '◷ Última sessão marcada', '✓ Compareceu à última sessão marcada',
  '# Nº de faltas em sessão',
] as const;

/**
 * Espelha a PESSOA da franquia no cartão: sexo, nascimento, endereço, origem e status.
 *
 * A ficha completa custa UMA chamada por paciente (`/api/clients/{id}`), então só vale a
 * pena buscá-la quando há buraco pra preencher. Se os sete campos já estiverem cheios, o
 * cartão é pulado sem gastar chamada nenhuma.
 *
 * O preço dessa economia, dito na cara: enquanto tudo estiver preenchido, uma correção
 * feita na franquia (sexo trocado, endereço atualizado) não chega aqui. Quem pega esse
 * caso é o validador de cartão, não este caminho.
 */
async function espelharPaciente(ctx: CtxSync, leadId: number, lead: KommoLead, idClient: number): Promise<void> {
  const { unit, kommo, resumo, seco } = ctx;
  const bruto = (lead.custom_fields_values ?? []);
  const porNome = new Map(ctx.camposPorNome ?? []);
  const valorAtual = (campo: string): string | null => {
    const info = porNome.get(normalizar(campo));
    if (!info) return null;
    const cf = bruto.find((f) => f.field_id === info.id);
    const v = cf?.values?.[0]?.value;
    return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
  };

  // A idade primeiro, e de graça: ela se corrige a partir da data que já está no cartão,
  // sem consultar a franquia. É o que impede "45" de continuar lá depois do aniversário.
  const idade = idadeADesencalhar(valorAtual);
  if (idade) {
    const info = porNome.get(normalizar(idade.campo));
    if (info && !seco) {
      await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, idade.valor, info.enums)
        .then(() => { resumo.escritas++; logger.info({ unit: unit.slug, leadId, valor: idade.valor }, 'franquia-sync: idade recalculada'); })
        .catch((err) => { resumo.erros++; logger.warn({ err, unit: unit.slug, leadId }, 'franquia-sync: falha ao recalcular idade'); });
    } else if (info && seco) {
      logger.info({ unit: unit.slug, leadId, valor: idade.valor }, 'franquia-sync [seco]: recalcularia idade');
    }
  }

  const temBuraco = CAMPOS_PESSOA.some((c) => porNome.has(normalizar(c)) && valorAtual(c) === null);
  if (!temBuraco) return;

  const r = await fichaDoPaciente(unit as never, idClient).catch(() => null);
  if (!r?.ok || !r.data?.ficha) return;

  const opcoesProtocolo = (porNome.get(normalizar('⚕ Tratamento fechado'))?.enums ?? []).map((x) => x.value);
  const planejadas = [
    ...escritasDoPaciente(r.data.ficha, valorAtual),
    ...escritasDoTratamento({
      sessoes: r.data.ficha.schedules as never,
      tratamento: (r.data.ficha.treatments?.[0] ?? null) as never,
      opcoesProtocolo,
      valorAtual,
    }),
  ];
  for (const e of planejadas) {
    const info = porNome.get(normalizar(e.campo));
    if (!info) continue;
    if (!e.sobrescreve && valorAtual(e.campo) !== null) continue;
    // Campo de lista só aceita opção que EXISTE naquela conta. A franquia manda o nome do
    // fisioterapeuta que atendeu, e cada clínica tem a sua equipe — em Divinópolis isso
    // virou 400 NotSupportedChoice em série. Mesmo contrato do backfill-campos: não
    // inventa opção, pula e registra.
    if (['select', 'multiselect', 'radiobutton'].includes(info.type) && info.enums.length) {
      const existe = info.enums.some((x) => normalizar(x.value) === normalizar(String(e.valor)));
      if (!existe) {
        logger.info(
          { unit: unit.slug, leadId, campo: e.campo, valor: e.valor },
          'franquia-sync: opção não existe nesta conta — não gravei',
        );
        continue;
      }
    }
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-sync [seco]: gravaria campo da pessoa');
      continue;
    }
    try {
      await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, e.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-sync: campo da pessoa gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: e.campo }, 'franquia-sync: falha ao gravar campo da pessoa');
    }
    await new Promise((r2) => setTimeout(r2, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/**
 * Sessões e tratamento no cartão (fase 1c), ATUALIZADOS a cada varredura — o `espelharPaciente` só
 * preenche buraco, o que é certo para queixa e errado para contador (ver `sessoes-para-cartao.ts`).
 *
 * Os contadores só saem do histórico COMPLETO do paciente (`GET /clients/{id}`, cache de 1 h): a
 * agenda da varredura cobre D-3…D+45 e contar só ela diria "2 realizadas" para quem fez 14 sessões.
 * Sem o histórico em mãos grava apenas o que é do tratamento (id, local, grau, status).
 */
async function espelharSessoes(ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao, historico: Historico | null): Promise<void> {
  const { unit, kommo, resumo, agoraEpoch } = ctx;
  if (!p.tratamento?.idTreatment) return;
  // Chave por unidade (tela de Automações): desligado = não faz nada; seco = só registra o que gravaria.
  const estado = estadoDaAutomacao(unit.slug, 'franquia-sessoes', process.env.FRANQUIA_SESSOES_SLUGS);
  if (estado === 'desligado') return;
  const seco = estado === 'seco' || ctx.seco === true;
  if ((resumo.sessoes ?? 0) >= MAX_SESSOES_POR_VARREDURA) return;
  const hist = historico ?? (p.idClient ? await historicoDoPaciente(unit, p.idClient) : null);
  const ids = new Set(p.consultas.map((s) => s.idSchedule));
  const schedules = hist ? [...p.consultas, ...hist.schedules.filter((s) => !ids.has(s.idSchedule))] : [];

  if (seco && hist) {
    // Prova em produção de uma dúvida em aberto: a ficha do paciente manda o id do tratamento em cada sessão?
    // Se `comIdTratamento` vier 0, a separação de ciclos cai na data de criação do tratamento.
    const doHistorico = hist.schedules.filter((s) => !ehConsulta(s));
    logger.info(
      { unit: unit.slug, leadId, sessoesNoHistorico: doHistorico.length, comIdTratamento: doHistorico.filter((s) => s.idTreatment !== null).length },
      'franquia-sync [seco]: sessões do histórico do paciente',
    );
  }

  const porNome = new Map(ctx.camposPorNome ?? []);
  const bruto = lead.custom_fields_values ?? [];
  const campo = (nome: string) => {
    const info = acharCampoDeSessao(porNome, nome, normalizar);
    if (!info) return null;
    const v = bruto.find((f) => f.field_id === info.id)?.values?.[0]?.value;
    return { tipo: info.rawType ?? (info.type as string), valor: v === undefined || v === null || String(v).trim() === '' ? null : String(v) };
  };

  const planejadas = escritasDeSessoes({ schedules, tratamento: p.tratamento, agoraEpoch, campo });
  if (planejadas.length > 0) resumo.sessoes = (resumo.sessoes ?? 0) + 1;
  for (const e of planejadas) {
    const info = acharCampoDeSessao(porNome, e.campo, normalizar);
    if (!info) continue;
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.limpar ? '(limpar)' : e.valor, motivo: e.motivo }, 'franquia-sync [seco]: gravaria sessão/tratamento');
      continue;
    }
    try {
      if (e.limpar) await kommo.clearLeadCustomField(leadId, info.id);
      else await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, e.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.limpar ? '(limpar)' : e.valor, motivo: e.motivo }, 'franquia-sync: sessão/tratamento gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: e.campo }, 'franquia-sync: falha ao gravar sessão/tratamento');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/**
 * Atendimento da franquia no cartão (fase 1d): forma de pagamento, data do retorno e motivo para não realizar o
 * tratamento, lidos da TELA de edição do atendimento — a API não os devolve. Só para quem já foi atendido
 * (avaliação ou retorno com desfecho ATENDIDO). Detalhes e regras em `atendimento-para-cartao.ts`.
 *
 * Chave `franquia-tela` (tela de Automações): desligado não faz nada; seco registra o que gravaria. O login vem de
 * FRANQUIA_TELA_USER/FRANQUIA_TELA_PASS; sem ele a fase inteira é pulada com um aviso.
 */
async function espelharAtendimento(ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  const estado = estadoDaAutomacao(unit.slug, 'franquia-tela', process.env.FRANQUIA_TELA_SLUGS);
  if (estado === 'desligado' || !ctx.tela) return;
  const seco = estado === 'seco' || ctx.seco === true;

  const consulta = escolherConsulta(p.consultas);
  if (!consulta?.idSchedule || consulta.idStatus !== SPINE_STATUS.ATENDIDO) return;

  const chave = `${unit.slug}:${consulta.idSchedule}`;
  let atendimento = cacheTela.get(chave);
  if (!atendimento || Date.now() - atendimento.em > CACHE_TELA_MS) {
    if ((resumo.tela ?? 0) >= MAX_TELA_POR_VARREDURA) return;
    if (!ctx.tela.aberta) {
      ctx.tela.aberta = true;
      ctx.tela.sessao = await abrirSessaoTela(unit.slug);
      if (!ctx.tela.sessao) await avisarProblemaDaTela(unit, 'entrar');
    }
    if (!ctx.tela.sessao || ctx.tela.sessao.quebrada || ctx.tela.sessao.layoutMudou) return;
    const lido = await ctx.tela.sessao.lerAtendimento(consulta.idSchedule);
    if (!lido) {
      if (ctx.tela.sessao.quebrada) await avisarProblemaDaTela(unit, 'sessao');
      else if (ctx.tela.sessao.layoutMudou) await avisarProblemaDaTela(unit, 'layout');
      return;
    }
    resumo.tela = (resumo.tela ?? 0) + 1;
    atendimento = { em: Date.now(), atendimento: lido };
    if (cacheTela.size > 500) for (const [k, v] of cacheTela) if (Date.now() - v.em > CACHE_TELA_MS) cacheTela.delete(k);
    cacheTela.set(chave, atendimento);
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_LEITURAS_TELA_MS));
  }

  const bruto = lead.custom_fields_values ?? [];
  const campos = (nome: string): CampoCandidato[] =>
    (ctx.camposPorNome ?? [])
      .filter(([chaveNome]) => chaveNome === normalizar(nome))
      .map(([, info]) => {
        const v = bruto.find((f) => f.field_id === info.id)?.values?.[0]?.value;
        return {
          id: info.id,
          tipo: info.rawType ?? (info.type as string),
          valor: v === undefined || v === null || String(v).trim() === '' ? null : String(v),
          opcoes: info.enums.map((x) => x.value),
        };
      });

  const plano = planejarAtendimento({ atendimento: atendimento.atendimento, campos, fuso: unit.spineTimezone || 'America/Sao_Paulo' });
  for (const aviso of plano.avisos) logger.info({ unit: unit.slug, leadId, aviso }, 'franquia-tela: não gravei');

  for (const e of plano.escritas) {
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-tela [seco]: gravaria atendimento');
      continue;
    }
    const info = (ctx.camposPorNome ?? []).map(([, i]) => i).find((i) => i.id === e.id);
    if (!info) continue;
    try {
      await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, e.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: e.campo, valor: e.valor, motivo: e.motivo }, 'franquia-tela: atendimento gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: e.campo }, 'franquia-tela: falha ao gravar atendimento');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/** Linha de teste já registrada neste processo: o mesmo "gravaria/confere/diverge" não se repete a cada 15 min. */
const comparacoesVistas = new Set<string>();
/** Teto de cartões com escrita por varredura: a 1ª vez que liga numa unidade grande não pode segurar o move. */
const MAX_CAMPOS_SDR_POR_VARREDURA = Number(process.env.CAMPOS_SDR_MAX) || 60;

function jaRegistrou(chave: string): boolean {
  if (comparacoesVistas.has(chave)) return true;
  comparacoesVistas.add(chave);
  // apara as mais antigas (o Set guarda a ordem de entrada) em vez de esvaziar tudo e repetir o log inteiro
  if (comparacoesVistas.size > 20_000) {
    let n = 0;
    for (const k of comparacoesVistas) { comparacoesVistas.delete(k); if (++n >= 5_000) break; }
  }
  return false;
}

/**
 * Campos que a SDR preenchia à mão (fase 1e, em TESTE): Tipo de lead, Responsável agendamento e Data de
 * solicitação de cancelamento. Regras e decisões em `campos-sdr.ts`.
 *
 * Chave `campos-sdr` (tela de Automações): desligado não faz nada; seco registra o que gravaria; ligado grava SÓ
 * em campo vazio. Nos dois modos registra se o calculado CONFERE ou DIVERGE do que a SDR já pôs — é o teste em
 * produção antes de aprovar.
 */
async function espelharCamposSdr(
  ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao, consulta: SpineSchedule | null, feitoPelaIa: boolean,
): Promise<void> {
  const { unit, kommo, resumo } = ctx;
  const estado = estadoDaAutomacao(unit.slug, 'campos-sdr', process.env.CAMPOS_SDR_SLUGS);
  // a cópia do Tipo de lead (Tipo de agendamento/fechamento) tem chave própria: liga/testa sem mexer nas outras
  const estadoTipos = estadoDaAutomacao(unit.slug, 'campos-sdr-tipos', process.env.CAMPOS_SDR_TIPOS_SLUGS);
  if (estado === 'desligado' && estadoTipos === 'desligado') return;
  const secoDe = (r: { copia?: true }) => (r.copia ? estadoTipos : estado) === 'seco' || ctx.seco === true;

  const bruto = lead.custom_fields_values ?? [];
  const porNome = ctx.camposPorNome ?? [];
  // Nome exato (com o símbolo) primeiro: a normalização tira o "⬢" e "Tipo de lead" antigo casaria com o novo.
  const info = (nome: string) => {
    const mesmos = porNome.filter(([k]) => k === normalizar(nome)).map(([, i]) => i);
    return mesmos.find((i) => i.nome === nome) ?? mesmos[0] ?? null;
  };
  const campo = (nome: string): CampoAtual | null => {
    const i = info(nome);
    if (!i) return null;
    const v = bruto.find((f) => f.field_id === i.id)?.values?.[0]?.value;
    return { valor: v === undefined || v === null || String(v).trim() === '' ? null : String(v), opcoes: i.enums.map((x) => x.value) };
  };
  const carimbo = Number(campo('◷ Agendado pela SDR em')?.valor);
  const temCarimbo = Number.isFinite(carimbo) && carimbo > 0;
  const dataConsulta = consulta?.dateAttendanceUtc ? Math.floor(Date.parse(consulta.dateAttendanceUtc) / 1000) : NaN;

  const primeiroContato = Number(campo('◷ Data do primeiro contato')?.valor);
  const plano = planejarCamposSdr({
    campo,
    nome: lead.name,
    criadoEmEpoch: lead.created_at ?? null,
    primeiroContatoEpoch: Number.isFinite(primeiroContato) && primeiroContato > 0 ? primeiroContato : null,
    // quando chegou ao agendamento: o carimbo; sem ele, a data da consulta. Nunca "agora".
    referenciaEpoch: temCarimbo ? carimbo : Number.isFinite(dataConsulta) ? dataConsulta : null,
    primeiraVez: !temCarimbo,
    consulta,
    feitoPelaIa,
    tratamento: p.tratamento,
    copiarTipos: estadoTipos !== 'desligado',
  }).filter((r) => (r.copia ? estadoTipos : estado) !== 'desligado');
  if (plano.length === 0) return;
  resumo.camposSdr ??= { gravaria: 0, confere: 0, diverge: 0 };
  const vaiEscrever = plano.some((r) => r.acao === 'gravar' && !secoDe(r));
  if (vaiEscrever && (resumo.camposSdrCartoes ?? 0) >= MAX_CAMPOS_SDR_POR_VARREDURA) return;
  if (vaiEscrever) resumo.camposSdrCartoes = (resumo.camposSdrCartoes ?? 0) + 1;

  for (const r of plano) {
    const rotulo = r.copia ? 'campos-sdr-tipos' : 'campos-sdr';
    if (r.acao !== 'gravar') {
      resumo.camposSdr[r.acao]++;
      if (!jaRegistrou(`${unit.slug}:${leadId}:${r.campo}:${r.acao}:${r.noCartao}`)) {
        logger.info({ unit: unit.slug, leadId, campo: r.campo, calculado: r.valor, noCartao: r.noCartao, motivo: r.motivo }, `${rotulo}: ${r.acao}`);
      }
      continue;
    }
    resumo.camposSdr.gravaria++;
    if (secoDe(r)) {
      if (!jaRegistrou(`${unit.slug}:${leadId}:${r.campo}:gravaria:${r.valor}`)) {
        logger.info({ unit: unit.slug, leadId, campo: r.campo, valor: r.valor, motivo: r.motivo }, `${rotulo} [seco]: gravaria`);
      }
      continue;
    }
    const i = info(r.campo);
    if (!i) continue;
    try {
      await kommo.setLeadCustomFieldValue(leadId, i.id, i.type, r.valor, i.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: r.campo, valor: r.valor, motivo: r.motivo }, `${rotulo}: gravado`);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: r.campo }, `${rotulo}: falha ao gravar`);
    }
    await new Promise((res) => setTimeout(res, PAUSA_ENTRE_ESCRITAS_MS));
  }
}

/**
 * Um cartão: fase 1 (campos espelhando a franquia) e fase 2 (etapa pela máquina de `planejarMovimento`).
 * `historico` = detalhe do paciente já em mãos (a revisão dos antigos traz; a varredura normal só busca
 * quando a etapa exige — GANHO e funil TRATAMENTO).
 */
async function processarCartao(ctx: CtxSync, leadId: number, lead: KommoLead, p: PacienteDoCartao, historico: Historico | null = null): Promise<void> {
  const { unit, kommo, funis, mapa, ops, agoraEpoch, resumo, seco } = ctx;
  const consulta = escolherConsulta(p.consultas);
  const consultaEpoch = consulta?.dateAttendanceUtc ? Math.floor(Date.parse(consulta.dateAttendanceUtc) / 1000) : null;
  const feitoPelaIa = consulta?.idSchedule
    ? !!(await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdSchedule: consulta.idSchedule } }))
    : false;
  const escritas = planejarEscritas({ valores: valoresDoLead(lead, mapa), consulta, consultaEpoch: Number.isFinite(consultaEpoch as number) ? consultaEpoch : null, tratamento: p.tratamento, feitoPelaIa, agoraEpoch, opcoes: ops });
  for (const w of escritas) {
    const info = mapa[w.campo];
    if (!info) continue;
    if (seco) {
      logger.info({ unit: unit.slug, leadId, campo: w.nome, valor: w.limpar ? '(limpar)' : w.valor, motivo: w.motivo }, 'franquia-sync [seco]: gravaria campo');
      continue;
    }
    try {
      if (w.limpar) await kommo.clearLeadCustomField(leadId, info.id);
      else await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, w.valor, info.enums);
      resumo.escritas++;
      logger.info({ unit: unit.slug, leadId, campo: w.nome, valor: w.limpar ? '(limpar)' : w.valor, motivo: w.motivo }, 'franquia-sync: campo gravado');
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, leadId, campo: w.nome }, 'franquia-sync: falha ao gravar campo');
    }
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
  }

  // fase 1b: a PESSOA (sexo, nascimento, endereço, origem, status)
  if (p.idClient) {
    await espelharPaciente(ctx, leadId, lead, p.idClient).catch((err) =>
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: espelho da pessoa falhou'),
    );
  }

  // fase 1c: sessões e tratamento, atualizados
  await espelharSessoes(ctx, leadId, lead, p, historico).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: espelho das sessões falhou'),
  );

  // fase 1d: forma de pagamento, retorno e motivo, lidos da tela do atendimento
  await espelharAtendimento(ctx, leadId, lead, p).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: espelho do atendimento falhou'),
  );

  // fase 1e (teste em seco): campos que a SDR preenchia — tipo de lead, responsável, data do cancelamento
  await espelharCamposSdr(ctx, leadId, lead, p, consulta, feitoPelaIa).catch((err) =>
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'franquia-sync: campos da SDR falharam'),
  );

  // fase 2: a franquia move o cartão
  if (!funis) return;
  const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
  if (!atual) return;
  let agendamentos: SpineSchedule[] = p.consultas;
  // o /treatments/search não traz idStatus; o nome do status basta ("EM ANDAMENTO", "FINALIZADO")
  let tratamentos: TratamentoParaEtapa[] = p.tratamento ? [{ idStatus: null, statusName: p.tratamento.statusName ?? null }] : [];
  // GANHO e EM TRATAMENTO dependem do histórico inteiro (sessão antiga, tratamento de outro mês)
  const precisaHistorico = historico !== null || normalizarNome(atual.status) === normalizarNome(ETAPA.GANHO) || atual.funil === 'TRATAMENTO';
  if (precisaHistorico) {
    // a agenda não traz idClient e o /treatments/search só lista tratamento em andamento:
    // quem finalizou some da lista — sem isto a ALTA nunca dispararia
    const hist = historico ?? (await historicoDoPaciente(unit, p.idClient ?? (await idClientDoLead(unit, leadId, p.nome))));
    if (hist) {
      const ids = new Set(agendamentos.map((s) => s.idSchedule));
      agendamentos = [...agendamentos, ...hist.schedules.filter((s) => !ids.has(s.idSchedule))];
      if (hist.treatments.length > 0) tratamentos = hist.treatments;
    }
  }
  const mov = planejarMovimento({ atual, agendamentos, tratamentos, agoraEpoch, horasAteNegociacao: horasAteNegociacao() });
  if (!mov) return;
  if (seco) {
    contarSimulado(resumo, atual.status, mov.para);
    logger.info({ unit: unit.slug, leadId, nome: lead.name, de: atual.status, para: mov.para, funil: mov.funil, motivo: mov.motivo, motivoPerda: mov.motivoPerda, semRegua: mov.semRegua }, 'franquia-move [seco]: moveria');
    return;
  }
  await aplicarMovimento(unit, kommo, funis, leadId, mov, resumo, atual.status);
}

const REVISAO_MAX_POR_VARREDURA = Number(process.env.FRANQUIA_REVISAO_MAX) || 60;
/** teto de buscas na franquia por cartão: cada termo é uma chamada; 8 cobre dois nomes com sobrenome */
const MAX_TERMOS_DE_BUSCA = Number(process.env.FRANQUIA_MAX_TERMOS) || 10;

/**
 * Quais cartões a revisão pelo histórico olha (23/09/2026, pedido do João: "tem que puxar tudo certinho"):
 * - CONFERIR NA FRANQUIA: todos (achou o paciente? volta pra etapa certa; 30 d sem acerto → PERDIDO)
 * - AGENDADO com «◷ Data da Consulta» mais velha que D-3 ou vazia (a agenda D-3…D+45 nunca os vê)
 * - COMPARECEU / EM NEGOCIAÇÃO cuja Situação no cartão não é "Atendido" (a SDR moveu na mão, a franquia não confirmou)
 */
export function candidatoARevisao(etapa: string, valores: Record<string, string | null>, corteEpoch: number): boolean {
  const n = normalizarNome(etapa);
  const data = Number(valores[CAMPOS_SYNC.DATA_CONSULTA] ?? NaN);
  if (n === normalizarNome(ETAPA.CONFERIR)) return true;
  if (n === normalizarNome(ETAPA.AGENDADO)) return !Number.isFinite(data) || data < corteEpoch;
  if (n === normalizarNome(ETAPA.COMPARECEU) || n === normalizarNome(ETAPA.NEGOCIACAO)) {
    return normalizar(valores[CAMPOS_SYNC.SITUACAO]) !== 'atendido' || !Number.isFinite(data);
  }
  return false;
}

function notaConferir(nome: string): string {
  return `🔎 A franquia não tem este paciente pelo nome «${nome.trim()}» nem pelo telefone do contato. Acerte o cadastro lá (nome e WhatsApp) ou o telefone aqui no cartão: corrigido, o cartão volta sozinho pra etapa certa em até 15 min. Sem acerto em ${JORNADA.CONFERIR_MAX_DIAS} dias vira PERDIDO ("${MOTIVO_PERDA.SEM_CADASTRO}").`;
}

/**
 * Caminho inverso: cartão → paciente (vínculo, nome sem a data da SDR, telefone) → histórico do
 * paciente (`GET /clients/{id}`, 1×/h) → mesma fase 1 e mesma máquina de etapas (jornada pela idade
 * do fato). Quem a franquia não conhece vai pra CONFERIR NA FRANQUIA (fila da SDR) e, 30 d depois sem
 * acerto, PERDIDO "sem cadastro". Erro da API da franquia não move nada (a busca lança).
 * Ex-paciente (tratamento finalizado, nada aberto) que aparece em etapa comercial: só registro — a ALTA
 * dispara templates de parabéns e não cabe meses depois.
 */
async function revisarPeloHistorico(ctxBase: CtxSync): Promise<void> {
  // A tela pode pôr ESTA unidade em seco sem mexer na variável global — por isso a pergunta vem
  // antes de montar o ctx, que é quem carrega o `seco` pro resto da revisão.
  const seco = estadoDaAutomacao(ctxBase.unit.slug, 'franquia-revisao', process.env.FRANQUIA_REVISAO_SLUGS) === 'seco' || revisaoSeca();
  const ctx: CtxSync = { ...ctxBase, seco };
  const { unit, kommo, funis, mapa, agoraEpoch, resumo } = ctx;
  if (!funis) return;
  if (!automacaoLigada(unit.slug, 'franquia-revisao', process.env.FRANQUIA_REVISAO_SLUGS)) return;
  if (seco) logger.info({ unit: unit.slug }, 'franquia-move [seco]: revisão pelo histórico só registra, não mexe');
  const corte = agoraEpoch - DIAS_ATRAS * 86_400;
  const conferir = funis.idDe('COMERCIAL', ETAPA.CONFERIR);
  if (!conferir) logger.warn({ unit: unit.slug }, `franquia-move: conta sem a etapa "${ETAPA.CONFERIR}" — cartão sem paciente fica onde está`);
  let avaliados = 0;
  for (const etapa of [ETAPA.CONFERIR, ETAPA.AGENDADO, ETAPA.COMPARECEU, ETAPA.NEGOCIACAO]) {
    const alvo = funis.idDe('COMERCIAL', etapa);
    if (!alvo) continue;
    const emConferir = etapa === ETAPA.CONFERIR;
    for (let page = 1; page <= 20; page++) {
      const leads = await kommo.listLeadsPorEtapa(alvo.pipelineId, alvo.statusId, 250, page, true);
      if (leads.length === 0) break;
      for (const lead of leads) {
        if (!candidatoARevisao(etapa, valoresDoLead(lead, mapa), corte)) continue;
        // já procurei este e não achei (cache 6 h): não gasta cota nem chamada; em CONFERIR ainda vale a regra dos 30 d
        const lembrado = cacheIdClient.get(`${unit.id}:${lead.id}`);
        const negativoLembrado = !!lembrado && lembrado.idClient === null && lembrado.expiraEm > Date.now();
        if (negativoLembrado && !emConferir) continue;
        if (!negativoLembrado) {
          if (avaliados >= REVISAO_MAX_POR_VARREDURA) return;
          avaliados++;
        }
        try {
          const idClient = negativoLembrado ? null : await idClientDoLead(unit, lead.id, lead.name ?? null, { kommo, contatoId: lead._embedded?.contacts?.[0]?.id ?? null });
          if (!idClient) {
            if (emConferir) {
              const parado = (agoraEpoch - (lead.updated_at ?? agoraEpoch)) / 86_400;
              // trava: cartão com consulta marcada PRA FRENTE nunca vira PERDIDO, mesmo sem paciente casado.
              // A fase 1 escreve essa data quando a franquia acha o paciente pelo telefone (caminho inverso do
              // nosso) — foi assim que dois cartões com consulta marcada foram fechados por engano em 23/09.
              const dataCartao = Number(valoresDoLead(lead, mapa)[CAMPOS_SYNC.DATA_CONSULTA] ?? NaN);
              if (Number.isFinite(dataCartao) && dataCartao > agoraEpoch) {
                logger.info({ unit: unit.slug, leadId: lead.id, dataConsulta: dataCartao }, 'franquia-move: em CONFERIR mas com consulta marcada pra frente — não fecho');
                continue;
              }
              if (parado > JORNADA.CONFERIR_MAX_DIAS) {
                const mov: Movimento = { funil: 'COMERCIAL', para: ETAPA.PERDIDO, motivo: `${Math.floor(parado)} d em ${ETAPA.CONFERIR} sem acerto do cadastro`, motivoPerda: MOTIVO_PERDA.SEM_CADASTRO, semRegua: true, dias: Math.floor(parado) };
                if (seco) {
                  contarSimulado(resumo, etapa, mov.para);
                  logger.info({ unit: unit.slug, leadId: lead.id, nome: lead.name, de: etapa, para: mov.para, motivo: mov.motivo }, 'franquia-move [seco]: moveria');
                }
                else await aplicarMovimento(unit, kommo, funis, lead.id, mov, resumo, etapa);
              }
              continue;
            }
            if (!conferir) continue;
            if (seco || estadoDoMove(unit.slug) === 'seco') {
              contarSimulado(resumo, etapa, ETAPA.CONFERIR);
              logger.info({ unit: unit.slug, leadId: lead.id, nome: lead.name, de: etapa, para: ETAPA.CONFERIR }, 'franquia-move [seco]: moveria');
              continue;
            }
            await kommo.moveStage({ leadId: lead.id, statusId: conferir.statusId, pipelineId: conferir.pipelineId });
            resumo.movimentos++;
            await kommo.addLeadNote(lead.id, notaConferir(lead.name ?? '')).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id }, 'franquia-move: nota de CONFERIR falhou'));
            logger.info({ unit: unit.slug, leadId: lead.id, de: etapa, nome: lead.name }, `franquia-move: paciente não achado na franquia — cartão foi pra ${ETAPA.CONFERIR}`);
            await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
            continue;
          }
          const hist = await historicoDoPaciente(unit, idClient);
          if (!hist) continue;
          // histórico inteiro: a máquina decide pela última avaliação e trata finalizado velho como ex-paciente (ALTA sem mensagem)
          if (hist.schedules.length === 0 && hist.treatments.length === 0) {
            logger.info({ unit: unit.slug, leadId: lead.id, idClient }, 'franquia-move: paciente achado, mas sem consulta nem tratamento no histórico — fica');
            continue;
          }
          if (hist.treatments.some(tratamentoFinalizado) && !hist.treatments.some(tratamentoAberto)) logger.info({ unit: unit.slug, leadId: lead.id, idClient, de: etapa }, 'franquia-move: ex-paciente (tratamento finalizado) em etapa comercial');
          resumo.revisados++;
          await processarCartao(ctx, lead.id, lead, { nome: lead.name ?? '', idClient, consultas: hist.schedules, tratamento: null }, hist);
        } catch (err) {
          resumo.erros++;
          logger.warn({ err: String(err), unit: unit.slug, leadId: lead.id, de: etapa }, 'franquia-move: falha na revisão pelo histórico');
        }
      }
      if (leads.length < 250) break;
    }
  }
}

async function sincronizarUnidade(unit: Unit): Promise<ResumoSync> {
  const resumo: ResumoSync = { unit: unit.slug, em: new Date().toISOString(), agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0, revisados: 0 };
  const kommo = createKommoClient(unit);
  const bruto = (await kommo.listLeadCustomFields()) as { _embedded?: { custom_fields?: CampoBruto[] } } | undefined;
  const camposBrutos = bruto?._embedded?.custom_fields ?? [];
  const mapa = mapearCampos(camposBrutos);
  const camposPorNome: NonNullable<CtxSync['camposPorNome']> = camposBrutos
    .filter((c) => ['date', 'date_time', 'select', 'monetary', 'numeric', 'text', 'textarea', 'radiobutton'].includes(c.type))
    .map((c) => [normalizar(c.name), {
      id: c.id,
      nome: c.name,
      rawType: c.type,
      type: (c.type === 'date_time' ? 'date' : c.type) as KommoLeadCustomField['type'],
      enums: (c.enums ?? []).map((e) => ({ id: e.id, value: e.value })),
    }]);
  if (!mapa.DATA_CONSULTA || !mapa.SITUACAO) {
    logger.warn({ unit: unit.slug }, 'franquia-sync: conta sem os campos de consulta — pulando');
    return resumo;
  }
  const mover = estadoDoMove(unit.slug) !== 'desligado';
  const funis = mover ? await carregarFunis(kommo) : null;
  if (mover && !funis) logger.warn({ unit: unit.slug }, 'franquia-move: conta sem funil principal — só campos');
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const hoje = instanteNoFuso(new Date(), tz).slice(0, 10);
  const somar = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

  const [ag, tr] = await Promise.all([
    SpineService.searchSchedules(unit, { initialDate: somar(hoje, -DIAS_ATRAS), endDate: somar(hoje, DIAS_FRENTE), rowsPerPage: 100 }),
    SpineService.searchTreatments(unit),
  ]);
  const agendamentos: SpineSchedule[] = ag.ok ? (ag.data?.schedules ?? []) : [];
  const tratamentos: SpineTreatment[] = tr.ok ? (tr.data?.treatments ?? []) : [];
  if (!ag.ok) logger.warn({ unit: unit.slug, erro: ag.error }, 'franquia-sync: agenda indisponível');
  if (!tr.ok) logger.warn({ unit: unit.slug, erro: tr.error }, 'franquia-sync: tratamentos indisponíveis');
  resumo.agendamentos = agendamentos.length;
  resumo.tratamentos = tratamentos.length;

  // agrupa por paciente (a agenda não traz idClient; o nome é a chave)
  const porPaciente = new Map<string, { nome: string; idClient: number | null; consultas: SpineSchedule[]; tratamento: SpineTreatment | null }>();
  for (const s of agendamentos) {
    if (!s.clientName) continue;
    const k = normalizar(s.clientName);
    const p = porPaciente.get(k) ?? { nome: s.clientName, idClient: null, consultas: [], tratamento: null };
    p.consultas.push(s);
    porPaciente.set(k, p);
  }
  for (const t of tratamentos) {
    if (!t.clientName) continue;
    const k = normalizar(t.clientName);
    const p = porPaciente.get(k) ?? { nome: t.clientName, idClient: t.idClient, consultas: [], tratamento: null };
    p.tratamento = melhorTratamento(p.tratamento, t);
    p.idClient = p.idClient ?? t.idClient;
    porPaciente.set(k, p);
  }
  resumo.pacientes = porPaciente.size;
  const ops = opcoes(mapa);
  const agoraEpoch = Math.floor(Date.now() / 1000);
  const ctx: CtxSync = { unit, kommo, funis, mapa, ops, agoraEpoch, resumo, camposPorNome, tela: { sessao: null, aberta: false } };
  let vistos = 0;

  for (const p of porPaciente.values()) {
    if (vistos++ >= MAX_PACIENTES_POR_VARREDURA) break;
    try {
      const idsSchedule = p.consultas.map((c) => c.idSchedule).filter((x): x is number => typeof x === 'number');
      const leadId = await resolverLead(unit, kommo, p.nome, p.idClient, idsSchedule);
      if (!leadId) {
        resumo.semLead++;
        if (resumo.exemplosSemLead.length < 8) resumo.exemplosSemLead.push(p.nome);
        continue;
      }
      resumo.comLead++;
      const lead = await kommo.getLead(leadId);
      await processarCartao(ctx, leadId, lead, p);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, paciente: p.nome }, 'franquia-sync: falha no paciente');
    }
  }

  if (funis) {
    try {
      await revisarPeloHistorico(ctx);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug }, 'franquia-move: falha na revisão pelo histórico');
    }
    try {
      await passarNegociacao(unit, kommo, funis, mapa, resumo);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug }, 'franquia-move: falha na passagem das 48 h');
    }
  }
  return resumo;
}

/** As unidades que o sincronizador atende agora — ligadas na tela e com credencial dos dois lados. */
async function unidadesDoSync(): Promise<Unit[]> {
  const units = await prisma.unit.findMany({
    where: { spineEnabled: true, spineToken: { not: null }, kommoAccessToken: { not: null } },
  });
  return units.filter((u) => automacaoLigada(u.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS));
}

/**
 * Teto de varreduras ao mesmo tempo. Não é a trava velha disfarçada: aquela era 1 e valia para o
 * processo inteiro; esta existe só para não bater na franquia com N requisições paralelas quando
 * alguém ligar o sincronizador em vinte unidades de uma vez. Com o padrão em 6 — o número de
 * unidades ligadas hoje — ninguém espera.
 */
const MAX_PARALELO = Number(process.env.FRANQUIA_SYNC_PARALELO) || 6;
let rodandoAgora = 0;
const esperandoVaga: Array<() => void> = [];

async function comVaga<T>(fn: () => Promise<T>): Promise<T> {
  if (rodandoAgora >= MAX_PARALELO) {
    // Quem esperava NÃO incrementa ao acordar: o slot foi entregue já contado, no `finally` abaixo.
    await new Promise<void>((libera) => esperandoVaga.push(libera));
  } else {
    rodandoAgora++;
  }
  try {
    return await fn();
  } finally {
    // O slot passa DIRETO para quem espera, em vez de ser devolvido e retomado. Decrementar e só
    // depois acordar deixaria a vaga livre por um microtask, e um chamador novo — síncrono — a
    // tomaria antes de quem estava na fila; aí os dois entrariam e o teto seria furado por um.
    const proximo = esperandoVaga.shift();
    if (proximo) proximo();
    else rodandoAgora--;
  }
}

/** Varre UMA unidade. É aqui que a trava por unidade e o relógio dela se encontram. */
async function varrerUnidade(unit: Unit, forcada = false): Promise<void> {
  const desde = emVoo.get(unit.slug);
  if (desde !== undefined) {
    // LOGAR A BATIDA DESCARTADA. Antes isto era um `return` mudo, e o atraso era invisível: o ciclo
    // estourava e ninguém ficava sabendo até alguém reparar num cartão velho.
    logger.warn(
      { unit: unit.slug, haMin: Math.round((Date.now() - desde) / 60_000), forcada },
      'franquia-sync: batida descartada — esta unidade já está sendo varrida',
    );
    return;
  }
  emVoo.set(unit.slug, Date.now());
  const t0 = Date.now();
  try {
    const r = await sincronizarUnidade(unit);
    ultimoResumo.set(unit.slug, r);
    anotarVarredura(unit, r, Date.now() - t0);
    logger.info({ ...r, ms: Date.now() - t0 }, 'franquia-sync: varredura concluída');
  } catch (err) {
    logger.error({ err, unit: unit.slug }, 'franquia-sync: varredura falhou');
  } finally {
    // No finally, as duas: unidade que estourou não pode ficar travada para sempre, nem voltar
    // pro topo da fila a cada 15 min porque nunca registrou sucesso.
    anotarTentativa(unit.slug);
    emVoo.delete(unit.slug);
  }
}

/**
 * Varredura avulsa — o "forçar agora" da tela, e o caminho que o worker NÃO usa mais para a rotina.
 * Sem `soSlug` varre todas, agora em paralelo (respeitando `MAX_PARALELO`) em vez de uma de cada vez.
 */
async function varrer(soSlug?: string): Promise<void> {
  const fila = (await unidadesDoSync())
    .filter((u) => !soSlug || u.slug === soSlug)
    .sort((a, b) => ultimaTentativa(a.slug) - ultimaTentativa(b.slug));
  await Promise.all(fila.map((u) => comVaga(() => varrerUnidade(u, true))));
}

/**
 * Varredura fora de hora (João, 23/09/2026: "pode rodar agora pra consertar esses cartões, depois segue
 * de 15 em 15"). Dispara em segundo plano e responde na hora. O relógio de 15 min continua o mesmo.
 *
 * Forçar UMA unidade agora funciona mesmo com outra em voo — antes não funcionava, porque a trava
 * era global e o filtro de unidade vinha depois dela.
 */
export function varrerAgora(soSlug?: string): { iniciado: boolean; motivo?: string } {
  if (soSlug && emVoo.has(soSlug)) {
    const haMin = Math.round((Date.now() - (emVoo.get(soSlug) ?? Date.now())) / 60_000);
    return { iniciado: false, motivo: `${soSlug} já está sendo varrida há ${haMin} min` };
  }
  void varrer(soSlug).catch((err) => logger.error({ err, soSlug }, 'franquia-sync: varredura manual falhou'));
  return { iniciado: true };
}

/**
 * CADA UNIDADE COM SEU PRÓPRIO RELÓGIO (João, 29/09/2026: "vamos isolar para cada uma, não precisar
 * desse atraso global").
 *
 * Antes havia UM `setInterval` que, a cada 15 min, percorria todas as unidades com `await` — uma de
 * cada vez. Tirar a trava global (feito mais cedo hoje) consertou o "forçar agora", mas não isto:
 * com ~15 min por unidade e 6 unidades, a rotina continuava levando ~1h30 para dar a volta, e a
 * unidade no fim da fila via seus cartões 1h30 atrasados.
 *
 * Agora cada unidade tem um `setTimeout` próprio, que se reagenda 15 min DEPOIS de a varredura dela
 * terminar. O intervalo de uma não depende do tempo das outras, e unidade lenta atrasa só a si
 * mesma. Reagendar no fim — e não a cada 15 min fixos — é de propósito: se a varredura demorar 20
 * min, a próxima sai 15 min depois do fim, em vez de nascer já atrasada e empilhar.
 *
 * `MAX_PARALELO` é o único limite que sobrou, e existe para não bater na franquia com vinte
 * requisições ao mesmo tempo — não para serializar.
 */
const agendadas = new Map<string, NodeJS.Timeout | null>();
/** Quando o relógio de cada unidade dispara (epoch ms) — é o que a tela mostra como "próxima". */
const proximaEm = new Map<string, number>();
/** Espaçamento entre os primeiros disparos: vinte unidades não devem acordar no mesmo segundo. */
const ESCALONAR_MS = 20_000;
/** De quanto em quanto tempo o supervisor procura unidade nova (ou unidade que saiu). */
const RECONCILIAR_MS = 60_000;

function agendarUnidade(unit: Unit, emMs: number): void {
  proximaEm.set(unit.slug, Date.now() + emMs);
  agendadas.set(
    unit.slug,
    setTimeout(() => {
      agendadas.set(unit.slug, null); // gerenciada, mas sem timer: está rodando agora
      proximaEm.delete(unit.slug);
      void comVaga(() => varrerUnidade(unit)).finally(() => {
        // Só reagenda se ainda for gerenciada — `stop` e o supervisor apagam a entrada de quem saiu.
        if (agendadas.has(unit.slug)) agendarUnidade(unit, SWEEP_MS);
      });
    }, emMs),
  );
}

/** Liga o relógio de quem entrou e desliga o de quem saiu — é o que faz unidade nova começar sozinha. */
async function reconciliar(): Promise<void> {
  let units: Unit[];
  try {
    units = await unidadesDoSync();
  } catch (err) {
    logger.warn({ err: String(err) }, 'franquia-sync: não consegui reler as unidades — mantendo os relógios atuais');
    return;
  }
  const vivas = new Set(units.map((u) => u.slug));
  for (const [slug, t] of agendadas) {
    if (vivas.has(slug)) continue;
    if (t) clearTimeout(t);
    agendadas.delete(slug);
    proximaEm.delete(slug);
    logger.info({ unit: slug }, 'franquia-sync: unidade saiu do sincronizador — relógio desligado');
  }
  let novas = 0;
  for (const u of units) {
    if (agendadas.has(u.slug)) continue;
    agendarUnidade(u, PRIMEIRA_MS + novas * ESCALONAR_MS);
    novas++;
  }
  if (novas) logger.info({ novas, total: agendadas.size }, 'franquia-sync: relógios ligados');
}

export function startFranquiaSyncWorker(): void {
  if (timer) return;
  void reconciliar();
  timer = setInterval(() => void reconciliar(), RECONCILIAR_MS);
  logger.info(
    {
      slugs: process.env.FRANQUIA_SYNC_SLUGS ?? '(vazio = desligado)',
      intervaloMin: SWEEP_MS / 60_000,
      maxParalelo: MAX_PARALELO,
    },
    'franquia-sync: worker iniciado — um relógio por unidade',
  );
}

export function stopFranquiaSyncWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
  // Os relógios por unidade também: sem isto, parar o worker deixaria N timeouts vivos segurando o
  // processo no deploy, e o `finally` de cada um reagendaria o próximo.
  for (const t of agendadas.values()) if (t) clearTimeout(t);
  agendadas.clear();
  proximaEm.clear();
}

export const _interno = { mapearCampos, valoresDoLead, procurarPaciente };
