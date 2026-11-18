// Provedor da JUÍZA do Promptfoo (asserção llm-rubric): usa a chave e o modelo de uma unidade do banco
// (padrão `default`, a da Doutor Digital; troque com PF_JUIZA_UNIDADE=<slug>). Lógica em src/eval/promptfoo-sofia.ts.
import { tsImport } from 'tsx/esm/api';

let ponte;
const carregar = () => (ponte ??= tsImport('../src/eval/promptfoo-sofia.ts', import.meta.url));

export default class Juiza {
  id() {
    return 'juiza';
  }

  async callApi(prompt) {
    const { julgar, UNIDADE_DA_JUIZA_PADRAO } = await carregar();
    return julgar(prompt, process.env.PF_JUIZA_UNIDADE || UNIDADE_DA_JUIZA_PADRAO);
  }

  async cleanup() {
    if (ponte) await (await ponte).encerrar();
  }
}
