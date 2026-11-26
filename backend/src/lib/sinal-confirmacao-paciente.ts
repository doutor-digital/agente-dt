/**
 * A CONFIRMAÇÃO DO SINAL AO PACIENTE (decisão do João, 26/11/2026): quando o sinal de R$ 50 é pago — pelo Pix do Asaas ou pelo link da InfinitePay, as duas rotas —
 * a Sofia manda UMA mensagem curta: «Recebemos seu sinal de R$ 50 ✅ Sua consulta está confirmada para <dia, data> às <hora> na Doutor Hérnia <cidade>. Até lá!».
 * Até então o pagamento só marcava o cartão («✓ Consulta pg antecipado») e o paciente ficava sem resposta.
 *
 * REGRAS:
 *  - UMA por sinal pago, para sempre: a reserva é um UPDATE condicionado a `confirmacao_em` nulo, feito ANTES de qualquer envio. Webhook, varredura, retry e pagamento
 *    atrasado chegam todos aqui e só um vence. Quem perde não envia. Erro no envio NÃO solta a reserva (duas mensagens ao paciente é pior que nenhuma: a equipe vê a nota);
 *  - dia e hora vêm da consulta que o sinal garante (`consultaEm`, que acompanha a remarcação). Sem data válida, ou de consulta que já passou, a frase sai sem essa parte: nunca se inventa;
 *  - canal: o Kommo, o mesmo caminho da Sofia (`sendChatReply`, Salesbot). Texto livre só chega com o paciente tendo escrito nas últimas 24 h (a mesma janela, com a mesma folga, da
 *    confirmação de véspera). FORA dela NÃO se envia nada, nem modelo: fica uma nota no cartão. Sem rota de envio pelo Salesbot, idem;
 *  - IA pausada (a unidade, «Pausar IA» no cartão ou pausa com data) = não envia; fica a nota;
 *  - chave `sinal-confirmacao-paciente` (SINAL_CONFIRMACAO_PACIENTE_SLUGS): ligada só onde o João liga; fora dela «só no papel» (decide e REGISTRA o que mandaria, sem tocar no
 *    paciente nem no cartão); desligada não faz nada;
 *  - só no Kommo: o sinal de uma conversa do Chatwoot não tem cartão nem Salesbot (a baixa dele é etiqueta + nota);
 *  - pagamento de mais de 12 h atrás não gera mensagem (a ligação da chave não pode mandar «recebemos seu sinal» sobre sinal de semanas atrás).
 * Nada daqui vai para o log além do id do cartão: nem o texto, nem nome, nem telefone.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { emPausa } from './pausa-unidade.js';
import { leadPausadoPorJanela } from './pausa-lead.js';
import { conversaDoLeadChatwoot } from './chatwoot-lead.js';
import { confirmacaoDaUnidade } from './confirmacao-unidade.js';
import { diaCurto as diaComSemana, janelaAberta as janelaDeTexto } from './confirmacao-d1.js';
import { fusoDoSinal, instanteLocal, nomeDaClinica, type LinhaDoSinal } from './sinal-pix.js';
import { createKommoClient, isLeadPaused, type KommoClient } from '../services/kommo.service.js';
import { mensagensOficiais } from '../services/kommo-talks.service.js';

export const ID_SINAL_CONFIRMACAO = 'sinal-confirmacao-paciente';
/** Depois disto o pagamento é «antigo» demais para virar mensagem. */
export const VALE_A_CONFIRMACAO_MS = 12 * 3600_000;

export type Desfecho = 'enviada' | 'fora-da-janela' | 'pausada' | 'sem-rota' | 'erro';

export type ResultadoDaConfirmacao =
  | { tipo: 'enviada' }
  /** não enviou e deixou a nota no cartão (o desfecho diz por quê) */
  | { tipo: 'nota'; desfecho: Exclude<Desfecho, 'enviada'> }
  /** modo «só no papel»: o que faria (nada saiu) */
  | { tipo: 'simulada'; faria: 'mandar' | 'nota'; motivo: string }
  | { tipo: 'ja-feita' }
  | { tipo: 'desligada' }
  | { tipo: 'fora-de-prazo' }
  | { tipo: 'nao-kommo' }
  /** não deu para ler a conversa agora: nada foi reservado, a próxima varredura tenta de novo */
  | { tipo: 'adiada'; motivo: string };

