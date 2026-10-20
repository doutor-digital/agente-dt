/**
 * "Marcar consulta" de dentro do Kommo — o botão do widget para a unidade SEM Sofia.
 *
 * Pedido do João (29/09/2026): na unidade sem IA a recepção conversa no Kommo, para, abre a franquia
 * e redigita nome e telefone para cadastrar e marcar. É nessa redigitação que nascem "MARIANE
 * 29/07", "BETITA NETO", apelido e telefone sem DDD — em Taubaté, 143 de 165 cartões que a franquia
 * não reconhece pelo nome. Aqui a SDR escolhe o horário no próprio cartão e o sistema faz o que a
 * Sofia já faz: procura o paciente pelo telefone, cadastra se não existe, marca, e grava o vínculo.
 *
 * É o MESMO caminho das ferramentas `cadastrar_paciente`/`agendar_consulta` (agenda-tools.ts), com as
 * mesmas guardas — DDD, horário ainda livre, uma consulta por paciente, telefone que não bate = recusa —,
 * só que devolvendo DADO em vez de texto para a IA, e carimbando "Humano" em vez de "I.A Sofia". Não é IA:
 * nada aqui gasta token. Uma diferença de propósito (20/10/2026): aqui a SDR pode salvar só com o primeiro
 * nome (ver `validarNome`); a Sofia continua exigindo nome e sobrenome.
 *
 * A franquia continua sendo a verdade: a etapa do cartão é movida aqui por cortesia (a SDR acabou de
 * clicar e espera ver AGENDADO), mas é o sincronizador quem manda nos 15 minutos seguintes.
 */
import type { Unit } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { SpineService } from '../services/spine.service.js';
import { AgendaReconcileService } from '../services/agenda-reconcile.service.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import { esquemaDaUnidade } from './kommo-schema.js';
import { carregarFunis } from './franquia-sync-worker.js';
import { ETAPA } from './franquia-move.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import { consultaAtual, gradeDoDia, hojeLocal, telefoneDoLead, unidadeFresca } from '../agent/agenda-tools.js';
import { travaDaUnidadeDeAtendimento, type CodigoTrava } from './trava-unidade-atendimento.js';
import { contaDoKommo, unidadeDoCartao, unidadeParaOCartao } from './crm-compartilhado.js';
import { motivoAmbiguo, motivoInconclusivo, pacienteExistente } from './paciente-existente.js';

export type CodigoRecusa =
  | 'sem_franquia'
  /** nenhuma palavra com 2+ letras no nome */
  | 'sem_nome'
  /** só o primeiro nome e a franquia não deixou conferir se o paciente já existe (nome comum ou curto demais) */
  | 'sem_sobrenome'
  | 'telefone_incompleto'
  | 'telefone_nao_bate'
  | 'data_invalida'
  | 'agenda_indisponivel'
  | 'horario_invalido'
  | 'horario_ocupado'
  | 'ja_tem_consulta'
  | 'cadastro_falhou'
  | 'agenda_falhou'
  | 'lead_invalido'
  | 'lead_sem_telefone'
  | 'data_passada'
  | 'em_andamento'
  /** dois ou mais pacientes na franquia com o telefone do cartão, nenhum com o nome igual (review, 16/10) */
  | 'paciente_ambiguo'
  | CodigoTrava
  /** Kommo dividido (Petrópolis + Caxias): a ⌂ Unidade de atendimento do cartão está vazia */
  | 'sem_unidade'
  /** Kommo dividido: a unidade do cartão não tem franquia conectada aqui */
  | 'unidade_sem_franquia';

export interface Recusa {
  ok: false;
  codigo: CodigoRecusa;
  /** Frase pronta para a SDR ler, sem termo técnico. */
  motivo: string;
}

export interface Marcada {
  ok: true;
  idClient: number;
  idSchedule: number | null;
  /** `true` quando o paciente foi cadastrado agora; `false` quando já existia e foi reaproveitado. */
  novoCadastro: boolean;
  nome: string;
  data: string;
  hora: string;
  cartao: { movido: boolean; camposEmBranco: string[] };
  /** `false` quando a consulta ficou marcada na franquia mas o vínculo não gravou no banco — o sincronizador ainda casa pelo telefone, mas avise. */
  vinculoGravado: boolean;
  /** Recado para a SDR (o mesmo vai na nota do cartão) — hoje só quando o paciente novo entrou sem sobrenome. */
  aviso?: string;
}

