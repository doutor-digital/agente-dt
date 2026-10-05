/**
 * Campos que a SDR preenchia à mão e que a franquia (ou o próprio cartão) já sabe — fase de TESTE EM SECO.
 *
 * Decisões do João (03/10/2026):
 *  - ⬢ Tipo de lead: "Resgate" = quem JÁ estava na base, mesmo que volte agora clicando num anúncio;
 *    "Cadastro" = quem não existia. Regra (05/10): Resgate se agendou mais de 90 dias depois do 1º contato,
 *    e o 1º contato é a data mais antiga entre a criação do cartão, o campo "Data do primeiro contato" e a
 *    data que a SDR escreve no nome ("Rosimar 14/5/2026"). Medido na base inteira contra o que as SDRs
 *    puseram: Açailândia 90% (n=272), Serra 93% (n=28). A etiqueta `importar_…` NÃO decide mais: a
 *    importação de 28/05 trouxe junto quem tinha chegado em abril/maio, e ela marcava esses como Resgate
 *    (a regra antiga dava 70% na Açailândia). "TRANSFERIDO DE OUTRA UNIDADE" continua manual.
 *  - ☻ Responsável agendamento: quem marcou a avaliação NA FRANQUIA. O dono do cartão no Kommo não serve
 *    (as SDRs dividem um login só). A franquia só guarda "quem mexeu por último", então o nome só vale
 *    enquanto o agendamento ainda está AGENDADO — depois a recepção dá baixa e o nome passa a ser o dela.
 *    Marcado pela Sofia → a opção da IA.
 *  - ◷ Data solicitação de cancelamento: o dia em que o tratamento virou desistência/cancelado na franquia.
 *    O status real da franquia é "DESISTÊNCIA A PEDIDO DO PACIENTE" (id 54), não "cancelado".
 *
 * Política deste módulo: PREENCHE BURACO. Se a SDR já preencheu, não sobrescreve — só compara e registra
 * se confere ou diverge, que é o teste em produção que o João pediu antes de aprovar.
 */
import { SPINE_STATUS, type SpineSchedule, type SpineTreatment } from '../services/spine.service.js';
import { ehAvaliacao, normalizar } from './franquia-sync.js';

export const CAMPOS_SDR = {
  TIPO_LEAD: '⬢ Tipo de lead',
  RESPONSAVEL: '☻ Responsável agendamento',
  DATA_CANCELAMENTO: '◷ Data solicitação de cancelamento',
} as const;

/** Cartão com mais que isso quando chegou ao agendamento já estava na base. */
export const DIAS_PARA_RESGATE = 90;
const DIA_S = 86_400;

/** Meio-dia em Brasília: a data do nome não tem hora, e um dia a mais ou a menos não muda a regra dos 90 dias. */
const HORA_UTC = 15;
/** Data no nome mais velha que isso é digitação ("26/06/06") ou nascimento, não 1º contato. */
const MAX_ANOS_NO_NOME = 3;

/**
 * Datas que a SDR escreveu no nome do cartão ("Rosimar 14/5/2026", "ELANE 26/1", "Nivas 09/12/25 19/5/2026"),
 * em epoch (s). Os cartões importados guardam ali o dia do 1º contato — a criação do cartão é o dia da importação.
 *
 * Sem ano: o mais recente que não passe da referência. Fica de fora: data colada em outros dígitos ou barras
 * ("25/02/26/02/26" — não dá para saber onde uma termina), data impossível (31/02) e data DEPOIS da
 * referência (ninguém faz o 1º contato depois de agendar) ou mais de 3 anos antes dela (digitação/nascimento).
 */
export function datasNoNome(nome: string | null | undefined, referenciaEpoch: number): number[] {
  const ref = new Date(referenciaEpoch * 1000);
  const out: number[] = [];
  for (const m of (nome ?? '').matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : ref.getUTCFullYear();
    const epoch = (a: number) => {
      const d = new Date(Date.UTC(a, mes - 1, dia, HORA_UTC));
      // o Date "conserta" 31/02 para 03/03; se mudou, a data não existe
      return d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? d.getTime() / 1000 : null;
    };
    let e = epoch(ano);
    if (e !== null && !m[3] && e > referenciaEpoch + DIA_S) e = epoch(--ano);
    if (e === null || e > referenciaEpoch + DIA_S || e < referenciaEpoch - MAX_ANOS_NO_NOME * 365 * DIA_S) continue;
    out.push(e);
  }
  return out;
}

