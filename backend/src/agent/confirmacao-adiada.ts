/**
 * A Sofia marcou a consulta de quem tinha acabado de ADIAR a confirmação (Salto, lead 5032777, 25/11/2026, 11:43 UTC).
 *
 * Ela ofereceu quinta 15h, o paciente disse "15:00", deu o nome, perguntou o valor, e ela perguntou "o senhor confirma
 * quinta 26/11 às 15h00?". Ele respondeu "Te confirmo na parte da tarde." — ou seja, ainda não confirmou. O modelo leu
 * como sim: chamou agendar_consulta com diaConfirmado=true e mandou "✅ Agendamento confirmado, Fernando!".
 *
 * `diaConfirmado` é o modelo quem preenche; nada no código conferia que o paciente tinha dito sim. Aqui mora a conferência
 * sobre a fala dele neste turno: se ele adiou ("te confirmo mais tarde", "vou ver e te aviso"), a ferramenta recusa e o modelo
 * responde sem marcar. Mesmo molde de `travarAgendamentoPorComprovante` (ferramenta embrulhada no grafo, estado do turno
 * preenchido pelo nó do agente).
 *
 * CHAVE `confirmacao-adiada` (por unidade; env `CONFIRMACAO_ADIADA_SLUGS`, padrão DESLIGADA):
 *  - `seco`      → decide e REGISTRA no histórico da execução que teria recusado, mas marca como sempre;
 *  - `ligado`    → recusa;
 *  - `desligado` → como sempre.
 *
 * PRINCÍPIO: NA DÚVIDA, MARCA. Recusar quem confirmou custa uma consulta perdida; marcar quem adiou custa uma mensagem de
 * desfazer. Por isso o detector é estreito e a confirmação vence:
 *  - lê UMA MENSAGEM POR VEZ (cada linha do turno); nada atravessa a quebra de linha;
 *  - em cada mensagem, tira o trecho que adia e olha o RESTO: se sobrou "sim", "confirmo", "confirmado", "fechado", "pode ser",
 *    "pode marcar", "marca", "paguei" ou "comprovante", ele confirmou ("Fechado! Vou falar com meu marido pra me levar");
 *  - de uma mensagem para a outra vale a ÚLTIMA decisão: "Vou ver com meu marido" seguido de "Confirmado!" confirma;
 *  - "vou confirmar" SEM um quando não adia, nem "confirmar" + pagamento, Pix, sinal, comprovante ou endereço;
 *  - período seguido de hora ("te confirmo amanhã às 15h") é escolha de horário, não adiamento;
 *  - "te aviso se…", "te falo o nome…", "te respondo sobre o convênio" adiam um DETALHE, não a confirmação;
 *  - LIMITE CONHECIDO: "Sim, vou ver com meu marido e te aviso" (sim + adiar na MESMA mensagem) marca. É o preço de "Sim, quinta 15h. Vou
 *    ver com meu chefe pra sair mais cedo" não perder a consulta; o seco mostra quantos são antes de ligar.
 */
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { TraceRecorder } from './trace-recorder.js';
import { estadoDaAutomacao, type Estado } from '../lib/automacoes-estado.js';

export const ID_CONFIRMACAO_ADIADA = 'confirmacao-adiada';

export function confirmacaoAdiadaEstado(slug: string, raw: string | undefined = process.env.CONFIRMACAO_ADIADA_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_CONFIRMACAO_ADIADA, raw);
}

// Bordas por letra/número: com acento ("amanhã", "à tarde") o `\b` do JS falha.
const E = String.raw`(?<![\p{L}\p{N}_])`;
const D = String.raw`(?![\p{L}\p{N}_])`;

/** Uma HORA logo depois ("às 15h", "15:00", "por volta das 3 horas"): aí o período é a escolha do horário, não um adiamento. */
const HORA_DEPOIS = String.raw`(?![ \t]+(?:(?:[àa]s?|por[ \t]+volta[ \t]+d[ae]s?|pelas?)[ \t]+\d{1,2}|\d{1,2}[ \t]*(?:h|:|horas?)|\d{1,2}[ \t]+da[ \t]+(?:manh[ãa]|tarde|noite)))`;

/**
 * "Quando" do adiamento que não deixa dúvida: "mais tarde", "depois", "daqui a pouco", "em 2 horas", "quando puder".
 * "Confirmo na quinta" / "confirmo à tarde" NÃO entram aqui: podem ser a confirmação do próprio horário.
 */
