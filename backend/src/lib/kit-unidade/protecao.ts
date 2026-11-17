/**
 * PROTEÇÃO DE UNIDADE QUE JÁ EXISTE (kit de unidade, 15/11/2026, revisão do sênior no #341).
 *
 * O script `nova-unidade` foi feito para unidade NOVA. Rodado sobre uma que já existe (Parauapebas, por exemplo), ele não pode trocar o que a
 * equipe já preencheu — a persona e as fontes da Sofia, o número do Kapso, a WABA, o prefixo dos modelos, os dados dos textos: um `null` gravado
 * por cima do número do Kapso derruba a leitura das mídias, e um endereço trocado muda o que a Sofia diz ao paciente.
 *
 * Regra: numa unidade existente SÓ se preenche campo VAZIO (nulo, texto em branco, lista ou objeto vazio). O que já tem valor, mesmo diferente do
 * questionário, fica — e o relatório diz quais campos ficaram. Trocar o que já tem valor exige `--sobrescrever`. Unidade ATIVA exige
 * `--sobrescrever` até para ser tocada (ver `plano.ts` e `executar.ts`).
 */
export const vazio = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && v !== null && Object.keys(v as object).length === 0);

/** JSON com as chaves em ordem, para comparar valores vindos do banco (jsonb) com os do questionário. */
function igual(a: unknown, b: unknown): boolean {
  const ordenar = (x: unknown): unknown => (Array.isArray(x) ? x.map(ordenar) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0)).map(([k, y]) => [k, ordenar(y)])) : x);
  return JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b));
}

export interface ParaGravar {
  /** só o que muda de verdade (campo vazio que o questionário preenche; com `sobrescrever`, também o que difere) */
  gravar: Record<string, unknown>;
  /** campos que JÁ têm valor diferente do questionário e que ficaram como estão */
  preservados: string[];
}

/** `hoje` = a linha como está no banco (null/undefined = não existe: grava tudo). */
export function aGravar(hoje: Record<string, unknown> | null | undefined, novos: Record<string, unknown>, sobrescrever: boolean): ParaGravar {
  if (!hoje) return { gravar: { ...novos }, preservados: [] };
  const gravar: Record<string, unknown> = {};
  const preservados: string[] = [];
  for (const [k, v] of Object.entries(novos)) {
    const atual = hoje[k];
    if (igual(atual, v)) continue;
    if (vazio(atual) || sobrescrever) gravar[k] = v;
    else preservados.push(k);
  }
  return { gravar, preservados };
}

/** Os dados dos modelos (um objeto): preenche só a CHAVE que falta; o que já está escrito fica. */
export function dadosDosModelosAGravar(hoje: Record<string, unknown> | null | undefined, novos: Record<string, unknown>, sobrescrever: boolean): ParaGravar & { mesclado: Record<string, unknown> } {
  const r = aGravar(hoje ?? null, novos, sobrescrever);
  return { ...r, mesclado: { ...(hoje ?? {}), ...r.gravar } };
}
