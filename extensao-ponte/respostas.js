/**
 * Ponte — respostas prontas para COPIAR (fase 3). Pura: sem chrome.* e sem DOM (o teste do servidor,
 * `backend/src/lib/ponte-respostas.test.ts`, carrega este arquivo).
 *
 * As respostas são os modelos gerais do Kommo (texto livre, não os do WhatsApp). A Ponte só COPIA: nunca põe
 * texto na caixa do WhatsApp e nunca envia. A atendente cola na conversa e envia ela mesma.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteRespostas = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Os marcadores de nome: `{{contact.name}}` (o que o Kommo grava), `{{contact.first_name}}`, "[Nome do contato]"
   * (o que a tela do Kommo mostra) e os simples `{{nome}}`, `{nome}` e `[nome]`.
   */
  var MARCADOR_DE_NOME = /\{\{\s*contact\.(?:first_)?name\s*\}\}|\{\{\s*nome\s*\}\}|\{\s*nome\s*\}|\[\s*nome(?:\s+do\s+contato)?\s*\]/gi;

  /** Troca o marcador de nome pelo primeiro nome do paciente; sem nome conhecido, deixa "[nome]" para completar. */
  function preencherNome(texto, primeiroNome) {
    var nome = String(primeiroNome == null ? '' : primeiroNome).trim();
    return String(texto == null ? '' : texto).replace(MARCADOR_DE_NOME, nome || '[nome]');
  }

  /** Sobrou algo entre colchetes para a atendente completar antes de enviar? */
  function temLacuna(texto) {
    return /\[[^\]\n]{1,80}\]/.test(String(texto == null ? '' : texto));
  }

  function paraBusca(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** As respostas cujo nome ou texto têm todas as palavras da busca. */
  function filtrar(lista, busca) {
    var palavras = paraBusca(busca).split(' ').filter(Boolean);
    if (!palavras.length) return (lista || []).slice();
    return (lista || []).filter(function (r) {
      var k = paraBusca((r && r.nome) + ' ' + (r && r.texto));
      return palavras.every(function (p) { return k.indexOf(p) >= 0; });
    });
  }

  // ── 0.5.0: as sugeridas para a etapa e os modelos de cada unidade ──

  /** O nome do modelo como chave: "⚡ Consulta dados pix" → "consulta_dados_pix". */
  function chaveDoModelo(nome) {
    return paraBusca(nome).replace(/ /g, '_');
  }

  /**
   * Os prefixos de nome que combinam com cada etapa (a chave da etapa é a de `trilha.js`). Casa pelo COMEÇO do nome
   * do modelo, depois de tirar o prefixo da unidade ("petropolis_consulta_endereco" → "consulta_endereco").
   */
  var PREFIXOS_DA_ETAPA = {
    entrada: ['lead', 'primeiro_contato', 'boas_vindas', 'qualificacao'],
    qualificacao: ['lead', 'primeiro_contato', 'boas_vindas', 'qualificacao'],
    espera: ['espera', 'retomada', 'retomar'],
    conferir: ['conferir'],
    agendado: ['consulta', 'agendado', 'confirmacao', 'confirmar', 'endereco'],
    'nao-compareceu': ['falta', 'faltou', 'nao_compareceu', 'remarcar'],
    compareceu: ['negociacao', 'plano', 'proposta', 'tratamento'],
    negociacao: ['negociacao', 'plano', 'proposta', 'tratamento'],
    ganho: ['tratamento', 'sessao'],
    'em-tratamento': ['sessao', 'tratamento'],
    alta: ['alta', 'retorno', 'pos_tratamento'],
    retorno: ['retorno', 'pos_tratamento'],
    perdido: ['perdido', 'reativacao', 'reativar'],
  };

  /** As unidades que têm modelos com prefixo próprio. A conta pode mandar as dela (`unidades`). */
  var UNIDADES_COM_PREFIXO = ['petropolis', 'caxias'];

  function prefixosDeUnidade(unidades) {
    var l = (unidades && unidades.length ? unidades : UNIDADES_COM_PREFIXO).map(function (u) { return chaveDoModelo(u); }).filter(Boolean);
    return l.sort(function (a, b) { return b.length - a.length; });
  }

  /** De qual unidade é o modelo ("caxias_endereco" → "caxias"), ou null (vale para todas). */
  function unidadeDoModelo(nome, unidades) {
    var k = chaveDoModelo(nome);
    var achou = prefixosDeUnidade(unidades).filter(function (u) { return k === u || k.indexOf(u + '_') === 0; })[0];
    return achou || null;
  }

  /**
   * As respostas que podem ir para ESTE cartão: os modelos de outra unidade saem quando a unidade do cartão é
   * conhecida (o endereço de Caxias não pode ir para um paciente de Petrópolis). Sem unidade, ficam todos.
   * Devolve `{ lista, escondidas }`.
   */
  function daUnidade(lista, unidade, unidades) {
    var minha = unidade ? chaveDoModelo(unidade) : null;
    var escondidas = 0;
    var ok = (lista || []).filter(function (r) {
      var u = unidadeDoModelo(r && r.nome, unidades);
      if (!u || !minha || u === minha) return true;
      escondidas++;
      return false;
    });
    return { lista: ok, escondidas: escondidas };
  }

  /**
   * As sugeridas para a etapa, na ordem da conta: o nome (sem o prefixo da unidade) começa com um prefixo da etapa.
   * Modelo de unidade só entra quando é da unidade do cartão; sem unidade conhecida, só os que valem para todas.
   */
  function sugeridas(lista, chaveDaEtapa, unidade, unidades) {
    var prefixos = PREFIXOS_DA_ETAPA[chaveDaEtapa];
    if (!prefixos) return [];
    var minha = unidade ? chaveDoModelo(unidade) : null;
    return (lista || []).filter(function (r) {
      var k = chaveDoModelo(r && r.nome);
      var u = unidadeDoModelo(r && r.nome, unidades);
      if (u && u !== minha) return false;
      if (u) k = k.slice(u.length).replace(/^_/, '');
      return prefixos.some(function (p) { return k === p || k.indexOf(p + '_') === 0; });
    });
  }

  return Object.freeze({
    preencherNome: preencherNome,
    temLacuna: temLacuna,
    filtrar: filtrar,
    chaveDoModelo: chaveDoModelo,
    unidadeDoModelo: unidadeDoModelo,
    daUnidade: daUnidade,
    sugeridas: sugeridas,
    PREFIXOS_DA_ETAPA: PREFIXOS_DA_ETAPA,
  });
});
