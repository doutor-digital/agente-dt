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
import { afirmaConfirmacao, NAO_AFIRMA_CONFIRMACAO, QUANDO_HORARIO } from './confirmacao-so-com-crm.js';
import { fmtBRL, precosDaConsulta } from './prompt-composer.js';

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
const PEDE_PIX = [
  // "e o pix" (o "e" abre a frase: "aceita débito e pix?" não é pedido), "qual a chave", "cadê o pix"
  /(?:^|[.!?,;]\s*)e\s+(?:o|a|esse|essa)?\s*(?:chave|pix)\b/,
  /\b(?:qual|cade|onde)\s+(?:e\s+)?(?:o|a|esse|essa)?\s*(?:chave|pix)\b/,
  // "manda o pix", "me envia a chave", "pode me passar o pix" (o objeto vem logo depois do verbo)
  // sem vírgula no meio e sem outro assunto entre o verbo e o Pix: "me passa o endereço, aceita pix?" e "pode passar o preço do pix" não pedem a chave
  /\b(?:manda|mande|mandar|envia|envie|enviar|passa|passe|passar)\b(?:(?!\b(?:valor|preco|endereco|horario|quanto|desconto|informacoes?|dados)\b)[^.?!,]){0,15}\b(?:pix|chave)\b/,
  // "quero o pix", "preciso da chave" — colado ao verbo: "quero saber o valor do pix" e "quero pagar com cartão ou pix" não são pedido
  /\b(?:quero|preciso|gostaria)\s+(?:d[oa]s?\s+|[oa]s?\s+)?(?:chave|pix)\b/,
  // "vou pagar no pix", "prefiro pagar com pix"
  /\b(?:vou|quero|prefiro|pode ser|opto|escolho)\s+(?:pagar\s+)?(?:no|com|via|por|pelo)\s+(?:o\s+)?pix\b/,
  // "pix por favor", "chave pfv"
  /\b(?:pix|chave)\b[^.?!]{0,15}\b(?:por favor|pfv|pf|por gentileza)\b/,
  // só "pix" / "a chave?"
  /^(?:o |a )?(?:chave )?(?:pix|chave)[?!. ]*$/,
];
/** Escolheu pagar antes: "vou pagar o pix antecipado", "prefiro antecipado", ou só "Pix antecipado" (a resposta do botão). */
const ESCOLHE_ANTECIPADO = [
  /\b(?:vou|quero|prefiro|pode ser|opto|escolho|fecho)\b[^.?!]{0,20}\b(?:antecipad|pagar (?:agora|antes|ja|hoje))/,
  /^(?:no |o )?(?:pix )?antecipad[oa]?[ .!]*$/,
  /^pix antecipad[oa]?\b/,
];

