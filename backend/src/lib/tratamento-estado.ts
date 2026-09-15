/**
 * Estado do tratamento: quantas sessões o paciente já fez e se ele ainda está
 * em tratamento AGORA. Parte pura — quem busca na franquia e escreve no Kommo
 * é o worker.
 *
 * A régua foi decidida com o João em 15/09/2026, depois de medir Araguaína: o
 * critério antigo era "tem alguma sessão atendida no passado", e por ele 148
 * pacientes entrariam em EM TRATAMENTO — sendo que 84 tinham feito a última
 * sessão entre 3 meses e 1 ano atrás. A etapa passaria a mentir sobre o presente.
 *
 * EM TRATAMENTO = "está em tratamento AGORA" (entra E sai), não "já começou um dia".
 *
 * Ordem de prioridade, a primeira que casa vence:
 *   1. tem sessão futura marcada            → EM_TRATAMENTO
 *   2. sem futura + protocolo completo      → CANDIDATO_ALTA (nunca move sozinho)
 *   3. sem futura + última sessão ≤ 30 dias → EM_TRATAMENTO (ativo, só não remarcou)
 *   4. resto                                → PAROU (fica onde está, vira tarefa)
 *
 * Por que ALTA nunca é automática: ALTA é o "Ganho" nativo do funil de tratamento
 * e o gatilho dela dispara um bot SEM nenhuma condição — mover em massa mandaria
 * uma mensagem de conclusão para cada cartão. Quem aprova é gente, pela página.
 */

/** Protocolo → sessões contratadas (tabela de negociação da clínica). */
export const SESSOES_POR_PROTOCOLO: Record<number, number> = { 1: 8, 2: 16, 3: 24 };

const DIA_MS = 86_400_000;

/** Dias sem sessão e sem próxima marcada para o paciente contar como "parou". */
export const DIAS_PARA_PAROU = 30;

/**
 * "PROTOCOLO 03 MESES" → 24. A franquia manda o protocolo como texto; o número
 * de meses é o que diz quantas sessões foram contratadas.
 *
 * Devolve 0 para avaliação e para o que não reconhecer — 0 faz o paciente nunca
 * parecer "protocolo completo", que é o lado seguro do erro: ele fica em
 * EM_TRATAMENTO ou PAROU, e ninguém recebe alta indevida.
 */
export function sessoesDoProtocolo(category: string | null | undefined): number {
  const c = String(category ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (!c.includes('protocolo')) return 0;
  const m = c.match(/(\d{1,2})\s*(mes|meses)/);
  if (!m) return 0;
  return SESSOES_POR_PROTOCOLO[Number(m[1])] ?? 0;
}

/** Uma sessão do paciente, já filtrada pelo worker (só as dos tratamentos dele). */
export interface SessaoDoPaciente {
  /** ISO da franquia. O sufixo "Z" mente: a hora é LOCAL — ver franquia-sync. */
  dateAttendanceUtc: string | null;
  idStatus: number | null;
}

export interface ResumoTratamento {
  /** soma dos protocolos: quem renovou contratou mais sessões */
  previstas: number;
  realizadas: number;
  faltas: number;
  /** ISO da primeira sessão ainda por vir */
  proxima: string | null;
  /** ISO da última sessão JÁ OCORRIDA — nunca uma futura */
  ultimaFeita: string | null;
  /** se compareceu à última JÁ OCORRIDA */
  compareceu: 'Sim' | 'Não' | null;
}

const ATENDIDO = 42;
const NAO_COMPARECEU = 40;

/**
 * `ultimaFeita` é deliberadamente a última sessão **já ocorrida**. Pegar o fim da
 * lista ordenada traz a sessão FUTURA de quem tem horário marcado: o cartão fica
 * com a próxima no campo de última, e o campo vizinho ("Compareceu à última
 * sessão marcada") passa a falar de outra sessão. Ninguém compareceu a uma
 * sessão que ainda não aconteceu.
 */
export function resumirTratamento(
  sessoes: SessaoDoPaciente[],
  protocolos: Array<{ category: string | null }>,
  agora: Date,
): ResumoTratamento {
  const corte = agora.getTime();
  const comData = sessoes
    .filter((s) => s.dateAttendanceUtc)
    .sort((a, b) => String(a.dateAttendanceUtc).localeCompare(String(b.dateAttendanceUtc)));

  const passadas = comData.filter((s) => Date.parse(String(s.dateAttendanceUtc)) <= corte);
  const futuras = comData.filter((s) => Date.parse(String(s.dateAttendanceUtc)) > corte);
  const ultima = passadas[passadas.length - 1];

  return {
    previstas: protocolos.reduce((n, p) => n + sessoesDoProtocolo(p.category), 0),
    realizadas: passadas.filter((s) => s.idStatus === ATENDIDO).length,
    faltas: passadas.filter((s) => s.idStatus === NAO_COMPARECEU).length,
    proxima: futuras[0]?.dateAttendanceUtc ?? null,
    ultimaFeita: ultima?.dateAttendanceUtc ?? null,
    compareceu: !ultima ? null : ultima.idStatus === ATENDIDO ? 'Sim' : ultima.idStatus === NAO_COMPARECEU ? 'Não' : null,
  };
}

export type EstadoTratamento = 'EM_TRATAMENTO' | 'CANDIDATO_ALTA' | 'PAROU' | 'SEM_SESSAO';

/** Protocolo completo = fez pelo menos o que contratou. Sem protocolo conhecido, nunca completo. */
export function protocoloCompleto(r: Pick<ResumoTratamento, 'previstas' | 'realizadas'>): boolean {
  return r.previstas > 0 && r.realizadas >= r.previstas;
}

export function diasDesde(iso: string | null, agora: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((agora.getTime() - t) / DIA_MS) : null;
}

export function classificarTratamento(
  r: ResumoTratamento,
  agora: Date,
  diasParaParou: number = DIAS_PARA_PAROU,
): EstadoTratamento {
  if (r.realizadas === 0 && !r.proxima) return 'SEM_SESSAO';
  if (r.proxima) return 'EM_TRATAMENTO';
  if (protocoloCompleto(r)) return 'CANDIDATO_ALTA';
  const dias = diasDesde(r.ultimaFeita, agora);
  if (dias !== null && dias <= diasParaParou) return 'EM_TRATAMENTO';
  return 'PAROU';
}
