// ============================================================================
// agenda-tools.ts — Tools de agendamento (API Spine da franquia).
//
// ONDE O GUARD REALMENTE MORA
// ---------------------------
// De nada adianta a recepção bloquear um horário na tela se o agente não
// consultar esse bloqueio na hora de marcar. Por isso a checagem NÃO está no
// prompt — instrução em prompt é sugestão, e o modelo pode contorná-la sob
// pressão do paciente. Está aqui, no código da tool: pausado ou bloqueado, a
// tool recusa e devolve o motivo. Não há caminho ao redor.
//
// REVALIDAÇÃO NA ESCRITA, e não só na oferta
// ------------------------------------------
// `consultar_horarios` e `agendar_consulta` refazem a mesma checagem. Parece
// redundante e não é: entre a IA oferecer 14h e o paciente responder "pode
// ser", passam minutos — tempo de sobra pra recepção bloquear aquele horário
// ou outro paciente marcar. Confiar na consulta anterior é confiar num dado
// vencido, e o preço é duas pessoas na mesma cadeira.
// ============================================================================

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaService } from '../services/agenda.service.js';

const TZ_PADRAO = 'America/Sao_Paulo';

function agoraLocal(unit: Unit): string {
  return SpineService.instanteNoFuso(new Date(), unit.spineTimezone || TZ_PADRAO);
}

/** Recarrega a unidade do banco — pausa e bloqueios mudam DURANTE a conversa. */
async function unidadeFresca(unitId: string): Promise<Unit | null> {
  return prisma.unit.findUnique({ where: { id: unitId } });
}

interface Contexto {
  unit: Unit;
  recorder: TraceRecorder;
  /** Opcional: sem ele o agendamento funciona, só não carimba o CRM. */
  kommo?: KommoClient;
}

/**
 * Campos do Kommo que registram o agendamento.
 *
 * Preenchidos PELA TOOL, não por regra de captura. A diferença importa: regra
 * de captura depende de a I.A. decidir chamá-la, e "esqueci de marcar Agendou"
 * é invisível — some numa estatística que ninguém confere. Aqui, se a consulta
 * foi marcada, o campo é escrito no mesmo passo. Não há caminho em que uma
 * coisa aconteça sem a outra.
 */
const CAMPO_AGENDOU = 2442703;      // ✓ Agendou (select Sim/Não)
const CAMPO_DATA_AGENDAMENTO = 2440909; // ◷ Data de agendamento (date_time)

// ---------------------------------------------------------------------------
// Grade de um dia, já com tudo subtraído.
// ---------------------------------------------------------------------------

async function gradeDoDia(unit: Unit, dia: string) {
  const [r, blocks] = await Promise.all([
    SpineService.searchSchedules(unit, { initialDate: dia, endDate: dia }),
    prisma.agendaBlock.findMany({ where: { unitId: unit.id, dayLocal: dia } }),
  ]);
  if (!r.ok || !r.data) return { erro: r.error ?? 'agenda indisponível', slots: [] as const };

  const slots = AgendaService.buildAgenda(
    {
      start: unit.spineAgendaStart,
      end: unit.spineAgendaEnd,
      lunchStart: unit.spineLunchStart,
      lunchEnd: unit.spineLunchEnd,
      days: unit.spineAgendaDays,
      slotMinutes: unit.spineSlotMinutes,
    },
    r.data.schedules,
    { initialDate: dia, endDate: dia },
    agoraLocal(unit),
    blocks,
  );
  return { erro: null, slots };
}

// ---------------------------------------------------------------------------
// consultar_horarios
// ---------------------------------------------------------------------------

