/**
 * "Esse paciente já existe na franquia?" — antes de a Sofia CRIAR lead ou paciente lá (achado do inventário de 16/10/2026).
 *
 * Desde 02/10 a Sofia criou na franquia leads com o telefone de pacientes que a recepção já tinha cadastrado (ids 6008239,
 * 6013846 e 6019146 na franquia). O caminho era: a Sofia acha o paciente (buscar_paciente grava o idClient no vínculo),
 * marca a consulta e, no fim do turno, o espelhamento do lead não olha o vínculo nem o telefone — e cria um lead novo.
 *
 * Aqui vale a MESMA ordem do casamento do robô (decisão 3, 16/10): **idClient → telefone → nome** — mas no modo
 * `cadastro`: o nome tem de bater em todo passo. Achou = casa com o existente (grava o vínculo) e não cria nada. Dois
 * pacientes diferentes no mesmo telefone = não cria (o sincronizador marca o cartão e a SDR escolhe). O paciente do
 * cartão, do vínculo ou do telefone com OUTRO nome (a mãe, quando a Sofia cadastra a filha pelo WhatsApp dela) = também
 * conflito: nem casa com a mãe, nem cria por cima — a equipe confere (achado 1 da revisão de 16/10). Só a falta de
 * qualquer sinal deixa criar.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from './kommo.service.js';
import type { Estado } from '../lib/automacoes-estado.js';
import { nomesCompletosCompativeis } from '../lib/nome-compativel.js';

/** Começo do `motivo` que o espelhamento grava no vínculo quando CASOU com paciente que já existia (quem lê o vínculo compara com isto). */
export const PREFIXO_PACIENTE_EXISTENTE = 'paciente já existe na franquia';
/** Idem, para o telefone que já era LEAD na franquia (o 1º contato não cria o segundo cadastro). */
export const PREFIXO_LEAD_EXISTENTE = 'lead já existe na franquia';

/**
 * O motivo que o 1º contato grava quando o telefone já era LEAD na franquia. O id e o NOME do lead achado ficam aqui (e não em
 * `spine_id_lead`): só quem agenda, comparando o nome que o paciente deu com este, pode converter o lead achado em paciente.
 */
export function motivoDeLeadJaExistente(a: { id: number; nome: string | null; onde: string }): string {
  return `${PREFIXO_LEAD_EXISTENTE} (idLead ${a.id}, nome ${a.nome ? JSON.stringify(a.nome) : 'desconhecido'}, achado pelo telefone ${a.onde}): não criei lead — o lead NÃO foi vinculado ao cartão (telefone sozinho não prova a pessoa; quem agenda confere o nome)`;
}

/** O lead achado pelo telefone que o motivo guarda (ver `motivoDeLeadJaExistente`), ou `null` se o motivo é de outro tipo. */
export function leadAchadoNoMotivo(motivo: string | null | undefined): { id: number; nome: string | null } | null {
  const m = String(motivo ?? '');
  if (!m.startsWith(PREFIXO_LEAD_EXISTENTE)) return null;
  const id = /\(idLead (\d+)/.exec(m);
  if (!id) return null;
  const n = /, nome ("(?:[^"\\]|\\.)*")/.exec(m);
  let nome: string | null = null;
  if (n) {
    try { nome = String(JSON.parse(n[1]!)).trim() || null; } catch { nome = null; }
  }
  return { id: Number(id[1]), nome };
}

/**
 * Que lead da franquia a consulta pode converter em paciente? (decidido na HORA DE AGENDAR, com o nome que o paciente DEU)
 *  - o lead que o vínculo guarda como SEU (`spineIdLead`: criado por nós para este cartão);
 *  - o lead que o 1º contato apenas ACHOU pelo telefone (só no motivo): só se o nome da consulta bate com o dele, nome e sobrenome. O nome
 *    do cartão nunca serve de prova (vem do perfil do WhatsApp, que é o da mãe quando a filha escreve do aparelho dela).
 * Nenhum dos dois: `id` nulo — cria-se o paciente novo, como sempre. `achadoDescartado` diz o lead que ficou de fora, para o log.
 */
export function leadParaConverter(
  vinculo: { spineIdLead?: number | null; motivo?: string | null } | null | undefined,
  nomeDaConsulta: string | null | undefined,
): { id: number | null; achadoDescartado: number | null } {
  if (vinculo?.spineIdLead) return { id: vinculo.spineIdLead, achadoDescartado: null };
  const achado = leadAchadoNoMotivo(vinculo?.motivo);
  if (!achado) return { id: null, achadoDescartado: null };
  return nomesCompletosCompativeis(nomeDaConsulta, achado.nome)
    ? { id: achado.id, achadoDescartado: null }
    : { id: null, achadoDescartado: achado.id };
}

/**
 * De onde veio um vínculo "ok": criado por NÓS, o telefone já era lead lá, ou já era paciente lá. Quem conta "enviados por nós" (tela da
 * franquia, conferência dos 7 dias) não pode somar os que já existiam: eles nunca foram enviados, e a conferência os daria como "faltando".
 */
export type TipoDoVinculo = 'criado' | 'lead-ja-existia' | 'paciente-ja-existia';
export function tipoDoVinculo(motivo: string | null | undefined): TipoDoVinculo {
  const m = motivo ?? '';
  if (m.startsWith(PREFIXO_PACIENTE_EXISTENTE)) return 'paciente-ja-existia';
  if (m.startsWith(PREFIXO_LEAD_EXISTENTE)) return 'lead-ja-existia';
  return 'criado';
}

/** Quantos vínculos de cada tipo (ver `TipoDoVinculo`). */
export function contarPorTipoDoVinculo(motivos: ReadonlyArray<string | null | undefined>): Record<TipoDoVinculo, number> {
  const out: Record<TipoDoVinculo, number> = { criado: 0, 'lead-ja-existia': 0, 'paciente-ja-existia': 0 };
  for (const m of motivos) out[tipoDoVinculo(m)]++;
  return out;
}

export type PacienteExistente =
  | { tipo: 'achou'; idClient: number; por: 'idClient' | 'telefone' | 'nome' }
  /** `outroNome`: o telefone (ou o cartão) é de UM paciente com outro nome — pode ser alguém da família. */
  | { tipo: 'conflito'; ids: number[]; outroNome?: boolean };

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
    modo: 'cadastro',
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
  if (esc.tipo === 'conflito') return { tipo: 'conflito', ids: esc.candidatos.map((c) => c.idClient).filter((x): x is number => !!x), ...(esc.outroNome ? { outroNome: true } : {}) };
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
    ? `${PREFIXO_PACIENTE_EXISTENTE} (idClient ${existente.idClient}, achado por ${existente.por}): não criei lead`
    : existente.outroNome
      ? `o telefone (ou o cartão) é do paciente idClient ${existente.ids.join(', ')} da franquia, com outro nome: não criei lead — pode ser outra pessoa da família; a equipe confere`
      : `o telefone é de ${existente.ids.length} pacientes da franquia (${existente.ids.join(', ')}): não criei lead — a SDR escolhe no widget`;
  if (estado === 'seco') return { criar: true, simular: { motivo, valor: existente.tipo === 'achou' ? String(existente.idClient) : existente.ids.join(', ') } };
  return { criar: false, motivo, vincular: existente.tipo === 'achou' ? existente.idClient : null, jaExistia: true };
}
