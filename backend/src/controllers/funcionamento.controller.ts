import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { feriadosNoIntervalo, dataLocalISO } from '../lib/feriados.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { resumoResultados } from '../services/resultados.service.js';

/**
 * GET /units/:id/funcionamento?days=7
 *
 * Contadores vivos de cada comportamento da IA, para a tela "Como a Sofia funciona".
 * Existe porque o João pediu para VER no painel o que hoje só vive no backend e no
 * banco ("senão eu não consigo entender"). Um comportamento sem número ao lado é
 * um comportamento que ninguém sabe se está acontecendo.
 */
export async function funcionamentoHandler(req: Request, res: Response): Promise<void> {
  const unitId = String(req.params.id ?? '');
  const dias = Math.min(Math.max(Number(req.query.days ?? 7), 1), 90);
  const desde = new Date(Date.now() - dias * 86_400_000);
  try {
    const unit = await prisma.unit.findUnique({ where: { id: unitId } });
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const passo = (where: Prisma.ExecutionStepWhereInput) =>
      prisma.executionStep.count({ where: { trace: { unitId }, createdAt: { gte: desde }, ...where } });
    const decisao = (valor: string) =>
      prisma.executionTrace.count({ where: { unitId, createdAt: { gte: desde }, iaDecision: { equals: valor } } });

    const [
      rastros, pausados, etapaNaoPermitida, encerramentoRepetido, foraDoHorario, agrupadosTrace,
      burstsAgrupados, consultasAgenda, consultasMarcadas, agendarFalhou, leadsMovidos, resumosSdr,
      handoffsCarimbados, iaPausada, tarefasCriadas, alertas, safetyNet, entregasSalesbot, entregasNota,
      capturas, readbackDivergiu, patchFalhou, fallbackNota, conversas, llm,
    ] = await Promise.all([
      prisma.executionTrace.count({ where: { unitId, createdAt: { gte: desde } } }),
      decisao('__paused__'),
      decisao('__stage_not_allowed__'),
      decisao('__encerramento_repetido__'),
      decisao('__out_of_hours__'),
      prisma.executionTrace.count({ where: { unitId, createdAt: { gte: desde }, iaDecision: { string_starts_with: '__coalesced_into__' } } }),
      passo({ title: { startsWith: 'Burst coalescido' } }),
      passo({ kind: 'TOOL_RESULT', title: { startsWith: 'consultar_horarios' } }),
      passo({ kind: 'TOOL_RESULT', title: { startsWith: 'Consulta marcada:' } }),
      passo({ kind: 'ERROR', title: { startsWith: 'agendar_consulta falhou' } }),
      passo({ title: { startsWith: 'Lead movido para etapa' } }),
      passo({ title: { contains: 'resumo pra SDR' } }),
      passo({ title: { startsWith: 'Handoff carimbado' } }),
      passo({ title: { startsWith: 'IA pausada no lead' } }),
      passo({ title: { startsWith: 'Tarefa criada no lead' } }),
      passo({ title: { startsWith: 'ALERTA ·' } }),
      passo({ title: { startsWith: '[safety-net]' } }),
      passo({ title: { startsWith: 'Resposta entregue ao paciente via salesbot' } }),
      passo({ title: { startsWith: 'Resposta entregue ao paciente via lead_note' } }),
      passo({ kind: 'TOOL_CALL', title: { startsWith: 'Decisão: registra_' } }),
      passo({ title: { contains: 'Readback: divergência' } }),
      passo({ kind: 'ERROR', title: { contains: 'PATCH no campo "Resposta IA" falhou' } }),
      passo({ title: { startsWith: '📝 Caiu no fallback' } }),
      prisma.conversation.aggregate({
        where: { unitId, createdAt: { gte: desde } },
        _count: { _all: true, handoffAt: true, convertedAt: true },
        _sum: { reactivations: true, followUpStep: true },
      }),
      prisma.llmCall.aggregate({ where: { unitId, createdAt: { gte: desde } }, _count: { _all: true }, _sum: { costUsd: true } }),
    ]);

    const sond = await prisma.$queryRaw<Array<{ sondados: bigint | null; recusados: bigint | null; oferecidos: bigint | null }>>`
      select
        sum(jsonb_array_length(coalesce(s.payload->'sondados','[]'::jsonb))) as sondados,
        sum(jsonb_array_length(coalesce(s.payload->'recusados','[]'::jsonb))) as recusados,
        sum(jsonb_array_length(coalesce(s.payload->'oferecer','[]'::jsonb))) as oferecidos
      from execution_steps s join execution_traces t on t.id = s.trace_id
      where t.unit_id = ${unitId} and s.created_at >= ${desde} and s.kind = 'TOOL_RESULT' and s.title like 'consultar_horarios%'`;

    const tz = fusoDaUnidade(unit);
    const hoje = dataLocalISO(new Date(), tz);
    const em30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const bloqueiosFuturos = await prisma.agendaBlock.count({ where: { unitId, dayLocal: { gte: hoje } } });

    res.json({
      dias,
      rastros: {
        total: rastros,
        pausados,
        etapaNaoPermitida,
        agrupados: agrupadosTrace,
        encerramentoRepetido,
        foraDoHorario,
        respondidos: Math.max(0, rastros - pausados - etapaNaoPermitida - agrupadosTrace - encerramentoRepetido - foraDoHorario),
      },
      contadores: {
        burstsAgrupados, consultasAgenda, consultasMarcadas, agendarFalhou, leadsMovidos, resumosSdr,
        handoffsCarimbados, iaPausada, tarefasCriadas, alertas, safetyNet, entregasSalesbot, entregasNota,
        capturas, readbackDivergiu, patchFalhou, fallbackNota,
      },
      sondagem: {
        consultas: consultasAgenda,
        sondados: Number(sond[0]?.sondados ?? 0),
        recusados: Number(sond[0]?.recusados ?? 0),
        oferecidos: Number(sond[0]?.oferecidos ?? 0),
      },
      conversas: {
        total: conversas._count._all,
        handoffs: conversas._count.handoffAt,
        convertidas: conversas._count.convertedAt,
        reativacoes: conversas._sum.reactivations ?? 0,
        followUps: conversas._sum.followUpStep ?? 0,
      },
      agenda: {
        fuso: tz,
        hoje,
        bloqueiosFuturos,
        feriadosProximos: feriadosNoIntervalo(hoje, em30),
        janela: {
          dias: unit.spineAgendaDays,
          inicio: unit.spineAgendaStart,
          fim: unit.spineAgendaEnd,
          almoco: [unit.spineLunchStart, unit.spineLunchEnd],
          porDia: unit.spineDayHours ?? null,
          slot: unit.spineSlotMinutes,
        },
        coalesceMs: Number(process.env.AGENT_COALESCE_MS) || 8000,
      },
      llm: { chamadas: llm._count._all, custoUsd: Number(llm._sum.costUsd ?? 0) },
      resultados: await resumoResultados(unitId, Math.max(dias, 30)),
    });
  } catch (err) {
    logger.error({ err: String(err), unitId }, 'funcionamento: falha');
    res.status(500).json({ error: 'funcionamento_failed' });
  }
}
