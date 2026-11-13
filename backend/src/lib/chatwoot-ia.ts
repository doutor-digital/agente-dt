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
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { chamar, contaChatwootDoAmbiente, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';
import { aplicarEtiqueta, eventoDeEtiqueta, portasDaPonte, type PortasDaPonte } from './chatwoot-etiquetas.js';
import { eventoDePausa, eventoDeReativacao, pausar, portaDaPausaDoChatwoot, reativar, type PortaDaPausa } from './chatwoot-pausa.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { registrarEventoDaSofia, registrarRespostaDaSofia, ultimaFalaDoPaciente } from './sofia-avaliacoes.js';
import { rodarTesteDaSofia } from '../controllers/playground.controller.js';
import { cartaoNoKommoDaUnidade } from './chatwoot-cartao-kommo.js';
import { portaDoChatwoot, type ConversaLida, type PortaDoChatwoot } from './chatwoot-porta.js';
import { combinadoPelaEquipe, consultaDosAtributos, consultasReaisDoPaciente, diaEHoraNoFuso, divergenciaDoCombinado, idsDaIntegracao, type ConsultaReal } from './chatwoot-horario-combinado.js';
import { SpineService } from '../services/spine.service.js';
import { fusoDaUnidade } from './fuso.js';
import { motivoDeNaoResponder, passarParaEquipeNoChatwoot, rodarSofiaDoChatwoot, type Fala, type ModoDaSofia, type ResultadoDaSofia } from './chatwoot-sofia.js';

export type { Fala };

export const ID_IA = 'chatwoot-ia';
export const ESPERA_SOFIA_MS = 60_000;
export const TETO_SOFIA_POR_DIA = 300;
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
  registrarResposta?(r: { mensagem: number; conversa: number; slug: string; texto: string; fala: string | null; acoes: string[] }): Promise<void>;
  /** guarda o que a Sofia FEZ e o painel do Agente conta (passou para a equipe, Pix que saiu); opcional (os testes não precisam) */
  registrarEvento?(e: { slug: string; conversa: number; tipo: 'equipe' | 'pix' }): Promise<void>;
  /** as consultas de pé deste paciente na franquia; null = não deu para conferir */
  agendaReal(unit: Unit, lida: ConversaLida): Promise<ConsultaReal[] | null>;
  /** passa a conversa para a equipe (etiqueta + etapa + nota); LANÇA se o Chatwoot falhar */
  passarParaEquipe(conversa: number, lida: ConversaLida, motivo: string): Promise<void>;
  transcrever(unit: Unit, url: string): Promise<string>;
  /** a conversa como está agora (atributos, etiquetas, telefone) */
  conversa(conversa: number): Promise<ConversaLida | null>;
  /** cartão ativo no Kommo da unidade para este telefone; null = nenhum (ou unidade sem Kommo); LANÇA se não deu para conferir */
  cartaoNoKommo(unit: Unit, telefone: string): Promise<{ leadId: number } | null>;
  sofia(unit: Unit, falas: Fala[], pedido: { conversa: number; modo: ModoDaSofia; lida: ConversaLida }): Promise<ResultadoDaSofia | null>;
  agendar(fn: () => void, ms: number): unknown;
  cancelar(t: unknown): void;
  hoje(): string;
}

