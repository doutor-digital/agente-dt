/**
 * A IA pedindo a mesma coisa de novo e de novo (item 10 da lista de prioridades de 21/10/2026).
 *
 * Medido de 01 a 20/10: o nome foi pedido 3 vezes ou mais em 437 conversas. O bloco <coleta_nome> dizia "se
 * recusar 2x, deixe pra lá", mas quem simplesmente IGNORA a pergunta (manda o anúncio de novo, conta da dor,
 * pergunta o preço) não recusou nada — e a lista <falta_para_agendar> repetia "pergunte como pode chamá-lo" a
 * cada turno. No áudio, 484 ficaram sem transcrição (OpenAI sem crédito) e a Sofia repetia a pergunta como se
 * tivesse ouvido.
 *
 * Isto CONTA no histórico, em código, em vez de pedir ao modelo que conte: quantas vezes a IA já pediu o nome,
 * quantas vezes seguidas fez a mesma pergunta, e quantos áudios seguidos não deu para ouvir. A regra é a do
 * pedido: depois de 2 tentativas sem sucesso, para de pedir; se a conversa travou, passa para uma pessoa.
 *
 * Tudo aqui é função pura sobre a lista de falas — sem banco, sem Kommo — para dar para testar com conversa
 * de verdade.
 */
import type { BaseMessage } from '@langchain/core/messages';

import { semBlocoOficial } from '../lib/conversa-oficial.js';
import { ehSoCumprimento } from '../lib/pediu-para-parar.js';

export interface Fala {
  papel: 'paciente' | 'ia';
  texto: string;
}

/**
 * O que o webhook põe na mensagem do modelo quando o áudio do paciente não virou texto (`AUDIO_NAO_OUVIDO`, em
 * webhook.controller.ts — o teste confere que as duas continuam iguais). Repetido aqui para o agente não
 * depender do controller.
 */
export const MARCA_AUDIO_NAO_OUVIDO = '[áudio do cliente — não deu pra ouvir]';
const AUDIO_SEM_FALA = /\[áudio sem fala detectada\]/;

/** Só o histórico recente conta: o mesmo cartão pode voltar semanas depois, e aí é outra conversa. */
export const JANELA_FALAS = 30;
/** Falas do paciente olhadas para contar áudio não ouvido seguido. */
const JANELA_AUDIO = 12;

/** Depois de quantas tentativas a IA para (pedido do João/chefe: 2). */
export const LIMITE_TENTATIVAS = 2;

/**
 * O pedido do nome para CHAMAR a pessoa ("como posso te chamar?"). O nome completo para marcar a consulta é
 * outra coisa — é obrigatório no cadastro — e não entra na conta.
 */
const PEDE_NOME =
  /\b(?:como\s+(?:eu\s+)?posso\s+te\s+chamar|como\s+(?:voc[eê]|vc)\s+se\s+chama|como\s+(?:[eé]\s+)?(?:o\s+)?seu\s+nome|qual\s+(?:[eé]\s+)?(?:o\s+)?(?:seu|teu)\s+nome|me\s+(?:diz|diga|fala|fale|conta|passa)\s+(?:s[oó]\s+)?(?:o\s+)?seu\s+nome|posso\s+saber\s+(?:o\s+)?seu\s+nome|seu\s+nome,?\s+por\s+favor|com\s+quem\s+(?:eu\s+)?falo)\b/i;
const NOME_COMPLETO = /\bnome\s+completo\b|\bsobrenome\b/i;

export function pedeNome(texto: string): boolean {
  return PEDE_NOME.test(texto) && !NOME_COMPLETO.test(texto);
}

/**
 * A pergunta dos sinais de alerta (força na perna, xixi/intestino, virilha), em qualquer formulação. Araguaína,
 * lead 28659614 (15/10/2026): a Sofia fez essa pergunta 8 vezes em 12 minutos, cada vez com outras palavras ("fraqueza na
 * perna, formigamento ou dificuldade pra segurar xixi?", "a perna bambeou, perdeu a força?"), a um paciente que
 * respondia por áudio sobre outra coisa. Por palavra-chave, todas são a MESMA pergunta.
 */
export const TEMA_SINAL_DE_ALERTA = 'sinal de alerta';
const PERGUNTA_SINAL_DE_ALERTA =
  /perda\s+de\s+for[cç]a|perde[ru]?\s+(?:a\s+)?for[cç]a|sem\s+for[cç]a|fraqueza|pernas?\s+(?:ficou\s+|ficaram\s+|est[aá]\s+)?fracas?|xixi|intestino|bexiga|urin(?:a|ar)\b|evacua|fezes|virilha|regi[aã]o\s+(?:da\s+)?sela/i;

