/**
 * Horário oferecido que já passou, tirado de uma consulta velha à agenda, ou "manhã ou tarde?" no lugar de horário
 * (auditoria de Araguaína, 21/10/2026).
 *
 * Os casos:
 *  - Lead 28743600: em 17/10 17:53 a Sofia ofereceu "segunda-feira, 19/10: às 08h, 14h ou 16h". Em 19/10 às 08:29
 *    ofereceu de novo "segunda (19/10) às 08h, 14h ou 16h" — o das 08h já tinha passado, e ela não consultou a
 *    agenda: reaproveitou os horários de dois dias antes, que estavam no histórico.
 *  - Leads 28686476, 28743362, 28655414 ("de manhã ou à tarde costuma ser melhor pra você?") e 28681456 ("prefere vir
 *    pela manhã ou à tarde?"): o prompt manda consultar e oferecer DUAS opções, e ela perguntou o turno.
 *
 * O prompt já dizia "nunca repita horário de uma conversa anterior". Aqui a conferência é em código, sobre a resposta
 * pronta: que horários ela oferece, para que dia, se já passaram no fuso da unidade, e de quando é a consulta à agenda
 * de onde eles saíram (a ferramenta consultar_horarios agora carimba a hora da consulta no que devolve). O grafo
 * decide o que fazer com o veredito (graph.ts): reconsultar a agenda, cortar o horário vencido ou refazer a resposta.
 *
 * Tudo aqui é função pura sobre texto e mensagens — sem banco, sem Kommo — para dar para testar com conversa real.
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

/**
 * Por quanto tempo uma consulta à agenda vale para oferecer de novo os mesmos horários (no mesmo dia). De propósito
 * não é "só o turno": a conversa seguindo minutos depois (ele pergunta o preço, ela repete os horários) não precisa de
 * outra sondagem na franquia — e a marcação confere o horário de novo antes de agendar (horarioAindaLivre /
 * agendar_consulta). O que a trava pega é o caso de Araguaína: horário reaproveitado de outro dia, ou horas depois.
 */
export const VALIDADE_DA_CONSULTA_MIN = 180;

const pad = (n: number) => String(n).padStart(2, '0');

function somarDiasISO(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function diaDaSemanaISO(dia: string): number {
  return new Date(`${dia}T12:00:00Z`).getUTCDay();
}

/** O dia seguinte (AAAA-MM-DD) ao instante local "AAAA-MM-DDTHH:MM". */
export function diaSeguinte(agoraLocal: string): string {
  return somarDiasISO(agoraLocal.slice(0, 10), 1);
}

/** "19/10 08:29" a partir de "2026-10-19T08:29". */
export function rotuloLocal(iso: string): string {
  const [d, h] = iso.split('T');
  const [, m, dia] = d.split('-');
  return h ? `${dia}/${m} ${h.slice(0, 5)}` : `${dia}/${m}`;
}

// ── O carimbo da consulta à agenda ──────────────────────────────────────────────────────────────────────

/**
 * O que consultar_horarios põe no fim do que devolve. Serve aos dois lados: o modelo lê que a lista vale para agora,
 * e a trava (lá embaixo) sabe de quando ela é.
 */
export function carimboDaConsulta(agoraLocal: string): string {
  const [d, h] = agoraLocal.split('T');
  const [a, m, dia] = d.split('-');
  return (
    `(Agenda consultada em ${dia}/${m}/${a} às ${(h ?? '00:00').slice(0, 5)}, horário da clínica. Esta lista vale para ` +
    'agora: em outro dia, ou horas depois, chame consultar_horarios de novo antes de oferecer qualquer horário.)'
  );
}

const CARIMBO = /Agenda consultada em (\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2})/;

/** A hora (ISO local "2026-10-17T17:53") carimbada no resultado da consulta; null se não tem carimbo. */
export function quandoFoiConsultada(resultado: string): string | null {
  const m = CARIMBO.exec(resultado);
  return m ? `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}` : null;
}

export interface ConsultaDaAgenda {
  /** Feita depois da última fala do paciente (o turno em curso). */
  noTurno: boolean;
  /** Quando foi feita (carimbo), ou null para resultado antigo, sem carimbo. */
  em: string | null;
  /** Devolveu horários confirmados. */
  confirmados: boolean;
}

