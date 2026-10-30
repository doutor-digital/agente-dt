/**
 * Agenda da franquia no Calendário do Kommo — o worker. A decisão (o que criar/atualizar/fechar) é de
 * `franquia-calendario.ts` (puro); aqui se busca, casa paciente → cartão e aplica.
 *
 * Liga por unidade em `FRANQUIA_CALENDARIO_SLUGS` (csv; `*` = todas; vazio = desligado), INDEPENDENTE de a
 * unidade estar em `FRANQUIA_SYNC_SLUGS`: este passo só cria/atualiza/conclui TAREFAS e nunca grava campo do
 * cartão. Sem `FRANQUIA_CALENDARIO_APLICAR` (csv, mesma forma) a unidade fica em modo seco: lê e registra no
 * log o que faria. Outras variáveis (`slug:valor`, csv): `FRANQUIA_CALENDARIO_RESPONSAVEL` (userId do Kommo),
 * `FRANQUIA_CALENDARIO_TIPO` (id do tipo de tarefa; sem ele procura o tipo "Consulta" da conta, e sem esse usa 1).
 * `FRANQUIA_CALENDARIO_DURACAO_MIN` (padrão 60; 0 = não manda duração) e `FRANQUIA_CALENDARIO_REMARCADO`
 * (`manter` — padrão — ou `fechar`; ver o porquê em `franquia-calendario.ts`).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoTarefa } from '../services/kommo.service.js';
import { SpineService, somarDias, localParaUtcIso, type SpineSchedule } from '../services/spine.service.js';
import { contaDoKommo, grupoDaUnidade } from './crm-compartilhado.js';
import { normalizar } from './franquia-sync.js';
import { ondeTemSync, resolverPaciente, telefoneDoPaciente } from './franquia-sync-worker.js';
import {
  DURACAO_PADRAO_SEG, TIPO_PADRAO, epochDaConsulta, janelaDoCalendario, mapaPorSlug, modoDoCalendario, planejarCalendario, slugNaLista,
  sufixoDeTarefaSolta, textoDaTarefa, tipoPeloNome, type Acao, type ModoDoCalendario, type TarefaAberta,
} from './franquia-calendario.js';

const SWEEP_MS = 15 * 60_000;
const PRIMEIRA_MS = 120_000;
const PAUSA_ENTRE_ESCRITAS_MS = 200;
/** Tarefas NOVAS por varredura: a primeira de uma unidade grande se espalha por várias, em vez de bater no Kommo de uma vez. */
const MAX_CRIAR_POR_VARREDURA = Number(process.env.FRANQUIA_CALENDARIO_MAX_CRIAR) || 80;
const MAX_LINHAS_DE_LOG_SECO = 200;
/** Tarefa criada há pouco não se cria de novo mesmo que a lista do Kommo ainda não a mostre. */
const CRIADA_RECENTE_MS = 10 * 60_000;
const TIPO_CACHE_MS = 6 * 60 * 60_000;

export interface ResumoCalendario {
  unit: string;
  em: string;
  modo: ModoDoCalendario;
  agendamentos: number;
  tarefasAbertas: number;
  /** em modo seco, o que FARIA */
  criadas: number;
  atualizadas: number;
  fechadas: number;
  /** tarefas criadas soltas por falta de cartão (ou cartão incerto): nome e telefone vão no texto */
  semCartao: number;
  /** das `semCartao`, quantas porque o telefone casou com vários cartões e nenhum se provou */
  cartaoIncerto: number;
  /** tarefas abertas cujo agendamento não veio na busca — só logado */
  sumiram: number;
  /** passou do teto de criações da varredura; entram na próxima */
  adiadas: number;
  passados: number;
  /** consultas ativas cuja tarefa já foi concluída por alguém: respeitado */
  jaConcluidas: number;
  ignorados: number;
  erros: number;
}

