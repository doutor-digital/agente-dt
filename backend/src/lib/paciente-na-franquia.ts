/**
 * O que a franquia sabe do paciente de um cartão: consulta marcada, última consulta, sessões e tratamento
 * em andamento. SÓ LEITURA — nada aqui escreve na franquia nem no Kommo.
 *
 * Saiu de `widgetPacienteHandler` (widget do cartão no Kommo) para ser a mesma resposta na extensão Ponte
 * do WhatsApp Web: dois lugares mostrando a agenda, uma regra só de qual cadastro é o paciente.
 *
 * Como casa o paciente: 1) `leadId` → vínculo `spine_lead_links` (o que a Sofia gravou);
 * 2) `nome`/`titulo` → busca por nome na franquia e confere os 8 últimos dígitos do `telefone`.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { SpineService, type SpineTreatment } from '../services/spine.service.js';
import { limparNome, resumoDaAgenda, termosDeBusca, type ResumoAgenda } from './widget-agenda.js';
import { chaveTelefone, normalizar } from './franquia-sync.js';
import { unidadeParaOCartao } from './crm-compartilhado.js';
import { estadoCasamentoJornada } from './casamento-jornada.js';
import { escolhaDaSdr } from './conflito-paciente.js';

// ── tratamentos EM ANDAMENTO: a rota da franquia devolve a unidade inteira; guarda 5 min por unidade ──
const cacheTratamentos = new Map<string, { em: number; lista: SpineTreatment[] }>();
async function tratamentosDaUnidade(unit: Unit): Promise<SpineTreatment[]> {
  const c = cacheTratamentos.get(unit.id);
  if (c && Date.now() - c.em < 5 * 60_000) return c.lista;
  const r = await SpineService.searchTreatments(unit);
  const lista = r.ok ? (r.data?.treatments ?? []) : c?.lista ?? [];
  cacheTratamentos.set(unit.id, { em: Date.now(), lista });
  return lista;
}

interface PacienteAchado {
  idClient: number;
  origem: 'vinculo' | 'nome+telefone' | 'nome' | 'escolha';
}

async function porVinculo(unit: Unit, leadId: number | null): Promise<PacienteAchado | null> {
  if (!leadId) return null;
  const link = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, orderBy: { updatedAt: 'desc' } });
  return link?.spineIdClient ? { idClient: link.spineIdClient, origem: 'vinculo' } : null;
}

async function porNomeETelefone(unit: Unit, titulo: string, nome: string, telefone: string): Promise<PacienteAchado | null> {
  const chave = chaveTelefone(telefone);
  const termos = termosDeBusca(titulo, nome);
  if (!termos.length) return null;
  const alvoNomes = new Set([normalizar(limparNome(titulo)), normalizar(limparNome(nome))].filter(Boolean));
  let porNomeExato: PacienteAchado | null = null;
  for (const termo of termos) {
    // até 100 por página: "Sandra" sozinho passa fácil de 20 pacientes, e ela ficava de fora (caso real, 16/09)
    const r = await SpineService.searchClients(unit, termo, 100);
    if (!r.ok) continue;
    const lista = (r.data?.clients ?? []).filter((c) => c.idClient);
    if (chave) {
      const casam = lista.filter((c) => c.whatsapp && chaveTelefone(c.whatsapp) === chave);
      if (casam.length === 1) return { idClient: casam[0].idClient!, origem: 'nome+telefone' };
      if (casam.length > 1) {
        const exato = casam.find((c) => alvoNomes.has(normalizar(c.name)));
        return { idClient: (exato ?? casam[0]).idClient!, origem: 'nome+telefone' };
      }
    }
    // sem telefone que case: aceita só se o nome completo bater exatamente e for um só
    if (!porNomeExato) {
      const exatos = lista.filter((c) => alvoNomes.has(normalizar(c.name)));
      if (exatos.length === 1) porNomeExato = { idClient: exatos[0].idClient!, origem: 'nome' };
    }
  }
  return porNomeExato;
}

export interface PedidoDoPaciente {
  leadId: number | null;
  /** Nome do contato (perfil do WhatsApp). */
  nome: string;
  /** Título do cartão ("NOME 03/08/2026"). */
  titulo: string;
  telefone: string;
}