export interface EntradaMarcacao {
  leadId: number;
  nome: string;
  telefone: string;
  /** AAAA-MM-DD */
  data: string;
  /** HH:mm no fuso da clínica */
  hora: string;
  cidade?: string | null;
  uf?: string | null;
  idCategory?: number | null;
  /** Nome de quem clicou, para o campo ☻ Responsável agendamento (só grava se for uma das opções). */
  responsavel?: string | null;
}

// ── validações puras (testáveis sem franquia nem Kommo) ────────────────────────────────────────

/**
 * Régua do WIDGET ("Marcar consulta" e "Só cadastrar"): basta o primeiro nome, com 2+ letras (pedido do João, 20/10/2026 —
 * a SDR às vezes só sabe o primeiro nome). `semSobrenome` diz a quem chama que é o caso, para o aviso no cartão.
 *
 * NÃO é a régua da Sofia: a dela (nome E sobrenome) mora em agenda-tools.ts (`buscar_paciente`, `cadastrar_paciente`) e
 * não mudou — ela não chama esta função. O que impede o cadastro em dobro com nome curto é a busca (`pacienteExistente`):
 * quem decide é o telefone, e "só o primeiro nome" que a busca não consegue conferir é recusado.
 */
export function validarNome(bruto: string): { ok: true; nome: string; semSobrenome: boolean } | Recusa {
  const nome = String(bruto ?? '').replace(/\s+/g, ' ').trim();
  const partes = nome.split(' ').filter((x) => (x.match(/\p{L}/gu) ?? []).length >= 2);
  if (partes.length === 0) return { ok: false, codigo: 'sem_nome', motivo: 'Falta o nome do paciente (pelo menos o primeiro nome).' };
  return { ok: true, nome, semSobrenome: partes.length < 2 };
}

/** O recado que fica no cartão quando o paciente entra na franquia só com o primeiro nome. */
export const AVISO_SEM_SOBRENOME = 'Salvo só com o primeiro nome — complete o sobrenome na franquia quando souber.';

/** Telefone com DDD, normalizado como a franquia guarda (55 + DDD + número). */
export function validarTelefone(bruto: string): { ok: true; fone: string } | Recusa {
  const fone = SpineService.normalizarWhatsapp(String(bruto ?? ''));
  if (!fone || fone.replace(/\D/g, '').length < 12) {
    return { ok: false, codigo: 'telefone_incompleto', motivo: 'Telefone incompleto. Precisa do DDD e do número inteiro.' };
  }
  return { ok: true, fone };
}

export function fim8(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : null;
}

export function validarDataHora(data: string, hora: string, hoje?: string): Recusa | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(`${data}T00:00:00`))) {
    return { ok: false, codigo: 'data_invalida', motivo: 'Data inválida.' };
  }
  if (hoje && data < hoje) return { ok: false, codigo: 'data_passada', motivo: 'Essa data já passou.' };
  if (!/^\d{2}:\d{2}$/.test(hora)) return { ok: false, codigo: 'horario_invalido', motivo: 'Horário inválido.' };
  return null;
}

// ── a grade que o widget mostra ────────────────────────────────────────────────────────────────

export interface DiaLivre {
  dia: string;
  livres: string[];
  erro: string | null;
}

/** Os horários livres de `dias` dias a partir de `de`, lidos da mesma grade que a Sofia oferece. */
export async function horariosParaWidget(unit: Unit, de: string, dias: number): Promise<DiaLivre[]> {
  const saida: DiaLivre[] = [];
  const inicio = new Date(`${de}T12:00:00`);
  for (let i = 0; i < Math.min(Math.max(dias, 1), 14); i++) {
    const d = new Date(inicio.getTime() + i * 86_400_000);
    const dia = d.toISOString().slice(0, 10);
    try {
      const { erro, slots } = await gradeDoDia(unit, dia);
      saida.push({ dia, livres: erro ? [] : slots.filter((s) => s.status === 'livre').map((s) => s.time), erro: erro ?? null });
    } catch (err) {
      saida.push({ dia, livres: [], erro: String(err).slice(0, 120) });
    }
  }
  return saida;
}

