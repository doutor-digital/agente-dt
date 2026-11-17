/**
 * O worker `crm-tarefas` (automação `chatwoot-tarefas`): a cada minuto olha as tarefas do CRM (mensagem agendada, ligação, lembrete) que chegaram na hora e
 * deixa `crm-tarefas/ciclo.ts` decidir. Aqui só estão as ligações com o mundo de verdade: o banco (as travas «uma vez só» são `updateMany` com condição),
 * o Chatwoot DA CONTA DA UNIDADE (nunca o de outra) e o WhatsApp pessoal da menina (a instância dos avisos, `EVOLUTION_ALERT_*`).
 *
 * Modo por unidade (tela de automações): desligado = o robô ignora (a tela das tarefas continua funcionando); SECO (de fábrica em toda conta) = decide e anota
 * «mandaria…», sem escrever no paciente, no CRM nem no WhatsApp da menina; ligado = faz.
 */
import type { CrmTarefa } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { fusoDaUnidade } from './fuso.js';
import { enviarPelaEvolution } from './alerta-whatsapp.js';
import { chamar, contaChatwootDoAmbiente, contextoDaUnidade, contextoDoAmbiente } from '../mcp-remoto/chatwoot.js';
import { chatDoChatwoot, paramsDoTemplate } from './chatwoot-regua-worker.js';
import { caixaWhatsappOficial, conferirModeloDaOnda } from './disparo/chatwoot/canal.js';
import { ultimoPedidoDeSaidaDoContato } from './disparo/chatwoot/mensagens.js';
import { AUTOMACAO_TAREFAS, PRESA_ENVIANDO_MS } from './crm-tarefas/regras.js';
import { ID_CICLO, rodarCiclo, type Armazem, type MundoDoCiclo } from './crm-tarefas/ciclo.js';

const CICLO_MS = Number(process.env.CRM_TAREFAS_CICLO_MS) || 60_000;
const PRIMEIRO_CICLO_MS = 90_000;

export const modoDasTarefas = (slug: string, env: NodeJS.ProcessEnv = process.env) => estadoDaAutomacao(slug, AUTOMACAO_TAREFAS, env.CHATWOOT_TAREFAS_SLUGS);

export function armazemDoBanco(): Armazem {
  return {
    async soltarPresas(agora) {
      const r = await prisma.crmTarefa.updateMany({
        where: { estado: 'enviando', tentativaEm: { lt: new Date(agora.getTime() - PRESA_ENVIANDO_MS) } },
        data: { estado: 'falhou', motivo: 'não sei se saiu (o robô parou no meio): confira a conversa antes de mandar de novo' },
      });
      return r.count;
    },
    async unidadesComVencidas(agora) {
      // ligação/lembrete já lembrados esperam o resultado na tela: não põem a unidade na fila do robô a cada minuto
      const l = await prisma.crmTarefa.findMany({ where: { estado: 'pendente', quando: { lte: agora }, OR: [{ tipo: 'mensagem' }, { lembreteEm: null }] }, distinct: ['unitId'], select: { unitId: true } });
      return l.map((x) => x.unitId);
    },
    vencidas(unitId, agora, soNaoSimuladas, limite) {
      return prisma.crmTarefa.findMany({
        where: {
          unitId,
          estado: 'pendente',
          quando: { lte: agora },
          // ligação e lembrete: uma vez só (depois de lembrada, espera o resultado na tela)
          OR: [{ tipo: 'mensagem' }, { lembreteEm: null }],
          ...(soNaoSimuladas ? { simuladoEm: null } : {}),
        },
        orderBy: { quando: 'asc' },
        take: limite,
      });
    },
    async pegar(id, agora, versao) {
      return (await prisma.crmTarefa.updateMany({ where: { id, estado: 'pendente', atualizadoEm: versao }, data: { estado: 'enviando', tentativaEm: agora } })).count === 1;
    },
    async pegarLembrete(id, agora) {
      return (await prisma.crmTarefa.updateMany({ where: { id, estado: 'pendente', lembreteEm: null }, data: { lembreteEm: agora } })).count === 1;
    },
    async desfazerLembrete(id) {
      await prisma.crmTarefa.updateMany({ where: { id, estado: 'pendente' }, data: { lembreteEm: null } });
    },
    async anotarSimulado(id, texto, agora) {
      return (await prisma.crmTarefa.updateMany({ where: { id, estado: 'pendente', simuladoEm: null }, data: { simuladoEm: agora, simulado: texto.slice(0, 300) } })).count === 1;
    },
    async atualizar(id, daqui, dados, versao) {
      return (await prisma.crmTarefa.updateMany({ where: { id, estado: { in: daqui }, ...(versao ? { atualizadoEm: versao } : {}) }, data: dados })).count === 1;
    },
    async numeroDaMenina(conta, agenteId) {
      const z = await prisma.crmTarefaZap.findUnique({ where: { conta_agenteId: { conta, agenteId } } });
      return z?.telefone ?? null;
    },
  };
}

