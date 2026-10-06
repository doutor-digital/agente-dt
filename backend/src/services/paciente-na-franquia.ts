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
import { fusoDaUnidade } from '../lib/fuso.js';
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
  /** a consulta (avaliação/retorno) atendida mais recente, dentro de JANELA_ATENDIDA_DIAS */
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

/**
 * Avaliação atendida há mais tempo que isso não conta: quem foi avaliado em 2024, teve alta e volta
 * com dor nova é lead de novo — tem de poder ouvir sobre a avaliação.
 */
const JANELA_ATENDIDA_DIAS = 90;

function diasAntes(local: string, dias: number): string {
  const t = Date.parse(`${local.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? local : `${new Date(t - dias * 86_400_000).toISOString().slice(0, 10)}T00:00`;
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

  const desde = diasAntes(agora, JANELA_ATENDIDA_DIAS);
  const atendidas = comHora
    .filter(({ s, a }) => a.consulta && a.quando <= agora && a.quando >= desde && s.idStatus === SPINE_STATUS.ATENDIDO)
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
/** Dois turnos seguidos do mesmo lead esperam a MESMA busca, em vez de repetir as chamadas à franquia. */
const emVoo = new Map<string, Promise<PacienteNaFranquia | null>>();
/** Cada termo é uma chamada à franquia; quem decide é o telefone, e os primeiros termos já são os nomes inteiros. */
const MAX_TERMOS = 5;

/** Erro da franquia: não é "não é paciente" — fica sem o bloco e NÃO entra no cache. */
class FalhaDaFranquia extends Error {}

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
  const voando = emVoo.get(k);
  if (voando) return voando;

  const busca = buscar(unit, leadId, nomes, telefone)
    .then((valor) => {
      if (cache.size >= MAX_ENTRADAS) cache.clear();
      cache.set(k, { em: Date.now(), valor });
      return valor;
    })
    .catch((err) => {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'paciente-na-franquia: busca falhou — sem bloco');
      return null;
    })
    .finally(() => emVoo.delete(k));
  emVoo.set(k, busca);
  return busca;
}

async function buscar(
  unit: Unit,
  leadId: number,
  nomes: Array<string | null | undefined>,
  telefone: string | null | undefined,
): Promise<PacienteNaFranquia | null> {
  // Título do cartão (a recepção costuma escrever o nome completo) e nome do WhatsApp, separados
  // por " / " — `termosDeBuscaDoNome` trata cada um como uma pessoa. Só vale quem bate o telefone.
  const nome = [...new Set(nomes.map((n) => n?.trim()).filter(Boolean))].join(' / ') || null;
  const idClient = await idClientDoLead(unit, leadId, nome, { fone: telefone, soPorTelefone: true, maxTermos: MAX_TERMOS });
  if (!idClient) return null;
  const r = await SpineService.getClient(unit, idClient);
  if (!r.ok) throw new FalhaDaFranquia(`getClient(${idClient}): ${r.error ?? 'falhou'}`);
  if (!r.data?.client) return null;
  const agora = instanteNoFuso(new Date(), fusoDaUnidade(unit));
  return resumirPaciente(idClient, r.data.client.schedules, r.data.client.treatments, agora);
}
