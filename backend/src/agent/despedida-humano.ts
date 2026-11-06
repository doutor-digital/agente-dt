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
import type { BaseMessage } from '@langchain/core/messages';
import { logger } from '../lib/logger.js';
import type { Estado } from '../lib/automacoes-estado.js';
import { AUTOMACAO_DESPEDIDA_HUMANO, estadoDaDespedidaHumano } from '../lib/despedida-humano-estado.js';
import { avisoRecente, marcadoEm, marcarAviso, REGRA_DESPEDIDA } from '../lib/aviso-dedupe.js';
import { mascararPii } from '../lib/pii.js';
import { pediuParaParar } from '../lib/pediu-para-parar.js';
import { registrarSimulacao, type Simulacao } from '../lib/so-no-papel.js';
import { prisma } from '../lib/prisma.js';
import { createKommoClient, type KommoTarefa } from '../services/kommo.service.js';
import type { Fala } from './repeticao.js';
import { pacienteEncerrou, turnoDoPaciente } from './paciente-encerrou.js';
import { sinalNaFala } from './sinal-de-alerta.js';
import { ehEncerramento } from '../lib/encerramento.js';

export { AUTOMACAO_DESPEDIDA_HUMANO, estadoDaDespedidaHumano };
export const JANELA_DESPEDIDA_MS = 24 * 3600_000;
/**
 * Despedida repetida sem a Sofia ter falado: dentro desta janela depois do último aviso é o MESMO evento (segue calada). Passada,
 * o aviso de ontem não garante que alguém olhou: vale o caminho normal (tarefa da equipe vigente, ou tarefa nova).
 */
export const JANELA_MESMO_EVENTO_MS = 6 * 3600_000;
/** Prazo da tarefa: não é urgência (o paciente foi embora), mas alguém precisa olhar logo, com o paciente ainda quente. */
export const PRAZO_TAREFA_S = 30 * 60;
/** Tarefa de ALERTA com prazo mais longe que isto não é "a equipe cuidando do paciente agora". */
export const TAREFA_LONGE_MS = 24 * 3600_000;
/** Mais longo que isto não é despedida: é conversa. */
const MAX_CARACTERES = 220;

// ── parte pura ──────────────────────────────────────────────────────────────────────────────────

export type TipoDeDespedida = 'adiou' | 'agradeceu';
export interface Despedida {
  tipo: TipoDeDespedida;
  /** O que o paciente disse neste turno (as falas seguidas dele, juntas). */
  fala: string;
}

/** Verbos de quem promete VOLTAR a tratar do assunto ("eu marco", "te aviso", "volto a falar"). */
const VOLTAR = String.raw`(?:vejo|marco|agendo|decido|volto|entro|chamo|falo|aviso|procuro|retorno|resolvo|fa[cç]o|ligo)`;

/**
 * Adiamento INEQUÍVOCO (vale mesmo que a IA tenha terminado com pergunta — adiar é a resposta dele a ela): o que o
 * `pediuParaParar` (a régua) já reconhece, mais o que ele deixa passar: "entrarei em contato", "não vou querer",
 * "vou me organizar", "vou deixar pra outro mês", "logo mais eu…". "Mais pra frente" e "em outro momento" só valem
 * COM verbo de marcar/voltar: "Dói mais pra frente, perto da virilha" e "já tive essa crise em outro momento" são queixa.
 */