const reaisCurto = (centavos: number): string => (centavos % 100 === 0 ? String(centavos / 100) : (centavos / 100).toFixed(2).replace('.', ','));

/**
 * O texto. `consultaEm` = "AAAA-MM-DDTHH:mm" no relógio da unidade. Consulta que não existe, não é uma data válida ou já passou: a frase sai sem «para <dia> às <hora>».
 */
export function textoDaConfirmacao(a: { valorCentavos: number; consultaEm: string | null | undefined; nomeDaUnidade: string; agoraLocal: string }): string {
  const valido = !!a.consultaEm && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a.consultaEm) && !Number.isNaN(Date.parse(`${a.consultaEm.slice(0, 16)}:00Z`)) && a.consultaEm.slice(0, 16) >= a.agoraLocal;
  const quando = valido ? ` para ${diaComSemana(a.consultaEm!)} às ${a.consultaEm!.slice(11, 16)}` : '';
  return `Recebemos seu sinal de R$ ${reaisCurto(a.valorCentavos)} ✅ Sua consulta está confirmada${quando} na Doutor Hérnia ${nomeDaClinica(a.nomeDaUnidade)}. Até lá!`;
}

const NOTA: Record<Exclude<Desfecho, 'enviada'>, (porque: string) => string> = {
  'fora-da-janela': () => '📵 confirmação não enviada: fora da janela de 24 h. O sinal está pago e o cartão marcado; avise o paciente por outro canal.',
  pausada: (porque) => `📵 confirmação não enviada: a IA está pausada (${porque}). O sinal está pago e o cartão marcado; avise o paciente se precisar.`,
  'sem-rota': () => '📵 confirmação não enviada: a unidade não tem rota de envio pelo Salesbot. O sinal está pago e o cartão marcado; avise o paciente.',
  erro: () => '📵 confirmação não enviada: o envio deu erro (confira no Kommo se a mensagem saiu antes de avisar de novo). O sinal está pago e o cartão marcado.',
};

export interface DepsDaConfirmacao {
  estado: (slug: string) => Estado;
  agora: () => Date;
  /** a reserva: true só para quem a conseguiu (UPDATE condicionado a `confirmacao_em` nulo) */
  reservar: (linhaId: string) => Promise<boolean>;
  concluir: (linhaId: string, desfecho: Desfecho) => Promise<void>;
  /** o motivo de a IA estar pausada, ou null */
  pausadoPor: (unit: Unit, leadId: number) => Promise<string | null>;
  /** o paciente escreveu nas últimas 24 h? Lança se não deu para ler a conversa. */
  janelaAberta: (unit: Unit, leadId: number) => Promise<boolean>;
  temRota: (unit: Unit) => boolean;
  /** `enviado` = foi para o Salesbot; `sem-rota` = o Kommo só deixou uma nota interna (o paciente NÃO recebeu). Lança em erro. */
  enviar: (unit: Unit, leadId: number, texto: string) => Promise<'enviado' | 'sem-rota'>;
  gravarMensagem: (unit: Unit, leadId: number, texto: string) => Promise<void>;
  nota: (unit: Unit, leadId: number, texto: string) => Promise<void>;
  simular: (unit: Unit, s: Parameters<typeof registrarSimulacao>[2]) => void;
}

// só no papel: o que já foi simulado nesta vida do processo (a varredura passa de 5 em 5 min pelo mesmo sinal por até 12 h)
const simulados = new Set<string>();

