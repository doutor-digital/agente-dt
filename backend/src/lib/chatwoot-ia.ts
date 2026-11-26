/**
 * IA no Chatwoot (pedido do João, 12/11/2026) — automação `chatwoot-ia`, por unidade, padrão DESLIGADO.
 *
 * Um receptor só para os eventos do Chatwoot (`POST /api/public/chatwoot/evento?k=…`, webhook da CONTA com `message_created`).
 * Para cada mensagem nova DO PACIENTE numa caixa do mapa:
 *  1. ÁUDIO → transcreve (o mesmo serviço do Kommo) e deixa NOTA PRIVADA «🎙️ Transcrição do áudio».
 *  2. SOFIA → espera 60 s sem o paciente escrever, lê as últimas mensagens públicas da conversa e roda a Sofia com as ferramentas
 *     REAIS (`chatwoot-sofia.ts`: horários, cadastro, agendamento e sinal Pix da franquia; campos, etiquetas e etapa no Chatwoot).
 *     - SECO: as ferramentas de leitura são reais; as que escrevem são simuladas. Nada vai ao paciente: deixa NOTA PRIVADA com o que
 *       ela responderia e as ações que tomaria.
 *     - LIGADO: manda a resposta como mensagem PÚBLICA (e o Pix do sinal numa mensagem só dele, e o endereço depois de marcar) e as
 *       ferramentas gravam de verdade. Deixa uma nota privada curta com o que ela fez.
 *
 * Travas: só mensagem recebida (incoming), não privada, de caixa do mapa, fora de grupo; não roda se a equipe respondeu depois da última
 * fala do paciente (conferido de novo na hora de mandar); não responde conversa já passada à equipe nem paciente em tratamento;
 * NÃO responde paciente com cartão ATIVO no Kommo da unidade (decisão 31: quem atende é o Kommo; só nota) nem quando não dá para
 * conferir o Kommo; teto de rodadas da Sofia por unidade por dia (em memória); chave na URL (o log mascara `k=`).
 */
import { emPausa } from './pausa-unidade.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, contaChatwootDoAmbiente, contasDoChatwoot, contextoDoAmbiente, donaDaConta, ehContaDoAmbiente, tokenParaChaveDaConta, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { configDaUnidade, contaDaCaixa, unidadeDaCaixa } from './chatwoot-unidades.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { aplicarEtiqueta, eventoDeEtiqueta, portasDaPonte, type PortasDaPonte } from './chatwoot-etiquetas.js';
import { eventoDePausa, eventoDeReativacao, pausar, portaDaPausaDoChatwoot, reativar, type PortaDaPausa } from './chatwoot-pausa.js';
import { aplicarResolucao, eventoDeResolucao, portasDoResolver, type PortasDoResolver } from './chatwoot-resolver.js';
import { aplicarReferralDoKapso, mensagemParaConsultar, type ReferralDoKapso } from './kapso-referral.js';
import { etiquetarAnuncio, portasDaOrigem, preencherOrigem, type PortasDaOrigem } from './chatwoot-origem.js';
import { noConviteDoCrm } from './chatwoot-convite-whatsapp.js';
import { notaDoAnuncio, portasDaNota, type PortasDaNota } from './chatwoot-anuncio.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { registrarEventoDaSofia, registrarRespostaDaSofia, ultimaFalaDoPaciente, type EventoDaSofia } from './sofia-avaliacoes.js';
import { portaDoRobo, tokenDoRobo } from './chatwoot-sofia-bot.js';
import { ehMensagemDeEspera } from './crm-demora/marca.js';
import { atendimentoLigado, comecarAtendimento, conferirAtendimento, encerrarAtendimento, eventoDeAtendimento, portaDoAtendimento } from './chatwoot-sofia-atendendo.js';
import { rodarTesteDaSofia } from '../controllers/playground.controller.js';
import { cartaoNoKommoDaUnidade } from './chatwoot-cartao-kommo.js';
import { confereCartaoNoKommo, kommoCortado, tratamentoNaFranquia } from './kommo-cortado.js';
import { consultarFranquia } from './paciente-em-tratamento.js';
import { agendarIndice } from './franquia-indice-telefones.js';
import { foraDoHorarioDaIa } from './chatwoot-horario-da-ia.js';
import type { CartaoNoKommo } from './chatwoot-cartao-kommo.js';
import { portaDoChatwoot, type ConversaLida, type PortaDoChatwoot } from './chatwoot-porta.js';
import { combinadoPelaEquipe, consultaDosAtributos, consultasReaisDoPaciente, diaEHoraNoFuso, divergenciaDoCombinado, idsDaIntegracao, type ConsultaReal } from './chatwoot-horario-combinado.js';
import { SpineService } from '../services/spine.service.js';
import { fusoDaUnidade } from './fuso.js';
import { motivoDeNaoResponder, passarParaEquipeNoChatwoot, rodarSofiaDoChatwoot, type Fala, type ModoDaSofia, type ResultadoDaSofia } from './chatwoot-sofia.js';

export type { Fala };

export const ID_IA = 'chatwoot-ia';
export const ESPERA_SOFIA_MS = 60_000;
export const TETO_SOFIA_POR_DIA = 300;
/** quanto o «Sofia atendendo» espera o anúncio da mesma mensagem terminar de gravar a etiqueta dele */
export const ESPERA_DO_ANUNCIO_MS = 8_000;
/** quantas mensagens públicas da conversa a Sofia lê */
export const MAX_MENSAGENS_LIDAS = 24;
const MAX_TEXTO_ACAO = 160;

export function chaveDoEvento(tokenChatwoot: string): string {
  return createHmac('sha256', tokenChatwoot).update('chatwoot-evento-v1').digest('hex').slice(0, 32);
}

export function chaveDoEventoConfere(tokenChatwoot: string | undefined, recebida: unknown): boolean {
  if (!tokenChatwoot || typeof recebida !== 'string' || recebida.length !== 32) return false;
  const a = Buffer.from(chaveDoEvento(tokenChatwoot));
  const b = Buffer.from(recebida);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MensagemDoPaciente {
  conversa: number;
  caixa: number;
  slug: string;
  audios: string[];
}

/** Corpo do webhook do Chatwoot → mensagem do paciente numa caixa do mapa, ou null. */
export function mensagemDoPaciente(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): MensagemDoPaciente | null {
  if (corpo?.event !== 'message_created') return null;
  const tipo = corpo?.message_type;
  if (!(tipo === 'incoming' || tipo === 0)) return null;
  if (corpo?.private === true) return null;
  const conversa = Number(corpo?.conversation?.id);
  const caixa = Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const slug = caixas[caixa];
  if (!Number.isInteger(conversa) || conversa <= 0 || !slug) return null;
  // grupo de WhatsApp não é paciente
  const ident = String(corpo?.sender?.identifier ?? corpo?.conversation?.meta?.sender?.identifier ?? '');
  if (/@g\.us$/i.test(ident)) return null;
  const anexos: any[] = Array.isArray(corpo?.attachments) ? corpo.attachments : [];
  const audios = anexos.filter((a) => String(a?.file_type) === 'audio' && typeof a?.data_url === 'string').map((a) => String(a.data_url));
  return { conversa, caixa, slug, audios };
}

/**
 * As mensagens do Chatwoot (`/conversations/:id/messages`, em ordem) → falas para a Sofia. Só públicas (nota não entra);
 * entrada = paciente, saída = nós. Áudio sem texto vira a transcrição da nota logo depois, se houver; senão "[áudio]".
 * Junta falas seguidas do mesmo lado. Devolve null se a última fala não é do paciente (a equipe já respondeu).
 */
export function falasDaConversa(mensagens: any[], max = MAX_MENSAGENS_LIDAS): Fala[] | null {
  const transcricoes = new Map<number, string>();
  for (let i = 0; i < mensagens.length; i++) {
    const m = mensagens[i];
    const t = typeof m?.content === 'string' ? m.content : '';
    if (m?.private === true && t.startsWith(PREFIXO_TRANSCRICAO)) {
      // a nota de transcrição vale para o áudio anterior mais perto
      for (let j = i - 1; j >= 0; j--) {
        if (Number(mensagens[j]?.message_type) === 0 && temAudio(mensagens[j])) {
          if (!transcricoes.has(j)) transcricoes.set(j, textoDaTranscricao(t));
          break;
        }
      }
    }
  }
  const falas: Fala[] = [];
  mensagens.forEach((m, i) => {
    const tipo = Number(m?.message_type);
    if (m?.private === true || (tipo !== 0 && tipo !== 1)) return;
    // a nossa mensagem de espera (crm-demora) é invisível para a Sofia: não é a equipe respondendo
    if (ehMensagemDeEspera(m)) return;
    let texto = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!texto && temAudio(m)) texto = transcricoes.get(i) ?? '[áudio]';
    if (!texto && Array.isArray(m?.attachments) && m.attachments.length) texto = '[anexo]';
    if (!texto) return;
    const role: Fala['role'] = tipo === 0 ? 'user' : 'assistant';
    const ultima = falas[falas.length - 1];
    if (ultima && ultima.role === role) ultima.content += `\n${texto}`;
    else falas.push({ role, content: texto });
  });
  if (!falas.length || falas[falas.length - 1]!.role !== 'user') return null;
  // a Sofia começa sempre por uma fala do paciente
  let corte = falas.slice(-max);
  while (corte.length && corte[0]!.role !== 'user') corte = corte.slice(1);
  return corte.length ? corte : null;
}