export function portasReais(ctx: ContextoChatwoot): PortasDaIa {
  const chat: PortaDoChatwoot = portaDoChatwoot(ctx);
  return {
    estado: (slug) => estadoDaAutomacao(slug, ID_IA, process.env.CHATWOOT_IA_SLUGS),
    unidade: (slug) => prisma.unit.findUnique({ where: { slug } }),
    async mensagens(conversa) {
      const r = (await chamar(ctx, 'GET', `conversations/${conversa}/messages`)) as { payload?: unknown[] } | null;
      return Array.isArray(r?.payload) ? r.payload : [];
    },
    nota: (conversa, texto) => chat.nota(conversa, texto),
    publica: (conversa, texto) => chat.publica(conversa, texto),
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
    async passarParaEquipe(conversa, lida, motivo) {
      await passarParaEquipeNoChatwoot(chat, { conversa, etapa: String(lida.attrs.etapa ?? '').trim(), motivo });
    },
    async transcrever(unit, url) {
      return (await transcribeAudio(unit, url)).text;
    },
    conversa: (id) => chat.conversa(id),
    async cartaoNoKommo(unit, telefone) {
      if (!unit.kommoSubdomain || !unit.kommoAccessToken) return null;
      return cartaoNoKommoDaUnidade(unit)(telefone);
    },
    sofia: (unit, falas, pedido) => rodarSofiaDoChatwoot({ unit, falas, ...pedido, chat }, { rodarTeste: rodarTesteDaSofia }),
    agendar: (fn, ms) => setTimeout(fn, ms),
    cancelar: (t) => clearTimeout(t as NodeJS.Timeout),
    hoje: () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10),
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
}
export const novaMemoriaDaIa = (): MemoriaDaIa => ({
  esperas: new Map(),
  rodadas: new Map(),
  avisosDoKommo: new Set(),
  emAndamento: new Set(),
  avisosDeHorario: new Set(),
  usuariosDaIntegracao: new Set(),
});
/** Se a rodada anterior da mesma conversa ainda não acabou, tenta de novo depois disto. */
export const REPETE_SE_OCUPADA_MS = 15_000;

