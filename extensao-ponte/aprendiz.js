/**
 * Ponte — "Modo aprendiz": onde cada coisa do painel fica dentro do Kommo.
 *
 * FASE 1: lista estática, sempre igual. A estrutura já é a da fase 3 (ensinar no dia a dia): cada dica tem
 * um `id` estável, e a fase 3 vai decidir QUAL dica mostrar e QUANDO (`quando`), e ligar cada uma à aula
 * curta da trilha. Mudar texto aqui não mexe em mais nada.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteAprendiz = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DICAS = [
    { id: 'etapa', quando: 'sempre', titulo: 'Etapa do paciente', onde: 'No Kommo, a etapa fica em: Cartão › topo › funil' },
    { id: 'responsavel', quando: 'sempre', titulo: 'Responsável', onde: 'Cartão › topo, embaixo do nome do cartão' },
    { id: 'etiquetas', quando: 'sempre', titulo: 'Etiquetas', onde: 'Cartão › embaixo do nome, o "#"' },
    { id: 'pausa', quando: 'sempre', titulo: 'Pausar a Sofia', onde: 'Cartão › campo "Pausar IA" (ou o widget "Pausar a Sofia")' },
    { id: 'franquia', quando: 'sempre', titulo: 'Agenda da franquia', onde: 'Cartão › coluna da direita › widget "Agenda da franquia"' },
  ];
  return Object.freeze({ DICAS: Object.freeze(DICAS.map(Object.freeze)) });
});
