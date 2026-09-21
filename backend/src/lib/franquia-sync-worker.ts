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
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead, type KommoLeadCustomField } from '../services/kommo.service.js';
import { SPINE_STATUS, SpineService, instanteNoFuso, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { CAMPOS_SYNC, chaveTelefone, ehConsulta, escolherConsulta, normalizar, planejarEscritas, type CampoSync } from './franquia-sync.js';
import { ETAPA, horasAteNegociacao, moveLiberado, planejarMovimento, tratamentoAberto, type EtapaAtual, type Funil, type Movimento, type TratamentoParaEtapa } from './franquia-move.js';
import { normalizarNome } from './kommo-schema.js';

const SWEEP_MS = 15 * 60_000;
const PRIMEIRA_MS = 90_000;
const DIAS_ATRAS = 3;
const DIAS_FRENTE = 45;
const MAX_PACIENTES_POR_VARREDURA = 400;
const PAUSA_ENTRE_ESCRITAS_MS = 150;
const CACHE_LEAD_MS = 6 * 60 * 60_000;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

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
}
const ultimoResumo = new Map<string, ResumoSync>();
export function resumoDoSync(): ResumoSync[] {
  return [...ultimoResumo.values()];
}

/** paciente (nome normalizado) → lead do Kommo, por unidade; evita repetir a busca por telefone a cada 15 min */
const cacheLead = new Map<string, { leadId: number | null; expiraEm: number }>();

export function slugsLiberados(raw: string | undefined): (slug: string) => boolean {
  const lista = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (lista.length === 0) return () => false;
  if (lista.includes('*')) return () => true;
  const set = new Set(lista);
  return (slug) => set.has(slug);
}

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

