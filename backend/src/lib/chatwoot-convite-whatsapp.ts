/**
 * ROBÔ «CONVITE AO WHATSAPP», caminho do CRM (Chatwoot) — pedido do João, 26/11/2026. O Kommo é `convite-whatsapp.ts`; a parte pura (chave, texto,
 * número, link) é `convite-whatsapp-estado.ts`: a MESMA chave `convite-whatsapp` e o MESMO texto.
 *
 * Quando um lead escreve numa caixa de Instagram (`Channel::Instagram`) ou de Facebook (`Channel::FacebookPage`), o robô (NÃO é a Sofia) responde
 * UMA vez com o convite e o link do WhatsApp da clínica. Sai pela API do Chatwoot (usuário conector) com a marca `content_attributes.convite_whatsapp`,
 * e o CRM a rotula «🤖 Robô · mensagem automática» (`chatwoot-rotulo-robo.ts`).
 *
 * As caixas de Instagram/Facebook NÃO estão no mapa de caixas da unidade (`CAIXAS_REGUA`) — e não devem entrar: a régua, a Sofia e a agenda tratariam
 * o contato do Instagram como paciente de WhatsApp. A unidade vem da CONTA do Chatwoot (Parauapebas é a conta do ambiente). Conta com mais de uma
 * unidade configurada não se adivinha: sem convite.
 *
 * NUNCA convida (o motivo vai ao log; em «seco» vira nota privada na conversa): mensagem que não é do lead, nota privada, menção em story, unidade em
 * pausa, unidade sem número, conversa com `ia-pausada`/`interno`, a EQUIPE já respondeu (usuário do CRM que não é o conector; ou resposta pelo app
 * do Instagram/Facebook, o «eco» sem remetente — salvo o que sai até 20 s depois da 1ª mensagem do lead, que é a resposta AUTOMÁTICA da Meta
 * («Olá, que satisfação receber o seu contato!»: em Parauapebas, 6 de 6 respostas no Facebook em até 30 s, mediana 5 s, 30 dias até 26/11), paciente
 * (o telefone do contato, se houver, acusa tratamento/sessão/avaliação recente na franquia), ou já convidou este CONTATO nos últimos 7 dias.
 * FALHA FECHADA: leitura que não deu = não convida.
 *
 * Também (mesma chave, mesmos estados): quando o lead chega ao WhatsApp com o texto pronto do convite («Olá! Vim pelo Instagram e quero saber
 * mais.»), a ORIGEM do contato vira Instagram/Facebook — só se estiver VAZIA e se a opção existir na lista da conta (senão, só o log).
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { chamar, contaChatwootDoAmbiente, contextoDoAmbiente, donaDaConta, ehContaDoAmbiente, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { CAIXAS_REGUA, unidadeDaCaixa, unidadesConfiguradas } from './chatwoot-unidades.js';
import { portaDoChatwoot, type ConversaLida } from './chatwoot-porta.js';
import { claimMessageId, liberarClaim, reivindicarComCerteza } from './dedup-cache.js';
import { emPausa } from './pausa-unidade.js';
import { conectoresDoRotulo } from './chatwoot-rotulo-robo.js';
import { nomeDaClinicaDaUnidade, telefoneNaFranquia } from './convite-whatsapp.js';
import { normalizarFrase } from './origem-texto-pronto.js';
import { ETIQUETA_PAUSA } from './chatwoot-pausa.js';
import {
  VALIDADE_DO_CONVITE_MS,
  canalDoConvite,
  conviteWhatsappEstado,
  decididoRecentemente,
  fraseDeOrigem,
  lembrarDecisao,
  numeroDaUnidade,
  textoDoConvite,
  type CanalDoConvite,
} from './convite-whatsapp-estado.js';

/** A marca da mensagem do robô: o CRM a rotula e os leitores a reconhecem como fala nossa (nunca como equipe). */
export const MARCA_DO_CONVITE = 'convite_whatsapp';
const MENSAGENS_POR_PAGINA = 20;
const PAGINAS_LIDAS = 6;
/** Resposta sem remetente que sai até aqui depois da mensagem do lead que ela responde é a resposta automática da Meta — não conta como a equipe. */
export const ECO_AUTOMATICO_SEG = 20;

