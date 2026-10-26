/**
 * Carimbos por mudança de etapa (webhook `status_lead` do Kommo).
 *
 * Nasceu do cartão enxuto (laboratório `doutorherniakommo`, 17–18/09/2026): a API da
 * franquia nunca devolve `dateBegin`/`dateFinish` do tratamento, então "◷ Início do
 * tratamento" e "◷ Fim do tratamento" ficariam vazios pra sempre. O João decidiu que
 * a etapa é a verdade: entrou em EM TRATAMENTO → início; foi pra ALTA ou TRATAMENTO
 * CANCELADO → fim. As datas só entram se o campo estiver vazio (o sincronizador pode
 * ter gravado a data da 1ª sessão, que é melhor que "hoje").
 *
 * Aproveita o mesmo gatilho pra fechar o bloco DIGITAL: lead em GANHO / CONCLUÍDO ou
 * PERDIDO → "⬢ Status da conversa" = Encerrada. Este é o ÚNICO escritor de "Encerrada"; os outros escritores do
 * campo (IA, handoff, follow-up) não a desfazem enquanto o cartão estiver encerrado — ver status-conversa.ts.
 *
 * Só roda nas unidades listadas em `CARIMBO_ETAPA_SLUGS` (csv; `*` = todas). A conta
 * também precisa assinar `status_lead` no webhook do agente — a Imperatriz, por exemplo,
 * só assinava `add_message` em 18/09/2026, então nada disto disparava lá.
 *
 * KOMMO DIVIDIDO (Petrópolis + Caxias, 20/10/2026): o webhook chega sempre pela dona da conta (Petrópolis), mas
 * quem decide é a «⌂ Unidade de atendimento» do CARTÃO — a chave que vale é a da unidade do cartão, como na volta
 * de EM ESPERA. Cartão sem unidade (ou com um valor que nenhuma unidade usa) não é de ninguém: não grava e diz o
 * motivo no log. Sem a divisão gravada em `unit_crm_compartilhado` (ou com a tabela ainda não lida), a conta com
 * unidade de atendimento (`REGRAS_POR_UNIDADE`) só carimba o cartão da cidade da franquia dela — a mesma regra da
 * trava de escrita na franquia. Kommo de uma unidade só: nada muda, nem uma leitura a mais.
 */
import type { Unit } from '@prisma/client';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { esquemaDaUnidade, normalizarNome, type EsquemaKommo } from './kommo-schema.js';
import { logger } from './logger.js';
import { etapaEncerraConversa, STATUS_ENCERRADA } from './status-conversa.js';
import { automacaoLigada } from './automacoes-estado.js';
import { grupoDaUnidade, membroDoRotulo, valorDaUnidadeNoCartao, type GrupoDoCrm } from './crm-compartilhado.js';
import { regrasDaUnidade, travaPeloCampo, unidadeNoCartao } from './trava-unidade-atendimento.js';
import type { RegrasDaUnidade } from './unidade-por-canal.js';

export const CAMPOS_CARIMBO = {
  INICIO_TRAT: '◷ Início do tratamento',
  FIM_TRAT: '◷ Fim do tratamento',
  STATUS_CONVERSA: '⬢ Status da conversa',
} as const;

export interface CarimboEtapa {
  campo: string;
  tipo: 'date' | 'select';
  valor: string | number;
  /** true = não sobrescreve o que já está no cartão */
  soSeVazio: boolean;
  motivo: string;
}

const ETAPAS = {
  emTratamento: normalizarNome('EM TRATAMENTO'),
  alta: normalizarNome('ALTA'),
  cancelado: normalizarNome('TRATAMENTO CANCELADO'),
};