function textoDe(conteudo: unknown): string {
  if (typeof conteudo === 'string') return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

/** Os resultados de consultar_horarios na conversa (o histórico inteiro do grafo, não só a janela do modelo). */
export function consultasDaAgenda(mensagens: BaseMessage[]): ConsultaDaAgenda[] {
  let ultimoHumano = -1;
  mensagens.forEach((m, i) => {
    if (m.getType() === 'human') ultimoHumano = i;
  });
  const nomePorId = new Map<string, string>();
  const consultas: ConsultaDaAgenda[] = [];
  mensagens.forEach((m, i) => {
    const tipo = m.getType();
    if (tipo === 'ai') {
      for (const c of (m as AIMessage).tool_calls ?? []) if (c.id && c.name) nomePorId.set(c.id, c.name);
      return;
    }
    if (tipo !== 'tool') return;
    const tm = m as unknown as { name?: string; tool_call_id?: string };
    const nome = tm.name || (tm.tool_call_id ? nomePorId.get(tm.tool_call_id) : undefined);
    if (nome !== 'consultar_horarios') return;
    const texto = textoDe(m.content);
    consultas.push({ noTurno: i > ultimoHumano, em: quandoFoiConsultada(texto), confirmados: /Horários CONFIRMADOS/.test(texto) });
  });
  return consultas;
}

function minutosDoDia(iso: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/**
 * A consulta ainda vale: mesmo dia e há no máximo VALIDADE_DA_CONSULTA_MIN minutos. Os dois lados são relógio de
 * parede LOCAL da unidade (o carimbo e o "agora" saem do mesmo fuso, fusoDaUnidade) — compara dia com dia e minuto
 * com minuto, sem converter fuso nenhum.
 */
export function consultaAindaVale(em: string, agoraLocal: string): boolean {
  if (em.slice(0, 10) !== agoraLocal.slice(0, 10)) return false;
  const min = minutosDoDia(agoraLocal) - minutosDoDia(em);
  return Number.isFinite(min) && min >= 0 && min <= VALIDADE_DA_CONSULTA_MIN;
}

// ── As frases da resposta ───────────────────────────────────────────────────────────────────────────────

export interface Pedaco {
  frase: string;
  /** O que separava esta frase da anterior (espaço, quebra de linha) — para remontar o texto como era. */
  sep: string;
}

const SEPARADOR = /(\n+|(?<=[.!?…])[ \t]+|(?<=\p{Extended_Pictographic}\uFE0F?)[ \t]+(?=\p{Lu}))/u;

/** O texto em frases, guardando os separadores. Emoji solto depois da frase fica com ela. */
export function quebrarEmFrases(texto: string): Pedaco[] {
  const partes = texto.split(SEPARADOR);
  const out: Pedaco[] = [];
  for (let i = 0; i < partes.length; i += 2) {
    const frase = partes[i] ?? '';
    const sep = i > 0 ? (partes[i - 1] ?? '') : '';
    if (out.length > 0 && !/[\p{L}\p{N}]/u.test(frase)) {
      out[out.length - 1].frase += sep + frase;
      continue;
    }
    if (!frase && out.length === 0) continue;
    out.push({ frase, sep });
  }
  return out;
}

export function juntarFrases(pedacos: Pedaco[]): string {
  return pedacos
    .map((p, i) => (i === 0 ? '' : p.sep) + p.frase)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Que horários a resposta oferece ─────────────────────────────────────────────────────────────────────

export interface HorarioOferecido {
  /** Dia (AAAA-MM-DD) a que o horário se refere, ou null quando o texto não diz. */
  data: string | null;
  hora: string;
  /** Índice da frase (em quebrarEmFrases) onde ele está. */
  frase: number;
}

const DIAS: Array<[RegExp, number]> = [
  [/^dom/, 0],
  [/^seg/, 1],
  [/^ter/, 2],
  [/^qua/, 3],
  [/^qui/, 4],
  [/^sex/, 5],
  [/^s[áa]b/, 6],
];

const DIA_POR_EXTENSO = /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?(\s+que\s+vem)?/gi;
// fronteira por \p{L}: com \b, "Ter" casava dentro de "Terça" (o "ç" não é letra para o \b) e o dia contava duas vezes
const DIA_ABREVIADO = /(?<![\p{L}])(seg|ter|qua|qui|sex|s[áa]b|dom)(?![\p{L}])\.?/giu;
const DATA_DD_MM = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;
const HORA = /(?<![\d/:.$])(\d{1,2})(?:h(\d{2})?|:(\d{2}))(?!\d)/gi;
const HORA_DO_PERIODO = /\b[àa]s\s+(\d{1,2})\s+(?:horas?\s+)?d[ae]\s+(manh[ãa]|tarde|noite)\b/gi;
/** "das 8h às 18h", "entre 8h e 12h": é o expediente, não horário oferecido. */
const FAIXA = /\b(?:d[ae]s?|entre)\s+\d{1,2}(?:h\d{0,2}|:\d{2})\s+(?:[àa]s?|at[ée](?:\s+[àa]s)?|e)\s+\d{1,2}(?:h\d{0,2}|:\d{2})/gi;
/** Duração, não horário: "dura 1h", "cerca de 2h". */
const ANTES_DE_DURACAO = /(?:^|[\s,(])(?:dura|durar|leva|levar|cerca\s+de|aproximadamente|uns|umas|por|durante|h[áa]|faz|mais\s+de|menos\s+de|em\s+at[ée])\s*$/i;

const OFERTA =
  /\b(?:tenho|temos|tem\s+(?:vaga|hor[áa]rio)|dispon[íi]ve|vagas?\b|livres?\b|fica\s+melhor|prefere|qual\s+(?:desses|dessas|deles|delas|dos|das|hor[áa]rio|fica|voc[êe]\s+prefere|seria|[ée]\s+melhor)|posso\s+(?:te\s+)?(?:encaixar|reservar|marcar|agendar|deixar|garantir|separar|segurar)|consigo\s+(?:te\s+)?(?:encaixar|marcar|agendar)|garantir\s+(?:a\s+)?sua\s+vaga|encaix|que\s+tal|serve\b|pode\s+ser|daria\s+(?:pra|para)|consegue\s+vir|quer\s+(?:o|a|[àa]s|na|no)\b)/i;
/** Consulta que ele JÁ TEM (confirmação, lembrete): não é oferta. */
const CONSULTA_QUE_JA_TEM =
  /sua\s+consulta|seu\s+(?:hor[áa]rio|agendamento)|confirmar\s+(?:a\s+|sua\s+)?presen[çc]a|consulta\s+marcada|est[áa]\s+marcad|(?:agendad|marcad|confirmad)[ao]\s+(?:para|pra)|te\s+esper|agendamento\s+confirmado/i;

interface Marca {
  ini: number;
  /** null: dia da semana ambíguo ("segunda" dito numa segunda, sem data) — o horário fica sem dia conhecido. */
  data: string | null;
  /** DD/MM escrito. */
  explicita: boolean;
  /** Veio de um dia da semana ("segunda", "Ter"). */
  semana?: boolean;
}

function dataDoDDMM(dia: number, mes: number, anoTexto: string | undefined, hoje: string): string | null {
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;
  let ano = anoTexto ? (anoTexto.length === 2 ? 2000 + Number(anoTexto) : Number(anoTexto)) : Number(hoje.slice(0, 4));
  let data = `${ano}-${pad(mes)}-${pad(dia)}`;
  // "05/01" escrito em dezembro é janeiro do ano que vem
  if (!anoTexto && data < somarDiasISO(hoje, -60)) {
    ano += 1;
    data = `${ano}-${pad(mes)}-${pad(dia)}`;
  }
  return data;
}

/**
 * O dia de "segunda", "Ter": o mesmo dia da semana já citado com data antes no texto ("terça-feira, 28/10 … a terça às
 * 9h"); senão o próximo a partir de hoje. Dito no próprio dia, sem data e sem "que vem", é ambíguo (hoje ou a semana
 * que vem): fica null, e o horário não é julgado como passado.
 */
function dataDoDiaDaSemana(nome: string, queVem: boolean, hoje: string, vistas: string[]): string | null | undefined {
  const alvo = DIAS.find(([re]) => re.test(nome.toLowerCase()))?.[1];
  if (alvo === undefined) return undefined;
  const citada = vistas.find((v) => diaDaSemanaISO(v) === alvo && v >= hoje);
  if (citada) return citada;
  let d = (alvo - diaDaSemanaISO(hoje) + 7) % 7;
  if (d === 0) {
    if (!queVem) return null;
    d = 7;
  }
  return somarDiasISO(hoje, d);
}

function datasNaFrase(frase: string, hoje: string, ehBotao: boolean, vistas: string[]): Marca[] {
  const marcas: Marca[] = [];
  for (const m of frase.matchAll(DATA_DD_MM)) {
    const d = dataDoDDMM(Number(m[1]), Number(m[2]), m[3], hoje);
    if (d) marcas.push({ ini: m.index ?? 0, data: d, explicita: true });
  }
  const semDepois = frase.replace(/depois\s+de\s+amanh[ãa]/gi, (s) => ' '.repeat(s.length));
  for (const m of frase.matchAll(/depois\s+de\s+amanh[ãa]/gi)) marcas.push({ ini: m.index ?? 0, data: somarDiasISO(hoje, 2), explicita: false });
  // \b não serve depois de letra acentuada ("amanhã "): o fim da palavra é conferido com \p{L}
  for (const m of semDepois.matchAll(/(?<![\p{L}\p{N}])amanh[ãa](?![\p{L}\p{N}])/giu)) marcas.push({ ini: m.index ?? 0, data: somarDiasISO(hoje, 1), explicita: false });
  for (const m of frase.matchAll(/(?<![\p{L}\p{N}])hoje(?![\p{L}\p{N}])/giu)) marcas.push({ ini: m.index ?? 0, data: hoje, explicita: false });
  const semana: Marca[] = [];
  for (const m of frase.matchAll(DIA_POR_EXTENSO)) {
    const antes = frase.slice(Math.max(0, (m.index ?? 0) - 10), m.index ?? 0);
    const d = dataDoDiaDaSemana(m[1], !!m[2] || /pr[óo]xim[ao]\s*$/i.test(antes), hoje, vistas);
    if (d !== undefined) semana.push({ ini: m.index ?? 0, data: d, explicita: false, semana: true });
  }
  if (ehBotao) {
    for (const m of frase.matchAll(DIA_ABREVIADO)) {
      if (semana.some((s) => s.ini === (m.index ?? 0))) continue;
      const d = dataDoDiaDaSemana(m[1], false, hoje, vistas);
      if (d !== undefined) semana.push({ ini: m.index ?? 0, data: d, explicita: false, semana: true });
    }
  }
  // "segunda-feira, 19/10": a data escrita manda; o dia da semana colado nela não conta de novo
  for (const s of semana) {
    if (!marcas.some((e) => e.explicita && Math.abs(e.ini - s.ini) <= 22)) marcas.push(s);
  }
  return marcas.sort((a, b) => a.ini - b.ini);
}

function horasNaFrase(frase: string): Array<{ ini: number; hora: string }> {
  const limpa = frase.replace(FAIXA, (s) => ' '.repeat(s.length));
  const horas: Array<{ ini: number; hora: string }> = [];
  for (const m of limpa.matchAll(HORA)) {
    const hh = Number(m[1]);
    const mm = Number(m[2] ?? m[3] ?? 0);
    if (hh > 23 || mm > 59) continue;
    if (ANTES_DE_DURACAO.test(limpa.slice(Math.max(0, (m.index ?? 0) - 20), m.index ?? 0))) continue;
    horas.push({ ini: m.index ?? 0, hora: `${pad(hh)}:${pad(mm)}` });
  }
  for (const m of limpa.matchAll(HORA_DO_PERIODO)) {
    let hh = Number(m[1]);
    if (hh > 12) continue;
    if (/tarde|noite/i.test(m[2]) && hh < 12) hh += 12;
    horas.push({ ini: m.index ?? 0, hora: `${pad(hh)}:00` });
  }
  return horas.sort((a, b) => a.ini - b.ini);
}

function ehOferta(frase: string, horas: number): boolean {
  if (/^\s*\[\[\s*botoes\s*:/i.test(frase)) return true;
  // duas horas ou mais com "ou" no meio é escolha, sempre
  if (horas >= 2 && /\bou\b/i.test(frase)) return true;
  if (CONSULTA_QUE_JA_TEM.test(frase)) return false;
  return OFERTA.test(frase);
}

/**
 * Os horários que a resposta OFERECE ao paciente, cada um com o dia a que se refere (a data da própria frase, ou a
 * última citada antes dela). Confirmação de consulta que ele já tem, expediente ("das 8h às 18h") e duração não
 * contam.
 */
export function horariosOferecidos(texto: string, agoraLocal: string): HorarioOferecido[] {
  const hoje = agoraLocal.slice(0, 10);
  const pedacos = quebrarEmFrases(texto ?? '');
  const ofertas: HorarioOferecido[] = [];
  let dataCorrente: string | null = null;
  // as datas escritas no texto (DD/MM, hoje, amanhã), para dar o dia certo a "a terça" ou "Ter 9h" mais adiante
  const vistas: string[] = [];
  pedacos.forEach((p, i) => {
    const ehBotao = /^\s*\[\[\s*botoes\s*:/i.test(p.frase);
    const datas = datasNaFrase(p.frase, hoje, ehBotao, vistas);
    for (const d of datas) if (d.data && !d.semana && !vistas.includes(d.data)) vistas.push(d.data);
    const horas = horasNaFrase(p.frase);
    if (horas.length > 0 && ehOferta(p.frase, horas.length)) {
      for (const h of horas) {
        const antes = [...datas].reverse().find((d) => d.ini <= h.ini);
        const depois = datas.find((d) => d.ini > h.ini);
        const data = antes ? antes.data : depois && !ehBotao ? depois.data : dataCorrente;
        ofertas.push({ data, hora: h.hora, frase: i });
      }
    }
    if (datas.length > 0) dataCorrente = datas[datas.length - 1].data;
  });
  return ofertas;
}

/** Os oferecidos que já passaram no relógio da unidade (sem dia conhecido não dá para dizer: fica de fora). */
export function horariosQueJaPassaram(ofertas: HorarioOferecido[], agoraLocal: string): HorarioOferecido[] {
  const agora = agoraLocal.slice(0, 16);
  return ofertas.filter((o) => o.data !== null && `${o.data}T${o.hora}` < agora);
}

// ── "Manhã ou tarde?" ───────────────────────────────────────────────────────────────────────────────────

const PERGUNTA_DE_TURNO =
  /manh[ãa]\s+ou\s+(?:[àa]\s+|de\s+|pela\s+|na\s+parte\s+da\s+)?tarde|tarde\s+ou\s+(?:de\s+|pela\s+|na\s+parte\s+da\s+)?manh[ãa]|qual\s+(?:turno|per[íi]odo)|prefere\s+(?:vir\s+|ser\s+atendid[oa]\s+)?(?:de\s+|pela\s+|na\s+parte\s+da\s+)manh[ãa]|prefere\s+(?:vir\s+)?(?:[àa]\s+|de\s+|pela\s+)tarde|melhor\s+(?:de\s+|pela\s+)manh[ãa]/i;
/** "Prefere que a equipe te ligue de manhã ou à tarde?" é sobre a ligação, não sobre a consulta. */
const SOBRE_CONTATO = /\blig(?:ue|ar|a[çc][ãa]o|uem|o)\b|te\s+(?:chamar|procurar|retornar)|contato|falar\s+com/i;

/** A resposta pergunta o turno ("manhã ou tarde?") e não oferece nenhum horário concreto. */
export function perguntaTurnoSemHorario(texto: string, agoraLocal: string): boolean {
  if (horariosOferecidos(texto, agoraLocal).length > 0) return false;
  return quebrarEmFrases(texto ?? '').some((p) => p.frase.includes('?') && PERGUNTA_DE_TURNO.test(p.frase) && !SOBRE_CONTATO.test(p.frase));
}

// ── A trava ─────────────────────────────────────────────────────────────────────────────────────────────

/** Ferramentas que mostram que não havia horário para dar (agenda cheia → preferência e encaixe pela equipe). */
const SEM_HORARIO_PARA_DAR = /^(?:pausar_ia|resumir_lead_para_sdr|avisar_sinal_de_alerta)$|preferencia/i;

export type TravaDoHorario =
  /** O grafo chama consultar_horarios (a partir de `data`) e o modelo escreve de novo com a agenda de agora. */
  | { acao: 'reconsultar'; motivo: string; data: string }
  /** A agenda já foi consultada neste turno e mesmo assim saiu horário que passou: o horário sai da resposta. */
  | { acao: 'cortar_passado'; motivo: string }
  /** A agenda devolveu horários neste turno e a resposta perguntou o turno: refaz UMA vez oferecendo dois. */
  | { acao: 'refazer_turno'; motivo: string }
  | null;

export interface EntradaDaTrava {
  texto: string;
  /** "AAAA-MM-DDTHH:MM" no fuso da unidade. */
  agoraLocal: string;
  consultas: ConsultaDaAgenda[];
  /** Ferramentas chamadas neste turno. */
  ferramentas: string[];
  /** O grafo já reconsultou a agenda neste turno. */
  jaReconsultou: boolean;
}

/**
 * Decide, sobre a resposta pronta (sem ferramenta pendente), se ela pode sair. Só para unidade com a agenda ligada
 * (consultar_horarios entre as ferramentas) — quem chama confere.
 */
export function travaDoHorario(e: EntradaDaTrava): TravaDoHorario {
  const hoje = e.agoraLocal.slice(0, 10);
  const amanha = somarDiasISO(hoje, 1);
  const consultouNoTurno = e.consultas.some((c) => c.noTurno);
  const podeReconsultar = !e.jaReconsultou && !consultouNoTurno;
  const ofertas = horariosOferecidos(e.texto, e.agoraLocal);

  if (ofertas.length > 0) {
    const passados = horariosQueJaPassaram(ofertas, e.agoraLocal);
    if (passados.length > 0) {
      const quais = [...new Set(passados.map((p) => rotuloLocal(`${p.data}T${p.hora}`)))].join(', ');
      const motivo = `ofereceu horário que já passou (${quais}; agora ${rotuloLocal(e.agoraLocal)})`;
      // o dia que ela estava oferecendo, a partir de hoje: a ferramenta já tira as horas que passaram
      return podeReconsultar ? { acao: 'reconsultar', motivo, data: hoje } : { acao: 'cortar_passado', motivo };
    }
    if (consultouNoTurno || !podeReconsultar) return null;
    const datas = ofertas.map((o) => o.data).filter((d): d is string => !!d).sort();
    const data = datas.length > 0 && datas[0] > hoje ? datas[0] : datas.length > 0 ? hoje : amanha;
    const ultima = e.consultas[e.consultas.length - 1];
    if (!ultima) return { acao: 'reconsultar', motivo: 'ofereceu horário sem ter consultado a agenda', data };
    // resultado antigo, sem carimbo (de antes desta trava): não dá para saber a idade — deixa passar
    if (ultima.em && !consultaAindaVale(ultima.em, e.agoraLocal)) {
      return { acao: 'reconsultar', motivo: `ofereceu horários de uma consulta à agenda de ${rotuloLocal(ultima.em)}`, data };
    }
    return null;
  }

  if (perguntaTurnoSemHorario(e.texto, e.agoraLocal) && !e.ferramentas.some((f) => SEM_HORARIO_PARA_DAR.test(f))) {
    const motivo = 'perguntou "manhã ou tarde?" em vez de oferecer dois horários';
    if (podeReconsultar) return { acao: 'reconsultar', motivo, data: amanha };
    const doTurno = e.consultas.filter((c) => c.noTurno);
    if (doTurno.length > 0 && doTurno[doTurno.length - 1].confirmados) return { acao: 'refazer_turno', motivo };
  }
  return null;
}

/** A chamada a consultar_horarios que o grafo põe no lugar da resposta reprovada. */
export function reconsultaDaAgenda(data: string): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id: `trava_agenda_${Date.now()}`, name: 'consultar_horarios', args: { data }, type: 'tool_call' }],
  });
}

/** Quando nem a agenda de agora nem o corte deixam a resposta de pé: pergunta o dia e consulta na volta. */
export const PERGUNTA_DO_DIA = 'Me conta qual dia fica melhor pra você que eu confiro os horários livres na agenda ☺';

/** A resposta sem as frases que oferecem horário que já passou (e sem a linha de botões, se ela tinha um). */
export function semHorarioPassado(texto: string, agoraLocal: string): string {
  const passados = horariosQueJaPassaram(horariosOferecidos(texto, agoraLocal), agoraLocal);
  if (passados.length === 0) return texto;
  const fora = new Set(passados.map((p) => p.frase));
  // os botões repetem os horários da frase que saiu: saem juntos
  const resto = juntarFrases(quebrarEmFrases(texto).filter((p, i) => !fora.has(i) && !/^\s*\[\[\s*botoes\s*:/i.test(p.frase)));
  if (!/[\p{L}\p{N}]/u.test(resto)) return PERGUNTA_DO_DIA;
  return resto.includes('?') ? resto : `${resto}\n\n${PERGUNTA_DO_DIA}`;
}

export function instrucaoParaReconsultar(motivo: string): string {
  return (
    `[instrução interna, não é fala do paciente] Sua resposta acima ${motivo}. A agenda muda: chame consultar_horarios ` +
    'agora e ofereça DOIS horários concretos (dia da semana + DD/MM + hora) da lista que ela devolver. Não repita ' +
    'horário de mensagem anterior e não pergunte "manhã ou tarde?". Responda só com a mensagem final.'
  );
}

export const INSTRUCAO_REFAZER_TURNO =
  '[instrução interna, não é fala do paciente] Você perguntou "manhã ou tarde?", mas a agenda já devolveu horários ' +
  'neste turno. Reescreva a MESMA resposta oferecendo DOIS horários concretos dessa lista (dia da semana + DD/MM + ' +
  'hora), sem perguntar o turno. Responda só com a mensagem final.';
