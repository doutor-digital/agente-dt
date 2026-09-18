/**
 * Vigia diário da qualidade dos números de WhatsApp.
 *
 * A Meta nota cada número (GREEN / YELLOW / RED) e dá um teto de envio por dia.
 * Quando a nota cai, o bloqueio vem atrás — e número bloqueado deixa a unidade
 * MUDA no WhatsApp sem ninguém entender por quê. Hoje isso só se descobre pelo
 * efeito: "os pacientes pararam de responder".
 *
 * Só varre unidade que tem credencial da Meta gravada. Hoje é uma (Mossoró);
 * cada unidade nova que o João atribuir entra sozinha, sem mexer aqui.
 *
 * Nesta versão o alerta sai enquanto a nota não for GREEN, com trava de 12 h por
 * unidade — não guarda a leitura anterior. Isso perde "voltou ao normal" e
 * "o teto caiu com a cor igual", mas não pede migração de banco. `piorou()` e
 * `melhorou()` já existem em `qualidade-do-numero.ts` pra quando valer a pena
 * guardar o histórico.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { avisarJoao } from './alerta-whatsapp.js';
import { credenciaisDaUnidade } from './whatsapp-meta.js';
import { normalizarQualidade, piorou, textoDoAlerta } from './qualidade-do-numero.js';

const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const VERSAO = process.env.META_GRAPH_VERSION || 'v23.0';
const SWEEP_MS = Number(process.env.QUALIDADE_NUMERO_SWEEP_MS) || 24 * 60 * 60_000;
const ATRASO_INICIAL_MS = Number(process.env.QUALIDADE_NUMERO_DELAY_MS) || 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

export async function varrerQualidadeDosNumeros(): Promise<{ lidas: number; alertas: number }> {
  const unidades = await prisma.unit.findMany({
    where: { isActive: true, metaPhoneNumberId: { not: null }, metaAccessToken: { not: null } },
  });

  let lidas = 0;
  let alertas = 0;
  for (const unit of unidades) {
    const cred = credenciaisDaUnidade(unit);
    if (!cred) continue;
    try {
      const r = await fetch(
        `${GRAPH}/${VERSAO}/${cred.phoneNumberId}?fields=display_phone_number,quality_rating,messaging_limit_tier`,
        { headers: { Authorization: `Bearer ${cred.token}` } },
      );
      const d = (await r.json()) as {
        display_phone_number?: string;
        quality_rating?: string;
        messaging_limit_tier?: string;
        error?: unknown;
      };
      if (!r.ok || d.error) {
        logger.warn({ unit: unit.slug, erro: d.error }, 'qualidade-numero: Meta recusou a leitura');
        continue;
      }
      lidas += 1;
      const agora = {
        qualidade: normalizarQualidade(d.quality_rating),
        limite: d.messaging_limit_tier ?? null,
      };
      logger.info({ unit: unit.slug, ...agora }, 'qualidade-numero: lido');

      // `antes: null` faz o alerta sair sempre que a nota não for GREEN.
      if (piorou(null, agora)) {
        const mandou = await avisarJoao(
          textoDoAlerta({
            unidade: unit.name,
            numero: d.display_phone_number ?? cred.phoneNumberId,
            antes: null,
            agora,
          }),
          `qualidade:${unit.slug}`,
          12 * 60 * 60_000,
        );
        if (mandou) alertas += 1;
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug }, 'qualidade-numero: falhou');
    }
  }
  logger.info({ unidades: unidades.length, lidas, alertas }, 'qualidade-numero: varredura concluída');
  return { lidas, alertas };
}

export function iniciarVigiaDeQualidade(): void {
  if (timer) return;
  primeira = setTimeout(() => {
    void varrerQualidadeDosNumeros().catch((err) =>
      logger.warn({ err: String(err) }, 'qualidade-numero: primeira varredura falhou'),
    );
  }, ATRASO_INICIAL_MS);
  timer = setInterval(() => {
    if (rodando) return;
    rodando = true;
    void varrerQualidadeDosNumeros()
      .catch((err) => logger.warn({ err: String(err) }, 'qualidade-numero: varredura falhou'))
      .finally(() => {
        rodando = false;
      });
  }, SWEEP_MS);
  logger.info({ sweepMs: SWEEP_MS }, 'qualidade-numero: vigia ligado');
}

export function pararVigiaDeQualidade(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
