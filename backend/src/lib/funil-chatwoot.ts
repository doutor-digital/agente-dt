/**
 * Funil de etapas do Chatwoot (pedido do João, 11/11/2026): o Chatwoot não tem quadro de etapas como o Kommo, e mexer no
 * código dele prenderia a gente numa versão. Então o funil é NOSSO, encaixado nele como "Dashboard App" (uma aba dentro da
 * conversa): a etapa mora num atributo personalizado da conversa (`etapa`, tipo lista — a Suzanne edita as etapas no próprio
 * Chatwoot) e o quadro lê/grava pela API da conta. Atualizar o Chatwoot não quebra nada.
 *
 * Aqui só a lógica pura (chave, montar o quadro); quem fala HTTP é `controllers/funil.controller.ts`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ATRIBUTO_ETAPA = 'etapa';
/** Etapas de partida, se o atributo ainda não existir no Chatwoot. A lista que vale é a do atributo. */
export const ETAPAS_PADRAO = ['Novo', 'Em atendimento', 'Aguardando paciente', 'Agendado', 'Compareceu', 'Fechou tratamento', 'Perdido'] as const;
/** Quantas páginas de conversa (25 cada) o quadro lê de uma vez. */
export const MAX_PAGINAS = 8;

/**
 * Chave do funil, derivada do token do Chatwoot que o servidor já tem (CHATWOOT_API_TOKEN): sem variável nova no .env. Vai na
 * URL do Dashboard App (o Chatwoot abre a página com ela) e no cabeçalho X-Funil-Chave das chamadas; o log mascara.
 */
export function chaveDoFunil(tokenChatwoot: string): string {
  return createHmac('sha256', tokenChatwoot).update('funil-v1').digest('hex').slice(0, 32);
}

export function chaveConfere(tokenChatwoot: string | undefined, recebida: unknown): boolean {
  if (!tokenChatwoot || typeof recebida !== 'string' || recebida.length !== 32) return false;
  const a = Buffer.from(chaveDoFunil(tokenChatwoot));
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A lista de etapas do atributo `etapa` (definições de atributo da conversa); sem ele, a padrão. */
export function etapasDoAtributo(definicoes: unknown): string[] {
  const lista = Array.isArray(definicoes) ? definicoes : [];
  const def = lista.find((d: any) => d?.attribute_key === ATRIBUTO_ETAPA) as { attribute_values?: unknown } | undefined;
  const vals = Array.isArray(def?.attribute_values) ? def!.attribute_values.map((v) => String(v).trim()).filter(Boolean) : [];
  return vals.length ? [...new Set(vals)] : [...ETAPAS_PADRAO];
}

export interface Cartao {
  id: number;
  nome: string;
  caixaId: number | null;
  etapa: string;
  status: string;
  responsavel: string | null;
  ultimaMensagem: string;
  /** segundos desde 1970 (como o Chatwoot manda) */
  atividade: number;
  etiquetas: string[];
}

function texto(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : '';
  const limpo = s.replace(/\s+/g, ' ').trim();
  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

/** Uma conversa do Chatwoot vira cartão. Etapa vazia ou fora da lista = a 1ª etapa (o lead novo cai em "Novo"). */
export function cartaoDaConversa(c: any, etapas: string[]): Cartao {
  const bruta = typeof c?.custom_attributes?.[ATRIBUTO_ETAPA] === 'string' ? c.custom_attributes[ATRIBUTO_ETAPA].trim() : '';
  const etapa = etapas.includes(bruta) ? bruta : etapas[0];
  const msgs = Array.isArray(c?.messages) ? c.messages : [];
  const ultima = msgs.length ? msgs[msgs.length - 1] : c?.last_non_activity_message;
  return {
    id: Number(c?.id),
    nome: texto(c?.meta?.sender?.name, 60) || `Conversa ${c?.id}`,
    caixaId: Number.isInteger(c?.inbox_id) ? c.inbox_id : null,
    etapa,
    status: String(c?.status ?? ''),
    responsavel: texto(c?.meta?.assignee?.name, 40) || null,
    ultimaMensagem: ultima?.private ? '(nota interna)' : texto(ultima?.content, 120),
    atividade: Number(c?.last_activity_at ?? c?.timestamp ?? 0) || 0,
    etiquetas: Array.isArray(c?.labels) ? c.labels.map(String).slice(0, 5) : [],
  };
}

/** Junta as páginas da API (`data.payload`), sem repetir conversa, e monta as colunas na ordem das etapas. */
export function montarQuadro(paginas: unknown[], etapas: string[]) {
  const vistos = new Set<number>();
  const cartoes: Cartao[] = [];
  for (const p of paginas) {
    const lista = (p as any)?.data?.payload ?? (p as any)?.payload ?? [];
    for (const c of Array.isArray(lista) ? lista : []) {
      const k = Number(c?.id);
      if (!Number.isInteger(k) || vistos.has(k)) continue;
      vistos.add(k);
      cartoes.push(cartaoDaConversa(c, etapas));
    }
  }
  cartoes.sort((a, b) => b.atividade - a.atividade);
  const colunas = etapas.map((etapa) => ({ etapa, cartoes: cartoes.filter((c) => c.etapa === etapa) }));
  return { etapas, total: cartoes.length, colunas };
}

/** Nota interna deixada na conversa a cada mudança (histórico de quem moveu e quando). */
export function notaDaMudanca(de: string, para: string, quem: string | null): string {
  return `📋 Etapa: ${de} → ${para}${quem ? ` (por ${quem})` : ''} — pelo funil`;
}
