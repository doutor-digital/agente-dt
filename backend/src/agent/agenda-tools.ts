// ============================================================================
// agenda-tools.ts — Tools de agendamento (API Spine da franquia).
//
// ONDE O GUARD REALMENTE MORA
// ---------------------------
// De nada adianta a recepção bloquear um horário na tela se o agente não
// consultar esse bloqueio na hora de marcar. Por isso a checagem NÃO está no
// prompt — instrução em prompt é sugestão, e o modelo pode contorná-la sob
// pressão do paciente. Está aqui, no código da tool: pausado ou bloqueado, a
// tool recusa e devolve o motivo. Não há caminho ao redor.
//
// REVALIDAÇÃO NA ESCRITA, e não só na oferta
// ------------------------------------------
// `consultar_horarios` e `agendar_consulta` refazem a mesma checagem. Parece
// redundante e não é: entre a IA oferecer 14h e o paciente responder "pode
// ser", passam minutos — tempo de sobra pra recepção bloquear aquele horário
// ou outro paciente marcar. Confiar na consulta anterior é confiar num dado
// vencido, e o preço é duas pessoas na mesma cadeira.
// ============================================================================

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { TraceRecorder } from './trace-recorder.js';
import type { KommoClient } from '../services/kommo.service.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaService } from '../services/agenda.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';

const TZ_PADRAO = 'America/Sao_Paulo';

function agoraLocal(unit: Unit): string {
  return SpineService.instanteNoFuso(new Date(), unit.spineTimezone || TZ_PADRAO);
}

/** Recarrega a unidade do banco — pausa e bloqueios mudam DURANTE a conversa. */
async function unidadeFresca(unitId: string): Promise<Unit | null> {
  return prisma.unit.findUnique({ where: { id: unitId } });
}

interface Contexto {
  unit: Unit;
  recorder: TraceRecorder;
  /** Opcional: sem ele o agendamento funciona, só não carimba o CRM. */
  kommo?: KommoClient;
}

/**
 * Campos do Kommo que registram o agendamento.
 *
 * Preenchidos PELA TOOL, não por regra de captura. A diferença importa: regra
 * de captura depende de a I.A. decidir chamá-la, e "esqueci de marcar Agendou"
 * é invisível — some numa estatística que ninguém confere. Aqui, se a consulta
 * foi marcada, o campo é escrito no mesmo passo. Não há caminho em que uma
 * coisa aconteça sem a outra.
 */
const CAMPO_AGENDOU = 2442703;      // ✓ Agendou (select Sim/Não)
const CAMPO_DATA_AGENDAMENTO = 2440909; // ◷ Data de agendamento (date_time)

// ---------------------------------------------------------------------------
// Grade de um dia, já com tudo subtraído.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// consultar_horarios
// ---------------------------------------------------------------------------

/**
 * PERGUNTA À FRANQUIA se o horário aceita mesmo, em vez de deduzir.
 *
 * A dedução ("não tem ninguém marcado, logo está livre") erra porque não
 * enxergamos o TURNO da profissional. Medido em produção numa quarta: 08:00 e
 * 10:00 aceitos, 11:00 e 16:00 recusados — sem ninguém marcado em nenhum dos
 * dois. A API não expõe disponibilidade; o único jeito de saber é tentar.
 *
 * Tentar é seguro porque agendamento É a única escrita nossa que a franquia
 * desfaz (DELETE /api/schedules). Cria e cancela na mesma volta.
 *
 * Custa duas chamadas por horário, então valida poucos — quem oferece dez
 * horários não converte mais que quem oferece três.
 */
const MAX_VALIDACOES = 4;

