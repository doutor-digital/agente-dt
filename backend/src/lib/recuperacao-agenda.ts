/**
 * Lista diária de RECUPERAÇÃO — avaliação desmarcada ou faltosa — para a recepção ligar (26/11/2026). Parte PURA.
 *
 * O número que motiva: das avaliações desmarcadas, só 11% dos pacientes voltaram a ter consulta marcada na mesma unidade; das faltas,
 * 3% (piso, medido em 26/11; ver `docs/estudos/oportunidades-evolucao-crm.md`, seção 5.2). Hoje ninguém recebe a lista dessas pessoas.
 *
 * Critério ADMINISTRATIVO, nunca clínico: só olha categoria, status, data e se a pessoa já voltou. Queixa, dor, idade e diagnóstico
 * não são lidos. A lista não decide por quem a recepção liga primeiro além de «o mais recente primeiro».
 *
 * O que entra: AVALIAÇÃO (e variantes: reavaliação) com status DESMARCADO ou NÃO COMPARECEU, com o DIA da consulta entre 14 e 1 dia
 * atrás. O que sai: quem já voltou a marcar (consulta marcada, confirmada, remarcada ou atendida no mesmo horário ou depois), quem
 * tem consulta futura, quem está em tratamento (sessão marcada ou feita na janela, ou tratamento aberto na franquia). O resto da
 * saída — quem disse «não quero mais» — depende do cartão do Kommo e é do worker (`recuperacao-agenda-worker.ts`).
 *
 * «Desmarcou depois do horário (provável falta)»: a recepção usa «Desmarcado» para tudo. 18% dos desmarques da rede foram lançados
 * DEPOIS da hora da consulta, e isso quase sempre é falta. O texto diz isso, sem mudar o status na franquia.
 */
import { SPINE_STATUS, somarDias } from '../services/spine.service.js';
import { ehSessao, normalizar, tratamentoAbertoNaFranquia } from './franquia-sync.js';
import { tratamentoCancelado, tratamentoFinalizado } from './franquia-move.js';
import { diaDaSemana } from './feriados.js';
import { chaveDoPaciente, instanteDaFranquia } from './agenda-historico.js';
import { primeiroNome } from './aviso-clinica-agendamento.js';

export const DIAS_DA_LISTA = 14;
export const MAXIMO_POR_DIA = 15;

export type TipoDaPerda = 'desmarcou' | 'faltou' | 'provavel_falta';

/** Status em que o paciente TEM consulta de pé (marcada, confirmada, remarcada) ou já foi atendido. */
const COM_CONSULTA = new Set<number>([SPINE_STATUS.AGENDADO, SPINE_STATUS.CONFIRMADO, SPINE_STATUS.REMARCADO, SPINE_STATUS.ATENDIDO]);

export interface AgendamentoDaLista {
  idSchedule: number | null;
  idStatus: number | null;
  clientName: string | null;
  categoryName: string | null;
  dateAttendanceUtc: string | null;
  dayLocal: string | null;
  timeLocal: string | null;
  modifiedUtc?: string | null;
}

export interface Candidato {
  idSchedule: number;
  pacienteChave: string;
  /** o nome como a franquia escreve — só para o primeiro nome do texto; nunca é gravado nem logado */
  nome: string;
  categoria: string | null;
  tipo: TipoDaPerda;
  inicio: Date;
  dia: string;
  hora: string;
  modificadoEm: Date | null;
}

export type MotivoDeSaida = 'voltou' | 'em-tratamento' | 'sem-chave' | 'repetido';

export interface EntradaDaLista {
  unitId: string;
  agendamentos: ReadonlyArray<AgendamentoDaLista>;
  /** as chaves (`chaveDoPaciente`) dos pacientes com tratamento ABERTO na franquia */
  emTratamento: ReadonlySet<string>;
  /**
   * A hora em que cada DESMARQUE foi lançado, do histórico (por idSchedule). Vale mais que o `modified` da agenda, que é a última alteração do
   * registro e muda com qualquer edição. Quem não está aqui usa o `modified`.
   */
  lancamentos?: ReadonlyMap<number, Date>;
  /** hoje na unidade, AAAA-MM-DD */
  hoje: string;
  /** o instante de agora */
  agora: Date;
  dias?: number;
}

export interface ResultadoDosCandidatos {
  /** do mais recente para o mais antigo, um por paciente */
  candidatos: Candidato[];
  /** quantos saíram, e por quê (só contagem) */
  saidas: Record<MotivoDeSaida, number>;
}

export const ehAvaliacao = (categoria: string | null | undefined): boolean => normalizar(categoria).includes('avalia');

