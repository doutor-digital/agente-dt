/**
 * ROBÔ «CONVITE AO WHATSAPP» — a parte pura (estado, canal, número, texto, link). Pedido do João, 26/11/2026:
 * quando um lead escreve no Instagram ou no Facebook (Direct/Messenger), um robô (NÃO é a Sofia) responde UMA vez convidando para o WhatsApp
 * da clínica, com link, para a conversa não se estender na rede social.
 *
 * Mora à parte, sem importar banco nem Kommo, por dois motivos: o Kommo (`convite-whatsapp.ts`) e o CRM (`chatwoot-convite-whatsapp.ts`)
 * usam o MESMO texto, o MESMO número e a MESMA chave; e a Sofia (`sofia-so-whatsapp.ts`) precisa saber se o robô está ligado numa unidade
 * (onde ele fala, ela se cala no Instagram/Facebook) sem que um importe o outro.
 *
 * Chave `convite-whatsapp` (por unidade; env `CONVITE_WHATSAPP_SLUGS`, padrão DESLIGADA):
 *  - `seco`      → decide tudo (inclusive o texto) e REGISTRA «mandaria convite para X» na tela «Só no papel»; não envia nada;
 *  - `ligado`    → envia (uma vez por conversa; de novo só depois de 7 dias) e a Sofia não fala no Instagram/Facebook desta unidade;
 *  - `desligado` → nada roda: nem leitura, nem consulta.
 */
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';

export const ID_CONVITE_WHATSAPP = 'convite-whatsapp';

/** Quanto tempo até o robô poder convidar de novo a mesma conversa. */
export const DIAS_ENTRE_CONVITES = 7;
export const VALIDADE_DO_CONVITE_MS = DIAS_ENTRE_CONVITES * 86_400_000;

export function conviteWhatsappEstado(slug: string, raw: string | undefined = process.env.CONVITE_WHATSAPP_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_CONVITE_WHATSAPP, raw);
}

export type CanalDoConvite = 'Instagram' | 'Facebook';

/**
 * O canal pelo que o Kommo informa em `origin` (`instagram_business`, `facebook`) ou pelo tipo da caixa do Chatwoot (`Channel::Instagram`,
 * `Channel::FacebookPage`). `null` = não é rede social (WhatsApp, desconhecido): o robô não age.
 */
export function canalDoConvite(origem: string | null | undefined): CanalDoConvite | null {
  if (typeof origem !== 'string') return null;
  if (/instagram/i.test(origem)) return 'Instagram';
  if (/facebook|messenger/i.test(origem)) return 'Facebook';
  return null;
}

/**
 * O telefone como o cadastro da unidade o guarda («(11) 99999-0000», «5511999990000», «+55 11 99999-0000») → só dígitos, com o 55.
 * `null` se não parece um número do Brasil (10 ou 11 dígitos com DDD, mais o 55): NUNCA se completa nem se adivinha dígito.
 */
export function numeroDoWhatsapp(bruto: unknown): string | null {
  const d = String(bruto ?? '').replace(/\D/g, '');
  if (!d) return null;
  const comPais = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d : d.length === 10 || d.length === 11 ? `55${d}` : null;
  if (!comPais) return null;
  const ddd = Number(comPais.slice(2, 4));
  return ddd >= 11 && ddd <= 99 ? comPais : null;
}

/** O texto que o lead manda quando toca no link: serve também para marcar a ORIGEM no WhatsApp (ver `fraseDeOrigem`). */
export function textoPreEscrito(canal: CanalDoConvite): string {
  return `Olá! Vim pelo ${canal} e quero saber mais.`;
}

/** A frase (sem «Olá!») que identifica o lead que veio do convite: cadastrar em `origem_por_texto` (`contem: true`). */
export function fraseDeOrigem(canal: CanalDoConvite): string {
  return `Vim pelo ${canal} e quero saber mais`;
}

export function linkDoWhatsapp(numero: string, canal: CanalDoConvite): string {
  return `https://wa.me/${numero}?text=${encodeURIComponent(textoPreEscrito(canal))}`;
}