async function resolverLead(unit: Unit, kommo: KommoClient, nome: string, idClient: number | null, idsSchedule: number[]): Promise<number | null> {
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

async function aplicarMovimento(unit: Unit, kommo: KommoClient, funis: Funis, leadId: number, mov: Movimento, resumo: ResumoSync): Promise<void> {
  const alvo = funis.idDe(mov.funil, mov.para);
  if (!alvo) {
    logger.warn({ unit: unit.slug, leadId, para: mov.para, funil: mov.funil }, 'franquia-move: etapa não existe nesta conta — não movi');
    return;
  }
  try {
    await kommo.moveStage({ leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
    resumo.movimentos++;
    logger.info({ unit: unit.slug, leadId, para: mov.para, funil: mov.funil, motivo: mov.motivo }, 'franquia-move: cartão movido');
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
/** idClient do paciente na franquia: pelo vínculo que a Sofia gravou, senão pelo nome (só se for único). */
export async function idClientDoLead(unit: Unit, leadId: number, nome: string | null): Promise<number | null> {
  const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
  if (link?.spineIdClient) return link.spineIdClient;
  if (!nome) return null;
  const r = await SpineService.searchClients(unit, nome);
  if (!r.ok || !r.data) return null;
  const alvo = normalizar(nome);
  const exatos = r.data.clients.filter((c) => normalizar(c.name) === alvo && c.idClient);
  return exatos.length === 1 ? exatos[0].idClient : null;
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
      await aplicarMovimento(unit, kommo, funis, lead.id, { funil: 'COMERCIAL', para: ETAPA.NEGOCIACAO, motivo: `atendido há ${Math.floor((agora - dataConsulta) / 3600)} h sem tratamento (pelo cartão)` }, resumo);
    }
    if (leads.length < 250) break;
  }
}

async function sincronizarUnidade(unit: Unit): Promise<ResumoSync> {
  const resumo: ResumoSync = { unit: unit.slug, em: new Date().toISOString(), agendamentos: 0, tratamentos: 0, pacientes: 0, comLead: 0, semLead: 0, escritas: 0, erros: 0, exemplosSemLead: [], movimentos: 0 };
  const kommo = createKommoClient(unit);
  const bruto = (await kommo.listLeadCustomFields()) as { _embedded?: { custom_fields?: CampoBruto[] } } | undefined;
  const mapa = mapearCampos(bruto?._embedded?.custom_fields ?? []);
  if (!mapa.DATA_CONSULTA || !mapa.SITUACAO) {
    logger.warn({ unit: unit.slug }, 'franquia-sync: conta sem os campos de consulta — pulando');
    return resumo;
  }
  const mover = moveLiberado(unit.slug);
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
    p.tratamento = p.tratamento ?? t;
    p.idClient = p.idClient ?? t.idClient;
    porPaciente.set(k, p);
  }
  resumo.pacientes = porPaciente.size;
  const ops = opcoes(mapa);
  const agoraEpoch = Math.floor(Date.now() / 1000);
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
      const consulta = escolherConsulta(p.consultas);
      const consultaEpoch = consulta?.dateAttendanceUtc ? Math.floor(Date.parse(consulta.dateAttendanceUtc) / 1000) : null;
      const feitoPelaIa = consulta?.idSchedule
        ? !!(await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdSchedule: consulta.idSchedule } }))
        : false;
      const escritas = planejarEscritas({ valores: valoresDoLead(lead, mapa), consulta, consultaEpoch: Number.isFinite(consultaEpoch as number) ? consultaEpoch : null, tratamento: p.tratamento, feitoPelaIa, agoraEpoch, opcoes: ops });
      for (const w of escritas) {
        const info = mapa[w.campo];
        if (!info) continue;
        try {
          await kommo.setLeadCustomFieldValue(leadId, info.id, info.type, w.valor, info.enums);
          resumo.escritas++;
          logger.info({ unit: unit.slug, leadId, campo: w.nome, valor: w.valor, motivo: w.motivo }, 'franquia-sync: campo gravado');
        } catch (err) {
          resumo.erros++;
          logger.warn({ err, unit: unit.slug, leadId, campo: w.nome }, 'franquia-sync: falha ao gravar campo');
        }
        await new Promise((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));
      }

      // fase 2: a franquia move o cartão
      if (funis) {
        const atual = funis.nomeDe(lead.pipeline_id, lead.status_id);
        if (atual) {
          let agendamentos: SpineSchedule[] = p.consultas;
          // o /treatments/search não traz idStatus; o nome do status basta ("EM ANDAMENTO", "FINALIZADO")
          let tratamentos: TratamentoParaEtapa[] = p.tratamento ? [{ idStatus: null, statusName: p.tratamento.statusName ?? null }] : [];
          // GANHO e EM TRATAMENTO dependem do histórico inteiro (sessão antiga, tratamento de outro mês)
          const precisaHistorico = normalizarNome(atual.status) === normalizarNome(ETAPA.GANHO) || atual.funil === 'TRATAMENTO';
          if (precisaHistorico) {
            // a agenda não traz idClient e o /treatments/search só lista tratamento em andamento:
            // quem finalizou some da lista — sem isto a ALTA nunca dispararia
            const idClient = p.idClient ?? (await idClientDoLead(unit, leadId, p.nome));
            const hist = await historicoDoPaciente(unit, idClient);
            if (hist) {
              const ids = new Set(agendamentos.map((s) => s.idSchedule));
              agendamentos = [...agendamentos, ...hist.schedules.filter((s) => !ids.has(s.idSchedule))];
              if (hist.treatments.length > 0) tratamentos = hist.treatments;
            }
          }
          const mov = planejarMovimento({ atual, agendamentos, tratamentos, agoraEpoch, horasAteNegociacao: horasAteNegociacao() });
          if (mov) await aplicarMovimento(unit, kommo, funis, leadId, mov, resumo);
        }
      }
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug, paciente: p.nome }, 'franquia-sync: falha no paciente');
    }
  }

  if (funis) {
    try {
      await passarNegociacao(unit, kommo, funis, mapa, resumo);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err, unit: unit.slug }, 'franquia-move: falha na passagem das 48 h');
    }
  }
  return resumo;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const liberado = slugsLiberados(process.env.FRANQUIA_SYNC_SLUGS);
    const units = await prisma.unit.findMany({
      where: { spineEnabled: true, spineToken: { not: null }, kommoAccessToken: { not: null } },
    });
    for (const unit of units) {
      if (!liberado(unit.slug)) continue;
      const t0 = Date.now();
      try {
        const r = await sincronizarUnidade(unit);
        ultimoResumo.set(unit.slug, r);
        logger.info({ ...r, ms: Date.now() - t0 }, 'franquia-sync: varredura concluída');
      } catch (err) {
        logger.error({ err, unit: unit.slug }, 'franquia-sync: varredura falhou');
      }
    }
  } finally {
    rodando = false;
  }
}

export function startFranquiaSyncWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info({ slugs: process.env.FRANQUIA_SYNC_SLUGS ?? '(vazio = desligado)' }, 'franquia-sync: worker iniciado');
}

export function stopFranquiaSyncWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}

export const _interno = { mapearCampos, valoresDoLead };
