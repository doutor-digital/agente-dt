/**
 * Etapas em que a Sofia NÃO responde, por NOME (decisão do João, 22/09/2026): GANHO / CONCLUÍDO,
 * ALTA e TRATAMENTO CANCELADO. Quem está aí já foi resolvido pela clínica; se o paciente escrever,
 * a equipe decide — a Sofia só deixa uma NOTA no cartão (sem tarefa, sem grupo: política de tarefas
 * enxutas), uma vez por dia por lead.
 *
 * Por que por nome e não pela allowlist de ids (`kommoAllowedStatusIds`): os ids 142 e 143 se
 * repetem nos dois funis — 143 é PERDIDO no COMERCIAL e TRATAMENTO CANCELADO no TRATAMENTO. Na
 * Serra o 143 está liberado pra IA de resgate responder em PERDIDO, e por acidente isso liberava
 * CANCELADO também. PERDIDO e EM ESPERA continuam governados pela allowlist (lá a IA de resgate /
 * a Sofia respondem, por decisão anterior).
 *
 * Só nas unidades em `SOFIA_CALADA_SLUGS` (csv; `*` = todas). Serra primeiro.
 */
import { normalizarNome } from './kommo-schema.js';

export const REGRA_NOTA_CALADA = 'sofia-calada';

const ALTA = normalizarNome('ALTA');
const CANCELADO = normalizarNome('TRATAMENTO CANCELADO');

export interface PosicaoDoLead {
  statusId?: number | null;
  /** nome do funil, pra separar o 143 do COMERCIAL (PERDIDO, fala) do 143 do TRATAMENTO (CANCELADO, cala) */
  pipeline?: string | null;
}

/**
 * Puro: a Sofia fica calada nesta etapa? Aceita "GANHO / CONCLUÍDO", "GANHO", "CONCLUÍDO" e variações
 * de caixa/acento. Também olha a ESTRUTURA: 142 é sempre a etapa ganha do funil (GANHO no COMERCIAL,
 * ALTA no TRATAMENTO) mesmo que a conta ainda a chame de "Fechado - ganho"; 143 no funil TRATAMENTO é
 * o cancelamento. O nome sozinho falha em conta onde a renomeação de 142/143 não pegou.
 */
export function etapaCalada(nomeEtapa: string | null | undefined, pos: PosicaoDoLead = {}): boolean {
  const n = normalizarNome(nomeEtapa ?? '');
  if (n && (n === ALTA || n === CANCELADO || n.startsWith('ganho') || n === 'concluido')) return true;
  if (pos.statusId === 142) return true;
  if (pos.statusId === 143 && normalizarNome(pos.pipeline ?? '').includes('tratamento')) return true;
  return false;
}

export function sofiaCaladaLiberada(slug: string, raw: string | undefined = process.env.SOFIA_CALADA_SLUGS): boolean {
  const lista = (raw ?? '').replace(/^['"]|['"]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  if (lista.length === 0) return false;
  return lista.includes('*') || lista.includes(slug);
}

/** A nota que fica no cartão. Curta: a equipe lê no celular. */
export function notaSofiaCalada(nomeEtapa: string, mensagem: string): string {
  const trecho = mensagem.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `🤫 Paciente escreveu estando em ${nomeEtapa.trim()} — a Sofia não responde nesta etapa; a equipe decide.${trecho ? ` Disse: "${trecho}${mensagem.trim().length > 140 ? '…' : ''}"` : ''}`;
}
