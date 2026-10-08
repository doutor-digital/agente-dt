/**
 * Duas regras nascidas do teste gravado na Açailândia em 05/10/2026 (lead 10824318).
 *
 * 1. SOFIA SEM AGENDA NÃO PROMETE HORÁRIO. A Sofia de resgate não tem agenda (`spineEnabled = false`,
 *    de propósito: ela reativa e passa o bastão). Mas as ações de preço copiadas da comercial mandavam
 *    "chame consultar_horarios e ofereça dois horários concretos" — sem a ferramenta, o modelo inventou
 *    "quarta 9h ou quinta 8h30" e disse "fica reservado pro seu nome". Nada foi marcado na franquia
 *    (dois pacientes reais na mesma semana: Sergio e Giovanni). A regra abaixo vai no prompt de toda
 *    Sofia sem agenda, acima de qualquer ação da unidade.
 *
 * 2. A CONVERSA ANDA JUNTO COM O PACIENTE. Cada Sofia (comercial, resgate…) guarda a conversa dela;
 *    quando o cartão muda de etapa e outra Sofia assume, ela começava do zero — "como posso te chamar?"
 *    para quem acabou de dar o nome. Agora a Sofia que assume lê o que a outra conversou com o mesmo
 *    cartão nos últimos 3 dias.
 */
import { prisma } from '../lib/prisma.js';
import { dataLocalISO } from '../lib/feriados.js';
import { semNomeDeProfissional } from '../lib/nome-do-profissional.js';
import { agoraLocalISO, avisoDeConsultaQuePassou, consultasQueJaPassaram } from './consulta-que-passou.js';

/** Fixa por unidade (entra na parte do prompt que fica em cache). Vazia para quem tem agenda. */
export function renderSemAgenda(unit: { spineEnabled: boolean }): string {
  if (unit.spineEnabled) return '';
  return [
    '### Você NÃO tem acesso à agenda da clínica',
    '- NUNCA ofereça dia nem horário, nem como sugestão ("quarta às 9h", "amanhã de manhã").',
    '- NUNCA diga que reservou, marcou, agendou ou garantiu a vaga. Você não consegue fazer isso.',
    '- Se uma instrução desta unidade mandar consultar horários ou oferecer horários, IGNORE essa parte: esta regra vale mais.',
    '- Quando o paciente quiser marcar, diga que vai passar para quem cuida da agenda e que já já confirmam o melhor horário com ele. Pode perguntar se ele prefere manhã ou tarde — isso ajuda quem vai marcar.',
  ].join('\n');
}

const JANELA_MS = 72 * 3600_000;
const MAX_MENSAGENS = 16;

export interface FalaDeOutraSofia {
  papel: 'paciente' | 'sofia';
  texto: string;
  em: Date;
}

/** O relógio da unidade, para datar as falas e saber o que já passou. */
export interface RelogioDaUnidade {
  /** "2026-10-08T11:16" no fuso da unidade. */
  agoraLocal: string;
  tz: string;
}

/** "(06/10 13:17)" — sem isso, "sua consulta de amanhã" da outra Sofia vira amanhã de hoje. */
function quandoFoi(em: Date, tz: string): string {
  const [dia, hora] = agoraLocalISO(tz, em).split('T');
  const [, m, d] = dia.split('-');
  return `(${d}/${m} ${hora})`;
}

/**
 * Puro: o bloco do prompt. null quando não há o que mostrar. `temAgenda` = a Sofia que assume tem agenda:
 * só ela recebe "vá para os horários"; a sem agenda não pode receber ordem de oferecer horário.
 *
 * Com `relogio` (08/10/2026, cartão 28088906): cada fala sai com dia e hora em que foi dita, e consulta
 * citada que já passou ganha um aviso no topo. O nome do profissional sai sempre — é de uma consulta
 * que esta Sofia não marcou e que pode nem existir mais.
 */
export function renderConversaComOutraSofia(
  falas: ReadonlyArray<FalaDeOutraSofia>,
  temAgenda: boolean,
  relogio?: RelogioDaUnidade,
): string | null {
  if (falas.length === 0) return null;
  const linhas = falas.map((f) => {
    const texto = semNomeDeProfissional(f.texto).texto.replace(/\s+/g, ' ').trim().slice(0, 600);
    const quando = relogio ? `${quandoFoi(f.em, relogio.tz)} ` : '';
    return `${quando}${f.papel === 'paciente' ? 'Paciente' : 'Sofia'}: ${texto}`;
  });
  const passadas = relogio
    ? consultasQueJaPassaram(
        falas.map((f) => ({ texto: f.texto, escritoEm: dataLocalISO(f.em, relogio.tz) })),
        relogio.agoraLocal,
      )
    : [];
  return [
    '<conversa_com_outra_sofia>',
    'Este paciente acabou de conversar com outra Sofia da mesma clínica (outra etapa do atendimento). Para ele, é a MESMA conversa:',
    '- NÃO se apresente de novo e NÃO pergunte o que ele já respondeu abaixo (nome, onde dói, há quanto tempo, se é de onde…).',
    ...(temAgenda
      ? [
          '- Continue de onde parou. Se ele já disse que quer marcar, vá direto para os horários.',
          '- Se a outra Sofia disse que "reservou" ou citou um horário, isso NÃO foi marcado: consulte a agenda de verdade antes de confirmar qualquer coisa, e se o horário citado não existir, explique com naturalidade e ofereça os reais.',
        ]
      : [
          '- Continue de onde parou, sem oferecer horário (você não tem agenda): se ele quer marcar, diga que vai passar para quem cuida da agenda.',
        ]),
    ...(relogio ? ['- Cada fala tem o dia e a hora em que foi dita: "amanhã" e "hoje" ali são relativos àquele dia, não a hoje.'] : []),
    ...(passadas.length > 0 ? ['', ...avisoDeConsultaQuePassou(passadas, relogio!.agoraLocal)] : []),
    '',
    ...linhas,
    '</conversa_com_outra_sofia>',
  ].join('\n');
}

/**
 * As falas do mesmo cartão com as OUTRAS Sofias da mesma conta Kommo (últimas 72 h, até 16), em TODO turno.
 * Sem corte pela própria conversa de propósito: essas falas nunca estão no histórico desta Sofia, então
 * não duplicam; e cortar pela última resposta dela fazia a conversa sumir do prompt a partir do 2º turno
 * (e cortar pela última mensagem pegava a do paciente que acabou de chegar — o bloco nunca aparecia).
 */
export async function conversaComOutraSofia(
  unit: { id: string; kommoSubdomain: string | null },
  leadId: number,
  agora: Date = new Date(),
): Promise<FalaDeOutraSofia[]> {
  if (!unit.kommoSubdomain || !Number.isFinite(leadId) || leadId <= 0) return [];
  const irmas = await prisma.unit.findMany({
    where: { kommoSubdomain: unit.kommoSubdomain, id: { not: unit.id } },
    select: { id: true },
  });
  if (irmas.length === 0) return [];
  const msgs = await prisma.message.findMany({
    where: {
      conversation: { unitId: { in: irmas.map((u) => u.id) }, leadId: String(leadId) },
      createdAt: { gt: new Date(agora.getTime() - JANELA_MS) },
      role: { in: ['user', 'assistant'] },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_MENSAGENS,
    select: { role: true, content: true, createdAt: true },
  });
  return msgs
    .reverse()
    .filter((m) => (m.content ?? '').trim())
    .map((m) => ({ papel: m.role === 'user' ? 'paciente' : 'sofia', texto: m.content ?? '', em: m.createdAt }));
}
