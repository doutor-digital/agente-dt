/**
 * "TENHO UMA DÚVIDA" NO LEMBRETE DO ROBÔ DO KOMMO — a conversa vai para a secretária NA HORA, calado.
 *
 * O caso (Salto, lead 3185496, 17/11/2026): o robô do Kommo mandou o lembrete da consulta de hoje ("❗️ IMPORTANTE … Ficou alguma
 * dúvida?", botões "Está tudo certo" / "Tenho uma dúvida"), o paciente tocou "Tenho uma dúvida" e a Sofia respondeu por cima —
 * `units.source_papel` de Salto manda passar para a secretária sem avisar o paciente, e a IA ignorou. Mandar o modelo "obedecer o
 * prompt" é torcer; aqui é código, o mesmo desenho do toque em "Confirmar presença"/"Preciso remarcar" (`resposta-ao-lembrete.ts`).
 *
 * O QUE CONTA: três coisas juntas, e falta uma = a mensagem segue para a Sofia como sempre:
 *   1. o texto é EXATAMENTE o do botão ("Tenho uma dúvida", sem acento/caixa/pontuação) — "tenho uma dúvida sobre o preço" é conversa;
 *   2. a última mensagem que saiu na conversa oficial é um LEMBRETE de robô (`provaDoLembrete`: não é fala da equipe, não é fala
 *      da Sofia, saiu há menos de 30 h e fala de consulta/sessão) — o botão só existe nesse modelo;
 *   3. o cartão ainda não está com "Pausar IA" marcado (se já está, a equipe/IA já passou a conversa; nada a fazer aqui).
 *
 * O QUE ACONTECE (chave `duvida-no-lembrete`, DUVIDA_NO_LEMBRETE_SLUGS): a Sofia NÃO gera resposta e o paciente não recebe nada. Marca
 * "Pausar IA", carimba "assumido por humano" (o mesmo carimbo do handoff comum da Sofia) e abre UMA tarefa para a equipe com o aviso.
 * NÃO mexe na etapa do cartão (quem está em ALTA/TRATAMENTO dispararia automação de etapa) e NÃO grava na franquia.
 *
 * Nasce em "só no papel" (quandoVazio 'seco'): o seco decide e registra na tela, não pausa, não cria tarefa, e a mensagem segue
 * para a Sofia exatamente como hoje. "Ligado" só por unidade, pela lista do `.env` ou pela tela.
 */
import type { Conversation, Unit } from '@prisma/client';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { normalizar } from './franquia-sync.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';
import { DEPS_LEMBRETE_PADRAO, provaDoLembrete, type KommoDoLembrete, type ProvaDoLembrete } from './resposta-ao-lembrete.js';
import { carimbarHumanoAssumiu } from '../services/lead-metrics.service.js';
import { cancelarReativacao } from './pausa-equipe.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';

export const AUTOMACAO_DUVIDA_NO_LEMBRETE = 'duvida-no-lembrete';
/** O rótulo do botão do modelo do Kommo, já normalizado (sem acento, caixa nem pontuação). Igualdade exata. */
export const BOTAO_DUVIDA = 'tenho uma duvida';
/** A tarefa da equipe vence em 10 min: é "na hora", não "hoje". */
export const PRAZO_DA_TAREFA_S = 10 * 60;

export function estadoDaDuvidaNoLembrete(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_DUVIDA_NO_LEMBRETE, env.DUVIDA_NO_LEMBRETE_SLUGS);
}

/** PURA: o texto é o do botão "Tenho uma dúvida"? Igualdade exata — "tenho uma dúvida sobre o valor" vai para a Sofia. */
export function ehToqueDeDuvida(texto: string): boolean {
  return normalizar(texto) === BOTAO_DUVIDA;
}

/**
 * Teste SÍNCRONO e barato: esta mensagem pode ser o toque tratado aqui? Serve para o webhook responder 200 ao Kommo ANTES do trabalho
 * (o Kommo dá 2 s e reenvia quem passa disso) — mesmo padrão de `podeSerBotaoDoLembrete`. Com a chave desligada, não responde antes.
 */
