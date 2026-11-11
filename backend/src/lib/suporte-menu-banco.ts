/**
 * Menu de suporte — o armazém de verdade (Prisma) e a ligação com o resto do sistema (Telegram, índice de grupos).
 * Tudo que é regra mora em `suporte-menu.ts` e `suporte-menu-maquina.ts`; aqui só há I/O.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { enviarTelegramChamados } from './telegram.js';
import { dispararAnalise } from './suporte-analise-banco.js';
import { AgrupadorDeAvisos, JANELA_ANALISE_MS, anexarComplemento } from './suporte-complemento.js';
import { enfileirarSeVerificada } from './suporte-claude-banco.js';
import { contarIgnoradaNaPausa, menuPausado } from './suporte-pausa-banco.js';
import { pessoaPausada } from './central-pausa-banco.js';
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
  pausado: () => menuPausado(),
  contarIgnoradaNaPausa,
  pessoaPausada,

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

  async salvar({ jid, versaoEsperada, estado, abrir, complemento }) {
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
      // anexa o complemento ao relato. A linha da demanda fica travada (FOR UPDATE) até o fim da transação: dois balões ao mesmo
      // tempo (outra réplica durante um deploy) não se sobrescrevem
      const anexar = async (c: { protocolo: number; texto: string; quando: Date }) => {
        await tx.$queryRaw`SELECT protocolo FROM suporte_demandas WHERE protocolo = ${c.protocolo} FOR UPDATE`;
        const atual = await tx.suporteDemanda.findUnique({ where: { protocolo: c.protocolo }, select: { relato: true, status: true, jid: true } });
        if (!atual || atual.jid !== jid) {
          logger.warn({ protocolo: c.protocolo }, 'suporte-menu: complemento para demanda que não existe (ou não é desta pessoa) — NÃO anexado');
          return { ok: true };
        }
        const anexo = anexarComplemento(atual.relato, c.texto, c.quando);
        if (anexo.gravado) await tx.suporteDemanda.update({ where: { protocolo: c.protocolo }, data: { relato: anexo.relato } });
        return { ok: true, complementoGravado: { gravado: anexo.gravado, cortado: anexo.cortado, status: atual.status } };
      };

      if (versaoEsperada === null) {
        const criadas = await tx.suporteConversa.createMany({ data: [{ jid, ...colunas, protocolo: null }], skipDuplicates: true });
        if (criadas.count === 0) return { ok: false };
      } else {
        const feitas = await tx.suporteConversa.updateMany({
          where: { jid, versao: versaoEsperada },
          data: { ...colunas, versao: { increment: 1 } },
        });
        // um complemento não muda o passo da conversa: perder a corrida da versão não pode jogar o texto da pessoa fora
        if (feitas.count === 0) return complemento ? { ...(await anexar(complemento)), estadoNaoGravado: true } : { ok: false };
      }
      if (complemento) return anexar(complemento);
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

  async reabrir(protocolo) {
    await prisma.suporteDemanda.update({
      where: { protocolo },
      data: { status: 'reaberta', reabertaEm: new Date(), vezesReaberta: { increment: 1 } },
    });
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

/** Um só para o processo: junta os balões de cada demanda e dá o teto de avisos (o estado fica aqui, não em cada chamada). */
const avisosDeComplemento = new AgrupadorDeAvisos({
  agora: () => Date.now(),
  agendar: (ms, fn) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
  },
  enviar: (texto) => enviarTelegramChamados(texto),
});

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
      // espera uns segundos para os balões seguintes da mesma dúvida entrarem no relato (a análise lê o relato do banco ao rodar);
      // depois, a análise primeiro (o agente lê o que ela achou); com ou sem análise, a demanda verificada entra na fila do agente
      const t = setTimeout(() => void dispararAnalise(protocolo).finally(() => void enfileirarSeVerificada(protocolo)), JANELA_ANALISE_MS);
      // RISCO CONHECIDO: um reinício do servidor dentro destes segundos perde a análise E a entrada na fila do agente desta demanda
      // (o texto e o cartão do Telegram já estão salvos; não há varredura que refaça). Antes a janela era a duração da análise.
      t.unref?.();
    },
    avisarComplemento: (c) => avisosDeComplemento.adicionar(c),
  };
}

/** Ponto de entrada do webhook (depois de o controller já ter respondido 200): fila por conversa + registro de qualquer erro. */
export function tratarMensagemRecebida(msg: Recebida, config: ConfigSuporte = lerConfig()): Promise<Desfecho | null> {
  return emFila(msg.jid, () => processarMensagem(msg, config, armazemPrisma, efeitosReais(config))).catch((err: unknown) => {
    logger.error({ err: String(err), numero: `…${msg.jid.split('@')[0]!.slice(-4)}` }, 'suporte-menu: erro ao tratar a mensagem');
    return null;
  });
}
