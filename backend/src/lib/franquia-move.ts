/**
 * Franquia → Kommo, fase 2: MOVER etapa (a fase 1 só escrevia campos).
 *
 * Decisão do João com a chefe da DH (18/09/2026): a franquia é onde a clínica registra o que
 * aconteceu; o cartão do Kommo anda sozinho atrás do fato. As SDRs param de mover cartão.
 * Máquina de etapas, casada com o rastreio do n8n (que manda Purchase pra Meta SÓ quando o
 * cartão passa por GANHO / CONCLUÍDO no funil COMERCIAL):
 *
 *   avaliação marcada (futura)        → AGENDADO
 *   avaliação atendida                → COMPARECEU
 *   falta registrada                  → NÃO COMPARECEU
 *   atendido há 48 h sem tratamento   → EM NEGOCIAÇÃO
 *   tratamento aberto                 → GANHO / CONCLUÍDO
 *   primeira sessão atendida          → EM TRATAMENTO (funil TRATAMENTO)
 *   tratamento finalizado             → ALTA
 *
 *   tratamento cancelado              → TRATAMENTO CANCELADO        (22/09/2026)
 *   alta + retorno pós marcado        → RETORNO PÓS-TRATAMENTO      (22/09/2026, volta pro COMERCIAL)
 *   retorno pós atendido              → COMPARECEU, como avaliação  (22/09/2026)
 *   consulta desmarcada, sem remarcar → EM ESPERA                   (23/09/2026)
 *
 *   JORNADA pela idade do fato (23/09/2026, pedido do João: "regra de negócio pela jornada do lead"):
 *   atendido < 48 h → COMPARECEU · ≤ 45 d → EM NEGOCIAÇÃO · > 45 d → PERDIDO "não fechou"
 *   faltou ≤ 7 d → NÃO COMPARECEU · ≤ 30 d → EM ESPERA · > 30 d → PERDIDO "não remarcou"
 *   desmarcou ≤ 30 d → EM ESPERA · > 30 d → PERDIDO "não remarcou"
 *   PERDIDO só a partir de cartão parado (AGENDADO, NÃO COMPARECEU, COMPARECEU, CONFERIR); entrada,
 *   EM QUALIFICAÇÃO, EM ESPERA e EM NEGOCIAÇÃO ficam com a Sofia/SDR e o worker de parados (alguém está trabalhando).
 *   Fato com mais de 90 d fecha SEM a régua de reengajamento de PERDIDO.
 *   paciente não achado na franquia    → CONFERIR NA FRANQUIA; 30 d sem acerto → PERDIDO "sem cadastro"
 *   ex-paciente (finalizado, nada aberto, parado > 30 d) → ALTA sem mensagem (não passa por GANHO)
 *
 * O que NUNCA faz: tirar cartão de PERDIDO ou TRATAMENTO CANCELADO (decisão humana); tirar de ALTA
 * ou RETORNO PÓS-TRATAMENTO por outro motivo que não o retorno acima; mover pra PERDIDO ou EM ESPERA
 * (é leitura da conversa, fica com a Sofia/SDR); mexer em cartão que está em outro funil (resgate,
 * financeiro…). Quem já teve alta tem tratamento FINALIZADO no histórico — isso não pode empurrar o
 * cartão de volta pra GANHO quando ele volta pra um retorno.
 *
 * Só nas unidades em `FRANQUIA_MOVE_SLUGS` (csv; `*` = todas). Lab primeiro, depois Imperatriz.
 *
 * REGRAS DE 16/10/2026 (só com `regras1610`, que vem da chave `casamento-jornada` — ver `casamento-jornada.ts`):
 *   ex-paciente (finalizado, nada aberto) que volta com consulta marcada → RETORNO PÓS-TRATAMENTO (de qualquer etapa,
 *   inclusive ALTA e PERDIDO); finalizado nunca leva a GANHO (cartão parado de quem terminou → ALTA); âncora da jornada =
 *   última AVALIAÇÃO; falta em retorno não muda a etapa (vira nota + tarefa no sincronizador). "A franquia manda" no PERDIDO
 *   e na ALTA: avaliação marcada pra frente tira do PERDIDO (AGENDADO); na ALTA, sessão marcada → EM TRATAMENTO e consulta
 *   marcada → RETORNO PÓS-TRATAMENTO. Essas saídas levam `gatilho` e o sincronizador só as faz UMA vez por fato (a equipe pôs
 *   de volta = fica, e vira tarefa). TRATAMENTO CANCELADO continua intocável (a SDR cancela no Kommo, regra 08/10).
 */
import { SPINE_STATUS, type SpineSchedule } from '../services/spine.service.js';
import { ehAvaliacao, ehConsulta } from './franquia-sync.js';
import { normalizarNome } from './kommo-schema.js';
import { automacaoLigada, estadoDaAutomacao, type Estado } from './automacoes-estado.js';

