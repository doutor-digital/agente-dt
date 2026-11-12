/**
 * "LIDA" (✓✓ azul) no Chatwoot para o que sai pelo CELULAR da unidade (pedido do João, 12/11/2026).
 *
 * O Evolution só repassa "lida" ao Chatwoot quando a mensagem nasceu no Chatwoot: para a que a equipe manda pelo celular ele não
 * guarda o identificador do contato na caixa (`chatwootContactInboxSourceId` fica vazio) e o aviso morre. Aqui o agente-dt recebe
 * o webhook `messages.update` do Evolution (status READ/PLAYED de mensagem NOSSA), acha a conversa pelo telefone e chama o
 * `update_last_seen` da API pública do Chatwoot — o mesmo que o Evolution faria. Resultado: tudo o que mandamos até ali vira ✓✓.
 *
 *  - Não manda nada a ninguém: só marca "visto pelo contato".
 *  - Chave na URL (`?k=`), derivada do token do Chatwoot (sem env novo; o log mascara `k=`).
 *  - Só as instâncias do mapa. Grupo e contato sem telefone (@lid sem número alternativo) ficam de fora.
 *  - Um aviso de leitura costuma vir em rajada (várias mensagens lidas de uma vez): o mesmo telefone só é marcado 1× a cada 20 s.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { logger } from './logger.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

/** instância do Evolution → caixa do Chatwoot */
export const INSTANCIA_CAIXA: Readonly<Record<string, number>> = { 'parauapebas-unidade': 2 };
export const INTERVALO_MESMO_TELEFONE_MS = 20_000;
const VALIDADE_DO_ALVO_MS = 30 * 60_000;

export function chaveDaLida(tokenChatwoot: string): string {
  return createHmac('sha256', tokenChatwoot).update('evolution-lida-v1').digest('hex').slice(0, 32);
}