/**
 * ESPALHA os candidatos pelo dia em vez de pegar os primeiros da fila.
 *
 * O que a recusa da franquia significa é "fora do turno da profissional", e
 * turno é um bloco contínuo de horas. Sondar os quatro PRIMEIROS livres testa
 * quatro horas coladas — se o turno dela for de tarde, os quatro dão recusa e
 * a tarde inteira fica invisível.
 *
 * Medido num caso real: livres [13,14,15,16,17], sondados os quatro primeiros,
 * todos recusados. Espalhando, o 17:00 entra na amostra e o dia se resolve numa
 * consulta só — em vez de virar duas desculpas na cara do paciente.
 */
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
      // Cancela IMEDIATAMENTE. Se este cancelamento falhar, sobra um
      // agendamento fantasma na agenda da clínica — por isso o log é warn e
      // carrega o id: é o que a recepção leva pra remover lá.
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

/**
 * Paciente usado só para sondar. Qualquer cliente da unidade serve — o
 * agendamento é desfeito em seguida e nunca chega a existir de verdade.
 */
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

export function buildConsultarHorarios({ unit, recorder }: Contexto) {
  return new DynamicStructuredTool({
    name: 'consultar_horarios',
    description:
      'Consulta os horários REALMENTE disponíveis da clínica numa data. Já desconta ' +
      'consultas marcadas, almoço, dias sem atendimento e os bloqueios da recepção, ' +
      'e ainda CONFIRMA com o sistema da clínica antes de devolver. Use SEMPRE ' +
      'antes de oferecer qualquer horário ao paciente — nunca invente nem repita ' +
      'horário de uma consulta anterior. Devolve só o que está livre: já desconta ' +
      'consultas marcadas, almoço, dias sem atendimento e bloqueios da recepção.',
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

      const { erro, slots } = await gradeDoDia(fresca, data);
      if (erro) {
        logger.warn({ erro, data, unit: fresca.slug }, 'consultar_horarios: agenda indisponível');
        return `Não consegui consultar a agenda agora (${erro}). NÃO ofereça horários; diga que a equipe confirma em seguida.`;
      }

      const todosLivres = slots.filter((s) => s.status === 'livre').map((s) => s.time);

      // O TURNO ENTRA ANTES DA VERIFICAÇÃO, não depois. Verificar custa duas
      // chamadas por horário e o orçamento é pequeno; gastá-lo de manhã quando
      // o paciente pediu tarde devolve uma lista vazia de horários que ele nem
      // queria — e é assim que a conversa morre.
      // O TURNO PEDIDO É RESPEITADO, mesmo quando não sobra nada nele.
      //
      // Antes, turno vazio caía em `todosLivres` — o paciente pedia manhã e a
      // sondagem ia gastar o orçamento na tarde. Foi assim que um paciente que
      // pediu manhã recebeu duas ofertas de 17:00, num dia em que a clínica
      // fechava 12:30. Devolver "não tem de manhã" deixa a I.A. perguntar se
      // ele aceita outro período, que é uma conversa honesta.
      const livres = turno
        ? todosLivres.filter((h) => (turno === 'manha' ? h < '12:00' : h >= '12:00'))
        : todosLivres;

      // A grade é só a PRIMEIRA peneira: ela desconta quem já está marcado,
      // almoço e bloqueio da recepção. O que ela não sabe é o turno da
      // profissional — e é aí que a franquia recusa. Confirma com ela.
      const sonda = await clienteDeSondagem(fresca);
      let oferecer = livres;
      let recusados: string[] = [];
      let sondados: string[] = [];
      let verificado = false;

      if (sonda && livres.length > 0) {
        const r = await horariosQueAFranquiaAceita(fresca, data, livres, sonda);
        recusados = r.recusados;
        sondados = r.sondados;
        verificado = true;
        // SÓ O QUE A FRANQUIA ACEITOU. Nada de cair nos não sondados.
        //
        // Era o que fazia antes, e o preço foi medido num paciente: quatro
        // horários sondados, os quatro recusados, e o código ofereceu o quinto
        // — o único que ele nunca testou — em dois dias seguidos. O paciente
        // aceitou os dois e levou duas vezes "esse horário acabou de ser
        // preenchido". O sinal de que o turno inteiro estava fora da escala
        // estava dado nas quatro recusas; oferecer o resto foi ignorá-lo.
        //
        // Lista vazia é uma resposta honesta. Duas desculpas seguidas não.
        oferecer = r.aceitos;
      } else if (livres.length > 0) {
        // Sem paciente de sondagem não há como confirmar com a franquia. A
        // grade sozinha não enxerga o turno da profissional, então o que sai
        // daqui é aposta — registrada como tal pra não sumir num "deu certo".
        logger.warn(
          { unit: fresca.slug, data, livres: livres.length },
          'consultar_horarios: sem paciente de sondagem — horários NÃO confirmados com a franquia',
        );
      }

      await recorder.step({
        kind: 'TOOL_RESULT',
        title:
          `consultar_horarios ${data}${turno ? ` (${turno})` : ''}: ` +
          `${oferecer.length} confirmado(s) de ${livres.length} livre(s) na grade` +
          (verificado ? '' : ' — SEM verificação'),
        payload: { data, turno, naGrade: todosLivres, noTurno: livres, sondados, oferecer, recusados, sonda },
      });

      if (oferecer.length === 0) {
        // Recusa em tudo que foi sondado é sinal de turno fechado, não de dia
        // cheio. A diferença importa pro que a I.A. diz ao paciente: "a agenda
        // dessa data não abriu" em vez de "está tudo ocupado".
        const turnoFechado = verificado && recusados.length > 0;
        return (
          (turnoFechado
            ? `A clínica não está aceitando agendamento em ${data}${turno === 'manha' ? ' de manhã' : turno === 'tarde' ? ' à tarde' : ''} — a agenda desse período não está aberta.`
            : `Nenhum horário livre em ${data}${turno === 'manha' ? ' de manhã' : turno === 'tarde' ? ' à tarde' : ''}.`) +
          ' ' +
          (turno && todosLivres.length > 0
            ? 'No outro turno ainda pode haver vaga — pergunte se ele aceita. '
            : '') +
          'Ofereça outra data — NÃO insista nesta e NÃO cite horário nenhum deste dia.'
        );
      }
      return (
        `Horários CONFIRMADOS com a clínica em ${data}: ${oferecer.join(', ')}. ` +
        'Ofereça no máximo 2 ou 3 deles. Não ofereça nenhum horário fora desta lista.'
      );
    },
  });
}

