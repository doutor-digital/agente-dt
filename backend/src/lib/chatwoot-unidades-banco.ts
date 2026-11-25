/**
 * Leitura da configuração do CRM por unidade (`unit_chatwoot`) no boot, revalidada a cada minuto. A parte pura (tipos, semente, mapas
 * derivados) está em `chatwoot-unidades.ts`. Mesmo desenho de `automacoes-estado.ts`: nunca lança; banco fora do ar mantém o que já
 * estava carregado (no primeiro boot, a semente de Parauapebas = o comportamento de sempre).
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { aplicarConfigs, aplicarDominios, configDaLinha, problemasDaConfig, mesclarComSemente, type LinhaDoBanco } from './chatwoot-unidades.js';

const avisados = new Set<string>();
let carregando: Promise<void> | null = null;
let ultimoErro: string | null = null;
const RELEITURA_MS = 60_000;

/** Relê o banco. Nunca lança: banco fora do ar mantém o que já estava carregado (a semente, no primeiro boot). */
export async function recarregarConfigChatwoot(): Promise<void> {
  if (carregando) return carregando;
  carregando = (async () => {
    try {
      const linhas = (await prisma.unitChatwoot.findMany({
        include: { unit: { select: { slug: true } }, caixas: true },
      })) as unknown as LinhaDoBanco[];
      // o aviso de uma linha ruim sai UMA vez por motivo (a releitura é de minuto em minuto: não pode virar enxurrada no log)
      const lista = mesclarComSemente(linhas.map(configDaLinha), (msg, slug) => {
        const chave = `${slug}|${msg}`;
        if (avisados.has(chave)) return;
        avisados.add(chave);
        logger.warn({ slug }, `chatwoot-unidades: ${msg}`);
      });
      aplicarConfigs(lista);
      // o ENDEREÇO da linha inerte (sem caixa): entra nas origens aceitas; não torna a config válida
      // só entra a linha que é válida OU cujo ÚNICO problema é não ter caixa ainda (linha rejeitada por outro motivo — conta ou subdomínio errados — não vira origem confiável)
      aplicarDominios(linhas.filter((l) => problemasDaConfig(configDaLinha(l)).every((m) => m === 'sem nenhuma caixa')));
      ultimoErro = null;
    } catch (err) {
      // uma vez por erro diferente (banco fora do ar ou tabela ainda não migrada não pode virar uma linha de log por minuto)
      const msg = String(err);
      if (msg !== ultimoErro) logger.warn({ err: msg }, 'chatwoot-unidades: não consegui ler o banco — segue valendo o que já estava carregado');
      ultimoErro = msg;
    } finally {
      carregando = null;
    }
  })();
  return carregando;
}

let timer: NodeJS.Timeout | null = null;

/** No boot: lê uma vez (antes dos workers) e revalida a cada minuto. */
export async function iniciarConfigChatwoot(): Promise<void> {
  await recarregarConfigChatwoot();
  if (timer) return;
  timer = setInterval(() => void recarregarConfigChatwoot(), RELEITURA_MS);
  timer.unref?.();
}

export function pararConfigChatwoot(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