const FREIO_MS = 30 * 60_000;
const freios = new Map<string, number>();
const freiar = (chave: string, agora: number): void => {
  if (freios.size >= 5000) freios.clear();
  freios.set(chave, agora + FREIO_MS);
};
const freado = (chave: string, agora: number): boolean => (freios.get(chave) ?? 0) > agora;
export const _esquecerFreiosDoCrmParaTeste = (): void => freios.clear();

const numero = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const minusculas = (v: unknown): string => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

// ── o evento (puro) ───────────────────────────────────────────────────────────────────────────

export interface EventoSocial {
  conversa: number;
  caixa: number;
  canal: CanalDoConvite;
  /** o contato (lead) que escreveu; a marca de «uma vez» é DELE, não da conversa */
  contato: number | null;
  /** menção em story: o lead não escreveu para a clínica */
  mencaoEmStory: boolean;
}

/** `message_created` de ENTRADA, pública, numa conversa de Instagram/Facebook (o tipo do canal vem no próprio payload). */
export function eventoDeRedeSocial(corpo: any): EventoSocial | null {
  if (corpo?.event !== 'message_created') return null;
  if (!(corpo?.message_type === 'incoming' || corpo?.message_type === 0)) return null;
  if (corpo?.private === true) return null;
  // Instagram que chega por uma caixa de PÁGINA do Facebook (o modo antigo do Chatwoot) vem como `Channel::FacebookPage` com este atributo na conversa
  const doInstagram = corpo?.conversation?.additional_attributes?.type === 'instagram_direct_message';
  const canal = doInstagram ? 'Instagram' : canalDoConvite(corpo?.conversation?.channel ?? corpo?.inbox?.channel_type ?? corpo?.channel);
  const conversa = numero(corpo?.conversation?.id);
  const caixa = numero(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  if (!canal || !conversa || !caixa) return null;
  const ca = corpo?.content_attributes && typeof corpo.content_attributes === 'object' ? corpo.content_attributes : {};
  const mencaoEmStory = ca.image_type === 'story_mention' || /menç[ãa]o em story|story_mention/i.test(String(corpo?.content ?? ''));
  const contato = numero(corpo?.sender?.id); // em mensagem de ENTRADA o remetente é o contato
  return { conversa, caixa, canal, contato, mencaoEmStory };
}

/**
 * A unidade de uma caixa SOCIAL: a que o mapa de caixas diz (se um dia a caixa entrar nele) ou a ÚNICA unidade configurada na conta do evento.
 * Duas unidades na mesma conta (ou nenhuma) = não se sabe de quem é: `null`.
 */
export function slugDaCaixaSocial(caixa: number, conta: number, contaDoAmbiente: number | null, configs: ReadonlyArray<{ slug: string; contaId: number | null }> = unidadesConfiguradas()): string | null {
  const dono = unidadeDaCaixa(caixa);
  if (dono) return dono;
  const daConta = configs.filter((c) => (c.contaId ?? contaDoAmbiente) === conta);
  return daConta.length === 1 ? daConta[0]!.slug : null;
}

export interface MensagemDaApi {
  message_type?: unknown;
  private?: unknown;
  created_at?: unknown;
  sender?: { id?: unknown; type?: unknown } | null;
  sender_type?: unknown;
  sender_id?: unknown;
  content_attributes?: unknown;
}

/**
 * Puro: a EQUIPE (gente) já respondeu esta conversa? Resposta do robô (conector, AgentBot, nossa marca) não conta; a resposta SEM remetente (o app do
 * Instagram/Facebook, a automação da Meta) conta, salvo se saiu até `ECO_AUTOMATICO_SEG` depois da mensagem do lead que ela responde (a ÚLTIMA mensagem do
 * lead antes dela: a Meta responde de novo a cada sessão de 24 h). Sem mensagem do lead antes dela (histórico longo cortado), conta como equipe
 * (na dúvida, não fala por cima).
 */
export function equipeJaRespondeu(mensagens: ReadonlyArray<MensagemDaApi>, conectores: readonly number[] = conectoresDoRotulo()): boolean {
  const tipo = (m: MensagemDaApi) => Number(m.message_type);
  const horaDe = (m: MensagemDaApi) => numero(m.created_at);
  const entradas = mensagens.filter((m) => tipo(m) === 0).map(horaDe).filter((t): t is number => t !== null);
  for (const m of mensagens) {
    if (m.private === true || (tipo(m) !== 1 && tipo(m) !== 3)) continue;
    const ca = m.content_attributes && typeof m.content_attributes === 'object' ? (m.content_attributes as Record<string, unknown>) : {};
    if (ca[MARCA_DO_CONVITE] || ca.demora_espera || ca.dd_sofia) continue; // nossa fala
    const quem = minusculas(m.sender?.type ?? m.sender_type);
    const id = numero(m.sender?.id ?? m.sender_id);
    if (quem === 'agentbot') continue;
    if (quem === 'user') {
      if (id !== null && conectores.includes(id)) continue; // o conector: Sofia, régua, convite — robô
      return true;
    }
    if (quem === 'contact') continue;
    // sem remetente: o app da rede social (ou a automação da Meta, que responde em segundos à mensagem que abre a sessão)
    const t = horaDe(m);
    const respondida = t === null ? null : entradas.filter((e) => e <= t).reduce<number | null>((a, e) => (a === null || e > a ? e : a), null);
    if (t !== null && respondida !== null && t - respondida <= ECO_AUTOMATICO_SEG) continue;
    return true;
  }
  return false;
}

// ── o robô ────────────────────────────────────────────────────────────────────────────────────

export type MotivoDoConviteCrm =
  | 'sem-unidade'
  | 'menção-em-story'
  | 'unidade-pausada'
  | 'sem-numero'
  | 'ja-convidado'
  | 'conversa-pausada'
  | 'equipe-ja-respondeu'
  | 'paciente'
  | 'nao-consegui-conferir';

export type DesfechoCrm =
  | { tipo: 'desligado' }
  | { tipo: 'ignorou'; motivo: MotivoDoConviteCrm; detalhe?: string }
  | { tipo: 'seco'; texto: string }
  | { tipo: 'ja-decidido' }
  | { tipo: 'enviou'; texto: string }
  | { tipo: 'falhou'; detalhe: string };

export interface PortasDoConviteCrm {
  unidade(slug: string): Promise<Unit | null>;
  conversa(id: number): Promise<ConversaLida | null>;
  mensagens(id: number): Promise<MensagemDaApi[]>;
  /** mensagem PÚBLICA com a marca no `content_attributes` */
  publica(id: number, texto: string, marca: Record<string, unknown>): Promise<void>;
  nota(id: number, texto: string): Promise<void>;
  /** há convite vivo (≤ 7 dias) para esta chave? Só leitura. Lança se não deu para saber. */
  jaConvidado(chave: string): Promise<boolean>;
  reivindicar(chave: string): Promise<'ganhou' | 'perdeu' | 'incerto'>;
  /** em «seco»: primeira vez que registro este convite? (a nota privada só sai uma vez) */
  primeiraNotaDoSeco(chave: string): Promise<boolean>;
  /** a franquia diz que este telefone é de paciente? `nao-sei` = a franquia não respondeu. Nunca lança. */
  pacienteNaFranquia(unit: Unit, telefone: string): Promise<'sim' | 'nao' | 'nao-sei'>;
  /** devolve a marca (só quando SABEMOS que nada saiu: erro 4xx do Chatwoot) */
  soltar(chave: string): Promise<void>;
  conectores(): number[];
}

export const chaveDoConviteCrm = (conta: number, ev: Pick<EventoSocial, 'conversa' | 'contato'>): string => `convite-whatsapp-crm:${conta}:${ev.contato ? `contato-${ev.contato}` : `conversa-${ev.conversa}`}`;

export function notaDoSeco(canal: CanalDoConvite, texto: string, comTelefone = true): string {
  const aviso = comTelefone ? '' : '\n\n(O contato não tem telefone: só o telefone acha paciente na franquia, então esta conferência não pôde ser feita.)';
  return `🧪 (só no papel) O robô mandaria este convite ao WhatsApp (${canal}) — nada foi enviado:\n\n${texto}${aviso}`;
}

/** O robô do CRM. Nunca lança. `desligado` = nenhuma leitura, nenhuma consulta, nenhuma escrita. */
const DEFINITIVOS: ReadonlySet<MotivoDoConviteCrm> = new Set(['conversa-pausada', 'equipe-ja-respondeu', 'paciente']);

export async function convidarNoCrm(
  ev: EventoSocial,
  conta: number,
  p: PortasDoConviteCrm,
  contaDoAmbiente: number | null = contaChatwootDoAmbiente()?.conta ?? null,
  agora: () => number = Date.now,
): Promise<DesfechoCrm> {
  const slug = slugDaCaixaSocial(ev.caixa, conta, contaDoAmbiente);
  if (!slug) {
    logger.debug({ conta, caixa: ev.caixa }, 'convite-whatsapp (CRM): não sei de qual unidade é esta caixa de Instagram/Facebook — não convida');
    return { tipo: 'ignorou', motivo: 'sem-unidade' };
  }
  const estado = conviteWhatsappEstado(slug);
  if (estado === 'desligado') return { tipo: 'desligado' };
  const seco = estado === 'seco';
  const chave = chaveDoConviteCrm(conta, ev);
  const agoraMs = () => agora();
  const nao = (motivo: MotivoDoConviteCrm, detalhe?: string): DesfechoCrm => {
    if (DEFINITIVOS.has(motivo)) lembrarDecisao(chave, agoraMs());
    logger.info({ slug, conversa: ev.conversa, canal: ev.canal, motivo, detalhe }, `convite-whatsapp (CRM${seco ? ', seco' : ''}): não convida — ${motivo}${detalhe ? ` (${detalhe})` : ''}`);
    return { tipo: 'ignorou', motivo, detalhe };
  };
  try {
    if (ev.mencaoEmStory) return nao('menção-em-story');
    const unit = await p.unidade(slug);
    if (!unit) return nao('sem-unidade', 'a unidade não está no banco');
    if (emPausa(unit)) return nao('unidade-pausada');
    const wa = numeroDaUnidade(unit, ev.canal);
    if (!wa) return nao('sem-numero');
    if (!seco && (await p.jaConvidado(chave))) return nao('ja-convidado');
    if (!seco && freado(chave, agoraMs())) return nao('nao-consegui-conferir', 'o envio anterior foi recusado há menos de 30 min');
    // uma decisão por conversa por hora: o «não» definitivo e o «mandaria» do seco não repetem as leituras do Chatwoot a cada mensagem do lead
    if (decididoRecentemente(chave, agoraMs())) return { tipo: 'ja-decidido' };

    const lida = await p.conversa(ev.conversa);
    if (!lida) return nao('nao-consegui-conferir', 'conversa não lida');
    if (lida.interno || lida.etiquetas.some((e) => e.trim().toLowerCase() === ETIQUETA_PAUSA)) return nao('conversa-pausada');
    if (equipeJaRespondeu(await p.mensagens(ev.conversa), p.conectores())) return nao('equipe-ja-respondeu');
    if (lida.telefone) {
      // o contato TEM telefone: não achar na franquia só vale se a franquia respondeu (índice vencido, ficha que não veio, timeout = não sei = não convida)
      const naFranquia = await p.pacienteNaFranquia(unit, lida.telefone);
      if (naFranquia === 'sim') return nao('paciente', 'telefone na franquia');
      if (naFranquia === 'nao-sei') return nao('nao-consegui-conferir', 'a franquia não respondeu sobre o telefone do contato');
    }

    const texto = textoDoConvite({ clinica: nomeDaClinicaDaUnidade(unit), numero: wa, canal: ev.canal });
    if (seco) {
      if (await p.primeiraNotaDoSeco(chave)) await p.nota(ev.conversa, notaDoSeco(ev.canal, texto, !!lida.telefone));
      logger.info({ slug, conversa: ev.conversa, canal: ev.canal, texto }, 'convite-whatsapp (CRM, seco): mandaria o convite — nada foi enviado ao lead');
      lembrarDecisao(chave, agoraMs());
      return { tipo: 'seco', texto };
    }
    if (conviteWhatsappEstado(slug) !== 'ligado') return nao('nao-consegui-conferir', 'a chave mudou durante a conferência');
    const marca = await p.reivindicar(chave);
    if (marca === 'perdeu') return nao('ja-convidado', 'outra mensagem chegou primeiro');
    if (marca === 'incerto') return nao('nao-consegui-conferir', 'banco não confirmou a marca');
    try {
      await p.publica(ev.conversa, texto, { [MARCA_DO_CONVITE]: true });
    } catch (err) {
      const status = Number((err as { status?: unknown })?.status);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        // o Chatwoot RECUSOU (4xx): sabemos que nada saiu. Devolve a marca; a próxima mensagem do lead tenta de novo, depois de 30 min
        await p.soltar(chave).catch(() => undefined);
        freiar(chave, agoraMs());
        logger.error({ err: String(err), slug, conversa: ev.conversa, chave }, 'convite-whatsapp (CRM): o Chatwoot recusou o envio — nada saiu; a marca foi devolvida e o robô tenta de novo em 30 min');
        return { tipo: 'falhou', detalhe: String(err) };
      }
      // timeout/5xx: o pedido pode ter saído; repetir mandaria duas vezes — a marca FICA
      logger.error({ err: String(err), slug, conversa: ev.conversa, chave }, 'convite-whatsapp (CRM): o envio deu erro — a marca FICA (não repete); confira na conversa se a mensagem saiu');
      return { tipo: 'falhou', detalhe: String(err) };
    }
    logger.info({ slug, conversa: ev.conversa, canal: ev.canal }, 'convite-whatsapp (CRM): convite enviado');
    return { tipo: 'enviou', texto };
  } catch (err) {
    logger.warn({ err: String(err), slug, conversa: ev.conversa }, 'convite-whatsapp (CRM): falhou na conferência — não convida');
    return { tipo: 'ignorou', motivo: 'nao-consegui-conferir', detalhe: String(err).slice(0, 200) };
  }
}

