/**
 * O que só a API da Meta faz, e o Kommo não.
 *
 * O WhatsApp da rede é do Kommo (ele é o provedor). A gente fala com a Meta em
 * paralelo, com um app próprio já inscrito nos webhooks. Isso dá acesso a três
 * coisas que o chat do Kommo não tem: "digitando…", confirmação de leitura,
 * lista interativa e mensagem de localização.
 *
 * ⚠️ A REGRA QUE NASCEU DO TESTE DE 18/09/2026: mensagem enviada por aqui NÃO
 * APARECE NO KOMMO. O Kommo só mostra o que passou por ele. No teste, o João
 * escolheu "08:00" numa lista e o cartão ficou com a resposta sem a pergunta —
 * quem abrisse depois veria um paciente respondendo algo que ninguém perguntou.
 * Pior: a própria Sofia lê a conversa oficial do Kommo pra saber o que já disse,
 * e ficaria cega para as próprias mensagens.
 *
 * Por isso a divisão:
 *  - `marcarLidaEDigitando` é seguro e não precisa de espelho: não é mensagem,
 *    não deixa buraco no histórico.
 *  - `enviarLista` e `enviarLocalizacao` SEMPRE espelham uma nota no cartão.
 *    A nota não é balão de conversa, mas o histórico para de mentir.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';

const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com';
const VERSAO = process.env.META_GRAPH_VERSION || 'v23.0';

/** Endereço de um caminho da Graph API na versão que a casa usa (quem lê modelos/qualidade fala o mesmo endereço). */
export function urlDaGraph(caminho: string): string {
  return `${GRAPH}/${VERSAO}/${caminho.replace(/^\//, '')}`;
}

export interface CredenciaisMeta {
  phoneNumberId: string;
  token: string;
}

/** Só devolve credencial quando a unidade tem AS DUAS pontas configuradas. */
export function credenciaisDaUnidade(
  unit: Pick<Unit, 'metaPhoneNumberId' | 'metaAccessToken'>,
): CredenciaisMeta | null {
  const phoneNumberId = unit.metaPhoneNumberId?.trim();
  const token = unit.metaAccessToken?.trim();
  return phoneNumberId && token ? { phoneNumberId, token } : null;
}

/**
 * O tique azul é uma PROMESSA: diz ao paciente que alguém viu a mensagem dele.
 *
 * Se a IA está pausada (a recepção assumiu) ou fora do horário, marcar como lido
 * e não responder é pior que não marcar nada — hoje o paciente pelo menos supõe
 * que ninguém viu. Por isso o gatilho é a DECISÃO DE RESPONDER, não a chegada
 * da mensagem.
 */
export function devoAvisarQueEstouDigitando(args: {
  pausada: boolean;
  foraDoHorario: boolean;
  comHumano: boolean;
}): boolean {
  return !args.pausada && !args.foraDoHorario && !args.comHumano;
}

