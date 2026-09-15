import axios from 'axios';
import { randomUUID } from 'node:crypto';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { decidirProva } from '../lib/prova-de-sessao.js';

/**
 * Serviço de chat interno do Kommo ("amojo") — o que o SITE usa para mandar nota de voz.
 *
 * Por que existe: a API oficial não tem mídia no caminho da IA. O `execute_handlers`
 * do widget só aceita texto/botões ("Unsupported handler code" para send_message), e
 * o passo de voz do Salesbot é um arquivo fixo que a API não deixa trocar (PATCH
 * /bots 405). Testado em 02/09 e 05/09/2026. Já a rota que o navegador usa quando um
 * humano grava um áudio funcionou do servidor, sem navegador, e entregou no WhatsApp
 * (05/09/2026, número do João, delivery_status 2).
 *
 * Como se autentica: NÃO é o Bearer da integração. É um "token de chat" criado a
 * partir da sessão WEB de um usuário (cookie `session_id`), via
 * `POST /ajax/v1/chats/session`. Vale ~3 dias e fica em `kommo_chat_sessions` por
 * unidade. A mesma sessão serve para todas as contas em que o usuário existe
 * (conferido em Taubaté, Rio Verde, Imperatriz e Araguaína). A mensagem sai em nome
 * desse usuário — hoje "Doutor Digital".
 *
 * Fragilidades assumidas (decisão do João, 05/09): API não oficial e sessão que pode
 * cair. Por isso TODA falha aqui é exceção, e quem chama cai em texto pelo caminho
 * normal. Mapeado no código do site: chunk 61179 (rotas, `X-Auth-Token`) e 8180
 * (gravador de voz: `attachments[{file_id, external_file_id, external_file_vers_id,
 * type:'voice'}]` em `POST /v2/{chat_id}/sendMessage?stand=v16`).
 */

const AMOJO = process.env.KOMMO_AMOJO_SERVER || 'https://amojo.kommo.com';
const STAND = process.env.KOMMO_AMOJO_STAND || 'v16';
/** Recria o token quando faltar menos que isto para vencer. */
const MARGEM_MS = 12 * 60 * 60_000;

export class KommoChatIndisponivel extends Error {}

/**
 * Cookies da sessão web: o banco (versão mais nova, já rotacionada) manda; o env é
 * a semente. O `refresh_token` é o que vale por 91 dias — com ele a Kommo emite
 * sessão nova mesmo quando o `session_id` já caducou.
 */
async function cookiesDaSessao(): Promise<{ sessionId: string; refreshToken: string; cookie: string }> {
  const row = await prisma.kommoWebSession.findUnique({ where: { id: 'default' } }).catch(() => null);
  const sessionId = (row?.sessionId || process.env.KOMMO_WEB_SESSION_ID || '').trim();
  const refreshToken = (row?.refreshToken || process.env.KOMMO_WEB_REFRESH_TOKEN || '').trim();
  if (!sessionId && !refreshToken) {
    throw new KommoChatIndisponivel('sem sessão web do Kommo (KOMMO_WEB_SESSION_ID / KOMMO_WEB_REFRESH_TOKEN) — não há token de chat');
  }
  const partes = [sessionId && `session_id=${sessionId}`, refreshToken && `refresh_token=${refreshToken}`].filter(Boolean);
  return { sessionId, refreshToken, cookie: partes.join('; ') };
}

/** Guarda o que a Kommo mandou de volta em Set-Cookie (rotação de session_id/refresh_token). */
async function guardarCookiesRotacionados(setCookie: string[] | undefined, userName?: string | null): Promise<void> {
  const novos: Record<string, string> = {};
  for (const linha of setCookie ?? []) {
    const m = /^(session_id|refresh_token)=([^;]*)/.exec(linha);
    if (m && m[2]) novos[m[1]] = m[2];
  }
  const agora = new Date();
  await prisma.kommoWebSession
    .upsert({
      where: { id: 'default' },
      update: {
        ...(novos.session_id ? { sessionId: novos.session_id } : {}),
        ...(novos.refresh_token ? { refreshToken: novos.refresh_token } : {}),
        ...(userName ? { userName } : {}),
        ultimoOk: agora,
        ultimoErro: null,
      },
      create: {
        id: 'default',
        sessionId: novos.session_id || process.env.KOMMO_WEB_SESSION_ID || null,
        refreshToken: novos.refresh_token || process.env.KOMMO_WEB_REFRESH_TOKEN || null,
        userName: userName ?? null,
        ultimoOk: agora,
      },
    })
    .catch((err) => logger.warn({ err: String(err) }, 'kommo-chat: não consegui guardar cookies rotacionados'));
  if (novos.session_id || novos.refresh_token) {
    logger.info({ rotacionou: Object.keys(novos) }, 'kommo-chat: sessão web rotacionada e guardada');
  }
}