/**
 * Resgate ou Cadastro. O 1º contato é a data mais antiga entre a criação do cartão, o campo "Data do primeiro
 * contato" e as datas escritas no nome. `referenciaEpoch` = quando o lead chegou ao agendamento (o carimbo
 * "Agendado pela SDR em" ou, sem ele, a data da consulta). NUNCA "agora": um cartão de maio que agendou em maio
 * e é varrido em outubro viraria "Resgate" só por estar velho hoje. Sem referência ou sem nenhuma data, não decide.
 */
export function tipoDoLead(e: {
  nome: string | null | undefined;
  criadoEmEpoch: number | null | undefined;
  primeiroContatoEpoch: number | null | undefined;
  referenciaEpoch: number | null;
}): 'Resgate' | 'Cadastro' | null {
  if (!e.referenciaEpoch) return null;
  const candidatas = [e.criadoEmEpoch, e.primeiroContatoEpoch, ...datasNoNome(e.nome, e.referenciaEpoch)]
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0);
  if (candidatas.length === 0) return null;
  return e.referenciaEpoch - Math.min(...candidatas) > DIAS_PARA_RESGATE * DIA_S ? 'Resgate' : 'Cadastro';
}

/**
 * A opção da lista "Responsável agendamento" que corresponde a quem marcou. null = não dá para afirmar
 * (agendamento já mexido pela recepção, nome que não está na lista, consulta que não é avaliação).
 */
export function responsavelDoAgendamento(e: {
  consulta: Pick<SpineSchedule, 'categoryName' | 'idStatus' | 'modifiedBy'> | null;
  feitoPelaIa: boolean;
  opcoes: string[];
  /**
   * true = é a PRIMEIRA vez que o sincronizador vê este agendamento (ainda sem o carimbo "Agendado pela SDR
   * em"). Só nessa hora "quem mexeu por último" é quem marcou: uma remarcação continua AGENDADO e troca o nome.
   */
  primeiraVez: boolean;
}): string | null {
  const c = e.consulta;
  if (!c || !ehAvaliacao(c)) return null;
  if (e.feitoPelaIa) return e.opcoes.find((o) => normalizar(o).includes('sofia')) ?? null;
  // Só AGENDADO e só na primeira vez: depois disso o nome pode ser de quem confirmou, remarcou ou deu baixa.
  if (!e.primeiraVez || c.idStatus !== SPINE_STATUS.AGENDADO) return null;
  const quem = normalizar(c.modifiedBy);
  if (!quem) return null;
  const primeiro = quem.split(' ')[0];
  // nome inteiro igual, ou o primeiro nome igual a uma opção de UMA palavra ("TAMIRES", "NEIA")
  return e.opcoes.find((o) => normalizar(o) === quem || normalizar(o) === primeiro) ?? null;
}

/** Tratamento que o paciente largou: desistência (o nome real da franquia) ou cancelado. */
export function tratamentoDesistido(t: Pick<SpineTreatment, 'statusName'> | null): boolean {
  return !!t && /desist|cancel/.test(normalizar(t.statusName));
}

/**
 * Epoch (s) do dia em que o tratamento virou desistência; null se não virou, se a franquia não disse quando,
 * ou se o tratamento é de um ciclo ANTERIOR a este cartão (paciente que desistiu há meses e voltou como lead
 * novo não pode levar a data velha para o cartão novo).
 *
 * Limite conhecido: a franquia só dá `modified` (última alteração de qualquer coisa), não "quando virou
 * desistência". Uma edição posterior no tratamento muda a data — por isso este campo fica em teste.
 */
