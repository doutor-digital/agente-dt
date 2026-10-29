/**
 * Taxa de reserva (Boa Vista): a chave Pix sai por CÓDIGO, e nenhum horário é dado como garantido sem o comprovante.
 *
 * Caso medido (27–28/10/2026, cartão da Boa Vista, `spine_booking_requires_payment`):
 *  - a paciente pediu o Pix duas vezes ("E o pix", "Mande o pix por gentileza") e a Sofia respondeu "a equipe te envia a
 *    chave" — a recusa de `agendar_consulta` (RECUSA_SEM_COMPROVANTE_DA_TAXA) e o prompt já mandavam enviar a chave e
 *    pedir o comprovante, e o modelo ignorou as duas. A chave só chegou no dia seguinte, pela equipe;
 *  - sem consulta no CRM e sem comprovante, a Sofia disse "já deixei tudo registrado com a equipe", "até já às 13h30" e
 *    "já está tudo certo com o seu horário". As travas de `confirmacao-so-com-crm.ts` só valem com comprovante no turno
 *    ou com o bloco do prompt dizendo "DESMARCADA": esta situação ficava de fora.
 *
 * Aqui mora a decisão de código (prompt não segura o modelo): só em unidade com a flag, com chave Pix e valor da taxa
 * cadastrados, a saída final é trocada por um recado fixo que traz a chave, o titular, o valor e o pedido de comprovante.
 * Sem chave ou sem valor NADA é escrito: o comportamento de antes fica (nunca inventar dado).
 *
 * Puro: o grafo passa o que já sabe (falas do turno, prova de consulta, comprovante) e recebe o texto novo ou null.
 */
import type { Unit } from '@prisma/client';
import { normalizar, trechos } from '../lib/prometeu-sem-marcar.js';
import { afirmaConfirmacao, comprovantesDoTexto, NAO_AFIRMA_CONFIRMACAO, QUANDO_HORARIO } from './confirmacao-so-com-crm.js';
import { fmtBRL, precosDaConsulta } from './prompt-composer.js';
import { semOTrecho } from './reserva-sem-marcar.js';

export interface DadosDaTaxa {
  /** copiada exatamente do cadastro da unidade (só aparam-se as pontas) */
  chave: string;
  titular: string | null;
  /** o valor da taxa de agendamento, de `precosDaConsulta().antecipado` */
  valor: number;
}

/** Só a unidade com taxa de reserva obrigatória, chave Pix E valor cadastrados. Faltou um: null (nada é escrito). */
export function dadosDaTaxa(
  unit: Pick<Unit, 'spineBookingRequiresPayment' | 'pixKey' | 'pixHolder' | 'sourceProdutos' | 'systemPrompt'>,
): DadosDaTaxa | null {
  if (!unit.spineBookingRequiresPayment) return null;
  const chave = unit.pixKey?.trim();
  const valor = precosDaConsulta(unit)?.antecipado;
  if (!chave || !valor || !(valor > 0)) return null;
  return { chave, titular: unit.pixHolder?.trim() || null, valor };
}

// --- O que o paciente disse neste turno ---------------------------------------------------------------------------------

/** A leitura de foto/PDF é do paciente só no nome: "COMPROVANTE: Pix de R$ 100" não é pedido de chave. */
const LEITURA_DE_ARQUIVO = /\[(?:imagem|arquivo) do cliente\]:[\s\S]*/gi;
/**
 * Já pagou, acabou de mandar, não quer, ou está comparando formas de pagar ("posso pagar no dia ou preciso do pix?"):
 * não é pedido de chave. "Paguei"/"fiz" soltos NÃO excluem: "me passa a chave que eu pago e mando o comprovante" pede.
 */
const NAO_E_PEDIDO =
  /\bja (?:fiz|paguei|mandei|enviei|transferi|foi)\b|\bacabei de\b|\bsegue\b|\bnao (?:tenho|quero|uso|vou|consigo|posso|aceito|preciso)\b[^.?!]{0,20}\b(?:pix|chave|antecip)|\b(?:ou|em vez d[eo]|ao inves d[eo])\s+(?:\S+\s+){0,2}?(?:pix|chave)\b|\b(?:pix|chave)\s+(?:\S+\s+){0,2}?ou\b/;
/** Pedido EXPLÍCITO da chave: vale sempre, mesmo para quem acabou de recebê-la (não viu, perdeu a mensagem). */
const PEDE_A_CHAVE = [
  // "e o pix" (o "e" abre a frase: "aceita débito e pix?" não é pedido), "qual a chave", "cadê o pix"
  /(?:^|[.!?,;]\s*)e\s+(?:o|a|esse|essa)?\s*(?:chave|pix)\b/,
  /\b(?:qual|cade|onde)\s+(?:e\s+)?(?:o|a|esse|essa)?\s*(?:chave|pix)\b/,
  // "manda o pix", "me envia a chave", "pode me passar o pix" (o objeto vem logo depois do verbo)
  // sem vírgula no meio e sem outro assunto entre o verbo e o Pix: "me passa o endereço, aceita pix?" e "pode passar o preço do pix" não pedem a chave
  /\b(?:manda|mande|mandar|envia|envie|enviar|passa|passe|passar)\b(?:(?!\b(?:valor|preco|endereco|horario|quanto|desconto|informacoes?|dados)\b)[^.?!,]){0,15}\b(?:pix|chave)\b/,
  // "quero o pix", "preciso da chave" — colado ao verbo: "quero saber o valor do pix" e "quero pagar com cartão ou pix" não são pedido
  /\b(?:quero|preciso|gostaria)\s+(?:d[oa]s?\s+|[oa]s?\s+)?(?:chave|pix)\b/,
  // "pix por favor", "chave pfv"
  /\b(?:pix|chave)\b[^.?!]{0,15}\b(?:por favor|pfv|pf|por gentileza)\b/,
  // só "pix" / "a chave?"
  /^(?:o |a )?(?:chave )?(?:pix|chave)[?!. ]*$/,
];
/**
 * Anuncia que vai pagar no Pix ("vou pagar no pix", "prefiro pagar com pix"): pede a chave de quem ainda não a tem, mas quem
 * ACABOU de recebê-la está respondendo ("ok, vou pagar no pix agora") — reenviar o recado inteiro seria repetir a mensagem.
 */
