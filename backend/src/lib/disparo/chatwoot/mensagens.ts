/**
 * Ler as MENSAGENS de uma conversa do Chatwoot para o disparo: quem pediu para SAIR (a MESMA regra `pediuParaSair` do motor do Kommo),
 * quando o paciente respondeu e o estado de entrega das nossas. Só leitura.
 *
 * O Chatwoot devolve as 20 mais novas em ordem crescente; `before=<id>` traz as 20 anteriores (o mesmo caminho de `ultimaDoPaciente` da régua).
 */
import { chamar, type ContextoChatwoot } from '../../../mcp-remoto/chatwoot.js';
import { pediuParaSair } from '../regras.js';

/** O id da mensagem do CRM guardado em `wamid` (`cw:<id>`); `null` se o wamid não é de uma mensagem do CRM. */
export const idDaMensagem = (wamid: string | null | undefined): number | null => {
  const m = /^cw:(\d{1,12})$/.exec(wamid ?? '');
  return m ? Number(m[1]) : null;
};

export interface MensagemLida {
  id: number;
  /** 0 = recebida do paciente · 1 = enviada · 2 = atividade · 3 = modelo */
  tipo: number;
  privada: boolean;
  conteudo: string;
  criadaEm: Date;
  /** 'sent' | 'delivered' | 'read' | 'failed' (ou o número do enum, normalizado) */
  status: string | null;
  erro: string | null;
}

const STATUS_NUMERICO = ['sent', 'delivered', 'read', 'failed'];

export function mensagemLida(m: any): MensagemLida | null {
  const id = Number(m?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const s = m?.status;
  const status = typeof s === 'string' ? s.toLowerCase() : Number.isInteger(s) && STATUS_NUMERICO[s] ? STATUS_NUMERICO[s]! : null;
  const erroBruto = m?.external_error ?? m?.content_attributes?.external_error;
  return {
    id,
    tipo: Number(m?.message_type),
    privada: m?.private === true,
    conteudo: typeof m?.content === 'string' ? m.content : '',
    criadaEm: new Date(Number(m?.created_at) * 1000 || 0),
    status,
    erro: typeof erroBruto === 'string' && erroBruto.trim() ? erroBruto.slice(0, 300) : null,
  };
}

/** Até `paginas` páginas de 20 mensagens, das mais novas para as mais antigas. Lança se o Chatwoot não respondeu. */
export async function lerMensagens(ctx: ContextoChatwoot, conversaId: number, paginas = 3): Promise<MensagemLida[]> {
  const todas: MensagemLida[] = [];
  let antes: number | undefined;
  for (let i = 0; i < paginas; i++) {
    const r = (await chamar(ctx, 'GET', `conversations/${conversaId}/messages`, { query: antes ? { before: String(antes) } : {} })) as { payload?: unknown[] } | null;
    const lista = Array.isArray(r?.payload) ? r.payload : [];
    if (lista.length === 0) break;
    for (const m of lista) {
      const l = mensagemLida(m);
      if (l) todas.push(l);
    }
    const primeiro = Number((lista[0] as { id?: unknown })?.id);
    if (!Number.isInteger(primeiro) || primeiro <= 0 || lista.length < 20) break;
    antes = primeiro;
  }
  return todas;
}

/** Quando foi o ÚLTIMO pedido de saída do paciente nesta lista de mensagens (só as recebidas e públicas). `null` = nenhum. */
export function ultimoPedidoDeSaida(mensagens: readonly MensagemLida[]): Date | null {
  let ultimo: Date | null = null;
  for (const m of mensagens) {
    if (m.tipo !== 0 || m.privada || !m.conteudo || !pediuParaSair(m.conteudo)) continue;
    if (!ultimo || m.criadaEm > ultimo) ultimo = m.criadaEm;
  }
  return ultimo;
}

/** As outras conversas do contato (outras caixas, conversas antigas): o SAIR pode ter sido dito em qualquer uma. Lança se não deu para ler. */
export async function conversasDoContato(ctx: ContextoChatwoot, contatoId: number, max = 6): Promise<number[]> {
  const r = (await chamar(ctx, 'GET', `contacts/${contatoId}/conversations`)) as { payload?: unknown[] } | null;
  const lista = Array.isArray(r?.payload) ? (r.payload as Array<{ id?: unknown; last_activity_at?: unknown }>) : [];
  return lista
    .map((c) => ({ id: Number(c?.id), t: Number(c?.last_activity_at) || 0 }))
    .filter((c) => Number.isInteger(c.id) && c.id > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, max)
    .map((c) => c.id);
}

/**
 * O último pedido de saída do CONTATO: na conversa do disparo e nas outras conversas dele (até 6). Lança se alguma leitura falhar —
 * quem chama NÃO pode tratar falha como «não pediu».
 */
export async function ultimoPedidoDeSaidaDoContato(ctx: ContextoChatwoot, conversaId: number, contatoId: number | null, paginas = 3): Promise<Date | null> {
  const ids = new Set<number>([conversaId]);
  if (contatoId) for (const id of await conversasDoContato(ctx, contatoId)) ids.add(id);
  let ultimo: Date | null = null;
  for (const id of ids) {
    // a conversa do disparo é lida a fundo; as outras do contato, só nas 20 mensagens mais novas (uma chamada cada)
    const d = ultimoPedidoDeSaida(await lerMensagens(ctx, id, id === conversaId ? paginas : 1));
    if (d && (!ultimo || d > ultimo)) ultimo = d;
  }
  return ultimo;
}