export interface ResumoDoPaciente {
  unidade: string;
  franquia: boolean;
  tz?: string;
  agora?: Date;
  paciente: { idClient: number | null; nome: string | null; whatsapp: string | null; origem: PacienteAchado['origem'] } | null;
  erro?: string;
  /** 0.5.0: por que a franquia recusou (`sem_unidade`: a conta é de duas unidades e o cartão está sem o campo). */
  codigo?: 'sem_unidade' | 'unidade_sem_franquia';
  duplicadoNaFranquia?: boolean;
  agenda?: ResumoAgenda;
  tratamento?: { categoria: string | null; fisioterapeuta: string | null; status: string | null; local: string | null; grau: string | null; valor: number | null } | null;
}

/**
 * A resposta do widget "Agenda da franquia". LANÇA quando a franquia cai no meio — quem chama decide o que
 * mostrar (o widget responde 502; a Ponte mostra o cartão sem o bloco da franquia).
 */
export async function resumoDoPacienteNaFranquia(unitDoPedido: Unit, q: PedidoDoPaciente): Promise<ResumoDoPaciente> {
  if (!unitDoPedido.spineEnabled || !unitDoPedido.spineToken) return { unidade: unitDoPedido.name, franquia: false, paciente: null };
  // Kommo dividido (Petrópolis + Caxias): mostra a franquia da unidade do CARTÃO; campo vazio não escolhe por ninguém.
  const dono = await unidadeParaOCartao(unitDoPedido, q.leadId);
  if (dono.tipo === 'recusa') return { unidade: unitDoPedido.name, franquia: true, paciente: null, erro: dono.motivo, codigo: dono.codigo };
  const unit = dono.unit;
  const tz = unit.spineTimezone ?? 'America/Sao_Paulo';

  // Dois caminhos, sempre: o vínculo que a Sofia gravou E a busca por nome+telefone. Caso real (16/09): o vínculo
  // apontava pra um cadastro sem agenda (343253) e a paciente de verdade, em tratamento, era outro cadastro (320555).
  // Fica o cadastro que tem agenda; se os dois existem e são diferentes, a franquia tem paciente em dobro → avisar.
  // Regra de 16/10: a SDR escolheu no widget qual dos pacientes do telefone é o deste cartão — é ele, sem buscar mais nada.
  const escolhido = q.leadId && estadoCasamentoJornada(unit.slug) === 'ligado' ? await escolhaDaSdr(unit.id, q.leadId) : null;
  const [vinc, busca] = escolhido
    ? [{ idClient: escolhido, origem: 'escolha' as const }, null]
    : await Promise.all([porVinculo(unit, q.leadId), porNomeETelefone(unit, q.titulo, q.nome, q.telefone)]);
  const candidatos = [vinc, busca].filter((c, i, a): c is PacienteAchado => !!c && a.findIndex((x) => x && x.idClient === c.idClient) === i);
  if (!candidatos.length) return { unidade: unit.name, franquia: true, tz, agora: new Date(), paciente: null };

  const detalhes = await Promise.all(candidatos.map(async (c) => ({ c, det: await SpineService.getClient(unit, c.idClient) })));
  const validos = detalhes.filter((d) => d.det.ok && d.det.data?.client);
  if (!validos.length) {
    return { unidade: unit.name, franquia: true, tz, agora: new Date(), paciente: null, erro: detalhes.some((d) => !d.det.ok) ? 'franquia indisponível' : undefined };
  }
  validos.sort((a, b) => (b.det.data!.client!.schedules.length - a.det.data!.client!.schedules.length));
  const achado = validos[0].c;
  const cli = validos[0].det.data!.client!;
  const duplicadoNaFranquia = validos.length > 1;
  if (duplicadoNaFranquia) logger.info({ unit: unit.slug, leadId: q.leadId, ids: validos.map((v) => v.c.idClient) }, 'widget: paciente com dois cadastros na franquia');
  const agenda = resumoDaAgenda(cli.schedules, new Date());
  const trat = (await tratamentosDaUnidade(unit)).find((t) => (t.idClient && t.idClient === cli.idClient) || (t.clientName && cli.name && normalizar(t.clientName) === normalizar(cli.name))) ?? null;
  return {
    unidade: unit.name,
    franquia: true,
    tz,
    agora: new Date(),
    paciente: { idClient: cli.idClient, nome: cli.name, whatsapp: cli.whatsapp ? `…${chaveTelefone(cli.whatsapp).slice(-4)}` : null, origem: achado.origem },
    duplicadoNaFranquia,
    agenda,
    tratamento: trat
      ? { categoria: trat.category, fisioterapeuta: trat.staffName, status: trat.statusName, local: trat.local, grau: trat.degree, valor: trat.price }
      : null,
  };
}
