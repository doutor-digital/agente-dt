/**
 * O `Porto` de verdade: banco, Kommo, franquia e Meta. É a ÚNICA ponte do disparo com o mundo, e a única que chama
 * `enviarTemplate` (ver `lote.ts` para a trava do modo seco).
 */
import type { Prisma, Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { logger } from '../logger.js';
import { createKommoClient } from '../../services/kommo.service.js';
import { credenciaisDaUnidade, enviarTemplate } from '../whatsapp-meta.js';
import { conferenciaDaFranquia } from './franquia.js';
import { leadsQuePediramSair } from './publico.js';
import { telefoneWhatsapp } from './regras.js';
import { modoDaUnidade } from './modo.js';
import { definicaoDaOnda } from './onda.js';
import { impressaoDaOnda } from './modelo.js';
import type { Destino, Modo, Porto } from './lote.js';

export { AUTOMACAO_DISPARO } from './modo.js';

/**
 * `DISPARO_LISTA_DE_TESTE`: quem pode receber de verdade com a unidade LIGADA — POR UNIDADE, nunca global.
 *
 *   `doutor-hernia-canaa=5563991021043,5563...;doutor-hernia-balsas=*`
 *
 *  - `<slug>=<telefones>` → só esses números recebem naquela unidade;
 *  - `<slug>=*` → todos os aprovados DAQUELA unidade (a decisão deliberada de soltar a onda, depois da prova);
 *  - unidade que não aparece, entrada sem `slug=` (o formato antigo, global) ou lixo → NINGUÉM. Um `*` global soltaria
 *    a rede toda de uma vez, e ligar uma unidade na tela não pode virar "manda para a lista inteira".
 * Devolve `null` para "todos" e um conjunto (possivelmente vazio) para "só estes".
 */
export function listaDeTesteDoAmbiente(slug: string, env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> | null {
  for (const entrada of (env.DISPARO_LISTA_DE_TESTE ?? '').split(/[;\n]/)) {
    const i = entrada.indexOf('=');
    if (i < 0 || entrada.slice(0, i).trim() !== slug) continue;
    const valores = entrada.slice(i + 1).split(/[,+]/).map((v) => v.trim());
    if (valores.length === 1 && valores[0] === '*') return null;
    return new Set(valores.map((t) => telefoneWhatsapp(t) ?? '').filter(Boolean));
  }
  return new Set();
}

/** O que a variável tem de errado (formato antigo, global), para o log de subida avisar: nada disso vale. */
export function avisosDaListaDeTeste(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DISPARO_LISTA_DE_TESTE ?? '')
    .split(/[;\n]/)
    .map((e) => e.trim())
    .filter((e) => e && !/^[a-z0-9][a-z0-9-]*=./i.test(e))
    .map((e) => `DISPARO_LISTA_DE_TESTE: a entrada "${e.slice(0, 40)}" não vale (o formato é por unidade: slug=telefone,telefone ou slug=*); ninguém recebe por ela`);
}

const paraDestino = (d: { id: string; ondaId: string; campanhaId: string; unitId: string; telefone: string; chave: string; nome: string; kommoLeadId: number | null; nomeCompleto?: string | null }): Destino => ({
  id: d.id, ondaId: d.ondaId, campanhaId: d.campanhaId, unitId: d.unitId, telefone: d.telefone, chave: d.chave, nome: d.nome, nomeCompleto: d.nomeCompleto ?? d.nome, kommoLeadId: d.kommoLeadId,
});

export function portoReal(unidades: ReadonlyMap<string, Unit>): Porto {
  const franquias = new Map<string, ReturnType<typeof conferenciaDaFranquia>>();
  const mesmoNumero = new Map<string, Promise<string[]>>();
  const unidadesDoMesmoNumero = (unitId: string): Promise<string[]> => {
    let p = mesmoNumero.get(unitId);
    if (!p) {
      p = (async () => {
        const numero = unidade(unitId).metaPhoneNumberId?.trim();
        if (!numero) return [unitId];
        const todas = await prisma.unit.findMany({ where: { metaPhoneNumberId: numero }, select: { id: true } });
        return [...new Set([unitId, ...todas.map((u) => u.id)])];
      })();
      mesmoNumero.set(unitId, p);
    }
    return p;
  };
  const unidade = (id: string): Unit => {
    const u = unidades.get(id);
    if (!u) throw new Error(`unidade ${id} fora da rodada`);
    return u;
  };

  return {
    agora: () => new Date(),
    modoDaUnidade: (slug): Modo => modoDaUnidade(slug),
    listaDeTeste: (slug) => listaDeTesteDoAmbiente(slug),

    // O teto é do NÚMERO de WhatsApp (phone_number_id), que é o que a Meta limita: duas unidades que dividem o mesmo
    // número (Petrópolis e Caxias) somam no mesmo teto. Sem número cadastrado, só a própria unidade.
    contarNaJanela: async (unitId, desde, modo) =>
      prisma.disparoDestinatario.count({ where: { unitId: { in: await unidadesDoMesmoNumero(unitId) }, ...(modo === 'ligado' ? { enviadoEm: { gte: desde } } : { simuladoEm: { gte: desde } }) } }),

    pendentes: async (ondaId, modo, limite, soTelefones) =>
      (
        await prisma.disparoDestinatario.findMany({
          where: { ondaId, estado: 'pendente', ...(modo === 'seco' ? { simuladoEm: null } : {}), ...(soTelefones ? { telefone: { in: [...soTelefones] } } : {}) },
          // Quem foi adiado (franquia fora, banco instável) leva a atualização e vai para o FIM da fila: sem isso três pessoas
          // presas ficam sempre na frente e a onda não anda. Quem nunca foi tentado tem `atualizadoEm` = `criadoEm`.
          orderBy: [{ atualizadoEm: 'asc' }, { id: 'asc' }],
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
          // Sem teto de idade: credencial ruim aparece mesmo numa unidade que manda 3 por dia. `desde` (a última aprovação) é o reinício.
          where: { unitId, estado: { in: ['enviado', 'falhou'] }, atualizadoEm: { gte: desde } },
          orderBy: { atualizadoEm: 'desc' },
          take: n,
          select: { estado: true },
        })
      ).map((x) => (x.estado === 'enviado' ? 'enviado' : 'falhou')),

    // A onda ainda estar APROVADA faz parte da mesma instrução atômica: cancelar/pausar enquanto as conferências
    // lentas rodavam (franquia, SAIR) vale já para esta pessoa.
    reivindicar: async (id) =>
      (await prisma.disparoDestinatario.updateMany({ where: { id, estado: 'pendente', onda: { estado: 'aprovada' } }, data: { estado: 'enviando', enviadoEm: new Date() } })).count === 1,

    gravar: async (id, dados) => {
      await prisma.disparoDestinatario.update({
        where: { id },
        data: {
          ...(dados.estado ? { estado: dados.estado } : {}),
          ...(dados.motivo !== undefined ? { motivo: dados.motivo } : {}),
          ...(dados.wamid !== undefined ? { wamid: dados.wamid } : {}),
          ...(dados.simuladoEm !== undefined ? { simuladoEm: dados.simuladoEm } : {}),
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

    // A aprovação foi dada com a unidade em seco (ou desligada) e a unidade foi LIGADA: o João não aprovou ENVIO. A onda volta a
    // "montada" para ele aprovar de novo, e o que o seco descartou volta para a fila (reconferido na hora do envio): descartar no
    // seco não pode ser para sempre. O total e a impressão são refeitos, senão a nova aprovação nunca bateria.
    devolverParaAprovacao: async (ondaId, motivo) => {
      await prisma.$transaction(async (tx) => {
        const voltou = await tx.disparoOnda.updateMany({
          where: { id: ondaId, estado: 'aprovada' },
          data: { estado: 'montada', aprovadaPor: null, aprovadaEm: null, aprovadaModo: null, pausaMotivo: motivo.slice(0, 300) },
        });
        if (voltou.count !== 1) return;
        await tx.disparoDestinatario.updateMany({ where: { ondaId, estado: 'descartado', enviadoEm: null }, data: { estado: 'pendente', motivo: null } });
        await tx.disparoDestinatario.updateMany({ where: { ondaId, estado: 'pendente', simuladoEm: { not: null } }, data: { simuladoEm: null } });
        const onda = (await tx.disparoOnda.findUnique({ where: { id: ondaId } }))!;
        const pessoas = await tx.disparoDestinatario.findMany({ where: { ondaId, estado: 'pendente' }, select: { chave: true, nome: true } });
        await tx.disparoOnda.update({ where: { id: ondaId }, data: { total: pessoas.length, impressao: impressaoDaOnda(definicaoDaOnda(onda), pessoas) } });
      });
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
