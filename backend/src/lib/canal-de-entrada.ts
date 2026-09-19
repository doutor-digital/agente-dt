/**
 * Por onde a mensagem do paciente ENTRA: Kommo ou Meta.
 *
 * O agente tem dois caminhos de entrada. O do Kommo é o que roda em toda a rede:
 * o CRM recebe a mensagem e chama nosso webhook. O da Meta é direto do WhatsApp
 * Cloud API, e hoje não está montado em unidade nenhuma.
 *
 * A versão anterior disto deduzia o canal pela presença de credencial:
 *
 *     !!unit.metaPhoneNumberId && !!unit.metaAccessToken
 *
 * E aí bastava gravar as credenciais da Meta numa unidade para o caminho do
 * Kommo ser desligado nela. Foi o que aconteceu com Mossoró em 18/09/2026: as
 * credenciais entraram para o vigia de qualidade do número e para o "digitando…"
 * — ferramentas de SAÍDA, que não têm nada a ver com por onde a mensagem chega —
 * e a partir dali toda mensagem que o Kommo mandava era descartada com
 * "Meta é canal primário, ignorando gatilho do agente". A unidade ficou muda por
 * um dia inteiro, com zero execuções, sem nenhum erro em lugar nenhum: o webhook
 * respondia 200 e jogava fora.
 *
 * Agora é declaração, não dedução. Lista vazia — o padrão — significa que todo
 * mundo entra pelo Kommo. Uma unidade só passa a entrar pela Meta quando alguém
 * escrever o slug dela em `META_INBOUND_SLUGS`, de propósito, sabendo que está
 * trocando o canal de entrada.
 *
 * Mesmo formato das outras listas do sistema (`FRANQUIA_MOVE_SLUGS`,
 * `AVISO_AGENDAMENTO_SLUGS`): vírgula separa, `*` liga em todas.
 */

export function entraPelaMeta(slug: string, lista = process.env.META_INBOUND_SLUGS): boolean {
  const raw = (lista ?? '').trim();
  if (!raw) return false;
  const itens = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return itens.has('*') || itens.has(slug);
}
