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
/** Já pagou, não quer, não usa: não é pedido de chave. */
const NAO_E_PEDIDO =
  /\bcomprovante\b|\bacabei de\b|\b(?:fiz|fez|fizemos|paguei|pagamos|mandei|enviei|transferi|ja (?:foi|fiz|paguei|mandei|enviei|transferi)|foi (?:feito|pago|enviado))\b|\bnao\b[^.?!]{0,20}\b(?:pix|chave|antecip)/;
const PEDE_PIX = [
  // "e o pix", "qual a chave", "cadê o pix"
  /\b(?:e|qual|cade|onde)\s+(?:e\s+)?(?:o|a|esse|essa)?\s*(?:chave|pix)\b/,
  // "manda o pix", "me envia a chave", "pode me passar o pix", "quero o pix", "preciso da chave"
  /\b(?:manda|mande|mandar|envia|envie|enviar|passa|passe|passar|quero|preciso|gostaria|falta)\b[^.?!]{0,25}\b(?:pix|chave)\b/,
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

// --- O que a Sofia respondeu --------------------------------------------------------------------------------------------

const QUEM = '(?:equipe|recepcao|time|atendente|setor|clinica)';
const ENVIAR = '(?:envia|enviar|enviara|envie|manda|mandar|mandara|passa|passar|passara|encaminha|encaminhar|encaminhara|fornece)';
const EQUIPE_ENVIA = [
  // "a equipe te envia a chave certa", "a equipe já vai te enviar a chave por aqui"
  new RegExp(`\\b${QUEM}\\b[^.?!]{0,50}\\b${ENVIAR}\\b[^.?!]{0,30}\\b(?:chave|pix)\\b`),
  // "a chave, a equipe te manda"
  new RegExp(`\\b(?:chave|pix)\\b[^.?!]{0,30}\\b${QUEM}\\b[^.?!]{0,30}\\b${ENVIAR}\\b`),
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

/** O trecho tem condição ANTES da frase ("assim que o comprovante chegar, deixo tudo registrado"): promessa de futuro, não afirmação. */
const CONDICAO_ANTES =
  /\b(?:assim que|logo que|quando|depois (?:que|de|do|da)|apos|caso|se (?:voce|vc|pagar|o pix|o comprovante|ele|ela|estiver|for|der))\b/;
/** Condição em qualquer ponto do trecho: "o horário fica reservado assim que o comprovante chegar" explica, não afirma. */
const CONDICAO_NO_TRECHO =
  /\b(?:assim que|logo que|quando|depois que|depois d[oa] (?:pagamento|pix|comprovante|taxa|confirmacao)|apos o (?:pagamento|pix|comprovante))\b/;
/** Frases que o `afirmaConfirmacao` não pega e que, sem consulta nem comprovante, são sempre falsas. */
const ATE_JA = /\bate ja\b/;
const DEIXEI_REGISTRADO =
  /\bdeix(?:ei|ado|ada|o)\s+(?:\S+\s+){0,3}?(?:registrad|anotad|combinad|certinh|encaminhad|agendad)[oa]s?\b/;
const PRA_TE_RECEBER = /\b(?:pra|para) te receber\b|\baguardamos (?:voce|vc)\b|\bestarei (?:te )?(?:esperando|aguardando)\b/;
const E_ASSUNTO_DE_HORARIO = /\b(?:receber|horario|consulta|atendimento|vaga)\b/;

/**
 * A resposta dá o horário como garantido/combinado. Parte do `afirmaConfirmacao` (modo normal, o mais largo) e soma o que
 * a Sofia disse em Boa Vista e ele não pegava. Pergunta e explicação ("o horário só é reservado depois do pagamento") não.
 */
export function afirmaHorarioGarantido(texto: string | null | undefined): boolean {
  return trechos(String(texto ?? '')).some((t) => {
    const n = normalizar(t);
    if (/\?\s*\S{0,3}$/.test(n)) return false;
    // Condição no próprio trecho ("fica reservado assim que o comprovante chegar"): é explicação do que vem depois.
    if (CONDICAO_NO_TRECHO.test(n)) return false;
    if (afirmaConfirmacao(t)) return true;
    // "Até já" sozinho é despedida; "Até já às 13h30" é horário combinado. As outras duas aceitam o assunto no lugar da hora.
    for (const [re, vale] of [
      [ATE_JA, QUANDO_HORARIO.test(n)],
      [DEIXEI_REGISTRADO, QUANDO_HORARIO.test(n) || E_ASSUNTO_DE_HORARIO.test(n)],
      [PRA_TE_RECEBER, QUANDO_HORARIO.test(n) || E_ASSUNTO_DE_HORARIO.test(n)],
    ] as const) {
      const m = re.exec(n);
      if (!m || !vale) continue;
      if (CONDICAO_ANTES.test(n.slice(0, m.index)) || NAO_AFIRMA_CONFIRMACAO.test(n.slice(Math.max(0, m.index - 25), m.index + m[0].length))) continue;
      return true;
    }
    return false;
  });
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

export interface ContextoDaTaxa {
  /** o que o PACIENTE disse neste turno (sem as linhas da equipe) */
  falasDoPaciente: ReadonlyArray<string>;
  /** existe consulta de pé no CRM (o prompt traz a consulta de verdade) ou ela acabou de ser marcada neste turno */
  consultaDePe: boolean;
  /** há comprovante lido na conversa (neste turno ou nas últimas 24 h): quem trata é a espera da equipe */
  comprovanteLido: boolean;
}

export interface TrocaDaTaxa {
  texto: string;
  motivo: 'chave_pedida' | 'equipe_envia_a_chave' | 'horario_sem_comprovante';
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
  if (!dados || ctx.consultaDePe || ctx.comprovanteLido) return null;
  const pediu = pacientePediuAChave(ctx.falasDoPaciente);
  const empurrou = empurrouAChaveParaEquipe(texto);
  if ((pediu || empurrou) && !jaTrazAChaveEPedeComprovante(texto, dados)) {
    return { texto: recadoDaChave(dados), motivo: empurrou ? 'equipe_envia_a_chave' : 'chave_pedida' };
  }
  if (afirmaHorarioGarantido(texto)) return { texto: recadoSemComprovante(dados), motivo: 'horario_sem_comprovante' };
  return null;
}
