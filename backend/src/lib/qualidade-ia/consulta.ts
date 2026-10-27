/**
 * As consultas do resumo de qualidade da Sofia. SÓ LEITURA, SEM IA: contagem sobre `conversation_evaluations`,
 * `messages` e `conversations`, que o sistema já grava. São 3 consultas por resumo (avaliações, mensagens,
 * contato da pior conversa); as contas em cima delas estão em `agregar.ts` e `texto.ts`.
 *
 * O que é "Sofia falou" (fragmento `E_SOFIA`): mensagem `assistant` que a IA escreveu na conversa. Ficam de
 * fora o que também é gravado como `assistant` mas não é ela conversando: fala da equipe lida da conversa
 * oficial (`origem = kommo_talks`), degraus da régua (`followUp`), reativação, lembrete de consulta.
 *
 * O que é "avaliável": a Sofia falou ≥ 1 vez E o paciente escreveu depois da 1ª fala dela. O resto é nota
 * que não mede a Sofia (medido em 27/10/2026: ~7% das conversas sem nenhuma fala dela, ~24% em que o
 * paciente sumiu depois da 1ª fala).
 *
 * Datas: `messages.created_at` e `conversation_evaluations.created_at` são `timestamp` SEM fuso, em UTC
 * (padrão do Prisma). O dia de São Paulo sai de `(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`;
 * `col AT TIME ZONE 'America/Sao_Paulo'` direto leria o UTC como se fosse horário de Brasília.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { inicioDoDia, somarDias } from './dias.js';
import { final4, limparTrecho, primeiroNome } from './privacidade.js';
import { MIN_CARACTERES_REPETIDA, REGEX_FALHA, REGEX_VAZAMENTO } from './sinais.js';
import type { Dia, DiaMensagens, LinhaDeAvaliacao, PiorConversa } from './tipos.js';

/** Mensagem do paciente que não chegou como texto: vazia, ou o marcador de áudio que não deu para ouvir. */
const AUDIO_NAO_OUVIDO = '[áudio do cliente — não deu pra ouvir]';

const E_SOFIA = Prisma.sql`(
  m.role = 'assistant'
  AND coalesce(m.meta->>'origem', '') <> 'kommo_talks'
  AND coalesce(m.meta->>'origem', '') <> 'lembrete_kommo'
  AND coalesce(m.meta->>'origem', '') NOT LIKE 'confirmacao%'
  AND m.meta->'followUp' IS NULL
  AND m.meta->'reactivation' IS NULL
)`;

