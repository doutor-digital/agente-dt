/**
 * Confirmação de presença: dois toques antes da consulta.
 *
 *  - D-2 (reforço): só para quem marcou com 2 dias ou mais de antecedência. É o buraco medido na
 *    Serra em 22/09/2026: das 14 consultas da IA já resolvidas, as 6 marcadas com 2+ dias caíram
 *    TODAS, e nenhuma delas recebeu contato nenhum entre marcar e o dia.
 *  - D-1 (véspera): a pergunta "você vem?", com botões.
 *
 * COMO A MENSAGEM SAI, nesta ordem:
 *  1. Consulta já confirmada + Salesbot de lembrete da unidade → dispara o lembrete (é o caso da
 *     Imperatriz, que tem template próprio de "já está garantida").
 *  2. Janela de 24 h do WhatsApp ABERTA → texto livre pelo chat, com botões.
 *  3. Janela FECHADA → dispara o Salesbot do TEMPLATE aprovado (ids em `pipeline_intents`:
 *     `confirmacao_salesbot_id` para a véspera, `reforco_salesbot_id` para o D-2).
 *  4. Sem template configurado → aí sim, e só aí, tarefa para a equipe confirmar por telefone.
 *
 * O passo 3 é o que faltava: até 22/09/2026 a janela fechada caía direto na tarefa, e a tarefa
 * ninguém lia — na Serra só 4 dos 17 pacientes receberam qualquer confirmação.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoPipeline } from '../services/kommo.service.js';
import type { MensagemOficial } from '../services/kommo-talks-normalizar.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';
import { desistenciaEscrita, etapaSemVespera, textoTarefaDesistencia, voltouAtrasDeVerdade } from './vespera-segura.js';
import { motivoDeBloqueio } from './mensagem-bloqueada.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService, type ConsultaReconciliada } from '../services/agenda-reconcile.service.js';
import { addMessage } from '../services/conversations.service.js';
import { mensagensOficiais } from '../services/kommo-talks.service.js';
import { enviarMensagemDeChat } from '../services/kommo-chat.service.js';
import {
  BOTOES_D1,
  chaveDaConfirmacao,
  contextoDeChatDoLead,
  janelaAberta,
  prefixoDoToque,
  textoAlertaSemJanela,
  textoConfirmacaoD1,
  type Toque,
} from './confirmacao-d1.js';

// A chave mora em confirmacao-d1.ts porque a RESPOSTA do paciente também precisa dela (para saber
// de qual consulta ele está falando). Reexportada aqui para quem já importava deste módulo.
export { chaveDaConfirmacao, prefixoDoToque, type Toque };
import { emPausa } from './pausa-unidade.js';
import { avisoRecente, marcadoEm, marcadoEmPrefixo, marcarAviso, marcasComPrefixo } from './aviso-dedupe.js';
import { marcaDaConsulta, MARCA_RECUSOU } from './desistencia-acao.js';
import { PAUSA_POR } from '../agent/teto-mensal.js';
import type { Unit } from '@prisma/client';
import { automacaoLigada } from './automacoes-estado.js';
import { estadoDoLembrete } from './lembrete-chaves.js';

/**
 * Janelas da chave ANTIGA, que não carregava o horário da consulta. Só servem à transição de
 * deploy (ver `LEGADO_ATE`) — quem impede a repetição hoje é `POR_CONSULTA_MS`.
 */
const REENVIO_D1_MS = 36 * 3600_000;
const REENVIO_D2_MS = 72 * 3600_000;

/**
 * Até quando ainda olhamos a chave antiga. Ela evita perguntar de novo, no dia do deploy, a quem
 * já tinha sido perguntado; depois disso só atrapalha, porque cala consulta remarcada por 36 h.
 */
const LEGADO_ATE = Date.parse('2026-09-26T00:00:00Z');

/**
 * A marca de "já perguntei" vale pela CONSULTA, então não precisa de janela curta: uma vez
 * perguntado aquele horário, não se pergunta de novo, e horário novo é chave nova.
 */
const POR_CONSULTA_MS = 30 * 24 * 3600_000;

const SWEEP_MS = 60 * 60_000;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

