/**
 * "Cancelei", "desmarquei", "não vou": o paciente desistiu da consulta que tinha.
 *
 * Item 6 da lista da Suzanne (25/10/2026), decisão do João em 26/10:
 *  1. os lembretes param;
 *  2. a Sofia TENTA REMARCAR (acolhe em uma frase, oferece novo horário — bloco em `agent/paciente-desistiu.ts`);
 *     se ele recusar ou não responder, encerra com educação, para a régua e abre tarefa para a equipe.
 *
 * O que aconteceu nos casos de Araguaína (medido em 26/10, eventos do Kommo + banco):
 *  - #28861610: consulta de 23/10 14:00 só no cartão (nunca foi para a franquia: 0 linha em `spine_lead_links`).
 *    "Cancelei." às 14:03 de 22/10, em cima do lembrete de 24 h; a IA estava pausada, então ninguém respondeu. O cartão
 *    ficou em AGENDADO e os robôs de 3 h e de 1 h antes mandaram às 11:00 e 13:01 de 23/10.
 *  - #28858170: "pode desmarcar" em 24/10 11:17; cartão em AGENDADO; os dois robôs de 24 h mandaram às 14:00 de 25/10.
 * O robô do Kommo não lê conversa. Quem tem de agir é a equipe — e a única coisa que o servidor sabia era uma NOTA no
 * cartão ("o paciente continuou escrevendo com a IA pausada"), que ninguém lê. Aqui vira TAREFA com o prefixo ALERTA,
 * que também chega no WhatsApp do grupo.
 *
 * O detector é ESTREITO de propósito (frases reais lidas antes do regex, 45 dias de mensagens): "cancelamento de
 * contrato" e "solicitação de cancelamento" são conversa de tratamento, e "não irei pagar a mais" não é "não vou ir".
 */
import type { Unit } from '@prisma/client';
import type { KommoLead } from '../services/kommo.service.js';
import { avisoRecente, marcarAviso, JANELA_24H_MS } from './aviso-dedupe.js';
import { logger } from './logger.js';
import { fusoDaUnidade } from './fuso.js';

