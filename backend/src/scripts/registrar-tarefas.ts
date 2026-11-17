/**
 * Registra a aba «Tarefas» (Dashboard App) em TODAS as contas do CRM que já existem (as contas novas já nascem com ela pelo kit: `abasDaConta`).
 * Roda DENTRO do contêiner do agente (é lá que estão o banco e os tokens); o João chama por `ops/kit-unidade/registrar-tarefas-joao.sh`.
 *
 *   node dist/scripts/registrar-tarefas.js --so-conferir   # só diz, conta por conta, se a aba existe (não escreve nada)
 *   node dist/scripts/registrar-tarefas.js                 # cria a que falta (uma por conta; as que já existem ficam como estão)
 *
 * Idempotente: roda duas vezes sem criar duas abas. Nenhum token é impresso.
 */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { abasDaConta, listaDaResposta } from '../lib/kit-unidade/fase2.js';
import { chamar, contasDoChatwoot, contextoDoAmbiente, donaDaConta } from '../mcp-remoto/chatwoot.js';

export const TITULO_DA_ABA = 'Tarefas';

/** A porta de UMA conta: ler as abas e criar uma (o teste troca por mentira). */
export interface ContaParaRegistrar {
  conta: number;
  /** a conta tem credencial só dela (token próprio) ou cai no token global? */
  propria: boolean;
  listar(): Promise<unknown>;
  criar(corpo: Record<string, unknown>): Promise<unknown>;
}

export interface Linha {
  conta: number;
  situacao: 'ja-existia' | 'faltava' | 'criada' | 'falhou' | 'sem-token';
  texto: string;
}

export async function registrarTarefas(contas: readonly ContaParaRegistrar[], urlDoAgente: string, soConferir: boolean): Promise<Linha[]> {
  const saida: Linha[] = [];
  for (const c of contas) {
    try {
      const existentes = listaDaResposta(await c.listar());
      if (existentes.some((a) => String(a.title) === TITULO_DA_ABA)) {
        saida.push({ conta: c.conta, situacao: 'ja-existia', texto: `conta ${c.conta}: a aba «${TITULO_DA_ABA}» já existe` });
        continue;
      }
      const aba = abasDaConta(urlDoAgente, c.conta).find((a) => a.title === TITULO_DA_ABA)!;
      if (soConferir) {
        saida.push({ conta: c.conta, situacao: 'faltava', texto: `conta ${c.conta}: FALTA a aba «${TITULO_DA_ABA}» (criaria apontando para ${aba.content[0]!.url})${c.propria ? '' : ' — usando o token global da instalação (a conta não tem token próprio)'}` });
        continue;
      }
      await c.criar(aba);
      saida.push({ conta: c.conta, situacao: 'criada', texto: `conta ${c.conta}: aba «${TITULO_DA_ABA}» CRIADA, apontando para ${aba.content[0]!.url}` });
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      saida.push({ conta: c.conta, situacao: 'falhou', texto: `conta ${c.conta}: FALHOU${status ? ` (CRM respondeu ${status})` : ''} — ${String(e instanceof Error ? e.message : e).slice(0, 120)}` });
    }
  }
  return saida;
}

/** O endereço do agente (de onde o Chatwoot da clínica chama): a origem de MCP_URL_PUBLICA, ou o padrão. */
export function urlDoAgente(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return env.MCP_URL_PUBLICA ? new URL(env.MCP_URL_PUBLICA).origin : 'https://agente-vps.doutordigitalconsultoria.com';
  } catch {
    return 'https://agente-vps.doutordigitalconsultoria.com';
  }
}

async function principal(): Promise<number> {
  const args = process.argv.slice(2);
  for (const a of args) if (a !== '--so-conferir') return console.error(`argumento desconhecido: ${a} (use só --so-conferir)`), 2;
  const soConferir = args.includes('--so-conferir');
  const { iniciarConfigChatwoot, pararConfigChatwoot } = await import('../lib/chatwoot-unidades-banco.js');
  await iniciarConfigChatwoot();
  try {
    const base = contextoDoAmbiente();
    if (!base) return console.error('o Chatwoot não está configurado neste servidor (CHATWOOT_API_TOKEN / CHATWOOT_CONTA_ID)'), 1;
    const contas: ContaParaRegistrar[] = [];
    const semToken: Linha[] = [];
    for (const id of contasDoChatwoot()) {
      const dona = donaDaConta(base, id);
      if (!dona) {
        semToken.push({ conta: id, situacao: 'sem-token', texto: `conta ${id}: nenhuma unidade com token para ela — não mexi` });
        continue;
      }
      contas.push({ conta: id, propria: dona.propria, listar: () => chamar(dona.ctx, 'GET', 'dashboard_apps'), criar: (corpo) => chamar(dona.ctx, 'POST', 'dashboard_apps', { corpo }) });
    }
    console.log(soConferir ? 'SÓ CONFERIR: nada será escrito.' : 'Registrando a aba «Tarefas» onde falta.');
    const linhas = [...(await registrarTarefas(contas, urlDoAgente(), soConferir)), ...semToken].sort((a, b) => a.conta - b.conta);
    for (const l of linhas) console.log(`  ${l.texto}`);
    const faltam = linhas.filter((l) => l.situacao === 'faltava').length;
    const falhas = linhas.filter((l) => l.situacao === 'falhou' || l.situacao === 'sem-token').length;
    console.log(`${linhas.length} conta(s): ${linhas.filter((l) => l.situacao === 'ja-existia').length} já tinham, ${linhas.filter((l) => l.situacao === 'criada').length} criada(s)${soConferir ? `, ${faltam} faltando` : ''}${falhas ? `, ${falhas} com problema (veja acima)` : ''}.`);
    return falhas ? 1 : 0;
  } finally {
    pararConfigChatwoot();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`erro: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
      process.exit(1);
    },
  );
}
