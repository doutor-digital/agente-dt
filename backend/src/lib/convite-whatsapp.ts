/**
 * ROBÔ «CONVITE AO WHATSAPP», caminho do KOMMO (pedido do João, 26/11/2026). A parte pura (chave, texto, número) está em
 * `convite-whatsapp-estado.ts`; o caminho do CRM (Chatwoot) é `chatwoot-convite-whatsapp.ts`.
 *
 * Quando o lead escreve pelo Instagram ou pelo Facebook (Direct/Messenger — a origem que o Kommo informa em cada mensagem do webhook), este robô
 * (NÃO é a Sofia) responde UMA vez: «Oi! Aqui é da Doutor Hérnia X. Para te atender mais rápido, continue pelo nosso WhatsApp: <link>».
 * O link já leva o texto «Olá! Vim pelo Instagram e quero saber mais.», que depois identifica a ORIGEM do lead no WhatsApp
 * (`origem_por_texto` com `contem: true`, chave `origem-texto-pronto`, que já existe — sem código novo).
 *
 * NUNCA convida quando (cada motivo vai para o log e, em «só no papel», para a tela):
 *  - a mensagem não é de rede social, é comentário em post (só Direct/Messenger), ou o lead não escreveu nada que possamos ler;
 *  - a unidade está em pausa; «Pausar IA» marcado ou pausa do lead (alguém já cuida); o cartão está em etapa em que a Sofia não fala
 *    (a allowlist da unidade, GANHO/ALTA/cancelado, regra global de etapa pausada);
 *  - a EQUIPE já falou (conversa oficial do Kommo: a mesma que a pausa-equipe lê; a fala do robô e a resposta automática do celular não contam);
 *  - é paciente em tratamento: o cartão já tem vínculo com a franquia, ou o telefone do contato (se houver) acusa tratamento ativo, sessão
 *    futura ou consulta recente na franquia — o mesmo `consultarFranquia` da Sofia. Contato de Instagram quase nunca tem telefone: sem
 *    telefone não se acha paciente por nome (palpite vira dado permanente), só pelos sinais do cartão acima;
 *  - já convidou esta conversa há menos de 7 dias; a unidade não tem número cadastrado; ou a unidade não tem rota de envio pelo Salesbot.
 * FALHA FECHADA: qualquer leitura que não deu (Kommo, banco) = não convida. Convite perdido custa pouco; convite a paciente custa caro.
 *
 * «Uma vez»: a reivindicação em `message_claims` (INSERT atômico, vale 7 dias) vai ANTES do envio; quem perde a corrida não envia. Falha DEPOIS
 * de partir o pedido (exceção, timeout) não solta a marca (pode ter saído). Já a falha em que SABEMOS que nada saiu (a mensagem virou nota no
 * cartão) DEVOLVE a marca — o lead não pode ficar 7 dias sem ninguém — com um freio de 30 min para não empilhar nota a cada mensagem. Em «seco» a
 * marca NÃO é gravada (ligar depois convida normalmente).
 *
 * A SOFIA só se cala nos leads que RECEBERAM o convite: a 2ª marca («recebeu», `convite-whatsapp-marca.ts`) é gravada SÓ depois da entrega confirmada.
 * Leitura que falhou, franquia que não respondeu, 403, erro de envio, envio que virou nota e a passagem do seco para o ligado não deixam essa marca:
 * nesses casos a Sofia responde normalmente (e a escada e a reativação continuam valendo para esse lead). Enquanto o robô decide um lead, a Sofia espera o desfecho.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { prisma } from './prisma.js';
import { emPausa } from './pausa-unidade.js';
import { liberarClaim, reivindicarComCerteza } from './dedup-cache.js';
import { chaveDoConvite, gravarEnviado, jaConvidado, registrarEmAndamento } from './convite-whatsapp-marca.js';
import { pausaDoLeadAtiva } from './pausa-lead-regras.js';
import { registrarSimulacao, type Simulacao } from './so-no-papel.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import { etapaPermitida, precisaDoFunil, type FunisDaConta } from './etapa-permitida.js';
import { etapaCalada } from './sofia-calada.js';
import { esquemaDaUnidade, type EsquemaKommo } from './kommo-schema.js';
import { getPausedStagesGlobalSet } from '../services/actions.service.js';
import { falasHumanasDaEquipe } from './pausa-equipe.js';
import { mensagensOficiaisDaUnidade } from '../services/kommo-talks.service.js';
import { consultarFranquia, type SinalDaFranquia } from './paciente-em-tratamento.js';
import { agendarIndice } from './franquia-indice-telefones.js';
import { cidadeDaUnidade, unidadeDona } from '../agent/rede-doutor-hernia.js';
import {
  ID_CONVITE_WHATSAPP,
  VALIDADE_DO_CONVITE_MS,
  canalDoConvite,
  conviteWhatsappEstado,
  decididoRecentemente,
  lembrarDecisao,
  nomeDaClinica,
  numeroDaUnidade,
  textoDoConvite,
  type CanalDoConvite,
} from './convite-whatsapp-estado.js';

export type MotivoDoConvite =
  | 'nao-e-rede-social'
  | 'comentario'
  | 'unidade-pausada'
  | 'sem-numero'
  | 'sem-rota-de-envio'
  | 'ja-convidado'
  | 'cartao-pausado'
  | 'etapa-sem-sofia'
  | 'equipe-ja-falou'
  | 'paciente'
  | 'nao-consegui-conferir';

export type Desfecho =
  | { tipo: 'desligado' }
  | { tipo: 'ignorou'; motivo: MotivoDoConvite; detalhe?: string }
  | { tipo: 'seco'; texto: string; canal: CanalDoConvite }
  /** esta conversa já foi decidida na última hora (a tela e o log já mostram) */
  | { tipo: 'ja-decidido' }
  | { tipo: 'enviou'; texto: string; canal: CanalDoConvite }
  /** o pedido de envio falhou ou virou nota (erro sem saber: a marca fica; virou nota: a marca foi devolvida) — e o log diz */
  | { tipo: 'falhou'; detalhe: string };