// ── a origem pelo texto pronto (WhatsApp) ─────────────────────────────────────────────────────

export interface EventoDoTextoPronto {
  conversa: number;
  caixa: number;
  contato: number;
  canal: CanalDoConvite;
}

/** `message_created` de ENTRADA numa caixa de WhatsApp do mapa, cujo texto traz «Vim pelo Instagram/Facebook e quero saber mais». */
export function eventoDoTextoPronto(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): EventoDoTextoPronto | null {
  if (corpo?.event !== 'message_created') return null;
  if (!(corpo?.message_type === 'incoming' || corpo?.message_type === 0) || corpo?.private === true) return null;
  const conversa = numero(corpo?.conversation?.id);
  const caixa = numero(corpo?.conversation?.inbox_id ?? corpo?.inbox?.id);
  const contato = numero(corpo?.sender?.id);
  if (!conversa || !caixa || !contato || !caixas[caixa]) return null;
  const fala = ` ${normalizarFrase(corpo?.content)} `;
  for (const canal of ['Instagram', 'Facebook'] as const) if (fala.includes(` ${normalizarFrase(fraseDeOrigem(canal))} `)) return { conversa, caixa, contato, canal };
  return null;
}

export interface PortasDaOrigemDoConvite {
  /** `custom_attributes` do contato AGORA */
  contato(id: number): Promise<Record<string, unknown>>;
  /** as opções da lista `origem` dos contatos desta conta */
  opcoesDaOrigem(): Promise<string[]>;
  gravarOrigem(contato: number, valor: string): Promise<void>;
}

