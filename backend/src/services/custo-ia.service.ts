import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { UsoIa } from '../lib/relatorio-mensal-rede.js';

/**
 * Uso e custo da IA por CONTA Kommo (uma clínica = uma conta; a IA de resgate e as unidades irmãs
 * `*-resgate`, `*-financeiro`, `*-tratamento` dividem a conta e entram somadas).
 *
 * SÓ LEITURA. Soma `llm_calls` num intervalo. O mês é medido no horário de Brasília (UTC−3), igual ao relatório.
 * O uso vem de `response_body.llmOutput.usage`; chamada sem esse bloco conta em `chamadas` e `registradoUsd`
 * mas não em tokens.
 */
export interface UsoPorConta extends UsoIa {
  conta: string;
  slugs: string[];
}

const n = Prisma.sql;

export async function usoDaIaPorConta(de: string, ate: string): Promise<UsoPorConta[]> {
  // [de 00:00, ate+1 00:00) em Brasília = [de 03:00Z, ate+1 03:00Z) em UTC
  const ini = new Date(`${de}T03:00:00.000Z`);
  const fim = new Date(new Date(`${ate}T03:00:00.000Z`).getTime() + 86_400_000);
  const u = (campo: string) => n`COALESCE((c.response_body->'llmOutput'->'usage'->>${campo})::numeric, 0)`;
  const linhas = await prisma.$queryRaw<
    Array<{ conta: string; slugs: string[]; chamadas: number; registrado: number; entrada: number; saida: number; leitura: number; gravado_total: number; g5m: number; g1h: number }>
  >(n`
    SELECT COALESCE(un.kommo_subdomain, un.slug, '(sem unidade)') AS conta,
           ARRAY_AGG(DISTINCT un.slug) FILTER (WHERE un.slug IS NOT NULL) AS slugs,
           COUNT(*)::int AS chamadas,
           COALESCE(SUM(c.cost_usd), 0)::float AS registrado,
           SUM(${u('input_tokens')})::float AS entrada,
           SUM(${u('output_tokens')})::float AS saida,
           SUM(${u('cache_read_input_tokens')})::float AS leitura,
           SUM(${u('cache_creation_input_tokens')})::float AS gravado_total,
           SUM(COALESCE((c.response_body->'llmOutput'->'usage'->'cache_creation'->>'ephemeral_5m_input_tokens')::numeric, 0))::float AS g5m,
           SUM(COALESCE((c.response_body->'llmOutput'->'usage'->'cache_creation'->>'ephemeral_1h_input_tokens')::numeric, 0))::float AS g1h
      FROM llm_calls c
      LEFT JOIN units un ON un.id = c.unit_id
     WHERE c.created_at >= ${ini} AND c.created_at < ${fim}
     GROUP BY 1
     ORDER BY 1`);
  return linhas.map((l) => {
    // gravação de cache sem o detalhe 5m/1h (uso antigo): o que sobrou do total é cobrado como 5 min
    const resto = Math.max(0, l.gravado_total - l.g5m - l.g1h);
    return {
      conta: l.conta,
      slugs: l.slugs ?? [],
      chamadas: l.chamadas,
      registradoUsd: l.registrado,
      entrada: l.entrada,
      saida: l.saida,
      cacheLeitura: l.leitura,
      cache5m: l.g5m + resto,
      cache1h: l.g1h,
    };
  });
}
