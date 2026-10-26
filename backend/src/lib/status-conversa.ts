/**
 * "⬢ Status da conversa" — quem manda neste campo.
 *
 * O campo tinha QUATRO escritores sem hierarquia, e cada um lia de uma fonte diferente:
 *   - carimbo-etapa (webhook de etapa)  → "Encerrada"       (lê a ETAPA do cartão)
 *   - lead-metrics, fim do turno da IA  → "Aguardando lead"  (lê a conversa)
 *   - carimbarHumanoAssumiu (pausar_ia, auto-pausa, pausa da equipe) → "Respondendo"
 *   - follow-up, fim da escada          → "Sem resposta"     (lê a escada)
 * Em 24/10/2026, na Açailândia, 5 dos 6 "Encerrada" que o carimbo gravou em PERDIDO foram desfeitos em
 * minutos — três deles pelo follow-up (leads 29017216, 29020564, 29020582) e dois pela IA ao passar o
 * cartão para um humano (29027086, 29027778). Nenhum escritor falhou, por isso o log de erros ficou em 0.
 *
 * A regra, num lugar só: a ETAPA é a verdade (decisão do João já registrada em carimbo-etapa.ts). Cartão em
 * etapa de encerramento (GANHO / CONCLUÍDO, PERDIDO) está "Encerrada", e nenhum escritor automático desfaz
 * isso. Quem tira o cartão do "Encerrada" é a equipe movendo-o de etapa — depois disso a IA volta a escrever o
 * campo no próximo turno (se a IA estiver pausada, o "Encerrada" fica até alguém ou a escada reescrever: ninguém
 * limpa o campo ao reabrir o cartão — lacuna que já existia, fora deste conserto). Quem escreve "Encerrada" é só o
 * carimbo de etapa.
 *
 * Duas guardas, por escritor: o fim do turno da IA respeita a ETAPA (guarda que ele já tinha, vale em toda unidade e
 * cobre o `fechar_lead` do mesmo turno, antes do carimbo gravar); handoff e follow-up respeitam a etapa E o valor —
 * só recusam quando o campo já diz "Encerrada" (senão, cartão encerrado onde o carimbo não gravou congela o campo).
 *
 * Este arquivo é PURO (sem rede, sem banco): a decisão e a definição de "etapa que encerra".
 */
import { normalizarNome } from './kommo-schema.js';

export type StatusConversa = 'Aguardando lead' | 'Respondendo' | 'Sem resposta' | 'Encerrada';

/** O que os escritores automáticos podem pedir. "Encerrada" não está aqui: é só do carimbo de etapa. */
export type StatusAutomatico = Exclude<StatusConversa, 'Encerrada'>;

export const STATUS_ENCERRADA: StatusConversa = 'Encerrada';

/** Quem está tentando escrever — vai para o log, para o "quem desfez o quê" nunca mais depender de adivinhação. */
export type OrigemDoStatus = 'turno-da-ia' | 'humano-assumiu' | 'follow-up-sem-resposta';

/** Ids fixos do Kommo para "fechado e ganho" / "fechado e perdido" — os mesmos em todo funil e toda conta. */
const IDS_DE_ENCERRAMENTO = new Set([142, 143]);

/**
 * A etapa de nome `nomeEtapa` encerra a conversa? É a MESMA definição que o carimbo de etapa usa para gravar
 * "Encerrada" — vive aqui para quem grava e quem respeita não poderem divergir.
 * "GANHO / CONCLUÍDO" e variações ("GANHO", "CONCLUÍDO") e PERDIDO.
 */
export function etapaEncerraConversa(nomeEtapa: string | null | undefined): boolean {
  const n = normalizarNome(nomeEtapa ?? '');
  if (!n) return false;
  return n === normalizarNome('PERDIDO') || n.startsWith('ganho') || n === 'concluido';
}

/**
 * Etapas de 142/143 que NÃO encerram a conversa: no funil TRATAMENTO os mesmos ids se chamam "ALTA" e "TRATAMENTO
 * CANCELADO", e o carimbo de etapa só carimba o fim do tratamento ali, nunca "Encerrada".
 */
const ETAPAS_DE_TRATAMENTO = new Set([normalizarNome('ALTA'), normalizarNome('TRATAMENTO CANCELADO')]);

/**
 * O cartão está numa etapa que encerra a conversa? 142/143 são os mesmos ids em todo funil e só o nome diz o que
 * significam. Então: o nome que encerra (PERDIDO, GANHO…) vale; o nome que o carimbo sabe que NÃO encerra (ALTA,
 * TRATAMENTO CANCELADO) não vale; qualquer outro nome — ou nenhum — cai no id, que é o que o Kommo garante
 * (142 = fechado e ganho, 143 = fechado e perdido), como a guarda antiga do turno da IA já fazia.
 */
export function cartaoEncerrado(
  lead: { status_id?: number | null } | null | undefined,
  nomeDaEtapa: string | null | undefined,
): boolean {
  if (etapaEncerraConversa(nomeDaEtapa)) return true;
  if (ETAPAS_DE_TRATAMENTO.has(normalizarNome(nomeDaEtapa ?? ''))) return false;
  return lead?.status_id != null && IDS_DE_ENCERRAMENTO.has(lead.status_id);
}

export type DecisaoDoStatus = { gravar: true } | { gravar: false; motivo: string };

/**
 * Pode `novo` ser gravado agora? Puro.
 *  - "Encerrada" sempre (é o carimbo de etapa falando);
 *  - fim do turno da IA ('turno-da-ia'): NÃO grava em cartão encerrado, pela etapa só — é a guarda que ele sempre teve,
 *    e o turno pode terminar no mesmo instante do `fechar_lead`, antes de o carimbo gravar "Encerrada";
 *  - handoff e follow-up: só NÃO gravam quando as DUAS coisas são verdade — o cartão está em etapa de encerramento E o
 *    campo JÁ diz "Encerrada". Cartão encerrado cujo campo diz outra coisa (o carimbo não gravou, ou alguém mexeu)
 *    deixa gravar: bloquear só pela etapa congelaria o campo para sempre.
 */
export function decidirStatusConversa(
  novo: StatusConversa,
  encerrado: boolean,
  valorAtual: string | null,
  origem: OrigemDoStatus,
): DecisaoDoStatus {
  if (novo === STATUS_ENCERRADA || !encerrado) return { gravar: true };
  if (origem === 'turno-da-ia') return { gravar: false, motivo: 'cartão em etapa de encerramento — o turno da IA não escreve nele' };
  if (valorAtual !== null && normalizarNome(valorAtual) === normalizarNome(STATUS_ENCERRADA)) {
    return { gravar: false, motivo: 'cartão em etapa de encerramento e o campo já diz "Encerrada" — vale' };
  }
  return { gravar: true };
}