/** Uma mensagem do paciente chegou: transcreve o áudio agora; a Sofia, só depois de 60 s quieto (reagenda a cada fala). */
export async function aoChegar(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa): Promise<void> {
  if (p.estado(m.slug) === 'desligado') return;
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
  | 'kommo-indisponivel';

/**
 * A «assinatura» das mensagens PÚBLICAS da conversa: quantas são e qual é a última (pelo id do Chatwoot; sem id, pelo texto).
 * Mudou entre o começo e o fim da rodada = o paciente escreveu, a equipe respondeu ou outra cópia do servidor já respondeu.
 */
export function assinaturaDaConversa(mensagens: any[]): string {
  const publicas = mensagens.filter((m) => m?.private !== true && (Number(m?.message_type) === 0 || Number(m?.message_type) === 1));
  const ultima = publicas.at(-1);
  return `${publicas.length}|${ultima?.id ?? ultima?.content ?? ''}`;
}

/** Ferramentas que gravam na franquia ou no Asaas: se a rodada as usou, descartar a resposta deixa a equipe com trabalho a conferir. */
const FERRAMENTAS_QUE_GRAVAM = new Set(['cadastrar_paciente', 'agendar_consulta', 'remarcar_consulta', 'cancelar_consulta', 'gerar_sinal_pix']);

export async function rodarSofia(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa): Promise<Desfecho> {
  const modo = p.estado(m.slug);
  if (modo === 'desligado') return 'desligado';
  if (mem.emAndamento.has(m.conversa)) return 'ocupada';
  mem.emAndamento.add(m.conversa);
  try {
    return await rodarSofiaDessaConversa(m, p, mem, modo);
  } finally {
    mem.emAndamento.delete(m.conversa);
  }
}

async function rodarSofiaDessaConversa(m: MensagemDoPaciente, p: PortasDaIa, mem: MemoriaDaIa, modo: ModoDaSofia): Promise<Desfecho> {
  const chaveDia = `${m.slug}|${p.hoje()}`;
  // o painel do Agente conta daqui; falhar ao gravar não atrapalha o paciente
  const evento = async (tipo: 'equipe' | 'pix') => {
    await p.registrarEvento?.({ slug: m.slug, conversa: m.conversa, tipo }).catch((err) => logger.warn({ err: String(err), conversa: m.conversa, tipo }, `${ID_IA}: não consegui gravar o evento para o painel`));
  };
  if ((mem.rodadas.get(chaveDia) ?? 0) >= TETO_SOFIA_POR_DIA) return 'teto';
  const mensagens = await p.mensagens(m.conversa);
  const falas = falasDaConversa(mensagens);
  if (!falas) return 'equipe-respondeu';
  const unit = await p.unidade(m.slug);
  if (!unit) return 'sem-unidade';

  // a conversa como está agora: já passada à equipe, em tratamento, grupo → calada; sem telefone não dá para conferir o Kommo nem a agenda
  const lida = await p.conversa(m.conversa);
  if (!lida) return 'falhou';
  const calar = motivoDeNaoResponder(lida);
  if (calar) {
    logger.info({ conversa: m.conversa, motivo: calar }, `${ID_IA}: a Sofia fica calada`);
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
        await evento('equipe');
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
  // ela mesma passou a conversa para a equipe (pausar_ia): conta agora — a resposta dela pode ser descartada logo abaixo
  if (r.passouParaEquipe) await evento('equipe');

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
    logger.info({ conversa: m.conversa, motivo: calou, gravou }, `${ID_IA}: a conversa passou para a equipe enquanto a Sofia pensava — resposta descartada`);
    const nota = gravou ? alerta(`a conversa passou para a equipe (${calou}) enquanto ela pensava`) : null;
    if (nota) await p.nota(m.conversa, nota).catch(() => undefined);
    return 'mudou';
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
        .registrarResposta({ mensagem: enviada.mensagem, conversa: m.conversa, slug: m.slug, texto: r.resposta, fala: ultimaFalaDoPaciente(falas), acoes: r.acoes.map((a) => a.tool) })
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

let estado: { portas: PortasDaIa; mem: MemoriaDaIa; ponte: PortasDaPonte; pausa: PortaDaPausa } | null = null;

function estadoDoReceptor() {
  if (!estado) {
    const conta = contaChatwootDoAmbiente();
    if (!conta) return null;
    const ctx = criarContextoChatwoot(conta);
    estado = { portas: portasReais(ctx), mem: novaMemoriaDaIa(), ponte: portasDaPonte(ctx), pausa: portaDaPausaDoChatwoot(ctx) };
  }
  return estado;
}

export function eventoChatwootHandler(req: Request, res: Response): void {
  const token = process.env.CHATWOOT_API_TOKEN?.trim();
  if (!chaveDoEventoConfere(token, req.query.k)) {
    res.status(401).json({ error: 'chave inválida' });
    return;
  }
  res.json({ ok: true });
  // pessoa respondeu (pelo Chatwoot ou pelo celular) → pausa a IA nesta conversa; conversa resolvida → reativa (chatwoot-pausa.ts)
  const pausa = eventoDePausa(req.body);
  if (pausa) {
    const e = estadoDoReceptor();
    if (e) void pausar(pausa.conversa, pausa.autor, e.pausa).catch((err) => logger.warn({ err: String(err), conversa: pausa.conversa }, 'chatwoot-pausa: não consegui pausar'));
    return;
  }
  const reativa = eventoDeReativacao(req.body);
  if (reativa) {
    const e = estadoDoReceptor();
    if (e) void reativar(reativa.conversa, null, e.pausa).catch((err) => logger.warn({ err: String(err), conversa: reativa.conversa }, 'chatwoot-pausa: não consegui reativar'));
  }
  // botão "Perdido: <motivo>" → etiqueta → etapa + motivo no cartão (chatwoot-etiquetas.ts)
  const etq = eventoDeEtiqueta(req.body);
  if (etq) {
    const e = estadoDoReceptor();
    if (e) void aplicarEtiqueta(etq, e.ponte).catch((err) => logger.warn({ err: String(err), conversa: etq.conversa }, 'chatwoot-etiquetas: falhou'));
    return;
  }
  const m = mensagemDoPaciente(req.body);
  if (!m) return;
  const e = estadoDoReceptor();
  if (!e) return;
  void aoChegar(m, e.portas, e.mem).catch((err) => logger.warn({ err: String(err), conversa: m.conversa }, `${ID_IA}: evento falhou`));
}