const ANUNCIA_O_PIX = /\b(?:vou|quero|prefiro|pode ser|opto|escolho)\s+(?:pagar\s+)?(?:no|com|via|por|pelo)\s+(?:o\s+)?pix\b/;
/** Escolheu pagar antes: "vou pagar o pix antecipado", "prefiro antecipado", ou só "Pix antecipado" (a resposta do botão). */
const ESCOLHE_ANTECIPADO = [
  /\b(?:vou|quero|prefiro|pode ser|opto|escolho|fecho)\b[^.?!]{0,20}\b(?:antecipad|pagar (?:agora|antes|ja|hoje))/,
  /^(?:no |o )?(?:pix )?antecipad[oa]?[ .!]*$/,
  /^pix antecipad[oa]?\b/,
];

/**
 * O paciente pediu a chave Pix, ou escolheu pagar antes, em alguma das falas DESTE turno.
 * `soPedidoExplicito`: a chave já foi enviada (ou ele já pagou) — aí só vale o pedido explícito ("e o pix?", "qual a chave?"),
 * não o aviso de que vai pagar ("ok, vou pagar no pix agora", "Pix antecipado").
 */
export function pacientePediuAChave(falasDoTurno: ReadonlyArray<string>, opcoes: { soPedidoExplicito?: boolean } = {}): boolean {
  return falasDoTurno.some((fala) => {
    const n = normalizar(String(fala ?? '').replace(LEITURA_DE_ARQUIVO, ' '));
    if (!n || NAO_E_PEDIDO.test(n)) return false;
    if (PEDE_A_CHAVE.some((r) => r.test(n))) return true;
    return !opcoes.soPedidoExplicito && (ANUNCIA_O_PIX.test(n) || ESCOLHE_ANTECIPADO.some((r) => r.test(n)));
  });
}

/**
 * Escolheu pagar na clínica ("Só pago na hora tudo", "Na clínica", "pago no dia"). Em unidade com taxa de reserva isso NÃO
 * dispensa a taxa: o horário só fica separado com ela. Vale a pergunta também ("posso pagar tudo lá?"): a resposta é a mesma.
 */
const PAGA_NA_CLINICA = [
  /\bpag(?:o|ar|arei|aria)\b[^.?!]{0,25}\b(?:na hora|no dia|na clinica|na consulta|no local|presencial)\b/,
  /\bpag(?:o|ar|arei)\s+la\b/,
  /\b(?:na clinica|no dia|na hora)\b[^.?!]{0,15}\b(?:pago|pagar|pagarei|pagamento)\b/,
];
/** A fala INTEIRA é só o lugar ("Na clínica", "só no dia"): numa frase solta no meio ("Ok. No dia.") é resposta a outra pergunta. */
const SO_O_LUGAR = /^(?:so |apenas )?(?:na clinica|no dia|na hora)(?: mesmo)?[ .!]*$/;

/** O paciente quer pagar só na clínica. Quem pediu a chave ou escolheu o antecipado NÃO entra (o pedido manda). */
export function pacienteQuerPagarNaClinica(falasDoTurno: ReadonlyArray<string>): boolean {
  if (pacientePediuAChave(falasDoTurno)) return false;
  return falasDoTurno.some((fala) => {
    const n = normalizar(String(fala ?? '').replace(LEITURA_DE_ARQUIVO, ' '));
    // "ok, pago o restante na clínica" concorda com a taxa (o recado diz que o restante é na clínica): não é recusa
    if (!n || /\b(?:resto|restante|saldo|diferenca|o que falta|complemento)\b/.test(n)) return false;
    if (SO_O_LUGAR.test(n)) return true;
    // cada frase sozinha: "Quanto pago no dia? Só pago na hora tudo" recusa na segunda
    return n.split(/(?<=[.!?])\s+/).some((frase) => {
      const achados = PAGA_NA_CLINICA.map((r) => r.exec(frase)).filter((m): m is RegExpExecArray => !!m);
      return achados.length > 0 && !perguntaDeOutraCoisa(frase, Math.min(...achados.map((m) => m.index)));
    });
  });
}

/**
 * A frase PERGUNTA quanto paga, como remarca ou se aceita cartão no dia: não é recusa da taxa, e trocá-la pelo recado deixa a
 * pergunta sem resposta ("quanto pago no dia?", "posso pagar no cartão no dia?", "não vou poder ir no dia, posso pagar e
 * remarcar?"). "Quanto" só exclui se vem ANTES do trecho de pagar ("quero pagar tudo no dia, quanto fica?" segue sendo recusa).
 */
function perguntaDeOutraCoisa(frase: string, inicioDoPagar: number): boolean {
  // "Quanto à taxa, vou pagar na clínica mesmo" é "quanto a" = "quanto à/ao": introduz o assunto, não pergunta valor.
  // "Quanto a consulta custa se eu pagar no dia?" continua sendo pergunta: só vale "quanto a" + palavra de pagamento.
  const quanto = frase.search(/\bquanto\b(?!\s+(?:a|as|ao|aos)\s+(?:taxa|pagamento|pix|antecipad\w*|sinal|reserva|agendamento|entrada|valor|parte)\b)/);
  if (quanto >= 0 && quanto < inicioDoPagar) return true;
  if (!/\?\s*$/.test(frase)) return false;
  return /\b(?:remarc\w*|reagend\w*|desmarc\w*|cancel\w*|cartao|credito|debito|dinheiro|especie|parcel\w*|dividir)\b/.test(frase);
}

