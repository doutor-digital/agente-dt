/**
 * Tira da conversa o que identifica o paciente ANTES de ela ir para a IA (decisão de privacidade do Copiloto):
 * telefone, e-mail, CPF e o nome do paciente (o que está no título do cartão e/ou no contato).
 * Não é anonimização perfeita — por isso o que foi enviado fica registrado — mas tira o que é fácil de achar.
 */

const TELEFONE = /(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

const sem = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palavras do nome que valem trocar: 3+ letras e fora de partículas comuns. */
function partesDoNome(nomes: string[]): string[] {
  const particulas = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'lead', 'novo', 'paciente', 'sr', 'sra']);
  const out = new Set<string>();
  for (const n of nomes) {
    for (const p of n.split(/[\s,.-]+/)) {
      const t = p.trim();
      if (t.length >= 3 && !particulas.has(sem(t)) && !/^\d+$/.test(t)) out.add(t);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function anonimizar(texto: string, nomesDoPaciente: string[] = []): string {
  let t = texto.replace(EMAIL, '[e-mail]').replace(CPF, '[documento]').replace(TELEFONE, '[telefone]');
  for (const p of partesDoNome(nomesDoPaciente)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    t = t.replace(re, '[paciente]');
  }
  return t;
}
