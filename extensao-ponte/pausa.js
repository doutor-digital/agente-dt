/**
 * Ponte — as opções de "Pausar a Sofia neste paciente" (fase 2). Pura: sem chrome.* e sem DOM, para o teste da
 * extensão e o do servidor (`backend/src/lib/ponte-pausa.test.ts`) carregarem este mesmo arquivo.
 *
 * A data é calculada no relógio da atendente; quem decide se vale é o servidor (`validarPausaDoLead`: no futuro
 * e no máximo 30 dias). A conta aqui é a mesma, só para avisar antes de mandar.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PontePausa = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** O mesmo limite do servidor (`PAUSA_LEAD_MAX_DIAS`). */
  var MAX_DIAS = 30;
  var DIA_MS = 24 * 60 * 60 * 1000;
  /** Hora em que a Sofia volta quando a opção é um DIA (amanhã, ou a data escolhida). */
  var HORA_DE_VOLTA = 8;

  var OPCOES = [
    { id: 'amanha8', rotulo: 'Até amanhã às 8h' },
    { id: '3dias', rotulo: '3 dias' },
    { id: '1semana', rotulo: '1 semana' },
    { id: 'data', rotulo: 'Escolher a data' },
  ];

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 'AAAA-MM-DD' no relógio local (o da atendente). */
  function dataLocal(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function volta(ano, mes, dia) {
    return new Date(ano, mes, dia, HORA_DE_VOLTA, 0, 0, 0);
  }

  /** A última data que "escolher a data" aceita: a volta às 8h desse dia ainda cabe nos 30 dias. */
  function dataMaxima(agora) {
    var d = new Date(agora.getTime() + MAX_DIAS * DIA_MS);
    var v = volta(d.getFullYear(), d.getMonth(), d.getDate());
    if (v.getTime() - agora.getTime() > MAX_DIAS * DIA_MS) v = volta(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    return dataLocal(v);
  }

  /** A primeira data aceita: hoje, se ainda não deu 8h; senão, amanhã. */
  function dataMinima(agora) {
    var hoje = volta(agora.getFullYear(), agora.getMonth(), agora.getDate());
    return dataLocal(hoje.getTime() > agora.getTime() ? hoje : volta(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1));
  }

  /**
   * Até quando, para a opção escolhida: `{ ate: Date }` ou `{ erro: 'texto para a atendente' }`.
   *   - `amanha8`: amanhã às 8h;  - `3dias` / `1semana`: daqui a 72 h / 168 h;
   *   - `data`: o dia escolhido ('AAAA-MM-DD', do campo de data) às 8h.
   */
  function fimDaPausa(opcao, agora, dataEscolhida) {
    var ate;
    if (opcao === 'amanha8') ate = volta(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1);
    else if (opcao === '3dias') ate = new Date(agora.getTime() + 3 * DIA_MS);
    else if (opcao === '1semana') ate = new Date(agora.getTime() + 7 * DIA_MS);
    else if (opcao === 'data') {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dataEscolhida || '').trim());
      if (!m) return { erro: 'Escolha o dia em que a Sofia volta.' };
      ate = volta(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (dataLocal(ate) !== m[0]) return { erro: 'Essa data não existe.' };
    } else {
      return { erro: 'Escolha até quando.' };
    }
    if (ate.getTime() <= agora.getTime()) return { erro: 'A Sofia precisa voltar numa data futura.' };
    if (ate.getTime() - agora.getTime() > MAX_DIAS * DIA_MS) return { erro: 'A pausa de um paciente vai até ' + MAX_DIAS + ' dias.' };
    return { ate: ate };
  }

  /**
   * O estado da Sofia no painel depois de pausar ou retomar, sem perguntar o cartão de novo. As travas mais
   * fortes (a unidade inteira, fora do horário, a caixinha marcada à mão pela SDR) continuam valendo; só a
   * pausa com data muda. Mesma ordem de `estadoDaSofia` no servidor.
   */
  function sofiaDepois(sofia, pausa) {
    var s = sofia || { pausada: false, por: null, ate: null };
    if (s.pausada && (s.por === 'unidade' || s.por === 'horario' || s.por === 'caixinha')) return s;
    if (pausa && pausa.ate) return { pausada: true, por: 'janela', ate: pausa.ate };
    return { pausada: false, por: null, ate: null };
  }

  return Object.freeze({
    MAX_DIAS: MAX_DIAS,
    OPCOES: Object.freeze(OPCOES.map(Object.freeze)),
    fimDaPausa: fimDaPausa,
    dataMaxima: dataMaxima,
    dataMinima: dataMinima,
    dataLocal: dataLocal,
    sofiaDepois: sofiaDepois,
  });
});
