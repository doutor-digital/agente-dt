/**
 * Quem recebeu um disparo com oferta e está respondendo: devolve a oferta para a Sofia (prompt + guardrail de preço).
 * Só leitura. O vínculo é o envio REAL (`enviado` com `wamid`): o "receberia" do modo seco nunca vale.
 */
import { prisma } from '../prisma.js';
import type { OfertaVigente } from '../../agent/oferta-da-campanha.js';
import { chaveDaPessoa, telefoneWhatsapp, textoFinal, valoresDasVariaveis } from './regras.js';

/** Por quantos dias depois do envio a Sofia ainda trata a pessoa como destinatária da oferta (`DISPARO_OFERTA_DIAS`). */
export function diasDaOferta(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DISPARO_OFERTA_DIAS);
  return env.DISPARO_OFERTA_DIAS !== undefined && env.DISPARO_OFERTA_DIAS.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 90 ? n : 14;
}

/**
 * A oferta mais recente que esta pessoa recebeu nesta unidade, ou null.
 * Casa pelo cartão (`kommoLeadId`) OU pelo telefone (DDD + 8 últimos dígitos): o mesmo critério da chave única do disparo.
 * Quem respondeu SAIR (`saiu`) não entra, e campanha sem texto de oferta não entra.
 */
export async function ofertaDoLead(unitId: string, leadId: number | null | undefined, telefone?: string | null, agora: Date = new Date()): Promise<OfertaVigente | null> {
  // `undefined` = quem chama não tem o telefone à mão: o da conversa deste cartão.
  const doCartao =
    telefone === undefined && leadId && Number.isFinite(leadId) && leadId > 0
      ? (await prisma.conversation.findUnique({ where: { unitId_leadId: { unitId, leadId: String(leadId) } }, select: { phone: true } }))?.phone
      : telefone;
  const tel = telefoneWhatsapp(doCartao ?? null);
  const quem: Array<{ kommoLeadId: number } | { chave: string }> = [];
  if (leadId && Number.isFinite(leadId) && leadId > 0) quem.push({ kommoLeadId: leadId });
  if (tel) quem.push({ chave: chaveDaPessoa(tel) });
  if (quem.length === 0) return null;
  const achado = await prisma.disparoDestinatario.findFirst({
    where: {
      unitId,
      estado: 'enviado',
      wamid: { not: null },
      enviadoEm: { gte: new Date(agora.getTime() - diasDaOferta() * 86_400_000) },
      onda: { campanha: { oferta: { not: null } } },
      OR: quem,
    },
    orderBy: { enviadoEm: 'desc' },
    select: { nome: true, enviadoEm: true, onda: { select: { textoModelo: true, variaveis: true, unit: { select: { name: true } }, campanha: { select: { nome: true, oferta: true } } } } },
  });
  const oferta = achado?.onda.campanha.oferta?.trim();
  if (!achado || !oferta || !achado.enviadoEm) return null;
  let textoEnviado = '';
  try {
    const variaveis = Array.isArray(achado.onda.variaveis) ? (achado.onda.variaveis as unknown[]).map(String) : [];
    textoEnviado = textoFinal(achado.onda.textoModelo, valoresDasVariaveis(variaveis, { primeiroNome: achado.nome, unidade: achado.onda.unit.name }));
  } catch {
    textoEnviado = '';
  }
  return { campanha: achado.onda.campanha.nome, oferta, enviadoEm: achado.enviadoEm, textoEnviado };
}
