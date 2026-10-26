/**
 * A IA só diz "confirmado / agendado / reservado" quando a consulta existe no CRM da franquia.
 *
 * Item 3 da lista da Suzanne (25/10/2026). O que foi medido em produção (14 dias, 26/10):
 *  - Canaã #28886952: a foto do comprovante virou consulta marcada e "✅ Agendamento confirmado" no mesmo
 *    turno; a equipe, que conferia o pagamento, tinha outra data. Decisão do João (26/10): comprovante em
 *    foto ou PDF, SÓ A EQUIPE confirma.
 *  - Balsas #28858838: a recepção desmarcou, o prompt do turno dizia "foi DESMARCADA no sistema" e a IA
 *    respondeu "sua consulta está marcada pra hoje, 22/10, às 13h — já está tudo certo". A trava de texto
 *    (`reserva-sem-marcar.ts`) não pegou: a frase vinha depois de "pra eu te garantir certo:", que o detector
 *    lia como condição.
 *
 * Aqui mora o que é decisão de código (não de prompt): o turno com comprovante não marca nem confirma; a
 * resposta que afirma é trocada pelo recado fixo; a equipe ganha a tarefa. Puro onde dá — o que fala com
 * o Kommo recebe o cliente por parâmetro.
 */
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { avisoRecente, marcarAviso } from '../lib/aviso-dedupe.js';
import { logger } from '../lib/logger.js';
import { ehTranscricaoDeComprovante } from '../lib/pagamento-antecipado.js';
import { normalizar, trechos, type Promessa } from '../lib/prometeu-sem-marcar.js';
import type { KommoClient } from '../services/kommo.service.js';
import type { TraceRecorder } from './trace-recorder.js';

/** O que a Sofia diz quando chega comprovante. A frase "em até 1 hora" é também a MARCA que o histórico guarda. */
export const RECADO_COMPROVANTE =
  'Recebi seu comprovante! 🙏 A equipe confere o pagamento e confirma a sua consulta em até 1 hora, aqui mesmo na conversa.';
const MARCA_DO_RECADO = 'confirma a sua consulta em até 1 hora';

/** A consulta que a IA tinha como marcada foi desmarcada no CRM: ela não confirma nada, a equipe vê. */
export const RECADO_DESMARCADA =
  'Deixa eu conferir direitinho o seu horário com a equipe — ela te confirma aqui mesmo na conversa em até 1 hora. 🙏';

/** Vai junto da resposta reprovada quando o CRM diz que a consulta foi desmarcada (refeita da trava). */
export const INSTRUCAO_DESMARCADA =
  '[instrução interna, não é fala do paciente] Sua resposta acima trata como marcada uma consulta que foi DESMARCADA ' +
  'no sistema da clínica: ela não existe mais. Se o paciente pediu, NESTA mensagem, um horário novo e já escolheu ' +
  'dia, hora e forma de pagamento, use consultar_horarios e agendar_consulta. Se ele só confirmou o horário antigo ' +
  'ou perguntou se está tudo certo, NÃO marque nada: diga que vai conferir com a equipe, que confirma em até 1 hora, ' +
  'sem dizer confirmado, agendado nem reservado. Responda só com a mensagem final ou com a chamada da ferramenta.';

/** O bloco `<consulta_do_paciente>` que diz "não há consulta de pé": desmarcada ou não compareceu. */
const BLOCO_SEM_CONSULTA = /foi DESMARCADA no sistema da clínica|registrou NÃO COMPARECEU/;

export function blocoDizDesmarcada(bloco: string | null | undefined): boolean {
  return BLOCO_SEM_CONSULTA.test(String(bloco ?? ''));
}

/**
 * Afirma que a consulta/vaga/pagamento ESTÁ confirmada, agendada, marcada ou reservada. Mais largo que o
 * `detectarPromessa` do vigia (que erra para o lado de calar): vale só onde afirmar é sempre falso — turno com
 * comprovante, ou consulta que o CRM diz desmarcada.
 */