export function perguntaDeSinalDeAlerta(pergunta: string): boolean {
  return PERGUNTA_SINAL_DE_ALERTA.test(pergunta);
}

/** Do que trata a pergunta. Duas perguntas com o mesmo tema são a mesma pergunta, mesmo com outras palavras. */
const TEMAS: Array<[string, RegExp]> = [
  ['nome', PEDE_NOME],
  [TEMA_SINAL_DE_ALERTA, PERGUNTA_SINAL_DE_ALERTA],
  ['onde dói', /onde\s+(?:[eé]\s+(?:que\s+)?)?(?:d[oó]i|est[aá]\s+(?:essa\s+|a\s+)?dor|voc[eê]\s+sente|sente)|qual\s+(?:a\s+)?regi[aã]o|em\s+que\s+(?:parte|regi[aã]o)/i],
  ['há quanto tempo', /h[aá]\s+quanto\s+tempo|desde\s+quando|faz\s+quanto\s+tempo/i],
  ['cidade', /\bmora\s+(?:aqui\s+)?(?:em|no|na|perto)\b|qual\s+(?:a\s+)?(?:sua\s+)?cidade|de\s+(?:qual|que)\s+cidade|de\s+onde\s+(?:voc[eê]|vc)\s+[eé]/i],
  ['horário', /qual\s+(?:desses|dos\s+dois|dos\s+hor[aá]rios|hor[aá]rio|dia)|qual\s+(?:deles\s+)?fica\s+melhor|prefere\s+(?:de\s+|pela\s+)?manh[aã]|manh[aã]\s+ou\s+(?:[aà]\s+|de\s+)?tarde|algum\s+desses/i],
  ['pagamento', /como\s+prefere\s+pagar|antecipado\s+(?:no\s+pix\s+|por\s+pix\s+)?ou\b|pix\s+antecipado\s+ou/i],
];

function temasDe(pergunta: string): Set<string> {
  return new Set(TEMAS.filter(([, re]) => re.test(pergunta)).map(([t]) => t));
}

function perguntasDe(texto: string): string[] {
  return texto
    .split(/(?<=[?!.])\s+|\n+/)
    .map((f) => f.trim())
    .filter((f) => f.includes('?'));
}

/** A última frase com "?" da mensagem — é ela que espera resposta. */
export function perguntaFinal(texto: string): string | null {
  const perguntas = perguntasDe(texto);
  return perguntas.length ? perguntas[perguntas.length - 1] : null;
}

/**
 * A pergunta que a mensagem deixa esperando: a dos sinais de alerta, se ela estiver em QUALQUER frase (é a que
 * trava a conversa, e a IA costuma fechar com outra coisa: "...segurar xixi ou intestino? Preciso entender isso
 * antes de seguir, tá?"); senão, a última frase com "?".
 */
export function perguntaQueEspera(texto: string): string | null {
  const perguntas = perguntasDe(texto);
  if (perguntas.length === 0) return null;
  return perguntas.find(perguntaDeSinalDeAlerta) ?? perguntas[perguntas.length - 1];
}

function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\[[^\]]*\]:?/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function palavras(s: string): Set<string> {
  return new Set(normalizar(s).split(' ').filter((p) => p.length >= 4));
}

/** Mesma pergunta: mesmo tema, ou quase as mesmas palavras (Jaccard ≥ 0,6 com pelo menos 3 palavras). */
export function mesmaPergunta(a: string, b: string): boolean {
  const ta = temasDe(a);
  const tb = temasDe(b);
  for (const t of ta) if (tb.has(t)) return true;
  const pa = palavras(a);
  const pb = palavras(b);
  if (pa.size < 3 || pb.size < 3) return false;
  let comum = 0;
  for (const p of pa) if (pb.has(p)) comum++;
  return comum / (pa.size + pb.size - comum) >= 0.6;
}

/**
 * A fala do paciente não responde nada: só emoji ou pontuação, áudio sem fala, áudio que não deu pra ouvir, ou
 * a MESMA mensagem que ele já tinha mandado (o anúncio repetido). Cumprimento ("bom dia") NÃO entra: quem volta
 * dizendo oi está retomando a conversa, não fugindo da pergunta. "ok", "sim" e "não" também não — respondem
 * pergunta fechada.
 */
