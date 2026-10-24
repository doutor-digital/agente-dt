/**
 * De onde vem a lista e quem já pediu para sair. Só leitura: nada aqui escreve no Kommo nem manda mensagem.
 *
 * A seleção continua sendo do Kommo (etiqueta da onda): quem decide QUEM entra na campanha é gente; este código só
 * tira dessa lista quem não pode receber (ver `regras.ts`).
 */
import type { Unit } from '@prisma/client';
import { prisma } from '../prisma.js';
import { createKommoClient, type KommoLead } from '../../services/kommo.service.js';
import { grupoDaUnidade, pularCartao } from '../crm-compartilhado.js';
import { conferenciaDaFranquia } from './franquia.js';
import { chaveDaPessoa, pediuParaSair, telefoneWhatsapp, type Candidato, type ContextoDoPublico } from './regras.js';

/** Os cartões com a etiqueta, com o nome e o telefone do contato principal. */
export async function candidatosDaEtiqueta(unit: Unit, etiqueta: string): Promise<{ candidatos: Candidato[]; foraDoKommoDividido: number }> {
  if (!unit.kommoSubdomain || !unit.kommoAccessToken) throw new Error('unidade sem Kommo configurado');
  const kommo = createKommoClient(unit);
  const cartoes: KommoLead[] = await kommo.listLeadsComEtiqueta(etiqueta);

  // Kommo dividido (Petrópolis + Caxias): cartão da outra unidade ou sem «⌂ Unidade de atendimento» não é nosso.
  const grupo = await grupoDaUnidade(unit.id);
  const resumo: { deOutraUnidade?: number; semUnidade?: number } = {};
  const nossos = cartoes.filter((l) => !pularCartao(grupo, unit.id, l, resumo));

  const contatoDoCartao = new Map<number, number>();
  for (const l of nossos) {
    const c = l._embedded?.contacts?.find((x) => x.is_main) ?? l._embedded?.contacts?.[0];
    if (c) contatoDoCartao.set(l.id, c.id);
  }
  const contatos = await kommo.contatosBasicos([...contatoDoCartao.values()]);
  const candidatos = nossos.map((l): Candidato => {
    const c = contatos.get(contatoDoCartao.get(l.id) ?? -1);
    return { leadId: l.id, nome: c?.nome ?? null, telefoneBruto: c?.telefone ?? null };
  });
  return { candidatos, foraDoKommoDividido: (resumo.deOutraUnidade ?? 0) + (resumo.semUnidade ?? 0) };
}

/** Palavras que PODEM ser um pedido de saída; o regex fino (`pediuParaSair`) decide. Filtra no banco para não ler a conversa toda. */
const PISTAS_DE_SAIDA = ['sair', 'parar', 'pare', 'stop', 'receber', 'lista', 'descadastr'];

/** Cartões (de qualquer cartão da conta Kommo da unidade) cujo paciente escreveu um pedido de saída, a partir de `desde`. */
export async function leadsQuePediramSair(unit: Unit, leadIds: number[], desde?: Date): Promise<Set<number>> {
  const saiu = new Set<number>();
  if (leadIds.length === 0) return saiu;
  const daConta = unit.kommoSubdomain ? await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } }) : [{ id: unit.id }];
  const msgs = await prisma.message.findMany({
    where: {
      role: 'user',
      ...(desde ? { createdAt: { gte: desde } } : {}),
      OR: PISTAS_DE_SAIDA.map((p) => ({ content: { contains: p, mode: 'insensitive' as const } })),
      conversation: { unitId: { in: daConta.map((u) => u.id) }, leadId: { in: leadIds.map(String) } },
    },
    select: { content: true, conversation: { select: { leadId: true } } },
  });
  for (const m of msgs) if (pediuParaSair(m.content)) saiu.add(Number(m.conversation.leadId));
  return saiu;
}

/** Quem já respondeu SAIR numa onda ANTERIOR do sistema (qualquer campanha), pela chave do telefone. */
export async function chavesQueSairamAntes(unitId: string): Promise<Set<string>> {
  const linhas = await prisma.disparoDestinatario.findMany({ where: { unitId, estado: 'saiu' }, select: { chave: true } });
  return new Set(linhas.map((l) => l.chave));
}

/**
 * Quem já está em alguma onda desta campanha nesta unidade. Não conta quem só está numa onda CANCELADA sem ter
 * recebido nada (pendente ou descartado): refazer uma onda cancelada — texto errado, lista a ajustar — é rotina, e a
 * pessoa que nunca recebeu não pode ficar travada para sempre. Essas linhas são reaproveitadas em `reaproveitarDeOndaCancelada`.
 */
export async function chavesJaNaCampanha(campanhaId: string, unitId: string): Promise<Set<string>> {
  const linhas = await prisma.disparoDestinatario.findMany({
    where: { campanhaId, unitId, NOT: { estado: { in: [...ESTADOS_REAPROVEITAVEIS] }, onda: { estado: 'cancelada' } } },
    select: { chave: true },
  });
  return new Set(linhas.map((l) => l.chave));
}

const ESTADOS_REAPROVEITAVEIS = ['pendente', 'descartado'] as const;

/** Move para a onda nova as linhas de ondas canceladas que nunca enviaram nada (a chave única não deixa criar outra). */
export async function reaproveitarDeOndaCancelada(
  campanhaId: string,
  unitId: string,
  ondaId: string,
  pessoas: ReadonlyArray<{ chave: string; telefone: string; nome: string; nomeCompleto: string; leadId: number | null }>,
): Promise<number> {
  let movidas = 0;
  for (const p of pessoas) {
    const r = await prisma.disparoDestinatario.updateMany({
      where: { campanhaId, unitId, chave: p.chave, estado: { in: [...ESTADOS_REAPROVEITAVEIS] }, onda: { estado: 'cancelada' } },
      data: { ondaId, telefone: p.telefone, nome: p.nome, nomeCompleto: p.nomeCompleto || null, kommoLeadId: p.leadId, estado: 'pendente', motivo: null, simuladoEm: null },
    });
    movidas += r.count;
  }
  return movidas;
}

/** Converte "cartões que pediram SAIR" em "chaves de telefone que pediram SAIR", usando os candidatos da lista. */
export function chavesDosLeads(candidatos: Candidato[], leads: ReadonlySet<number>): Set<string> {
  const chaves = new Set<string>();
  for (const c of candidatos) {
    if (c.leadId === null || !leads.has(c.leadId)) continue;
    const tel = telefoneWhatsapp(c.telefoneBruto);
    if (tel) chaves.add(chaveDaPessoa(tel));
  }
  return chaves;
}

export interface PublicoLido extends ContextoDoPublico {
  candidatos: Candidato[];
  foraDoKommoDividido: number;
}

/** Tudo o que a montagem lê do mundo para decidir quem entra: Kommo, conversas, onda anterior e franquia. Só leitura. */
export async function lerPublico(unit: Unit, etiqueta: string, campanhaId: string): Promise<PublicoLido> {
  const { candidatos, foraDoKommoDividido } = await candidatosDaEtiqueta(unit, etiqueta);
  const leadIds = candidatos.map((c) => c.leadId).filter((n): n is number => n !== null);
  const sairamNasConversas = chavesDosLeads(candidatos, await leadsQuePediramSair(unit, leadIds));
  return {
    candidatos,
    foraDoKommoDividido,
    pediramSair: new Set([...sairamNasConversas, ...(await chavesQueSairamAntes(unit.id))]),
    jaNaCampanha: await chavesJaNaCampanha(campanhaId, unit.id),
    franquia: conferenciaDaFranquia(unit),
  };
}