const ultimoEnvioPorUnidade = new Map<string, string>();


function agoraLocal(tz: string): { dia: string; hora: number } {
  const iso = SpineService.instanteNoFuso(new Date(), tz || 'America/Sao_Paulo');
  return { dia: iso.slice(0, 10), hora: Number(iso.slice(11, 13)) };
}

function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** Qual toque esta consulta merece hoje: véspera, reforço de dois dias, ou nenhum. */
export function toqueDoDia(diaDaConsulta: string, hoje: string): Toque | null {
  if (diaDaConsulta === somarDias(hoje, 1)) return 'd1';
  if (diaDaConsulta === somarDias(hoje, 2)) return 'd2';
  return null;
}

/**
 * O reforço de D-2 é mensagem NOVA para o paciente: entra unidade por unidade, nunca na rede
 * inteira de uma vez. Vazio = ninguém; `*` = todas.
 */
export function reforcoLiberado(slug: string, raw: string | undefined = process.env.CONFIRMACAO_D2_SLUGS): boolean {
  return automacaoLigada(slug, 'confirmacao-d2', raw);
}

/** Ids dos Salesbots que carregam os templates aprovados, guardados em `pipeline_intents`. */
export function botsDeConfirmacao(unit: Pick<Unit, 'pipelineIntents'>): { d1: number | null; d2: number | null } {
  const i = (unit.pipelineIntents ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
  return { d1: num(i.confirmacao_salesbot_id), d2: num(i.reforco_salesbot_id) };
}

interface Envio {
  unit: Unit;
  kommo: KommoClient;
  leadId: number;
  consulta: ConsultaReconciliada & { quando: string };
  toque: Toque;
  /** Chave do dedupe, gravada aqui dentro assim que o canal aceita a mensagem. */
  chave: string;
  /** Título do cartão: é nele que a Sofia grava o nome que o paciente disse. */
  titulo: string | null;
  /** Conversa oficial já lida pelo laço (undefined = ler aqui). */
  oficiais?: MensagemOficial[] | null;
}

/** Manda a pergunta de confirmação pelo melhor canal disponível. Devolve por onde saiu. */
async function pedirConfirmacao(e: Envio): Promise<'chat_botoes' | 'texto' | 'template' | 'tarefa' | 'nada'> {
  const { unit, kommo, leadId, consulta, toque, chave } = e;
  const bots = botsDeConfirmacao(unit);
  const botTemplate = toque === 'd1' ? bots.d1 : bots.d2;

  /**
   * Grava a marca no instante em que o canal aceitou a mensagem.
   *
   * Antes isso era feito lá fora, depois de `armar()` e de `addMessage()` — dois writes no
   * Postgres. Qualquer um deles falhando derrubava a execução para o catch do laço, e a marca
   * nunca era gravada, apesar de o paciente JÁ ter recebido a mensagem. A varredura seguinte
   * então perguntava de novo. É o caminho que produziu as duas perguntas idênticas da Luciana.
   */
  const marcar = () => marcarAviso(unit.id, leadId, chave);

  const conv = await prisma.conversation.findFirst({
    where: { unitId: unit.id, leadId: String(leadId) },
    orderBy: { lastMessageAt: 'desc' },
  });

  // Janela de 24 h: texto livre só chega se o paciente escreveu nesse período. Fora dela, o Kommo
  // aceita o envio e marca "Erro" depois — falha em silêncio.
  const oficiais = e.oficiais !== undefined ? e.oficiais : await mensagensOficiais(kommo, leadId, 15).catch(() => null);
  const aberta = oficiais ? janelaAberta(oficiais) : true;

  // Arma o tratador da resposta: sem isto, o "1" ou o toque no botão do paciente chega como texto
  // solto no agente, que não sabe que perguntou nada.
  const armar = async () => {
    if (!conv) return;
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { confirmacaoD1EnviadaEm: new Date(), confirmacaoD1Resposta: null },
    });
  };

  if (!aberta) {
    if (botTemplate) {
      const r = await kommo.triggerSalesbot(botTemplate, leadId);
      if (r.ok) {
        await marcar();
        await armar();
        return 'template';
      }
      logger.warn({ unit: unit.slug, leadId, toque, erro: r.error }, 'confirmação: template falhou');
    }
    // Sem template configurado, a equipe precisa ligar — é a única confirmação que resta.
    if (toque === 'd1') {
      await kommo.createTask({
        leadId,
        text: textoAlertaSemJanela({ slug: unit.slug, nome: conv?.contactName, quando: consulta.quando }),
        completeAt: Math.floor(Date.now() / 1000) + 60 * 60,
      });
      await marcar();
      if (conv) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { confirmacaoD1EnviadaEm: new Date(), confirmacaoD1Resposta: 'sem_janela' },
        });
      }
      return 'tarefa';
    }
    return 'nada';
  }

  // O nome vem do título do cartão, que a Sofia grava com o nome que o paciente disse. O do contato é o perfil
  // do WhatsApp ("Space Conv. Hookah", "Leily Espaço Diva" — Canaã, 19/10/2026): sem nome no título, vai "Oi!".
  const texto = textoConfirmacaoD1({
    nome: primeiroNomeDoPaciente(e.titulo, null),
    quando: consulta.quando,
    especialista: consulta.especialista,
    endereco: unit.clinicAddress,
    antecedencia: toque,
  });

  // Com os ids do chat, vai com botões (Confirmo · Preciso remarcar); sem eles, texto "responda 1 ou 2".
  let via: 'chat_botoes' | 'texto' = 'texto';
  const ctx = await contextoDeChatDoLead(unit.id, leadId).catch(() => null);
  if (ctx) {
    try {
      await enviarMensagemDeChat(unit, {
        chatId: ctx.chatId,
        recipientId: ctx.authorId,
        talkId: ctx.talkId,
        contactId: ctx.contactId,
        accountId: ctx.accountId,
        texto: texto.replace(
          /Responda \*1\* para confirmar ou \*2\* se precisar remarcar\. 😊/,
          'Toca no botão aqui embaixo pra me avisar 😊',
        ),
        botoes: BOTOES_D1,
      });
      via = 'chat_botoes';
    } catch (err) {
      logger.warn({ unit: unit.slug, leadId, err: String(err) }, 'confirmação: botões falharam, indo em texto');
    }
  }
  if (via !== 'chat_botoes') {
    // `sendChatReply` cai para NOTA no cartão quando o chat recusa — e nota o paciente não lê.
    // Tratar isso como enviado faria o dedupe calar a próxima tentativa até depois da consulta.
    const r = await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });
    if (r.via === 'lead_note') {
      logger.warn({ unit: unit.slug, leadId, toque }, 'confirmação: virou nota interna, o paciente NÃO recebeu');
      return 'nada';
    }
  }
  // A mensagem já está com o paciente: marca ANTES dos writes abaixo, que podem falhar.
  await marcar();
  await armar();
  if (conv) {
    await addMessage({ conversationId: conv.id, role: 'assistant', content: texto, meta: { origem: `confirmacao_${toque}`, via } });
  }
  return via;
}