const ASSUNTO = '(?:consulta|avaliacao|agendamento|horario|vaga|reserva|presenca|pagamento|pix|tudo)';
const PARTICIPIO = '(?:confirmad|agendad|marcad|reservad|garantid|recebid)(?:inh)?[oa]s?';
/** Frases de estado: "sua consulta está confirmada", "Agendamento confirmado", "já está tudo certo". */
const AFIRMA_ESTADO = new RegExp(
  [
    `\\b${ASSUNTO}\\s+(?:\\S+\\s+){0,5}?${PARTICIPIO}\\b`,
    `\\b${PARTICIPIO}\\s+(?:\\S+\\s+){0,2}?(?:consulta|vaga|horario|presenca)\\b`,
    String.raw`\b(?:esta|ficou|fica|ja esta|ja ficou)\s+(?:tudo\s+)?cert(?:o|inho|inha)\b|\btudo cert(?:o|inho)\b`,
    String.raw`\b(?:confirmei|agendei|marquei|reservei|garanti)\b`,
    // "Recebido, confirmado!" — o particípio solto, sem dizer o quê
    String.raw`(?:^|[,;:]\s*)(?:ja\s+|tudo\s+)?(?:confirmad|agendad|reservad|garantid)[oa]s?\b`,
  ].join('|'),
);
/** "Te espero terça", "nos vemos": só vale com dia/hora no trecho (no modo estrito). */
const AFIRMA_TE_ESPERO = /\b(?:te|lhe) (?:espero|esperamos|aguardo|aguardamos)\b|\bnos vemos\b/;
/** Negação/condição na ORAÇÃO da afirmação: "ainda não está confirmada", "se estiver confirmada", "para ser confirmada". */
const NAO_AFIRMA =
  /\b(?:nao|nem|nenhum|nenhuma|caso|quando|apos|depois que|assim que|aguarde|aguardando|para ser|pra ser|ate eu)\b|\bse (?:voce|vc|ele|ela|estiver|for|der)\b/;
/**
 * Modo estrito (consulta desmarcada): ali a IA ainda pode explicar preço e oferecer novo horário ("esse valor
 * já garante seu horário reservado"), então fica de fora a explicação de pagamento, e "te espero" só vale com
 * dia/hora.
 */
const EXPLICA_PAGAMENTO = /\b(?:pagando|pagamento antecipado|antecipado|antecipando|valor|pix|r\$)\b/;
const QUANDO = /\b(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|\b\d{1,2}\/\d{1,2}\b|\b(?:amanha|hoje)\b|\b\d{1,2}(?::\d{2}|h\d{0,2})\b/;

/** A oração em que a afirmação aparece: do último separador (vírgula, ponto e vírgula, dois-pontos) até o fim dela. */
function oracaoDe(n: string, fim: number): string {
  const antes = n.slice(0, fim);
  return n.slice(Math.max(antes.lastIndexOf(','), antes.lastIndexOf(';'), antes.lastIndexOf(':')) + 1, fim);
}

export function afirmaConfirmacao(texto: string | null | undefined, opcoes: { estrito?: boolean } = {}): Promessa | null {
  for (const t of trechos(String(texto ?? ''))) {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n)) continue;
    if (opcoes.estrito && EXPLICA_PAGAMENTO.test(n)) continue;
    const e = AFIRMA_ESTADO.exec(n);
    const espera = AFIRMA_TE_ESPERO.exec(n);
    const m = e ?? (!opcoes.estrito || QUANDO.test(n) ? espera : null);
    if (m && !NAO_AFIRMA.test(oracaoDe(n, m.index + m[0].length))) return { trecho: t, forma: 'confirmacao', quando: null };
  }
  return null;
}

/**
 * O prompt diz que a consulta está desmarcada (ou o paciente não compareceu) e a resposta fala dela como de
 * pé. `promessa` é o que a trava de texto já achou; se ela calou, vale o detector largo em modo estrito. Marcou
 * neste turno (o paciente pediu para marcar de novo e a IA marcou) não é o caso.
 */
export function afirmouComConsultaDesmarcada(
  texto: string,
  ctx: { marcouAgora: boolean; bloco: string | null | undefined; promessa: Promessa | null },
): Promessa | null {
  if (ctx.marcouAgora || !blocoDizDesmarcada(ctx.bloco)) return null;
  return ctx.promessa ?? afirmaConfirmacao(texto, { estrito: true });
}