/**
 * O paciente está em tratamento, pelo status do tratamento na franquia? As regras são as DO SINCRONIZADOR (importadas, não copiadas): aberto =
 * `tratamentoAbertoNaFranquia` (sem status, em andamento, não iniciado, pendente). Status que NÃO se reconhece também conta como em tratamento
 * — só sai dessa conta o que a casa sabe que acabou (finalizado/alta ou cancelado). Na dúvida o paciente NÃO entra na lista.
 */
export function pacienteEmTratamento(statusName: string | null | undefined): boolean {
  if (tratamentoAbertoNaFranquia(statusName)) return true;
  const t = { idStatus: null, statusName: statusName ?? null };
  // «Suspenso por falta de pagamento» casa com /alta/ (de «falta») na regra de finalizado: suspenso/pausado/em falta NÃO é encerrado, segue em tratamento
  if (/falta|suspens|paus|aguard/.test(normalizar(statusName))) return true;
  return !(tratamentoFinalizado(t) || tratamentoCancelado(t));
}

/**
 * Como o desmarque ou a falta deve ser lido. DESMARCADO lançado DEPOIS da hora da consulta é falta que a recepção registrou como
 * «Desmarcado». Sem a hora do lançamento (a franquia não mandou), vale o que o status diz.
 */
export function tipoDaPerda(idStatus: number | null, inicio: Date, modificadoEm: Date | null): TipoDaPerda | null {
  if (idStatus === SPINE_STATUS.NAO_COMPARECEU) return 'faltou';
  if (idStatus !== SPINE_STATUS.DESMARCADO) return null;
  return modificadoEm && modificadoEm.getTime() > inicio.getTime() ? 'provavel_falta' : 'desmarcou';
}

/** PURO. Quem entra na lista de hoje, antes de olhar o cartão do Kommo. */
export function candidatosDaLista(e: EntradaDaLista): ResultadoDosCandidatos {
  const dias = e.dias ?? DIAS_DA_LISTA;
  const de = somarDias(e.hoje, -dias);
  const ate = somarDias(e.hoje, -1);
  const saidas: Record<MotivoDeSaida, number> = { voltou: 0, 'em-tratamento': 0, 'sem-chave': 0, repetido: 0 };

  // tudo o que cada paciente tem na agenda lida (a janela inteira, não só a avaliação)
  const porPaciente = new Map<string, Array<{ id: number | null; status: number | null; inicioMs: number; categoria: string | null }>>();
  for (const s of e.agendamentos) {
    const chave = chaveDoPaciente(e.unitId, s.clientName);
    const inicio = instanteDaFranquia(s.dateAttendanceUtc);
    if (!chave || !inicio) continue;
    const lista = porPaciente.get(chave) ?? [];
    lista.push({ id: s.idSchedule, status: s.idStatus, inicioMs: inicio.getTime(), categoria: s.categoryName });
    porPaciente.set(chave, lista);
  }

  const brutos: Candidato[] = [];
  const vistos = new Set<number>();
  for (const s of e.agendamentos) {
    const id = s.idSchedule;
    if (typeof id !== 'number' || vistos.has(id) || !ehAvaliacao(s.categoryName)) continue;
    if (!s.dayLocal || s.dayLocal < de || s.dayLocal > ate) continue;
    const inicio = instanteDaFranquia(s.dateAttendanceUtc);
    const modificadoEm = e.lancamentos?.get(id) ?? instanteDaFranquia(s.modifiedUtc);
    const tipo = inicio ? tipoDaPerda(s.idStatus, inicio, modificadoEm) : null;
    if (!inicio || !tipo || !s.clientName?.trim()) continue;
    vistos.add(id);
    const chave = chaveDoPaciente(e.unitId, s.clientName);
    if (!chave) {
      saidas['sem-chave']++;
      continue;
    }
    brutos.push({ idSchedule: id, pacienteChave: chave, nome: s.clientName, categoria: s.categoryName?.trim() || null, tipo, inicio, dia: s.dayLocal, hora: s.timeLocal ?? '', modificadoEm });
  }

  brutos.sort((a, b) => b.inicio.getTime() - a.inicio.getTime());
  const candidatos: Candidato[] = [];
  const jaNaLista = new Set<string>();
  for (const c of brutos) {
    if (jaNaLista.has(c.pacienteChave)) {
      saidas.repetido++;
      continue;
    }
    const dele = porPaciente.get(c.pacienteChave) ?? [];
    // voltou: outra consulta dele (não esta), de pé ou atendida, a partir do momento em que o desmarque foi LANÇADO (ou do horário da consulta, o que vier
    // primeiro): quem remarcou para ANTES do horário original (cancelou no dia 25 e foi atendido no dia 22, por exemplo) também voltou.
    const desde = Math.min(c.inicio.getTime(), c.modificadoEm?.getTime() ?? Infinity);
    const voltou = dele.some((o) => o.id !== c.idSchedule && o.status !== null && COM_CONSULTA.has(o.status) && o.inicioMs >= desde);
    if (voltou) {
      saidas.voltou++;
      continue;
    }
    const emTratamento = e.emTratamento.has(c.pacienteChave) || dele.some((o) => ehSessao({ categoryName: o.categoria }) && o.status !== null && COM_CONSULTA.has(o.status));
    if (emTratamento) {
      saidas['em-tratamento']++;
      continue;
    }
    jaNaLista.add(c.pacienteChave);
    candidatos.push(c);
  }
  return { candidatos, saidas };
}