const temAudio = (m: any) => Array.isArray(m?.attachments) && m.attachments.some((a: any) => String(a?.file_type) === 'audio');
export const PREFIXO_TRANSCRICAO = '🎙️ Transcrição do áudio';
const textoDaTranscricao = (nota: string) => nota.replace(/^🎙️ Transcrição do áudio[^\n]*\n+/, '').replace(/^«|»$/g, '').trim();

export function notaDaTranscricao(texto: string): string {
  return `${PREFIXO_TRANSCRICAO}:\n«${texto.trim()}»`;
}

type Acao = { tool: string; args: Record<string, unknown> };

function linhasDasAcoes(acoes: Acao[]): string[] {
  return acoes.map((a) => {
    const args = Object.entries(a.args ?? {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' · ');
    return `• ${a.tool}${args ? ` — ${args.length > MAX_TEXTO_ACAO ? `${args.slice(0, MAX_TEXTO_ACAO)}…` : args}` : ''}`;
  });
}

/** A nota do seco: o que a Sofia responderia + as ações (ferramentas) que tomaria, em português curto. */
export function notaDaSofia(resposta: string, acoes: Acao[]): string {
  const linhas = [`🧪 [SECO] Sofia responderia:\n\n${resposta.trim() || '(sem texto)'}`];
  if (acoes.length) linhas.push('\nAções que ela tomaria:', ...linhasDasAcoes(acoes));
  return linhas.join('\n');
}

/** A nota do ligado: o que a Sofia fez além de responder (nada a dizer = sem nota). */
export function notaDoLigado(acoes: Acao[]): string | null {
  return acoes.length ? ['🤖 Sofia respondeu por aqui e agiu:', ...linhasDasAcoes(acoes)].join('\n') : null;
}

// ── portas (trocáveis no teste) ────────────────────────────────────────────────────────────────────

export interface PortasDaIa {
  estado(slug: string): Estado;
  unidade(slug: string): Promise<Unit | null>;
  mensagens(conversa: number): Promise<any[]>;
  nota(conversa: number, texto: string): Promise<void>;
  /** mensagem PÚBLICA (chega ao paciente); devolve o usuário do Chatwoot que a mandou (o da integração) e o id da mensagem, se souber */
  publica(conversa: number, texto: string): Promise<{ usuario: number | null; mensagem?: number | null }>;
  /** guarda a resposta da Sofia (id da mensagem no Chatwoot) para os 👍/👎 do balão; opcional (os testes não precisam) */
  registrarResposta?(r: { mensagem: number; conversa: number; slug: string; texto: string; fala: string | null }): Promise<void>;
  /** guarda o que a Sofia FEZ e o painel do Agente conta (marcou, passou para a equipe, Pix que saiu); opcional (os testes não precisam) */
  registrarEvento?(e: EventoDaSofia): Promise<void>;
  /** as consultas de pé deste paciente na franquia; null = não deu para conferir */
  agendaReal(unit: Unit, lida: ConversaLida): Promise<ConsultaReal[] | null>;
  /** passa a conversa para a equipe (etiqueta + etapa + nota); LANÇA se o Chatwoot falhar */
  passarParaEquipe(conversa: number, lida: ConversaLida, motivo: string): Promise<void>;
  transcrever(unit: Unit, url: string): Promise<string>;
  /** a conversa como está agora (atributos, etiquetas, telefone) */
  conversa(conversa: number): Promise<ConversaLida | null>;
  /** cartão ativo no Kommo da unidade para este telefone; null = nenhum (ou unidade sem Kommo); LANÇA se não deu para conferir */
  cartaoNoKommo(unit: Unit, telefone: string): Promise<{ leadId: number } | null>;
  /**
   * Só na unidade que saiu da Kommo (kommo-cortado.ts): o paciente está EM TRATAMENTO na franquia? Devolve o motivo (a Sofia cala) ou null.
   * Nunca lança (franquia fora do ar = null, a Sofia segue). Opcional: os testes que não tratam disso não precisam.
   */
  tratamentoNaFranquia?(unit: Unit, telefone: string): Promise<string | null>;
  sofia(unit: Unit, falas: Fala[], pedido: { conversa: number; modo: ModoDaSofia; lida: ConversaLida }): Promise<ResultadoDaSofia | null>;
  agendar(fn: () => void, ms: number): unknown;
  cancelar(t: unknown): void;
  hoje(): string;
  /** o instante de agora (horário da clínica, feriado); opcional: o teste fixa, o real usa o relógio */
  agora?(): Date;
  /** só com o robô ligado: tira a conversa de «Pendentes» (a Sofia não respondeu; a equipe precisa ver) */
  abrirParaEquipe?(conversa: number): Promise<void>;
  /**
   * Só com o robô ligado e `CHATWOOT_SOFIA_ATENDENDO` != 0 (chatwoot-sofia-atendendo.ts): o paciente escreveu e a Sofia vai atender →
   * a conversa vai para «Abertas» e ganha a etiqueta `sofia-atendendo`.
   */
  comecarAtendimento?(conversa: number, criterio?: (lida: ConversaLida) => Promise<boolean>): Promise<void>;
  /**
   * tira a etiqueta `sofia-atendendo` (a equipe respondeu, a Sofia passou para a equipe, a rodada não pôde responder, unidade desligada/seco).
   * Existe SEMPRE (mesmo com a chave desligada ou sem robô): quem a pôs antes precisa conseguir tirá-la.
   */
  encerrarAtendimento?(conversa: number): Promise<void>;
  /**
   * vem do webhook: com o recurso ligado tira a etiqueta se a conversa mostra que a Sofia saiu (resolvida, pausada, esperando humano);
   * com o recurso DESLIGADO tira a que existir. Existe sempre.
   */
  conferirAtendimento?(conversa: number): Promise<void>;
  /** o recurso está ligado aqui (robô configurado e `CHATWOOT_SOFIA_ATENDENDO` != 0)? Define se o webhook confere ou recolhe. */
  atendimentoAtivo?: boolean;
}

/**
 * O cartão ativo no Kommo que segura a Sofia do CRM (decisão 31). Unidade sem Kommo ou que SAIU da Kommo (kommo-cortado.ts): não consulta.
 * `consultar` só o teste troca.
 */
export async function cartaoNoKommoDaIa(
  unit: Unit,
  telefone: string,
  consultar: (u: Unit) => CartaoNoKommo = (u) => cartaoNoKommoDaUnidade(u),
): Promise<{ leadId: number } | null> {
  if (!confereCartaoNoKommo(unit)) return null;
  return consultar(unit)(telefone);
}

/**
 * Unidade que saiu da Kommo: pergunta à franquia se o telefone é de paciente EM TRATAMENTO (motivo = a Sofia cala; null = segue).
 * Pede antes a carga do índice de telefones (idempotente, 1 por dia): na unidade cortada este é o único caminho que pede — os outros
 * que pedem (paciente-em-tratamento-porta, perdido-reabre, cutucada) são do Kommo, que não recebe mais a unidade. Nunca lança.
 * `deps` só o teste troca.
 */
export async function perguntarTratamentoNaFranquia(
  unit: Unit,
  telefone: string,
  deps: { agendar?: (u: Unit) => void; consultar?: typeof consultarFranquia } = {},
): Promise<string | null> {
  try {
    (deps.agendar ?? agendarIndice)(unit);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug }, `${ID_IA}: não consegui pedir a carga do índice de telefones da franquia`);
  }
  const sinal = await (deps.consultar ?? consultarFranquia)(unit, telefone);
  const motivo = tratamentoNaFranquia(sinal);
  if (!motivo && sinal.tipo === 'indisponivel') {
    logger.warn({ unit: unit.slug, motivo: sinal.motivo }, `${ID_IA}: unidade sem Kommo — a franquia não achou o telefone (${sinal.motivo}); a Sofia segue`);
  }
  return motivo;
}