/**
 * A última resposta da IA ANTES das falas deste turno (a de agora ainda não existe): de onde se sabe se a chave já foi enviada.
 * `mensagens` na ordem da conversa, já sem o system; ferramentas e respostas deste turno ficam depois da última fala do paciente.
 */
export function respostaAnteriorDaIA(mensagens: ReadonlyArray<{ tipo: string; texto: string }>): string {
  let i = mensagens.length - 1;
  while (i >= 0 && mensagens[i].tipo !== 'human') i--; // o que a IA e as ferramentas fizeram neste turno
  while (i >= 0 && mensagens[i].tipo === 'human') i--; // a rajada de falas do paciente
  for (; i >= 0; i--) if (mensagens[i].tipo === 'ai' && mensagens[i].texto.trim()) return mensagens[i].texto;
  return '';
}

// --- O que a Sofia respondeu --------------------------------------------------------------------------------------------

const QUEM = '(?:equipe|recepcao|time|atendente|setor|clinica)';
const ENVIAR = '(?:envia|enviar|enviara|envie|manda|mandar|mandara|passa|passar|passara|encaminha|encaminhar|encaminhara|fornece)';
/**
 * O que a equipe envia NÃO é a chave: "a equipe te envia a confirmação depois do Pix", "a equipe encaminha o recibo do Pix".
 * Vale quando essa palavra é o OBJETO do envio (a primeira depois do verbo) e o Pix só a complementa. "Os dados/informações do Pix"
 * e "o endereço e a chave Pix" continuam sendo a chave.
 */
const OUTRO_OBJETO = new Set(['confirmacao', 'recibo', 'comprovante', 'lembrete', 'orientacao', 'orientacoes', 'resumo', 'aviso', 'valor', 'endereco']);
const ENFEITE = new Set(['te', 'lhe', 'voce', 'vc', 'a', 'o', 'as', 'os', 'um', 'uma', 'seu', 'sua', 'aqui', 'por', 'tambem', 'depois', 'ja', 'em', 'seguida', 'rapido', 'logo']);
const EQUIPE_ENVIA = [
  // "a equipe te envia a chave certa", "a equipe já vai te enviar a chave por aqui"
  new RegExp(`\\b${QUEM}\\b[^.?!]{0,50}\\b${ENVIAR}\\b(?<ate>[^.?!]{0,30}?)\\b(?<obj>chave(?!\\s+de\\s+(?:acesso|porta|casa|entrada|seguranca))|pix)\\b`),
  // "a chave, a equipe te manda" (só "chave": "depois do Pix, a equipe te envia a confirmação" é explicação)
  new RegExp(`\\bchave\\b[^.?!]{0,30}\\b${QUEM}\\b[^.?!]{0,30}\\b${ENVIAR}\\b`),
];
/** O objeto do envio é outra coisa e o Pix só a complementa ("o recibo do Pix")? */
function enviaOutraCoisaDoPix(m: RegExpExecArray): boolean {
  if (m.groups?.obj !== 'pix') return false;
  const ate = m.groups.ate ?? '';
  // "o endereço e o Pix", "o recibo, o Pix": o Pix é um segundo objeto do envio, não complemento do primeiro
  if (/\be\b|,/.test(ate)) return false;
  const primeira = ate.split(/\s+/).find((w) => w && !ENFEITE.has(w));
  return !!primeira && OUTRO_OBJETO.has(primeira);
}
/** "Não se preocupe, a equipe te envia a chave" tranquiliza: o "não" não nega o envio. */
const TRANQUILIZA = /\bnao (?:se )?preocup\w*|\bnao precisa (?:se )?preocupar\b|\bnao (?:tem|ha) (?:problema|duvida)\b/g;

/** A resposta empurra a chave para a equipe ("a equipe te envia a chave"). Pergunta e negação não contam. */
export function empurrouAChaveParaEquipe(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t).replace(TRANQUILIZA, ' ');
    if (/\?\s*\S{0,3}$/.test(n)) return false;
    return EQUIPE_ENVIA.some((r) => {
      const m = r.exec(n);
      if (!m || enviaOutraCoisaDoPix(m)) return false;
      // a negação vale na MESMA oração do envio ("a equipe não envia a chave"); a de outra oração não ("Não, ... a equipe te envia")
      // e a no máximo 30 caracteres antes: "Não tenho acesso à chave aqui mas a equipe te envia a chave" ainda empurra
      const inicio = Math.max(n.lastIndexOf(',', m.index), n.lastIndexOf(';', m.index), n.lastIndexOf(':', m.index), n.lastIndexOf(' mas ', m.index)) + 1;
      return !/\b(?:nao|nem)\b/.test(n.slice(Math.max(inicio, m.index - 30), m.index + m[0].length));
    });
  });
}

const OFERECE = '(?:quer|gostaria|deseja|posso|podemos|vou|quer que eu|gostaria que eu|prefere que eu)';
const PASSAR = '(?:passe|passar|passo|mande|mandar|mando|envie|enviar|envio|enviarei|mandarei|te passe|te mande|te envie)';
const OFERTA_DA_CHAVE = [
  // "Quer que eu te passe a chave Pix pra garantir sua vaga?", "Posso te enviar a chave?"
  new RegExp(`\\b${OFERECE}\\b[^?]{0,40}\\b${PASSAR}\\b[^?]{0,30}\\b(?:chave|pix)\\b`),
  // "Quer a chave Pix?"
  /\bquer\b[^?]{0,10}\b(?:a|o) (?:chave|pix)\b/,
];

/** A resposta PERGUNTA se o paciente quer a chave em vez de mandá-la ("Quer que eu te passe a chave Pix?"). */
export function ofereceuAChaveEmPergunta(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t);
    return /\?\s*\S{0,3}$/.test(n) && OFERTA_DA_CHAVE.some((r) => r.test(n));
  });
}

/** O trecho tem condição ANTES da frase ("assim que o comprovante chegar, deixo tudo registrado"): promessa de futuro, não afirmação. */
const CONDICAO_ANTES =
  /\b(?:assim que|logo que|quando|depois (?:que|de|do|da)|apos|caso|se (?:voce|vc|pagar|o pix|o comprovante|ele|ela|estiver|for|der))\b/;
