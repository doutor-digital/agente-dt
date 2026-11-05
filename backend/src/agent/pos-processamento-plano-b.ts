/**
 * Chamadas auxiliares de pós-processamento quando o plano B respondeu o turno.
 *
 * Quando o modelo principal cai e o plano B (outro provedor) responde, as etapas que vêm
 * depois — reescrever bastidor vazado, refazer o fechamento sem pergunta — não podem
 * voltar ao principal: ele está fora e cada volta custa o tempo limite inteiro (~35 s),
 * somado à espera que o paciente já teve. Mesma regra que as refeitas de reserva e de
 * "pediu o nome" já seguem (`!respondeuPlanoB`).
 *
 * Duas escolhas, e por quê:
 *  - Reescrita de bastidor: SAI PELO PLANO B. É segurança (vazamento não pode ir ao paciente
 *    nem ficar sem resposta), e a chamada é simples (sem histórico, sem ferramentas).
 *  - Fechamento sem pergunta (CTA): PULA e mantém o texto já validado. É melhoria de conversão,
 *    não de segurança; o plano B refazendo com ferramentas arrisca mais do que ganha.
 */

export interface PlanoBEmUso {
  provider: string;
  modelName: string;
}

export interface AlvoDoReescritor<M> {
  model: M;
  modelName: string;
  provider: string;
}

/**
 * Modelo (e nome/provedor para o rastro) que reescreve o bastidor vazado.
 * Plano B respondeu: usa o plano B. Caminho normal: o mesmo de sempre (principal ou chave reserva).
 */
export function alvoDoReescritor<U extends object, M>(args: {
  unit: U;
  modelName: string;
  provedorAtivo: string;
  planoBEmUso: PlanoBEmUso | null;
  criarModelo: (unit: U, opcoes: { model: string; temperature: number; maxTokens: number }) => M;
  maxTokens: number;
}): AlvoDoReescritor<M> {
  const { unit, modelName, provedorAtivo, planoBEmUso, criarModelo, maxTokens } = args;
  if (planoBEmUso) {
    return {
      model: criarModelo({ ...unit, llmProvider: planoBEmUso.provider }, { model: planoBEmUso.modelName, temperature: 0, maxTokens }),
      modelName: planoBEmUso.modelName,
      provider: planoBEmUso.provider,
    };
  }
  return {
    model: criarModelo(unit, { model: modelName, temperature: 0, maxTokens }),
    modelName,
    provider: provedorAtivo,
  };
}

/** Refazer no modelo principal só vale quando ele respondeu o turno; com o plano B no lugar, ele está fora. */
export function podeRefazerNoPrincipal(respondeuPlanoB: boolean): boolean {
  return !respondeuPlanoB;
}
