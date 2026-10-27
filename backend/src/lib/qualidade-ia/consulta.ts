/**
 * As consultas do resumo de qualidade da Sofia. SÓ LEITURA, SEM IA: contagem sobre `conversation_evaluations`,
 * `messages` e `conversations`, que o sistema já grava. São 3 consultas por resumo (avaliações, mensagens,
 * contato da pior conversa); as contas em cima delas estão em `agregar.ts` e `texto.ts`.
 *
 * O que é "Sofia falou" (fragmento `E_SOFIA`): mensagem `assistant` que a IA escreveu CONVERSANDO. A lista do que
 * fica de fora (fala da equipe, importação do Kommo, confirmação, cartão de chegada, nota interna, régua,
 * reativação, lembrete) mora em `lib/mensagem-da-ia.ts` e é a MESMA que o alerta "prometeu sem marcar" usa em
 * JavaScript; o teste de SQL confere que as duas respondem igual.
 *
 * O que é "avaliável": a Sofia falou ≥ 1 vez E o paciente escreveu depois da 1ª fala dela — OLHANDO SÓ O QUE
 * EXISTIA QUANDO O JUIZ DEU A NOTA (`created_at <= avaliação`). Sem esse corte, o paciente que sumiu, tirou nota 2
 * e voltou dias depois passaria a contar como avaliável e devolveria à média exatamente as notas "paciente
 * sumiu" que o resumo existe para tirar.
 *
 * Datas: `messages.created_at` e `conversation_evaluations.created_at` são `timestamp` SEM fuso, em UTC (padrão
 * do Prisma). O dia de São Paulo sai de `(col AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo'`. Os limites
 * da janela entram como `timestamptz` explícito convertido para UTC (`utc()`): a consulta não depende do
 * `timezone` da sessão do Postgres (se o banco estiver em America/Sao_Paulo, a janela não anda 3 h).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { MARCA_AUDIO_NAO_OUVIDO } from '../../agent/repeticao.js';
import {
  AUTOR_DA_EQUIPE,
  CHAVES_DE_RETOMADA,
  ORIGENS_AUTOMATICAS,
  ORIGENS_QUE_NAO_SAO_DA_IA,
  PREFIXO_ORIGEM_QUE_NAO_E_DA_IA,
  VIAS_QUE_NAO_SAO_DA_IA,
} from '../mensagem-da-ia.js';
import { inicioDoDia, somarDias } from './dias.js';
import { final4, limparTrecho, primeiroNome } from './privacidade.js';
import { MIN_CARACTERES_REPETIDA, REGEX_CLINICO, REGEX_FALHA_TECNICA, REGEX_NAO_ENTENDI, REGEX_VAZAMENTO } from './sinais.js';
import type { Dia, DiaMensagens, LinhaDeAvaliacao, PiorConversa } from './tipos.js';

/** `meta ->> chave` sem NULL: ausente = ''. */
const meta = (chave: string) => Prisma.sql`coalesce(m.meta->>(${chave}::text), '')`;

/**
 * "A Sofia conversando", em SQL, a partir das MESMAS listas de `mensagem-da-ia.ts`
 * (`mensagemDaSofiaConversando`). A tabela `m` é `messages`.
 */
export const E_SOFIA = Prisma.sql`(
  m.role = 'assistant'
  AND ${meta('origem')} NOT IN (${Prisma.join([...ORIGENS_QUE_NAO_SAO_DA_IA, ...ORIGENS_AUTOMATICAS])})
  AND ${meta('origem')} NOT LIKE ${PREFIXO_ORIGEM_QUE_NAO_E_DA_IA + '%'}
  AND ${meta('autor')} <> ${AUTOR_DA_EQUIPE}
  AND ${meta('via')} NOT IN (${Prisma.join([...VIAS_QUE_NAO_SAO_DA_IA])})
  AND ${Prisma.join(
    CHAVES_DE_RETOMADA.map((k) => Prisma.sql`coalesce(m.meta->(${k}::text), 'null'::jsonb) = 'null'::jsonb`),
    ' AND ',
  )}
)`;

/** Dia de São Paulo (date) de uma coluna `timestamp` em UTC. */
const diaSP = (col: Prisma.Sql) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date`;

/** Instante → `timestamp` em UTC, igual ao das colunas, sem depender do fuso da sessão. */
const utc = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

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
              WHERE p.conversation_id = e.conversation_id AND p.role = 'user'
                AND p.created_at > s.primeira_sofia AND p.created_at <= e.created_at
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
      WHERE m.conversation_id = e.conversation_id AND m.created_at <= e.created_at AND ${E_SOFIA}
    ) s ON true
    WHERE e.created_at >= ${utc(ini)} AND e.created_at < ${utc(fim)}
    ORDER BY e.created_at DESC`;
  return rows.map((r) => ({ ...r, nota: Number(r.nota) }));
}

/** Conversas, mensagens vazias e sinais objetivos de erro, por dia da MENSAGEM. */
export async function mensagensPorDia(de: Dia, ate: Dia): Promise<DiaMensagens[]> {
  const { ini, fim } = janela(de, ate);

  // Início e fim do dia de São Paulo (de cada linha `pac.dia`), como `timestamp` em UTC.
  const inicioDoDiaSP = Prisma.sql`(((pac.dia)::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC')`;
  const fimDoDiaSP = Prisma.sql`(((pac.dia + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'UTC')`;

  const pacientes = await prisma.$queryRaw<
    Array<{ dia: string; conversasComPaciente: number; conversasSemSofia: number; mensagensPaciente: number; mensagensPacienteVazias: number }>
  >`
    WITH pac AS (
      SELECT ${diaSP(Prisma.sql`m.created_at`)} AS dia,
             m.conversation_id,
             count(*) AS msgs,
             count(*) FILTER (WHERE btrim(m.content) = '' OR m.content LIKE ${MARCA_AUDIO_NAO_OUVIDO + '%'}) AS vazias
      FROM messages m
      WHERE m.role = 'user' AND m.created_at >= ${utc(ini)} AND m.created_at < ${utc(fim)}
      GROUP BY 1, 2
    )
    SELECT to_char(pac.dia, 'YYYY-MM-DD') AS dia,
           count(*)::int AS "conversasComPaciente",
           count(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = pac.conversation_id AND ${E_SOFIA}
               AND m.created_at >= ${inicioDoDiaSP} AND m.created_at < ${fimDoDiaSP}
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
      WHERE ${E_SOFIA} AND m.created_at >= ${utc(antes)} AND m.created_at < ${utc(fim)}
    )
    SELECT to_char(${diaSP(Prisma.sql`s.created_at`)}, 'YYYY-MM-DD') AS dia,
           count(*)::int AS mensagens,
           count(*) FILTER (WHERE s.anterior IS NOT NULL
                              AND length(btrim(s.content)) >= ${MIN_CARACTERES_REPETIDA}
                              AND btrim(s.content) = btrim(s.anterior))::int AS repetidas,
           count(*) FILTER (WHERE s.content ~* ${REGEX_VAZAMENTO})::int AS vazamento,
           count(*) FILTER (WHERE s.content ~* ${REGEX_FALHA_TECNICA}
                              OR (s.content ~* ${REGEX_NAO_ENTENDI} AND s.content !~* ${REGEX_CLINICO}))::int AS falha
    FROM s
    WHERE s.created_at >= ${utc(ini)}
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
