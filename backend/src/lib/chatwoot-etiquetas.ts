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
import { etapasDoContexto, nomeParaGravar, type MapaDeEtapas } from './chatwoot-etapas.js';
import { MOTIVO_POR_ETIQUETA, motivoNaLista } from './motivo-do-botao.js';

export const PREFIXO_PERDIDO = 'perdido-';
export const ETAPA_PERDIDO = 'Perdido';

export { MOTIVO_POR_ETIQUETA, motivoNaLista };

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
  if (!etiquetas.some((e) => Object.hasOwn(MOTIVO_POR_ETIQUETA, String(e)))) return null;
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
export function mudancaDaConversa(conv: any, opcoesDoMotivo?: readonly string[], mapa?: MapaDeEtapas | null): Mudanca | null {
  const etiquetas: string[] = Array.isArray(conv?.labels) ? conv.labels.map(String) : [];
  const comando = etiquetas.filter((e) => Object.hasOwn(MOTIVO_POR_ETIQUETA, e));
  if (!comando.length) return null;
  const motivo = motivoNaLista(MOTIVO_POR_ETIQUETA[comando[comando.length - 1]]!, opcoesDoMotivo);
  const atuais = conv?.custom_attributes && typeof conv.custom_attributes === 'object' ? conv.custom_attributes : {};
  return {
    // `atuais` são os atributos COMO O CHATWOOT OS TEM; a etapa nova vai com o nome que a conta dá ao papel Perdido
    atributos: { ...atuais, etapa: nomeParaGravar(mapa, ETAPA_PERDIDO) ?? ETAPA_PERDIDO, motivo_nao_agendamento: motivo },
    etiquetas: etiquetas.filter((e) => !(Object.hasOwn(MOTIVO_POR_ETIQUETA, e))),
    motivo,
  };
}

export interface PortasDaPonte {
  conversa(id: number): Promise<any>;
  gravarAtributos(id: number, atributos: Record<string, unknown>): Promise<void>;
  gravarEtiquetas(id: number, etiquetas: string[]): Promise<void>;
  /** as opções de `motivo_nao_agendamento` desta conta (opcional: sem isto vale o valor de sempre) */
  opcoesDoMotivo?(): Promise<string[]>;
  /** as etapas desta conta (opcional: sem isto, o molde) */
  mapaDeEtapas?: MapaDeEtapas;
}

/** As opções de `motivo_nao_agendamento` por conta, guardadas 60 s (um clique de «Perdido» não baixa as definições todas de novo). */
const opcoesGuardadas = new Map<number, { ate: number; v: string[] }>();

export function portasDaPonte(ctx: ContextoChatwoot): PortasDaPonte {
  return {
    // getter: o mapa de AGORA a cada clique (a ponte pode ficar guardada por mais tempo que a gravação do mapa)
    get mapaDeEtapas() {
      return etapasDoContexto(ctx);
    },
    conversa: (id) => chamar(ctx, 'GET', `conversations/${id}`),
    async gravarAtributos(id, atributos) {
      await chamar(ctx, 'POST', `conversations/${id}/custom_attributes`, { corpo: { custom_attributes: atributos } });
    },
    async opcoesDoMotivo() {
      const conta = ctx.conta?.conta ?? 0;
      const g = opcoesGuardadas.get(conta);
      if (g && g.ate > Date.now()) return g.v;
      const defs = (await chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: 'conversation_attribute' } })) as unknown;
      const def = (Array.isArray(defs) ? defs : []).find((d: any) => d?.attribute_key === 'motivo_nao_agendamento') as { attribute_values?: unknown } | undefined;
      const v = Array.isArray(def?.attribute_values) ? def!.attribute_values.map((x) => String(x).trim()).filter(Boolean) : [];
      // 60 s (o servidor e o kit são processos separados: o kit não consegue limpar esta memória, então ela vale pouco)
      opcoesGuardadas.set(conta, { ate: Date.now() + 60_000, v });
      return v;
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
    // sem etiqueta de Perdido não há o que gravar: nem lê a lista de motivos
    if (!(Array.isArray(conv?.labels) ? conv.labels : []).some((l: unknown) => Object.hasOwn(MOTIVO_POR_ETIQUETA, String(l)))) return 'nada';
    // a lista é só para escolher o NOME do motivo: se a leitura falhar, vale o valor de sempre (o botão nunca deixa de gravar por isso)
    let opcoes: string[] | undefined;
    try {
      opcoes = await p.opcoesDoMotivo?.();
    } catch {
      opcoes = undefined;
    }
    const m = mudancaDaConversa(conv, opcoes, p.mapaDeEtapas);
    if (!m) return 'nada';
    await p.gravarAtributos(e.conversa, m.atributos);
    await p.gravarEtiquetas(e.conversa, m.etiquetas);
    logger.info({ unit: e.slug, conversa: e.conversa, motivo: m.motivo }, 'chatwoot-etiquetas: Perdido gravado no cartão');
    return 'gravou';
  } finally {
    trava.delete(e.conversa);
  }
}
