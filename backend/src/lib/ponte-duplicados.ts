/**
 * Ponte, fase 3 (14/10/2026) — AVISO DE CARTÃO DUPLICADO.
 *
 * Na resposta do cartão vai `duplicados`: os OUTROS cartões ABERTOS do mesmo paciente, cada um com `via`:
 *   - `contato`: o paciente é o contato PRINCIPAL do outro cartão (contato que entra como secundário — a mãe que
 *     acompanha a filha — não conta);
 *   - `telefone`: o contato principal do outro cartão é OUTRO contato com o MESMO telefone completo (DDD +
 *     número). Pode ser da família dividindo o WhatsApp: o painel mostra separado, com cautela.
 * "Aberto" = fora de GANHO 142 e PERDIDO 143 E fora das etapas finais pelo NOME (ALTA, CANCELADO, CONCLUÍDO,
 * FINALIZADO, ENCERRADO — o funil TRATAMENTO tem "ALTA"). O painel mostra a faixa amarela e a regra da casa:
 * confira se é a mesma pessoa; fica o que veio do anúncio; o outro é juntado (Mesclar) no Kommo, nunca apagado.
 *
 * A Ponte só AVISA: não junta nem apaga nada. Esta é a parte pura; quem lê o Kommo é `ponte.controller.ts`.
 */
import { chaveTelefone } from './franquia-sync.js';
import { GANHO, PERDIDO, dddBrasileiro } from './ponte-cartao.js';
import { CAMPOS_DO_ANUNCIO } from '../agent/anuncio-de-origem.js';

/** Quantos outros cartões a Ponte olha, no máximo (um paciente com mais que isso é caso para o Kommo). */
export const MAX_CARTOES_DUPLICADOS = 20;

/**
 * Os dois números são o MESMO telefone completo? Mais estrito que o `telefoneConfere` do casamento (que aceita
 * contato sem DDD): para dizer "é o mesmo paciente", os dois precisam ter DDD (ou ser o mesmo número de fora,
 * dígito a dígito). Com e sem o 55 e com e sem o nono dígito continuam sendo o mesmo número.
 */
export function mesmoTelefoneCompleto(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = dddBrasileiro(a);
  const db = dddBrasileiro(b);
  if (da && db) return da === db && chaveTelefone(a).length >= 8 && chaveTelefone(a) === chaveTelefone(b);
  if (da || db) return false;
  const x = String(a ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  const y = String(b ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  return x.length >= 10 && x === y;
}

/** O número tem DDD (ou é um número de fora com país): dá para dizer "é o mesmo telefone". */
export function telefoneCompleto(t: string | null | undefined): boolean {
  return mesmoTelefoneCompleto(t, t);
}

export interface CartaoDoPaciente {
  id: number;
  name?: string | null;
  status_id: number;
  pipeline_id: number;
  updated_at?: number;
  custom_fields_values?: ReadonlyArray<{ field_name?: string | null; values?: ReadonlyArray<{ value?: unknown }> | null }> | null;
  _embedded?: { contacts?: ReadonlyArray<{ id: number; is_main?: boolean }> } | null;
}

export type ViaDoDuplicado = 'contato' | 'telefone';

export interface CartaoDuplicado {
  id: number;
  nome: string;
  funil: string | null;
  etapa: string | null;
  /** O "⚑ Origem" do cartão, quando preenchido. */
  origem: string | null;
  link: string;
  /** `contato`: o mesmo contato principal; `telefone`: outro contato com o mesmo número (pode ser da família). */
  via: ViaDoDuplicado;
}

/** Palavras de etapa FINAL pelo nome (o funil TRATAMENTO tem "ALTA"; há contas com "CONCLUÍDO" fora do 142). */
const FINAL = [/^alta$/, /^cancelad/, /^conclu/, /^finaliz/, /^encerrad/];

/** A etapa é final pelo nome? Palavra inteira: "FALTOU" não é "alta". */
export function etapaFinal(nome: string | null | undefined): boolean {
  const palavras = String(nome ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return palavras.some((p) => FINAL.some((r) => r.test(p)));
}

/** Aberto = fora de GANHO/PERDIDO e, quando se sabe o nome da etapa, fora das etapas finais pelo nome. */
export function cartaoAberto(l: { status_id: number }, etapa?: string | null): boolean {
  return l.status_id !== GANHO && l.status_id !== PERDIDO && !etapaFinal(etapa);
}

/** O contato principal do cartão (`is_main`), ou o primeiro. */
export function contatoPrincipal(l: Pick<CartaoDoPaciente, '_embedded'>): number | null {
  const cs = l._embedded?.contacts ?? [];
  return (cs.find((c) => c.is_main) ?? cs[0])?.id ?? null;
}

/** O "⚑ Origem" do cartão (pelo nome do campo). */
export function origemDoCartao(l: Pick<CartaoDoPaciente, 'custom_fields_values'>): string | null {
  const v = (l.custom_fields_values ?? []).find((c) => (c.field_name ?? '').trim() === CAMPOS_DO_ANUNCIO.origem)?.values?.[0]?.value;
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s || null;
}

/**
 * Os OUTROS cartões abertos do paciente — só quando, contando o da tela, há pelo menos DOIS abertos. Um cartão
 * fechado (GANHO/PERDIDO/ALTA…) mais um aberto é o paciente que voltou, não duplicado. Só entra cartão cujo
 * contato PRINCIPAL é o paciente (`via: 'contato'`) ou um contato com o mesmo telefone completo
 * (`via: 'telefone'`); o resto (o paciente como contato secundário) fica de fora. Mais mexido primeiro.
 */
export function cartoesDuplicados(
  atual: { id: number; status_id: number; pipeline_id: number },
  outros: ReadonlyArray<CartaoDoPaciente>,
  quem: { contato: number; doMesmoTelefone: ReadonlySet<number> },
  nomes: (l: { pipeline_id: number; status_id: number }) => { funil: string | null; etapa: string | null },
  link: (id: number) => string,
): CartaoDuplicado[] {
  const vistos = new Set<number>([atual.id]);
  const abertos: Array<{ l: CartaoDoPaciente; via: ViaDoDuplicado; n: { funil: string | null; etapa: string | null } }> = [];
  for (const l of outros) {
    if (vistos.has(l.id)) continue;
    vistos.add(l.id);
    const principal = contatoPrincipal(l);
    const via: ViaDoDuplicado | null = principal === quem.contato ? 'contato' : principal !== null && quem.doMesmoTelefone.has(principal) ? 'telefone' : null;
    if (!via) continue;
    const n = nomes(l);
    if (!cartaoAberto(l, n.etapa)) continue;
    abertos.push({ l, via, n });
  }
  abertos.sort((a, b) => (b.l.updated_at ?? 0) - (a.l.updated_at ?? 0) || b.l.id - a.l.id);
  const total = abertos.length + (cartaoAberto(atual, nomes(atual).etapa) ? 1 : 0);
  if (total < 2) return [];
  return abertos.slice(0, MAX_CARTOES_DUPLICADOS).map(({ l, via, n }) => ({
    id: l.id,
    nome: String(l.name ?? '').trim() || `Cartão ${l.id}`,
    ...n,
    origem: origemDoCartao(l),
    link: link(l.id),
    via,
  }));
}
