/**
 * A faxina do inbox, disparada de fora (o n8n chama isto às 20h).
 *
 * Mora aqui, e não no n8n, porque as credenciais das 19 contas do Kommo já estão neste
 * servidor. Copiá-las pro n8n criaria uma segunda cópia pra manter sincronizada toda vez
 * que um token vencer — e token vencendo em silêncio já nos custou caro antes.
 *
 * SIMULA POR PADRÃO. Quem quiser fechar de verdade tem de mandar `simular: false`
 * explicitamente. Uma chamada distraída não varre o inbox de ninguém.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fecharConversasLidas, type ResultadoFaxina } from '../lib/fechar-conversas.js';
import { levantarNaoLidas } from '../lib/nao-lidas-worker.js';
import { montarAviso } from '../lib/nao-lidas.js';
import { avisarJoao } from '../lib/alerta-whatsapp.js';

export async function faxinaConversasHandler(req: Request, res: Response): Promise<void> {
  const corpo = (req.body ?? {}) as {
    unidades?: unknown;
    simular?: unknown;
    minimoHoras?: unknown;
    maximo?: unknown;
  };

  const pedidas = Array.isArray(corpo.unidades)
    ? corpo.unidades.map((s) => String(s)).filter(Boolean)
    : null;
  // `simular !== false` e não `!!simular`: quem esquecer o campo simula, quem mandar
  // qualquer outra coisa também. Só o `false` literal fecha de verdade.
  const simular = corpo.simular !== false;
  const minimoHoras = Number.isFinite(Number(corpo.minimoHoras)) ? Number(corpo.minimoHoras) : 0;
  const maximo = Number.isFinite(Number(corpo.maximo)) ? Number(corpo.maximo) : undefined;

  const unidades = await prisma.unit.findMany({
    where: pedidas ? { slug: { in: pedidas } } : { kommoAccessToken: { not: null } },
    orderBy: { slug: 'asc' },
  });

  if (pedidas && unidades.length !== pedidas.length) {
    const achadas = new Set(unidades.map((u) => u.slug));
    res.status(404).json({ error: 'unidade_desconhecida', quais: pedidas.filter((s) => !achadas.has(s)) });
    return;
  }

  // Uma conta do Kommo pode abrigar mais de uma unidade nossa (Imperatriz tem quatro).
  // Rodar por unidade fecharia a mesma conversa duas vezes e contaria errado.
  const porConta = new Map<string, (typeof unidades)[number]>();
  for (const u of unidades) {
    const chave = u.kommoSubdomain ?? u.slug;
    if (!porConta.has(chave)) porConta.set(chave, u);
  }

  const resultados: ResultadoFaxina[] = [];
  for (const u of porConta.values()) {
    resultados.push(await fecharConversasLidas(u, { simular, minimoHoras, maximo }));
  }

  const total = resultados.reduce(
    (acc, r) => ({
      abertas: acc.abertas + r.abertas,
      lidas: acc.lidas + r.lidas,
      naoLidas: acc.naoLidas + r.naoLidas,
      fechadas: acc.fechadas + r.fechadas,
      falhas: acc.falhas + r.falhas,
    }),
    { abertas: 0, lidas: 0, naoLidas: 0, fechadas: 0, falhas: 0 },
  );

  logger.info({ simular, contas: porConta.size, ...total }, 'faxina do inbox');
  res.json({ simulado: simular, contas: porConta.size, total, porConta: resultados });
}

/**
 * O aviso das não lidas, sob demanda — pra conferir o texto sem esperar as 8h.
 *
 * Simula por padrão, igual à faxina: devolve o texto e não manda. Só `enviar: true`
 * dispara de verdade, e ainda assim só pro número do João.
 */
export async function avisoNaoLidasHandler(req: Request, res: Response): Promise<void> {
  const enviar = (req.body as { enviar?: unknown } | undefined)?.enviar === true;
  const contas = await levantarNaoLidas();
  const texto = montarAviso(contas);
  let enviado: boolean | null = null;
  if (enviar && texto) enviado = await avisarJoao(texto, `nao-lidas-manual-${Date.now()}`, 0);
  logger.info({ enviar, enviado, contas: contas.length }, 'aviso de não lidas sob demanda');
  res.json({ enviado, texto, contas });
}
