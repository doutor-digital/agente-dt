/**
 * Pausa do menu de suporte — a regra (pura: sem banco e sem rede; quem executa é `suporte-pausa-banco.ts`).
 *
 * Dois caminhos mexem na MESMA chave, guardada no banco (nunca em memória, para sobreviver a deploy e valer em todas as réplicas):
 *   - o bot @ddchamados_bot, com /pausar, /voltar e /status, aceitos SÓ do chat do João (`TELEGRAM_CHAMADOS_CHAT`);
 *   - o botão Pausar/Retomar do painel suporte.* (só administrador geral).
 * O webhook do menu lê a chave a cada mensagem. Pausado = o menu não responde e não grava conversa nem demanda; só conta quantas
 * mensagens ficaram sem resposta, para o João saber quando voltar (o WhatsApp não reenvia o que o webhook ignorou).
 *
 * Segurança: o comando só vale se vier do chat privado do João (o `chat.id` E o `from.id` batem com o configurado). Qualquer outro
 * remetente é ignorado em silêncio, sem resposta (o bot não confirma que existe). O texto de quem escreve no WhatsApp nunca
 * chega aqui: isto só lê atualizações do Telegram.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { FUSO_PADRAO, partesNoFuso } from './fuso.js';

export interface EstadoPausa {
  pausado: boolean;
  /** quando a pausa atual começou (nulo se não está pausado) */
  desde: Date | null;
  /** "telegram" ou o e-mail de quem pausou pelo painel */
  por: string | null;
  /** mensagens que chegaram durante a pausa atual e ficaram sem resposta */
  ignoradas: number; // aproximado: conta reentregas do webhook e mídia sem texto
}

export const SEM_PAUSA: EstadoPausa = { pausado: false, desde: null, por: null, ignoradas: 0 };

export interface ArmazemPausa {
  ler(): Promise<EstadoPausa>;
  /** grava o novo estado; devolve o estado ANTERIOR (para saber se mudou algo e quantas mensagens a pausa que acabou ignorou) */
  gravar(p: { pausado: boolean; por: string; quando: Date }): Promise<EstadoPausa>;
}

export type Comando = 'pausar' | 'voltar' | 'status' | 'ajuda';

/** "/pausar", "/Pausar@ddchamados_bot arg" → 'pausar'. Texto que não é comando conhecido → null. */
export function lerComando(texto: unknown): Comando | null {
  if (typeof texto !== 'string') return null;
  const primeiro = texto.trim().split(/\s+/)[0] ?? '';
  const m = /^\/([a-zA-Z]+)(?:@[A-Za-z0-9_]+)?$/.exec(primeiro);
  if (!m) return null;
  switch (m[1]!.toLowerCase()) {
    case 'pausar':
    case 'pausa':
      return 'pausar';
    case 'voltar':
    case 'retomar':
      return 'voltar';
    case 'status':
      return 'status';
    case 'ajuda':
    case 'help':
    case 'start':
      return 'ajuda';
    default:
      return null;
  }
}

export type Atualizacao =
  | { ok: true; comando: Comando | 'desconhecido' }
  | { ok: false; motivo: string };

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lê uma atualização do Telegram (corpo do webhook) sem confiar em nada. Só serve mensagem nova de texto, em conversa privada,
 * vinda do chat permitido. Mensagem editada, grupo, canal ou outro remetente = ignorar.
 */
export function lerAtualizacao(corpo: unknown, chatPermitido: string): Atualizacao {
  if (!chatPermitido) return { ok: false, motivo: 'chat do João não configurado' };
  if (!ehObj(corpo) || !ehObj(corpo.message)) return { ok: false, motivo: 'não é mensagem nova' };
  const msg = corpo.message;
  const chat = ehObj(msg.chat) ? msg.chat : null;
  const de = ehObj(msg.from) ? msg.from : null;
  if (!chat || !de) return { ok: false, motivo: 'sem remetente' };
  if (chat.type !== 'private') return { ok: false, motivo: 'não é conversa privada' };
  if (de.is_bot === true) return { ok: false, motivo: 'remetente é bot' };
  if (String(chat.id) !== chatPermitido || String(de.id) !== chatPermitido) return { ok: false, motivo: 'chat não autorizado' };
  const texto = typeof msg.text === 'string' ? msg.text : '';
  if (!texto.trim().startsWith('/')) return { ok: false, motivo: 'não é comando' };
  return { ok: true, comando: lerComando(texto) ?? 'desconhecido' };
}

/** Segredo do webhook do Telegram (cabeçalho `X-Telegram-Bot-Api-Secret-Token`). Sem segredo configurado = recusa tudo. */
export function segredoDoTelegramConfere(esperado: string | undefined, recebido: unknown): boolean {
  const e = String(esperado ?? '').trim();
  if (!e || typeof recebido !== 'string' || !recebido) return false;
  // comparação em tempo constante via hash (tamanhos diferentes não vazam)
  return timingSafeEqual(createHash('sha256').update(e).digest(), createHash('sha256').update(recebido).digest());
}

// ─── textos (puros, sem formatação: o `enviarTelegram` manda texto simples) ─────────────────────────────────

/** "11/11 08:00" em horário de São Paulo (montado à mão: o Intl varia de versão para versão do ICU) */
export function quandoEmSP(d: Date): string {
  const p = partesNoFuso(d, FUSO_PADRAO);
  const dois = (n: number) => String(n).padStart(2, '0');
  return `${dois(p.dia)}/${dois(p.mes)} ${dois(p.hora)}:${dois(p.min)}`;
}