async function registrarFalhaDeSessao(motivo: string): Promise<void> {
  await prisma.kommoWebSession
    .upsert({ where: { id: 'default' }, update: { ultimoErro: motivo.slice(0, 500) }, create: { id: 'default', ultimoErro: motivo.slice(0, 500) } })
    .catch(() => undefined);
}

interface SessaoCriada {
  access_token: string;
  refresh_token: string;
  expired_at: number;
  user?: { name?: string };
}

/** `POST /ajax/v1/chats/session` com os cookies da sessão web (formato do site: form-urlencoded). */
async function criarTokenDeChat(subdomain: string): Promise<SessaoCriada> {
  const url = `https://${subdomain}.kommo.com/ajax/v1/chats/session`;
  const { cookie } = await cookiesDaSessao();
  try {
    const resp = await axios.post<{ response?: { chats?: { session?: SessaoCriada } } }>(
      url,
      'request%5Bchats%5D%5Bsession%5D%5Baction%5D=create',
      {
        headers: {
          Cookie: cookie,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
          Referer: `https://${subdomain}.kommo.com/`,
        },
        timeout: 20_000,
      },
    );
    const s = resp.data?.response?.chats?.session;
    if (!s?.access_token || !s.refresh_token || !s.expired_at) {
      throw new KommoChatIndisponivel(`resposta sem token de chat: ${JSON.stringify(resp.data).slice(0, 200)}`);
    }
    await guardarCookiesRotacionados(resp.headers['set-cookie'] as string[] | undefined, s.user?.name ?? null);
    return s;
  } catch (err) {
    if (err instanceof KommoChatIndisponivel) throw err;
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const corpo = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? '').slice(0, 200) : String(err);
    const motivo = `sessão web recusada em ${subdomain} (HTTP ${status ?? '?'}): ${corpo}`;
    // 401/403/400 "código 103" = sessão web caiu ou não vale nesta conta.
    await registrarFalhaDeSessao(motivo);
    throw new KommoChatIndisponivel(motivo);
  }
}

async function amojoAccountId(unit: Pick<Unit, 'kommoSubdomain' | 'kommoAccessToken'>): Promise<string | null> {
  try {
    const { data } = await axios.get<{ amojo_id?: string }>(
      `https://${unit.kommoSubdomain}.kommo.com/api/v4/account`,
      { params: { with: 'amojo_id' }, headers: { Authorization: `Bearer ${unit.kommoAccessToken}` }, timeout: 15_000 },
    );
    return data?.amojo_id ?? null;
  } catch {
    return null;
  }
}

export interface TokenDeChat {
  token: string;
  amojoAccountId: string | null;
}

/** Token válido para a unidade — do banco se ainda vale, senão recriado da sessão web. */
export async function obterTokenDeChat(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'kommoAccessToken'>,
  opts: { forcarNovo?: boolean } = {},
): Promise<TokenDeChat> {
  if (!unit.kommoSubdomain) throw new KommoChatIndisponivel('unidade sem subdomínio do Kommo');
  const atual = await prisma.kommoChatSession.findUnique({ where: { unitId: unit.id } });
  if (!opts.forcarNovo && atual && atual.expiresAt.getTime() - Date.now() > MARGEM_MS) {
    return { token: atual.accessToken, amojoAccountId: atual.amojoAccountId };
  }
  const s = await criarTokenDeChat(unit.kommoSubdomain);
  const amojoId = atual?.amojoAccountId ?? (await amojoAccountId(unit));
  const salvo = await prisma.kommoChatSession.upsert({
    where: { unitId: unit.id },
    update: {
      subdomain: unit.kommoSubdomain,
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      expiresAt: new Date(s.expired_at * 1000),
      amojoAccountId: amojoId,
      userName: s.user?.name ?? null,
    },
    create: {
      unitId: unit.id,
      subdomain: unit.kommoSubdomain,
      accessToken: s.access_token,
      refreshToken: s.refresh_token,
      expiresAt: new Date(s.expired_at * 1000),
      amojoAccountId: amojoId,
      userName: s.user?.name ?? null,
    },
  });
  logger.info(
    { unit: unit.slug, expiraEm: salvo.expiresAt.toISOString(), usuario: salvo.userName },
    'kommo-chat: token de chat criado a partir da sessão web',
  );
  return { token: salvo.accessToken, amojoAccountId: salvo.amojoAccountId };
}