export const ETAPA = {
  INC: 'Etapa de leads de entrada',
  QUALIFICACAO: 'EM QUALIFICAÇÃO',
  ESPERA: 'EM ESPERA',
  AGENDADO: 'AGENDADO',
  NAO_COMPARECEU: 'NÃO COMPARECEU',
  COMPARECEU: 'COMPARECEU',
  NEGOCIACAO: 'EM NEGOCIAÇÃO',
  RETORNO: 'RETORNO PÓS-TRATAMENTO',
  /** cartão que afirma consulta mas a franquia não conhece o paciente (nome/telefone): fila da SDR (23/09/2026) */
  CONFERIR: 'CONFERIR NA FRANQUIA',
  GANHO: 'GANHO / CONCLUÍDO',
  PERDIDO: 'PERDIDO',
  EM_TRATAMENTO: 'EM TRATAMENTO',
  ALTA: 'ALTA',
  CANCELADO: 'TRATAMENTO CANCELADO',
} as const;

export type Funil = 'COMERCIAL' | 'TRATAMENTO';

export interface EtapaAtual {
  funil: Funil;
  status: string;
}

/** O que precisamos saber de um tratamento da franquia pra decidir etapa. 44 pendente · 45 em andamento · 46 finalizado. */
export interface TratamentoParaEtapa {
  idStatus: number | null;
  statusName?: string | null;
  /** Quando a franquia manda (o histórico do paciente manda): é o "fato" da saída da ALTA por sessão marcada. */
  idTreatment?: number | null;
}

export interface EntradaMovimento {
  atual: EtapaAtual | null;
  /** todas as consultas (avaliação/retorno) e sessões do paciente que conhecemos */
  agendamentos: SpineSchedule[];
  tratamentos: TratamentoParaEtapa[];
  agoraEpoch: number;
  horasAteNegociacao: number;
  /**
   * Regras de 16/10/2026 (chave `casamento-jornada`, ver `casamento-jornada.ts`): ex-paciente que volta vai pra
   * RETORNO PÓS-TRATAMENTO e finalizado nunca leva a GANHO; âncora = última AVALIAÇÃO; falta em retorno não move;
   * consulta marcada na franquia tira do PERDIDO ("a franquia manda"). Sem isto, a máquina é a de sempre.
   */
  regras1610?: boolean;
}

export interface Movimento {
  funil: Funil;
  para: string;
  motivo: string;
  /** só pra PERDIDO: motivo de perda do Kommo (loss reason), criado se não existir */
  motivoPerda?: string;
  /** só pra PERDIDO: fato velho demais pra régua de reengajamento — etiqueta NO_FOLLOW_UP segura os templates */
  semRegua?: boolean;
  /** só pra PERDIDO: idade do fato em dias (vai pra nota do cartão) */
  dias?: number;
  /**
   * 16/10 ("a franquia manda"): o cartão sai de PERDIDO ou ALTA por causa deste fato da franquia (`consulta:<idSchedule>`,
   * ou `sessao:trat:<idTreatment>` / `sessao:<idSchedule>` na ALTA). O sincronizador só tira o cartão de lá UMA vez por
   * fato: se a equipe puser de volta, fica e vira tarefa.
   */
  gatilho?: string;
}

/**
 * Prazos da jornada do lead (23/09/2026). Mesmos números do worker de parados (negociação 45 d, espera 30 d,
 * falta 7 d), aplicados pela IDADE DO FATO na franquia — não pela última mexida no cartão.
 */
export const JORNADA = {
  /** atendido e sem tratamento: até aqui é EM NEGOCIAÇÃO; depois, PERDIDO "não fechou" */
  NEGOCIACAO_MAX_DIAS: 45,
  /** desmarcou/faltou e não remarcou: até aqui é EM ESPERA (recuperável); depois, PERDIDO */
  ESPERA_MAX_DIAS: 30,
  /** falta recente ainda vale NÃO COMPARECEU (a régua de falta fala com o paciente) */
  FALTA_RECENTE_DIAS: 7,
  /** PERDIDO por fato mais velho que isto não recebe a régua de reengajamento (lead frio de meses) */
  REGUA_PERDIDO_MAX_DIAS: 90,
  /** ninguém acertou o cadastro em CONFERIR NA FRANQUIA por este tempo: PERDIDO "sem cadastro" */
  CONFERIR_MAX_DIAS: 30,
  /** tratamento finalizado e sem atividade há mais que isto = ex-paciente: ALTA sem mensagem, não GANHO */
  EX_PACIENTE_DIAS: 30,
} as const;

export const MOTIVO_PERDA = {
  NAO_FECHOU: 'Não fechou após a avaliação',
  NAO_REMARCOU: 'Desmarcou ou faltou e não remarcou',
  SEM_CADASTRO: 'Sem cadastro na franquia',
} as const;

export const TRATAMENTO_FINALIZADO = 46;

const n = normalizarNome;
const eh = (a: string, b: string) => n(a) === n(b);
const emAlgum = (status: string, lista: string[]) => lista.some((s) => eh(status, s));

