/**
 * O FILTRO da tela «Disparos» do CRM — puro (sem rede nem banco): o que o pedido pode conter e quem passa nele.
 *
 * O público nasce das conversas da CAIXA de WhatsApp oficial da unidade: etiquetas (incluir/excluir), atributos da conversa (`etapa`
 * e os outros que a régua usa) e «sem interação há X dias». Quem decide a lista é a equipe; as exclusões automáticas (SAIR, franquia,
 * interno…) vêm depois, em `publico.ts`, e NUNCA são ligáveis pelo filtro.
 */
import { z } from 'zod';
import type { ConversaRegua } from '../../chatwoot-regua.js';

const etiqueta = z.string().trim().min(1).max(60);
/** Chave de atributo de conversa do Chatwoot: minúsculas, dígitos e `_` (é como o Chatwoot as define). */
const chaveDeAtributo = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);

export const filtroSchema = z.object({
  caixa: z.number().int().positive(),
  /** a conversa precisa ter etiqueta(s) destas (ver `todasAsEtiquetas`); vazio = não filtra por etiqueta */
  etiquetasIncluir: z.array(etiqueta).max(20).default([]),
  /** com `true`, a conversa precisa ter TODAS as etiquetas de `etiquetasIncluir`; com `false`, basta UMA */
  todasAsEtiquetas: z.boolean().default(false),
  /** a conversa NÃO pode ter nenhuma destas */
  etiquetasExcluir: z.array(etiqueta).max(20).default([]),
  /** atributo da conversa → valores aceitos (um deles). Ex.: `{ etapa: ['Perdido', 'Frio'] }`. Atributos diferentes se somam (E). */
  atributos: z.record(chaveDeAtributo, z.array(z.string().trim().min(1).max(120)).min(1).max(30)).default({}),
  /** só quem está há pelo menos N dias sem mensagem (0 = não filtra) */
  semInteracaoDias: z.number().int().min(0).max(730).default(0),
});
export type Filtro = z.infer<typeof filtroSchema>;

/** Os atributos que a régua e o funil usam e que a tela oferece de início (a lista viva do Chatwoot completa o resto). */
export const ATRIBUTOS_USUAIS = ['etapa', 'etapa_tratamento', 'funil', 'situacao_consulta', 'motivo_nao_agendamento', 'origem'] as const;

const norm = (v: unknown): string =>
  (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '').trim().toLowerCase();

/** A conversa como o filtro e a triagem a enxergam: a da régua + o que o disparo precisa a mais. */
export interface ConversaDoPublico extends ConversaRegua {
  contatoId: number | null;
  /** `last_activity_at` da listagem, em ms (conta nota privada, status…): só a reserva de «última interação» */
  atividadeEm: number;
  interno: boolean;
  status: string;
}

export const MS_DIA = 86_400_000;

/** A hora da última mensagem PÚBLICA (a nota privada, inclusive a do «seco» da régua, não é interação). `null` = só dá a atividade. */
export function ultimaMensagemPublicaEm(c: ConversaDoPublico): Date | null {
  return c.ultima && !c.ultima.privada && c.ultima.criadaEm.getTime() > 0 ? c.ultima.criadaEm : null;
}

/** A última interação conhecida: a mensagem pública da listagem; senão a resolvida por fora (`resolvida`); senão a atividade da conversa. */
export function ultimaInteracao(c: ConversaDoPublico, resolvida?: Date | null): number {
  return (ultimaMensagemPublicaEm(c) ?? resolvida)?.getTime() ?? c.atividadeEm;
}

/** Precisa buscar a última mensagem pública por fora? (a listagem só trouxe uma nota privada) */
export function precisaResolverInteracao(c: ConversaDoPublico, f: Filtro): boolean {
  return f.semInteracaoDias > 0 && ultimaMensagemPublicaEm(c) === null && !!c.ultima?.privada;
}

/** A conversa passa no filtro? (`resolvida` = a última mensagem pública achada por fora, se foi preciso). */
export function passaNoFiltro(c: ConversaDoPublico, f: Filtro, agora: number, resolvida?: Date | null): boolean {
  const tem = new Set(c.etiquetas.map(norm));
  const incluir = f.etiquetasIncluir.map(norm);
  if (incluir.length && !(f.todasAsEtiquetas ? incluir.every((e) => tem.has(e)) : incluir.some((e) => tem.has(e)))) return false;
  if (f.etiquetasExcluir.map(norm).some((e) => tem.has(e))) return false;
  for (const [chave, valores] of Object.entries(f.atributos)) {
    if (!valores.map(norm).includes(norm(c.attrs[chave]))) return false;
  }
  if (f.semInteracaoDias > 0 && ultimaInteracao(c, resolvida) > agora - f.semInteracaoDias * MS_DIA) return false;
  return true;
}

/** Uma linha que a equipe lê e que fica na onda (`etiqueta` do banco): o filtro em palavras. Sem telefone, sem nome. */
export function resumoDoFiltro(f: Filtro): string {
  const partes: string[] = ['CRM'];
  if (f.etiquetasIncluir.length) partes.push(`${f.todasAsEtiquetas ? 'todas' : 'alguma'} das etiquetas ${f.etiquetasIncluir.join(', ')}`);
  if (f.etiquetasExcluir.length) partes.push(`sem as etiquetas ${f.etiquetasExcluir.join(', ')}`);
  for (const [k, v] of Object.entries(f.atributos)) partes.push(`${k} = ${v.join(' ou ')}`);
  if (f.semInteracaoDias > 0) partes.push(`sem interação há ${f.semInteracaoDias}+ dias`);
  return partes.join(' · ').slice(0, 300);
}

/** Etiquetas e atributos que SEMPRE tiram a conversa do público (a equipe não escolhe): o que o robô já respeita. */
export const ETIQUETA_SEM_FOLLOW_UP = 'sem-follow-up';
