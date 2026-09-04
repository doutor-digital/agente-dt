import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { esquemaDaUnidade } from '../lib/kommo-schema.js';
import { AgendaService } from '../services/agenda.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { registrarTempoAteAgendamento } from '../services/lead-metrics.service.js';
import { dataPorExtenso, feriadoNacional } from '../lib/feriados.js';

const TZ_PADRAO = 'America/Sao_Paulo';

function agoraLocal(unit: Unit): string {
  return SpineService.instanteNoFuso(new Date(), unit.spineTimezone || TZ_PADRAO);
}

function somarDias(dia: string, n: number): string {
  const t = Date.parse(`${dia}T00:00:00Z`);
  if (Number.isNaN(t)) return dia;
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

async function unidadeFresca(unitId: string): Promise<Unit | null> {
  return prisma.unit.findUnique({ where: { id: unitId } });
}

/**
 * Sinal de que a agenda foi realmente consultada nesta execução.
 *
 * Existe por causa de um caso real (Imperatriz, 28/08/2026, lead 24954279): a IA
 * pausou o atendimento alegando "agenda sem vaga automática" sem ter chamado
 * `consultar_horarios` uma única vez na conversa inteira. A afirmação até estava
 * certa naquele dia — por sorte, não por verificação — e a paciente saiu sem
 * nenhuma data alternativa, embora a tool avance sozinha até o próximo dia com vaga.
 */
export interface EstadoAgenda {
  consultou: boolean;
}

/** Data de hoje (AAAA-MM-DD) no fuso da clínica, não no do servidor. */
export function hojeLocal(unit: Unit): string {
  return agoraLocal(unit).slice(0, 10);
}

interface Contexto {
  unit: Unit;
  recorder: TraceRecorder;
  kommo?: KommoClient;
  /** Compartilhado com o safety-net do `pausar_ia`. */
  estado?: EstadoAgenda;
}

const NOME_AGENDOU = '✓ Agendou';
const NOME_DATA_AGENDAMENTO = '◷ Agendado pela SDR em';
const NOME_DATA_CONSULTA = '◷ Data da Consulta';
const NOME_RESPONSAVEL = '☻ Responsável agendamento';
const RESPONSAVEL_IA = 'I.A Sofia';
const NOME_SITUACAO_CONSULTA = '✓ Situação da consulta';
const NOME_PAGAMENTO_ANTECIPADO = '¤ Pagamento antecipado';
const NOME_ST_RETORNO = 'RETORNO PÓS-TRATAMENTO';

async function gradeDoDia(unit: Unit, dia: string) {
  const [r, blocks] = await Promise.all([
    SpineService.searchSchedules(unit, { initialDate: dia, endDate: dia }),
    prisma.agendaBlock.findMany({ where: { unitId: unit.id, dayLocal: dia } }),
  ]);
  if (!r.ok || !r.data) return { erro: r.error ?? 'agenda indisponível', slots: [] as const };

  const slots = AgendaService.buildAgenda(
    {
      start: unit.spineAgendaStart,
      end: unit.spineAgendaEnd,
      lunchStart: unit.spineLunchStart,
      lunchEnd: unit.spineLunchEnd,
      days: unit.spineAgendaDays,
      slotMinutes: unit.spineSlotMinutes,
    },
    r.data.schedules,
    { initialDate: dia, endDate: dia },
    agoraLocal(unit),
    blocks,
  );
  return { erro: null, slots };
}

const MAX_VALIDACOES = 4;

function espalhar(lista: string[], max: number): string[] {
  if (max <= 0) return [];
  if (lista.length <= max) return [...lista];
  if (max === 1) return [lista[0]];
  const passo = (lista.length - 1) / (max - 1);
  const escolhidos = new Set<string>();
  for (let i = 0; i < max; i++) escolhidos.add(lista[Math.round(i * passo)]);
  return [...escolhidos];
}

async function horariosQueAFranquiaAceita(
  unit: Unit,
  data: string,
  candidatos: string[],
  idClientSonda: number,
): Promise<{ aceitos: string[]; recusados: string[]; sondados: string[] }> {
  const aceitos: string[] = [];
  const recusados: string[] = [];
  const sondados = espalhar(candidatos, MAX_VALIDACOES);
  for (const hora of sondados) {
    const r = await SpineService.createSchedule(unit, {
      idClient: idClientSonda,
      dateAttendanceLocal: `${data}T${hora}:00`,
      idCategory: 1,
    });
    if (r.ok && r.data?.idSchedule) {
      aceitos.push(hora);
      const c = await SpineService.cancelSchedule(unit, r.data.idSchedule);
      if (!c.ok) {
        logger.warn(
          { idSchedule: r.data.idSchedule, data, hora, unit: unit.slug },
          'sondagem: NÃO consegui cancelar — agendamento fantasma na franquia',
        );
      }
    } else {
      recusados.push(hora);
    }
  }
  return { aceitos, recusados, sondados };
}

let sondaCache: { unitId: string; idClient: number; em: number } | null = null;

async function clienteDeSondagem(unit: Unit): Promise<number | null> {
  if (sondaCache?.unitId === unit.id && Date.now() - sondaCache.em < 30 * 60_000) {
    return sondaCache.idClient;
  }
  const vinculo = await prisma.spineLeadLink.findFirst({
    where: { unitId: unit.id, spineIdClient: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  const id = vinculo?.spineIdClient ?? null;
  if (id) sondaCache = { unitId: unit.id, idClient: id, em: Date.now() };
  return id;
}

export function buildConsultarHorarios({ unit, recorder, estado }: Contexto) {
  return new DynamicStructuredTool({
    name: 'consultar_horarios',
    description:
      'Consulta os horários REALMENTE disponíveis da clínica a partir de uma data. ' +
      'Já desconta consultas marcadas, almoço, dias sem atendimento e bloqueios da ' +
      'recepção, e CONFIRMA com o sistema da clínica antes de devolver. Se a data ' +
      'pedida estiver lotada ou bloqueada, AVANÇA SOZINHA até o próximo dia com vaga ' +
      '(inclusive semana ou mês que vem) e devolve os horários desse dia — nunca ' +
      'deixe o paciente sem opção só porque a semana está cheia. Use SEMPRE antes de ' +
      'oferecer qualquer horário — nunca invente nem repita horário de consulta ' +
      'anterior. Passe a data que o paciente pediu (ou amanhã); a tool acha a próxima ' +
      'vaga real a partir dela.',
    schema: z.object({
      data: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Data no formato AAAA-MM-DD, no fuso da clínica.'),
      turno: z
        .enum(['manha', 'tarde'])
        .optional()
        .describe(
          'Passe quando o paciente disser a preferência ("de manhã", "à tarde"). ' +
          'Sem isso a consulta gasta a verificação em horários que ele não quer.',
        ),
    }),
    func: async ({ data, turno }: { data: string; turno?: 'manha' | 'tarde' }) => {
      // Marca ANTES de qualquer saída: o que interessa ao safety-net é se a agenda
      // chegou a ser olhada, mesmo que a resposta tenha sido "não há vaga".
      if (estado) estado.consultou = true;
      const fresca = (await unidadeFresca(unit.id)) ?? unit;

      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'A agenda da clínica não está conectada. NÃO ofereça horários — diga que a equipe entra em contato para marcar.';
      }
      if (fresca.spineAiPaused) {
        await recorder.step({
          kind: 'TOOL_RESULT',
          title: 'consultar_horarios bloqueado — IA pausada pela recepção',
          payload: { motivo: fresca.spinePausedReason },
        });
        return (
          'AGENDAMENTO PAUSADO pela recepção' +
          (fresca.spinePausedReason ? ` (${fresca.spinePausedReason})` : '') +
          '. NÃO ofereça nenhum horário. Diga ao paciente que houve uma intercorrência ' +
          'na agenda e que você retorna em instantes com os horários — sem prometer dia nem hora.'
        );
      }

      const LOOKAHEAD_DIAS = 30;
      const MAX_DIAS_SONDADOS = 3;
      const sonda = await clienteDeSondagem(fresca);
      let diasSondados = 0;
      let outroTurnoNoDiaPedido: string | null = null;
      let cursor = data;

      for (let i = 0; i <= LOOKAHEAD_DIAS; i++, cursor = somarDias(cursor, 1)) {
        const dow = new Date(`${cursor}T00:00:00Z`).getUTCDay();
        if (!fresca.spineAgendaDays.includes(dow)) continue;
        if (feriadoNacional(cursor)) continue; // clínica fechada — nem consulta a grade

        const { erro, slots } = await gradeDoDia(fresca, cursor);
        if (erro) {
          if (i === 0) {
            logger.warn({ erro, data, unit: fresca.slug }, 'consultar_horarios: agenda indisponível');
            return `Não consegui consultar a agenda agora (${erro}). NÃO ofereça horários; diga que a equipe confirma em seguida.`;
          }
          continue;
        }

        const todosLivres = slots.filter((s) => s.status === 'livre').map((s) => s.time);
        const livres = turno
          ? todosLivres.filter((h) => (turno === 'manha' ? h < '12:00' : h >= '12:00'))
          : todosLivres;

        if (i === 0 && turno && livres.length === 0 && todosLivres.length > 0) {
          outroTurnoNoDiaPedido = data;
        }
        if (livres.length === 0) continue;

        let oferecer = livres;
        let recusados: string[] = [];
        let sondados: string[] = [];
        let verificado = false;
        if (sonda && diasSondados < MAX_DIAS_SONDADOS) {
          diasSondados++;
          const r = await horariosQueAFranquiaAceita(fresca, cursor, livres, sonda);
          recusados = r.recusados;
          sondados = r.sondados;
          verificado = true;
          oferecer = r.aceitos;
        } else if (!sonda) {
          logger.warn(
            { unit: fresca.slug, data: cursor, livres: livres.length },
            'consultar_horarios: sem paciente de sondagem — horários NÃO confirmados com a franquia',
          );
        }

        await recorder.step({
          kind: 'TOOL_RESULT',
          title:
            `consultar_horarios ${cursor}${turno ? ` (${turno})` : ''}: ` +
            `${oferecer.length} confirmado(s) de ${livres.length} livre(s) na grade` +
            (cursor === data ? '' : ` (avançou de ${data})`) +
            (verificado ? '' : ' — SEM verificação'),
          payload: { pedido: data, data: cursor, turno, naGrade: todosLivres, noTurno: livres, sondados, oferecer, recusados, sonda },
        });

        if (oferecer.length === 0) continue;

        const mesmoDia = cursor === data;
        return (
          `Horários CONFIRMADOS com a clínica em ${dataPorExtenso(cursor)} (${cursor}): ${oferecer.join(', ')}. ` +
          (mesmoDia
            ? ''
            : `A data ${dataPorExtenso(data)} não tinha vaga (lotada, feriado ou sem atendimento) — ${dataPorExtenso(cursor)} é o PRÓXIMO dia com horário. Ofereça esta data ao paciente com naturalidade. `) +
          'Ofereça no máximo 2 ou 3 deles. Não ofereça nenhum horário fora desta lista. ' +
          'Ao citar a data ao paciente, use EXATAMENTE o dia da semana informado aqui.'
        );
      }

      return (
        (outroTurnoNoDiaPedido
          ? `Em ${outroTurnoNoDiaPedido} não há vaga no período pedido, mas pode haver no outro turno — pergunte se ele aceita. `
          : '') +
        `Não encontrei horário livre de ${data} até ${cursor} (varri os próximos ${LOOKAHEAD_DIAS} dias). ` +
        'Registre a preferência e diga que a equipe confirma o encaixe assim que abrir vaga — NÃO cite nenhum horário.'
      );
    },
  });
}

function fim8(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

async function telefoneDoLead(
  kommo: KommoClient | undefined,
  leadId: number | undefined,
): Promise<string | null> {
  if (!kommo || !leadId) return null;
  try {
    const lead = await kommo.getLead(leadId);
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    if (!contactId) return null;
    return await kommo.getContactPhone(contactId);
  } catch {
    return null;
  }
}

export function buildBuscarPaciente({ unit, recorder, kommo }: Contexto) {
  return new DynamicStructuredTool({
    name: 'buscar_paciente',
    description:
      'Procura o paciente já cadastrado no sistema da clínica, para agendar no ' +
      'cadastro certo. EXIGE o nome COMPLETO (nome e sobrenome) — buscar só pelo ' +
      'primeiro nome traz xarás e a tool recusa. Se não encontrar, use ' +
      'cadastrar_paciente. NUNCA invente idClient.',
    schema: z.object({
      nome: z
        .string()
        .min(2)
        .max(120)
        .describe('Nome COMPLETO do paciente: nome e sobrenome. Só o primeiro nome é recusado.'),
      telefone: z
        .string()
        .max(30)
        .optional()
        .describe(
          'Telefone do paciente com DDD, se ele já disse. É o que confirma que o ' +
          'cadastro encontrado é dele mesmo, e não de um xará.',
        ),
      leadId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Lead do Kommo desta conversa — permite conferir o telefone sozinho.'),
    }),
    func: async (args: { nome: string; telefone?: string; leadId?: number }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Sistema da clínica não conectado. Transfira para a equipe.';
      }

      const partes = args.nome.trim().split(/\s+/).filter((x) => x.length >= 2);
      if (partes.length < 2) {
        await recorder.step({
          kind: 'TOOL_RESULT',
          title: `buscar_paciente recusado — "${args.nome}" é só o primeiro nome`,
          payload: { nome: args.nome },
        });
        return (
          `RECUSADO: "${args.nome}" é só o primeiro nome, e buscar assim traz o cadastro ` +
          'de outra pessoa com o mesmo nome. Pergunte o NOME COMPLETO ao paciente ' +
          '(e o telefone com DDD, se ainda não tiver) e chame esta tool de novo.'
        );
      }

      const r = await SpineService.searchClients(fresca, args.nome);
      if (!r.ok || !r.data) return `Não consegui consultar o cadastro (${r.error}).`;

      const achados = r.data.clients.slice(0, 5);
      if (achados.length === 0) {
        await recorder.step({
          kind: 'TOOL_RESULT',
          title: `buscar_paciente "${args.nome}": 0 resultado(s)`,
          payload: { nome: args.nome, achados },
        });
        return (
          `Nenhum cadastro encontrado para "${args.nome}". ` +
          'Peça o telefone com DDD (se ainda não tiver) e use cadastrar_paciente — ' +
          'depois disso dá pra agendar normalmente.'
        );
      }

      const foneInformado = args.telefone ? SpineService.normalizarWhatsapp(args.telefone) : null;
      const fone = foneInformado ?? (await telefoneDoLead(kommo, args.leadId));
      const alvo = fim8(fone);
      const batem = alvo ? achados.filter((c) => fim8(c.whatsapp) === alvo) : [];

      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `buscar_paciente "${args.nome}": ${achados.length} achado(s), ${batem.length} com telefone batendo`,
        payload: { nome: args.nome, achados, telefoneConferido: fone, batem },
      });

      if (!alvo) {
        return (
          `Encontrei ${achados.length} cadastro(s) com esse nome, mas NÃO tenho telefone ` +
          'pra confirmar que é o dele. NÃO agende ainda. Peça o telefone com DDD ao ' +
          'paciente e chame buscar_paciente de novo passando `telefone`.'
        );
      }

      if (batem.length === 0) {
        return (
          `ATENÇÃO: existe(m) ${achados.length} cadastro(s) com o nome "${args.nome}", mas ` +
          'NENHUM tem o telefone deste paciente. É XARÁ, não é ele. NÃO use esses cadastros. ' +
          'Pergunte ao paciente se ele já se consultou aqui antes: se disser que NÃO, ' +
          'chame cadastrar_paciente e siga; se disser que SIM, NÃO agende — diga que a ' +
          'equipe vai localizar o cadastro dele e retorna em seguida.'
        );
      }

      if (batem.length === 1) await guardarPaciente(fresca.id, args.leadId, batem[0].idClient);

      return (
        `Confirmado pelo telefone: ${batem
          .map((c) => `idClient ${c.idClient} — ${c.name}`)
          .join(' | ')}. Use este idClient em agendar_consulta.`
      );
    },
  });
}

/**
 * Confere se o horário que a IA diz que o paciente aceitou é um horário de
 * verdade: existe no calendário e ainda não passou.
 *
 * Aceita só o formato pedido no schema. Deixar solto ("amanhã de manhã",
 * "semana que vem") devolveria o problema pro lugar de onde ele veio: a IA
 * escreveria qualquer coisa pra satisfazer o campo obrigatório e cadastraria
 * o paciente do mesmo jeito.
 */
export function interpretarHorarioEscolhido(
  bruto: string | undefined,
  agora: Date = new Date(),
): { ok: true; quando: Date } | { ok: false; motivo: string } {
  const texto = (bruto ?? '').trim();
  if (!texto) return { ok: false, motivo: 'não veio o horário escolhido pelo paciente.' };

  const m = texto.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) {
    return {
      ok: false,
      motivo: `"${texto.slice(0, 40)}" não é um horário concreto (esperado AAAA-MM-DD HH:MM).`,
    };
  }

  const [, ano, mes, dia, hora, min] = m.map(Number) as unknown as number[];
  const quando = new Date(ano, mes - 1, dia, hora, min, 0, 0);
  // O Date do JS transborda em silêncio: 2026-13-45 vira fevereiro de 2027 e
  // passaria como "futuro". Só aceita se a data que saiu for a que entrou.
  const bateu =
    quando.getFullYear() === ano &&
    quando.getMonth() === mes - 1 &&
    quando.getDate() === dia &&
    quando.getHours() === hora &&
    quando.getMinutes() === min;
  if (!bateu) {
    return { ok: false, motivo: `"${texto.slice(0, 40)}" não é uma data válida.` };
  }
  // Uma folga de 5 min pro relógio do modelo não brigar com o do servidor.
  if (quando.getTime() < agora.getTime() - 5 * 60_000) {
    return { ok: false, motivo: `${texto.slice(0, 16)} já passou.` };
  }
  return { ok: true, quando };
}

