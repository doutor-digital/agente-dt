// Provedor do Promptfoo: a Sofia de verdade (prompt da produção, modelo da unidade, guardrail e trava),
// SEM executar ferramenta. A lógica mora em src/eval/promptfoo-sofia.ts; aqui só a carga via tsx, porque
// o Promptfoo roda em Node puro e não resolve os imports `.js` → `.ts` do backend.
import { tsImport } from 'tsx/esm/api';

let ponte;
const carregar = () => (ponte ??= tsImport('../src/eval/promptfoo-sofia.ts', import.meta.url));

export default class SofiaDoBanco {
  constructor(opcoes = {}) {
    this.config = opcoes.config ?? {};
  }

  id() {
    return this.config.promptDaUnidade ? 'sofia (prompt da unidade)' : 'sofia';
  }

  // O `prompt` é só "{{caso}}" (o id): quem monta o prompt de verdade é o compositor da produção.
  async callApi(_prompt, contexto) {
    const { respostaDaSofia } = await carregar();
    const promptDaUnidade = Boolean(this.config.promptDaUnidade) || process.env.PF_PROMPT_DA_UNIDADE === '1';
    return respostaDaSofia(contexto.vars.caso, { promptDaUnidade });
  }

  async cleanup() {
    if (ponte) await (await ponte).encerrar();
  }
}
