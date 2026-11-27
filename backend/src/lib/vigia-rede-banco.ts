/**
 * Vigia da rede — a parte que toca no mundo: lê o banco (llm_calls, messages, conversations, units), guarda o estado
 * (`vigia_alertas`) e manda o aviso para o Telegram PESSOAL do João. As decisões estão em `vigia-rede.ts`.
 *
 * Destino do aviso: `enviarTelegram(texto, { canal: 'avisos' })`, sem `chat` → cai no chat do João
 * (TELEGRAM_CHAT_JOAO / CHAT_JOAO_PADRAO), o mesmo dos avisos do Asaas. Nunca grupo, nunca e-mail/alertrelay.
 *
 * Quem roda: só o líder (`worker-lease`), de 5 em 5 min. Desligar: `VIGIA_REDE_DESLIGADO=1`.
 *
 * Datas: `llm_calls.created_at` e `messages.created_at` são `timestamp` SEM fuso, gravados em UTC, e o banco roda com
 * fuso America/Sao_Paulo — comparar com `now()` desloca a janela em 3 h. Por isso toda janela aqui parte de um
 * instante recebido como ISO com `Z` e convertido para UTC sem fuso (`(…::timestamptz AT TIME ZONE 'UTC')`).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { enviarTelegram, type OpcoesTelegram } from './telegram.js';
import { FALLBACK_INDISPONIVEL } from '../agent/llm-policy.js';
import {
  rodarVigia,
  type EstadoAlerta,
  type EstadoStore,
  type Familia,
  type Frases,
  type GrupoDeErro,
  type Leitura,
  type TotaisDaFamilia,
} from './vigia-rede.js';

/**
 * O Joaoof grava as chamadas dele em `llm_calls` (endpoint `joaoof.*`, `unit_id` nulo). Elas NÃO são a IA da rede: uma chamada boa dele não pode
 * esconder «IA parada», uma sem crédito na chave DELE não pode abrir alarme para a rede, e uma boa não pode fechar um «sem crédito» da rede.
 * Toda consulta ao `llm_calls` aqui (e em taxa-erro-worker e saude-externa) filtra `coalesce(c.endpoint, '') NOT LIKE 'joaoof.%'`; um teste trava as três.
 */

export const VIGIA_TICK_MS = Number(process.env.VIGIA_REDE_TICK_MS) || 5 * 60_000;
/** O começo da frase de queda: o texto pode ganhar um enfeite depois, o começo não muda. */
export const PREFIXO_DA_FRASE = FALLBACK_INDISPONIVEL.slice(0, 40);

/** Instante `agora` como timestamp UTC sem fuso, comparável com as colunas `created_at`. */
const utc = (agora: Date) => agora.toISOString();