export function respostaVazia(texto: string, anteriorDoPaciente?: string | null): boolean {
  if (texto.includes(MARCA_AUDIO_NAO_OUVIDO)) return true;
  const semMarcas = texto.replace(/\[[^\]]*\]:?/g, ' ');
  if (AUDIO_SEM_FALA.test(texto) && !/[\p{L}\p{N}]/u.test(semMarcas)) return true;
  if (!/[\p{L}\p{N}]/u.test(semMarcas)) return true;
  // A mesma mensagem de novo só conta para texto puro: duas fotos ou dois áudios com descrição parecida não são
  // "a mesma coisa".
  if (anteriorDoPaciente && !/\[[^\]]*\]/.test(texto)) {
    const n = normalizar(texto);
    if (n.length > 0 && n === normalizar(anteriorDoPaciente)) return true;
  }
  return false;
}

/**
 * A fala responde à pergunta dos sinais de alerta? Sim/não, "não senti nada disso", ou falar do que foi perguntado
 * (perna, força, formigamento, xixi, intestino…). Áudio sobre o endereço, o preço ou o dia de vir NÃO responde —
 * e para esta pergunta isso conta como "sem resposta", porque é a resposta que falta para seguir com segurança.
 */
const RESPONDE_SINAL_DE_ALERTA = new RegExp(
  [
    // começa respondendo: "sim", "não", "nada", "nenhum", "senti sim"… (\b do JS não enxerga o "ã": fim à mão)
    String.raw`^\s*(?:sim|s|n[aã]o|nada|nenhum|nenhuma|nunca|negativo|tenho|tive|senti|sinto)(?![\wÀ-ÿ])`,
    String.raw`n[aã]o\s+(?:senti|sinto|tive|tenho|percebi|notei)(?![\wÀ-ÿ])|nada\s+disso|nenhum(?:a)?\s+(?:dess[ae]s?|disso)|gra[cç]as\s+a\s+deus\s+n[aã]o`,
    String.raw`perna|for[cç]a|fraq|formig|dorm[eê]n|dormente|xixi|urin|intestin|fezes|bexiga|banheiro|evacu|segur(?:o|ar|ando)|control|virilha|\bsela\b`,
  ].join('|'),
  'i',
);

export function respondeSinalDeAlerta(texto: string): boolean {
  return RESPONDE_SINAL_DE_ALERTA.test(texto.replace(/\[[^\]]*\]:?/g, ' ').trim());
}

/** "Já te falei", "já respondi": ele respondeu e a IA não viu. Não é conversa travada — é a IA que não leu. */
const JA_RESPONDEU = /\bj[aá]\s+(?:te\s+|lhe\s+)?(?:falei|disse|respondi|mandei|informei|expliquei|passei)\b/i;

export interface Repeticao {
  /** Quantas vezes a IA já pediu o nome na janela recente, antes deste turno. */
  pedidosDeNome: number;
  /**
   * A última pergunta da IA, quantas vezes seguidas ela foi feita (1 = só uma vez) e, dessas, quantas seguidas
   * (da mais recente para trás, contando a fala deste turno) ficaram sem resposta nenhuma.
   */
  ultimaPergunta: { texto: string; vezes: number; semRespostaSeguidas: number; tema: string | null } | null;
  /** A fala deste turno não responde nada. */
  semResposta: boolean;
  /** Ele diz que já respondeu. */
  disseQueJaRespondeu: boolean;
  /** Áudios seguidos que não deu para ouvir, contando o deste turno (0 se o deste turno foi ouvido ou não houve). */
  audiosNaoOuvidos: number;
}

