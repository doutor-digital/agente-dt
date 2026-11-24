/**
 * As ferramentas da Sophia (escritório de advocacia): `consultar_horarios`, `agendar_atendimento` e `encaminhar_ao_dr_thiago`.
 * A regra mora em `lib/sophia/atendimento.ts`; aqui só se liga o mundo de verdade (Tramitação, Kommo, Evolution, trace) e o esquema das ferramentas.
 *
 * `consultar_horarios` leva o MESMO nome da ferramenta da franquia de propósito: as travas do grafo (horário inventado, horário
 * vencido, "manhã ou tarde?") procuram por esse nome e pelo carimbo "Agenda consultada em…". E o texto que `agendar_atendimento` devolve
 * começa com "Atendimento marcado para", que a trava "reservado sem marcar" reconhece como marcação feita (`RESPOSTA_QUE_MARCA`).
 *
 * Só existe para escritório SEM franquia (`spineEnabled` falso) e com a automação `sophia-agenda` em seco ou ligada.
 */
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { telefoneDoLead } from './agenda-tools.js';
import { carimboDaConsulta } from './horario-oferecido.js';
import { agoraLocalISO } from './consulta-que-passou.js';
import { fusoDaUnidade } from '../lib/fuso.js';
import { logger } from '../lib/logger.js';
import { enviarPelaEvolution } from '../lib/alerta-whatsapp.js';
import { avisoRecente, marcarAviso } from '../lib/aviso-dedupe.js';
import { marcarConsultaNoTurno } from '../lib/cartao-de-chegada.js';
import { registrarSimulacao } from '../lib/so-no-papel.js';
import { linkDoCartao } from '../lib/exame-de-imagem.js';
import { ID_DA_AUTOMACAO, estadoDaSophia, evolutionDoGrupo } from '../lib/sophia/config.js';
import { agendaDaTramitacao, type AgendaDoEscritorio } from '../lib/sophia/agenda.js';
import { agendarAtendimento, consultarHorarios, encaminharAoThiago, type Deps } from '../lib/sophia/atendimento.js';

const STATUS_GANHO = 142;
const STATUS_PERDIDO = 143;

export interface ContextoDaSophia {
  unit: Unit;
  recorder: TraceRecorder;
  kommo?: KommoClient;
  /** Conversa sem Kommo: o telefone do WhatsApp da conversa. */
  telefoneDaConversa?: string;
  /** Só para teste. */
  agenda?: AgendaDoEscritorio;
}

export function depsDaSophia(ctx: ContextoDaSophia): Deps {
  const { unit, recorder, kommo } = ctx;
  return {
    slug: unit.slug,
    estado: () => estadoDaSophia(unit.slug),
    agenda: ctx.agenda ?? agendaDaTramitacao(unit),
    agora: () => Date.now(),
    telefoneDoLead: async (leadId) => (await telefoneDoLead(kommo, leadId)) ?? ctx.telefoneDaConversa ?? null,
    mover: async (leadId, destino) => {
      if (!kommo) throw new Error('sem Kommo neste turno');
      const lead = await kommo.getLead(leadId);
      if (lead.status_id === STATUS_GANHO || lead.status_id === STATUS_PERDIDO) return 'terminal';
      if (lead.pipeline_id !== destino.pipelineId) return 'fora_do_funil';
      if (lead.status_id === destino.statusId) return 'ja_na_etapa';
      await kommo.moveStage({ leadId, statusId: destino.statusId, pipelineId: destino.pipelineId });
      return 'moveu';
    },
    mandarNoGrupo: async (grupo, texto, mencionar) => {
      const evo = evolutionDoGrupo();
      if (!evo) {
        logger.warn({ unit: unit.slug }, 'sophia: sem SOPHIA_EVOLUTION_* nem EVOLUTION_ALERT_* — o grupo não recebe');
        return false;
      }
      return enviarPelaEvolution({ ...evo, numero: grupo, texto, mencionar });
    },
    linkDoCartao: (leadId) => linkDoCartao(unit, leadId),
    jaAvisou: (leadId, chave, janelaMs) => avisoRecente(unit.id, leadId, chave, janelaMs),
    marcarAviso: (leadId, chave) => marcarAviso(unit.id, leadId, chave),
    registrar: (kind, title, payload) => recorder.step({ kind, title, payload }),
    simular: (leadId, acao, alvo, valor) => registrarSimulacao(unit, ID_DA_AUTOMACAO, { leadId, acao, alvo, valor }),
    pedirCartaoDeChegada: () => marcarConsultaNoTurno(recorder.traceId),
    carimbo: () => carimboDaConsulta(agoraLocalISO(fusoDaUnidade(unit))),
  };
}

