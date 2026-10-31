/**
 * O cartão do Kommo visto pelo Copiloto: só a etapa e os campos DO DICIONÁRIO que ESTA CONTA realmente tem
 * (nada que não esteja no dicionário vira prompt, e campo que a conta não tem é "não existe" para o portão).
 * Função pura: recebe o que o Kommo devolveu e devolve o que o prompt e o portão precisam.
 */
import type { CampoDoCartaoDaConta, KommoLead, KommoPipeline } from '../../services/kommo.service.js';
import { etapaCanonica, nomeCanonico } from './mapa-de-campos.js';

export interface ContextoDoCartao {
  /** Nome da etapa como o Kommo mostra (ex.: "EM QUALIFICAÇÃO"). */
  etapaNome: string | null;
  /** A mesma etapa na grafia do dicionário; null = etapa que o dicionário não conhece. */
  etapa: string | null;
  /** SÓ os campos do dicionário que a conta tem; valor atual (vazio = null). Campo fora daqui não existe para o Copiloto. */
  valores: Record<string, string | null>;
  /** Opções das listas (select/radio/multiselect), por nome do campo do dicionário. */
  opcoes: Record<string, string[]>;
  /** Campos que são lista: sem opções conhecidas, o portão recusa o valor. */
  ehLista: Record<string, boolean>;
}

const TIPOS_DE_LISTA = new Set(['select', 'multiselect', 'radiobutton']);
const TIPOS_DE_DATA = new Set(['date', 'date_time', 'birthday']);

function dataBr(v: unknown): string | null {
  const n = typeof v === 'number' ? v : /^\d{9,11}$/.test(String(v)) ? Number(v) : null;
  if (n === null) return null;
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(n * 1000));
  } catch {
    return null;
  }
}

function textoDoValor(vals: Array<{ value: unknown }>, tipo: string): string | null {
  const partes = vals
    .map((v) => {
      if (v.value === null || v.value === undefined) return '';
      if (TIPOS_DE_DATA.has(tipo)) return dataBr(v.value) ?? String(v.value).trim();
      return String(v.value).trim();
    })
    .filter(Boolean);
  return partes.length ? partes.join(', ') : null;
}

export function montarContextoDoCartao(lead: KommoLead, funis: KommoPipeline[], definicoes: CampoDoCartaoDaConta[]): ContextoDoCartao {
  const funil = funis.find((f) => f.id === lead.pipeline_id);
  const etapaNome = funil?.statuses.find((s) => s.id === lead.status_id)?.name ?? null;

  const valores: Record<string, string | null> = {};
  const opcoes: Record<string, string[]> = {};
  const ehLista: Record<string, boolean> = {};
  const nomePorId = new Map<number, { nome: string; tipo: string }>();
  for (const d of definicoes) {
    const canon = nomeCanonico(d.name);
    if (!canon) continue; // campo da conta que o dicionário não conhece: o Copiloto nem vê
    nomePorId.set(d.id, { nome: canon, tipo: d.type });
    valores[canon] = null;
    if (TIPOS_DE_LISTA.has(d.type)) {
      ehLista[canon] = true;
      if (d.enums?.length) opcoes[canon] = d.enums.map((e) => e.value);
    }
  }
  // o valor do cartão é casado pelo ID do campo, não pelo nome (o nome pode faltar no valor)
  for (const cf of lead.custom_fields_values ?? []) {
    const def = nomePorId.get(cf.field_id);
    if (def) valores[def.nome] = textoDoValor(cf.values, def.tipo);
  }
  return { etapaNome, etapa: etapaNome ? etapaCanonica(etapaNome) : null, valores, opcoes, ehLista };
}

/** A conta tem este campo? */
export function campoExisteNoCartao(ctx: ContextoDoCartao, nome: string): boolean {
  const canon = nomeCanonico(nome);
  return !!canon && canon in ctx.valores;
}
