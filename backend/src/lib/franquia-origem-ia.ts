/**
 * A origem "IA SOFIA" existe NESTA franquia? (27/11/2026)
 *
 * Todo lead que a Sofia cadastra no 1º contato sai com a origem "IA SOFIA" (`units.spine_ia_source_id`). O id é da franquia, não
 * nosso: se alguém apagar ou trocar a origem lá, o lead nasceria com outra origem (ou a franquia o recusaria). Antes de criar, e
 * na tela de prontidão da unidade, a lista de origens da franquia (`GET /api/general/sources`, só leitura) é conferida.
 *
 * Três respostas, de propósito:
 *  - `ok`: o id configurado está na lista e o nome é "IA SOFIA";
 *  - `faltando`: a lista foi lida e a origem NÃO está lá (ou o id aponta para outra origem) — o lead NÃO sai, e o aviso diz o quê;
 *  - `nao-deu-para-conferir`: a franquia não deixou ler a lista (token sem a permissão "Dados Gerais", fora do ar, formato novo).
 *    Isto NÃO é prova de que falta: o id configurado já é o que o agendamento usa em produção e a franquia valida o `idSource` ao
 *    criar. O lead segue com o id configurado, e o aviso fica no log e na prontidão.
 * Unidade sem `spine_ia_source_id` configurado é `faltando`: nunca se cai na origem padrão (lead nunca sai sem origem IA SOFIA).
 */
import { logger } from './logger.js';
import { SpineService, type SpineOrigem, type SpineResult, type SpineUnit } from '../services/spine.service.js';

export type ConferenciaDaOrigem =
  | { situacao: 'ok'; idSource: number; nome: string }
  | { situacao: 'faltando'; motivo: string }
  | { situacao: 'nao-deu-para-conferir'; idSource: number; motivo: string };

export interface UnidadeDaOrigem extends SpineUnit {
  id: string;
  slug: string;
  spineIaSourceId: number | null;
}

export interface DepsDaOrigem {
  listar(unit: SpineUnit): Promise<SpineResult<{ origens: SpineOrigem[] }>>;
  agora(): number;
}

const depsPadrao: DepsDaOrigem = { listar: (u) => SpineService.listarOrigens(u), agora: () => Date.now() };

/** A lista de origens quase nunca muda: 6 h para o que deu certo, 10 min para o que falhou. */
export const VALIDADE_OK_MS = 6 * 3600_000;
export const VALIDADE_FALHA_MS = 10 * 60_000;
const guardadas = new Map<string, { em: number; lista: SpineOrigem[] | null; erro?: string; curta?: boolean }>();

/** Só para teste. */
export function _limparOrigensParaTeste(): void {
  guardadas.clear();
}

/** "IA SOFIA", "IA Sofia - Doutor Digital", "Sofia IA": a franquia dá o nome; o que não pode é o id apontar para outra origem (Google, Site…). */
const ehIaSofia = (nome: string) => /sofia/i.test(nome);

export async function conferirOrigemIaSofia(unit: UnidadeDaOrigem, deps: DepsDaOrigem = depsPadrao): Promise<ConferenciaDaOrigem> {
  const id = unit.spineIaSourceId;
  if (!id || id <= 0) {
    return { situacao: 'faltando', motivo: 'a unidade não tem a origem "IA SOFIA" configurada (units.spine_ia_source_id) — o lead não sai sem ela' };
  }
  const agora = deps.agora();
  const chave = unit.id;
  let g = guardadas.get(chave);
  if (!g || agora - g.em > (g.lista && !g.curta ? VALIDADE_OK_MS : VALIDADE_FALHA_MS)) {
    const r = await deps.listar(unit).catch((err): SpineResult<{ origens: SpineOrigem[] }> => ({ ok: false, error: String(err) }));
    g = r.ok && r.data ? { em: agora, lista: r.data.origens } : { em: agora, lista: null, erro: r.error ?? 'sem resposta' };
    guardadas.set(chave, g);
    if (!g.lista) logger.warn({ unit: unit.slug, erro: g.erro }, 'franquia-origem-ia: não consegui ler a lista de origens da franquia');
  }
  if (!g.lista) {
    return { situacao: 'nao-deu-para-conferir', idSource: id, motivo: `não consegui ler a lista de origens da franquia (${g.erro}) — sigo com o id ${id} configurado` };
  }
  const achada = g.lista.find((o) => o.idSource === id);
  // Lista lida mas SEM a origem: a franquia pode corrigir a qualquer hora — reconfere em 10 min, não em 6 h.
  g.curta = !achada || !ehIaSofia(achada.name);
  if (!achada) {
    return { situacao: 'faltando', motivo: `a origem ${id} configurada como "IA SOFIA" NÃO existe na lista de origens desta franquia` };
  }
  if (!ehIaSofia(achada.name)) {
    return { situacao: 'faltando', motivo: `a origem ${id} existe na franquia, mas se chama "${achada.name}" e não "IA SOFIA" — conferir com a franquia antes de cadastrar` };
  }
  return { situacao: 'ok', idSource: id, nome: achada.name };
}
