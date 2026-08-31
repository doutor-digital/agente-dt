/**
 * Diz à IA, a cada turno, o que ainda falta para conseguir marcar a consulta.
 *
 * O buraco que isto tapa apareceu numa conversa real (Núbia, Boa Vista, 29/08):
 * a Sofia perguntou sobre perda de força, a paciente respondeu outra coisa, e
 * ela seguiu adiante como se tivesse sido respondida — a pergunta que decide se
 * o caso é emergência ficou sem resposta a conversa inteira. No mesmo
 * atendimento ela perguntou "onde dói e há quanto tempo", recebeu outra coisa,
 * e pulou pra pergunta seguinte: a conversa ficou uma pergunta atrasada até o
 * fim.
 *
 * A causa é simples: ela sabe o que já foi dito (tem memória), mas nada lhe diz
 * o que FALTA. Uma lista curta e explícita no prompt resolve, e é barata: sai
 * dos fatos que ela mesma já grava.
 *
 * Cada item aceita vários nomes de fato porque a IA inventa a chave na hora —
 * em produção convivem `queixa`, `queixa_principal`, `dor` e `localizacao_dor`
 * para a mesma informação, e `agendou` com `consulta_marcada`. Casar por nome
 * exato deixaria a lista mentindo que falta algo que já existe.
 */

export type Fatos = Record<string, unknown>;

/** Sinais que exigem a pergunta de triagem antes de seguir vendendo. */
const SINAL_NEUROLOGICO = /dorm[êe]nc|formigament|fraquez|perda de for[çc]a|sem for[çc]a|n[ãa]o consegue andar/i;

/** Fatos que registram a resposta do paciente sobre força/bexiga/intestino. */
const CHAVES_RED_FLAG = ['red_flag', 'redflag', 'perda_forca', 'perda_de_forca', 'bexiga', 'intestino', 'sinal_alerta'];

interface Item {
  rotulo: string;
  chaves: string[];
  comoPedir: string;
}

const CHECKLIST: Item[] = [
  { rotulo: 'nome', chaves: ['nome'], comoPedir: 'pergunte como pode chamá-lo' },
  {
    rotulo: 'queixa',
    chaves: ['queixa', 'queixa_principal', 'dor', 'localizacao_dor', 'localizacao'],
    comoPedir: 'pergunte onde dói',
  },
  { rotulo: 'tempo de dor', chaves: ['tempo_dor', 'tempo_de_dor'], comoPedir: 'pergunte há quanto tempo' },
  { rotulo: 'cidade', chaves: ['cidade', 'localizacao'], comoPedir: 'confirme a cidade dele' },
  {
    rotulo: 'horário escolhido',
    chaves: ['preferencia_horario', 'horario_preferido', 'horario_escolhido'],
    comoPedir: 'consulte a agenda e ofereça 2 ou 3 horários',
  },
];

const CHAVES_AGENDOU = ['agendou', 'consulta_marcada', 'consulta_agendada'];

function temAlgum(fatos: Fatos, chaves: string[]): boolean {
  return chaves.some((k) => {
    const v = fatos[k];
    return v !== null && v !== undefined && String(v).trim() !== '';
  });
}

function jaAgendou(fatos: Fatos): boolean {
  return CHAVES_AGENDOU.some((k) => /sim|true|1/i.test(String(fatos[k] ?? '')));
}

/**
 * Monta o bloco. Devolve string vazia quando não há nada a cobrar — prompt que
 * repete o óbvio a cada turno vira ruído e o modelo passa a ignorar o bloco.
 */
export function renderFaltaParaAgendar(fatos: Fatos | null | undefined): string {
  const f = fatos ?? {};
  if (Object.keys(f).length === 0) return '';
  if (jaAgendou(f)) return '';

  const faltando = CHECKLIST.filter((i) => !temAlgum(f, i.chaves));

  // Sinal neurológico sem resposta registrada é o item mais urgente da lista:
  // é ele que separa "caso comum" de "emergência", e foi exatamente o que se
  // perdeu quando a paciente respondeu outra coisa e a IA seguiu em frente.
  const textoQueixa = CHECKLIST[1].chaves.map((k) => String(f[k] ?? '')).join(' ');
  const precisaTriagem = SINAL_NEUROLOGICO.test(textoQueixa) && !temAlgum(f, CHAVES_RED_FLAG);

  // Não há saída antecipada aqui de propósito: "já tem tudo e ainda não marcou"
  // é justamente a hora de empurrar o fechamento, não de calar. Quem já agendou
  // saiu lá em cima.
  const linhas: string[] = [];
  if (precisaTriagem) {
    linhas.push(
      '- **ANTES DE QUALQUER COISA:** ele relatou dormência ou fraqueza e você ainda NÃO tem a ' +
        'resposta sobre perda de força / controle de xixi e intestino. Pergunte e **espere a ' +
        'resposta**. Se ele responder outra coisa, repita a pergunta com gentileza — não siga sem ela.',
    );
  }
  if (faltando.length > 0) {
    linhas.push('- Ainda falta, nesta ordem: ' + faltando.map((i) => i.rotulo).join(' → ') + '.');
    linhas.push(`- Próximo passo: ${faltando[0].comoPedir}. Uma pergunta por mensagem.`);
  } else {
    linhas.push('- Você já tem tudo para marcar. Ofereça o horário e feche a reserva.');
  }

  return `<falta_para_agendar>\n(o que impede esta conversa de virar consulta)\n${linhas.join('\n')}\n</falta_para_agendar>`;
}