// ---------------------------------------------------------------------------
// buscar_paciente
// ---------------------------------------------------------------------------

/**
 * Últimos 8 dígitos — é o que dá pra comparar com segurança entre as duas
 * pontas. O WhatsApp entrega o número do Brasil sem o nono dígito (o `wa_id`
 * de "+55 99 99150-7569" chega como "+559991507569"), então casar o número
 * inteiro reprovaria a mesma pessoa. Os 8 finais sobrevivem a isso.
 */
function fim8(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

/** Telefone do paciente pelo lead do Kommo — mora no CONTATO, não no lead. */
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

// ---------------------------------------------------------------------------
// buscar_paciente
//
// POR QUE ESTA TOOL RECUSA MAIS DO QUE ACHA
// -----------------------------------------
// A busca da franquia casa por PEDAÇO do nome. Procurar "Keyla" devolve
// "KEYLA DA SILVA LIMA KOMATSU" — outra pessoa, cadastrada em 2024, com outro
// telefone. Foi o que aconteceu: a consulta de uma paciente nova foi marcada
// no prontuário de uma xará. Ninguém percebeu porque, do lado de fora, deu
// tudo certo — a IA achou "a paciente", confirmou o horário, e a agenda da
// clínica passou a esperar a pessoa errada.
//
// Dois erros possíveis, de tamanhos MUITO diferentes:
//   - usar o cadastro de um xará → prontuário trocado, consulta no nome de
//     outra pessoa, e a paciente de verdade não é esperada. Sem desfazer.
//   - criar um cadastro a mais → uma linha duplicada que a recepção junta.
// O primeiro é incidente clínico, o segundo é bagunça. Na dúvida, o segundo.
//
// Por isso o telefone MANDA: é a única coisa que distingue xará de paciente.
// Sem ele, nenhum idClient sai daqui.
// ---------------------------------------------------------------------------

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

      // GUARD 1 — sobrenome. A mesma régua do cadastrar_paciente, que já
      // recusa cadastro sem sobrenome. Antes valia só na escrita; o buraco
      // estava na leitura, que é justamente onde o xará entra.
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

      // GUARD 2 — telefone. O que a IA passou, ou o do contato no Kommo.
      const foneInformado = args.telefone ? SpineService.normalizarWhatsapp(args.telefone) : null;
      const fone = foneInformado ?? (await telefoneDoLead(kommo, args.leadId));
      const alvo = fim8(fone);
      const batem = alvo ? achados.filter((c) => fim8(c.whatsapp) === alvo) : [];

      await recorder.step({
        kind: 'TOOL_RESULT',
        title: `buscar_paciente "${args.nome}": ${achados.length} achado(s), ${batem.length} com telefone batendo`,
        payload: { nome: args.nome, achados, telefoneConferido: fone, batem },
      });

      // Sem telefone nenhum pra comparar: não devolve idClient. Entregar o
      // cadastro aqui é apostar que não há xará — e foi exatamente essa aposta
      // que pôs a consulta no prontuário errado.
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

      // Um só bate: é ele, sem ambiguidade. Guarda o vínculo. Com mais de um,
      // não dá pra escolher por nós — quem decide é a I.A. com o paciente.
      if (batem.length === 1) await guardarPaciente(fresca.id, args.leadId, batem[0].idClient);

      return (
        `Confirmado pelo telefone: ${batem
          .map((c) => `idClient ${c.idClient} — ${c.name}`)
          .join(' | ')}. Use este idClient em agendar_consulta.`
      );
    },
  });
}

