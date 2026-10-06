/**
 * Uma unidade por FRANQUIA. No banco do agente, a mesma franquia aparece mais de uma vez com o
 * mesmo token: a unidade principal (`doutor-hernia-serra`), a de resgate (`serra-resgate`, outro
 * funil no Kommo) e até o laboratório (`laboratorio-kommo`, com o token da Imperatriz). Medido em
 * 06/10/2026: 25 linhas, 16 franquias. Sem isto, "todas" contaria a Imperatriz três vezes.
 */
import type { Unidade } from '../franquia-mcp/unidade.js';

/** Quanto MENOR, mais "principal": a unidade de verdade ganha da de resgate e do laboratório. */
function prioridade(slug: string): number {
  if (/resgate|laborat|teste|homolog/.test(slug)) return 2;
  if (slug.startsWith('doutor-hernia-')) return 0;
  return 1;
}

export function umaPorToken(unidades: Unidade[]): { ficam: Map<string, Unidade>; descartadas: Array<{ slug: string; mesmaFranquiaQue: string }> } {
  const porToken = new Map<string, Unidade[]>();
  for (const u of unidades) porToken.set(u.token, [...(porToken.get(u.token) ?? []), u]);

  const ficam = new Map<string, Unidade>();
  const descartadas: Array<{ slug: string; mesmaFranquiaQue: string }> = [];
  for (const grupo of porToken.values()) {
    const [escolhida, ...resto] = [...grupo].sort(
      (a, b) => prioridade(a.slug) - prioridade(b.slug) || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug),
    );
    if (!escolhida) continue;
    ficam.set(escolhida.slug, escolhida);
    for (const r of resto) descartadas.push({ slug: r.slug, mesmaFranquiaQue: escolhida.slug });
  }
  return { ficam: new Map([...ficam].sort((a, b) => a[0].localeCompare(b[0]))), descartadas };
}