export function podeSerDuvidaDoLembrete(slug: string, texto: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return ehToqueDeDuvida(texto) && estadoDaDuvidaNoLembrete(slug, env) !== 'desligado';
}

/** PURA: o texto da tarefa que a equipe vê. */
export function textoDaTarefaDeDuvida(args: { slug: string; nome: string | null | undefined; prova: Pick<ProvaDoLembrete, 'tipo'>; texto: string }): string {
  const de = args.prova.tipo === 'sessao' ? 'da sessão' : args.prova.tipo === 'consulta' ? 'da consulta' : 'do agendamento';
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome ?? 'paciente'}] ❓ O paciente tocou "${args.texto.trim().slice(0, 60)}" no lembrete ${de}. ` +
    'A Sofia NÃO respondeu e o paciente não foi avisado: a conversa está com a equipe ("Pausar IA" marcado). Responda a dúvida pelo WhatsApp.'
  );
}

export type ResultadoDaPausaDuvida = 'marcou' | 'sem_campo';

export interface DepsDuvida {
  agora: () => Date;
  /** A conversa oficial do Kommo. null = não consegui ler (aí não há prova: segue para a Sofia). */
  oficiais: (unit: Unit, kommo: KommoDoLembrete, leadId: number) => Promise<MensagemOficial[] | null>;
  /** O que a Sofia disse ao paciente desde `desde` — para não confundir fala dela com lembrete do robô. */
  falasDaSofia: (unitId: string, leadId: number, desde: Date) => Promise<string[]>;
  /** A caixinha "Pausar IA" já está marcada? Lança se não deu para ler (aí segue para a Sofia). */
  pausado: (unit: Unit, leadId: number) => Promise<boolean>;
  /** Marca "Pausar IA", carimba "assumido por humano" e cancela a reativação pendente do handoff. */
  pausar: (unit: Unit, leadId: number) => Promise<ResultadoDaPausaDuvida>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

export const DEPS_DUVIDA_PADRAO: DepsDuvida = {
  agora: () => new Date(),
  oficiais: DEPS_LEMBRETE_PADRAO.oficiais,
  falasDaSofia: DEPS_LEMBRETE_PADRAO.falasDaSofia,
  // Uma leitura só do campo, e que LANÇA se o Kommo falhar (`isLeadPaused` engoliria o erro e diria "não pausado").
  pausado: async (unit, leadId) => (unit.kommoPausedFieldId ? createKommoClient(unit).isLeadFieldChecked(leadId, unit.kommoPausedFieldId) : false),
  pausar: async (unit, leadId) => {
    if (!unit.kommoPausedFieldId) return 'sem_campo';
    const kommo = createKommoClient(unit);
    await cancelarReativacao(unit, leadId); // gente assumiu: um handoff velho da Sofia não pode reabrir a conversa em 30 min
    await kommo.setLeadFieldFlag(leadId, unit.kommoPausedFieldId, true);
    // Bloco DIGITAL: assumido por humano = Sim, status = Respondendo (o mesmo carimbo do handoff comum da Sofia).
    void carimbarHumanoAssumiu(unit, kommo, leadId);
    return 'marcou';
  },
  simular: registrarSimulacao,
};

export interface ResultadoDaDuvida {
  /** 'em_andamento' = outro toque do mesmo paciente já está passando a conversa agora: este não refaz (nem vai para a Sofia). */
  resultado: 'passou' | 'em_andamento';
  pausa: ResultadoDaPausaDuvida | null;
  tarefa: boolean;
}

/** Dois toques seguidos (ids de mensagem diferentes) passariam os dois pela leitura da caixinha antes de qualquer um marcar. */
const emAndamento = new Set<string>();

/**
 * Trata o toque em "Tenho uma dúvida" de um lembrete do robô do Kommo. null = não é caso daqui (ou está só no papel) e a mensagem
 * segue para a Sofia como sempre. Erro ANTES de pausar sobe para o chamador (que manda para a Sofia — o lado de antes).
 */
export async function tratarDuvidaDoLembrete(
  args: {
    unit: Unit;
    leadId: number;
    texto: string;
    conv: Pick<Conversation, 'id' | 'contactName' | 'phone'>;
    kommo: Pick<KommoClient, 'createTask'> & KommoDoLembrete;
    env?: NodeJS.ProcessEnv;
  },
  deps: DepsDuvida = DEPS_DUVIDA_PADRAO,
): Promise<ResultadoDaDuvida | null> {
  const { unit, leadId, texto, conv, kommo } = args;
  if (!ehToqueDeDuvida(texto)) return null;
  const estado = estadoDaDuvidaNoLembrete(unit.slug, args.env ?? process.env);
  if (estado === 'desligado') return null;
  const log = { unit: unit.slug, leadId };

  const agora = deps.agora();
  const msgs = await deps.oficiais(unit, kommo, leadId);
  if (!msgs) {
    logger.info(log, 'dúvida no lembrete: não li a conversa oficial — sem prova do lembrete, segue para a Sofia');
    return null;
  }
  const falas = await deps.falasDaSofia(unit.id, leadId, new Date(agora.getTime() - 31 * 3600_000));
  const prova = provaDoLembrete({ msgs, agora, falasDaSofia: falas });
  if (!prova) {
    logger.info(log, 'dúvida no lembrete: a última fala não foi um lembrete do robô — segue para a Sofia');
    return null;
  }

  // Cartão já pausado (a equipe, a recepção ou a própria Sofia): a conversa já é de gente e o webhook pula a Sofia sozinho. Também é
  // o que impede a 2ª tarefa quando o paciente toca de novo. (Reenvio do mesmo toque pelo Kommo nem chega aqui: o webhook reivindica
  // o id da mensagem por 2 h.)
  if (await deps.pausado(unit, leadId)) {
    logger.info(log, 'dúvida no lembrete: "Pausar IA" já estava marcado — a conversa já é da equipe, nada a fazer aqui');
    return null;
  }

  if (estado === 'seco') {
    deps.simular(unit, AUTOMACAO_DUVIDA_NO_LEMBRETE, {
      leadId,
      acao: 'gravaria',
      alvo: 'Pausar IA + tarefa para a equipe (sem resposta ao paciente)',
      valor: 'Sim',
      motivo: `o paciente tocou "Tenho uma dúvida" no lembrete do robô (${prova.tipo}); com a chave ligada a Sofia não responde e a conversa vai para a secretária`,
    });
    logger.info({ ...log, tipo: prova.tipo }, 'dúvida no lembrete [seco]: passaria para a equipe calado (a Sofia segue)');
    return null;
  }

  // A leitura da caixinha e a marcação não são atômicas: o 2º toque seguido espera a marca deste processo em vez de abrir outra tarefa.
  // (Calado para a Sofia também: o 1º toque já está passando a conversa.)
  const trava = `${unit.id}:${leadId}`;
  if (emAndamento.has(trava)) {
    logger.info(log, 'dúvida no lembrete: outro toque do mesmo paciente já está passando a conversa — este não refaz');
    return { resultado: 'em_andamento', pausa: null, tarefa: false };
  }
  emAndamento.add(trava);
  try {
    const pausa = await deps.pausar(unit, leadId);
    if (pausa === 'sem_campo') {
      // Sem a caixinha não há como segurar a Sofia: ela responde como sempre (e o toque segue para ela).
      logger.warn(log, 'dúvida no lembrete: unidade sem a caixinha "Pausar IA" — não dá para passar calado, segue para a Sofia');
      return null;
    }
    const tarefa = await kommo
      .createTask({
        leadId,
        text: textoDaTarefaDeDuvida({ slug: unit.slug, nome: conv.contactName, prova, texto }),
        completeAt: Math.floor(agora.getTime() / 1000) + PRAZO_DA_TAREFA_S,
      })
      .then(() => true)
      .catch((err) => {
        logger.warn({ ...log, err: String(err) }, 'dúvida no lembrete: falha ao abrir a tarefa (a pausa já está marcada)');
        return false;
      });
    logger.info({ ...log, tipo: prova.tipo, pausa, tarefa }, 'dúvida no lembrete: a Sofia não respondeu — conversa passada para a equipe, calado');
    return { resultado: 'passou', pausa, tarefa };
  } finally {
    emAndamento.delete(trava);
  }
}