// ---------------------------------------------------------------------------
// cadastrar_paciente
//
// O ELO QUE FALTAVA. POST /api/schedules exige idClient — sem paciente não
// existe agendamento. Antes, quando a busca não achava ninguém, a IA parava e
// passava pra equipe; agora ela conclui o cadastro e segue.
//
// As recusas são as mesmas do painel, e ficam AQUI, não no prompt: prompt é
// instrução, e instrução se contorna. A franquia não apaga paciente, então o
// que não pode acontecer não pode depender de o modelo lembrar.
// ---------------------------------------------------------------------------

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
    }),
    func: async (args: {
      nome: string;
      telefone: string;
      cidade?: string;
      uf?: string;
      leadId?: number;
    }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;
      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Sistema da clínica não conectado. Transfira para a equipe.';
      }

      // "Nome Completo" é o nome do campo lá. Só o primeiro nome vira cadastro
      // que a recepção não distingue dos outros — e não sai mais.
      const partes = args.nome.trim().split(/\s+/).filter((x) => x.length >= 2);
      if (partes.length < 2) {
        return 'RECUSADO: falta o sobrenome. Pergunte o nome completo antes de cadastrar.';
      }

      const fone = SpineService.normalizarWhatsapp(args.telefone);
      if (!fone || fone.replace(/\D/g, '').length < 12) {
        return 'RECUSADO: telefone incompleto. Peça o número com DDD.';
      }

      // Já existe? Cadastrar de novo cria duplicata permanente.
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

      // CONVERTER, NÃO CRIAR DO ZERO.
      //
      // Quando o lead já foi espelhado na franquia, criar um paciente novo
      // deixa DUAS fichas da mesma pessoa, sem nada ligando uma à outra — e
      // com nomes diferentes, porque o lead foi espelhado com o nome parcial
      // que a I.A. tinha no minuto (o primeiro nome) e o paciente nasce com o
      // nome completo. Quem procura por um não acha o outro.
      //
      // /api/leads/convert transforma a MESMA ficha em paciente. Uma pessoa,
      // um cadastro, já com o nome completo.
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
          // CAI PARA A CRIAÇÃO. Duas fichas é ruim; paciente sem cadastro
          // nenhum, na hora de fechar o agendamento, é pior — perde a
          // consulta. O log marca pra dar pra ver se a conversão vive.
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

