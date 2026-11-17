/**
 * As origens (esquema + host) de Chatwoot de que as telas por iframe aceitam a sessão (postMessage): a principal (CHATWOOT_URL) e o subdomínio de cada
 * clínica CADASTRADA (`unit_chatwoot.subdominio`). Nada além disso: origem que não está aqui é recusada pela página.
 */
import { origensDasClinicas } from './chatwoot-unidades.js';
import { contaChatwootDoAmbiente } from '../mcp-remoto/chatwoot.js';

export function origensDoChatwoot(e: NodeJS.ProcessEnv = process.env): string[] {
  const principal = contaChatwootDoAmbiente(e)?.url;
  let origem: string | null = null;
  try {
    origem = principal ? new URL(principal).origin : null;
  } catch {
    origem = null;
  }
  return [...new Set([...(origem ? [origem] : []), ...origensDasClinicas()])];
}