/** Etapa de entrada tem nome variável ("Incoming leads", "Etapa de leads de entrada"): trata pelo padrão. */
export function ehEtapaDeEntrada(status: string): boolean {
  const s = n(status);
  return s.includes('entrada') || s.includes('incoming') || s === n(ETAPA.INC);
}

const PRE_AGENDADO = [ETAPA.QUALIFICACAO, ETAPA.ESPERA];
const INTOCAVEIS_COMERCIAL = [ETAPA.PERDIDO];
const INTOCAVEIS_TRATAMENTO = [ETAPA.CANCELADO];

/** "Retorno após tratamento" na franquia: a consulta de quem já teve alta. Categoria ≠ "Retorno" simples (que é dentro da avaliação). */
export function ehRetornoPosTratamento(s: Pick<SpineSchedule, 'categoryName'>): boolean {
  const c = n(s.categoryName ?? '');
  return c.includes('retorno') && c.includes('tratamento');
}

function epoch(s: SpineSchedule): number | null {
  if (!s.dateAttendanceUtc) return null;
  const t = Math.floor(Date.parse(s.dateAttendanceUtc) / 1000);
  return Number.isFinite(t) ? t : null;
}

function ehSessao(s: SpineSchedule): boolean {
  const c = n(s.categoryName ?? '');
  return !!c && !ehConsulta(s);
}

export const TRATAMENTO_EM_ANDAMENTO = 45;

function finalizado(t: TratamentoParaEtapa): boolean {
  return t.idStatus === TRATAMENTO_FINALIZADO || /finaliz|conclu|alta/.test(n(t.statusName ?? ''));
}

function cancelado(t: TratamentoParaEtapa): boolean {
  return /cancel/.test(n(t.statusName ?? ''));
}

/**
 * 45 EM ANDAMENTO (ou nome equivalente). Um tratamento só PENDENTE (44, proposta sem pagamento)
 * não segura a ALTA. Sem id nem nome (veio do /treatments/search cru) assume em andamento, que é
 * o que aquela rota devolve.
 */
function emAndamento(t: TratamentoParaEtapa): boolean {
  if (finalizado(t) || cancelado(t)) return false;
  const nome = n(t.statusName ?? '');
  if (t.idStatus === TRATAMENTO_EM_ANDAMENTO) return true;
  if (nome) return /andamento|ativo/.test(nome);
  return t.idStatus === null;
}

export const TRATAMENTO_PENDENTE = 44;

/**
 * Tratamento "aberto" na franquia (pendente ou em andamento): é o que leva o cartão pra GANHO.
 * Cancelado e finalizado não contam — e um status que a gente NÃO conhece (id fora de 44/45/46,
 * sem nome) também não: um cancelado que chegue sem `statusName` não pode virar Purchase.
 */
export function tratamentoAberto(t: TratamentoParaEtapa): boolean {
  if (finalizado(t) || cancelado(t)) return false;
  if (t.idStatus === null || t.idStatus === TRATAMENTO_PENDENTE || t.idStatus === TRATAMENTO_EM_ANDAMENTO) return true;
  return /pendente|andamento|ativo/.test(n(t.statusName ?? ''));
}
const aberto = tratamentoAberto;
/** Tratamento finalizado (alta) — pra revisão reconhecer ex-paciente sem tratamento aberto. */
export const tratamentoFinalizado = finalizado;

function pendente(t: TratamentoParaEtapa): boolean {
  return !finalizado(t) && !cancelado(t) && (t.idStatus === TRATAMENTO_PENDENTE || /pendente/.test(n(t.statusName ?? '')));
}

/** Retorno pós-tratamento atendido há pouco: entre uma varredura e outra, ou registrado depois do fato. */
const RECENTE_S = 7 * 24 * 3600;

/** O agendamento mais próximo (o primeiro pela data), ou null. */
function proxima(lista: SpineSchedule[]): SpineSchedule | null {
  return [...lista].sort((a, b) => (epoch(a) ?? 0) - (epoch(b) ?? 0))[0] ?? null;
}

/** O fato da franquia que tira o cartão de PERDIDO/ALTA: o id da consulta (ou a data, se a franquia não mandou id). */
function gatilhoDe(s: SpineSchedule): string {
  return `consulta:${s.idSchedule ?? s.dateAttendanceUtc ?? '?'}`;
}

/**
 * Sessão (achado 3 da revisão de 16/10: era um "sessao" fixo, que valia uma vez por cartão por dez anos): o fato é o
 * TRATAMENTO — o da sessão, ou o único em andamento na franquia —, estável enquanto ele durar, e um tratamento novo é fato
 * novo. Sem id de tratamento nenhum, a própria sessão.
 */
function gatilhoDaSessao(s: SpineSchedule, tratamentos: TratamentoParaEtapa[]): string {
  const doTratamentoAberto = tratamentos.filter(emAndamento).map((t) => t.idTreatment).filter((x): x is number => !!x);
  const id = s.idTreatment ?? (doTratamentoAberto.length === 1 ? doTratamentoAberto[0] : null);
  return id ? `sessao:trat:${id}` : `sessao:${s.idSchedule ?? s.dateAttendanceUtc ?? '?'}`;
}