export type DesfechoDaOrigem = 'desligado' | 'ja-tem' | 'sem-opcao' | 'seco' | 'gravada' | 'erro';

/** Marca a origem do contato que chegou pelo texto do convite. Nunca lança. Só campo VAZIO; só opção que a conta tem. */
export async function marcarOrigemDoConvite(ev: EventoDoTextoPronto, p: PortasDaOrigemDoConvite, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): Promise<DesfechoDaOrigem> {
  const slug = caixas[ev.caixa];
  if (!slug) return 'desligado';
  const estado = conviteWhatsappEstado(slug);
  if (estado === 'desligado') return 'desligado';
  try {
    const atual = await p.contato(ev.contato);
    if (typeof atual.origem === 'string' ? atual.origem.trim() : atual.origem) return 'ja-tem';
    const opcao = (await p.opcoesDaOrigem()).find((o) => normalizarFrase(o) === normalizarFrase(ev.canal));
    if (!opcao) {
      logger.warn({ slug, conversa: ev.conversa, canal: ev.canal }, `convite-whatsapp (CRM): a lista «origem» do CRM não tem a opção «${ev.canal}» — origem NÃO marcada (cadastre a opção)`);
      return 'sem-opcao';
    }
    if (estado === 'seco') {
      logger.info({ slug, conversa: ev.conversa, contato: ev.contato, origem: opcao }, `convite-whatsapp (CRM, seco): marcaria a origem do contato ${ev.contato} = ${opcao}`);
      return 'seco';
    }
    // relê logo antes de gravar: a atendente pode ter preenchido enquanto líamos a lista
    const agora = await p.contato(ev.contato);
    if (typeof agora.origem === 'string' ? agora.origem.trim() : agora.origem) return 'ja-tem';
    await p.gravarOrigem(ev.contato, opcao);
    logger.info({ slug, conversa: ev.conversa, contato: ev.contato, origem: opcao }, `convite-whatsapp (CRM): origem do contato ${ev.contato} = ${opcao}`);
    return 'gravada';
  } catch (err) {
    logger.warn({ err: String(err), slug, conversa: ev.conversa }, 'convite-whatsapp (CRM): não consegui marcar a origem (segue)');
    return 'erro';
  }
}

