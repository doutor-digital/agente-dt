/**
 * ALERTA NO TELEGRAM + TAREFA NO CARTÃO: paciente que escreveu e ficou 5 minutos sem resposta (decisão do João,
 * 16/10/2026; a tarefa foi pedida em 30/10/2026 depois que o alerta do Timbó chegou só ao João).
 *
 * Piloto na Açailândia, atrás da chave `alerta-sem-resposta` (ALERTA_SEM_RESPOSTA_SLUGS). Vai para o
 * Telegram do João e, no mesmo momento, vira uma tarefa "ALERTA · slug · …" no cartão para a equipe da unidade
 * (prazo = agora, responsável = o do cartão). Cada saída tem a sua marca em `card_alert`, então uma que falha
 * não cala nem repete a outra. Os grupos das unidades no Telegram ficam para depois.
 *
 * O QUE CONTA COMO RESPOSTA (a escolha conservadora, explicada no PR):
 *   Qualquer mensagem que SAIU para o paciente depois da dele — da equipe, da Sofia ou de um robô do
 *   Kommo. Alerta só quando ninguém respondeu nada. Contar só gente ("resposta humana" ao pé da letra)
 *   alertaria cada conversa que a Sofia atende sozinha — dezenas por dia na Açailândia — e o alerta
 *   que toca o tempo todo é o alerta que ninguém lê. Para endurecer depois (só a equipe conta), basta
 *   trocar `esperaDoPaciente` para ignorar as saídas da Sofia.
 *
 * QUEM DECIDE: a conversa oficial do Kommo (a mesma que a Sofia lê antes de responder), não o nosso
 * banco — a resposta da SDR pelo Kommo ou pelo celular não passa por aqui. O banco só serve para achar
 * candidatos baratos: mensagem do paciente gravada entre 5 e 65 minutos atrás, sem resposta da Sofia
 * gravada depois dela.
 *
 * Travas: horário de atendimento da unidade (o mesmo do alerta de SLA: dias da agenda, 8h–20h, sem
 * feriado); mensagem de no máximo 60 min (a volta de uma queda não vira rajada); um alerta por espera
 * (a marca guarda QUANDO o alerta saiu — só volta a avisar depois que alguém responder
 * e o paciente ficar sem resposta de novo). "Só no papel": registra na tela o que alertaria.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { dentroDoHorario, humanizarEspera } from './sla-alert-worker.js';
import { enviarTelegram, telegramConfigurado } from './telegram.js';
import { ehEncerramento } from './encerramento.js';
import { mascararPii } from './pii.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';
import { esquemaDaUnidade } from './kommo-schema.js';
import { marcarAviso, marcadoEm } from './aviso-dedupe.js';
import { createKommoClient } from '../services/kommo.service.js';
import { mensagensOficiais, type MensagemOficial } from '../services/kommo-talks.service.js';

export const AUTOMACAO_SEM_RESPOSTA = 'alerta-sem-resposta';
/** Quanto o paciente espera antes do alerta. */
export const ESPERA_MS = 5 * 60_000;
/** Mensagem mais velha que ESPERA + isto não alerta mais. */
export const JANELA_MS = 60 * 60_000;
/**
 * A marca em `card_alert`: uma linha por lead, com `created_at` = QUANDO o alerta saiu. A mesma espera é
 * "nenhuma saída depois do alerta". Antes a marca guardava o início da espera, e quem mandava mais de 20
 * mensagens seguidas mudava esse início a cada mensagem (a conversa oficial só traz as últimas) — um
 * alerta novo a cada mensagem (revisão de 16/10, item 6).
 */
export const REGRA_SEM_RESPOSTA = 'sem_resposta_telegram';
/**
 * A marca da TAREFA no cartão (30/10/2026): outra linha em `card_alert`, com a mesma regra de "mesma espera".
 * Separada da do Telegram de propósito — se uma das duas saídas falhar, a outra não repete nem é calada.
 */
export const REGRA_SEM_RESPOSTA_TAREFA = 'sem_resposta_tarefa';
/** Espera que segue sem resposta há mais que isto ganha UM lembrete novo (e cobre a conversa nova de quem volta semanas depois). */
export const REALERTA_MS = 12 * 3600_000;
/** Quantas mensagens da conversa oficial se leem: folga para ver a resposta mesmo com o paciente escrevendo muito. */
const MENSAGENS_LIDAS = 40;