export interface DepsDoCalendario {
  kommo?: KommoClient;
  agora?: Date;
  buscarAgenda?: (de: string, ate: string) => Promise<{ ok: boolean; erro?: string; agendamentos: SpineSchedule[]; truncada?: boolean }>;
  resolver?: (nome: string, idsSchedule: number[]) => Promise<{ leadId: number | null; confirmado: boolean }>;
  telefone?: (nome: string) => Promise<string | null>;
  modo?: ModoDoCalendario;
  pausaMs?: number;
}

const tipoPorConta = new Map<string, { id: number; ate: number }>();
const criadasRecentes = new Map<string, number>();
/** Última atualização aplicada por agendamento: se o Kommo não "guardou" o que mandamos, não regravamos para sempre. */
const ultimaAtualizacao = new Map<string, string>();

export function _limparMemoriaDoCalendario(): void {
  tipoPorConta.clear();
  criadasRecentes.clear();
  ultimaAtualizacao.clear();
}

/**
 * O tipo das tarefas da unidade, ou `null` se não deu para saber. `null` ABORTA a varredura: a lista de tarefas abertas é
 * filtrada por tipo, e errar o tipo (cair no 1 por um 429 passageiro) esconderia as tarefas já criadas e duplicaria todas.
 */
async function tipoDeTarefa(unit: Pick<Unit, 'slug'>, kommo: KommoClient, conta: string): Promise<number | null> {
  const configurado = mapaPorSlug(process.env.FRANQUIA_CALENDARIO_TIPO).get(unit.slug);
  if (configurado) return configurado;
  const hit = tipoPorConta.get(conta);
  if (hit && hit.ate > Date.now()) return hit.id;
  let id: number;
  try {
    id = tipoPeloNome(await kommo.listarTiposDeTarefa()) ?? TIPO_PADRAO;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: sem a lista de tipos de tarefa — nada feito nesta varredura');
    return null;
  }
  if (id === TIPO_PADRAO) logger.warn({ unit: unit.slug }, 'franquia-calendario: a conta não tem o tipo "Consulta" — uso o tipo 1 (Follow-up), que os robôs também usam; crie o tipo ou configure FRANQUIA_CALENDARIO_TIPO');
  tipoPorConta.set(conta, { id, ate: Date.now() + TIPO_CACHE_MS });
  return id;
}

function paraTarefa(t: KommoTarefa): TarefaAberta {
  return { id: t.id, text: t.text ?? '', completeTill: typeof t.complete_till === 'number' ? t.complete_till : null, entityId: t.entity_id ?? null };
}