export interface PedidoDoConvite {
  unit: Unit;
  leadId: number;
  /** `origin` da mensagem no webhook do Kommo */
  origem: string | null;
  /** `message_type` da mensagem no webhook (`text`, `voice`, `picture`, … — comentário não vem como mensagem comum) */
  tipoDaMensagem?: string | null;
  isChatMessage: boolean;
  chatId: string | null;
  talkId: string | null;
  contactId: string | null;
}

/** O que o cartão diz do lead (lido uma vez). */
export interface LeituraDoCartao {
  pausado: boolean;
  /** a etapa/funil: `null` quando nada a conferir na unidade (sem allowlist, sem etapa calada a ler) */
  etapaPermite: boolean;
  /** o lead já está ligado a um paciente da franquia (`spine_lead_links.spine_id_client`) */
  temIdClient: boolean;
  /** telefone do contato, se o Kommo tiver (Instagram quase nunca tem) */
  telefone: string | null;
}

export interface DepsDoConvite {
  agora?: () => Date;
  /** a chave da conversa já foi reivindicada (há convite vivo)? Só leitura. Lança se não deu para saber. */
  jaConvidado(chave: string): Promise<boolean>;
  reivindicar(chave: string): Promise<'ganhou' | 'perdeu' | 'incerto'>;
  /** devolve a marca (só quando SABEMOS que nada saiu) */
  soltar(chave: string): Promise<void>;
  cartao(unit: Unit, leadId: number, contactId: string | null): Promise<LeituraDoCartao>;
  /** a EQUIPE (gente) já falou nesta conversa? Lança se não leu. */
  equipeJaFalou(unit: Unit, leadId: number): Promise<boolean>;
  /** a franquia diz que este telefone é de paciente (tratamento ativo, sessão futura, avaliação recente)? `nao-sei` = franquia/índice indisponível. Nunca lança. */
  pacienteNaFranquia(unit: Unit, telefone: string): Promise<'sim' | 'nao' | 'nao-sei'>;
  /** «Doutor Hérnia Salto»: como a clínica se chama (o nome da unidade quando já diz; senão a cidade do mapa do ⌂ Unidade). */
  clinica(unit: Unit): string;
  enviar(unit: Unit, p: PedidoDoConvite, texto: string): Promise<'entregue' | 'virou-nota'>;
  /** grava «o lead RECEBEU o convite» (a Sofia se cala NESTE lead). Só depois da entrega confirmada. `false` = não gravou (a Sofia segue respondendo). */
  gravarEnviado(chave: string): Promise<boolean>;
  simular(unit: Pick<Unit, 'id' | 'slug'>, s: Simulacao): void;
}