/** «Doutor Hérnia Salto». O nome da cidade vem de quem chama (o mapa do ⌂ Unidade); vazio = só «Doutor Hérnia». */
export function nomeDaClinica(cidade: string | null | undefined): string {
  const c = String(cidade ?? '')
    .replace(/\s*\/\s*[A-Za-z]{2}\s*$/, '') // «Marabá/PA» → «Marabá»
    .trim();
  return c ? `Doutor Hérnia ${c}` : 'Doutor Hérnia';
}

/** O texto padrão (o João aprova na prévia). Uma mensagem só, o link no fim. */
export function textoDoConvite(a: { clinica: string; numero: string; canal: CanalDoConvite }): string {
  return `Oi! 😊 Aqui é da ${a.clinica}. Para te atender mais rápido e já ver os horários, continue pelo nosso WhatsApp: 👉 ${linkDoWhatsapp(a.numero, a.canal)}`;
}

/** O que o cadastro da unidade tem de número: `units.ig_whatsapp_number` / `units.fb_whatsapp_number` (os mesmos do agente de comentários). */
export interface NumerosDaUnidade {
  igWhatsappNumber?: string | null;
  fbWhatsappNumber?: string | null;
}

/** O número do convite: o do canal da conversa e, se não houver, o outro (é o mesmo WhatsApp da clínica). Nunca inventa. */
export function numeroDaUnidade(u: NumerosDaUnidade | null | undefined, canal: CanalDoConvite): string | null {
  const [primeiro, segundo] = canal === 'Instagram' ? [u?.igWhatsappNumber, u?.fbWhatsappNumber] : [u?.fbWhatsappNumber, u?.igWhatsappNumber];
  return numeroDoWhatsapp(primeiro) ?? numeroDoWhatsapp(segundo);
}

/** A rota de envio da unidade no Kommo: Salesbot + campo de resposta, sem o modo «bypass» (que corta o texto em pedaços de 240 caracteres). */
export interface RotaDeEnvioDaUnidade {
  kommoSalesbotId?: number | null;
  kommoReplyFieldId?: number | null;
  kommoBypassSalesbot?: boolean | null;
}

/** A unidade tem rota de envio pelo Salesbot no Kommo (Salesbot + campo de resposta, sem bypass)? É o que separa o caminho do Kommo do do CRM. */
export function temRotaDeEnvioNoKommo(u: RotaDeEnvioDaUnidade): boolean {
  return !!u.kommoSalesbotId && !!u.kommoReplyFieldId && !u.kommoBypassSalesbot;
}

/**
 * O robô PODE falar pelo Kommo nesta unidade — LIGADO, com número e com rota de envio? É só a PRÉ-CONDIÇÃO para a Sofia se calar: quem a cala é
 * o lead que de fato RECEBEU o convite (`conviteEnviado`, em `convite-whatsapp-marca.ts`), nunca a unidade inteira.
 * Quem chama com um objeto sem estes campos (um `select` estreito) não cala a Sofia.
 */
export function conviteFalaNaUnidade(u: { slug: string } & NumerosDaUnidade & RotaDeEnvioDaUnidade, raw?: string): boolean {
  if (conviteWhatsappEstado(u.slug, raw) !== 'ligado') return false;
  if (!(numeroDoWhatsapp(u.igWhatsappNumber) ?? numeroDoWhatsapp(u.fbWhatsappNumber))) return false;
  return temRotaDeEnvioNoKommo(u);
}

// ── memória curta das decisões (o robô não repete as leituras a cada mensagem do mesmo lead) ───────────────────────────────

const DECISAO_VALE_MS = 3600_000;
const decididos = new Map<string, number>();

/** Esta conversa já foi decidida na última hora (um «não» definitivo, ou o «mandaria» do seco)? Só leitura. */
export function decididoRecentemente(chave: string, agora: number = Date.now()): boolean {
  const antes = decididos.get(chave);
  return antes !== undefined && agora - antes < DECISAO_VALE_MS;
}

/** Guarda a decisão por 1 h. Memória do processo: perder no deploy só repete uma leitura. NÃO usar para falha passageira («não consegui conferir»). */
export function lembrarDecisao(chave: string, agora: number = Date.now()): void {
  if (decididos.size >= 5000) for (const [k, t] of decididos) if (agora - t >= DECISAO_VALE_MS) decididos.delete(k);
  if (decididos.size >= 5000) decididos.clear();
  decididos.set(chave, agora);
}

export function _esquecerDecisoesParaTeste(): void {
  decididos.clear();
}
