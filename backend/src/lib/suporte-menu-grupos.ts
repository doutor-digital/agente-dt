/**
 * Menu de suporte — QUEM É QUEM pelos grupos de Marketing do WhatsApp.
 *
 * Cada unidade tem um grupo "Mkt | Dr Hérnia <Unidade>". Quem está no grupo da unidade é da equipe dela. O índice abaixo
 * liga o número de quem escreve ao(s) grupo(s) em que ele está:
 *   - em UM grupo só  → unidade identificada e VERIFICADA (o menu pula a pergunta de nome e unidade);
 *   - em vários grupos → consultoria ou agência (estão em todos) → o menu pergunta a unidade por texto;
 *   - em nenhum / índice ainda não carregado → o menu pergunta por texto (identificação não verificada).
 *
 * O índice vive na memória e é refeito de tempos em tempos em SEGUNDO PLANO: nunca bloqueia uma conversa. A leitura é
 * de ~50 grupos, uma chamada por grupo com intervalo (listar tudo de uma vez já gerou 429 do WhatsApp no alertas2,
 * 08/10): qualquer 429 aborta a rodada e mantém o índice antigo.
 */
import { logger } from './logger.js';
import { normalizar, type UnidadeBasica } from './suporte-menu-maquina.js';

export interface ParticipanteDoGrupo {
  /** `…@lid` ou `…@s.whatsapp.net` */
  id?: string;
  /** o telefone verdadeiro, quando o participante é um `@lid` */
  phoneNumber?: string;
}

export interface GrupoComParticipantes {
  jid: string;
  assunto: string;
  participantes: ParticipanteDoGrupo[];
}

/** "Mkt | Dr Hérnia Marabá" → "maraba"; qualquer outro nome → null */
export function chaveDoGrupo(assunto: string): string | null {
  const m = /^\s*mkt\s*\|\s*d(?:r|outor)\.?\s+hernia\s+(.+?)\s*$/.exec(normalizar(assunto));
  if (!m) return null;
  const chave = m[1]!.replace(/[^a-z0-9]+/g, '');
  return chave || null;
}

/** As chaves pelas quais uma unidade pode ser reconhecida: o nome sem "Doutor Hérnia" e o slug sem hífen, sem o prefixo. */
export function chavesDaUnidade(u: UnidadeBasica): string[] {
  const semPrefixo = (t: string) =>
    normalizar(t)
      .replace(/^(doutor|dr)[\s.-]*hernia[\s.-]*/, '')
      .replace(/[^a-z0-9]+/g, '');
  return [...new Set([semPrefixo(u.nome), semPrefixo(u.slug)].filter(Boolean))];
}

export function unidadeDoGrupo(assunto: string, unidades: readonly UnidadeBasica[]): UnidadeBasica | null {
  const chave = chaveDoGrupo(assunto);
  if (!chave) return null;
  const achadas = unidades.filter((u) => chavesDaUnidade(u).includes(chave));
  return achadas.length === 1 ? achadas[0]! : null;
}

/**
 * Chave comparável de um telefone/JID: DDD + últimos 8 dígitos (imune ao 55 e ao nono dígito, como a chave do índice da
 * franquia). `@lid` não é telefone: vira `lid:<número>`. Devolve null quando não dá para saber.
 */
export function chaveDoNumero(jid: string | null | undefined): string | null {
  const bruto = String(jid ?? '');
  const [parte = '', dominio = ''] = bruto.split('@');
  const digitos = parte.split(':')[0]!.replace(/\D/g, '');
  if (!digitos) return null;
  if (dominio === 'lid') return `lid:${digitos}`;
  const semPais = digitos.startsWith('55') && digitos.length >= 12 ? digitos.slice(2) : digitos;
  if (semPais.length < 10) return null;
  return semPais.slice(0, 2) + semPais.slice(-8);
}

export type IndiceDeGrupos = ReadonlyMap<string, readonly UnidadeBasica[]>;

/** Monta o índice número → unidades. Grupo que não é "Mkt | Dr Hérnia <unidade conhecida>" é ignorado. */
export function montarIndice(grupos: readonly GrupoComParticipantes[], unidades: readonly UnidadeBasica[]): IndiceDeGrupos {
  const indice = new Map<string, UnidadeBasica[]>();
  const poe = (chave: string | null, u: UnidadeBasica) => {
    if (!chave) return;
    const lista = indice.get(chave) ?? [];
    if (!lista.some((x) => x.slug === u.slug)) lista.push(u);
    indice.set(chave, lista);
  };
  for (const g of grupos) {
    const u = unidadeDoGrupo(g.assunto, unidades);
    if (!u) continue;
    for (const p of g.participantes) {
      poe(chaveDoNumero(p.phoneNumber), u);
      poe(chaveDoNumero(p.id), u);
    }
  }
  return indice;
}

/** As unidades cujo grupo de Marketing tem esse número (por telefone ou por `@lid`). Sem duplicar. */
export function unidadesDoNumero(indice: IndiceDeGrupos, ...jids: Array<string | null | undefined>): UnidadeBasica[] {
  const achadas = new Map<string, UnidadeBasica>();
  for (const j of jids) {
    const chave = chaveDoNumero(j);
    if (!chave) continue;
    for (const u of indice.get(chave) ?? []) achadas.set(u.slug, u);
  }
  return [...achadas.values()];
}

