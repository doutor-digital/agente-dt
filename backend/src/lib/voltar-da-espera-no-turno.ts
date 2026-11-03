/**
 * "Paciente em EM ESPERA que escreve de verdade volta para EM QUALIFICAÇÃO" é uma decisão do momento em que a mensagem
 * CHEGA (webhook ao vivo). O turno retomado depois de um deploy (lib/recuperar-turnos.ts) refaz um pedido que pode ter
 * minutos: mexer na ETAPA agora seria agir sobre uma conversa que já seguiu — e a etapa dispara automações (um cartão
 * que sai de EM ESPERA ou de ALTA recebe template meses depois). O campo e a resposta, sim; a etapa, não.
 * Devolve se rodou.
 */
export async function voltarDaEsperaNoTurno(retomada: boolean | undefined, voltar: () => Promise<void>): Promise<boolean> {
  if (retomada) return false;
  await voltar();
  return true;
}
