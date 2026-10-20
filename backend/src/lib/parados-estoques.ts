/**
 * Parados: os ESTOQUES que nenhuma regra alcançava (auditoria da Açailândia, 16/10/2026, item 11).
 *
 * Em 20/10 a Açailândia tinha, parados sem nenhuma automação capaz de mexer neles:
 *  - NÃO COMPARECEU: 37. A regra de 18/09 só move quem tem Situação "Não compareceu" E paciente achado
 *    na franquia; 13 eram "Desmarcado", 6 sem situação, e o legado sem cadastro nunca sai;
 *  - AGENDADO: 8 sem data ou com data velha (importação de 28/05 sem consulta; 24338262 com consulta de
 *    04/09 que a clínica nunca registrou) — a revisão acha o paciente, não vê desfecho, e deixa;
 *  - RETORNO PÓS-TRATAMENTO: 29 parados há 40–58 dias, 20 sem data nenhuma — só saem com retorno atendido;
 *  - EM TRATAMENTO: 14 sem nenhum dado de sessão da franquia — a alta nunca é automática e ninguém os lista;
 *  - entrada (50) e EM QUALIFICAÇÃO (2.449, 1.905 da importação de 28/05) sem ninguém escrever há meses.
 *
 * As regras abaixo são as mesmas idades da JORNADA da franquia (`franquia-move`: falta ≤ 30 d = EM ESPERA,
 * > 30 d = PERDIDO "desmarcou ou faltou e não remarcou", fato > 90 d sem régua), aplicadas pelo que o CARTÃO
 * diz quando a franquia não sabe dizer. Moram atrás de chave PRÓPRIA, que nasce desligada: ligar (ou pôr
 * no papel) é decisão do João, porque a primeira varredura começa a escoar o estoque — no teto de sempre,
 * 10 por regra por varredura. O worker de parados precisa estar ligado (ou no papel) na unidade.
 *
 * PURO: decide com os fatos que o worker levantou; quem lê Kommo/franquia e move é `parados-worker.ts`.
 */
import { JORNADA, MOTIVO_PERDA as MOTIVO_PERDA_FRANQUIA, ehEtapaDeEntrada } from './franquia-move.js';
import { normalizarNome } from './kommo-schema.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { CAMPO, DIA_S, MOTIVO_PERDA, OPCAO_ESPERA_FALTA, PRAZOS, campoDoPerdidoDaFranquia, type DecisaoParado } from './parados.js';
import type { DiaDaRetomada } from './espera-retomada.js';

export const ID_AUTOMACAO_ESTOQUES = 'parados-estoques';

/** Estado da chave nesta unidade (tela > `PARADOS_ESTOQUES_SLUGS`; vazio = desligado). */
export function estadoDosEstoques(slug: string, raw: string | undefined = process.env.PARADOS_ESTOQUES_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_AUTOMACAO_ESTOQUES, raw);
}

export const PRAZOS_ESTOQUE = {
  /** falta/desmarcação até aqui ainda é EM ESPERA (recuperável); depois, PERDIDO — JORNADA.ESPERA_MAX_DIAS */
  esperaMaxDias: JORNADA.ESPERA_MAX_DIAS,
  /** fato mais velho que isto fecha sem a régua de PERDIDO — JORNADA.REGUA_PERDIDO_MAX_DIAS */
  semReguaDias: JORNADA.REGUA_PERDIDO_MAX_DIAS,
  /** AGENDADO / RETORNO PÓS / EM TRATAMENTO sem mexer de etapa por tanto tempo = parado (a revisão teve a vez dela) */
  paradoDias: 30,
  /** entrada / EM QUALIFICAÇÃO sem ninguém escrever nem mexer por tanto tempo = dormente */
  dormenteDias: 90,
} as const;

const COMBINADA = 'Regra dos estoques parados (auditoria da Açailândia, 16/10/2026)';

