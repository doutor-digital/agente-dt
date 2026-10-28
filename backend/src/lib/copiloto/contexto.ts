/**
 * O cartão do Kommo visto pelo Copiloto: só a etapa e os campos DO DICIONÁRIO (nada que não esteja lá vira prompt).
 * Função pura: recebe o que o Kommo devolveu e devolve o que o prompt e o portão precisam.
 */
import type { KommoLead, KommoLeadCustomField, KommoPipeline } from '../../services/kommo.service.js';
import { DICIONARIO } from './dicionario-campos.js';
import { etapaCanonica, nomeCanonico } from './mapa-de-campos.js';

export interface ContextoDoCartao {
  /** Nome da etapa como o Kommo mostra (ex.: "EM QUALIFICAÇÃO"). */
  etapaNome: string | null;
  /** A mesma etapa na grafia do dicionário; null = etapa que o dicionário não conhece. */
  etapa: string | null;
  /** Valor atual de cada campo do dicionário que o cartão tem (vazio = null). */
  valores: Record<string, string | null>;
  /** Opções das listas (select/radio/multiselect), por nome do campo do dicionário. */
  opcoes: Record<string, string[]>;
}

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

function textoDoValor(vals: Array<{ value: unknown }>): string | null {
  const partes = vals.map((v) => (v.value === null || v.value === undefined ? '' : String(v.value).trim())).filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

export function montarContextoDoCartao(lead: KommoLead, funis: KommoPipeline[], definicoes: KommoLeadCustomField[]): ContextoDoCartao {
  const funil = funis.find((f) => f.id === lead.pipeline_id);
  const etapaNome = funil?.statuses.find((s) => s.id === lead.status_id)?.name ?? null;
  const valores: Record<string, string | null> = {};
  for (const nome of Object.keys(DICIONARIO.campos)) valores[nome] = null;
  for (const cf of lead.custom_fields_values ?? []) {
    const canon = cf.field_name ? nomeCanonico(cf.field_name) : null;
    if (canon) valores[canon] = textoDoValor(cf.values);
  }
  const opcoes: Record<string, string[]> = {};
  for (const d of definicoes) {
    const canon = nomeCanonico(d.name);
    if (canon && d.enums?.length) opcoes[canon] = d.enums.map((e) => e.value);
  }
  return { etapaNome, etapa: etapaNome ? etapaCanonica(etapaNome) : null, valores, opcoes };
}

/** Existe o campo no cartão desta conta? (conta clonada pode não ter todos). */
export function campoExisteNoCartao(ctx: ContextoDoCartao, nome: string): boolean {
  const canon = nomeCanonico(nome);
  return !!canon && (canon in ctx.valores);
}

export const _norm = norm;