/** `tokenRobo`: o token do robô DESTA conta (undefined = o de Parauapebas, `CHATWOOT_SOFIA_BOT_TOKEN`; null = sem robô; texto = o da clínica de conta própria). */
export function portasReais(ctx: ContextoChatwoot, opcoes: { tokenRobo?: string | null } = {}): PortasDaIa {
  const chat: PortaDoChatwoot = portaDoChatwoot(ctx);
  // Sofia como ROBÔ do Chatwoot (chatwoot-sofia-bot.ts): só com CHATWOOT_SOFIA_COMO_BOT=1 + CHATWOOT_SOFIA_BOT_TOKEN; senão, null
  const tokenRobo = opcoes.tokenRobo === undefined ? tokenDoRobo() : opcoes.tokenRobo;
  const robo = tokenRobo ? portaDoRobo(ctx, tokenRobo) : null;
  if (robo) logger.info(`${ID_IA}: a Sofia responde como ROBÔ do Chatwoot`);
  // «Sofia atendendo» (chatwoot-sofia-atendendo.ts): só onde há robô — é ele que faz a conversa nascer em «Pendentes»
  const atendimentoAtivo = !!robo && atendimentoLigado();
  // a porta existe sempre: com o recurso desligado ela só serve para TIRAR a etiqueta que um deploy/ligação anterior deixou (abrir não faz nada)
  const atendimento = portaDoAtendimento(ctx, (conversa) => (robo ? robo.abrirParaEquipe(conversa) : Promise.resolve()));
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_IA, process.env.CHATWOOT_IA_SLUGS),
    unidade: (slug) => prisma.unit.findUnique({ where: { slug } }),
    async mensagens(conversa) {
      const r = (await chamar(ctx, 'GET', `conversations/${conversa}/messages`)) as { payload?: unknown[] } | null;
      return Array.isArray(r?.payload) ? r.payload : [];
    },
    nota: (conversa, texto) => chat.nota(conversa, texto),
    // sem o robô, a Sofia sai pelo usuário conector: marca a publicação (content_attributes) para o CRM rotular «✨ Sofia (IA)» e não «modelo automático»
    publica: (conversa, texto) => (robo ? robo.publica(conversa, texto) : chat.publica(conversa, texto, { dd_sofia: true })),
    registrarResposta: (r) => registrarRespostaDaSofia(r),
    registrarEvento: (e) => registrarEventoDaSofia(e),
    async agendaReal(unit, lida) {
      const agora = new Date();
      const fuso = fusoDaUnidade(unit);
      const doAtributo = consultaDosAtributos(lida.attrs, diaEHoraNoFuso(agora.toISOString(), fuso)?.dia ?? '');
      let franquia: ConsultaReal[] | null = null;
      if (unit.spineEnabled && unit.spineToken && lida.telefone) {
        franquia = await consultasReaisDoPaciente(
          {
            async buscarPorNome(nome) {
              const r = await SpineService.searchClients(unit, nome);
              return r.ok && r.data ? r.data.clients : null;
            },
            async agendamentos(idClient) {
              const det = await SpineService.getClient(unit, idClient);
              return det.ok ? (det.data?.client?.schedules ?? []).map((s) => ({ idStatus: s.idStatus ?? null, dateAttendanceUtc: s.dateAttendanceUtc ?? null })) : null;
            },
          },
          { nome: lida.nome, telefone: lida.telefone, fuso, agora },
        ).catch(() => null);
      }
      // a franquia, quando respondeu, é a verdade (inclusive "nenhuma"); o que o Chatwoot guardou só vale se a franquia não deu para conferir
      return franquia ?? (doAtributo ? [doAtributo] : null);
    },
    // robô ligado: conversa em que a Sofia NÃO respondeu vai para «Abertas» (senão ficaria escondida em «Pendentes»)
    abrirParaEquipe: robo ? (conversa) => robo.abrirParaEquipe(conversa) : undefined,
    comecarAtendimento: atendimentoAtivo ? async (conversa, criterio) => void (await comecarAtendimento(conversa, atendimento, criterio)) : undefined,
    encerrarAtendimento: async (conversa) => void (await encerrarAtendimento(conversa, atendimento)),
    conferirAtendimento: async (conversa) => void (await (atendimentoAtivo ? conferirAtendimento : encerrarAtendimento)(conversa, atendimento)),
    atendimentoAtivo,
    async passarParaEquipe(conversa, lida, motivo) {
      await passarParaEquipeNoChatwoot(chat, { conversa, etapa: String(lida.attrs.etapa ?? '').trim(), motivo });
      // robô → equipe: tira de «Pendentes» (a etiqueta e a nota já avisaram; falhar aqui não desfaz a passagem)
      if (robo) await robo.abrirParaEquipe(conversa).catch((err: unknown) => logger.warn({ err: String(err), conversa }, `${ID_IA}: não consegui abrir a conversa para a equipe (robô)`));
    },
    async transcrever(unit, url) {
      return (await transcribeAudio(unit, url)).text;
    },
    conversa: (id) => chat.conversa(id),
    cartaoNoKommo: (unit, telefone) => cartaoNoKommoDaIa(unit, telefone),
    tratamentoNaFranquia: (unit, telefone) => perguntarTratamentoNaFranquia(unit, telefone),
    sofia: (unit, falas, pedido) => rodarSofiaDoChatwoot({ unit, falas, ...pedido, chat }, { rodarTeste: rodarTesteDaSofia }),
    agendar: (fn, ms) => setTimeout(fn, ms),
    cancelar: (t) => clearTimeout(t as NodeJS.Timeout),
    hoje: () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10),
    agora: () => new Date(),
  };
}

