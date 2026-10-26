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
  /\bn(ao|) (vou|vamos|irei|iremos) mais\b(?! (me )?(faltar|atrasar|esquecer|demorar|perder|deixar|falhar))/,
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
  /\b(cancel|desmarc|desmarqu)\w* (o |a |os |as |meu |minha |seu |sua |nosso |nossa )?(plano|convenio|contrato|cartao|assinatura|pix|pagamento|compra|pedido|exame|tratamento|boleto|recibo|nota|fatura|parcela|carne|lembrete|aviso|mensagem|notificacao|dentista|medico|compromisso|trabalho|reuniao|viagem|passagem)/,
  // "ir de carro/ônibus": é o meio de transporte
  /\bir de (carro|onibus|moto|bike|bicicleta|uber|taxi|van|aviao|trem)\b|\bvou de (carro|onibus|moto|bike|bicicleta|uber|taxi|van|carona|a pe)\b/,
  // vem em outro dia: "não posso ir na quinta mas vou na sexta"
  /\bmas (vou|irei|vamos|posso|consigo|podemos|chego|chegarei|vou chegar|apareco|aparecerei)\b/,
  // "cancela não", "desmarca não pfv": o "não" depois do verbo é "não cancele"
  /\b(cancel|desmarc|desmarqu)\w* (nao|n)\b/,
  // "não vou mais atrasar/esquecer/faltar/demorar": é o contrário
  /\bn(ao|) (vou|vamos|irei|iremos) mais (me )?(faltar|atrasar|esquecer|demorar|perder|deixar|falhar)/,
];

/**
 * O paciente quer MANTER a consulta: "quero manter", "vou sim", "consegui me organizar", "cancela não", "prefiro manter a de
 * amanhã". Revisão do sênior no #132: "Não quero remarcar, quero manter" foi lida como recusa e a Sofia cancelaria a consulta
 * de quem queria ir.
 */
const QUER_MANTER: RegExp[] = [
  /\b(quero|vou|prefiro|vamos|queremos|preferimos) (manter|ficar com|continuar com)\b/,
  /\bmantem(os)?\b|\bmanter\b|\bmantenha\b/,
  // sem "vou lá"/"vou comparecer"/"dá pra ir": "não vou lá" e "não dá pra ir" são o contrário
  /\bvou sim\b|\bvamos sim\b|\beu vou\b(?! (cancelar|desmarcar|desistir|ter que|precisar))/,
  /\bconsegui me organizar\b/,
  /\bnao vou mais (me )?(faltar|atrasar|esquecer|demorar|perder|deixar|falhar)\b/,
  /\b(cancel|desmarc|desmarqu)\w* (nao|n)\b|\bnao (cancel|desmarc)\w*/,
];

export function quisManter(texto: string | null | undefined): boolean {
  const s = normalizar(texto ?? '');
  return !!s && QUER_MANTER.some((r) => r.test(s));
}

/**
 * Fala de OUTRA consulta: "cancela a do meu filho, a minha mantém", "cancela a minha de terça e deixa a de quinta". A Sofia
 * não cancela sozinha — a equipe confere qual cai (tarefa). Não é desistência da consulta DESTE paciente.
 */
const OUTRA_CONSULTA: RegExp[] = [
  /\b(consulta|horario|agendamento|sessao|vaga|a|o) (d[oa]|de) (meu|minha|nosso|nossa) (filh|espos|marid|mae|pai|irma|irmao|neto|neta|avo|sogr|amig|tio|tia|primo|prima|companheir|namorad)/,
  /\b(deixa|deixe) (a|o) (de|do|da)\b/,
  /\b(cancel|desmarc|desmarqu)\w*\b.*\b(mantem|mantenha|manter|fica|fique) (a|o) (de|do|da)\b/,
  /\ba minha (mantem|fica|continua|vai continuar|segue)\b|\bmantem a minha\b/,
  /\b(cancel|desmarc|desmarqu)\w* (a|o) (de|do|da) /,
];

export function falouDeOutraConsulta(texto: string | null | undefined): boolean {
  const s = normalizar(texto ?? '');
  return !!s && OUTRA_CONSULTA.some((r) => r.test(s));
}

/** Passado asseverado: com "?" ainda é desistência. */
const DESISTENCIA_NO_PASSADO = /\b(cancelei|desmarquei|desisti)\b/;

/** O trecho é PERGUNTA sobre cancelar ("Posso cancelar?", "Como faço para cancelar o convênio?"), não aviso com "?" no fim ("não vou conseguir ir terça tem quinta?"). */
const PERGUNTA_SOBRE_CANCELAR =
  /^(posso|pode|podem|como|tem como|da pra|sera|se |e se|qual|quanto|quando|onde|vcs|voces)\b|\b(posso|pode|podem|da pra|tem como) (cancelar|desmarcar|desistir)\b/;
