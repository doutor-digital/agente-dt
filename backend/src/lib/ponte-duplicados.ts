/**
 * Ponte, fase 3 (14/10/2026) — AVISO DE CARTÃO DUPLICADO.
 *
 * Na resposta do cartão vai `duplicados`: os OUTROS cartões ABERTOS (fora de GANHO 142 e PERDIDO 143, em
 * qualquer funil) do mesmo paciente — do mesmo contato, ou de outros contatos com o MESMO telefone completo
 * (DDD + número). O painel mostra a faixa amarela "Este paciente tem 2 cartões abertos" e a regra da casa:
 * fica o que veio do anúncio; o outro é juntado (Mesclar) no Kommo, nunca apagado.
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
}

export interface CartaoDuplicado {
  id: number;
  nome: string;
  funil: string | null;
  etapa: string | null;
  /** O "⚑ Origem" do cartão, quando preenchido. */
  origem: string | null;
  link: string;
}

export const cartaoAberto = (l: { status_id: number }) => l.status_id !== GANHO && l.status_id !== PERDIDO;

/** O "⚑ Origem" do cartão (pelo nome do campo). */
export function origemDoCartao(l: Pick<CartaoDoPaciente, 'custom_fields_values'>): string | null {
  const v = (l.custom_fields_values ?? []).find((c) => (c.field_name ?? '').trim() === CAMPOS_DO_ANUNCIO.origem)?.values?.[0]?.value;
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s || null;
}

/**
 * Os OUTROS cartões abertos do paciente — só quando, contando o da tela, há pelo menos DOIS abertos. Um cartão
 * fechado (GANHO/PERDIDO) mais um aberto é o paciente que voltou, não duplicado. Mais mexido primeiro.
 */
export function cartoesDuplicados(
  atual: { id: number; status_id: number },
  outros: ReadonlyArray<CartaoDoPaciente>,
  nomes: (l: { pipeline_id: number; status_id: number }) => { funil: string | null; etapa: string | null },
  link: (id: number) => string,
): CartaoDuplicado[] {
  const vistos = new Set<number>([atual.id]);
  const abertos = outros
    .filter((l) => (vistos.has(l.id) ? false : (vistos.add(l.id), true)))
    .filter(cartaoAberto)
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0) || b.id - a.id);
  const total = abertos.length + (cartaoAberto(atual) ? 1 : 0);
  if (total < 2) return [];
  return abertos.slice(0, MAX_CARTOES_DUPLICADOS).map((l) => ({
    id: l.id,
    nome: String(l.name ?? '').trim() || `Cartão ${l.id}`,
    ...nomes(l),
    origem: origemDoCartao(l),
    link: link(l.id),
  }));
}