export interface TurnoDoComprovante {
  /** a mensagem deste turno traz foto/PDF lido como comprovante */
  noTurno: boolean;
  /** neste turno ou numa das últimas respostas a IA já disse "a equipe confirma": ainda não confirmou ninguém */
  pendente: boolean;
}

/** As últimas respostas da IA que ainda contam: depois disso a conversa seguiu e a equipe já deve ter respondido. */
const RESPOSTAS_QUE_CONTAM = 10;

export function turnoDoComprovante(ultimaFalaDoPaciente: string | null | undefined, respostasDaIA: ReadonlyArray<string>): TurnoDoComprovante {
  const noTurno = ehTranscricaoDeComprovante(String(ultimaFalaDoPaciente ?? ''));
  const pendente = noTurno || respostasDaIA.slice(-RESPOSTAS_QUE_CONTAM).some((t) => t.includes(MARCA_DO_RECADO));
  return { noTurno, pendente };
}

/** "pagamento confirmado", "seu Pix foi aprovado": quem confere o comprovante é a equipe, não a IA. */
const AFIRMA_PAGAMENTO = /\b(?:pagamento|pix|comprovante|valor)\s+(?:\S+\s+){0,5}?(?:confirmad|aprovad|conferid|validad|compensad|identificad)[oa]s?\b|\bcaiu\b/;

export function afirmaPagamentoConferido(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t);
    const m = AFIRMA_PAGAMENTO.exec(n);
    return !!m && !NAO_AFIRMA.test(oracaoDe(n, m.index + m[0].length));
  });
}

/**
 * Turno com comprovante: se a resposta afirma confirmação, vale o recado fixo. Resposta que não afirma
 * ("recebi, me manda o nome completo") segue como veio.
 *
 * Com uma consulta já no CRM (`consultaNoCrm` = o prompt traz a consulta de verdade: criada pela equipe, ou
 * paciente que paga o saldo) falar DELA é verdade e o texto fica — mas dizer que o PAGAMENTO foi conferido
 * continua sendo da equipe (achado do Codex): essa frase ainda vira o recado.
 */
export function respostaDoComprovante(texto: string, turno: TurnoDoComprovante, consultaNoCrm: boolean): string | null {
  if (!turno.pendente) return null;
  if (consultaNoCrm) return turno.noTurno && afirmaPagamentoConferido(texto) ? RECADO_COMPROVANTE : null;
  return afirmaConfirmacao(texto) ? RECADO_COMPROVANTE : null;
}

export const RECUSA_DO_COMPROVANTE =
  'RECUSADO: o paciente mandou comprovante de pagamento, e comprovante quem confirma é a EQUIPE da clínica. ' +
  'A consulta NÃO foi marcada. NÃO chame agendar_consulta de novo e NÃO diga que está confirmada, agendada, ' +
  `reservada ou garantida. Responda ao paciente só isto, com as suas palavras: "${RECADO_COMPROVANTE}"`;

/** Turnos depois do comprovante: a equipe ainda não respondeu e o paciente pode estar pedindo outra coisa. */
export const RECUSA_AGUARDANDO_EQUIPE =
  'RECUSADO: a equipe da clínica ainda está conferindo o comprovante que o paciente mandou antes, e é ela quem ' +
  'confirma a consulta. A consulta NÃO foi marcada. NÃO chame agendar_consulta de novo e NÃO diga que está confirmada, ' +
  'agendada, reservada ou garantida. Se o paciente pediu outro dia ou outra forma de pagar, diga que a equipe cuida ' +
  'disso junto da confirmação e chame resumir_lead_para_sdr.';

/**
 * `agendar_consulta` (e só ela; remarcar é de quem já tem consulta) recusa enquanto houver comprovante
 * esperando a equipe. Fica no grafo e não no prompt: prompt não segura o modelo (Olímpia 19/10, Canaã 24/10).
 */
