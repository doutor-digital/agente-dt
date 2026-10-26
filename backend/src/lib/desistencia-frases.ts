/**
 * As FRASES de quem desistiu da consulta — só o detector, sem banco nem Kommo (puro, para a véspera, a régua e o prompt
 * da Sofia usarem o mesmo). A decisão e o contexto estão em `desistencia-da-consulta.ts`.
 *
 * Estreito de propósito (frases reais lidas antes do regex, 45 dias de mensagens): "cancelamento de contrato" e
 * "solicitação de cancelamento" são conversa de tratamento, "não irei pagar a mais" não é "não vou ir", e "não quero
 * cancelar", "posso cancelar?", "se eu cancelar…" e "cancelei o plano" não são desistência.
 */
import { semAcento as normalizar } from './sem-acento.js';

const VERBO_DE_IR = '(ir|comparecer|vir|estar (ai|la|presente|na consulta))';
const PODER = '(vou|vamos|vai|irei|iremos|poderei|poderemos|posso|podemos|consigo|conseguimos|conseguirei|conseguiremos)';

/** O que NÃO entra: "remarcar/reagendar/outro dia" (quer horário novo, não desistiu — a Sofia já remarca) e "cancelou/cancelaram" (3ª pessoa). */
const DESISTE_DA_CONSULTA: RegExp[] = [
  // 1ª pessoa, imperativo e infinitivo: cancelar, cancelei, cancelo, cancela, cancele, cancelando — e desmarc-
  /\b(cancel|desmarc|desmarqu)(ar|ei|o|e|a|ando|amos|em)\b(?! (de )?contrato)/,
  /\bcancelamento d[aoe] (minha |nossa |meu |nosso )?(consulta|agendamento|horario|sessao|vaga)\b/,
  /\bdesist(i|ir|o|imos|indo)\b/,
  // "não vou poder ir", "n vou conseguir comparecer", "não poderei ir", "não irei" + verbo de ir
  new RegExp(`\\bn(ao|) ${PODER}( mais)?( (poder|conseguir))? ${VERBO_DE_IR}\\b`),
  /\bn(ao|) (vou|vamos|irei|iremos) mais\b/,
  // "Nao irei." / "Infelizmente não vou." — a frase inteira, sem complemento (com complemento é outra coisa: "não irei pagar")
  /\bn(ao|) (irei|iremos|vou|vamos)[ .!]*$/,
  /\bn(ao|) (vou|irei|iremos) precisar mais\b/,
  // "Infelizmente não vou poder." (o trecho inteiro) e "não tenho como ir" — sem "conseguir" solto, que é "conseguir pagar"
  /\bn(ao|) (vou|vamos|posso|podemos|poderei) poder( hoje| amanha| mais| agora)?[ .!]*$/,
  /\bn(ao|) tenho como (ir|comparecer|vir)\b/,
  // "não vai dar pra ir", "não vai dar pra mim ir hoje", "não vai dar eu ir"
  new RegExp(`\\bn(ao|) vai (dar|rolar) (pra |para |de )?(mim |eu |ela |ele )?${VERBO_DE_IR}\\b`),
  // "tive um imprevisto", "surgiu um imprevisto", "houve imprevistos" — quem relata, não "imprevistos acontecem"
  /\b(tive|tivemos|teve|houve|surgiu|surgiram|aconteceu|aconteceram|ocorreu|deu|com) (um |uns |uma |alguns |algum |grande |grandes )*imprevistos?\b/,
];

/**
 * O que parece desistência mas não é, lido no texto INTEIRO — revisão de 26/10: "não quero cancelar", "não cancele",
 * "se eu cancelar, perco o valor?", "cancelei o plano de saúde", "cancelar o tratamento" (outro fluxo, o do cancelamento
 * acolhido), "cancela o boleto" e "não posso ir na quinta mas vou na sexta" calavam a régua de quem queria vir.
 */