export function analisarRepeticao(falasTodas: Fala[]): Repeticao {
  // Até a fala do paciente deste turno: no meio do turno (depois de uma ferramenta) pode haver texto da IA
  // depois dela, e esse texto ainda não foi para o paciente.
  let fim = falasTodas.length - 1;
  while (fim >= 0 && falasTodas[fim].papel !== 'paciente') fim--;
  const vazio: Repeticao = { pedidosDeNome: 0, ultimaPergunta: null, semResposta: false, disseQueJaRespondeu: false, audiosNaoOuvidos: 0 };
  if (fim < 0) return vazio;

  const falas = falasTodas.slice(Math.max(0, fim + 1 - JANELA_FALAS), fim + 1);
  const atual = falas[falas.length - 1].texto;
  const antes = falas.slice(0, -1);

  const pedidosDeNome = antes.filter((f) => f.papel === 'ia' && pedeNome(f.texto)).length;

  // A última pergunta da IA e quantas vezes seguidas ela apareceu. Mensagem da IA sem pergunta (o "sem pressa"
  // da régua) não quebra a sequência; uma pergunta DIFERENTE quebra. Para transferir, conta só as vezes que
  // ficaram SEM resposta: se ele respondeu e a IA perguntou de novo para esclarecer, a pergunta não ficou sem
  // resposta (achado do Codex, 21/10) — a cadeia para ali.
  const anteriorDoPaciente = (j: number): string | null => {
    for (let k = j - 1; k >= 0; k--) if (falas[k].papel === 'paciente') return falas[k].texto;
    return null;
  };
  let ultimaPergunta: Repeticao['ultimaPergunta'] = null;
  let cadeiaSemResposta = true;
  for (let i = falas.length - 2; i >= 0; i--) {
    if (falas[i].papel !== 'ia') continue;
    const q = perguntaQueEspera(falas[i].texto);
    if (!q) continue;
    if (!ultimaPergunta) {
      // O tema que não é o nome manda: "como posso te chamar e onde dói?" repetida é a pergunta da dor.
      const temas = [...temasDe(q)];
      ultimaPergunta = { texto: q, vezes: 1, semRespostaSeguidas: 0, tema: temas.find((t) => t !== 'nome') ?? temas[0] ?? null };
    } else if (mesmaPergunta(ultimaPergunta.texto, q)) {
      ultimaPergunta.vezes++;
    } else {
      break;
    }
    // o que o paciente mandou depois desta pergunta, até a próxima fala da IA (para a última, é a fala deste turno).
    // Na pergunta dos sinais de alerta, falar de outra coisa também é ficar sem resposta (lead 28659614) — menos o
    // cumprimento, que segue sendo retomada, como no resto desta conta.
    const sinal = ultimaPergunta.tema === TEMA_SINAL_DE_ALERTA;
    let semResposta = true;
    for (let j = i + 1; j < falas.length && falas[j].papel === 'paciente'; j++) {
      const t = falas[j].texto;
      if (respostaVazia(t, anteriorDoPaciente(j))) continue;
      if (!sinal || respondeSinalDeAlerta(t) || ehSoCumprimento(t)) semResposta = false;
    }
    if (cadeiaSemResposta && semResposta) ultimaPergunta.semRespostaSeguidas++;
    else cadeiaSemResposta = false;
  }

  const doPaciente = antes.filter((f) => f.papel === 'paciente');
  const anterior = doPaciente.length > 0 ? doPaciente[doPaciente.length - 1].texto : null;

  let audiosNaoOuvidos = 0;
  if (atual.includes(MARCA_AUDIO_NAO_OUVIDO)) {
    // as últimas falas DO PACIENTE (a da IA e a de ferramenta no meio não podem encurtar a janela — Codex, 21/10)
    const recentes = falas.filter((f) => f.papel === 'paciente').slice(-JANELA_AUDIO);
    for (let i = recentes.length - 1; i >= 0; i--) {
      const t = recentes[i].texto;
      // seguidos de verdade: qualquer outra fala dele no meio (texto, áudio ouvido) quebra a sequência (Codex, 21/10)
      if (t.includes(MARCA_AUDIO_NAO_OUVIDO)) audiosNaoOuvidos++;
      else break;
    }
  }

  return {
    pedidosDeNome,
    ultimaPergunta,
    semResposta: respostaVazia(atual, anterior),
    disseQueJaRespondeu: JA_RESPONDEU.test(atual.replace(/\[[^\]]*\]:?/g, ' ')),
    audiosNaoOuvidos,
  };
}

/** Parou de pedir o nome: já foram 2 tentativas. */
export function pararDePedirNome(r: Repeticao): boolean {
  return r.pedidosDeNome >= LIMITE_TENTATIVAS;
}

/**
 * A conversa travou e vai para uma pessoa: a mesma pergunta (que não seja o nome — sem nome dá para seguir)
 * já foi feita 2 vezes e nas 2 ficou sem resposta (a fala deste turno incluída); ou é o 2º áudio seguido que não
 * deu pra ouvir.
 */