/**
 * PURA (16/10, achado da revisão): tratamento FINALIZADO, nenhum em andamento, e mesmo assim uma sessão marcada pra frente
 * na franquia. É sujeira (sessão esquecida): o cartão não se move por isso; o sincronizador abre uma tarefa. Devolve a
 * sessão, ou null.
 */
export function sessaoEsquecidaComTratamentoFinalizado(e: Pick<EntradaMovimento, 'agendamentos' | 'tratamentos' | 'agoraEpoch'>): SpineSchedule | null {
  if (!e.tratamentos.some(finalizado) || e.tratamentos.some(emAndamento)) return null;
  const futuras = e.agendamentos.filter((s) => ehSessao(s) && (epoch(s) ?? 0) > e.agoraEpoch && (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO));
  return proxima(futuras);
}

/** Puro: dado o cartão e o que a franquia sabe, pra onde o cartão vai (ou null = fica). */
export function planejarMovimento(e: EntradaMovimento): Movimento | null {
  const atual = e.atual;
  if (!atual) return null;
  const status = atual.status;
  const v2 = e.regras1610 === true;
  const ir = (funil: Funil, para: string, motivo: string): Movimento | null => (atual.funil === funil && eh(status, para) ? null : { funil, para, motivo });

  let consultas = e.agendamentos.filter((s) => ehConsulta(s) && epoch(s) !== null);
  const sessoes = e.agendamentos.filter((s) => ehSessao(s) && epoch(s) !== null);
  const temFinalizado = e.tratamentos.some(finalizado);
  const temAberto = e.tratamentos.some(aberto);
  const temEmAndamento = e.tratamentos.some(emAndamento);
  const temCancelado = e.tratamentos.some(cancelado);
  const temPendente = e.tratamentos.some(pendente);
  const passou = (s: SpineSchedule) => (epoch(s) ?? Infinity) <= e.agoraEpoch;
  const futura = (s: SpineSchedule) => (epoch(s) ?? 0) > e.agoraEpoch && (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO);

  // ── regras de 16/10: o ex-paciente e a VOLTA ──
  // Ex-paciente = já terminou um tratamento e não tem nenhum aberto. A "volta" são as consultas DEPOIS da última sessão
  // dele (o fim do ciclo). Sem sessão conhecida não há como separar o ciclo velho do novo: aí só a consulta marcada pra
  // frente conta como volta — a avaliação de antes do tratamento nunca pode reabrir a jornada.
  const exPaciente = v2 && temFinalizado && !temAberto;
  const fimDoCiclo = v2 ? Math.max(0, ...sessoes.filter(passou).map((s) => epoch(s) ?? 0)) : 0;
  const daVolta = (s: SpineSchedule) => (fimDoCiclo > 0 ? (epoch(s) ?? 0) > fimDoCiclo : futura(s));
  const consultasDaVolta = exPaciente ? consultas.filter(daVolta) : [];
  const voltaMarcada = consultasDaVolta.some(futura);
  const decididasDaVolta = consultasDaVolta
    .filter((s) => passou(s) || s.idStatus === SPINE_STATUS.DESMARCADO)
    .sort((a, b) => (epoch(b) ?? 0) - (epoch(a) ?? 0));
  const ultimaDaVolta = decididasDaVolta[0] ?? null;

  if (atual.funil === 'COMERCIAL' && emAlgum(status, INTOCAVEIS_COMERCIAL)) {
    // "a franquia manda" (16/10): uma consulta marcada PRA FRENTE é fato novo e tira o cartão do PERDIDO — avaliação vai
    // pra AGENDADO; ex-paciente, com qualquer consulta, vai pra RETORNO PÓS-TRATAMENTO. Fato velho (atendido, falta,
    // tratamento antigo "em andamento" esquecido) não reabre nada: perder de novo um paciente fechado não tem volta.
    if (v2) {
      const daVoltaMarcada = proxima(consultasDaVolta.filter(futura));
      if (daVoltaMarcada) return { funil: 'COMERCIAL', para: ETAPA.RETORNO, motivo: 'ex-paciente voltou: consulta marcada na franquia (sai do PERDIDO)', gatilho: gatilhoDe(daVoltaMarcada) };
      const avaliacaoMarcada = proxima(consultas.filter((s) => futura(s) && ehAvaliacao(s)));
      if (avaliacaoMarcada) return { funil: 'COMERCIAL', para: ETAPA.AGENDADO, motivo: 'avaliação marcada na franquia (a franquia manda: sai do PERDIDO)', gatilho: gatilhoDe(avaliacaoMarcada) };
    }
    return null;
  }
  if (atual.funil === 'TRATAMENTO' && emAlgum(status, INTOCAVEIS_TRATAMENTO)) return null;
  // quem já fez um ciclo inteiro (alta) volta como retorno pós-tratamento. O retorno mais recente marca o
  // corte do ciclo atual: sessão e tratamento de antes dele são do ciclo velho e não valem pra GANHO/ALTA.
  const retornosPos = consultas.filter(ehRetornoPosTratamento).sort((a, b) => (epoch(b) ?? 0) - (epoch(a) ?? 0));
  const ultimoRetornoPos = retornosPos[0] ?? null;
  const cicloAnterior = ultimoRetornoPos !== null;
  const corteCiclo = ultimoRetornoPos ? (epoch(ultimoRetornoPos) ?? 0) : 0;
  const retornoPosAtendido = !!ultimoRetornoPos && ultimoRetornoPos.idStatus === SPINE_STATUS.ATENDIDO && passou(ultimoRetornoPos);
  const retornoPosAtendidoRecente = retornoPosAtendido && e.agoraEpoch - corteCiclo <= RECENTE_S;
  const retornoPosMarcado = !!ultimoRetornoPos && futura(ultimoRetornoPos);

  // ── RETORNO PÓS-TRATAMENTO (COMERCIAL): só sai quando o retorno é atendido, e aí segue como avaliação normal ──
  if (atual.funil === 'COMERCIAL' && eh(status, ETAPA.RETORNO)) {
    if (retornoPosAtendido) return ir('COMERCIAL', ETAPA.COMPARECEU, 'retorno pós-tratamento atendido na franquia');
    // 16/10: a consulta da volta pode vir como avaliação (não "retorno após tratamento"); atendida, segue como avaliação.
    // Falta ou desmarcação aqui não mexe na etapa (falta vira nota + tarefa — decisão 4).
    if (ultimaDaVolta && ultimaDaVolta.idStatus === SPINE_STATUS.ATENDIDO && passou(ultimaDaVolta)) {
      return ir('COMERCIAL', ETAPA.COMPARECEU, 'ex-paciente voltou: consulta atendida na franquia');
    }
    return null;
  }

  // ── funil TRATAMENTO ──
  if (atual.funil === 'TRATAMENTO') {
    if (eh(status, ETAPA.ALTA)) {
      if (v2) {
        // 16/10, "a franquia manda" também na ALTA: sessão marcada pra frente = ainda em tratamento; consulta marcada pra
        // frente (avaliação ou retorno) = voltou (regra 2). Cada saída leva o fato que a causou (só uma vez por fato).
        // Só com tratamento EM ANDAMENTO: finalizado + sessão "agendada" é sujeira da franquia — o cartão fica na ALTA e o
        // sincronizador abre uma tarefa (sem isto, ALTA → EM TRATAMENTO → ALTA e a régua da ALTA dispara de novo).
        const sessaoMarcada = proxima(sessoes.filter(futura));
        if (sessaoMarcada && temEmAndamento) return { funil: 'TRATAMENTO', para: ETAPA.EM_TRATAMENTO, motivo: 'sessão marcada na franquia (a franquia manda: sai da ALTA)', gatilho: gatilhoDaSessao(sessaoMarcada, e.tratamentos) };
        const consultaMarcada = proxima(consultas.filter(futura));
        if (consultaMarcada) return { funil: 'COMERCIAL', para: ETAPA.RETORNO, motivo: 'consulta marcada na franquia (a franquia manda: sai da ALTA)', gatilho: gatilhoDe(consultaMarcada) };
        if (retornoPosAtendidoRecente && ultimoRetornoPos) return { funil: 'COMERCIAL', para: ETAPA.COMPARECEU, motivo: 'retorno pós-tratamento atendido na franquia', gatilho: gatilhoDe(ultimoRetornoPos) };
        if (ultimaDaVolta && ultimaDaVolta.idStatus === SPINE_STATUS.ATENDIDO && passou(ultimaDaVolta) && e.agoraEpoch - (epoch(ultimaDaVolta) ?? 0) <= RECENTE_S) {
          return { funil: 'COMERCIAL', para: ETAPA.COMPARECEU, motivo: 'ex-paciente voltou: consulta atendida na franquia', gatilho: gatilhoDe(ultimaDaVolta) };
        }
        return null;
      }
      // paciente de alta com retorno marcado: volta pro COMERCIAL, na etapa própria
      if (retornoPosMarcado) return ir('COMERCIAL', ETAPA.RETORNO, 'retorno pós-tratamento marcado na franquia');
      // retorno marcado e atendido entre duas varreduras (ou lançado depois): não pode ficar preso na ALTA
      if (retornoPosAtendidoRecente) return ir('COMERCIAL', ETAPA.COMPARECEU, 'retorno pós-tratamento atendido na franquia');
      return null;
    }
    if (eh(status, ETAPA.EM_TRATAMENTO)) {
      if (cicloAnterior) {
        // o FINALIZADO do ciclo velho é esperado aqui; o que decide é o tratamento novo
        if (temCancelado && !temEmAndamento && !temPendente) return ir('TRATAMENTO', ETAPA.CANCELADO, 'tratamento cancelado na franquia');
        if (temFinalizado && !temEmAndamento && !temPendente && !temCancelado) return ir('TRATAMENTO', ETAPA.ALTA, 'tratamento finalizado na franquia');
        return null;
      }
      // um tratamento pendente não segura a alta; um em andamento segura
      if (temFinalizado && !temEmAndamento) return ir('TRATAMENTO', ETAPA.ALTA, 'tratamento finalizado na franquia');
      // cancelado na franquia, sem outro aberto (pendente ou em andamento) e sem finalizado: a clínica encerrou
      if (temCancelado && !temAberto && !temFinalizado) return ir('TRATAMENTO', ETAPA.CANCELADO, 'tratamento cancelado na franquia');
    }
    return null;
  }

  // ── 16/10: ex-paciente em etapa comercial. Nunca GANHO (não é venda nova, não gera Purchase) ──
  // Voltou com consulta marcada → RETORNO PÓS-TRATAMENTO. Voltou e a consulta já aconteceu → a jornada segue pelas
  // consultas da VOLTA (abaixo). Não voltou → cartão parado de quem terminou: ALTA, sem a régua se o fato é velho.
  let jornadaDaVolta = false;
  if (exPaciente && atual.funil === 'COMERCIAL' && !eh(status, ETAPA.GANHO)) {
    if (voltaMarcada) return ir('COMERCIAL', ETAPA.RETORNO, 'ex-paciente voltou: consulta marcada na franquia');
    if (decididasDaVolta.length === 0) {
      const ultimaAtividade = Math.max(0, ...e.agendamentos.map((s) => epoch(s) ?? 0));
      const diasParado = ultimaAtividade > 0 ? (e.agoraEpoch - ultimaAtividade) / 86_400 : Infinity;
      const cartaoParado = emAlgum(status, [ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU, ETAPA.COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.CONFERIR]);
      if (!cartaoParado) return null;
      const dias = Number.isFinite(diasParado) ? Math.floor(diasParado) : 365;
      return { funil: 'TRATAMENTO', para: ETAPA.ALTA, motivo: `tratamento finalizado na franquia (ex-paciente, sem atividade há ${Number.isFinite(diasParado) ? dias : '+365'} d)`, semRegua: diasParado > JORNADA.EX_PACIENTE_DIAS, dias };
    }
    consultas = consultasDaVolta;
    jornadaDaVolta = true;
  }

  // ── (regras antigas) ex-paciente (decisão do João, 23/09/2026): tratamento FINALIZADO, nada aberto, nada marcado e sem
  // atividade há mais de EX_PACIENTE_DIAS, com o cartão perdido numa etapa comercial parada → ALTA sem mensagem
  // (etiqueta NO_FOLLOW_UP segura os gatilhos de ALTA). Não passa por GANHO: não é venda nova, não gera Purchase.
  // Finalizado RECENTE segue o caminho normal (GANHO → EM TRATAMENTO → ALTA): ciclo rápido que a varredura perdeu.
  if (!v2 && atual.funil === 'COMERCIAL' && temFinalizado && !temAberto && !cicloAnterior) {
    const temFutura = e.agendamentos.some((s) => (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO) && (epoch(s) ?? 0) > e.agoraEpoch);
    const ultimaAtividade = Math.max(0, ...e.agendamentos.map((s) => epoch(s) ?? 0));
    const diasParado = ultimaAtividade > 0 ? (e.agoraEpoch - ultimaAtividade) / 86_400 : Infinity;
    const cartaoParado = emAlgum(status, [ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU, ETAPA.COMPARECEU, ETAPA.NEGOCIACAO, ETAPA.CONFERIR]);
    if (!temFutura && diasParado > JORNADA.EX_PACIENTE_DIAS && cartaoParado) {
      return { funil: 'TRATAMENTO', para: ETAPA.ALTA, motivo: `ex-paciente: tratamento finalizado na franquia, sem atividade há ${Number.isFinite(diasParado) ? Math.floor(diasParado) : '+365'} d`, semRegua: true, dias: Number.isFinite(diasParado) ? Math.floor(diasParado) : 365 };
    }
  }

  // ── tratamento existe: GANHO, e depois EM TRATAMENTO na 1ª sessão atendida ──
  // (finalizado só conta pra quem NÃO é retorno de um ciclo anterior)
  // 16/10: finalizado nunca LEVA a GANHO; só mantém a passagem GANHO → EM TRATAMENTO de quem já está em GANHO
  const finalizadoContaPraGanho = temFinalizado && !cicloAnterior && (!v2 || eh(status, ETAPA.GANHO));
  if (temAberto || finalizadoContaPraGanho) {
    // sessão do ciclo velho (antes do retorno pós) não leva ninguém pra EM TRATAMENTO de novo
    const sessaoAtendida = sessoes.some((s) => s.idStatus === SPINE_STATUS.ATENDIDO && passou(s) && (epoch(s) ?? 0) > corteCiclo);
    if (eh(status, ETAPA.GANHO)) {
      if (sessaoAtendida) return ir('TRATAMENTO', ETAPA.EM_TRATAMENTO, 'primeira sessão atendida');
      return null;
    }
    // qualquer etapa antes de GANHO (inclusive entrada, espera e negociação) vai pra GANHO primeiro:
    // é ali que o n8n manda o Purchase; EM TRATAMENTO fica pra próxima varredura, se já houver sessão.
    return ir('COMERCIAL', ETAPA.GANHO, 'tratamento aberto na franquia');
  }

  // ── sem tratamento aberto: a ÚLTIMA AVALIAÇÃO decide a jornada (23/09/2026, "jornada do lead") ──
  // Antes valia "qualquer atendida": avaliação de 2025 levava o cartão de 2026 pra COMPARECEU. Agora a
  // âncora é a última AVALIAÇÃO (retorno desmarcado não apaga a avaliação atendida; avaliação nova
  // desmarcada apaga a velha atendida) e a IDADE do fato diz a etapa: recente → etapa do fato; velho →
  // a etapa em que a jornada terminou (EM ESPERA / PERDIDO), sem passar pelas etapas do meio.
  if (consultas.length === 0) return null;
  const porData = [...consultas].sort((a, b) => (epoch(b) ?? 0) - (epoch(a) ?? 0));
  const futurasMarcadas = porData.filter((s) => (s.idStatus === SPINE_STATUS.AGENDADO || s.idStatus === SPINE_STATUS.CONFIRMADO) && (epoch(s) ?? 0) > e.agoraEpoch);
  // fato decidido: consulta que já passou, ou desmarcada (mesmo com data futura — cancelar antes é fato)
  const decididas = porData.filter((s) => passou(s) || s.idStatus === SPINE_STATUS.DESMARCADO);
  // 16/10 (decisão 5): a âncora é a última AVALIAÇÃO — retorno não ancora a jornada. Exceção: o ex-paciente que voltou,
  // cuja consulta da volta faz o papel de avaliação, venha com que nome vier.
  const ancora = v2
    ? (decididas.find(ehAvaliacao) ?? (jornadaDaVolta ? decididas[0] : null) ?? null)
    : (decididas.find(ehAvaliacao) ?? decididas[0] ?? null);
  const dias = ancora ? Math.max(0, (e.agoraEpoch - (epoch(ancora) ?? e.agoraEpoch)) / 86_400) : 0;
  const horas = dias * 24;
  const quando = ancora ? `há ${Math.floor(dias)} d` : '';
  const emConferir = eh(status, ETAPA.CONFERIR);
  // etapas que ainda não viram a avaliação (a franquia pode levar pra qualquer lado a partir daqui)
  const pre = ehEtapaDeEntrada(status) || emAlgum(status, [...PRE_AGENDADO, ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU]) || emConferir;
  // etapas que AFIRMAM que a avaliação aconteceu — se a franquia diz outra coisa, a afirmação cai
  const posSemProva = emAlgum(status, [ETAPA.COMPARECEU, ETAPA.NEGOCIACAO]);
  // etapas em que o cartão já "tem consulta": falta/desmarcada só mexem a partir daqui (de EM QUALIFICAÇÃO/EM ESPERA
  // a máquina não inventa NÃO COMPARECEU — decisão de 18/09)
  const origemConsulta = emAlgum(status, [ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU]) || emConferir || posSemProva;
  // de onde a máquina pode fechar como PERDIDO: cartão parado que ninguém está trabalhando. Entrada e
  // EM QUALIFICAÇÃO/EM ESPERA (a Sofia conversa, pode ser paciente antigo voltando) e EM NEGOCIAÇÃO (a SDR
  // negocia) ficam com o worker de parados.
  const podePerder = emAlgum(status, [ETAPA.AGENDADO, ETAPA.NAO_COMPARECEU, ETAPA.COMPARECEU]) || emConferir;
  const perder = (motivoPerda: string, motivo: string): Movimento => ({ funil: 'COMERCIAL', para: ETAPA.PERDIDO, motivo, motivoPerda, semRegua: dias > JORNADA.REGUA_PERDIDO_MAX_DIAS, dias: Math.floor(dias) });

  // avaliação atendida: jornada pós-consulta
  if (ancora && ancora.idStatus === SPINE_STATUS.ATENDIDO) {
    // com retorno marcado o paciente já tem próximo passo (João, 18/09): fica em COMPARECEU, as 48 h contam depois
    if (futurasMarcadas.length > 0) return pre ? ir('COMERCIAL', ETAPA.COMPARECEU, 'avaliação atendida na franquia, retorno marcado') : null;
    if (eh(status, ETAPA.NEGOCIACAO)) return null;
    if (horas < e.horasAteNegociacao) return ir('COMERCIAL', ETAPA.COMPARECEU, 'avaliação atendida na franquia');
    if (dias <= JORNADA.NEGOCIACAO_MAX_DIAS) return ir('COMERCIAL', ETAPA.NEGOCIACAO, `atendido há ${Math.floor(horas)} h sem tratamento`);
    if (podePerder) return perder(MOTIVO_PERDA.NAO_FECHOU, `avaliação atendida ${quando}, sem tratamento nem retorno`);
    return null;
  }

  // avaliação marcada pra frente (e a última decidida não foi atendida): AGENDADO.
  // De COMPARECEU/NEGOCIAÇÃO só uma AVALIAÇÃO nova puxa de volta — retorno futuro é continuação, não volta.
  if (futurasMarcadas.length > 0) {
    if (pre || (posSemProva && futurasMarcadas.some(ehAvaliacao))) return ir('COMERCIAL', ETAPA.AGENDADO, 'avaliação marcada na franquia');
    return null;
  }
  if (!ancora) return null;

  // 16/10 (decisão 4): falta (ou desmarcação) em consulta que não é avaliação não muda a etapa — falta vira nota + tarefa
  if (v2 && !ehAvaliacao(ancora) && (ancora.idStatus === SPINE_STATUS.NAO_COMPARECEU || ancora.idStatus === SPINE_STATUS.DESMARCADO)) return null;

  // faltou: jornada da falta
  if (ancora.idStatus === SPINE_STATUS.NAO_COMPARECEU) {
    if (dias <= JORNADA.FALTA_RECENTE_DIAS) return origemConsulta ? ir('COMERCIAL', ETAPA.NAO_COMPARECEU, 'falta registrada na franquia') : null;
    if (dias <= JORNADA.ESPERA_MAX_DIAS) return origemConsulta ? ir('COMERCIAL', ETAPA.ESPERA, `faltou ${quando} e não remarcou`) : null;
    if (podePerder) return perder(MOTIVO_PERDA.NAO_REMARCOU, `faltou ${quando} e não remarcou`);
    return null;
  }
  // desmarcou: jornada da desistência antes da avaliação (EM ESPERA é a etapa recuperável)
  if (ancora.idStatus === SPINE_STATUS.DESMARCADO) {
    if (dias <= JORNADA.ESPERA_MAX_DIAS) return origemConsulta ? ir('COMERCIAL', ETAPA.ESPERA, `consulta desmarcada na franquia ${quando}, sem remarcação`) : null;
    if (podePerder) return perder(MOTIVO_PERDA.NAO_REMARCOU, `desmarcou ${quando} e não remarcou`);
    return null;
  }
  // consulta PASSADA ainda "agendada/confirmada/remarcada" na franquia: a clínica não registrou o desfecho — fica, a Conferência aponta
  return null;
}

