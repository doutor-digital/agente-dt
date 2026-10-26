/**
 * O que o SISTEMA faz quando o paciente desiste da consulta e a Sofia está conversando (decisão do coordenador, 26/10/2026,
 * depois da reprovação do sênior no #132): a Sofia NÃO cancela na franquia — cancelar é irreversível e o classificador por
 * frases ainda erra. Ela oferece remarcar e, na recusa explícita, se despede SEM dizer que cancelou. Em código, aqui:
 *
 *  - `oferta`  : a Sofia vai oferecer horário → marca `desistencia_oferta:<consulta>` (o worker avisa a equipe se ele não responder);
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
import { consultaDoVinculoPadrao, estadoDaDesistencia, ID_AUTOMACAO, quandoDaConsultaPorVir, textoTarefaDesistenciaSemIA } from './desistencia-da-consulta.js';
import { citouHorario, pareceDesistenciaDaConsulta } from './desistencia-frases.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';
import type { Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';

export { ID_AUTOMACAO, estadoDaDesistencia };

/** As marcas levam a CONSULTA a que se referem (`<prefixo>:<AAAA-MM-DDTHH:mm>`): remarcou = outra consulta = marca que não vale mais. */
export const MARCA_OFERTA = 'desistencia_oferta';
export const MARCA_RECUSOU = 'recusou_remarcar';
export const chaveDaMarca = (prefixo: string, iso: string): string => `${prefixo}:${iso}`;
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

export type ResultadoDaAcao =
  | 'nao_e'
  | 'nada'
  | 'simulada'
  | 'marcada'
  | 'sem_consulta'
  | 'remarcou'
  | 'ja_avisada'
  | 'tarefa_aberta'
  | 'falhou';

/**
 * As ações do sistema. As três primeiras vêm da conversa em andamento com a Sofia; `ia_calada` (a Sofia não vai responder) e
 * `sem_resposta` (ela ofereceu horário e ele não respondeu) abrem a tarefa do "Escreveu que não vem".
 */
export type AcaoDoSistema = 'oferta' | 'recusou' | 'duvida' | 'ia_calada' | 'sem_resposta';

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

const DEPS_PADRAO: DepsDaAcao = {
  agora: () => new Date(),
  avisoRecente,
  marcarAviso,
  consultaDoVinculo: (u, l) => consultaDoVinculoPadrao(u, l),
  estado: (slug) => estadoDaDesistencia(slug),
  simular: registrarSimulacao,
};

const emAndamento = new Set<string>();

export interface ArgsDaAcao {
  unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone' | 'businessHoursTimezone'>;
  leadId: number;
  acao: AcaoDoSistema;
  /** O texto do paciente neste turno (a fala da recusa/dúvida; na oferta, o turno inteiro). */
  trecho: string;
  kommo: () => KommoDaAcao;
  nome?: string | null;
  /** Vindo do worker que refaz a tarefa que falhou: não regrava a marca (a data dela é a da recusa). */
  refazendo?: boolean;
  /** Só `sem_resposta`: a consulta da marca — se hoje é outra, ele remarcou e não há o que avisar. */
  consultaDaMarca?: string;
}

/**
 * Faz (ou, em seco, só registra) o que o sistema deve fazer com a desistência. Nunca lança. `kommo` é uma fábrica: um cliente
 * que não nasce (unidade sem credencial) não pode derrubar o webhook.
 */
