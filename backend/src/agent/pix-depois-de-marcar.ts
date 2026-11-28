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
 *  - Unidade com antecipado por chave Pix FIXA (sem sinal; é o caso de hoje: nenhuma unidade tem sinal gerado): depois de marcar, a Sofia oferece UMA
 *    vez o valor antecipado ("R$ 250 pelo Pix, com a chave, ou R$ 350 no dia", o preço não muda). Mesmo marcador `sinal_oferecido`, e a régua NÃO a
 *    trata como escolha: só `pix_antecipado` recebe o degrau do Pix (`degrauDoPixNaoSeAplica`), senão o erro de 11/09 voltaria 5 minutos depois da oferta.
 *    "Quero o Pix" grava `pix_antecipado` e CARIMBA o cartão como o main faz ao marcar com Pix ("¤ Pagamento antecipado = Sim" e o valor antecipado); "Pago no
 *    dia" grava `na_clinica`. Sem chave Pix cadastrada ou sem os dois preços não há o que oferecer: marca, vale "na clínica" (gravado) e a promessa de
 *    antecipado vira `resumir_lead_para_sdr`.
 *
 * Fora do alcance, de propósito: Boa Vista (taxa de reserva obrigatória), unidade sem antecipado (Timbó) e remarcação.
 */
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { SinalDaUnidade } from './prompt-composer.js';
import type { Unit } from '@prisma/client';
import { agoraLocalISO } from './consulta-que-passou.js';
import { fusoDaUnidade } from '../lib/fuso.js';

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

/**
 * Resultado do `agendar_consulta` quando a forma NÃO foi perguntada e a unidade NÃO tem sinal, mas TEM chave Pix fixa e os dois preços: a oferta do
 * valor ANTECIPADO depois de marcar (decisão do João de 27/11: tira só a pergunta de ANTES; o desconto do Pix antecipado continua e o preço não muda).
 */
export function orientacaoPixDepoisComChave(precos: { antecipado: number; noDia: number }, chave: string, titular?: string | null): string {
  return (
    ' A forma de pagamento NÃO foi perguntada e NÃO é para perguntar antes: a consulta já está marcada. ' +
    'Na MESMA mensagem da confirmação, ofereça UMA vez o valor antecipado, sem pressão e sem dizer que ele garante a vaga (a vaga já está marcada): ' +
    `a consulta é R$ ${fmt(precos.noDia)} pagando no dia, ou R$ ${fmt(precos.antecipado)} pagando antes pelo Pix — o preço é o de sempre, nada muda. ` +
    'Termine com a linha [[botoes: Quero o Pix | Pago no dia]]. ' +
    `Se ele escolher o Pix (agora ou em outra mensagem), envie a chave Pix COPIADA caractere por caractere: ${chave}${titular ? ` (no nome de ${titular})` : ''}, ` +
    `e o valor R$ ${fmt(precos.antecipado)}, e diga que pode pagar até a véspera — depois disso vale o valor na clínica; NÃO peça comprovante agora. ` +
    'NÃO ofereça de novo e NUNCA cobre o Pix mais de uma vez. ' +
    'Se disser "pago no dia" ou não responder, vale PAGAR NA CLÍNICA: NÃO mencione Pix daqui em diante, a menos que ELE pergunte. ' +
    'PROIBIDO escrever colchete, chave ou lacuna do tipo "[chave]", "R$ [valor]", "XXX": use só os dados escritos acima.'
  );
}

/**
 * Resultado do `agendar_consulta` quando a forma NÃO foi perguntada e NÃO há o que oferecer (sem sinal e sem chave Pix ou sem os dois preços):
 * marcou, vale pagar na clínica. Se ELE perguntar do antecipado, a promessa fica REGISTRADA (resumir_lead_para_sdr), nunca só dita.
 */
export function orientacaoPixDepoisSemSinal(): string {
  return (
    ' A forma de pagamento NÃO foi perguntada e NÃO é para perguntar: vale PAGAR NA CLÍNICA, no dia. ' +
    'NÃO ofereça Pix nem valor antecipado, NÃO envie chave Pix e NÃO peça comprovante. ' +
    'Se ELE perguntar se dá para pagar antes: diga que vai verificar com a equipe, chame resumir_lead_para_sdr dizendo que ele quer pagar antes pelo Pix ' +
    '(para a promessa ficar registrada) e NUNCA invente chave nem valor. Diga o valor na clínica só se ele perguntar.'
  );
}

/** A frase que a ferramenta acrescenta à recusa quando só falta confirmar o dia. */
export const FECHO_RECUSA_SEM_PAGAMENTO =
  ' NÃO pergunte forma de pagamento: ela vem DEPOIS de marcar. Chame agendar_consulta assim que ele confirmar o dia.';

/**
 * Marcador gravado em `conversations.pagamento_escolhido` NO MOMENTO em que `agendar_consulta` marca com sinal e devolve a oferta do sinal.
 * É a prova de que a oferta aconteceu de fato: o histórico guardado não traz a linha `[[botoes: …]]` (é tirada antes de salvar), então olhar a
 * fala da IA não prova nada — este marcador prova. Nenhum outro código lê este valor (follow-up e «agendados sem Pix» só olham `na_clinica`).
 */
export const OFERTA_DO_SINAL_FEITA = 'sinal_oferecido';

/** A resposta de quem recusa o sinal: o botão "Pago no dia" ou o mesmo por extenso, e SÓ isso (frase inteira, curta). */
const RESPOSTAS_QUE_RECUSAM = new Set(['pago no dia', 'pago na clinica', 'prefiro pagar no dia', 'prefiro pagar na clinica', 'vou pagar no dia', 'vou pagar na clinica']);