/** Quanto antes da consulta do cartão (ou da criação do lead) o histórico ainda é "deste ciclo". */
export const REVISAO_FOLGA_S = 30 * 24 * 3600;

/**
 * Recorte do histórico do paciente pra revisar um cartão em AGENDADO (achados do review, 23/09/2026):
 * a máquina de etapas foi desenhada pra janela D-3…D+45, não pro histórico inteiro. Só entram as
 * consultas/sessões a partir de `desdeEpoch` (avaliação atendida em 2025 não pode reescrever a Data da
 * Consulta nem levar pra COMPARECEU) e só tratamento ABERTO (finalizado/cancelado de ciclo velho levaria
 * o cartão a GANHO e o n8n mandaria Purchase falso pra Meta).
 */
export function recortarHistorico<S extends Pick<SpineSchedule, 'dateAttendanceUtc'>, T extends TratamentoParaEtapa>(
  hist: { schedules: S[]; treatments: T[] },
  desdeEpoch: number,
): { schedules: S[]; treatments: T[] } {
  const schedules = hist.schedules.filter((s) => {
    const t = s.dateAttendanceUtc ? Math.floor(Date.parse(s.dateAttendanceUtc) / 1000) : NaN;
    return Number.isFinite(t) && t >= desdeEpoch;
  });
  return { schedules, treatments: hist.treatments.filter(tratamentoAberto) };
}

export function moveLiberado(slug: string, raw: string | undefined = process.env.FRANQUIA_MOVE_SLUGS): boolean {
  return automacaoLigada(slug, 'franquia-move', raw);
}

/**
 * ligado = move; seco = decide e registra "moveria" sem tocar no Kommo (só a tela grava "seco");
 * desligado = nem decide. O `.env` só sabe ligado/desligado.
 */
export function estadoDoMove(slug: string, raw: string | undefined = process.env.FRANQUIA_MOVE_SLUGS): Estado {
  return estadoDaAutomacao(slug, 'franquia-move', raw);
}

export function horasAteNegociacao(raw: string | undefined = process.env.FRANQUIA_NEGOCIACAO_HORAS): number {
  const h = Number((raw ?? '').replace(/^['"]|['"]$/g, ''));
  return Number.isFinite(h) && h > 0 ? h : 48;
}
