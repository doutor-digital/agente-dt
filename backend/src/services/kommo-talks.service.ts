/**
 * A conversa como o WhatsApp a vê, pela rota oficial do Kommo (talks/messages).
 *
 * A Sofia guardava só o que passava por ela: a mensagem do paciente e a própria
 * resposta. A resposta da SDR, o áudio que o webhook não entregou e o status de
 * leitura ficavam invisíveis — daí "não vi o que a equipe falou", a re-apresentação
 * depois de um humano entrar e a régua cobrando quem nem leu.
 *
 * Aqui a rota oficial vira três coisas simples: a lista normalizada, "o que
 * aconteceu desde a última fala da Sofia" (o que o modelo precisa saber antes de
 * responder) e o estado de leitura da última mensagem enviada (o que a régua
 * precisa saber antes de cobrar).
 */
import type { Unit } from '@prisma/client';
import { createKommoClient, type KommoClient, type KommoTalkMessage } from './kommo.service.js';

export type AutorOficial = 'paciente' | 'sofia' | 'equipe';

export interface MensagemOficial {
  id: string;
  em: Date;
  direcao: 'entrada' | 'saida';
  autor: AutorOficial;
  autorNome: string;
  texto: string;
  anexo: { tipo: string; link: string | null } | null;
  status: string | null;
}

/** Usuários do Kommo pelos quais a Sofia fala (nota de voz sai como o usuário da sessão). */
const NOMES_DA_SOFIA = ['doutor digital', 'i.a sofia', 'ia sofia', 'sofia'];

export function classificarAutor(m: Pick<KommoTalkMessage, 'type' | 'author'>): AutorOficial {
  const tipo = (m.author?.type ?? '').toLowerCase();
  if (m.type === 'incoming' || tipo === 'external') return 'paciente';
  if (tipo === 'bot') return 'sofia';
  const nome = (m.author?.name ?? '').trim().toLowerCase();
  if (NOMES_DA_SOFIA.includes(nome)) return 'sofia';
  return 'equipe';
}

export function normalizar(raw: KommoTalkMessage[]): MensagemOficial[] {
  return raw
    .map((m) => ({
      id: String(m.id),
      em: new Date((m.created_at ?? 0) * 1000),
      direcao: (m.type === 'incoming' ? 'entrada' : 'saida') as 'entrada' | 'saida',
      autor: classificarAutor(m),
      autorNome: (m.author?.name ?? '').trim(),
      texto: (m.text ?? '').trim(),
      anexo: m.attachment?.type ? { tipo: String(m.attachment.type), link: m.attachment.link ?? null } : null,
      status: m.delivery_status ?? null,
    }))
    .sort((a, b) => a.em.getTime() - b.em.getTime());
}

export async function mensagensOficiais(kommo: KommoClient, leadId: number, limit = 40): Promise<MensagemOficial[]> {
  const talks = await kommo.listTalks(leadId);
  if (!talks.length) return [];
  // A conversa viva é a talk mais recente; talks antigas são histórico já consolidado.
  const viva = [...talks].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
  const raw = await kommo.listTalkMessages(viva.talk_id, limit);
  return normalizar(raw);
}

/** Tudo que aconteceu depois da última fala da Sofia (equipe e paciente). */
export function desdeUltimaFalaDaSofia(msgs: MensagemOficial[]): MensagemOficial[] {
  let corte = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].autor === 'sofia') { corte = i; break; }
  }
  return msgs.slice(corte + 1);
}

function hora(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(5, 16);
  }
}

/**
 * Bloco que vai junto com a mensagem do paciente. Só existe quando há algo que
 * o modelo não veria de outro jeito: a equipe falou, ou o paciente mandou coisa
 * que o webhook não entregou (áudio já transcrito pelo chamador).
 */
