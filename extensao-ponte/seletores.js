/**
 * Ponte — TODOS os seletores do DOM do WhatsApp Web ficam AQUI, e só aqui.
 *
 * O WhatsApp Web muda o HTML sem aviso: classe ofuscada (`_ak8l`, `x1n2onr6`…) troca a cada versão. Por isso
 * esta lista usa, sempre que dá, atributos que o próprio WhatsApp precisa manter estáveis — `id="main"`,
 * `data-id` (o id da mensagem), `data-pre-plain-text` (o que vai para a área de transferência quando se copia
 * uma mensagem), `role`, `dir`, `title`. Quando um seletor quebrar, o conserto é neste arquivo.
 *
 * TUDO AQUI É SUPOSIÇÃO a validar no teste de 1 dia no computador de uma atendente (ver README). As fixtures
 * em `testes/fixtures/` imitam o que se sabe do DOM em out/2026; não são cópia do WhatsApp real.
 *
 * Só LEITURA: nenhum destes seletores é usado para clicar, digitar, focar ou marcar como lida.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteSeletores = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return Object.freeze({
    /** O painel da direita, com a conversa aberta. Sem ele, nenhuma conversa está aberta. */
    PAINEL_CONVERSA: '#main',

    /** O cabeçalho da conversa aberta (foto, nome, "visto por último"). */
    CABECALHO: '#main header',

    /**
     * O nome no cabeçalho, do mais específico para o mais genérico — o primeiro que tiver texto vale.
     * `data-testid` sumiu de quase tudo em 2023, mas custa nada tentar primeiro.
     */
    NOME_CABECALHO: Object.freeze([
      '[data-testid="conversation-info-header-chat-title"]',
      'span[dir="auto"][title]',
      'div[role="button"] span[dir="auto"]',
      'span[dir="auto"]',
    ]),

    /**
     * Cada mensagem tem um elemento com `data-id` no formato
     *   `<deMim>_<jidDaConversa>_<idDaMensagem>[_<jidDoParticipante>]`
     * ex.: `false_5599900000043@c.us_3EB0A1B2C3D4` (recebida, conversa com um número)
     *      `true_123456789012345@lid_3EB0FF00`      (enviada, conversa com id opaco — NÃO é telefone)
     *      `false_120363000000000000@g.us_3EB0AA_5511999990000@c.us` (grupo: o participante NÃO é a conversa)
     */
    MENSAGEM: '[data-id]',
    DATA_ID: /^(true|false)_([^_]+)_([^_]+)(?:_(.+))?$/,

    /** O bloco copiável da mensagem: `data-pre-plain-text="[10:32, 13/10/2026] Maria Souza: "`. */
    BLOCO_TEXTO: '[data-pre-plain-text]',
    ATRIBUTO_PRE_TEXTO: 'data-pre-plain-text',

    /** A hora no começo do pre-texto: "[10:32, " (pt-BR) ou "[10:32 AM, " (en-US). */
    HORA_PRE_TEXTO: /^\[\s*(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?\s*,/,

    /** Onde está o texto dentro do bloco copiável, do mais específico para o mais genérico. */
    TEXTO_DA_MENSAGEM: Object.freeze(['span.selectable-text', '.selectable-text', 'span[dir]']),

    /**
     * Contato que não está salvo no celular da clínica aparece com o NÚMERO no cabeçalho
     * ("+55 99 90000-0043"). Esse número está na tela — não é o id `@lid` —, então vale como telefone.
     */
    TELEFONE_NO_CABECALHO: /^\+\d[\d\s().-]{8,}$/,
  });
});