async function chamar(
  cred: CredenciaisMeta,
  corpo: Record<string, unknown>,
  opcoes: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; detalhe: unknown; status: number }> {
  const r = await fetch(`${GRAPH}/${VERSAO}/${cred.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...corpo }),
    // Sem teto, uma Meta que não responde trava quem espera (Nygard). Opt-in: quem já chamava continua igual.
    ...(opcoes.timeoutMs ? { signal: AbortSignal.timeout(opcoes.timeoutMs) } : {}),
  });
  const detalhe = await r.json().catch(() => null);
  return { ok: r.ok, detalhe, status: r.status };
}

/**
 * Marca a mensagem do paciente como lida e mostra "digitando…".
 *
 * A Meta exige os dois juntos: sem `status:'read'` recusa com "The parameter
 * status is required", e sem `message_id` recusa também. Testado em 18/09/2026 —
 * não existe caminho só com o número do telefone.
 *
 * O indicador dura ~25 s ou até a resposta chegar. A Sofia responde em 2 a 6 s
 * na mediana, então ele aparece por pouco tempo — que é como uma pessoa
 * digitando rápido se comportaria.
 */
export async function marcarLidaEDigitando(
  cred: CredenciaisMeta,
  wamid: string,
): Promise<boolean> {
  const { ok, detalhe } = await chamar(cred, {
    status: 'read',
    message_id: wamid,
    typing_indicator: { type: 'text' },
  });
  if (!ok) logger.warn({ detalhe }, 'whatsapp-meta: digitando recusado');
  return ok;
}

export interface LinhaDaLista {
  id: string;
  titulo: string;
  descricao?: string;
}

export interface SecaoDaLista {
  titulo: string;
  linhas: LinhaDaLista[];
}

/**
 * Lista nativa — o paciente TOCA no horário em vez de digitar.
 *
 * O ganho não é estético: a resposta volta como o `id` da linha ("h0900"), não
 * como texto. Some a interpretação, e com ela a chance de a IA ler "as 8" como
 * 20h. Conferido no teste: a escolha chegou como `interactive.list_reply.id`.
 *
 * Limites da Meta: 10 linhas no total, título de linha até 24 caracteres.
 */
export async function enviarLista(
  cred: CredenciaisMeta,
  args: { para: string; corpo: string; rotuloBotao: string; secoes: SecaoDaLista[] },
): Promise<{ ok: boolean; detalhe: unknown }> {
  const linhas = args.secoes.reduce((n, s) => n + s.linhas.length, 0);
  if (linhas === 0 || linhas > 10) {
    return { ok: false, detalhe: `lista precisa de 1 a 10 linhas (tem ${linhas})` };
  }
  return chamar(cred, {
    recipient_type: 'individual',
    to: args.para,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: args.corpo },
      action: {
        button: args.rotuloBotao.slice(0, 20),
        sections: args.secoes.map((s) => ({
          title: s.titulo.slice(0, 24),
          rows: s.linhas.map((l) => ({
            id: l.id,
            title: l.titulo.slice(0, 24),
            ...(l.descricao ? { description: l.descricao.slice(0, 72) } : {}),
          })),
        })),
      },
    },
  });
}

/**
 * A clínica como PIN no mapa, não link colado.
 *
 * Exige latitude e longitude de verdade. NUNCA aproximar: pin errado manda o
 * paciente para a porta errada, e ele descobre isso já atrasado. Se a unidade
 * não tem coordenada gravada, esta função nem é chamada — o endereço em texto
 * continua saindo, que é o comportamento de hoje.
 */
export async function enviarLocalizacao(
  cred: CredenciaisMeta,
  args: { para: string; latitude: number; longitude: number; nome: string; endereco: string },
): Promise<{ ok: boolean; detalhe: unknown }> {
  if (!Number.isFinite(args.latitude) || !Number.isFinite(args.longitude)) {
    return { ok: false, detalhe: 'coordenada inválida — não envio pin aproximado' };
  }
  return chamar(cred, {
    recipient_type: 'individual',
    to: args.para,
    type: 'location',
    location: {
      latitude: args.latitude,
      longitude: args.longitude,
      name: args.nome,
      address: args.endereco,
    },
  });
}

export interface CabecalhoDeMidia {
  tipo: 'image' | 'video' | 'document';
  /** Endereço público da mídia. A Meta baixa dele na hora do envio. */
  link: string;
  /** Só para `document`. */
  nomeArquivo?: string;
}

export interface TemplateParaEnviar {
  /** Telefone só com dígitos e DDI (5563999999999). */
  para: string;
  /** Nome do modelo APROVADO na Meta, exatamente como está lá. */
  nome: string;
  /** pt_BR… */
  idioma: string;
  /** Valores de {{1}}, {{2}}… na ordem. */
  corpo?: string[];
  /** Obrigatório quando o modelo foi aprovado com cabeçalho de mídia — a Meta recusa sem ele (14/10: Araguaína 22/22). */
  cabecalho?: CabecalhoDeMidia;
}

/**
 * A Meta recusa quebra de linha, tab e mais de 4 espaços seguidos DENTRO de uma variável, e vazio.
 * Limpamos aqui para o erro não aparecer só no envio.
 */
export function variavelLimpa(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 1024);
}

/** O corpo exato do POST de um modelo. Separado do envio para o teste ver o que sairia sem tocar a rede. */
export function montarCorpoDoTemplate(t: TemplateParaEnviar): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [];
  if (t.cabecalho) {
    const { tipo, link, nomeArquivo } = t.cabecalho;
    components.push({
      type: 'header',
      parameters: [{ type: tipo, [tipo]: { link, ...(tipo === 'document' && nomeArquivo ? { filename: nomeArquivo } : {}) } }],
    });
  }
  if (t.corpo?.length) {
    components.push({ type: 'body', parameters: t.corpo.map((v) => ({ type: 'text', text: variavelLimpa(v) })) });
  }
  return {
    recipient_type: 'individual',
    to: t.para,
    type: 'template',
    template: { name: t.nome, language: { code: t.idioma }, ...(components.length ? { components } : {}) },
  };
}

export interface ResultadoDoTemplate {
  ok: boolean;
  /** id da mensagem na Meta (wamid…): é com ele que o status entregue/lida/falhou é casado depois. */
  wamid: string | null;
  detalhe: unknown;
  /**
   * `true` quando NÃO sabemos se a Meta aceitou (timeout, queda de rede, 5xx). Quem chama nunca reenvia
   * sozinho: reenviar um envio incerto é mandar duas vezes para o paciente.
   */
  incerto: boolean;
}

const TIMEOUT_DO_TEMPLATE_MS = 20_000;

/**
 * Manda um modelo (template) aprovado — o único tipo de mensagem que a Meta deixa abrir uma conversa fora
 * da janela de 24 h. Mesma credencial e mesmo caminho dos envios acima.
 *
 * ⚠️ Como `enviarLista`, isto NÃO aparece no Kommo. Quem chama em produção tem de espelhar uma nota no cartão
 * (ver `disparo/enviar.ts`), senão a resposta do paciente chega sem a pergunta.
 */
export async function enviarTemplate(
  cred: CredenciaisMeta,
  t: TemplateParaEnviar,
  opcoes: { timeoutMs?: number } = {},
): Promise<ResultadoDoTemplate> {
  if (!/^\d{10,15}$/.test(t.para)) return { ok: false, wamid: null, detalhe: 'telefone fora do formato (só dígitos com DDI)', incerto: false };
  if (!t.nome.trim() || !t.idioma.trim()) return { ok: false, wamid: null, detalhe: 'modelo sem nome ou idioma', incerto: false };
  try {
    const { ok, detalhe, status } = await chamar(cred, montarCorpoDoTemplate(t), { timeoutMs: opcoes.timeoutMs ?? TIMEOUT_DO_TEMPLATE_MS });
    const wamid = (detalhe as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]?.id ?? null;
    if (ok && !wamid) return { ok: false, wamid: null, detalhe, incerto: true };
    return { ok, wamid, detalhe, incerto: !ok && status >= 500 };
  } catch (err) {
    return { ok: false, wamid: null, detalhe: String(err), incerto: true };
  }
}

/**
 * O texto do espelho que vai para a nota do cartão.
 *
 * Existe porque o Kommo não registra o que sai por fora dele. Sem esta nota, a
 * equipe vê a resposta do paciente sem a pergunta.
 */
export function espelhoParaNota(
  tipo: 'lista' | 'localizacao',
  resumo: string,
): string {
  const oQue = tipo === 'lista' ? 'lista de opções' : 'localização (pin no mapa)';
  return (
    `📲 A Sofia enviou uma ${oQue} pelo WhatsApp.\n` +
    `${resumo}\n\n` +
    'Esta nota existe porque o Kommo não mostra mensagem enviada por fora dele. ' +
    'O paciente recebeu normalmente.'
  );
}

/** Resumo legível da lista, para a nota. */
export function resumirLista(secoes: SecaoDaLista[]): string {
  return secoes
    .map((s) => `${s.titulo}: ${s.linhas.map((l) => l.titulo).join(', ')}`)
    .join(' · ');
}
