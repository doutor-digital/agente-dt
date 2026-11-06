/**
 * O que a perda-ia e a motivo-perdido-ia olham no CARTÃO (puro, sem chamada nenhuma) antes de gastar leitura de conversa
 * e IA. A conversa em si (hora da última fala, equipe falando, pergunta aberta) está em `perda-ia.ts`.
 */
import type { KommoLead } from '../services/kommo.service.js';
import { caixinhaMarcada } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { travaDaPerdaAutomatica, consultaJaOcorreu } from './trava-perda.js';
import { ETIQUETAS_DE_NAO_CONTATAR } from './sofia-fecha-quente-morno.js';
import { diaDaRetomada, retomarEmDoCartao } from './espera-retomada.js';
import { CAMPO, TAG_SEM_REGUA, nomesDoCampo } from './parados.js';
import { ETIQUETA_CURRICULO } from './nao-paciente.js';

export const PERDIDO = 143;

/** Etiquetas de quem já foi tratado (currículo, não contatar): o cartão fica como está. */
const ETIQUETAS_QUE_SEGURAM = [TAG_SEM_REGUA, ...ETIQUETAS_DE_NAO_CONTATAR, ETIQUETA_CURRICULO].map(normalizarNome);

function temEtiqueta(lead: Pick<KommoLead, '_embedded'>, alvos: readonly string[]): boolean {
  return (lead._embedded?.tags ?? []).some((t) => alvos.includes(normalizarNome(t.name ?? '')));
}

function valorDe(lead: Pick<KommoLead, 'custom_fields_values'>, nomes: readonly string[]): string {
  const alvos = nomes.map(normalizarNome);
  const campo = (lead.custom_fields_values ?? []).find((c) => alvos.includes(normalizarNome(c.field_name ?? '')));
  return String(campo?.values?.[0]?.value ?? '').trim();
}

/**
 * `perda-ia`: por que este cartão aberto NÃO é candidato (null = é). Tudo aqui é do próprio cartão, de graça:
 *  - etiqueta de quem já foi tratado (NO_FOLLOW_UP, CURRÍCULO...);
 *  - consulta que já aconteceu ou falta (Atendido / Não compareceu): quem faltou e foi parar em EM ESPERA é do `parados`;
 *  - «Pausar IA» marcado (a SDR ou a equipe está com o paciente);
 *  - ◷ Retomar em de hoje em diante (alguém decidiu esperar até lá);
 *  - consulta futura no cartão, pagamento antecipado, Quente/Morno (a trava da perda automática, a mesma do `parados`).
 * A franquia (consulta futura / tratamento em andamento lá) é conferida depois, só para quem a IA mandaria para PERDIDO.
 */
export function porQueOCartaoFica(
  lead: Pick<KommoLead, '_embedded' | 'custom_fields_values'>,
  o: { agoraEpoch: number; tz: string; pausarIaFieldId: number | null },
): string | null {
  if (temEtiqueta(lead, ETIQUETAS_QUE_SEGURAM)) return 'etiqueta de cartão já tratado (NO_FOLLOW_UP, CURRÍCULO...)';
  // quem já consultou ou faltou é jornada da franquia (parados / franquia-move), não «recusa de lead»: o mesmo corte do motivo-perdido-ia
  if (consultaJaOcorreu(lead)) return 'a consulta já aconteceu ou o paciente faltou: é jornada da franquia';
  if (o.pausarIaFieldId !== null) {
    const campo = (lead.custom_fields_values ?? []).find((c) => c.field_id === o.pausarIaFieldId);
    if (caixinhaMarcada(campo?.values?.[0]?.value)) return '«Pausar IA» marcado: tem gente com o paciente';
  }
  const dia = diaDaRetomada(retomarEmDoCartao(lead.custom_fields_values), o.agoraEpoch, o.tz);
  if (dia === 'futuro' || dia === 'hoje') return `◷ Retomar em ${dia === 'hoje' ? 'é hoje' : 'está no futuro'}: a espera foi decisão de gente`;
  const trava = travaDaPerdaAutomatica(lead, o.agoraEpoch);
  if (trava) return `trava da perda automática: ${trava.motivo}`;
  return null;
}

/** Os nomes (atual e antigos) dos dois campos ⊘ do COMERCIAL. */
const NOMES_NAO_AGENDAMENTO = nomesDoCampo(CAMPO.MOTIVO_NAO_AGENDAMENTO);
const NOMES_NAO_FECHAMENTO = nomesDoCampo(CAMPO.MOTIVO_NAO_FECHAMENTO);

export const JANELA_DO_MOTIVO_S = 24 * 3600;
/** A SDR que acabou de mover ainda pode estar escolhendo o motivo; o robô espera. */
export const CARENCIA_DO_MOTIVO_S = 10 * 60;

/**
 * `motivo-perdido-ia`: este cartão perdido precisa do ⊘ Motivo do não agendamento? null = sim; senão, o porquê de não.
 * Só COMERCIAL em PERDIDO, que entrou há 10 min a 24 h, com os DOIS campos ⊘ vazios (nunca sobrescreve; quem já consultou e
 * não fechou é assunto do «não fechamento», não deste campo) e sem a consulta ter acontecido.
 */
export function porQueNaoPreencherMotivo(
  lead: Pick<KommoLead, 'status_id' | 'pipeline_id' | 'closed_at' | 'updated_at' | 'custom_fields_values' | '_embedded'>,
  o: { agoraEpoch: number; comercialId: number },
): string | null {
  if (lead.status_id !== PERDIDO || lead.pipeline_id !== o.comercialId) return 'não está em PERDIDO do COMERCIAL';
  const entrou = lead.closed_at ?? lead.updated_at ?? 0;
  if (entrou < o.agoraEpoch - JANELA_DO_MOTIVO_S) return 'perdido há mais de 24 h';
  if (entrou > o.agoraEpoch - CARENCIA_DO_MOTIVO_S) return 'perdido há menos de 10 min: a SDR ainda pode estar escolhendo';
  if (valorDe(lead, NOMES_NAO_AGENDAMENTO)) return 'o ⊘ Motivo do não agendamento já está preenchido';
  if (valorDe(lead, NOMES_NAO_FECHAMENTO)) return 'tem ⊘ Motivo de não fechamento: já consultou, não é caso de não agendamento';
  if (consultaJaOcorreu(lead)) return 'a consulta já aconteceu';
  if (temEtiqueta(lead, [normalizarNome(ETIQUETA_CURRICULO)])) return 'currículo: o motivo é o do robô de currículo';
  return null;
}
