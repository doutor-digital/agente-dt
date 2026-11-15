/**
 * O que o banco sabe das conversas e a listagem do Chatwoot não, para os alertas da Sofia (`prometeu-sem-marcar`, `agendamento-perdido`):
 * as falas dela e o que ela fez nas últimas 24 h. Uma consulta de cada por ciclo, para todas as conversas da unidade.
 */
import { prisma } from './prisma.js';
import type { FatosDaConversa } from './chatwoot-regua.js';

export interface BancoDeFatos {
  falas(slug: string, conversas: number[], desde: Date): Promise<Array<{ conversa: number; texto: string; criadoEm: Date }>>;
  eventos(slug: string, conversas: number[], desde: Date): Promise<Array<{ conversa: number; tipo: string; detalhe: string | null; criadoEm: Date }>>;
}

const bancoPadrao: BancoDeFatos = {
  falas: (slug, conversas, desde) => prisma.sofiaMensagem.findMany({ where: { unitSlug: slug, conversa: { in: conversas }, criadoEm: { gte: desde } }, select: { conversa: true, texto: true, criadoEm: true }, orderBy: { criadoEm: 'desc' } }),
  eventos: (slug, conversas, desde) => prisma.sofiaEvento.findMany({ where: { unitSlug: slug, conversa: { in: conversas }, criadoEm: { gte: desde } }, select: { conversa: true, tipo: true, detalhe: true, criadoEm: true }, orderBy: { criadoEm: 'desc' } }),
};

export async function fatosDoBanco(slug: string, conversas: number[], agora: Date, banco: BancoDeFatos = bancoPadrao): Promise<Map<number, FatosDaConversa>> {
  const saida = new Map<number, FatosDaConversa>();
  if (!conversas.length) return saida;
  const desde = new Date(agora.getTime() - 24 * 3600_000);
  const [falas, eventos] = await Promise.all([banco.falas(slug, conversas, desde), banco.eventos(slug, conversas, desde)]);
  const de = (id: number): FatosDaConversa => {
    let f = saida.get(id);
    if (!f) saida.set(id, (f = { falasDaSofia: [], eventos: [] }));
    return f;
  };
  // só desta unidade e desta janela, mais recente primeiro (o detector pega a primeira afirmação)
  for (const x of [...falas].sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())) de(x.conversa).falasDaSofia.push({ texto: x.texto, em: x.criadoEm });
  for (const x of eventos) de(x.conversa).eventos.push({ tipo: x.tipo, detalhe: x.detalhe, em: x.criadoEm });
  return saida;
}