// ---------------------------------------------------------------------------
// cancelar_consulta e remarcar_consulta
//
// A CONFIRMAÇÃO MORA NA TOOL, não no prompt.
//
// Cancelar é destrutivo do ponto de vista do paciente: ele perde a vaga e
// alguém pode pegá-la em seguida. Uma instrução no prompt ("pergunte antes")
// depende de o modelo lembrar no meio de uma conversa longa. Aqui a tool
// simplesmente RECUSA sem `confirmado: true` e devolve a pergunta pronta — o
// caminho errado deixa de existir em vez de ficar desaconselhado.
//
// Um lead tem no máximo UMA consulta. Por isso agendar recusa quem já tem, e
// remarcar existe: ele MARCA A NOVA PRIMEIRO e só então cancela a antiga. Na
// ordem inversa, uma falha no meio deixaria o paciente sem consulta nenhuma —
// e a vaga antiga já teria sido devolvida pra fila.
// ---------------------------------------------------------------------------

/**
 * A consulta do lead, CONFERIDA na franquia — não a lembrança do nosso banco.
 *
 * A recepção remarca pelo sistema dela e nunca passa por aqui. Decidir com o
 * valor salvo faz o cancelamento mirar um horário que não existe mais e faz a
 * IA repetir ao paciente uma hora que já mudou.
 */
async function consultaAtual(unit: Unit, leadId: number | undefined) {
  const c = await AgendaReconcileService.consultaDoLead(unit, leadId);
  if (!c || !c.idSchedule || c.estado === 'cancelada') return null;
  return { idSchedule: c.idSchedule, quando: c.quando, confirmada: c.estado === 'confirmada' };
}

const porExtenso = AgendaReconcileService.porExtenso;

/**
 * Guarda QUEM é o paciente deste lead na franquia.
 *
 * Ficava perdido: a tool criava o cadastro, devolvia o idClient para a I.A. e
 * não escrevia em lugar nenhum. Sem isto o painel mostra lead sem paciente, e
 * a releitura do agendamento precisa varrer a agenda por data em vez de
 * perguntar direto pela ficha dele.
 */
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

      // Não confirmei o horário na franquia agora. Perguntar "quer cancelar a
      // de 08:00?" quando a recepção já mudou pra 09:30 faz o paciente
      // desmentir a IA — ou pior, concordar com a coisa errada.
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

// ---------------------------------------------------------------------------
// confirmar_presenca
//
// O par do lembrete. Sem isto, "confirmo" morria na conversa: a franquia
// seguia vendo AGENDADO e a recepção ligava pra confirmar o que já estava
// confirmado. O registro tem que ser do lado DELES pra parar a ligação.
//
// Não pede confirmação em dois passos, ao contrário de cancelar: confirmar de
// novo não tira a vaga de ninguém, e o pior caso é um PATCH repetido.
// ---------------------------------------------------------------------------

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
      // Confirmar um horário que eu não consegui conferir é prometer ao
      // paciente que está tudo certo para uma hora que pode ter mudado.
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

      // MARCA A NOVA PRIMEIRO. Se cancelasse antes e a nova falhasse, o
      // paciente ficaria sem consulta e a vaga antiga já teria ido embora.
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