export { chaveDoConvite };

const FREIO_DEPOIS_DE_FALHA_MS = 30 * 60_000;
const freios = new Map<string, number>();
function freiarDepoisDeFalha(chave: string, agora: number): void {
  if (freios.size >= 5000) freios.clear();
  freios.set(chave, agora + FREIO_DEPOIS_DE_FALHA_MS);
}
function freado(chave: string, agora: number): boolean {
  const ate = freios.get(chave);
  return ate !== undefined && ate > agora;
}
export function _esquecerFreiosParaTeste(): void {
  freios.clear();
}

/** Mensagem que não é conversa direta: comentário em post (o Kommo marca o tipo). */
export function ehComentario(tipo: string | null | undefined): boolean {
  return typeof tipo === 'string' && /comment|coment/i.test(tipo);
}

/** Puro: a franquia diz que é paciente? (o mesmo critério da Sofia + a avaliação recente de quem já negocia) */
export function sinalDePaciente(s: SinalDaFranquia): boolean {
  return s.tipo === 'paciente' && (s.tratamentoAtivo || s.sessaoFutura || s.avaliacaoRecente === true);
}

/** Os «não» que custaram leituras do Kommo e não mudam logo: lembrados por 1 h. Falha passageira e o que se decide de graça não entram. */
const DEFINITIVOS_DEPOIS_DAS_LEITURAS: ReadonlySet<MotivoDoConvite> = new Set(['cartao-pausado', 'etapa-sem-sofia', 'equipe-ja-falou', 'paciente']);

const ROTULO: Record<MotivoDoConvite, string> = {
  'nao-e-rede-social': 'não é Instagram/Facebook',
  comentario: 'é comentário em post, não mensagem direta',
  'unidade-pausada': 'a unidade está em pausa',
  'sem-numero': 'a unidade não tem o número do WhatsApp cadastrado',
  'sem-rota-de-envio': 'a unidade não tem Salesbot + campo de resposta (o envio viraria nota no cartão)',
  'ja-convidado': 'esta conversa já foi convidada há menos de 7 dias',
  'cartao-pausado': '«Pausar IA»/pausa do lead: alguém já cuida',
  'etapa-sem-sofia': 'o cartão está em etapa em que a Sofia não fala (paciente já em tratamento/alta)',
  'equipe-ja-falou': 'a equipe já respondeu esta conversa',
  paciente: 'paciente da franquia (tratamento, sessão, avaliação recente ou cartão vinculado)',
  'nao-consegui-conferir': 'não consegui conferir (Kommo/banco): na dúvida não convida',
};

/**
 * O robô. Nunca lança. `desligado` = nenhuma leitura, nenhuma consulta (o custo da chave desligada é o de uma comparação).
 */
export function convidarParaWhatsapp(p: PedidoDoConvite, deps: DepsDoConvite = DEPS_PADRAO): Promise<Desfecho> {
  const trabalho = decidir(p, deps);
  // a Sofia (webhook e workers) espera o desfecho deste lead antes de decidir se fala: quem está sendo decidido agora fica registrado
  if (p.isChatMessage && canalDoConvite(p.origem) && conviteWhatsappEstado(p.unit.slug) === 'ligado') registrarEmAndamento(chaveDoConvite(p.unit, p.leadId), trabalho);
  return trabalho;
}

