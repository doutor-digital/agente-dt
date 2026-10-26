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
 */

/** "[imagem do cliente]: COMPROVANTE: R$ 100,00 …" — transcrição de recibo pela visão (foto ou PDF). */
export function ehTranscricaoDeComprovante(texto: string): boolean {
  return /\[(?:imagem|arquivo) do cliente\]:\s*["'“]?\s*COMPROVANTE\b/i.test(texto);
}
