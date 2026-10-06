/**
 * Uma unidade por FRANQUIA. No banco do agente a mesma franquia aparece mais de uma vez:
 * a unidade principal (`doutor-hernia-serra`), a de resgate (`serra-resgate`), financeiro,
 * tratamento — funis diferentes, mas o MESMO token da franquia e a MESMA conta do Kommo.
 * Medido em 06/10/2026: 25 linhas com token da franquia, 16 franquias. Sem isto, "todas"
 * contaria a Imperatriz três vezes.
 *
 * O laboratório (`laboratorio-kommo`) sai sempre: é conta de teste, não franquia.
 */
import type { Unidade } from '../franquia-mcp/unidade.js';

const DE_TESTE = /laborat|teste|homolog/;

/** Quanto MENOR, mais "principal": a unidade de verdade ganha da de resgate/financeiro/tratamento. */
function prioridade(slug: string): number {
  if (/resgate|financeiro|tratamento/.test(slug)) return 2;
  if (slug.startsWith('doutor-hernia-')) return 0;
  return 1;
}

export interface Agrupadas<T> {
  ficam: Map<string, T & { slugsDaFranquia: string[] }>;
  descartadas: Array<{ slug: string; mesmaFranquiaQue: string }>;
}

/** Agrupa por `chave` (token da franquia, subdomínio do Kommo) e fica com a principal de cada grupo. */
export function umaPorChave<T extends { slug: string }>(itens: T[], chave: (t: T) => string): Agrupadas<T> {
  const grupos = new Map<string, T[]>();
  for (const it of itens) {
    if (DE_TESTE.test(it.slug)) continue;
    const k = chave(it);
    grupos.set(k, [...(grupos.get(k) ?? []), it]);
  }
  const ficam = new Map<string, T & { slugsDaFranquia: string[] }>();
  const descartadas: Array<{ slug: string; mesmaFranquiaQue: string }> = [];
  for (const grupo of grupos.values()) {
    const ordenado = [...grupo].sort(
      (a, b) => prioridade(a.slug) - prioridade(b.slug) || a.slug.length - b.slug.length || a.slug.localeCompare(b.slug),
    );
    const [escolhida, ...resto] = ordenado;
    if (!escolhida) continue;
    ficam.set(escolhida.slug, { ...escolhida, slugsDaFranquia: ordenado.map((x) => x.slug) });
    for (const r of resto) descartadas.push({ slug: r.slug, mesmaFranquiaQue: escolhida.slug });
  }
  return { ficam: new Map([...ficam].sort((a, b) => a[0].localeCompare(b[0]))), descartadas };
}

/** O caso da franquia: chave = token. Devolve o formato que o contexto da franquia usa. */
export function umaPorToken(unidades: Unidade[]): { ficam: Map<string, Unidade>; descartadas: Array<{ slug: string; mesmaFranquiaQue: string }> } {
  const { ficam, descartadas } = umaPorChave(unidades, (u) => u.token);
  const limpas = new Map<string, Unidade>();
  for (const [slug, { slugsDaFranquia: _s, ...u }] of ficam) limpas.set(slug, u);
  return { ficam: limpas, descartadas };
}

/**
 * Slug exato, ou nome curto: "serra" acha "doutor-hernia-serra". Só vale se UMA casar.
 * Mesma regra do contexto da franquia, pra Kommo e cérebro.
 */
export function acharSlug(slugs: Iterable<string>, pedido: string): string | undefined {
  const p = pedido.trim().toLowerCase();
  const todos = [...slugs];
  if (todos.includes(p)) return p;
  if (!p) return undefined;
  const candidatos = todos.filter((s) => s.endsWith(`-${p}`));
  return candidatos.length === 1 ? candidatos[0] : undefined;
}