export function travarAgendamentoPorComprovante(
  tools: DynamicStructuredTool[],
  turno: TurnoDoComprovante,
  recorder: Pick<TraceRecorder, 'step'>,
): DynamicStructuredTool[] {
  for (const tool of tools) {
    if (tool.name !== 'agendar_consulta') continue;
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      const remarcando = Boolean((args as { remarcando?: boolean } | null)?.remarcando);
      if (turno.pendente && !remarcando) {
        await recorder.step({
          kind: 'ERROR',
          title: '🧾 agendar_consulta recusado — comprovante: só a equipe confirma',
          payload: { noTurno: turno.noTurno, args },
        });
        return turno.noTurno ? RECUSA_DO_COMPROVANTE : RECUSA_AGUARDANDO_EQUIPE;
      }
      return original(args as never, ...(resto as never[]));
    };
  }
  return tools;
}

/** Rajada de PDFs do mesmo comprovante (Bebedouro mandou 5 em 1 minuto) = uma tarefa; outro comprovante, mais tarde, outra. */
const JANELA_COMPROVANTE_MS = 15 * 60_000;

type Dedupe = { avisoRecente: typeof avisoRecente; marcarAviso: typeof marcarAviso };

/**
 * Tarefa para a equipe, aberta pelo código (não pela IA): vence em 1 hora, no responsável do cartão. Uma por
 * cartão e motivo a cada 24 h; só marca o aviso depois que o Kommo aceitou, para uma falha não calar a próxima.
 */
export async function abrirTarefaParaEquipe(args: {
  slug: string;
  unitId: string;
  leadId: number;
  kommo: Pick<KommoClient, 'createTask' | 'getLead'>;
  recorder: Pick<TraceRecorder, 'step'>;
  motivo: 'comprovante' | 'desmarcada';
  dedupe?: Dedupe;
  agora?: () => number;
}): Promise<'criada' | 'repetida' | 'falhou'> {
  const { slug, unitId, leadId, kommo, recorder, motivo } = args;
  const dedupe = args.dedupe ?? { avisoRecente, marcarAviso };
  const chave = motivo === 'comprovante' ? 'comprovante_so_equipe' : 'consulta_desmarcada_afirmada';
  try {
    if (await dedupe.avisoRecente(unitId, leadId, chave, motivo === 'comprovante' ? JANELA_COMPROVANTE_MS : undefined)) return 'repetida';
    let nome: string | null = null;
    let responsavel: number | undefined;
    try {
      const lead = await kommo.getLead(leadId);
      nome = lead?.name?.trim() || null;
      responsavel = lead?.responsible_user_id || undefined;
    } catch (err) {
      logger.warn({ err: String(err), leadId }, 'tarefa da equipe: sem o cartão (nome/responsável)');
    }
    const quem = nome ? ` · ${nome}` : '';
    const text =
      motivo === 'comprovante'
        ? `CONFERIR COMPROVANTE · ${slug}${quem} · o paciente mandou o comprovante: conferir o pagamento e confirmar a consulta na franquia em até 1 h. A IA não confirmou nada por ele.`
        : `CONFERIR CONSULTA · ${slug}${quem} · a consulta está DESMARCADA no CRM e o paciente respondeu como se estivesse marcada. A IA não confirmou: falar com ele e remarcar em até 1 h.`;
    const agora = args.agora ?? Date.now;
    const res = await kommo.createTask({ leadId, text, completeAt: Math.floor(agora() / 1000) + 3600, responsibleUserId: responsavel });
    await dedupe.marcarAviso(unitId, leadId, chave);
    await recorder.step({
      kind: 'KOMMO_ACTION',
      title: `🧾 Tarefa para a equipe (${motivo}) no lead ${leadId} (tarefa ${res?.id ?? '?'})`,
      payload: { leadId, taskId: res?.id ?? null, responsibleUserId: responsavel ?? null, text },
    });
    return 'criada';
  } catch (err) {
    await recorder.step({
      kind: 'ERROR',
      title: `Falha ao abrir a tarefa da equipe (${motivo}): ${err instanceof Error ? err.message : String(err)}`,
      payload: { leadId, motivo },
    });
    return 'falhou';
  }
}