export async function agirNaDesistencia(args: ArgsDaAcao, deps: DepsDaAcao = DEPS_PADRAO): Promise<ResultadoDaAcao> {
  const { unit, leadId, acao } = args;
  const dos2 = acao === 'ia_calada' || acao === 'sem_resposta';
  if (dos2 && !pareceDesistenciaDaConsulta(args.trecho)) return 'nao_e';
  const trava = `${unit.id}:${leadId}:${acao}`;
  if (emAndamento.has(trava)) return 'ja_avisada';
  emAndamento.add(trava);
  try {
    const agora = deps.agora();
    const estado = deps.estado(unit.slug);
    if (estado === 'desligado') return 'nada';
    const seco = estado !== 'ligado';
    // ele já ESCOLHEU horário neste turno ("não vou poder ir amanhã, pode ser sexta às 10h?"): a Sofia remarca, não há o que aguardar
    if (acao === 'oferta' && citouHorario(args.trecho)) return 'nada';

    const kommo = args.kommo();
    const lead = await kommo.getLead(leadId).catch(() => null);
    let consulta = await quandoDaConsultaPorVir({ unit, leadId, lead, agora, consultaDoVinculo: (u, l) => deps.consultaDoVinculo(u, l, agora) });

    // Cartão ilegível: não dá para saber se há consulta.
    if (!consulta && !lead) {
      // Na RECUSA a Sofia já se despediu dizendo que a equipe cancela: a marca (reversível) deixa o worker refazer a tarefa.
      if (acao === 'recusou' && !seco && !args.refazendo) await deps.marcarAviso(unit.id, leadId, chaveDaMarca(MARCA_RECUSOU, '?'), agora);
      return 'falhou';
    }
    // Cartão legível e sem consulta por vir: "cancelei" pode ser o plano de saúde — não age, nem a oferta marca. Na RECUSA a Sofia já
    // prometeu "vou avisar a equipe": a promessa não fica sem executor — vira "conferir", sem parar nada.
    let efetiva: AcaoDoSistema = acao;
    if (!consulta) {
      if (acao !== 'recusou') return 'sem_consulta';
      efetiva = 'duvida';
      consulta = { label: 'sem data no cartão nem na franquia', iso: '?' };
    }
    // sem_resposta: se hoje a consulta é OUTRA, ele remarcou (a Sofia ou a equipe) — nada a avisar
    if (acao === 'sem_resposta' && args.consultaDaMarca && args.consultaDaMarca !== '?' && consulta.iso !== args.consultaDaMarca) return 'remarcou';

    const nome = primeiroNomeDoPaciente(lead?.name, args.nome ?? null);
    const info = { slug: unit.slug, nome, quando: consulta.label, trecho: args.trecho };
    const trecho = args.trecho.replace(/\s+/g, ' ').slice(0, 120);
    const texto =
      efetiva === 'recusou'
        ? textoTarefaCancelarNaFranquia(info)
        : efetiva === 'duvida'
          ? textoTarefaConferir(info)
          : textoTarefaDesistenciaSemIA({ slug: unit.slug, nome, quando: consulta.label, mensagem: args.trecho, motivo: efetiva === 'sem_resposta' ? 'sem_resposta' : 'ia_calada' });

    // EM SECO: tudo o que gravaria vira linha na tela de Automações, nada vai ao Kommo nem ao banco
    if (seco) {
      if (acao === 'oferta') {
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: `marca ${MARCA_OFERTA}`, motivo: 'a Sofia vai oferecer horário; sem resposta em 2 h abriria a tarefa "não respondeu"' });
      } else if (efetiva === 'recusou') {
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'alertaria', alvo: 'tarefa URGENTE CANCELAR NA FRANQUIA', valor: texto, motivo: `recusou remarcar: "${trecho}"` });
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'gravaria', alvo: `marca ${MARCA_RECUSOU} (para a véspera e a régua)`, motivo: `consulta ${consulta.label}` });
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'etiquetaria', alvo: ETIQUETA_SEM_FOLLOW_UP, motivo: 'recusou remarcar' });
      } else {
        const alvo = efetiva === 'duvida' ? 'tarefa CONFERIR COM O PACIENTE' : efetiva === 'sem_resposta' ? 'tarefa "não respondeu à oferta"' : 'tarefa "IA calada: ele escreveu que não vem"';
        deps.simular(unit, ID_AUTOMACAO, { leadId, acao: 'alertaria', alvo, valor: texto, motivo: efetiva === 'duvida' ? `dúvida: "${trecho}"` : `consulta ${consulta.label}` });
      }
      return 'simulada';
    }

    if (acao === 'oferta') {
      await deps.marcarAviso(unit.id, leadId, chaveDaMarca(MARCA_OFERTA, consulta.iso), agora);
      return 'marcada';
    }
    // a NOSSA véspera e a NOSSA régua param JÁ, antes de qualquer chamada que possa falhar
    if (efetiva === 'recusou' && !args.refazendo) await deps.marcarAviso(unit.id, leadId, chaveDaMarca(MARCA_RECUSOU, consulta.iso), agora);

    const chave = efetiva === 'recusou' ? 'desistencia_tarefa:cancelar' : `desistencia_tarefa:${efetiva === 'duvida' ? 'conferir' : efetiva}`;
    if (await deps.avisoRecente(unit.id, leadId, chave, JANELA_24H_MS, agora)) return 'ja_avisada';
    const criada = await kommo.createTask({
      leadId,
      text: texto,
      completeAt: Math.floor(agora.getTime() / 1000) + (efetiva === 'recusou' ? 30 * 60 : efetiva === 'duvida' ? 2 * 3600 : 60 * 60),
      ...(lead?.responsible_user_id ? { responsibleUserId: lead.responsible_user_id } : {}),
    });
    // marca SÓ depois de o Kommo confirmar: falha de rede não pode calar o aviso por 24 h
    if (!criada) return 'falhou';
    await deps.marcarAviso(unit.id, leadId, chave, agora);
    if (efetiva === 'recusou') {
      await kommo.addTag({ leadId, tags: [ETIQUETA_SEM_FOLLOW_UP] }).catch((err) => logger.warn({ err: String(err), leadId }, 'desistência: não pus NO_FOLLOW_UP (segue)'));
    }
    logger.info({ unit: unit.slug, leadId, acao, quando: consulta.label }, 'desistência da consulta: tarefa aberta para a equipe');
    return 'tarefa_aberta';
  } catch (err) {
    logger.warn({ unit: unit.slug, leadId, acao, err: String(err) }, 'desistência da consulta: ação falhou — segue');
    return 'falhou';
  } finally {
    emAndamento.delete(trava);
  }
}

/** Atalho das tarefas de "IA calada" (webhook) e "sem resposta" (worker): mesma função, outra ação. */
export function abrirTarefaDaDesistencia(
  a: { unit: ArgsDaAcao['unit']; leadId: number; texto: string; motivo: 'ia_calada' | 'sem_resposta'; nome?: string | null; kommo: () => KommoDaAcao; consultaDaMarca?: string },
  deps?: DepsDaAcao,
): Promise<ResultadoDaAcao> {
  return agirNaDesistencia({ unit: a.unit, leadId: a.leadId, acao: a.motivo, trecho: a.texto, kommo: a.kommo, nome: a.nome, consultaDaMarca: a.consultaDaMarca }, deps);
}
