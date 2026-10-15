/**
 * Ponte — "Modo aprendiz": onde cada coisa do painel fica dentro do Kommo.
 *
 * FASE 1: lista estática, sempre igual. A estrutura já é a da fase 3 (ensinar no dia a dia): cada dica tem
 * um `id` estável, e a fase 3 vai decidir QUAL dica mostrar e QUANDO (`quando`), e ligar cada uma à aula
 * curta da trilha. Mudar texto aqui não mexe em mais nada.
 *
 * 0.5.1: a dica da pausa da Sofia é `quando: 'com-ia'` — só aparece quando o servidor disse que a unidade tem a Sofia
 * (`sofiaNaUnidade: true`). Na unidade sem IA (Petrópolis, Caxias), o painel não fala da Sofia.
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
    { id: 'pausa', quando: 'com-ia', titulo: 'Pausar a Sofia', onde: 'Cartão › campo "Pausar IA" (ou o widget "Pausar a Sofia")' },
    { id: 'franquia', quando: 'sempre', titulo: 'Agenda da franquia', onde: 'Cartão › coluna da direita › widget "Agenda da franquia"' },
    // 0.5.1: paciente NOVO se cadastra e marca pelo widget, nunca direto na franquia
    { id: 'marcar', quando: 'sempre', titulo: 'Marcar consulta', onde: 'Cartão › widget "Assistente do cartão" › "Cadastrar e marcar na franquia" (paciente novo; já cadastrado: "Marcar consulta na franquia")' },
    { id: 'respostas', quando: 'sempre', titulo: 'Respostas prontas', onde: 'Configurações › Modelos › Modelos gerais (no chat: o raio ⚡ ou "/")' },
  ];
  var CONGELADAS = Object.freeze(DICAS.map(Object.freeze));

  /** As dicas que valem para a unidade: as de `com-ia` só quando ela TEM a Sofia (`comIa === true`; sem saber, não). */
  function dicasPara(comIa) {
    return CONGELADAS.filter(function (d) { return d.quando !== 'com-ia' || comIa === true; });
  }

  return Object.freeze({ DICAS: CONGELADAS, dicasPara: dicasPara });
});
