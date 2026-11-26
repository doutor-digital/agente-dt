/**
 * O Chatwoot como a Sofia e a baixa do sinal o enxergam: ler a conversa (atributos, etiquetas, telefone), gravar atributos e
 * etiquetas SEM apagar o que já está lá (o Chatwoot substitui o objeto/lista inteiro), deixar nota privada, mandar mensagem
 * pública e ler as listas vivas (valores dos atributos, etiquetas da conta). Um lugar só: o que muda na API do Chatwoot muda aqui.
 */
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { GERENTE_DA_CAIXA } from './chatwoot-unidades.js';
import { atributosParaGravar, etapasDoContexto, papeisDaLista, papeisDoTratamentoDaLista, papeisDosAtributos, type MapaDeEtapas } from './chatwoot-etapas.js';

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

// ── etiquetas: UMA gravação por vez por conversa ───────────────────────────────────────────────────────────────────
// O Chatwoot SUBSTITUI a lista de etiquetas. Quem soma ou tira uma etiqueta lê a lista e regrava: se dois fazem isso ao mesmo tempo (o anúncio, o formulário,
// a Sofia que passou a atender), o último a gravar desfaz o outro. Aqui as gravações de UMA conversa entram em fila neste processo, e cada uma relê a lista
// DENTRO da fila — então nenhuma regrava uma lista velha. (Escritor fora desta fila segue como antes: a fila vale para quem a usa.)
const filasDeEtiquetas = new Map<string, Promise<unknown>>();

export function emFilaDeEtiquetas<T>(conta: number | undefined, conversa: number, fn: () => Promise<T>): Promise<T> {
  const chave = `${conta ?? 0}:${conversa}`;
  const minha = (filasDeEtiquetas.get(chave) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const cauda = minha.catch(() => undefined);
  filasDeEtiquetas.set(chave, cauda);
  void cauda.then(() => {
    if (filasDeEtiquetas.get(chave) === cauda) filasDeEtiquetas.delete(chave);
  });
  return minha;
}

/** Soma e/ou tira etiquetas da conversa: relê a lista na fila e só grava se algo mudou. Lança se a conversa não existe. */
export async function mudarEtiquetas(ctx: ContextoChatwoot, id: number, somar: readonly string[], tirar: readonly string[] = []): Promise<void> {
  await emFilaDeEtiquetas(ctx.conta?.conta, id, async () => {
    const raw = (await chamar(ctx, 'GET', `conversations/${id}`)) as { id?: unknown; labels?: unknown } | null;
    if (!raw || !Number.isInteger(Number(raw.id))) throw new Error(`conversa ${id} não encontrada no Chatwoot`);
    const atual = Array.isArray(raw.labels) ? raw.labels.map(String) : [];
    const lista = [...new Set([...atual.filter((e) => !tirar.includes(e)), ...somar])];
    if (lista.length !== atual.length || lista.some((e, i) => e !== atual[i])) await chamar(ctx, 'POST', `conversations/${id}/labels`, { corpo: { labels: lista } });
  });
}

export interface PortaDoChatwoot {
  conversa(id: number): Promise<ConversaLida | null>;
  /** Mescla `parcial` nos atributos que a conversa tem AGORA (o Chatwoot substitui o objeto inteiro). */
  gravarAtributos(id: number, parcial: Record<string, unknown>): Promise<void>;
  /** Soma etiquetas às que a conversa já tem. */
  adicionarEtiquetas(id: number, etiquetas: string[]): Promise<void>;
  /** Tira etiquetas (e só elas) da lista que a conversa tem AGORA; sem a etiqueta, não grava nada. */
  removerEtiquetas?(id: number, etiquetas: string[]): Promise<void>;
  /** Nota PRIVADA. */
  nota(id: number, texto: string): Promise<void>;
  /** Mensagem PÚBLICA: chega ao paciente. Devolve o usuário do Chatwoot que a enviou (o da integração) e o id da mensagem, se a resposta disser. */
  publica(id: number, texto: string, marca?: Record<string, unknown>): Promise<{ usuario: number | null; mensagem?: number | null }>;
  /** Os valores válidos de um atributo de lista (definição viva do Chatwoot); [] = não é lista ou não deu para ler. */
  valoresDoAtributo(chave: string): Promise<string[]>;
  /** As etiquetas que existem na conta. */
  etiquetasDaConta(): Promise<string[]>;
  /**
   * Quem deve ser AVISADO (menção em nota privada) quando a Sofia passa a conversa: o responsável de agora (rodízio) ou, se não houver, a gerente
   * da caixa. null = ninguém para mencionar. Opcional: portas que não sabem não mencionam.
   */
  destinoDaPassagem?(id: number): Promise<{ id: number; nome: string } | null>;
}

/** O usuário «Conector Claude» (por onde saem Sofia e régua): nunca é quem vai atender. */
const USUARIO_DA_INTEGRACAO = 2;

const ehSim = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && ['true', 'sim', '1', 'yes'].includes(v.trim().toLowerCase()));
export const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