const eh = (a: string, b: string) => normalizarNome(a) === normalizarNome(b);
const diasDesde = (epoch: number, agora: number) => Math.floor((agora - epoch) / DIA_S);
/** A SDR (ou a Sofia) marcou a retomada pra frente: o cartão é dela até lá (mesma regra da espera, item 10). */
const retomadaMarcada = (r: DiaDaRetomada) => r === 'hoje' || r === 'futuro';

// ─── NÃO COMPARECEU ───────────────────────────────────────────────────────────────────────────────

/** Situações do cartão que o estoque de NÃO COMPARECEU alcança. Atendido/Agendado/Remarcado são da franquia. */
export function situacaoDoEstoqueDeFalta(situacao: string | null | undefined): boolean {
  const s = normalizarNome(String(situacao ?? ''));
  return !s || s.includes(normalizarNome('não compareceu')) || s.includes(normalizarNome('desmarcado'));
}

/** Barato, só com o cartão: vale gastar chamada (franquia, eventos) com este cartão de NÃO COMPARECEU? */
export function candidatoFaltaDoEstoque(situacao: string | null | undefined, dataFaltaEpoch: number | null, retomada: DiaDaRetomada, agora: number): boolean {
  if (!situacaoDoEstoqueDeFalta(situacao) || retomadaMarcada(retomada)) return false;
  if (dataFaltaEpoch === null) return true; // sem data: o prazo conta pela última mudança de etapa
  return dataFaltaEpoch <= agora && diasDesde(dataFaltaEpoch, agora) >= PRAZOS.faltaDias;
}

export interface FatosDaFalta {
  dataFaltaEpoch: number | null;
  /**
   * o cartão não muda de etapa há 7 d (com data) ou `paradoDias` (sem data). Quem acabou de chegar em NÃO
   * COMPARECEU não anda pelo prazo — é o que segura o cartão sem paciente achado na franquia (review do Codex).
   */
  semMudarEtapa: boolean;
  /** a franquia (fresca) tem consulta futura ou tratamento em andamento */
  franquiaSegura: boolean;
  agora: number;
}

/**
 * NÃO COMPARECEU pela jornada: falta (ou desmarcação) há 7–30 d → EM ESPERA com retomada em +7 (a regra de
 * 18/09); mais de 30 d → PERDIDO "desmarcou ou faltou e não remarcou", sem régua se passou de 90 d. Sem data
 * no cartão, a idade do fato é desconhecida: parado há 30 d na etapa → PERDIDO sem régua.
 */
export function decidirFaltaDoEstoque(f: FatosDaFalta): DecisaoParado | null {
  if (f.franquiaSegura || !f.semMudarEtapa) return null;
  if (f.dataFaltaEpoch === null) {
    return perdidoPorFalta(`em NÃO COMPARECEU há mais de ${PRAZOS_ESTOQUE.paradoDias} dias, sem data da consulta no cartão`, PRAZOS_ESTOQUE.paradoDias, true);
  }
  const dias = diasDesde(f.dataFaltaEpoch, f.agora);
  if (dias < PRAZOS.faltaDias) return null;
  if (dias <= PRAZOS_ESTOQUE.esperaMaxDias) {
    return {
      para: 'EM ESPERA',
      regra: `faltou ou desmarcou há ${dias} dias e não remarcou (prazo ${PRAZOS.faltaDias})`,
      dias,
      campo: { nome: CAMPO.MOTIVO_ESPERA, opcao: OPCAO_ESPERA_FALTA },
      retomarEmEpoch: f.agora + PRAZOS.faltaDias * DIA_S,
      combinada: COMBINADA,
    };
  }
  return perdidoPorFalta(`faltou ou desmarcou há ${dias} dias e não remarcou`, dias, dias > PRAZOS_ESTOQUE.semReguaDias);
}

function perdidoPorFalta(regra: string, dias: number, semRegua: boolean): DecisaoParado {
  return {
    para: 'PERDIDO',
    regra,
    dias,
    motivoPerda: MOTIVO_PERDA_FRANQUIA.NAO_REMARCOU,
    campo: campoDoPerdidoDaFranquia(MOTIVO_PERDA_FRANQUIA.NAO_REMARCOU),
    semRegua,
    combinada: COMBINADA,
  };
}

