/**
 * Mensagem de cortesia: só agradecimento, despedida e saudação. Fica fora do `parados.ts` porque serve a mais de uma automação
 * (a volta de EM ESPERA, a prova de motivo da perda-ia) e quem só precisa DISTO não deve carregar o worker de prazos.
 */
// Só agradecimento, despedida e saudação. "sim", "pode ser", "tudo bem" ficam FORA: são resposta
// afirmativa à retomada ("quer que eu já marque?") e têm de trazer o cartão de volta.
const CORTESIA = new Set([
  'ok', 'okay', 'oks', 'okk', 'ta', 'tabom', 'blz', 'beleza', 'certo', 'combinado', 'valeu', 'vlw',
  'obrigado', 'obrigada', 'obg', 'brigado', 'brigada', 'grato', 'grata', 'gratidao', 'show', 'perfeito', 'otimo',
  'bom', 'dia', 'tarde', 'noite', 'boa', 'ate', 'logo', 'mais', 'amem', 'deus', 'abencoe', 'bjs', 'beijo', 'beijos',
  'abraco', 'abracos', 'igualmente', 'pra', 'voce', 'tambem',
]);

/** "ok, obrigado 🙏" não é o paciente voltando: não cancela a espera. */
export function ehRespostaDeCortesia(mensagem: string | null | undefined): boolean {
  const limpa = String(mensagem ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
  if (!limpa) return true;
  const palavras = limpa.split(/\s+/).filter(Boolean);
  if (palavras.length > 5) return false;
  return palavras.every((p) => CORTESIA.has(p));
}