export interface MemoriaDaIa {
  esperas: Map<number, unknown>;
  rodadas: Map<string, number>;
  /** `conversa|lead`: a nota «não respondo, tem cartão no Kommo» já foi deixada (uma por cartão por vez que o servidor sobe) */
  avisosDoKommo: Set<string>;
  /** conversas com a Sofia rodando agora: uma rodada por conversa por vez (a nova espera a velha acabar) */
  emAndamento: Set<number>;
  /** `conversa|trecho`: a nota «passaria para a equipe: horário combinado diverge» do seco já foi deixada */
  avisosDeHorario: Set<string>;
  /** o(s) usuário(s) do Chatwoot que mandam as nossas mensagens (para não tomar a fala da Sofia por fala da equipe) */
  usuariosDaIntegracao: Set<number>;
  /** conversa → quando o Registro anotou «Sofia desligada nesta unidade» (uma vez por hora por conversa) */
  registrosDeDesligada: Map<number, number>;
  /** conversa → quando o Registro anotou «fora do horário da IA» (uma vez por hora por conversa: no modo «só fora do expediente» são todas as mensagens do expediente) */
  registrosDeForaDoHorario: Map<number, number>;
  /** conversa → resposta recente de «a rodada vai atender?» (cartão no Kommo é uma ida à API por mensagem; vale ATENDIMENTO_CONFERIDO_MS) */
  atendimentoConferido: Map<number, { em: number; vai: Promise<boolean> }>;
}
export const novaMemoriaDaIa = (): MemoriaDaIa => ({
  esperas: new Map(),
  rodadas: new Map(),
  avisosDoKommo: new Set(),
  emAndamento: new Set(),
  avisosDeHorario: new Set(),
  usuariosDaIntegracao: new Set(),
  registrosDeDesligada: new Map(),
  registrosDeForaDoHorario: new Map(),
  atendimentoConferido: new Map(),
});
/** Se a rodada anterior da mesma conversa ainda não acabou, tenta de novo depois disto. */
export const REPETE_SE_OCUPADA_MS = 15_000;

/** Quanto tempo a resposta de «a rodada vai atender?» vale (várias mensagens seguidas do paciente não repetem a ida ao Kommo). */
export const ATENDIMENTO_CONFERIDO_MS = 30_000;

/**
 * O MESMO critério com que a rodada desiste (teto do dia, sem telefone, cartão ativo no Kommo, Kommo fora do ar), aplicado já na 1ª
 * mensagem: a etiqueta `sofia-atendendo` só entra onde a rodada vai mesmo conversar — senão piscaria a cada mensagem. Não lança.
 */
async function vaiAtender(m: MensagemDoPaciente, lida: ConversaLida, p: PortasDaIa, mem: MemoriaDaIa): Promise<boolean> {
  const antes = mem.atendimentoConferido.get(m.conversa);
  if (antes && Date.now() - antes.em < ATENDIMENTO_CONFERIDO_MS) return antes.vai;
  const decidir = async (): Promise<boolean> => {
    if ((mem.rodadas.get(`${m.slug}|${p.hoje()}`) ?? 0) >= TETO_SOFIA_POR_DIA) return false;
    if (!lida.telefone) return false;
    const unit = await p.unidade(m.slug);
    if (!unit) return false;
    if (emPausa(unit)) return false; // unidade pausada: não ganha o selo «Sofia atendendo»
    if (foraDoHorarioDaIa(unit, p.agora?.())) return false; // fora do horário da IA (expediente, feriado): a equipe atende, sem selo
    if ((await p.cartaoNoKommo(unit, lida.telefone)) !== null) return false;
    // unidade que saiu da Kommo: paciente em tratamento na franquia também não ganha o selo (a rodada vai calar)
    if (kommoCortado(unit.slug) && p.tratamentoNaFranquia && (await p.tratamentoNaFranquia(unit, lida.telefone))) return false;
    return true;
  };
  // a PROMESSA fica guardada: mensagens que chegam enquanto a primeira ainda consulta o Kommo esperam a mesma resposta
  const vai = decidir().catch(() => false);
  if (mem.atendimentoConferido.size > 5000) mem.atendimentoConferido.clear();
  mem.atendimentoConferido.set(m.conversa, { em: Date.now(), vai });
  return vai;
}

/**
 * Uma mensagem do paciente chegou: transcreve o áudio agora; a Sofia, só depois de 60 s quieto (reagenda a cada fala).
 * `depoisDe`: algo que mexe nas ETIQUETAS da mesma conversa e roda junto (o anúncio) — o «Sofia atendendo» espera por isso, porque o Chatwoot
 * substitui a lista inteira e duas gravações simultâneas perdem uma etiqueta.
 */
export async function aoChegar(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa, depoisDe: Promise<unknown> = Promise.resolve()): Promise<void> {
  if (p.estado(m.slug) === 'desligado') {
    // aba Registro: «por que ela não respondeu?» — uma linha por conversa por hora, sem tocar em mais nada
    const antes = mem.registrosDeDesligada.get(m.conversa) ?? 0;
    if (Date.now() - antes >= 3_600_000 && p.registrarEvento) {
      mem.registrosDeDesligada.set(m.conversa, Date.now());
      if (mem.registrosDeDesligada.size > 5000) mem.registrosDeDesligada.clear();
      await p.registrarEvento({ slug: m.slug, conversa: m.conversa, tipo: 'decisao', nome: 'unidade-pausada' }).catch(() => undefined);
    }
    if (p.abrirParaEquipe) await p.abrirParaEquipe(m.conversa).catch(() => undefined);
    // unidade desligada: a Sofia não atende — se a conversa ficou com a etiqueta de quando estava ligada, ela sai
    await p.encerrarAtendimento?.(m.conversa).catch((err: unknown) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui tirar a etiqueta sofia-atendendo`));
    return;
  }
  // «Abertas» + etiqueta `sofia-atendendo` já na 1ª mensagem (só no LIGADO: no seco a Sofia não responde e a etiqueta mentiria)
  const comecar = p.comecarAtendimento;
  if (comecar && p.estado(m.slug) === 'ligado') {
    void depoisDe
      .then(() => comecar(m.conversa, (lida) => vaiAtender(m, lida, p, mem)))
      .catch((err: unknown) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui abrir a conversa / pôr a etiqueta sofia-atendendo`));
  }
  if (m.audios.length) {
    const unit = await p.unidade(m.slug);
    if (unit) {
      for (const url of m.audios) {
        try {
          const texto = await p.transcrever(unit, url);
          if (texto.trim()) await p.nota(m.conversa, notaDaTranscricao(texto));
        } catch (err) {
          logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui transcrever o áudio`);
        }
      }
    }
  }
  const antes = mem.esperas.get(m.conversa);
  if (antes !== undefined) p.cancelar(antes);
  const disparar = () => {
    mem.esperas.delete(m.conversa);
    rodarSofia(m, p, mem)
      .then((d) => {
        if (d === 'ocupada') mem.esperas.set(m.conversa, p.agendar(disparar, REPETE_SE_OCUPADA_MS));
      })
      .catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: a rodada da Sofia falhou`));
  };
  mem.esperas.set(m.conversa, p.agendar(disparar, ESPERA_SOFIA_MS));
}

export type Desfecho =
  | 'nota'
  | 'enviada'
  | 'sem-texto'
  | 'equipe-respondeu'
  | 'mudou'
  | 'teto'
  | 'sem-unidade'
  | 'falhou'
  | 'desligado'
  | 'calada'
  | 'sem-telefone'
  | 'ocupada'
  | 'horario-divergente'
  | 'cartao-no-kommo'
  | 'kommo-indisponivel'
  | 'pausada-pela-unidade'
  | 'fora-do-horario';

/**
 * A «assinatura» das mensagens PÚBLICAS da conversa: quantas são e qual é a última (pelo id do Chatwoot; sem id, pelo texto).
 * Mudou entre o começo e o fim da rodada = o paciente escreveu, a equipe respondeu ou outra cópia do servidor já respondeu.
 */
export function assinaturaDaConversa(mensagens: any[]): string {
  const publicas = mensagens.filter((m) => m?.private !== true && (Number(m?.message_type) === 0 || Number(m?.message_type) === 1) && !ehMensagemDeEspera(m));
  const ultima = publicas.at(-1);
  return `${publicas.length}|${ultima?.id ?? ultima?.content ?? ''}`;
}

/** Ferramentas que gravam na franquia ou no Asaas: se a rodada as usou, descartar a resposta deixa a equipe com trabalho a conferir. */
const FERRAMENTAS_QUE_GRAVAM = new Set(['cadastrar_paciente', 'agendar_consulta', 'remarcar_consulta', 'cancelar_consulta', 'gerar_sinal_pix']);

