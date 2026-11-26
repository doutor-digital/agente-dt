/**
 * A Sofia marcou a consulta de quem tinha acabado de ADIAR a confirmação (Salto, lead 5032777, 25/11/2026, 11:43 UTC).
 *
 * Ela ofereceu quinta 15h, o paciente disse "15:00", deu o nome, perguntou o valor, e ela perguntou "o senhor confirma
 * quinta 26/11 às 15h00?". Ele respondeu "Te confirmo na parte da tarde." — ou seja, ainda não confirmou. O modelo leu
 * como sim: chamou agendar_consulta com diaConfirmado=true e mandou "✅ Agendamento confirmado, Fernando!".
 *
 * `diaConfirmado` é o modelo quem preenche; nada no código conferia que o paciente tinha dito sim. Aqui mora a conferência
 * sobre a fala dele neste turno: se ele adiou ("te confirmo depois", "vou ver e te aviso", "vou confirmar"), a ferramenta
 * recusa e o modelo responde sem marcar. Mesmo molde de `travarAgendamentoPorComprovante` (ferramenta embrulhada no grafo,
 * estado do turno preenchido pelo nó do agente).
 *
 * Regra de ouro: "Confirmo" sozinho e "pode confirmar" NÃO são adiamento. Na dúvida, deixa marcar: o que se mede é o adiamento
 * dito com todas as letras (verbo de confirmar/avisar/ver no futuro, ou "confirmo" + quando).
 */
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { TraceRecorder } from './trace-recorder.js';

// Bordas por letra/número: com acento ("amanhã", "à tarde") o `\b` do JS falha.
const E = String.raw`(?<![\p{L}\p{N}_])`;
const D = String.raw`(?![\p{L}\p{N}_])`;

/**
 * "Quando" do adiamento que não deixa dúvida: "mais tarde", "depois", "daqui a pouco", "em 2 horas", "quando puder".
 * "Confirmo amanhã às 15h", "confirmo na quinta" e "confirmo à tarde" NÃO entram aqui: podem ser a confirmação do próprio horário
 *
 */
const QUANDO = String.raw`(?:mais\s+tarde|mais\s+pra\s+frente|depois|logo\s+mais|daqui\s+(?:a\s+)?(?:pouco|\d+|uma?|duas?|alguns?)|em\s+(?:\d+|uma?|duas?|alguns?)\s+(?:minutos?|horas?|dias?)|ainda\s+hoje|hoje\s+mais\s+tarde|quando\s+(?:eu\s+)?(?:puder|der|souber|chegar|ver|sair|conseguir))`;
/** O mesmo, mais o período do dia — só quando é ELE avisando a ELA ("te confirmo na parte da tarde"): o "te" mostra que a resposta é uma promessa. */
const QUANDO_PERIODO = String.raw`(?:${QUANDO}|amanh[ãa]|(?:nesta|nessa|na)\s+semana|na\s+parte\s+d[ae]\s+(?:manh[ãa]|tarde|noite)|(?:[àa]|na|no|ao|pela)\s+(?:tarde|noite|manh[ãa])|(?:no|ao)\s+(?:fim|final)\s+d[oae]\s+(?:dia|tarde|manh[ãa]))`;

