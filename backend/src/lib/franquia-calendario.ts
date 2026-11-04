/**
 * Agenda da franquia no Calendário do Kommo (/todo/calendar) — parte PURA.
 *
 * Cada agendamento da franquia (qualquer categoria: avaliação, sessão, tratamento) vira UMA tarefa no
 * horário da consulta. Aqui mora só a decisão: dado [agendamentos da franquia] e [tarefas abertas do
 * Kommo], quais tarefas criar, atualizar e fechar. O worker (`franquia-calendario-worker.ts`) busca,
 * casa paciente → cartão e aplica.
 *
 * A identidade da tarefa é o marcador no texto, `[ag:<idSchedule>]`. A fonte da verdade é o Kommo: a
 * cada varredura as tarefas abertas são relidas e reconciliadas pelo marcador, então um reinício do
 * worker (ou um timeout no meio do POST) não cria tarefa em dobro.
 *
 * Decisões que NÃO são óbvias:
 *  - nada é apagado. Fechar = concluir com resultado ("Atendido", "Faltou"…);
 *  - tarefa aberta sem agendamento correspondente na janela só é LOGADA (`sumiu`): a busca pode ter vindo
 *    incompleta, e apagar a agenda de alguém por causa disso seria pior que deixar uma tarefa velha;
 *  - tudo depois do marcador no texto é preservado nas atualizações (é onde fica o contato da tarefa solta
 *    e qualquer nota que a recepção escreva) — senão a varredura brigaria com a pessoa para sempre;
 *  - REMARCADO: a franquia muda a data no PRÓPRIO registro e põe REMARCADO — o paciente vem naquela data
 *    (provado em Bebedouro, 22/10/2026; ver `spine.service.ts`). Fechar a tarefa apagaria um compromisso
 *    vivo da agenda; por isso o padrão é MANTER (a tarefa segue a data do registro). `fechar` existe como
 *    chave (`FRANQUIA_CALENDARIO_REMARCADO=fechar`) para quem provar que a unidade cria registro novo.
 */
import { SPINE_STATUS, instanteNoFuso, somarDias, type SpineSchedule } from '../services/spine.service.js';
import { downgradeEmoji } from '../services/kommo.service.js';
import { normalizar } from './franquia-sync.js';
import { estadoDoAmbienteComAplicar } from './automacoes-estado.js';

export const DIAS_ATRAS = 14;
export const DURACAO_PADRAO_SEG = 60 * 60;

export type DesfechoDaAgenda = 'ativo' | 'atendido' | 'faltou' | 'desmarcado' | 'remarcado';

const RESULTADO: Record<Exclude<DesfechoDaAgenda, 'ativo'>, string> = {
  atendido: 'Atendido',
  faltou: 'Faltou',
  desmarcado: 'Desmarcado',
  remarcado: 'Remarcado',
};
/** Os resultados com que NÓS concluímos uma tarefa. Qualquer outro (ou nenhum) é a recepção. */
const RESULTADOS_NOSSOS = new Set([...Object.values(RESULTADO), 'Duplicada'].map((r) => normalizar(r)));

/** O que a franquia disse sobre o agendamento. Status novo/desconhecido fica `ativo` (mais seguro que fechar). */
export function desfechoDaAgenda(statusName: string | null | undefined, remarcado: 'manter' | 'fechar' = 'manter', idStatus?: number | null): DesfechoDaAgenda {
  // o id é o que a franquia não escreve de outro jeito; o nome fica de reforço (status novo, id novo)
  const s = normalizar(statusName);
  if (idStatus === SPINE_STATUS.ATENDIDO || s === 'atendido') return 'atendido';
  if (idStatus === SPINE_STATUS.NAO_COMPARECEU || s === 'faltou' || s === 'nao compareceu') return 'faltou';
  if (idStatus === SPINE_STATUS.DESMARCADO || s === 'desmarcado') return 'desmarcado';
  if ((idStatus === SPINE_STATUS.REMARCADO || s === 'remarcado') && remarcado === 'fechar') return 'remarcado';
  return 'ativo';
}

export type ItemDaAgenda = Pick<SpineSchedule, 'idSchedule' | 'clientName' | 'categoryName' | 'physicalTherapist' | 'statusName' | 'dateAttendanceUtc'> & { idStatus?: number | null };

