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

/**
 * As últimas `limite` mensagens do lead somando TODAS as conversas (talks), não só a viva: quem volta depois
 * de semanas abre conversa nova, e o histórico de antes ficava de fora. Mais recente primeiro, até completar.
 */
export async function historicoOficial(kommo: Pick<KommoClient, 'listTalks' | 'listTalkMessages'>, leadId: number, limite = 30): Promise<{ mensagens: MensagemOficial[]; conversas: number }> {
  const talks = [...(await kommo.listTalks(leadId))].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const juntas: KommoTalkMessage[] = [];
  for (const t of talks) {
    juntas.push(...(await kommo.listTalkMessages(t.talk_id, 250)));
    if (juntas.length >= limite) break;
  }
  const todas = normalizar(juntas);
  return { mensagens: todas.slice(-limite), conversas: talks.length };
}