export async function rodarSofia(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa): Promise<Desfecho> {
  const modo = p.estado(m.slug);
  if (modo === 'desligado') {
    await p.encerrarAtendimento?.(m.conversa).catch((err: unknown) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui tirar a etiqueta sofia-atendendo`));
    return 'desligado';
  }
  if (mem.emAndamento.has(m.conversa)) return 'ocupada';
  mem.emAndamento.add(m.conversa);
  const info: InfoDaRodada = {};
  let desfecho: Desfecho = 'falhou';
  try {
    desfecho = await rodarSofiaDessaConversa(m, p, mem, modo, info);
    return desfecho;
  } finally {
    mem.emAndamento.delete(m.conversa);
    // robô ligado: a Sofia não respondeu o paciente nesta rodada → a equipe precisa ver a conversa em «Abertas»
    if (p.abrirParaEquipe && desfecho !== 'enviada' && desfecho !== 'ocupada') {
      await p.abrirParaEquipe(m.conversa).catch((err: unknown) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui abrir a conversa para a equipe`));
    }
    // a Sofia não vai mais responder nesta conversa (por ora): a etiqueta `sofia-atendendo` sai. Desfecho que ela vai tentar de novo
    // (`mudou`: o paciente escreveu outra vez; `ocupada`) não mexe aqui.
    if (p.encerrarAtendimento && DESFECHOS_QUE_ENCERRAM.has(desfecho)) {
      await p.encerrarAtendimento(m.conversa).catch((err: unknown) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui tirar a etiqueta sofia-atendendo`));
    }
    // aba Registro: a rodada em que ela NÃO respondeu ao paciente, e por quê (a resposta enviada já fica em sofia_mensagem)
    if (DESFECHOS_DO_REGISTRO.has(desfecho) && p.registrarEvento) {
      await p
        .registrarEvento({ slug: m.slug, conversa: m.conversa, tipo: 'decisao', nome: desfecho, detalhe: info.motivo ?? null })
        .catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui gravar a decisão no Registro`));
    }
  }
}

/** Desfechos em que a Sofia NÃO respondeu e não vai tentar de novo sozinha: a equipe é quem precisa olhar (a etiqueta «Sofia atendendo» sai). */
export const DESFECHOS_QUE_ENCERRAM: ReadonlySet<Desfecho> = new Set<Desfecho>([
  // `nota` = seco: a Sofia só deixa nota, não atende — a etiqueta de quando a unidade estava ligada não pode ficar
  'nota',
  'sem-texto',
  'teto',
  'sem-unidade',
  'falhou',
  'calada',
  'sem-telefone',
  'horario-divergente',
  'cartao-no-kommo',
  'kommo-indisponivel',
  // a unidade está pausada (recepção ou painel Agente): a Sofia não atende, então a etiqueta «Sofia atendendo» não pode ficar
  'pausada-pela-unidade',
  // fora do horário da IA (expediente da clínica, feriado): a equipe atende, a etiqueta «Sofia atendendo» não pode ficar
  'fora-do-horario',
  // a última fala pública é nossa: a equipe respondeu (a pausa já teria tirado a etiqueta; se ela falhou, é aqui que sai) — se fosse a Sofia
  // mesma de outra cópia do servidor, a próxima mensagem do paciente repõe
  'equipe-respondeu',
]);

/** O que a rodada conta para o Registro além do desfecho (ex.: por que ficou calada). */
interface InfoDaRodada {
  motivo?: string;
}
/** Desfechos que viram linha «não respondeu» no Registro (enviada já está em sofia_mensagem; ocupada é só uma nova tentativa). */
export const DESFECHOS_DO_REGISTRO: ReadonlySet<Desfecho> = new Set<Desfecho>([
  'nota',
  'sem-texto',
  'equipe-respondeu',
  'mudou',
  'teto',
  'sem-unidade',
  'falhou',
  'calada',
  'sem-telefone',
  'horario-divergente',
  'cartao-no-kommo',
  'kommo-indisponivel',
  'pausada-pela-unidade',
]);