export interface TarefaAberta {
  id: number;
  text: string;
  /** epoch em segundos */
  completeTill: number | null;
  entityId: number | null;
}

export type Acao =
  | { tipo: 'criar'; idSchedule: number; item: ItemDaAgenda; texto: string; completeTill: number }
  | { tipo: 'atualizar'; idSchedule: number; taskId: number; texto: string | null; completeTill: number | null }
  | { tipo: 'fechar'; idSchedule: number; taskId: number; resultado: string }
  /** tarefa aberta cujo agendamento não veio na busca (dentro da janela): só vai para o log */
  | { tipo: 'sumiu'; idSchedule: number; taskId: number };

export interface Plano {
  acoes: Acao[];
  /** agendamentos sem id/data/paciente: não viram tarefa */
  ignorados: number;
  /** agendamentos ativos que já passaram e não têm tarefa: não se cria tarefa para o passado */
  passados: number;
  /** agendamentos ativos cuja tarefa alguém já concluiu: respeitado, não se cria outra */
  jaConcluidas: number;
}

/**
 * O marcador é `[ag:<idSchedule>]`. Duas unidades que dividem UM Kommo (Petrópolis × Caxias) leem a mesma lista de tarefas e os
 * `idSchedule` de franquias diferentes podem coincidir: a irmã usa um PREFIXO (`[ag:caxias:<id>]`) e cada uma só enxerga o próprio
 * formato — `[ag:123]` (sem prefixo) nunca casa com `[ag:caxias:123]` e vice-versa. Unidade de Kommo só dela: sem prefixo, como sempre foi.
 */
const MARCADORES = new Map<string, RegExp>();
function regexDoMarcador(prefixo: string): RegExp {
  let r = MARCADORES.get(prefixo);
  if (!r) {
    // o prefixo só tem letras e dígitos (ver `prefixoDaUnidade`): nada para escapar
    r = new RegExp(`\\[ag:${prefixo ? `${prefixo}:` : ''}(\\d+)\\]`);
    MARCADORES.set(prefixo, r);
  }
  return r;
}

/** Do SLUG da unidade (que não muda), sem "doutor-hernia-", só letras e dígitos: `doutor-hernia-caxias` → `caxias`. Vazio = sem prefixo. */
export function prefixoDaUnidade(slug: string | null | undefined): string {
  return normalizar(slug).replace(/^doutor[\s-]*hernia[\s-]*/, '').replace(/[^a-z0-9]/g, '');
}

export function marcador(idSchedule: number, prefixo = ''): string {
  return `[ag:${prefixo ? `${prefixo}:` : ''}${idSchedule}]`;
}

export function idDoMarcador(texto: string | null | undefined, prefixo = ''): number | null {
  const m = regexDoMarcador(prefixo).exec(texto ?? '');
  return m ? Number(m[1]) : null;
}

/** O que vem DEPOIS do marcador — preservado nas atualizações. */
export function sufixoDepoisDoMarcador(texto: string | null | undefined, prefixo = ''): string {
  const t = texto ?? '';
  const m = regexDoMarcador(prefixo).exec(t);
  return m ? t.slice(m.index + m[0].length) : '';
}

const capitalizar = (p: string) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p);

