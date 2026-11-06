/**
 * Pequenas leituras do cartão do Kommo que mais de um worker usa. Moram aqui (e não num worker importado por outro) para
 * mexer num worker não quebrar o outro.
 */
import type { KommoLead } from '../services/kommo.service.js';
import type { Estado } from './automacoes-estado.js';
import type { MembroDoCrm } from './crm-compartilhado.js';

/** O contato principal do cartão (o marcado como principal; senão o primeiro). */
export function contatoPrincipal(lead: KommoLead): number | null {
  const contatos = lead._embedded?.contacts ?? [];
  return (contatos.find((c) => c.is_main) ?? contatos[0])?.id ?? null;
}

/** O valor do campo no cartão, como texto aparado; null se o cartão não tem o campo ou ele está vazio. */
export function valorDoCampo(lead: KommoLead, fieldId: number): string | null {
  const v = lead.custom_fields_values?.find((f) => f.field_id === fieldId)?.values?.[0]?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}

/** Alguma unidade da conta (ela mesma, ou o grupo Petrópolis + Caxias) está em seco ou ligada? */
export function algumaChaveAtiva(unit: { slug: string }, membros: ReadonlyArray<MembroDoCrm> | null, estado: (slug: string) => Estado): boolean {
  const slugs = membros?.length ? membros.map((m) => m.slug).filter((s): s is string => !!s) : [unit.slug];
  return slugs.some((s) => estado(s) !== 'desligado');
}