async function lembrarUnidade(unit: Unit): Promise<void> {
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const { dia, hora } = agoraLocal(tz);

  if (hora < unit.reminderHourLocal) return;
  if (ultimoEnvioPorUnidade.get(unit.id) === dia) return;
  if (!unit.spineEnabled || !unit.spineToken) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }

  // Unidade com Salesbot de lembrete próprio: ele só serve para consulta JÁ confirmada ("está
  // garantida"). Quem ainda não confirmou precisa da PERGUNTA, que é o caminho de baixo.
  const botLembrete = unit.reminderEnabled ? unit.reminderSalesbotId : null;

  // Filtra no banco pelos dois dias que interessam: sem isto, uma unidade com 10 mil leads
  // importados faz 10 mil chamadas à franquia antes de descartar quase todas.
  const amanha = somarDias(dia, 1);
  const depois = somarDias(dia, 2);
  const diasAlvo = reforcoLiberado(unit.slug) ? [amanha, depois] : [amanha];
  const links = await prisma.spineLeadLink.findMany({
    where: {
      unitId: unit.id,
      spineIdSchedule: { not: null },
      OR: diasAlvo.map((d) => ({ agendadoPara: { startsWith: d } })),
    },
  });

  const kommo = createKommoClient(unit);
  const conta = { lembrete: 0, chat_botoes: 0, texto: 0, template: 0, tarefa: 0, nada: 0, d2: 0, pulados: 0, ja_confirmou: 0, etapa: 0, desistiu: 0, robo_kommo: 0, bloqueado: 0, recusou: 0 };
  let pipes: KommoPipeline[] | null = null;
  const nomeDaEtapa = async (pipelineId: number | undefined, statusId: number): Promise<string | null> => {
    pipes ??= await kommo.listPipelines().catch(() => []);
    const pipe = pipes.find((p) => p.id === pipelineId) ?? pipes.find((p) => p.statuses?.some((s) => s.id === statusId));
    return pipe?.statuses?.find((s) => s.id === statusId)?.name ?? null;
  };
  // Véspera pelo robô do Kommo (chave confirmacao-d1, decisão de 16/10/2026): fora de "desligado" — só no papel
  // ou ligada —, a do servidor não sai nesta unidade. O gatilho do Kommo já manda a véspera; as duas juntas
  // davam duas perguntas ao mesmo paciente (revisão de 16/10, item 5).
  const vesperaDoKommo = estadoDoLembrete(unit.slug, 'consulta');

  for (const link of links) {
    const consulta = await AgendaReconcileService.consultaDoLead(unit, link.kommoLeadId);
    // `nao_confirmada` significa que a franquia NÃO devolveu este horário agora: o `quando` é o
    // valor salvo, que pode estar velho. Perguntar "confirma sua consulta de quinta às 15h" com
    // data não verificada é pior que não perguntar.
    if (!consulta || consulta.estado !== 'confirmada' || !consulta.quando) {
      conta.pulados++;
      continue;
    }
    const toque = toqueDoDia(consulta.quando.slice(0, 10), dia);
    if (!toque) continue;
    if (toque === 'd2' && !reforcoLiberado(unit.slug)) continue;
    if (toque === 'd1' && vesperaDoKommo !== 'desligado') {
      conta.robo_kommo++;
      continue;
    }

    const chave = chaveDaConfirmacao(toque, consulta.quando);
    // Chave antiga (sem o horário): os avisos gravados antes desta versão ainda valem, senão o
    // primeiro deploy perguntaria de novo a todo mundo que já tinha sido perguntado hoje.
    const chaveAntiga = prefixoDoToque(toque);
    const janela = toque === 'd1' ? REENVIO_D1_MS : REENVIO_D2_MS;
    try {
      if (await avisoRecente(unit.id, link.kommoLeadId, chave, POR_CONSULTA_MS)) continue;
      if (Date.now() < LEGADO_ATE && (await avisoRecente(unit.id, link.kommoLeadId, chaveAntiga, janela))) continue;

      // A franquia não sabe de desistência (cancelar é só no Kommo): quem manda aqui é o cartão e a conversa.
      // Ver `vespera-segura.ts` — caso Milena/Leomar, Canaã, 17–18/10/2026.
      // Uma 2ª tentativa e, falhando de novo, segue como antes destas travas: a varredura é uma por dia, e
      // segurar a véspera por um soluço do Kommo deixaria o paciente sem lembrete nenhum.
      const lead = await kommo
        .getLead(link.kommoLeadId)
        .catch(() => kommo.getLead(link.kommoLeadId))
        .catch((err) => {
          logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, err: String(err) }, 'confirmação: cartão ilegível, segue sem as travas');
          return null;
        });
      // Etiqueta/nome que diz "não mande nada" (não-mandar-mensagem, NAO_PERTURBAR, "NÃO É LEAD" no nome…): item 6 da
      // Suzanne, 25/10/2026. Ver `mensagem-bloqueada.ts` — para consulta marcada só calam as de "não mande NADA".
      const bloqueio = motivoDeBloqueio(lead, 'lembrete');
      if (bloqueio) {
        conta.bloqueado++;
        logger.debug({ unit: unit.slug, kommoLeadId: link.kommoLeadId, toque, bloqueio }, 'confirmação: cartão bloqueado para mensagem automática, não sai');
        continue;
      }
      const etapa = lead?.status_id ? await nomeDaEtapa(lead.pipeline_id, lead.status_id) : null;
      if (lead?.status_id && etapaSemVespera({ statusId: lead.status_id, nome: etapa })) {
        conta.etapa++;
        logger.info({ unit: unit.slug, kommoLeadId: link.kommoLeadId, etapa, toque }, 'confirmação: cartão fora de agendado, não sai');
        continue;
      }
      const oficiais = await mensagensOficiais(kommo, link.kommoLeadId, 40).catch(() => null);
      // Desde quando vale a desistência: o momento em que o horário atual foi gravado. `link` foi lido antes da
      // reconciliação acima — se ela acabou de trocar o horário, o que o paciente escreveu antes é da consulta velha.
      // Limite conhecido: `updatedAt` também anda quando o sincronizador grava paciente/tentativas no vínculo (perto
      // do agendamento, não depois). Se andar depois da desistência, a véspera sai — que é o comportamento de antes.
      const marcadaEm = consulta.mudou ? new Date() : link.updatedAt;
      // O paciente RECUSOU remarcar e a Sofia se despediu dizendo que a equipe cancela (desistencia-acao.ts): a NOSSA véspera para
      // neste cartão. A marca é DESTA consulta (leva o horário na chave): se ela foi remarcada, a chave é outra e a marca não vale —
      // sem depender do `updatedAt` do vínculo, que anda a cada escrita. E não vale mais se ele voltou atrás depois ("consegui,
      // vou sim", "confirmo").
      // (a hora do cartão e a da franquia podem diferir por minutos: a comparação tem 5 min de tolerância)
      const recusouEm = marcaDaConsulta(await marcasComPrefixo(unit.id, link.kommoLeadId, MARCA_RECUSOU + ':'), MARCA_RECUSOU, consulta.quando.slice(0, 16));
      const voltouAtras = !!recusouEm && !!oficiais && voltouAtrasDeVerdade(oficiais.filter((m) => m.direcao === 'entrada' && m.autor === 'paciente' && m.em > recusouEm).map((m) => m.texto));
      if (recusouEm && !voltouAtras) {
        conta.recusou++;
        logger.info({ unit: unit.slug, kommoLeadId: link.kommoLeadId, toque }, 'confirmação: o paciente recusou remarcar e a equipe vai cancelar — não sai');
        continue;
      }
      const desistiu = oficiais ? desistenciaEscrita(oficiais, marcadaEm) : null;
      if (desistiu) {
        conta.desistiu++;
        const chaveTarefa = `vespera_desistencia:${consulta.quando}`;
        // O webhook (IA calada) e a régua (sem resposta) já abrem tarefa quando o paciente escreve que não vem — não duplica.
        const recente = async (tipo: string): Promise<boolean> => {
          const t = await marcadoEmPrefixo(unit.id, link.kommoLeadId, `desistencia_tarefa:${tipo}:`);
          return !!t && Date.now() - t.getTime() < 2 * 24 * 3600_000;
        };
        const jaAvisada =
          (await avisoRecente(unit.id, link.kommoLeadId, chaveTarefa, POR_CONSULTA_MS)) ||
          (await recente('ia_calada')) ||
          (await recente('sem_resposta')) ||
          (await recente('cancelar')) ||
          (await recente('conferir'));
        if (!jaAvisada) {
          try {
            await kommo.createTask({
              leadId: link.kommoLeadId,
              text: textoTarefaDesistencia({
                slug: unit.slug,
                nome: primeiroNomeDoPaciente(lead?.name, null),
                quando: consulta.quando,
                etapa,
                mensagem: desistiu.texto,
              }),
              completeAt: Math.floor(Date.now() / 1000) + 60 * 60,
            });
            await marcarAviso(unit.id, link.kommoLeadId, chaveTarefa);
          } catch (err) {
            logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, err: String(err) }, 'confirmação: tarefa da desistência falhou');
          }
        }
        logger.info(
          { unit: unit.slug, kommoLeadId: link.kommoLeadId, toque, quando: consulta.quando, em: desistiu.em },
          'confirmação: paciente escreveu que não vem, não sai',
        );
        continue;
      }

      // O Salesbot de lembrete da unidade diz "sua consulta está garantida" — só serve para quem
      // JÁ respondeu confirmando. Quem não respondeu precisa da pergunta.
      const conv = await prisma.conversation.findFirst({
        where: { unitId: unit.id, leadId: String(link.kommoLeadId) },
        orderBy: { lastMessageAt: 'desc' },
        select: { confirmacaoD1Resposta: true },
      });

      /**
       * O paciente já respondeu "confirmo" sobre ESTA consulta?
       *
       * `confirmacaoD1Resposta` sozinha não diz de qual consulta ela fala — pode ser de um horário
       * antigo, já remarcado. Quem amarra é a marca do reforço: se o D-2 saiu para este mesmo
       * horário e o paciente respondeu confirmando, a confirmação é desta consulta.
       *
       * Sem isso, quem confirmava no reforço era perguntado outra vez na véspera, porque as duas
       * marcas são chaves diferentes. É a forma do caso da Luciana (Serra, 23/09/2026): respondeu
       * "1", levou a mesma pergunta de novo, escreveu "Outra vez ?" e encerrou com "Vou bloquear".
       */
      const confirmouEstaConsulta =
        toque === 'd1' &&
        conv?.confirmacaoD1Resposta === 'confirmou' &&
        (await avisoRecente(
          unit.id,
          link.kommoLeadId,
          chaveDaConfirmacao('d2', consulta.quando),
          POR_CONSULTA_MS,
        ));

      if (confirmouEstaConsulta) {
        if (botLembrete) {
          const r = await kommo.triggerSalesbot(botLembrete, link.kommoLeadId);
          if (r.ok) {
            conta.lembrete++;
            await marcarAviso(unit.id, link.kommoLeadId, chave);
          } else {
            logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, erro: r.error }, 'lembrete: Salesbot falhou');
          }
        } else {
          // Sem Salesbot de lembrete não há o que dizer: a consulta já está confirmada. Repetir a
          // pergunta é o que fez a paciente ameaçar bloquear o número.
          conta.ja_confirmou++;
          await marcarAviso(unit.id, link.kommoLeadId, chave);
          logger.info(
            { unit: unit.slug, kommoLeadId: link.kommoLeadId, quando: consulta.quando },
            'confirmação: paciente já confirmou esta consulta, véspera não sai',
          );
        }
        continue;
      }

      // A marca agora é gravada DENTRO de pedirConfirmacao, no instante em que o canal aceita a
      // mensagem — não aqui, depois de dois writes que podem falhar com o paciente já avisado.
      const via = await pedirConfirmacao({
        unit,
        kommo,
        leadId: link.kommoLeadId,
        consulta: consulta as ConsultaReconciliada & { quando: string },
        toque,
        chave,
        titulo: lead?.name ?? null,
        oficiais,
      });
      conta[via]++;
      if (toque === 'd2') conta.d2++;
    } catch (err) {
      logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, toque, err: String(err) }, 'confirmação: falha no lead');
    }
  }

  ultimoEnvioPorUnidade.set(unit.id, dia);
  logger.info({ unit: unit.slug, dia, ...conta, vesperaDoKommo, candidatos: links.length }, 'confirmação de presença: varredura concluída');
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    // A pausa por TETO MENSAL corta o que gasta IA; a confirmação é template/Salesbot, não gasta
    // token e evita falta — segue rodando. A pausa da recepção continua valendo.
    const unidades = (await prisma.unit.findMany({ where: { spineEnabled: true } })).filter(
      (u) => !emPausa(u) || u.pausaPor === PAUSA_POR,
    );
    for (const unit of unidades) {
      await lembrarUnidade(unit).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug }, 'confirmação: erro na unidade (ignorado)');
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'confirmação: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startReminderWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  void varrer();
  logger.info('confirmação de presença: worker iniciado (D-2 reforço + D-1 véspera)');
}

export function stopReminderWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