const ADIA_FORTE = new RegExp(
  [
    String.raw`\bentrarei\s+em\s+contato\b|\bvoltarei\b|\bretornarei\b`,
    String.raw`\bn[ãa]o\s+vou\s+(?:querer(?:\s+(?:marcar|agendar))?|marcar|agendar)(?=\s*(?:[,.!;]|$)|\s+(?:agora|por\s+enquanto|no\s+momento|ainda|obrigad|a\s+consulta|consulta|nada|isso))`,
    String.raw`\bn[ãa]o\s+quero\s+(?:agora|por\s+enquanto|no\s+momento)\b`,
    String.raw`\bvou\s+(?:me\s+)?organizar\b`,
    String.raw`\bvou\s+deixar\s+(?:isso\s+)?(?:pra|para)\s+(?:o\s+)?(?:outro|pr[óo]ximo|depois|mais\s+tarde)\b`,
    String.raw`\b(?:mais\s+(?:pra|para)\s+frente|em\s+outro\s+momento)\s+(?:eu\s+)?(?:te\s+|lhe\s+)?${VOLTAR}\b`,
    String.raw`\b${VOLTAR}\b[^.!?\n,;]{0,25}?\b(?:mais\s+(?:pra|para)\s+frente|em\s+outro\s+momento)\b`,
    String.raw`\b(?:logo\s+mais|mais\s+tarde|depois)\s+(?:eu\s+)?(?:te\s+|lhe\s+)?${VOLTAR}\b`,
    String.raw`\b(?:amanh[ãa]|semana\s+que\s+vem|m[eê]s\s+que\s+vem)\s+(?:eu\s+)?(?:te\s+|lhe\s+)?${VOLTAR}\b`,
  ].join('|'),
  'i',
);

/**
 * "Vou verificar se tenho o exame" / "vou verificar com o convênio" é o paciente respondendo, não adiando. O
 * `pediuParaParar` lê "vou verificar" como adiamento (e a régua que o usa não é tocada): aqui a oração sai antes de perguntar.
 */
const VERIFICAR_PARA_RESPONDER = /\bvou\s+verificar\s+(?:se|com|quanto|qual|o\s+exame|meu\s+exame|no|na)\b[^,.;!\n]*/gi;

/**
 * Adiamento FRACO: "agora não", "por enquanto não", "no momento não", "outra hora" também respondem pergunta de triagem
 * ("Você tem exame? — Agora não tenho"; "Está com dor? — Agora não"). Só valem em fala curta, quando a Sofia NÃO terminou
 * perguntando e NÃO tinha pedido algo ("agora não posso, mais tarde te mando o exame" depois de ela pedir o exame).
 */
const ADIA_FRACO =
  /\b(?:agora|por\s+enquanto|no\s+momento)\s+n[ãa]o(?=\s*(?:[,.!;]|$)|\s+(?:obrigad|vou|quero|posso|d[áa]|consigo|preciso)\b)|\bem\s+outra\s+hora\b|\boutra\s+hora\s*$/i;
const MAX_CARACTERES_FRACO = 80;

/**
 * O paciente pede ALGO junto, ou negocia horário ("agora não consigo, pode ser quinta às 14h"): isso é conversa em
 * andamento, e a Sofia tem de responder. Só despedida/adiamento limpo aciona o humano. "Como/qual/quanto/onde" só valem no
 * COMEÇO da oração ("mas qual o endereço"): no meio ("vou ver como fica minha agenda", "depois eu vejo qual dia fica
 * melhor") fazem parte da promessa de voltar.
 */
const PEDE_ALGO = new RegExp(
  [
    String.raw`\bme\s+(?:passa|passe|manda|mande|envia|envie|diz|diga|fala|fale|informa|informe|explica|explique)\b`,
    String.raw`(?:^|[.!;\n]\s*|,\s*(?:e\s+|mas\s+)?|\bmas\s+|\be\s+)(?:qual|quais|quanto|quantos|onde|como|que\s+horas?)\b`,
    String.raw`\b(?:queria|gostaria\s+de)\s+(?:saber|entender|perguntar)\b`,
    // pedido sem "?": "pode passar o endereço", "mande o endereço", "preciso do valor", "quero marcar sexta", "aceita cartão"
    String.raw`\b(?:pode|poderia)\s+(?:passar|enviar|mandar|informar|explicar)\b|\b(?:manda|mande|envia|envie|passa|passe)\b`,
    String.raw`\bpreciso\s+d[aeo]s?\b|\bquero\s+(?:o|a|os|as|um|uma|saber|marcar|agendar|ir|ver|fazer)\b`,
    String.raw`\b(?:aceita|aceitam|atende|atendem)\b|\btem\s+como\b|\bonde\s+fica|\bvoc[êe]s?\s+(?:ficam|atendem|aceitam|tem|t[eê]m)\b`,
    String.raw`\b(?:pode|poderia|consegue|podemos|d[áa])\s+(?:ser|me|marcar|fazer|pra|para)\b`,
    String.raw`\b(?:prefiro|fica\s+melhor\s+(?:pra|para|[àa]s?|de|na|no|em)|vamos\s+marcar|pode\s+marcar|marca\s+(?:pra|para))\b`,
    // "às 14", "as 9": o `\b` do JS é ASCII e não vê fronteira antes do "à" — por isso o lookbehind unicode
    String.raw`(?<![\p{L}\p{N}])[àa]s\s+\d{1,2}|\b\d{1,2}\s*(?:h\b|horas?\b|:\d{2})`,
  ].join('|'),
  'iu',
);

