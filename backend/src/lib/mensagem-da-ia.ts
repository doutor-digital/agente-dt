/**
 * "Esta mensagem `assistant` foi a IA conversando com o paciente?" — a regra, numa lista só.
 *
 * Por que existe: o banco guarda como `role = 'assistant'` tudo que NÃO é o paciente falando, e isso inclui coisas
 * que não são a Sofia: a fala da equipe copiada do chat oficial do Kommo, a confirmação de véspera, o cartão de
 * chegada e a resposta que virou nota interna (o paciente nunca leu). Duas partes do sistema precisam da mesma
 * resposta — o alerta "prometeu sem marcar" (`prometeu-sem-marcar.ts`, em JavaScript) e o resumo de qualidade
 * (`qualidade-ia/consulta.ts`, em SQL). Com duas listas elas divergem (já divergiram: o resumo contava resposta que
 * não chegou ao paciente como fala da Sofia). Aqui estão os dados; o JavaScript e o SQL leem a mesma lista, e o
 * teste de SQL (`qualidade-ia/consulta.sql.test.ts`) confere que os dois dão a mesma resposta para cada caso.
 *
 * Puro de propósito: sem banco, sem Prisma.
 */

/** `meta.origem` de mensagem que não é a IA: texto da equipe copiado do chat oficial / importação antiga do Kommo. */
export const ORIGENS_QUE_NAO_SAO_DA_IA = ['kommo_talks', 'backfill-kommo'] as const;
/** `meta.origem` que começa assim não é a IA conversando: a confirmação de véspera só sai para consulta que existe. */
export const PREFIXO_ORIGEM_QUE_NAO_E_DA_IA = 'confirmacao';
/** `meta.via`: o cartão de chegada só sai depois de marcar; `lead_note` virou nota interna, o paciente nunca leu. */
export const VIAS_QUE_NAO_SAO_DA_IA = ['chat_cartao', 'lead_note'] as const;
/** `meta.autor` de quem escreveu pela equipe. */
export const AUTOR_DA_EQUIPE = 'equipe';

/** Mensagens que são da IA, mas são envio automático (lembrete), não ela conversando. */
export const ORIGENS_AUTOMATICAS = ['lembrete_kommo'] as const;
/** Chaves de `meta` que marcam envio automático de retomada: degrau da régua e reativação. */
export const CHAVES_DE_RETOMADA = ['followUp', 'reactivation'] as const;

function lerMeta(meta: unknown): { origem: string; via: string; autor: unknown; bruto: Record<string, unknown> } {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
  return {
    origem: typeof m.origem === 'string' ? m.origem : '',
    via: typeof m.via === 'string' ? m.via : '',
    autor: m.autor,
    bruto: m,
  };
}

/**
 * Mensagens que não são da IA conversando — não entram:
 *  - `kommo_talks`/`backfill-kommo`: texto da equipe copiado do chat oficial do Kommo;
 *  - `confirmacao_*`: a confirmação de véspera só sai para consulta que existe;
 *  - `chat_cartao`: o cartão de chegada só sai depois de marcar;
 *  - `lead_note`: virou nota interna, o paciente nunca leu;
 *  - `autor = equipe`.
 */
export function mensagemDaIA(meta: unknown): boolean {
  const { origem, via, autor } = lerMeta(meta);
  if ((ORIGENS_QUE_NAO_SAO_DA_IA as readonly string[]).includes(origem) || origem.startsWith(PREFIXO_ORIGEM_QUE_NAO_E_DA_IA)) return false;
  if (autor === AUTOR_DA_EQUIPE) return false;
  if ((VIAS_QUE_NAO_SAO_DA_IA as readonly string[]).includes(via)) return false;
  return true;
}

/**
 * A Sofia CONVERSANDO: da IA, e não envio automático de retomada (régua, reativação) nem lembrete. É o que o resumo
 * de qualidade chama de "Sofia falou" — quem só recebeu toque da régua não teve conversa com ela.
 */
export function mensagemDaSofiaConversando(meta: unknown): boolean {
  if (!mensagemDaIA(meta)) return false;
  const { origem, bruto } = lerMeta(meta);
  if ((ORIGENS_AUTOMATICAS as readonly string[]).includes(origem)) return false;
  return !CHAVES_DE_RETOMADA.some((k) => bruto[k] != null);
}