/** O paciente pediu a chave Pix, ou escolheu pagar antes, em alguma das falas DESTE turno. */
export function pacientePediuAChave(falasDoTurno: ReadonlyArray<string>): boolean {
  return falasDoTurno.some((fala) => {
    const n = normalizar(String(fala ?? '').replace(LEITURA_DE_ARQUIVO, ' '));
    if (!n || NAO_E_PEDIDO.test(n)) return false;
    return PEDE_PIX.some((r) => r.test(n)) || ESCOLHE_ANTECIPADO.some((r) => r.test(n));
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
  /^(?:so |apenas )?(?:na clinica|no dia|na hora)(?: mesmo)?[ .!]*$/,
];

/** O paciente quer pagar só na clínica. Quem pediu a chave ou escolheu o antecipado NÃO entra (o pedido manda). */
export function pacienteQuerPagarNaClinica(falasDoTurno: ReadonlyArray<string>): boolean {
  if (pacientePediuAChave(falasDoTurno)) return false;
  return falasDoTurno.some((fala) => {
    const n = normalizar(String(fala ?? '').replace(LEITURA_DE_ARQUIVO, ' '));
    // "ok, pago o restante na clínica" concorda com a taxa (o recado diz que o restante é na clínica): não é recusa
    return !!n && !/\b(?:resto|restante|saldo|diferenca|o que falta|complemento)\b/.test(n) && PAGA_NA_CLINICA.some((r) => r.test(n));
  });
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
const EQUIPE_ENVIA = [
  // "a equipe te envia a chave certa", "a equipe já vai te enviar a chave por aqui"
  new RegExp(`\\b${QUEM}\\b[^.?!]{0,50}\\b${ENVIAR}\\b[^.?!]{0,30}\\b(?:chave(?!\\s+de\\s+(?:acesso|porta|casa|entrada|seguranca))|pix)\\b`),
  // "a chave, a equipe te manda" (só "chave": "depois do Pix, a equipe te envia a confirmação" é explicação)
  new RegExp(`\\bchave\\b[^.?!]{0,30}\\b${QUEM}\\b[^.?!]{0,30}\\b${ENVIAR}\\b`),
];

/** A resposta empurra a chave para a equipe ("a equipe te envia a chave"). Pergunta e negação não contam. */
export function empurrouAChaveParaEquipe(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n)) return false;
    return EQUIPE_ENVIA.some((r) => {
      const m = r.exec(n);
      return !!m && !/\b(?:nao|nem)\b/.test(n.slice(Math.max(0, m.index - 30), m.index + m[0].length));
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

function afirmaNaOracao(t: string): boolean {
  const n = normalizar(t);
  const assunto = QUANDO_HORARIO.test(n) || E_ASSUNTO_DE_HORARIO.test(n);
  // "Tudo certo, vou precisar do seu nome" é coleta de dado, não horário: a frase solta só vale com horário/consulta/dia no trecho.
  if (afirmaConfirmacao(t, { soForte: true }) || (assunto && afirmaConfirmacao(t))) return true;
  for (const [re, vale] of [
    [ATE_JA, QUANDO_HORARIO.test(n)],
    [DEIXEI_REGISTRADO, assunto],
    // "pra te receber bem" é cortesia: só vale com hora ou dia
    [PRA_TE_RECEBER, QUANDO_HORARIO.test(n)],
  ] as const) {
    const m = re.exec(n);
    if (!m || !vale) continue;
    if (CONDICAO_ANTES.test(n.slice(0, m.index)) || NAO_AFIRMA_CONFIRMACAO.test(n.slice(Math.max(0, m.index - 25), m.index + m[0].length))) continue;
    return true;
  }
  return false;
}

// --- O recado fixo ------------------------------------------------------------------------------------------------------

const reais = (v: number) => `R$ ${fmtBRL(v)}`;

function blocoDaChave(d: DadosDaTaxa): string {
  return `Chave Pix: ${d.chave}${d.titular ? `\nTitular: ${d.titular}` : ''}`;
}

/** O paciente pediu o Pix (ou a resposta mandou a equipe enviar): a chave, o titular, o valor e o pedido do comprovante. */
export function recadoDaChave(d: DadosDaTaxa): string {
  return (
    `Claro! Para garantir o seu horário, é só pagar a taxa de agendamento de ${reais(d.valor)} por Pix:\n\n` +
    `${blocoDaChave(d)}\n\n` +
    'Assim que pagar, me manda o comprovante aqui na conversa (foto ou PDF). Sem o comprovante, o horário não fica garantido. 🙏'
  );
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

/** O paciente quer pagar na clínica: em uma frase, a taxa é o que separa o horário; e a chave vai na mesma mensagem. */
export function recadoPagarNaClinica(d: DadosDaTaxa): string {
  return (
    `Entendi! Aqui o horário só fica separado com a taxa de agendamento de ${reais(d.valor)}: sem ela, ele pode ser ocupado por outra pessoa. ` +
    'O restante você paga na clínica, no dia da consulta.\n\n' +
    `Se quiser garantir, é só pagar por Pix:\n${blocoDaChave(d)}\n\n` +
    'Me manda o comprovante aqui na conversa (foto ou PDF), tá? 🙏'
  );
}

/** O paciente insiste em pagar só na clínica depois de receber a chave: a equipe cuida, e o horário NÃO é prometido. */
export const RECADO_INSISTIU_NA_CLINICA =
  'Tudo bem! Anotei que você prefere pagar na clínica e a equipe vai falar com você aqui na conversa para ver como fica. 🙏';

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
}

/** Os dois textos do prompt (`renderPacienteNaFranquia` e `REGRAS_DO_FUNIL_TRATAMENTO`) que dizem que o paciente está em tratamento. */
export function promptDizEmTratamento(prompt: string | null | undefined): boolean {
  return /JÁ TEM TRATAMENTO na clínica|ELE ESTÁ EM TRATAMENTO/.test(String(prompt ?? ''));
}

export interface TrocaDaTaxa {
  texto: string;
  motivo: 'chave_pedida' | 'equipe_envia_a_chave' | 'chave_oferecida' | 'pagar_na_clinica' | 'insistiu_na_clinica' | 'horario_sem_comprovante';
}

/** A resposta já traz a chave EXATA e pede o comprovante: não há o que corrigir. */
function jaTrazAChaveEPedeComprovante(texto: string, d: DadosDaTaxa): boolean {
  return texto.includes(d.chave) && /comprovante/.test(normalizar(texto)) && !empurrouAChaveParaEquipe(texto);
}

/**
 * A decisão: null = a resposta sai como veio. Primeiro a chave (pedida pelo paciente, ou empurrada para a equipe); depois o
 * horário dado como garantido sem prova. Uma troca só por turno.
 */
export function travaDaTaxaDeReserva(texto: string, dados: DadosDaTaxa | null, ctx: ContextoDaTaxa): TrocaDaTaxa | null {
  if (!dados || ctx.consultaDePe || ctx.emTratamento || ctx.comprovanteLido) return null;
  // Quer pagar só na clínica. Já recebeu a chave e insiste: equipe. Senão: a taxa em uma frase e a chave na MESMA mensagem.
  if (pacienteQuerPagarNaClinica(ctx.falasDoPaciente)) {
    if (ctx.respostaAnterior.includes(dados.chave) || ctx.respostaAnterior.includes(RECADO_INSISTIU_NA_CLINICA)) return { texto: RECADO_INSISTIU_NA_CLINICA, motivo: 'insistiu_na_clinica' };
    if (!jaTrazAChaveEPedeComprovante(texto, dados)) return { texto: recadoPagarNaClinica(dados), motivo: 'pagar_na_clinica' };
  }
  const pediu = pacientePediuAChave(ctx.falasDoPaciente);
  const empurrou = empurrouAChaveParaEquipe(texto);
  const ofereceu = ofereceuAChaveEmPergunta(texto);
  if ((pediu || empurrou || ofereceu) && !jaTrazAChaveEPedeComprovante(texto, dados)) {
    return { texto: recadoDaChave(dados), motivo: empurrou ? 'equipe_envia_a_chave' : ofereceu ? 'chave_oferecida' : 'chave_pedida' };
  }
  if (afirmaHorarioGarantido(texto)) return { texto: recadoSemComprovante(dados), motivo: 'horario_sem_comprovante' };
  return null;
}
