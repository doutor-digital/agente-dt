/**
 * Webhook da Pluggy — a assinatura e o tratamento do evento. Esquema CONFERIDO na documentação oficial (docs.pluggy.ai/en/docs/developer-tools/webhook-security):
 * NÃO é Svix/standard-webhooks, apesar do prefixo `whsec_`. O cabeçalho é um só:
 *
 *   X-Pluggy-Signature: t=<segundos unix>,v1=<HMAC-SHA256 em hex de "<t>.<corpo cru>">
 *
 * A chave do HMAC é o segredo INTEIRO, com o prefixo `whsec_`, em UTF-8 (não se decodifica base64). Confere-se sobre o corpo CRU (antes de qualquer
 * JSON.parse), com comparação em tempo constante, e rejeita-se `t` a mais de 5 minutos do relógio. Sem assinatura válida: 401, sem tocar em nada.
 * A Pluggy conta como falha quem não responde 2xx em 10 s, e o 401 não é reenviado; por isso o tratamento do evento roda DEPOIS da resposta.
 *
 * Aceita uma lista de segredos (o atual e o anterior) para a troca do segredo sem perder eventos.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { itemMascarado } from './pluggy.js';

export const TOLERANCIA_SEGUNDOS = 5 * 60;

export function assinaturaValida(corpo: Buffer, cabecalho: string | undefined, segredos: ReadonlyArray<string>, agoraMs: number = Date.now()): boolean {
  if (!cabecalho || !segredos.length) return false;
  let t: string | undefined;
  const recebidas: string[] = [];
  for (const parte of String(cabecalho).split(',')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    const k = parte.slice(0, i).trim();
    const v = parte.slice(i + 1).trim();
    if (k === 't' && t === undefined) t = v;
    else if (k === 'v1') recebidas.push(v);
  }
  // cabeçalho é entrada hostil: só um número decimal e um digest de 64 hex minúsculos passam
  if (!t || !/^[0-9]{1,12}$/.test(t)) return false;
  const validas = recebidas.filter((v) => /^[0-9a-f]{64}$/.test(v));
  if (!validas.length) return false;
  if (Math.abs(Math.floor(agoraMs / 1000) - Number(t)) > TOLERANCIA_SEGUNDOS) return false;
  let achou = false;
  for (const segredo of segredos) {
    if (!segredo) continue;
    const esperado = createHmac('sha256', segredo).update(`${t}.`).update(corpo).digest();
    // sem curto-circuito: confere todas, para o tempo não revelar qual casou
    for (const v of validas) if (timingSafeEqual(esperado, Buffer.from(v, 'hex'))) achou = true;
  }
  return achou;
}

export function segredosDoWebhook(e: NodeJS.ProcessEnv = process.env): string[] {
  return [e.PLUGGY_WEBHOOK_SECRET, e.PLUGGY_WEBHOOK_SECRET_PREVIOUS].map((s) => (s ?? '').trim()).filter(Boolean);
}

// ----------------------------------------------------------------- tratamento

export interface DependenciasDoWebhook {
  ambiente: () => NodeJS.ProcessEnv;
  agora: () => number;
  /** esquece o que o cliente guardou desse item */
  invalidarItem: (itemId: string) => void;
  /** manda o aviso ao João; nunca lança */
  avisar: (texto: string) => Promise<boolean>;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
  /** ids dos itens configurados (e o apelido de cada um); só esses geram aviso */
  itensConhecidos: () => Map<string, { apelido?: string }>;
}

export interface RespostaDoWebhook {
  status: number;
  /** o que roda DEPOIS de responder (cache, log, Telegram) */
  depois?: () => Promise<void>;
}

/** Um aviso de erro por item a cada 6 h: a Pluggy repete o evento quando o banco segue com problema. */
export const INTERVALO_DO_AVISO_MS = 6 * 60 * 60_000;
const MEMORIA_DE_EVENTOS_MS = 60 * 60_000;
const MAX_EVENTOS = 2000;

export function criarTratadorDoWebhook(d: DependenciasDoWebhook) {
  const eventosVistos = new Map<string, number>();
  const ultimoAviso = new Map<string, number>();

  return function tratar(corpo: Buffer, cabecalho: string | undefined): RespostaDoWebhook {
    const env = d.ambiente();
    const segredos = segredosDoWebhook(env);
    // sem segredo configurado a rota nem existe (o servidor sem a variável se comporta como sempre)
    if (!segredos.length) return { status: 404 };
    if (!assinaturaValida(corpo, cabecalho, segredos, d.agora())) {
      d.log.warn({ temCabecalho: Boolean(cabecalho) }, 'pluggy: webhook recusado (assinatura ausente, inválida ou fora do prazo)');
      return { status: 401 };
    }
    let evento: Record<string, unknown>;
    try {
      const j = JSON.parse(corpo.toString('utf8')) as unknown;
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('não é objeto');
      evento = j as Record<string, unknown>;
    } catch {
      return { status: 400 };
    }
    const clientId = (env.PLUGGY_CLIENT_ID ?? '').trim();
    // aviso de OUTRA aplicação (a assinatura prova a origem, não o destinatário): ignora, com 2xx para não ser reenviado
    if (typeof evento.clientId === 'string' && clientId && evento.clientId !== clientId) return { status: 200 };

    const eventId = typeof evento.eventId === 'string' ? evento.eventId : '';
    if (eventId) {
      const agora = d.agora();
      for (const [k, quando] of eventosVistos) if (agora - quando > MEMORIA_DE_EVENTOS_MS) eventosVistos.delete(k);
      if (eventosVistos.has(eventId)) return { status: 200 };
      if (eventosVistos.size >= MAX_EVENTOS) eventosVistos.delete(eventosVistos.keys().next().value as string);
      eventosVistos.set(eventId, agora);
    }

    const nome = typeof evento.event === 'string' ? evento.event : '';
    const itemId = typeof evento.itemId === 'string' ? evento.itemId.toLowerCase() : '';
    if (!itemId || (nome !== 'item/updated' && nome !== 'item/error')) return { status: 200 };

    return {
      status: 200,
      depois: async () => {
        const conhecido = d.itensConhecidos().get(itemId);
        if (!conhecido) {
          d.log.info({ evento: nome, item: itemMascarado(itemId) }, 'pluggy: webhook de um item que não está em PLUGGY_ITENS; ignorado');
          return;
        }
        d.invalidarItem(itemId);
        d.log.info({ evento: nome, item: itemMascarado(itemId) }, 'pluggy: webhook recebido, cache do item invalidado');
        if (nome !== 'item/error') return;
        const agora = d.agora();
        const anterior = ultimoAviso.get(itemId);
        if (anterior !== undefined && agora - anterior < INTERVALO_DO_AVISO_MS) return;
        ultimoAviso.set(itemId, agora);
        // só o CÓDIGO do erro (USER_AUTHORIZATION_EXPIRED…), nunca texto livre vindo do corpo
        const codigo = typeof (evento.error as { code?: unknown } | undefined)?.code === 'string' ? String((evento.error as { code: string }).code) : '';
        const cod = /^[A-Z][A-Z_]{2,48}$/.test(codigo) ? ` (${codigo})` : '';
        const quem = conhecido.apelido ? `${conhecido.apelido} (${itemMascarado(itemId)})` : itemMascarado(itemId);
        await d.avisar(`Pluggy: a conexão ${quem} deu erro${cod}. O extrato bancário do conector pode estar desatualizado. Reconecte no Meu Pluggy (meu.pluggy.ai) e confirme com pluggy_contas.`);
      },
    };
  };
}
