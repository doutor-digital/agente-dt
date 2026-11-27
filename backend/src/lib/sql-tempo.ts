import { Prisma } from '@prisma/client';

/**
 * "Agora" para comparar com colunas `timestamp without time zone` gravadas pelo Prisma.
 *
 * O PROBLEMA (auditoria de 27/11): o Prisma grava `created_at` em UTC, em `timestamp` SEM fuso, mas a sessão do
 * banco roda em `America/Sao_Paulo`. `now()` devolve `timestamptz`; ao comparar com `timestamp`, o Postgres converte
 * o valor da COLUNA (UTC puro) como se fosse hora de São Paulo. O efeito é um deslocamento de 3 h: o que a consulta
 * chama de "últimos 30 minutos" cobre 3h30. Medido em produção: 1.965 linhas contra 247 corretas em `llm_calls` (8x).
 *
 * A SAÍDA: `now() AT TIME ZONE 'utc'` devolve um `timestamp` já em UTC, do mesmo "relógio" que o Prisma grava,
 * e a comparação passa a ser timestamp × timestamp, sem conversão de fuso nenhuma — qualquer que seja o `TimeZone`
 * da sessão. Foi preferido a mudar o fuso da conexão (`options=-c timezone=UTC`) porque isso alteraria o significado
 * de tudo que hoje depende de `now()`/`CURRENT_DATE` em hora local (ver docs/fuso-agente-dt.md).
 *
 * USE em qualquer SQL cru que compare uma coluna `timestamp` do agente_dt com "agora". NÃO use em coluna
 * `timestamptz` (aí o `now()` puro já está certo) nem em coluna gravada pelo próprio `now()` do banco
 * (ex.: `worker_leases`, onde os dois lados são hora local e se compensam).
 */
export const AGORA_UTC = "(now() at time zone 'utc')";

/** Mesma coisa, para `prisma.$queryRaw\`...\`` (template tagged). */
export const agoraUtcSql = Prisma.raw(AGORA_UTC);