/** Adia: o verbo de responder/avisar + "quando"; ou o verbo de ver/conferir no futuro, que já diz que a resposta não veio. */
const ADIA = new RegExp(
  [
    // "te confirmo mais tarde", "te confirmo na parte da tarde", "te aviso amanhã", "te falo à noite"
    `${E}(?:te|lhe|vos)\\s+(?:confirmo|aviso|falo|retorno|respondo|chamo)\\s+(?:aqui\\s+|de\\s+novo\\s+|ainda\\s+)?${QUANDO_PERIODO}${D}`,
    // "confirmo depois", "posso confirmar mais tarde?", "retorno mais tarde", "dou um retorno amanhã"
    `${E}(?:confirmo|confirmar|aviso|avisar|falo|retorno|respondo|responder|chamo|dou\\s+(?:um\\s+)?retorno)\\s+(?:aqui\\s+|de\\s+novo\\s+|ainda\\s+)?${QUANDO}${D}`,
    // "depois te falo", "mais tarde te confirmo", "amanhã eu te aviso", "depois eu confirmo"
    `${E}${QUANDO_PERIODO}\\s+(?:eu\\s+)?(?:te\\s+|lhe\\s+)?(?:confirmo|aviso|falo|retorno|respondo|chamo|confirmar|avisar)${D}`,
    // "vou confirmar", "vou ver e te aviso", "vou conferir", "vou checar", "vou ver com meu marido", "vou ver aqui"
    `${E}(?:vou|vamos|irei|preciso|tenho\\s+que|tenho\\s+de)\\s+(?:s[oó]\\s+|antes\\s+)?(?:confirmar|falar\\s+com|perguntar\\s+(?:pra|para|ao|a)|consultar|combinar\\s+com|(?:conferir|checar|ver|olhar)(?!\\s+(?:o|a|os|as|um|uma)\\s+(?:endere[çc]o|mapa|local|localiza|valor|pre[çc]o|pix|chave|link|exames?|rua|cl[ií]nica|fotos?|v[ií]deos?|site|instagram|whatsapp|n[uú]mero)))${D}`,
    // "deixa eu ver", "deixa eu confirmar", "deixa eu falar com meu marido"
    `${E}(?:deixa|deixe)\\s+(?:eu|a\\s+gente)\\s+(?:ver|confirmar|conferir|checar|falar|pensar|olhar|combinar)${D}`,
    // "me dá um tempo", "só um minutinho pra ver"
    `${E}me\\s+(?:d[áa]|deixa|d[êe])\\s+(?:um\\s+)?(?:tempo|tempinho|momento|prazo)${D}`,
  ].join('|'),
  'iu',
);

/**
 * Sinal claro de que ele confirmou agora, na mesma fala ("pode marcar, só vou ver o pagamento depois", "confirmo sim"). "Combinado" e "fechado" ficam de fora: "Combinado, te confirmo mais tarde" é adiamento:
 * adiar o pagamento ou um detalhe junto com um sim não é adiar a confirmação. Na dúvida, vale como antes (a consulta marca).
 */
const CONFIRMA = new RegExp(
  `${E}(?:pode\\s+(?:marcar|agendar|reservar|confirmar|fechar)|confirmo\\s+sim)${D}`,
  'iu',
);

/**
 * A fala do paciente neste turno adia a confirmação? Só o texto dele (o grafo passa as mensagens do turno juntas), sem marcas
 * de áudio ou botão. Devolve o trecho que denunciou, ou null.
 */
export function adiouConfirmacao(falaDoPaciente: string | null | undefined): string | null {
  const fala = (falaDoPaciente ?? '').replace(/\[[^\]]*\]:?/g, ' ').trim();
  if (!fala) return null;
  const m = ADIA.exec(fala);
  if (!m) return null;
  if (CONFIRMA.test(fala)) return null;
  return m[0].slice(0, 80);
}

/** O que o modelo lê quando a ferramenta recusa — mesmo molde do `porQueNaoReservar`: "NÃO marcada ainda", o que fazer, sem culpar ninguém. */
export function textoDaRecusaAdiada(trecho: string): string {
  return (
    'Consulta NÃO marcada. O paciente NÃO confirmou: ele deixou a confirmação para depois ' +
    `("${trecho.slice(0, 60)}"). Não chame agendar_consulta e NÃO diga que está confirmado, agendado nem reservado. ` +
    'Responda curto e sem pressão: tudo bem, ele pode confirmar quando puder, é só avisar por aqui (se o horário pode ser ocupado ' +
    'até lá, diga que a agenda enche). Quando ele disser que confirma, aí sim marque.'
  );
}

/** Estado do turno: o nó do agente preenche a cada volta; a ferramenta lê. */
export interface TurnoDaConfirmacao {
  /** O trecho em que o paciente adiou neste turno, ou null. */
  adiou: string | null;
}

/**
 * Embrulha `agendar_consulta`: se o paciente adiou a confirmação neste turno, recusa sem marcar. `remarcando` não abre a porta
 * (como na trava do comprovante): a remarcação tem a sua própria ferramenta.
 */
export function travarAgendamentoAdiado(
  tools: DynamicStructuredTool[],
  turno: TurnoDaConfirmacao,
  recorder: Pick<TraceRecorder, 'step'>,
): DynamicStructuredTool[] {
  for (const tool of tools) {
    if (tool.name !== 'agendar_consulta') continue;
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      if (!turno.adiou) return original(args as never, ...(resto as never[]));
      await recorder.step({
        kind: 'ERROR',
        title: 'agendar_consulta recusado — o paciente adiou a confirmação',
        payload: { trecho: turno.adiou, args },
      });
      return textoDaRecusaAdiada(turno.adiou);
    };
  }
  return tools;
}