const QUANDO = String.raw`(?:mais[ \t]+tarde|mais[ \t]+pra[ \t]+frente|depois|logo[ \t]+mais|daqui[ \t]+(?:a[ \t]+)?(?:pouco|\d+|uma?|duas?|alguns?)|em[ \t]+(?:\d+|uma?|duas?|alguns?)[ \t]+(?:minutos?|horas?|dias?)|ainda[ \t]+hoje|hoje[ \t]+mais[ \t]+tarde|quando[ \t]+(?:eu[ \t]+)?(?:puder|der|souber|chegar|ver|sair|conseguir))`;
/** O mesmo, mais o dia/período — só quando é ELE avisando a ELA ("te confirmo na parte da tarde"): o "te" mostra que a resposta é uma promessa. */
const QUANDO_PERIODO = String.raw`(?:${QUANDO}|amanh[ãa]|(?:nesta|nessa|na)[ \t]+semana|na[ \t]+parte[ \t]+d[ae][ \t]+(?:manh[ãa]|tarde|noite)|(?:[àa]|na|no|ao|pela)[ \t]+(?:tarde|noite|manh[ãa])|(?:no|ao)[ \t]+(?:fim|final)[ \t]+d[oae][ \t]+(?:dia|tarde|manh[ãa]))${HORA_DEPOIS}`;

/**
 * O que vem depois de "te aviso/falo/respondo…" e mostra que é um DETALHE que ele vai contar ("te falo o nome", "te aviso se meu filho vai").
 * Depois do "quando" ("depois QUE eu falar com meu marido", "depois DE ver a agenda", "depois DO almoço") a oração é só o quando: não bloqueia.
 */
const DETALHE_DEPOIS_DO_VERBO = String.raw`(?![ \t]+(?:se|sobre|quanto|qual|quais|quem|como|onde|que|o|a|os|as|do|da|dos|das|de|pelo|pela)${D})`;
const DETALHE_DEPOIS_DO_QUANDO = String.raw`(?![ \t]+(?:se|sobre|quanto|qual|quais|quem|como|onde)${D})`;

/** "ver/olhar/conferir/checar" + isto NÃO é adiar a confirmação: é olhar uma coisa concreta ("vou ver o caminho", "vou ver vocês quinta"). */
const OBJETO_CONCRETO = String.raw`(?![ \t]+(?:(?:o|a|os|as|um|uma|meu|minha)[ \t]+)?(?:endere[çc]o|mapa|local|localiza|valor|pre[çc]o|pix|chave|link|exames?|rua|cl[ií]nica|fotos?|v[ií]deos?|site|instagram|whatsapp|n[uú]mero|pagamento|comprovante|caminho|[ôo]nibus|hor[áa]rio\s+d[oe]|voc[eê]s?|vcs?|sinal|boleto|dinheiro)${D})`;

/** Adia: o verbo de responder/avisar + "quando"; ou o verbo de ver/conferir no futuro, que já diz que a resposta não veio. */
const ADIA = new RegExp(
  [
    // "te confirmo mais tarde", "te confirmo na parte da tarde", "te aviso amanhã", "te falo à noite" (não "te confirmo amanhã às 15h")
    `${E}(?:te|lhe|vos)[ \\t]+(?:confirmo|aviso|falo|retorno|respondo|chamo)[ \\t]+(?:aqui[ \\t]+|de[ \\t]+novo[ \\t]+|ainda[ \\t]+)?${QUANDO_PERIODO}${DETALHE_DEPOIS_DO_QUANDO}`,
    // "confirmo depois", "vou confirmar mais tarde", "posso confirmar depois?", "retorno mais tarde", "dou um retorno daqui a pouco"
    `${E}(?:confirmo|confirmar|aviso|avisar|falo|retorno|respondo|responder|chamo|dou[ \\t]+(?:um[ \\t]+)?retorno)[ \\t]+(?:aqui[ \\t]+|de[ \\t]+novo[ \\t]+|ainda[ \\t]+)?${QUANDO}${DETALHE_DEPOIS_DO_QUANDO}`,
    // "depois te falo", "mais tarde te confirmo", "amanhã eu te aviso" (não "amanhã às 15h te aviso")
    `${E}(?:${QUANDO}|amanh[ãa]${HORA_DEPOIS})[ \\t]+(?:eu[ \\t]+)?(?:te[ \\t]+|lhe[ \\t]+)?(?:confirmo|aviso|falo|retorno|respondo|chamo|confirmar|avisar)${DETALHE_DEPOIS_DO_VERBO}${D}`,
    // "vou confirmar com meu marido" (pessoa, não "com vocês")
    `${E}(?:vou|vamos|irei|preciso|tenho[ \\t]+que|tenho[ \\t]+de)[ \\t]+(?:s[oó][ \\t]+|antes[ \\t]+)?confirmar[ \\t]+com[ \\t]+(?:o|a|os|as|meu|minha|ele|ela)${D}`,
    // "vou ver e te aviso", "vou conferir", "vou ver com meu marido", "vou ver aqui", "preciso checar" (não "vou ver o endereço")
    `${E}(?:vou|vamos|irei|preciso|tenho[ \\t]+que|tenho[ \\t]+de)[ \\t]+(?:s[oó][ \\t]+|antes[ \\t]+)?(?:conferir|checar|ver|olhar)${D}${OBJETO_CONCRETO}`,
    // "deixa eu ver", "deixa eu confirmar", "deixa eu pensar"
    `${E}(?:deixa|deixe)[ \\t]+(?:eu|a[ \\t]+gente)[ \\t]+(?:ver|conferir|checar|pensar|olhar)${D}${OBJETO_CONCRETO}`,
    `${E}(?:deixa|deixe)[ \\t]+(?:eu|a[ \\t]+gente)[ \\t]+confirmar[ \\t]+${QUANDO}${D}`,
    // "me dá um tempo", "me dá um tempinho"
    `${E}me[ \\t]+(?:d[áa]|deixa|d[êe])[ \\t]+(?:um[ \\t]+)?(?:tempo|tempinho|momento|prazo)${D}`,
  ].join('|'),
  'giu',
);