/** Dia de São Paulo (date) de uma coluna `timestamp` em UTC. */
const diaSP = (col: Prisma.Sql) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date`;

/** Intervalo [ini, fim) em UTC que cobre os dias de `de` a `ate` (inclusive). */
export function janela(de: Dia, ate: Dia): { ini: Date; fim: Date } {
  return { ini: inicioDoDia(de), fim: inicioDoDia(somarDias(ate, 1)) };
}

/** Uma linha por avaliação do período, da mais nova para a mais velha. */
export async function avaliacoesDoPeriodo(de: Dia, ate: Dia): Promise<LinhaDeAvaliacao[]> {
  const { ini, fim } = janela(de, ate);
  const rows = await prisma.$queryRaw<
    Array<{
      conversationId: string;
      unitId: string;
      unidade: string;
      dia: string;
      nota: number;
      sofiaFalou: boolean;
      pacienteRespondeu: boolean;
      ganhou: boolean;
      comConsulta: boolean;
    }>
  >`
    SELECT e.conversation_id AS "conversationId",
           e.unit_id AS "unitId",
           u.name AS unidade,
           to_char(${diaSP(Prisma.sql`e.created_at`)}, 'YYYY-MM-DD') AS dia,
           e.overall_score::float8 AS nota,
           (s.primeira_sofia IS NOT NULL) AS "sofiaFalou",
           (s.primeira_sofia IS NOT NULL AND EXISTS (
              SELECT 1 FROM messages p
              WHERE p.conversation_id = e.conversation_id AND p.role = 'user' AND p.created_at > s.primeira_sofia
           )) AS "pacienteRespondeu",
           (c.converted_at IS NOT NULL) AS ganhou,
           EXISTS (
             SELECT 1 FROM spine_lead_links l
             WHERE l.unit_id = c.unit_id AND l.kommo_lead_id::text = c.lead_id AND l.spine_id_schedule IS NOT NULL
           ) AS "comConsulta"
    FROM conversation_evaluations e
    JOIN conversations c ON c.id = e.conversation_id
    JOIN units u ON u.id = e.unit_id
    LEFT JOIN LATERAL (
      SELECT min(m.created_at) AS primeira_sofia
      FROM messages m
      WHERE m.conversation_id = e.conversation_id AND ${E_SOFIA}
    ) s ON true
    WHERE e.created_at >= ${ini} AND e.created_at < ${fim}
    ORDER BY e.created_at DESC`;
  return rows.map((r) => ({ ...r, nota: Number(r.nota) }));
}

/** Conversas, mensagens vazias e sinais objetivos de erro, por dia da MENSAGEM. */
export async function mensagensPorDia(de: Dia, ate: Dia): Promise<DiaMensagens[]> {
  const { ini, fim } = janela(de, ate);

  const pacientes = await prisma.$queryRaw<
    Array<{ dia: string; conversasComPaciente: number; conversasSemSofia: number; mensagensPaciente: number; mensagensPacienteVazias: number }>
  >`
    WITH pac AS (
      SELECT ${diaSP(Prisma.sql`m.created_at`)} AS dia,
             m.conversation_id,
             count(*) AS msgs,
             count(*) FILTER (WHERE btrim(m.content) = '' OR m.content LIKE ${AUDIO_NAO_OUVIDO + '%'}) AS vazias
      FROM messages m
      WHERE m.role = 'user' AND m.created_at >= ${ini} AND m.created_at < ${fim}
      GROUP BY 1, 2
    )
    SELECT to_char(pac.dia, 'YYYY-MM-DD') AS dia,
           count(*)::int AS "conversasComPaciente",
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = pac.conversation_id AND ${E_SOFIA}
               AND m.created_at < (((pac.dia + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC')
           ))::int AS "conversasSemSofia",
           sum(pac.msgs)::int AS "mensagensPaciente",
           sum(pac.vazias)::int AS "mensagensPacienteVazias"
    FROM pac
    GROUP BY pac.dia
    ORDER BY pac.dia`;

  // A véspera da janela entra só para a "repetida" do 1º dia ter com o que comparar.
  const antes = new Date(ini.getTime() - 86_400_000);
  const sofia = await prisma.$queryRaw<Array<{ dia: string; mensagens: number; repetidas: number; vazamento: number; falha: number }>>`
    WITH s AS (
      SELECT m.conversation_id, m.content, m.created_at,
             lag(m.content) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS anterior
      FROM messages m
      WHERE ${E_SOFIA} AND m.created_at >= ${antes} AND m.created_at < ${fim}
    )
    SELECT to_char(${diaSP(Prisma.sql`s.created_at`)}, 'YYYY-MM-DD') AS dia,
           count(*)::int AS mensagens,
           count(*) FILTER (WHERE s.anterior IS NOT NULL
                              AND length(btrim(s.content)) >= ${MIN_CARACTERES_REPETIDA}
                              AND btrim(s.content) = btrim(s.anterior))::int AS repetidas,
           count(*) FILTER (WHERE s.content ~* ${REGEX_VAZAMENTO})::int AS vazamento,
           count(*) FILTER (WHERE s.content ~* ${REGEX_FALHA})::int AS falha
    FROM s
    WHERE s.created_at >= ${ini}
    GROUP BY 1
    ORDER BY 1`;

  const pDia = new Map(pacientes.map((p) => [p.dia, p]));
  const sDia = new Map(sofia.map((x) => [x.dia, x]));
  return [...new Set([...pDia.keys(), ...sDia.keys()])].sort().map((dia) => {
    const p = pDia.get(dia);
    const s = sDia.get(dia);
    return {
      dia,
      conversasComPaciente: p?.conversasComPaciente ?? 0,
      conversasSemSofia: p?.conversasSemSofia ?? 0,
      mensagensPaciente: p?.mensagensPaciente ?? 0,
      mensagensPacienteVazias: p?.mensagensPacienteVazias ?? 0,
      mensagensSofia: s?.mensagens ?? 0,
      sinais: { repetidas: s?.repetidas ?? 0, vazamento: s?.vazamento ?? 0, falha: s?.falha ?? 0 },
    };
  });
}

/** Identificação mínima + 2 linhas do fim de uma conversa. Nunca devolve telefone inteiro nem sobrenome. */
export async function detalheDaConversa(
  conversationId: string,
  nota: number,
  unidade: string,
): Promise<PiorConversa | null> {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactName: true, phone: true, leadId: true },
  });
  if (!c) return null;
  const msgs = await prisma.$queryRaw<Array<{ role: string; content: string }>>`
    SELECT m.role, m.content
    FROM messages m
    WHERE m.conversation_id = ${conversationId} AND (m.role = 'user' OR ${E_SOFIA}) AND btrim(m.content) <> ''
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 2`;
  const trecho = msgs.reverse().map((m) => `${m.role === 'user' ? 'Paciente' : 'Sofia'}: ${limparTrecho(m.content)}`);
  return { nota, unidade, primeiroNome: primeiroNome(c.contactName), final4: final4(c.phone), leadId: c.leadId, trecho };
}