// ── a marcação ─────────────────────────────────────────────────────────────────────────────────

/**
 * Um cartão por vez. `consultaAtual` barra a SEGUNDA marcação depois que a primeira gravou o vínculo,
 * mas dois cliques quase juntos chegariam antes disso e criariam duas consultas (review, 29/09).
 */
// Exportado: o "Só cadastrar" (`cadastro-pelo-widget.ts`) usa o MESMO conjunto — "Marcar" e "Só cadastrar" clicados
// juntos no mesmo cartão também criariam o paciente duas vezes na franquia.
export const emAndamento = new Set<string>();

/** `opcoes.kommo` só existe para o teste trocar o cliente do Kommo; em produção ele nasce do token da unidade. */
export async function marcarPeloWidget(
  unitBase: Unit,
  entrada: EntradaMarcacao,
  opcoes: { kommo?: KommoClient } = {},
): Promise<Marcada | Recusa> {
  const chave = `${unitBase.id}:${entrada.leadId}`;
  if (emAndamento.has(chave)) {
    return { ok: false, codigo: 'em_andamento', motivo: 'Já estou marcando para este cartão. Aguarde a resposta.' };
  }
  emAndamento.add(chave);
  try {
    return await marcarInterno(unitBase, entrada, opcoes);
  } finally {
    emAndamento.delete(chave);
  }
}

