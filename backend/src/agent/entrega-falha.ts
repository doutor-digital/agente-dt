/**
 * Lembra que a última resposta não chegou ao paciente, para o próximo turno.
 *
 * Sem isso a IA conversa sozinha: a mensagem vira nota interna no cartão, o
 * paciente não vê nada, e ela segue como se tivesse falado — repetindo "como eu
 * te disse", cobrando resposta de uma pergunta que ninguém leu. Em 14 dias
 * foram 963 respostas assim, e ela nunca desconfiou de nenhuma.
 *
 * Guardado em memória de propósito: é informação de um turno, morre quando é
 * usada, e perder no restart é aceitável — na pior hipótese ela volta a se
 * comportar como se tivesse falado, que é exatamente o comportamento de antes.
 */

/**
 * Por que a resposta não chegou:
 *  - `falha`: erro nosso na entrega (virou nota interna, Kommo recusou).
 *  - `atropelada`: a resposta estava pronta, mas o paciente mandou outra mensagem
 *    enquanto ela nascia — foi segurada de propósito pra o próximo turno responder
 *    as duas juntas, em vez de ele ler a resposta velha embaixo da pergunta nova.
 */
export type MotivoNaoEntrega = 'falha' | 'atropelada';

interface Presa {
  texto: string;
  quando: number;
  motivo: MotivoNaoEntrega;
}

const presas = new Map<string, Presa>();

/** Passado disso, repetir já não faz sentido: a conversa seguiu. */
export const VALIDADE_MS = 30 * 60_000;

const chave = (unitId: string, leadId: number | string): string => `${unitId}:${leadId}`;

export function marcarNaoEntregue(
  unitId: string,
  leadId: number | string,
  texto: string,
  agora: number = Date.now(),
  motivo: MotivoNaoEntrega = 'falha',
): void {
  const t = (texto ?? '').trim();
  if (!t) return;
  presas.set(chave(unitId, leadId), { texto: t, quando: agora, motivo });
}

/**
 * Devolve o que ficou preso (texto e motivo) e ESQUECE — o aviso vale para o
 * próximo turno e some. Repetir o alerta a cada mensagem faria a IA pedir
 * desculpa em loop.
 */
export function consumirNaoEntregueDetalhe(
  unitId: string,
  leadId: number | string,
  agora: number = Date.now(),
): { texto: string; motivo: MotivoNaoEntrega } | null {
  const k = chave(unitId, leadId);
  const p = presas.get(k);
  if (!p) return null;
  presas.delete(k);
  if (agora - p.quando > VALIDADE_MS) return null;
  return { texto: p.texto, motivo: p.motivo };
}

/** Só o texto — mantido pra quem não precisa do motivo. */
export function consumirNaoEntregue(
  unitId: string,
  leadId: number | string,
  agora: number = Date.now(),
): string | null {
  return consumirNaoEntregueDetalhe(unitId, leadId, agora)?.texto ?? null;
}

/** Só pra teste. */
export function limparNaoEntregues(): void {
  presas.clear();
  seguradas.clear();
}

// ── Respostas seguradas que ficaram no histórico ─────────────────────────────────────────────────────────────

/**
 * A resposta segurada ('atropelada') não sai, mas FICA no histórico do grafo como se a IA tivesse falado. Numa
 * rajada longa isso se repete turno após turno (Araguaína, lead 28681456, 15/10/2026: dez mensagens em três
 * minutos, nenhuma resposta enviada até a última): o modelo lia o próprio histórico, achava que já tinha acolhido
 * a dor ("me faltaram as pernas", "quase não andei") e respondeu só ao "tudo bem graças a Deus" do fim.
 *
 * Guardamos o ID da mensagem do grafo de cada resposta segurada (o reducer do LangGraph dá id a toda mensagem, e
 * ele vai junto no checkpoint) para tirá-la das FALAS que as contas do turno leem (repetição, insistência no preço,
 * rajada — ver `falasDoHistorico`): o que conta é o que o paciente leu. Pelo id, e não pelo texto, para nunca tirar
 * uma resposta que SAIU com as mesmas palavras. A segurada nunca sai depois (a que sai é outra mensagem), então não
 * há o que "limpar" quando a resposta seguinte é entregue. Em memória, como o resto deste arquivo; perdeu no
 * restart, volta ao comportamento de antes.
 */
