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

/** O recorte de um passo de execução (`execution_steps`) que importa para a régua. */
export interface PassoDaConversa {
  kind: string;
  title: string;
}

/**
 * Como os passos de agenda são gravados DE VERDADE (agenda-tools.ts, marcacao-widget.ts): `TOOL_RESULT` (ou
 * `ERROR` quando a ferramenta recusa) com o nome da ferramenta no começo do título — ex. "consultar_horarios
 * 2026-11-03: 4 confirmado(s)…", "agendar_consulta recusado — …", "Consulta marcada: …". Não existe um campo só
 * com o nome da ferramenta (o payload não traz), então o prefixo do título é o identificador mais estável que há.
 * O worker antigo procurava "Decisão: x(" em TOOL_CALL, formato que a agenda nunca gravou: a regra "pediu
 * horário = Quente" nunca disparava (Timbó 30/10: 1 Quente, 37 Morno, 9 Frio; 12 AGENDADO como Morno).
 */
const PASSO_DE_FERRAMENTA = /^(consultar_horarios|agendar_consulta|cadastrar_paciente|confirmar_presenca)\b/;
/** "remarcar: recusado (…)" / "remarcar: <desfecho> (…)" — o título da remarcação não leva o nome da ferramenta. */
const PASSO_DE_REMARCAR = /^remarcar: /;
const PASSO_CONSULTA_MARCADA = /^Consulta marcada/;
/** O formato antigo, que `tools.ts` ainda grava para outras ferramentas. */
const DECISAO_ANTIGA = /^Decisão: ([a-z_]+)\(/;
/** A recepção segurava a IA: a ferramenta foi barrada, não é o paciente pedindo horário. */
const IA_PAUSADA = 'IA pausada pela recepção';

/** Prefixos de título que valem a pena trazer do banco (filtro grosso; o fino é `sinaisDosPassos`). */
export const PREFIXOS_DE_PASSO = [
  'Decisão: ',
  'consultar_horarios',
  'agendar_consulta',
  'cadastrar_paciente',
  'confirmar_presenca',
  'remarcar: ',
  'Consulta marcada',
];

/** Lê os passos de uma conversa e diz que ferramentas de agenda houve e se uma consulta foi marcada. Puro. */
export function sinaisDosPassos(passos: PassoDaConversa[]): { ferramentas: string[]; consultaMarcada: boolean } {
  const ferramentas: string[] = [];
  let consultaMarcada = false;
  const anota = (f: string) => {
    if (!ferramentas.includes(f)) ferramentas.push(f);
  };
  for (const p of passos) {
    if (p.kind === 'TOOL_CALL') {
      const m = DECISAO_ANTIGA.exec(p.title);
      if (m) anota(m[1]);
      continue;
    }
    if (p.kind !== 'TOOL_RESULT' && p.kind !== 'ERROR') continue;
    if (p.title.includes(IA_PAUSADA)) continue;
    if (p.kind === 'TOOL_RESULT' && PASSO_CONSULTA_MARCADA.test(p.title)) {
      consultaMarcada = true;
      continue;
    }
    const m = PASSO_DE_FERRAMENTA.exec(p.title);
    if (m) anota(m[1]);
    else if (PASSO_DE_REMARCAR.test(p.title)) anota('remarcar_consulta');
  }
  return { ferramentas, consultaMarcada };
}

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
