/**
 * Aba «Registro» da tela Agente (pedido do João, 14/11/2026: "a Sofia podia rodar como um robô pra gente ver os logs dela"): por
 * conversa, mais nova primeiro, o que a Sofia FEZ e por quê nos últimos 7 dias.
 *
 * Fontes (nada novo no banco, só leitura):
 *  - respostas: `sofia_mensagem` (cada resposta pública dela, com a última fala do paciente);
 *  - o que ela fez: `sofia_evento` marcou / equipe / pix;
 *  - quando NÃO respondeu e por quê: `sofia_evento` tipo «decisao» (nome = desfecho da rodada, detalhe = motivo), gravado na hora
 *    por chatwoot-ia.ts — não muda o comportamento dela;
 *  - avaliações da equipe: `sofia_avaliacao` (👍/👎).
 */
import { prisma } from './prisma.js';

export const DIAS_DO_REGISTRO = 7;
export const MAX_ITENS_DO_REGISTRO = 400;
export const TIPOS_DO_REGISTRO = ['resposta', 'marcou', 'equipe', 'pix', 'avaliacao', 'nao-respondeu'] as const;
export type TipoDoRegistro = (typeof TIPOS_DO_REGISTRO)[number];

/** desfecho da rodada (chatwoot-ia.ts `Desfecho`) → o que a equipe lê */
export const DESFECHOS: Readonly<Record<string, string>> = {
  calada: 'Ficou calada',
  'equipe-respondeu': 'Não respondeu: a equipe já tinha respondido',
  mudou: 'Resposta descartada: a conversa mudou enquanto ela pensava',
  teto: 'Não respondeu: chegou ao limite de respostas do dia',
  'sem-unidade': 'Não respondeu: unidade não encontrada',
  falhou: 'Não respondeu: falha do modelo ou do Chatwoot',
  'sem-telefone': 'Não respondeu: conversa sem telefone',
  'horario-divergente': 'Passou para a equipe: o horário combinado não bate com a agenda',
  'cartao-no-kommo': 'Não respondeu: o paciente tem cartão ativo no Kommo',
  'kommo-indisponivel': 'Não respondeu: não deu para conferir o Kommo',
  'sem-texto': 'Não respondeu: o modelo não escreveu a resposta',
  nota: 'Só no papel: deixou a resposta como nota (não foi ao paciente)',
  'unidade-pausada': 'Não respondeu: a Sofia está desligada nesta unidade',
};
/** motivo de ficar calada (chatwoot-sofia.ts `motivoDeNaoResponder`) → o que a equipe lê */
export const MOTIVOS: Readonly<Record<string, string>> = {
  'ia-pausada': 'IA pausada nesta conversa (alguém da equipe assumiu ou respondeu pelo celular)',
  interno: 'contato interno da equipe',
  grupo: 'grupo de WhatsApp',
  'esperando-humano': 'conversa já passada para a equipe',
  'em-tratamento': 'paciente em tratamento',
};

export interface ItemDoRegistro {
  /** ISO */
  quando: string;
  conversa: number;
  tipo: TipoDoRegistro;
  titulo: string;
  detalhe: string | null;
}
export interface ConversaDoRegistro {
  conversa: number;
  ultima: string;
  itens: ItemDoRegistro[];
}

