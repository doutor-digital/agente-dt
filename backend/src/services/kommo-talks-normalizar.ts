/**
 * A parte pura da conversa oficial do Kommo: quem falou (paciente, Sofia, equipe), a lista normalizada e o
 * histórico juntando todas as conversas do lead. Sem importar o cliente do Kommo nem o ambiente, para o
 * conector do claude.ai e os testes usarem. O serviço `kommo-talks.service.ts` reexporta tudo daqui.
 */
import type { KommoClient, KommoTalkMessage } from './kommo.service.js';

export type AutorOficial = 'paciente' | 'sofia' | 'equipe';

export interface MensagemOficial {
  id: string;
  em: Date;
  direcao: 'entrada' | 'saida';
  autor: AutorOficial;
  autorNome: string;
  texto: string;
  anexo: { tipo: string; link: string | null } | null;
  status: string | null;
}

/** Usuários do Kommo pelos quais a Sofia fala (nota de voz sai como o usuário da sessão). */
const NOMES_DA_SOFIA = ['doutor digital', 'i.a sofia', 'ia sofia', 'sofia'];

export function classificarAutor(m: Pick<KommoTalkMessage, 'type' | 'author'>): AutorOficial {
  const tipo = (m.author?.type ?? '').toLowerCase();
  if (m.type === 'incoming' || tipo === 'external') return 'paciente';
  if (tipo === 'bot') return 'sofia';
  const nome = (m.author?.name ?? '').trim().toLowerCase();
  if (NOMES_DA_SOFIA.includes(nome)) return 'sofia';
  return 'equipe';
}

export function normalizar(raw: KommoTalkMessage[]): MensagemOficial[] {
  return raw
    .map((m) => ({
      id: String(m.id),
      em: new Date((m.created_at ?? 0) * 1000),
      direcao: (m.type === 'incoming' ? 'entrada' : 'saida') as 'entrada' | 'saida',
      autor: classificarAutor(m),
      autorNome: (m.author?.name ?? '').trim(),
      texto: (m.text ?? '').trim(),
      anexo: m.attachment?.type ? { tipo: String(m.attachment.type), link: m.attachment.link ?? null } : null,
      status: m.delivery_status ?? null,
    }))
    .sort((a, b) => a.em.getTime() - b.em.getTime());
}

/** Teto do histórico inteiro de um lead: acima disso a resposta enche a conversa do claude.ai e o Kommo divide a fila com a Sofia. */
export const TETO_HISTORICO = 500;
const POR_PAGINA = 250;
const PAGINAS_POR_CONVERSA = 4;

/**
 * Mensagens do lead somando TODAS as conversas (talks), não só a viva: quem volta depois de semanas abre
 * conversa nova, e o histórico de antes ficava de fora. Mais recente primeiro, até completar `limite`.
 * Com período (`desde`/`ate`, epoch s), pula as conversas fora dele e devolve só as mensagens dentro.
 * `total` conta o que foi lido; `truncado` diz que havia mais do que `limite` (ou do que o teto lido).
 */
export async function historicoOficial(
  kommo: Pick<KommoClient, 'listTalks' | 'listTalkMessages'>,
  leadId: number,
  limite = 30,
  periodo: { desde?: number; ate?: number } = {},
): Promise<{ mensagens: MensagemOficial[]; conversas: number; total: number; truncado: boolean }> {
  const talks = [...(await kommo.listTalks(leadId))].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const comPeriodo = periodo.desde != null || periodo.ate != null;
  const vistos = new Set<string>();
  const juntas: KommoTalkMessage[] = [];
  let sobrou = false;
  for (const t of talks) {
    if (periodo.desde != null && (t.updated_at ?? Infinity) < periodo.desde) continue;
    if (periodo.ate != null && (t.created_at ?? 0) > periodo.ate) continue;
    if (!comPeriodo && juntas.length >= limite) { sobrou = true; break; }
    for (let pagina = 1; pagina <= PAGINAS_POR_CONVERSA; pagina++) {
      const lote = await kommo.listTalkMessages(t.talk_id, POR_PAGINA, pagina);
      const novos = lote.filter((m) => !vistos.has(String(m.id)));
      for (const m of novos) { vistos.add(String(m.id)); juntas.push(m); }
      // página cheia de mensagens novas: pode haver mais; senão a conversa acabou (ou a API ignora a página)
      if (lote.length < POR_PAGINA || novos.length === 0) break;
      if (pagina === PAGINAS_POR_CONVERSA) sobrou = true;
    }
  }
  const dentro = normalizar(juntas).filter((m) => {
    const seg = m.em.getTime() / 1000;
    return (periodo.desde == null || seg >= periodo.desde) && (periodo.ate == null || seg <= periodo.ate);
  });
  const mensagens = dentro.slice(-limite);
  return { mensagens, conversas: talks.length, total: dentro.length, truncado: sobrou || dentro.length > mensagens.length };
}
