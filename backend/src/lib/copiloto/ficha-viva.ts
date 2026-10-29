/**
 * A ficha de uma etapa lida da ESTRUTURA VIVA da conta do Kommo (o que o cartão realmente mostra e exige hoje), em vez do
 * dicionário de campos por etapa que era do cartão antigo. Função pura: recebe o que o Kommo devolveu.
 */
import type { CampoDoCartaoDaConta, KommoPipeline } from '../../services/kommo.service.js';
import { ehCampoTecnico, infoDoCampo } from './mapa-de-campos.js';

export interface FichaViva {
  etapa: string;
  /** Campos que aparecem no cartão nesta etapa, na ordem do Kommo. */
  visiveis: string[];
  /** Os que o Kommo exige para entrar na etapa. */
  obrigatorios: string[];
  /** Dos visíveis, os que chegam sozinhos (franquia, automação): só se confere. */
  chegamSozinhos: string[];
}

const MAX_CAMPOS = 16;
const semAcento = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function fichaViva(etapaNome: string | null | undefined, funis: KommoPipeline[], defs: CampoDoCartaoDaConta[]): FichaViva | null {
  if (!etapaNome) return null;
  const alvo = semAcento(etapaNome);
  let achado: { pipeline: KommoPipeline; nome: string; id: number } | null = null;
  for (const f of [...funis].sort((a, b) => Number(!!b.is_main) - Number(!!a.is_main))) {
    const s = f.statuses.find((x) => semAcento(x.name) === alvo);
    if (s) { achado = { pipeline: f, nome: s.name, id: s.id }; break; }
  }
  if (!achado) return null;
  const aqui = (l: Array<{ pipeline_id: number; status_id: number }> | undefined) => (l ?? []).some((e) => e.pipeline_id === achado!.pipeline.id && e.status_id === achado!.id);

  const visiveis: string[] = [], obrigatorios: string[] = [], chegamSozinhos: string[] = [];
  for (const d of [...defs].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) {
    if (d.is_api_only || d.type === 'tracking_data' || ehCampoTecnico(d.name) || /^\s*(##|\*)/.test(d.name)) continue;
    if (aqui(d.hidden_statuses)) continue;
    if (visiveis.length >= MAX_CAMPOS) break;
    visiveis.push(d.name);
    if (aqui(d.required_statuses)) obrigatorios.push(d.name);
    const info = infoDoCampo(d.name);
    if (info && (info.chegaSozinho || info.atores.includes('automatico'))) chegamSozinhos.push(d.name);
  }
  return { etapa: achado.nome, visiveis, obrigatorios, chegamSozinhos };
}

export function textoDaFichaViva(f: FichaViva): string {
  const so = new Set(f.chegamSozinhos);
  return [
    `Etapa ${f.etapa} (lida do Kommo agora). Campos que aparecem no cartão: ${f.visiveis.length ? f.visiveis.map((n) => n + (so.has(n) ? ' [chega sozinho]' : '')).join('; ') : 'nenhum'}.`,
    f.obrigatorios.length ? `O Kommo exige para entrar nesta etapa: ${f.obrigatorios.join('; ')}.` : 'O Kommo não exige campo para entrar nesta etapa.',
    'Use SÓ esta lista para falar dos campos da etapa. O que está marcado [chega sozinho] a pessoa só confere.',
  ].join('\n');
}