/**
 * O paciente fala de dor, de piora ou de urgência: NUNCA silêncio. Complementa o `sinalNaFala` (que só vê os sinais de
 * alerta com todas as letras): "vou pensar, tô com muita dor" e "quando eu conseguir andar eu vou, a dor tá insuportável"
 * não são sinal de alerta literal, mas quem está assim precisa de resposta agora. Largo de propósito: o custo de errar para
 * este lado é a Sofia responder "combinado" como hoje.
 */
const PRECISA_DE_RESPOSTA =
  /\bd[oó]i\b|\bdoendo\b|\bdor(?:es)?\b|insuport|n[ãa]o\s+aguent|\burgente\b|\burg[êe]ncia\b|\bemerg[êe]ncia\b|\bsocorro\b|desesper|\bpiorand|\bpior\b|\bpiorou\b|n[ãa]o\s+consigo\s+(?:andar|levantar|me\s+mexer)|formigament|\bparalis|sofrend|inc[ôo]modo|travad|n[ãa]o\s+consigo\s+dormir|latej|choque|fisgada|queima[çc][ãa]o|\bdorm[êe]ncia|dormente/iu;

/** Sinal de alerta, dor ou urgência em alguma das falas: a Sofia responde (e `passarPorSinalNoTurno` cuida do resto). */
export function temSinalOuUrgencia(textos: string[]): boolean {
  return !!sinalNaFala(textos) || textos.some((t) => PRECISA_DE_RESPOSTA.test(t));
}

/** "Muito obrigada pelas informações": agradecimento com motivo, que o `ehEncerramento` (só palavras soltas) não reconhece. */
const AGRADECE_POR =
  /^(?:muito\s+)?(?:obrigad[oa]s?|brigad[oa]|valeu|agrade[çc]o)\s+(?:pel[oa]s?|por)\s+(?:toda\s+)?(?:a\s+|as\s+|o\s+|os\s+)?(?:informa[çc][ãõ][eo]s?|explica[çc][ãõ][eo]s?|aten[çc][ãa]o|ajuda|retorno|esclarecimentos?|orienta[çc][ãõ][eo]s?|disponibilidade)[\s.!,\p{Extended_Pictographic}\p{Emoji_Presentation}️]*$/iu;

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

const ia = (texto: string): Fala => ({ papel: 'ia', texto });
const pac = (texto: string): Fala => ({ papel: 'paciente', texto });

/** Só um "ok"/👍/"tá bom" (sem sim, não, isso). */
const SO_OK = /(?<![\p{L}])(?:sim|n[ãa]o|isso|uhum|aham)(?![\p{L}])/iu;

