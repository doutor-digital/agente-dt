/**
 * "Pedir à Doutor Digital" na tela Agente do Chatwoot (pedido do João, 13/11/2026: "eles cuidam da própria IA; o que for de código
 * fonte envolve a gente"). O que a equipe da clínica não muda sozinha (valor, horário, erro da Sofia, informação da clínica) vira
 * uma DEMANDA do suporte (`suporte_demandas`, a mesma fila do painel suporte.doutordigitalconsultoria.com e do bot de chamados).
 *
 * Diferenças para o menu do WhatsApp: quem pede está logada no Chatwoot (verificação "chatwoot", nunca entra sozinha na fila do
 * agente de código, que só aceita "grupo") e o "jid" é `chatwoot:<usuário>` (não é número: o painel não manda WhatsApp para ele).
 */
import { prisma } from './prisma.js';

export const VERIFICACAO_CHATWOOT = 'chatwoot';
export const MIN_PEDIDO = 10;
export const MAX_PEDIDO = 1_500;
/** por unidade e por dia: a porta é aberta a toda a equipe, o teto evita enxurrada no bot de chamados */
export const MAX_PEDIDOS_POR_DIA = 15;

/** O que aparece para a atendente e a categoria do suporte (`CATEGORIAS` de suporte-menu-maquina.ts) em que cai. */
export const TIPOS_DE_PEDIDO = {
  erro: { rotulo: 'A Sofia errou ou não respondeu', categoria: 1 },
  valor: { rotulo: 'Mudar valor, desconto ou pagamento', categoria: 1 },
  agenda: { rotulo: 'Horários, agenda ou médicos', categoria: 4 },
  info: { rotulo: 'Informação da clínica errada', categoria: 1 },
  outro: { rotulo: 'Outra coisa', categoria: 7 },
} as const;
export type TipoDePedido = keyof typeof TIPOS_DE_PEDIDO;

const ehTipo = (v: unknown): v is TipoDePedido => typeof v === 'string' && Object.prototype.hasOwnProperty.call(TIPOS_DE_PEDIDO, v);
const limpar = (t: string) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

export function lerPedido(corpo: unknown): { ok: true; tipo: TipoDePedido; texto: string; conversa: number | null } | { ok: false; erro: string } {
  const c = (corpo && typeof corpo === 'object' ? corpo : {}) as Record<string, unknown>;
  if (!ehTipo(c.tipo)) return { ok: false, erro: 'Escolha o tipo do pedido.' };
  const texto = typeof c.texto === 'string' ? limpar(c.texto) : '';
  if (texto.length < MIN_PEDIDO) return { ok: false, erro: 'Explique o que precisa (pelo menos uma frase).' };
  if (texto.length > MAX_PEDIDO) return { ok: false, erro: `O pedido passou de ${MAX_PEDIDO} letras. Resuma um pouco.` };
  const n = Number(c.conversa);
  return { ok: true, tipo: c.tipo, texto, conversa: Number.isInteger(n) && n > 0 ? n : null };
}

export function relatoDoPedido(p: { unidade: string; nome: string; tipo: TipoDePedido; texto: string; conversa: number | null }): string {
  const onde = p.conversa ? ` (conversa ${p.conversa} do Chatwoot)` : '';
  return `[Agente no Chatwoot] ${p.nome}, de ${p.unidade}, pediu${onde}:\n${TIPOS_DE_PEDIDO[p.tipo].rotulo}\n\n${p.texto}`;
}

export function avisoDoPedido(p: { protocolo: number; unidade: string; nome: string; tipo: TipoDePedido; texto: string }): string {
  const corte = p.texto.length > 400 ? `${p.texto.slice(0, 399)}…` : p.texto;
  return `🆕 Pedido #${p.protocolo} pelo Agente (Chatwoot) — ${p.unidade}\n${p.nome} · ${TIPOS_DE_PEDIDO[p.tipo].rotulo}\n"${corte}"`;
}

export type SituacaoDoPedido = 'na-fila' | 'resolvido' | 'reaberto';

export function situacaoDoPedido(status: string): SituacaoDoPedido {
  return status === 'resolvida' ? 'resolvido' : status === 'reaberta' ? 'reaberto' : 'na-fila';
}

export async function pedidosHoje(slug: string, agora = new Date()): Promise<number> {
  const inicio = new Date(agora.getTime() - 24 * 3_600_000);
  return prisma.suporteDemanda.count({ where: { unidadeSlug: slug, verificacao: VERIFICACAO_CHATWOOT, criadoEm: { gte: inicio } } });
}

export async function criarPedido(p: {
  slug: string;
  unidade: string;
  quemId: number | null;
  nome: string;
  tipo: TipoDePedido;
  texto: string;
  conversa: number | null;
}): Promise<{ protocolo: number }> {
  const t = TIPOS_DE_PEDIDO[p.tipo];
  return prisma.suporteDemanda.create({
    data: {
      jid: `chatwoot:${p.quemId ?? 0}`,
      nome: p.nome.slice(0, 80),
      unidadeSlug: p.slug,
      verificacao: VERIFICACAO_CHATWOOT,
      categoria: t.categoria,
      categoriaNome: `Agente (Chatwoot) · ${t.rotulo}`,
      relato: relatoDoPedido(p).slice(0, 8_000),
    },
    select: { protocolo: true },
  });
}

export async function marcarAvisado(protocolo: number, ok: boolean): Promise<void> {
  await prisma.suporteDemanda.update({ where: { protocolo }, data: { telegramEnviado: ok } });
}

export interface PedidoDaLista {
  protocolo: number;
  nome: string | null;
  tipo: string;
  texto: string;
  situacao: SituacaoDoPedido;
  criadoEm: Date;
  resolvidoEm: Date | null;
  resposta: string | null;
}

/** Os pedidos da unidade feitos pelo Agente (últimos 60 dias), mais novos primeiro. */
export async function pedidosDaUnidade(slug: string, agora = new Date()): Promise<PedidoDaLista[]> {
  const desde = new Date(agora.getTime() - 60 * 86_400_000);
  const l = await prisma.suporteDemanda.findMany({
    where: { unidadeSlug: slug, verificacao: VERIFICACAO_CHATWOOT, criadoEm: { gte: desde } },
    orderBy: { criadoEm: 'desc' },
    take: 50,
    select: { protocolo: true, nome: true, categoriaNome: true, relato: true, status: true, criadoEm: true, resolvidaEm: true, notaResolucao: true },
  });
  return l.map((d) => ({
    protocolo: d.protocolo,
    nome: d.nome,
    tipo: d.categoriaNome.replace(/^Agente \(Chatwoot\) · /, ''),
    // o relato guarda o cabeçalho "[Agente no Chatwoot] …" + o tipo; a lista mostra só o que a pessoa escreveu
    texto: d.relato.split('\n\n').slice(1).join('\n\n') || d.relato,
    situacao: situacaoDoPedido(d.status),
    criadoEm: d.criadoEm,
    resolvidoEm: d.resolvidaEm,
    resposta: d.notaResolucao,
  }));
}