/** "DR. LEONARDO SILVA SANTOS" → "Dr. Leonardo"; "ANA PAULA X" → "Ana". */
export function profissionalResumido(nome: string | null | undefined): string {
  const partes = String(nome ?? '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '';
  const titulo = normalizar(partes[0]);
  if ((titulo === 'dr' || titulo === 'dra') && partes.length > 1) return `${capitalizar(partes[0].replace(/\.?$/, ''))}. ${capitalizar(partes[1])}`;
  return capitalizar(partes[0]);
}

/** "14:00" no relógio da unidade. */
export function horaLocal(utcIso: string | null | undefined, tz: string): string | null {
  if (!utcIso) return null;
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  return instanteNoFuso(d, tz).slice(11, 16);
}

export function epochDaConsulta(utcIso: string | null | undefined): number | null {
  if (!utcIso) return null;
  const ms = Date.parse(utcIso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** O texto do Kommo é o que sai de `downgradeEmoji` (o Kommo da clínica não guarda emoji de 4 bytes): compara-se igual com igual. */
function comoOKommoGuarda(t: string): string {
  return downgradeEmoji(t).trim();
}

/** `🩺 AVALIAÇÃO 14:00 · Dr. Leonardo · AGENDADO [ag:3784113]` + o que já houvesse depois do marcador. */
export function textoDaTarefa(item: ItemDaAgenda, tz: string, sufixo = '', prefixo = ''): string {
  const categoria = (item.categoryName ?? '').trim().toUpperCase() || 'CONSULTA';
  const hora = horaLocal(item.dateAttendanceUtc, tz) ?? '--:--';
  const prof = profissionalResumido(item.physicalTherapist);
  const status = (item.statusName ?? '').trim().toUpperCase();
  const base = ['🩺 ' + categoria + ' ' + hora, prof, status].filter(Boolean).join(' · ');
  return `${base} ${marcador(item.idSchedule as number, prefixo)}${sufixo}`;
}

/** Depois do marcador, em TODA tarefa: quem é o paciente da franquia. Dois homônimos podem cair no mesmo cartão; o nome na tarefa deixa a recepção ver. */
export function sufixoComCartao(nome: string | null | undefined): string {
  return ` Paciente: ${(nome ?? '').trim() || 'sem nome'}`;
}

/** O que se escreve depois do marcador numa tarefa SEM cartão: quem é e como falar com a pessoa. */
export function sufixoDeTarefaSolta(nome: string | null | undefined, telefone: string | null | undefined): string {
  const quem = (nome ?? '').trim() || 'sem nome';
  return telefone ? ` Paciente: ${quem} · Tel: ${telefone}` : ` Paciente: ${quem} · sem cartão no Kommo`;
}

export interface EntradaDoPlano {
  agendamentos: ReadonlyArray<ItemDaAgenda>;
  /** tarefas ABERTAS do tipo configurado; as sem marcador são ignoradas aqui */
  tarefas: ReadonlyArray<TarefaAberta>;
  /** tarefas JÁ CONCLUÍDAS (por nós ou pela recepção) na janela: o que alguém concluiu de uma consulta ativa não se recria */
  concluidas?: ReadonlyArray<Pick<TarefaAberta, 'text'> & { resultado?: string | null }>;
  agoraEpoch: number;
  tz: string;
  /** janela da busca, em epoch (segundos): só tarefa dentro dela pode ser dada como "sumida" */
  janela: { deEpoch: number; ateEpoch: number };
  remarcado?: 'manter' | 'fechar';
  /** prefixo do marcador desta unidade (Kommo dividido); sem ele, `[ag:N]` */
  prefixo?: string;
}

export function planejarCalendario(e: EntradaDoPlano): Plano {
  const acoes: Acao[] = [];
  let ignorados = 0;
  let passados = 0;
  let jaConcluidas = 0;
  const prefixo = e.prefixo ?? '';
  const fechadasNoKommo = new Set<number>();
  for (const t of e.concluidas ?? []) {
    const id = idDoMarcador(t.text, prefixo);
    // Concluída por NÓS (resultado "Desmarcado", "Atendido"…) não conta: se a franquia reativou o agendamento (desmarcado →
    // agendado outra vez, mesmo registro), a tarefa tem de voltar. Só o que a recepção concluiu é respeitado.
    if (id !== null && !RESULTADOS_NOSSOS.has(normalizar(t.resultado))) fechadasNoKommo.add(id);
  }

  // várias tarefas abertas com o mesmo marcador (reinício no meio do POST): a mais antiga é a canônica
  const porMarcador = new Map<number, TarefaAberta[]>();
  for (const t of e.tarefas) {
    const id = idDoMarcador(t.text, prefixo);
    if (id === null) continue;
    const lista = porMarcador.get(id) ?? [];
    lista.push(t);
    porMarcador.set(id, lista);
  }
  for (const lista of porMarcador.values()) lista.sort((a, b) => a.id - b.id);

  const vistos = new Set<number>();
  for (const item of e.agendamentos) {
    const id = item.idSchedule;
    const quando = epochDaConsulta(item.dateAttendanceUtc);
    if (typeof id !== 'number' || quando === null || !item.clientName?.trim()) {
      ignorados++;
      continue;
    }
    if (vistos.has(id)) continue; // a paginação da franquia pode repetir um registro
    vistos.add(id);

    const desfecho = desfechoDaAgenda(item.statusName, e.remarcado, item.idStatus);
    const abertas = porMarcador.get(id) ?? [];

    if (desfecho !== 'ativo') {
      for (const t of abertas) acoes.push({ tipo: 'fechar', idSchedule: id, taskId: t.id, resultado: RESULTADO[desfecho] });
      continue; // sem tarefa aberta e já resolvido: nada a criar, nunca ressuscita
    }

    if (abertas.length === 0) {
      if (fechadasNoKommo.has(id)) {
        // a recepção deu a tarefa por feita: recriar a cada varredura brigaria com ela para sempre
        jaConcluidas++;
        continue;
      }
      if (quando < e.agoraEpoch) {
        passados++;
        continue;
      }
      acoes.push({ tipo: 'criar', idSchedule: id, item, texto: textoDaTarefa(item, e.tz, '', prefixo), completeTill: quando });
      continue;
    }

    const [canonica, ...repetidas] = abertas;
    for (const t of repetidas) acoes.push({ tipo: 'fechar', idSchedule: id, taskId: t.id, resultado: 'Duplicada' });
    const desejado = textoDaTarefa(item, e.tz, sufixoDepoisDoMarcador(canonica.text, prefixo), prefixo);
    const mudaTexto = comoOKommoGuarda(desejado) !== (canonica.text ?? '').trim();
    const mudaHora = canonica.completeTill !== quando;
    if (mudaTexto || mudaHora) {
      acoes.push({ tipo: 'atualizar', idSchedule: id, taskId: canonica.id, texto: mudaTexto ? desejado : null, completeTill: mudaHora ? quando : null });
    }
  }

  for (const [id, lista] of porMarcador) {
    if (vistos.has(id)) continue;
    for (const t of lista) {
      const ate = t.completeTill;
      if (ate !== null && ate >= e.janela.deEpoch && ate < e.janela.ateEpoch) acoes.push({ tipo: 'sumiu', idSchedule: id, taskId: t.id });
    }
  }

  return { acoes, ignorados, passados, jaConcluidas };
}

// ── configuração por unidade ────────────────────────────────────────────────────────────────────

/** `slug:valor,slug2:valor2` → mapa. Linha malformada é ignorada (valor tem de ser inteiro positivo). */
export function mapaPorSlug(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const par of (raw ?? '').replace(/^['"]|['"]$/g, '').split(',')) {
    const [slug, valor] = par.split(':').map((s) => s.trim());
    const n = Number(valor);
    if (slug && Number.isInteger(n) && n > 0) out.set(slug, n);
  }
  return out;
}

/** `a,b` ou `*` — vazio = ninguém. */
export function slugNaLista(slug: string, raw: string | undefined): boolean {
  const lista = (raw ?? '').replace(/^['"]|['"]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return lista.includes('*') || lista.includes(slug);
}

export type ModoDoCalendario = 'desligado' | 'seco' | 'aplicar';

/**
 * O que a tela de Automações gravou para a unidade (`gravado`) manda: ligado = escreve, seco = só registra, desligado = nada. Sem nada
 * gravado, vale o `.env` de sempre: ligado por `FRANQUIA_CALENDARIO_SLUGS`, e só ESCREVE no Kommo se também estiver em
 * `FRANQUIA_CALENDARIO_APLICAR` (é assim que Timbó roda desde 30/10).
 */
export function modoDoCalendario(
  slug: string,
  env: { slugs?: string; aplicar?: string } = { slugs: process.env.FRANQUIA_CALENDARIO_SLUGS, aplicar: process.env.FRANQUIA_CALENDARIO_APLICAR },
  gravado: 'ligado' | 'seco' | 'desligado' | null = null,
): ModoDoCalendario {
  if (gravado) return gravado === 'ligado' ? 'aplicar' : gravado;
  const doEnv = estadoDoAmbienteComAplicar(slug, env.slugs, env.aplicar); // a mesma definição que a tela usa
  return doEnv === 'ligado' ? 'aplicar' : doEnv;
}

/** O tipo "Consulta" da conta, se houver (sem acento, sem caixa). */
export function tipoPeloNome(tipos: ReadonlyArray<{ id: number; name: string }>, nome = 'Consulta'): number | null {
  const alvo = normalizar(nome);
  return tipos.find((t) => normalizar(t.name) === alvo)?.id ?? null;
}

/**
 * A janela que a varredura LÊ: de hoje-14 a hoje+30 (dias da clínica), em datas yyyy-mm-dd. Os 14 dias para trás existem para
 * FECHAR/atualizar: a recepção dá baixa (ATENDIDO/FALTOU/DESMARCADO) dias depois, e com a janela começando ontem essa baixa
 * nunca chegava à tarefa. Criar continua pulando o passado (`planejarCalendario`).
 */
export function janelaDoCalendario(tz: string, agora: Date = new Date()): { de: string; ate: string } {
  const hoje = instanteNoFuso(agora, tz).slice(0, 10);
  return { de: somarDias(hoje, -DIAS_ATRAS), ate: somarDias(hoje, 30) };
}

/** A linha de `unit_calendario` (só o que o worker lê). */
export interface LinhaDeConfig {
  taskTypeId: number | null;
  responsibleUserId: number | null;
  duracaoMin: number | null;
}

export interface ConfigDaUnidade {
  tipo: number | null;
  responsavel: number | null;
  /** `null` = padrão (60); 0 = não manda duração */
  duracaoMin: number | null;
}

const inteiroPositivo = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/**
 * Tipo, dono e duração de UMA unidade. A linha de `unit_calendario` manda; sem ela vale o `.env` de sempre (Timbó, desde 30/10:
 * `slug:valor`); sem nenhum dos dois, `null` e o worker decide (tipo "Consulta" da conta, dono = único usuário da clínica, 60 min).
 * A duração do `.env` é uma só para todas (`FRANQUIA_CALENDARIO_DURACAO_MIN`); na tabela é por unidade, e 0 vale (= não manda duração).
 */
export function configDaUnidade(
  slug: string,
  linha: LinhaDeConfig | null | undefined,
  env: { tipo?: string; responsavel?: string; duracaoMin?: string } = {
    tipo: process.env.FRANQUIA_CALENDARIO_TIPO,
    responsavel: process.env.FRANQUIA_CALENDARIO_RESPONSAVEL,
    duracaoMin: process.env.FRANQUIA_CALENDARIO_DURACAO_MIN,
  },
): ConfigDaUnidade {
  let duracaoMin: number | null = null;
  if (typeof linha?.duracaoMin === 'number' && Number.isFinite(linha.duracaoMin) && linha.duracaoMin >= 0) duracaoMin = Math.floor(linha.duracaoMin);
  else if (env.duracaoMin !== undefined && env.duracaoMin !== '') duracaoMin = Math.max(0, Math.floor(Number(env.duracaoMin) || 0));
  return {
    tipo: inteiroPositivo(linha?.taskTypeId) ?? mapaPorSlug(env.tipo).get(slug) ?? null,
    responsavel: inteiroPositivo(linha?.responsibleUserId) ?? mapaPorSlug(env.responsavel).get(slug) ?? null,
    duracaoMin,
  };
}

/**
 * De quanto em quanto tempo a rodada roda: `FRANQUIA_CALENDARIO_INTERVALO_MIN`, padrão 15, entre 3 e 60. O piso existe porque cada
 * rodada lê a franquia e o Kommo de TODAS as unidades ligadas, uma de cada vez: a rodada tem de caber no intervalo (o log
 * "rodada concluída" mostra `ms` e `intervaloMs`).
 */
export function intervaloDoCalendarioMs(raw: string | undefined = process.env.FRANQUIA_CALENDARIO_INTERVALO_MIN): number {
  const n = Number((raw ?? '').replace(/^['"]|['"]$/g, ''));
  const min = Number.isFinite(n) && n > 0 ? Math.min(60, Math.max(3, n)) : 15;
  return min * 60_000;
}
