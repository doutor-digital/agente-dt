/**
 * O Chatwoot como a Sofia e a baixa do sinal o enxergam: ler a conversa (atributos, etiquetas, telefone), gravar atributos e
 * etiquetas SEM apagar o que já está lá (o Chatwoot substitui o objeto/lista inteiro), deixar nota privada, mandar mensagem
 * pública e ler as listas vivas (valores dos atributos, etiquetas da conta). Um lugar só: o que muda na API do Chatwoot muda aqui.
 */
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

export interface ConversaLida {
  id: number;
  nome: string;
  /** `+55…` do contato; null = o Chatwoot não tem (sem telefone a Sofia não responde) */
  telefone: string | null;
  attrs: Record<string, unknown>;
  etiquetas: string[];
  grupo: boolean;
  /**
   * Contato INTERNO (a equipe falando com o número da unidade: «libera», «acabando»): a conversa tem a etiqueta `interno` ou o contato
   * tem o atributo `interno` marcado. A Sofia não responde.
   */
  interno: boolean;
}

export interface PortaDoChatwoot {
  conversa(id: number): Promise<ConversaLida | null>;
  /** Mescla `parcial` nos atributos que a conversa tem AGORA (o Chatwoot substitui o objeto inteiro). */
  gravarAtributos(id: number, parcial: Record<string, unknown>): Promise<void>;
  /** Soma etiquetas às que a conversa já tem. */
  adicionarEtiquetas(id: number, etiquetas: string[]): Promise<void>;
  /** Nota PRIVADA. */
  nota(id: number, texto: string): Promise<void>;
  /** Mensagem PÚBLICA: chega ao paciente. Devolve o usuário do Chatwoot que a enviou (o da integração), se a resposta disser. */
  publica(id: number, texto: string): Promise<{ usuario: number | null }>;
  /** Os valores válidos de um atributo de lista (definição viva do Chatwoot); [] = não é lista ou não deu para ler. */
  valoresDoAtributo(chave: string): Promise<string[]>;
  /** As etiquetas que existem na conta. */
  etiquetasDaConta(): Promise<string[]>;
}

const ehSim = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && ['true', 'sim', '1', 'yes'].includes(v.trim().toLowerCase()));
export const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

export function conversaLidaDoChatwoot(raw: any): ConversaLida | null {
  const id = Number(raw?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const sender = raw?.meta?.sender ?? {};
  const adicionais = raw?.additional_attributes ?? {};
  const etiquetas: string[] = Array.isArray(raw?.labels) ? raw.labels.map(String) : [];
  const grupo = /@g\.us$/i.test(texto(sender.identifier)) || texto(adicionais.type).toLowerCase() === 'group' || adicionais.group === true;
  return {
    id,
    nome: texto(sender.name),
    telefone: texto(sender.phone_number) || null,
    attrs: raw?.custom_attributes && typeof raw.custom_attributes === 'object' ? { ...raw.custom_attributes } : {},
    etiquetas,
    grupo,
    interno: etiquetas.some((e) => e.trim().toLowerCase() === 'interno') || ehSim(sender.custom_attributes?.interno),
  };
}

const VALIDADE_LISTAS_MS = 5 * 60_000;

export function portaDoChatwoot(ctx: ContextoChatwoot): PortaDoChatwoot {
  const listas = new Map<string, { em: number; valores: string[] }>();
  let contaEtiquetas: { em: number; valores: string[] } | null = null;
  const ler = async (id: number) => conversaLidaDoChatwoot(await chamar(ctx, 'GET', `conversations/${id}`));
  return {
    conversa: ler,
    async gravarAtributos(id, parcial) {
      const atual = await ler(id);
      if (!atual) throw new Error(`conversa ${id} não encontrada no Chatwoot`);
      await chamar(ctx, 'POST', `conversations/${id}/custom_attributes`, { corpo: { custom_attributes: { ...atual.attrs, ...parcial } } });
    },
    async adicionarEtiquetas(id, etiquetas) {
      const atual = await ler(id);
      if (!atual) throw new Error(`conversa ${id} não encontrada no Chatwoot`);
      const lista = [...new Set([...atual.etiquetas, ...etiquetas])];
      if (lista.length !== atual.etiquetas.length) await chamar(ctx, 'POST', `conversations/${id}/labels`, { corpo: { labels: lista } });
    },
    async nota(id, t) {
      await chamar(ctx, 'POST', `conversations/${id}/messages`, { corpo: { content: t, message_type: 'outgoing', private: true } });
    },
    async publica(id, t) {
      const r = (await chamar(ctx, 'POST', `conversations/${id}/messages`, { corpo: { content: t, message_type: 'outgoing', private: false } })) as { sender?: { id?: unknown } } | null;
      const usuario = Number(r?.sender?.id);
      return { usuario: Number.isInteger(usuario) && usuario > 0 ? usuario : null };
    },
    async valoresDoAtributo(chave) {
      const g = listas.get(chave);
      if (g && Date.now() - g.em < VALIDADE_LISTAS_MS) return g.valores;
      const defs = (await chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: 'conversation_attribute' } })) as unknown;
      const lista = Array.isArray(defs) ? defs : [];
      const def = lista.find((d: any) => d?.attribute_key === chave) as { attribute_values?: unknown } | undefined;
      const valores = Array.isArray(def?.attribute_values) ? def!.attribute_values.map((v) => String(v).trim()).filter(Boolean) : [];
      listas.set(chave, { em: Date.now(), valores });
      return valores;
    },
    async etiquetasDaConta() {
      if (contaEtiquetas && Date.now() - contaEtiquetas.em < VALIDADE_LISTAS_MS) return contaEtiquetas.valores;
      const r = (await chamar(ctx, 'GET', 'labels')) as { payload?: unknown } | null;
      const valores = (Array.isArray(r?.payload) ? r.payload : []).map((l: any) => texto(l?.title)).filter(Boolean);
      contaEtiquetas = { em: Date.now(), valores };
      return valores;
    },
  };
}
