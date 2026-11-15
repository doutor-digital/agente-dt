/**
 * Os pedaços de JavaScript que as telas (iframes do Chatwoot) trazem em comum. UMA cópia só: as páginas têm o marcador `/*__CONTA_JS__*\/` e quem monta
 * a página chama `comContaNaPagina`.
 *
 *  1. `comConta(caminho)`: manda `?conta=<N>` ao servidor. A conta vem do endereço do iframe (`?conta=N`, posto pelo menu do Chatwoot) e é só um PEDIDO:
 *     o servidor confere se a pessoa é membro dela (`conta-da-requisicao.ts`).
 *  2. As ORIGENS do Chatwoot: a principal (atendimento.…) e os subdomínios das clínicas cadastradas (`unit_chatwoot.subdominio`). A sessão só é aceita
 *     de `window.parent` cuja origem está nessa lista (`origemDoCrm`), e a mensagem é endereçada à origem REAL do pai (`origemDoPai`: a do próprio
 *     iframe pai quando está na lista; senão a principal). Origem fora da lista é recusada.
 * Sem texto com crase nem `${` (as páginas são String.raw).
 */
import { origensDoChatwoot } from './origens-do-chatwoot.js';

export const MARCADOR_DA_CONTA = '/*__CONTA_JS__*/';

export const CONTA_NA_PAGINA_JS =
  "var CONTA_Q = (function(){ var c = new URLSearchParams(location.search).get('conta'); return /^[1-9][0-9]{0,9}$/.test(c || '') ? c : ''; })();\n" +
  "  function comConta(caminho){ return CONTA_Q ? caminho + (caminho.indexOf('?') < 0 ? '?' : '&') + 'conta=' + CONTA_Q : caminho; }\n" +
  '  function origemDoCrm(o){ return typeof o === \'string\' && __ORIGENS_CW__.indexOf(o) >= 0; }\n' +
  '  function origemDoPai(principal){\n' +
  '    var c = [];\n' +
  '    try { if (location.ancestorOrigins && location.ancestorOrigins.length) c.push(location.ancestorOrigins[0]); } catch (e) {}\n' +
  '    try { if (document.referrer) c.push(new URL(document.referrer).origin); } catch (e) {}\n' +
  '    for (var i = 0; i < c.length; i++) if (origemDoCrm(c[i])) return c[i];\n' +
  '    return principal;\n' +
  '  }';

/** Troca o marcador pela cópia única e `__ORIGENS_CW__` pela lista (JSON) de origens aceitas. */
export const comContaNaPagina = (html: string, origens: string[] = origensDoChatwoot()): string =>
  html.split(MARCADOR_DA_CONTA).join(CONTA_NA_PAGINA_JS).split('__ORIGENS_CW__').join(JSON.stringify(origens));