export interface RenovacaoDeTokens {
  verificadas: number;
  renovadas: number;
  falhas: Array<{ slug: string; erro: string }>;
}

/**
 * Renova os tokens de chat das unidades com voz ligada que vencem em menos de
 * `margemHoras`. É o que mantém a voz de pé sem ninguém abrir o Kommo: cada renovação
 * usa (e rotaciona) o refresh_token da sessão web guardada no banco.
 */
export async function renovarTokensDeChat(margemHoras = 48): Promise<RenovacaoDeTokens> {
  const units = await prisma.unit.findMany({
    where: { voiceReplyEnabled: true, isActive: true, kommoAccessToken: { not: null } },
    select: { id: true, slug: true, kommoSubdomain: true, kommoAccessToken: true },
    orderBy: { slug: 'asc' },
  });
  const limite = Date.now() + margemHoras * 3_600_000;
  const out: RenovacaoDeTokens = { verificadas: units.length, renovadas: 0, falhas: [] };
  for (const u of units) {
    const atual = await prisma.kommoChatSession.findUnique({ where: { unitId: u.id } });
    if (atual && atual.expiresAt.getTime() > limite) continue;
    try {
      await obterTokenDeChat(u, { forcarNovo: true });
      out.renovadas += 1;
    } catch (err) {
      out.falhas.push({ slug: u.slug, erro: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return out;
}

export interface ProvaDeSessao {
  /** false = não era hora de provar (prova recente, ou a varredura já renovou) */
  testou: boolean;
  ok: boolean;
  erro?: string;
  /** dias até o primeiro token de chat vencer; null quando não há token */
  margemDias: number | null;
  idadeDias: number | null;
}

/**
 * Emite um token de teste para PROVAR que a sessão web ainda funciona.
 *
 * Existe porque renovar só acontece nas últimas 48 h de vida do token: entre uma
 * renovação e outra, ninguém toca na sessão e ninguém sabe se ela ainda vale. Se
 * ela tiver caído, a descoberta vem tarde demais. Aqui a falha aparece com dias de
 * antecedência — e `ultimo_ok` passa a significar "última vez que provamos que
 * funciona", que é o que eu achei que ele significava quando dei alarme falso em
 * 15/09/2026.
 */
export async function provarSessaoWeb(
  opts: { renovouAgora?: boolean; diasSemProva?: number; agora?: Date } = {},
): Promise<ProvaDeSessao> {
  const agora = opts.agora ?? new Date();
  const sessao = await prisma.kommoWebSession.findUnique({ where: { id: 'default' } });
  const d = decidirProva(sessao?.ultimoOk ?? null, agora, opts);

  const primeiro = await prisma.kommoChatSession.findFirst({ orderBy: { expiresAt: 'asc' }, select: { expiresAt: true } });
  const margemDias = primeiro ? (primeiro.expiresAt.getTime() - agora.getTime()) / 86_400_000 : null;

  if (!d.provar) return { testou: false, ok: true, margemDias, idadeDias: d.idadeDias };

  const unit = await prisma.unit.findFirst({
    where: { voiceReplyEnabled: true, isActive: true, kommoAccessToken: { not: null }, kommoSubdomain: { not: null } },
    select: { id: true, slug: true, kommoSubdomain: true, kommoAccessToken: true },
    orderBy: { slug: 'asc' },
  });
  // Sem unidade com voz ligada não há o que provar nem o que quebrar.
  if (!unit) return { testou: false, ok: true, margemDias, idadeDias: d.idadeDias };

  try {
    await obterTokenDeChat(unit, { forcarNovo: true });
    logger.info({ unidade: unit.slug, motivo: d.motivo }, 'voz-sessao: sessão web provada');
    return { testou: true, ok: true, margemDias, idadeDias: d.idadeDias };
  } catch (err) {
    const erro = err instanceof Error ? err.message : String(err);
    await registrarFalhaDeSessao(erro);
    logger.warn({ unidade: unit.slug, erro }, 'voz-sessao: sessão web NÃO emite token novo');
    return { testou: true, ok: false, erro, margemDias, idadeDias: d.idadeDias };
  }
}

export interface NotaDeVoz {
  chatId: string;
  /** Id (amojo) do paciente — `author.id` da mensagem que ele mandou. */
  recipientId: string;
  /** talk_id do Kommo = dialog_id do amojo. */
  talkId: number | null;
  contactId: number | null;
  /** Id numérico da conta Kommo. */
  accountId: number | null;
  arquivo: { uuid: string; versionUuid: string; nome: string };
}

export interface NotaEnviada {
  messageId: string;
  deliveryStatus: number | null;
}

/**
 * O que o chat do Kommo aceita numa mensagem nossa (provado em 12/09/2026 no chat
 * do João, Araguaína): texto, anexo (`voice`, `picture`, `file`, `video`, sempre
 * via Drive do Kommo) e botões de resposta rápida (`reply_markup` inline, máx. 3,
 * até 20 caracteres, só texto — botão com link exige template aprovado, erro 3130).
 * Localização não existe por este caminho (417/400; o site do Kommo só lê).
 * O toque no botão volta como mensagem de texto normal com o rótulo.
 */
export const MAX_BOTOES = 3;
export const MAX_CHARS_BOTAO = 20;

export type TipoDeAnexo = 'voice' | 'picture' | 'file' | 'video';

export interface MensagemDeChat {
  chatId: string;
  /** Id (amojo) do paciente — `author.id` da mensagem que ele mandou. */
  recipientId: string;
  /** talk_id do Kommo = dialog_id do amojo. Talk encerrada dá DIALOG_CLOSED; `null` abre outra. */
  talkId: number | null;
  contactId: number | null;
  accountId: number | null;
  texto?: string;
  anexo?: { uuid: string; versionUuid: string; tipo: TipoDeAnexo };
  botoes?: string[];
}

/** `POST /v2/{chat_id}/sendMessage`. Recria o token uma vez se ele for recusado. */
export async function enviarMensagemDeChat(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'kommoAccessToken'>,
  m: MensagemDeChat,
): Promise<NotaEnviada> {
  const montar = (talkId: number | null): Record<string, unknown> => {
    const corpo: Record<string, unknown> = {
      text: m.texto ?? '',
      recipient_id: m.recipientId,
      group_id: null,
      crm_dialog_id: talkId,
      crm_contact_id: m.contactId,
      crm_account_id: m.accountId,
      crm_entity: {},
      skip_link_shortener: false,
      set_personalization: false,
      silent: false,
    };
    if (m.anexo) {
      corpo.attachments = [
        { file_id: randomUUID(), external_file_id: m.anexo.uuid, external_file_vers_id: m.anexo.versionUuid, type: m.anexo.tipo },
      ];
    }
    if (m.botoes?.length) {
      corpo.reply_markup = {
        mode: 'inline',
        buttons: m.botoes.slice(0, MAX_BOTOES).map((t) => [{ text: t.slice(0, MAX_CHARS_BOTAO) }]),
      };
    }
    return corpo;
  };

  const tentar = async (token: string, talkId: number | null) =>
    axios.post<Array<{ id?: string; delivery_status?: number; error_code?: number; error?: { code?: number; description?: string } }>>(
      `${AMOJO}/v2/${m.chatId}/sendMessage`,
      montar(talkId),
      {
        params: { stand: STAND },
        headers: {
          'X-Auth-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: `https://${unit.kommoSubdomain}.kommo.com`,
          Referer: `https://${unit.kommoSubdomain}.kommo.com/`,
        },
        timeout: 30_000,
      },
    );

  let { token } = await obterTokenDeChat(unit);
  let resposta;
  try {
    resposta = await tentar(token, m.talkId);
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const corpoErro = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? '').slice(0, 200) : String(err);
    if (status === 401 || status === 403 || status === 404) {
      // Token vencido ou revogado: recria da sessão e tenta UMA vez.
      ({ token } = await obterTokenDeChat(unit, { forcarNovo: true }));
      try {
        resposta = await tentar(token, m.talkId);
      } catch (err2) {
        const s2 = axios.isAxiosError(err2) ? err2.response?.status : undefined;
        throw new KommoChatIndisponivel(`amojo recusou o envio mesmo com token novo (HTTP ${s2 ?? '?'})`);
      }
    } else if (status === 400 && m.talkId != null && /DIALOG_CLOSED/i.test(corpoErro)) {
      // A talk fechou (auto-close do Kommo). Sem dialog o amojo abre outra e entrega.
      try {
        resposta = await tentar(token, null);
      } catch (err3) {
        const s3 = axios.isAxiosError(err3) ? err3.response?.status : undefined;
        throw new KommoChatIndisponivel(`amojo recusou o envio sem dialog (HTTP ${s3 ?? '?'})`);
      }
    } else {
      throw new KommoChatIndisponivel(`amojo recusou o envio (HTTP ${status ?? '?'}): ${corpoErro}`);
    }
  }

  const msg = Array.isArray(resposta.data) ? resposta.data[0] : undefined;
  if (!msg?.id) throw new KommoChatIndisponivel(`amojo respondeu sem id de mensagem: ${JSON.stringify(resposta.data).slice(0, 200)}`);
  const codigo = msg.error_code ?? msg.error?.code ?? 0;
  if (codigo) throw new KommoChatIndisponivel(`amojo aceitou mas marcou erro ${codigo}: ${msg.error?.description ?? ''}`);
  return { messageId: msg.id, deliveryStatus: msg.delivery_status ?? null };
}

/** Nota de voz = mensagem de chat sem texto e com anexo `voice`. */
export async function enviarNotaDeVoz(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'kommoAccessToken'>,
  nota: NotaDeVoz,
): Promise<NotaEnviada> {
  return enviarMensagemDeChat(unit, {
    chatId: nota.chatId,
    recipientId: nota.recipientId,
    talkId: nota.talkId,
    contactId: nota.contactId,
    accountId: nota.accountId,
    texto: '',
    anexo: { uuid: nota.arquivo.uuid, versionUuid: nota.arquivo.versionUuid, tipo: 'voice' },
  });
}

export interface EntregaVerificada {
  encontrada: boolean;
  deliveryStatus: number | null;
  erro: string | null;
}

/**
 * Relê as últimas mensagens do chat e diz o que o Kommo fez com a nossa.
 * `delivery_status` 2 = entregue no WhatsApp (mesmo valor das mensagens de texto).
 * Erro conhecido só quando o próprio Kommo marcou `error_code` na mensagem.
 */
export async function verificarEntregaDaNota(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'kommoAccessToken'>,
  chatId: string,
  messageId: string,
): Promise<EntregaVerificada> {
  const { token, amojoAccountId } = await obterTokenDeChat(unit);
  if (!amojoAccountId) return { encontrada: false, deliveryStatus: null, erro: null };
  const { data } = await axios.get<Array<{ id?: string; delivery_status?: number; error_code?: number; error?: { code?: number; description?: string } }>>(
    `${AMOJO}/chats/${amojoAccountId}/${chatId}/messages`,
    { params: { stand: STAND, limit: 10 }, headers: { 'X-Auth-Token': token, Accept: 'application/json' }, timeout: 20_000 },
  );
  const m = (Array.isArray(data) ? data : []).find((x) => x.id === messageId);
  if (!m) return { encontrada: false, deliveryStatus: null, erro: null };
  const codigo = m.error_code ?? m.error?.code ?? 0;
  return {
    encontrada: true,
    deliveryStatus: m.delivery_status ?? null,
    erro: codigo ? `${codigo}: ${m.error?.description ?? ''}` : null,
  };
}

/**
 * O que pode virar áudio. Espelho do paciente (ele mandou áudio) é decisão de quem
 * chama; aqui é só o TEXTO: curto, sem link, sem chave/documento, sem bloco
 * estruturado (confirmação, lista de horários) — ninguém decora uma chave Pix ouvindo.
 */
export function podeVirarAudio(texto: string): { ok: boolean; motivo?: string } {
  const t = texto.trim();
  if (!t) return { ok: false, motivo: 'texto vazio' };
  if (t.length > 900) return { ok: false, motivo: 'texto longo (>900 caracteres)' };
  if (/https?:\/\/|www\./i.test(t)) return { ok: false, motivo: 'contém link' };
  if (/\S+@\S+\.\S+/.test(t)) return { ok: false, motivo: 'contém e-mail (chave Pix)' };
  if (/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t)) return { ok: false, motivo: 'contém CNPJ/CPF (chave Pix)' };
  if (/\d[\d\s().-]{9,}\d/.test(t)) return { ok: false, motivo: 'contém número longo (telefone/chave)' };
  if (/[✅⭐⏰⏳✨]|^\s*[-•▪]\s/m.test(t)) return { ok: false, motivo: 'bloco estruturado (confirmação/lista)' };
  if ((t.match(/\n/g) ?? []).length > 3) return { ok: false, motivo: 'muitas linhas' };
  return { ok: true };
}
