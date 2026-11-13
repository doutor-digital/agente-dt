/**
 * 👍/👎 nas respostas da Sofia dentro do Chatwoot (pedido do João, 13/11/2026) e o resumo que a tela "Agente" mostra.
 *
 * Como sabemos que uma mensagem é da Sofia: quando ela responde (chatwoot-ia), o id da mensagem que o Chatwoot devolve é guardado
 * em `sofia_mensagem` com a resposta e a última fala do paciente. Só essas mensagens ganham os botões no balão (a régua e as
 * atendentes também saem pelo mesmo usuário do Chatwoot).
 *
 * Uma avaliação por pessoa e mensagem: clicar de novo troca a nota. As 👎 ficam "para revisar" no Agente até alguém ensinar a
 * Sofia (regra), pedir à Doutor Digital (pedido) ou dar ok. Nada aqui chega ao paciente.
 */
import { prisma } from './prisma.js';

export type Nota = 'boa' | 'ruim';
export type ComoRevisou = 'regra' | 'pedido' | 'ok';
export const COMO_REVISOU: readonly ComoRevisou[] = ['regra', 'pedido', 'ok'];
export const MAX_TEXTO_DA_AVALIACAO = 600;
const MAX_RESPOSTA = 4_000;
const MAX_FALA = 1_000;
const DIA_MS = 86_400_000;

export const ehNota = (v: unknown): v is Nota => v === 'boa' || v === 'ruim';

/** A última fala do PACIENTE antes da resposta (para a equipe ver o caso). Ignora falas vazias. */
export function ultimaFalaDoPaciente(falas: ReadonlyArray<{ role: string; content: string }>): string | null {
  for (let i = falas.length - 1; i >= 0; i--) {
    const f = falas[i]!;
    if (f.role === 'user' && f.content.trim()) return f.content.trim().slice(0, MAX_FALA);
  }
  return null;
}

/** Guarda a resposta que a Sofia acabou de mandar (idempotente: o mesmo id não duplica). */
export async function registrarRespostaDaSofia(r: { mensagem: number; conversa: number; slug: string; texto: string; fala: string | null }): Promise<void> {
  await prisma.sofiaMensagem.upsert({
    where: { messageId: r.mensagem },
    create: { messageId: r.mensagem, conversa: r.conversa, unitSlug: r.slug, texto: r.texto.slice(0, MAX_RESPOSTA), fala: r.fala?.slice(0, MAX_FALA) ?? null },
    update: {},
  });
}

export interface RespostaNoBalao {
  id: number;
  /** a nota de quem está olhando (null = ainda não avaliou) */
  minha: Nota | null;
  /** alguém (outra pessoa) marcou como ruim: o nome, para o botão mostrar */
  ruimPor: string | null;
}

/** As respostas da Sofia numa conversa, com o que cada uma já recebeu (para os botões do balão). */
export async function respostasDaSofiaNaConversa(conversa: number, quemId: number | null): Promise<RespostaNoBalao[]> {
  const msgs = await prisma.sofiaMensagem.findMany({ where: { conversa }, select: { messageId: true }, orderBy: { messageId: 'desc' }, take: 300 });
  if (!msgs.length) return [];
  const ids = msgs.map((m) => m.messageId);
  const avals = await prisma.sofiaAvaliacao.findMany({
    where: { messageId: { in: ids } },
    select: { messageId: true, nota: true, quemId: true, quemNome: true },
    orderBy: { criadoEm: 'asc' },
  });
  return ids.map((id) => {
    const daqui = avals.filter((a) => a.messageId === id);
    const minha = quemId ? daqui.find((a) => a.quemId === quemId) : undefined;
    const ruimDeOutra = daqui.filter((a) => a.nota === 'ruim' && (!quemId || a.quemId !== quemId)).pop();
    return { id, minha: minha && ehNota(minha.nota) ? minha.nota : null, ruimPor: ruimDeOutra?.quemNome ?? null };
  });
}

/** A mensagem é resposta da Sofia NESTA conversa? (o botão do balão não pode avaliar mensagem de outra conversa) */
export async function respostaDaSofia(mensagem: number, conversa: number): Promise<{ unitSlug: string } | null> {
  const m = await prisma.sofiaMensagem.findUnique({ where: { messageId: mensagem }, select: { conversa: true, unitSlug: true } });
  return m && m.conversa === conversa ? { unitSlug: m.unitSlug } : null;
}

/**
 * Grava a avaliação. Com mensagem e pessoa conhecidas, a mesma pessoa avaliando de novo TROCA a nota (e uma 👎 volta a ficar para
 * revisar). Devolve se a nota é nova ou mudou (a nota privada de 👎 só sai nesse caso, para não repetir).
 */
