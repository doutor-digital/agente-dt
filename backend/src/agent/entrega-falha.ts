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
}

export function renderEntregaFalha(
  texto: string | null,
  motivo: MotivoNaoEntrega = 'falha',
): string {
  if (!texto) return '';
  const trecho = texto.length > 220 ? `${texto.slice(0, 220)}…` : texto;
  if (motivo === 'atropelada') {
    return (
      '<entrega_falhou>\n' +
      '(a resposta abaixo NÃO foi enviada: o paciente mandou outra mensagem enquanto ela nascia)\n' +
      '- Ele não leu nada disso. Responda AGORA às duas mensagens dele de uma vez, na ordem em que vieram.\n' +
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
