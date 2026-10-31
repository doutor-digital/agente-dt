/**
 * Tira o que identifica o paciente ANTES de qualquer texto ir para a IA: telefone, e-mail, CPF e o nome do paciente
 * (o do título do cartão e/ou do contato). Vale para a conversa, para a pergunta da atendente, para o histórico e
 * para o valor dos campos de texto do cartão. Não é anonimização perfeita — por isso o que vai para a IA é só o
 * necessário —, mas tira o que é fácil de achar.
 */

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// 123.456.789-09 · 12345678909 · 123 456 789 09 · 123.456.789/09
const CPF = /(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-/\s]?\d{2}(?!\d)/g;
// (21) 98472-5300 · (21) 9 8472-5300 · 21 9 8472 5300 · +55 21 98472-5300 · 98472-5300 · 3322-1100 (DDD e o 9 são opcionais)
const TELEFONE = /(?<!\d)(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?[\s.-]?\d{4}[\s.-]?\d{4}(?!\d)/g;

/**
 * Uma unidade UTF-16 de entrada → uma de saída (sem acento, minúscula): o texto dobrado tem SEMPRE o mesmo tamanho do
 * original, mesmo com emoji (que ocupa duas unidades). Por isso é `split('')` e não `Array.from`.
 */
const dobra = (s: string) => s.split('').map((c) => c.normalize('NFD')[0]!.toLowerCase()).join('');

/** Palavras do nome que valem trocar: 3+ letras e fora de partículas comuns. */
function partesDoNome(nomes: string[]): string[] {
  const particulas = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'lead', 'novo', 'paciente', 'sr', 'sra']);
  const out = new Map<string, string>();
  for (const n of nomes) {
    for (const p of n.split(/[\s,.-]+/)) {
      const t = dobra(p.trim());
      if (t.length >= 3 && !particulas.has(t) && !/^\d+$/.test(t)) out.set(t, t);
    }
  }
  return [...out.keys()].sort((a, b) => b.length - a.length);
}

export function anonimizar(texto: string, nomesDoPaciente: string[] = []): string {
  let t = texto.replace(EMAIL, '[e-mail]').replace(CPF, '[documento]').replace(TELEFONE, '[telefone]');
  const partes = partesDoNome(nomesDoPaciente);
  if (!partes.length) return t;
  // procura no texto dobrado (sem acento, sem caixa) e troca a mesma posição no original
  const dobrado = dobra(t);
  const faixas: Array<[number, number]> = [];
  for (const p of partes) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of dobrado.matchAll(re)) faixas.push([m.index!, m.index! + m[0].length]);
  }
  faixas.sort((a, b) => b[0] - a[0]);
  let fim = Infinity;
  for (const [i, j] of faixas) {
    if (j > fim) continue; // sobreposição: já trocado por uma parte maior
    t = t.slice(0, i) + '[paciente]' + t.slice(j);
    fim = i;
  }
  return t;
}