async function rodarSofiaDessaConversa(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa, modo: ModoDaSofia, info: InfoDaRodada = {}): Promise<Desfecho> {
  const chaveDia = `${m.slug}|${p.hoje()}`;
  // o painel do Agente conta daqui; falhar ao gravar não atrapalha o paciente
  const evento = async (tipo: EventoDaSofia['tipo'], extra: { nome?: string | null; detalhe?: string | null } = {}) => {
    // nunca atrapalha o paciente: nem a promessa recusada nem uma exceção síncrona da porta sobem daqui
    try {
      await p.registrarEvento?.({ slug: m.slug, conversa: m.conversa, tipo, ...extra });
    } catch (err) {
      logger.warn({ err: String(err), conversa: m.conversa, tipo }, `${ID_IA}: não consegui gravar o evento para o painel`);
    }
  };
  if ((mem.rodadas.get(chaveDia) ?? 0) >= TETO_SOFIA_POR_DIA) return 'teto';
  const mensagens = await p.mensagens(m.conversa);
  const falas = falasDaConversa(mensagens);
  if (!falas) return 'equipe-respondeu';
  const unit = await p.unidade(m.slug);
  if (!unit) return 'sem-unidade';
  // PAUSA DA UNIDADE (colunas `pausa_*`: a página /pausa da recepção e o botão do painel Agente): a Sofia do CRM também respeita, como o Kommo. A mensagem do
  // paciente fica sem resposta da Sofia (a equipe vê no Registro) e ela NÃO responde sozinha quando a pausa acaba. Sem pausa, nada muda.
  if (emPausa(unit)) {
    // texto fixo: o motivo digitado e quem pausou aparecem na faixa do painel (qualquer atendente da unidade vê), mas NÃO se repetem em cada linha do Registro
    info.motivo = 'pausa da clínica';
    logger.info({ conversa: m.conversa, unit: m.slug }, `${ID_IA}: unidade pausada — a Sofia não responde`);
    return 'pausada-pela-unidade';
  }

  // HORÁRIO DA IA (`business_hours_*`, `business_hours_expediente`, feriado nacional): o mesmo portão da Sofia do Kommo. Fora da janela a equipe atende
  // e a Sofia fica calada; no modo «só fora do expediente» (Caxias, Petrópolis, Taubaté) é o contrário: calada DENTRO do expediente. Unidade sem
  // `business_hours_enabled` (Parauapebas) nunca cai aqui — 24 h como sempre. Conferido na hora de rodar (60 s depois da fala), não na da mensagem.
  if (foraDoHorarioDaIa(unit, p.agora?.())) {
    info.motivo = 'fora do horário da IA';
    logger.info({ conversa: m.conversa, unit: m.slug }, `${ID_IA}: fora do horário da IA nesta unidade — a Sofia não responde`);
    // aba Registro: uma linha por conversa por hora (no modo «só fora do expediente» seriam todas as mensagens do expediente); por isso não está em DESFECHOS_DO_REGISTRO
    const antes = mem.registrosDeForaDoHorario.get(m.conversa) ?? 0;
    if (Date.now() - antes >= 3_600_000 && p.registrarEvento) {
      mem.registrosDeForaDoHorario.set(m.conversa, Date.now());
      if (mem.registrosDeForaDoHorario.size > 5000) mem.registrosDeForaDoHorario.clear();
      await p.registrarEvento({ slug: m.slug, conversa: m.conversa, tipo: 'decisao', nome: 'fora-do-horario', detalhe: info.motivo }).catch(() => undefined);
    }
    return 'fora-do-horario';
  }

  // a conversa como está agora: já passada à equipe, em tratamento, grupo → calada; sem telefone não dá para conferir o Kommo nem a agenda
  const lida = await p.conversa(m.conversa);
  if (!lida) return 'falhou';
  const calar = motivoDeNaoResponder(lida);
  if (calar) {
    logger.info({ conversa: m.conversa, motivo: calar }, `${ID_IA}: a Sofia fica calada`);
    info.motivo = calar;
    return 'calada';
  }
  if (!lida.telefone) {
    logger.warn({ conversa: m.conversa }, `${ID_IA}: conversa sem telefone — a Sofia não responde`);
    return 'sem-telefone';
  }

  // cartão ATIVO no Kommo da unidade: quem atende é o Kommo (decisão 31). Se não deu para conferir, não responde (melhor calar que duplicar).
  let cartao: { leadId: number } | null;
  try {
    cartao = await p.cartaoNoKommo(unit, lida.telefone);
  } catch (err) {
    logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui conferir o Kommo — a Sofia não responde`);
    return 'kommo-indisponivel';
  }
  if (cartao) {
    info.motivo = `lead ${cartao.leadId} no Kommo`;
    const aviso = `${m.conversa}|${cartao.leadId}`;
    if (!mem.avisosDoKommo.has(aviso)) {
      mem.avisosDoKommo.add(aviso);
      await p.nota(
        m.conversa,
        `${modo === 'seco' ? '🧪 [SECO] ' : '⏸ '}Sofia NÃO responde aqui: este paciente tem cartão ATIVO no Kommo (lead ${cartao.leadId}). Quem atende é o Kommo; nada foi enviado.`,
      );
    }
    return 'cartao-no-kommo';
  }

  // unidade que SAIU da Kommo (kommo-cortado.ts): a trava do cartão não vale mais, e ela era quem segurava o paciente EM TRATAMENTO
  // (cartão ativo no funil TRATAMENTO). Aqui quem responde é a franquia: tratamento ativo ou sessão futura = a Sofia não responde.
  if (kommoCortado(unit.slug) && p.tratamentoNaFranquia) {
    const tratamento = await p.tratamentoNaFranquia(unit, lida.telefone);
    if (tratamento) {
      info.motivo = tratamento;
      const aviso = `${m.conversa}|tratamento`;
      if (!mem.avisosDoKommo.has(aviso)) {
        mem.avisosDoKommo.add(aviso);
        await p.nota(m.conversa, `${modo === 'seco' ? '🧪 [SECO] ' : '⏸ '}Sofia NÃO responde aqui: ${tratamento}. Quem atende é a equipe; nada foi enviado.`);
      }
      return 'calada';
    }
  }

  // a equipe já combinou horário na conversa e não bate com a agenda da franquia: a Sofia não afirma horário nenhum, passa para a equipe
  const combinado = combinadoPelaEquipe(mensagens, new Set([...idsDaIntegracao(mensagens), ...mem.usuariosDaIntegracao]));
  if (combinado) {
    const reais = await p.agendaReal(unit, lida).catch((err) => {
      logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui conferir a agenda para o horário combinado`);
      return null;
    });
    const divergencia = divergenciaDoCombinado(combinado, reais);
    if (divergencia) {
      const motivo = `${divergencia}. A Sofia não confirma horário por conta própria: confira com o paciente.`;
      if (modo === 'seco') {
        const aviso = `${m.conversa}|${combinado.trecho}`;
        if (!mem.avisosDeHorario.has(aviso)) {
          mem.avisosDeHorario.add(aviso);
          await p.nota(m.conversa, `🧪 [SECO] Sofia passaria esta conversa para a equipe e não responderia: ${motivo}`);
        }
      } else {
        try {
          await p.passarParaEquipe(m.conversa, lida, motivo);
        } catch (err) {
          logger.error({ err: String(err), conversa: m.conversa }, `${ID_IA}: horário combinado diverge da agenda, mas não consegui passar para a equipe`);
          return 'falhou';
        }
        await evento('equipe', { detalhe: 'horario-divergente' });
      }
      return 'horario-divergente';
    }
  }

  // confere e conta num passo só (sem await no meio): duas conversas rodando juntas não perdem incremento nem passam do teto
  const feitas = mem.rodadas.get(chaveDia) ?? 0;
  if (feitas >= TETO_SOFIA_POR_DIA) return 'teto';
  mem.rodadas.set(chaveDia, feitas + 1);
  const r = await p.sofia(unit, falas, { conversa: m.conversa, modo, lida });
  if (!r) {
    // o paciente ficaria sem resposta e sem aviso: no ligado a equipe é avisada (no seco o erro já está no log)
    if (modo === 'ligado') await p.nota(m.conversa, '⚠ A Sofia não conseguiu responder agora (falha do modelo ou das ferramentas). A mensagem do paciente está sem resposta: responda por aqui.').catch(() => undefined);
    return 'falhou';
  }

  if (modo === 'seco') {
    await p.nota(m.conversa, notaDaSofia(r.resposta, r.acoes));
    return 'nota';
  }
  // o que ela FEZ conta agora (a resposta pode ser descartada logo abaixo): consulta marcada na franquia, passagem para a equipe
  if (r.agendou) await evento('marcou', { nome: lida.nome || null, detalhe: `${r.agendou.data}T${r.agendou.hora}` });
  if (r.passouParaEquipe) {
    if (!r.motivoDaPassagem) logger.info({ conversa: m.conversa }, `${ID_IA}: passou para a equipe sem categoria de motivo (a tela mostra «sem motivo registrado»)`);
    await evento('equipe', { detalhe: r.motivoDaPassagem ?? null });
    // a Sofia passou a conversa: a etiqueta sai (o webhook da etiqueta `esperando-humano` também conferiria, isto é só mais cedo)
    await p.encerrarAtendimento?.(m.conversa).catch((err: unknown) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui tirar a etiqueta sofia-atendendo`));
  }

  // ligado: o paciente pode ter escrito de novo (ou a equipe respondido, ou outra cópia do servidor) enquanto a Sofia pensava
  const gravou = r.acoes.some((a) => FERRAMENTAS_QUE_GRAVAM.has(a.tool));
  const alerta = (porque: string) =>
    [`⚠ A Sofia agiu mas a resposta ao paciente NÃO saiu (${porque}). Confira com ele o que foi feito:`, ...(notaDoLigado(r.acoes)?.split('\n').slice(1) ?? [])].join('\n');
  const depois = await p.mensagens(m.conversa).catch((err) => {
    logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui reler a conversa antes de responder`);
    return null;
  });
  if (!depois || assinaturaDaConversa(depois) !== assinaturaDaConversa(mensagens) || !falasDaConversa(depois)) {
    logger.info({ conversa: m.conversa, gravou }, `${ID_IA}: a conversa mudou enquanto a Sofia pensava — resposta descartada`);
    const nota = gravou ? alerta('a conversa mudou enquanto ela pensava') : notaDoLigado(r.acoes);
    if (nota) await p.nota(m.conversa, nota).catch(() => undefined);
    return 'mudou';
  }
  // a equipe pode ter assumido a conversa (etiqueta, etapa, marca de interno) enquanto ela pensava, sem escrever nada
  const agoraLida = await p.conversa(m.conversa).catch(() => null);
  const calou = agoraLida ? motivoDeNaoResponder(agoraLida) : null;
  if (calou) {
    info.motivo = calou;
    logger.info({ conversa: m.conversa, motivo: calou, gravou }, `${ID_IA}: a conversa passou para a equipe enquanto a Sofia pensava — resposta descartada`);
    const nota = gravou ? alerta(`a conversa passou para a equipe (${calou}) enquanto ela pensava`) : null;
    if (nota) await p.nota(m.conversa, nota).catch(() => undefined);
    return 'mudou';
  }
  // a clínica pode ter aberto (modo «só fora do expediente») ou fechado enquanto a Sofia pensava: a resposta não sai por cima da equipe
  if (foraDoHorarioDaIa(unit, p.agora?.())) {
    info.motivo = 'fora do horário da IA';
    logger.info({ conversa: m.conversa, gravou }, `${ID_IA}: o horário da IA acabou enquanto a Sofia pensava — resposta descartada`);
    if (gravou) await p.nota(m.conversa, alerta('o horário da Sofia acabou enquanto ela pensava')).catch(() => undefined);
    return 'fora-do-horario';
  }
  if (!r.resposta || r.semResposta) {
    if (gravou) await p.nota(m.conversa, alerta('o modelo não escreveu a resposta')).catch(() => undefined);
    return 'sem-texto';
  }
  try {
    const enviada = await p.publica(m.conversa, r.resposta);
    if (enviada?.usuario) mem.usuariosDaIntegracao.add(enviada.usuario);
    // a resposta ganha 👍/👎 no balão do Chatwoot (tela Agente); falhar aqui não atrapalha o paciente
    if (enviada?.mensagem && p.registrarResposta)
      await p
        .registrarResposta({ mensagem: enviada.mensagem, conversa: m.conversa, slug: m.slug, texto: r.resposta, fala: ultimaFalaDoPaciente(falas) })
        .catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui guardar a resposta para a avaliação`));
  } catch (err) {
    // as ferramentas já gravaram: sem resposta o paciente fica sem saber. A equipe é avisada (nota) e a exceção sobe para o log.
    logger.error({ err: String(err), conversa: m.conversa, gravou }, `${ID_IA}: não consegui mandar a resposta da Sofia`);
    if (gravou) await p.nota(m.conversa, alerta('o Chatwoot recusou a mensagem')).catch(() => undefined);
    throw err;
  }
  // o Pix e o endereço são mensagens à parte: falhar nelas não desfaz o que já foi
  for (const extra of [r.pix, r.cartao]) {
    if (!extra) continue;
    const saiu = await p
      .publica(m.conversa, extra)
      .then(() => true)
      .catch((err) => {
        logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: não consegui mandar a mensagem extra (Pix/endereço)`);
        return false;
      });
    if (saiu && extra === r.pix) await evento('pix');
  }
  const nota = notaDoLigado(r.acoes);
  if (nota) await p.nota(m.conversa, nota).catch(() => undefined);
  return 'enviada';
}

