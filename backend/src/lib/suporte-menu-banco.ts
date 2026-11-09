/**
 * Menu de suporte — o armazém de verdade (Prisma) e a ligação com o resto do sistema (Telegram, índice de grupos).
 * Tudo que é regra mora em `suporte-menu.ts` e `suporte-menu-maquina.ts`; aqui só há I/O.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { enviarTelegramChamados } from './telegram.js';
import { dispararAnalise } from './suporte-analise-banco.js';
import {
  atualizarIndiceSeVelho,
  indiceAtual,
  lerGruposDeMarketing,
  unidadesDoNumero,
} from './suporte-menu-grupos.js';
import { criarEnviadorEvolution, emFila, lerConfig, processarMensagem, type Armazem, type ConfigSuporte, type Desfecho, type Efeitos, type Recebida } from './suporte-menu.js';
import type { Estado, Passo, UnidadeBasica, Verificacao } from './suporte-menu-maquina.js';

const VALIDADE_UNIDADES_MS = 10 * 60_000;
let cacheDeUnidades: { ate: number; lista: UnidadeBasica[] } | null = null;

async function unidadesAtivas(): Promise<UnidadeBasica[]> {
  const agora = Date.now();
  if (cacheDeUnidades && cacheDeUnidades.ate > agora) return cacheDeUnidades.lista;
  const linhas = await prisma.unit.findMany({ where: { isActive: true }, select: { slug: true, name: true } });
  const lista = linhas.map((u) => ({ slug: u.slug, nome: u.name }));
  cacheDeUnidades = { ate: agora + VALIDADE_UNIDADES_MS, lista };
  return lista;
}

const DIA_MS = 24 * 60 * 60_000;

export const armazemPrisma: Armazem = {
  async marcarVista(id) {
    // ON CONFLICT DO NOTHING: atômico e sem erro no log quando o Evolution entrega o mesmo webhook duas vezes
    const r = await prisma.suporteMensagemVista.createMany({ data: [{ id }], skipDuplicates: true });
    return r.count === 1;
  },

  async lerConversa(jid) {
    const c = await prisma.suporteConversa.findUnique({ where: { jid } });
    if (!c) return null;
    const estado: Estado = {
      passo: c.passo as Passo,
      tentativas: c.tentativas,
      nome: c.nome,
      unidade: c.unidadeSlug && c.unidadeNome ? { slug: c.unidadeSlug, nome: c.unidadeNome } : null,
      verificacao: c.verificacao as Verificacao,
      categoria: c.categoria,
      protocolo: c.protocolo,
      atualizadoEm: c.atualizadoEm,
      avisouEm: c.avisouEm,
    };
    return { estado, versao: c.versao };
  },

  unidades: unidadesAtivas,

  contarNovasDesde: (desde) => prisma.suporteEnvio.count({ where: { enviadoEm: { gte: desde }, nova: true } }),
  contarRespostasDesde: (desde) => prisma.suporteEnvio.count({ where: { enviadoEm: { gte: desde } } }),

  async salvar({ jid, versaoEsperada, estado, abrir }) {
    const colunas = {
      passo: estado.passo,
      tentativas: estado.tentativas,
      nome: estado.nome,
      unidadeSlug: estado.unidade?.slug ?? null,
      unidadeNome: estado.unidade?.nome ?? null,
      verificacao: estado.verificacao,
      categoria: estado.categoria,
      avisouEm: estado.avisouEm,
      atualizadoEm: estado.atualizadoEm ?? new Date(),
    };
    return prisma.$transaction(async (tx) => {
      if (versaoEsperada === null) {
        const criadas = await tx.suporteConversa.createMany({ data: [{ jid, ...colunas, protocolo: null }], skipDuplicates: true });
        if (criadas.count === 0) return { ok: false };
      } else {
        const feitas = await tx.suporteConversa.updateMany({
          where: { jid, versao: versaoEsperada },
          data: { ...colunas, versao: { increment: 1 } },
        });
        if (feitas.count === 0) return { ok: false };
      }
      if (!abrir) return { ok: true };
      const d = await tx.suporteDemanda.create({
        data: {
          jid,
          nome: abrir.nome,
          unidadeSlug: abrir.unidade?.slug ?? null,
          verificacao: abrir.verificacao,
          gruposVistos: abrir.gruposVistos,
          categoria: abrir.categoria,
          categoriaNome: abrir.categoriaNome,
          relato: abrir.relato,
        },
        select: { protocolo: true },
      });
      await tx.suporteConversa.update({ where: { jid }, data: { protocolo: d.protocolo } });
      return { ok: true, protocolo: d.protocolo };
    });
  },

  async registrarEnvio(jid, nova) {
    await prisma.suporteEnvio.create({ data: { jid, nova } });
  },

  async marcarTelegram(protocolo, enviado) {
    await prisma.suporteDemanda.update({ where: { protocolo }, data: { telegramEnviado: enviado } });
  },

  async limparAntigos() {
    const agora = Date.now();
    await prisma.suporteMensagemVista.deleteMany({ where: { vistaEm: { lt: new Date(agora - 7 * DIA_MS) } } });
    await prisma.suporteEnvio.deleteMany({ where: { enviadoEm: { lt: new Date(agora - 3 * DIA_MS) } } });
  },
};

/** Os efeitos reais, montados a partir da configuração do momento. */
export function efeitosReais(config: ConfigSuporte): Efeitos {
  const enviarWhatsApp = criarEnviadorEvolution(config);
  return {
    enviarWhatsApp,
    enviarTelegram: (texto) => enviarTelegramChamados(texto),
    agora: () => new Date(),
    unidadesDoGrupo: (jid, jidAlt) => unidadesDoNumero(indiceAtual(), jid, jidAlt),
    garantirIndice: () => {
      // só lê grupos se há endereço (https) e chave; a leitura é em segundo plano e nunca derruba a conversa
      if (!config.gruposUrl.startsWith('https://') || !config.gruposApikey) return;
      void atualizarIndiceSeVelho(unidadesAtivas, () =>
        lerGruposDeMarketing({ url: config.gruposUrl, instancia: config.gruposInstancia, apikey: config.gruposApikey }),
      );
    },
    sorteio: Math.random,
    analisar: (protocolo) => {
      void dispararAnalise(protocolo);
    },
  };
}

/** Ponto de entrada do webhook (depois de o controller já ter respondido 200): fila por conversa + registro de qualquer erro. */
export function tratarMensagemRecebida(msg: Recebida, config: ConfigSuporte = lerConfig()): Promise<Desfecho | null> {
  return emFila(msg.jid, () => processarMensagem(msg, config, armazemPrisma, efeitosReais(config))).catch((err: unknown) => {
    logger.error({ err: String(err), numero: `…${msg.jid.split('@')[0]!.slice(-4)}` }, 'suporte-menu: erro ao tratar a mensagem');
    return null;
  });
}
