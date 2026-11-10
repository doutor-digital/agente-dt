/**
 * Ferramenta `gerar_sinal_pix` da Sofia 2.0: o Pix do SINAL de R$ 50, gerado no Asaas da unidade (lib/sinal-pix.ts).
 *
 * Só existe para a unidade com a flag `sinalPixCentavos` (e preços legíveis nas fontes: `sinalDaUnidade`); nas demais a ferramenta nem é
 * registrada, e o comportamento é o de sempre. A Sofia chama DEPOIS de `agendar_consulta` dar certo, quando o paciente escolheu o sinal.
 * Sem argumentos obrigatórios: o cartão (leadId) é o da consulta que `agendar_consulta` acabou de marcar neste turno.
 *
 * Falha do Asaas (sem chave, 401/403, timeout, teto do dia) NUNCA derruba a resposta: a ferramenta manda a Sofia dizer que a equipe envia
 * o Pix em instantes e abre a tarefa para a SDR (`sinal_pix_falhou`). Link e sinal já pago são idempotentes (ver lib/sinal-pix.ts).
 */
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { diaCurto, gerarSinalPix, ID_SINAL_PIX, type ResultadoDoSinal } from '../lib/sinal-pix.js';
import { estadoDaAutomacao } from '../lib/automacoes-estado.js';
import { abrirTarefaParaEquipe } from './confirmacao-so-com-crm.js';
import { fmtBRL, sinalDaUnidade, type SinalDaUnidade } from './prompt-composer.js';

interface ContextoDoSinal {
  unit: Unit;
  recorder: TraceRecorder;
  kommo?: KommoClient;
}

// O cartão da consulta que `agendar_consulta` marcou neste turno: é dele o sinal quando o modelo não diz o leadId.
const leadDoTurno = new Map<string, number>();
export function registrarLeadDoSinal(traceId: string, leadId: number): void {
  if (leadDoTurno.size > 500) leadDoTurno.delete(leadDoTurno.keys().next().value as string);
  leadDoTurno.set(traceId, leadId);
}

/** O que a ferramenta devolve à Sofia para cada desfecho. Puro: o teste confere as frases. */
export function textoDoSinal(r: ResultadoDoSinal, s: SinalDaUnidade, tarefaAberta: boolean): string {
  const sinal = `R$ ${fmtBRL(s.sinal)}`;
  const resto = `R$ ${fmtBRL(s.restoNoDia)}`;
  if (r.tipo === 'ja-pago') {
    return (
      `O sinal de ${sinal} deste paciente JÁ foi pago. NÃO gere nem peça outro Pix. Diga que o sinal está confirmado e que no dia ficam ${resto}. ` +
      'NUNCA envie chave Pix.'
    );
  }
  if (r.tipo === 'link') {
    return (
      `Pix do sinal de ${sinal} gerado. Envie ao paciente ESTE link, copiado exatamente, sem encurtar nem mudar: ${r.url} ` +
      `Diga que o link vale até ${diaCurto(r.venceEm)} e que, com o sinal, a consulta fica R$ ${fmtBRL(s.comSinal)} (${sinal} agora + ${resto} no dia). ` +
      (r.novo ? '' : 'Este é o MESMO link já gerado antes: NÃO gere outro. ') +
      'NUNCA envie chave Pix nem diga que a equipe envia a chave. NÃO diga que o pagamento foi confirmado: a confirmação chega sozinha depois que ele pagar.'
    );
  }
  // falhou: a Sofia nunca fala do erro nem inventa um Pix
  return (
    `NÃO consegui gerar o Pix do sinal agora. NÃO invente link nem chave Pix e NÃO conte ao paciente o motivo. ` +
    (tarefaAberta
      ? 'Diga em UMA frase que a equipe envia o Pix do sinal por aqui em instantes (sem prometer prazo exato).'
      : 'O aviso à equipe NÃO saiu: NÃO prometa que a equipe envia. Diga em UMA frase que vai verificar e já retorna.')
  );
}

