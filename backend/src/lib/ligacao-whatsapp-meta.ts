/**
 * Ligação pelo WhatsApp — a conversa com a Meta (Graph API, Calling API) e a leitura do webhook `calls`.
 *
 * Endpoints usados (doc oficial lida em 08/10/2026, developers.facebook.com/documentation/business-messaging/whatsapp/calling):
 *   POST /{phone_number_id}/calls            action "connect" (oferta SDP do navegador) e "terminate"
 *   GET  /{phone_number_id}/call_permissions ?user_wa_id=  — o paciente deixa ligar? até quando?
 *   POST /{phone_number_id}/messages         interativa `call_permission_request` (pedido de permissão)
 *
 * A ligação NÃO sai do celular da clínica: sai do navegador da SDR (WebRTC), e a Meta faz a ponte até o
 * WhatsApp do paciente. A resposta SDP da Meta chega pelo webhook (evento "connect").
 *
 * `fetch` entra por parâmetro para os testes não chamarem a Meta de verdade.
 */
import type { MetaLigacoes, ResultadoMeta } from './ligacao-whatsapp-servico.js';

const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
/** A Calling API exige versão recente da Graph API; dá pra trocar sem deploy de código. */
const VERSAO = process.env.META_CALLING_GRAPH_VERSION || 'v25.0';

export interface CredencialMeta {
  phoneNumberId: string;
  token: string;
}

type Buscar = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface PermissaoNaMeta {
  estado: 'aceita' | 'sem';
  ate: Date | null;
  permanente: boolean;
  /** `start_call` liberado agora? null = a Meta não disse. */
  podeLigar: boolean | null;
  /** `send_call_permission_request` liberado agora? */
  podePedir: boolean | null;
}

function erroDaResposta(j: unknown): { codigo: number | null; mensagem: string | null } {
  const e = (j as { error?: { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } } } | null)?.error;
  if (!e) return { codigo: null, mensagem: null };
  return { codigo: typeof e.code === 'number' ? e.code : null, mensagem: e.error_data?.details || e.message || null };
}