/** Uma fala sozinha do paciente, no que ela É (adiou / agradeceu), sem olhar o contexto da Sofia além do que `ultimaIa` diz. */
function classificarFala(texto: string, ultimaIa: string, haAdiamento: boolean): TipoDeDespedida | null {
  const t = texto.trim();
  if (!t || t.length > MAX_CARACTERES || t.includes('?') || PEDE_ALGO.test(t)) return null;
  if (pediuParaParar(t) === 'irritacao') return null; // outro caso: a régua já se cala
  const encerrou = pacienteEncerrou([ia(ultimaIa), pac(t)]);
  if (
    pediuParaParar(t.replace(VERIFICAR_PARA_RESPONDER, ' ')) === 'adiamento' ||
    ADIA_FORTE.test(t) ||
    encerrou === 'vai_se_organizar'
  ) {
    return 'adiou';
  }
  const perguntou = iaTerminouPerguntando(ultimaIa);
  const iaPediu = IA_PEDIU.test(ultimaIa);
  if (!perguntou && !iaPediu && t.length <= MAX_CARACTERES_FRACO && ADIA_FRACO.test(t)) return 'adiou';
  // Contexto livre: a Sofia só informou; ou ofereceu mais ajuda ("Não, obrigada"); ou o bloco JÁ tem um adiamento (aí o
  // "obrigada" antes e o "ok"/👍 depois são parte da mesma despedida — com o silêncio já feito, um "ok" não pode acordá-la).
  const livre = haAdiamento || OFERTA_DE_AJUDA.test(ultimaIa) || (!perguntou && !iaPediu);
  if (livre && (AGRADECE_POR.test(t) || encerrou === 'agradeceu')) return 'agradeceu';
  if (haAdiamento && ehEncerramento(t) && !SO_OK.test(t)) return 'agradeceu';
  return null;
}

/**
 * O paciente se despediu ou adiou neste turno? PURA.
 *
 * Cada fala dele, desde a última da IA, tem de ser despedida/adiamento POR SI: se a Sofia já se calou uma vez, a mensagem
 * seguinte ("Quero marcar sexta") se junta ao mesmo bloco de falas sem resposta — e uma frase de adiamento antiga não pode
 * calá-la de novo diante de um pedido novo (nem uma pergunta sem resposta de um turno que falhou, ficar sem ela).
 *
 *  - ADIOU: "vou pensar", "entro em contato", "agora não vou querer", "depois eu vejo", "vou me organizar"…
 *  - AGRADECEU: obrigado/valeu/até logo (sem pergunta e sem "sim", segundo o `pacienteEncerrou`) e a última fala da IA
 *    não terminou em pergunta nem pediu nada — ou era "posso ajudar em mais algo?". Dentro de um bloco com adiamento,
 *    "obrigada" (antes) e "ok"/👍 (depois) continuam a despedida. "concordou" sozinho (um "ok" depois de a IA ter fechado)
 *    não conta: não há nada novo a avisar.
 *  - SEMPRE null (a Sofia responde): sinal de alerta, dor, urgência (`temSinalOuUrgencia`), irritação, pergunta do
 *    paciente, pedido junto, nada a que se despedir (a IA ainda não falou).
 */
export function detectarDespedida(falas: Fala[]): Despedida | null {
  const { textos, ultimaIa } = turnoDoPaciente(falas);
  if (textos.length === 0 || !ultimaIa) return null;
  if (temSinalOuUrgencia(textos)) return null;
  // O adiamento vale para o bloco inteiro, esteja onde estiver: "Obrigada!" + "Vou pensar e te retorno".
  const haAdiamento = textos.some((t) => classificarFala(t, ultimaIa, false) === 'adiou');
  let adiou = false;
  for (const t of textos) {
    const tipo = classificarFala(t, ultimaIa, haAdiamento);
    if (!tipo) return null;
    if (tipo === 'adiou') adiou = true;
  }
  return { tipo: adiou ? 'adiou' : 'agradeceu', fala: textos.join('\n').trim() };
}

/** Como o rastro e a nota chamam o que o paciente fez. */
const rotulo = (d: Despedida): string => (d.tipo === 'adiou' ? 'adiou' : 'se despediu');