/** Condição em qualquer ponto do trecho: "o horário fica reservado assim que o comprovante chegar" explica, não afirma. */
const CONDICAO_NO_TRECHO =
  /\b(?:assim que|logo que|quando|depois que|depois d[oa] (?:pagamento|pix|comprovante|taxa|confirmacao)|apos o (?:pagamento|pix|comprovante)|assim (?:o|a|seu|sua|voce|fica)|(?:para|pra) (?:garantir|reservar|confirmar|fechar))\b/;
/** Frases que o `afirmaConfirmacao` não pega e que, sem consulta nem comprovante, são sempre falsas. */
const ATE_JA = /\bate ja\b/;
const DEIXEI_REGISTRADO =
  /\bdeix(?:ei|ado|ada)\s+(?:\S+\s+){0,3}?(?:registrad|anotad|combinad|certinh|encaminhad|agendad)[oa]s?\b/;
const PRA_TE_RECEBER = /\b(?:pra|para) te receber\b|\baguardamos (?:voce|vc)\b|\bestarei (?:te )?(?:esperando|aguardando)\b/;
/**
 * A Sofia anuncia o que VAI FAZER ("Tudo certo, vou ver os horários de quinta pra você"): não garante horário nenhum.
 * A oração assim é julgada fora; o que sobra do trecho continua valendo ("Sua consulta está confirmada, vou ver…" afirma).
 */
const ANUNCIA_UMA_ACAO =
  /\b(?:vou|vamos|irei|deixa eu|deixe eu|quer que eu|posso)\s+(?:te\s+|lhe\s+)?(?:\S+\s+){0,1}?(?:ver|verificar|conferir|checar|consultar|procurar|buscar|olhar|mostrar|sugerir|separar os horarios)\b/;
/** "Tudo certo, quinta às 14h está disponível pra você": informa que há vaga, não que o horário foi guardado. */
const SO_DISPONIVEL = /\b(?:disponivel|disponiveis|livre|livres|vago|vagos)\b/;
const AFIRMA_GUARDA = /\b(?:confirmad|agendad|reservad|garantid|marcad|anotad|registrad)[oa]s?\b|\b(?:deixei|deixo|deixar|reservei|reservo|garanti|garanto|agendei|marquei)\b|\btudo cert\w*|\bcertinh\w*/;
/** "Deixei anotado aqui que o melhor horário é à tarde": a preferência dele foi anotada, não o horário reservado. */
const ANOTOU_O_QUE_ELE_DISSE = /^\s*(?:aqui\s+|por aqui\s+)?que\s+(?<dito>.*)$/;
/**
 * Depois do "que", ELE diz o que quer ("que você prefere quinta à tarde", "que prefere amanhã", "que o melhor horário é amanhã"):
 * é o pedido dele, mesmo com dia/hora. "que você vai ficar com quinta às 14h" e "que você tem consulta quinta" são a reserva.
 */
const SUJEITO_E_ELE =
  /^(?:(?:voce|vc|ele|ela|o senhor|a senhora|o paciente)\s+)?(?:so\s+|ainda\s+|tambem\s+)?(?:prefere|preferem|prefiro|quer|queria|gostaria|gosta|pediu|disse|falou|informou|precisa|costuma|trabalha|estuda|sai|so pode|nao pode|nao consegue)\b|^(?:o melhor horario|a melhor hora|sua preferencia|a sua preferencia)\b/;
/** O que foi anotado é a preferência dele? Com dia/hora só se o sujeito for ele; "que seu horário é quinta às 14h" afirma. */
function anotouOQueEleDisse(depois: string): boolean {
  const dito = ANOTOU_O_QUE_ELE_DISSE.exec(depois)?.groups?.dito;
  if (dito === undefined) return false;
  if (AFIRMA_GUARDA.test(dito)) return false;
  return !QUANDO_HORARIO.test(dito) || SUJEITO_E_ELE.test(dito.trim());
}
const E_ASSUNTO_DE_HORARIO = /\b(?:receber|horario|consulta|atendimento|vaga)\b/;

/**
 * A resposta dá o horário como garantido/combinado. Parte do `afirmaConfirmacao` (modo normal, o mais largo) e soma o que
 * a Sofia disse em Boa Vista e ele não pegava. Pergunta e explicação ("o horário só é reservado depois do pagamento") não.
 */
export function afirmaHorarioGarantido(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => afirmaNoTrecho(t));
}

function afirmaNoTrecho(t: string): boolean {
  const n = normalizar(t);
  if (/\?\s*\S{0,3}$/.test(n)) {
    // "Já deixei o horário certo com a equipe, me manda o comprovante?": a pergunta vem DEPOIS da afirmação. Sem vírgula ("Posso confirmar?") é só pergunta.
    const virgula = t.lastIndexOf(',');
    return virgula > 0 && afirmaNoTrecho(t.slice(0, virgula));
  }
  if (!CONDICAO_NO_TRECHO.test(n)) return afirmaNaOracao(t);
  // Há condição no trecho ("fica reservado assim que o comprovante chegar" explica; "confirmado pra quarta às 10h, pra garantir é só pagar" afirma):
  // cada oração separada por vírgula é julgada sozinha, e o que vem DEPOIS da condição é consequência dela, não afirmação.
  for (const oracao of t.split(/,\s*/)) {
    if (CONDICAO_NO_TRECHO.test(normalizar(oracao))) return false;
    if (afirmaNaOracao(oracao)) return true;
  }
  return false;
}

/** Oração que só informa ou anuncia ("vou ver os horários", "quinta às 14h está disponível"): sem verbo de guardar, não garante nada. */
function oracaoNeutra(o: string): boolean {
  const n = normalizar(o);
  return (ANUNCIA_UMA_ACAO.test(n) || SO_DISPONIVEL.test(n)) && !AFIRMA_GUARDA.test(n);
}

