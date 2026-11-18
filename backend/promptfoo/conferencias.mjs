// Asserção fixa do Promptfoo: as conferências de src/eval/checks.ts (as mesmas do `npm run eval`),
// lidas do metadata que o provedor da Sofia devolve. Regra em src/eval/promptfoo-casos.ts.
import { tsImport } from 'tsx/esm/api';

let ponte;

export async function conferencias(_saida, contexto) {
  ponte ??= tsImport('../src/eval/promptfoo-casos.ts', import.meta.url);
  const { avaliarConferencias } = await ponte;
  return avaliarConferencias(contexto.providerResponse?.metadata);
}