export function buildCadastrarPaciente({ unit, recorder }: Contexto) {
  return new DynamicStructuredTool({
    name: 'cadastrar_paciente',
    description:
      'Cadastra o paciente no sistema da clínica quando buscar_paciente não achou ninguém. ' +
      'Exige NOME COMPLETO (nome e sobrenome) e telefone com DDD. Devolve o idClient ' +
      'para usar em agendar_consulta. Se recusar, peça ao paciente o que faltou.',
    schema: z.object({
      nome: z.string().min(3).max(120).describe('Nome COMPLETO: nome e sobrenome.'),
      telefone: z.string().min(8).max(30).describe('Telefone com DDD.'),
      cidade: z.string().max(80).optional().describe('Cidade, se o paciente disse.'),
      uf: z.string().max(30).optional().describe('Estado ou sigla, se o paciente disse.'),
      leadId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Lead do Kommo desta conversa — liga o cadastro ao contato já existente.'),
      horarioEscolhido: z
        .string()
        .describe(
          'OBRIGATÓRIO: a data e hora que o paciente JÁ ACEITOU, no formato ' +
            'AAAA-MM-DD HH:MM. Só cadastre quem vai agendar agora. Se ele ainda ' +
            'não escolheu horário, ofereça os horários primeiro — não cadastre.',
        ),
    }),
    func: async (args: {
      nome: string;
      telefone: string;
      cidade?: string;
      uf?: string;
      leadId?: number;
      horarioEscolhido: string;
    }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Sistema da clínica não conectado. Transfira para a equipe.';
      }

      const partes = args.nome.trim().split(/\s+/).filter((x) => x.length >= 2);
      if (partes.length < 2) {
        return 'RECUSADO: falta o sobrenome. Pergunte o nome completo antes de cadastrar.';
      }

      // Paciente na franquia é só quem agenda. Em 30 dias, 6 dos 22 cadastros
      // feitos pela IA foram de gente que nunca marcou nada — vira paciente
      // fantasma no sistema da clínica. O cadastro acontece ANTES do
      // agendamento por desenho do fluxo, então a única forma de amarrar os
      // dois é exigir aqui o horário que o paciente já aceitou.
      const quando = interpretarHorarioEscolhido(args.horarioEscolhido);
      if (!quando.ok) {
        await recorder.step({
          kind: 'TOOL_RESULT',
          title: `cadastrar_paciente RECUSADO: ${quando.motivo}`,
          payload: { nome: args.nome, horarioEscolhido: args.horarioEscolhido },
        });
        return `RECUSADO: ${quando.motivo} Só cadastre quem já escolheu o horário — ofereça os horários primeiro.`;
      }

      const fone = SpineService.normalizarWhatsapp(args.telefone);
      if (!fone || fone.replace(/\D/g, '').length < 12) {
        return 'RECUSADO: telefone incompleto. Peça o número com DDD.';
      }

      const jaTem = await SpineService.searchClients(fresca, args.nome);
      const igual = jaTem.ok
        ? (jaTem.data?.clients ?? []).find(
            (c) => (c.whatsapp ?? '').replace(/\D/g, '').slice(-8) === fone.replace(/\D/g, '').slice(-8),
          )
        : undefined;
      if (igual) {
        await recorder.step({
          kind: 'TOOL_RESULT',
          title: `cadastrar_paciente: já existia (${igual.idClient})`,
          payload: { nome: args.nome, idClient: igual.idClient },
        });
        await guardarPaciente(fresca.id, args.leadId, igual.idClient);
        return `Já existia. idClient ${igual.idClient} — ${igual.name}. Use este para agendar.`;
      }

      const vinculo = args.leadId
        ? await prisma.spineLeadLink.findFirst({
            where: { unitId: fresca.id, kommoLeadId: args.leadId },
          })
        : null;

      let idClient: number | null = null;
      let via: 'convert' | 'create' = 'create';

      if (vinculo?.spineIdLead) {
        const c = await SpineService.convertLead(fresca, {
          idLead: vinculo.spineIdLead,
          name: args.nome.trim(),
          idSource: fresca.spineDefaultSourceId,
          whatsapp: fone,
        });
        if (c.ok && c.data?.idClient) {
          idClient = c.data.idClient;
          via = 'convert';
        } else {
          logger.warn(
            { unit: fresca.slug, idLead: vinculo.spineIdLead, erro: c.error },
            'agenda-tools: conversão do lead falhou — caindo para cadastro novo',
          );
        }
      }

      if (idClient === null) {
        const r = await SpineService.createClient(fresca, {
          name: args.nome.trim(),
          whatsapp: fone,
          idSource: fresca.spineDefaultSourceId,
          idLead: vinculo?.spineIdLead ?? null,
          addressCity: args.cidade?.trim().toUpperCase() ?? null,
          addressUf: SpineService.resolverUf(args.uf ?? null),
        });
        if (!r.ok || !r.data?.idClient) {
          await recorder.step({
            kind: 'ERROR',
            title: `cadastrar_paciente "${args.nome}": falhou`,
            payload: { nome: args.nome, telefone: fone, resultado: r },
          });
          logger.warn({ unit: fresca.slug, erro: r.error }, 'agenda-tools: falha ao cadastrar paciente');
          return `Não consegui concluir o cadastro (${r.error}). Avise que a equipe vai finalizar.`;
        }
        idClient = r.data.idClient;
      }

      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `cadastrar_paciente "${args.nome}": ok via ${via} (idClient ${idClient})`,
        payload: { nome: args.nome, telefone: fone, idClient, via, idLead: vinculo?.spineIdLead ?? null },
      });
      await guardarPaciente(fresca.id, args.leadId, idClient);
      return `Cadastrado. idClient ${idClient} — use este número em agendar_consulta.`;
    },
  });
}

