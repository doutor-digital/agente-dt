/**
 * Ligação pelo WhatsApp — o banco (Prisma). Implementa o `Repositorio` de `ligacao-whatsapp-servico.ts`.
 * Tabelas: `whatsapp_ligacoes`, `whatsapp_ligacao_pacientes`, `whatsapp_ligacao_config`.
 */
import { prisma } from './prisma.js';
import type { LinhaLigacao, LinhaPaciente, Repositorio } from './ligacao-whatsapp-servico.js';

const ABERTAS = ['iniciando', 'chamando', 'tocando', 'em_ligacao', 'encerrando'];

export const repositorioPrisma: Repositorio = {
  async config(unitId) {
    return prisma.whatsappLigacaoConfig.findUnique({ where: { unitId } });
  },

  async paciente(unitId, chave) {
    return prisma.whatsappLigacaoPaciente.findUnique({ where: { unitId_chaveTelefone: { unitId, chaveTelefone: chave } } });
  },

  async salvarPaciente(unitId, chave, dados) {
    const { telefone, ...resto } = dados;
    return prisma.whatsappLigacaoPaciente.upsert({
      where: { unitId_chaveTelefone: { unitId, chaveTelefone: chave } },
      create: { unitId, chaveTelefone: chave, telefone, ...resto },
      update: { telefone, ...resto },
    });
  },

  async criarLigacao(dados) {
    return prisma.whatsappLigacao.create({ data: dados }) as Promise<LinhaLigacao>;
  },

  async ligacao(id) {
    return prisma.whatsappLigacao.findUnique({ where: { id } });
  },

  async ligacaoPorWaId(waCallId) {
    return prisma.whatsappLigacao.findUnique({ where: { waCallId } });
  },

  async atualizarLigacao(id, dados) {
    // id/unit/criadaEm nunca mudam por aqui
    const { id: _id, unitId: _u, criadaEm: _c, atualizadaEm: _a, ...resto } = dados;
    return prisma.whatsappLigacao.update({ where: { id }, data: resto });
  },

  async reservarFinalizacao(id, quando) {
    const r = await prisma.whatsappLigacao.updateMany({ where: { id, registradaEm: null }, data: { registradaEm: quando } });
    return r.count === 1;
  },

  async liberarFinalizacao(id) {
    await prisma.whatsappLigacao.updateMany({ where: { id, status: { not: 'encerrada' } }, data: { registradaEm: null } });
  },

  async aberta(unitId, chave, desde) {
    return prisma.whatsappLigacao.findFirst({
      where: { unitId, chaveTelefone: chave, status: { in: ABERTAS }, criadaEm: { gte: desde } },
      orderBy: { criadaEm: 'desc' },
    });
  },

  async ultima(unitId, chave) {
    return prisma.whatsappLigacao.findFirst({ where: { unitId, chaveTelefone: chave }, orderBy: { criadaEm: 'desc' } });
  },

  async esperandoIdDaMeta(unitId, chaves, desde) {
    return prisma.whatsappLigacao.findFirst({
      where: { unitId, chaveTelefone: { in: chaves }, waCallId: null, status: 'iniciando', criadaEm: { gte: desde } },
      orderBy: { criadaEm: 'desc' },
    });
  },

  async resultadosEntre(unitId, de, ate) {
    const linhas = await prisma.whatsappLigacao.findMany({
      where: { unitId, criadaEm: { gte: de, lt: ate }, status: 'encerrada' },
      select: { resultado: true },
    });
    return linhas.map((l) => l.resultado);
  },

  async pausarFila(unitId, ate, motivo, agora) {
    // Só "pausa agora" quem não estava pausado — é isso que garante um alerta por dia, mesmo com duas
    // réplicas fechando ligações ao mesmo tempo.
    const atual = await prisma.whatsappLigacaoConfig.findUnique({ where: { unitId } });
    if (!atual) {
      try {
        await prisma.whatsappLigacaoConfig.create({ data: { unitId, filaPausadaAte: ate, filaPausadaMotivo: motivo } });
        return true;
      } catch {
        return false; // a outra réplica criou primeiro
      }
    }
    const r = await prisma.whatsappLigacaoConfig.updateMany({
      where: { unitId, OR: [{ filaPausadaAte: null }, { filaPausadaAte: { lte: agora } }] },
      data: { filaPausadaAte: ate, filaPausadaMotivo: motivo },
    });
    return r.count === 1;
  },

  async comPermissao(unitId) {
    return prisma.whatsappLigacaoPaciente.findMany({ where: { unitId, permissao: 'aceita', leadId: { not: null } }, take: 500 }) as Promise<LinhaPaciente[]>;
  },

  async abertasParadas(antesDe) {
    return prisma.whatsappLigacao.findMany({ where: { status: { in: ABERTAS }, atualizadaEm: { lt: antesDe } }, orderBy: { atualizadaEm: 'asc' }, take: 100 });
  },
};
