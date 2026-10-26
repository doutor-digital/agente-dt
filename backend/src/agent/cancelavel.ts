/**
 * Só se cancela consulta FUTURA e DE PÉ. Sênior no #132: `consultaDoLead` devolve ATENDIDA como "confirmada" (só desmarcado e
 * não-compareceu viram "cancelada"), então a ferramenta cancelaria no franquia uma consulta que já aconteceu — e a Sofia diria
 * "cancelei" para quem foi atendido ontem. Passada, em andamento ou com status de encerrada: nunca.
 */
import { SpineService } from '../services/spine.service.js';

/**
 * REMARCADO (41) NÃO está aqui de propósito: é consulta VIVA movida para outra data (spine.service: "o paciente vem NAQUELA data"),
 * e quem remarcou também pode desistir. O corte de horário é no minuto ("AAAA-MM-DDTHH:mm", hora local dos dois lados): quem
 * pede cancelar no minuto exato da consulta já está no horário dela.
 */
const ENCERRADOS: Record<number, string> = {
  [SpineService.SPINE_STATUS.ATENDIDO]: 'já foi ATENDIDA',
  [SpineService.SPINE_STATUS.NAO_COMPARECEU]: 'está como NÃO COMPARECEU',
  [SpineService.SPINE_STATUS.DESMARCADO]: 'já está DESMARCADA',
};

/**
 * Por que NÃO cancelar — ou null (pode). `quando`: "AAAA-MM-DDTHH:mm" local da clínica; `agoraLocal`: o mesmo formato, agora.
 * Sem `quando` não há como provar que é futura: não cancela.
 */
export function motivoDeNaoCancelar(
  c: { quando: string | null | undefined; idStatus?: number | null },
  agoraLocal: string,
): string | null {
  if (c.idStatus != null && ENCERRADOS[c.idStatus]) return `a consulta ${ENCERRADOS[c.idStatus]} na clínica`;
  if (!c.quando) return 'não sei o dia e a hora da consulta';
  if (c.quando.slice(0, 16) <= agoraLocal.slice(0, 16)) return 'a consulta já passou ou está acontecendo agora';
  return null;
}

/**
 * A pergunta "Confirmo o cancelamento da sua consulta de…?" tem de ter sido feita em OUTRO turno antes de o cancelamento valer.
 * A ferramenta não vê a conversa, então a pergunta deixa uma marca (`cancelar_pergunta:<traceId do turno>` no `card_alert`) e
 * `confirmado=true` só passa se houver marca de um turno DIFERENTE do atual e recente. Isso fecha "o modelo chama sem e depois
 * com confirmado=true no mesmo turno" e "confirmado=true direto por causa de um 'pode cancelar' dito antes da pergunta" — o
 * 'sim' a ESSA pergunta continua sendo instrução do bloco, e esta é a trava que não depende do modelo.
 */
export const PREFIXO_DA_PERGUNTA = 'cancelar_pergunta:';
const JANELA_DA_PERGUNTA_MS = 48 * 3600_000;

export function perguntadoEmOutroTurno(
  marcas: Array<{ ruleKey: string; createdAt: Date }>,
  traceIdAtual: string | null | undefined,
  agora: Date = new Date(),
): boolean {
  const atual = `${PREFIXO_DA_PERGUNTA}${traceIdAtual ?? ''}`;
  return marcas.some((m) => m.ruleKey.startsWith(PREFIXO_DA_PERGUNTA) && m.ruleKey !== atual && agora.getTime() - m.createdAt.getTime() < JANELA_DA_PERGUNTA_MS);
}
