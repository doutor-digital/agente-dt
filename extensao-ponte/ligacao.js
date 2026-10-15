/**
 * Ponte — a fila de ligações com 1 clique (fase 3). Pura: sem chrome.* e sem DOM (o teste da extensão e o do
 * servidor carregam este arquivo).
 *
 * "Começar a ligar": um paciente por vez, na ordem da Fila de hoje. A Ponte abre a conversa (navegação, como o
 * "Abrir conversa") e a atendente dá o ÚNICO clique, no 📞 do próprio WhatsApp Web. A Ponte nunca clica, digita
 * nem envia nada no WhatsApp.
 *
 * O ritmo: sem espera entre uma ligação e a próxima por padrão (`intervaloS` = 0, pedido do João em 14/10), e no máximo
 * `tetoPorHora` aberturas numa janela corrida de 60 min. Os números vêm do servidor (`RITMO_DAS_LIGACOES`).
 *
 * O que fica guardado (chrome.storage, para a posição sobreviver a fechar o painel): o dia, a unidade, os ids dos
 * cartões já feitos ou pulados, o id do que está aberto, o id da TENTATIVA (o servidor grava cada tentativa uma vez
 * só) e as horas das aberturas. NUNCA nome nem telefone.
 *
 * "Sem telefone": só é pulado de vez (marcado como feito) quem o servidor AFIRMA não ter telefone
 * (`semTelefone: true`). Telefone que não pôde ser lido agora fica para depois, sem marcar nada.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteLigacao = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HORA_MS = 60 * 60 * 1000;

  /** Os botões de resultado, na ordem da tela. O id é o que vai para o servidor (`RESULTADOS_DA_LIGACAO`). */
  var RESULTADOS = [
    { id: 'atendeu', rotulo: 'Atendeu' },
    { id: 'nao-atendeu', rotulo: 'Não atendeu' },
    { id: 'caixa-postal', rotulo: 'Caixa postal' },
    { id: 'numero-errado', rotulo: 'Número errado' },
  ];

  /** O mesmo padrão do servidor; vale quando a fila veio sem `ritmo` (servidor antigo). */
  var RITMO_PADRAO = { intervaloS: 0, tetoPorHora: 40 };

  /** O ritmo que vale: o do servidor, com as mesmas travas (intervalo ≥ 0 s, teto entre 1 e 120 por hora). */
  function ritmoDe(r) {
    var i = Number(r && r.intervaloS);
    var t = Number(r && r.tetoPorHora);
    return {
      intervaloS: Number.isFinite(i) && i >= 0 ? i : RITMO_PADRAO.intervaloS,
      tetoPorHora: Number.isFinite(t) && t >= 1 ? Math.min(120, Math.floor(t)) : RITMO_PADRAO.tetoPorHora,
    };
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** 'AAAA-MM-DD' no relógio da atendente: a lista de feitos vale só para o dia. */
  function diaLocal(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** Quem ligar, na ordem da Fila de hoje (grupos na ordem do funil; cada grupo já vem ordenado), sem repetir. */
  function filaDeLigacao(fila) {
    var vistos = {};
    var out = [];
    ((fila && fila.grupos) || []).forEach(function (g) {
      (g.itens || []).forEach(function (it) {
        if (!it || !it.leadId || vistos[it.leadId]) return;
        vistos[it.leadId] = true;
        out.push(it);
      });
    });
    return out;
  }

  /** Só dígitos, de 10 a 15 (a mesma regra do link do WhatsApp em desenho.js). */
  function temTelefone(it) {
    return /^\d{10,15}$/.test(String((it && it.telefone) || ''));
  }

  function estadoNovo(dia, slug, anterior) {
    return { v: 1, dia: dia, slug: slug, feitos: [], atual: null, tentativa: null, aberturas: (anterior && anterior.aberturas) || [] };
  }

  var TENTATIVA_OK = /^[A-Za-z0-9_-]{8,64}$/;

  /** Um id novo para a tentativa de ligação (o servidor usa para gravar o resultado uma vez só). */
  function novaTentativa() {
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    var s = Date.now().toString(36);
    for (var i = 0; i < 3; i++) s += '-' + Math.random().toString(36).slice(2, 10);
    return s.slice(0, 64);
  }

  /** O servidor afirma que o paciente não tem telefone (e não só "não deu para ler agora")? */
  function semTelefoneConfirmado(it) {
    return !!it && it.semTelefone === true;
  }

  /**
   * O estado guardado, se ainda vale (mesmo dia e mesma unidade); senão um novo — que herda as aberturas da
   * última hora (o ritmo não zera à meia-noite nem ao trocar a unidade).
   */
  function estadoDoDia(guardado, dia, slug, agoraMs) {
    var g = guardado && guardado.v === 1 ? guardado : null;
    var aberturas = ((g && g.aberturas) || []).filter(function (t) { return typeof t === 'number' && agoraMs - t < HORA_MS && t <= agoraMs + 60000; });
    if (g && g.dia === dia && g.slug === slug) {
      var atual = Number.isFinite(g.atual) ? g.atual : null;
      return {
        v: 1, dia: dia, slug: slug, feitos: (g.feitos || []).filter(Number.isFinite), atual: atual,
        tentativa: atual !== null && TENTATIVA_OK.test(String(g.tentativa || '')) ? g.tentativa : null,
        aberturas: aberturas,
      };
    }
    return estadoNovo(dia, slug, { aberturas: aberturas });
  }

  /**
   * O próximo: o que está aberto (se ainda está na fila), senão o primeiro que não foi feito nem pulado. `deixar`
   * são ids a pular só agora, sem marcar (telefone que não deu para ler).
   */
  function proximo(itens, estado, deixar) {
    var feitos = {};
    (estado.feitos || []).forEach(function (id) { feitos[id] = true; });
    (deixar || []).forEach(function (id) { feitos[id] = true; });
    if (estado.atual != null && !feitos[estado.atual]) {
      for (var i = 0; i < itens.length; i++) if (itens[i].leadId === estado.atual) return itens[i];
    }
    for (var j = 0; j < itens.length; j++) if (!feitos[itens[j].leadId]) return itens[j];
    return null;
  }

  /** Quantos da fila já foram feitos ou pulados hoje. */
  function feitosNaFila(itens, estado) {
    var feitos = {};
    (estado.feitos || []).forEach(function (id) { feitos[id] = true; });
    return itens.filter(function (it) { return feitos[it.leadId]; }).length;
  }

  function marcarFeito(estado, leadId) {
    var feitos = (estado.feitos || []).filter(function (id) { return id !== leadId; });
    feitos.push(leadId);
    var segue = estado.atual === leadId ? null : estado.atual;
    return { v: 1, dia: estado.dia, slug: estado.slug, feitos: feitos, atual: segue, tentativa: segue === null ? null : estado.tentativa || null, aberturas: estado.aberturas || [] };
  }

  /** A conversa do paciente abriu: conta no ritmo e começa uma tentativa nova (com id). */
  function registrarAbertura(estado, leadId, agoraMs, tentativa) {
    var aberturas = (estado.aberturas || []).filter(function (t) { return agoraMs - t < HORA_MS; });
    aberturas.push(agoraMs);
    return { v: 1, dia: estado.dia, slug: estado.slug, feitos: estado.feitos || [], atual: leadId, tentativa: tentativa || novaTentativa(), aberturas: aberturas };
  }

  /**
   * Quando a próxima conversa pode ser aberta: `{ em: ms, motivo: null | 'intervalo' | 'teto' }`. `em <= agora` =
   * já pode. Intervalo: `intervaloS` depois da última abertura. Teto: com `tetoPorHora` aberturas nos últimos
   * 60 min, só quando a mais antiga delas sair da janela.
   */
  function quandoPodeAbrir(estado, agoraMs, ritmo) {
    var r = ritmoDe(ritmo);
    var na = (estado.aberturas || []).filter(function (t) { return agoraMs - t < HORA_MS; }).sort(function (a, b) { return a - b; });
    var em = agoraMs;
    var motivo = null;
    if (na.length) {
      var porIntervalo = na[na.length - 1] + r.intervaloS * 1000;
      if (porIntervalo > em) { em = porIntervalo; motivo = 'intervalo'; }
    }
    if (na.length >= r.tetoPorHora) {
      var porTeto = na[na.length - r.tetoPorHora] + HORA_MS;
      if (porTeto > em) { em = porTeto; motivo = 'teto'; }
    }
    return { em: em, motivo: motivo };
  }

  /**
   * 0.5.1: o cabeçalho do modo ligação. Sem espera (o padrão desde a 0.5.0), "Uma conversa a cada 0 s" parecia defeito:
   * diz que não há espera. O teto por hora continua explicado — é ele que protege o número de parecer spam.
   */
  function textoDoRitmo(ritmo) {
    var r = ritmoDe(ritmo);
    var porque = 'no máximo ' + r.tetoPorHora + ' por hora, para o número não parecer spam e ficar protegido.';
    return r.intervaloS > 0
      ? 'Uma conversa a cada ' + r.intervaloS + ' s · ' + porque
      : 'Sem espera entre uma ligação e outra · ' + porque;
  }

  /** "próximo em 25 s", "próximo em 3 min". */
  function textoDaEspera(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    if (s < 60) return 'próximo em ' + s + ' s';
    var min = Math.ceil(s / 60);
    return 'próximo em ' + min + ' min';
  }

  return Object.freeze({
    RESULTADOS: Object.freeze(RESULTADOS.map(Object.freeze)),
    RITMO_PADRAO: Object.freeze(RITMO_PADRAO),
    ritmoDe: ritmoDe,
    diaLocal: diaLocal,
    filaDeLigacao: filaDeLigacao,
    temTelefone: temTelefone,
    semTelefoneConfirmado: semTelefoneConfirmado,
    novaTentativa: novaTentativa,
    estadoDoDia: estadoDoDia,
    proximo: proximo,
    feitosNaFila: feitosNaFila,
    marcarFeito: marcarFeito,
    registrarAbertura: registrarAbertura,
    quandoPodeAbrir: quandoPodeAbrir,
    textoDaEspera: textoDaEspera,
    textoDoRitmo: textoDoRitmo,
  });
});