export function conversaLidaDoChatwoot(raw: any, mapa?: MapaDeEtapas | null): ConversaLida | null {
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
    // `etapa` / `etapa_tratamento` em PAPÉIS (a Sofia e o resto só conhecem papéis); sem mapa, como veio
    attrs: raw?.custom_attributes && typeof raw.custom_attributes === 'object' ? { ...papeisDosAtributos(mapa, raw.custom_attributes) } : {},
    etiquetas,
    grupo,
    interno: etiquetas.some((e) => e.trim().toLowerCase() === 'interno') || ehSim(sender.custom_attributes?.interno),
  };
}

const VALIDADE_LISTAS_MS = 5 * 60_000;

export function portaDoChatwoot(ctx: ContextoChatwoot): PortaDoChatwoot {
  const listas = new Map<string, { em: number; valores: string[] }>();
  let contaEtiquetas: { em: number; valores: string[] } | null = null;
  // o mapa é pedido a CADA chamada (a porta fica guardada em cache por conta e vive mais que a gravação do mapa: o servidor relê a configuração de minuto em minuto)
  const mapa = (): MapaDeEtapas => etapasDoContexto(ctx);
  const ler = async (id: number) => conversaLidaDoChatwoot(await chamar(ctx, 'GET', `conversations/${id}`), mapa());
  /** a conversa COMO O CHATWOOT A TEM (nomes da conta): é o que se mescla na gravação, para nunca regravar uma etapa que ninguém pediu para mudar */
  const lerCrua = async (id: number) => conversaLidaDoChatwoot(await chamar(ctx, 'GET', `conversations/${id}`));
  return {
    conversa: ler,
    async gravarAtributos(id, parcial) {
      const atual = await lerCrua(id);
      if (!atual) throw new Error(`conversa ${id} não encontrada no Chatwoot`);
      // papel → nome da conta; papel que a conta não tem sai da gravação (a etapa de agora fica); sem mapa, `parcial` segue igual
      await chamar(ctx, 'POST', `conversations/${id}/custom_attributes`, { corpo: { custom_attributes: { ...atual.attrs, ...atributosParaGravar(mapa(), parcial) } } });
    },
    adicionarEtiquetas: (id, etiquetas) => mudarEtiquetas(ctx, id, etiquetas),
    removerEtiquetas: (id, etiquetas) => mudarEtiquetas(ctx, id, [], etiquetas),
    async nota(id, t) {
      await chamar(ctx, 'POST', `conversations/${id}/messages`, { corpo: { content: t, message_type: 'outgoing', private: true } });
    },
    async publica(id, t, marca) {
      // `marca` vai em content_attributes (o CRM lê para rotular o balão: «✨ Sofia (IA)» mesmo quando sai pelo usuário conector)
      const r = (await chamar(ctx, 'POST', `conversations/${id}/messages`, { corpo: { content: t, message_type: 'outgoing', private: false, ...(marca ? { content_attributes: marca } : {}) } })) as {
        id?: unknown;
        sender?: { id?: unknown };
      } | null;
      const usuario = Number(r?.sender?.id);
      const mensagem = Number(r?.id);
      return { usuario: Number.isInteger(usuario) && usuario > 0 ? usuario : null, mensagem: Number.isInteger(mensagem) && mensagem > 0 ? mensagem : null };
    },
    async valoresDoAtributo(chave) {
      const g = listas.get(chave);
      // a lista guardada é a do Chatwoot (nomes da conta); a tradução para papéis é feita a cada pergunta, com o mapa de AGORA
      const traduz = (v: string[]): string[] => (chave === 'etapa' ? papeisDaLista(mapa(), v) : chave === 'etapa_tratamento' ? papeisDoTratamentoDaLista(mapa(), v) : v);
      if (g && Date.now() - g.em < VALIDADE_LISTAS_MS) return traduz(g.valores);
      const defs = (await chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: 'conversation_attribute' } })) as unknown;
      const lista = Array.isArray(defs) ? defs : [];
      const def = lista.find((d: any) => d?.attribute_key === chave) as { attribute_values?: unknown } | undefined;
      const doChatwoot = Array.isArray(def?.attribute_values) ? def!.attribute_values.map((v) => String(v).trim()).filter(Boolean) : [];
      // a pergunta é «esta conta tem a etapa X?»: `etapa` volta em PAPÉIS (o que a conta não tem não aparece); `etapa_tratamento` idem
      listas.set(chave, { em: Date.now(), valores: doChatwoot });
      return traduz(doChatwoot);
    },
    async destinoDaPassagem(id) {
      const raw = (await chamar(ctx, 'GET', `conversations/${id}`)) as { inbox_id?: unknown; meta?: { assignee?: { id?: unknown; name?: unknown } | null } } | null;
      const dono = Number(raw?.meta?.assignee?.id);
      if (Number.isInteger(dono) && dono > 0 && dono !== USUARIO_DA_INTEGRACAO) return { id: dono, nome: texto(raw?.meta?.assignee?.name) || 'equipe' };
      const gerente = GERENTE_DA_CAIXA[Number(raw?.inbox_id)];
      if (!gerente) return null;
      const agentes = (await chamar(ctx, 'GET', 'agents').catch(() => null)) as Array<{ id?: unknown; name?: unknown }> | null;
      const nome = Array.isArray(agentes) ? texto(agentes.find((a) => Number(a?.id) === gerente)?.name) : '';
      return { id: gerente, nome: nome || 'gerente' };
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
