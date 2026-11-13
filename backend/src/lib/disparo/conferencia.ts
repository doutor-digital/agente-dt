/**
 * A conferência de "esta pessoa já é nossa?" por unidade — a regra escolhe a fonte:
 *  1. unidade COM franquia (`spineToken`) → agenda e tratamentos da franquia (`franquia.ts`), como sempre;
 *  2. unidade SEM franquia mas COM `DISPARO_REGRA_CLIENTE` → o cartão do lead no Kommo (escritório de advocacia:
 *     cliente é quem está num funil ou numa etapa de "cliente");
 *  3. sem uma coisa nem outra → `indisponivel` para todo mundo (o padrão seguro de sempre: na dúvida, não manda).
 *
 * `DISPARO_REGRA_CLIENTE` — POR UNIDADE, nunca global (mesmo molde de `DISPARO_LISTA_DE_TESTE`):
 *
 *   `magalhaes-advocacia=14026239,13964971/108260519,13964971/142`
 *
 *  - `<funil>`          → QUEM ESTÁ em qualquer etapa desse funil (inclusive ganho/perdido) é cliente;
 *  - `<funil>/<etapa>`  → só quem está nessa etapa desse funil é cliente;
 *  - entradas de unidades diferentes separadas por `;` (ou quebra de linha), itens da unidade por vírgula;
 *  - qualquer item que não seja número (ou número/número) invalida a entrada INTEIRA: regra pela metade deixaria passar
 *    cliente. Unidade que não aparece, ou entrada inválida = sem regra = `indisponivel`.
 *
 * Falha ao ler o lead NUNCA vira `livre`: vira `indisponivel`, e quem chama não manda (e adia, não descarta).
 * O lead é lido FRESCO a cada conferência (funil e etapa de agora): a reconferência da hora do envio pega quem fechou
 * contrato depois de a onda ser montada.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../logger.js';
import { createKommoClient } from '../../services/kommo.service.js';
import { conferenciaDaFranquia, type FranquiaPorta, type PessoaParaConferir } from './franquia.js';
import type { SituacaoNaFranquia } from './regras.js';

export interface RegraDeCliente {
  /** funis inteiros: qualquer etapa conta como cliente */
  funis: ReadonlySet<number>;
  /** etapas soltas: `"<funil>/<etapa>"` */
  etapas: ReadonlySet<string>;
}

const chaveDaEtapa = (funil: number, etapa: number) => `${funil}/${etapa}`;

/** O que importa do lead para a regra. */
export interface LeadNoKommo {
  pipeline_id: number;
  status_id: number;
}

function lerEntrada(valor: string): RegraDeCliente | null {
  const funis = new Set<number>();
  const etapas = new Set<string>();
  const itens = valor.split(',').map((i) => i.trim());
  for (const item of itens) {
    const m = /^(\d+)(?:\/(\d+))?$/.exec(item);
    if (!m) return null;
    const funil = Number(m[1]);
    if (!Number.isSafeInteger(funil) || funil <= 0) return null;
    if (m[2] === undefined) {
      funis.add(funil);
      continue;
    }
    const etapa = Number(m[2]);
    if (!Number.isSafeInteger(etapa) || etapa <= 0) return null; // "funil/0" é erro de digitação, não etapa
    etapas.add(chaveDaEtapa(funil, etapa));
  }
  return funis.size + etapas.size > 0 ? { funis, etapas } : null;
}

/** A regra de cliente da unidade, ou `null` (sem regra, regra inválida, ou variável ausente). */
export function regraDeClienteDoAmbiente(slug: string, env: NodeJS.ProcessEnv = process.env): RegraDeCliente | null {
  for (const entrada of (env.DISPARO_REGRA_CLIENTE ?? '').split(/[;\n]/)) {
    const i = entrada.indexOf('=');
    if (i < 0 || entrada.slice(0, i).trim() !== slug) continue;
    return lerEntrada(entrada.slice(i + 1));
  }
  return null;
}