export function buildSophiaTools(ctx: ContextoDaSophia): DynamicStructuredTool[] {
  if (ctx.unit.spineEnabled) return []; // clínica com franquia usa a agenda da franquia
  if (estadoDaSophia(ctx.unit.slug) === 'desligado') return [];
  const deps = depsDaSophia(ctx);

  const consultar = new DynamicStructuredTool({
    name: 'consultar_horarios',
    description:
      'Consulta os horários REALMENTE livres dos advogados do escritório (Dra. Amanda e Dr. Victor) na agenda. Use SEMPRE antes de oferecer qualquer horário; ' +
      'nunca invente nem repita horário de conversa anterior. Devolve os dois horários a oferecer. Segunda a sexta, 8h–12h e 14h–18h, 50 minutos cada.',
    schema: z.object({
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Procurar a partir desta data (AAAA-MM-DD). Sem data, a partir de hoje.'),
      turno: z.enum(['manha', 'tarde']).optional().describe('Só se o cliente pediu manhã ou tarde.'),
    }),
    func: async ({ data, turno }) => (await consultarHorarios(deps, { aPartirDe: data, turno })).texto,
  });

  const agendar = new DynamicStructuredTool({
    name: 'agendar_atendimento',
    description:
      'Agenda o atendimento do cliente com um advogado, num horário que consultar_horarios devolveu. Só chame depois de o cliente ESCOLHER o horário e de você ter: ' +
      'nome completo, cidade onde mora, resumo curto do caso, se tem laudo e exames, e a situação no INSS. Presencial só para quem mora em Araguaína/TO; as outras cidades são online. ' +
      'Não use para o Dr. Thiago nem para caso tributário (use encaminhar_ao_dr_thiago). Só diga que está marcado se esta ferramenta devolver "Atendimento marcado para".',
    schema: z.object({
      leadId: z.number().int().positive().describe('ID numérico do cartão (lead) no Kommo.'),
      nomeDoCliente: z.string().min(2).max(120).describe('Nome completo do cliente.'),
      cidade: z.string().min(2).max(80).describe('Cidade onde o cliente mora.'),
      estado: z.string().max(40).optional().describe('Estado (UF), se o cliente disse.'),
      caso: z.string().min(3).max(300).describe('Resumo curto do caso, em uma frase (sem CPF, sem número de benefício).'),
      temLaudoEExames: z.boolean().describe('O cliente tem laudo e exames?'),
      situacaoNoInss: z.string().min(2).max(160).describe('Situação no INSS (ex.: benefício cortado, pedido negado, ainda não pediu).'),
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data escolhida (AAAA-MM-DD), exatamente como consultar_horarios devolveu.'),
      hora: z.string().regex(/^\d{2}:\d{2}$/).describe('Hora escolhida (HH:MM), exatamente como consultar_horarios devolveu.'),
      advogado: z.enum(['amanda', 'victor']).optional().describe('O advogado do horário que consultar_horarios indicou. Sem ele, o sistema escolhe quem estiver livre.'),
    }),
    func: async (args) => (await agendarAtendimento(deps, args)).texto,
  });

  const thiago = new DynamicStructuredTool({
    name: 'encaminhar_ao_dr_thiago',
    description:
      'Use quando o cliente PEDE o Dr. Thiago, ou quando o caso é TRIBUTÁRIO. Nesses casos você NÃO agenda: o sistema avisa o Dr. Thiago no grupo do escritório e ele entra em contato. ' +
      'Depois, diga ao cliente que vai avisar o Dr. Thiago e que ele entra em contato. Só diga isso se esta ferramenta devolver "Dr. Thiago avisado".',
    schema: z.object({
      leadId: z.number().int().positive().describe('ID numérico do cartão (lead) no Kommo.'),
      nomeDoCliente: z.string().min(2).max(120).describe('Nome do cliente (só o primeiro nome vai ao grupo).'),
      cidade: z.string().max(80).optional(),
      resumo: z.string().min(3).max(300).describe('Resumo curto do caso, em uma frase (sem CPF, sem número de benefício).'),
      motivo: z.enum(['pediu_thiago', 'tributario']),
    }),
    func: async (args) => (await encaminharAoThiago(deps, args)).texto,
  });

  return [consultar, agendar, thiago];
}