async function consultaAtual(unit: Unit, leadId: number | undefined) {
  const c = await AgendaReconcileService.consultaDoLead(unit, leadId);
  if (!c || !c.idSchedule || c.estado === 'cancelada') return null;
  return { idSchedule: c.idSchedule, quando: c.quando, confirmada: c.estado === 'confirmada' };
}

const porExtenso = AgendaReconcileService.porExtenso;

/**
 * Confere se o `idClient` que o modelo mandou é o paciente DESTA conversa.
 *
 * `buscar_paciente` já é rigorosa — só confirma cadastro cujo telefone bate, e
 * grava o vínculo lead↔paciente em `spineLeadLink.spineIdClient`. Mas o número
 * que chega em `agendar_consulta`, `cancelar_consulta` e `remarcar_consulta` é o
 * que o MODELO escreveu, e ninguém compara com o vínculo guardado.
 *
 * O estrago aqui é maior que uma tag errada: marcar, remarcar ou CANCELAR a
 * consulta de outro paciente. E é invisível — a resposta ao paciente parece
 * perfeitamente normal, então o guardrail de saída não pega.
 *
 * Só bloqueia quando existe vínculo gravado E ele diverge. Lead sem vínculo
 * (paciente novo, primeiro agendamento) passa: aí o `idClient` acabou de sair do
 * `cadastrar_paciente` e não há com o que comparar.
 */
