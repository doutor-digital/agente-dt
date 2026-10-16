/**
 * "Esse paciente já existe na franquia?" — antes de a Sofia CRIAR lead ou paciente lá (achado do inventário de 16/10/2026).
 *
 * Desde 02/10 a Sofia criou na franquia leads com o telefone de pacientes que a recepção já tinha cadastrado (ids 6008239,
 * 6013846 e 6019146 na franquia). O caminho era: a Sofia acha o paciente (buscar_paciente grava o idClient no vínculo),
 * marca a consulta e, no fim do turno, o espelhamento do lead não olha o vínculo nem o telefone — e cria um lead novo.
 *
 * Aqui vale a MESMA regra do casamento do robô (decisão 3, 16/10): **idClient → telefone → nome**. Achou = casa com o
 * existente (grava o vínculo) e não cria nada. Dois pacientes diferentes no mesmo telefone = também não cria (o
 * sincronizador marca o cartão e a SDR escolhe). Só a falta de qualquer sinal deixa criar.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from './kommo.service.js';
import type { Estado } from '../lib/automacoes-estado.js';

export type PacienteExistente =
  | { tipo: 'achou'; idClient: number; por: 'idClient' | 'telefone' | 'nome' }
  | { tipo: 'conflito'; ids: number[] };

export async function pacienteQueJaExiste(
  unit: Unit,
  kommoLeadId: number,
  p: {
    nome: string | null; telefone: string | null; idDoCartao?: number | null; kommo?: KommoClient; contatoId?: number | null;
    /** Cadastro duplicado (mesmo nome e telefone): deixa a nota "juntar os cadastros" no cartão, uma vez (ou só registra, em seco). */
    avisarDuplicado?: { seco: boolean };
  },
): Promise<PacienteExistente | null> {
  // import dinâmico: o sincronizador puxa o Kommo, a franquia e os workers — e este arquivo é importado no turno da IA
  const { casarPacienteDoCartao, escolherEntreDuplicados } = await import('../lib/franquia-sync-worker.js');
  const esc = await casarPacienteDoCartao(unit, kommoLeadId, p.nome, {
    fone: p.telefone,
    kommo: p.kommo,
    contatoId: p.contatoId ?? null,
    idDoCartao: p.idDoCartao ?? null,
  });
  if (esc.tipo === 'achou') return { tipo: 'achou', idClient: esc.idClient, por: esc.por };
  if (esc.tipo === 'desempatar') {
    // o mesmo nome e o mesmo telefone em dois cadastros: é a mesma pessoa — fica o de agenda mais recente
    const id = await escolherEntreDuplicados(unit, esc.candidatos);
    if (p.avisarDuplicado && p.kommo) {
      const { avisarCadastroDuplicado } = await import('../lib/conflito-paciente.js');
      await avisarCadastroDuplicado(unit, p.kommo, kommoLeadId, esc.candidatos.map((c) => c.idClient).filter((x): x is number => !!x), id, p.avisarDuplicado.seco);
    }
    return id ? { tipo: 'achou', idClient: id, por: 'telefone' } : null;
  }
  if (esc.tipo === 'conflito') return { tipo: 'conflito', ids: esc.candidatos.map((c) => c.idClient).filter((x): x is number => !!x) };
  return null;
}

export type DecisaoDoCadastro =
  | { criar: true; simular?: { motivo: string; valor: string } }
  | { criar: false; motivo: string; vincular: number | null; jaExistia: boolean };

/**
 * PURA. O que o espelhamento do lead faz com o que `pacienteQueJaExiste` achou, conforme a chave `casamento-jornada`:
 * desligado cria como sempre; só no papel cria e registra que não criaria; ligado casa com o existente (ou, no conflito e
 * na franquia fora do ar, não cria e tenta de novo no próximo turno — melhor atrasar que duplicar).
 */
export function decidirCadastro(estado: Estado, existente: PacienteExistente | null | 'erro'): DecisaoDoCadastro {
  if (estado === 'desligado' || existente === null) return { criar: true };
  if (existente === 'erro') {
    return estado === 'ligado'
      ? { criar: false, motivo: 'não consegui conferir se o paciente já existe na franquia', vincular: null, jaExistia: false }
      : { criar: true };
  }
  const motivo = existente.tipo === 'achou'
    ? `paciente já existe na franquia (idClient ${existente.idClient}, achado por ${existente.por}): não criei lead`
    : `o telefone é de ${existente.ids.length} pacientes da franquia (${existente.ids.join(', ')}): não criei lead — a SDR escolhe no widget`;
  if (estado === 'seco') return { criar: true, simular: { motivo, valor: existente.tipo === 'achou' ? String(existente.idClient) : existente.ids.join(', ') } };
  return { criar: false, motivo, vincular: existente.tipo === 'achou' ? existente.idClient : null, jaExistia: true };
}
