import { automacaoLigada } from './automacoes-estado.js';
/**
 * A carinha `☺` que entrega o robô.
 *
 * A Sofia escreve 😊 e 😢 como qualquer pessoa escreveria. Só que o banco do
 * Kommo cortava emoji de 4 bytes, então o nosso código troca esses emoji por
 * equivalentes antigos de 1 byte: 😊 vira `☺`, 😢 vira `☹`. O remédio ficou pior
 * que a doença — `☺` é um glifo preto e branco dos anos 90, e no WhatsApp, no
 * meio de uma conversa, não existe ser humano que digite aquilo.
 *
 * Medido em Taubaté (21/09/2026): `☺` ou `☹` em 578 das 802 respostas da semana,
 * 72%. A clínica escreveu: "tá muito na cara que é robô".
 *
 * A saída é remover em vez de rebaixar. Perder o sorriso é melhor que parecer
 * máquina — e continua sem quebrar o banco do Kommo, que é o motivo de o
 * rebaixamento existir.
 *
 * Por unidade porque o João pediu Taubaté primeiro, pra ver o efeito antes de
 * levar pra rede. Mesmo formato das outras listas: vírgula separa, `*` liga em
 * todas, vazio mantém o comportamento antigo.
 */

export function semCarinhaLigado(slug: string | null | undefined, lista = process.env.SEM_CARINHA_SLUGS): boolean {
  if (!slug) return false;
  return automacaoLigada(slug, 'sem-carinha', lista);
}

/** Os emoji que o rebaixamento transformava em `☺`/`☹`, mais os próprios glifos. */
const CARINHAS = /[☺☹\u{1F60A}\u{1F600}\u{1F603}\u{1F604}\u{1F642}\u{1F601}\u{1F622}\u{1F61E}\u{1F614}\u{1F641}\u{1F61F}][︎️]?/gu;

/** Tira as carinhas sem deixar espaço sobrando nem pontuação solta. */
export function semCarinha(texto: string): string {
  if (!texto) return texto;
  return texto
    .replace(CARINHAS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * O sorriso COLORIDO da confirmação de Timbó: ☺ (U+263A) + U+FE0F (seletor de variação 16).
 *
 * `downgradeEmoji` tira o U+FE0F de tudo que envia (e `semCarinha` apaga o ☺ inteiro onde a carinha antiga está desligada).
 * Sem o U+FE0F o WhatsApp mostra o glifo preto e branco; com ele, o emoji colorido que o João pediu no fecho da confirmação
 * ("Até breve! ☺️", 03/11/2026). O par é BMP (3 + 3 bytes) — não tem o problema dos 4 bytes do Kommo.
 *
 * Só onde a automação `sorriso-colorido` está ligada para a unidade (SORRISO_COLORIDO_SLUGS ou a tela de Automações). Nas
 * demais o envio é o de sempre: o U+FE0F cai e o ☺ puro segue o destino de antes.
 */
export function sorrisoColoridoLigado(slug: string | null | undefined, lista = process.env.SORRISO_COLORIDO_SLUGS): boolean {
  if (!slug) return false;
  return automacaoLigada(slug, 'sorriso-colorido', lista);
}

const SORRISO_COLORIDO = '\u263A\uFE0F';
/** Marca de uso privado (BMP, 1 unidade): nenhum dos saneadores a conhece, então atravessa todos intacta. */
const MARCA_DO_SORRISO = '\uE000';

/**
 * Roda `transforma` (os saneadores de emoji do envio) sem deixar que ela estrague o ☺️ colorido — só onde a unidade o permite.
 * Fora disso, ou sem o par no texto, é só `transforma(texto)`.
 */
export function preservandoSorrisoColorido(
  slug: string | null | undefined,
  texto: string,
  transforma: (t: string) => string,
): string {
  if (!texto.includes(SORRISO_COLORIDO) || !sorrisoColoridoLigado(slug)) return transforma(texto);
  return transforma(texto.replaceAll(SORRISO_COLORIDO, MARCA_DO_SORRISO)).replaceAll(MARCA_DO_SORRISO, SORRISO_COLORIDO);
}