export type ConfereePaciente = { ok: true } | { ok: false; idClientCerto: number };

/** A decisão, separada da leitura do banco pra poder ser testada sozinha. */
export function pacienteConfere(
  guardado: number | null | undefined,
  pedido: number,
): ConfereePaciente {
  if (!guardado) return { ok: true };
  if (guardado === pedido) return { ok: true };
  return { ok: false, idClientCerto: guardado };
}

async function conferirPacienteDoLead(
  unitId: string,
  leadId: number | undefined,
  idClient: number,
): Promise<ConfereePaciente> {
  if (!leadId) return { ok: true };
  const vinculo = await prisma.spineLeadLink
    .findUnique({
      where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } },
      select: { spineIdClient: true },
    })
    .catch(() => null);
  return pacienteConfere(vinculo?.spineIdClient, idClient);
}

async function guardarPaciente(
  unitId: string,
  leadId: number | undefined,
  idClient: number | null | undefined,
): Promise<void> {
  if (!leadId || !idClient) return;
  await prisma.spineLeadLink
    .updateMany({ where: { unitId, kommoLeadId: leadId }, data: { spineIdClient: idClient } })
    .catch(() => undefined);
  AgendaReconcileService.esqueceConsulta(unitId, leadId);
}

export function buildCancelarConsulta({ unit, recorder }: Contexto) {
  return new DynamicStructuredTool({
    name: 'cancelar_consulta',
    description:
      'Cancela a consulta do paciente na clínica. Chame PRIMEIRO sem confirmado ' +
      '(ou confirmado=false) para receber a pergunta de confirmação e fazê-la ao ' +
      'paciente. Só chame com confirmado=true depois de ele responder que sim.',
    schema: z.object({
      leadId: z.number().int().positive().describe('Lead do Kommo desta conversa.'),
      confirmado: z
        .boolean()
        .optional()
        .describe('true SOMENTE depois de o paciente confirmar que quer cancelar.'),
    }),
    func: async (args: { leadId: number; confirmado?: boolean }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      const atual = await consultaAtual(fresca, args.leadId);
      if (!atual) return 'Este paciente não tem consulta marcada por aqui. Não há o que cancelar.';

      if (!atual.confirmada) {
        return (
          'NÃO CANCELEI: não consegui confirmar na clínica qual é a consulta dele agora. ' +
          'NÃO cite dia nem hora. Diga que vai confirmar o agendamento com a equipe e ' +
          'retornar em instantes.'
        );
      }

      if (!args.confirmado) {
        return (
          'AINDA NÃO CANCELEI. Pergunte ao paciente, com estas palavras: ' +
          `"Você tem certeza que deseja cancelar seu agendamento de ${porExtenso(atual.quando)}? ` +
          'Se cancelar, a vaga volta para a fila e pode ser ocupada por outra pessoa. ' +
          'Me confirma: cancelar ou manter?" ' +
          'Só chame de novo com confirmado=true se ele responder que quer MESMO cancelar. ' +
          'Se ele quiser outro dia ou horário, use remarcar_consulta em vez de cancelar.'
        );
      }

      const r = await SpineService.cancelSchedule(fresca, atual.idSchedule);
      await recorder.step({
        kind: r.ok ? 'TOOL_RESULT' : 'ERROR',
        title: `cancelar_consulta ${atual.idSchedule}: ${r.ok ? 'cancelada' : r.error}`,
        payload: { leadId: args.leadId, idSchedule: atual.idSchedule, quando: atual.quando },
      });
      if (!r.ok) {
        return `Não consegui cancelar (${r.error}). NÃO diga que foi cancelado — avise que a equipe confirma.`;
      }

      await prisma.spineLeadLink
        .updateMany({
          where: { unitId: fresca.id, kommoLeadId: args.leadId },
          data: { spineIdSchedule: null, agendadoPara: null },
        })
        .catch(() => undefined);
      AgendaReconcileService.esqueceConsulta(fresca.id, args.leadId);

      return `Consulta de ${porExtenso(atual.quando)} cancelada. Confirme ao paciente e pergunte se ele quer remarcar para outro dia.`;
    },
  });
}

