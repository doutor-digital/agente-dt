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

/** Puro: o bloco do prompt. null quando não há o que mostrar. */
export function renderConversaComOutraSofia(falas: ReadonlyArray<FalaDeOutraSofia>): string | null {
  if (falas.length === 0) return null;
  const linhas = falas.map((f) => `${f.papel === 'paciente' ? 'Paciente' : 'Sofia'}: ${f.texto.replace(/\s+/g, ' ').trim().slice(0, 600)}`);
  return [
    '<conversa_com_outra_sofia>',
    'Este paciente acabou de conversar com outra Sofia da mesma clínica (outra etapa do atendimento). Para ele, é a MESMA conversa:',
    '- NÃO se apresente de novo e NÃO pergunte o que ele já respondeu abaixo (nome, onde dói, há quanto tempo, se é de onde…).',
    '- Continue de onde parou. Se ele já disse que quer marcar, vá direto para os horários.',
    '- Se a outra Sofia disse que "reservou" ou citou um horário, isso NÃO foi marcado: consulte a agenda de verdade antes de confirmar qualquer coisa, e se o horário citado não existir, explique com naturalidade e ofereça os reais.',
    '',
    ...linhas,
    '</conversa_com_outra_sofia>',
  ].join('\n');
}

/**
 * As falas do mesmo cartão com as OUTRAS Sofias da mesma conta Kommo (últimas 72 h, até 16). Só entra o
 * que é mais novo que a última fala desta Sofia — o que ela já viu na própria conversa não se repete.
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
  const desde = new Date(agora.getTime() - JANELA_MS);
  const minhaUltima = await prisma.message.findFirst({
    where: { conversation: { unitId: unit.id, leadId: String(leadId) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const corte = minhaUltima && minhaUltima.createdAt > desde ? minhaUltima.createdAt : desde;
  const msgs = await prisma.message.findMany({
    where: {
      conversation: { unitId: { in: irmas.map((u) => u.id) }, leadId: String(leadId) },
      createdAt: { gt: corte },
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
