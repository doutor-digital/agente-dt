import axios from 'axios';
import { randomUUID } from 'node:crypto';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

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

function sessaoWeb(): string {
  const s = (process.env.KOMMO_WEB_SESSION_ID ?? '').trim();
  if (!s) throw new KommoChatIndisponivel('KOMMO_WEB_SESSION_ID não configurado — sem sessão web não há token de chat');
  return s;
}

interface SessaoCriada {
  access_token: string;
  refresh_token: string;
  expired_at: number;
  user?: { name?: string };
}

/** `POST /ajax/v1/chats/session` com o cookie da sessão web (formato do site: form-urlencoded). */
async function criarTokenDeChat(subdomain: string): Promise<SessaoCriada> {
  const url = `https://${subdomain}.kommo.com/ajax/v1/chats/session`;
  try {
    const { data } = await axios.post<{ response?: { chats?: { session?: SessaoCriada } } }>(
      url,
      'request%5Bchats%5D%5Bsession%5D%5Baction%5D=create',
      {
        headers: {
          Cookie: `session_id=${sessaoWeb()}`,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: `https://${subdomain}.kommo.com/`,
        },
        timeout: 20_000,
      },
    );
    const s = data?.response?.chats?.session;
    if (!s?.access_token || !s.refresh_token || !s.expired_at) {
      throw new KommoChatIndisponivel(`resposta sem token de chat: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return s;
  } catch (err) {
    if (err instanceof KommoChatIndisponivel) throw err;
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    const corpo = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? '').slice(0, 200) : String(err);
    // 401/403/400 "código 103" = sessão web caiu ou não vale nesta conta.
    throw new KommoChatIndisponivel(`sessão web recusada em ${subdomain} (HTTP ${status ?? '?'}): ${corpo}`);
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

/** `POST /v2/{chat_id}/sendMessage` com anexo de voz. Recria o token uma vez se ele for recusado. */
export async function enviarNotaDeVoz(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'kommoAccessToken'>,
  nota: NotaDeVoz,
): Promise<NotaEnviada> {
  const corpo = {
    text: '',
    recipient_id: nota.recipientId,
    group_id: null,
    crm_dialog_id: nota.talkId,
    crm_contact_id: nota.contactId,
    crm_account_id: nota.accountId,
    crm_entity: {},
    attachments: [
      {
        file_id: randomUUID(),
        external_file_id: nota.arquivo.uuid,
        external_file_vers_id: nota.arquivo.versionUuid,
        type: 'voice',
      },
    ],
    skip_link_shortener: false,
    set_personalization: false,
    silent: false,
  };

  const tentar = async (token: string) =>
    axios.post<Array<{ id?: string; delivery_status?: number; error_code?: number; error?: { code?: number; description?: string } }>>(
      `${AMOJO}/v2/${nota.chatId}/sendMessage`,
      corpo,
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
    resposta = await tentar(token);
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    if (status === 401 || status === 403 || status === 404) {
      // Token vencido ou revogado: recria da sessão e tenta UMA vez.
      ({ token } = await obterTokenDeChat(unit, { forcarNovo: true }));
      try {
        resposta = await tentar(token);
      } catch (err2) {
        const s2 = axios.isAxiosError(err2) ? err2.response?.status : undefined;
        throw new KommoChatIndisponivel(`amojo recusou o envio mesmo com token novo (HTTP ${s2 ?? '?'})`);
      }
    } else {
      const corpoErro = axios.isAxiosError(err) ? JSON.stringify(err.response?.data ?? '').slice(0, 200) : String(err);
      throw new KommoChatIndisponivel(`amojo recusou o envio (HTTP ${status ?? '?'}): ${corpoErro}`);
    }
  }

  const msg = Array.isArray(resposta.data) ? resposta.data[0] : undefined;
  if (!msg?.id) throw new KommoChatIndisponivel(`amojo respondeu sem id de mensagem: ${JSON.stringify(resposta.data).slice(0, 200)}`);
  const codigo = msg.error_code ?? msg.error?.code ?? 0;
  if (codigo) throw new KommoChatIndisponivel(`amojo aceitou mas marcou erro ${codigo}: ${msg.error?.description ?? ''}`);
  return { messageId: msg.id, deliveryStatus: msg.delivery_status ?? null };
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