export function buildConfirmarPresenca({ unit, recorder }: Contexto) {
  return new DynamicStructuredTool({
    name: 'confirmar_presenca',
    description:
      'Registra na clínica que o paciente CONFIRMOU que vai comparecer. Use quando ' +
      'ele disser que confirma, que estará lá, ou responder "confirmo" ao lembrete. ' +
      'Não use para marcar consulta nova — isso é agendar_consulta.',
    schema: z.object({
      leadId: z.number().int().positive().describe('Lead do Kommo desta conversa.'),
    }),
    func: async (args: { leadId: number }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Agenda não conectada. Agradeça a confirmação e diga que a equipe registra.';
      }

      const atual = await consultaAtual(fresca, args.leadId);
      if (!atual) {
        return (
          'Este paciente não tem consulta marcada por aqui — não há presença a confirmar. ' +
          'Se ele quer marcar, use consultar_horarios e agende.'
        );
      }
      if (!atual.confirmada) {
        return (
          'NÃO confirmei: não consegui checar a consulta dele na clínica agora. ' +
          'NÃO cite dia nem hora. Agradeça e diga que a equipe confirma em seguida.'
        );
      }

      const r = await SpineService.confirmSchedule(fresca, atual.idSchedule);
      await recorder.step({
        kind: r.ok ? 'TOOL_RESULT' : 'ERROR',
        title: `confirmar_presenca ${atual.idSchedule}: ${r.ok ? 'confirmada' : r.error}`,
        payload: { leadId: args.leadId, idSchedule: atual.idSchedule, quando: atual.quando },
      });
      if (!r.ok) {
        return (
          `Não consegui registrar a confirmação (${r.error}). Agradeça mesmo assim e diga ` +
          'que está tudo certo para o horário — NÃO invente problema para o paciente.'
        );
      }
      AgendaReconcileService.esqueceConsulta(fresca.id, args.leadId);
      return (
        `Presença confirmada para ${porExtenso(atual.quando)}. Agradeça, confirme o dia e a ` +
        'hora e lembre de chegar 15 minutos antes.'
      );
    },
  });
}

