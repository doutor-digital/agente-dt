// Testes do Promptfoo = os casos de src/eval/banco.ts (não existe segundo banco). Filtro igual ao
// `npm run eval`: PF_CASO=<id> e/ou PF_UNIDADE=<slug>.
import { tsImport } from 'tsx/esm/api';

export default async function testes() {
  const { testesDoBanco } = await tsImport('../src/eval/promptfoo-casos.ts', import.meta.url);
  return testesDoBanco({ caso: process.env.PF_CASO || undefined, unidade: process.env.PF_UNIDADE || undefined });
}