/** As memórias só valem por minutos (criadas) ou até o próximo deploy (atualizações); sem poda, crescem para sempre. */
function podarMemoria(): void {
  const agora = Date.now();
  for (const [k, em] of criadasRecentes) if (agora - em > CRIADA_RECENTE_MS) criadasRecentes.delete(k);
  if (ultimaAtualizacao.size > 5000) ultimaAtualizacao.clear();
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function varrerCalendario(unit: Unit, deps: DepsDoCalendario = {}): Promise<ResumoCalendario> {
  const modo = deps.modo ?? modoDoCalendario(unit.slug);
  const agora = deps.agora ?? new Date();
  const resumo: ResumoCalendario = {
    unit: unit.slug, em: agora.toISOString(), modo, agendamentos: 0, tarefasAbertas: 0, criadas: 0, atualizadas: 0, fechadas: 0,
    semCartao: 0, cartaoIncerto: 0, sumiram: 0, adiadas: 0, passados: 0, jaConcluidas: 0, ignorados: 0, erros: 0,
  };
  if (modo === 'desligado') return resumo;
  const aplicar = modo === 'aplicar';
  podarMemoria();
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const kommo = deps.kommo ?? createKommoClient(await contaDoKommo(unit));
  const pausa = deps.pausaMs ?? PAUSA_ENTRE_ESCRITAS_MS;

  // 1. a agenda da franquia. Sem ela não se decide nada (nem fechar: agenda vazia por pane não é agenda vazia).
  const { de, ate } = janelaDoCalendario(tz, agora);
  const ag = deps.buscarAgenda
    ? await deps.buscarAgenda(de, ate)
    : await SpineService.searchSchedules(unit, { initialDate: de, endDate: ate, rowsPerPage: 100 }).then((r) => ({
        ok: r.ok, erro: r.error, agendamentos: r.data?.schedules ?? [], truncada: r.data?.truncada,
      }));
  if (!ag.ok) {
    logger.warn({ unit: unit.slug, erro: ag.erro }, 'franquia-calendario: agenda indisponível — nada feito');
    resumo.erros++;
    return resumo;
  }
  resumo.agendamentos = ag.agendamentos.length;
  if (ag.truncada) logger.warn({ unit: unit.slug }, 'franquia-calendario: a franquia tinha mais páginas que o teto — lista incompleta, não dou tarefa por sumida');

  // 2. as tarefas abertas do Kommo (a fonte da verdade da idempotência)
  const conta = kommo.subdomain;
  const taskTypeId = await tipoDeTarefa(unit, kommo, conta);
  if (taskTypeId === null) {
    resumo.erros++;
    return resumo;
  }
  // a janela em epoch, pelo relógio da clínica: de 00:00 de ontem até 00:00 do dia seguinte ao último
  const deEpoch = epochDaConsulta(localParaUtcIso(`${de}T00:00:00`, tz)) ?? 0;
  const ateEpoch = epochDaConsulta(localParaUtcIso(`${somarDias(ate, 1)}T00:00:00`, tz)) ?? 0;
  let abertas: KommoTarefa[] = [];
  let completa = true;
  try {
    ({ tarefas: abertas, completa } = await kommo.listarTarefas({ taskTypeId }));
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: não consegui ler as tarefas abertas — nada feito (criaria duplicada)');
    resumo.erros++;
    return resumo;
  }
  resumo.tarefasAbertas = abertas.length;
  if (!completa) logger.warn({ unit: unit.slug, lidas: abertas.length }, 'franquia-calendario: lista de tarefas cortada no teto — não crio tarefa nova nesta varredura');
  // As CONCLUÍDAS da janela: tarefa que a recepção deu por feita (ou que nós fechamos) não se recria. Sem esta leitura, concluir
  // uma consulta ainda AGENDADA faria o worker criar outra a cada 10 min. Falhou = não crio nada novo (pode ser duplicada).
  let concluidas: KommoTarefa[] = [];
  try {
    const r = await kommo.listarTarefas({ taskTypeId, concluidas: true, completeTillDe: deEpoch, completeTillAte: ateEpoch });
    concluidas = r.tarefas;
    if (!r.completa) completa = false;
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, 'franquia-calendario: não consegui ler as tarefas concluídas — não crio tarefa nova nesta varredura');
    resumo.erros++;
    completa = false;
  }

  // 3. decide
  const plano = planejarCalendario({
    agendamentos: ag.agendamentos,
    tarefas: abertas.map(paraTarefa),
    concluidas: concluidas.map(paraTarefa),
    agoraEpoch: Math.floor(agora.getTime() / 1000),
    tz,
    janela: { deEpoch, ateEpoch },
    remarcado: process.env.FRANQUIA_CALENDARIO_REMARCADO === 'fechar' ? 'fechar' : 'manter',
  });
  resumo.passados = plano.passados;
  resumo.jaConcluidas = plano.jaConcluidas;
  resumo.ignorados = plano.ignorados;

  const responsavel = mapaPorSlug(process.env.FRANQUIA_CALENDARIO_RESPONSAVEL).get(unit.slug);
  if (!responsavel) logger.warn({ unit: unit.slug }, 'franquia-calendario: FRANQUIA_CALENDARIO_RESPONSAVEL sem esta unidade — a tarefa nasce com o dono do token');
  const minutos = process.env.FRANQUIA_CALENDARIO_DURACAO_MIN;
  const durationSec = minutos !== undefined && minutos !== '' ? Math.max(0, Number(minutos) || 0) * 60 : DURACAO_PADRAO_SEG;

  const idsPorPaciente = new Map<string, number[]>();
  for (const s of ag.agendamentos) {
    if (!s.clientName || typeof s.idSchedule !== 'number') continue;
    const k = normalizar(s.clientName);
    idsPorPaciente.set(k, [...(idsPorPaciente.get(k) ?? []), s.idSchedule]);
  }

  // 4. aplica (ou, em seco, só conta e loga)
  let linhasSeco = 0;
  const dizer = (o: Record<string, unknown>, msg: string) => {
    if (aplicar || linhasSeco++ >= MAX_LINHAS_DE_LOG_SECO) return;
    logger.info({ unit: unit.slug, ...o }, `franquia-calendario: [seco] ${msg}`);
  };
  let criadasAgora = 0;
  const aplicarAcao = async (a: Acao): Promise<void> => {
    if (a.tipo === 'sumiu') {
      if (ag.truncada) return; // busca incompleta: não dá para dizer que sumiu
      resumo.sumiram++;
      logger.info({ unit: unit.slug, idSchedule: a.idSchedule, taskId: a.taskId }, 'franquia-calendario: tarefa aberta sem agendamento na busca — deixei como está');
      return;
    }
    if (a.tipo === 'fechar') {
      dizer({ idSchedule: a.idSchedule, taskId: a.taskId, resultado: a.resultado }, 'fecharia');
      if (aplicar) {
        await kommo.fecharTarefa(a.taskId, a.resultado);
        await dormir(pausa);
      }
      resumo.fechadas++;
      return;
    }
    if (a.tipo === 'atualizar') {
      const assinatura = `${a.texto ?? ''}|${a.completeTill ?? ''}`;
      const chave = `${unit.id}:${a.idSchedule}`;
      if (aplicar && ultimaAtualizacao.get(chave) === assinatura) {
        // já mandei exatamente isto e o Kommo continua diferente: não regravo a cada varredura (dois escritores = regravação eterna)
        logger.warn({ unit: unit.slug, idSchedule: a.idSchedule, taskId: a.taskId }, 'franquia-calendario: o Kommo não guardou a atualização anterior — não regravo');
        return;
      }
      dizer({ idSchedule: a.idSchedule, taskId: a.taskId, texto: a.texto, completeTill: a.completeTill }, 'atualizaria');
      if (aplicar) {
        await kommo.atualizarTarefa(a.taskId, {
          ...(a.texto !== null ? { text: a.texto } : {}),
          ...(a.completeTill !== null ? { completeAt: a.completeTill, durationSec: durationSec || undefined } : {}),
        });
        ultimaAtualizacao.set(chave, assinatura); // só depois de gravar: PATCH que falhou tenta de novo na próxima
        await dormir(pausa);
      }
      resumo.atualizadas++;
      return;
    }
    // criar
    if (!completa) return;
    const recente = criadasRecentes.get(`${unit.id}:${a.idSchedule}`);
    if (recente && Date.now() - recente < CRIADA_RECENTE_MS) return;
    if (criadasAgora >= MAX_CRIAR_POR_VARREDURA) {
      resumo.adiadas++;
      return;
    }
    criadasAgora++;
    const nome = a.item.clientName ?? '';
    const r = deps.resolver
      ? await deps.resolver(nome, idsPorPaciente.get(normalizar(nome)) ?? [a.idSchedule])
      : await resolverPaciente(unit, kommo, nome, null, idsPorPaciente.get(normalizar(nome)) ?? [a.idSchedule]).then((x) => ({ leadId: x.leadId, confirmado: x.leadConfirmado }));
    // Só cartão PROVADO recebe a tarefa: telefone que casa com vários cartões (mãe e filha dividem o WhatsApp) é palpite.
    const leadId = r.leadId !== null && r.confirmado ? r.leadId : null;
    let texto = a.texto;
    if (leadId === null) {
      const fone = deps.telefone ? await deps.telefone(nome) : await telefoneDoPaciente(unit, nome, null).then((x) => x?.fone ?? null).catch(() => null);
      texto = textoDaTarefa(a.item, tz, sufixoDeTarefaSolta(nome, fone));
    }
    dizer({ idSchedule: a.idSchedule, leadId, solta: leadId === null, texto, completeTill: a.completeTill }, 'criaria');
    if (aplicar) {
      // marcada ANTES do POST: num timeout o Kommo pode ter gravado a tarefa, e a lista da próxima varredura pode ainda não mostrá-la
      criadasRecentes.set(`${unit.id}:${a.idSchedule}`, Date.now());
      const feita = await kommo.createTask({
        leadId, text: texto, completeAt: a.completeTill, responsibleUserId: responsavel, taskTypeId, manterResponsavel: true,
        durationSec: durationSec || undefined,
      });
      if (!feita) {
        resumo.erros++;
        logger.warn({ unit: unit.slug, idSchedule: a.idSchedule, solta: leadId === null }, 'franquia-calendario: o Kommo não devolveu o id da tarefa criada');
        return;
      }
      await dormir(pausa);
    }
    resumo.criadas++;
    if (leadId === null) {
      resumo.semCartao++;
      if (r.leadId !== null) resumo.cartaoIncerto++;
    }
  };
  for (const a of plano.acoes) {
    try {
      await aplicarAcao(a);
    } catch (err) {
      resumo.erros++;
      logger.warn({ err: String(err), unit: unit.slug, idSchedule: a.idSchedule, tipo: a.tipo }, 'franquia-calendario: falha na tarefa');
    }
  }
  return resumo;
}

