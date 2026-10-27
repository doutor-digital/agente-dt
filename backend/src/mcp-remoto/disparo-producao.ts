/** A fonte de verdade das ferramentas de disparo: o banco e o código do disparo. Os testes usam uma falsa (`FonteDeDisparo`). */
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { listarCampanhas, salvarCampanha } from '../lib/disparo/campanha.js';
import { abrirOnda, concluirMontagem } from '../lib/disparo/onda.js';
import { dadosDaTela } from '../lib/disparo/tela.js';
import type { FonteDeDisparo } from './disparo.js';

function origemPublica(): string | null {
  try {
    return env.MCP_URL_PUBLICA ? new URL(env.MCP_URL_PUBLICA).origin : null;
  } catch {
    return null;
  }
}

export const fonteDeDisparo: FonteDeDisparo = {
  urlDoPainel: origemPublica,
  unidades: async () => (await prisma.unit.findMany({ where: { isActive: true }, select: { slug: true }, orderBy: { slug: 'asc' } })).map((u) => u.slug),
  campanhas: listarCampanhas,
  ondasRecentes: async () =>
    (
      await prisma.disparoOnda.findMany({
        orderBy: { criadoEm: 'desc' },
        take: 20,
        select: { id: true, estado: true, total: true, etiqueta: true, criadoEm: true, pausaMotivo: true, campanha: { select: { slug: true } }, unit: { select: { slug: true } } },
      })
    ).map((o) => ({ id: o.id, campanha: o.campanha.slug, unidade: o.unit.slug, etiqueta: o.etiqueta, estado: o.estado, total: o.total, criadoEm: o.criadoEm, motivo: o.pausaMotivo })),
  montandoAgora: () => prisma.disparoOnda.count({ where: { estado: 'montando' } }),
  salvarCampanha: (slug, entrada, opcoes) => salvarCampanha(slug, entrada, opcoes),
  montarOnda: async (a) => {
    const r = await abrirOnda({ campanha: a.campanha, unidade: a.unidade, etiqueta: a.etiqueta, por: a.por });
    if (!r.ok) return r;
    // Montar leva minutos (Kommo + franquia por pessoa): a ferramenta responde já e o Claude consulta depois.
    void concluirMontagem(r.dados.id).catch((err) => logger.error({ err: String(err), onda: r.dados.id }, 'disparo: montagem (conector) estourou'));
    return { ok: true, dados: { id: r.dados.id } };
  },
  tela: (ondaId) => dadosDaTela(ondaId, undefined),
};