export function criarLeituraDoBanco(): Leitura {
  return {
    async errosAgrupados(agora: Date, janelaMin: number): Promise<GrupoDeErro[]> {
      const rows = await prisma.$queryRaw<
        Array<{ claude: boolean; mensagem: string; chamadas: number; unidades: string[]; primeiro: Date; ultimo: Date }>
      >`
        WITH t AS (SELECT (${utc(agora)}::timestamptz AT TIME ZONE 'UTC') AS agora)
        SELECT (c.model ILIKE 'claude%') AS claude,
               left(coalesce(c.error_message, ''), 200) AS mensagem,
               count(*)::int AS chamadas,
               coalesce(array_agg(DISTINCT u.name) FILTER (WHERE u.name IS NOT NULL), '{}') AS unidades,
               min(c.created_at) AS primeiro,
               max(c.created_at) AS ultimo
          FROM llm_calls c
          CROSS JOIN t
          LEFT JOIN units u ON u.id = c.unit_id
         WHERE c.status = 'error'
           AND coalesce(c.endpoint, '') NOT LIKE 'joaoof.%'
           AND c.created_at >= t.agora - (${janelaMin}::int * interval '1 minute')
           AND c.created_at <= t.agora
           AND c.model !~* '^(models/)?(gemini|gemma)'
           AND c.provider NOT LIKE '%-reserva'
         GROUP BY 1, 2`;
      return rows.map((r) => ({
        familia: r.claude ? 'anthropic' : 'openai',
        mensagem: r.mensagem,
        chamadas: r.chamadas,
        unidades: r.unidades ?? [],
        primeiro: r.primeiro,
        ultimo: r.ultimo,
      }));
    },

    async totaisPorFamilia(agora: Date, janelaMin: number): Promise<Record<Familia, TotaisDaFamilia>> {
      const rows = await prisma.$queryRaw<Array<{ claude: boolean; ok: number; erro: number }>>`
        WITH t AS (SELECT (${utc(agora)}::timestamptz AT TIME ZONE 'UTC') AS agora)
        SELECT (c.model ILIKE 'claude%') AS claude,
               (count(*) FILTER (WHERE c.status = 'success'))::int AS ok,
               (count(*) FILTER (WHERE c.status = 'error'))::int AS erro
          FROM llm_calls c
          CROSS JOIN t
         WHERE coalesce(c.endpoint, '') NOT LIKE 'joaoof.%'
           AND c.created_at >= t.agora - (${janelaMin}::int * interval '1 minute')
           AND c.created_at <= t.agora
           AND c.model !~* '^(models/)?(gemini|gemma)'
           AND c.provider NOT LIKE '%-reserva'
         GROUP BY 1`;
      const out: Record<Familia, TotaisDaFamilia> = { anthropic: { ok: 0, erro: 0 }, openai: { ok: 0, erro: 0 } };
      for (const r of rows) out[r.claude ? 'anthropic' : 'openai'] = { ok: r.ok, erro: r.erro };
      return out;
    },

    async ultimoSucesso(agora: Date): Promise<Record<Familia, Date | null>> {
      const rows = await prisma.$queryRaw<Array<{ claude: boolean; ultimo: Date | null }>>`
        WITH t AS (SELECT (${utc(agora)}::timestamptz AT TIME ZONE 'UTC') AS agora)
        SELECT (c.model ILIKE 'claude%') AS claude, max(c.created_at) AS ultimo
          FROM llm_calls c
          CROSS JOIN t
         WHERE c.status = 'success'
           AND coalesce(c.endpoint, '') NOT LIKE 'joaoof.%'
           AND c.created_at >= t.agora - interval '24 hours'
           AND c.created_at <= t.agora
           AND c.model !~* '^(models/)?(gemini|gemma)'
           AND c.provider NOT LIKE '%-reserva'
         GROUP BY 1`;
      const out: Record<Familia, Date | null> = { anthropic: null, openai: null };
      for (const r of rows) out[r.claude ? 'anthropic' : 'openai'] = r.ultimo;
      return out;
    },

    async baselineSucessos(agora: Date, janelaMin: number, semanas: number): Promise<number[]> {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        WITH t AS (SELECT (${utc(agora)}::timestamptz AT TIME ZONE 'UTC') AS agora)
        SELECT (SELECT count(*)::int
                  FROM llm_calls c
                 WHERE c.status = 'success'
                   AND coalesce(c.endpoint, '') NOT LIKE 'joaoof.%'
                   AND c.created_at >= t.agora - (g.d * interval '7 days') - (${janelaMin}::int * interval '1 minute')
                   AND c.created_at < t.agora - (g.d * interval '7 days')) AS n
          FROM t, generate_series(1, ${semanas}::int) AS g(d)`;
      return rows.map((r) => r.n);
    },

    async frases(agora: Date, janelaMin: number): Promise<Frases> {
      const rows = await prisma.$queryRaw<Array<{ mensagens: number; conversas: number; unidades: string[] }>>`
        WITH t AS (SELECT (${utc(agora)}::timestamptz AT TIME ZONE 'UTC') AS agora)
        SELECT count(*)::int AS mensagens,
               count(DISTINCT m.conversation_id)::int AS conversas,
               coalesce(array_agg(DISTINCT u.name) FILTER (WHERE u.name IS NOT NULL), '{}') AS unidades
          FROM messages m
          CROSS JOIN t
          JOIN conversations c ON c.id = m.conversation_id
          LEFT JOIN units u ON u.id = c.unit_id
         WHERE m.role = 'assistant'
           AND m.created_at >= t.agora - (${janelaMin}::int * interval '1 minute')
           AND m.created_at <= t.agora
           AND left(m.content, ${PREFIXO_DA_FRASE.length}::int) = ${PREFIXO_DA_FRASE}`;
      const r = rows[0];
      return { mensagens: r?.mensagens ?? 0, conversas: r?.conversas ?? 0, unidades: r?.unidades ?? [] };
    },
  };
}

export function criarStoreDoBanco(): EstadoStore {
  return {
    async listar(): Promise<EstadoAlerta[]> {
      const rows = await prisma.vigiaAlerta.findMany();
      return rows.map((r) => ({
        chave: r.chave,
        abertoEm: r.abertoEm,
        ultimoVistoEm: r.ultimoVistoEm,
        ultimoAvisoEm: r.ultimoAvisoEm,
        lembretes: r.lembretes,
        resolvidoEm: r.resolvidoEm,
      }));
    },
    async abrir(chave, abertoEm, vistoEm) {
      // upsert: reabrir uma chave já resolvida zera o ciclo (novo aviso, lembretes de volta a 0)
      await prisma.vigiaAlerta.upsert({
        where: { chave },
        create: { chave, abertoEm, ultimoVistoEm: vistoEm },
        update: { abertoEm, ultimoVistoEm: vistoEm, ultimoAvisoEm: null, lembretes: 0, resolvidoEm: null },
      });
    },
    async visto(chave, vistoEm) {
      await prisma.vigiaAlerta.updateMany({ where: { chave, resolvidoEm: null }, data: { ultimoVistoEm: vistoEm } });
    },
    async avisou(chave, quando, lembrete) {
      await prisma.vigiaAlerta.update({
        where: { chave },
        data: { ultimoAvisoEm: quando, ...(lembrete ? { lembretes: { increment: 1 } } : {}) },
      });
    },
    async fechar(chave, quando) {
      await prisma.vigiaAlerta.updateMany({ where: { chave, resolvidoEm: null }, data: { resolvidoEm: quando } });
    },
  };
}

/**
 * O ÚNICO caminho de saída do vigia. Sem `chat` e no canal `avisos`: o aviso vai para o chat do João, o mesmo dos avisos
 * do Asaas. O teste trava isto (um chat diferente, um canal diferente ou o relay de e-mail quebram a suíte).
 */
export function enviarAvisoDoVigia(texto: string, opcoes: Pick<OpcoesTelegram, 'env' | 'fetch'> = {}): Promise<boolean> {
  return enviarTelegram(texto, { canal: 'avisos', ...opcoes });
}

// ---------------------------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------------------------
let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

export async function varrerOVigia(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const avisos = await rodarVigia({
      leitura: criarLeituraDoBanco(),
      store: criarStoreDoBanco(),
      enviar: (t) => enviarAvisoDoVigia(t),
    });
    for (const a of avisos) (a.erro ? logger.warn : logger.info).call(logger, { chave: a.chave, acao: a.acao, entregue: a.entregue, erro: a.erro }, 'vigia-rede: aviso');
  } catch (err) {
    // Se a leitura falha, o estado não muda: o próximo tick refaz tudo.
    logger.warn({ err: String(err) }, 'vigia-rede: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startVigiaRedeWorker(): void {
  if (process.env.VIGIA_REDE_DESLIGADO === '1') {
    logger.info('vigia-rede: DESLIGADO por VIGIA_REDE_DESLIGADO=1');
    return;
  }
  if (timer) return;
  // A primeira passada espera 30 s: o deploy acabou de subir e o banco/Prisma ainda estão aquecendo.
  primeira = setTimeout(() => void varrerOVigia(), 30_000);
  primeira.unref?.();
  timer = setInterval(() => void varrerOVigia(), VIGIA_TICK_MS);
  timer.unref?.();
  logger.info({ tickMs: VIGIA_TICK_MS }, 'vigia-rede: ligado (aviso no Telegram do João)');
}

export function stopVigiaRedeWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
