/**
 * O paciente se DESPEDE ou ADIA e ainda não marcou: a Sofia fica em silêncio e a EQUIPE é avisada.
 *
 * Pedido da Stefany (Timbó, 06/11/2026, áudio), encaminhado pelo João: "ajusta a IA pra ela acionar o humano… pra ela
 * não responder mais… na outra IA que eu usava ela parava de responder e acionava o humano, e daí vinha uma
 * notificação pra gente que a pessoa precisava de resposta".
 *
 * O caso real (Timbó): a Sofia deu o preço da consulta (R$ 250), o paciente disse "Obrigada, entro em contato para
 * agendar logo mais" e ela respondeu "Combinado então! Quando quiser marcar, é só me chamar por aqui. ☺️". Quem
 * perdeu foi a clínica: o lead quente que se despediu ficou sem ninguém olhando.
 *
 * O QUE ESTA CHAVE FAZ (automação `despedida-humano`, DESPEDIDA_HUMANO_SLUGS; nasce DESLIGADA):
 *  - desligada: NADA muda. Nem esta decisão é calculada (a porta sai antes). O resto do sistema segue com a despedida
 *    curta e calorosa de `paciente-encerrou.ts`, que é regra do João e não é tocada aqui;
 *  - "só no papel": decide, loga e registra "alertaria" na tela das automações; a Sofia responde COMO HOJE;
 *  - ligada, no turno em que o paciente se despede/adia SEM consulta marcada: a Sofia não envia nada, o cartão ganha a
 *    tarefa "ALERTA · slug · [DESPEDIDA] …" (a mesma família das outras tarefas de alerta: prazo curto, responsável do
 *    cartão) e uma nota. SEM Telegram: o Telegram é o canal do João, e despedida é coisa de todo dia — a notificação
 *    que a Stefany pediu é a da própria tarefa, que o Kommo entrega ao responsável do cartão.
 *
 * O QUE ELA NÃO FAZ DE PROPÓSITO:
 *  - NÃO marca "Pausar IA". Se o paciente voltar a escrever, a Sofia responde normal (a pausa permanente tiraria a
 *    conversa dela por uma frase de despedida, e "Pausar IA" é a trava das rotinas diárias — rotina-*.ts — que não pode
 *    ser acionada por heurística de texto). Se a equipe responder, a `pausa-equipe` já a faz parar sozinha;
 *  - NÃO muda etapa nem campo (quem está em ALTA/GANHO já é calado pela etapa; aqui é só tarefa + nota);
 *  - NÃO mexe em quem tem consulta marcada: despedida depois de agendar é normal, e a regra de despedida curta segue.
 *
 * SILÊNCIO SEM AVISO É O PIOR CASO. Por isso a Sofia só se cala quando o aviso EXISTE: tarefa criada agora, ou aviso
 * de hoje ainda sem resposta nenhuma da Sofia depois dele, ou tarefa da equipe já aberta no cartão. Se o Kommo recusar
 * a tarefa, ela RESPONDE COMO HOJE (a despedida curta) e o erro fica no rastro, bem visível.
 */
import type { Unit } from '@prisma/client';
import { logger } from '../lib/logger.js';
import type { Estado } from '../lib/automacoes-estado.js';
import { AUTOMACAO_DESPEDIDA_HUMANO, JANELA_MESMO_EVENTO_MS, estadoDaDespedidaHumano } from '../lib/despedida-humano-estado.js';
import { avisoRecente, JANELA_24H_MS, marcadoEm, marcarAviso, REGRA_DESPEDIDA, REGRA_DESPEDIDA_ULTIMA } from '../lib/aviso-dedupe.js';
import { mascararPii } from '../lib/pii.js';
import { registrarSimulacao, type Simulacao } from '../lib/so-no-papel.js';
import { prisma } from '../lib/prisma.js';
import { createKommoClient, type KommoTarefa } from '../services/kommo.service.js';
import type { Fala } from './repeticao.js';
import { turnoDoPaciente } from './paciente-encerrou.js';
import { sinalNaFala } from './sinal-de-alerta.js';

export { AUTOMACAO_DESPEDIDA_HUMANO, estadoDaDespedidaHumano };
export { JANELA_MESMO_EVENTO_MS };
/** Prazo da tarefa: não é urgência (o paciente foi embora), mas alguém precisa olhar logo, com o paciente ainda quente. */
export const PRAZO_TAREFA_S = 30 * 60;
/** Tarefa de ALERTA com prazo mais longe que isto (2 h) não é "a equipe cuidando do paciente agora". */
export const TAREFA_LONGE_MS = 2 * 3600_000;
/** Mais longo que isto não é despedida: é conversa. */
const MAX_CARACTERES = 220;

// ── parte pura ──────────────────────────────────────────────────────────────────────────────────

export type TipoDeDespedida = 'adiou' | 'agradeceu';
export interface Despedida {
  tipo: TipoDeDespedida;
  /** O que o paciente disse neste turno (as falas seguidas dele, juntas). */
  fala: string;
}