async function decidir(p: PedidoDoConvite, deps: DepsDoConvite): Promise<Desfecho> {
  const { unit, leadId } = p;
  const estado = conviteWhatsappEstado(unit.slug);
  if (estado === 'desligado') return { tipo: 'desligado' };
  const canal = canalDoConvite(p.origem);
  if (!p.isChatMessage || !canal) return { tipo: 'ignorou', motivo: 'nao-e-rede-social' };
  const seco = estado === 'seco';
  const chave = chaveDoConvite(unit, leadId);
  const agoraMs = () => deps.agora?.().getTime() ?? Date.now();
  // uma decisão por conversa por hora: o «não» definitivo (equipe já falou, paciente…) e o «mandaria» do seco não repetem as leituras do Kommo a cada mensagem do lead
  // a memória é POR MODO: o «mandaria» do seco não pode segurar o convite por 1 h depois de ligar a chave
  const memoria = seco ? `${chave}#seco` : chave;
  if (decididoRecentemente(memoria, agoraMs())) return { tipo: 'ja-decidido' };

  const nao = (motivo: MotivoDoConvite, detalhe?: string): Desfecho => {
    if (DEFINITIVOS_DEPOIS_DAS_LEITURAS.has(motivo)) lembrarDecisao(memoria, agoraMs());
    logger.info({ unit: unit.slug, leadId, canal, motivo, detalhe }, `convite-whatsapp${seco ? ' (seco)' : ''}: não convida — ${ROTULO[motivo]}`);
    if (seco) deps.simular(unit, { leadId, acao: 'pularia', alvo: 'mensagem', motivo: `${ROTULO[motivo]}${detalhe ? ` (${detalhe})` : ''}`.slice(0, 480) });
    return { tipo: 'ignorou', motivo, detalhe };
  };

  try {
    if (ehComentario(p.tipoDaMensagem)) return nao('comentario');
    if (emPausa(unit)) return nao('unidade-pausada');
    const numero = numeroDaUnidade(unit, canal);
    if (!numero) return nao('sem-numero');
    // a MESMA rota que cala a Sofia (conviteFalaNaUnidade): Salesbot + campo de resposta, e nunca o modo «bypass» (o texto iria em pedaços de 240
    // caracteres e o link seria cortado). Todo webhook de chat traz `chatId`, então ele não serve de rota: sem Salesbot o envio cairia em nota.
    if (!unit.kommoSalesbotId || !unit.kommoReplyFieldId || unit.kommoBypassSalesbot) return nao('sem-rota-de-envio');
    // o barato primeiro: quem já foi convidado não custa nenhuma leitura do Kommo
    if (!seco && (await deps.jaConvidado(chave))) return nao('ja-convidado');
    if (!seco && freado(chave, agoraMs())) return nao('nao-consegui-conferir', 'o envio anterior falhou há menos de 30 min');

    const cartao = await deps.cartao(unit, leadId, p.contactId);
    if (cartao.pausado) return nao('cartao-pausado');
    if (!cartao.etapaPermite) return nao('etapa-sem-sofia');
    if (cartao.temIdClient) return nao('paciente', 'cartão vinculado à franquia');
    if (await deps.equipeJaFalou(unit, leadId)) return nao('equipe-ja-falou');
    if (cartao.telefone) {
      // o contato TEM telefone: não achar na franquia só vale se a franquia respondeu («índice vencido», timeout, ficha que não veio = não sei = não convida)
      const naFranquia = await deps.pacienteNaFranquia(unit, cartao.telefone);
      if (naFranquia === 'sim') return nao('paciente', 'telefone na franquia');
      if (naFranquia === 'nao-sei') return nao('nao-consegui-conferir', 'a franquia não respondeu sobre o telefone do contato');
    }

    const texto = textoDoConvite({ clinica: deps.clinica(unit), numero, canal });
    if (seco) {
      logger.info({ unit: unit.slug, leadId, canal, texto }, 'convite-whatsapp (seco): mandaria o convite — nada foi enviado');
      deps.simular(unit, { leadId, acao: 'mandaria', alvo: 'mensagem', valor: texto, motivo: `convite ao WhatsApp (${canal})` });
      lembrarDecisao(memoria, agoraMs());
      return { tipo: 'seco', texto, canal };
    }

    // a chave pode ter sido desligada enquanto líamos o cartão (a tela vale em segundos): confere de novo na hora de mandar
    if (conviteWhatsappEstado(unit.slug) !== 'ligado') return nao('nao-consegui-conferir', 'a chave mudou durante a conferência');

    // UMA vez: a marca vai ANTES do envio. Banco que não respondeu = não envia (resposta em dobro é pior que convite perdido).
    const marca = await deps.reivindicar(chave);
    if (marca === 'perdeu') return nao('ja-convidado', 'outra mensagem chegou primeiro');
    if (marca === 'incerto') return nao('nao-consegui-conferir', 'banco não confirmou a marca');

    let entrega: 'entregue' | 'virou-nota';
    try {
      entrega = await deps.enviar(unit, p, texto);
    } catch (err) {
      // NÃO solta a marca: exceção depois de o pedido partir não prova que nada saiu
      logger.error({ err: String(err), unit: unit.slug, leadId, chave }, 'convite-whatsapp: o envio deu erro — a marca FICA (não repete); confira no Kommo se a mensagem saiu');
      return { tipo: 'falhou', detalhe: String(err) };
    }
    if (entrega === 'virou-nota') {
      // SABEMOS que nada saiu (ficou só uma nota no cartão): devolve a marca para a próxima mensagem do lead tentar de novo — a Sofia está calada por causa
      // do robô e o lead não pode ficar 7 dias sem ninguém. O freio de 30 min evita uma nota nova a cada mensagem.
      await deps.soltar(chave).catch(() => undefined);
      freiarDepoisDeFalha(chave, agoraMs());
      logger.error({ unit: unit.slug, leadId, chave }, 'convite-whatsapp: a mensagem virou NOTA no cartão — o lead NÃO recebeu; a marca foi devolvida e o robô tenta de novo em 30 min, na próxima mensagem do lead');
      return { tipo: 'falhou', detalhe: 'virou nota no cartão' };
    }
    // entrega CONFIRMADA: só agora a Sofia passa a se calar neste lead
    await deps.gravarEnviado(chave);
    logger.info({ unit: unit.slug, leadId, canal }, 'convite-whatsapp: convite enviado');
    return { tipo: 'enviou', texto, canal };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'convite-whatsapp: falhou na conferência — não convida');
    return { tipo: 'ignorou', motivo: 'nao-consegui-conferir', detalhe: String(err).slice(0, 200) };
  }
}

