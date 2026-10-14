/**
 * Ponte — o guia "O que eu faço agora?" (0.4.0). Pura: sem chrome.* e sem DOM, para o teste da extensão e o do
 * servidor (`backend/src/lib/ponte-guia.test.ts`) carregarem este mesmo arquivo.
 *
 * Quem decide o que falta, o que é da SDR e para onde o cartão pode ir é o SERVIDOR (`GET …/ponte/guia`). Aqui fica
 * só o que o painel faz antes de mandar: ler o que a atendente digitou, montar a PRÉVIA do que vai ser gravado, e
 * dizer se dá para mover. O servidor confere tudo de novo — esta é só a primeira trava, para a atendente não
 * esperar a volta do servidor para descobrir que esqueceu um campo.
 */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.PonteGuia = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** O mesmo texto do servidor (`AVISO_DOS_ROBOS`): o servidor não lê os gatilhos, então o painel avisa sempre. */
  var AVISO_DOS_ROBOS = 'Ao mover, os robôs desta etapa podem mandar mensagem ao paciente.';

  /** Número do jeito que a atendente digita: "250", "1.250,50", "R$ 90" (a mesma regra do servidor). */
  function numeroDigitado(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    var limpo = v.replace(/R\$/gi, '').replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(limpo)) return null;
    var n = Number(limpo);
    return isFinite(n) ? n : null;
  }

  function dinheiro(n) {
    try {
      return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00a0/g, ' ');
    } catch (e) {
      return 'R$ ' + String(n).replace('.', ',');
    }
  }

  /** "2026-10-20" → "20/10/2026" (sem passar por fuso: a data é a do calendário que a atendente escolheu). */
  function dataBR(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  function dataValida(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m || Number(m[1]) < 2000 || Number(m[1]) > 2100) return false;
    var d = new Date(iso + 'T12:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
  }

  /**
   * O que a atendente digitou para um campo do guia. Vazio = `{ vazio: true }` (não vai no pedido). Senão, o valor que
   * vai para o servidor e o texto da prévia, ou o erro em linguagem simples.
   */
  function lerEntrada(campo, bruto) {
    var nome = campo.nome;
    var s = typeof bruto === 'string' ? bruto.trim() : bruto == null ? '' : String(bruto);
    if (s === '') return { vazio: true };
    switch (campo.tipo) {
      case 'texto':
      case 'texto-longo':
        return { ok: true, valor: s, texto: s };
      case 'numero':
      case 'dinheiro': {
        var n = numeroDigitado(s);
        if (n === null || n < 0) return { ok: false, erro: nome + ': digite só o número.' };
        return { ok: true, valor: n, texto: campo.tipo === 'dinheiro' ? dinheiro(n) : String(n).replace('.', ',') };
      }
      case 'data':
        if (!dataValida(s)) return { ok: false, erro: nome + ': escolha a data no calendário.' };
        return { ok: true, valor: s, texto: dataBR(s) };
      case 'lista': {
        var id = Number(s);
        var opcao = (campo.opcoes || []).filter(function (o) { return o.id === id; })[0];
        if (!opcao) return { ok: false, erro: nome + ': escolha uma das opções.' };
        return { ok: true, valor: opcao.id, texto: opcao.valor };
      }
      default:
        return { ok: false, erro: nome + ': preencha este campo no Kommo.' };
    }
  }

  /**
   * O que vai ser gravado: os campos editáveis com algo digitado. `valores` = { [idDoCampo]: texto digitado }.
   * Devolve `{ campos: [{ id, valor }], previa: [{ nome, texto }], erros: [texto] }`.
   */
  function alteracoes(campos, valores) {
    var out = { campos: [], previa: [], erros: [] };
    (campos || []).forEach(function (c) {
      if (!c || !c.editavel) return;
      var r = lerEntrada(c, valores ? valores[c.id] : null);
      if (r.vazio) return;
      if (!r.ok) return out.erros.push(r.erro);
      if (out.campos.some(function (x) { return x.id === c.id; })) return;
      out.campos.push({ id: c.id, valor: r.valor });
      out.previa.push({ nome: c.nome, texto: r.texto });
    });
    return out;
  }

  /**
   * Dá para mover para esta saída com o que foi digitado? Não, se falta algo que a Ponte não preenche (`bloqueio`),
   * ou se algum campo que falta continua vazio. Devolve `{ pode, falta: [nomes], erros }`.
   */
  function podeMover(saida, valores) {
    if (!saida) return { pode: false, falta: [], erros: [] };
    if (saida.bloqueio) return { pode: false, falta: [], erros: [], bloqueio: saida.bloqueio };
    var a = alteracoes((saida.faltam || []).concat(saida.sugere || []), valores);
    var falta = (saida.faltam || []).filter(function (c) {
      return !a.campos.some(function (x) { return x.id === c.id; });
    }).map(function (c) { return c.nome; });
    return { pode: !falta.length && !a.erros.length, falta: falta, erros: a.erros, alteracoes: a };
  }

  /** "Vai gravar no Kommo:" + uma linha por campo — a prévia que a atendente confere antes de confirmar. */
  function linhasDaPrevia(previa) {
    return (previa || []).map(function (p) { return p.nome + ': ' + p.texto; });
  }

  return Object.freeze({
    AVISO_DOS_ROBOS: AVISO_DOS_ROBOS,
    numeroDigitado: numeroDigitado,
    dataBR: dataBR,
    lerEntrada: lerEntrada,
    alteracoes: alteracoes,
    podeMover: podeMover,
    linhasDaPrevia: linhasDaPrevia,
  });
});