// ── as portas reais ───────────────────────────────────────────────────────────────────────────

export function portasReaisDoConvite(ctx: ContextoChatwoot): PortasDoConviteCrm & PortasDaOrigemDoConvite {
  const chat = portaDoChatwoot(ctx);
  return {
    unidade: (slug) => prisma.unit.findUnique({ where: { slug } }),
    conversa: (id) => chat.conversa(id),
    async mensagens(id) {
      // o Chatwoot devolve as 20 últimas por página: volta pelas anteriores (`before`) até o começo da conversa. Conversa longa demais para conferir =
      // LANÇA (falha fechada): não dá para afirmar que a equipe nunca respondeu.
      const todas: Array<MensagemDaApi & { id?: unknown }> = [];
      let antes: number | null = null;
      for (let pagina = 0; pagina < PAGINAS_LIDAS; pagina++) {
        const r = (await chamar(ctx, 'GET', `conversations/${id}/messages`, antes ? { query: { before: String(antes) } } : {})) as { payload?: unknown[] } | null;
        const lote = (Array.isArray(r?.payload) ? r!.payload : []) as Array<MensagemDaApi & { id?: unknown }>;
        todas.push(...lote);
        if (lote.length < MENSAGENS_POR_PAGINA) return todas;
        antes = Math.min(...lote.map((m) => numero(m.id) ?? Infinity));
        if (!Number.isFinite(antes)) break;
      }
      throw new Error(`conversa ${id} longa demais para conferir se a equipe já respondeu`);
    },
    async publica(id, texto, marca) {
      await chat.publica(id, texto, marca);
    },
    nota: (id, texto) => chat.nota(id, texto),
    async jaConvidado(chave) {
      const linha = await prisma.messageClaim.findUnique({ where: { key: chave }, select: { expiresAt: true } });
      return !!linha && linha.expiresAt.getTime() > Date.now();
    },
    reivindicar: (chave) => reivindicarComCerteza('convite-whatsapp-crm', chave.slice('convite-whatsapp-crm:'.length), VALIDADE_DO_CONVITE_MS),
    primeiraNotaDoSeco: (chave) => claimMessageId('convite-whatsapp-crm-seco', chave.slice('convite-whatsapp-crm:'.length), VALIDADE_DO_CONVITE_MS),
    pacienteNaFranquia: telefoneNaFranquia,
    soltar: (chave) => liberarClaim('convite-whatsapp-crm', chave.slice('convite-whatsapp-crm:'.length)),
    conectores: () => conectoresDoRotulo(),
    async contato(id) {
      const r = (await chamar(ctx, 'GET', `contacts/${id}`)) as { payload?: { custom_attributes?: Record<string, unknown> }; custom_attributes?: Record<string, unknown> } | null;
      return r?.payload?.custom_attributes ?? r?.custom_attributes ?? {};
    },
    async opcoesDaOrigem() {
      const defs = (await chamar(ctx, 'GET', 'custom_attribute_definitions', { query: { attribute_model: 'contact_attribute' } })) as unknown;
      const def = (Array.isArray(defs) ? defs : []).find((d: any) => d?.attribute_key === 'origem') as { attribute_values?: unknown } | undefined;
      return Array.isArray(def?.attribute_values) ? def!.attribute_values.map((v) => String(v).trim()).filter(Boolean) : [];
    },
    async gravarOrigem(contato, valor) {
      // o Chatwoot MESCLA custom_attributes no PUT do contato
      await chamar(ctx, 'PUT', `contacts/${contato}`, { corpo: { custom_attributes: { origem: valor } } });
    },
  };
}