export function buildConsultarHorarios({ unit, recorder }: Contexto) {
  return new DynamicStructuredTool({
    name: 'consultar_horarios',
    description:
      'Consulta os horários REALMENTE disponíveis da clínica numa data. Use SEMPRE ' +
      'antes de oferecer qualquer horário ao paciente — nunca invente nem repita ' +
      'horário de uma consulta anterior. Devolve só o que está livre: já desconta ' +
      'consultas marcadas, almoço, dias sem atendimento e bloqueios da recepção.',
    schema: z.object({
      data: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Data no formato AAAA-MM-DD, no fuso da clínica.'),
    }),
    func: async ({ data }: { data: string }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;

      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'A agenda da clínica não está conectada. NÃO ofereça horários — diga que a equipe entra em contato para marcar.';
      }
      if (fresca.spineAiPaused) {
        await recorder.step({
          kind: 'TOOL_RESULT',
          title: 'consultar_horarios bloqueado — IA pausada pela recepção',
          payload: { motivo: fresca.spinePausedReason },
        });
        return (
          'AGENDAMENTO PAUSADO pela recepção' +
          (fresca.spinePausedReason ? ` (${fresca.spinePausedReason})` : '') +
          '. NÃO ofereça nenhum horário. Diga ao paciente que houve uma intercorrência ' +
          'na agenda e que você retorna em instantes com os horários — sem prometer dia nem hora.'
        );
      }

      const { erro, slots } = await gradeDoDia(fresca, data);
      if (erro) {
        logger.warn({ erro, data, unit: fresca.slug }, 'consultar_horarios: agenda indisponível');
        return `Não consegui consultar a agenda agora (${erro}). NÃO ofereça horários; diga que a equipe confirma em seguida.`;
      }

      const livres = slots.filter((s) => s.status === 'livre').map((s) => s.time);
      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `consultar_horarios ${data}: ${livres.length} livre(s)`,
        payload: { data, livres, total: slots.length },
      });

      if (livres.length === 0) {
        return `Nenhum horário livre em ${data}. Ofereça outra data — NÃO insista nesta.`;
      }
      return `Horários livres em ${data}: ${livres.join(', ')}. Ofereça no máximo 2 ou 3 deles.`;
    },
  });
}

// ---------------------------------------------------------------------------
// buscar_paciente
// ---------------------------------------------------------------------------

export function buildBuscarPaciente({ unit, recorder }: Contexto) {
  return new DynamicStructuredTool({
    name: 'buscar_paciente',
    description:
      'Procura o paciente no sistema da clínica pelo nome, para obter o cadastro ' +
      'necessário ao agendamento. Use antes de agendar. Se não encontrar, NÃO ' +
      'invente cadastro — transfira para a equipe.',
    schema: z.object({
      nome: z.string().min(2).max(120).describe('Nome do paciente, completo ou parcial.'),
    }),
    func: async ({ nome }: { nome: string }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Sistema da clínica não conectado. Transfira para a equipe.';
      }
      const r = await SpineService.searchClients(fresca, nome);
      if (!r.ok || !r.data) return `Não consegui consultar o cadastro (${r.error}).`;

      const achados = r.data.clients.slice(0, 5);
      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `buscar_paciente "${nome}": ${achados.length} resultado(s)`,
        payload: { nome, achados },
      });
      if (achados.length === 0) {
        return `Nenhum cadastro encontrado para "${nome}". NÃO agende — avise que a equipe vai concluir o cadastro e o agendamento.`;
      }
      return achados
        .map((c) => `idClient ${c.idClient} — ${c.name}${c.whatsapp ? ` (${c.whatsapp})` : ''}`)
        .join(' | ');
    },
  });
}

// ---------------------------------------------------------------------------
// agendar_consulta
// ---------------------------------------------------------------------------

