/**
 * A MARCA da mensagem de espera («Recebemos sua mensagem 😊 Já já alguém da equipe te responde.») e da nota de passagem da Sofia.
 *
 * Por que isto é um arquivo à parte, sem import nenhum: quem LÊ a conversa precisa reconhecer a nossa mensagem de espera para NÃO a tomar por
 * resposta da equipe — a pausa (não pode pausar a Sofia nem tirar a etiqueta `sofia-atendendo`), a rodada da Sofia (`falasDaConversa`: a
 * última fala pública nossa = «a equipe respondeu», e a Sofia ficaria calada), a régua (`sem-resposta-24h` conta do último «nosso») e a tela
 * Hoje. Todos importam daqui; nenhum importa o worker da demora.
 */

/** O id desta automação no catálogo (`lib/automacoes.ts`). Mora aqui (sem imports) para a régua poder perguntar o estado dela sem puxar o resto. */
export const AUTOMACAO_DEMORA = 'chatwoot-demora';

const RODAPE_DA_ESPERA = 'Recebemos sua mensagem 😊 Já já alguém da equipe te responde.';
const MARCA_DA_ESPERA = /Recebemos sua mensagem 😊 Já já alguém da equipe te responde\.\s*$/u;

/** O texto ao paciente. Sem nome seguro, só «Oi!». */
export function textoDaEspera(primeiroNome: string | null | undefined): string {
  return `${primeiroNome ? `Oi, ${primeiroNome}!` : 'Oi!'} ${RODAPE_DA_ESPERA}`;
}

const saiu = (tipo: unknown): boolean => tipo === 1 || tipo === 3 || tipo === 'outgoing' || tipo === 'template' || tipo === '1' || tipo === '3';

/**
 * É a nossa mensagem de espera? Serve para a mensagem crua da API (`message_type` numérico) e para o corpo do webhook (`message_type`
 * em texto, o texto em `content`). Só vale mensagem de SAÍDA e pública: o paciente que cita a frase não a transforma em marca.
 */
export function ehMensagemDeEspera(m: any): boolean {
  if (!m || m.private === true || !saiu(m.message_type)) return false;
  const ca = m.content_attributes;
  if (ca && typeof ca === 'object' && (ca as { demora_espera?: unknown }).demora_espera === true) return true;
  return typeof m.content === 'string' && MARCA_DA_ESPERA.test(m.content);
}

/** O trecho que a nota privada de passagem da Sofia carrega («🙋 A Sofia passou esta conversa para você: …» / «🙋 Sofia passou esta conversa para a equipe: …»). */
export const TRECHO_DA_PASSAGEM = 'Sofia passou esta conversa';

export const ehNotaDePassagem = (conteudo: unknown): boolean => typeof conteudo === 'string' && conteudo.includes(TRECHO_DA_PASSAGEM);
