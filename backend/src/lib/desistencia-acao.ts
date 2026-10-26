/**
 * O que o SISTEMA faz quando o paciente desiste da consulta e a Sofia está conversando (decisão do coordenador, 26/10/2026,
 * depois da reprovação do sênior no #132): a Sofia NÃO cancela na franquia — cancelar é irreversível e o classificador por
 * frases ainda erra. Ela oferece remarcar e, na recusa explícita, se despede SEM dizer que cancelou. Em código, aqui:
 *
 *  - `oferta`  : a Sofia vai oferecer horário → marca `desistencia_oferta` (o worker avisa a equipe se ele não responder);
 *  - `recusou` : recusa explícita → tarefa URGENTE "CANCELAR NA FRANQUIA" para o responsável do cartão, marca
 *                `recusou_remarcar` (para a NOSSA véspera e a NOSSA régua deste cartão) e etiqueta `NO_FOLLOW_UP`;
 *  - `duvida`  : manter, outra consulta, hesitação → tarefa "conferir com o paciente", SEM parar a véspera.
 *
 * Só com consulta ainda por vir (no cartão ou no vínculo da franquia): sem ela, "cancelei" pode ser o plano de saúde.
 */
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { logger } from './logger.js';
import { avisoRecente, marcarAviso, JANELA_24H_MS } from './aviso-dedupe.js';
import { consultaDoVinculoPadrao, estadoDaDesistencia, ID_AUTOMACAO, quandoDaConsultaPorVir } from './desistencia-da-consulta.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';
import type { Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';

export { ID_AUTOMACAO, estadoDaDesistencia };

export const MARCA_OFERTA = 'desistencia_oferta';
export const MARCA_RECUSOU = 'recusou_remarcar';
export const ETIQUETA_SEM_FOLLOW_UP = 'NO_FOLLOW_UP';

export function textoTarefaCancelarNaFranquia(a: { slug: string; nome: string | null; quando: string; trecho: string }): string {
  const trecho = a.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    `ALERTA · ${a.slug} · [Contato: ${a.nome || 'paciente'}] URGENTE — CANCELAR NA FRANQUIA — ${a.nome || 'paciente'}, consulta ${a.quando}. ` +
    `Recusou remarcar: "${trecho}". A Sofia se despediu dizendo que a equipe cancela. Cancele na franquia, ponha ✓ Situação da consulta = ` +
    'Desmarcado e tire o cartão de AGENDADO. A nossa véspera e a régua já pararam para este cartão e a etiqueta NO_FOLLOW_UP foi posta (tire-a se ele voltar atrás); os lembretes do Kommo continuam até você agir.'
  );
}

export function textoTarefaConferir(a: { slug: string; nome: string | null; quando: string; trecho: string }): string {
  const trecho = a.trecho.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    `ALERTA · ${a.slug} · [Contato: ${a.nome || 'paciente'}] CONFERIR COM O PACIENTE — ${a.nome || 'paciente'}, consulta ${a.quando}. ` +
    `Escreveu: "${trecho}" e não ficou claro se ele vem. A Sofia respondeu normal e NÃO cancelou; a véspera segue. Ligue ou escreva ` +
    'para confirmar se a consulta fica ou cai (e, se for de outra pessoa, qual).'
  );
}

export type ResultadoDaAcao = 'nada' | 'simulada' | 'marcada' | 'sem_consulta' | 'ja_avisada' | 'tarefa_aberta' | 'falhou';

export interface KommoDaAcao {
  getLead(id: number): Promise<KommoLead | null>;
  createTask(a: { leadId: number; text: string; completeAt: number; responsibleUserId?: number }): Promise<{ id?: number } | null>;
  addTag(a: { leadId: number; tags: string[] }): Promise<void>;
}

export interface DepsDaAcao {
  agora: () => Date;
  avisoRecente: typeof avisoRecente;
  marcarAviso: typeof marcarAviso;
  /** "AAAA-MM-DDTHH:mm" local da consulta ainda por vir no vínculo da franquia, ou null. */
  consultaDoVinculo: (unitId: string, leadId: number, agora: Date) => Promise<string | null>;
  estado: (slug: string) => Estado;
  simular: typeof registrarSimulacao;
}

const DEPS_PADRAO: DepsDaAcao = { agora: () => new Date(), avisoRecente, marcarAviso, consultaDoVinculo: (u, l) => consultaDoVinculoPadrao(u, l), estado: (slug) => estadoDaDesistencia(slug), simular: registrarSimulacao };

const emAndamento = new Set<string>();

