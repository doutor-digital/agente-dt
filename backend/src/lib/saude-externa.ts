import { prisma } from './prisma.js';
import { decidirSaude, type LinhaDoProvedor, type Saude } from './watchdog-decisao.js';
import { filtrosSql } from './causa-erro-ia.js';

/**
 * Saúde da IA para o vigia EXTERNO (`GET /api/health/ia`, consultado do GitHub Actions a cada 10 min).
 *
 * BARATO: UMA consulta em `llm_calls`, só pelo índice de `created_at`, sobre a última hora (centenas de linhas), e o
 * resultado fica 15 s em memória (vigia, painel ou curioso batendo à vontade não multiplica a carga no banco).
 *
 * SEM DADO SENSÍVEL: só contagens e o nome do provedor. Nada de slug de unidade, texto de erro, telefone ou lead.
 * A causa (crédito, chave, limite, indisponível) é lida AQUI da mensagem de erro e sai como uma palavra.
 *
 * O FUSO: `created_at` é `timestamp` UTC sem fuso e a sessão do banco é America/Sao_Paulo. Por isso a janela é
 * `(now() at time zone 'utc') - interval`, nunca `now() - interval` (que cobriria 3h a mais).
 *
 * A causa vem de `lib/causa-erro-ia.ts` (a mesma regra em JS e em SQL); ordem importa: «429 … no credits remaining» é
 * crédito, não limite.
 */

const JANELA_MIN = 10;
const CONSULTA_MIN = 60;
const CACHE_MS = 15_000;


interface Linha {
  provider: string | null;
  rede: number;
  total: number;
  erros: number;
  unidades: number;
  erros_credito: number;
  erros_chave: number;
  erros_limite: number;
  erros_indisponivel: number;
  ultimo_sucesso: Date | null;
}

export interface RespostaDeSaude {
  estado: Saude['estado'];
  causa: Saude['causa'];
  motivo: string;
  janelaMin: number;
  chamadas: number;
  erros: number;
  taxaErro: number;
  provedores: Array<{ nome: string; chamadas: number; erros: number; taxaErro: number }>;
  /** Minutos desde a última chamada que deu certo (null = nenhuma na última hora). */
  ultimoSucessoMinAtras: number | null;
  geradoEm: string;
}

const F = filtrosSql('c.error_message');

/** A consulta. Exportada para o teste contra Postgres de verdade; as regexes são constantes do arquivo, sem entrada de usuário. */
export const SQL_DA_SAUDE = `
  select c.provider as provider,
         grouping(c.provider)::int as rede,
         count(*) filter (where c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as total,
         count(*) filter (where c.status = 'error' and c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as erros,
         count(distinct c.unit_id) filter (where c.status = 'error' and c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as unidades,
         count(*) filter (where c.status = 'error' and ${F.credito} and c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as erros_credito,
         count(*) filter (where c.status = 'error' and ${F.autenticacao} and c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as erros_chave,
         count(*) filter (where c.status = 'error' and ${F.limite} and c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as erros_limite,
         count(*) filter (where c.status = 'error' and ${F.indisponivel} and c.created_at > (now() at time zone 'utc') - interval '${JANELA_MIN} minutes')::int as erros_indisponivel,
         max(c.created_at) filter (where c.status = 'success') as ultimo_sucesso
    from llm_calls c
   where c.created_at > (now() at time zone 'utc') - interval '${CONSULTA_MIN} minutes'
   group by rollup (c.provider)
`;

/** PURA: linhas do banco → resposta. `agoraMs` é o relógio do processo (o `timestamp` do banco é UTC, como o `Date` do Prisma). */
export function montarResposta(linhas: Linha[], agoraMs: number): RespostaDeSaude {
  const min = (d: Date | null) => (d ? Math.max(0, Math.round((agoraMs - new Date(d).getTime()) / 60_000)) : null);
  const paraLinha = (l: Linha): LinhaDoProvedor => ({
    escopo: l.rede ? 'rede' : (l.provider ?? '?'),
    total: Number(l.total),
    erros: Number(l.erros),
    unidadesComErro: Number(l.unidades),
    errosCredito: Number(l.erros_credito),
    errosChave: Number(l.erros_chave),
    errosLimite: Number(l.erros_limite),
    errosIndisponivel: Number(l.erros_indisponivel),
    minutosSemSucesso: min(l.ultimo_sucesso),
  });
  const todas = linhas.map(paraLinha);
  const saude = decidirSaude(todas);
  const rede = todas.find((l) => l.escopo === 'rede');
  const t = (l: { total: number; erros: number }) => (l.total > 0 ? Math.round((l.erros / l.total) * 1000) / 1000 : 0);
  return {
    estado: saude.estado,
    causa: saude.causa,
    motivo: saude.estado === 'ok' && !rede?.total ? 'sem chamadas na janela (silêncio não é queda)' : saude.motivo,
    janelaMin: JANELA_MIN,
    chamadas: rede?.total ?? 0,
    erros: rede?.erros ?? 0,
    taxaErro: rede ? t(rede) : 0,
    provedores: todas.filter((l) => l.escopo !== 'rede' && l.total > 0).map((l) => ({ nome: l.escopo, chamadas: l.total, erros: l.erros, taxaErro: t(l) })),
    ultimoSucessoMinAtras: rede?.minutosSemSucesso ?? null,
    geradoEm: new Date(agoraMs).toISOString(),
  };
}

let guardada: { em: number; resposta: RespostaDeSaude } | null = null;

export async function consultarSaude(agora: number = Date.now()): Promise<RespostaDeSaude> {
  if (guardada && agora - guardada.em < CACHE_MS) return guardada.resposta;
  const linhas = await prisma.$queryRawUnsafe<Linha[]>(SQL_DA_SAUDE);
  const resposta = montarResposta(linhas, agora);
  guardada = { em: agora, resposta };
  return resposta;
}

/** Para teste: esquece o cache. */
export function esquecerSaudeGuardada(): void {
  guardada = null;
}