export function renderConversaOficial(
  itens: Array<MensagemOficial & { transcricao?: string | null }>,
  tz = 'America/Sao_Paulo',
): string {
  if (!itens.length) return '';
  const linhas = itens.map((m) => {
    const quem = m.autor === 'equipe' ? `Equipe${m.autorNome ? ` (${m.autorNome})` : ''}` : m.autor === 'paciente' ? 'Paciente' : 'Sofia';
    const corpo = m.transcricao
      ? `[áudio transcrito] "${m.transcricao}"`
      : m.texto
        ? `"${m.texto}"`
        : m.anexo
          ? `[${m.anexo.tipo === 'voice' ? 'áudio' : m.anexo.tipo}]`
          : '[mensagem vazia]';
    return `- ${hora(m.em, tz)} · ${quem}: ${corpo}`;
  });
  const temEquipe = itens.some((m) => m.autor === 'equipe');
  const regras = temEquipe
    ? 'A EQUIPE HUMANA já falou com o paciente depois da sua última mensagem. NÃO repita nem contradiga o que a equipe disse, NÃO se reapresente, e continue exatamente de onde a conversa parou. Se a equipe fez uma pergunta e o paciente acabou de responder, responda ao que ele disse.'
    : 'Considere estas mensagens do paciente como parte da conversa; não peça que ele repita o que já disse aqui.';
  return `<conversa_oficial>\nO que aconteceu no WhatsApp desde a sua última mensagem (rota oficial), em ordem:\n${linhas.join('\n')}\n${regras}\n</conversa_oficial>`;
}

export interface EstadoDeLeitura {
  ultimaSaida: { em: Date; status: string | null; autor: AutorOficial } | null;
  ultimaEntradaEm: Date | null;
  equipeFalouPorUltimo: boolean;
}

export function estadoDeLeitura(msgs: MensagemOficial[]): EstadoDeLeitura {
  let ultimaSaida: EstadoDeLeitura['ultimaSaida'] = null;
  let ultimaEntradaEm: Date | null = null;
  let ultimoAutor: AutorOficial | null = null;
  for (const m of msgs) {
    if (m.direcao === 'saida') ultimaSaida = { em: m.em, status: m.status, autor: m.autor };
    else ultimaEntradaEm = m.em;
    ultimoAutor = m.autor;
  }
  return { ultimaSaida, ultimaEntradaEm, equipeFalouPorUltimo: ultimoAutor === 'equipe' };
}

export const STATUS_LIDO = new Set(['seen', 'read']);
export const STATUS_FALHOU = new Set(['error', 'failed', 'not_delivered', 'undelivered']);
/** Sem confirmação de leitura (paciente sem "visto" ou celular desligado), a régua espera até aqui. */
export const ESPERA_SEM_LEITURA_MS = 6 * 3600_000;

export type DecisaoDeCobranca = 'cobrar' | 'esperar_leitura' | 'parar_nao_entregue' | 'parar_equipe' | 'parar_paciente_respondeu';

/**
 * A régua só cobra quem LEU e não respondeu. Não entregue = parar (a janela do
 * WhatsApp fechou ou o número não existe). Equipe falou por último = a conversa
 * é dela. Paciente falou por último = não é caso de cobrança, é de resposta.
 */
export function decidirCobranca(estado: EstadoDeLeitura, agora: Date = new Date()): DecisaoDeCobranca {
  if (estado.equipeFalouPorUltimo) return 'parar_equipe';
  const saida = estado.ultimaSaida;
  if (!saida) return 'cobrar';
  if (estado.ultimaEntradaEm && estado.ultimaEntradaEm > saida.em) return 'parar_paciente_respondeu';
  const status = (saida.status ?? '').toLowerCase();
  if (STATUS_FALHOU.has(status)) return 'parar_nao_entregue';
  if (STATUS_LIDO.has(status)) return 'cobrar';
  if (agora.getTime() - saida.em.getTime() >= ESPERA_SEM_LEITURA_MS) return 'cobrar';
  return 'esperar_leitura';
}

export const MOTIVO_PARADA_LEITURA: Record<Exclude<DecisaoDeCobranca, 'cobrar' | 'esperar_leitura'>, string> = {
  parar_nao_entregue: 'última mensagem não entregue (rota oficial)',
  parar_equipe: 'equipe assumiu a conversa (rota oficial)',
  parar_paciente_respondeu: 'paciente respondeu por fora (rota oficial)',
};

/** Lê a rota oficial e decide se a régua pode cobrar este lead agora. */
export async function decisaoDeCobrancaDoLead(unit: Unit, leadId: number, agora: Date = new Date()): Promise<DecisaoDeCobranca> {
  const msgs = await mensagensOficiais(createKommoClient(unit), leadId, 12);
  return decidirCobranca(estadoDeLeitura(msgs), agora);
}