// ---------------------------------------------------------------------------
// agendar_consulta
// ---------------------------------------------------------------------------

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
    }),
    func: async (args: {
      idClient: number;
      remarcando?: boolean;
      data: string;
      hora: string;
      idCategory?: number;
      leadId?: number;
    }) => {
      const fresca = (await unidadeFresca(unit.id)) ?? unit;

      if (!fresca.spineEnabled || !fresca.spineToken) {
        return 'Agenda não conectada. NÃO confirme nada — diga que a equipe conclui o agendamento.';
      }

      // GUARD 1 — pausa. Relido do banco AGORA, não do começo da conversa.
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

      // GUARD 2 — o horário ainda está livre? Revalidado na hora da escrita,
      // porque entre a oferta e o "pode ser" do paciente passam minutos.
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

      // UMA CONSULTA POR LEAD. Sem isto, o paciente que pede outro horário
      // acaba com duas vagas ocupadas — e a clínica descobre no dia. Remarcar
      // passa por aqui de propósito, com a flag, porque ele já cancela a
      // antiga logo depois.
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

      // GUARD 3 — o idClient é mesmo deste paciente?
      //
      // As travas do buscar_paciente impedem que a I.A. RECEBA um idClient não
      // verificado, mas não impediam que ela PASSASSE um. Aqui a conferência é
      // contra a franquia: quem é esse cadastro, e o telefone dele bate com o
      // WhatsApp de quem está conversando? Foi assim que a consulta de uma
      // paciente nova acabou no prontuário de uma xará de 2024.
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
      // Falha de rede não vira recusa: bloquear aqui por indisponibilidade
      // deles custaria agendamentos legítimos. Só a resposta EXPLÍCITA de
      // "não existe" ou de telefone divergente barra.
      const paciente = conf.ok ? conf.data?.client ?? null : null;
      if (paciente) {
        const foneLead = await telefoneDoLead(kommo, args.leadId);
        const a = fim8(foneLead);
        const b = fim8(paciente.whatsapp);
        if (a && b && a !== b) {
          await recorder.step({
            kind: 'ERROR',
            title: `agendar_consulta recusado — idClient ${args.idClient} é de outra pessoa`,
            payload: { ...args, cadastro: paciente.name, foneCadastro: paciente.whatsapp, foneLead },
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
        // PARE de propósito. Uma recusa costuma significar que o horário saiu
        // da grade da profissional, e tentar o vizinho leva a mesma recusa —
        // foi assim que um turno queimou o limite de passos do grafo e o
        // paciente ficou SEM RESPOSTA NENHUMA, que é pior que um "não" claro.
        return (
          `Não consegui marcar às ${args.hora} (${r.error}). ` +
          'PARE AQUI: não chame agendar_consulta de novo neste turno e não tente ' +
          'outro horário agora. Responda ao paciente pedindo desculpas em UMA ' +
          'frase, sem termo técnico, diga que vai confirmar a melhor opção e ' +
          'que retorna em instantes. No próximo turno você consulta de novo.'
        );
      }

      // LÊ DE VOLTA quem ficou com o atendimento, em vez de assumir. A
      // franquia é quem escolhe o profissional (não mandamos idStaff), então
      // o nome só é confiável depois de perguntar a ela. Se a leitura falhar,
      // fica vazio e a IA omite a linha — melhor que anunciar o especialista
      // errado a quem vai atravessar a cidade pra consulta.
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

      // Guarda QUAL é a consulta deste lead. É o que permite depois cancelar
      // e remarcar sem casar por nome — a busca da franquia não devolve
      // idClient, e cancelar a consulta de um homônimo não tem desfazer.
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

      // Carimba o CRM no MESMO passo. Fire-and-forget porque falhar aqui não
      // desfaz o agendamento — a consulta está marcada na franquia, e voltar
      // erro faria a I.A. dizer ao paciente que não marcou, o que seria falso.
      if (kommo && args.leadId) {
        void (async () => {
          try {
            await kommo.setLeadCustomFieldValue(args.leadId!, CAMPO_AGENDOU, 'select', 'Sim');
            await kommo.setLeadCustomFieldValue(
              args.leadId!,
              CAMPO_DATA_AGENDAMENTO,
              'date',
              `${args.data}T${args.hora}:00`,
            );
            await recorder.step({
              kind: 'KOMMO_ACTION',
              title: 'Campos de agendamento preenchidos (Agendou, Data de agendamento)',
              payload: { leadId: args.leadId, data: args.data, hora: args.hora },
            });
          } catch (err) {
            logger.warn({ err, leadId: args.leadId }, 'agenda: falha ao carimbar campos no Kommo');
          }
        })();
      }

      return `Consulta marcada para ${args.data} às ${args.hora}.${
        especialista ? ` Especialista: ${especialista}.` : ''
      } Confirme ao paciente com dia e hora.`;
    },
  });
}

/** Só entram quando a unidade tem a agenda conectada. */
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