// ─── leitura no Evolution (só LEITURA) ──────────────────────────────────────────────────────────────────

export interface ConfigDeGrupos {
  url: string;
  instancia: string;
  apikey: string;
}

export interface DepsDeLeitura {
  fetch?: typeof fetch;
  esperar?: (ms: number) => Promise<void>;
  /** espaço entre uma chamada de grupo e a próxima */
  intervaloMs?: number;
}

const INTERVALO_PADRAO_MS = 1_500;
const dormir = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

interface RespostaGrupo {
  id?: string;
  subject?: string;
}

/**
 * Lê os grupos "Mkt | Dr Hérnia …" e os participantes de cada um. Devolve null se a rodada não pôde ser concluída
 * (429, erro de rede, resposta estranha): quem chama mantém o índice antigo. Nunca lança.
 */
export async function lerGruposDeMarketing(cfg: ConfigDeGrupos, deps: DepsDeLeitura = {}): Promise<GrupoComParticipantes[] | null> {
  const buscar = deps.fetch ?? globalThis.fetch;
  const esperar = deps.esperar ?? dormir;
  const intervalo = deps.intervaloMs ?? INTERVALO_PADRAO_MS;
  const base = cfg.url.replace(/\/+$/, '');
  const inst = encodeURIComponent(cfg.instancia);
  const pedir = async (caminho: string): Promise<unknown> => {
    const r = await buscar(`${base}${caminho}`, { headers: { apikey: cfg.apikey }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    const lista = await pedir(`/group/fetchAllGroups/${inst}?getParticipants=false`);
    const grupos = (Array.isArray(lista) ? (lista as RespostaGrupo[]) : []).filter((g) => g.id && g.subject && chaveDoGrupo(g.subject));
    const saida: GrupoComParticipantes[] = [];
    for (const g of grupos) {
      await esperar(intervalo);
      const corpo = (await pedir(`/group/participants/${inst}?groupJid=${encodeURIComponent(g.id!)}`)) as { participants?: ParticipanteDoGrupo[] };
      saida.push({ jid: g.id!, assunto: g.subject!, participantes: Array.isArray(corpo?.participants) ? corpo.participants : [] });
    }
    return saida;
  } catch (err) {
    // a mensagem do erro não carrega a chave (só "HTTP 429" ou o motivo da rede)
    logger.warn({ err: String(err instanceof Error ? err.message : err) }, 'suporte-menu: não consegui ler os grupos de Marketing — mantenho o índice antigo');
    return null;
  }
}

// ─── o índice vivo (memória) ────────────────────────────────────────────────────────────────────────────

export const VALIDADE_DO_INDICE_MS = 6 * 60 * 60_000;
/** Depois de uma rodada que falhou, espera isto antes de tentar de novo. */
export const ESPERA_APOS_FALHA_MS = 30 * 60_000;

interface Vivo {
  indice: IndiceDeGrupos;
  carregadoEm: number;
  proximaTentativa: number;
  carregando: boolean;
}

const vivo: Vivo = { indice: new Map(), carregadoEm: 0, proximaTentativa: 0, carregando: false };

export function indiceAtual(): IndiceDeGrupos {
  return vivo.indice;
}

export function _zerarIndiceParaTeste(): void {
  vivo.indice = new Map();
  vivo.carregadoEm = 0;
  vivo.proximaTentativa = 0;
  vivo.carregando = false;
}

/**
 * Refaz o índice em segundo plano quando está velho ou vazio (NÃO espera: a conversa em curso usa o que já existe).
 * `unidades` e `ler` entram por parâmetro para o teste não tocar banco nem rede.
 */
export function atualizarIndiceSeVelho(
  unidades: () => Promise<readonly UnidadeBasica[]>,
  ler: () => Promise<GrupoComParticipantes[] | null>,
  agora: number = Date.now(),
): Promise<void> | null {
  if (vivo.carregando) return null;
  if (vivo.carregadoEm && agora - vivo.carregadoEm < VALIDADE_DO_INDICE_MS) return null;
  if (agora < vivo.proximaTentativa) return null;
  vivo.carregando = true;
  return (async () => {
    try {
      const [us, grupos] = await Promise.all([unidades(), ler()]);
      if (!grupos) {
        vivo.proximaTentativa = agora + ESPERA_APOS_FALHA_MS;
        return;
      }
      vivo.indice = montarIndice(grupos, us);
      vivo.carregadoEm = agora;
      logger.info({ grupos: grupos.length, numeros: vivo.indice.size }, 'suporte-menu: índice de grupos de Marketing atualizado');
    } catch (err) {
      vivo.proximaTentativa = agora + ESPERA_APOS_FALHA_MS;
      logger.warn({ err: String(err) }, 'suporte-menu: falha ao atualizar o índice de grupos');
    } finally {
      vivo.carregando = false;
    }
  })();
}