/** Cliente da Meta de uma unidade. */
export function metaDaUnidade(cred: CredencialMeta, buscar: Buscar = fetch as unknown as Buscar): MetaLigacoes {
  const base = `${GRAPH}/${VERSAO}/${cred.phoneNumberId}`;
  const cab = { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' };

  async function chamar<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<ResultadoMeta<T> & { bruto?: unknown }> {
    try {
      const r = await buscar(`${base}${caminho}`, {
        method: metodo,
        headers: cab,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return { ok: false, ...erroDaResposta(j), bruto: j };
      return { ok: true, bruto: j };
    } catch (err) {
      return { ok: false, codigo: null, mensagem: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    async iniciar(para, sdp, opaco) {
      const r = await chamar<{ callId: string }>('POST', '/calls', {
        messaging_product: 'whatsapp',
        to: para,
        action: 'connect',
        session: { sdp_type: 'offer', sdp },
        biz_opaque_callback_data: opaco,
      });
      if (!r.ok) return r;
      const id = (r.bruto as { calls?: Array<{ id?: string }> } | null)?.calls?.[0]?.id;
      return id ? { ok: true, dado: { callId: id } } : { ok: false, codigo: null, mensagem: 'a Meta não devolveu o id da ligação' };
    },
    async encerrar(callId) {
      const r = await chamar('POST', '/calls', { messaging_product: 'whatsapp', call_id: callId, action: 'terminate' });
      return { ok: r.ok, codigo: r.codigo, mensagem: r.mensagem };
    },
    async permissao(para) {
      const r = await chamar<PermissaoNaMeta>('GET', `/call_permissions?user_wa_id=${encodeURIComponent(para)}`);
      if (!r.ok) return { ok: false, codigo: r.codigo, mensagem: r.mensagem };
      return { ok: true, dado: lerPermissao(r.bruto) };
    },
    async pedirPermissao(para, texto) {
      const r = await chamar('POST', '/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: para,
        type: 'interactive',
        interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' }, body: { text: texto } },
      });
      return { ok: r.ok, codigo: r.codigo, mensagem: r.mensagem };
    },
    async pedirPermissaoPorModelo(para, modelo) {
      const [nome, idioma] = modelo.split(':');
      const r = await chamar('POST', '/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: para,
        type: 'template',
        template: { name: nome.trim(), language: { code: (idioma || 'pt_BR').trim() } },
      });
      return { ok: r.ok, codigo: r.codigo, mensagem: r.mensagem };
    },
  };
}

/** `GET /call_permissions` → o que interessa. Formato da doc: `permission.status` + `actions[]`. */
export function lerPermissao(bruto: unknown): PermissaoNaMeta {
  const j = (bruto ?? {}) as {
    permission?: { status?: string; expiration_time?: number | string; is_permanent?: boolean };
    actions?: Array<{ action_name?: string; can_perform_action?: boolean }>;
  };
  const status = String(j.permission?.status ?? '').toLowerCase();
  const exp = Number(j.permission?.expiration_time);
  const aceita = status === 'granted' || status === 'temporary' || status === 'permanent';
  const permanente = status === 'permanent' || j.permission?.is_permanent === true || (aceita && !Number.isFinite(exp));
  const acao = (nome: string) => {
    const a = (j.actions ?? []).find((x) => x.action_name === nome);
    return typeof a?.can_perform_action === 'boolean' ? a.can_perform_action : null;
  };
  return {
    estado: aceita ? 'aceita' : 'sem',
    ate: aceita && Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null,
    permanente: aceita && permanente,
    podeLigar: acao('start_call'),
    podePedir: acao('send_call_permission_request'),
  };
}

// ── webhook ──────────────────────────────────────────────────────────────────────────────────────

export type EventoDeLigacao =
  /** `numeros`: o `to` e o `from` do evento — a doc da Meta troca os dois no exemplo, então guardamos ambos. */
  | { tipo: 'connect'; phoneNumberId: string; callId: string; opaco: string | null; telefone: string; numeros: string[]; sdp: string | null; sdpTipo: string | null; quando: Date }
  | { tipo: 'status'; phoneNumberId: string; callId: string; opaco: string | null; telefone: string; status: string; quando: Date }
  | { tipo: 'terminate'; phoneNumberId: string; callId: string; opaco: string | null; telefone: string; status: string; duracaoSeg: number | null; inicio: Date | null; quando: Date }
  | { tipo: 'permissao'; phoneNumberId: string; telefone: string; resposta: 'aceita' | 'recusada'; ate: Date | null; permanente: boolean; quando: Date };

const quandoDe = (t: unknown, padrao: Date): Date => {
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : padrao;
};

/**
 * Lê o corpo do webhook da Meta e devolve só o que é de ligação: eventos `calls` (connect/terminate),
 * status de ligação (`statuses[]` com `type: "call"`: RINGING/ACCEPTED/REJECTED) e a resposta do paciente
 * ao pedido de permissão (`messages[]` interativa `call_permission_reply`). O resto é ignorado.
 */
export function lerWebhookDeLigacoes(payload: unknown, agora = new Date()): EventoDeLigacao[] {
  const out: EventoDeLigacao[] = [];
  const raiz = payload as { entry?: Array<{ changes?: Array<{ field?: string; value?: Record<string, unknown> }> }> };
  for (const entry of raiz?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = (change?.value ?? {}) as {
        metadata?: { phone_number_id?: string };
        calls?: Array<Record<string, unknown>>;
        statuses?: Array<Record<string, unknown>>;
        messages?: Array<Record<string, unknown>>;
      };
      const phoneNumberId = String(v.metadata?.phone_number_id ?? '');
      for (const c of v.calls ?? []) {
        const evento = String(c.event ?? '').toLowerCase();
        const callId = String(c.id ?? '');
        if (!callId) continue;
        const opaco = typeof c.biz_opaque_callback_data === 'string' ? c.biz_opaque_callback_data : null;
        const telefone = String(c.to ?? c.from ?? '');
        const quando = quandoDe(c.timestamp, agora);
        if (evento === 'connect') {
          const s = (c.session ?? {}) as { sdp?: string; sdp_type?: string };
          const numeros = [c.to, c.from].filter((x): x is string => typeof x === 'string' && !!x);
          out.push({ tipo: 'connect', phoneNumberId, callId, opaco, telefone, numeros, sdp: typeof s.sdp === 'string' ? s.sdp : null, sdpTipo: s.sdp_type ?? null, quando });
        } else if (evento === 'terminate') {
          const dur = Number(c.duration);
          out.push({
            tipo: 'terminate', phoneNumberId, callId, opaco, telefone,
            status: String(c.status ?? ''),
            duracaoSeg: Number.isFinite(dur) && dur >= 0 ? Math.round(dur) : null,
            inicio: c.start_time ? quandoDe(c.start_time, agora) : null,
            quando,
          });
        }
      }
      for (const s of v.statuses ?? []) {
        if (String(s.type ?? '').toLowerCase() !== 'call') continue;
        const callId = String(s.id ?? '');
        if (!callId) continue;
        out.push({
          tipo: 'status', phoneNumberId, callId,
          opaco: typeof s.biz_opaque_callback_data === 'string' ? s.biz_opaque_callback_data : null,
          telefone: String(s.recipient_id ?? ''),
          status: String(s.status ?? ''),
          quando: quandoDe(s.timestamp, agora),
        });
      }
      for (const m of v.messages ?? []) {
        const inter = (m.interactive ?? {}) as { type?: string; call_permission_reply?: { response?: string; expiration_timestamp?: number | string; is_permanent?: boolean } };
        if (inter.type !== 'call_permission_reply' || !inter.call_permission_reply) continue;
        const r = inter.call_permission_reply;
        const exp = Number(r.expiration_timestamp);
        out.push({
          tipo: 'permissao', phoneNumberId,
          telefone: String(m.from ?? ''),
          resposta: String(r.response ?? '').toLowerCase() === 'accept' ? 'aceita' : 'recusada',
          ate: Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null,
          permanente: r.is_permanent === true,
          quando: quandoDe(m.timestamp, agora),
        });
      }
    }
  }
  return out;
}

/** Os `phone_number_id` citados no corpo — é por eles que se acha a unidade. */
export function numerosDoWebhook(payload: unknown): string[] {
  const ids = new Set<string>();
  const raiz = payload as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string } } }> }> };
  for (const entry of raiz?.entry ?? []) for (const ch of entry?.changes ?? []) {
    const id = ch?.value?.metadata?.phone_number_id;
    if (id) ids.add(String(id));
  }
  return [...ids];
}
