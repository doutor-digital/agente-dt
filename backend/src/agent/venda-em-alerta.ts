/**
 * "Sobrou venda?" para o turno de alerta (sinal de alerta, #143).
 *
 * Quando o corte do pronto-socorro deixa a resposta de pé num turno de aviso urgente, o que sobrou não pode vender:
 * valor, horário oferecido, ou o convite para marcar. Se sobrou, a resposta inteira vira a frase do passe. Errar para o
 * lado de trocar é seguro (o paciente em alerta recebe o aviso); errar para o outro lado é vender a quem está mal — mas
 * a pergunta clínica ("começou às 7h?", "há 3h?", "desde 20/10?", "consegue andar?") tem de atravessar, senão o
 * aviso vira sempre a mesma frase.
 */
import { ANTES_DE_DURACAO, HORA, OFERTA_DE_HORARIO, quebrarEmFrases } from './horario-oferecido.js';

/** Fronteira de palavra que funciona antes de letra acentuada (o \b do JS não funciona antes de "à"). */
const INI = String.raw`(?<![\p{L}\p{N}])`;
const FIM = String.raw`(?![\p{L}\p{N}])`;

/** "R$ 150", "150 reais", "150,00", "cento e cinquenta", "duzentos". */
const VALOR = new RegExp(
  [
    String.raw`R\$`,
    // qualquer "reais" é dinheiro: "150 reais", "mil reais", "duzentos e cinquenta reais"
    String.raw`${INI}reais${FIM}`,
    String.raw`${INI}\d{2,4},\d{2}${FIM}`,
    String.raw`${INI}(?:pilas?|cento|duzent[oa]s?|trezent[oa]s?|quatrocent[oa]s?|quinhent[oa]s?)${FIM}`,
  ].join('|'),
  'iu',
);

/**
 * Verbo/termo de venda e de agendamento. Formas escolhidas uma a uma: "marca roxa" e "marcha" não são venda, "segurar a
 * urina" também não; "marcá-la", "agendá-lo" e "reservá-la" são.
 */
const VENDA = new RegExp(
  `${INI}(?:` +
    [
      String.raw`(?:re)?(?:marc|agend|reserv|encaix)(?:ar|á-\w+|ar[eéi]\w*|amos|ad[oa]s?|ue|e|ou|ei)`, // sem "o": "Marco" é nome de paciente
      String.raw`(?:re)?marqu(?:e|ei|emos)`,
      String.raw`agenda|agendamentos?|reservas?`,
      String.raw`garant(?:ir|i-\w+|o|imos|id[oa]s?)`,
      String.raw`vagas?`,
      String.raw`disponibilidade`,
      String.raw`pix`,
      // preço sem "R$": "fica 150", "à vista", "parcelado", "desconto", "o valor"
      String.raw`(?:fica|sai|custa|vale)\s+(?:por\s+)?\d{2,4}(?!\d|\s*(?:min|hora|h\b|dia|seman|m[eê]s|ano|vez|cm|kg|graus|%|:))`,
      String.raw`[àa]\s+vista|parcel\w+|desconto|pre[cç]os?|valor(?:es)?`,
      // convite: "quer vir", "pode vir", "quer ver um horário", "quer que eu veja os horários/as opções"
      String.raw`(?:quer|pode|consegue|gostaria\s+de|prefere)\s+vir`,
      String.raw`quer\s+(?:ver|garantir|marcar|agendar)`,
      String.raw`quer\s+que\s+eu\s+(?:veja|confira|consulte|procure|encontre|te\s+(?:mostre|passe|envie|mande))\s+(?:\p{L}+\s+){0,2}(?:hor[aá]rios?|op[cç][oõ]es|vagas?|dias?|datas?|valores?)`,
      String.raw`posso\s+ver\s+(?:um|o|os|as|algum|alguns)\s+(?:\p{L}+\s+)?(?:hor[aá]rios?|op[cç][oõ]es|vagas?)`,
      String.raw`posso\s+(?:garantir|te\s+(?:mostrar|passar|mandar|enviar|encaixar))`,
      // outros convites de fechamento: "te interessa?", "tem espaço", "consigo te atender", "deixo separado", "link de pagamento"
      String.raw`te\s+interessa|tem\s+espa[cç]o|consigo\s+te\s+atender|deixo\s+(?:separad|reservad|garantid)\w*|pagamento|primeiro\s+passo|fica\s+bom\s+(?:pra|para)\s+voc[eê]`,
      String.raw`campanha|promo[cç][aã]o|aproveit\w+`,
    ].join('|') +
    `)${FIM}`,
  'iu',
);

