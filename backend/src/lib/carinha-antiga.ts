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
  const raw = (lista ?? '').trim();
  if (!raw || !slug) return false;
  const itens = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return itens.has('*') || itens.has(slug);
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