/**
 * `horarioDito`: a oração neutra que saiu do julgamento falava de dia/hora disponível ("quinta às 14h está disponível, deixei tudo
 * registrado"). O dia e a hora continuam sendo o assunto do "deixei registrado", que sozinho não os traria.
 */
function afirmaNaOracao(t: string, horarioDito = false): boolean {
  const oracoes = t.split(/,\s+/); // vírgula de decimal ("R$ 1,50") não separa oração
  if (oracoes.some(oracaoNeutra)) {
    // a oração neutra sai do julgamento; o que sobra do trecho continua valendo ("Sua consulta está confirmada, vou ver…" afirma)
    const resto = oracoes.filter((o) => !oracaoNeutra(o)).join(', ');
    const disseOHorario = oracoes.some((o) => oracaoNeutra(o) && SO_DISPONIVEL.test(normalizar(o)) && QUANDO_HORARIO.test(normalizar(o)));
    return !!resto && afirmaNaOracao(resto, horarioDito || disseOHorario);
  }
  const n = normalizar(t);
  const assunto = QUANDO_HORARIO.test(n) || E_ASSUNTO_DE_HORARIO.test(n);
  // "Tudo certo, vou precisar do seu nome" é coleta de dado, não horário: a frase solta só vale com horário/consulta/dia no trecho.
  if (afirmaConfirmacao(t, { soForte: true }) || (assunto && afirmaConfirmacao(t))) return true;
  for (const [re, vale] of [
    [ATE_JA, QUANDO_HORARIO.test(n)],
    // só o "deixei registrado" herda o horário da oração neutra; "até já!" e "pra te receber" sozinhos são cortesia de despedida
    [DEIXEI_REGISTRADO, assunto || horarioDito],
    // "pra te receber bem" é cortesia: só vale com hora ou dia
    [PRA_TE_RECEBER, QUANDO_HORARIO.test(n)],
  ] as const) {
    const m = re.exec(n);
    if (!m || !vale) continue;
    if (CONDICAO_ANTES.test(n.slice(0, m.index)) || NAO_AFIRMA_CONFIRMACAO.test(n.slice(Math.max(0, m.index - 25), m.index + m[0].length))) continue;
    // "deixei anotado que…" e o que vem depois é o que ELE disse (preferência, nome, dia que prefere), não horário garantido
    if (re === DEIXEI_REGISTRADO && anotouOQueEleDisse(n.slice(m.index + m[0].length))) continue;
    return true;
  }
  return false;
}

// --- O recado fixo ------------------------------------------------------------------------------------------------------

const reais = (v: number) => `R$ ${fmtBRL(v)}`;

function blocoDaChave(d: DadosDaTaxa): string {
  return `Chave Pix: ${d.chave}${d.titular ? `\nTitular: ${d.titular}` : ''}`;
}

/** O pedido da taxa com a chave: o que se ACRESCENTA ao resto de uma resposta (sem abertura própria). */
function pedidoDaChave(d: DadosDaTaxa): string {
  return (
    `Para garantir o seu horário, é só pagar a taxa de agendamento de ${reais(d.valor)} por Pix:\n\n` +
    `${blocoDaChave(d)}\n\n` +
    'Assim que pagar, me manda o comprovante aqui na conversa (foto ou PDF). Sem o comprovante, o horário não fica garantido. 🙏'
  );
}

/** O paciente pediu o Pix (ou a resposta mandou a equipe enviar): a chave, o titular, o valor e o pedido do comprovante. */
export function recadoDaChave(d: DadosDaTaxa): string {
  return `Claro! ${pedidoDaChave(d)}`;
}

/** A resposta dava o horário como garantido sem consulta nem comprovante: o horário só fica garantido depois da taxa. */
export function recadoSemComprovante(d: DadosDaTaxa): string {
  return (
    `Só um detalhe importante: o seu horário ainda não está garantido. Ele só fica reservado depois que a taxa de agendamento de ${reais(d.valor)} ` +
    'for paga por Pix e o comprovante (foto ou PDF) chegar aqui na conversa.\n\n' +
    `${blocoDaChave(d)}\n\n` +
    'Me manda o comprovante assim que pagar, tá? 🙏'
  );
}

/** A taxa em uma frase e a chave: o que se ACRESCENTA ao resto de uma resposta (sem abertura própria). */
function explicacaoDaClinica(d: DadosDaTaxa): string {
  return (
    `Aqui o horário só fica separado com a taxa de agendamento de ${reais(d.valor)}: sem ela, ele pode ser ocupado por outra pessoa. ` +
    'O restante você paga na clínica, no dia da consulta.\n\n' +
    `Se quiser garantir, é só pagar por Pix:\n${blocoDaChave(d)}\n\n` +
    'Me manda o comprovante aqui na conversa (foto ou PDF), tá? 🙏'
  );
}

/** O paciente quer pagar na clínica: em uma frase, a taxa é o que separa o horário; e a chave vai na mesma mensagem. */
export function recadoPagarNaClinica(d: DadosDaTaxa): string {
  return `Entendi! ${explicacaoDaClinica(d)}`;
}

const CORPO_INSISTIU_NA_CLINICA = 'Anotei que você prefere pagar na clínica e a equipe vai falar com você aqui na conversa para ver como fica. 🙏';
const CORPO_INSISTIU_SEM_PROMESSA =
  'Entendi que você prefere pagar na clínica. Só que, sem a taxa de agendamento, o horário não fica separado. Se quiser garantir, é só me avisar que eu te passo a chave Pix. 🙏';

/** O paciente insiste em pagar só na clínica depois de receber a chave: a equipe cuida, e o horário NÃO é prometido. */
export const RECADO_INSISTIU_NA_CLINICA = `Tudo bem! ${CORPO_INSISTIU_NA_CLINICA}`;