// ── o texto ───────────────────────────────────────────────────────────────────────────────────

const ROTULO: Record<TipoDaPerda, string> = {
  desmarcou: 'desmarcou',
  faltou: 'faltou',
  provavel_falta: 'desmarcou depois do horário (provável falta)',
};

export const SEM_NOME = 'paciente (sem nome)';

/** O primeiro nome da agenda da franquia, ou «paciente (sem nome)». Tira o prefixo «IA-» / «N-» que a franquia põe em quem nasceu pela IA. */
export function nomeParaOTexto(nomeDaFranquia: string | null | undefined): string {
  return primeiroNome(String(nomeDaFranquia ?? '').replace(/^\s*(IA|N)\s*-\s*/i, '')) ?? SEM_NOME;
}

export interface ItemDoTexto {
  nome: string;
  /** AAAA-MM-DD, o dia da consulta que não aconteceu */
  dia: string;
  /** HH:mm */
  hora: string;
  tipo: TipoDaPerda;
  /** o link do cartão do Kommo; null = não achei (a recepção procura pelo nome) */
  link: string | null;
}

const dm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** A Evolution corta o texto em 1.500 caracteres (`enviarPelaEvolutionComResultado`): cada mensagem fica abaixo disso. */
export const TAMANHO_MAXIMO_DA_MENSAGEM = 1400;

export interface ParteDaLista {
  texto: string;
  /** quais itens (posição na lista de entrada, de `de` até `ate` sem incluir) estão nesta mensagem */
  de: number;
  ate: number;
}

/**
 * As mensagens do grupo (quase sempre uma só; a lista é cortada em mais de uma antes de a Evolution cortar no meio de um paciente), cada
 * uma com os itens que levam — quem envia anota o desfecho item a item: uma continuação que não saiu NÃO pode marcar como «enviado» quem ficou nela.
 * Primeiro nome, dia e hora da consulta, o que aconteceu e o link do cartão. NUNCA CPF, telefone ou sobrenome.
 * `restantes` = quantos candidatos ainda não foram conferidos por causa do teto do dia (entram nos próximos dias, se ainda estiverem dentro dos 14 e não tiverem voltado).
 */
export function partesDaLista(a: { hoje: string; itens: ReadonlyArray<ItemDoTexto>; restantes: number; dias?: number }): ParteDaLista[] {
  const dias = a.dias ?? DIAS_DA_LISTA;
  const linhas = a.itens.map((it, i) => {
    const dia = diaDaSemana(it.dia, true).toLowerCase();
    const quando = `${dm(it.dia)} (${dia})${it.hora ? ` às ${it.hora}` : ''}`;
    const onde = it.link ?? '(cartão não achado, confira o opt-out)';
    return `${i + 1}. ${it.nome} — avaliação de ${quando} — ${ROTULO[it.tipo]}\n   ${onde}`;
  });
  const cabecalho = [
    `📋 Avaliações para recuperar — ${dm(a.hoje)}`,
    `Desmarcaram ou faltaram nos últimos ${dias} dias e ainda não voltaram a marcar. Vale ligar e oferecer um novo horário:`,
    '',
  ].join('\n');
  const rodape = [
    ...(a.restantes > 0 ? [`+${a.restantes} ainda por conferir ficam para os próximos dias.`] : []),
    'Quem voltar a marcar sai da lista sozinho. Cada paciente aparece uma vez.',
  ].join('\n');

  const partes: ParteDaLista[] = [];
  let atual = cabecalho;
  let de = 0;
  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    // o rodapé vai sempre na ÚLTIMA mensagem, junto de pelo menos um paciente: o último item só entra se couber com ele
    const reserva = i === linhas.length - 1 ? rodape.length + 2 : 0;
    if (i > de && atual.length + l.length + 1 + reserva > TAMANHO_MAXIMO_DA_MENSAGEM) {
      partes.push({ texto: atual, de, ate: i });
      de = i;
      atual = '(continuação)\n';
    }
    atual += `${atual.endsWith('\n') ? '' : '\n'}${l}`;
  }
  partes.push({ texto: `${atual}\n\n${rodape}`, de, ate: linhas.length });
  return partes;
}

/** Os mesmos textos, só as mensagens. */
export const textosDaLista = (a: Parameters<typeof partesDaLista>[0]): string[] => partesDaLista(a).map((p) => p.texto);