function normalizar(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const VERBO_DE_IR = '(ir|comparecer|vir|estar (ai|la|presente|na consulta)|chegar)';
const PODER = '(vou|vamos|vai|irei|iremos|poderei|poderemos|posso|podemos|consigo|conseguimos|conseguirei|conseguiremos)';

/** O que NÃO entra: "remarcar/reagendar/outro dia" (quer horário novo, não desistiu — a Sofia já remarca) e "cancelou/cancelaram" (3ª pessoa). */
const DESISTE_DA_CONSULTA: RegExp[] = [
  // 1ª pessoa, imperativo e infinitivo: cancelar, cancelei, cancelo, cancela, cancele, cancelando — e desmarc-
  /\b(cancel|desmarc|desmarqu)(ar|ei|o|e|a|ando|amos|em)\b(?! (de )?contrato)/,
  /\bcancelamento d[aoe] (minha |nossa |meu |nosso )?(consulta|agendamento|horario|sessao|vaga)\b/,
  /\bdesist(i|ir|o|imos|indo)\b/,
  // "não vou poder ir", "n vou conseguir comparecer", "não poderei ir", "não irei" + verbo de ir
  new RegExp(`\\bn(ao|) ${PODER}( mais)?( (poder|conseguir))? ${VERBO_DE_IR}\\b`),
  /\bn(ao|) (vou|vamos|irei|iremos) mais\b/,
  // "Nao irei." / "Infelizmente não vou." — a frase inteira, sem complemento (com complemento é outra coisa: "não irei pagar")
  /\bn(ao|) (irei|iremos|vou|vamos)[ .!]*$/,
  /\bn(ao|) (vou|irei|iremos) precisar mais\b/,
  // "não vai dar pra ir", "não vai dar pra mim ir hoje", "não vai dar eu ir"
  new RegExp(`\\bn(ao|) vai (dar|rolar) (pra |para |de )?(mim |eu |ela |ele )?${VERBO_DE_IR}\\b`),
  // "tive um imprevisto", "surgiu um imprevisto", "houve imprevistos" — quem relata, não "imprevistos acontecem"
  /\b(tive|tivemos|teve|houve|surgiu|surgiram|aconteceu|aconteceram|ocorreu|deu|com) (um |uns |uma |alguns |algum |grande |grandes )*imprevistos?\b/,
];

/** O texto diz que o paciente não vem à consulta que tinha? */
export function pareceDesistenciaDaConsulta(texto: string | null | undefined): boolean {
  const s = normalizar(texto ?? '');
  return !!s && DESISTE_DA_CONSULTA.some((r) => r.test(s));
}

const CAMPO_DATA_DA_CONSULTA = 'datadaconsulta';

/** Data da consulta no cartão (epoch s) quando ainda não passou — ou null. Por NOME do campo: cada conta tem os seus ids. */
export function consultaFuturaDoCartao(lead: Pick<KommoLead, 'custom_fields_values'> | null | undefined, agoraS: number): number | null {
  for (const f of lead?.custom_fields_values ?? []) {
    const nome = normalizar(f.field_name ?? '').replace(/[^a-z0-9]/g, '');
    if (nome !== CAMPO_DATA_DA_CONSULTA) continue;
    const n = Number(f.values?.[0]?.value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Uma folga de 3 h: o paciente que escreve "não vou" no meio da tarde de uma consulta das 14 h ainda é desistência.
    return n >= agoraS - 3 * 3600 ? n : null;
  }
  return null;
}

/** "AAAA-MM-DDTHH:mm" local da clínica → "dd/mm às HH:mm". */
function quandoLocal(epochS: number, tz: string): string {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(epochS * 1000),
  );
  // "26/10, 14:00" → "26/10 às 14:00"
  return p.replace(/,?\s+/, ' às ');
}

export function textoTarefaDesistenciaSemIA(args: { slug: string; nome: string | null | undefined; quando: string; mensagem: string; etapa?: string | null }): string {
  const trecho = args.mensagem.replace(/\s+/g, ' ').trim().slice(0, 140);
  return (
    `ALERTA · ${args.slug} · [Contato: ${args.nome || 'paciente'}] Escreveu que não vem: "${trecho}". ` +
    `A consulta de ${args.quando} segue no cartão${args.etapa ? ` (etapa ${args.etapa})` : ''} e a IA está pausada — ninguém ofereceu novo horário. ` +
    'Combine outro horário com o paciente OU, se ele não quer mais, cancele na franquia, ponha ✓ Situação da consulta = Desmarcado e tire o cartão de AGENDADO. ' +
    'Enquanto estiver em AGENDADO com a data da consulta, os lembretes automáticos do Kommo continuam saindo para ele.'
  );
}

export type ResultadoDaDesistencia = 'nao_e' | 'sem_consulta' | 'ja_avisada' | 'tarefa_aberta' | 'falhou';

export interface DepsDaDesistencia {
  agora: () => Date;
  avisoRecente: typeof avisoRecente;
  marcarAviso: typeof marcarAviso;
}

const DEPS_PADRAO: DepsDaDesistencia = { agora: () => new Date(), avisoRecente, marcarAviso };

/**
 * IA pausada e o paciente escreveu que não vem: sem Sofia para remarcar, a equipe é quem resolve — e precisa saber
 * por tarefa, não por nota. Só quando o cartão tem consulta ainda por vir (sem consulta, "cancelei" pode ser o plano de
 * saúde). Uma tarefa por consulta a cada 24 h (a trava de 21/09 contra tarefa repetida). Nunca lança.
 */
export async function avisarDesistenciaComIaPausada(
  args: {
    unit: Pick<Unit, 'id' | 'slug' | 'spineTimezone' | 'businessHoursTimezone'>;
    leadId: number;
    texto: string;
    nome?: string | null;
    kommo: {
      getLead(id: number): Promise<KommoLead | null>;
      createTask(a: { leadId: number; text: string; completeAt: number }): Promise<{ id?: number } | null>;
    };
  },
  deps: DepsDaDesistencia = DEPS_PADRAO,
): Promise<ResultadoDaDesistencia> {
  if (!pareceDesistenciaDaConsulta(args.texto)) return 'nao_e';
  const { unit, leadId, kommo } = args;
  try {
    const agora = deps.agora();
    const lead = await kommo.getLead(leadId);
    const consulta = consultaFuturaDoCartao(lead, Math.floor(agora.getTime() / 1000));
    if (!consulta) return 'sem_consulta';
    const chave = `desistencia_sem_ia:${consulta}`;
    if (await deps.avisoRecente(unit.id, leadId, chave, JANELA_24H_MS, agora)) return 'ja_avisada';
    const tz = fusoDaUnidade(unit);
    const criada = await kommo.createTask({
      leadId,
      text: textoTarefaDesistenciaSemIA({ slug: unit.slug, nome: args.nome ?? lead?.name ?? null, quando: quandoLocal(consulta, tz), mensagem: args.texto }),
      completeAt: Math.floor(agora.getTime() / 1000) + 60 * 60,
    });
    // marca SÓ depois de o Kommo confirmar: falha de rede não pode calar o aviso por 24 h
    if (!criada) return 'falhou';
    await deps.marcarAviso(unit.id, leadId, chave, agora);
    logger.info({ unit: unit.slug, leadId, consulta }, 'desistência com a IA pausada: tarefa aberta para a equipe');
    return 'tarefa_aberta';
  } catch (err) {
    logger.warn({ unit: unit.slug, leadId, err: String(err) }, 'desistência com a IA pausada: não consegui abrir a tarefa — segue');
    return 'falhou';
  }
}