// ── a rota ─────────────────────────────────────────────────────────────────────────────────────────

/** Tudo o que a IA precisa DE UMA CONTA do Chatwoot: as portas, a memória (debounce, rodadas, avisos) e a trava das etiquetas. Uma por conta. */
export interface EstadoDaConta {
  portas: PortasDaIa;
  mem: MemoriaDaIa;
  ponte: PortasDaPonte;
  pausa: PortaDaPausa;
  resolver: PortasDoResolver;
  origem: PortasDaOrigem;
  chat: PortaDoChatwoot;
  nota: PortasDaNota;
  /** a trava de «Perdido: motivo» por conversa — o id da conversa é POR CONTA, então a trava também */
  trava: Set<number>;
}

const estados = new Map<number, { assinatura: string; estado: EstadoDaConta }>();

/** Só para os testes: esquece os estados guardados. */
export const esquecerEstadosDaIa = (): void => estados.clear();

/**
 * O estado da IA da CONTA `conta` (id no Chatwoot). A conta do ambiente (Parauapebas) monta exatamente o que sempre montou: o mesmo contexto,
 * o robô do `CHATWOOT_SOFIA_BOT_TOKEN` e uma memória nova. Uma conta própria usa o contexto/token dela e o robô DELA (ou nenhum): a memória
 * nunca é compartilhada, porque a conversa 5 de uma conta não é a conversa 5 de outra. `null` = conta sem unidade/token: não responde.
 */
export function estadoDoReceptor(conta: number, e: NodeJS.ProcessEnv = process.env): EstadoDaConta | null {
  const base = contextoDoAmbiente(e);
  if (!base) return null;
  const ehAmbiente = ehContaDoAmbiente(conta, e);
  const dona = ehAmbiente ? { slug: null, ctx: base } : donaDaConta(base, conta, e);
  const contaDoCtx = dona?.ctx.conta;
  if (!dona || !contaDoCtx) {
    estados.delete(conta); // a configuração recarregou e nenhuma unidade usa mais essa conta
    return null;
  }
  const ctx = dona.ctx;
  const sufixo = dona.slug ? configDaUnidade(dona.slug)?.envSufixo : undefined;
  const tokenRobo = ehAmbiente ? tokenDoRobo(e) : tokenDoRobo(e, sufixo);
  // o que alimenta as portas: se a configuração recarregou e algo disso mudou (conta, token, robô), as portas são refeitas — a MEMÓRIA e a trava
  // ficam (uma rodada em andamento não pode ser esquecida, senão a Sofia responderia duas vezes)
  const assinatura = [contaDoCtx.url, contaDoCtx.conta, contaDoCtx.token, tokenRobo ?? ''].join('\u0000');
  const guardado = estados.get(conta);
  if (guardado && guardado.assinatura === assinatura) return guardado.estado;
  const origem = portasDaOrigem(ctx);
  const novo: EstadoDaConta = {
    portas: portasReais(ctx, ehAmbiente ? {} : { tokenRobo }),
    mem: guardado?.estado.mem ?? novaMemoriaDaIa(),
    ponte: portasDaPonte(ctx),
    pausa: portaDaPausaDoChatwoot(ctx),
    resolver: portasDoResolver(ctx),
    origem,
    chat: portaDoChatwoot(ctx),
    nota: portasDaNota(ctx, origem),
    trava: guardado?.estado.trava ?? new Set(),
  };
  estados.set(conta, { assinatura, estado: novo });
  return novo;
}

/**
 * De que conta é este evento? Do `account.id` do payload, conferido com a caixa; sem `account` no payload, pela caixa; sem nenhum dos dois, a
 * conta do ambiente (como sempre foi). Conta que o servidor não conhece, caixa de OUTRA conta que a do payload, ou clínica sem conta válida:
 * IGNORA (o chamador avisa no log) — nunca cai na conta 1.
 */
export function contaDoEvento(corpo: any, e: NodeJS.ProcessEnv = process.env): { conta: number } | { ignorar: string } {
  const amb = contaChatwootDoAmbiente(e);
  if (!amb) return { ignorar: 'o Chatwoot não está configurado neste servidor' };
  const idDoPayload = Number(corpo?.account?.id);
  const noPayload = Number.isInteger(idDoPayload) && idDoPayload > 0 ? idDoPayload : null;
  const caixa = Number(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id ?? corpo?.inbox_id);
  let daCaixa: number | null = null;
  if (Number.isInteger(caixa) && caixa > 0 && unidadeDaCaixa(caixa)) {
    const c = contaDaCaixa(caixa);
    if (c === undefined) return { ignorar: `a caixa ${caixa} é de uma unidade sem conta válida` };
    daCaixa = c ?? amb.conta;
  }
  if (noPayload !== null) {
    if (!contasDoChatwoot(e).includes(noPayload)) return { ignorar: `conta ${noPayload} desconhecida` };
    if (daCaixa !== null && daCaixa !== noPayload) return { ignorar: `a caixa ${caixa} é da conta ${daCaixa}, mas o evento veio da conta ${noPayload}` };
    return { conta: noPayload };
  }
  return { conta: daCaixa ?? amb.conta };
}

const ignoradosAvisados = new Map<string, number>();
/** Um aviso por motivo a cada 10 min (conta errada pode mandar milhares de eventos). */
function avisarIgnorado(motivo: string, corpo: any): void {
  const agora = Date.now();
  if ((ignoradosAvisados.get(motivo) ?? 0) > agora - 600_000) return;
  if (ignoradosAvisados.size > 200) ignoradosAvisados.clear();
  ignoradosAvisados.set(motivo, agora);
  logger.warn({ motivo, evento: String(corpo?.event ?? '') }, `${ID_IA}: evento do Chatwoot IGNORADO — ${motivo}`);
}

/** O que cada parte do `aoAcharReferral` fez (o retroativo conta isso por conversa; o webhook ignora). */
export interface DetalheDoAoAchar {
  /** `sim` = ficou etiquetada; `nao-ad` = publicação/etiqueta desligada (nada a fazer); `falhou`; `sem-estado` = conta sem estado da IA */
  etiqueta: 'sim' | 'nao-ad' | 'falhou' | 'sem-estado';
  /** `notaDoAnuncio`: com-imagem | so-texto | desligado | nada | falhou; `ja-existia` = a linha já estava guardada (nota só na 1ª vez) */
  nota: string;
  /** `preencherOrigem`: gravado | seco | desligado | nada (nada a preencher, ou erro — o motivo fica no log) */
  origem: string;
}

