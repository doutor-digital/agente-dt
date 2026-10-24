/**
 * O `Porto` de verdade: banco, Kommo, franquia e Meta. É a ÚNICA ponte do disparo com o mundo, e a única que chama
 * `enviarTemplate` (ver `lote.ts` para a trava do modo seco).
 */
import type { Prisma, Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { estadoDaAutomacao } from '../automacoes-estado.js';
import { createKommoClient } from '../../services/kommo.service.js';
import { credenciaisDaUnidade, enviarTemplate } from '../whatsapp-meta.js';
import { conferenciaDaFranquia } from './franquia.js';
import { leadsQuePediramSair } from './publico.js';
import { telefoneWhatsapp } from './regras.js';
import type { Destino, Modo, Porto } from './lote.js';

/** O id desta automação no catálogo (`lib/automacoes.ts`). */
export const AUTOMACAO_DISPARO = 'disparo-campanha';

/**
 * `DISPARO_LISTA_DE_TESTE`: quem pode receber de verdade com a unidade LIGADA.
 *  - `5563991021043,…` → só esses números;
 *  - `*` → todos os aprovados (a decisão deliberada de soltar a onda, que o João toma uma vez, depois da prova);
 *  - vazia, ausente ou ilegível → NINGUÉM. Ligar uma unidade na tela não pode virar "manda para a lista inteira"
 *    sem alguém ter dito isso com todas as letras.
 * Devolve `null` para "todos" e um conjunto (possivelmente vazio) para "só estes".
 */
export function listaDeTesteDoAmbiente(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | null {
  const bruto = (env.DISPARO_LISTA_DE_TESTE ?? '').trim();
  if (bruto === '*') return null;
  return new Set(bruto.split(',').map((t) => telefoneWhatsapp(t) ?? '').filter(Boolean));
}

const paraDestino = (d: { id: string; ondaId: string; campanhaId: string; unitId: string; telefone: string; chave: string; nome: string; kommoLeadId: number | null; nomeCompleto?: string | null }): Destino => ({
  id: d.id, ondaId: d.ondaId, campanhaId: d.campanhaId, unitId: d.unitId, telefone: d.telefone, chave: d.chave, nome: d.nome, nomeCompleto: d.nomeCompleto ?? d.nome, kommoLeadId: d.kommoLeadId,
});

export function portoReal(unidades: ReadonlyMap<string, Unit>): Porto {
  const franquias = new Map<string, ReturnType<typeof conferenciaDaFranquia>>();
  const unidade = (id: string): Unit => {
    const u = unidades.get(id);
    if (!u) throw new Error(`unidade ${id} fora da rodada`);
    return u;
  };

  return {
    agora: () => new Date(),
    modoDaUnidade: (slug): Modo => estadoDaAutomacao(slug, AUTOMACAO_DISPARO, process.env.DISPARO_CAMPANHA_SLUGS),
    listaDeTeste: () => listaDeTesteDoAmbiente(),

    contarNaJanela: (unitId, desde, modo) =>
      prisma.disparoDestinatario.count({ where: { unitId, ...(modo === 'ligado' ? { enviadoEm: { gte: desde } } : { simuladoEm: { gte: desde } }) } }),

    pendentes: async (ondaId, modo, limite, soTelefones) =>
      (
        await prisma.disparoDestinatario.findMany({
          where: { ondaId, estado: 'pendente', ...(modo === 'seco' ? { simuladoEm: null } : {}), ...(soTelefones ? { telefone: { in: [...soTelefones] } } : {}) },
          orderBy: [{ criadoEm: 'asc' }, { id: 'asc' }],
          take: limite,
        })
      ).map(paraDestino),

    sobram: (ondaId, modo, soTelefones) =>
      prisma.disparoDestinatario.count({
        where: { ondaId, estado: 'pendente', ...(modo === 'seco' ? { simuladoEm: null } : {}), ...(soTelefones ? { telefone: { in: [...soTelefones] } } : {}) },
      }),

    // Só conta quem RECEBEU (enviadoEm) e depois respondeu SAIR; quem já tinha pedido para sair antes foi barrado sem envio.
    quantosSairam: (campanhaId, unitId) => prisma.disparoDestinatario.count({ where: { campanhaId, unitId, estado: 'saiu', enviadoEm: { not: null } } }),

    ondaAprovada: async (ondaId) => (await prisma.disparoOnda.count({ where: { id: ondaId, estado: 'aprovada' } })) > 0,

    ultimosResultados: async (unitId, n, desde) =>
      (
        await prisma.disparoDestinatario.findMany({
          where: { unitId, estado: { in: ['enviado', 'falhou'] }, atualizadoEm: { gte: new Date(Math.max(desde.getTime(), Date.now() - 86_400_000)) } },
          orderBy: { atualizadoEm: 'desc' },
          take: n,
          select: { estado: true },
        })
      ).map((x) => (x.estado === 'enviado' ? 'enviado' : 'falhou')),

    reivindicar: async (id) => (await prisma.disparoDestinatario.updateMany({ where: { id, estado: 'pendente' }, data: { estado: 'enviando', enviadoEm: new Date() } })).count === 1,

    gravar: async (id, dados) => {
      await prisma.disparoDestinatario.update({
        where: { id },
        data: {
          ...(dados.estado ? { estado: dados.estado } : {}),
          ...(dados.motivo !== undefined ? { motivo: dados.motivo } : {}),
          ...(dados.wamid !== undefined ? { wamid: dados.wamid } : {}),
          ...(dados.simuladoEm ? { simuladoEm: dados.simuladoEm } : {}),
          ...(dados.enviadoEm !== undefined ? { enviadoEm: dados.enviadoEm } : {}),
        },
      });
    },

    pausarOndas: async (unitId, campanhaId, motivo) => {
      await prisma.disparoOnda.updateMany({
        where: { unitId, estado: 'aprovada', ...(campanhaId ? { campanhaId } : {}) },
        data: { estado: 'pausada', pausaMotivo: motivo.slice(0, 300) },
      });
    },

    pausarOnda: async (ondaId, motivo) => {
      await prisma.disparoOnda.updateMany({ where: { id: ondaId, estado: 'aprovada' }, data: { estado: 'pausada', pausaMotivo: motivo.slice(0, 300) } });
    },

    concluirOnda: async (ondaId) => {
      await prisma.disparoOnda.updateMany({ where: { id: ondaId, estado: 'aprovada' }, data: { estado: 'concluida' } });
    },

    pediuSair: async (d) => {
      // Em qualquer campanha anterior do sistema…
      const antes = await prisma.disparoDestinatario.count({ where: { unitId: d.unitId, chave: d.chave, estado: 'saiu', NOT: { id: d.id } } });
      if (antes > 0) return true;
      // …ou em qualquer mensagem do cartão.
      return d.kommoLeadId ? (await leadsQuePediramSair(unidade(d.unitId), [d.kommoLeadId])).has(d.kommoLeadId) : false;
    },

    franquia: (d) => {
      const u = unidade(d.unitId);
      let conferir = franquias.get(u.id);
      if (!conferir) franquias.set(u.id, (conferir = conferenciaDaFranquia(u)));
      return conferir({ leadId: d.kommoLeadId, nomeCompleto: d.nomeCompleto, telefone: d.telefone });
    },

    enviar: (onda, d, valores) => {
      const cred = credenciaisDaUnidade(unidade(d.unitId));
      if (!cred) return Promise.resolve({ ok: false, wamid: null, detalhe: 'unidade sem credencial da Meta', incerto: false });
      return enviarTemplate(cred, { para: d.telefone, nome: onda.template, idioma: onda.idioma, corpo: valores, ...(onda.cabecalho ? { cabecalho: onda.cabecalho } : {}) });
    },

    espelhar: async (d, texto) => {
      if (!d.kommoLeadId) return;
      await createKommoClient(unidade(d.unitId)).addLeadNote(d.kommoLeadId, texto);
    },

    dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (nivel, dados, msg) => logger[nivel](dados as Prisma.JsonObject, msg),
  };
}