export function buildRemarcarConsulta(ctx: Contexto) {
  const { unit, recorder } = ctx;
  const agendar = buildAgendarConsulta(ctx);
  return new DynamicStructuredTool({
    name: 'remarcar_consulta',
    description:
      'Troca a consulta do paciente para outro dia/horário. Use quando ele já tem ' +
      'consulta marcada e quer mudar — NÃO cancele e agende separadamente. ' +
      'Consulte os horários antes e use um da lista.',
    schema: z.object({
      leadId: z.number().int().positive(),
      idClient: z.number().int().positive().describe('idClient do paciente.'),
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Nova data AAAA-MM-DD.'),
      hora: z.string().regex(/^\d{2}:\d{2}$/).describe('Novo horário HH:mm.'),
    }),
    func: async (args: { leadId: number; idClient: number; data: string; hora: string }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      const atual = await consultaAtual(fresca, args.leadId);

      const nova = await (agendar as unknown as { func: (a: unknown) => Promise<string> }).func({
        leadId: args.leadId,
        idClient: args.idClient,
        data: args.data,
        hora: args.hora,
        remarcando: true,
      });
      if (!/marcada/i.test(nova)) {
        return `A consulta antiga CONTINUA valendo — não consegui marcar a nova. ${nova}`;
      }

      if (atual) {
        const c = await SpineService.cancelSchedule(fresca, atual.idSchedule);
        await recorder.step({
          kind: c.ok ? 'TOOL_RESULT' : 'ERROR',
          title: `remarcar: antiga ${atual.idSchedule} ${c.ok ? 'cancelada' : 'NÃO cancelada'}`,
          payload: { leadId: args.leadId, antiga: atual.idSchedule, nova: `${args.data} ${args.hora}` },
        });
        AgendaReconcileService.esqueceConsulta(fresca.id, args.leadId);
      }
      return `Remarcada de ${porExtenso(atual?.quando)} para ${porExtenso(`${args.data}T${args.hora}`)}. ${nova}`;
    },
  });
}

