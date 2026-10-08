/**
 * Consulta que JÁ PASSOU não pode chegar ao modelo parecendo futura.
 *
 * O caso (Açailândia, 08/10/2026 11:16, cartão de teste 28088906 em PERDIDO): o paciente mandou
 * "oi, teste" e a Sofia de resgate respondeu "Tudo certo com sua consulta de quarta, 07/10 às 13h
 * com a fisioterapeuta Aylana — posso te ajudar em mais alguma coisa antes do seu dia?". A consulta
 * tinha sido ONTEM. O prompt gravado em `llm_calls` mostrou de onde veio, e nenhum bloco dizia que a
 * data tinha passado:
 *  1. `<conversa_com_outra_sofia>` trazia, sem data nenhuma, a confirmação e o lembrete de véspera
 *     que a Sofia comercial mandou em 06/10 ("sua consulta de amanhã, quarta, 07/10 às 13:00 com
 *     fisioterapeuta Aylana Silva Mendes");
 *  2. `<memoria_paciente>` dizia "tem consulta marcada para quarta-feira, 07/10/2026, às 13h" e
 *     guardava os fatos `data_consulta` / `horario_consulta` — o resumidor tem ordem de não escrever
 *     isso e escreve assim mesmo;
 *  3. `<etapa_do_lead>` dizia "ele já tem consulta marcada", porque o ◷ Data da Consulta do cartão
 *     ainda estava dentro da folga de 24 h que liga esse sinal.
 * A Sofia de resgate não tem agenda nem o vínculo da consulta (`spine_lead_links` é da unidade
 * comercial), então `<consulta_do_paciente>` — o único bloco que já sabia dizer "JÁ PASSOU" — nem
 * existia no prompt dela.
 *
 * Aqui ficam as peças puras: o relógio local, achar datas de consulta num texto, dizer quais já
 * passaram e o aviso que vai ao modelo.
 */
import { dataPorExtenso } from '../lib/feriados.js';

/** Tempo depois da hora marcada em que a consulta ainda é tratada como "de hoje". */
const FOLGA_CONSULTA_MS = 4 * 60 * 60_000;

/**
 * A consulta é anterior ao agora? Compara texto com texto: os dois lados são ISO LOCAL
 * ("2026-09-18T16:00") no fuso da unidade, então a ordem alfabética é a ordem do tempo —
 * sem conversão de fuso, que é onde esse tipo de comparação costuma errar.
 */
export function consultaNoPassado(quando: string | null | undefined, agoraLocalISO: string): boolean {
  if (!quando || !agoraLocalISO) return false;
  // Folga de 4 h depois da hora marcada: quem escreve "estou chegando, peguei trânsito" às 15h08 de
  // uma consulta das 15h não pode ouvir que o horário dele não existe mais.
  // O "Z" é de propósito: força a soma a acontecer no relógio de parede, sem o fuso da máquina
  // entrar na conta. Os dois lados continuam sendo hora local da unidade.
  const t = Date.parse(`${quando.slice(0, 16)}:00Z`);
  const fim = Number.isNaN(t) ? quando.slice(0, 16) : new Date(t + FOLGA_CONSULTA_MS).toISOString().slice(0, 16);
  return fim < agoraLocalISO.slice(0, 16);
}

/** "2026-09-22T10:25" no fuso pedido. */
export function agoraLocalISO(tz: string, agora: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(agora);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return `${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}`;
}

/** Hora usada quando o texto cita o dia sem a hora: o dia inteiro conta como "ainda não passou". */
const SEM_HORA = '23:59';

const pad = (n: number) => String(n).padStart(2, '0');

/** Só olha datas de mensagens que falam de consulta — "a dor começou 01/09" não é consulta. */
const FALA_DE_CONSULTA = /consult|agend|avalia|hor[áa]rio|atendimento|retorno|sess[ãa]o|marcad|remarc|confirm/i;

/** "07/10", "07/10/2026", "7/10/26" — sem pegar pedaço de telefone, CPF ou data maior. */
const DATA_DD_MM = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;

/**
 * A hora logo depois da data: "às 13h", "13:00", "às 9h30" — e na linha de baixo, como na
 * confirmação ("⭐ Data: quarta-feira, 07/10/2026" / "⏰ Horário: 13:00"). Exige ":" ou "h" para não
 * pegar outro número, e no máximo 25 caracteres sem dígito no caminho.
 */
const HORA_LOGO_DEPOIS = /^[^\d]{0,25}?(\d{1,2})(?::(\d{2})|h(\d{2})?)(?!\d)/i;

