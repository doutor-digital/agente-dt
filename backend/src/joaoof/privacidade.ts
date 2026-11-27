/**
 * LGPD do Joaoof: o que entra no banco e no prompt NUNCA leva telefone, CPF, e-mail nem número de cartão.
 * O grupo é de trabalho, mas cita paciente («Contato: 55 99 91711-305», «CPF 000.000.000-00»); o Joaoof precisa do ASSUNTO,
 * não da pessoa. Só um trecho curto fica guardado.
 */
import { createHmac } from 'node:crypto';

export const TRECHO_MAX = 280;

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** menção do WhatsApp: «@264205617909889» é o id interno de alguém, não um nome */
const MENCAO_RE = /@\d{6,}/g;
/** sequência de dígitos com separadores comuns de telefone/CPF/CNPJ/cartão; decide-se pela contagem de dígitos */
const NUMERO_RE = /\+?\d[\d\s().-]{5,}\d/g;
/** datas e horas escritas só com hífen («2026-11-27», «02-12», «02-12-26») não são telefone */
const DATA_RE = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2}(-\d{2,4})?)$/;

/** URL sem a query (ela carrega telefone: «?filter[term]=94+92136-180») e sem o fragmento. */
function semQuery(url: string): string {
  const corte = url.search(/[?#]/);
  return corte === -1 ? url : url.slice(0, corte);
}

/** Link do Kommo para um lead/contato: o id (8 dígitos) é o que o João precisa para abrir, e não é telefone. */
const LINK_KOMMO_RE = /^https?:\/\/[a-z0-9-]+\.kommo\.com\/(?:leads|contacts|chats\/leads)\/detail\/\d+\/?$/i;

function mascararNumeros(t: string): string {
  return t.replace(NUMERO_RE, (trecho) => {
    const t2 = trecho.trim();
    if (DATA_RE.test(t2)) return trecho;
    const digitos = t2.replace(/\D/g, '');
    // 8+ dígitos = telefone, CPF (11), CNPJ (14), cartão (13–19), protocolo longo. Menos que isso (valor, hora, ano) fica.
    return digitos.length >= 8 ? '[número]' : trecho;
  });
}

export function mascarar(texto: string): string {
  // Link: sem a query (ela leva o telefone). Só o link de lead do Kommo guarda os dígitos do caminho; qualquer outro (wa.me/5594…, api.whatsapp.com/…)
  // passa pela máscara de número como o resto do texto.
  const links: string[] = [];
  // NUL: o Postgres rejeita em coluna text (derrubaria a gravação da unidade inteira) e colidiria com o delimitador interno dos links
  let t = String(texto ?? '').replace(/\u0000/g, '').replace(URL_RE, (u) => {
    const limpo = semQuery(u);
    return `\u0000L${links.push(LINK_KOMMO_RE.test(limpo) ? limpo : mascararNumeros(limpo)) - 1}\u0000`;
  });
  t = t.replace(EMAIL_RE, '[e-mail]');
  t = t.replace(MENCAO_RE, '@pessoa');
  t = mascararNumeros(t);
  return t.replace(/\u0000L(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? '');
}

/** Mascara, junta espaços e corta em `max` (com reticências). */
export function trechoCurto(texto: string, max = TRECHO_MAX): string {
  const limpo = mascarar(texto).replace(/\s+/g, ' ').trim();
  const letras = Array.from(limpo);
  return letras.length <= max ? limpo : `${letras.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/**
 * Corta por CARACTERE (ponto de código), nunca por unidade UTF-16: `.slice` no meio de um emoji deixa um `\ud83c` solto, e a Anthropic recusa
 * texto com surrogate órfão (400). TODO corte de texto que vai ao modelo ou ao Telegram passa por aqui.
 */
export function cortar(texto: string, max: number): string {
  const s = String(texto ?? '');
  if (s.length <= max) return s; // (comprimento UTF-16 ≤ max ⇒ pontos de código ≤ max)
  return Array.from(s).slice(0, Math.max(0, max)).join('');
}

/**
 * Chave estável de uma pessoa a partir do número (HMAC). O número nunca é gravado; sem segredo configurado não há chave
 * (e quem chama NÃO grava a pessoa), para não cair num hash sem segredo, que se desfaz por força bruta (10^11 números).
 */
export function chaveDaPessoa(numero: string, segredo: string | undefined): string | null {
  const s = String(segredo ?? '').trim();
  const digitos = String(numero ?? '').replace(/\D/g, '');
  if (s.length < 16 || digitos.length < 6) return null;
  return createHmac('sha256', s).update(digitos).digest('hex').slice(0, 32);
}
