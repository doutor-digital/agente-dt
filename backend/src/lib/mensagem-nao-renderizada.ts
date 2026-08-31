/**
 * Reconhece o aviso de erro do Kommo que chega no lugar da mensagem do paciente.
 *
 * Quando o WhatsApp manda algo que o CRM não consegue exibir (erro 131060), o
 * Kommo entrega ao webhook um texto em inglês no lugar do conteúdo:
 *
 *   "Unable to display this message in CRM. View it in the WhatsApp Business
 *    app. You can reply in CRM. Learn more: https://support.kommo.com/..."
 *
 * Sem tratar, a IA lê isso como se fosse fala do paciente e responde em cima —
 * daí os "respostas vagas" e o "explicou sua limitação em abrir links" que o
 * juiz vinha apontando. Aconteceu 81 vezes em 7 dias.
 *
 * O paciente MANDOU alguma coisa de verdade. O certo é assumir que houve
 * conteúdo e pedir de outro jeito, não responder ao aviso técnico.
 */

const MARCAS = [
  /unable to display this message/i,
  /view it in the whatsapp business app/i,
  /message-available-only-in-the-app/i,
  /não (foi possível|é possível) exibir esta mensagem/i,
];

export function ehAvisoDeMensagemNaoRenderizada(texto: string | null | undefined): boolean {
  const t = (texto ?? '').trim();
  if (!t) return false;
  return MARCAS.some((re) => re.test(t));
}

/**
 * O que a IA lê no lugar do aviso.
 *
 * Escrito como observação entre colchetes, no mesmo formato já usado para
 * imagem ilegível, pra ela entender que é contexto do sistema e não fala do
 * paciente.
 */
export const AVISO_PARA_IA =
  '[o paciente enviou algo que o sistema não conseguiu abrir — pode ser áudio, ' +
  'foto ou documento. NÃO comente o erro nem fale em link: peça, com leveza, ' +
  'que ele conte por escrito o que enviou.]';

/** Troca o aviso técnico pela observação; devolve o texto original se não for aviso. */
export function tratarMensagemNaoRenderizada(texto: string): string {
  return ehAvisoDeMensagemNaoRenderizada(texto) ? AVISO_PARA_IA : texto;
}
