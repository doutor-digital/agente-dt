/**
 * Chave `pix-depois-de-marcar` (PIX_DEPOIS_DE_MARCAR_SLUGS), decisão do João de 27/11/2026.
 *
 * O problema (análise de 136 conversas, ops/relatorios/2026-11-27-por-que-sofia-nao-converte.md): `agendar_consulta` recusava marcar sem
 * a confirmação do dia E sem a forma de pagamento (trava de 11/09, commit 7a707053). A trava existia por dois motivos — marcar no primeiro
 * "ok" sem saber se o dia servia, e a régua de Pix cobrando 3 a 4 vezes quem ia pagar na clínica. Em 30 dias de produção a Sofia fez a
 * pergunta "Pix antecipado ou na clínica?" em 48 conversas: 16 marcaram pela IA, 22 nunca marcaram (6 calaram logo depois da pergunta).
 *
 * O que muda, só com a chave ligada na unidade:
 *  - SAI a exigência da forma de pagamento antes de marcar. FICA a confirmação do dia ("consegue vir mesmo?") — o motivo nº 1 da trava.
 *  - Unidade COM sinal por Pix: depois de gravar, a Sofia oferece UMA vez o sinal (o preço não muda: R$ X no dia, ou R$ Y com sinal).
 *    A escolha NÃO é gravada como "na clínica": o Pix do sinal segue podendo ser pedido, e a lista «agendados sem Pix» da recepção
 *    (`agendados-sem-pix-worker`, que só tira da lista quem tem `pagamento_escolhido = 'na_clinica'`) continua enxergando a pessoa.
 *    A régua de follow-up já pula os degraus «só Pix» em unidade com sinal (`degrauDoPixNaoSeAplica`), então ninguém é cobrado em duplicidade.
 *  - Unidade com antecipado por chave Pix fixa (sem sinal): não há o que oferecer depois; marca e vale "na clínica". Aqui a escolha é
 *    gravada como `na_clinica` — sem isso a régua AGENDADO (degraus «só Pix») cobraria Pix de quem nunca escolheu, que é o erro de 11/09.
 *
 * Fora do alcance, de propósito: Boa Vista (taxa de reserva obrigatória), unidade sem antecipado (Timbó) e remarcação.
 */
import { automacaoLigada } from '../lib/automacoes-estado.js';
import type { SinalDaUnidade } from './prompt-composer.js';

export const ID_PIX_DEPOIS = 'pix-depois-de-marcar';

/** Mesmo formato do `fmtBRL` do prompt (R$ 350, R$ 12,50), sem importá-lo: o prompt-composer já importa este módulo. */
const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','));

/** A unidade pode marcar sem perguntar a forma de pagamento? Chave ligada e a unidade com antecipado normal (nem Timbó, nem Boa Vista). */
export function pixDepoisDeMarcar(
  unit: { slug?: string | null } | null | undefined,
  contexto: { semAntecipado: boolean; taxaObrigatoria: boolean },
): boolean {
  if (!unit?.slug || contexto.semAntecipado || contexto.taxaObrigatoria) return false;
  return automacaoLigada(unit.slug, ID_PIX_DEPOIS, process.env.PIX_DEPOIS_DE_MARCAR_SLUGS);
}

/** Resultado do `agendar_consulta` quando a forma NÃO foi perguntada e a unidade tem sinal: a oferta depois de marcar. */
export function orientacaoPixDepoisComSinal(sinal: SinalDaUnidade): string {
  return (
    ' A forma de pagamento NÃO foi perguntada e NÃO é para perguntar antes: a consulta já está marcada. ' +
    'Na MESMA mensagem da confirmação, ofereça UMA vez o sinal, sem pressão e sem dizer que ele garante a vaga (a vaga já está marcada): ' +
    `a consulta é R$ ${fmt(sinal.noDia)} pagando tudo no dia, ou R$ ${fmt(sinal.comSinal)} garantindo com sinal de R$ ${fmt(sinal.sinal)} agora por Pix ` +
    `(R$ ${fmt(sinal.restoNoDia)} no dia) — o preço é o de sempre, nada muda. Termine com a linha [[botoes: Quero o Pix | Pago no dia]]. ` +
    'Se ele aceitar (agora ou em outra mensagem), chame gerar_sinal_pix com o leadId desta conversa e use o link que ela devolver; chamar de novo ' +
    'devolve o MESMO link, então NÃO ofereça de novo e NUNCA cobre o Pix mais de uma vez. ' +
    'Se disser "pago no dia" ou não responder, vale PAGAR NA CLÍNICA: NÃO mencione Pix nem sinal daqui em diante, a menos que ELE pergunte. ' +
    'NUNCA envie chave Pix e NÃO peça comprovante.'
  );
}

/** Resultado do `agendar_consulta` quando a forma NÃO foi perguntada e a unidade NÃO tem sinal: marcou, vale pagar na clínica. */
export function orientacaoPixDepoisSemSinal(): string {
  return (
    ' A forma de pagamento NÃO foi perguntada e NÃO é para perguntar: vale PAGAR NA CLÍNICA, no dia. ' +
    'NÃO ofereça Pix nem valor antecipado, NÃO envie chave Pix e NÃO peça comprovante, a menos que ELE pergunte se dá para pagar antes. ' +
    'Diga o valor na clínica só se ele perguntar.'
  );
}

/** A frase que a ferramenta acrescenta à recusa quando só falta confirmar o dia. */
export const FECHO_RECUSA_SEM_PAGAMENTO =
  ' NÃO pergunte forma de pagamento: ela vem DEPOIS de marcar. Chame agendar_consulta assim que ele confirmar o dia.';
