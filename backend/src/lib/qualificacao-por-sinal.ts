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
 * 2026-11-03: 4 confirmado(s)…", "agendar_consulta falhou: …", "Consulta marcada: …". Não existe um campo só
 * com o nome da ferramenta (o payload não traz), então o título é o identificador mais estável que há.
 *
 * LISTA DO QUE ESQUENTA, não do que esfria. O nome da ferramenta no título NÃO prova intenção: a agenda também
 * grava a recusa por falta de escolha ("agendar_consulta recusado — faltou confirmar o dia…", "cadastrar_paciente
 * RECUSADO: não veio o horário escolhido…") e por idClient errado ("…não existe", "…é de outra pessoa"). Nesses
 * a IA tentou antes de o paciente escolher qualquer coisa — um lead de 1 mensagem saía Quente (PR #178). Só
 * esquenta o passo em que houve ESCOLHA do paciente: consultou horários, o horário estava ocupado ou a franquia
 * recusou o que ele escolheu, marcou, remarcou, confirmou. Título novo que não está aqui NÃO esquenta: errar
 * para o lado do Morno/Frio é barato; um Quente falso aparece no funil e na fila da SDR.
 *
 * O worker antigo procurava "Decisão: x(" em TOOL_CALL, formato que nenhuma ferramenta de agenda grava — e que,
 * sendo o registro da CHAMADA, não provaria escolha mesmo se gravasse. Foi retirado.
 *
 * UMA tabela só: o filtro que traz os passos do banco e o casamento que os lê saem dela, para não divergirem.
 * `resto` (opcional) restringe o que vem depois do prefixo.
 */
interface RegraDePasso {
  prefixo: string;
  resto?: RegExp;
  ferramenta: string;
}
const REGRAS_DE_PASSO: RegraDePasso[] = [
  // "consultar_horarios 2026-11-03 (manhã): 4 confirmado(s)…" — e não "consultar_horarios bloqueado — IA pausada…"
  { prefixo: 'consultar_horarios ', resto: /^\d{4}-\d{2}-\d{2}/, ferramenta: 'consultar_horarios' },
  // houve escolha de dia/horário e a franquia disse não, ou a chamada falhou
  { prefixo: 'agendar_consulta recusado — ', resto: /^\d{2}:\d{2} está /, ferramenta: 'agendar_consulta' },
  { prefixo: 'agendar_consulta recusado — já tem consulta na clínica', ferramenta: 'agendar_consulta' },
  { prefixo: 'agendar_consulta falhou:', ferramenta: 'agendar_consulta' },
  // passos de depois do portão de confirmação (dia + pagamento): o horário estava ocupado por possível cadastro em dobro
  { prefixo: 'agendar_consulta: possível cadastro em dobro', ferramenta: 'agendar_consulta' },
  { prefixo: 'agendar_consulta: ', resto: /^\d{2}:\d{2} ocupado /, ferramenta: 'agendar_consulta' },
  // cadastrar_paciente só chega aqui com horário escolhido e livre; as recusas de ANTES disso (sem horário, data
  // inválida, já passou) não estão na lista
  { prefixo: 'cadastrar_paciente RECUSADO: a franquia não aceita', ferramenta: 'cadastrar_paciente' },
  { prefixo: 'cadastrar_paciente RECUSADO: o telefone', ferramenta: 'cadastrar_paciente' },
  { prefixo: 'cadastrar_paciente: já existia', ferramenta: 'cadastrar_paciente' },
  // `cadastrar_paciente "Maria": ok via…` / `…: falhou`
  { prefixo: 'cadastrar_paciente "', ferramenta: 'cadastrar_paciente' },
  { prefixo: 'confirmar_presenca ', resto: /^\d+:/, ferramenta: 'confirmar_presenca' },
  // "remarcar: trocada|sobra_no_passado|vaga_presa (antiga 5)" — e não "remarcar: recusado (sem_consulta)"
  { prefixo: 'remarcar: ', resto: /^(trocada|sobra_no_passado|vaga_presa) /, ferramenta: 'remarcar_consulta' },
  // "Consulta marcada: …" (IA) e "Consulta marcada na franquia: …" (widget da recepção): alguém marcou, e marcar
  // é o fim do caminho de agendar. Conta como `agendar_consulta`, e NÃO como "consulta marcada agora": o passo é
  // histórico — se a consulta foi cancelada depois, só o vínculo atual (`spineIdSchedule`) diz que ainda existe.
  { prefixo: 'Consulta marcada:', ferramenta: 'agendar_consulta' },
  { prefixo: 'Consulta marcada na franquia:', ferramenta: 'agendar_consulta' },
];
/** Prefixos de título que valem a pena trazer do banco (filtro grosso; o fino é `sinaisDosPassos`). */
export const PREFIXOS_DE_PASSO = [...new Set(REGRAS_DE_PASSO.map((r) => r.prefixo))];

/** O título casa com a regra: começa pelo prefixo e, se a regra restringe o que vem depois, o resto confere. */
function casa(titulo: string, r: RegraDePasso): boolean {
  return titulo.startsWith(r.prefixo) && (!r.resto || r.resto.test(titulo.slice(r.prefixo.length)));
}

/** Lê os passos de uma conversa e diz que ferramentas de agenda a IA (ou a recepção) usou nela. Puro. */
export function sinaisDosPassos(passos: PassoDaConversa[]): { ferramentas: string[] } {
  const ferramentas: string[] = [];
  const anota = (f: string) => {
    if (!ferramentas.includes(f)) ferramentas.push(f);
  };
  for (const p of passos) {
    if (p.kind !== 'TOOL_RESULT' && p.kind !== 'ERROR') continue;
    const regra = REGRAS_DE_PASSO.find((r) => casa(p.title, r));
    if (regra) anota(regra.ferramenta);
  }
  return { ferramentas };
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