/**
 * PURA: esta espera já foi alertada? Sim quando houve alerta há menos de 12 h e nada saiu para o paciente
 * depois dele.
 */
export function mesmaEsperaJaAlertada(
  msgs: ReadonlyArray<Pick<MensagemOficial, 'direcao' | 'em'>>,
  alertadoEm: Date | null,
  agora: Date,
): boolean {
  if (!alertadoEm) return false;
  if (agora.getTime() - alertadoEm.getTime() >= REALERTA_MS) return false;
  return !msgs.some((m) => m.direcao === 'saida' && m.em.getTime() > alertadoEm.getTime());
}
const SWEEP_MS = 60_000;
const MAX_CANDIDATAS = 200;

export function estadoDoAlertaSemResposta(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDaAutomacao(slug, AUTOMACAO_SEM_RESPOSTA, env.ALERTA_SEM_RESPOSTA_SLUGS);
}

/**
 * PURA: desde quando o paciente espera — a primeira mensagem dele depois da última que saiu. null = a
 * última fala da conversa foi para o paciente (respondido) ou ele não escreveu nada.
 */
export interface EsperaDoPaciente {
  /** A primeira mensagem do paciente sem resposta — é daqui que a espera conta. */
  desde: Date;
  /** A mais recente dele. */
  ultimaEm: Date;
  ultimaTexto: string;
  /** Todos os textos dele desde `desde`, em ordem. */
  textos: string[];
}

export function esperaDoPaciente(msgs: ReadonlyArray<Pick<MensagemOficial, 'direcao' | 'em' | 'texto'>>): EsperaDoPaciente | null {
  const ordenadas = [...msgs].sort((a, b) => a.em.getTime() - b.em.getTime());
  let desde: Date | null = null;
  let ultima: Pick<MensagemOficial, 'em' | 'texto'> | null = null;
  const textos: string[] = [];
  for (let i = ordenadas.length - 1; i >= 0; i--) {
    const m = ordenadas[i];
    if (m.direcao === 'saida') break;
    desde = m.em;
    textos.unshift(m.texto);
    if (ultima === null) ultima = m;
  }
  return desde && ultima ? { desde, ultimaEm: ultima.em, ultimaTexto: ultima.texto, textos } : null;
}

/** Cumprimento e "sim/não" pedem resposta, mesmo curtos — só agradecimento e "ok" não pedem. */
const PEDE_RESPOSTA = /\b(oi|ol[aá]|bom dia|boa tarde|boa noite|sim|n[aã]o)\b/i;

/**
 * PURA: a espera é só agradecimento ("ok", "obrigada 🙏", "👍")? Ninguém precisa responder isso — e a
 * Sofia de propósito não responde o segundo "obrigado" (encerramento repetido). Mensagem sem texto
 * (áudio, imagem) pede resposta.
 */
export function soAgradecimento(textos: readonly string[]): boolean {
  return textos.length > 0 && textos.every((t) => t.trim() !== '' && ehEncerramento(t) && !PEDE_RESPOSTA.test(t));
}

/**
 * PURA: alerta agora? O paciente espera há 5 min ou mais E escreveu na última hora. A segunda trava
 * segura a rajada da volta de uma queda; ela olha a ÚLTIMA mensagem (e não a primeira) para não perder
 * quem começou a esperar com a clínica fechada e voltou a escrever de manhã.
 */
export function deveAlertar(espera: Pick<EsperaDoPaciente, 'desde' | 'ultimaEm'>, agora: Date): boolean {
  return (
    agora.getTime() - espera.desde.getTime() >= ESPERA_MS &&
    agora.getTime() - espera.ultimaEm.getTime() <= ESPERA_MS + JANELA_MS
  );
}

