/**
 * Campos que a SDR preenchia à mão e que a franquia (ou o próprio cartão) já sabe — fase de TESTE EM SECO.
 *
 * Decisões do João (03/10/2026):
 *  - ⬢ Tipo de lead: "Resgate" = quem JÁ estava na base, mesmo que volte agora clicando num anúncio;
 *    "Cadastro" = quem não existia. Sinal medido (86% de concordância com as SDRs na Açailândia, 97% na Serra):
 *    a etiqueta `importar_…` (leads trazidos da base antiga na implantação) ou cartão com mais de 90 dias
 *    quando chegou ao agendamento. "TRANSFERIDO DE OUTRA UNIDADE" continua manual.
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

/** Leads trazidos da base antiga na implantação carregam esta etiqueta (ex.: `importar_28052026_1600`). */
export function veioDaBaseAntiga(tags: ReadonlyArray<{ name: string }> | undefined): boolean {
  return (tags ?? []).some((t) => /^importar_/i.test(t.name.trim()));
}

/**
 * Resgate ou Cadastro. `referenciaEpoch` = quando o lead chegou ao agendamento (o carimbo "Agendado pela SDR
 * em", ou agora). Sem data de criação do cartão, só a etiqueta decide.
 */
export function tipoDoLead(e: {
  tags: ReadonlyArray<{ name: string }> | undefined;
  criadoEmEpoch: number | null | undefined;
  referenciaEpoch: number;
}): 'Resgate' | 'Cadastro' {
  if (veioDaBaseAntiga(e.tags)) return 'Resgate';
  if (e.criadoEmEpoch && e.referenciaEpoch - e.criadoEmEpoch > DIAS_PARA_RESGATE * DIA_S) return 'Resgate';
  return 'Cadastro';
}

/**
 * A opção da lista "Responsável agendamento" que corresponde a quem marcou. null = não dá para afirmar
 * (agendamento já mexido pela recepção, nome que não está na lista, consulta que não é avaliação).
 */
export function responsavelDoAgendamento(e: {
  consulta: Pick<SpineSchedule, 'categoryName' | 'idStatus' | 'modifiedBy'> | null;
  feitoPelaIa: boolean;
  opcoes: string[];
}): string | null {
  const c = e.consulta;
  if (!c || !ehAvaliacao(c)) return null;
  if (e.feitoPelaIa) return e.opcoes.find((o) => normalizar(o).includes('sofia')) ?? null;
  // Só AGENDADO: confirmado, atendido, falta e desmarcado já passaram pela mão de outra pessoa.
  if (c.idStatus !== SPINE_STATUS.AGENDADO) return null;
  const quem = normalizar(c.modifiedBy);
  if (!quem) return null;
  const primeiro = quem.split(' ')[0];
  // nome inteiro igual vence; depois o primeiro nome (as opções são "TAMIRES", "NEIA", "DOUTOR DIGITAL"…)
  return (
    e.opcoes.find((o) => normalizar(o) === quem) ??
    e.opcoes.find((o) => normalizar(o).split(' ')[0] === primeiro && !normalizar(o).includes(' ')) ??
    null
  );
}

/** Tratamento que o paciente largou: desistência (o nome real da franquia) ou cancelado. */
export function tratamentoDesistido(t: Pick<SpineTreatment, 'statusName'> | null): boolean {
  return !!t && /desist|cancel/.test(normalizar(t.statusName));
}

/** Epoch (s) do dia em que o tratamento virou desistência; null se não virou ou se a franquia não disse quando. */
export function dataDoCancelamento(t: Pick<SpineTreatment, 'statusName' | 'modified'> | null): number | null {
  if (!tratamentoDesistido(t)) return null;
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
  tags: ReadonlyArray<{ name: string }> | undefined;
  criadoEmEpoch: number | null | undefined;
  referenciaEpoch: number;
  consulta: Pick<SpineSchedule, 'categoryName' | 'idStatus' | 'modifiedBy'> | null;
  feitoPelaIa: boolean;
  tratamento: Pick<SpineTreatment, 'statusName' | 'modified'> | null;
}): ResultadoCampoSdr[] {
  const out: ResultadoCampoSdr[] = [];
  const avaliar = (nome: string, valor: string | number | null, motivo: string, igual: (noCartao: string) => boolean) => {
    if (valor === null) return;
    const c = e.campo(nome);
    if (!c) return;
    if (c.valor === null) out.push({ campo: nome, acao: 'gravar', valor, motivo });
    else out.push({ campo: nome, acao: igual(c.valor) ? 'confere' : 'diverge', valor, noCartao: c.valor, motivo });
  };

  // Tipo de lead: só depois que existe consulta (o lead chegou ao agendamento) — antes disso ninguém decide.
  if (e.consulta) {
    const tipo = tipoDoLead(e);
    const c = e.campo(CAMPOS_SDR.TIPO_LEAD);
    // "Transferido de outra unidade" é decisão humana: não compara nem sobrescreve.
    if (!c || !/transferid/.test(normalizar(c.valor))) {
      avaliar(CAMPOS_SDR.TIPO_LEAD, tipo, veioDaBaseAntiga(e.tags) ? 'veio da base antiga (importação)' : tipo === 'Resgate' ? `cartão com mais de ${DIAS_PARA_RESGATE} dias ao agendar` : 'lead novo', (v) => normalizar(v) === normalizar(tipo));
    }
  }

  const resp = e.campo(CAMPOS_SDR.RESPONSAVEL);
  if (resp) {
    const quem = responsavelDoAgendamento({ consulta: e.consulta, feitoPelaIa: e.feitoPelaIa, opcoes: resp.opcoes });
    avaliar(CAMPOS_SDR.RESPONSAVEL, quem, e.feitoPelaIa ? 'agendado pela Sofia' : 'quem marcou na franquia', (v) => normalizar(v) === normalizar(quem));
  }

  const quando = dataDoCancelamento(e.tratamento);
  avaliar(CAMPOS_SDR.DATA_CANCELAMENTO, quando, 'desistência registrada na franquia', (v) => quando !== null && mesmaData(quando, v));

  return out;
}