export function chaveDaLidaConfere(tokenChatwoot: string | undefined, recebida: unknown): boolean {
  if (!tokenChatwoot || typeof recebida !== 'string' || recebida.length !== 32) return false;
  const a = Buffer.from(chaveDaLida(tokenChatwoot));
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface AvisoDeLeitura {
  instancia: string;
  /** só dígitos, com o 55 */
  telefone: string;
}

/** Corpo do webhook do Evolution → aviso de leitura de mensagem nossa, ou null. Aceita `data` objeto ou lista. */
export function avisoDaLeitura(corpo: any): AvisoDeLeitura | null {
  const evento = String(corpo?.event ?? '').toLowerCase().replace(/_/g, '.');
  if (evento !== 'messages.update') return null;
  const instancia = String(corpo?.instance ?? '').trim();
  if (!instancia) return null;
  const itens: any[] = Array.isArray(corpo?.data) ? corpo.data : [corpo?.data];
  for (const d of itens) {
    const status = String(d?.status ?? d?.update?.status ?? '').toUpperCase();
    if (status !== 'READ' && status !== 'PLAYED') continue;
    if (d?.fromMe !== true && d?.key?.fromMe !== true) continue;
    const jid = [d?.remoteJid, d?.remoteJidAlt, d?.key?.remoteJid, d?.key?.remoteJidAlt].find(
      (j): j is string => typeof j === 'string' && /@s\.whatsapp\.net$/.test(j),
    );
    if (!jid) continue;
    const telefone = jid.split('@')[0]!.replace(/\D/g, '');
    if (telefone.length < 10) continue;
    return { instancia, telefone };
  }
  return null;
}

/** Mesmo número? Compara DDI+DDD e os 8 últimos dígitos (o Brasil tem o mesmo celular com e sem o 9). */
export function mesmoTelefone(a: string, b: string): boolean {
  const x = a.replace(/\D/g, '');
  const y = b.replace(/\D/g, '');
  if (x.length < 10 || y.length < 10) return false;
  return x.slice(0, 4) === y.slice(0, 4) && x.slice(-8) === y.slice(-8);
}

export interface Alvo {
  conversa: number;
  sourceId: string;
}

export interface PortaDaLida {
  inboxIdentifier(caixa: number): Promise<string | null>;
  alvo(caixa: number, telefone: string): Promise<Alvo | null>;
  marcar(identificador: string, alvo: Alvo): Promise<void>;
}

export function portaDoChatwoot(ctx: ContextoChatwoot): PortaDaLida {
  return {
    async inboxIdentifier(caixa) {
      const r = (await chamar(ctx, 'GET', `inboxes/${caixa}`)) as { inbox_identifier?: unknown } | null;
      return typeof r?.inbox_identifier === 'string' && r.inbox_identifier ? r.inbox_identifier : null;
    },
    async alvo(caixa, telefone) {
      const busca = (await chamar(ctx, 'GET', 'contacts/search', { query: { q: telefone.slice(-8) } })) as { payload?: any[] } | null;
      const contatos = (busca?.payload ?? []).filter((c) => typeof c?.phone_number === 'string' && mesmoTelefone(c.phone_number, telefone));
      let melhor: { conversa: number; contato: number; atividade: number } | null = null;
      for (const c of contatos) {
        const r = (await chamar(ctx, 'GET', `contacts/${Number(c.id)}/conversations`)) as { payload?: any[] } | null;
        for (const conv of r?.payload ?? []) {
          if (Number(conv?.inbox_id) !== caixa) continue;
          const atividade = Number(conv?.last_activity_at) || 0;
          if (!melhor || atividade > melhor.atividade) melhor = { conversa: Number(conv.id), contato: Number(c.id), atividade };
        }
      }
      if (!melhor) return null;
      const ci = (await chamar(ctx, 'GET', `contacts/${melhor.contato}/contactable_inboxes`)) as { payload?: any[] } | null;
      const sourceId = (ci?.payload ?? []).find((x) => Number(x?.inbox?.id) === caixa)?.source_id;
      return typeof sourceId === 'string' && sourceId ? { conversa: melhor.conversa, sourceId } : null;
    },
    async marcar(identificador, alvo) {
      const conta = ctx.conta;
      if (!conta) return;
      const url = `${conta.url}/public/api/v1/inboxes/${encodeURIComponent(identificador)}/contacts/${encodeURIComponent(alvo.sourceId)}/conversations/${alvo.conversa}/update_last_seen`;
      const r = await ctx.fetch(url, { method: 'POST', signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`Chatwoot ${r.status} no update_last_seen da conversa ${alvo.conversa}`);
    },
  };
}

/** Estado em memória: identificador da caixa, alvo por telefone e a última marcação por telefone. */
export interface MemoriaDaLida {
  identificadores: Map<number, string>;
  alvos: Map<string, { alvo: Alvo; ate: number }>;
  ultima: Map<string, number>;
}
export const novaMemoriaDaLida = (): MemoriaDaLida => ({ identificadores: new Map(), alvos: new Map(), ultima: new Map() });

export type ResultadoDaLida = 'marcada' | 'ignorada' | 'repetida' | 'sem-conversa';

export async function processarLeitura(aviso: AvisoDeLeitura, porta: PortaDaLida, mem: MemoriaDaLida, agora: number): Promise<ResultadoDaLida> {
  const caixa = INSTANCIA_CAIXA[aviso.instancia];
  if (!caixa) return 'ignorada';
  const chave = `${caixa}:${aviso.telefone}`;
  const antes = mem.ultima.get(chave);
  if (antes !== undefined && agora - antes < INTERVALO_MESMO_TELEFONE_MS) return 'repetida';
  mem.ultima.set(chave, agora);
  let identificador = mem.identificadores.get(caixa);
  if (!identificador) {
    identificador = (await porta.inboxIdentifier(caixa)) ?? undefined;
    if (!identificador) return 'sem-conversa';
    mem.identificadores.set(caixa, identificador);
  }
  const guardado = mem.alvos.get(chave);
  let alvo = guardado && guardado.ate > agora ? guardado.alvo : null;
  if (!alvo) {
    alvo = await porta.alvo(caixa, aviso.telefone);
    if (!alvo) return 'sem-conversa';
    mem.alvos.set(chave, { alvo, ate: agora + VALIDADE_DO_ALVO_MS });
  }
  try {
    await porta.marcar(identificador, alvo);
  } catch (err) {
    // a conversa pode ter mudado (nova conversa do mesmo contato): esquece o alvo e tenta achar de novo uma vez
    mem.alvos.delete(chave);
    const novo = await porta.alvo(caixa, aviso.telefone);
    if (!novo) throw err;
    mem.alvos.set(chave, { alvo: novo, ate: agora + VALIDADE_DO_ALVO_MS });
    await porta.marcar(identificador, novo);
  }
  return 'marcada';
}

// ── a rota ─────────────────────────────────────────────────────────────────────────────────────────

let estado: { porta: PortaDaLida; mem: MemoriaDaLida } | null = null;

/** POST /api/public/evolution/lida?k=<chave> — webhook `messages.update` do Evolution. Responde na hora; o trabalho segue depois. */
export function lidaEvolutionHandler(req: Request, res: Response): void {
  const token = process.env.CHATWOOT_API_TOKEN?.trim();
  if (!chaveDaLidaConfere(token, req.query.k)) {
    res.status(401).json({ error: 'chave inválida' });
    return;
  }
  res.json({ ok: true });
  const aviso = avisoDaLeitura(req.body);
  if (!aviso) return;
  if (!estado) {
    const conta = contaChatwootDoAmbiente();
    if (!conta) return;
    estado = { porta: portaDoChatwoot(criarContextoChatwoot(conta)), mem: novaMemoriaDaLida() };
  }
  const { porta, mem } = estado;
  processarLeitura(aviso, porta, mem, Date.now())
    .then((r) => {
      if (r === 'marcada' || r === 'sem-conversa') logger.debug({ instancia: aviso.instancia, final: aviso.telefone.slice(-4), r }, 'evolution-lida');
    })
    .catch((err) => logger.warn({ err: String(err), instancia: aviso.instancia, final: aviso.telefone.slice(-4) }, 'evolution-lida: não consegui marcar como lida'));
}
