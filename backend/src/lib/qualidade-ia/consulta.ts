/**
 * As consultas do resumo de qualidade da Sofia. SÓ LEITURA, SEM IA: tudo é contagem sobre
 * `conversation_evaluations`, `messages` e `conversations` que o sistema já grava.
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
import type {
  Dia,
  DiaAvaliado,
  DiaMensagens,
  FaixaDeNota,
  PiorConversa,
  UnidadeNota,
} from './tipos.js';

/** Nota abaixo disto = faixa baixa; de FAIXA_ALTA_DE para cima = faixa alta; o meio é a média. */
export const FAIXA_BAIXA_ATE = 5;
export const FAIXA_ALTA_DE = 7;

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

/** Uma linha por avaliação do período, com os dois fatos que decidem se ela mede a Sofia. */
function baseAvaliacoes(ini: Date, fim: Date): Prisma.Sql {
  return Prisma.sql`(
    SELECT e.id, e.conversation_id, e.unit_id, e.overall_score, e.created_at,
           ${diaSP(Prisma.sql`e.created_at`)} AS dia,
           s.primeira_sofia,
           (s.primeira_sofia IS NOT NULL AND EXISTS (
              SELECT 1 FROM messages u
              WHERE u.conversation_id = e.conversation_id AND u.role = 'user' AND u.created_at > s.primeira_sofia
           )) AS respondeu
    FROM conversation_evaluations e
    LEFT JOIN LATERAL (
      SELECT min(m.created_at) AS primeira_sofia
      FROM messages m
      WHERE m.conversation_id = e.conversation_id AND ${E_SOFIA}
    ) s ON true
    WHERE e.created_at >= ${ini} AND e.created_at < ${fim}
  )`;
}

const AVALIAVEL = Prisma.sql`(b.primeira_sofia IS NOT NULL AND b.respondeu)`;

/** Intervalo [ini, fim) em UTC que cobre os dias de `de` a `ate` (inclusive). */
export function janela(de: Dia, ate: Dia): { ini: Date; fim: Date } {
  return { ini: inicioDoDia(de), fim: inicioDoDia(somarDias(ate, 1)) };
}

export async function avaliacoesPorDia(de: Dia, ate: Dia): Promise<DiaAvaliado[]> {
  const { ini, fim } = janela(de, ate);
  const rows = await prisma.$queryRaw<
    Array<{ dia: string; total: number; semSofia: number; sumiu: number; avaliaveis: number; mediaAvaliaveis: number | null }>
  >`
    SELECT to_char(b.dia, 'YYYY-MM-DD') AS dia,
           count(*)::int AS total,
           count(*) FILTER (WHERE b.primeira_sofia IS NULL)::int AS "semSofia",
           count(*) FILTER (WHERE b.primeira_sofia IS NOT NULL AND NOT b.respondeu)::int AS sumiu,
           count(*) FILTER (WHERE ${AVALIAVEL})::int AS avaliaveis,
           (avg(b.overall_score) FILTER (WHERE ${AVALIAVEL}))::float8 AS "mediaAvaliaveis"
    FROM ${baseAvaliacoes(ini, fim)} b
    GROUP BY b.dia
    ORDER BY b.dia`;
  return rows.map((r) => ({ ...r, mediaAvaliaveis: r.mediaAvaliaveis === null ? null : Number(r.mediaAvaliaveis) }));
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
  const sinais = await prisma.$queryRaw<Array<{ dia: string; repetidas: number; vazamento: number; falha: number }>>`
    WITH s AS (
      SELECT m.conversation_id, m.content, m.created_at,
             lag(m.content) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS anterior
      FROM messages m
      WHERE ${E_SOFIA} AND m.created_at >= ${antes} AND m.created_at < ${fim}
    )
    SELECT to_char(${diaSP(Prisma.sql`s.created_at`)}, 'YYYY-MM-DD') AS dia,
           count(*) FILTER (WHERE s.anterior IS NOT NULL
                              AND length(btrim(s.content)) >= ${MIN_CARACTERES_REPETIDA}
                              AND btrim(s.content) = btrim(s.anterior))::int AS repetidas,
           count(*) FILTER (WHERE s.content ~* ${REGEX_VAZAMENTO})::int AS vazamento,
           count(*) FILTER (WHERE s.content ~* ${REGEX_FALHA})::int AS falha
    FROM s
    WHERE s.created_at >= ${ini}
    GROUP BY 1
    ORDER BY 1`;

  const porDia = new Map(sinais.map((x) => [x.dia, x]));
  const dias = new Set([...pacientes.map((p) => p.dia), ...sinais.map((x) => x.dia)]);
  const pDia = new Map(pacientes.map((p) => [p.dia, p]));
  return [...dias].sort().map((dia) => {
    const p = pDia.get(dia);
    const s = porDia.get(dia);
    return {
      dia,
      conversasComPaciente: p?.conversasComPaciente ?? 0,
      conversasSemSofia: p?.conversasSemSofia ?? 0,
      mensagensPaciente: p?.mensagensPaciente ?? 0,
      mensagensPacienteVazias: p?.mensagensPacienteVazias ?? 0,
      sinais: { repetidas: s?.repetidas ?? 0, vazamento: s?.vazamento ?? 0, falha: s?.falha ?? 0 },
    };
  });
}