export function motivoDeHandoff(r: Repeticao): string | null {
  if (r.audiosNaoOuvidos >= LIMITE_TENTATIVAS) {
    return `áudio não ouvido ${r.audiosNaoOuvidos}x seguidas`;
  }
  const q = r.ultimaPergunta;
  if (!q || q.semRespostaSeguidas < LIMITE_TENTATIVAS || q.tema === 'nome' || r.disseQueJaRespondeu) return null;
  if (q.tema === TEMA_SINAL_DE_ALERTA) {
    // Aqui a fala deste turno pode ter conteúdo (o áudio sobre o endereço) e mesmo assim não responder — a cadeia
    // já conferiu isso. O motivo NÃO diz "sinal de alerta": ninguém confirmou sinal nenhum, e esse texto viraria
    // tarefa URGENTE de "paciente com sinal de alerta" (MOTIVO_SINAL_DE_ALERTA em sinal-de-alerta.ts).
    return `conversa travada: pergunta de segurança da coluna (força na perna, xixi/intestino) ${q.vezes}x sem resposta`;
  }
  if (!r.semResposta) return null;
  return `conversa travada: mesma pergunta ${q.vezes}x sem resposta${q.tema ? ` (${q.tema})` : ''}`;
}

/** O que o paciente lê quando a conversa vai para a equipe por repetição (sem prometer "em instantes"). */
export const FRASE_HANDOFF_REPETICAO =
  'Vou pedir pra alguém da nossa equipe continuar seu atendimento por aqui, tá bem? 🙏';
export const FRASE_HANDOFF_AUDIO =
  'Não consegui ouvir seu áudio por aqui 🙏 Vou pedir pra alguém da nossa equipe ouvir e continuar seu atendimento por aqui, tá bem?';

/**
 * O bloco do turno. Vazio quando não há nada a dizer — bloco que aparece sempre vira ruído e o modelo passa a
 * ignorar.
 */
export function renderRepeticao(r: Repeticao): string {
  const linhas: string[] = [];
  const handoff = motivoDeHandoff(r);

  if (r.audiosNaoOuvidos >= LIMITE_TENTATIVAS) {
    linhas.push(
      `- ÁUDIO: é a ${r.audiosNaoOuvidos}ª vez seguida que não deu pra ouvir o áudio dele. NÃO peça pra mandar de novo nem ` +
        'pra escrever, e NÃO responda como se tivesse entendido. Chame pausar_ia (motivo: "áudio não ouvido") e diga, ' +
        'em UMA frase, que não conseguiu ouvir e que alguém da equipe vai ouvir o áudio e continuar o atendimento por ' +
        'aqui. Isto vale mais do que a instrução que veio junto do áudio.',
    );
  }

  if (pararDePedirNome(r)) {
    linhas.push(
      `- NOME: você já pediu o nome ${r.pedidosDeNome} vezes nesta conversa. NÃO peça de novo — nem "como posso te ` +
        'chamar", nem "qual seu nome", nem no meio de outra pergunta. Siga sem o nome, pelo que ele está falando. ' +
        '(O nome completo só na hora de marcar a consulta, se for marcar.)',
    );
  }

  const q = r.ultimaPergunta;
  if (q && q.vezes >= LIMITE_TENTATIVAS && q.tema !== 'nome' && r.audiosNaoOuvidos < LIMITE_TENTATIVAS) {
    if (handoff) {
      linhas.push(
        `- CONVERSA TRAVADA: você já fez ${q.vezes} vezes a mesma pergunta ("${q.texto.slice(0, 120)}") e ele de novo ` +
          'não respondeu. NÃO pergunte de novo. Chame pausar_ia (motivo: "conversa travada: mesma pergunta 2x sem ' +
          'resposta") e diga, em UMA frase e sem outra pergunta, que alguém da equipe vai continuar o atendimento por aqui.',
      );
    } else if (r.disseQueJaRespondeu) {
      linhas.push(
        `- Ele diz que JÁ RESPONDEU ("${q.texto.slice(0, 120)}"). Releia a conversa e use a resposta dele. NÃO faça ` +
          'essa pergunta de novo. Se não achar a resposta, peça desculpa em uma frase e siga para o próximo passo.',
      );
    } else {
      linhas.push(
        `- Você já fez ${q.vezes} vezes a mesma pergunta ("${q.texto.slice(0, 120)}"). NÃO repita. Responda ao que ele ` +
          'escreveu agora e siga com o que tem; se não der para avançar sem essa resposta, chame pausar_ia e diga que ' +
          'alguém da equipe continua o atendimento por aqui.',
      );
    }
  }

  if (linhas.length === 0) return '';
  return `<repeticao>\n(ALTA PRIORIDADE — contado pelo sistema no histórico desta conversa; vale mais que <falta_para_agendar> e <coleta_nome>)\n${linhas.join('\n')}\n</repeticao>`;
}