export async function confirmarSinalAoPaciente(unit: Unit, linha: LinhaDoSinal, deps: DepsDaConfirmacao): Promise<ResultadoDaConfirmacao> {
  const leadId = Number(linha.leadId);
  if (!Number.isFinite(leadId) || conversaDoLeadChatwoot(leadId) !== null) return { tipo: 'nao-kommo' };
  if (linha.status !== 'pago' || linha.confirmacaoEm) return { tipo: 'ja-feita' };
  const estado = deps.estado(unit.slug);
  if (estado === 'desligado') return { tipo: 'desligada' };
  const agora = deps.agora();
  if (!linha.pagoEm || agora.getTime() - linha.pagoEm.getTime() > VALE_A_CONFIRMACAO_MS) return { tipo: 'fora-de-prazo' };
  if (estado === 'seco' && simulados.has(linha.id)) return { tipo: 'ja-feita' };

  // 1) o que fazer, SEM efeito nenhum (só leituras). Não deu para ler = adia sem reservar nada.
  let decisao: { tipo: 'enviar' } | { tipo: 'nota'; desfecho: Exclude<Desfecho, 'enviada'>; porque: string };
  try {
    const pausa = await deps.pausadoPor(unit, leadId);
    if (pausa) decisao = { tipo: 'nota', desfecho: 'pausada', porque: pausa };
    else if (!(await deps.janelaAberta(unit, leadId))) decisao = { tipo: 'nota', desfecho: 'fora-da-janela', porque: 'o paciente não escreveu nas últimas 24 h' };
    else if (!deps.temRota(unit)) decisao = { tipo: 'nota', desfecho: 'sem-rota', porque: 'a unidade não tem Salesbot + campo de resposta' };
    else decisao = { tipo: 'enviar' };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_SINAL_CONFIRMACAO}: não consegui ler a conversa/pausa — tento na próxima varredura`);
    return { tipo: 'adiada', motivo: 'leitura falhou' };
  }

  const texto = textoDaConfirmacao({ valorCentavos: linha.valorCentavos, consultaEm: linha.consultaEm, nomeDaUnidade: unit.name, agoraLocal: instanteLocal(agora, fusoDoSinal(unit)) });

  // 2) só no papel: registra o que faria e para (nada reservado, nada enviado, nenhuma nota)
  if (estado === 'seco') {
    simulados.add(linha.id);
    if (simulados.size > 5000) simulados.clear();
    deps.simular(
      unit,
      decisao.tipo === 'enviar'
        ? { leadId, acao: 'mandaria', alvo: 'mensagem', valor: texto, motivo: 'sinal pago: confirmação ao paciente (Kommo, texto livre dentro da janela de 24 h)' }
        : { leadId, acao: 'pularia', alvo: 'mensagem', valor: texto, motivo: `não mandaria (${decisao.porque}); deixaria a nota «confirmação não enviada» no cartão` },
    );
    return { tipo: 'simulada', faria: decisao.tipo === 'enviar' ? 'mandar' : 'nota', motivo: decisao.tipo === 'enviar' ? 'mandar' : decisao.porque };
  }

  // 3) ligado: a reserva ANTES de qualquer envio ou nota. Quem perde a corrida não faz nada.
  if (!(await deps.reservar(linha.id))) return { tipo: 'ja-feita' };

  if (decisao.tipo === 'nota') {
    await deps.nota(unit, leadId, NOTA[decisao.desfecho](decisao.porque)).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_SINAL_CONFIRMACAO}: não consegui deixar a nota no cartão`));
    await deps.concluir(linha.id, decisao.desfecho).catch(() => undefined);
    logger.info({ unit: unit.slug, leadId, desfecho: decisao.desfecho }, `${ID_SINAL_CONFIRMACAO}: confirmação NÃO enviada — nota no cartão`);
    return { tipo: 'nota', desfecho: decisao.desfecho };
  }

  try {
    const via = await deps.enviar(unit, leadId, texto);
    if (via === 'sem-rota') {
      await deps.nota(unit, leadId, NOTA['sem-rota']('')).catch(() => undefined);
      await deps.concluir(linha.id, 'sem-rota').catch(() => undefined);
      return { tipo: 'nota', desfecho: 'sem-rota' };
    }
  } catch (err) {
    // a reserva FICA: exceção depois de o pedido partir não prova que nada saiu, e duas mensagens ao paciente é pior que uma que a equipe resolve pela nota
    logger.error({ err: String(err), unit: unit.slug, leadId, sinal: linha.id }, `${ID_SINAL_CONFIRMACAO}: o envio deu erro — a reserva FICA (não repete); confira no Kommo se saiu`);
    await deps.nota(unit, leadId, NOTA.erro('')).catch(() => undefined);
    await deps.concluir(linha.id, 'erro').catch(() => undefined);
    return { tipo: 'nota', desfecho: 'erro' };
  }
  await deps.concluir(linha.id, 'enviada').catch(() => undefined);
  // o agente registra o que a Sofia mandou: é como a pausa pela equipe reconhece a saída do Salesbot como da Sofia (e não como fala humana)
  await deps.gravarMensagem(unit, leadId, texto).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_SINAL_CONFIRMACAO}: enviei, mas não gravei a mensagem no banco`));
  logger.info({ unit: unit.slug, leadId }, `${ID_SINAL_CONFIRMACAO}: confirmação enviada`);
  return { tipo: 'enviada' };
}

/** O que a confirmação usa de verdade: o mundo (banco, Kommo, pausas). O cliente do Kommo pode vir de quem já o criou. */
export function depsReaisDaConfirmacao(kommo: KommoClient): DepsDaConfirmacao {
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_SINAL_CONFIRMACAO, process.env.SINAL_CONFIRMACAO_PACIENTE_SLUGS),
    agora: () => new Date(),
    reservar: async (id) => (await prisma.sinalPix.updateMany({ where: { id, confirmacaoEm: null }, data: { confirmacaoEm: new Date() } })).count === 1,
    concluir: async (id, desfecho) => void (await prisma.sinalPix.updateMany({ where: { id }, data: { confirmacao: desfecho } })),
    pausadoPor: async (unit, leadId) => {
      const fresca = await prisma.unit.findUnique({ where: { id: unit.id }, select: { pausaDesde: true, pausaAte: true } });
      if (fresca && emPausa(fresca)) return 'a IA da unidade está pausada';
      if (await leadPausadoPorJanela(unit.id, leadId)) return 'pausa com data neste cartão';
      if (await isLeadPaused(unit, leadId)) return '«Pausar IA» marcado no cartão';
      return null;
    },
    janelaAberta: async (unit, leadId) => {
      // WhatsApp Lite (QR): não existe a janela de 24 h, o texto chega sempre (mesma regra da confirmação de véspera)
      if (confirmacaoDaUnidade(unit.slug, true)?.semJanela) return true;
      return janelaDeTexto(await mensagensOficiais(kommo, leadId, 15));
    },
    temRota: (unit) => !!(unit.kommoReplyFieldId && (unit.kommoSalesbotId || unit.kommoBypassSalesbot)),
    enviar: async (_unit, leadId, texto) => ((await kommo.sendChatReply({ leadId, text: texto, chatId: null, talkId: null, contactId: null })).via === 'lead_note' ? 'sem-rota' : 'enviado'),
    gravarMensagem: async (unit, leadId, texto) => {
      let conversa = await prisma.conversation.findFirst({ where: { unitId: unit.id, leadId: String(leadId) }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } });
      if (!conversa) conversa = await prisma.conversation.create({ data: { unitId: unit.id, leadId: String(leadId), channel: 'kommo' }, select: { id: true } });
      await prisma.message.create({ data: { conversationId: conversa.id, role: 'assistant', content: texto, meta: { via: 'salesbot', origem: 'sinal_confirmacao' } } });
    },
    nota: async (_unit, leadId, texto) => void (await kommo.addLeadNote(leadId, texto)),
    simular: (unit, s) => registrarSimulacao(unit, ID_SINAL_CONFIRMACAO, s),
  };
}

/** Para o worker. O cliente do Kommo só é criado se a chave não está desligada. */
export async function confirmarSinalDaUnidade(unit: Unit, linha: LinhaDoSinal): Promise<ResultadoDaConfirmacao> {
  if (estadoDaAutomacao(unit.slug, ID_SINAL_CONFIRMACAO, process.env.SINAL_CONFIRMACAO_PACIENTE_SLUGS) === 'desligado') return { tipo: 'desligada' };
  return confirmarSinalAoPaciente(unit, linha, depsReaisDaConfirmacao(createKommoClient(unit)));
}
