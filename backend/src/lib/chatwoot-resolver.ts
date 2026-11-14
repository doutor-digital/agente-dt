/**
 * Campos obrigatórios ao resolver — a camada do SERVIDOR (João, 14/11/2026: "faça do melhor jeito pra evitar erros").
 *
 * A janela «Antes de resolver» do menu (chatwoot-assistente-ui.ts) pede os campos no botão «Resolver». O que escapa dela
 * (atalho de teclado, resolver várias pela lista, resolver automático de 7 dias, tela antiga aberta) chega aqui pelo webhook:
 *  - conversa RESOLVIDA faltando campo → etiqueta `falta-etapa` (vira pasta para alguém completar). Não reabre a conversa
 *    (reabrir brigaria com a pessoa e devolveria a conversa para a Sofia).
 *  - quando os campos ficam completos (alguém preencheu depois) → tira a etiqueta.
 * Conversa do histórico unificado (`historico`) fica de fora. A regra é a MESMA da janela (`camposFaltandoAoResolver`).
 */
import { logger } from './logger.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA, ETIQUETA_HISTORICO } from './chatwoot-regua.js';

export const ETIQUETA_FALTA = 'falta-etapa';

/** Etapa sempre; Perdido → motivo do não agendamento; Fechou → valor fechado (> 0). */
export function camposFaltandoAoResolver(a: Record<string, unknown> | null | undefined): string[] {
  const at = a ?? {};
  const f: string[] = [];
  const etapa = String(at.etapa ?? '').trim();
  if (!etapa) f.push('etapa');
  if (etapa === 'Perdido' && !String(at.motivo_nao_agendamento ?? '').trim()) f.push('motivo_nao_agendamento');
  if (etapa === 'Fechou' && !(Number(at.valor_fechado) > 0)) f.push('valor_fechado');
  return f;
}

export interface EventoDeResolucao {
  conversa: number;
  etiquetas: string[];
  /** 'por' = pôr a etiqueta; 'tirar' = tirar; null = nada a fazer */
  acao: 'por' | 'tirar' | null;
}

/** Webhook do Chatwoot → o que fazer com a etiqueta `falta-etapa`, ou null (não é conversa de unidade / não é evento que importa). */
export function eventoDeResolucao(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): EventoDeResolucao | null {
  const ev = corpo?.event;
  if (ev !== 'conversation_status_changed' && ev !== 'conversation_updated') return null;
  const conversa = Number(corpo?.id);
  if (!Number.isInteger(conversa) || conversa <= 0 || !caixas[Number(corpo?.inbox_id)]) return null;
  const etiquetas: string[] = Array.isArray(corpo?.labels) ? corpo.labels.map(String) : [];
  if (etiquetas.includes(ETIQUETA_HISTORICO)) return null;
  const tem = etiquetas.includes(ETIQUETA_FALTA);
  const falta = camposFaltandoAoResolver(corpo?.custom_attributes);
  const resolvida = String(corpo?.status ?? '') === 'resolved';
  let acao: EventoDeResolucao['acao'] = null;
  if (resolvida && falta.length && !tem) acao = 'por';
  else if (tem && !falta.length) acao = 'tirar';
  return { conversa, etiquetas, acao };
}

export interface PortasDoResolver {
  etiquetas(conversa: number, lista: string[]): Promise<void>;
}

export function portasDoResolver(ctx: ContextoChatwoot): PortasDoResolver {
  return {
    async etiquetas(conversa, lista) {
      // o Chatwoot SUBSTITUI a lista inteira: manda a lista completa
      await chamar(ctx, 'POST', `conversations/${conversa}/labels`, { corpo: { labels: lista } });
    },
  };
}

/** Desliga com CHATWOOT_RESOLVER_OBRIGATORIO=0 (o mesmo interruptor da janela). Não lança. */
export async function aplicarResolucao(e: EventoDeResolucao, p: PortasDoResolver, env: NodeJS.ProcessEnv = process.env): Promise<'nada' | 'pos' | 'tirou'> {
  if (env.CHATWOOT_RESOLVER_OBRIGATORIO === '0' || !e.acao) return 'nada';
  const lista = e.acao === 'por' ? [...e.etiquetas, ETIQUETA_FALTA] : e.etiquetas.filter((x) => x !== ETIQUETA_FALTA);
  try {
    await p.etiquetas(e.conversa, lista);
    logger.info({ conversa: e.conversa, acao: e.acao }, `chatwoot-resolver: ${e.acao === 'por' ? 'resolvida sem os campos → etiqueta' : 'campos completos → tirou a etiqueta'} ${ETIQUETA_FALTA}`);
    return e.acao === 'por' ? 'pos' : 'tirou';
  } catch (err) {
    logger.warn({ conversa: e.conversa, err: String(err) }, 'chatwoot-resolver: não consegui mexer na etiqueta');
    return 'nada';
  }
}