/**
 * Sinal de que ELE confirmou, nesta mesma mensagem, no que sobra depois de tirar o trecho que adia: "sim", "confirmo", "confirmado",
 * "fechado", "pode ser", "pode marcar", "marca", "paguei", "comprovante" (e "Confirmar" sozinho, o botão).
 */
const CONFIRMA = new RegExp(
  `${E}(?:sim|confirmo|confirmad[oa]|fechad[oa]|pode[ \\t]+ser|pode[ \\t]+(?:marcar|agendar|reservar|confirmar|fechar)|marca|paguei|comprovante)${D}|^[ \\t]*confirmar[ \\t]*[.!]*[ \\t]*$`,
  'iu',
);

/**
 * A fala do paciente neste turno adia a confirmação? Lê uma mensagem (linha) por vez; vale a última decisão. Devolve o trecho
 * que denunciou, ou null. Marcas de áudio/botão (`[…]:`) são ignoradas.
 */
export function adiouConfirmacao(falaDoPaciente: string | null | undefined): string | null {
  let adiou: string | null = null;
  for (const bruta of (falaDoPaciente ?? '').split(/\r?\n/)) {
    const linha = bruta.replace(/\[[^\]]*\]:?/g, ' ').trim();
    if (!linha) continue;
    const achados = [...linha.matchAll(ADIA)];
    const resto = achados.reduce((txt, m) => txt.replace(m[0], ' '), linha);
    if (CONFIRMA.test(resto)) {
      adiou = null; // ele confirmou (nesta mensagem, ou depois de adiar numa anterior)
      continue;
    }
    if (achados.length > 0) adiou = achados[0][0].slice(0, 80);
  }
  return adiou;
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
 * Embrulha `agendar_consulta`: se o paciente adiou a confirmação neste turno, recusa sem marcar (chave `ligado`) ou só registra
 * que teria recusado (`seco`). `estado` é lido a CADA chamada: ligar/desligar na tela vale sem reconstruir o grafo. `remarcando`
 * não abre a porta (como na trava do comprovante): a remarcação tem a sua própria ferramenta.
 */
export function travarAgendamentoAdiado(
  tools: DynamicStructuredTool[],
  turno: TurnoDaConfirmacao,
  recorder: Pick<TraceRecorder, 'step'>,
  estado: () => Estado,
): DynamicStructuredTool[] {
  for (const tool of tools) {
    if (tool.name !== 'agendar_consulta') continue;
    const original = tool.func.bind(tool);
    tool.func = async (args: unknown, ...resto: unknown[]) => {
      const modo = estado();
      if (modo === 'desligado' || !turno.adiou) return original(args as never, ...(resto as never[]));
      if (modo === 'seco') {
        await recorder.step({
          kind: 'THINKING',
          title: `🧪 [só no papel] agendar_consulta teria recusado — o paciente adiou a confirmação ("${turno.adiou.slice(0, 60)}")`,
          payload: { trecho: turno.adiou, args },
        });
        return original(args as never, ...(resto as never[]));
      }
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
