/**
 * O que a FRANQUIA sabe de um paciente que a Sofia não marcou.
 *
 * O bloco `<consulta_do_paciente>` só enxergava consulta com vínculo (`spine_lead_links`), isto é,
 * consulta que a própria Sofia marcou. Consulta marcada pela recepção ficava invisível — furo aceito
 * em ago/2026. Em 06/10/2026 ele custou caro em Taubaté (lead 4851114): a recepção marcou o Paulo em
 * 05/10 às 19:30, ele compareceu e fechou tratamento, e no dia seguinte a Sofia pediu que ele
 * confirmasse "amanhã, terça, 06/10, às 7h" — um horário que nunca existiu.
 *
 * Só roda quando o cartão já diz que a pessoa agendou ou é paciente (`jaAgendadoOuPaciente`): é
 * exatamente quem a recepção marcou por fora, e o filtro segura o consumo da API da franquia.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import { ehConsulta } from '../lib/franquia-sync.js';
import { tratamentoAberto, type TratamentoParaEtapa } from '../lib/franquia-move.js';
import { idClientDoLead } from '../lib/franquia-sync-worker.js';
import { comQuemVaiSerAtendido } from '../lib/nome-do-profissional.js';
import { SPINE_STATUS, SpineService, instanteNoFuso, type SpineSchedule } from './spine.service.js';

export interface AgendamentoNaFranquia {
  /** "2026-10-05T19:30", hora local da unidade */
  quando: string;
  categoria: string | null;
  /** avaliação ou retorno (não sessão de tratamento) */
  consulta: boolean;
  especialista: string | null;
}

export interface PacienteNaFranquia {
  idClient: number;
  emTratamento: boolean;
  /** o próximo agendamento ainda de pé (agendado ou confirmado), de qualquer categoria */
  proximo: AgendamentoNaFranquia | null;
  /** a consulta (avaliação/retorno) mais recente que a franquia marcou como atendida */
  ultimaConsultaAtendida: AgendamentoNaFranquia | null;
}

function paraAgendamento(s: SpineSchedule): AgendamentoNaFranquia | null {
  if (!s.dayLocal || !s.timeLocal) return null;
  return {
    quando: `${s.dayLocal}T${s.timeLocal}`,
    categoria: s.categoryName,
    consulta: ehConsulta(s),
    especialista: comQuemVaiSerAtendido(s.physicalTherapist),
  };
}

/** PURA: dado o histórico da franquia e a hora local da unidade ("YYYY-MM-DDTHH:mm"), o que importa para a conversa. */
export function resumirPaciente(
  idClient: number,
  schedules: SpineSchedule[],
  treatments: TratamentoParaEtapa[],
  agoraLocal: string,
): PacienteNaFranquia {
  const agora = agoraLocal.slice(0, 16);
  const comHora = schedules
    .map((s) => ({ s, a: paraAgendamento(s) }))
    .filter((x): x is { s: SpineSchedule; a: AgendamentoNaFranquia } => x.a !== null);

  const deFuturo = comHora
    .filter(({ s, a }) => a.quando >= agora && (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO))
    .sort((x, y) => x.a.quando.localeCompare(y.a.quando));

  const atendidas = comHora
    .filter(({ s, a }) => a.consulta && a.quando <= agora && s.idStatus === SPINE_STATUS.ATENDIDO)
    .sort((x, y) => y.a.quando.localeCompare(x.a.quando));

  return {
    idClient,
    emTratamento: treatments.some(tratamentoAberto),
    proximo: deFuturo[0]?.a ?? null,
    ultimaConsultaAtendida: atendidas[0]?.a ?? null,
  };
}

/** Não diz nada à Sofia: sem consulta futura, sem tratamento e sem consulta atendida. */
export function nadaADizer(p: PacienteNaFranquia | null): boolean {
  return !p || (!p.emTratamento && !p.proximo && !p.ultimaConsultaAtendida);
}

/**
 * 10 min: curto o bastante para a Sofia ver a consulta que a recepção acabou de marcar, longo o
 * bastante para uma conversa inteira custar uma busca só. Vale para o "não achei" também.
 */
const TTL_MS = 10 * 60_000;
const MAX_ENTRADAS = 2_000;
const cache = new Map<string, { em: number; valor: PacienteNaFranquia | null }>();

export async function pacienteNaFranquia(
  unit: Unit,
  leadId: number,
  nomes: Array<string | null | undefined>,
  telefone: string | null | undefined,
): Promise<PacienteNaFranquia | null> {
  if (!unit.spineEnabled || !unit.spineToken) return null;
  const k = `${unit.id}:${leadId}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.em < TTL_MS) return hit.valor;

  let valor: PacienteNaFranquia | null = null;
  try {
    // Título do cartão (a recepção costuma escrever o nome completo) e nome do WhatsApp, separados
    // por " / " — `termosDeBuscaDoNome` trata cada um como uma pessoa. Quem decide é o telefone.
    const nome = [...new Set(nomes.map((n) => n?.trim()).filter(Boolean))].join(' / ') || null;
    // O "não achei" do sincronizador fica 6 h no cache dele; aqui a recepção pode ter cadastrado agora.
    const idClient = await idClientDoLead(unit, leadId, nome, { fone: telefone, ignorarNegativo: true });
    if (idClient) {
      const r = await SpineService.getClient(unit, idClient);
      if (r.ok && r.data?.client) {
        const agora = instanteNoFuso(new Date(), unit.spineTimezone || 'America/Sao_Paulo');
        valor = resumirPaciente(idClient, r.data.client.schedules, r.data.client.treatments, agora);
      }
    }
  } catch (err) {
    // Erro da franquia não vira "não é paciente": só fica sem o bloco, e tenta de novo no próximo turno.
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'paciente-na-franquia: busca falhou — sem bloco');
    return null;
  }

  if (cache.size >= MAX_ENTRADAS) cache.clear();
  cache.set(k, { em: Date.now(), valor });
  return valor;
}