export function textoDoAlerta(args: {
  unidade: string;
  contato: string | null;
  leadId: number;
  etapa: string | null;
  esperaMs: number;
  ultima: string;
  link: string | null;
  /** Como ficou a tarefa no cartão: o João precisa saber se a recepção foi avisada ou se é para ele avisar. */
  tarefa?: 'criada' | 'falhou' | null;
}): string {
  const ultima = mascararPii(args.ultima.replace(/\s+/g, ' ').trim()).slice(0, 160);
  return [
    `⏰ Paciente sem resposta há ${humanizarEspera(args.esperaMs)} — ${args.unidade}`,
    `Contato: ${args.contato?.trim() || 'paciente'} (lead ${args.leadId})`,
    ...(args.etapa ? [`Etapa: ${args.etapa}`] : []),
    `Última mensagem: "${ultima || '(sem texto: áudio, imagem ou figurinha)'}"`,
    ...(args.tarefa === 'criada' ? ['✅ Tarefa criada no cartão para a equipe da unidade.'] : []),
    ...(args.tarefa === 'falhou' ? ['⚠️ Tarefa NÃO criada no cartão — avise a recepção da unidade.'] : []),
    ...(args.link ? [args.link] : []),
  ].join('\n');
}

/**
 * Texto da TAREFA no cartão do Kommo (a equipe da unidade lê isto). O prefixo `ALERTA · <slug> ·` é o mesmo das
 * outras tarefas de alerta (SLA, lembrete…): é a chave do roteador de alertas. Trecho curto e sem dado sensível.
 */
export function textoDaTarefa(args: { slug: string; contato: string | null; esperaMs: number; ultima: string }): string {
  const ultima = mascararPii(args.ultima.replace(/\s+/g, ' ').trim()).slice(0, 100);
  const nome = args.contato?.replace(/\s+/g, ' ').trim();
  return (
    `ALERTA · ${args.slug} · ${nome ? `[Contato: ${nome}] ` : ''}` +
    `Paciente sem resposta há ${humanizarEspera(args.esperaMs)}. ` +
    `Última mensagem: "${ultima || '(sem texto: áudio, imagem ou figurinha)'}". Responda agora.`
  );
}

export interface CandidataSemResposta {
  leadId: number;
  contactName: string | null;
  /** A mensagem mais recente do paciente no nosso banco, dentro da janela. */
  ultimaDoPacienteEm: Date;
}

