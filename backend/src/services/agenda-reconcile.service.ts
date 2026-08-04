// ============================================================================
// agenda-reconcile.service.ts — o horário que vale é o da franquia, não o nosso.
//
// POR QUE ISTO EXISTE
// -------------------
// A gente cria o agendamento e guarda `agendadoPara` no banco. Depois disso,
// nunca mais olhava. Mas a recepção remarca — pelo sistema dela, sem passar
// por aqui. Medido: consulta criada pela IA em 03/08 para 17/08 às 08:00;
// no dia seguinte, às 10:57, a recepção puxou para 09:30. Nosso banco
// continuou dizendo 08:00, e é isso que a IA responderia se o paciente
// perguntasse — mandando ele pra clínica uma hora e meia antes da vaga.
//
// O erro é assimétrico e por isso o desenho é conservador: dizer a hora errada
// com confiança põe o paciente na porta no horário errado; dizer "confirmo em
// seguida" só custa uma mensagem. Quando não dá pra confirmar, a gente NÃO
// afirma.
//
// ONDE ISTO ENTRA
// ---------------
// Em dois lugares, de propósito:
//   1. nas tools (agendar/cancelar/remarcar), que decidem com o dado;
//   2. no system prompt, porque o paciente pode só PERGUNTAR ("que horas mesmo
//      é minha consulta?") — e aí não há tool nenhuma no caminho. A IA
//      responderia pelo histórico da conversa, que é justamente onde o horário
//      velho está escrito.
//
// CUSTO
// -----
// Só bate na API da franquia quando o lead TEM consulta marcada — o que é raro.
// Cache de 60s por lead cobre os vários passos do mesmo turno com uma chamada
// só. A varredura larga (quando mudaram o DIA, não só a hora) é o caminho caro
// e roda só quando o agendamento sumiu do dia esperado.
// ============================================================================

import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { SpineService } from './spine.service.js';

/**
 * - `confirmada`   — lida agora na franquia; `quando` é a verdade.
 * - `cancelada`    — a franquia desmarcou. O vínculo foi limpo.
 * - `nao_confirmada` — não deu pra ler (API fora, token ausente, sumiu da
 *   agenda). `quando` é o último valor conhecido e NÃO deve ser afirmado.
 */
export type EstadoConsulta = 'confirmada' | 'cancelada' | 'nao_confirmada';

export interface ConsultaReconciliada {
  idSchedule: number;
  /** "AAAA-MM-DDTHH:mm" no fuso da clínica. */
  quando: string | null;
  /** O que estava salvo antes da conferência — só pra log e diagnóstico. */
  salvo: string | null;
  estado: EstadoConsulta;
  /** A franquia mexeu desde a última vez que olhamos? */
  mudou: boolean;
  especialista: string | null;
}

/** Dias à frente varridos quando o agendamento saiu do dia esperado. */
const JANELA_DIAS = 90;

const TTL_MS = 60_000;
/**
 * Teto de entradas. O cache guarda uma linha por lead que conversou no último
 * minuto — inclusive os `null` (lead sem consulta), que são a maioria e são
 * justamente os que mais valem cachear: evitam uma ida ao banco por turno.
 * Sem teto, um processo de semanas acumula uma entrada por lead pra sempre.
 */
const MAX_ENTRADAS = 5_000;
const cache = new Map<string, { em: number; valor: ConsultaReconciliada | null }>();

function chave(unitId: string, kommoLeadId: number): string {
  return `${unitId}:${kommoLeadId}`;
}

/** Descarta o que venceu; se ainda estiver cheio, corta os mais antigos. */
function podar(): void {
  if (cache.size < MAX_ENTRADAS) return;
  const agora = Date.now();
  for (const [k, v] of cache) if (agora - v.em >= TTL_MS) cache.delete(k);
  // Map itera em ordem de inserção — os primeiros são os mais velhos.
  if (cache.size >= MAX_ENTRADAS) {
    const sobrando = cache.size - Math.floor(MAX_ENTRADAS / 2);
    let i = 0;
    for (const k of cache.keys()) {
      if (i++ >= sobrando) break;
      cache.delete(k);
    }
  }
}