// ── as portas reais ────────────────────────────────────────────────────────────────────────────

/** De onde o robô lê o cartão (as fontes reais; o teste troca). TODAS lançam quando a leitura não deu. */
export interface FontesDoCartao {
  kommo(unit: Unit): Pick<KommoClient, 'getLead' | 'isLeadFieldChecked' | 'getContactPhoneOuErro'>;
  esquema(unit: Unit): Promise<EsquemaKommo>;
  globais(): Promise<ReadonlySet<string>>;
  janelaDoLead(unitId: string, leadId: number): Promise<{ ate: Date } | null>;
  temIdClient(unitId: string, leadId: number): Promise<boolean>;
}

const FONTES_REAIS: FontesDoCartao = {
  kommo: (unit) => createKommoClient(unit),
  esquema: (unit) => esquemaDaUnidade(unit, createKommoClient(unit)),
  globais: () => getPausedStagesGlobalSet(),
  janelaDoLead: (unitId, leadId) => prisma.leadPausa.findUnique({ where: { unitId_kommoLeadId: { unitId, kommoLeadId: leadId } }, select: { ate: true } }),
  temIdClient: async (unitId, leadId) => !!(await prisma.spineLeadLink.findFirst({ where: { unitId, kommoLeadId: leadId, spineIdClient: { not: null } }, select: { id: true } })),
};

export async function lerCartao(unit: Unit, leadId: number, contactId: string | null, f: FontesDoCartao = FONTES_REAIS): Promise<LeituraDoCartao> {
  const kommo = f.kommo(unit);
  const lead = await kommo.getLead(leadId);
  // FALHA FECHADA: as duas leituras LANÇAM se não deram (`isLeadPaused`/`leadPausadoPorJanela` devolvem «não pausado» no erro — para o robô isso mandaria o convite
  // com «Pausar IA» marcado, só porque o Kommo respondeu 429)
  const caixinha = unit.kommoPausedFieldId ? await kommo.isLeadFieldChecked(leadId, unit.kommoPausedFieldId) : false;
  const janela = pausaDoLeadAtiva(await f.janelaDoLead(unit.id, leadId));
  const pausado = caixinha || janela;
  const sid = lead.status_id;
  const pid = lead.pipeline_id;

  // as mesmas conferências de etapa da Sofia (allowlist, regra global de etapa, GANHO/ALTA/cancelado)
  let etapaPermite = true;
  const permitidas = unit.kommoAllowedStatusIds ?? [];
  const globais = await f.globais();
  const esquema = await f.esquema(unit); // lança se a conta não abriu: quem chama não convida
  const funis: FunisDaConta | null = precisaDoFunil(permitidas, sid) ? esquema : null;
  if (permitidas.length > 0 && !etapaPermitida(permitidas, sid, pid, funis)) etapaPermite = false;
  if (sid && (globais.has(`*:${sid}`) || (pid && globais.has(`${pid}:${sid}`)))) etapaPermite = false;
  if (sid && pid) {
    const posicao = esquema.nomeDoStatus(pid, sid);
    if (etapaCalada(posicao?.status ?? null, { statusId: sid, pipeline: posicao?.pipeline ?? null })) etapaPermite = false;
  }

  const temIdClient = await f.temIdClient(unit.id, leadId);
  const idContato = contactId && Number.isFinite(Number(contactId)) ? Number(contactId) : null;
  // falha ao ler o telefone NÃO vira «contato sem telefone»: lança, e quem chama não convida
  const telefone = idContato ? await kommo.getContactPhoneOuErro(idContato) : null;
  return { pausado, etapaPermite, temIdClient, telefone };
}

