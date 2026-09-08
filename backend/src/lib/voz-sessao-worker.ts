import { logger } from './logger.js';
import { renovarTokensDeChat } from '../services/kommo-chat.service.js';
import { avisarJoao } from './alerta-whatsapp.js';

/**
 * Guardião da voz: renova os tokens de chat do Kommo antes de vencerem.
 *
 * Existe porque em 05/09/2026 a sessão web copiada do navegador morreu uma hora
 * depois, e sem token de chat toda resposta em áudio cai em texto sem ninguém
 * perceber. Roda no líder (worker-lease), a cada 12 h, renovando o que vence em
 * menos de 48 h. Se a renovação falhar em alguma unidade, avisa o João no
 * WhatsApp — é o sinal de que a sessão caiu e alguém precisa logar de novo.
 */

const SWEEP_MS = Number(process.env.VOZ_SESSAO_SWEEP_MS) || 12 * 60 * 60_000;
const ATRASO_INICIAL_MS = Number(process.env.VOZ_SESSAO_DELAY_MS) || 3 * 60_000;

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

export async function varrerSessaoDeVoz(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const r = await renovarTokensDeChat(48);
    logger.info({ ...r, falhas: r.falhas.length }, 'voz-sessao: tokens de chat verificados');
    if (r.falhas.length) {
      const lista = r.falhas.slice(0, 6).map((f) => `• ${f.slug}: ${f.erro.slice(0, 90)}`).join('\n');
      void avisarJoao(
        `🔊 Guardião da voz: não consegui renovar o token de chat em ${r.falhas.length} unidade(s). ` +
          `Quando o token atual vencer, as respostas em áudio dessas unidades vão sair em texto.\n${lista}\n\n` +
          'Provável causa: a sessão web do Kommo caiu — precisa logar de novo.',
        'voz-sessao',
        6 * 60 * 60_000,
      );
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'voz-sessao: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startVozSessaoWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrerSessaoDeVoz(), ATRASO_INICIAL_MS);
  timer = setInterval(() => void varrerSessaoDeVoz(), SWEEP_MS);
  logger.info({ sweepMs: SWEEP_MS }, 'voz-sessao: guardião ligado');
}

export function stopVozSessaoWorker(): void {
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