/** Dia ou data na frase: com um convite ("tenho", "fica melhor", "que tal") vira oferta de horário. "qua." chega aqui sem o ponto. */
const DIA_OU_DATA = new RegExp(
  `${INI}(?:amanh[ãa]|hoje|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|seg|ter|qua|qui|sex|s[áa]b|dom)${FIM}|${INI}\\d{1,2}/\\d{1,2}${FIM}`,
  'iu',
);
const PALAVRA_HORARIO = new RegExp(`${INI}hor[áa]rios?${FIM}`, 'iu');
/** A frase é pergunta de triagem sobre o sintoma: "Em qual horário a dor fica pior?" não oferece horário. */
const TRIAGEM_DO_SINTOMA = /\b(?:d[oó]i|dor|piora\w*|pior|sente\w*|sintomas?|formig\w+)\b/i;
/** Aviso de que a equipe vai ligar/responder: "ela te responde amanhã às 8h", "prefere que a equipe ligue hoje ou amanhã?" */
const AVISO_DA_EQUIPE = /\b(?:liga|ligar|ligue|ligamos|ligo|ligamo|responde|respondem|chama|chamar|retorna|retornar|retorne|contato|procura)\b/i;

/**
 * O paciente (ou a pergunta) contando quando começou ou o que fez: "desde quarta às 7h", "a dor aumentou hoje às 15h",
 * "ontem às 22h a perna estava fraca". Só vale para dia+hora SEM convite escrito; "dor"/"equipe" soltos NÃO isentam
 * ("quarta às 9h a doutora avalia a sua dor" é venda).
 */
const RELATO_DE_INICIO =
  /\b(?:desde|come[cç]ou|inici(?:ou|ei)|piorou|aumentou|acord(?:ou|ei)|sentiu|sentia|apareceu|estava|estavam|ficou|tomou|conseguiu|ontem)\b/i;

// "às 9" (com crase) é hora; "as 2 pernas" não: sem a crase só vale com h, : ou "horas".
const AS_N = new RegExp(`${INI}(?:às\\s+(\\d{1,2})(?::(\\d{2})|h(\\d{2})?|\\s*horas?)?|as\\s+(\\d{1,2})(?::(\\d{2})|h(\\d{2})?|\\s+horas?))${FIM}`, 'giu');

/** Horas de relógio na frase (0-23h, 0-59min); "há 3h", "48h", "últimas 24h" são duração e não entram. */
function horasDeRelogio(frase: string): number {
  let n = 0;
  for (const m of frase.matchAll(HORA)) {
    const antes = frase.slice(0, m.index ?? 0);
    const hora = Number(m[1]);
    const min = Number(m[2] ?? m[3] ?? 0);
    if (hora > 23 || min > 59 || ANTES_DE_DURACAO.test(antes.slice(-20))) continue;
    n++;
  }
  for (const m of frase.matchAll(AS_N)) {
    const hora = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[3] ?? m[5] ?? m[6] ?? 0);
    if (hora <= 23 && min <= 59) n++;
  }
  return n;
}

export function sobrouVenda(texto: string): boolean {
  // "Tenho qua. às 9h": o ponto da abreviatura não encerra a frase
  const t = texto.replace(/(?<![\p{L}])(seg|ter|qua|qui|sex|s[áa]b|dom)\./giu, '$1');
  if (VALOR.test(t) || VENDA.test(t)) return true;
  for (const { frase } of quebrarEmFrases(t)) {
    const relogio = horasDeRelogio(frase) > 0;
    const temDia = DIA_OU_DATA.test(frase);
    if (AVISO_DA_EQUIPE.test(frase)) continue;
    // "Tenho quarta às 9h", "pode ser amanhã?", "que tal esse horário?"
    if (OFERTA_DE_HORARIO.test(frase) && (temDia || relogio || (PALAVRA_HORARIO.test(frase) && !TRIAGEM_DO_SINTOMA.test(frase)))) return true;
    // "quarta às 9h", "dia 12/11 às 9" sem convite escrito, a menos que seja o relato do paciente
    if (temDia && relogio && !RELATO_DE_INICIO.test(frase)) return true;
  }
  return false;
}

/**
 * A resposta do modelo CONFIRMA ao paciente algo que a ferramenta fez neste turno e que ele não pode deixar de ler: presença
 * confirmada, consulta cancelada, ou "já tem consulta marcada" (a equipe marcou). Juntamente com `marcouNesteTurno` (marcada /
 * remarcada), isenta a resposta de virar a frase do passe.
 */
const CONFIRMA_AO_PACIENTE = /^(?:Presença confirmada para|Consulta de [^\n]{1,80}? cancelada\.|RECUSADO: este paciente já tem consulta)/;
export function confirmouConsultaNoTurno(resultadosDasFerramentas: ReadonlyArray<string>): boolean {
  return resultadosDasFerramentas.some((r) => CONFIRMA_AO_PACIENTE.test(String(r ?? '').trim()));
}