/**
 * Invalida o cache de um lead. Chamado por quem ACABOU de escrever na agenda
 * (agendar/cancelar/remarcar) — sem isto o passo seguinte do mesmo turno leria
 * o estado anterior e contradiria o que a tool acabou de fazer.
 */
export function esqueceConsulta(unitId: string, kommoLeadId: number): void {
  cache.delete(chave(unitId, kommoLeadId));
}

function hojeNaClinica(unit: Unit): string {
  return SpineService.instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo').slice(0, 10);
}

function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

interface Achado {
  dia: string | null;
  hora: string | null;
  idStatus: number | null;
  especialista: string | null;
}

/**
 * Procura o agendamento na ficha do próprio paciente.
 *
 * `null` significa "não deu pra responder por aqui" — e NUNCA "foi apagado".
 * A lista embutida pode não trazer agendamentos excluídos, então concluir
 * exclusão a partir da ausência aqui seria inferir demais: quem decide isso é
 * a varredura por data, que é a fonte que a gente conhece.
 */
async function pelosAgendamentosDoPaciente(
  unit: Unit,
  idClient: number,
  idSchedule: number,
): Promise<Achado | null> {
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok || !r.data?.client) return null;
  const s = r.data.client.schedules.find((x) => x.idSchedule === idSchedule);
  if (!s) return null;
  return {
    dia: s.dayLocal,
    hora: s.timeLocal,
    idStatus: s.idStatus,
    especialista: s.physicalTherapist?.trim() || null,
  };
}

/** Procura UM idSchedule dentro de um intervalo. `null` = não estava lá. */
async function procurar(
  unit: Unit,
  idSchedule: number,
  de: string,
  ate: string,
): Promise<Achado | null> {
  const r = await SpineService.searchSchedules(unit, {
    initialDate: de,
    endDate: ate,
    rowsPerPage: 100,
  });
  if (!r.ok || !r.data) return null;
  const achado = r.data.schedules.find((s) => s.idSchedule === idSchedule);
  if (!achado) return null;
  return {
    dia: achado.dayLocal,
    hora: achado.timeLocal,
    idStatus: achado.idStatus,
    especialista: achado.physicalTherapist?.trim() || null,
  };
}

/**
 * A consulta atual do lead, conferida na franquia.
 *
 * `null` significa "este lead não tem consulta nossa" — diferente de
 * `nao_confirmada`, que é "tem, mas não consegui olhar agora".
 */
export async function consultaDoLead(
  unit: Unit,
  kommoLeadId: number | undefined,
): Promise<ConsultaReconciliada | null> {
  if (!kommoLeadId || !Number.isFinite(kommoLeadId)) return null;

  const k = chave(unit.id, kommoLeadId);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.em < TTL_MS) return hit.valor;

  const valor = await reconciliar(unit, kommoLeadId);
  podar();
  cache.set(k, { em: Date.now(), valor });
  return valor;
}