/** O contexto da CONTA do evento (o do ambiente, ou o da clínica de conta própria). `null` = não há. */
function contextoDaConta(conta: number): ContextoChatwoot | null {
  const base = contextoDoAmbiente();
  if (!base) return null;
  return ehContaDoAmbiente(conta) ? base : (donaDaConta(base, conta)?.ctx ?? null);
}

/**
 * O que o receptor de eventos do Chatwoot chama a cada evento. Evento que não é nosso = retorno imediato, sem rede nem banco. Nunca lança.
 * `portas` só o teste troca.
 */
export async function noConviteDoCrm(corpo: any, conta: number, portas?: PortasDoConviteCrm & PortasDaOrigemDoConvite): Promise<DesfechoCrm | DesfechoDaOrigem | null> {
  try {
    const social = eventoDeRedeSocial(corpo);
    const pronto = social ? null : eventoDoTextoPronto(corpo);
    if (!social && !pronto) return null;
    if (social) {
      // chave desligada: nem monta as portas
      const slug = slugDaCaixaSocial(social.caixa, conta, contaChatwootDoAmbiente()?.conta ?? null);
      if (!slug) return null; // conta com mais de uma unidade (ou nenhuma): não se adivinha, e sem ruído no log
      if (conviteWhatsappEstado(slug) === 'desligado') return { tipo: 'desligado' };
    } else if (pronto && conviteWhatsappEstado(CAIXAS_REGUA[pronto.caixa] ?? '') === 'desligado') return 'desligado';
    const p = portas ?? (() => {
      const ctx = contextoDaConta(conta);
      return ctx ? portasReaisDoConvite(ctx) : null;
    })();
    if (!p) return null;
    return social ? await convidarNoCrm(social, conta, p) : await marcarOrigemDoConvite(pronto!, p);
  } catch (err) {
    logger.warn({ err: String(err), conta }, 'convite-whatsapp (CRM): falha inesperada (ignorada)');
    return null;
  }
}
