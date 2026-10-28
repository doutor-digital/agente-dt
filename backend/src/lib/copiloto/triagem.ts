/**
 * Depois da IA: toda sugestão passa pelo portão. O que passa vira "sugestão" (a atendente decide e digita);
 * o que não passa vira "não sugeri X porque…" — que ensina (ex.: "esse campo chega sozinho").
 */
import type { ContextoDoCartao } from './contexto.js';
import { nomeCanonico, validarProposta, type PapelDeQuemUsa } from './mapa-de-campos.js';
import type { SugestaoDaIa } from './prompt.js';

export interface SugestaoAceita {
  campo: string;
  valor: string;
  porque: string;
}
export interface SugestaoRecusada {
  campo: string;
  motivo: string;
}

export function triarSugestoes(sugestoes: SugestaoDaIa[], ctx: ContextoDoCartao, papel: PapelDeQuemUsa = 'sdr'): { aceitas: SugestaoAceita[]; recusadas: SugestaoRecusada[] } {
  const aceitas: SugestaoAceita[] = [];
  const recusadas: SugestaoRecusada[] = [];
  const vistos = new Set<string>();
  for (const s of sugestoes) {
    const canon = nomeCanonico(s.campo);
    if (canon && vistos.has(canon)) continue; // a IA repetiu o campo
    if (canon) vistos.add(canon);
    if (canon && !(canon in ctx.valores)) {
      recusadas.push({ campo: canon, motivo: 'Esse campo não existe no cartão desta unidade.' });
      continue;
    }
    const d = validarProposta(
      { campo: s.campo, valor: s.valor },
      { etapa: ctx.etapa ?? '', papel, valorAtual: (c) => ctx.valores[c] ?? null, opcoes: (c) => ctx.opcoes[c] ?? null, ehLista: (c) => !!ctx.ehLista[c] },
    );
    if (d.acao === 'propor') aceitas.push({ campo: canon!, valor: s.valor, porque: s.porque });
    else recusadas.push({ campo: canon ?? s.campo, motivo: d.motivo });
  }
  return { aceitas, recusadas };
}