// ── LISTA BRANCA: o PADRÃO É RESPONDER ──────────────────────────────────────────────────────────
//
// Léxico de urgência/triagem nunca fecha ("tô internada", "travou", "estourou", "nem consigo sentar"…). Por isso o desenho
// é o inverso: a Sofia só fica calada se, TIRANDO da fala do paciente (a) a parte reconhecida de despedida/adiamento,
// (b) cortesias (obrigada, ok, 👍…) e (c) uma desculpa curta e benigna (estou no trabalho/dirigindo/sem tempo agora), o que
// SOBRA é VAZIO (só palavras de ligação). Qualquer resto — sintoma, hospital, "tô de cama", horário, pergunta, cumprimento,
// "sim" — e ela RESPONDE. Urgência fora de qualquer léxico nunca vira silêncio.

/** Emojis de cortesia (joinha, mãos, coração, sorriso): não são conteúdo. Qualquer OUTRO emoji (😭, 🤕, 😰, 🚑…) conta como resto. */
const EMOJI_DE_CORTESIA = /[👍🙏❤💙💚😊🙂😉☺😄😁🤗👏🤝✌🫶\u{1F3FB}-\u{1F3FF}‍️]/gu;

/** Normaliza para comparar: minúsculas, sem acento, sem pontuação; emoji de cortesia some, outro emoji vira a palavra "emoji" (resto). "tô" vira "to". */
function normalizar(texto: string): string {
  return texto
    // emoticon de texto: sorriso é cortesia; triste/chorando (:( ;( =( ): T_T -_- >_<) vira resto, como o emoji de aflição
    .replace(/(?<![\p{L}\p{N}])(?:[:;=8]'?-?[(\[/\\|]|[)\]]-?'?[:;=]|t[_.]t|-_-|>_<|:'\()(?![\p{L}\p{N}])/giu, ' emoji ')
    .replace(/(?<![\p{L}\p{N}])(?:[:;=]-?[)dD]|\^\^|<3)(?![\p{L}\p{N}])/gu, ' ')
    .replace(EMOJI_DE_CORTESIA, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' emoji ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    // letra final repetida ("obrigadaa", "valeuu"): vira a palavra normal
    .replace(/([aeiou])\1+(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const COM_VOCES = String.raw`(?: com (?:voces|vcs|a clinica|a equipe|o senhor|a senhora))?`;
/** "para agendar/marcar" SÓ conta colado a um verbo de voltar ("entro em contato para agendar"); sozinho é o pedido de quem QUER marcar. */
const PARA_AGENDAR = String.raw`(?: para (?:agendar|marcar)(?: (?:a )?(?:consulta|avaliacao|horario))?)?`;
const T = String.raw`(?:mais pra frente|mais para frente|em outro momento|outra hora|depois|mais tarde|logo mais|amanha|semana que vem|mes que vem|quando (?:eu )?(?:puder|der|decidir|conseguir|resolver))`;
/** Promessa de voltar que não se confunde com outra coisa. ("retorno" é substantivo em clínica; "volto"/"te ligo"/"te retorno" precisam de "eu" ou de tempo.) */
const FORTE_VERBO = String.raw`(?:entro em contato|entrarei em contato|voltarei|retornarei|volto a (?:falar|conversar|procurar|entrar em contato)|te (?:aviso|chamo|falo|procuro))`;
/** Verbos ambíguos: só com "eu" antes ou tempo ao lado ("eu te retorno", "retorno depois", "depois te ligo"). */
const AMBIGUO_VERBO = String.raw`(?:volto|retorno|te ligo|te retorno)`;
const FRACO_VERBO = String.raw`(?:vejo|marco|agendo|decido|faco|resolvo|falo|aviso|chamo|procuro|ligo)`;

/**
 * Adiamento INEQUÍVOCO: vale mesmo que a Sofia tenha terminado perguntando (adiar é a resposta dele a ela). A ORDEM importa: as
 * frases específicas ("qualquer coisa eu te chamo", "amanhã eu te chamo") saem antes do verbo solto ("te chamo"), senão ele
 * levaria só a metade e sobraria "qualquer coisa". "Quando puder", "vou ver" no fim, "não vou querer" e "para agendar" NÃO estão
 * aqui: respondem a pergunta/pedido da Sofia ("Qual o melhor horário pra te ligar?" — "Quando puder"), ou são o pedido de quem quer marcar.
 */
const ADIA_FORTE: RegExp[] = [
  // "vou pensar/ver e te retorno": o "e te …" fecha a promessa (sem ele, "retorno" sozinho é ambíguo)
  /\bvou (?:pensar|ver|verificar|analisar|avaliar|me organizar)(?: (?:melhor|isso|aqui|com calma|direitinho|um pouco|bem|nisso|no assunto))* e (?:te|lhe) (?:aviso|chamo|falo|procuro|ligo|retorno)\b/g,
  /\bvou pensar(?: (?:melhor|um pouco|com calma|direitinho|bem|nisso|no assunto))*\b/g,
  /\bvou (?:me )?organizar\b/g,
  /\bvou (?:analisar|avaliar)(?: (?:melhor|isso|com calma))*\b/g,
  /\bvou (?:ver|verificar)(?: (?:isso|aqui|com calma|direitinho))?(?= e (?:te|lhe) | e depois)/g,
  /\bvou (?:conversar|falar) com (?:meu|minha|o|a) (?:marido|esposa|mulher|filho|filha|familia|irmao|irma|mae|pai)\b/g,
  /\bvou deixar (?:isso )?(?:pra|para) (?:o )?(?:outro|proximo|depois|mais tarde)(?: (?:mes|dia|semana|ano))?\b/g,
  /\b(?:qualquer coisa|se precisar) (?:eu )?(?:te )?(?:chamo|aviso|falo|procuro)\b/g,
  // tempo + (eu) + verbo, com "para agendar" opcional colado ao verbo
  new RegExp(String.raw`\b${T} (?:eu )?(?:${FORTE_VERBO}|${AMBIGUO_VERBO})${PARA_AGENDAR}${COM_VOCES}\b`, 'g'),
  // verbo forte, com tempo opcional depois
  new RegExp(String.raw`\b(?:eu )?${FORTE_VERBO}${PARA_AGENDAR}${COM_VOCES}(?: ${T})?\b`, 'g'),
  // verbo ambíguo: "eu" antes, ou tempo depois
  new RegExp(String.raw`\beu ${AMBIGUO_VERBO}${PARA_AGENDAR}${COM_VOCES}(?: ${T})?\b`, 'g'),
  new RegExp(String.raw`\b${AMBIGUO_VERBO}${PARA_AGENDAR}${COM_VOCES} ${T}\b`, 'g'),
];

/**
 * Só valem se a Sofia NÃO perguntou nem pediu nada (senão são a resposta a ela): "quando puder" (a "Qual o melhor horário pra te
 * ligar?"), "vou ver" no fim (a "me envie o exame"), "não vou querer" (a uma oferta: é recusa, não adiamento).
 */
const ADIA_SEM_PEDIDO: RegExp[] = [
  /\b(?:quando|assim que) (?:eu )?(?:puder|decidir|resolver|conseguir|der)\b/g,
  /\bvou (?:ver|verificar)(?: (?:isso|aqui|com calma|direitinho))?(?= depois|$)/g,
  /\bnao vou (?:querer|marcar|agendar)(?: (?:marcar|agendar))?\b/g,
  /\bnao quero (?:agora|por enquanto|no momento)\b/g,
];

/** Adiamento com verbo genérico ("depois eu vejo", "mais tarde eu falo"): só vale se a Sofia NÃO tinha perguntado nada. */
const ADIA_GENERICO: RegExp[] = [
  new RegExp(String.raw`\b${T} (?:eu )?${FRACO_VERBO}(?: isso| disso| aqui)?\b`, 'g'),
  new RegExp(String.raw`\b(?:eu )?${FRACO_VERBO}(?: isso| disso| aqui)? ${T}\b`, 'g'),
];

/** "Agora não", "por enquanto não": respondem pergunta de triagem — só valem se a Sofia não perguntou nem pediu nada. */
const ADIA_FRACO: RegExp[] = [
  /\b(?:agora|por enquanto|no momento) nao(?: (?:vou|quero|posso|da|consigo|preciso))?(?: (?:querer|marcar|agendar|falar|conversar))*\b/g,
  /\boutra hora\b/g,
];

/** Desculpa curta e benigna: junto de um adiamento reconhecido, não é conteúdo. */
const DESCULPA_BENIGNA: RegExp[] = [
  /\b(?:to|tou|estou|ta|esta|estava) (?:no|em|na) (?:trabalho|servico|reuniao|aula|transito|mercado|banco|onibus)\b/g,
  /\b(?:to|tou|estou) (?:muito )?(?:trabalhando|dirigindo|ocupad[oa]|correndo|saindo|chegando|almocando|em reuniao)\b/g,
  /\b(?:(?:to|tou|estou|ta|esta) )?(?:muito )?(?:sem tempo|correria|corrido|corrida)\b/g,
  // só com "agora"/"no momento": "não consigo falar/digitar" sozinho pode ser sintoma (fala, mão)
  /\bnao posso (?:falar|conversar|atender|responder) (?:agora|no momento)\b/g,
];

/** Agradecimento / despedida. Sua presença é o que faz uma fala sem adiamento valer como "agradeceu". */
const AGRADECE: RegExp[] = [
  /\b(?:muito )?(?:obrigad[oa]s?|obrigadinh[oa]|obg|obgd|brigad[oa]s?|brigadu|valeu|vlw|agradeco|agradecid[oa]|grat[oa]|tks|thanks)\b/g,
  /\b(?:pel[oa]s?|por) (?:toda |tod[oa]s? )?(?:a |as |o |os )?(?:informacao|informacoes|explicacao|explicacoes|atencao|ajuda|retorno|esclarecimentos?|orientacao|orientacoes|disponibilidade|atendimento|tudo|tempo|paciencia)\b/g,
  /\b(?:tchau|ate (?:mais|logo|breve|amanha)|um abraco|abracos?|fica com deus|deus abencoe|bom descanso|boa semana|bom fim de semana|bom final de semana)\b/g,
  /\btenha (?:um|uma) (?:bom|boa|otimo|otima|excelente|abencoad[oa]) (?:dia|tarde|noite|semana|fim de semana|final de semana)\b/g,
];

/** "Ok", "tá bom": sozinhos não dizem nada; depois de um adiamento no mesmo bloco continuam a despedida. */
const ACK: RegExp[] = [
  /\b(?:ok(?:ay|ey)?|okk+|blz|beleza|show|top|perfeito|certo|fechado|combinado|entendi|entendido|ta bom|tabom|ta|tranquilo)\b/g,
  // interjeição e o nome da persona ("Ah ta, obrigada", "Obrigada Sofia")
  /\b(?:a+h+|ata|hu+m+|hm+|oh+|(?:dra |doutora )?sofia)\b/g,
];



/** O que pode SOBRAR sem ser conteúdo: palavras de ligação. ("to", "bem", "mal", "nao", "sim" NÃO estão aqui de propósito.) */
const LIGACAO = new Set([
  'e', 'eu', 'te', 'lhe', 'me', 'a', 'o', 'as', 'os', 'um', 'uma', 'de', 'do', 'da', 'em', 'no', 'na', 'pra', 'para', 'por',
  'que', 'se', 'logo', 'mais', 'depois', 'agora', 'ja', 'entao', 'ai', 'aqui', 'so', 'mesmo', 'tambem', 'favor', 'pois', 'la',
  'vou', 'vamos', 'irei', 'muito', 'com', 'voces', 'vcs',
]);

interface Analise {
  /** Sobrou só palavra de ligação. */
  limpa: boolean;
  adiou: boolean;
  agradeceu: boolean;
}

interface ContextoDaIa {
  perguntou: boolean;
  iaPediu: boolean;
  ofereceuAjuda: boolean;
}

/** Tira de `t` o que `res` reconhece. Devolve o resto e se tirou alguma coisa. */
function tirar(t: string, res: RegExp[]): { resto: string; tirou: boolean } {
  let resto = t;
  let tirou = false;
  for (const re of res) {
    re.lastIndex = 0;
    const novo = resto.replace(re, ' ');
    if (novo !== resto) tirou = true;
    resto = novo;
  }
  return { resto, tirou };
}

/** Uma fala sozinha do paciente. null = nem vale analisar (pergunta, vazia, longa) e a Sofia responde. */
function analisarFala(texto: string, ctx: ContextoDaIa): Analise | null {
  if (!texto.trim() || texto.length > MAX_CARACTERES || texto.includes('?')) return null;
  let t = normalizar(texto); // vazio = só emoji de cortesia (👍): limpa, sem nada reconhecido
  const abre = !ctx.perguntou && !ctx.iaPediu;
  let adiou = false;
  const passos: Array<[RegExp[], (tirou: boolean) => void, boolean]> = [
    [DESCULPA_BENIGNA, () => undefined, true],
    [ADIA_FORTE, (x) => { adiou ||= x; }, true],
    [ADIA_GENERICO, (x) => { adiou ||= x; }, !ctx.perguntou],
    [ADIA_SEM_PEDIDO, (x) => { adiou ||= x; }, abre],
    [ADIA_FRACO, (x) => { adiou ||= x; }, abre],
  ];
  for (const [res, marca, vale] of passos) {
    if (!vale) continue;
    const r = tirar(t, res);
    t = r.resto;
    marca(r.tirou);
  }
  const ag = tirar(t, AGRADECE);
  t = ag.resto.replace(/\s+/g, ' ').trim();
  // "Não, obrigada" a "posso ajudar em mais algo?": o "não" é a despedida, só se for tudo o que sobrou do agradecimento
  if (ctx.ofereceuAjuda && ag.tirou && /^(?:nao(?: precisa)?|nada|so isso|e so isso)$/.test(t)) t = '';
  t = tirar(t, ACK).resto;
  const sobra = t.split(' ').filter((w) => w && !LIGACAO.has(w));
  return { limpa: sobra.length === 0, adiou, agradeceu: ag.tirou };
}

/** "Muito obrigada pelas informações" etc. já estão em AGRADECE. */
const LINHA_DE_BOTOES = /^\s*\[\[\s*botoes\s*:.*$/gim;

/**
 * A fala da IA terminou perguntando ("…posso ver um horário pra você? ☺️", "Tá sentindo dor? Me conta.")? Aí um "obrigada"
 * solto é RESPOSTA, não despedida. A linha `[[botoes: …]]` não conta como texto (a pergunta vem antes dela) e pergunta com
 * botões é pergunta mesmo sem "?"; depois do último "?" cabe uma frase curta.
 */
export function iaTerminouPerguntando(texto: string | null | undefined): boolean {
  const bruto = (texto ?? '').trim();
  if (!bruto) return false;
  const t = bruto.replace(LINHA_DE_BOTOES, '').trim();
  if (t.length !== bruto.length) return true;
  const i = t.lastIndexOf('?');
  if (i < 0) return false;
  const depois = t.slice(i + 1).replace(/[\s\p{Extended_Pictographic}\p{Emoji_Presentation}️‍.!)\]]+/gu, ' ').trim();
  return depois.length <= 70;
}

/** A fala da IA PEDIU algo ou prometeu voltar, sem "?" ("Me envie o comprovante.", "Vou confirmar com a equipe e já te retorno."): "ok, obrigada" é resposta, não despedida. */
const IA_PEDIU =
  /\bme\s+(?:conta|conte|fala|fale|diz|diga|avise|avisa|informe|envie|mande|passe|manda|passa|envia|confirma|confirme)\b|(?:^|[.!\n]\s*)(?:qual|quais|quanto|onde|como|quando|que\s+horas?|em\s+qual|voc[êe]\s+(?:prefere|quer|pode|consegue|tem))\b|\b(?:envie|mande|manda|envia|informe|passe|diga)\b|\bpreciso\s+d[aeo]s?\b|\bpode\s+me\b|\bpoderia\b|\baguard[ea]\b|\bte\s+retorno\b|\bvou\s+(?:confirmar|verificar|ver)\s+com\b/i;

/** A pergunta da IA era "posso ajudar em mais algo?": "Não, obrigada" é a despedida. */
const OFERTA_DE_AJUDA =
  /\b(?:posso|podemos)\s+(?:te\s+|lhe\s+)?ajudar\s+(?:em|com)\s+(?:mais|algo|outra|alguma)|\bmais\s+alguma\s+(?:coisa|d[úu]vida)|\balguma\s+outra\s+(?:d[úu]vida|coisa)|\balgo\s+mais\b|\bficou\s+(?:com\s+)?alguma\s+d[úu]vida|\bprecisa\s+de\s+mais\s+(?:algo|alguma|informa)/i;

/** Sinal de alerta com todas as letras (rede de segurança extra; a lista branca já responde a tudo que não é despedida limpa). */
export function temSinalOuUrgencia(textos: string[]): boolean {
  return !!sinalNaFala(textos);
}

/**
 * O paciente se despediu ou adiou neste turno? PURA. LISTA BRANCA (ver o bloco acima): cada fala dele, desde a última da
 * IA, tem de ser SÓ despedida/adiamento + cortesia + desculpa benigna; qualquer resto manda a Sofia responder. Dentro de um
 * bloco com adiamento, "obrigada" (antes) e "ok"/👍 (depois) continuam a despedida; cumprimento, pergunta ou conteúdo novo
 * FECHAM o bloco (a Sofia responde). Sem adiamento, vale como "agradeceu" quando há agradecimento e a Sofia não tinha
 * perguntado nem pedido nada (ou tinha oferecido mais ajuda: "Não, obrigada").
 */
export function detectarDespedida(falas: Fala[], falasDoPaciente?: string[]): Despedida | null {
  const turno = turnoDoPaciente(falas);
  const { ultimaIa } = turno;
  // `falasDoPaciente`: o que ele disse neste turno INCLUINDO as linhas dele que vêm no bloco <conversa_oficial> (mensagens que o
  // webhook não trouxe); `falas` não as tem. Tudo o que ele disse passa pela lista branca.
  const textos = falasDoPaciente && falasDoPaciente.length > 0 ? falasDoPaciente : turno.textos;
  if (textos.length === 0 || !ultimaIa) return null;
  const ctx: ContextoDaIa = { perguntou: iaTerminouPerguntando(ultimaIa), iaPediu: IA_PEDIU.test(ultimaIa), ofereceuAjuda: OFERTA_DE_AJUDA.test(ultimaIa) };
  const analises: Analise[] = [];
  for (const t of textos) {
    const a = analisarFala(t, ctx);
    if (!a || !a.limpa) return null;
    analises.push(a);
  }
  const adiou = analises.some((a) => a.adiou);
  if (adiou) return { tipo: 'adiou', fala: textos.join('\n').trim() };
  const livre = (!ctx.perguntou && !ctx.iaPediu) || ctx.ofereceuAjuda;
  if (livre && analises.some((a) => a.agradeceu)) return { tipo: 'agradeceu', fala: textos.join('\n').trim() };
  return null;
}

/** Como o rastro e a nota chamam o que o paciente fez. */
const rotulo = (d: Despedida): string => (d.tipo === 'adiou' ? 'adiou' : 'se despediu');

/**
 * PURA: há no cartão uma tarefa que JÁ chama a equipe para este paciente? Só conta tarefa de ALERTA (o prefixo
 * `ALERTA ·` é a das nossas e das de sinal/entrega/sem resposta; lembrete de robô e tarefa de rotina não chamam ninguém),
 * ABERTA, NÃO vencida e com prazo até 2 h à frente. Vencida (inclusive a DESPEDIDA que ninguém fechou ontem) não conta:
 * nesses casos nasce tarefa nova, porque a nota sozinha não notifica ninguém.
 */
export function tarefaDaEquipeSegura(tarefas: readonly KommoTarefa[], agora: Date): boolean {
  const de = Math.floor(agora.getTime() / 1000);
  const ate = Math.floor((agora.getTime() + TAREFA_LONGE_MS) / 1000);
  return tarefas.some(
    (t) => !t.is_completed && /^\s*ALERTA\b/i.test(t.text ?? '') && !!t.complete_till && t.complete_till >= de && t.complete_till <= ate,
  );
}

export type Decisao =
  | { acao: 'responder'; motivo: string }
  | { acao: 'silenciar'; motivo: string; despedida: Despedida; alertou: boolean };

/** O texto da tarefa que a equipe lê. Prefixo `ALERTA · slug ·` é a chave do roteador de alertas. */
export function textoDaTarefa(args: { slug: string; contato: string | null; despedida: Despedida }): string {
  const fala = mascararPii(args.despedida.fala.replace(/\s+/g, ' ').trim()).slice(0, 120);
  const nome = args.contato?.replace(/\s+/g, ' ').trim();
  const oQue =
    args.despedida.tipo === 'adiou'
      ? 'Paciente adiou e ainda não marcou'
      : 'Paciente agradeceu/se despediu e ainda não marcou';
  return (
    `ALERTA · ${args.slug} · [DESPEDIDA] ${nome ? `[Contato: ${nome}] ` : ''}${oQue} — vale um contato humano. ` +
    `Última mensagem: "${fala}". A Sofia não respondeu.`
  );
}

export function textoDaNota(despedida: Despedida, tarefa: 'criada' | 'ja_existia'): string {
  const fala = mascararPii(despedida.fala.replace(/\s+/g, ' ').trim()).slice(0, 120);
  const complemento =
    tarefa === 'criada' ? 'Tarefa criada para a equipe.' : 'Já há tarefa aberta da equipe neste cartão.';
  return `🤝 Paciente ${rotulo(despedida)} sem consulta marcada ("${fala}"). A Sofia ficou em silêncio. ${complemento}`;
}

// ── efeitos ─────────────────────────────────────────────────────────────────────────────────────

type Recorder = {
  step(args: { kind: 'THINKING' | 'KOMMO_ACTION' | 'COMPLETED' | 'ERROR'; title: string; payload?: unknown }): Promise<void>;
};

/** O que a decisão usa de fora — injetável para teste. */
export interface DepsDaDespedida {
  agora: () => Date;
  /** A marca de hoje já existe (24 h)? */
  avisoDeHoje: (unit: Unit, leadId: number) => Promise<boolean>;
  /** Quando a marca foi gravada, ou null. */
  marcaEm: (unit: Unit, leadId: number) => Promise<Date | null>;
  /** A Sofia (ou a equipe, pelo nosso banco) falou nesta conversa depois de `desde`? Falha de banco = true (o lado seguro é responder). */
  iaFalouDepois: (unit: Unit, leadId: number, desde: Date) => Promise<boolean>;
  /** Tarefas abertas do cartão. LANÇA se o Kommo não respondeu. */
  tarefasAbertas: (unit: Unit, leadId: number) => Promise<KommoTarefa[]>;
  /** O cartão: nome e responsável. null se não deu para ler. */
  cartao: (unit: Unit, leadId: number) => Promise<{ nome: string | null; responsavel: number | null } | null>;
  /** Cria a tarefa. LANÇA se o Kommo não aceitou (2xx sem id também é falha). */
  criarTarefa: (unit: Unit, leadId: number, texto: string, completeAt: number, responsavel: number | null) => Promise<void>;
  /** Nota no cartão, melhor esforço (nunca lança). */
  anotar: (unit: Unit, leadId: number, texto: string) => Promise<boolean>;
  /** A marca do AVISO (quando a tarefa nasceu): é dela que a janela de 6 h e o limite de 1 por dia contam. */
  marcar: (unit: Unit, leadId: number, quando: Date) => Promise<void>;
  /** A marca da ÚLTIMA fala calada (regravada a cada "ok"): só o alerta de "sem resposta" a lê, para cobrir a espera inteira. */
  marcarUltima: (unit: Unit, leadId: number, quando: Date) => Promise<void>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

/**
 * O banco pode falhar ao gravar a marca (`marcarAviso` engole o erro) DEPOIS de a tarefa existir: sem isto cada "ok" seguinte
 * criaria outra. Memória do processo como segunda camada (reinício esquece: no máximo uma tarefa a mais).
 */
const avisadosNaMemoria = new Map<string, Date>();
const chaveDoLead = (unit: Pick<Unit, 'id'>, leadId: number) => `${unit.id}:${leadId}`;

export const DEPS_PADRAO: DepsDaDespedida = {
  agora: () => new Date(),
  avisoDeHoje: async (unit, leadId) => {
    const memoria = avisadosNaMemoria.get(chaveDoLead(unit, leadId));
    if (memoria && Date.now() - memoria.getTime() < JANELA_24H_MS) return true;
    return avisoRecente(unit.id, leadId, REGRA_DESPEDIDA, JANELA_24H_MS);
  },
  marcaEm: async (unit, leadId) => {
    const doBanco = await marcadoEm(unit.id, leadId, REGRA_DESPEDIDA);
    const memoria = avisadosNaMemoria.get(chaveDoLead(unit, leadId)) ?? null;
    return doBanco && memoria ? (doBanco > memoria ? doBanco : memoria) : (doBanco ?? memoria);
  },
  iaFalouDepois: async (unit, leadId, desde) => {
    try {
      const n = await prisma.message.count({
        where: { role: 'assistant', createdAt: { gt: desde }, conversation: { unitId: unit.id, leadId: String(leadId) } },
      });
      return n > 0;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'despedida-humano: não li o banco para ver se a Sofia falou depois do aviso — respondo como hoje');
      return true;
    }
  },
  tarefasAbertas: (unit, leadId) => createKommoClient(unit).tarefasAbertasDoLead(leadId),
  cartao: async (unit, leadId) => {
    try {
      const lead = await createKommoClient(unit).getLead(leadId);
      return { nome: lead?.name?.trim() || null, responsavel: lead?.responsible_user_id || null };
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'despedida-humano: sem o cartão (nome/responsável) — a tarefa vai pelo padrão da unidade');
      return null;
    }
  },
  criarTarefa: async (unit, leadId, texto, completeAt, responsavel) => {
    const criada = await createKommoClient(unit).createTask({
      leadId,
      text: texto,
      completeAt,
      ...(responsavel ? { responsibleUserId: responsavel } : {}),
    });
    if (!criada) throw new Error('o Kommo respondeu sem o id da tarefa');
  },
  anotar: async (unit, leadId, texto) => {
    try {
      return !!(await createKommoClient(unit).addLeadNote(leadId, texto));
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'despedida-humano: não consegui deixar a nota no cartão (segue)');
      return false;
    }
  },
  marcar: async (unit, leadId, quando) => {
    avisadosNaMemoria.set(chaveDoLead(unit, leadId), quando);
    if (avisadosNaMemoria.size > 20_000) for (const [k, t] of avisadosNaMemoria) if (Date.now() - t.getTime() > JANELA_24H_MS) avisadosNaMemoria.delete(k);
    await marcarAviso(unit.id, leadId, REGRA_DESPEDIDA, quando);
  },
  marcarUltima: (unit, leadId, quando) => marcarAviso(unit.id, leadId, REGRA_DESPEDIDA_ULTIMA, quando),
  simular: registrarSimulacao,
};

export interface EntradaDaDespedida {
  unit: Unit;
  leadId: number;
  estado: Estado;
  falas: Fala[];
  /** O que o paciente disse neste turno, com as linhas dele do bloco <conversa_oficial> (`falasDoTurno`). */
  falasDoPaciente?: string[];
  /** O prompt do turno traz consulta marcada / próximo agendamento (`promptTemConsulta`). */
  temConsulta: boolean;
  /** A consulta é DESCONHECIDA (franquia fora do ar, cartão diz que já agendou/é paciente, unidade sem franquia): "sem consulta no prompt" não é "ainda não marcou". */
  consultaDesconhecida: boolean;
  recorder: Recorder;
}

/**
 * Decide o que a Sofia faz neste turno. Nunca lança. `responder` = segue o fluxo de sempre (inclusive a despedida curta).
 * Chamada DEPOIS de montar o prompt (precisa saber se há consulta) e ANTES do modelo (silêncio não gasta token).
 */
export async function decidirDespedida(entrada: EntradaDaDespedida, deps: DepsDaDespedida = DEPS_PADRAO): Promise<Decisao> {
  const { unit, leadId, estado, falas, falasDoPaciente, temConsulta, consultaDesconhecida, recorder } = entrada;
  if (estado === 'desligado') return { acao: 'responder', motivo: 'chave desligada' };
  try {
    // Sinal de alerta, dor ou urgência no que ele disse: NUNCA silêncio, mesmo junto de "vou pensar" (graph.ts roda esta porta
    // ANTES de `passarPorSinalNoTurno`, então a checagem tem de estar aqui).
    if (temSinalOuUrgencia(falasDoPaciente && falasDoPaciente.length > 0 ? falasDoPaciente : turnoDoPaciente(falas).textos)) {
      return { acao: 'responder', motivo: 'sinal de alerta, dor ou urgência — a Sofia responde' };
    }
    const despedida = detectarDespedida(falas, falasDoPaciente);
    if (!despedida) return { acao: 'responder', motivo: 'não é despedida nem adiamento' };
    if (temConsulta) {
      return { acao: 'responder', motivo: 'tem consulta marcada — despedida depois de agendar é normal' };
    }
    if (consultaDesconhecida) {
      return { acao: 'responder', motivo: 'não sei se há consulta marcada (franquia fora do ar, ou o cartão diz que já agendou) — não cala' };
    }
    if (!Number.isFinite(leadId) || leadId <= 0) return { acao: 'responder', motivo: 'sem cartão' };

    if (estado === 'seco') {
      deps.simular(unit, AUTOMACAO_DESPEDIDA_HUMANO, {
        leadId,
        acao: 'alertaria',
        alvo: 'tarefa ALERTA + nota no cartão; a Sofia não responderia',
        valor: `paciente ${rotulo(despedida)}`,
        motivo: `fala: "${mascararPii(despedida.fala.replace(/\s+/g, ' ')).slice(0, 120)}"`,
      });
      await recorder
        .step({
          kind: 'THINKING',
          title: `🤝 [só no papel] Paciente ${rotulo(despedida)} sem consulta marcada — ficaria em silêncio e avisaria a equipe; respondi como hoje`,
          payload: { leadId, tipo: despedida.tipo, fala: despedida.fala },
        })
        .catch(() => undefined);
      logger.info({ unit: unit.slug, leadId, tipo: despedida.tipo }, 'despedida-humano (seco): ficaria em silêncio e avisaria a equipe');
      return { acao: 'responder', motivo: 'só no papel' };
    }

    // ── ligado ──
    const agora = deps.agora();

    // Já avisamos hoje: 1 aviso por cartão por dia. Se a Sofia não falou depois do aviso e ele é recente, é a MESMA situação (o
    // segundo "obrigada"): segue calada, a equipe já sabe. Se ela falou depois, a conversa voltou e foi embora de novo — sem
    // aviso novo (limite do dia) a Sofia não pode se calar: responde como hoje.
    if (await deps.avisoDeHoje(unit, leadId)) {
      const desde = await deps.marcaEm(unit, leadId);
      const falouDepois = desde ? await deps.iaFalouDepois(unit, leadId, desde) : true;
      if (falouDepois) {
        await recorder
          .step({
            kind: 'THINKING',
            title: '🤝 Despedida de novo no mesmo dia, depois de a Sofia ter voltado a falar — o aviso do dia já saiu; respondo como hoje',
            payload: { leadId, fala: despedida.fala },
          })
          .catch(() => undefined);
        return { acao: 'responder', motivo: 'aviso do dia já saiu e a Sofia falou depois' };
      }
      // Aviso velho (mais de 6 h) sem ninguém ter falado: não garante que alguém olhou — cai no caminho normal abaixo (tarefa da
      // equipe vigente, ou tarefa nova). Dentro de 6 h é o MESMO evento: segue calada.
      if (desde && agora.getTime() - desde.getTime() <= JANELA_MESMO_EVENTO_MS) {
        // Só a marca da ÚLTIMA fala calada é regravada (o alerta de "sem resposta" cobre a espera inteira por ela). A marca do AVISO
        // não: a janela de 6 h conta da tarefa, não do último "ok" — senão uma tarefa vencida e ignorada ficaria coberta para sempre.
        await deps.marcarUltima(unit, leadId, agora).catch(() => undefined);
        await recorder
          .step({
            kind: 'THINKING',
            title: '🤝 Despedida repetida: a equipe foi avisada há pouco e a Sofia não falou depois — segue em silêncio',
            payload: { leadId, fala: despedida.fala },
          })
          .catch(() => undefined);
        return { acao: 'silenciar', motivo: 'aviso recente ainda vale', despedida, alertou: false };
      }
    }

    // A equipe já tem tarefa aberta neste cartão: não empilha. A nota diz o que aconteceu.
    let aberta = false;
    try {
      aberta = tarefaDaEquipeSegura(await deps.tarefasAbertas(unit, leadId), agora);
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'despedida-humano: não consegui ler as tarefas do cartão — sigo e crio a minha');
    }
    if (aberta) {
      const anotou = await deps.anotar(unit, leadId, textoDaNota(despedida, 'ja_existia'));
      await deps.marcar(unit, leadId, agora).catch(() => undefined);
      await deps.marcarUltima(unit, leadId, agora).catch(() => undefined);
      await recorder
        .step({
          kind: 'KOMMO_ACTION',
          title: `🤝 Paciente ${rotulo(despedida)} sem consulta marcada — já há tarefa aberta da equipe no cartão: Sofia em silêncio${anotou ? ', nota deixada' : ''}`,
          payload: { leadId, tipo: despedida.tipo, fala: despedida.fala, tarefa: 'ja_existia' },
        })
        .catch(() => undefined);
      return { acao: 'silenciar', motivo: 'já havia tarefa da equipe', despedida, alertou: false };
    }

    const cartao = await deps.cartao(unit, leadId);
    const texto = textoDaTarefa({ slug: unit.slug, contato: cartao?.nome ?? null, despedida });
    try {
      await deps.criarTarefa(unit, leadId, texto, Math.floor(agora.getTime() / 1000) + PRAZO_TAREFA_S, cartao?.responsavel ?? null);
    } catch (err) {
      // O aviso não saiu: a Sofia NÃO pode ficar muda (silêncio sem aviso é o pior caso). Responde como hoje.
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, unit: unit.slug, leadId }, 'despedida-humano: FALHOU criar a tarefa para a equipe — a Sofia responde como hoje');
      await recorder
        .step({
          kind: 'ERROR',
          title: `🤝 Paciente ${rotulo(despedida)}, mas a tarefa para a equipe FALHOU (${msg}) — a Sofia respondeu como hoje, ninguém foi avisado`,
          payload: { leadId, tipo: despedida.tipo, fala: despedida.fala, erro: msg },
        })
        .catch(() => undefined);
      return { acao: 'responder', motivo: `tarefa falhou: ${msg}` };
    }
    // Marca SÓ depois de o Kommo confirmar (falha de rede não cala o aviso por 24 h). A tarefa JÁ existe: nada daqui para baixo
    // pode virar "responder" (o paciente receberia o "combinado" E a equipe, a tarefa).
    await deps.marcar(unit, leadId, agora).catch((err) => logger.warn({ err: String(err), unit: unit.slug, leadId }, 'despedida-humano: tarefa criada, mas a marca não gravou (segue calada)'));
    await deps.marcarUltima(unit, leadId, agora).catch(() => undefined);
    const anotou = await deps.anotar(unit, leadId, textoDaNota(despedida, 'criada'));
    await recorder
      .step({
        kind: 'KOMMO_ACTION',
        title: `🤝 Paciente ${rotulo(despedida)} sem consulta marcada — Sofia em silêncio e tarefa para a equipe${anotou ? ' + nota' : ''}`,
        payload: { leadId, tipo: despedida.tipo, fala: despedida.fala, tarefa: texto },
      })
      .catch(() => undefined);
    logger.info({ unit: unit.slug, leadId, tipo: despedida.tipo }, 'despedida-humano: Sofia em silêncio, equipe avisada');
    return { acao: 'silenciar', motivo: 'tarefa criada', despedida, alertou: true };
  } catch (err) {
    // Qualquer imprevisto: comportamento de hoje. A porta nunca derruba o atendimento.
    logger.error({ err: String(err), unit: unit.slug, leadId }, 'despedida-humano: imprevisto — a Sofia responde como hoje');
    return { acao: 'responder', motivo: `imprevisto: ${String(err)}` };
  }
}