/**
 * PURA: há no cartão uma tarefa que JÁ chama a equipe para este paciente? Só conta tarefa de ALERTA (o prefixo
 * `ALERTA ·` é a das nossas e das de sinal/entrega/sem resposta; lembrete de robô e tarefa de rotina não chamam ninguém),
 * ABERTA, NÃO vencida e com prazo até 24 h à frente. Vencida (inclusive a DESPEDIDA que ninguém fechou ontem) não conta:
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

export function textoDaNota(despedida: Despedida, tarefa: 'criada' | 'ja_existia' | 'aviso_de_hoje'): string {
  const fala = mascararPii(despedida.fala.replace(/\s+/g, ' ').trim()).slice(0, 120);
  const complemento =
    tarefa === 'criada'
      ? 'Tarefa criada para a equipe.'
      : tarefa === 'ja_existia'
        ? 'Já há tarefa aberta da equipe neste cartão.'
        : 'A equipe já foi avisada hoje.';
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
  marcar: (unit: Unit, leadId: number, quando: Date) => Promise<void>;
  simular: (unit: Pick<Unit, 'id' | 'slug'>, automacao: string, s: Simulacao) => void;
}

export const DEPS_PADRAO: DepsDaDespedida = {
  agora: () => new Date(),
  avisoDeHoje: (unit, leadId) => avisoRecente(unit.id, leadId, REGRA_DESPEDIDA, JANELA_DESPEDIDA_MS),
  marcaEm: (unit, leadId) => marcadoEm(unit.id, leadId, REGRA_DESPEDIDA),
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
  marcar: (unit, leadId, quando) => marcarAviso(unit.id, leadId, REGRA_DESPEDIDA, quando),
  simular: registrarSimulacao,
};

export interface EntradaDaDespedida {
  unit: Unit;
  leadId: number;
  estado: Estado;
  falas: Fala[];
  /** O prompt do turno traz consulta marcada / próximo agendamento (`promptTemConsulta`). */
  temConsulta: boolean;
  recorder: Recorder;
}

/**
 * Decide o que a Sofia faz neste turno. Nunca lança. `responder` = segue o fluxo de sempre (inclusive a despedida curta).
 * Chamada DEPOIS de montar o prompt (precisa saber se há consulta) e ANTES do modelo (silêncio não gasta token).
 */
export async function decidirDespedida(entrada: EntradaDaDespedida, deps: DepsDaDespedida = DEPS_PADRAO): Promise<Decisao> {
  const { unit, leadId, estado, falas, temConsulta, recorder } = entrada;
  if (estado === 'desligado') return { acao: 'responder', motivo: 'chave desligada' };
  try {
    // Sinal de alerta, dor ou urgência no que ele disse: NUNCA silêncio, mesmo junto de "vou pensar" (graph.ts roda esta porta
    // ANTES de `passarPorSinalNoTurno`, então a checagem tem de estar aqui).
    if (temSinalOuUrgencia(turnoDoPaciente(falas).textos)) {
      return { acao: 'responder', motivo: 'sinal de alerta, dor ou urgência — a Sofia responde' };
    }
    const despedida = detectarDespedida(falas);
    if (!despedida) return { acao: 'responder', motivo: 'não é despedida nem adiamento' };
    if (temConsulta) {
      return { acao: 'responder', motivo: 'tem consulta marcada — despedida depois de agendar é normal' };
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
        // Regrava a marca: o alerta de "sem resposta" só cobre a espera se o aviso for posterior à última mensagem dele.
        await deps.marcar(unit, leadId, agora).catch(() => undefined);
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

/**
 * O turno terminou SEM resposta da Sofia? (a última mensagem do grafo ainda é a do paciente.) Os canais que, com a
 * decisão vazia, mandariam um texto de espera (o Salesbot legado) conferem isto antes. Em todo turno normal a última
 * mensagem é da IA, então fora desta chave nada muda.
 */
export function turnoFicouEmSilencio(mensagens: ReadonlyArray<Pick<BaseMessage, 'getType'>> | undefined): boolean {
  const ultima = mensagens?.[mensagens.length - 1];
  return !!ultima && ultima.getType() === 'human';
}
