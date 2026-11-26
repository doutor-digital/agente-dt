/**
 * As fontes REAIS de `pluggy_rendimento_sofia` (`mcp-remoto/pluggy-rendimento.ts`): a agenda da franquia da empresa e as conversas que a Sofia atendeu. Só leitura.
 *
 * - AGENDA: `searchSchedules` (a leitura de sempre do agente, com o token da unidade). Desmarcado fica de fora (não veio). Lista cortada no teto de páginas volta `completa: false`.
 * - SOFIA: só vale FALA DELA DENTRO DA JANELA: mensagem na tabela `messages` e `created_at` entre o início e o fim da janela que seja a Sofia CONVERSANDO (`E_SOFIA`, a mesma regra do resumo
 *   de qualidade e de `mensagem-da-ia.ts`): fica de fora a fala da equipe copiada do Kommo, a confirmação de véspera (D-1), o lembrete, o cartão de chegada e o envio automático de retomada
 *   (régua, reativação, cutucada) — tudo isso também é gravado como `role = 'assistant'`. O tempo de vida da conversa, o total
 *   de `msgs_ia` e a última mensagem NÃO contam (a Sofia que retoma o lead depois do período não o torna «sofia»). A marcação que ela gravou vem de `conversation_outcomes` e só vale com `agendou_ia` verdadeiro (o botão «Marcar consulta» da equipe grava o mesmo `spine_id_schedule`).
 * Nada aqui vai para log: nome de paciente só passa por memória e volta na resposta da ferramenta (a que o conector já mascara/audita).
 */
import { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { E_SOFIA } from './qualidade-ia/consulta.js';
import { logger } from './logger.js';
import { nomeDeGente } from './aviso-clinica-agendamento.js';
import { chaveDoNome, tokensDoNome } from './pix-casamento.js';
import { SPINE_STATUS, localParaUtcIso, searchClients, searchSchedules, somarDias, type SpineSchedule, type SpineUnit } from '../services/spine.service.js';
import { fusoDaUnidade } from './fuso.js';
import type { ConversaDaSofia, FontesDoRendimento, PacienteDaAgenda } from '../mcp-remoto/pluggy-rendimento.js';

/** Tamanho da busca de ficha por nome (o máximo da franquia): página cheia = ficha não comprovadamente única. */
const BUSCA_DE_FICHAS = 100;

/**
 * O período são DIAS DA UNIDADE (como a agenda e o banco): meia-noite no fuso dela, não em UTC. `ateExclusivo` é a meia-noite do dia SEGUINTE ao último dia.
 * Null se a data não é uma data.
 */
export function janelaDaUnidade(unit: { businessHoursTimezone?: string | null; spineTimezone?: string | null }, de: string, ate: string): { desde: Date; ateExclusivo: Date } | null {
  const fuso = fusoDaUnidade(unit as never);
  const desdeIso = localParaUtcIso(`${de}T00:00:00`, fuso);
  const ateIso = localParaUtcIso(`${somarDias(ate, 1)}T00:00:00`, fuso);
  return desdeIso && ateIso ? { desde: new Date(desdeIso), ateExclusivo: new Date(ateIso) } : null;
}

/** A conversa conta como «da Sofia» na janela só com FALA dela dentro dela (a contagem vem do SQL, que filtra `messages` por role e por `created_at`). */
export const contaComoSofia = (l: { falasNaJanela: number }): boolean => l.falasNaJanela > 0;

/**
 * O que um telefone prova, dado quantas falas da Sofia há nas conversas com ele: dentro da janela → `sofia`; só FORA da janela → `desconhecido` (conversou, mas não dá para atribuir este
 * período a ela nem dizer que é da equipe); nenhuma, em QUALQUER data → `equipe` (a prova por ausência só vale sem conversa nenhuma).
 */
export function origemDoTelefone(falas: { naJanela: number; total: number }): 'sofia' | 'equipe' | 'desconhecido' {
  if (falas.naJanela > 0) return 'sofia';
  return falas.total > 0 ? 'desconhecido' : 'equipe';
}

interface LinhaDeConversa {
  nome: string | null;
  contato: string | null;
  marcou: boolean | null;
  idSchedule: number | null;
  falasNaJanela: number;
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
    async origemPorTelefone(empresa, nomes, desde, ate) {
      const out = new Map<string, 'sofia' | 'equipe' | 'desconhecido'>(nomes.map((n) => [n, 'desconhecido']));
      const buscar = () => prisma.unit.findUnique({ where: { slug: empresa }, select: { id: true, spineBaseUrl: true, spineToken: true, spineTimezone: true, businessHoursTimezone: true } });
      let unit: Awaited<ReturnType<typeof buscar>>;
      try {
        unit = await buscar();
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200) }, 'rendimento-sofia: não li a unidade para conferir a origem por telefone — fica sem comprovação');
        return out;
      }
      if (!unit?.spineToken) return out;
      const janela = janelaDaUnidade(unit, desde, ate);
      if (!janela) return out;
      const um = async (nome: string) => {
        // a busca da franquia acha por pedaço do nome: página cheia = pode haver outro homônimo na página seguinte, então não dá para afirmar que a ficha é única
        const r = await searchClients(unit, nome, BUSCA_DE_FICHAS);
        if (!r.ok || !r.data || r.data.clients.length >= BUSCA_DE_FICHAS) return;
        const alvo = tokensDoNome(nome).join(' ');
        const iguais = r.data.clients.filter((c) => tokensDoNome(c.name).join(' ') === alvo);
        // atenção: dentro do template o texto passa por escape do JS — por isso a classe é [^0-9], sem barra invertida
        const fim8 = iguais.length === 1 ? (iguais[0]!.whatsapp ?? '').replace(/\D/g, '').slice(-8) : '';
        if (fim8.length < 8) return;
        // as FALAS da Sofia (role assistant) nas conversas com ESTE telefone: dentro da janela e em qualquer data (a ausência só prova «equipe» se não houver conversa NUNCA)
        const f = await prisma.$queryRaw<Array<{ naJanela: number; total: number }>>(Prisma.sql`
          SELECT count(*) FILTER (WHERE m.created_at >= ${janela.desde} AND m.created_at < ${janela.ateExclusivo})::int AS "naJanela", count(*)::int AS "total"
            FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.unit_id = ${unit.id} AND ${E_SOFIA}
             AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 8) = ${fim8}`);
        out.set(nome, origemDoTelefone({ naJanela: Number(f[0]?.naJanela ?? 0), total: Number(f[0]?.total ?? 0) }));
      };
      // em lotes de 5 em paralelo; cada nome falha sozinho (uma falha não joga fora as outras conferências)
      for (let i = 0; i < nomes.length; i += 5) {
        const lote = await Promise.allSettled(nomes.slice(i, i + 5).map(um));
        for (const l of lote) if (l.status === 'rejected') logger.warn({ err: String(l.reason).slice(0, 200) }, 'rendimento-sofia: falha ao conferir uma origem por telefone — esse paciente fica sem comprovação');
      }
      return out;
    },
    async primeirosNomesSemTelefone(empresa) {
      try {
        const unit = await prisma.unit.findUnique({ where: { slug: empresa }, select: { id: true } });
        if (!unit) return null;
        // conversas da Sofia (com fala dela, de QUALQUER data) cujo telefone não está guardado
        const linhas = await prisma.$queryRaw<Array<{ nome: string | null; contato: string | null }>>(Prisma.sql`
          SELECT (SELECT f.valor FROM lead_fact_events f
                   WHERE f.unit_id = c.unit_id AND f.lead_id = c.lead_id AND f.chave = 'nome'
                   ORDER BY f.observado_em DESC LIMIT 1) AS "nome",
                 c.contact_name AS "contato"
            FROM conversations c
           WHERE c.unit_id = ${unit.id}
             AND length(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')) < 8
             AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND ${E_SOFIA})`);
        const primeiros = new Set<string>();
        for (const l of linhas) for (const n of [nomeDeGente(l.nome), nomeDeGente(l.contato)]) {
          const t = tokensDoNome(n)[0];
          if (t) primeiros.add(t);
        }
        return primeiros;
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200) }, 'rendimento-sofia: não li as conversas sem telefone — ninguém é «equipe» nesta resposta');
        return null;
      }
    },
    async conversasDaSofia(empresa, de, ate) {
      const unit = await prisma.unit.findUnique({ where: { slug: empresa }, select: { id: true, businessHoursTimezone: true, spineTimezone: true } });
      if (!unit) return null;
      const janela = janelaDaUnidade(unit, de, ate);
      if (!janela) return null;
      const { desde, ateExclusivo } = janela;
      // só conversa com FALA da Sofia (messages.role = 'assistant') dentro da janela, com limite dos dois lados
      const linhas = (
        await prisma.$queryRaw<LinhaDeConversa[]>(Prisma.sql`
        SELECT (SELECT f.valor FROM lead_fact_events f
                 WHERE f.unit_id = c.unit_id AND f.lead_id = c.lead_id AND f.chave = 'nome'
                 ORDER BY f.observado_em DESC LIMIT 1) AS "nome",
               c.contact_name AS "contato",
               coalesce(bool_or(o.agendou_ia), false) AS "marcou",
               max(o.spine_id_schedule) FILTER (WHERE o.agendou_ia) AS "idSchedule",
               count(m.id)::int AS "falasNaJanela"
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          LEFT JOIN conversation_outcomes o ON o.conversation_id = c.id
         WHERE c.unit_id = ${unit.id} AND ${E_SOFIA}
           AND m.created_at >= ${desde} AND m.created_at < ${ateExclusivo}
         GROUP BY c.id`)
      ).filter(contaComoSofia);
      return linhas.map((l): ConversaDaSofia => ({ nome: [nomeDeGente(l.nome), nomeDeGente(l.contato)].find((n) => n && chaveDoNome(n)) ?? null, marcou: !!l.marcou, idSchedule: l.idSchedule }));
    },
  };
}