async function reconciliar(unit: Unit, kommoLeadId: number): Promise<ConsultaReconciliada | null> {
  const link = await prisma.spineLeadLink.findFirst({
    where: { unitId: unit.id, kommoLeadId },
  });
  if (!link?.spineIdSchedule) return null;

  const base: ConsultaReconciliada = {
    idSchedule: link.spineIdSchedule,
    quando: link.agendadoPara,
    salvo: link.agendadoPara,
    estado: 'nao_confirmada',
    mudou: false,
    especialista: null,
  };

  // Sem agenda conectada não há como conferir. Devolve o que temos, marcado
  // como não confirmado — quem lê decide não afirmar.
  if (!unit.spineEnabled || !unit.spineToken) return base;

  try {
    // A ORDEM AQUI É POR CUSTO MEDIDO, não por elegância. Contra a produção:
    //
    //   busca de 1 dia          mediana  155ms
    //   varredura de 90 dias    mediana  304ms
    //   GET /api/clients/{id}   mediana 1435ms   (812 … 1957)
    //
    // "Uma chamada só" parecia o caminho barato — a ficha do paciente já traz
    // os agendamentos dele. É o mais CARO dos três, quase 10x a busca por dia,
    // porque a rota carrega tratamentos e o resto do cadastro junto. Como isto
    // roda na montagem do prompt, cada milissegundo aqui é o paciente esperando.

    // 1) O dia que a gente acha que é. O caso comum, e o mais barato.
    const dia = link.agendadoPara?.slice(0, 10) ?? null;
    let achado = dia ? await procurar(unit, link.spineIdSchedule, dia, dia) : null;

    // 2) Sumiu do dia esperado: remarcaram para outra data. A varredura à
    //    frente cobre isso e ainda sai mais barata que perguntar pela ficha.
    if (!achado) {
      const hoje = hojeNaClinica(unit);
      achado = await procurar(unit, link.spineIdSchedule, hoje, somarDias(hoje, JANELA_DIAS));
    }

    // 3) ÚLTIMO RECURSO — a ficha do paciente. Cara, então só quando as duas
    //    buscas por data falharam: pega o que ficou fora da janela (remarcado
    //    para daqui a mais de 90 dias, ou para trás). Sem isto, esses casos
    //    virariam "não confirmada" e a I.A. calaria sobre o horário à toa.
    if (!achado && link.spineIdClient) {
      achado = await pelosAgendamentosDoPaciente(unit, link.spineIdClient, link.spineIdSchedule);
    }

    // 3) Não está em lugar nenhum. Pode ter sido excluído na franquia (o
    //    DELETE deles some com o registro) ou estar fora da janela. NÃO
    //    limpamos o vínculo: apagar por não ter achado é destrutivo demais
    //    pra uma inferência por ausência — que é exatamente o furo que a
    //    leitura da agenda já tem. Marca como não confirmada e segue.
    if (!achado) {
      logger.warn(
        { unit: unit.slug, kommoLeadId, idSchedule: link.spineIdSchedule, salvo: link.agendadoPara },
        'agenda: consulta não encontrada na franquia — horário não confirmado',
      );
      return base;
    }

    // 4) Desmarcada lá. O vínculo tem que sumir daqui, senão agendar_consulta
    //    continua recusando "já tem consulta" para quem não tem mais.
    if (achado.idStatus === SpineService.SPINE_STATUS.DESMARCADO) {
      await prisma.spineLeadLink
        .update({ where: { id: link.id }, data: { spineIdSchedule: null, agendadoPara: null } })
        .catch(() => undefined);
      logger.warn(
        { unit: unit.slug, kommoLeadId, idSchedule: link.spineIdSchedule, salvo: link.agendadoPara },
        'agenda: consulta desmarcada na franquia — vínculo limpo',
      );
      return { ...base, estado: 'cancelada', quando: null, mudou: true, especialista: achado.especialista };
    }

    if (!achado.dia || !achado.hora) return base;

    const agora = `${achado.dia}T${achado.hora}`;
    const mudou = agora !== link.agendadoPara;

    if (mudou) {
      await prisma.spineLeadLink
        .update({ where: { id: link.id }, data: { agendadoPara: agora } })
        .catch(() => undefined);
      logger.warn(
        { unit: unit.slug, kommoLeadId, idSchedule: link.spineIdSchedule, de: link.agendadoPara, para: agora },
        'agenda: a franquia remarcou — horário local atualizado',
      );
    }

    return {
      ...base,
      quando: agora,
      estado: 'confirmada',
      mudou,
      especialista: achado.especialista,
    };
  } catch (err) {
    logger.warn(
      { err: String(err), unit: unit.slug, kommoLeadId },
      'agenda: falha ao conferir consulta na franquia',
    );
    return base;
  }
}

/** "2026-08-17T09:30" → "17/08/2026 às 09:30". */
export function porExtenso(quando: string | null | undefined): string {
  if (!quando) return 'a consulta marcada';
  const [dia, hora] = quando.split('T');
  const [a, m, d] = dia.split('-');
  if (!a || !m || !d) return quando;
  return `${d}/${m}/${a}${hora ? ` às ${hora}` : ''}`;
}

export const AgendaReconcileService = {
  consultaDoLead,
  esqueceConsulta,
  porExtenso,
};