function diasAntes(dataISO: string, dias: number): string {
  return new Date(Date.parse(`${dataISO}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
}

/**
 * As datas de consulta citadas num texto, como ISO local ("2026-10-07T13:00"; sem hora no texto,
 * "T23:59"). `escritoEm` (YYYY-MM-DD, dia em que o texto foi escrito) dá o ano quando o texto não diz
 * — e vira o ano seguinte quando a data cairia muito antes do texto ("05/01" escrito em dezembro).
 */
export function datasDeConsultaCitadas(texto: string | null | undefined, escritoEm: string): string[] {
  if (!texto || !FALA_DE_CONSULTA.test(texto) || !/^\d{4}-\d{2}-\d{2}/.test(escritoEm)) return [];
  const achadas = new Set<string>();
  for (const m of texto.matchAll(DATA_DD_MM)) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
    const anoEscrito = Number(escritoEm.slice(0, 4));
    let ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : anoEscrito;
    let data = `${ano}-${pad(mes)}-${pad(dia)}`;
    if (!m[3] && data < diasAntes(escritoEm, 60)) {
      ano += 1;
      data = `${ano}-${pad(mes)}-${pad(dia)}`;
    }
    const depois = texto.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 30);
    const h = HORA_LOGO_DEPOIS.exec(depois);
    let hora = SEM_HORA;
    if (h) {
      const hh = Number(h[1]);
      const mm = Number(h[2] ?? h[3] ?? 0);
      if (hh <= 23 && mm <= 59) hora = `${pad(hh)}:${pad(mm)}`;
    }
    achadas.add(`${data}T${hora}`);
  }
  return [...achadas].sort();
}

/** Já passou (com a folga de 4 h) e faz no máximo `janelaDias` dias. */
export function consultaPassouHaPouco(quando: string | null | undefined, agoraLocal: string, janelaDias = 30): boolean {
  if (!quando || !agoraLocal) return false;
  return quando.slice(0, 10) >= diasAntes(agoraLocal.slice(0, 10), janelaDias) && consultaNoPassado(quando, agoraLocal);
}

/**
 * Das datas de consulta citadas nos textos, as que JÁ PASSARAM (com a mesma folga de 4 h da agenda) e
 * são recentes (`janelaDias`). Mais velha que isso não confunde ninguém e só gastaria prompt.
 * Mesmo dia citado com e sem hora fica só a versão com hora.
 */
export function consultasQueJaPassaram(
  textos: ReadonlyArray<{ texto: string | null | undefined; escritoEm: string }>,
  agoraLocal: string,
  janelaDias = 30,
): string[] {
  if (!agoraLocal) return [];
  const passadas = new Set<string>();
  for (const t of textos) {
    for (const d of datasDeConsultaCitadas(t.texto, t.escritoEm)) {
      if (consultaPassouHaPouco(d, agoraLocal, janelaDias)) passadas.add(d);
    }
  }
  const lista = [...passadas].sort();
  return lista.filter((d) => !(d.endsWith(`T${SEM_HORA}`) && lista.some((o) => o !== d && o.startsWith(d.slice(0, 10)))));
}

/** "quarta-feira, 07/10/2026 às 13:00" (sem a hora quando o texto não tinha). */
export function rotuloDaConsulta(iso: string): string {
  const [dia, hora] = iso.split('T');
  const data = dataPorExtenso(dia);
  return hora && hora.slice(0, 5) !== SEM_HORA ? `${data} às ${hora.slice(0, 5)}` : data;
}

/**
 * O aviso ao modelo. Não manda oferecer horário: quem passou da data pode ter vindo (a recepção
 * nem sempre marca "atendido" na hora) — o certo é perguntar como foi ou se precisa remarcar.
 */
export function avisoDeConsultaQuePassou(datas: ReadonlyArray<string>, agoraLocal: string): string[] {
  if (datas.length === 0) return [];
  const quais = datas.map(rotuloDaConsulta).join('; ');
  return [
    `CONSULTA QUE JÁ PASSOU: ${quais} — hoje é ${dataPorExtenso(agoraLocal.slice(0, 10))}.`,
    '- Essa consulta NÃO é futura: não a confirme, não fale "te espero", "antes do seu dia" nem cite dia/hora dela como se ainda fosse acontecer.',
    '- Não diga com quem era o atendimento (nome de profissional).',
    '- Se fizer sentido, pergunte com naturalidade como foi a consulta ou se ele precisa remarcar.',
  ];
}
