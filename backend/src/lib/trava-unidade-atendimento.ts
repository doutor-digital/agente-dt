/**
 * Trava da unidade de atendimento — nada escreve na franquia a partir de um cartão que não é da cidade dela.
 *
 * Por quê (14/10/2026): a conta Kommo de Petrópolis (`doutorhernialvp`) atende DUAS clínicas, Petrópolis e Caxias
 * (campo `⌂ Unidade de atendimento` no cartão), mas a unidade do agente só tem o token da franquia de PETRÓPOLIS.
 * Marcar, remarcar ou cadastrar um paciente de Caxias por aqui o põe na agenda e na base de Petrópolis. Regra do
 * João (14/10): "marcar a consulta ou cadastrar o lead tem que ser de acordo com a unidade correta".
 *
 * Na conta com unidade de atendimento (as de `REGRAS_POR_UNIDADE`, hoje só Petrópolis):
 *  - cartão da cidade da franquia (`cidadeDaFranquia`) → segue normal;
 *  - cartão de OUTRA cidade → recusa, sem chamar a franquia;
 *  - campo VAZIO → recusa: a SDR escolhe a unidade antes de marcar ou cadastrar;
 *  - cartão que não deu para ler (sem lead, Kommo fora) → recusa. Trava que falha aberta não é trava.
 * Nas outras unidades nada muda: a função devolve null na hora, sem nem ler o Kommo.
 *
 * PROVISÓRIA: sai quando a unidade tiver os dois tokens (branch feat/petropolis-caxias-dois-tokens).
 */
import type { Unit } from '@prisma/client';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { normalizarNome } from './kommo-schema.js';
import { CAMPO_UNIDADE, REGRAS_POR_UNIDADE, type RegrasDaUnidade } from './unidade-por-canal.js';

export type CodigoTrava = 'unidade_de_outra_cidade' | 'unidade_vazia' | 'unidade_ilegivel';

export interface TravaDaFranquia {
  codigo: CodigoTrava;
  /** Frase pronta para a SDR (widget, painel). */
  motivo: string;
  /** O que a Sofia recebe da ferramenta no lugar do cadastro ou da marcação. */
  paraIa: string;
  /** Curto, para tarefa de alerta e log: "cartão de Caxias". */
  resumo: string;
}

/** As regras da conta com unidade de atendimento; null = unidade comum (a trava não existe para ela). */
export function regrasDaUnidade(slug: string | null | undefined): RegrasDaUnidade | null {
  if (!slug || !Object.prototype.hasOwnProperty.call(REGRAS_POR_UNIDADE, slug)) return null;
  return REGRAS_POR_UNIDADE[slug];
}

/** As cidades da conta, a da franquia primeiro, sem repetir: "Petrópolis ou Caxias". */
function cidadesDa(regras: RegrasDaUnidade): string[] {
  const vistas = new Set<string>();
  const saida: string[] = [];
  for (const c of [regras.cidadeDaFranquia, ...Object.values(regras.contasDeAnuncio), ...Object.values(regras.ddd)]) {
    const chave = normalizarNome(c);
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    saida.push(c);
  }
  return saida;
}

/** O valor do `⌂ Unidade de atendimento` no cartão (pelo nome do campo, sem id fixo); null se vazio. */
export function unidadeNoCartao(lead: Pick<KommoLead, 'custom_fields_values'>): string | null {
  const alvo = normalizarNome(CAMPO_UNIDADE);
  const v = lead.custom_fields_values?.find((f) => normalizarNome(f.field_name ?? '') === alvo)?.values?.[0]?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}

const ILEGIVEL: TravaDaFranquia = {
  codigo: 'unidade_ilegivel',
  motivo: 'Não consegui ler a unidade de atendimento do cartão agora. Nada foi feito na franquia. Tente de novo em instantes.',
  paraIa: 'RECUSADO: não consegui ler a unidade de atendimento do cartão. Não cadastre nem mexa na agenda: transfira para a equipe.',
  resumo: 'não consegui ler a unidade de atendimento do cartão',
};

/** Puro. `noCartao` = valor do campo (null se vazio). null = pode escrever na franquia. */
export function travaPeloCampo(regras: RegrasDaUnidade | null, noCartao: string | null): TravaDaFranquia | null {
  if (!regras) return null;
  const valor = noCartao?.trim() || null;
  if (!valor) {
    const opcoes = cidadesDa(regras).join(' ou ');
    return {
      codigo: 'unidade_vazia',
      motivo: `Escolha a unidade de atendimento do cartão (${opcoes}) antes de marcar ou cadastrar.`,
      paraIa:
        `RECUSADO: o cartão ainda não diz a unidade de atendimento (${opcoes}) e por aqui só dá para mexer na agenda de ` +
        `${regras.cidadeDaFranquia}. Não cadastre nem mexa na agenda: transfira para a equipe escolher a unidade.`,
      resumo: 'cartão sem unidade de atendimento',
    };
  }
  if (normalizarNome(valor) === normalizarNome(regras.cidadeDaFranquia)) return null;
  return {
    codigo: 'unidade_de_outra_cidade',
    motivo: `Este paciente é de ${valor}. Marque na agenda de ${valor}. A marcação pelo widget para ${valor} chega na próxima atualização.`,
    paraIa:
      `RECUSADO: este paciente é de ${valor} e por aqui só dá para mexer na agenda de ${regras.cidadeDaFranquia}. ` +
      `Não cadastre, não marque, não remarque, não cancele e não ofereça horário: transfira para a equipe cuidar ` +
      `na agenda de ${valor}.`,
    resumo: `cartão de ${valor}; esta unidade só tem a agenda de ${regras.cidadeDaFranquia}`,
  };
}

/**
 * A trava para um cartão, antes de qualquer escrita na franquia. Unidade comum: null na hora, sem ler o Kommo.
 * `kommo` = o cliente que o chamador já tem (senão cria um com o token da unidade).
 */
export async function travaDaUnidadeDeAtendimento(
  unit: Unit,
  leadId: number | null | undefined,
  kommo?: Pick<KommoClient, 'getLead'> | null,
): Promise<TravaDaFranquia | null> {
  const regras = regrasDaUnidade(unit.slug);
  if (!regras) return null;

  let trava: TravaDaFranquia | null = ILEGIVEL;
  if (leadId && Number.isInteger(leadId) && leadId > 0) {
    const cliente = kommo ?? (unit.kommoAccessToken ? createKommoClient(unit) : null);
    const lead = cliente ? await cliente.getLead(leadId).catch(() => null) : null;
    if (lead) trava = travaPeloCampo(regras, unidadeNoCartao(lead));
  }
  if (trava) logger.warn({ unit: unit.slug, leadId, codigo: trava.codigo }, 'trava da unidade de atendimento: não escrevi na franquia');
  return trava;
}