const NAO_E_DESISTENCIA: RegExp[] = [
  // negado: "não quero cancelar", "não pode cancelar", "não vou desistir", "não cancele", "não desmarque"
  /\bn(ao|) (quero|vou|pretendo|preciso|precisa|pode|posso|podem|vamos|deixe|deixa|deixar)( mais)?( nao)? (cancel|desmarc|desist)/,
  /\bn(ao|) (cancel|desmarc|desmarqu|desist)/,
  // condicional: "se eu cancelar…"
  /\bse (eu |a gente |nos )?(cancel|desmarc|desist)/,
  // cancelou outra coisa
  /\bcancel\w* (o |a |os |as |meu |minha |seu |sua |nosso |nossa )?(plano|convenio|contrato|cartao|assinatura|pix|pagamento|compra|pedido|exame|tratamento|boleto|recibo|nota|fatura|parcela|carne)/,
  // vem em outro dia: "não posso ir na quinta mas vou na sexta"
  /\bmas (vou|irei|vamos|posso|consigo|podemos)\b/,
];

/** Passado asseverado: com "?" ainda é desistência. */
const DESISTENCIA_NO_PASSADO = /\b(cancelei|desmarquei|desisti)\b/;

/**
 * O texto diz que o paciente não vem à consulta que tinha?
 *
 * Lido por TRECHO (entre vírgula, ponto, "?" ou quebra de linha): "Não vou poder ir amanhã, posso outro dia?" é desistência
 * — só o trecho "posso outro dia?" é pergunta. "Posso cancelar?" e "Como faço para cancelar o convênio?" não são: o próprio
 * trecho que fala em cancelar é a pergunta.
 */
export function pareceDesistenciaDaConsulta(texto: string | null | undefined): boolean {
  const bruto = texto ?? '';
  const s = normalizar(bruto);
  if (!s) return false;
  if (NAO_E_DESISTENCIA.some((r) => r.test(s))) return false;
  // os trechos saem do texto BRUTO: `normalizar` junta a quebra de linha com o espaço, e a mensagem de WhatsApp em duas
  // linhas ("Não vou poder ir amanhã\nPode me ajudar a remarcar?") é dois trechos
  return bruto
    .split(/(?<=[,.;?!])|\n+/)
    .map((t) => normalizar(t))
    .filter(Boolean)
    .some((trecho) => (!trecho.includes('?') || DESISTENCIA_NO_PASSADO.test(trecho)) && DESISTE_DA_CONSULTA.some((r) => r.test(trecho)));
}

/** Hesitação: "acho que não vou conseguir", "vou ver", "depois eu aviso" não é recusa — ainda dá para remarcar. */
const HESITA = /\b(acho|talvez|quem sabe|vou ver|vou pensar|depois eu|ainda nao sei|nao sei|se der|vamos ver)\b/;

const RECUSA_EXPLICITA: RegExp[] = [
  // "não quero remarcar", "não vou remarcar", "não preciso de outro dia"
  /\bn(ao|) (quero|vou|preciso|precisa|vamos) (mais )?(remarcar|reagendar|marcar|(de )?outro (dia|horario))/,
  /\bn(ao|) (quero|vou|irei|iremos|preciso) mais\b/,
  // "pode cancelar (mesmo)", "cancela", "cancele", "desmarca", "quero cancelar"
  /\b(pode|podem|quero|queria|gostaria de|vou querer) (cancelar|desmarcar)\b/,
  /\b(cancela|cancele|desmarca|desmarque)\b/,
  /\bcancelar? mesmo\b/,
  /\bdesisti\b|\bdesisto\b/,
];

/**
 * O paciente RECUSOU de forma explícita remarcar — e quer cancelar? ("não quero remarcar", "pode cancelar mesmo", "desisti").
 * Hesitação ("acho que não vou conseguir", "vou ver", "depois eu aviso") e negação ("não cancele") não contam: aí a Sofia
 * NÃO cancela na franquia, oferece remarcar. Decisão do coordenador/João, 26/10/2026.
 */
export function recusouRemarcarExplicitamente(texto: string | null | undefined): boolean {
  const s = normalizar(texto ?? '');
  if (!s) return false;
  if (NAO_E_DESISTENCIA.some((r) => r.test(s))) return false;
  if (s.includes('?') ) return false;
  if (HESITA.test(s)) return false;
  return RECUSA_EXPLICITA.some((r) => r.test(s));
}
