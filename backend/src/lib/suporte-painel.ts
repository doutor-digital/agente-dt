/**
 * Painel do suporte (suporte.doutordigitalconsultoria.com) — as regras de "Resolvido" e "Reabrir".
 *
 * "Resolvido" (João ou Suzanne, no painel):
 *   1. marca a demanda como resolvida (quem e quando; a nota, se houver);
 *   2. se a conversa da pessoa ainda está nesta demanda, ela passa a "resolvida" e a mensagem pergunta "funcionou? 1/2"
 *      (2 reabre sozinho, pelo menu). Se a pessoa já está noutra conversa do menu, a mensagem só avisa, sem pergunta
 *      (senão o "1" dela seria lido no passo errado);
 *   3. manda a mensagem no WhatsApp SÓ se o menu estiver `ligado`;
 *   4. avisa no bot de chamados.
 * A nota é de quem resolveu (pessoa da casa, logada como administrador): vai para o WhatsApp como escrita, cortada e sem
 * caracteres de controle.
 */
import { TEXTOS, limparTexto, type Passo } from './suporte-menu-maquina.js';

export const MAX_NOTA = 600;

export type StatusDemanda = 'aberta' | 'resolvida' | 'reaberta';

export interface DemandaDoPainel {
  protocolo: number;
  jid: string;
  status: StatusDemanda;
}

export interface ConversaDoPainel {
  passo: Passo;
  protocolo: number | null;
  versao: number;
}

export interface DepsPainel {
  agora(): Date;
  demanda(protocolo: number): Promise<DemandaDoPainel | null>;
  conversa(jid: string): Promise<ConversaDoPainel | null>;
  marcarResolvida(protocolo: number, dados: { quem: string; nota: string | null; quando: Date }): Promise<void>;
  /** passa a conversa a "resolvida" (trava otimista pela versão); false = a conversa andou nesse meio-tempo */
  conversaParaResolvida(jid: string, versao: number, quando: Date): Promise<boolean>;
  /** o menu pode falar com a pessoa agora? (`ligado` no servidor E não pausado) */
  /** o menu pode falar com ESTA pessoa agora: ligado, sem pausa geral e sem pausa só dela (Central do João) */
  menuLigado(jid: string): boolean | Promise<boolean>;
  enviarWhatsApp(jid: string, texto: string): Promise<boolean>;
  telegram(texto: string): Promise<boolean>;
  reabrir(protocolo: number): Promise<void>;
}

export type DesfechoResolver =
  | { ok: false; status: 404 | 409; erro: string }
  | { ok: true; perguntou: boolean; whatsapp: boolean };

export function limparNota(nota: unknown): string | null {
  if (typeof nota !== 'string') return null;
  const t = limparTexto(nota, MAX_NOTA);
  return t || null;
}

export async function resolverDemanda(protocolo: number, quem: string, notaBruta: unknown, deps: DepsPainel): Promise<DesfechoResolver> {
  const d = await deps.demanda(protocolo);
  if (!d) return { ok: false, status: 404, erro: 'demanda não encontrada' };
  if (d.status === 'resolvida') return { ok: false, status: 409, erro: 'a demanda já está resolvida' };
  const nota = limparNota(notaBruta);
  const agora = deps.agora();
  await deps.marcarResolvida(protocolo, { quem, nota, quando: agora });

  // só pergunta "funcionou?" se o menu pode falar agora (ligado e não pausado) E a conversa da pessoa ainda está nesta demanda (e
  // consegue passá-la a "resolvida"). Sem a pergunta no ar a conversa NÃO muda de passo: senão a próxima mensagem da pessoa seria lida
  // como resposta a um "funcionou?" que ela nunca recebeu.
  const podeFalar = await deps.menuLigado(d.jid);
  const c = podeFalar ? await deps.conversa(d.jid) : null;
  const naMesma = c != null && c.protocolo === protocolo && (c.passo === 'aberta' || c.passo === 'resolvida');
  const perguntou = naMesma ? await deps.conversaParaResolvida(d.jid, c!.versao, agora) : false;
  const texto = perguntou ? TEXTOS.resolvida(protocolo, nota) : `Sua demanda ${protocolo} foi resolvida. ✅${nota ? `\n\n${nota}` : ''}`;

  const whatsapp = podeFalar ? await deps.enviarWhatsApp(d.jid, texto) : false;
  await deps.telegram(`✅ Demanda #${protocolo} resolvida por ${quem}${nota ? ` — "${nota.slice(0, 200)}"` : ''}.${whatsapp ? ' A pessoa foi avisada para testar.' : ' (A pessoa NÃO foi avisada no WhatsApp: menu fora do modo ligado, pausado ou envio recusado.)'}`);
  return { ok: true, perguntou, whatsapp };
}

export async function reabrirPeloPainel(protocolo: number, quem: string, deps: DepsPainel): Promise<{ ok: boolean; status?: number; erro?: string }> {
  const d = await deps.demanda(protocolo);
  if (!d) return { ok: false, status: 404, erro: 'demanda não encontrada' };
  if (d.status !== 'resolvida') return { ok: false, status: 409, erro: 'só dá para reabrir demanda resolvida' };
  await deps.reabrir(protocolo);
  await deps.telegram(`🔁 Demanda #${protocolo} reaberta no painel por ${quem}.`);
  return { ok: true };
}

/** Base de conhecimento: valida o que vem do painel. */
export function lerItemDeConhecimento(corpo: unknown, parcial = false): { ok: true; dados: { titulo?: string; texto?: string; ativo?: boolean } } | { ok: false; erro: string } {
  if (typeof corpo !== 'object' || corpo === null) return { ok: false, erro: 'corpo inválido' };
  const c = corpo as Record<string, unknown>;
  const dados: { titulo?: string; texto?: string; ativo?: boolean } = {};
  if (c.titulo !== undefined) {
    const t = typeof c.titulo === 'string' ? limparTexto(c.titulo, 120) : '';
    if (!t) return { ok: false, erro: 'título vazio' };
    dados.titulo = t;
  }
  if (c.texto !== undefined) {
    const t = typeof c.texto === 'string' ? c.texto.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2_000) : '';
    if (!t) return { ok: false, erro: 'texto vazio' };
    dados.texto = t;
  }
  if (c.ativo !== undefined) {
    if (typeof c.ativo !== 'boolean') return { ok: false, erro: 'ativo tem de ser verdadeiro ou falso' };
    dados.ativo = c.ativo;
  }
  if (!parcial && (!dados.titulo || !dados.texto)) return { ok: false, erro: 'título e texto são obrigatórios' };
  return { ok: true, dados };
}
