/**
 * Ponte — os ícones do painel (0.5.0). SVG desenhado aqui mesmo: sem CDN, sem fonte de ícones, sem innerHTML.
 * Cada ícone é uma lista de traços (`d` de <path>) num quadro de 24×24, com traço de 2 px e pontas redondas — a cor
 * vem do texto em volta (`currentColor`). Sem chrome.* e sem DOM global: o teste roda isto no jsdom.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteIcones = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';

  var TRACOS = {
    telefone: ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z'],
    mensagem: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    lupa: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
    escolhido: ['M22 11.1V12a10 10 0 1 1-5.9-9.1', 'M22 4 12 14l-3-3'],
    casa: ['M3 10.5 12 3l9 7.5', 'M5 9v12h14V9', 'M10 21v-6h4v6'],
    chama: ['M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.3 2.8 2.5 2.8z'],
    morno: ['M14 14.8V4.5a2.5 2.5 0 0 0-5 0v10.3a4 4 0 1 0 5 0z', 'M11.5 17.5v-6'],
    frio: ['M12 2v20', 'M3.3 7l17.4 10', 'M20.7 7 3.3 17', 'M9 4l3 2 3-2', 'M9 20l3-2 3 2'],
    relogio: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
    franquia: ['M3 21h18', 'M5 21V8l7-5 7 5v13', 'M12 9v6', 'M9 12h6'],
    pessoa: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
    cadeado: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    calendario: ['M8 2v4', 'M16 2v4', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M3 10h18'],
    check: ['M20 6 9 17l-5-5'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    alerta: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
    seta: ['M5 12h14', 'M12 5l7 7-7 7'],
    copiar: ['M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
    externo: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    etiqueta: ['M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z', 'M7.5 7.5h.01'],
    pausa: ['M10 4H6v16h4z', 'M18 4h-4v16h4z'],
    robo: ['M12 8V4H8', 'M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M2 14h2', 'M20 14h2', 'M15 13v2', 'M9 13v2'],
    estrela: ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z'],
    atualizar: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
    brilho: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 16v4', 'M17 18h4'],
    abaixo: ['M6 9l6 6 6-6'],
    anuncio: ['M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z', 'M16 9a3 3 0 0 1 0 6', 'M19 6a7 7 0 0 1 0 12'],
    sessao: ['M22 12h-4l-3 9L9 3l-3 9H2'],
    alta: ['M4 22V4', 'M4 4h13l-2 4 2 4H4'],
    lista: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    duplicado: ['M16 3h3a2 2 0 0 1 2 2v3', 'M8 21H5a2 2 0 0 1-2-2v-3', 'M7 7h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z'],
    guia: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z'],
  };

  /** Um <svg> do ícone `nome`, decorativo (aria-hidden): quem lê é o texto ao lado. Nome que não existe → null. */
  function icone(doc, nome, classe) {
    var tracos = TRACOS[nome];
    if (!tracos) return null;
    var s = doc.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    s.setAttribute('class', 'icone' + (classe ? ' ' + classe : ''));
    s.setAttribute('data-icone', nome);
    tracos.forEach(function (d) {
      var p = doc.createElementNS(SVG, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  return Object.freeze({ icone: icone, NOMES: Object.freeze(Object.keys(TRACOS)) });
});
