/**
 * Quente, Morno ou Frio calculado pelo que ACONTECEU na conversa — sem o modelo.
 *
 * Por que sai do modelo. Medido em 26/09/2026, separando o que a IA escreve do que a
 * SDR escreve: a IA grava Qualificação em 31% dos leads na Serra, 23% na Canaã, 16% em
 * Marabá. Os 93% da Canaã são a recepção obrigada pela trava do Kommo, não a IA. E em
 * 120 dias a IA classificou **18 leads como Frio** na rede inteira — ela simplesmente
 * não rotula quem mandou uma mensagem e sumiu, que é 34% dos leads.
 *
 * E o rótulo dela não carrega informação: leads marcados Quente agendaram em 7,9% dos
 * casos; Morno, 8,6%. Estatisticamente a mesma coisa. O que o campo separa de verdade é
 * **engajou ou não engajou** — e isso um programa decide melhor que um LLM, porque
 * decide igual toda vez e dá pra conferir.
 *
 * A regra, em uma linha: pediu horário é Quente, conversou é Morno, sumiu na primeira é
 * Frio. Cobertura 100% por construção — toda conversa acaba, e toda conversa acabada
 * cai em um dos três.
 */

export type Temperatura = 'Quente' | 'Morno' | 'Frio';

/** Ferramentas cuja chamada prova intenção de marcar. */
const FERRAMENTAS_QUENTES = [
  'consultar_horarios',
  'agendar_consulta',
  'remarcar_consulta',
  'confirmar_presenca',
  'cadastrar_paciente',
];

export interface SinaisDaConversa {
  /** Mensagens que o PACIENTE mandou. A da IA não conta — ela sempre fala. */
  mensagensDoPaciente: number;
  /** Nomes das ferramentas que a IA chamou nessa conversa. */
  ferramentasChamadas: string[];
  /** A franquia confirma consulta marcada para este lead. Sinal mais forte que existe. */
  temConsultaMarcada?: boolean;
}

export interface Classificacao {
  temperatura: Temperatura;
  /** A frase que explica a decisão. Vai pro log e pro relatório — sem ela ninguém confia. */
  porque: string;
}

/**
 * Classifica. Nunca devolve `null`: toda conversa encerrada tem uma resposta defensável,
 * e deixar vazio foi exatamente o que a IA vinha fazendo com 69% dos leads.
 */
export function classificar(s: SinaisDaConversa): Classificacao {
  if (s.temConsultaMarcada) {
    return { temperatura: 'Quente', porque: 'tem consulta marcada na franquia' };
  }

  const quente = s.ferramentasChamadas.find((f) => FERRAMENTAS_QUENTES.includes(f));
  if (quente) {
    return { temperatura: 'Quente', porque: `a IA chamou ${quente} — houve intenção de marcar` };
  }

  // Uma mensagem é o texto automático do anúncio ("Olá! Tenho interesse..."). Quem só
  // mandou isso não disse nada sobre si — e é 34% dos leads. Chamar isso de Morno é o
  // que hoje faz o funil parecer cheio.
  if (s.mensagensDoPaciente <= 1) {
    return {
      temperatura: 'Frio',
      porque: s.mensagensDoPaciente === 0 ? 'não respondeu nada' : 'mandou uma mensagem e sumiu',
    };
  }

  return { temperatura: 'Morno', porque: `conversou (${s.mensagensDoPaciente} mensagens) e não pediu horário` };
}