/** O que a variável tem de errado, para o log de subida avisar: a entrada inválida não vale e a unidade fica `indisponivel`. */
export function avisosDaRegraDeCliente(env: NodeJS.ProcessEnv = process.env): string[] {
  const avisos: string[] = [];
  const vistos = new Set<string>();
  for (const bruta of (env.DISPARO_REGRA_CLIENTE ?? '').split(/[;\n]/)) {
    const e = bruta.trim();
    if (!e) continue;
    const i = e.indexOf('=');
    const slug = e.slice(0, i).trim();
    if (i > 0 && vistos.has(slug)) avisos.push(`DISPARO_REGRA_CLIENTE: "${slug.slice(0, 40)}" aparece mais de uma vez; só a PRIMEIRA entrada vale`);
    vistos.add(slug);
    if (i < 1 || !/^[a-z0-9][a-z0-9-]*$/i.test(e.slice(0, i).trim()) || !lerEntrada(e.slice(i + 1))) {
      avisos.push(`DISPARO_REGRA_CLIENTE: a entrada "${e.slice(0, 40)}" não vale (o formato é slug=funil,funil/etapa); a unidade fica sem regra e ninguém recebe`);
    }
  }
  return avisos;
}

/** Pura: este lead, no funil e na etapa de agora, é cliente? */
export function ehCliente(regra: RegraDeCliente, lead: LeadNoKommo): boolean {
  return regra.funis.has(lead.pipeline_id) || regra.etapas.has(chaveDaEtapa(lead.pipeline_id, lead.status_id));
}

/** A leitura do lead. Em produção é o Kommo da unidade; o teste troca por uma de mentira. */
export type LeitorDeLead = (leadId: number) => Promise<Partial<LeadNoKommo> | null | undefined>;

export function leitorDoKommo(unit: Unit): LeitorDeLead {
  let kommo: ReturnType<typeof createKommoClient> | null = null;
  return (leadId) => (kommo ??= createKommoClient(unit)).getLead(leadId);
}

/** A conferência de uma unidade SEM franquia, pela regra de cliente. */
export function conferenciaPorRegraDeCliente(unit: Pick<Unit, 'slug'>, regra: RegraDeCliente, ler: LeitorDeLead): (p: PessoaParaConferir) => Promise<SituacaoNaFranquia> {
  return async (p) => {
    if (!p.leadId) return 'indisponivel'; // sem cartão não há o que olhar
    try {
      const lead = await ler(p.leadId);
      // Resposta sem funil ou sem etapa não é "lead novo": é leitura que não deu certo.
      if (!lead || typeof lead.pipeline_id !== 'number' || typeof lead.status_id !== 'number') return 'indisponivel';
      return ehCliente(regra, { pipeline_id: lead.pipeline_id, status_id: lead.status_id }) ? 'ja-cliente' : 'livre';
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: p.leadId }, 'disparo: não consegui ler o lead no Kommo — pessoa fica de fora');
      return 'indisponivel';
    }
  };
}

/** Pode conferir "já é nosso?" nesta unidade? Sem franquia e sem regra, não: a onda nem abre. */
export function unidadeConfere(unit: Pick<Unit, 'slug' | 'spineToken'>, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(unit.spineToken) || regraDeClienteDoAmbiente(unit.slug, env) !== null;
}

/** A conferência que a montagem e a reconferência do envio usam — a MESMA nos dois, para uma só regra por unidade. */
export function conferenciaDaUnidade(
  unit: Unit,
  opcoes: { env?: NodeJS.ProcessEnv; ler?: LeitorDeLead; franquia?: FranquiaPorta } = {},
): (p: PessoaParaConferir) => Promise<SituacaoNaFranquia> {
  if (unit.spineToken) return conferenciaDaFranquia(unit, undefined, opcoes.franquia);
  const regra = regraDeClienteDoAmbiente(unit.slug, opcoes.env);
  if (!regra) return conferenciaDaFranquia(unit, undefined, opcoes.franquia); // sem token: 'indisponivel' para todos, como hoje
  return conferenciaPorRegraDeCliente(unit, regra, opcoes.ler ?? leitorDoKommo(unit));
}