// ─── AGENDADO e RETORNO PÓS-TRATAMENTO parados ───────────────────────────────────────────────────

/**
 * Barato: AGENDADO (ou RETORNO PÓS) cuja ◷ Data da Consulta está vazia ou passou há mais de `paradoDias`,
 * sem retomada marcada. Consulta pra frente no cartão (a fase 1 do sincronizador escreveu) segura.
 */
export function candidatoConsultaVelha(dataConsultaEpoch: number | null, retomada: DiaDaRetomada, agora: number): boolean {
  if (retomadaMarcada(retomada)) return false;
  if (dataConsultaEpoch === null) return true;
  return dataConsultaEpoch < agora && diasDesde(dataConsultaEpoch, agora) > PRAZOS_ESTOQUE.paradoDias;
}

export interface FatosDoParado {
  dataConsultaEpoch: number | null;
  /** não mudou de etapa nos últimos `paradoDias` */
  semMudarEtapa: boolean;
  /** o paciente não escreveu nos últimos `paradoDias` */
  semEscrever: boolean;
  franquiaSegura: boolean;
  agora: number;
}

/**
 * AGENDADO parado: consulta que passou há mais de 30 d sem desfecho na franquia (ou cartão sem consulta
 * nenhuma, legado da importação) e ninguém mexeu → PERDIDO. Com data, é a jornada da falta (a consulta não
 * aconteceu); sem data, "não deu continuidade". Fato > 90 d (ou sem data) fecha sem régua.
 */
export function decidirAgendadoParado(f: FatosDoParado): DecisaoParado | null {
  if (f.franquiaSegura || !f.semMudarEtapa || !f.semEscrever) return null;
  if (f.dataConsultaEpoch === null) {
    return {
      para: 'PERDIDO',
      regra: `em AGENDADO há mais de ${PRAZOS_ESTOQUE.paradoDias} dias sem consulta nenhuma (nem no cartão, nem pra frente na franquia)`,
      dias: PRAZOS_ESTOQUE.paradoDias,
      motivoPerda: MOTIVO_PERDA.ESPERA,
      campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.ESPERA },
      semRegua: true,
      combinada: COMBINADA,
    };
  }
  const dias = diasDesde(f.dataConsultaEpoch, f.agora);
  if (dias <= PRAZOS_ESTOQUE.paradoDias) return null;
  return perdidoPorFalta(`consulta de ${dias} dias atrás sem desfecho registrado e nada marcado pra frente`, dias, dias > PRAZOS_ESTOQUE.semReguaDias);
}

/**
 * RETORNO PÓS-TRATAMENTO parado: o ex-paciente não marcou o retorno em 30 d (nem escreveu) → PERDIDO "não deu
 * continuidade", SEMPRE sem régua — é ex-paciente, a régua comercial de PERDIDO não é pra ele. PERDIDO e não
 * ALTA: o gatilho da ALTA no Kommo não tem condição de etiqueta (ver `fila-de-alta.ts`), e mover pra lá mandaria
 * "parabéns pela conclusão"; o PERDIDO com NO_FOLLOW_UP é provado mudo (auditoria, item 13: 0 envios em 88).
 */
export function decidirRetornoParado(f: FatosDoParado): DecisaoParado | null {
  if (f.franquiaSegura || !f.semMudarEtapa || !f.semEscrever) return null;
  const dias = f.dataConsultaEpoch === null ? null : diasDesde(f.dataConsultaEpoch, f.agora);
  return {
    para: 'PERDIDO',
    regra: `em RETORNO PÓS-TRATAMENTO há mais de ${PRAZOS_ESTOQUE.paradoDias} dias sem retorno marcado${dias === null ? ' (sem data no cartão)' : ` (última consulta há ${dias} dias)`}`,
    dias: dias ?? PRAZOS_ESTOQUE.paradoDias,
    motivoPerda: MOTIVO_PERDA.ESPERA,
    campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.ESPERA },
    semRegua: true,
    combinada: COMBINADA,
  };
}

// ─── EM TRATAMENTO sem dado da franquia ──────────────────────────────────────────────────────────

