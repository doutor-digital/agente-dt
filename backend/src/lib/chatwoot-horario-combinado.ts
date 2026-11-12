/**
 * «A equipe já combinou o horário na conversa» — a Sofia não pode afirmar outro (pedido do João, medido no seco em produção, 12/11/2026).
 *
 * Caso real (conversa 19): a equipe escreveu «às 08:00», o paciente respondeu 👍, e a agenda da franquia dizia 14/11 09:30. A Sofia
 * "confirmaria" um horário que não é o da agenda nem o que a equipe falou. Regra: se o que a EQUIPE disse na conversa (hora e/ou dia) não
 * bate com a consulta que existe de verdade na franquia, ou se não dá para conferir a franquia, a Sofia NÃO afirma horário nenhum: passa
 * para a equipe (etiqueta + nota) e fica calada.
 *
 * Só conta a fala de GENTE da equipe: mensagem pública de saída, de um agente (`sender.type = user`) que não seja o usuário da integração
 * (o mesmo que manda as mensagens da Sofia e da régua). Os horários que a própria Sofia ofereceu («tenho 09:00 e 10:00») não são combinado
 * da equipe. O usuário da integração se reconhece pelas nossas notas privadas (prefixos abaixo) e pelas mensagens que acabamos de mandar.
 *
 * Aqui só a lógica pura; a consulta à franquia (`consultasReaisDoPaciente`) recebe as portas por parâmetro.
 */

/** O que a equipe disse sobre quando: horas «HH:MM» e dias «MM-DD» da ÚLTIMA fala dela que fala de horário. */
export interface Combinado {
  horas: string[];
  dias: string[];
  /** o trecho da fala, para a nota da equipe */
  trecho: string;
}

/** Uma consulta de pé na franquia (dia «AAAA-MM-DD», hora «HH:MM», no relógio da clínica). */
export interface ConsultaReal {
  dia: string;
  hora: string;
}

/** Começo das notas PRIVADAS que a integração (Sofia, régua, transcrição, baixa do sinal) deixa: é por elas que se acha o usuário dela. */
export const PREFIXOS_DAS_NOTAS_NOSSAS = ['🧪', '🤖', '🎙️', '⏸ Sofia', '🙋 Sofia', '⚠ A Sofia', '💸', '⏳'] as const;

/** Os ids de usuário da integração que aparecem nas mensagens (notas privadas com nossos prefixos). */
export function idsDaIntegracao(mensagens: any[]): Set<number> {
  const ids = new Set<number>();
  for (const m of mensagens) {
    const t = typeof m?.content === 'string' ? m.content : '';
    const id = Number(m?.sender?.id);
    if (m?.private === true && Number.isInteger(id) && id > 0 && PREFIXOS_DAS_NOTAS_NOSSAS.some((p) => t.startsWith(p))) ids.add(id);
  }
  return ids;
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** A fala fala de agendamento? (hora solta numa frase qualquer, como «abrimos às 7h», não é combinado) */
const GATILHO = /(?:hor[áa]rio|marcad|agend|consulta|sua\s+vez|te\s+espero|(?<![\p{L}\d])[àa]s\s)/iu;
const HORA_DOIS_PONTOS = /(?<![\d/])([01]?\d|2[0-3])\s*:\s*([0-5]\d)(?!\d)/g;
const HORA_COM_H = /(?<![\d/])([01]?\d|2[0-3])\s*h\s*([0-5]\d)?(?!\w)/gi;
const HORA_AS_SOLTA = /(?<![\p{L}\d])[àa]s\s+([01]?\d|2[0-3])(?![\d:/]|\s*h)/giu;
const DATA = /(?<!\d)(0?[1-9]|[12]\d|3[01])\/(0?[1-9]|1[0-2])(?:\/\d{2,4})?(?!\d)/g;

/** Horas e dias que uma fala menciona, normalizados. */
export function horariosDaFala(texto: string): { horas: string[]; dias: string[] } {
  const horas = new Set<string>();
  for (const m of texto.matchAll(HORA_DOIS_PONTOS)) horas.add(`${p2(Number(m[1]))}:${m[2]}`);
  for (const m of texto.matchAll(HORA_COM_H)) horas.add(`${p2(Number(m[1]))}:${m[2] ?? '00'}`);
  for (const m of texto.matchAll(HORA_AS_SOLTA)) horas.add(`${p2(Number(m[1]))}:00`);
  const dias = new Set<string>();
  for (const m of texto.matchAll(DATA)) dias.add(`${p2(Number(m[2]))}-${p2(Number(m[1]))}`);
  return { horas: [...horas].sort(), dias: [...dias].sort() };
}

/**
 * O que a equipe combinou, pela ÚLTIMA fala de gente da equipe que fala de horário. null = a equipe não falou de horário
 * (ou só a Sofia/régua falaram).
 */
export function combinadoPelaEquipe(mensagens: any[], integracao: ReadonlySet<number> = idsDaIntegracao(mensagens)): Combinado | null {
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i];
    if (Number(m?.message_type) !== 1 || m?.private === true) continue;
    if (String(m?.sender?.type ?? '') !== 'user') continue;
    if (integracao.has(Number(m?.sender?.id))) continue;
    const t = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!t || !GATILHO.test(t)) continue;
    const { horas, dias } = horariosDaFala(t);
    if (horas.length || dias.length) return { horas, dias, trecho: t.length > 160 ? `${t.slice(0, 159)}…` : t };
  }
  return null;
}