/** O mesmo caso quando NADA chegou à equipe (sem ferramenta, prazo estourado, erro): o recado não promete o que não aconteceu. */
export const RECADO_INSISTIU_SEM_PROMESSA = `Tudo bem! ${CORPO_INSISTIU_SEM_PROMESSA}`;

/**
 * O recado da insistência, com ou sem a promessa da equipe. `resto`: o que a resposta do modelo tinha de aproveitável (o endereço
 * que ele também perguntou); sem resto, o recado inteiro com a abertura.
 */
export function recadoDaInsistencia(equipeAvisada: boolean, resto: string | null = null): string {
  const corpo = equipeAvisada ? CORPO_INSISTIU_NA_CLINICA : CORPO_INSISTIU_SEM_PROMESSA;
  if (resto) return `${resto}\n\n${corpo}`;
  return equipeAvisada ? RECADO_INSISTIU_NA_CLINICA : RECADO_INSISTIU_SEM_PROMESSA;
}

/**
 * A resposta é (ou traz) o recado da insistência, com ou sem a promessa da equipe. Os dois contam: o recado sem promessa também
 * fecha o ciclo — o João já foi avisado pelo Telegram e repetir só reenvia a chave e o alerta a cada insistência.
 */
export function jaEncaminhouAInsistencia(texto: string | null | undefined): boolean {
  const t = String(texto ?? '');
  return t.includes(CORPO_INSISTIU_NA_CLINICA) || t.includes(CORPO_INSISTIU_SEM_PROMESSA);
}

/** Todas as respostas anteriores da IA nesta conversa: a insistência já foi tratada (com ou sem a promessa da equipe)? */
export function insistenciaJaTratada(respostasDaIA: ReadonlyArray<string>): boolean {
  return respostasDaIA.some(jaEncaminhouAInsistencia);
}

/** O paciente ainda quer pagar na clínica e o modelo disse que pode: o lembrete da taxa, sem repetir a chave nem avisar a equipe de novo. */
function lembreteDaTaxa(d: DadosDaTaxa): string {
  return `Só lembrando que o horário só fica separado com a taxa de agendamento de ${reais(d.valor)}, por Pix. Quando quiser garantir, é só me avisar que eu te passo a chave. 🙏`;
}

/** Alguma fala do paciente traz comprovante lido (foto/PDF), de QUALQUER data: quem já pagou não paga de novo por ter passado 24 h. */
export function pacienteJaMandouComprovante(falasDoPaciente: ReadonlyArray<string>): boolean {
  return falasDoPaciente.some((f) => comprovantesDoTexto(String(f ?? '')).length > 0);
}

export interface ContextoDaTaxa {
  /** o que o PACIENTE disse neste turno (sem as linhas da equipe) */
  falasDoPaciente: ReadonlyArray<string>;
  /** existe consulta de pé no CRM (o prompt traz a consulta de verdade) ou ela acabou de ser marcada neste turno */
  consultaDePe: boolean;
  /** o prompt diz que o paciente JÁ TEM TRATAMENTO / está no funil TRATAMENTO: pergunta de Pix é de sessão, não de reserva */
  emTratamento: boolean;
  /** a última resposta da IA antes deste turno (`respostaAnteriorDaIA`): se já tinha a chave, o paciente insiste */
  respostaAnterior: string;
  /** há comprovante lido na conversa (neste turno ou nas últimas 24 h): quem trata é a espera da equipe */
  comprovanteLido: boolean;
  /** há comprovante lido em QUALQUER ponto da conversa, de qualquer data (`pacienteJaMandouComprovante`): ele já pagou */
  jaMandouComprovante: boolean;
  /** alguma resposta anterior da IA nesta conversa já encaminhou a insistência à equipe (`jaEncaminhouAInsistencia`) */
  insistenciaJaEncaminhada: boolean;
}

/** Os dois textos do prompt (`renderPacienteNaFranquia` e `REGRAS_DO_FUNIL_TRATAMENTO`) que dizem que o paciente está em tratamento. */
export function promptDizEmTratamento(prompt: string | null | undefined): boolean {
  return /JÁ TEM TRATAMENTO na clínica|ELE ESTÁ EM TRATAMENTO/.test(String(prompt ?? ''));
}

export interface TrocaDaTaxa {
  texto: string;
  motivo: 'chave_pedida' | 'equipe_envia_a_chave' | 'chave_oferecida' | 'pagar_na_clinica' | 'insistiu_na_clinica' | 'horario_sem_comprovante';
  /** o resto da resposta do modelo foi mantido e o bloco da chave, acrescentado (false = o recado inteiro tomou o lugar) */
  preservouOResto?: boolean;
  /** o que sobrou da resposta do modelo (só quando `preservouOResto`): quem monta o recado de outra forma (a insistência) o reaproveita */
  resto?: string;
}

// --- Chave e valor ERRADOS na resposta do modelo --------------------------------------------------------------------------------

const digitos = (v: string) => v.replace(/\D/g, '');
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** CNPJ, CPF ou celular, com ou sem pontuação: de 10 a 14 dígitos numa sequência só. */
const SEQUENCIA_DE_DIGITOS = /\d[\d.\-/() ]{8,}\d/g;

/**
 * O trecho fala de Pix/chave e traz uma chave do MESMO TIPO que a do cadastro e diferente dela (CNPJ no lugar do CNPJ, e-mail no lugar
 * do e-mail). O telefone ou e-mail de contato da clínica ao lado da palavra "Pix" não é chave errada; tipo diferente não se compara.
 */
function trazOutraChave(t: string, dados: DadosDaTaxa): boolean {
  if (!/\b(?:pix|chave)\b/.test(normalizar(t))) return false;
  const minhaTexto = dados.chave.toLowerCase();
  if (minhaTexto.includes('@')) return (t.match(EMAIL) ?? []).some((c) => c.toLowerCase() !== minhaTexto);
  if (new RegExp(`^${UUID.source}$`, 'i').test(dados.chave)) return (t.match(UUID) ?? []).some((c) => c.toLowerCase() !== minhaTexto);
  const minha = digitos(dados.chave);
  if (minha === '') return false;
  // número do mesmo tamanho (CNPJ x CNPJ, CPF/celular x CPF/celular); com ou sem o 55 do celular
  return (t.match(SEQUENCIA_DE_DIGITOS) ?? []).some((c) => {
    const d = digitos(c);
    if (d === minha || minha.endsWith(d) || d.endsWith(minha)) return false;
    return d.length === minha.length || (Math.abs(d.length - minha.length) === 2 && (d.startsWith('55') || minha.startsWith('55')));
  });
}