const seguradas = new Map<string, { ids: string[]; quando: number }>();

/** A conversa do dia: passado disso a resposta segurada já não muda a conta de nada. */
export const VALIDADE_SEGURADA_MS = 24 * 60 * 60_000;
/** Teto por conversa — uma rajada de 20 mensagens não passa disso. */
const MAX_SEGURADAS = 20;
/** Varre os vencidos quando o mapa passa disso (cada lead só é lido quando ele fala de novo). */
const VARRER_ACIMA_DE = 2_000;

export function guardarRespostaSegurada(
  unitId: string,
  leadId: number | string,
  idDaMensagem: string | null | undefined,
  agora: number = Date.now(),
): void {
  const id = (idDaMensagem ?? '').trim();
  if (!id) return;
  if (seguradas.size > VARRER_ACIMA_DE) {
    for (const [k, v] of seguradas) if (agora - v.quando > VALIDADE_SEGURADA_MS) seguradas.delete(k);
  }
  const k = chave(unitId, leadId);
  const atual = seguradas.get(k);
  const ids = atual && agora - atual.quando <= VALIDADE_SEGURADA_MS ? atual.ids : [];
  seguradas.set(k, { ids: [...ids, id].slice(-MAX_SEGURADAS), quando: agora });
}

/** Os ids das respostas seguradas desta conversa. Não consome: vale para o turno todo (o grafo passa mais de uma vez). */
export function respostasSeguradas(unitId: string, leadId: number | string, agora: number = Date.now()): string[] {
  const k = chave(unitId, leadId);
  const s = seguradas.get(k);
  if (!s) return [];
  if (agora - s.quando > VALIDADE_SEGURADA_MS) {
    seguradas.delete(k);
    return [];
  }
  return [...s.ids];
}

/** O id da resposta deste turno no estado do grafo: a última mensagem da IA. */
export function idDaUltimaResposta(mensagens: ReadonlyArray<{ getType(): string; id?: string }> | null | undefined): string | null {
  for (let i = (mensagens?.length ?? 0) - 1; i >= 0; i--) {
    const m = mensagens![i];
    if (m.getType() === 'ai') return m.id ?? null;
  }
  return null;
}

export function renderEntregaFalha(
  texto: string | null,
  motivo: MotivoNaoEntrega = 'falha',
): string {
  if (!texto) return '';
  const trecho = texto.length > 220 ? `${texto.slice(0, 220)}…` : texto;
  if (motivo === 'atropelada') {
    // "As duas mensagens" era pouco: numa rajada de 3 minutos (Araguaína 28681456, 15/10) foram 4 turnos
    // segurados seguidos, e a resposta que saiu respondeu só ao "tudo bem" do fim.
    return (
      '<entrega_falhou>\n' +
      '(a resposta abaixo NÃO foi enviada: o paciente mandou outra mensagem enquanto ela nascia)\n' +
      '- Ele não leu nada disso. Responda AGORA, de uma vez, a TODAS as mensagens dele desde a última resposta ' +
      'que ele recebeu, na ordem em que vieram — não só à última. Dor, limitação ou sinal clínico vem antes de ' +
      'cumprimento.\n' +
      '- Não diga "como eu falei" nem cobre resposta do que estava ali: para ele, aquilo nunca existiu.\n' +
      '- Aproveite o que ainda vale desta resposta; descarte o que a mensagem nova tornou desnecessário.\n' +
      `- O que ficou sem enviar: "${trecho}"\n` +
      '</entrega_falhou>'
    );
  }
  return (
    '<entrega_falhou>\n' +
    '(ATENÇÃO — falha técnica nossa, o paciente NÃO tem culpa)\n' +
    '- A sua última resposta NÃO chegou até ele. Ele não leu nada do que você escreveu.\n' +
    '- Não diga "como eu falei" nem cobre resposta do que estava ali: para ele, aquilo nunca existiu.\n' +
    '- Retome a informação essencial naturalmente, sem pedir desculpa por erro técnico e sem explicar o problema.\n' +
    `- O que não chegou: "${trecho}"\n` +
    '</entrega_falhou>'
  );
}
