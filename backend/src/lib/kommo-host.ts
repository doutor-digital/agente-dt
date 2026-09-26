/**
 * O host é do ecossistema Kommo/amoCRM?
 *
 * Auditoria 26/09/2026: dois caminhos anônimos vazavam o token do Kommo da clínica
 * porque o servidor mandava o `Authorization: Bearer <token>` para uma URL escolhida
 * por quem chamou:
 *   1) `return_url` do webhook público do widget (widget.controller → continueSalesbotWidget);
 *   2) `attachment.link` do webhook público do Kommo, no reenvio com token quando o
 *      download dá 401/403 (transcription/vision.service).
 *
 * A defesa é a mesma nos dois: só falar (e só mandar o token) com host do próprio
 * Kommo/amoCRM. URL legítima do Kommo é sempre `https://<sub>.kommo.com/...` ou o
 * equivalente em `amocrm.com`/`amocrm.ru`. Qualquer outro host é rejeitado.
 *
 * Exige https. Se `subdomain` vier, casa o host EXATO da unidade primeiro; sempre
 * aceita, como rede, qualquer host sob os domínios da marca (arquivos e API ficam em
 * subdomínios variados). `URL` sem parse válido → false (falha fechado).
 */
const SUFIXOS_KOMMO = ['.kommo.com', '.amocrm.com', '.amocrm.ru'] as const;

export function ehHostDoKommo(urlStr: string, subdomain?: string | null): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();

  if (subdomain) {
    const alvo = `${subdomain.toLowerCase()}.kommo.com`;
    if (host === alvo) return true;
  }
  return SUFIXOS_KOMMO.some((sufixo) => host === sufixo.slice(1) || host.endsWith(sufixo));
}