/** Puro: dado o nome da etapa de destino, o que carimbar. */
export function carimbosDaEtapa(nomeEtapa: string, agoraEpoch: number): CarimboEtapa[] {
  const n = normalizarNome(nomeEtapa);
  if (!n) return [];
  if (n === ETAPAS.emTratamento) {
    return [{ campo: CAMPOS_CARIMBO.INICIO_TRAT, tipo: 'date', valor: agoraEpoch, soSeVazio: true, motivo: 'lead entrou em EM TRATAMENTO' }];
  }
  if (n === ETAPAS.alta || n === ETAPAS.cancelado) {
    return [{ campo: CAMPOS_CARIMBO.FIM_TRAT, tipo: 'date', valor: agoraEpoch, soSeVazio: true, motivo: `lead foi pra ${nomeEtapa.trim()}` }];
  }
  // "GANHO / CONCLUÍDO" e variações ("GANHO", "CONCLUÍDO") fecham a conversa; PERDIDO também. A definição de
  // "etapa que encerra" mora em status-conversa.ts — a mesma que os outros escritores do campo respeitam.
  if (etapaEncerraConversa(nomeEtapa)) {
    return [{ campo: CAMPOS_CARIMBO.STATUS_CONVERSA, tipo: 'select', valor: STATUS_ENCERRADA, soSeVazio: false, motivo: `lead foi pra ${nomeEtapa.trim()}` }];
  }
  return [];
}

export function carimboEtapaLiberado(slug: string, raw: string | undefined = process.env.CARIMBO_ETAPA_SLUGS): boolean {
  return automacaoLigada(slug, 'carimbo-etapa', raw);
}

export interface EventoEtapa {
  id: number;
  status_id?: number;
  pipeline_id?: number;
}

export function valorAtual(lead: KommoLead, fieldId: number): string | null {
  const cf = (lead.custom_fields_values ?? []).find((f) => f.field_id === fieldId);
  const v = cf?.values?.[0]?.value;
  return v === null || v === undefined || v === '' ? null : String(v);
}

/**
 * De quem é o carimbo deste cartão — PURO. `slug` = a unidade cuja chave decide; `pula` = ninguém carimba, com o
 * motivo para o log. `grupo` = a divisão gravada (Petrópolis + Caxias); `regras` = a conta com unidade de atendimento
 * sem a divisão gravada; os dois null = Kommo de uma unidade só (o cartão é desta unidade, sem ler o campo).
 */
export type DonoDoCarimbo = { slug: string; rotulo: string | null } | { pula: string };

export function donoDoCarimbo(
  unit: Pick<Unit, 'slug'>,
  grupo: GrupoDoCrm | null,
  regras: RegrasDaUnidade | null,
  lead: Pick<KommoLead, 'custom_fields_values'> | null,
): DonoDoCarimbo {
  if (grupo) {
    const valor = valorDaUnidadeNoCartao(lead);
    if (!valor) return { pula: 'cartão sem ⌂ Unidade de atendimento — não é de nenhuma unidade da conta' };
    const membro = membroDoRotulo(grupo, valor);
    if (!membro) return { pula: `⌂ Unidade de atendimento "${valor}" não é de nenhuma unidade desta conta` };
    if (!membro.slug) return { pula: `unidade "${membro.rotulo}" sem slug na divisão da conta` };
    return { slug: membro.slug, rotulo: membro.rotulo };
  }
  if (regras) {
    const trava = travaPeloCampo(regras, lead ? unidadeNoCartao(lead) : null);
    if (trava) return { pula: `${trava.resumo} (divisão da conta não gravada: só carimba ${regras.cidadeDaFranquia})` };
    return { slug: unit.slug, rotulo: regras.cidadeDaFranquia };
  }
  return { slug: unit.slug, rotulo: null };
}

/** Para teste: o cliente do Kommo, o esquema da conta, o relógio, a variável da chave e a divisão da conta. */
export interface DepsCarimbo {
  kommo?: Pick<KommoClient, 'getLead' | 'setLeadCustomFieldValue'>;
  esquema?: Pick<EsquemaKommo, 'nomeDoStatus' | 'campoPorNome'>;
  agora?: number;
  raw?: string | undefined;
  /** Kommo dividido: o grupo da conta (padrão: `unit_crm_compartilhado`, em memória). */
  grupo?: GrupoDoCrm | null;
}