export async function agirNaDesistencia(
  args: {
    unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone' | 'businessHoursTimezone'>;
    leadId: number;
    acao: 'oferta' | 'recusou' | 'duvida';
    trecho: string;
    kommo: () => KommoDaAcao;
    /** Vindo do worker que refaz a tarefa que falhou: não regrava a marca (a data dela é a da recusa). */
    refazendo?: boolean;
  },
  deps: DepsDaAcao = DEPS_PADRAO,
): Promise<ResultadoDaAcao> {
  const { unit, leadId, acao } = args;
  const trava = `${unit.id}:${leadId}:${acao}`;
  if (emAndamento.has(trava)) return 'ja_avisada';
  emAndamento.add(trava);
  try {
    const agora = deps.agora();
    const estado = deps.estado(unit.slug);
    if (estado === 'desligado') return 'nada';
    const seco = estado !== 'ligado';
    if (acao === 'oferta') {
      if (seco) {
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: `marca ${MARCA_OFERTA}`, motivo: 'a Sofia vai oferecer horário; sem resposta em 2 h abriria a tarefa "não respondeu"' });
        return 'simulada';
      }
      await deps.marcarAviso(unit.id, leadId, MARCA_OFERTA, agora);
      return 'marcada';
    }
    const kommo = args.kommo();
    const lead = await kommo.getLead(leadId).catch(() => null);
    let quando: string | null = await quandoDaConsultaPorVir({ unit, leadId, lead, agora, consultaDoVinculo: (u, l) => deps.consultaDoVinculo(u, l, agora) });
    // Cartão ilegível: não dá para saber se há consulta.
    if (!quando && !lead) {
      // Cartão ilegível e sem vínculo: não dá para provar a consulta, mas a Sofia já se despediu dizendo que a equipe cancela. A marca
      // (reversível) para a véspera e deixa o worker refazer a tarefa quando o Kommo voltar.
      if (acao === 'recusou' && !seco && !args.refazendo) await deps.marcarAviso(unit.id, leadId, MARCA_RECUSOU, agora);
      return 'falhou';
    }
    // Cartão legível e sem consulta por vir: "cancelei" pode ser o plano de saúde. Mas na RECUSA a Sofia já prometeu "vou avisar a
    // equipe" — a promessa não fica sem executor: vira "conferir", sem parar nada.
    let efetiva: 'recusou' | 'duvida' = acao;
    if (!quando) {
      if (acao !== 'recusou') return 'sem_consulta';
      efetiva = 'duvida';
      quando = 'sem data no cartão nem na franquia';
    }

    const nome = primeiroNomeDoPaciente(lead?.name, null);
    const info = { slug: unit.slug, nome, quando, trecho: args.trecho };
    // EM SECO: tudo o que gravaria vira linha na tela de Automações, nada vai ao Kommo nem ao banco
    if (seco) {
      const trecho = args.trecho.replace(/\s+/g, ' ').slice(0, 120);
      if (efetiva === 'recusou') {
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'alertaria', alvo: 'tarefa URGENTE CANCELAR NA FRANQUIA', valor: textoTarefaCancelarNaFranquia(info), motivo: `recusou remarcar: "${trecho}"` });
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: `marca ${MARCA_RECUSOU} (para a véspera e a régua)`, motivo: `consulta ${quando}` });
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'etiquetaria', alvo: ETIQUETA_SEM_FOLLOW_UP, motivo: 'recusou remarcar' });
      } else {
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'alertaria', alvo: 'tarefa CONFERIR COM O PACIENTE', valor: textoTarefaConferir(info), motivo: `dúvida: "${trecho}"` });
      }
      return 'simulada';
    }

    // a NOSSA véspera e a NOSSA régua param JÁ, antes de qualquer chamada que possa falhar
    if (efetiva === 'recusou' && !args.refazendo) await deps.marcarAviso(unit.id, leadId, MARCA_RECUSOU, agora);

    const chaveTarefa = `desistencia_tarefa:${efetiva === 'recusou' ? 'cancelar' : 'conferir'}`;
    if (await deps.avisoRecente(unit.id, leadId, chaveTarefa, JANELA_24H_MS, agora)) return 'ja_avisada';
    const criada = await kommo.createTask({
      leadId,
      text: efetiva === 'recusou' ? textoTarefaCancelarNaFranquia(info) : textoTarefaConferir(info),
      completeAt: Math.floor(agora.getTime() / 1000) + (efetiva === 'recusou' ? 30 * 60 : 2 * 3600),
      ...(lead?.responsible_user_id ? { responsibleUserId: lead.responsible_user_id } : {}),
    });
    if (!criada) return 'falhou';
    await deps.marcarAviso(unit.id, leadId, chaveTarefa, agora);
    if (efetiva === 'recusou') {
      await kommo.addTag({ leadId, tags: [ETIQUETA_SEM_FOLLOW_UP] }).catch((err) => logger.warn({ err: String(err), leadId }, 'desistência: não pus NO_FOLLOW_UP (segue)'));
    }
    logger.info({ unit: unit.slug, leadId, acao, quando }, 'desistência da consulta: tarefa aberta para a equipe');
    return 'tarefa_aberta';
  } catch (err) {
    logger.warn({ unit: unit.slug, leadId, acao, err: String(err) }, 'desistência da consulta: ação falhou — segue');
    return 'falhou';
  } finally {
    emAndamento.delete(trava);
  }
}
