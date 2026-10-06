/** Um Kommo de mentira pros testes do conector: leads em memória, um funil, um usuário. */
import type { KommoLead } from '../services/kommo.service.js';
import type { FonteKommo, UnidadeKommo } from './kommo.js';

const t = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function leadFalso(id: number, criado: string, extra: Partial<KommoLead> = {}): KommoLead {
  return { id, name: `Lead ${id}`, pipeline_id: 1, status_id: 11, created_at: t(criado), updated_at: t(criado), ...extra };
}

export function fonteFalsa(leads: KommoLead[], chamadas: Array<[number, number]> = [], telefones: Record<number, string> = {}): FonteKommo {
  return {
    async telefonesDosContatos(ids) {
      return new Map(ids.filter((id) => telefones[id]).map((id) => [id, telefones[id] as string]));
    },
    async leadsNaJanela(_campo, de, ate) {
      chamadas.push([de, ate]);
      return { leads: leads.filter((l) => (l.created_at ?? 0) >= de && (l.created_at ?? 0) <= ate), truncado: false };
    },
    async funis() {
      return [{ id: 1, name: 'Comercial', is_main: true, statuses: [{ id: 11, name: 'Novo' }, { id: 12, name: 'Agendado' }, { id: 142, name: 'Fechado' }, { id: 143, name: 'Perdido' }] }];
    },
    async lead(id) {
      const l = leads.find((x) => x.id === id);
      if (!l) throw new Error('404');
      return l;
    },
    async leadsPorTelefone() {
      return leads.slice(0, 1);
    },
    async usuarios() {
      return [{ id: 7, name: 'Júlia SDR' }];
    },
  };
}

export const unidadeKommo = (slug: string, fonte: FonteKommo): UnidadeKommo => ({ slug, nome: slug, fuso: 'America/Sao_Paulo', slugsDaFranquia: [slug], fonte });