export function dataDoCancelamento(
  t: Pick<SpineTreatment, 'statusName' | 'modified' | 'created'> | null,
  cartaoCriadoEmEpoch?: number | null,
): number | null {
  if (!tratamentoDesistido(t)) return null;
  if (cartaoCriadoEmEpoch) {
    const criado = Date.parse(t!.created ?? '');
    if (!Number.isFinite(criado) || criado / 1000 < cartaoCriadoEmEpoch - 7 * DIA_S) return null;
  }
  const ms = Date.parse(t!.modified ?? '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export interface CampoAtual {
  /** valor no cartão (texto; data = epoch em segundos como texto), null se vazio */
  valor: string | null;
  /** opções do campo (lista); vazio nos demais */
  opcoes: string[];
}

export type ResultadoCampoSdr =
  | { campo: string; acao: 'gravar'; valor: string | number; motivo: string }
  | { campo: string; acao: 'confere' | 'diverge'; valor: string | number; noCartao: string; motivo: string };

/** Datas valem iguais dentro de um dia (o campo pode ser date ou date_time). */
const mesmaData = (a: number, b: string) => Number.isFinite(Number(b)) && Math.abs(Number(b) - a) <= DIA_S;

/**
 * Puro: o que o robô gravaria (campo vazio) ou como o que ele calculou bate com o que a SDR já pôs.
 * `campo(nome)` devolve null quando a conta não tem o campo.
 */
export function planejarCamposSdr(e: {
  campo: (nome: string) => CampoAtual | null;
  /** nome do cartão (a SDR escreve ali o dia do 1º contato) */
  nome: string | null | undefined;
  criadoEmEpoch: number | null | undefined;
  /** campo "◷ Data do primeiro contato", se preenchido */
  primeiroContatoEpoch: number | null | undefined;
  referenciaEpoch: number | null;
  /** primeira vez que o sincronizador vê o agendamento (sem o carimbo "Agendado pela SDR em") */
  primeiraVez: boolean;
  consulta: Pick<SpineSchedule, 'categoryName' | 'idStatus' | 'modifiedBy'> | null;
  feitoPelaIa: boolean;
  tratamento: Pick<SpineTreatment, 'statusName' | 'modified' | 'created'> | null;
}): ResultadoCampoSdr[] {
  const out: ResultadoCampoSdr[] = [];
  const avaliar = (nome: string, valor: string | number | null, motivo: string, igual: (noCartao: string) => boolean) => {
    if (valor === null) return;
    const c = e.campo(nome);
    if (!c) return;
    // Campo de lista: só vale opção que EXISTE na conta, e na grafia dela (senão o Kommo devolve 400 a cada varredura).
    if (typeof valor === 'string' && c.opcoes.length > 0) {
      const alvo = normalizar(valor);
      const opcao = c.opcoes.find((o) => normalizar(o) === alvo);
      if (!opcao) return;
      valor = opcao;
    }
    if (c.valor === null) out.push({ campo: nome, acao: 'gravar', valor, motivo });
    else out.push({ campo: nome, acao: igual(c.valor) ? 'confere' : 'diverge', valor, noCartao: c.valor, motivo });
  };

  // Tipo de lead: só depois que existe consulta (o lead chegou ao agendamento) — antes disso ninguém decide.
  if (e.consulta) {
    const tipo = tipoDoLead(e);
    const c = e.campo(CAMPOS_SDR.TIPO_LEAD);
    // "Transferido de outra unidade" é decisão humana: não compara nem sobrescreve.
    if (!c || !/transferid/.test(normalizar(c.valor))) {
      if (tipo) avaliar(CAMPOS_SDR.TIPO_LEAD, tipo, tipo === 'Resgate' ? `agendou mais de ${DIAS_PARA_RESGATE} dias depois do 1º contato` : 'lead novo', (v) => normalizar(v) === normalizar(tipo));
    }
  }

  const resp = e.campo(CAMPOS_SDR.RESPONSAVEL);
  if (resp) {
    const quem = responsavelDoAgendamento({ consulta: e.consulta, feitoPelaIa: e.feitoPelaIa, opcoes: resp.opcoes, primeiraVez: e.primeiraVez });
    avaliar(CAMPOS_SDR.RESPONSAVEL, quem, e.feitoPelaIa ? 'agendado pela Sofia' : 'quem marcou na franquia', (v) => normalizar(v) === normalizar(quem));
  }

  const quando = dataDoCancelamento(e.tratamento, e.criadoEmEpoch);
  avaliar(CAMPOS_SDR.DATA_CANCELAMENTO, quando, 'desistência registrada na franquia', (v) => quando !== null && mesmaData(quando, v));

  return out;
}
