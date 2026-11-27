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
import { SO_CARTAO_DO_KOMMO } from './chatwoot-lead.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoPipeline } from '../services/kommo.service.js';
import type { MensagemOficial } from '../services/kommo-talks-normalizar.js';
import { primeiroNomeDoPaciente } from './ponte-respostas.js';
import { desistenciaEscrita, etapaSemVespera, textoTarefaDesistencia } from './vespera-segura.js';
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
  RESPOSTA_OFERTA_SOFIA,
  type Toque,
} from './confirmacao-d1.js';

// A chave mora em confirmacao-d1.ts porque a RESPOSTA do paciente também precisa dela (para saber
// de qual consulta ele está falando). Reexportada aqui para quem já importava deste módulo.
export { chaveDaConfirmacao, prefixoDoToque, type Toque };
import { emPausa } from './pausa-unidade.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { PAUSA_POR } from '../agent/teto-mensal.js';
import type { Unit } from '@prisma/client';
import { automacaoLigada } from './automacoes-estado.js';
import { clinicaAtendendoAgora } from './cutucada-apos-equipe.js';
import { registrarSimulacao } from './so-no-papel.js';
import { estadoDaManha, decidirManha, talvezDentroDaJanela, textoConfirmacaoManha, MAX_ENVIOS_POR_VARREDURA, ID_CONFIRMACAO_MANHA } from './confirmacao-manha.js';
import { oferecerNovoHorario } from './remarcar-oferta.js';
import { vesperaDoServidorDesligada } from './lembrete-chaves.js';
import {
  confirmacaoDaUnidade,
  ID_CONFIRMACAO_DIA_UTIL,
  diaUtilAnterior,
  diasQueConfirmamHoje,
  jaConfirmou,
  textoDaUnidade,
  type ConfirmacaoDaUnidade,
} from './confirmacao-unidade.js';

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

/**
 * QUAIS lembretes de consulta ESTE servidor manda para a unidade — a ÚNICA fonte da verdade (o worker decide por ela e a pausa da unidade a usa para
 * dizer à atendente o que realmente para):
 *  - `roda`: o worker varre a unidade (spine ligado + token da franquia) e só olha cartão do Kommo (a conversa do CRM tem régua própria);
 *  - `vespera`: `servidor` = a confirmação D-1 sai daqui; `robo-kommo` = a chave `confirmacao-d1` saiu de «desligado» e quem manda é o robô de 24 h
 *    do Kommo (a pausa da unidade não o alcança);
 *  - `d2`: o reforço de D-2 sai daqui (chave `confirmacao-d2` liberada e unidade fora do «dia útil anterior», que tem um toque só);
 *  - `daUnidade`/`diaUtil`: a regra de «dia útil anterior» (Petrópolis).
 * Uma unidade em pausa NÃO é varrida (salvo a pausa do teto mensal), então com `roda` a pausa para o que sai daqui.
 */
export interface LembretesDoServidor {
  roda: boolean;
  vespera: 'servidor' | 'robo-kommo';
  d2: boolean;
  diaUtil: boolean;
  daUnidade: ReturnType<typeof confirmacaoDaUnidade>;
}
export function lembretesDoServidor(unit: Pick<Unit, 'slug' | 'spineEnabled' | 'spineToken'>, env: NodeJS.ProcessEnv = process.env): LembretesDoServidor {
  const daUnidade = confirmacaoDaUnidade(unit.slug, automacaoLigada(unit.slug, ID_CONFIRMACAO_DIA_UTIL, env.CONFIRMACAO_DIA_UTIL_SLUGS));
  const diaUtil = daUnidade?.diaUtil === true;
  return {
    roda: !!unit.spineEnabled && !!unit.spineToken,
    vespera: vesperaDoServidorDesligada(unit.slug, env) ? 'robo-kommo' : 'servidor',
    d2: !diaUtil && reforcoLiberado(unit.slug, env.CONFIRMACAO_D2_SLUGS),
    diaUtil,
    daUnidade,
  };
}