const ePerguntaSobreCancelar = (trecho: string): boolean => trecho.includes('?') && PERGUNTA_SOBRE_CANCELAR.test(trecho);

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
  if (QUER_MANTER.some((r) => r.test(s)) || OUTRA_CONSULTA.some((r) => r.test(s))) return false;
  // os trechos saem do texto BRUTO: `normalizar` junta a quebra de linha com o espaço, e a mensagem de WhatsApp em duas
  // linhas ("Não vou poder ir amanhã\nPode me ajudar a remarcar?") é dois trechos
  return bruto
    .split(/(?<=[,.;?!])|\n+/)
    .map((t) => normalizar(t))
    .filter(Boolean)
    .some((trecho) => (!ePerguntaSobreCancelar(trecho) || DESISTENCIA_NO_PASSADO.test(trecho)) && DESISTE_DA_CONSULTA.some((r) => r.test(trecho)));
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
  if (QUER_MANTER.some((r) => r.test(s)) || OUTRA_CONSULTA.some((r) => r.test(s))) return false;
  return RECUSA_EXPLICITA.some((r) => r.test(s));
}

/**
 * A Sofia propôs horário nesta fala? Precisa de relógio ("14h", "14h30", "14:30", "9 horas") E de um dia ("sexta", "amanhã",
 * "27/10") E de cara de oferta: dois horários, ou "tenho/temos/posso oferecer/qual prefere". Não é oferta: o horário de
 * funcionamento ("de segunda a sexta das 8h às 18h") nem o lembrete ("Sua consulta é amanhã às 14h, confirma?").
 */
const RELOGIO_G = /(?<![\p{L}\d])\d{1,2}\s*(?:h(?:\d{2})?(?![\p{L}\d])|:\d{2}|horas?(?![\p{L}]))/giu;
const DIA_SEMANA = '(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?';
const DIA = new RegExp(`(?<![\\p{L}])(?:${DIA_SEMANA}|amanh[ãa]|hoje)(?![\\p{L}])|(?<![\\d/])\\d{1,2}/\\d{1,2}(?![\\d/])`, 'iu');
/** "das 8h às 18h", "de segunda a sexta": faixa de funcionamento, não oferta. */
const FAIXA_DE_RELOGIO = /(?<![\p{L}\d])\d{1,2}\s*(?:h(?:\d{2})?|:\d{2})\s*(?:às|as|a|até|ate|-)\s*\d{1,2}\s*(?:h(?:\d{2})?|:\d{2}|horas?)/giu;
const FAIXA_DE_DIAS = new RegExp(`(?<![\\p{L}])${DIA_SEMANA}\\s+(?:a|à|até|ate)\\s+${DIA_SEMANA}(?![\\p{L}])`, 'giu');
const CARA_DE_OFERTA = /(?<![\p{L}])(?:tenho|temos|tem|posso (?:te )?(?:oferecer|encaixar)|qual (?:fica|prefere)|prefere|op[çc][õo]es)(?![\p{L}])/iu;

export const oferecuHorario = (fala: string): boolean => {
  const limpa = fala.replace(FAIXA_DE_RELOGIO, ' ').replace(FAIXA_DE_DIAS, ' ');
  const relogios = limpa.match(RELOGIO_G) ?? [];
  if (relogios.length === 0 || !DIA.test(limpa)) return false;
  return relogios.length >= 2 || CARA_DE_OFERTA.test(limpa);
};

/**
 * A pergunta de confirmação do cancelamento, com a consulta NOMEADA: "Confirmo o cancelamento da sua consulta de quinta,
 * 29/10, às 14h?". Sênior no #132: o cancelamento SEMPRE passa por ela — a Sofia só chama `cancelar_consulta(confirmado=true)`
 * depois de um "sim" a ESSA pergunta, e o paciente vê qual consulta cai.
 */
export const perguntouConfirmarCancelamento = (fala: string): boolean => /confirmo o cancelamento da sua consulta/i.test(fala);

/** A resposta à pergunta de confirmação: "sim" só quando é um sim limpo; "não"/"manter" mantém; o resto não cancela. */
export function respostaDaConfirmacao(texto: string | null | undefined): 'sim' | 'nao' | 'outra' {
  const s = normalizar(texto ?? '').replace(/[!.,]+/g, ' ').trim();
  if (!s) return 'outra';
  if (/\b(nao|n|manter|mantem|mantenha|deixa|espera|calma|pera)\b/.test(s)) return 'nao';
  if (s.includes('?')) return 'outra';
  if (/^(sim|isso|pode|pode sim|confirmo|confirmado|confirma|ok|certo|isso mesmo|com certeza|quero sim|sim pode|sim confirmo|pode cancelar)\b/.test(s) && s.split(' ').length <= 6) return 'sim';
  return 'outra';
}