const VALOR = String.raw`r\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)`;
const PALAVRA_DA_TAXA = String.raw`(?:taxa|antecipad\w*|sinal)`;
/** "a taxa é R$ 50", "taxa de agendamento de R$ 50", "antecipado: R$ 50" — o valor logo depois da palavra, sem outro número no meio. */
const VALOR_DEPOIS_DA_TAXA = new RegExp(String.raw`\b${PALAVRA_DA_TAXA}\b[^.?!\d]{0,22}?${VALOR}`, 'g');
/** "R$ 50 de taxa", "R$ 100 antecipado" */
const VALOR_ANTES_DA_TAXA = new RegExp(String.raw`${VALOR}\s*(?:de |da |do )?${PALAVRA_DA_TAXA}\b`, 'g');
const emNumero = (v: string) => Number(v.replace(/\./g, '').replace(',', '.'));

/** O trecho dá, como valor da taxa, um que NÃO é o do cadastro ("a taxa é R$ 50")? O valor da consulta ("R$ 350") não conta. */
function trazOutroValorDaTaxa(t: string, dados: DadosDaTaxa): boolean {
  const n = normalizar(t);
  const citados = [...n.matchAll(VALOR_DEPOIS_DA_TAXA), ...n.matchAll(VALOR_ANTES_DA_TAXA)].map((m) => emNumero(m[1]));
  return citados.length > 0 && !citados.some((v) => Math.abs(v - dados.valor) < 0.005);
}

/** O trecho contradiz o cadastro: outra chave Pix, ou outro valor para a taxa. Nunca fica ao lado dos dados certos. */
function contradizOCadastro(t: string, dados: DadosDaTaxa): boolean {
  return trazOutraChave(t, dados) || trazOutroValorDaTaxa(t, dados);
}

/** A resposta já traz a chave EXATA e pede o comprovante (e não contradiz o cadastro): não há o que corrigir. */
function jaTrazAChaveEPedeComprovante(texto: string, d: DadosDaTaxa): boolean {
  return (
    texto.includes(d.chave) &&
    /comprovante/.test(normalizar(texto)) &&
    !empurrouAChaveParaEquipe(texto) &&
    !trechos(texto).some((t) => contradizOCadastro(t, d))
  );
}

/** "Sem isso, o horário pode ser ocupado": pendurado numa frase que saiu, não faz sentido sozinho. */
const PENDURADO = /^sem (?:isso|esse|essa|isto)\b/;
/** A resposta diz que ele pode pagar na clínica: contradiz a taxa, sai junto do bloco. */
const RESPONDE_PAGAR_NA_CLINICA =
  /\bpag\w*\b[^.?!]{0,40}\b(?:na clinica|no dia|na hora|no local|presencial)\b|\b(?:na clinica|no dia|na hora)\b[^.?!]{0,25}\bpag\w*\b/;

/**
 * O resto que ficaria ainda parece garantir horário ou empurrar a chave? Na dúvida vale o recado inteiro: o detector largo
 * (sem exigir dia/hora) e as frases soltas ("já deixei tudo registrado com a equipe") também contam aqui.
 */
function restoSuspeito(resto: string): boolean {
  if (afirmaHorarioGarantido(resto) || empurrouAChaveParaEquipe(resto) || ofereceuAChaveEmPergunta(resto)) return true;
  return trechos(resto).some((t) => {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n)) return false;
    return !!afirmaConfirmacao(t) || DEIXEI_REGISTRADO.test(n) || ATE_JA.test(n) || PRA_TE_RECEBER.test(n);
  });
}

/**
 * A resposta SEM os trechos-problema (`ehProblema`, o que contradiz o cadastro, o "sem isso…" pendurado). null = não sobra nada
 * que valha manter: o recado inteiro é o último recurso. Sobrou só uma interjeição ("Perfeito!", "Tudo bem!") também é nada.
 */
function semOsProblemas(texto: string, dados: DadosDaTaxa, ehProblema: (trecho: string, normalizado: string) => boolean): string | null {
  let resto = texto;
  for (const t of trechos(texto)) {
    const n = normalizar(t);
    if (!ehProblema(t, n) && !PENDURADO.test(n) && !contradizOCadastro(t, dados)) continue;
    const sem = semOTrecho(resto, t);
    if (sem === null) return null;
    resto = sem;
  }
  resto = resto.trim();
  return resto.replace(/[\p{P}\p{S}\s]/gu, '').length >= 10 ? resto : null;
}

/**
 * Tira da resposta só o que é problema, passa o resto pela MESMA trava e acrescenta o bloco. O recado inteiro fica como último
 * recurso: sobrou quase nada, o resto ainda é problema, ou o resto já traz a chave mas sem o pedido do comprovante.
 */
function conservandoOResto(
  texto: string,
  dados: DadosDaTaxa,
  ehProblema: (trecho: string, normalizado: string) => boolean,
  bloco: string,
  inteiro: string,
): { texto: string; preservouOResto: boolean; resto?: string } {
  const recadoInteiro = { texto: inteiro, preservouOResto: false };
  const resto = semOsProblemas(texto, dados, ehProblema);
  if (resto === null) return recadoInteiro;
  if (resto.includes(dados.chave)) return jaTrazAChaveEPedeComprovante(resto, dados) ? { texto: resto, preservouOResto: true } : recadoInteiro;
  if (restoSuspeito(resto)) return recadoInteiro;
  return { texto: `${resto}\n\n${bloco}`, preservouOResto: true, resto };
}