/** A fala do paciente é a recusa da oferta do sinal (o botão "Pago no dia")? Sem acento, sem pontuação, frase inteira. */
export function recusouOSinal(textoDoPaciente: string | null | undefined): boolean {
  const t = String(textoDoPaciente ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return RESPOSTAS_QUE_RECUSAM.has(t);
}

/**
 * Grava `na_clinica` para quem recusou o sinal — SÓ se (1) a oferta foi feita de fato (marcador `sinal_oferecido` na conversa) e (2) a consulta
 * ainda está marcada e no futuro. É o que tira a pessoa da lista «agendados sem Pix» da recepção. Nunca lança.
 */
export async function gravarRecusaDoSinal(
  unit: Pick<Unit, 'id' | 'businessHoursTimezone' | 'spineTimezone'>,
  leadId: string | number | null | undefined,
): Promise<boolean> {
  if (!leadId || !Number.isInteger(Number(leadId))) return false;
  try {
    const vinculo = await prisma.spineLeadLink.findUnique({ where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: Number(leadId) } }, select: { agendadoPara: true } });
    const quando = (vinculo?.agendadoPara ?? '').slice(0, 16);
    if (!quando || quando < agoraLocalISO(fusoDaUnidade(unit))) return false;
    const r = await prisma.conversation.updateMany({
      where: { unitId: unit.id, leadId: String(leadId), pagamentoEscolhido: OFERTA_DO_SINAL_FEITA },
      data: { pagamentoEscolhido: 'na_clinica' },
    });
    return r.count > 0;
  } catch (err) {
    logger.warn({ err: String(err), unitId: unit.id, leadId }, 'pix-depois-de-marcar: não gravei a recusa do sinal');
    return false;
  }
}

/**
 * O que `decidirPagamentoAntecipado` recebe como forma e como escolha guardada. Com a chave ligada, só a forma DITA agora entra como
 * `formaPagamento`; o `na_clinica` PADRÃO da chave (unidade sem sinal) entra como `escolhaSalva`, o que ativa `preservarSim`: o "Sim" que a
 * equipe pôs no cartão não vira "Não". Com a chave desligada, devolve exatamente o que recebeu.
 */
export function formaParaOCarimbo(a: {
  pixDepois: boolean;
  formaDitaAgora: string | undefined;
  formaFinal: string | undefined;
  escolhaSalva: string | null;
}): { formaPagamento: string | undefined; escolhaSalva: string | null } {
  if (!a.pixDepois || a.formaDitaAgora) return { formaPagamento: a.formaFinal, escolhaSalva: a.escolhaSalva };
  return { formaPagamento: undefined, escolhaSalva: a.formaFinal === 'na_clinica' ? 'na_clinica' : a.escolhaSalva };
}

/** O botão da oferta aceito ("Quero o Pix"): frase inteira, sem acento nem pontuação. Só vale com o marcador da oferta na conversa. */
export function aceitouOPix(textoDoPaciente: string | null | undefined): boolean {
  const t = String(textoDoPaciente ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return t === 'quero o pix' || t === 'quero pix' || t === 'quero o sinal';
}

/**
 * Unidade com chave Pix FIXA (sem sinal gerado): "Quero o Pix" depois da oferta vira `pix_antecipado` (o marcador da oferta troca), para a régua do Pix
 * e a lista «agendados sem Pix» enxergarem quem escolheu pagar antes. Só com o marcador e a consulta ainda de pé. Nunca lança.
 */
export async function gravarAceiteDoPix(
  unit: Pick<Unit, 'id' | 'businessHoursTimezone' | 'spineTimezone'>,
  leadId: string | number | null | undefined,
  opcoes: {
    /**
     * Carimba o CARTÃO depois de a conversa gravar (como o main faz ao marcar com Pix: "¤ Pagamento antecipado = Sim" + o valor antecipado). Recebe o
     * dia e a hora da consulta. Falha dele NÃO desfaz o aceite: quem chama abre nota/tarefa. Sem ele, só a conversa é gravada.
     */
    carimbar?: (quando: { data: string; hora: string }) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  if (!leadId || !Number.isInteger(Number(leadId))) return false;
  try {
    const vinculo = await prisma.spineLeadLink.findUnique({ where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: Number(leadId) } }, select: { agendadoPara: true } });
    const quando = (vinculo?.agendadoPara ?? '').slice(0, 16);
    if (!quando || quando < agoraLocalISO(fusoDaUnidade(unit))) return false;
    // vale a partir do marcador da oferta OU de um `na_clinica` (ele disse "Pago no dia" e depois mudou de ideia: "Quero o Pix"), com a consulta de pé
    const r = await prisma.conversation.updateMany({
      where: { unitId: unit.id, leadId: String(leadId), OR: [{ pagamentoEscolhido: OFERTA_DO_SINAL_FEITA }, { pagamentoEscolhido: 'na_clinica' }] },
      data: { pagamentoEscolhido: 'pix_antecipado' },
    });
    if (r.count === 0) return false;
    if (opcoes.carimbar) {
      const [data, hora] = quando.split('T');
      await opcoes.carimbar({ data, hora }).catch((err) => logger.warn({ err: String(err), unitId: unit.id, leadId }, 'pix-depois-de-marcar: o carimbo do aceite falhou'));
    }
    return true;
  } catch (err) {
    logger.warn({ err: String(err), unitId: unit.id, leadId }, 'pix-depois-de-marcar: não gravei o aceite do Pix');
    return false;
  }
}
