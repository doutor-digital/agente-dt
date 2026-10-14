/**
 * Ponte — o NÚMERO NO ÍCONE (0.4.0): quantos pacientes da unidade esperam resposta. Pura nas regras (o teste da
 * extensão e o do servidor carregam este arquivo) e com o que o script de fundo chama (`ligar`, `comecar`).
 *
 * A conta é a do grupo "sem resposta" da Fila de hoje (conversa não lida há mais de 2 h e a última fala não foi da
 * Sofia), feita pelo servidor em `GET …/ponte/contador` (cache de 90 s por conta). O script de fundo pergunta a cada
 * 5 min (`alarms`) — nada de notificação do sistema nesta versão.
 *
 *   - subiu desde a última leitura: cor de ALERTA (vermelho);
 *   - tem gente, mas não subiu: laranja;
 *   - zerou (leitura completa): ícone sem número;
 *   - falha (servidor, Kommo, internet) ou leitura incompleta com 0: "?" — NUNCA um 0 falso, que diria à atendente
 *     que ninguém está esperando.
 *
 * Guarda em `storage.local` só o último total e a unidade (para saber se subiu) — nunca nome nem telefone.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteContador = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NOME_DO_ALARME = 'ponte-contador';
  var MINUTOS = 5;
  var CHAVE_ANTERIOR = 'contadorAnterior';
  var COR_ALERTA = '#d93025';
  var COR_ATENCAO = '#e37400';
  var COR_SEM_SABER = '#80868b';
  var DICA_SEM_SABER = 'Não consegui contar os pacientes esperando resposta agora.';

  function textoDoTotal(n) {
    return n === 1 ? '1 paciente esperando resposta' : n + ' pacientes esperando resposta';
  }

  /**
   * O que mostrar no ícone para a resposta do servidor (`{ total, completo }`; `null` = não deu para perguntar).
   * `anterior` = o total da última leitura boa (ou null). Devolve `{ texto, cor, dica, total }`.
   */
  function badge(resposta, anterior) {
    var t = resposta && resposta.total;
    var total = typeof t === 'number' && isFinite(t) && t >= 0 ? Math.floor(t) : null;
    var completo = !!(resposta && resposta.completo === true);
    if (total === null || (total === 0 && !completo)) return { texto: '?', cor: COR_SEM_SABER, dica: DICA_SEM_SABER, total: null };
    if (total === 0) return { texto: '', cor: COR_ATENCAO, dica: 'Ninguém esperando resposta.', total: 0 };
    var subiu = typeof anterior !== 'number' || total > anterior;
    return {
      texto: total > 99 ? '99+' : String(total) + (completo ? '' : '+'),
      cor: subiu ? COR_ALERTA : COR_ATENCAO,
      dica: textoDoTotal(total) + (completo ? '' : ' (pode haver mais: o Kommo não respondeu tudo)'),
      total: total,
    };
  }

  function semErro(p) {
    return Promise.resolve(p).catch(function () {});
  }

  /** Põe no ícone: o número, a cor e a dica de passar o mouse. */
  function aplicar(api, b) {
    var a = api.action;
    var ps = [semErro(a.setBadgeText({ text: b.texto })), semErro(a.setTitle({ title: b.dica }))];
    if (b.texto) {
      ps.push(semErro(a.setBadgeBackgroundColor({ color: b.cor })));
      if (typeof a.setBadgeTextColor === 'function') ps.push(semErro(a.setBadgeTextColor({ color: '#ffffff' })));
    }
    return Promise.all(ps).then(function () { return b; });
  }

  /**
   * Pergunta ao servidor e atualiza o ícone. `deps` = { base, fetch }. Sem unidade configurada, o ícone fica sem
   * número (e não pergunta nada). Nunca lança.
   */
  function atualizar(api, deps) {
    var storage = api.storage.local;
    return Promise.resolve(storage.get(['slug', 'chave', CHAVE_ANTERIOR])).then(function (c) {
      if (!c || !c.slug || !c.chave) return aplicar(api, { texto: '', cor: COR_ATENCAO, dica: 'Abrir a Ponte', total: null });
      var slug = String(c.slug);
      var url = deps.base + '/api/public/widget/' + encodeURIComponent(slug) + '/ponte/contador';
      var guardado = c[CHAVE_ANTERIOR];
      var anterior = guardado && guardado.slug === slug && typeof guardado.total === 'number' ? guardado.total : null;
      return Promise.resolve()
        .then(function () { return deps.fetch(url, { headers: { 'X-Widget-Key': String(c.chave) }, cache: 'no-store' }); })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (j) {
          var b = badge(j, anterior);
          if (b.total !== null) {
            var o = {};
            o[CHAVE_ANTERIOR] = { slug: slug, total: b.total }; // só o número e a unidade
            semErro(storage.set(o));
          }
          return aplicar(api, b);
        });
    }).catch(function () {
      return aplicar(api, { texto: '?', cor: COR_SEM_SABER, dica: DICA_SEM_SABER, total: null });
    });
  }

  /** O alarme de 5 em 5 min (sobrevive ao script de fundo dormir; some quando o navegador fecha). */
  function garantirAlarme(api) {
    return Promise.resolve(api.alarms.get(NOME_DO_ALARME))
      .then(function (a) {
        if (!a) return api.alarms.create(NOME_DO_ALARME, { periodInMinutes: MINUTOS, delayInMinutes: MINUTOS });
      })
      .catch(function () {});
  }

  /**
   * Os ouvintes — no Chrome têm de ser registrados logo que o script de fundo carrega (ele dorme e acorda). O alarme
   * atualiza; trocar a unidade ou a chave nas opções atualiza na hora.
   */
  function ligar(api, deps) {
    api.alarms.onAlarm.addListener(function (a) {
      if (a && a.name === NOME_DO_ALARME) atualizar(api, deps);
    });
    api.storage.onChanged.addListener(function (mudou, area) {
      if (area === 'local' && mudou && (mudou.slug || mudou.chave)) atualizar(api, deps);
    });
    garantirAlarme(api);
  }

  /** Ao instalar e ao abrir o navegador: o alarme e uma leitura já. */
  function comecar(api, deps) {
    return garantirAlarme(api).then(function () { return atualizar(api, deps); });
  }

  return Object.freeze({
    NOME_DO_ALARME: NOME_DO_ALARME,
    MINUTOS: MINUTOS,
    CHAVE_ANTERIOR: CHAVE_ANTERIOR,
    COR_ALERTA: COR_ALERTA,
    COR_ATENCAO: COR_ATENCAO,
    COR_SEM_SABER: COR_SEM_SABER,
    badge: badge,
    textoDoTotal: textoDoTotal,
    atualizar: atualizar,
    ligar: ligar,
    comecar: comecar,
  });
});
