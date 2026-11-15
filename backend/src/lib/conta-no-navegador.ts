/**
 * O pedaço de JavaScript que as telas (iframes do Chatwoot) usam para mandar `?conta=<N>` ao servidor. UMA cópia só: as páginas trazem o marcador
 * `/*__CONTA_JS__*\/` e quem monta a página troca por `CONTA_NA_PAGINA_JS` (`comContaNaPagina`). A conta vem do endereço do iframe
 * (`?conta=N`, posto pelo menu do Chatwoot) e é só um PEDIDO: o servidor confere se a pessoa é membro dela (`conta-da-requisicao.ts`).
 * Sem texto com crase nem `${` (as páginas são String.raw).
 */
export const MARCADOR_DA_CONTA = '/*__CONTA_JS__*/';

export const CONTA_NA_PAGINA_JS =
  "var CONTA_Q = (function(){ var c = new URLSearchParams(location.search).get('conta'); return /^[1-9][0-9]{0,9}$/.test(c || '') ? c : ''; })();\n" +
  "  function comConta(caminho){ return CONTA_Q ? caminho + (caminho.indexOf('?') < 0 ? '?' : '&') + 'conta=' + CONTA_Q : caminho; }";

/** Troca o marcador pela cópia única. */
export const comContaNaPagina = (html: string): string => html.split(MARCADOR_DA_CONTA).join(CONTA_NA_PAGINA_JS);