/** O que a varredura usa de fora — injetável para teste. */
export interface DepsSemResposta {
  agora: () => Date;
  dentroDoHorario: (unit: Unit) => boolean;
  candidatas: (unit: Unit, de: Date, ate: Date) => Promise<CandidataSemResposta[]>;
  /** A conversa oficial do Kommo. null = não consegui ler (aí não se alerta no escuro). */
  oficiais: (unit: Unit, leadId: number) => Promise<MensagemOficial[] | null>;
  /** Quando saiu o último alerta deste lead, ou null. */
  alertadoEm: (unit: Unit, leadId: number) => Promise<Date | null>;
  marcarAlertado: (unit: Unit, leadId: number, quando: Date) => Promise<void>;
  etapa: (unit: Unit, leadId: number) => Promise<string | null>;
  /** Quando saiu a última tarefa deste lead (marca própria, separada da do Telegram), ou null. */
  tarefaEm: (unit: Unit, leadId: number) => Promise<Date | null>;
  marcarTarefa: (unit: Unit, leadId: number, quando: Date) => Promise<void>;
  /** Abre a tarefa no cartão, prazo = agora, no responsável do cartão. LANÇA se o Kommo não aceitou. */
  criarTarefa: (unit: Unit, leadId: number, texto: string) => Promise<void>;
  enviar: (texto: string) => Promise<boolean>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

/** Mensagens do paciente gravadas na janela, sem resposta da Sofia gravada depois — 1 por conversa. */
async function candidatasDoBanco(unit: Unit, de: Date, ate: Date): Promise<CandidataSemResposta[]> {
  const msgs = await prisma.message.findMany({
    where: { role: 'user', createdAt: { gte: de, lte: ate }, conversation: { unitId: unit.id, channel: 'kommo_chat' } },
    orderBy: { createdAt: 'desc' },
    take: MAX_CANDIDATAS,
    select: { conversationId: true, createdAt: true, conversation: { select: { leadId: true, contactName: true } } },
  });
  const porConversa = new Map<string, (typeof msgs)[number]>();
  for (const m of msgs) if (!porConversa.has(m.conversationId)) porConversa.set(m.conversationId, m);

  const out: CandidataSemResposta[] = [];
  for (const [conversationId, m] of porConversa) {
    const leadId = Number(m.conversation.leadId);
    if (!Number.isFinite(leadId) || leadId <= 0) continue;
    // Resposta da Sofia gravada depois — só a que chegou (a que virou nota interna o paciente não viu).
    const respostas = await prisma.message.findMany({
      where: { conversationId, role: 'assistant', createdAt: { gt: m.createdAt } },
      take: 5,
      select: { meta: true },
    });
    const sofiaRespondeu = respostas.some((r) => ((r.meta ?? {}) as Record<string, unknown>).via !== 'lead_note');
    if (sofiaRespondeu) continue;
    out.push({ leadId, contactName: m.conversation.contactName ?? null, ultimaDoPacienteEm: m.createdAt });
  }
  return out;
}

export const DEPS_SEM_RESPOSTA_PADRAO: DepsSemResposta = {
  agora: () => new Date(),
  dentroDoHorario,
  candidatas: candidatasDoBanco,
  oficiais: (unit, leadId) => mensagensOficiais(createKommoClient(unit), leadId, MENSAGENS_LIDAS).catch(() => null),
  alertadoEm: async (unit, leadId) => {
    try {
      const r = await prisma.cardAlert.findUnique({
        where: { unitId_leadId_ruleKey: { unitId: unit.id, leadId: String(leadId), ruleKey: REGRA_SEM_RESPOSTA } },
        select: { createdAt: true },
      });
      return r?.createdAt ?? null;
    } catch {
      return null;
    }
  },
  marcarAlertado: (unit, leadId, quando) => marcarAviso(unit.id, leadId, REGRA_SEM_RESPOSTA, quando),
  etapa: async (unit, leadId) => {
    try {
      const kommo = createKommoClient(unit);
      const lead = await kommo.getLead(leadId);
      return (await esquemaDaUnidade(unit, kommo)).nomeDoStatus(lead.pipeline_id, lead.status_id)?.status ?? null;
    } catch {
      return null;
    }
  },
  tarefaEm: async (unit, leadId) => marcadoEm(unit.id, leadId, REGRA_SEM_RESPOSTA_TAREFA),
  marcarTarefa: (unit, leadId, quando) => marcarAviso(unit.id, leadId, REGRA_SEM_RESPOSTA_TAREFA, quando),
  criarTarefa: async (unit, leadId, texto) => {
    const kommo = createKommoClient(unit);
    // O responsável do cartão; o `createTask` troca o login da consultoria pelo usuário da clínica (quando é um só).
    let responsavel: number | undefined;
    try {
      responsavel = (await kommo.getLead(leadId))?.responsible_user_id || undefined;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'sem-resposta: sem o cartão para achar o responsável — a tarefa vai pelo padrão da unidade');
    }
    await kommo.createTask({ leadId, text: texto, completeAt: Math.floor(Date.now() / 1000), responsibleUserId: responsavel });
  },
  enviar: (texto) => enviarTelegram(texto),
  simular: registrarSimulacao,
};

/**
 * Leads já conferidos e respondidos, pela última mensagem do paciente que vimos: não relê a conversa
 * oficial a cada minuto. Chave nova quando o paciente escreve de novo.
 */
const conferidas = new Map<string, number>();
const CONFERIDA_VALE_MS = ESPERA_MS + JANELA_MS + 5 * 60_000;

function jaConferida(chave: string, agora: number): boolean {
  const t = conferidas.get(chave);
  return t !== undefined && agora - t < CONFERIDA_VALE_MS;
}
function lembrarConferida(chave: string, agora: number): void {
  conferidas.set(chave, agora);
  if (conferidas.size > 20_000) for (const [k, t] of conferidas) if (agora - t >= CONFERIDA_VALE_MS) conferidas.delete(k);
}

/**
 * "Só no papel" não grava a marca no banco: guarda aqui quando TERIA alertado, para a tela mostrar um
 * "alertaria" por espera, como o ligado faria — e não um por mensagem de quem escreve sem parar.
 * Reinício esquece; no máximo um "alertaria" a mais.
 */