/**
 * O que se faz quando o referral de anúncio de uma mensagem foi achado (webhook e retroativo usam ESTE caminho): etiqueta `anuncio`, nota
 * «Veio do anúncio» (só na 1ª vez) e Origem/Campanha/Conjunto no contato. `r` null = conta sem estado: não faz nada.
 */
export function aoAcharReferral(r: EstadoDaConta | null): (m: { conversa: number; caixa: number; contato: number | null }, ref: ReferralDoKapso, novo: boolean) => Promise<DetalheDoAoAchar> {
  return async (m, ref, novo) => {
    if (!r) return { etiqueta: 'sem-estado', nota: 'sem-estado', origem: 'sem-estado' };
    // etiqueta «anuncio» na conversa (informação: vale com a origem desligada) — chatwoot-origem.ts
    const etiquetou = await etiquetarAnuncio(m.conversa, ref, (c, e) => r.chat.adicionarEtiquetas(c, e));
    const slug = CAIXAS_REGUA[m.caixa];
    // juntas (nenhuma das duas lança): a origem é dado e não espera o download/envio da imagem da nota
    const [nota, origem] = await Promise.all([
      // o «cartão» do anúncio (título, texto, imagem, link) numa nota interna, só na 1ª vez — chatwoot-anuncio.ts
      novo ? notaDoAnuncio({ conversa: m.conversa, slug, ref }, r.nota) : Promise.resolve('ja-existia'),
      slug && m.contato ? preencherOrigem({ slug, contato: m.contato, conversa: m.conversa, ref }, r.origem) : Promise.resolve('sem-contato-ou-unidade'),
    ]);
    return { etiqueta: etiquetou ? 'sim' : ref.tipo === 'ad' && process.env.CHATWOOT_ETIQUETA_ANUNCIO !== '0' ? 'falhou' : 'nao-ad', nota, origem };
  };
}

/** Espera `p` por no máximo `ms` (o relógio é desarmado quando `p` termina). Nunca rejeita. */
function esperarNoMaximo(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((ok) => {
    const t = setTimeout(ok, ms);
    t.unref();
    void p.then(
      () => (clearTimeout(t), ok()),
      () => (clearTimeout(t), ok()),
    );
  });
}

export function eventoChatwootHandler(req: Request, res: Response): void {
  // A chave é DA CONTA a que o evento diz pertencer (derivada do token dela): a chave de Parauapebas não forja evento de outra clínica e vice-versa.
  // Evento que não é de conta nenhuma que o servidor conheça só passa com a chave do ambiente (e é ignorado com aviso logo abaixo).
  const alvo = contaDoEvento(req.body);
  const token = 'conta' in alvo ? tokenParaChaveDaConta(alvo.conta) : process.env.CHATWOOT_API_TOKEN?.trim();
  if (!chaveDoEventoConfere(token, req.query.k)) {
    res.status(401).json({ error: 'chave inválida' });
    return;
  }
  res.json({ ok: true });
  if ('ignorar' in alvo) {
    avisarIgnorado(alvo.ignorar, req.body);
    return;
  }
  const conta = alvo.conta;
  // pessoa respondeu (pelo Chatwoot ou pelo celular) → pausa a IA nesta conversa; conversa resolvida → reativa (chatwoot-pausa.ts)
  const pausa = eventoDePausa(req.body);
  if (pausa) {
    const e = estadoDoReceptor(conta);
    if (e) {
      void (async () => {
        const falhou = (o: string) => (err: unknown) => logger.warn({ err: String(err), conversa: pausa.conversa }, `chatwoot-pausa: não consegui ${o}`);
        await pausar(pausa.conversa, pausa.autor, e.pausa).catch(falhou('pausar'));
        // cada passo é independente: pausar falhar (atribuição, nota) não deixa a conversa em «Pendentes» nem com «Sofia atendendo»
        // robô ligado: quem respondeu (inclusive pelo celular) está atendendo — a conversa sai de «Pendentes»
        await e.portas.abrirParaEquipe?.(pausa.conversa).catch(falhou('abrir a conversa'));
        await e.portas.encerrarAtendimento?.(pausa.conversa).catch(falhou('tirar a etiqueta sofia-atendendo'));
      })();
    }
    return;
  }
  // Um mesmo `conversation_updated` pode pedir até quatro coisas, e TODAS regravam a lista de etiquetas da conversa (o Chatwoot a substitui
  // inteira): rodam UMA DEPOIS DA OUTRA, não em paralelo — em paralelo cada uma leria a lista velha e a última a gravar desfaria as outras.
  // O resolver vai primeiro porque grava a lista que veio no AVISO (+ falta-etapa); as seguintes releem a lista e não a desfazem.
  const resol = eventoDeResolucao(req.body); // resolvida sem os campos obrigatórios → etiqueta falta-etapa; completou depois → tira
  const reativa = eventoDeReativacao(req.body); // resolvida e pausada → reativa a IA
  const atend = eventoDeAtendimento(req.body, undefined, { recolherSempre: estadoDoReceptor(conta)?.portas.atendimentoAtivo === false }); // etiqueta `sofia-atendendo` numa conversa em que a Sofia já saiu → tira
  const etq = eventoDeEtiqueta(req.body); // botão "Perdido: <motivo>" → etiqueta → etapa + motivo no cartão
  if (resol?.acao || reativa || atend || etq) {
    const e = estadoDoReceptor(conta);
    if (e) {
      void (async () => {
        const passo = async (de: string, conversa: number, fn: () => Promise<unknown>) => {
          try {
            await fn();
          } catch (err) {
            logger.warn({ err: String(err), conversa }, `${de}: falhou`);
          }
        };
        if (resol?.acao) await passo('chatwoot-resolver', resol.conversa, () => aplicarResolucao(resol, e.resolver));
        if (reativa) await passo('chatwoot-pausa (reativar)', reativa.conversa, () => reativar(reativa.conversa, null, e.pausa));
        if (atend && e.portas.conferirAtendimento) await passo(`${ID_IA} (etiqueta sofia-atendendo)`, atend.conversa, () => e.portas.conferirAtendimento!(atend.conversa));
        if (etq) await passo('chatwoot-etiquetas', etq.conversa, () => aplicarEtiqueta(etq, e.ponte, e.trava));
      })();
    }
  }
  if (etq) return;
  // o código do anúncio: o referral que o Chatwoot já traz na mensagem, ou (sem ele) o que o Kapso diz — guarda e aplica (kapso-referral.ts)
  const consultar = mensagemParaConsultar(req.body);
  let anuncioPronto: Promise<unknown> = Promise.resolve();
  if (consultar) {
    const r = estadoDoReceptor(conta);
    anuncioPronto = aplicarReferralDoKapso(consultar, {
      aoAchar: aoAcharReferral(r),
    }).catch(() => undefined);
  }
  // ROBÔ «CONVITE AO WHATSAPP» (chave `convite-whatsapp`, chatwoot-convite-whatsapp.ts): lead que escreve numa caixa de Instagram/Facebook recebe UM convite
  // com o link do WhatsApp da clínica (não é a Sofia; essas caixas nem estão no mapa de caixas) e, no WhatsApp, o texto pronto do convite marca a origem.
  // Evento que não é nosso volta na hora; chave desligada não lê nem escreve nada. Nunca lança.
  void noConviteDoCrm(req.body, conta);
  const m = mensagemDoPaciente(req.body);
  if (!m) return;
  const e = estadoDoReceptor(conta);
  if (!e) return;
  // o «Sofia atendendo» espera o anúncio gravar a etiqueta `anuncio` (no máximo 8 s): as duas regravam a lista de etiquetas da conversa
  void aoChegar(m, e.portas, e.mem, esperarNoMaximo(anuncioPronto, ESPERA_DO_ANUNCIO_MS)).catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: evento falhou`));
}