/**
 * O nome que o lead lê: o da própria unidade quando ele já diz «Doutor Hérnia <cidade>» («Doutor Hérnia Caxias», e não «Duque de Caxias»); senão
 * («Resgate · Canaã», «Comercial») a cidade do mapa do ⌂ Unidade da unidade dona da conta.
 */
export function nomeDaClinicaDaUnidade(unit: Pick<Unit, 'slug' | 'name'>): string {
  const nome = String(unit.name ?? '').replace(/\s+/g, ' ').trim();
  if (/^doutor h[eé]rnia\s+\S/i.test(nome)) return nome;
  return nomeDaClinica(cidadeDaUnidade(unidadeDona(unit.slug), unit.name));
}

async function conviteEnviar(unit: Unit, p: PedidoDoConvite, texto: string): Promise<'entregue' | 'virou-nota'> {
  const r = await createKommoClient(unit).sendChatReply({ leadId: p.leadId, text: texto, chatId: p.chatId, talkId: p.talkId, contactId: p.contactId });
  // o webhook que volta com a nossa fala não pode ser tomado por fala da equipe (auto-pausa) — mesmo registro que a Sofia faz
  if (r.via === 'salesbot' || r.via === 'chat_message') {
    const { trackPendingReply } = await import('./stale-reply-monitor.js');
    trackPendingReply({ unitId: unit.id, unitSlug: unit.slug, unitName: unit.name, leadId: String(p.leadId), text: texto });
  }
  return r.via === 'lead_note' ? 'virou-nota' : 'entregue';
}

/**
 * A franquia diz que este TELEFONE é de paciente (tratamento ativo, sessão futura, avaliação recente)? `nao-sei` = a franquia/índice não respondeu (índice
 * vencido ou ainda não carregado, ficha que não veio, timeout): quem chama NÃO convida. Unidade sem franquia conectada: `nao` (não há paciente a achar).
 * Usada pelo Kommo e pelo CRM. Nunca lança.
 */
export async function telefoneNaFranquia(unit: Unit, telefone: string): Promise<'sim' | 'nao' | 'nao-sei'> {
  if (!unit.spineEnabled || !unit.spineToken) return 'nao';
  agendarIndice(unit);
  const sinal = await consultarFranquia(unit, telefone);
  if (sinal.tipo === 'indisponivel') return 'nao-sei';
  return sinalDePaciente(sinal) ? 'sim' : 'nao';
}

export const DEPS_PADRAO: DepsDoConvite = {
  jaConvidado,
  reivindicar: (chave) => reivindicarComCerteza('convite-whatsapp', chave.slice('convite-whatsapp:'.length), VALIDADE_DO_CONVITE_MS),
  gravarEnviado,
  soltar: (chave) => liberarClaim('convite-whatsapp', chave.slice('convite-whatsapp:'.length)),
  cartao: lerCartao,
  async equipeJaFalou(unit, leadId) {
    const msgs = await mensagensOficiaisDaUnidade(unit, createKommoClient(unit) as KommoClient, leadId, 200);
    return falasHumanasDaEquipe(msgs).length > 0;
  },
  pacienteNaFranquia: telefoneNaFranquia,
  clinica: nomeDaClinicaDaUnidade,
  enviar: conviteEnviar,
  simular: (unit, s) => registrarSimulacao(unit, ID_CONVITE_WHATSAPP, s),
};