export function buildGerarSinalPix({ unit, recorder, kommo }: ContextoDoSinal) {
  return new DynamicStructuredTool({
    name: 'gerar_sinal_pix',
    description:
      'Gera o Pix do SINAL (link de pagamento do Asaas da clínica) para o paciente que escolheu garantir a vaga com sinal. ' +
      'Chame SÓ depois de agendar_consulta dar certo e de ele ter escolhido o sinal (formaPagamento=sinal_pix). ' +
      'Devolve o link para você enviar na confirmação. Chamar de novo devolve o MESMO link. Nunca use a chave Pix da clínica.',
    schema: z.object({
      leadId: z.number().int().positive().optional().describe('ID do lead no Kommo — opcional: sem ele vale o da consulta que você acabou de marcar.'),
    }),
    func: async (args: { leadId?: number }) => {
      // O cartão é o da consulta que `agendar_consulta` marcou NESTE turno: vale esse, e o leadId que o modelo escreve não o troca (id alucinado ou
      // induzido por texto do paciente criaria o sinal no cartão de outra pessoa). Sem marcação no turno, vale o do modelo, mas só se a conversa existe.
      const doTurno = leadDoTurno.get(recorder.traceId);
      const leadId = doTurno ?? args.leadId;
      if (!leadId) return 'Informe o leadId desta conversa: o sinal é gerado depois de a consulta estar marcada (agendar_consulta).';
      if (!doTurno) {
        const conversa = await prisma.conversation.findFirst({ where: { unitId: unit.id, leadId: String(leadId) }, select: { id: true } }).catch(() => null);
        if (!conversa) return 'Não achei esta conversa. Use o leadId desta conversa, depois de marcar a consulta com agendar_consulta.';
      }
      const fresca = await prisma.unit.findUnique({ where: { id: unit.id } }).catch(() => null);
      const s = fresca ? sinalDaUnidade(fresca) : null;
      if (!fresca || !s) return 'Esta unidade não usa sinal por Pix. NÃO ofereça sinal; siga a forma de pagamento de sempre.';

      // O sinal garante UMA consulta: ela precisa existir e ainda não ter passado.
      const vinculo = await prisma.spineLeadLink
        .findUnique({ where: { unitId_kommoLeadId: { unitId: fresca.id, kommoLeadId: leadId } }, select: { agendadoPara: true } })
        .catch(() => null);
      const quando = vinculo?.agendadoPara ?? null;
      if (!quando) return 'Ainda não há consulta marcada neste cartão. Marque primeiro com agendar_consulta; só depois gere o sinal.';
      const dia = quando.slice(0, 10);

      // Gerar o link sem a baixa LIGADA deixaria o paciente pagar de verdade e ninguém saber (sem webhook, quem enxerga o Pix é o worker, e em "só no
      // papel" ele não grava nada): só com a baixa ligada; senão a equipe manda o Pix.
      const r: ResultadoDoSinal =
        estadoDaAutomacao(fresca.slug, ID_SINAL_PIX, process.env.SINAL_PIX_SLUGS) !== 'ligado'
          ? { tipo: 'falhou', motivo: 'baixa-desligada', detalhe: 'a automação sinal-pix (baixa do Pix) não está ligada nesta unidade' }
          : await gerarSinalPix(fresca, leadId, dia);
      await recorder.step({
        kind: r.tipo === 'falhou' ? 'ERROR' : 'TOOL_RESULT',
        title: r.tipo === 'link' ? `Sinal Pix ${r.novo ? 'gerado' : 'reaproveitado'} (lead ${leadId})` : r.tipo === 'ja-pago' ? `Sinal Pix já pago (lead ${leadId})` : `Sinal Pix NÃO gerado (lead ${leadId}): ${r.motivo}`,
        payload: r.tipo === 'falhou' ? { leadId, motivo: r.motivo, detalhe: r.detalhe } : { leadId, tipo: r.tipo },
      });

      let tarefaAberta = false;
      if (r.tipo === 'falhou') {
        if (kommo) {
          const t = await abrirTarefaParaEquipe({
            slug: fresca.slug,
            unitId: fresca.id,
            leadId,
            kommo,
            recorder,
            motivo: 'sinal_pix_falhou',
            detalhe: `Motivo: ${r.motivo === 'sem-chave' ? 'a unidade não tem a chave do Asaas no cofre' : r.motivo === 'teto' ? 'teto de links por dia atingido' : r.motivo === 'baixa-desligada' ? 'a baixa automática do sinal não está ligada nesta unidade' : 'o Asaas recusou ou não respondeu'}`,
          }).catch((err) => {
            logger.warn({ err: String(err), leadId }, 'sinal-pix: falha ao abrir a tarefa da equipe');
            return 'falhou' as const;
          });
          tarefaAberta = t !== 'falhou';
        }
      }
      return textoDoSinal(r, s, tarefaAberta);
    },
  });
}
