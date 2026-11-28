/**
 * O aceite do Pix na unidade com chave Pix FIXA (chave `pix-depois-de-marcar`): o paciente respondeu "Quero o Pix" à oferta do antecipado feita DEPOIS de
 * marcar. A conversa passa a `pix_antecipado` (pix-depois-de-marcar.ts); aqui o CARTÃO acompanha, como o main faz ao marcar com Pix escolhido:
 * "¤ Valor da Consulta" = o valor antecipado (a régua pede R$ 250; a recepção não pode ver R$ 350) e "¤ Pagamento antecipado" = Sim.
 *
 * Usa as MESMAS regras do agendamento (`decidirPagamentoAntecipado`, `valorDaConsultaAoAgendar`), então concordam sempre. `preservarSim`: um "Sim" que a
 * equipe já pôs não é reescrito. Se qualquer passo falhar, abre uma NOTA no cartão — o paciente já ouviu que o Pix vale e a recepção precisa saber.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { valorDaConsultaAoAgendar } from '../lib/valor-consulta-agendar.js';
import { logger } from '../lib/logger.js';
import { decidirPagamentoAntecipado, valorDoCampo } from './carimbos-do-agendamento.js';

const NOME_PAGAMENTO_ANTECIPADO = '¤ Pagamento antecipado';
const NOME_ST_RETORNO = 'RETORNO PÓS-TRATAMENTO';

export type DesfechoDoCarimbo = 'carimbado' | 'ja-estava' | 'nao-se-aplica' | 'falhou';

export async function carimbarAceiteDoPix(a: {
  unit: Unit;
  kommo: Pick<KommoClient, 'getLead' | 'setLeadCustomFieldValue' | 'addLeadNote' | 'listLeadCustomFields'> & Record<string, unknown>;
  leadId: number;
  data: string;
  hora: string;
}): Promise<DesfechoDoCarimbo> {
  const { unit, kommo, leadId } = a;
  const nota = async (motivo: string) => {
    await kommo
      .addLeadNote(leadId, `Sofia: o paciente aceitou o Pix antecipado (consulta de ${a.data} às ${a.hora}), mas não consegui carimbar o cartão (${motivo}). Confira "¤ Pagamento antecipado" = Sim e "¤ Valor da Consulta" = valor antecipado.`)
      .catch((err: unknown) => logger.warn({ err: String(err), leadId }, 'aceite-do-pix: nem a nota no cartão saiu'));
  };
  try {
    const esquema = await esquemaDaUnidade(unit, kommo as unknown as KommoClient);
    const idPagamento = esquema.campoPorNome(NOME_PAGAMENTO_ANTECIPADO);
    const leadAtual = await kommo.getLead(leadId).catch(() => null);
    if (!leadAtual) {
      await nota('não li o cartão');
      return 'falhou';
    }
    const stRetorno = esquema.statusPorNome('COMERCIAL', NOME_ST_RETORNO);
    const ehRetorno = stRetorno !== null && leadAtual.status_id === stRetorno;
    const valorAtual = valorDoCampo(leadAtual, idPagamento);
    const pagamento = decidirPagamentoAntecipado({
      semAntecipado: false,
      preservarSim: true,
      ehRetorno,
      pagamentoComprovado: false,
      formaPagamento: 'pix_antecipado',
      escolhaSalva: null,
      valorAtual,
    });
    // retorno pós-tratamento não é pré-pago: nada a carimbar
    if (pagamento.valor !== 'Sim') return 'nao-se-aplica';
    // o valor ANTES da forma, como no agendamento: o modelo "consulta prepagamento" do Kommo lê este campo assim que a forma vira Sim
    await valorDaConsultaAoAgendar({ unit, kommo: kommo as unknown as KommoClient, leadId, leadAtual, data: a.data, hora: a.hora, pagamento: 'Sim', ehRetorno, ehAvaliacao: true });
    if (String(valorAtual ?? '').trim().toLowerCase() === 'sim') return 'ja-estava';
    if (idPagamento === null) {
      await nota('o campo "¤ Pagamento antecipado" não existe nesta conta');
      return 'falhou';
    }
    await kommo.setLeadCustomFieldValue(leadId, idPagamento, 'select', 'Sim');
    return 'carimbado';
  } catch (err) {
    logger.warn({ err: String(err), leadId, unit: unit.slug }, 'aceite-do-pix: falha ao carimbar o cartão');
    await nota(String(err).slice(0, 80));
    return 'falhou';
  }
}