const dm = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

/**
 * O que a equipe disse bate com a agenda? Devolve o motivo da divergência (texto para a nota da equipe) ou null se está tudo certo.
 * `reais` null = não deu para conferir a franquia (também é motivo: sem prova, a Sofia não afirma). Bate se alguma consulta real tem a
 * hora E (quando a equipe falou de dia) o dia que a equipe disse.
 */
export function divergenciaDoCombinado(c: Combinado, reais: readonly ConsultaReal[] | null): string | null {
  const disse = [c.horas.length ? c.horas.join(' ou ') : null, c.dias.length ? c.dias.map((d) => `${d.slice(3)}/${d.slice(0, 2)}`).join(' ou ') : null].filter(Boolean).join(', ');
  if (reais === null) return `a equipe combinou «${disse}» na conversa e não consegui conferir a agenda da franquia`;
  if (reais.length === 0) return `a equipe combinou «${disse}» na conversa, mas não há consulta de pé na franquia para este paciente`;
  const bate = reais.some((r) => (!c.horas.length || c.horas.includes(r.hora)) && (!c.dias.length || c.dias.includes(r.dia.slice(5))));
  if (bate) return null;
  return `a equipe combinou «${disse}» na conversa, mas a agenda da franquia diz ${reais.map((r) => `${dm(r.dia)} ${r.hora}`).join(' e ')}`;
}

// ── a consulta de verdade ──────────────────────────────────────────────────────────────────────────

export interface PortasDaFranquia {
  buscarPorNome(nome: string): Promise<Array<{ idClient: number | null; name?: string | null; whatsapp?: string | null }> | null>;
  agendamentos(idClient: number): Promise<Array<{ idStatus: number | null; dateAttendanceUtc: string | null }> | null>;
}

const fim8 = (f: string | null | undefined): string | null => {
  const d = (f ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
};

/** Uma data em UTC → dia e hora no relógio da clínica. */
export function diaEHoraNoFuso(utc: string, fuso: string): ConsultaReal | null {
  const t = Date.parse(utc);
  if (!Number.isFinite(t)) return null;
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  const g = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return { dia: `${g('year')}-${g('month')}-${g('day')}`, hora: `${g('hour')}:${g('minute')}` };
}

const DESMARCADO = 57;

/**
 * As consultas de pé deste paciente na franquia: acha o cadastro pelo nome do contato E pelo telefone (8 últimos dígitos; nome repetido
 * com outro telefone não vale) e lê os agendamentos futuros. `null` = não deu para conferir (erro da franquia). Nenhum cadastro com este
 * telefone = `[]` (a franquia não tem consulta dele).
 */
export async function consultasReaisDoPaciente(
  p: PortasDaFranquia,
  a: { nome: string; telefone: string; fuso: string; agora: Date },
): Promise<ConsultaReal[] | null> {
  const nome = a.nome.trim();
  if (nome.split(/\s+/).filter((x) => x.length >= 2).length < 1) return [];
  const achados = await p.buscarPorNome(nome);
  if (achados === null) return null;
  const alvo = fim8(a.telefone);
  const meus = achados.filter((c) => c.idClient && alvo && fim8(c.whatsapp) === alvo).slice(0, 3);
  const reais: ConsultaReal[] = [];
  for (const c of meus) {
    const ag = await p.agendamentos(c.idClient as number);
    if (ag === null) return null;
    for (const s of ag) {
      if (!s.dateAttendanceUtc || s.idStatus === DESMARCADO || Date.parse(s.dateAttendanceUtc) <= a.agora.getTime()) continue;
      const r = diaEHoraNoFuso(s.dateAttendanceUtc, a.fuso);
      if (r) reais.push(r);
    }
  }
  return reais.sort((x, y) => `${x.dia}${x.hora}`.localeCompare(`${y.dia}${y.hora}`));
}

/** O que o Chatwoot já sabe da consulta (preenchido pela Sofia ou pela varredura da agenda), como consulta de pé. */
export function consultaDosAtributos(attrs: Record<string, unknown>, hoje: string): ConsultaReal | null {
  const dia = String(attrs.data_consulta ?? '').slice(0, 10);
  const hora = String(attrs.hora_consulta ?? '').match(/^(\d{1,2})[:h](\d{2})?/);
  const situacao = String(attrs.situacao_consulta ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || dia < hoje || !hora) return null;
  if (situacao && !['Agendado', 'Confirmado', 'Remarcado'].includes(situacao)) return null;
  return { dia, hora: `${p2(Number(hora[1]))}:${hora[2] ?? '00'}` };
}
