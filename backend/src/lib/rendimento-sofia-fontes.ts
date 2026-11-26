/**
 * As fontes REAIS de `pluggy_rendimento_sofia` (`mcp-remoto/pluggy-rendimento.ts`): a agenda da franquia da empresa e as conversas que a Sofia atendeu. Só leitura.
 *
 * - AGENDA: `searchSchedules` (a leitura de sempre do agente, com o token da unidade). Desmarcado fica de fora (não veio). Lista cortada no teto de páginas volta `completa: false`.
 * - SOFIA: `conversation_outcomes` (o rastro que o agente grava por conversa: `msgs_ia`, `agendou_ia`, `spine_id_schedule`) com o nome que o paciente DISSE (`lead_fact_events`, chave
 *   «nome») ou, na falta, o nome do contato da conversa. Nome que não é de gente («Ocupado», «Oi», número) é descartado antes de casar com o banco.
 * Nada aqui vai para log: nome de paciente só passa por memória e volta na resposta da ferramenta (a que o conector já mascara/audita).
 */
import { prisma } from './prisma.js';
import { nomeDeGente } from './aviso-clinica-agendamento.js';
import { chaveDoNome } from './pix-casamento.js';
import { SPINE_STATUS, searchSchedules, somarDias, type SpineSchedule, type SpineUnit } from '../services/spine.service.js';
import type { ConversaDaSofia, FontesDoRendimento, PacienteDaAgenda } from '../mcp-remoto/pluggy-rendimento.js';

interface LinhaDeConversa {
  nome: string | null;
  contato: string | null;
  marcou: boolean | null;
  idSchedule: number | null;
}

/** A franquia recusa busca de mais de 100 dias (400): lê em fatias de 90, cada uma com o seu teto de páginas. `completa` falso = alguma fatia foi cortada. */
export const FATIA_DA_AGENDA_DIAS = 90;
export async function agendaEmFatias(unit: SpineUnit, de: string, ate: string): Promise<{ schedules: SpineSchedule[]; completa: boolean } | null> {
  const schedules: SpineSchedule[] = [];
  let completa = true;
  for (let ini = de; ini <= ate; ini = somarDias(ini, FATIA_DA_AGENDA_DIAS)) {
    const fim = somarDias(ini, FATIA_DA_AGENDA_DIAS - 1) < ate ? somarDias(ini, FATIA_DA_AGENDA_DIAS - 1) : ate;
    const r = await searchSchedules(unit, { initialDate: ini, endDate: fim, rowsPerPage: 100 });
    if (!r.ok || !r.data) return null;
    if (r.data.truncada) completa = false;
    schedules.push(...r.data.schedules);
  }
  return { schedules, completa };
}

export function fontesDoRendimentoReais(): FontesDoRendimento {
  return {
    async agenda(empresa, de, ate) {
      const unit = await prisma.unit.findUnique({ where: { slug: empresa }, select: { spineBaseUrl: true, spineToken: true, spineTimezone: true } });
      if (!unit?.spineToken) return null;
      const r = await agendaEmFatias(unit, de, ate);
      if (!r) return null;
      const pacientes: PacienteDaAgenda[] = r.schedules
        .filter((s) => s.idStatus !== SPINE_STATUS.DESMARCADO)
        .map((s) => ({ nome: s.clientName, idSchedule: s.idSchedule }));
      return { pacientes, completa: r.completa };
    },
    async conversasDaSofia(empresa, de, ate) {
      const unit = await prisma.unit.findUnique({ where: { slug: empresa }, select: { id: true } });
      if (!unit) return null;
      const desde = new Date(`${de}T00:00:00Z`);
      const ateExclusivo = new Date(Date.parse(`${ate}T00:00:00Z`) + 86_400_000);
      const linhas = await prisma.$queryRaw<LinhaDeConversa[]>`
        SELECT (SELECT f.valor FROM lead_fact_events f
                 WHERE f.unit_id = o.unit_id AND f.lead_id = o.kommo_lead_id::text AND f.chave = 'nome'
                 ORDER BY f.observado_em DESC LIMIT 1) AS "nome",
               c.contact_name AS "contato",
               o.agendou_ia AS "marcou",
               o.spine_id_schedule AS "idSchedule"
          FROM conversation_outcomes o
          LEFT JOIN conversations c ON c.id = o.conversation_id
         WHERE o.unit_id = ${unit.id}
           AND o.inicio_em >= ${desde} AND o.inicio_em < ${ateExclusivo}
           AND (o.msgs_ia > 0 OR o.agendou_ia)`;
      return linhas.map((l): ConversaDaSofia => ({ nome: [nomeDeGente(l.nome), nomeDeGente(l.contato)].find((n) => n && chaveDoNome(n)) ?? null, marcou: !!l.marcou, idSchedule: l.idSchedule }));
    },
  };
}
