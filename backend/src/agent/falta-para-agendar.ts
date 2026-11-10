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

/**
 * Sinais que exigem a pergunta de triagem antes de seguir vendendo.
 * Formigamento comum (perna, braço) SOZINHO não entra (10/11/2026) — na virilha/região íntima entra (FORMIGAMENTO_PERIGOSO): a regra <sinal_de_alerta> (decisão do João, 26/10) diz que dor que desce
 * para a perna ou formigamento, sozinhos, NÃO são sinal de alerta — e esta lista mandava perguntar mesmo assim, a cada turno.
 */
const SINAL_NEUROLOGICO = /dorm[êe]nc|fraquez|perda de for[çc]a|sem for[çc]a|n[ãa]o consegue andar/i;
/** Formigamento só dispara quando vem na virilha / região íntima / entre as pernas / períneo (sinal de cauda equina). */
const FORMIGAMENTO_PERIGOSO =
  /formigament\w*[^.;\n]{0,40}(?:virilha|[íi]ntim|entre as pernas|per[íi]neo|genita|[aâ]nus|\bsela\b)|(?:virilha|[íi]ntim|entre as pernas|per[íi]neo|genita|[aâ]nus|\bsela\b)[^.;\n]{0,40}formigament/i;

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
export function renderFaltaParaAgendar(
  fatos: Fatos | null | undefined,
  opcoes: { semPedirNome?: boolean } = {},
): string {
  const f = fatos ?? {};
  if (Object.keys(f).length === 0) return '';
  if (jaAgendou(f)) return '';

  // Já pediu o nome 2 vezes (repeticao.ts): a lista não pode continuar mandando "pergunte como pode chamá-lo" a
  // cada turno — era isso que fazia a Sofia pedir o nome 3, 4, 5 vezes a quem ignorava a pergunta.
  const faltando = CHECKLIST.filter((i) => !temAlgum(f, i.chaves)).filter(
    (i) => !(opcoes.semPedirNome && i.rotulo === 'nome'),
  );

  // Sinal neurológico sem resposta registrada é o item mais urgente da lista:
  // é ele que separa "caso comum" de "emergência", e foi exatamente o que se
  // perdeu quando a paciente respondeu outra coisa e a IA seguiu em frente.
  const textoQueixa = CHECKLIST[1].chaves.map((k) => String(f[k] ?? '')).join(' ');
  const precisaTriagem =
    (SINAL_NEUROLOGICO.test(textoQueixa) || FORMIGAMENTO_PERIGOSO.test(textoQueixa)) && !temAlgum(f, CHAVES_RED_FLAG);

  // Não há saída antecipada aqui de propósito: "já tem tudo e ainda não marcou"
  // é justamente a hora de empurrar o fechamento, não de calar. Quem já agendou
  // saiu lá em cima.
  const linhas: string[] = [];
  if (precisaTriagem) {
    linhas.push(
      // 10/11/2026: antes dizia "se ele responder outra coisa, repita a pergunta — não siga sem ela", o contrário da
      // regra <sinal_de_alerta> (26/10: "nunca repita a pergunta de segurança uma segunda vez — quem não respondeu
      // direito vai para a equipe"). Nos testes da Sofia 2.0 ela perguntava a mesma coisa 3 vezes e travava a venda.
      '- **ANTES DE QUALQUER COISA:** ele relatou dormência ou fraqueza e você ainda NÃO tem a ' +
        'resposta sobre perda de força / controle de xixi e intestino. Se você AINDA NÃO perguntou: pergunte ' +
        'UMA coisa por vez (primeiro a força, depois o xixi e o intestino) e **espere a resposta**. Um "sim" ' +
        'solto a uma pergunta com as duas coisas não confirma nada: pergunte qual. Se você JÁ perguntou e ele ' +
        'respondeu outra coisa, NÃO repita a pergunta: siga a regra <sinal_de_alerta> — quem não respondeu à ' +
        'pergunta de segurança vai para a equipe (resumir_lead_para_sdr e pausar_ia com sinalDeAlerta: true).',
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