/** As unidades de menor nota entre as avaliáveis do período, ignorando as com poucas conversas. */
export async function unidadesPiores(de: Dia, ate: Dia, minimo: number, quantas = 3): Promise<UnidadeNota[]> {
  const { ini, fim } = janela(de, ate);
  const rows = await prisma.$queryRaw<Array<{ nome: string; avaliaveis: number; media: number }>>`
    SELECT u.name AS nome, count(*)::int AS avaliaveis, (avg(b.overall_score))::float8 AS media
    FROM ${baseAvaliacoes(ini, fim)} b
    JOIN units u ON u.id = b.unit_id
    WHERE ${AVALIAVEL}
    GROUP BY u.id, u.name
    HAVING count(*) >= ${minimo}
    ORDER BY avg(b.overall_score) ASC, count(*) DESC
    LIMIT ${quantas}`;
  return rows.map((r) => ({ nome: r.nome, avaliaveis: r.avaliaveis, media: Number(r.media) }));
}

/** Faixas de nota (só avaliáveis) com quantas viraram Ganho e quantas têm consulta marcada na franquia. */
export async function faixasDeNota(de: Dia, ate: Dia): Promise<FaixaDeNota[]> {
  const { ini, fim } = janela(de, ate);
  const rows = await prisma.$queryRaw<Array<{ faixa: FaixaDeNota['faixa']; conversas: number; ganhos: number; comConsulta: number }>>`
    SELECT CASE WHEN b.overall_score < ${FAIXA_BAIXA_ATE} THEN 'baixa'
                WHEN b.overall_score < ${FAIXA_ALTA_DE} THEN 'media'
                ELSE 'alta' END AS faixa,
           count(*)::int AS conversas,
           count(*) FILTER (WHERE c.converted_at IS NOT NULL)::int AS ganhos,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM spine_lead_links l
             WHERE l.unit_id = c.unit_id AND l.kommo_lead_id::text = c.lead_id AND l.spine_id_schedule IS NOT NULL
           ))::int AS "comConsulta"
    FROM ${baseAvaliacoes(ini, fim)} b
    JOIN conversations c ON c.id = b.conversation_id
    WHERE ${AVALIAVEL}
    GROUP BY 1`;
  const ordem: FaixaDeNota['faixa'][] = ['baixa', 'media', 'alta'];
  return ordem.map((f) => rows.find((r) => r.faixa === f) ?? { faixa: f, conversas: 0, ganhos: 0, comConsulta: 0 });
}

/** A avaliável de menor nota do período, com 2 linhas do fim da conversa. Nunca devolve telefone inteiro. */
export async function piorConversa(de: Dia, ate: Dia): Promise<PiorConversa | null> {
  const { ini, fim } = janela(de, ate);
  const linhas = await prisma.$queryRaw<
    Array<{ id: string; nota: number; unidade: string; contato: string | null; telefone: string | null; leadId: string }>
  >`
    SELECT c.id, b.overall_score::float8 AS nota, u.name AS unidade,
           c.contact_name AS contato, c.phone AS telefone, c.lead_id AS "leadId"
    FROM ${baseAvaliacoes(ini, fim)} b
    JOIN conversations c ON c.id = b.conversation_id
    JOIN units u ON u.id = b.unit_id
    WHERE ${AVALIAVEL}
    ORDER BY b.overall_score ASC, b.created_at DESC
    LIMIT 1`;
  const r = linhas[0];
  if (!r) return null;

  const msgs = await prisma.$queryRaw<Array<{ role: string; content: string }>>`
    SELECT m.role, m.content
    FROM messages m
    WHERE m.conversation_id = ${r.id} AND (m.role = 'user' OR ${E_SOFIA}) AND btrim(m.content) <> ''
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 2`;
  const trecho = msgs
    .reverse()
    .map((m) => `${m.role === 'user' ? 'Paciente' : 'Sofia'}: ${limparTrecho(m.content)}`);

  return {
    nota: Number(r.nota),
    unidade: r.unidade,
    primeiroNome: primeiroNome(r.contato),
    final4: final4(r.telefone),
    leadId: r.leadId,
    trecho,
  };
}