/**
 * A decisão: null = a resposta sai como veio. Primeiro a chave (pedida pelo paciente, ou empurrada para a equipe); depois o
 * horário dado como garantido sem prova. Uma troca só por turno. Em TODAS as trocas o RESTO da resposta (o endereço que ele
 * também perguntou) fica e o bloco certo é acrescentado; o que contradiz o cadastro (outra chave, outro valor) sai.
 */
export function travaDaTaxaDeReserva(texto: string, dados: DadosDaTaxa | null, ctx: ContextoDaTaxa): TrocaDaTaxa | null {
  if (!dados || ctx.consultaDePe || ctx.emTratamento || ctx.comprovanteLido) return null;
  const chaveJaEnviada = ctx.respostaAnterior.includes(dados.chave);
  // Já mandou comprovante (em qualquer data) ou o cartão diz que pagou: NADA é pedido por conta da Sofia (nem "horário não garantido",
  // nem a taxa de quem quer pagar na clínica). Só o pedido EXPLÍCITO da chave ("qual o pix?") é atendido — ele pediu, e a resposta
  // "a equipe te envia a chave" seria a falha que esta trava existe para evitar.
  if (ctx.jaMandouComprovante) {
    if (!pacientePediuAChave(ctx.falasDoPaciente, { soPedidoExplicito: true }) || jaTrazAChaveEPedeComprovante(texto, dados)) return null;
    const r = conservandoOResto(texto, dados, (t) => empurrouAChaveParaEquipe(t) || ofereceuAChaveEmPergunta(t), pedidoDaChave(dados), recadoDaChave(dados));
    return { ...r, motivo: empurrouAChaveParaEquipe(texto) ? 'equipe_envia_a_chave' : ofereceuAChaveEmPergunta(texto) ? 'chave_oferecida' : 'chave_pedida' };
  }
  // Quer pagar só na clínica. Já recebeu a chave e insiste: equipe (UMA vez por conversa; depois a conversa segue como está,
  // sem novo recado nem novo resumo). Senão: a taxa em uma frase e a chave na MESMA mensagem.
  const insistenciaTratada = ctx.insistenciaJaEncaminhada || jaEncaminhouAInsistencia(ctx.respostaAnterior);
  const querPagarNaClinica = pacienteQuerPagarNaClinica(ctx.falasDoPaciente);
  if (!insistenciaTratada && querPagarNaClinica) {
    if (chaveJaEnviada) {
      // o recado promete (ou não) a equipe conforme o que saiu; aqui vale a versão com promessa, e o resto da resposta é guardado
      const r = conservandoOResto(
        texto,
        dados,
        (t, n) => t.includes(dados.chave) || ofereceuAChaveEmPergunta(t) || empurrouAChaveParaEquipe(t) || RESPONDE_PAGAR_NA_CLINICA.test(n) || afirmaNoTrecho(t),
        CORPO_INSISTIU_NA_CLINICA,
        RECADO_INSISTIU_NA_CLINICA,
      );
      const resto = r.preservouOResto ? r.resto : undefined; // sem resto aproveitável o recado inteiro tomou o lugar
      return { texto: recadoDaInsistencia(true, resto ?? null), preservouOResto: !!resto, ...(resto ? { resto } : {}), motivo: 'insistiu_na_clinica' };
    }
    if (!jaTrazAChaveEPedeComprovante(texto, dados)) {
      const r = conservandoOResto(
        texto,
        dados,
        (t, n) => ofereceuAChaveEmPergunta(t) || empurrouAChaveParaEquipe(t) || RESPONDE_PAGAR_NA_CLINICA.test(n),
        explicacaoDaClinica(dados),
        recadoPagarNaClinica(dados),
      );
      return { ...r, motivo: 'pagar_na_clinica' };
    }
  }
  // Insistência já tratada e o modelo diz que ele PODE pagar tudo na clínica: contradiz a taxa. O trecho sai e entra o lembrete da
  // taxa — sem a chave de novo, sem novo resumo, sem nova tarefa (a equipe já foi avisada, ou o João já recebeu o alerta).
  // "O restante você paga na clínica" é a verdade (a taxa é a parte antecipada): só "paga TUDO na clínica" contradiz.
  const liberaPagarNaClinica = (n: string) => RESPONDE_PAGAR_NA_CLINICA.test(n) && !/\b(?:resto|restante|saldo|diferenca|o que falta|complemento)\b/.test(n);
  if (insistenciaTratada && querPagarNaClinica && !jaTrazAChaveEPedeComprovante(texto, dados) && trechos(texto).some((t) => liberaPagarNaClinica(normalizar(t)))) {
    const r = conservandoOResto(texto, dados, (_t, n) => liberaPagarNaClinica(n), lembreteDaTaxa(dados), lembreteDaTaxa(dados));
    return { ...r, motivo: 'pagar_na_clinica' };
  }
  const pediu = pacientePediuAChave(ctx.falasDoPaciente, { soPedidoExplicito: chaveJaEnviada });
  const empurrou = empurrouAChaveParaEquipe(texto);
  const ofereceu = ofereceuAChaveEmPergunta(texto);
  if ((pediu || empurrou || ofereceu) && !jaTrazAChaveEPedeComprovante(texto, dados)) {
    const r = conservandoOResto(texto, dados, (t) => empurrouAChaveParaEquipe(t) || ofereceuAChaveEmPergunta(t), pedidoDaChave(dados), recadoDaChave(dados));
    return { ...r, motivo: empurrou ? 'equipe_envia_a_chave' : ofereceu ? 'chave_oferecida' : 'chave_pedida' };
  }
  if (afirmaHorarioGarantido(texto)) {
    const r = conservandoOResto(texto, dados, (t) => afirmaNoTrecho(t), recadoSemComprovante(dados), recadoSemComprovante(dados));
    return { ...r, motivo: 'horario_sem_comprovante' };
  }
  return null;
}
