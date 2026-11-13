/**
 * Pausa da IA por conversa no Chatwoot (pedido do João, 13/11/2026): "quando pausar a IA, assumir o atendimento; após mandar msg
 * fora do Chatwoot, pause a IA também".
 *
 * Antes, a Sofia só ficava calada enquanto a ÚLTIMA mensagem era da equipe: se o paciente respondesse de novo, ela voltava a falar
 * por cima da atendente. Agora a pausa PERSISTE (etiqueta `ia-pausada` na conversa) até alguém reativar ou a conversa ser resolvida.
 *
 * Pausa sozinha quando:
 *  - uma PESSOA manda mensagem pública pelo Chatwoot (usuário que não é o robô — o usuário 2, por onde saem Sofia e régua) →
 *    pausa e a conversa passa a ser de quem respondeu ("assumir o atendimento");
 *  - sai mensagem pelo CELULAR (coexistência do WhatsApp oficial: o Chatwoot grava o eco como saída sem remetente, com
 *    `content_attributes.external_echo`; na caixa antiga do Evolution, o usuário 7 "📱 Celular da unidade") → pausa, sem mudar quem atende.
 * Volta sozinha quando a conversa é RESOLVIDA (a próxima conversa do paciente começa com a IA ativa).
 * Nada vai ao paciente: só etiqueta, atribuição, atributos e uma nota privada.
 */
import { logger } from './logger.js';
import { chamar, type ContextoChatwoot, type SessaoDoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA, USUARIO_CELULAR } from './chatwoot-regua.js';

export const ETIQUETA_PAUSA = 'ia-pausada';
/** O usuário "Conector Claude": por ele saem a Sofia e a régua. Mensagem dele NÃO pausa. */
export const USUARIO_ROBO = 2;
export const NOTA_PAUSA = '⏸ IA pausada nesta conversa';
export const NOTA_REATIVADA = '▶ IA reativada nesta conversa';

export type AutorDaPausa = { tipo: 'pessoa'; id: number; nome: string } | { tipo: 'celular' };

export interface EventoDePausa {
  conversa: number;
  slug: string;
  autor: AutorDaPausa;
}

const numero = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** `message_created` de saída feita por gente (Chatwoot ou celular), pública, numa caixa do mapa → pausa; senão null. */
export function eventoDePausa(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): EventoDePausa | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'outgoing' || tipo === 1)) return null;
  if (corpo?.private === true) return null;
  const conversa = numero(corpo?.conversation?.id);
  const caixa = numero(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const slug = caixa ? caixas[caixa] : undefined;
  if (!conversa || !slug) return null;
  const atributos = corpo?.content_attributes && typeof corpo.content_attributes === 'object' ? corpo.content_attributes : {};
  if (atributos.external_echo === true || atributos.external_echo === 'true') return { conversa, slug, autor: { tipo: 'celular' } };
  const sender = corpo?.sender ?? {};
  const id = numero(sender.id);
  const ehUsuario = String(sender.type ?? '').toLowerCase() === 'user';
  if (!ehUsuario || !id || id === USUARIO_ROBO) return null;
  if (id === USUARIO_CELULAR) return { conversa, slug, autor: { tipo: 'celular' } };
  return { conversa, slug, autor: { tipo: 'pessoa', id, nome: String(sender.name ?? '').trim() || `usuário ${id}` } };
}

/** `conversation_updated` de conversa RESOLVIDA que ainda está pausada, numa caixa do mapa → reativar; senão null. */
export function eventoDeReativacao(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): { conversa: number } | null {
  if (corpo?.event !== 'conversation_updated' && corpo?.event !== 'conversation_status_changed') return null;
  if (String(corpo?.status ?? '') !== 'resolved') return null;
  const conversa = numero(corpo?.id);
  const caixa = numero(corpo?.inbox_id);
  if (!conversa || !caixa || !caixas[caixa]) return null;
  const etiquetas: unknown[] = Array.isArray(corpo?.labels) ? corpo.labels : [];
  return etiquetas.some((e) => String(e) === ETIQUETA_PAUSA) ? { conversa } : null;
}

export interface ConversaDaPausa {
  etiquetas: string[];
  atendente: number | null;
  attrs: Record<string, unknown>;
}

export interface PortaDaPausa {
  conversa(id: number): Promise<ConversaDaPausa>;
  etiquetas(id: number, lista: string[]): Promise<void>;
  atribuir(id: number, usuario: number): Promise<void>;
  /** grava os atributos da conversa (o Chatwoot SUBSTITUI o objeto: mandar todos) */
  atributos(id: number, attrs: Record<string, unknown>): Promise<void>;
  nota(id: number, texto: string): Promise<void>;
  agora(): Date;
}

