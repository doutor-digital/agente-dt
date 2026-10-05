/**
 * Unidade de atendimento pelo número de WhatsApp (05/10/2026, pedido do João).
 *
 * Petrópolis atende duas cidades num Kommo só: o número oficial (WhatsApp API) é Petrópolis e o número
 * conectado por QR code é Caxias. O Kommo sabe por qual canal cada conversa entrou (`source_id` da talk);
 * a SDR não sabe olhando o cartão. Este módulo decide, para cada cartão, a unidade pelo canal da PRIMEIRA
 * conversa e marca o campo "⌂ Unidade de atendimento" e a etiqueta da cidade.
 *
 * Regras:
 *  - Preenche buraco: campo já preenchido (pela SDR ou por nós) nunca é trocado — só compara (confere/diverge).
 *  - Vale a primeira conversa do cartão: quem começou por Caxias e depois escreveu no número de Petrópolis
 *    continua Caxias (a SDR corrige à mão se for o caso).
 *  - A etiqueta segue o CAMPO (o que está no cartão), não o canal: se a SDR corrigiu para Petrópolis, a
 *    etiqueta é PETRÓPOLIS.
 *  - Canal fora do mapa não decide nada (número novo conectado amanhã não vira "Petrópolis" por engano).
 */

export const CAMPO_UNIDADE = '⌂ Unidade de atendimento';

/** Por unidade do agente: `source_id` do canal no Kommo → nome da unidade (igual à opção do campo). */
export const CANAIS_POR_UNIDADE: Record<string, Record<number, string>> = {
  'doutor-hernia-petropolis': {
    5332: 'Petrópolis', // WhatsApp API oficial (waba)
    15410: 'Caxias', // WhatsApp por QR code (com.amocrm.amocrmwa), conectado em 05/10/2026
  },
};

/** A etiqueta da cidade: o nome em caixa alta ("Caxias" → "CAXIAS"). */
export const etiquetaDe = (unidade: string): string => unidade.toLocaleUpperCase('pt-BR');

export interface ConversaDoCartao {
  sourceId: number | null | undefined;
  criadaEm: number | null | undefined;
}

export type PlanoUnidade =
  | { acao: 'gravar'; unidade: string; etiqueta: string; motivo: string }
  | { acao: 'confere' | 'diverge'; unidade: string; noCartao: string; etiqueta: string | null; motivo: string };

/**
 * Puro. `noCartao` = valor atual do campo (null se vazio); `etiquetas` = as do cartão hoje.
 * Devolve null quando não há o que fazer (nenhuma conversa por canal conhecido).
 * `etiqueta` vem preenchida só quando falta no cartão.
 */
export function planejarUnidade(e: {
  conversas: ReadonlyArray<ConversaDoCartao>;
  mapa: Record<number, string>;
  noCartao: string | null;
  etiquetas: ReadonlyArray<string>;
}): PlanoUnidade | null {
  const conhecidas = e.conversas
    .filter((c) => typeof c.sourceId === 'number' && e.mapa[c.sourceId] !== undefined)
    .sort((a, b) => (a.criadaEm ?? Number.MAX_SAFE_INTEGER) - (b.criadaEm ?? Number.MAX_SAFE_INTEGER));
  if (conhecidas.length === 0) return null;
  const unidade = e.mapa[conhecidas[0].sourceId as number];
  const motivo = `primeira conversa pelo número de ${unidade}`;

  const tem = new Set(e.etiquetas.map((t) => t.trim().toLocaleUpperCase('pt-BR')));
  const falta = (u: string) => (tem.has(etiquetaDe(u)) ? null : etiquetaDe(u));

  if (!e.noCartao) return { acao: 'gravar', unidade, etiqueta: etiquetaDe(unidade), motivo };
  const igual = e.noCartao.trim().toLocaleLowerCase('pt-BR') === unidade.toLocaleLowerCase('pt-BR');
  // a etiqueta acompanha o que está no cartão (a correção da SDR vence o canal)
  return { acao: igual ? 'confere' : 'diverge', unidade, noCartao: e.noCartao, etiqueta: falta(e.noCartao), motivo };
}
