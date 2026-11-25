/**
 * Ponte etiqueta → cartão no Chatwoot (decisão do João, 12/11/2026, item 24).
 *
 * Macro do Chatwoot não grava atributo de conversa: só põe etiqueta, nota, status. Então os botões "Perdido: <motivo>" põem a
 * etiqueta `perdido-<motivo>` e esta ponte, ao receber o `conversation_updated` (o Chatwoot dispara quando a lista de etiquetas
 * muda), grava no cartão `etapa = Perdido` + `motivo_nao_agendamento = <motivo>` e TIRA a etiqueta. A etiqueta é só o comando:
 * se ficasse, uma conversa reaberta e movida no funil voltaria para Perdido no próximo evento.
 *
 * Mesmo receptor da `chatwoot-ia` (`POST /api/public/chatwoot/evento`); o webhook da conta precisa assinar `conversation_updated`.
 * Só caixas do mapa (`CAIXAS_REGUA`). Sem chave de seco: é o clique da pessoa, não decisão de robô.
 * Idempotente: relê a conversa antes de gravar; sem a etiqueta na leitura fresca, não faz nada (dois eventos do mesmo clique).
 */
import { logger } from './logger.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';

export const PREFIXO_PERDIDO = 'perdido-';
export const ETAPA_PERDIDO = 'Perdido';

/** etiqueta do botão → valor do atributo `motivo_nao_agendamento` (tem que existir na lista do atributo) */
export const MOTIVO_POR_ETIQUETA: Readonly<Record<string, string>> = {
  'perdido-sem-interesse': 'Sem interesse',
  'perdido-outra-cidade': 'Outra cidade',
  'perdido-plano-de-saude': 'Plano de saúde',
  'perdido-nao-deu-continuidade': 'Não deu continuidade',
};

/** Outros nomes que a MESMA razão tem em listas que seguem o Kommo da clínica («Plano de Saúde», «Não deu continuidade ao atendimento»). */
const ALIAS_DO_MOTIVO: Readonly<Record<string, readonly string[]>> = {
  'Não deu continuidade': ['Não deu continuidade ao atendimento'],
  'Plano de saúde': ['Plano de Saúde'],
};
const semAcentoNemCaixa = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/**
 * O valor que o botão grava, escolhido na lista REAL do atributo da conta: o próprio valor se a lista o tem; senão a opção que só difere em caixa/acento ou o outro nome da mesma razão;
 * senão (lista desconhecida ou sem nada parecido) o valor de sempre. Assim uma conta com a lista do Kommo («Plano de Saúde») não fica com o botão gravando um valor que a tela não mostra.
 */
export function motivoNaLista(padrao: string, opcoes: readonly string[] | undefined): string {
  if (!opcoes?.length || opcoes.includes(padrao)) return padrao;
  const alvos = [padrao, ...(ALIAS_DO_MOTIVO[padrao] ?? [])].map(semAcentoNemCaixa);
  return opcoes.find((o) => alvos.includes(semAcentoNemCaixa(o))) ?? padrao;
}

export interface EventoDeEtiqueta {
  conversa: number;
  slug: string;
}

/** Corpo do webhook → conversa de caixa do mapa que tem etiqueta de Perdido, ou null. */
export function eventoDeEtiqueta(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): EventoDeEtiqueta | null {
  if (corpo?.event !== 'conversation_updated') return null;
  const conversa = Number(corpo?.id);
  const slug = caixas[Number(corpo?.inbox_id)];
  if (!Number.isInteger(conversa) || conversa <= 0 || !slug) return null;
  const etiquetas: unknown[] = Array.isArray(corpo?.labels) ? corpo.labels : [];
  if (!etiquetas.some((e) => String(e) in MOTIVO_POR_ETIQUETA)) return null;
  return { conversa, slug };
}

export interface Mudanca {
  atributos: Record<string, unknown>;
  etiquetas: string[];
  motivo: string;
}

/**
 * Leitura fresca da conversa → o que gravar, ou null se não há etiqueta de Perdido (já tratada).
 * Duas etiquetas de Perdido juntas: vale a última da lista. Todas as `perdido-*` saem; as outras etiquetas ficam.
 */
export function mudancaDaConversa(conv: any, opcoesDoMotivo?: readonly string[]): Mudanca | null {
  const etiquetas: string[] = Array.isArray(conv?.labels) ? conv.labels.map(String) : [];
  const comando = etiquetas.filter((e) => e in MOTIVO_POR_ETIQUETA);
  if (!comando.length) return null;
  const motivo = motivoNaLista(MOTIVO_POR_ETIQUETA[comando[comando.length - 1]]!, opcoesDoMotivo);
  const atuais = conv?.custom_attributes && typeof conv.custom_attributes === 'object' ? conv.custom_attributes : {};
  return {
    atributos: { ...atuais, etapa: ETAPA_PERDIDO, motivo_nao_agendamento: motivo },
    etiquetas: etiquetas.filter((e) => !(e in MOTIVO_POR_ETIQUETA)),
    motivo,
  };
}

export interface PortasDaPonte {
  conversa(id: number): Promise<any>;
  gravarAtributos(id: number, atributos: Record<string, unknown>): Promise<void>;
  gravarEtiquetas(id: number, etiquetas: string[]): Promise<void>;
  /** as opções de `motivo_nao_agendamento` desta conta (opcional: sem isto vale o valor de sempre) */
  opcoesDoMotivo?(): Promise<string[]>;
}

export function portasDaPonte(ctx: ContextoChatwoot): PortasDaPonte {
  return {
    conversa: (id) => chamar(ctx, 'GET', `conversations/${id}`),
    async gravarAtributos(id, atributos) {
      await chamar(ctx, 'POST', `conversations/${id}/custom_attributes`, { corpo: { custom_attributes: atributos } });
    },
    async opcoesDoMotivo() {
      const defs = (await chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: 'conversation_attribute' } })) as unknown;
      const def = (Array.isArray(defs) ? defs : []).find((d: any) => d?.attribute_key === 'motivo_nao_agendamento') as { attribute_values?: unknown } | undefined;
      return Array.isArray(def?.attribute_values) ? def!.attribute_values.map((v) => String(v).trim()).filter(Boolean) : [];
    },
    async gravarEtiquetas(id, etiquetas) {
      await chamar(ctx, 'POST', `conversations/${id}/labels`, { corpo: { labels: etiquetas } });
    },
  };
}

const emAndamento = new Set<number>();

/** Aplica o comando da etiqueta. Uma conversa por vez (o mesmo clique gera mais de um evento). */
export async function aplicarEtiqueta(e: EventoDeEtiqueta, p: PortasDaPonte, trava: Set<number> = emAndamento): Promise<'gravou' | 'nada' | 'ocupado'> {
  if (trava.has(e.conversa)) return 'ocupado';
  trava.add(e.conversa);
  try {
    const conv = await p.conversa(e.conversa);
    // a lista é só para escolher o NOME do motivo: se a leitura falhar, vale o valor de sempre (o botão nunca deixa de gravar por isso)
    const opcoes = await p.opcoesDoMotivo?.().catch(() => undefined);
    const m = mudancaDaConversa(conv, opcoes);
    if (!m) return 'nada';
    await p.gravarAtributos(e.conversa, m.atributos);
    await p.gravarEtiquetas(e.conversa, m.etiquetas);
    logger.info({ unit: e.slug, conversa: e.conversa, motivo: m.motivo }, 'chatwoot-etiquetas: Perdido gravado no cartão');
    return 'gravou';
  } finally {
    trava.delete(e.conversa);
  }
}