/** Campos de sessão que o sincronizador escreve: cartão sem NENHUM deles nunca foi casado com o tratamento. */
export const CAMPOS_DE_SESSAO = [
  '# Sessões no histórico',
  '# Sessões previstas',
  '# Sessões realizadas',
  '◷ Última sessão',
  '◷ Última sessão marcada',
  '◷ Próxima sessão',
  '⚕ Status do tratamento',
] as const;

export function semDadoDeSessao(campos: ReadonlyArray<{ field_name?: string; values?: ReadonlyArray<{ value?: unknown }> }> | null | undefined): boolean {
  const alvos = new Set(CAMPOS_DE_SESSAO.map((c) => normalizarNome(c)));
  return !(campos ?? []).some((c) => alvos.has(normalizarNome(c.field_name ?? '')) && String(c.values?.[0]?.value ?? '').trim() !== '');
}

export interface FatosDoTratamento {
  semMudarEtapa: boolean;
  /** achou o paciente na franquia */
  conhecido: boolean;
  emAndamento: boolean;
  finalizado: boolean;
}

/**
 * EM TRATAMENTO sem dado nenhum da franquia: a ALTA nunca é automática (o gatilho da ALTA não tem condição),
 * então o cartão vai pra FILA da página /alta e a recepção decide. Tratamento finalizado na franquia = candidato
 * a ALTA; não achado (ou sem tratamento) = "parou no meio". Em andamento: fica — é paciente de verdade.
 */
export function classeDoTratamentoSemDado(f: FatosDoTratamento): 'ALTA' | 'PAROU' | null {
  if (!f.semMudarEtapa || f.emAndamento) return null;
  return f.conhecido && f.finalizado ? 'ALTA' : 'PAROU';
}

// ─── entrada e EM QUALIFICAÇÃO dormentes ────────────────────────────────────────────────────────

export function ehEtapaDormente(etapa: string): boolean {
  return ehEtapaDeEntrada(etapa) || eh(etapa, 'EM QUALIFICAÇÃO');
}

/** Barato: criado há mais de 90 d, sem consulta pra frente no cartão, sem retomada marcada. */
export function candidatoDormente(etapa: string, criadoEpoch: number | null, dataConsultaEpoch: number | null, retomada: DiaDaRetomada, agora: number): boolean {
  if (!ehEtapaDormente(etapa) || retomadaMarcada(retomada)) return false;
  if (dataConsultaEpoch !== null && dataConsultaEpoch > agora) return false;
  return criadoEpoch !== null && diasDesde(criadoEpoch, agora) > PRAZOS_ESTOQUE.dormenteDias;
}

export interface FatosDoDormente {
  /** não mudou de etapa nos últimos 90 d */
  semMudarEtapa: boolean;
  /** o paciente não escreveu nos últimos 90 d (eventos do Kommo) */
  semEscrever: boolean;
  /** a conversa no agente (Sofia ou régua) teve mensagem nos últimos 90 d */
  conversaRecente: boolean;
  franquiaSegura: boolean;
}

/**
 * Entrada / EM QUALIFICAÇÃO sem ninguém escrever nem mexer há 90 d → PERDIDO "não interagiu", sem régua (lead
 * frio de meses não recebe a régua de PERDIDO). Se o paciente voltar a escrever, a Sofia de resgate atende.
 */
export function decidirDormente(f: FatosDoDormente): DecisaoParado | null {
  if (f.franquiaSegura || !f.semMudarEtapa || !f.semEscrever || f.conversaRecente) return null;
  return {
    para: 'PERDIDO',
    regra: `sem o paciente escrever e sem mudar de etapa há mais de ${PRAZOS_ESTOQUE.dormenteDias} dias`,
    dias: PRAZOS_ESTOQUE.dormenteDias,
    motivoPerda: MOTIVO_PERDA.FOLLOW_UP,
    campo: { nome: CAMPO.MOTIVO_NAO_AGENDAMENTO, opcao: MOTIVO_PERDA.FOLLOW_UP },
    semRegua: true,
    combinada: COMBINADA,
  };
}