function textoDe(conteudo: unknown): string {
  if (typeof conteudo === 'string') return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .join('\n');
  }
  return '';
}

/**
 * A conversa como falas (paciente × IA), a partir das mensagens do grafo. Ferramenta e sistema ficam de fora, e
 * também as respostas seguradas que nunca saíram (`seguradas`: os ids guardados por `guardarRespostaSegurada`, em
 * entrega-falha.ts) — elas ficam no histórico do grafo, mas para as contas do turno vale o que chegou até ele.
 */
export function falasDoHistorico(mensagens: BaseMessage[], seguradas: ReadonlyArray<string> = []): Fala[] {
  const fora = new Set(seguradas);
  const falas: Fala[] = [];
  for (const m of mensagens) {
    const tipo = m.getType();
    if (tipo !== 'human' && tipo !== 'ai') continue;
    if (tipo === 'ai' && m.id && fora.has(m.id)) continue;
    const bruto = textoDe(m.content);
    const texto = (tipo === 'human' ? semBlocoOficial(bruto) ?? '' : bruto).trim();
    if (tipo === 'ai' && !texto) continue;
    falas.push({ papel: tipo === 'human' ? 'paciente' : 'ia', texto });
  }
  return falas;
}

/**
 * Ferramentas que mostram que a IA andou com a conversa neste turno (consultou agenda, marcou, transferiu). As de
 * anotação (tag, título, campo, tarefa) não contam: dá para anotar e mesmo assim repetir a pergunta.
 */
const FERRAMENTAS_DE_AVANCO = new Set([
  'pausar_ia',
  'resumir_lead_para_sdr',
  'agendar_consulta',
  'remarcar_consulta',
  'cancelar_consulta',
  'confirmar_presenca',
  'consultar_horarios',
  'buscar_paciente',
  'cadastrar_paciente',
  'fechar_lead',
  'mover_etapa',
  'mover_funil',
]);

/** Nomes das ferramentas chamadas depois da última fala do paciente (o turno em curso). */
export function ferramentasDoTurno(mensagens: BaseMessage[]): string[] {
  const nomes: string[] = [];
  for (let i = mensagens.length - 1; i >= 0; i--) {
    const m = mensagens[i];
    const tipo = m.getType();
    if (tipo === 'human') break;
    if (tipo === 'ai') {
      for (const c of (m as unknown as { tool_calls?: Array<{ name?: string }> }).tool_calls ?? []) {
        if (c?.name) nomes.push(c.name);
      }
    }
  }
  return nomes;
}

export const INSTRUCAO_REFAZER_SEM_NOME =
  '[instrução interna, não é fala do paciente] Você já pediu o nome 2 vezes nesta conversa e ele não deu. ' +
  'Reescreva a MESMA resposta SEM pedir o nome (nem "como posso te chamar", nem "qual seu nome"): mantenha o resto, ' +
  'o tom, e termine com UMA pergunta sobre o que ele está falando. Responda só com a mensagem final.';

export type TravaDaResposta =
  | { acao: 'passar_para_equipe'; motivo: string; frase: string }
  | { acao: 'refazer_sem_nome' }
  | null;

/**
 * Depois que o modelo respondeu (sem ferramenta pendente): ele obedeceu ao bloco <repeticao>?
 *  - conversa travada (ou 2º áudio não ouvido) e ele não transferiu nem avançou → passa para a equipe aqui, em
 *    código: chama pausar_ia e troca a resposta pela frase fixa;
 *  - já pediu o nome 2 vezes e a resposta pede de novo → refaz UMA vez sem o pedido.
 */
export function travaDaResposta(r: Repeticao, resposta: string, ferramentas: string[]): TravaDaResposta {
  const motivo = motivoDeHandoff(r);
  if (motivo && !ferramentas.some((f) => FERRAMENTAS_DE_AVANCO.has(f))) {
    return {
      acao: 'passar_para_equipe',
      motivo,
      frase: r.audiosNaoOuvidos >= LIMITE_TENTATIVAS ? FRASE_HANDOFF_AUDIO : FRASE_HANDOFF_REPETICAO,
    };
  }
  if (pararDePedirNome(r) && pedeNome(resposta)) return { acao: 'refazer_sem_nome' };
  return null;
}