/** Aplica os carimbos de cada evento de etapa. Falha em um lead não derruba os outros. */
export async function aplicarCarimbosDeEtapa(unit: Unit, eventos: EventoEtapa[], deps: DepsCarimbo = {}): Promise<number> {
  const raw = 'raw' in deps ? deps.raw : process.env.CARIMBO_ETAPA_SLUGS;
  if (eventos.length === 0) return 0;
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) return 0;

  // Kommo dividido: o evento chega pela dona da conta, mas a chave que vale é a da unidade do CARTÃO. Aqui só o
  // portão barato: alguém do grupo com a chave ligada? A decisão por cartão vem abaixo, depois de ler o cartão.
  const grupo = 'grupo' in deps ? (deps.grupo ?? null) : await grupoDaUnidade(unit.id);
  if (grupo) {
    if (!grupo.membros.some((m) => m.slug && carimboEtapaLiberado(m.slug, raw))) return 0;
  } else if (!carimboEtapaLiberado(unit.slug, raw)) {
    return 0;
  }
  const regras = grupo ? null : regrasDaUnidade(unit.slug);

  const kommo = deps.kommo ?? createKommoClient(unit);
  const esquema = deps.esquema ?? (await esquemaDaUnidade(unit, kommo as KommoClient));
  const agora = deps.agora ?? Math.floor(Date.now() / 1000);
  let gravados = 0;

  for (const ev of eventos) {
    if (!ev.status_id || !ev.pipeline_id) continue;
    const nomes = esquema.nomeDoStatus(ev.pipeline_id, ev.status_id);
    if (!nomes) continue;
    const carimbos = carimbosDaEtapa(nomes.status, agora).filter((c) => esquema.campoPorNome(c.campo) !== null);
    if (carimbos.length === 0) continue;

    try {
      // Conta dividida (ou com unidade de atendimento): o cartão é lido sempre — é ele que diz de quem é.
      const precisaLer = !!grupo || !!regras || carimbos.some((c) => c.soSeVazio);
      const lead = precisaLer ? await kommo.getLead(ev.id) : null;
      const dono = donoDoCarimbo(unit, grupo, regras, lead);
      if ('pula' in dono) {
        logger.info({ unit: unit.slug, leadId: ev.id, etapa: nomes.status, motivo: dono.pula }, 'carimbo-etapa: não gravei — cartão não é desta unidade');
        continue;
      }
      // A chave que vale é a da unidade do cartão (no Kommo de uma unidade só, a desta — já conferida no portão).
      if (!carimboEtapaLiberado(dono.slug, raw)) {
        logger.info(
          { unit: unit.slug, leadId: ev.id, etapa: nomes.status, unidadeDoCartao: dono.rotulo, slugDoCartao: dono.slug },
          dono.slug === unit.slug
            ? 'carimbo-etapa: não gravei — a chave carimbo-etapa desta unidade está desligada'
            : 'carimbo-etapa: não gravei — cartão de outra unidade, e a chave carimbo-etapa dela está desligada',
        );
        continue;
      }
      for (const c of carimbos) {
        const fieldId = esquema.campoPorNome(c.campo)!;
        if (c.soSeVazio && lead && valorAtual(lead, fieldId)) {
          logger.debug({ unit: unit.slug, leadId: ev.id, campo: c.campo }, 'carimbo-etapa: campo já preenchido, mantido');
          continue;
        }
        await kommo.setLeadCustomFieldValue(ev.id, fieldId, c.tipo, c.valor);
        gravados++;
        logger.info(
          { unit: unit.slug, leadId: ev.id, etapa: nomes.status, campo: c.campo, motivo: c.motivo, ...(dono.rotulo ? { unidadeDoCartao: dono.rotulo } : {}) },
          'carimbo-etapa: campo gravado',
        );
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: ev.id, etapa: nomes.status }, 'carimbo-etapa: falha ao gravar (ignorada)');
    }
  }
  return gravados;
}