const simuladoEm = new Map<string, Date>();

function lembrarSimulado(chave: string, agora: Date): void {
  simuladoEm.set(chave, agora);
  if (simuladoEm.size > 20_000) {
    for (const [k, t] of simuladoEm) if (agora.getTime() - t.getTime() >= REALERTA_MS) simuladoEm.delete(k);
  }
}

/**
 * Tarefa que o Kommo recusou (ou deu timeout): UMA tentativa por espera. Um timeout pode ter criado a tarefa, e
 * repetir a duplicaria no cartão; o Telegram já avisa o João de que a tarefa não saiu. Mesma regra de "mesma
 * espera" das marcas do banco. Reinício esquece: no máximo uma tentativa a mais.
 */
const tarefaTentadaEm = new Map<string, Date>();

/** Só para teste. */
export function _esquecerConferidas(): void {
  conferidas.clear();
  simuladoEm.clear();
  tarefaTentadaEm.clear();
}

export interface ResumoSemResposta {
  candidatas: number;
  alertas: number;
  /** Tarefas criadas no cartão do Kommo. */
  tarefas: number;
  /** Tarefas que o Kommo não aceitou (o Telegram saiu mesmo assim). */
  tarefasFalhas: number;
  simulados: number;
  respondidas: number;
}

/** Uma varredura numa unidade. Nunca lança por causa de um lead. */
export async function verificarUnidadeSemResposta(
  unit: Unit,
  estado: Estado,
  deps: DepsSemResposta = DEPS_SEM_RESPOSTA_PADRAO,
): Promise<ResumoSemResposta> {
  const resumo: ResumoSemResposta = { candidatas: 0, alertas: 0, tarefas: 0, tarefasFalhas: 0, simulados: 0, respondidas: 0 };
  if (estado === 'desligado' || !deps.dentroDoHorario(unit)) return resumo;
  const agora = deps.agora();
  const de = new Date(agora.getTime() - ESPERA_MS - JANELA_MS);
  const ate = new Date(agora.getTime() - ESPERA_MS);
  const candidatas = await deps.candidatas(unit, de, ate);
  resumo.candidatas = candidatas.length;

  for (const c of candidatas) {
    const chaveConferida = `${unit.id}:${c.leadId}:${c.ultimaDoPacienteEm.getTime()}`;
    if (jaConferida(chaveConferida, agora.getTime())) continue;
    try {
      const msgs = await deps.oficiais(unit, c.leadId);
      if (!msgs) continue; // sem a conversa oficial não se afirma "ninguém respondeu"
      const espera = esperaDoPaciente(msgs);
      if (!espera || soAgradecimento(espera.textos)) {
        resumo.respondidas++;
        lembrarConferida(chaveConferida, agora.getTime());
        continue;
      }
      if (!deveAlertar(espera, agora)) continue;
      const chaveDoLead = `${unit.id}:${c.leadId}`;
      const esperaMs = agora.getTime() - espera.desde.getTime();

      if (estado === 'seco') {
        if (mesmaEsperaJaAlertada(msgs, simuladoEm.get(chaveDoLead) ?? null, agora)) {
          lembrarConferida(chaveConferida, agora.getTime());
          continue;
        }
        deps.simular(unit, AUTOMACAO_SEM_RESPOSTA, {
          leadId: c.leadId,
          acao: 'alertaria',
          alvo: 'Telegram do João + tarefa no cartão',
          valor: `sem resposta há ${humanizarEspera(esperaMs)}`,
          motivo: `última mensagem: "${mascararPii(espera.ultimaTexto).slice(0, 120)}"`,
        });
        resumo.simulados++;
        lembrarSimulado(chaveDoLead, agora);
        lembrarConferida(chaveConferida, agora.getTime());
        continue;
      }

      // Duas saídas, cada uma com a sua marca: o Telegram do João e a tarefa para a equipe da unidade.
      const telegramJa = mesmaEsperaJaAlertada(msgs, await deps.alertadoEm(unit, c.leadId), agora);
      const tarefaJa = mesmaEsperaJaAlertada(msgs, await deps.tarefaEm(unit, c.leadId), agora);
      const tarefaTentada = !tarefaJa && mesmaEsperaJaAlertada(msgs, tarefaTentadaEm.get(chaveDoLead) ?? null, agora);
      if (telegramJa && (tarefaJa || tarefaTentada)) {
        lembrarConferida(chaveConferida, agora.getTime());
        continue;
      }

      // 1) A tarefa primeiro: o Telegram diz ao João como ela ficou. Se o Kommo falhar, o Telegram sai do mesmo jeito.
      let tarefa: 'criada' | 'falhou' | null = tarefaJa ? 'criada' : tarefaTentada ? 'falhou' : null;
      if (!tarefaJa && !tarefaTentada) {
        try {
          await deps.criarTarefa(
            unit,
            c.leadId,
            textoDaTarefa({ slug: unit.slug, contato: c.contactName, esperaMs, ultima: espera.ultimaTexto }),
          );
          // Marca SÓ depois que o Kommo aceitou.
          await deps.marcarTarefa(unit, c.leadId, agora);
          tarefa = 'criada';
          resumo.tarefas++;
          logger.info({ unit: unit.slug, leadId: c.leadId, esperaMin: Math.floor(esperaMs / 60_000) }, 'sem-resposta: tarefa criada no cartão');
        } catch (err) {
          tarefa = 'falhou';
          resumo.tarefasFalhas++;
          tarefaTentadaEm.set(chaveDoLead, agora);
          logger.error({ err: String(err), unit: unit.slug, leadId: c.leadId }, 'sem-resposta: FALHOU criar a tarefa no cartão — o Telegram sai mesmo assim');
        }
      }

      // 2) O Telegram do João.
      if (!telegramJa) {
        const texto = textoDoAlerta({
          unidade: unit.name,
          contato: c.contactName,
          leadId: c.leadId,
          etapa: await deps.etapa(unit, c.leadId),
          esperaMs,
          ultima: espera.ultimaTexto,
          link: unit.kommoSubdomain ? `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${c.leadId}` : null,
          tarefa,
        });
        if (!(await deps.enviar(texto))) continue; // Telegram recusou: sem marca, tenta de novo na próxima varredura
        // Marca SÓ depois que o Telegram aceitou: falha de rede não cala o aviso.
        await deps.marcarAlertado(unit, c.leadId, agora);
        resumo.alertas++;
        logger.info({ unit: unit.slug, leadId: c.leadId, esperaMin: Math.floor(esperaMs / 60_000) }, 'sem-resposta: alerta enviado no Telegram');
      }
      lembrarConferida(chaveConferida, agora.getTime());
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: c.leadId }, 'sem-resposta: falha ao conferir o lead — segue');
    }
  }
  return resumo;
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;
/** Ligado sem TELEGRAM_BOT_TOKEN: avisa no log no máximo de hora em hora, em vez de a cada paciente a cada minuto. */
let avisouSemToken = 0;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany();
    for (const unit of unidades) {
      const estado = estadoDoAlertaSemResposta(unit.slug);
      if (estado === 'desligado' || !unit.kommoSubdomain || !unit.kommoAccessToken) continue;
      if (estado === 'ligado' && !telegramConfigurado()) {
        if (Date.now() - avisouSemToken > 3600_000) {
          avisouSemToken = Date.now();
          logger.warn({ unit: unit.slug }, 'sem-resposta: chave ligada mas falta TELEGRAM_BOT_TOKEN no servidor — só a tarefa no cartão sai, o Telegram não');
        }
        // Segue: a tarefa para a equipe da unidade não depende do Telegram do João.
      }
      const r = await verificarUnidadeSemResposta(unit, estado).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug }, 'sem-resposta: unidade falhou');
        return null;
      });
      if (r && (r.alertas || r.simulados || r.tarefas || r.tarefasFalhas)) logger.info({ unit: unit.slug, estado, ...r }, 'sem-resposta: varredura');
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'sem-resposta: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startSemRespostaWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info('sem-resposta: worker iniciado (chave alerta-sem-resposta por unidade; Telegram do João)');
}

export function stopSemRespostaWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
