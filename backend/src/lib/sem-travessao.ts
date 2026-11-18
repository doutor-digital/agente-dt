/**
 * Tira o travessão (—) e o meio-travessão (–) da fala da IA ao paciente.
 *
 * Pedido do João (18/11/2026, Salto): "tire os hifens da IA, porque fica parecendo IA". O travessão é a marca
 * mais visível de texto de modelo ("pode trazer no dia da consulta — ela é usada como complemento"); secretária
 * no WhatsApp escreve com vírgula. Só a resposta ao paciente passa por aqui — nota, tarefa e campo do cartão
 * (que a equipe lê) ficam como estão. O hífen comum ("bem-vindo", "94246-9735", "425 - Centro") não é tocado.
 *
 *   colado entre palavras/números ("08–12", "seg–sex") → hífen comum
 *   no começo da linha → some
 *   depois de pontuação (", —", "! —") → some
 *   no meio da frase ("consulta — ela é") → vírgula
 */
export function semTravessao(texto: string): string {
  if (!/[—–]/.test(texto)) return texto;
  return texto
    .replace(/(\S)[—–](\S)/g, '$1-$2')
    .replace(/^[ \t]*[—–][ \t]*/gm, '')
    .replace(/([,.;:!?])[ \t]*[—–][ \t]*/g, '$1 ')
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    .replace(/,[ \t]*([,.;:!?])/g, '$1')
    .replace(/,[ \t]*$/gm, '')
    .replace(/[ \t]{2,}/g, ' ');
}
