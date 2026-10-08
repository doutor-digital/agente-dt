/**
 * A IA desta unidade responde nesta etapa? A allowlist (`units.kommo_allowed_status_ids`) é uma lista
 * de ids de status — e no Kommo os ids 142 e 143 não identificam etapa: TODO funil tem os dois
 * (ganho/perdido). 143 é PERDIDO no COMERCIAL e TRATAMENTO CANCELADO no TRATAMENTO.
 *
 * O caso (Açailândia, 08/10/2026 11:43, cartão de teste 28340326): o cartão estava em TRATAMENTO
 * CANCELADO, o paciente tocou no botão "Financeiro" do robô de acolhimento e a Sofia de RESGATE
 * respondeu com a oferta da consulta ("R$ 350 no dia, ou R$ 250 antecipado…"). O roteador por etapa
 * procurou "quem tem 143 na allowlist" e achou a `acailandia-resgate` ({143, EM ESPERA}); a mesma
 * allowlist liberou a resposta. A 143 que ela devia atender era só a do COMERCIAL.
 *
 * Regra: para 142/143, a etapa só vale se o lead está num funil DESTA unidade — os funis onde ficam
 * os outros ids da allowlist (EM ESPERA etc., que são únicos na conta). Em 08/10/2026 as 10 unidades
 * com 143 na allowlist (8 resgates + Serra + Boa Vista) têm pelo menos um outro id — a EM ESPERA
 * (waiting_deferred) em todas; conferido no Kommo da Açailândia e da Serra: COMERCIAL. Sem outro id
 * para ancorar, vale o nome: funil de TRATAMENTO não é de quem resgata.
 */

/** No Kommo, todo funil tem os dois: 142 = ganho, 143 = perdido. */
export const IDS_DE_TODO_FUNIL: ReadonlySet<number> = new Set([142, 143]);

/** O pedaço do esquema da conta que a regra precisa (ver kommo-schema.ts). */
export interface FunisDaConta {
  pipelineDoStatus: (statusId: number) => number | null;
  nomeDoFunil: (pipelineId: number) => string | null;
}

/** Vale só pros ids ambíguos: sem eles, a allowlist simples já decide e ninguém lê o esquema. */
export function precisaDoFunil(permitidos: readonly number[], statusId: number | null | undefined): boolean {
  return !!statusId && IDS_DE_TODO_FUNIL.has(statusId) && permitidos.includes(statusId);
}

/**
 * Puro. `funis` null = o esquema da conta não pôde ser lido: aí vale a regra antiga (só o id), para
 * uma falha de leitura nunca calar a Sofia em PERDIDO — o mesmo critério da "Sofia calada".
 */
export function etapaPermitida(
  permitidos: readonly number[],
  statusId: number | null | undefined,
  pipelineId: number | null | undefined,
  funis: FunisDaConta | null,
): boolean {
  if (!statusId || !permitidos.includes(statusId)) return false;
  if (!IDS_DE_TODO_FUNIL.has(statusId)) return true;
  if (!funis || !pipelineId) return true;
  const daUnidade = new Set<number>();
  for (const id of permitidos) {
    if (IDS_DE_TODO_FUNIL.has(id)) continue;
    const funil = funis.pipelineDoStatus(id);
    if (funil != null) daUnidade.add(funil);
  }
  if (daUnidade.size > 0) return daUnidade.has(pipelineId);
  return !/tratamento/i.test(funis.nomeDoFunil(pipelineId) ?? '');
}