const corta = (t: string | null | undefined, n: number): string | null => {
  const s = (t ?? '').replace(/\s+/g, ' ').trim();
  return s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null;
};
const consultaEm = (s: string | null): string => {
  const m = String(s ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? ` para ${m[3]}/${m[2]} às ${m[4]}h${m[5] !== '00' ? m[5] : ''}` : '';
};

export function lerTipoDoRegistro(v: unknown): TipoDoRegistro | null {
  return typeof v === 'string' && (TIPOS_DO_REGISTRO as readonly string[]).includes(v) ? (v as TipoDoRegistro) : null;
}

/** Função pura: junta as fontes, filtra, agrupa por conversa (mais nova primeiro) e corta no teto. */
export function montarRegistro(e: {
  respostas: ReadonlyArray<{ conversa: number; texto: string; fala: string | null; criadoEm: Date }>;
  eventos: ReadonlyArray<{ conversa: number; tipo: string; nome: string | null; detalhe: string | null; criadoEm: Date }>;
  avaliacoes: ReadonlyArray<{ conversa: number; nota: string; texto: string | null; quemNome: string; criadoEm: Date }>;
  filtro?: { conversa?: number | null; tipo?: TipoDoRegistro | null };
  limite?: number;
}): { conversas: ConversaDoRegistro[]; total: number; cortado: boolean } {
  const itens: ItemDoRegistro[] = [];
  for (const r of e.respostas) {
    itens.push({ quando: r.criadoEm.toISOString(), conversa: r.conversa, tipo: 'resposta', titulo: `Respondeu: ${corta(r.texto, 220) ?? ''}`, detalhe: r.fala ? `Paciente: ${corta(r.fala, 160)}` : null });
  }
  for (const v of e.eventos) {
    if (v.tipo === 'marcou') itens.push({ quando: v.criadoEm.toISOString(), conversa: v.conversa, tipo: 'marcou', titulo: `Marcou consulta${consultaEm(v.detalhe)}`, detalhe: v.nome ? `Paciente: ${corta(v.nome, 80)}` : null });
    else if (v.tipo === 'equipe') itens.push({ quando: v.criadoEm.toISOString(), conversa: v.conversa, tipo: 'equipe', titulo: 'Passou a conversa para a equipe', detalhe: null });
    else if (v.tipo === 'pix') itens.push({ quando: v.criadoEm.toISOString(), conversa: v.conversa, tipo: 'pix', titulo: 'Mandou o Pix do sinal', detalhe: null });
    else if (v.tipo === 'decisao') {
      const desfecho = v.nome ?? '';
      const motivo = v.detalhe ? MOTIVOS[v.detalhe] ?? v.detalhe : null;
      itens.push({
        quando: v.criadoEm.toISOString(),
        conversa: v.conversa,
        tipo: 'nao-respondeu',
        titulo: DESFECHOS[desfecho] ?? `Não respondeu (${desfecho || 'motivo não registrado'})`,
        detalhe: motivo ? `Motivo: ${motivo}` : null,
      });
    }
  }
  for (const a of e.avaliacoes) {
    itens.push({
      quando: a.criadoEm.toISOString(),
      conversa: a.conversa,
      tipo: 'avaliacao',
      titulo: `${a.quemNome || 'Alguém'} avaliou uma resposta como ${a.nota === 'boa' ? 'boa' : 'ruim'}`,
      detalhe: a.texto ? `«${corta(a.texto, 200)}»` : null,
    });
  }
  const f = e.filtro ?? {};
  const filtrados = itens
    .filter((i) => (!f.conversa || i.conversa === f.conversa) && (!f.tipo || i.tipo === f.tipo))
    .sort((x, y) => (x.quando < y.quando ? 1 : x.quando > y.quando ? -1 : 0));
  const limite = e.limite ?? MAX_ITENS_DO_REGISTRO;
  const usados = filtrados.slice(0, limite);
  const porConversa = new Map<number, ConversaDoRegistro>();
  for (const i of usados) {
    const g = porConversa.get(i.conversa) ?? { conversa: i.conversa, ultima: i.quando, itens: [] };
    g.itens.push(i);
    porConversa.set(i.conversa, g);
  }
  // Map guarda a ordem de inserção: a conversa entra na ordem do seu item mais novo
  return { conversas: [...porConversa.values()], total: filtrados.length, cortado: filtrados.length > usados.length };
}

/** Lê os últimos 7 dias da unidade e monta. */
export async function registroDaUnidade(slug: string, filtro: { conversa?: number | null; tipo?: TipoDoRegistro | null } = {}, agora = new Date()) {
  const desde = new Date(agora.getTime() - DIAS_DO_REGISTRO * 86_400_000);
  const porConversa = filtro.conversa ? { conversa: filtro.conversa } : {};
  const [respostas, eventos, avaliacoes] = await Promise.all([
    prisma.sofiaMensagem.findMany({ where: { unitSlug: slug, criadoEm: { gte: desde }, ...porConversa }, select: { conversa: true, texto: true, fala: true, criadoEm: true }, orderBy: { criadoEm: 'desc' }, take: MAX_ITENS_DO_REGISTRO }),
    prisma.sofiaEvento.findMany({ where: { unitSlug: slug, criadoEm: { gte: desde }, ...porConversa }, select: { conversa: true, tipo: true, nome: true, detalhe: true, criadoEm: true }, orderBy: { criadoEm: 'desc' }, take: MAX_ITENS_DO_REGISTRO }),
    prisma.sofiaAvaliacao.findMany({ where: { unitSlug: slug, criadoEm: { gte: desde }, ...porConversa }, select: { conversa: true, nota: true, texto: true, quemNome: true, criadoEm: true }, orderBy: { criadoEm: 'desc' }, take: MAX_ITENS_DO_REGISTRO }),
  ]);
  return { dias: DIAS_DO_REGISTRO, ...montarRegistro({ respostas, eventos, avaliacoes, filtro }) };
}
