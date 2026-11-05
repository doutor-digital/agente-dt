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

/** Sem acento, minúsculas, só letras e números separados por hífen: "Rio Verde" → ["rio","verde"]. */
function pedacos(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Funil de apoio da mesma franquia: nunca é a resposta de um nome curto ("imperatriz" não é imperatriz-financeiro). */
const DE_APOIO = /^(resgate|financeiro|tratamento)$/;

/**
 * Nomes que o pessoal usa e que não aparecem no slug (medido em `mcp_auditoria`, out/2026): "porto nacional" é o
 * `doutor-hernia-porto`; "trauma" é o `default` (o Kommo do Instituto Trauma). Só valem se o alvo estiver na lista
 * que a ferramenta tem (a Taubaté não tem Asaas: o apelido não inventa conta), e um slug real com o mesmo nome ganha dele.
 */
const APELIDOS: Record<string, string> = {
  portonacional: 'doutor-hernia-porto',
  doutorherniaportonacional: 'doutor-hernia-porto',
  trauma: 'default',
  institutotrauma: 'default',
};

/**
 * Slug exato, ou nome curto: "serra" acha "doutor-hernia-serra". Só vale se UMA casar — ambíguo é recusa, nunca palpite.
 * Aceita o nome como a pessoa escreve: com espaço, acento ou sem hífen ("Rio Verde", "boa vista", "Timbó" →
 * doutor-hernia-rioverde, doutor-hernia-boa-vista, doutor-hernia-timbo). O nome curto casa por PEDAÇOS inteiros do
 * slug (o fim: "vista" e "boa vista"; o começo: "hm" → hm-tecnologia), nunca por pedaço de palavra. Resgate,
 * financeiro e tratamento só respondem pelo slug inteiro.
 * Mesma regra do contexto da franquia, pra Kommo e cérebro.
 */
export function acharSlug(slugs: Iterable<string>, pedido: string): string | undefined {
  const p = pedido.trim().toLowerCase();
  const todos = [...slugs];
  if (todos.includes(p)) return p;
  if (!p) return undefined;
  const chave = pedacos(p).join('');
  if (!chave) return undefined;
  const unico = (lista: string[]) => (lista.length === 1 ? lista[0] : undefined);
  const lidos = todos.map((slug) => ({ slug, partes: pedacos(slug) }));

  // o mesmo nome escrito de outro jeito: "rio verde", "rio-verde", "Marabá", "Doutor Digital"
  const iguais = lidos.filter((l) => l.partes.join('') === chave).map((l) => l.slug);
  if (iguais.length) return unico(iguais);

  // o que sobra é nome curto, e só as principais respondem por ele ("resgate" sozinho não casa com nenhuma)
  const principais = lidos.filter((l) => !l.partes.some((x) => DE_APOIO.test(x)));
  const pelasPontas = (fim: boolean) =>
    principais
      .filter((l) => l.partes.some((_, i) => (fim ? l.partes.slice(-(i + 1)) : l.partes.slice(0, i + 1)).join('') === chave))
      .map((l) => l.slug);
  // "serra" acha doutor-hernia-serra; se mais de uma casar pelo fim, é ambíguo (não tenta o começo)
  const pelofim = pelasPontas(true);
  if (pelofim.length) return unico(pelofim);
  // "hm" acha "hm-tecnologia": o nome curto da empresa vem antes do hífen, ao contrário das clínicas
  const pelocomeco = pelasPontas(false);
  if (pelocomeco.length) return unico(pelocomeco);
  // por último, o apelido: unidade de verdade com aquele nome (inteiro ou curto) sempre ganha dele
  const apelido = APELIDOS[chave];
  return apelido && todos.includes(apelido) ? apelido : undefined;
}