// ── relógio ──────────────────────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

async function unidadesDoCalendario(): Promise<Unit[]> {
  const raw = process.env.FRANQUIA_CALENDARIO_SLUGS;
  if (!raw || !raw.replace(/['"\s]/g, '')) return [];
  const units = await prisma.unit.findMany({ where: await ondeTemSync() });
  const doCalendario = units.filter((u) => slugNaLista(u.slug, raw));
  // slug escrito errado, ou unidade sem token da franquia/Kommo: sem este aviso o passo "liga" e não faz nada, em silêncio
  const achados = new Set(doCalendario.map((u) => u.slug));
  const faltam = raw.replace(/['"]/g, '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*' && !achados.has(s));
  if (faltam.length) logger.warn({ faltam }, 'franquia-calendario: slug da lista sem unidade com franquia e Kommo configurados');
  return doCalendario;
}

async function varrerTodas(): Promise<void> {
  if (rodando) {
    logger.warn('franquia-calendario: batida descartada — a varredura anterior ainda não terminou');
    return;
  }
  rodando = true;
  try {
    for (const unit of await unidadesDoCalendario()) {
      const t0 = Date.now();
      try {
        // Kommo dividido entre unidades (Petrópolis + Caxias): o marcador [ag:N] é por unidade e as duas dividem a lista
        // de tarefas — ids iguais se confundiriam. Fora desta versão: recusa em vez de arriscar.
        if (await grupoDaUnidade(unit.id)) {
          logger.warn({ unit: unit.slug }, 'franquia-calendario: unidade em conta do Kommo dividida — não suportada, pulei');
          continue;
        }
        const r = await varrerCalendario(unit);
        logger.info({ ...r, ms: Date.now() - t0 }, 'franquia-calendario: varredura concluída');
      } catch (err) {
        logger.error({ err, unit: unit.slug }, 'franquia-calendario: varredura falhou');
      }
    }
  } finally {
    rodando = false;
  }
}

export function startFranquiaCalendarioWorker(): void {
  if (timer || primeira) return;
  const slugs = process.env.FRANQUIA_CALENDARIO_SLUGS;
  logger.info({ slugs: slugs || '(vazio = desligado)', aplicar: process.env.FRANQUIA_CALENDARIO_APLICAR || '(vazio = seco)' }, 'franquia-calendario: worker iniciado');
  primeira = setTimeout(() => void varrerTodas(), PRIMEIRA_MS);
  timer = setInterval(() => void varrerTodas(), SWEEP_MS);
}

export function stopFranquiaCalendarioWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