export function buildAgendarConsulta({ unit, recorder, kommo }: Contexto) {
  return new DynamicStructuredTool({
    name: 'agendar_consulta',
    description:
      'Marca a consulta no sistema da clínica. Só use DEPOIS de consultar_horarios ' +
      'e de o paciente escolher um horário da lista, e com o idClient obtido em ' +
      'buscar_paciente. Se a tool recusar, NÃO tente outro horário por conta ' +
      'própria: explique ao paciente e ofereça consultar de novo.',
    schema: z.object({
      idClient: z.number().int().positive().describe('idClient do paciente (de buscar_paciente).'),
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data AAAA-MM-DD.'),
      hora: z.string().regex(/^\d{2}:\d{2}$/).describe('Hora HH:mm do fuso da clínica.'),
      idCategory: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Categoria do atendimento. Padrão 1 (consulta).'),
      leadId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('ID do lead no Kommo — use o leadId desta conversa.'),
    }),
    func: async (args: {
      idClient: number;
      data: string;
      hora: string;
      idCategory?: number;
      leadId?: number;
    }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;

      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Agenda não conectada. NÃO confirme nada — diga que a equipe conclui o agendamento.';
      }

      // GUARD 1 — pausa. Relido do banco AGORA, não do começo da conversa.
      if (fresca.spineAiPaused) {
        await recorder.step({
          kind: 'ERROR',
          title: 'agendar_consulta recusado — IA pausada pela recepção',
          payload: { ...args, motivo: fresca.spinePausedReason },
        });
        return (
          'AGENDAMENTO PAUSADO pela recepção. A consulta NÃO foi marcada. Explique que ' +
          'houve uma intercorrência na agenda e que a equipe confirma o horário em seguida. ' +
          'NÃO diga que está agendado.'
        );
      }

      // GUARD 2 — o horário ainda está livre? Revalidado na hora da escrita,
      // porque entre a oferta e o "pode ser" do paciente passam minutos.
      const { erro, slots } = await gradeDoDia(fresca, args.data);
      if (erro) {
        return `Não consegui confirmar a agenda (${erro}). NÃO diga que está marcado.`;
      }
      const slot = slots.find((s) => s.time === args.hora);
      if (!slot) {
        return `${args.hora} não é um horário de atendimento em ${args.data}. Consulte os horários de novo e ofereça um da lista.`;
      }
      if (slot.status !== 'livre') {
        await recorder.step({
          kind: 'ERROR',
          title: `agendar_consulta recusado — ${args.hora} está ${slot.status}`,
          payload: { ...args, motivo: slot.motivo },
        });
        return (
          `${args.hora} não está mais disponível (${slot.motivo ?? slot.status}). ` +
          'A consulta NÃO foi marcada. Peça desculpas, consulte os horários de novo e ofereça outro.'
        );
      }

      const r = await SpineService.createSchedule(fresca, {
        idClient: args.idClient,
        dateAttendanceLocal: `${args.data}T${args.hora}:00`,
        idCategory: args.idCategory ?? 1,
      });

      if (!r.ok) {
        await recorder.step({
          kind: 'ERROR',
          title: `agendar_consulta falhou: ${r.error}`,
          payload: { ...args, error: r.error },
        });
        return `Não consegui concluir o agendamento (${r.error}). NÃO diga que está marcado — avise que a equipe confirma.`;
      }

      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `Consulta marcada: ${args.data} ${args.hora} (idSchedule ${r.data?.idSchedule})`,
        payload: { ...args, idSchedule: r.data?.idSchedule },
      });

      // Carimba o CRM no MESMO passo. Fire-and-forget porque falhar aqui não
      // desfaz o agendamento — a consulta está marcada na franquia, e voltar
      // erro faria a I.A. dizer ao paciente que não marcou, o que seria falso.
      if (kommo && args.leadId) {
        void (async () => {
          try {
            await kommo.setLeadCustomFieldValue(args.leadId!, CAMPO_AGENDOU, 'select', 'Sim');
            await kommo.setLeadCustomFieldValue(
              args.leadId!,
              CAMPO_DATA_AGENDAMENTO,
              'date',
              `${args.data}T${args.hora}:00`,
            );
            await recorder.step({
              kind: 'KOMMO_ACTION',
              title: 'Campos de agendamento preenchidos (Agendou, Data de agendamento)',
              payload: { leadId: args.leadId, data: args.data, hora: args.hora },
            });
          } catch (err) {
            logger.warn({ err, leadId: args.leadId }, 'agenda: falha ao carimbar campos no Kommo');
          }
        })();
      }

      return `Consulta marcada para ${args.data} às ${args.hora}. Confirme ao paciente com dia e hora.`;
    },
  });
}

/** Só entram quando a unidade tem a agenda conectada. */
export function buildAgendaTools(ctx: Contexto): DynamicStructuredTool[] {
  if (!ctx.unit.spineEnabled) return [];
  return [
    buildConsultarHorarios(ctx),
    buildBuscarPaciente(ctx),
    buildAgendarConsulta(ctx),
  ] as unknown as DynamicStructuredTool[];
}