export function mundoReal(): MundoDoCiclo {
  return {
    async unidade(unitId) {
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit) return null;
      const base = contextoDoAmbiente();
      const ctx = base ? contextoDaUnidade(base, unit.slug) : null;
      return {
        slug: unit.slug,
        nome: unit.name,
        fuso: fusoDaUnidade(unit),
        modo: modoDasTarefas(unit.slug),
        ctx,
        linkDaConta: ctx?.conta ? `${ctx.conta.url}/app/accounts/${ctx.conta.conta}` : null,
      };
    },
    conversa: (ctx, id) => chamar(ctx, 'GET', `conversations/${id}`),
    ultimaDoPaciente: (ctx, id) => chatDoChatwoot(ctx).ultimaDoPaciente(id),
    pediuSair: (ctx, conversaId, contatoId) => ultimoPedidoDeSaidaDoContato(ctx, conversaId, contatoId, 3),
    caixaOficial: (ctx, caixa) => caixaWhatsappOficial(ctx, caixa),
    conferirModelo: (ctx, caixa, def) => conferirModeloDaOnda(ctx, caixa, { ...def, categoria: null }),
    async mandar(ctx, conversaId, a) {
      const r = (await chamar(ctx, 'POST', `conversations/${conversaId}/messages`, {
        corpo: { content: a.content, message_type: 'outgoing', private: false, ...(a.modelo ? { template_params: paramsDoTemplate(a.modelo) } : {}) },
      })) as { id?: unknown } | null;
      const id = Number(r?.id);
      return { id: Number.isInteger(id) && id > 0 ? id : null };
    },
    async nota(ctx, conversaId, texto) {
      await chamar(ctx, 'POST', `conversations/${conversaId}/messages`, { corpo: { content: texto, message_type: 'outgoing', private: true } });
    },
    async zap(numero, texto) {
      const { EVOLUTION_ALERT_URL: url, EVOLUTION_ALERT_HEADER: header, EVOLUTION_ALERT_VALUE: valor } = process.env;
      if (!url || !header || !valor) return false;
      return enviarPelaEvolution({ url, header, valor, numero, texto });
    },
    agora: () => new Date(),
    pausa: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    await rodarCiclo({ armazem: armazemDoBanco(), mundo: mundoReal() });
  } catch (err) {
    logger.warn({ err: String(err) }, `${ID_CICLO}: o ciclo falhou — tento no próximo`);
  } finally {
    rodando = false;
  }
}

export function startCrmTarefasWorker(): void {
  if (timer) return;
  if (!contaChatwootDoAmbiente()) {
    logger.info(`${ID_CICLO}: sem CHATWOOT_API_TOKEN/CHATWOOT_CONTA_ID — worker não sobe`);
    return;
  }
  primeira = setTimeout(() => void varrer(), PRIMEIRO_CICLO_MS);
  timer = setInterval(() => void varrer(), CICLO_MS);
  logger.info(`${ID_CICLO}: worker iniciado`);
}

export function stopCrmTarefasWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}

export type { CrmTarefa };
