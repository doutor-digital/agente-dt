/**
 * Comprovante de pagamento lido na conversa.
 *
 * A leitura de imagem/PDF começa a transcrição com "COMPROVANTE:" quando reconhece um recibo, e o webhook a
 * pespega na mensagem do paciente como "[imagem do cliente]: COMPROVANTE: …" (ou "[arquivo do cliente]: …").
 *
 * Decisão do João (26/10/2026): comprovante NÃO autoriza marcar nem confirmar — quem confere o pagamento e cria a
 * consulta é a equipe (ver `agent/confirmacao-so-com-crm.ts`). Por isso a antiga `provaDePagamentoAntecipado`
 * (que deixava `agendar_consulta` reservar em Boa Vista a partir do campo "Pagou antecipado" do cartão, escrito
 * pela própria IA, ou do comprovante no histórico) saiu: o campo é informação, não prova.
 *
 * REVERTIDA em 03/11/2026, SÓ para unidade com `units.spine_booking_requires_payment` (hoje, Boa Vista), por decisão do João. Motivo: a
 * recepção de Boa Vista reclamou que a Sofia recebia o comprovante da taxa de reserva e ficava "esperando a equipe confirmar" em vez de
 * lançar a consulta (28/10: "recebi seu comprovante e já passei pra nossa equipe confirmar — assim que confirmarem, eu garanto o horário
 * de amanhã às 15h30"). Agora a Sofia lança a consulta quando o CÓDIGO aceita o comprovante (`lib/comprovante-pix.ts`: favorecido, valor,
 * ID E2E, data, autenticidade, E2E nunca reaproveitado) e a equipe recebe a tarefa «Conferir no extrato» — o risco aceito é um Pix que
 * não caiu virar consulta marcada, e a tarefa existe para pegá-lo. Nas demais unidades a regra de 26/10 segue valendo, sem mudança.
 */

/** "[imagem do cliente]: COMPROVANTE: R$ 100,00 …" — transcrição de recibo pela visão (foto ou PDF). */
export function ehTranscricaoDeComprovante(texto: string): boolean {
  return /\[(?:imagem|arquivo) do cliente\]:\s*["'“]?\s*COMPROVANTE\b/i.test(texto);
}