/** O Chatwoot, com o token da conta (eventos) ou com o login de quem clicou (painel: a atribuição sai no nome dela). */
export function portaDaPausaDoChatwoot(ctx: ContextoChatwoot, sessao: SessaoDoChatwoot | null = null): PortaDaPausa {
  const o = sessao ? { sessao } : {};
  return {
    async conversa(id) {
      const raw = (await chamar(ctx, 'GET', `conversations/${id}`, o)) as any;
      if (!raw || !numero(raw.id)) throw Object.assign(new Error('conversa não encontrada'), { status: 404 });
      return {
        etiquetas: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
        atendente: numero(raw?.meta?.assignee?.id),
        attrs: raw.custom_attributes && typeof raw.custom_attributes === 'object' ? { ...raw.custom_attributes } : {},
      };
    },
    async etiquetas(id, lista) {
      await chamar(ctx, 'POST', `conversations/${id}/labels`, { ...o, corpo: { labels: lista } });
    },
    async atribuir(id, usuario) {
      await chamar(ctx, 'POST', `conversations/${id}/assignments`, { ...o, corpo: { assignee_id: usuario } });
    },
    async atributos(id, attrs) {
      await chamar(ctx, 'POST', `conversations/${id}/custom_attributes`, { ...o, corpo: { custom_attributes: attrs } });
    },
    async nota(id, texto) {
      await chamar(ctx, 'POST', `conversations/${id}/messages`, { ...o, corpo: { content: texto, message_type: 'outgoing', private: true } });
    },
    agora: () => new Date(),
  };
}

const quemFoi = (a: AutorDaPausa) => (a.tipo === 'celular' ? 'respondeu pelo celular' : `${a.nome} assumiu o atendimento`);

/**
 * Pausa a IA na conversa. Já pausada: só garante que a conversa fica com quem respondeu (se foi uma pessoa). Devolve o que fez.
 * Ordem: etiqueta primeiro (é ela que cala a Sofia), depois atributos, atribuição e nota — se algo depois falhar, a IA já está calada.
 */
export async function pausar(conversa: number, autor: AutorDaPausa, p: PortaDaPausa): Promise<'pausou' | 'ja-pausada'> {
  const c = await p.conversa(conversa);
  const jaPausada = c.etiquetas.includes(ETIQUETA_PAUSA);
  if (!jaPausada) {
    await p.etiquetas(conversa, [...c.etiquetas, ETIQUETA_PAUSA]);
    const por = autor.tipo === 'pessoa' ? autor.nome : 'celular';
    await p.atributos(conversa, { ...c.attrs, ia_pausada_por: por, ia_pausada_em: p.agora().toISOString() }).catch((err) =>
      logger.warn({ err: String(err), conversa }, 'chatwoot-pausa: não consegui gravar quem pausou'),
    );
  }
  if (autor.tipo === 'pessoa' && c.atendente !== autor.id) await p.atribuir(conversa, autor.id);
  if (!jaPausada) await p.nota(conversa, `${NOTA_PAUSA} — ${quemFoi(autor)}. A Sofia não responde aqui até alguém reativar ou a conversa ser resolvida.`);
  return jaPausada ? 'ja-pausada' : 'pausou';
}

/** Tira a pausa. `quem` = nome de quem reativou (painel) ou null (conversa resolvida). */
export async function reativar(conversa: number, quem: string | null, p: PortaDaPausa): Promise<'reativou' | 'nao-estava-pausada'> {
  const c = await p.conversa(conversa);
  if (!c.etiquetas.includes(ETIQUETA_PAUSA)) return 'nao-estava-pausada';
  await p.etiquetas(conversa, c.etiquetas.filter((e) => e !== ETIQUETA_PAUSA));
  const { ia_pausada_por: _por, ia_pausada_em: _em, ...resto } = c.attrs;
  await p.atributos(conversa, resto).catch(() => undefined);
  await p.nota(conversa, quem ? `${NOTA_REATIVADA} por ${quem}.` : `${NOTA_REATIVADA}: a conversa foi resolvida.`);
  return 'reativou';
}

/** Estado para o painel: pausada? por quem e quando. */
export function estadoDaPausa(c: ConversaDaPausa): { pausada: boolean; por: string | null; em: string | null } {
  const pausada = c.etiquetas.includes(ETIQUETA_PAUSA);
  const por = typeof c.attrs.ia_pausada_por === 'string' ? c.attrs.ia_pausada_por : null;
  const em = typeof c.attrs.ia_pausada_em === 'string' ? c.attrs.ia_pausada_em : null;
  return { pausada, por: pausada ? por : null, em: pausada ? em : null };
}