/** "pelo Telegram" / "por fulano@x.com" / "" — já com o espaço de separação quando há texto */
const quem = (por: string | null) => (por === 'telegram' ? ' pelo Telegram' : por ? ` por ${por}` : '');

export const TEXTOS_PAUSA = {
  ajuda:
    'Comandos do menu de suporte:\n' +
    '/pausar — o menu para de responder e de gravar (nada é perdido do que já está aberto)\n' +
    '/voltar — o menu volta a responder\n' +
    '/status — como está agora\n\n' +
    'O painel também tem o botão Pausar/Retomar.',
  desconhecido: 'Não conheço esse comando. Mande /ajuda para ver a lista.',
  pausou: (aviso: string) =>
    `⏸ Menu de suporte PAUSADO. Não responde nem grava ninguém até você mandar /voltar.${aviso}\nAs demandas já abertas e o painel seguem normais; as mensagens que chegarem agora ficam sem resposta (só são contadas).`,
  jaPausado: (e: EstadoPausa) =>
    `⏸ Já estava pausado${e.desde ? ` desde ${quandoEmSP(e.desde)}` : ''}${quem(e.por)}.${e.ignoradas ? `\nCerca de ${e.ignoradas} mensagem(ns) sem resposta até agora.` : ''}`,
  voltou: (anterior: EstadoPausa) =>
    `▶️ Menu de suporte RETOMADO.${anterior.ignoradas > 0 ? `\nCerca de ${anterior.ignoradas} mensagem(ns) chegaram durante a pausa e NÃO foram respondidas nem gravadas (a conta inclui reentregas e figurinhas): quem escreveu precisa mandar de novo.` : ''}`,
  jaAtivo: '▶️ O menu já estava ativo (não estava pausado).',
};

/** Aviso extra quando a pausa não tem efeito prático porque o menu nem está ligado. */
export function avisoDoModo(modo: string): string {
  return modo === 'ligado' ? '' : `\n(O menu está em "${modo}" no servidor; a pausa fica guardada e vale quando ele for ligado.)`;
}

export interface DadosDoStatus {
  modo: string;
  pausa: EstadoPausa;
  abertas: number;
  reabertas: number;
  lembrete: string;
}

export function montarStatus(d: DadosDoStatus): string {
  const pausa = d.pausa.pausado
    ? `⏸ PAUSADO desde ${d.pausa.desde ? quandoEmSP(d.pausa.desde) : '?'}${quem(d.pausa.por)} — cerca de ${d.pausa.ignoradas} mensagem(ns) sem resposta`
    : '▶️ ativo (não pausado)';
  return [
    '📊 Menu de suporte',
    `Servidor: ${d.modo === 'ligado' ? 'ligado' : d.modo === 'seco' ? 'em modo seco (não envia nem grava)' : 'DESLIGADO'}`,
    `Pausa: ${pausa}`,
    `Demandas abertas: ${d.abertas}${d.reabertas ? ` (${d.reabertas} reaberta${d.reabertas > 1 ? 's' : ''})` : ''}`,
    `Lembretes das 9h e 17h: ${d.lembrete}`,
  ].join('\n');
}

// ─── o que cada caminho faz ─────────────────────────────────────────────────────────────────────────────────

export interface DepsComando {
  pausa: ArmazemPausa;
  agora(): Date;
  /** `SUPORTE_MENU` do servidor: desligado | seco | ligado */
  modoDoMenu(): string;
  dadosDoStatus(): Promise<Omit<DadosDoStatus, 'pausa' | 'modo'>>;
}

/** Executa um comando já autorizado e devolve o texto da resposta. */
export async function executarComando(comando: Comando | 'desconhecido', deps: DepsComando): Promise<string> {
  switch (comando) {
    case 'ajuda':
      return TEXTOS_PAUSA.ajuda;
    case 'desconhecido':
      return TEXTOS_PAUSA.desconhecido;
    case 'pausar': {
      const antes = await deps.pausa.ler();
      if (antes.pausado) return TEXTOS_PAUSA.jaPausado(antes);
      await deps.pausa.gravar({ pausado: true, por: 'telegram', quando: deps.agora() });
      return TEXTOS_PAUSA.pausou(avisoDoModo(deps.modoDoMenu()));
    }
    case 'voltar': {
      const antes = await deps.pausa.gravar({ pausado: false, por: 'telegram', quando: deps.agora() });
      return antes.pausado ? TEXTOS_PAUSA.voltou(antes) : TEXTOS_PAUSA.jaAtivo;
    }
    case 'status': {
      const [pausa, resto] = await Promise.all([deps.pausa.ler(), deps.dadosDoStatus()]);
      return montarStatus({ modo: deps.modoDoMenu(), pausa, ...resto });
    }
  }
}

/** O mesmo vale para o botão do painel: devolve o que mudou e o texto para avisar o João no Telegram. */
export async function mudarPeloPainel(
  pausar: boolean,
  email: string,
  deps: Pick<DepsComando, 'pausa' | 'agora' | 'modoDoMenu'>,
): Promise<{ mudou: boolean; estado: EstadoPausa; aviso: string | null }> {
  const antes = await deps.pausa.gravar({ pausado: pausar, por: email, quando: deps.agora() });
  const mudou = antes.pausado !== pausar;
  const estado = await deps.pausa.ler();
  const aviso = !mudou
    ? null
    : pausar
      ? `⏸ Menu de suporte PAUSADO pelo painel (${email}).${avisoDoModo(deps.modoDoMenu())}`
      : `▶️ Menu de suporte RETOMADO pelo painel (${email}).${antes.ignoradas > 0 ? `\nCerca de ${antes.ignoradas} mensagem(ns) da pausa ficaram sem resposta.` : ''}`;
  return { mudou, estado, aviso };
}