/** Ids dos Salesbots que carregam os templates aprovados, guardados em `pipeline_intents`. */
export function botsDeConfirmacao(unit: Pick<Unit, 'pipelineIntents'>): { d0: number | null; d1: number | null; d2: number | null } {
  const i = (unit.pipelineIntents ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
  // d0 = modelo da MANHÃ da consulta ("é hoje"), aprovado à parte: o da véspera diz "amanhã" e não serve.
  return { d0: num(i.manha_salesbot_id), d1: num(i.confirmacao_salesbot_id), d2: num(i.reforco_salesbot_id) };
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
  /** O jeito da unidade (automação `confirmacao-dia-util` + `POR_UNIDADE` em confirmacao-unidade.ts); null = padrão da rede. */
  daUnidade?: ConfirmacaoDaUnidade | null;
  /** Hora local do envio, para o {saudacao} do texto da unidade. */
  horaLocal?: number;
}

/** Manda a pergunta de confirmação pelo melhor canal disponível. Devolve por onde saiu. */
async function pedirConfirmacao(e: Envio): Promise<'chat_botoes' | 'texto' | 'template' | 'tarefa' | 'nada'> {
  const { unit, kommo, leadId, consulta, toque, chave } = e;
  const bots = botsDeConfirmacao(unit);
  const botTemplate = toque === 'd0' ? bots.d0 : toque === 'd1' ? bots.d1 : bots.d2;

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
  // WhatsApp Lite (QR code, ex.: Petrópolis): não existe a janela de 24 h — o texto chega sempre. Sem esta chave, o
  // paciente que marcou há 3 dias e não escreveu desde então virava TAREFA de ligação em vez de receber a mensagem.
  // Manhã da consulta (d0): conversa que não deu para ler = janela FECHADA. Texto livre fora da janela o Kommo aceita e marca "Erro" em silêncio.
  const aberta = e.daUnidade?.semJanela ? true : oficiais ? janelaAberta(oficiais) : toque !== 'd0';

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
  const modeloDaUnidade = toque === 'd0' ? null : (e.daUnidade?.texto ?? null);
  const textoDaManha = (comBotoes: boolean) =>
    textoConfirmacaoManha({
      nome: primeiroNomeDoPaciente(e.titulo, null),
      quando: consulta.quando,
      especialista: consulta.especialista,
      endereco: unit.clinicAddress,
      horaDoEnvio: e.horaLocal ?? 9,
      oferece: oferecerNovoHorario(unit.slug) === 'ligado',
      comBotoes,
    });
  const texto = toque === 'd0'
    ? textoDaManha(false)
    : modeloDaUnidade
    ? textoDaUnidade(modeloDaUnidade, {
        quando: consulta.quando,
        nome: primeiroNomeDoPaciente(e.titulo, null),
        especialista: consulta.especialista,
        endereco: unit.clinicAddress,
        horaDoEnvio: e.horaLocal ?? 9,
      })
    : textoConfirmacaoD1({
        nome: primeiroNomeDoPaciente(e.titulo, null),
        quando: consulta.quando,
        especialista: consulta.especialista,
        endereco: unit.clinicAddress,
        // no dia útil anterior a consulta pode ser segunda (pergunta na sexta): 'd2' tira o "de amanhã" do texto da rede
        antecedencia: e.daUnidade?.diaUtil && consulta.quando.slice(0, 10) !== somarDias(agoraLocal(unit.spineTimezone || 'America/Sao_Paulo').dia, 1) ? 'd2' : toque,
      });

  // Com os ids do chat, vai com botões (Confirmo · Preciso remarcar); sem eles, texto "responda 1 ou 2".
  // O texto da UNIDADE vai como ela escreveu, sem botão, numa mensagem só: é a mensagem que a equipe já mandava à mão.
  // Pelo chat direto ele não é cortado; o `sendChatReply` em modo bypass corta em 240 caracteres (3 bolhas no texto de Petrópolis).
  let via: 'chat_botoes' | 'texto' = 'texto';
  let foiPeloChat = false;
  let enviado = texto;
  const ctx = await contextoDeChatDoLead(unit.id, leadId).catch(() => null);
  if (ctx) {
    const textoDoChat =
      toque === 'd0'
        ? textoDaManha(true)
        : modeloDaUnidade
          ? texto
          : texto.replace(/Responda \*1\* para confirmar ou \*2\* se precisar remarcar\. 😊/, 'Toca no botão aqui embaixo pra me avisar 😊');
    try {
      await enviarMensagemDeChat(unit, {
        chatId: ctx.chatId,
        recipientId: ctx.authorId,
        talkId: ctx.talkId,
        contactId: ctx.contactId,
        accountId: ctx.accountId,
        texto: textoDoChat,
        ...(modeloDaUnidade ? {} : { botoes: BOTOES_D1 }),
      });
      foiPeloChat = true;
      enviado = textoDoChat;
      if (!modeloDaUnidade) via = 'chat_botoes';
    } catch (err) {
      logger.warn({ unit: unit.slug, leadId, err: String(err) }, 'confirmação: chat direto falhou, indo pelo caminho de texto');
    }
  }
  if (!foiPeloChat) {
    // `sendChatReply` cai para NOTA no cartão quando o chat recusa — e nota o paciente não lê.
    // Tratar isso como enviado faria o dedupe calar a próxima tentativa até depois da consulta.
    const r = await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null });
    if (r.via === 'lead_note') {
      logger.warn({ unit: unit.slug, leadId, toque }, 'confirmação: virou nota interna, o paciente NÃO recebeu');
      // No dia útil anterior não há segunda chance: no dia seguinte a consulta já saiu dos dias-alvo. Vira tarefa de ligação.
      if (e.daUnidade?.diaUtil) {
        await kommo.createTask({
          leadId,
          text: textoAlertaSemJanela({ slug: unit.slug, nome: conv?.contactName, quando: consulta.quando }),
          completeAt: Math.floor(Date.now() / 1000) + 60 * 60,
        });
        await marcar();
        return 'tarefa';
      }
      return 'nada';
    }
  }
  // A mensagem já está com o paciente: marca ANTES dos writes abaixo, que podem falhar.
  await marcar();
  await armar();
  if (conv) {
    await addMessage({ conversationId: conv.id, role: 'assistant', content: enviado, meta: { origem: `confirmacao_${toque}`, via } });
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
  // Unidade no "dia útil anterior" (Petrópolis, 17/11/2026): um toque só, no último dia útil antes da consulta.
  // Sexta confirma sábado, domingo e segunda; fim de semana e feriado não confirmam nada. Sem D-2.
  const quais = lembretesDoServidor(unit);
  const { daUnidade, diaUtil } = quais;
  const diasAlvo = diaUtil ? diasQueConfirmamHoje(dia) : quais.d2 ? [amanha, depois] : [amanha];
  if (!diasAlvo.length) {
    ultimoEnvioPorUnidade.set(unit.id, dia);
    return;
  }
  const links = await prisma.spineLeadLink.findMany({
    where: {
      unitId: unit.id,
      // conversa do Chatwoot (chave sintética, sem cartão no Kommo): a véspera dela é da régua do Chatwoot
      ...SO_CARTAO_DO_KOMMO,
      spineIdSchedule: { not: null },
      OR: diasAlvo.map((d) => ({ agendadoPara: { startsWith: d } })),
    },
  });

  const kommo = createKommoClient(unit);
  const conta = { lembrete: 0, chat_botoes: 0, texto: 0, template: 0, tarefa: 0, nada: 0, d2: 0, pulados: 0, ja_confirmou: 0, etapa: 0, desistiu: 0, robo_kommo: 0 };
  let pipes: KommoPipeline[] | null = null;
  const nomeDaEtapa = async (pipelineId: number | undefined, statusId: number): Promise<string | null> => {
    pipes ??= await kommo.listPipelines().catch(() => []);
    const pipe = pipes.find((p) => p.id === pipelineId) ?? pipes.find((p) => p.statuses?.some((s) => s.id === statusId));
    return pipe?.statuses?.find((s) => s.id === statusId)?.name ?? null;
  };
  // Véspera pelo robô do Kommo (chave confirmacao-d1, decisão de 16/10/2026): fora de "desligado" — só no papel
  // ou ligada —, a do servidor não sai nesta unidade. O gatilho do Kommo já manda a véspera; as duas juntas
  // davam duas perguntas ao mesmo paciente (revisão de 16/10, item 5).
  const vesperaDoKommo = quais.vespera === 'robo-kommo';

  for (const link of links) {
    const consulta = await AgendaReconcileService.consultaDoLead(unit, link.kommoLeadId);
    // `nao_confirmada` significa que a franquia NÃO devolveu este horário agora: o `quando` é o
    // valor salvo, que pode estar velho. Perguntar "confirma sua consulta de quinta às 15h" com
    // data não verificada é pior que não perguntar.
    if (!consulta || consulta.estado !== 'confirmada' || !consulta.quando) {
      conta.pulados++;
      continue;
    }
    const diaDaConsulta = consulta.quando.slice(0, 10);
    const toque: Toque | null = diaUtil ? (diaUtilAnterior(diaDaConsulta) === dia ? 'd1' : null) : toqueDoDia(diaDaConsulta, dia);
    if (!toque) continue;
    if (toque === 'd2' && !quais.d2) continue;
    if (toque === 'd1' && vesperaDoKommo) {
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
      const desistiu = oficiais ? desistenciaEscrita(oficiais, marcadaEm) : null;
      if (desistiu) {
        conta.desistiu++;
        const chaveTarefa = `vespera_desistencia:${consulta.quando}`;
        if (!(await avisoRecente(unit.id, link.kommoLeadId, chaveTarefa, POR_CONSULTA_MS))) {
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

      // Pendência 3 de Petrópolis (17/11): quem já confirmou não recebe a pergunta. Depois da desistência: quem
      // confirmou e depois escreveu "não vou poder" precisa da tarefa (caso Milena/Leomar). Ver `confirmacao-unidade.ts`.
      const confirmado = daUnidade?.pularConfirmada ? jaConfirmou({ idStatus: consulta.idStatus, oficiais }) : null;
      if (confirmado) {
        conta.ja_confirmou++;
        await marcarAviso(unit.id, link.kommoLeadId, chave);
        logger.info({ unit: unit.slug, kommoLeadId: link.kommoLeadId, quando: consulta.quando, motivo: confirmado }, 'confirmação: já confirmou, não sai');
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
        daUnidade,
        horaLocal: hora,
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

/**
 * A pergunta da MANHÃ da consulta (toque `d0`, chave `confirmacao-manha`). Roda a cada varredura (de hora em hora), não uma vez por dia
 * como a véspera: a consulta das 14h é perguntada entre 9h e 12h30, a das 18h entre 13h e 16h30. Consulta antes das 9h30 não tem
 * margem (a clínica abre às 8h e a pergunta precisa de 1 h 30 de folga): fica só com a véspera.
 * Decisão em `confirmacao-manha.ts` (pura); aqui só se juntam os fatos. Caminho de envio e tratador da resposta são os da véspera.
 */
async function lembrarManhaUnidade(unit: Unit): Promise<void> {
  const estado = estadoDaManha(unit.slug);
  if (estado === 'desligado' || !unit.spineEnabled || !unit.spineToken) return;
  const quais = lembretesDoServidor(unit);
  // Véspera e lembrete do dia pelo robô do Kommo: a pergunta da manhã já sai de lá; as duas juntas dariam duas perguntas ao paciente.
  if (quais.vespera === 'robo-kommo') return;
  const agora = new Date();
  if (!clinicaAtendendoAgora(unit, agora)) return;
  const tz = unit.spineTimezone || 'America/Sao_Paulo';
  const agoraLocalISO = SpineService.instanteNoFuso(agora, tz).slice(0, 16);
  const hora = Number(agoraLocalISO.slice(11, 13));

  const links = await prisma.spineLeadLink.findMany({
    where: { unitId: unit.id, ...SO_CARTAO_DO_KOMMO, spineIdSchedule: { not: null }, agendadoPara: { startsWith: agoraLocalISO.slice(0, 10) } },
  });
  if (!links.length) return;

  const kommo = createKommoClient(unit);
  const conta: Record<string, number> = { enviados: 0, seco: 0 };
  const soma = (k: string) => (conta[k] = (conta[k] ?? 0) + 1);
  let pipes: KommoPipeline[] | null = null;

  for (const link of links) {
    if (conta.enviados >= MAX_ENVIOS_POR_VARREDURA) {
      soma('adiados_pelo_teto');
      continue;
    }
    // pelo horário gravado no vínculo, já se vê quem não está perto da janela: poupa a chamada à franquia (uma por consulta de hoje, a cada varredura)
    if (!talvezDentroDaJanela(link.agendadoPara, agoraLocalISO)) {
      soma('fora_da_janela');
      continue;
    }
    try {
      const consulta = await AgendaReconcileService.consultaDoLead(unit, link.kommoLeadId);
      // sem `quando` verificado agora, ou fora da janela: sai antes de qualquer chamada ao Kommo
      if (!consulta?.quando || consulta.estado !== 'confirmada') {
        soma('consulta_nao_confirmada');
        continue;
      }
      const quando = consulta.quando;
      const chave = chaveDaConfirmacao('d0', quando);
      const perguntouHoje = await avisoRecente(unit.id, link.kommoLeadId, chave, POR_CONSULTA_MS);
      const previa = decidirManha({
        estado, vespera: quais.vespera, clinicaAtendendo: true, consulta, agoraLocal: agoraLocalISO, perguntouHoje,
        etapaSemVespera: false, desistiu: false, confirmadaNaFranquia: null, confirmouNoWhatsapp: false, pediuParaRemarcar: false,
      });
      if (previa.acao === 'pular') {
        soma(previa.motivo);
        continue;
      }

      // Pergunta nova a um paciente só sai com TUDO lido: cartão, etapas e conversa. Falha de leitura = pula e a próxima varredura tenta de novo
      // (sem isto, um soluço do Kommo perguntaria «você consegue vir?» a quem está em «Cancelado» ou escreveu «não vou poder»).
      const lead = await kommo.getLead(link.kommoLeadId).catch(() => null);
      if (!pipes?.length) pipes = await kommo.listPipelines().catch(() => null);
      const oficiais = await mensagensOficiais(kommo, link.kommoLeadId, 40).catch(() => null);
      if (!lead || !pipes?.length || !oficiais) {
        soma('leitura_falhou');
        continue;
      }
      const pipe = lead.status_id ? (pipes.find((p) => p.id === lead.pipeline_id) ?? pipes.find((p) => p.statuses?.some((st) => st.id === lead.status_id))) : undefined;
      const etapa = lead.status_id ? (pipe?.statuses?.find((st) => st.id === lead.status_id)?.name ?? null) : null;
      const conv = await prisma.conversation.findFirst({
        where: { unitId: unit.id, leadId: String(link.kommoLeadId) },
        orderBy: { lastMessageAt: 'desc' },
        select: { id: true, confirmacaoD1Resposta: true },
      });
      // a resposta guardada na conversa é da ÚLTIMA pergunta; só vale se essa pergunta foi sobre ESTA consulta (chave com o horário)
      const perguntouEstaConsulta =
        (await avisoRecente(unit.id, link.kommoLeadId, chaveDaConfirmacao('d1', quando), POR_CONSULTA_MS)) ||
        (await avisoRecente(unit.id, link.kommoLeadId, chaveDaConfirmacao('d2', quando), POR_CONSULTA_MS));
      const marcadaEm = consulta.mudou ? new Date() : link.updatedAt;
      const decisao = decidirManha({
        estado,
        vespera: quais.vespera,
        clinicaAtendendo: true,
        consulta,
        agoraLocal: agoraLocalISO,
        perguntouHoje,
        etapaSemVespera: !!lead.status_id && etapaSemVespera({ statusId: lead.status_id, nome: etapa }) !== null,
        desistiu: !!desistenciaEscrita(oficiais, marcadaEm),
        confirmadaNaFranquia: jaConfirmou({ idStatus: consulta.idStatus, oficiais }),
        confirmouNoWhatsapp: perguntouEstaConsulta && conv?.confirmacaoD1Resposta === 'confirmou',
        pediuParaRemarcar: perguntouEstaConsulta && (conv?.confirmacaoD1Resposta === 'remarcar' || conv?.confirmacaoD1Resposta === RESPOSTA_OFERTA_SOFIA),
      });
      if (decisao.acao === 'pular') {
        soma(decisao.motivo);
        continue;
      }
      if (estado === 'seco') {
        soma('seco');
        registrarSimulacao(unit, ID_CONFIRMACAO_MANHA, {
          leadId: link.kommoLeadId,
          acao: 'mandaria',
          alvo: 'mensagem',
          valor: textoConfirmacaoManha({
            nome: primeiroNomeDoPaciente(lead.name ?? null, null), quando, especialista: consulta.especialista,
            endereco: unit.clinicAddress, horaDoEnvio: hora, oferece: oferecerNovoHorario(unit.slug) === 'ligado', comBotoes: true,
          }),
          deEtapa: etapa,
        });
        continue;
      }
      const via = await pedirConfirmacao({
        unit,
        kommo,
        leadId: link.kommoLeadId,
        consulta: consulta as ConsultaReconciliada & { quando: string },
        toque: 'd0',
        chave,
        titulo: lead.name ?? null,
        oficiais,
        horaLocal: hora,
      });
      soma(via);
      if (via !== 'nada') conta.enviados++;
    } catch (err) {
      soma('erros');
      logger.warn({ unit: unit.slug, kommoLeadId: link.kommoLeadId, err: String(err) }, 'confirmação da manhã: falha no lead');
    }
  }
  logger.info({ unit: unit.slug, estado, candidatos: links.length, ...conta }, 'confirmação da manhã: varredura concluída');
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

/**
 * A manhã tem a sua varredura, a cada 15 min: a janela de uma consulta das 10h é de 8h a 8h30 (a clínica abre às 8h), e uma varredura de
 * hora em hora a acertaria ao acaso. É barata: unidade com a chave desligada sai antes de ler qualquer coisa.
 */
const SWEEP_MANHA_MS = 15 * 60_000;
let timerManha: NodeJS.Timeout | null = null;
let rodandoManha = false;

async function varrerManha(): Promise<void> {
  if (rodandoManha) return;
  rodandoManha = true;
  try {
    const unidades = (await prisma.unit.findMany({ where: { spineEnabled: true } })).filter((u) => !emPausa(u) || u.pausaPor === PAUSA_POR);
    for (const unit of unidades) {
      await lembrarManhaUnidade(unit).catch((err) => {
        logger.warn({ err: String(err), unit: unit.slug }, 'confirmação da manhã: erro na unidade (ignorado)');
      });
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'confirmação da manhã: varredura falhou');
  } finally {
    rodandoManha = false;
  }
}

export function startReminderWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  timerManha = setInterval(() => void varrerManha(), SWEEP_MANHA_MS);
  void varrer();
  logger.info('confirmação de presença: worker iniciado (D-2 reforço + D-1 véspera + manhã da consulta)');
}

export function stopReminderWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (timerManha) clearInterval(timerManha);
  timerManha = null;
}