export async function gravarAvaliacao(a: {
  slug: string;
  conversa: number;
  mensagem: number | null;
  nota: Nota;
  texto: string | null;
  quemId: number | null;
  quemNome: string;
}): Promise<{ mudou: boolean }> {
  const texto = a.texto?.trim().slice(0, MAX_TEXTO_DA_AVALIACAO) || null;
  if (a.mensagem && a.quemId) {
    const ja = await prisma.sofiaAvaliacao.findFirst({ where: { messageId: a.mensagem, quemId: a.quemId }, orderBy: { criadoEm: 'desc' } });
    if (ja) {
      const mudou = ja.nota !== a.nota || (a.nota === 'ruim' && (ja.texto ?? '') !== (texto ?? ''));
      await prisma.sofiaAvaliacao.update({
        where: { id: ja.id },
        data: { nota: a.nota, texto, quemNome: a.quemNome, criadoEm: new Date(), ...(mudou ? { revisadaEm: null, revisadaPor: null, revisadaComo: null } : {}) },
      });
      return { mudou };
    }
  }
  await prisma.sofiaAvaliacao.create({
    data: { unitSlug: a.slug, conversa: a.conversa, messageId: a.mensagem, nota: a.nota, texto, quemId: a.quemId, quemNome: a.quemNome },
  });
  return { mudou: true };
}

export interface AvaliacaoLida {
  id: string;
  nota: string;
  texto: string | null;
  quemNome: string;
  criadoEm: Date;
  conversa: number;
  messageId: number | null;
  revisadaEm: Date | null;
  revisadaPor: string | null;
  revisadaComo: string | null;
  resposta: string | null;
  fala: string | null;
}

export interface ResumoDasAvaliacoes {
  semana: { boas: number; ruins: number };
  anterior: { boas: number; ruins: number };
  paraRevisar: AvaliacaoLida[];
  revisadas: AvaliacaoLida[];
}

/** O resumo da tela: últimos 7 dias × 7 anteriores, as 👎 em aberto (mais novas primeiro) e as últimas revisadas. */
export function resumir(lista: readonly AvaliacaoLida[], agora: Date): ResumoDasAvaliacoes {
  const t = agora.getTime();
  const idade = (a: AvaliacaoLida) => t - a.criadoEm.getTime();
  const conta = (l: AvaliacaoLida[]) => ({ boas: l.filter((a) => a.nota === 'boa').length, ruins: l.filter((a) => a.nota === 'ruim').length });
  const novasPrimeiro = (x: AvaliacaoLida, y: AvaliacaoLida) => y.criadoEm.getTime() - x.criadoEm.getTime();
  return {
    semana: conta(lista.filter((a) => idade(a) < 7 * DIA_MS)),
    anterior: conta(lista.filter((a) => idade(a) >= 7 * DIA_MS && idade(a) < 14 * DIA_MS)),
    paraRevisar: lista.filter((a) => a.nota === 'ruim' && !a.revisadaEm).sort(novasPrimeiro).slice(0, 40),
    revisadas: lista
      .filter((a) => a.nota === 'ruim' && a.revisadaEm)
      .sort((x, y) => y.revisadaEm!.getTime() - x.revisadaEm!.getTime())
      .slice(0, 8),
  };
}

/** Lê as avaliações da unidade (últimos 60 dias) com a resposta e a fala de cada uma, e resume. */
export async function resumoDaUnidade(slug: string, agora = new Date()): Promise<ResumoDasAvaliacoes> {
  const desde = new Date(agora.getTime() - 60 * DIA_MS);
  const avals = await prisma.sofiaAvaliacao.findMany({ where: { unitSlug: slug, criadoEm: { gte: desde } }, orderBy: { criadoEm: 'desc' }, take: 1_000 });
  const ids = [...new Set(avals.map((a) => a.messageId).filter((x): x is number => x != null))];
  const msgs = ids.length ? await prisma.sofiaMensagem.findMany({ where: { messageId: { in: ids } }, select: { messageId: true, texto: true, fala: true } }) : [];
  const porId = new Map(msgs.map((m) => [m.messageId, m]));
  return resumir(
    avals.map((a) => ({
      id: a.id,
      nota: a.nota,
      texto: a.texto,
      quemNome: a.quemNome,
      criadoEm: a.criadoEm,
      conversa: a.conversa,
      messageId: a.messageId,
      revisadaEm: a.revisadaEm,
      revisadaPor: a.revisadaPor,
      revisadaComo: a.revisadaComo,
      resposta: a.messageId != null ? (porId.get(a.messageId)?.texto ?? null) : null,
      fala: a.messageId != null ? (porId.get(a.messageId)?.fala ?? null) : null,
    })),
    agora,
  );
}

/** Marca uma 👎 como revisada (só da unidade dela e só se ainda está aberta). false = não achou ou já revisada. */
export async function marcarRevisada(id: string, slug: string, quem: string, como: ComoRevisou): Promise<boolean> {
  const r = await prisma.sofiaAvaliacao.updateMany({
    where: { id, unitSlug: slug, nota: 'ruim', revisadaEm: null },
    data: { revisadaEm: new Date(), revisadaPor: quem.slice(0, 80), revisadaComo: como },
  });
  return r.count > 0;
}