async function marcarInterno(unitBase: Unit, entrada: EntradaMarcacao, opcoes: { kommo?: KommoClient }): Promise<Marcada | Recusa> {
  const t0 = Date.now();
  // A unidade pela qual o pedido chegou (onde o widget está instalado). Num Kommo dividido (Petrópolis + Caxias) a
  // franquia — token, agenda, vínculo — passa a ser a da ⌂ Unidade de atendimento do CARTÃO, logo abaixo.
  const unitDoPedido = (await unidadeFresca(unitBase.id)) ?? unitBase;
  let unit: Unit = unitDoPedido;
  const recorder = new TraceRecorder(randomUUID(), unitDoPedido.id);
  const passo = (kind: 'THINKING' | 'TOOL_RESULT' | 'ERROR' | 'KOMMO_ACTION', title: string, payload?: unknown) =>
    recorder.step({ kind, title, payload }).catch(() => undefined);
  const recusar = async (r: Recusa): Promise<Recusa> => {
    await passo('ERROR', `widget marcar RECUSADO (${r.codigo}): ${r.motivo}`, { ...entrada, telefone: '***' });
    await recorder.finalize({ status: 'FAILED', latencyMs: Date.now() - t0, iaDecision: `widget_marcar:${r.codigo}` }).catch(() => undefined);
    return r;
  };

  await passo('THINKING', `Recepção pediu marcação pelo widget: lead ${entrada.leadId}, ${entrada.data} ${entrada.hora}`, {
    leadId: entrada.leadId, data: entrada.data, hora: entrada.hora, responsavel: entrada.responsavel ?? null,
  });

  if (!unit.spineEnabled || !unit.spineToken) {
    return recusar({ ok: false, codigo: 'sem_franquia', motivo: 'A franquia não está conectada nesta unidade.' });
  }
  // Kommo da CONTA: a irmã de um Kommo dividido (Caxias) não tem credencial própria e usa o da dona.
  const contaKommo = await contaDoKommo(unitDoPedido);
  const kommo = opcoes.kommo ?? (contaKommo.kommoAccessToken ? createKommoClient(contaKommo) : undefined);
  // Conta com duas cidades e o token da franquia de uma só (Petrópolis × Caxias): cartão que não é da cidade da
  // franquia, ou sem cidade, não marca por aqui. Antes de tudo, para a SDR ler isto primeiro (14/10/2026).
  // Com a divisão gravada (unit_crm_compartilhado) esta trava sai do caminho e quem decide é `unidadeDoCartao`.
  const trava = await travaDaUnidadeDeAtendimento(unit, entrada.leadId, kommo);
  if (trava) return recusar({ ok: false, codigo: trava.codigo, motivo: trava.motivo });
  const vn = validarNome(entrada.nome);
  if (!vn.ok) return recusar(vn);
  const vt = validarTelefone(entrada.telefone);
  if (!vt.ok) return recusar(vt);
  const vd = validarDataHora(entrada.data, entrada.hora, hojeLocal(unit));
  if (vd) return recusar(vd);
  const { nome, semSobrenome } = vn;
  const { fone } = vt;

  // O telefone digitado tem de ser o do contato do cartão: senão a consulta vai parar no prontuário
  // de outra pessoa — a mesma recusa que a Sofia faz.
  let tituloDoCartao = '';
  if (kommo) {
    // O cartão tem de existir NESTA conta do Kommo e ter telefone. É o telefone que amarra a marcação à
    // pessoa certa; sem ele, qualquer número digitado viraria cadastro em nome de ninguém (review, 29/09).
    const lead = await kommo.getLead(entrada.leadId).catch(() => null);
    if (!lead) return recusar({ ok: false, codigo: 'lead_invalido', motivo: 'Este cartão não existe nesta conta do Kommo.' });
    tituloDoCartao = lead.name ?? '';
    // Kommo dividido (Petrópolis + Caxias): toda escrita na franquia segue a unidade do cartão (regra do João,
    // 14/10/2026). Campo vazio ou unidade sem franquia = recusa; cartão de Caxias = token, agenda e vínculo de Caxias.
    const dono = await unidadeDoCartao(unitDoPedido, lead);
    if (dono.tipo === 'recusa') return recusar({ ok: false, codigo: dono.codigo, motivo: dono.motivo });
    unit = dono.unit;
    if (dono.tipo === 'unidade') await passo('THINKING', `Conta dividida: o cartão é de ${dono.rotulo} — marcação na franquia de ${dono.rotulo}`, { unidade: unit.slug });
    const foneLead = await telefoneDoLead(kommo, entrada.leadId);
    if (!fim8(foneLead)) {
      return recusar({ ok: false, codigo: 'lead_sem_telefone', motivo: 'O contato deste cartão não tem telefone. Coloque o telefone no contato antes de marcar — é ele que liga o cartão ao paciente.' });
    }
    if (fim8(foneLead) !== fim8(fone)) {
      return recusar({
        ok: false, codigo: 'telefone_nao_bate',
        motivo: `O telefone digitado não é o do contato deste cartão (…${fim8(foneLead)}). Corrija o contato ou o número antes de marcar.`,
      });
    }
  }

  if (!kommo) {
    // sem Kommo não dá para ler a ⌂ Unidade de atendimento: numa conta dividida, nada é escrito
    const dono = await unidadeParaOCartao(unitDoPedido, entrada.leadId, async () => null);
    if (dono.tipo === 'recusa') return recusar({ ok: false, codigo: dono.codigo, motivo: dono.motivo });
  }

  // Horário: precisa existir na grade e estar livre. Nada é criado antes disto — cadastrar e depois
  // não conseguir marcar é o paciente fantasma que enche o sistema da clínica.
  const grade = await gradeDoDia(unit, entrada.data).catch((err) => ({ erro: String(err), slots: [] as const }));
  if (grade.erro) return recusar({ ok: false, codigo: 'agenda_indisponivel', motivo: `Não consegui ler a agenda da franquia agora (${grade.erro}). Tente de novo em instantes.` });
  const slot = grade.slots.find((s) => s.time === entrada.hora);
  if (!slot) return recusar({ ok: false, codigo: 'horario_invalido', motivo: `${entrada.hora} não é um horário de atendimento em ${entrada.data}.` });
  if (slot.status !== 'livre') return recusar({ ok: false, codigo: 'horario_ocupado', motivo: `${entrada.hora} não está mais livre (${slot.motivo ?? slot.status}). Escolha outro.` });

  const ja = await consultaAtual(unit, entrada.leadId).catch(() => null);
  if (ja) {
    return recusar({ ok: false, codigo: 'ja_tem_consulta', motivo: `Este paciente já tem consulta marcada (${String(ja.quando)}). Um paciente só pode ter uma — remarque na franquia se ele quer outro horário.` });
  }

  // Paciente: primeiro o que JÁ está ligado a este cartão (o "Só cadastrar" de ontem, a Sofia, o sincronizador);
  // depois a busca larga por nome decidida pelo telefone (`paciente-existente.ts`); só então cadastra (ou converte o
  // lead que o espelho já criou na franquia). Busca que falha ou telefone com dois pacientes = recusa, nunca um
  // cadastro novo no escuro (review, 16/10). Origem = a padrão da unidade, não "IA SOFIA": foi gente que marcou.
  let idClient: number | null = null;
  let novoCadastro = false;
  const vinculo = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: entrada.leadId } });
  const achado = vinculo?.spineIdClient ? null : await pacienteExistente(unit, nome, tituloDoCartao, fone, { soPrimeiroNome: semSobrenome });
  if (vinculo?.spineIdClient) {
    idClient = vinculo.spineIdClient;
    await passo('TOOL_RESULT', `Paciente já ligado a este cartão: ${vinculo.nome ?? '?'} (idClient ${idClient})`);
  } else if (achado?.tipo === 'sem_resposta') {
    return recusar({ ok: false, codigo: 'cadastro_falhou', motivo: 'A franquia não respondeu a todas as buscas do paciente. Nada foi marcado — tente de novo em instantes.' });
  } else if (achado?.tipo === 'inconclusivo') {
    return recusar({ ok: false, codigo: 'sem_sobrenome', motivo: motivoInconclusivo('marcado') });
  } else if (achado?.tipo === 'ambiguo') {
    return recusar({ ok: false, codigo: 'paciente_ambiguo', motivo: motivoAmbiguo(achado.candidatos, 'marcado') });
  } else if (achado?.tipo === 'achou') {
    idClient = achado.idClient;
    await passo('TOOL_RESULT', `Paciente já existia na franquia: ${achado.nome ?? '?'} (idClient ${idClient})`);
  } else {
    if (vinculo?.spineIdLead) {
      const c = await SpineService.convertLead(unit, { idLead: vinculo.spineIdLead, name: nome, idSource: unit.spineDefaultSourceId, whatsapp: fone });
      if (c.ok && c.data?.idClient) { idClient = c.data.idClient; novoCadastro = true; }
    }
    if (idClient === null) {
      const r = await SpineService.createClient(unit, {
        name: nome, whatsapp: fone, idSource: unit.spineDefaultSourceId, idLead: vinculo?.spineIdLead ?? null,
        addressCity: entrada.cidade?.trim().toUpperCase() || null, addressUf: SpineService.resolverUf(entrada.uf ?? null),
      });
      if (!r.ok || !r.data?.idClient) {
        return recusar({ ok: false, codigo: 'cadastro_falhou', motivo: `A franquia não aceitou o cadastro (${r.error ?? 'sem detalhe'}). Nada foi marcado.` });
      }
      idClient = r.data.idClient; novoCadastro = true;
    }
    await passo('TOOL_RESULT', `Paciente ${novoCadastro ? 'cadastrado' : 'convertido'} na franquia: ${nome} (idClient ${idClient})`);
  }
  // Logicamente inalcançável (todo ramo acima preenche ou recusa), mas é o que deixa o tipo honesto
  // daqui para baixo — inclusive dentro dos closures dos carimbos, onde o TS não estreita `let`.
  if (idClient === null) return recusar({ ok: false, codigo: 'cadastro_falhou', motivo: 'Não consegui obter o cadastro do paciente. Nada foi marcado.' });
  const idPaciente: number = idClient;
  // paciente que JÁ existia fica com o nome que a franquia tem; o aviso é só para o cadastro feito agora
  const aviso = novoCadastro && semSobrenome ? AVISO_SEM_SOBRENOME : undefined;

  const marc = await SpineService.createSchedule(unit, { idClient: idPaciente, dateAttendanceLocal: `${entrada.data}T${entrada.hora}:00`, idCategory: entrada.idCategory ?? 1 });
  if (!marc.ok) {
    return recusar({ ok: false, codigo: 'agenda_falhou', motivo: `A franquia não marcou (${marc.error ?? 'sem detalhe'}). ${novoCadastro ? 'O cadastro ficou feito; ' : ''}tente outro horário.` });
  }
  const idSchedule = marc.data?.idSchedule ?? null;
  await passo('TOOL_RESULT', `Consulta marcada na franquia: ${entrada.data} ${entrada.hora} (idSchedule ${idSchedule})`);

  // O vínculo é o que faz o sincronizador seguir este paciente pelo id, e não pelo nome, para sempre.
  let vinculoGravado = true;
  await prisma.spineLeadLink
    .upsert({
      where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: entrada.leadId } },
      update: { spineIdClient: idPaciente, spineIdSchedule: idSchedule, agendadoPara: `${entrada.data}T${entrada.hora}`, nome, status: 'ok' },
      create: { unitId: unit.id, kommoLeadId: entrada.leadId, spineIdClient: idPaciente, spineIdSchedule: idSchedule, agendadoPara: `${entrada.data}T${entrada.hora}`, nome, status: 'ok' },
    })
    .catch((err) => { vinculoGravado = false; logger.warn({ err: String(err), unit: unit.slug, leadId: entrada.leadId }, 'widget marcar: falha ao gravar vínculo'); });
  AgendaReconcileService.esqueceConsulta(unit.id, entrada.leadId);

  // Cartão: os mesmos carimbos da Sofia, mas "Humano"; mais os ids da franquia e a etapa.
  const cartao = { movido: false, camposEmBranco: [] as string[] };
  if (kommo) {
    try {
      const esquema = await esquemaDaUnidade(contaKommo, kommo); // os campos são da CONTA do Kommo
      const idDe = (n: string) => esquema.campoPorNome(n);
      const agora = Math.floor(Date.now() / 1000);
      const carimbos: Array<[string, (id: number) => Promise<unknown>]> = [
        ['✓ Agendou', (id) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'select', 'Sim')],
        ['◷ Agendado pela SDR em', (id) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'date', agora)],
        ['⬢ Agendamento feito por', (id) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'select', 'Humano')],
        ['◷ Data da Consulta', (id) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'date', `${entrada.data}T${entrada.hora}:00`)],
        ['✓ Situação da consulta', (id) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'select', 'Agendado')],
        ['⚙ idClient (franquia)', (id) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'numeric', idPaciente)],
        ...(idSchedule ? [['⚙ idSchedule (franquia)', (id: number) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'numeric', idSchedule)] as [string, (id: number) => Promise<unknown>]] : []),
        ...(entrada.responsavel ? [['☻ Responsável agendamento', (id: number) => kommo.setLeadCustomFieldValue(entrada.leadId, id, 'select', String(entrada.responsavel).trim().toUpperCase())] as [string, (id: number) => Promise<unknown>]] : []),
      ];
      for (const [campo, fn] of carimbos) {
        const id = idDe(campo);
        if (id === null) { cartao.camposEmBranco.push(campo); continue; }
        await fn(id).catch(() => cartao.camposEmBranco.push(campo));
      }
      const funis = await carregarFunis(kommo);
      const alvo = funis?.idDe('COMERCIAL', ETAPA.AGENDADO);
      if (alvo) {
        await kommo.moveStage({ leadId: entrada.leadId, statusId: alvo.statusId, pipelineId: alvo.pipelineId });
        cartao.movido = true;
      }
      await kommo.addLeadNote(entrada.leadId, `Consulta marcada pela recepção, pelo widget: ${entrada.data} ${entrada.hora}${novoCadastro ? ' (paciente cadastrado agora)' : ''}.${aviso ? ` ${aviso}` : ''}`).catch(() => null);
      await passo('KOMMO_ACTION', `Cartão carimbado${cartao.movido ? ' e movido para AGENDADO' : ''}${cartao.camposEmBranco.length ? ` — em branco: ${cartao.camposEmBranco.join(', ')}` : ''}`, cartao);
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: entrada.leadId }, 'widget marcar: falha ao carimbar o cartão (a consulta ESTÁ marcada na franquia)');
      await passo('ERROR', 'Consulta marcada na franquia, mas não consegui carimbar o cartão — o sincronizador completa em até 15 min', { err: String(err) });
    }
  }

  await recorder.finalize({ status: 'SUCCESS', latencyMs: Date.now() - t0, iaDecision: 'widget_marcar' }).catch(() => undefined);
  logger.info({ unit: unit.slug, leadId: entrada.leadId, idClient: idPaciente, idSchedule, novoCadastro }, 'widget marcar: consulta marcada pela recepção');
  return { ok: true, idClient: idPaciente, idSchedule, novoCadastro, nome, data: entrada.data, hora: entrada.hora, cartao, vinculoGravado, ...(aviso ? { aviso } : {}) };
}