export function buildAgendarConsulta({ unit, recorder, kommo }: Contexto) {
  return new DynamicStructuredTool({
    name: 'agendar_consulta',
    description:
      'Marca a consulta no sistema da clínica. Só use DEPOIS de consultar_horarios ' +
      'e de o paciente escolher um horário da lista, e com o idClient obtido em ' +
      'buscar_paciente. Se a tool recusar, NÃO tente outro horário por conta ' +
      'própria: explique ao paciente e ofereça consultar de novo.',
    schema: z.object({
      idClient: z.number().int().positive().describe('idClient do paciente (de buscar_paciente).'),
      remarcando: z
        .boolean()
        .optional()
        .describe('Uso interno de remarcar_consulta. NÃO use — para trocar de horário chame remarcar_consulta.'),
      data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data AAAA-MM-DD.'),
      hora: z.string().regex(/^\d{2}:\d{2}$/).describe('Hora HH:mm do fuso da clínica.'),
      idCategory: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Categoria do atendimento. Padrão 1 (consulta).'),
      leadId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('ID do lead no Kommo — use o leadId desta conversa.'),
      telefone: z
        .string()
        .max(30)
        .optional()
        .describe(
          'Telefone que o paciente informou, se ele disse um diferente do WhatsApp ' +
          'desta conversa. Use o MESMO que você passou em buscar_paciente ou cadastrar_paciente.',
        ),
    }),
    func: async (args: {
      idClient: number;
      remarcando?: boolean;
      data: string;
      hora: string;
      idCategory?: number;
      leadId?: number;
      telefone?: string;
    }) => {
      const feriado = feriadoNacional(args.data);
      if (feriado) {
        return `${dataPorExtenso(args.data)} é feriado nacional (${feriado}) — a clínica não abre. NÃO marque nesse dia; consulte horários em outro dia útil.`;
      }

      const fresca = (await unidadeFresca(unit.id)) ?? unit;

      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Agenda não conectada. NÃO confirme nada — diga que a equipe conclui o agendamento.';
      }

      if (fresca.spineAiPaused) {
        await recorder.step({
          kind: 'ERROR',
          title: 'agendar_consulta recusado — IA pausada pela recepção',
          payload: { ...args, motivo: fresca.spinePausedReason },
        });
        return (
          'AGENDAMENTO PAUSADO pela recepção. A consulta NÃO foi marcada. Explique que ' +
          'houve uma intercorrência na agenda e que a equipe confirma o horário em seguida. ' +
          'NÃO diga que está agendado.'
        );
      }

      const dono = await conferirPacienteDoLead(fresca.id, args.leadId, args.idClient);
      if (!dono.ok) {
        await recorder.step({
          kind: 'ERROR',
          title: `🛡 agendar_consulta tentou marcar para o paciente ${args.idClient} — este lead é do ${dono.idClientCerto}`,
          payload: { ...args, idClientCerto: dono.idClientCerto },
        });
        return (
          `RECUSADO: o idClient ${args.idClient} não é o paciente desta conversa. ` +
          `Use ${dono.idClientCerto}, que é o cadastro confirmado deste lead. ` +
          'NÃO diga ao paciente que houve erro — apenas refaça com o número certo.'
        );
      }

      const { erro, slots } = await gradeDoDia(fresca, args.data);
      if (erro) {
        return `Não consegui confirmar a agenda (${erro}). NÃO diga que está marcado.`;
      }
      const slot = slots.find((s) => s.time === args.hora);
      if (!slot) {
        return `${args.hora} não é um horário de atendimento em ${args.data}. Consulte os horários de novo e ofereça um da lista.`;
      }
      if (slot.status !== 'livre') {
        await recorder.step({
          kind: 'ERROR',
          title: `agendar_consulta recusado — ${args.hora} está ${slot.status}`,
          payload: { ...args, motivo: slot.motivo },
        });
        return (
          `${args.hora} não está mais disponível (${slot.motivo ?? slot.status}). ` +
          'A consulta NÃO foi marcada. Peça desculpas, consulte os horários de novo e ofereça outro.'
        );
      }

      if (!args.remarcando) {
        const ja = await consultaAtual(fresca, args.leadId);
        if (ja) {
          return (
            `RECUSADO: este paciente já tem consulta em ${porExtenso(ja.quando)}. ` +
            'Um paciente só pode ter uma. Se ele quer OUTRO dia ou horário, chame ' +
            'remarcar_consulta; se quer desmarcar, chame cancelar_consulta. ' +
            'NÃO marque uma segunda.'
          );
        }
      }

      const conf = await SpineService.getClient(fresca, args.idClient);
      if (conf.ok && !conf.data?.client) {
        await recorder.step({
          kind: 'ERROR',
          title: `agendar_consulta recusado — idClient ${args.idClient} não existe`,
          payload: { ...args },
        });
        return (
          `RECUSADO: o cadastro ${args.idClient} não existe na clínica. NÃO diga que marcou. ` +
          'Use buscar_paciente com o nome completo, ou cadastrar_paciente se ele for novo.'
        );
      }
      const paciente = conf.ok ? conf.data?.client ?? null : null;
      if (paciente) {
        const foneLead = await telefoneDoLead(kommo, args.leadId);
        const foneInformado = args.telefone ? SpineService.normalizarWhatsapp(args.telefone) : null;
        const aceitos = [fim8(foneLead), fim8(foneInformado)].filter(
          (x): x is string => x !== null,
        );
        const b = fim8(paciente.whatsapp);
        if (aceitos.length > 0 && b && !aceitos.includes(b)) {
          await recorder.step({
            kind: 'ERROR',
            title: `agendar_consulta recusado — idClient ${args.idClient} é de outra pessoa`,
            payload: { ...args, cadastro: paciente.name, foneCadastro: paciente.whatsapp, foneLead, foneInformado },
          });
          return (
            `RECUSADO: o cadastro ${args.idClient} é de "${paciente.name}", e o telefone dele ` +
            'NÃO é o deste paciente. Marcar aqui poria a consulta no prontuário de outra ' +
            'pessoa. NÃO diga que marcou. Confirme o nome completo e use buscar_paciente ' +
            'de novo; se ele nunca se consultou aí, use cadastrar_paciente.'
          );
        }
      }

      const r = await SpineService.createSchedule(fresca, {
        idClient: args.idClient,
        dateAttendanceLocal: `${args.data}T${args.hora}:00`,
        idCategory: args.idCategory ?? 1,
      });

      if (!r.ok) {
        await recorder.step({
          kind: 'ERROR',
          title: `agendar_consulta falhou: ${r.error}`,
          payload: { ...args, error: r.error },
        });
        return (
          `Não consegui marcar às ${args.hora} (${r.error}). ` +
          'PARE AQUI: não chame agendar_consulta de novo neste turno e não tente ' +
          'outro horário agora. Responda ao paciente pedindo desculpas em UMA ' +
          'frase, sem termo técnico, diga que vai confirmar a melhor opção e ' +
          'que retorna em instantes. No próximo turno você consulta de novo.'
        );
      }

      let especialista: string | null = null;
      try {
        const conf = await SpineService.searchSchedules(fresca, {
          initialDate: args.data,
          endDate: args.data,
        });
        const meu = (conf.data?.schedules ?? []).find(
          (x) => x.idSchedule === r.data?.idSchedule,
        );
        especialista = meu?.physicalTherapist?.trim() || null;
      } catch {
        especialista = null;
      }

      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `Consulta marcada: ${args.data} ${args.hora} (idSchedule ${r.data?.idSchedule})`,
        payload: { ...args, idSchedule: r.data?.idSchedule, especialista },
      });

      if (args.leadId) {
        await prisma.spineLeadLink
          .updateMany({
            where: { unitId: fresca.id, kommoLeadId: args.leadId },
            data: {
              spineIdSchedule: r.data?.idSchedule ?? null,
              agendadoPara: `${args.data}T${args.hora}`,
            },
          })
          .catch(() => undefined);
        AgendaReconcileService.esqueceConsulta(fresca.id, args.leadId);
      }

      if (kommo && args.leadId) {
        void (async () => {
          const esquema = await esquemaDaUnidade(unit, kommo);
          const idDe = (nome: string) => esquema.campoPorNome(nome);
          const stRetorno = esquema.statusPorNome('COMERCIAL', NOME_ST_RETORNO);

          const leadAtual = await kommo.getLead(args.leadId!).catch(() => null);
          const ehRetorno = stRetorno !== null && leadAtual?.status_id === stRetorno;
          const consultaEm = `${args.data}T${args.hora}:00`;
          const agendadoEm = Math.floor(Date.now() / 1000);

          const carimbos: Array<{ campo: string; id: number | null; fn: (id: number) => Promise<void> }> = [
            { campo: NOME_AGENDOU, id: idDe(NOME_AGENDOU), fn: (id) => kommo.setLeadCustomFieldValue(args.leadId!, id, 'select', 'Sim') },
            { campo: NOME_DATA_AGENDAMENTO, id: idDe(NOME_DATA_AGENDAMENTO), fn: (id) => kommo.setLeadCustomFieldValue(args.leadId!, id, 'date', agendadoEm) },
            { campo: NOME_DATA_CONSULTA, id: idDe(NOME_DATA_CONSULTA), fn: (id) => kommo.setLeadCustomFieldValue(args.leadId!, id, 'date', consultaEm) },
            { campo: NOME_RESPONSAVEL, id: idDe(NOME_RESPONSAVEL), fn: (id) => kommo.setLeadCustomFieldValue(args.leadId!, id, 'select', RESPONSAVEL_IA) },
            { campo: NOME_SITUACAO_CONSULTA, id: idDe(NOME_SITUACAO_CONSULTA), fn: (id) => kommo.setLeadCustomFieldValue(args.leadId!, id, 'select', 'Agendado') },
            { campo: NOME_PAGAMENTO_ANTECIPADO, id: idDe(NOME_PAGAMENTO_ANTECIPADO), fn: (id) => kommo.setLeadCustomFieldValue(args.leadId!, id, 'select', ehRetorno ? 'Não' : 'Sim') },
          ];

          const falhas: string[] = [];
          for (const c of carimbos) {
            if (c.id === null) {
              falhas.push(`${c.campo} (não existe nesta conta)`);
              logger.warn({ leadId: args.leadId, campo: c.campo, unit: unit.slug }, 'agenda: campo nao encontrado na conta');
              continue;
            }
            try {
              await c.fn(c.id);
            } catch (err) {
              falhas.push(c.campo);
              logger.warn({ err, leadId: args.leadId, campo: c.campo }, 'agenda: falha ao carimbar campo no Kommo');
            }
          }

          await recorder.step({
            kind: falhas.length > 0 ? 'ERROR' : 'KOMMO_ACTION',
            title:
              falhas.length > 0
                ? `⚠️ Agendamento gravado com ${falhas.length} campo(s) em branco: ${falhas.join(', ')}`
                : `Campos de agendamento preenchidos (Agendou, Agendado em, Data da Consulta, Responsável, Situação=Agendado, Pré-pag=${ehRetorno ? 'Não' : 'Sim'})`,
            payload: { leadId: args.leadId, consultaEm, agendadoEm, falhas, responsavel: RESPONSAVEL_IA },
          });

          await registrarTempoAteAgendamento(fresca, kommo, args.leadId!).catch((err) =>
            logger.warn({ err, leadId: args.leadId }, 'agenda: falha ao registrar tempo até agendamento'),
          );

          // Marca a conversa como convertida no momento em que a consulta é
          // marcada. Antes isso só acontecia quando o lead chegava em
          // "GANHO/CONCLUÍDO" — o fim do tratamento, meses depois — e o
          // resultado é que `converted_at` estava nulo em 3.869 conversas de 30
          // dias: o sistema não tinha registro de nenhuma vitória da IA.
          //
          // Sem isso, a reflexão semanal só consegue aprender com o que deu
          // errado; não há como perguntar "o que eu fiz nas conversas que
          // fecharam". `updateMany` não falha se a conversa ainda não existir.
          await prisma.conversation
            .updateMany({
              where: { unitId: fresca.id, leadId: String(args.leadId), convertedAt: null },
              data: { convertedAt: new Date() },
            })
            .catch((err) =>
              logger.warn({ err, leadId: args.leadId }, 'agenda: falha ao marcar conversão — segue'),
            );

          // Avisa o grupo de que foi a IA que marcou. Sem esta tarefa a equipe
          // só descobria abrindo o cartão: o único alerta com a palavra
          // "AGENDADO" que chegava no grupo era o do vigia de cards ("card em
          // AGENDADO com campo vazio") — que o roteador rotulava como "consulta
          // agendada" e dizia à equipe o oposto do que tinha acontecido.
          // O texto é fixo de propósito: é ele que o roteador reconhece como
          // agendamento da IA, então não pode depender do que o LLM escrever.
          try {
            const quando = `${args.data.slice(8, 10)}/${args.data.slice(5, 7)} às ${args.hora}`;
            await kommo.createTask({
              leadId: args.leadId!,
              text:
                `ALERTA · ${unit.slug} · [Contato: ${leadAtual?.name ?? 'paciente'}] ` +
                `🤖 CONSULTA AGENDADA PELA I.A Sofia — ${quando}` +
                `${especialista ? ` com ${especialista}` : ''}. Confirmar com o paciente.`,
              completeAt: Math.floor(Date.now() / 1000) + 60 * 60,
            });
          } catch (err) {
            logger.warn({ err, leadId: args.leadId }, 'agenda: falha ao avisar o grupo — agendamento segue valendo');
          }
        })();
      }

      return `Consulta marcada para ${dataPorExtenso(args.data)} às ${args.hora}.${
        especialista ? ` Especialista: ${especialista}.` : ''
      } Confirme ao paciente com EXATAMENTE este dia da semana e data.`;
    },
  });
}

export function buildAgendaTools(ctx: Contexto): DynamicStructuredTool[] {
  if (!ctx.unit.spineEnabled) return [];
  return [
    buildConsultarHorarios(ctx),
    buildBuscarPaciente(ctx),
    buildCadastrarPaciente(ctx),
    buildAgendarConsulta(ctx),
    buildRemarcarConsulta(ctx),
    buildCancelarConsulta(ctx),
    buildConfirmarPresenca(ctx),
  ] as unknown as DynamicStructuredTool[];
}
