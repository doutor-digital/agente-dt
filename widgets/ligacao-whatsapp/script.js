/* DD · Ligar pelo WhatsApp — widget privado Doutor Digital (08/10/2026).
 *
 * João: "faça um melhor widget de chamada mesmo, a gente pode ter dentro do Kommo". A SDR liga para o WhatsApp
 * do paciente pelo número OFICIAL da unidade, do navegador (WebRTC), sem sair do cartão. A Meta só deixa
 * ligar para quem deu permissão e tira a permissão de quem não atende — por isso o painel é um caminho de
 * 3 passos com travas:
 *
 *   ① PERMISSÃO  — botão "Pedir permissão" (o WhatsApp mostra ao paciente "Permitir ligações").
 *   ② COMBINAR   — "Posso te ligar agora?" escrito no chat; o Ligar só fica verde depois que ele responde.
 *   ③ LIGAR      — ligação pelo navegador: chamando, tocando, cronômetro, mudo, desligar.
 *
 * Travas (decididas pelo João): 2 ligações seguidas sem atender travam o paciente; se no dia menos da metade
 * das ligações da unidade é atendida, a fila "Ligar próximo" pausa até amanhã. Quem decide é o servidor
 * (agente-dt, `lib/ligacao-whatsapp.ts`) — o widget só mostra e pede. O telefone NUNCA sai daqui: o
 * servidor lê do contato do cartão.
 *
 * Settings: `slug` (código da unidade) e `chave` (a mesma chave dos outros widgets DD da unidade).
 */
define(['jquery'], function ($) {
  var VERSAO = '__VERSAO__';
  var CSS = __CSS__;
  var LOGO_B64 = __LOGO_B64__;
  var P = 'ddlig';
  var BASE = 'https://agente-vps.doutordigitalconsultoria.com';
  var STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

  // A ligação vive FORA do widget: o Kommo destrói e recria o widget a cada navegação, e a SDR pode abrir
  // outro cartão no meio da conversa. O áudio continua; qualquer cartão mostra a faixa "em ligação".
  var G = window.__ddlig || (window.__ddlig = { chamada: null, render: null });

  function app() { return window.APP || window.AMOCRM || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function dois(n) { return ('0' + n).slice(-2); }
  function data(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : dois(d.getDate()) + '/' + dois(d.getMonth() + 1); }
  function hora(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? '' : dois(d.getHours()) + ':' + dois(d.getMinutes()); }
  function quando(iso) {
    if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return '';
    var hoje = new Date(); var ontem = new Date(Date.now() - 864e5);
    if (d.toDateString() === hoje.toDateString()) return 'hoje ' + hora(iso);
    if (d.toDateString() === ontem.toDateString()) return 'ontem ' + hora(iso);
    return data(iso) + ' ' + hora(iso);
  }
  function relativo(iso) {
    if (!iso) return ''; var min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'agora'; if (min < 60) return 'há ' + min + ' min'; var h = Math.round(min / 60); return h < 24 ? 'há ' + h + ' h' : 'em ' + quando(iso);
  }
  function cron(seg) { seg = Math.max(0, Math.floor(seg)); var m = Math.floor(seg / 60); return dois(m) + ':' + dois(seg % 60); }
  function duracao(seg) { seg = Math.round(seg || 0); var m = Math.floor(seg / 60), s = seg % 60; return m ? m + 'min' + (s ? ' ' + dois(s) + 's' : '') : s + 's'; }
  function iniciais(nome) {
    var p = String(nome || '').replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, '').trim().split(/\s+/).filter(function (x) { return /^[A-Za-zÀ-ÿ]/.test(x); });
    return ((p[0] || '?').charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : '')).toUpperCase();
  }
  function nomeLimpo(nome) { return String(nome || '').replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, '').trim() || 'Paciente'; }

  var I = {
    tel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" fill="currentColor"/></svg>',
    desligar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.1a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.69a1 1 0 0 1 0 1.41l-2.48 2.45a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.66-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9z" fill="currentColor"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z" fill="currentColor"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11h-2c0 .74-.16 1.43-.45 2.05l1.47 1.47A6.9 6.9 0 0 0 19 11zm-4 .16V5a3 3 0 0 0-5.94-.6L15 10.34zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.52 2.59l1.48 1.48A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 3.1-1.23L19.73 21 21 19.73z" fill="currentColor"/></svg>',
    cadeado: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4z" fill="currentColor"/></svg>',
    ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill="currentColor"/></svg>',
    escudo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5z" fill="currentColor"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z" fill="currentColor"/></svg>',
    seta: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z" fill="currentColor"/></svg>'
  };

  var CustomWidget = function () {
    var self = this;
    var st = { painel: null, fila: null, erro: null, ocupado: false, confirmar: false, aviso: null, abrirFila: false, lido: 0, timer: null, lead: null };

    function cfg() { try { var s = (self.get_settings && self.get_settings()) || {}; return { slug: String(s.slug || '').trim(), chave: String(s.chave || '').trim() }; } catch (e) { return { slug: '', chave: '' }; } }
    function idDoLead() {
      var a = app();
      try { if (a && a.data && a.data.current_card && a.data.current_card.id) return Number(a.data.current_card.id); } catch (e) {}
      var m = (location.pathname || '').match(/leads\/detail\/(\d+)/); return m ? Number(m[1]) : null;
    }
    function usuario() {
      var id = null, nome = '';
      try { var s = self.system && self.system(); if (s && s.amouser_id) id = Number(s.amouser_id); } catch (e) {}
      try { var u = app() && app().constant && app().constant('user'); if (u) { id = id || Number(u.id) || null; nome = u.name || ''; } } catch (e) {}
      return { id: id, nome: nome };
    }

    /** Chamada à ponte (agente-dt). Nunca rejeita: devolve {ok, status, j}. */
    function ponte(metodo, caminho, corpo) {
      var c = cfg();
      if (!c.slug || !c.chave) return Promise.resolve({ ok: false, status: 0, j: { error: 'config' } });
      var opts = { method: metodo, headers: { 'X-Widget-Key': c.chave } };
      if (corpo) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(corpo); }
      return fetch(BASE + '/api/public/widget/' + encodeURIComponent(c.slug) + caminho, opts)
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j || {} }; }, function () { return { ok: r.ok, status: r.status, j: {} }; }); })
        .catch(function () { return { ok: false, status: 0, j: { error: 'rede' } }; });
    }
    function mensagemDeErro(r) {
      if (r.status === 0 && r.j && r.j.error === 'config') return 'config';
      if (r.status === 403) return 'Chave do widget inválida. Confira as configurações do widget.';
      if (r.status === 429) return 'Muitas tentativas seguidas. Aguarde um minuto.';
      if (r.status === 0) return 'Sem conexão com o servidor da Doutor Digital agora.';
      return (r.j && (r.j.motivo || r.j.error)) || 'Algo deu errado. Tente de novo.';
    }

    // ── leitura ──
    function carregar() {
      var lead = idDoLead(); st.lead = lead;
      if (!lead) { st.erro = 'Abra um lead para ligar.'; desenhar(); return Promise.resolve(); }
      return ponte('GET', '/ligacao/painel?lead=' + lead).then(function (r) {
        if (!r.ok) { st.erro = mensagemDeErro(r); } else { st.painel = r.j; st.erro = null; st.lido = Date.now(); }
        desenhar();
        if (st.painel && st.painel.modo !== 'desligado' && (st.abrirFila || !st.fila)) carregarFila();
      });
    }
    function carregarFila() {
      return ponte('GET', '/ligacao/fila').then(function (r) { if (r.ok) { st.fila = r.j; desenhar(); } });
    }

    // ── ações ──
    function pedirPermissao() {
      var u = usuario(); st.ocupado = true; st.aviso = null; desenhar();
      ponte('POST', '/ligacao/permissao', { leadId: st.lead, u: u.id, nome: u.nome }).then(function (r) {
        st.ocupado = false; st.aviso = { tipo: r.ok ? 'ok' : 'erro', texto: r.ok ? r.j.motivo : mensagemDeErro(r) }; carregar();
      });
    }
    function escreverNoChat(txt) {
      // mesmo caminho do Assistente: escreve no campo do chat do Kommo SEM enviar — a SDR lê e envia
      var el = document.querySelector('.control-contenteditable__area');
      if (!el) return false;
      el.focus(); var deu = false;
      try { deu = document.execCommand('insertText', false, txt); } catch (e) { deu = false; }
      if (!deu) { el.textContent = txt; el.dispatchEvent(new Event('input', { bubbles: true })); }
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      return true;
    }
    function copiar(txt) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(txt).then(function () { return true; }, function () { return legado(); });
      return Promise.resolve(legado());
      function legado() { var ta = $('<textarea>').val(txt).css({ position: 'fixed', left: '-9999px' }).appendTo('body'); ta[0].select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); return ok; }
    }
    function combinar(modo) {
      var txt = (st.painel && st.painel.combinado && st.painel.combinado.texto) || 'Posso te ligar agora pelo WhatsApp?';
      var feito = modo === 'chat' ? Promise.resolve(escreverNoChat(txt)) : copiar(txt);
      feito.then(function (ok) {
        st.aviso = { tipo: ok ? 'ok' : 'erro', texto: ok ? (modo === 'chat' ? 'Escrevi no chat. Confira e aperte enviar — o botão Ligar fica verde quando ele responder.' : 'Copiado. Cole no chat e envie.') : 'Não achei o campo do chat. Use "Copiar".' };
        if (ok) ponte('POST', '/ligacao/combinar', { leadId: st.lead }).then(carregar); else desenhar();
      });
    }

    // ── a ligação (WebRTC) ──
    function suportaLigacao() { return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext !== false); }
    function esperarCandidatos(pc, ms) {
      // A Meta quer a oferta COMPLETA (sem trickle): espera juntar os caminhos de rede, com teto de tempo.
      return new Promise(function (ok) {
        if (pc.iceGatheringState === 'complete') return ok();
        var t = setTimeout(ok, ms);
        pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') { clearTimeout(t); ok(); } });
      });
    }
    function ligar(confirmouSemCombinar, origem) {
      if (G.chamada) return;
      if (!suportaLigacao()) { st.aviso = { tipo: 'erro', texto: 'Este navegador não faz ligação. Use o Chrome atualizado.' }; desenhar(); return; }
      var u = usuario(); var p = st.painel || {}; var pac = p.paciente || {};
      var ch = G.chamada = { id: null, lead: st.lead, nome: nomeLimpo(pac.nome), tel: pac.telefone || '', status: 'preparando', inicio: Date.now(), atendida: null, mudo: false, pc: null, stream: null, audio: null, sdpAplicada: false, poll: null, fim: null, resultado: null, texto: null, registrada: false, erro: null, nivel: 0 };
      st.confirmar = false; st.aviso = null; desenhar();
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
        ch.stream = stream;
        var pc = ch.pc = new RTCPeerConnection({ iceServers: STUN });
        stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
        ch.audio = document.createElement('audio'); ch.audio.autoplay = true; ch.audio.style.display = 'none'; document.body.appendChild(ch.audio);
        pc.ontrack = function (ev) { ch.audio.srcObject = ev.streams[0]; var pr = ch.audio.play(); if (pr && pr.catch) pr.catch(function () {}); };
        pc.onconnectionstatechange = function () { if (pc.connectionState === 'failed' && ch.status !== 'encerrada') { ch.erro = 'A conexão de áudio caiu.'; desligar(); } };
        medirNivel(stream);
        ch.status = 'conectando'; desenhar();
        return pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).then(function () { return esperarCandidatos(pc, 2500); }).then(function () {
          return ponte('POST', '/ligacao/ligar', { leadId: ch.lead, sdp: pc.localDescription.sdp, u: u.id, nome: u.nome, origem: origem || 'cartao', confirmouSemCombinar: !!confirmouSemCombinar });
        }).then(function (r) {
          if (!r.ok || !r.j.ligacaoId) {
            var precisa = r.j && r.j.precisaConfirmar;
            limparMidia(ch); G.chamada = null;
            if (precisa) { st.confirmar = true; st.aviso = { tipo: 'alerta', texto: r.j.motivo }; } else st.aviso = { tipo: 'erro', texto: mensagemDeErro(r) };
            carregar(); return;
          }
          ch.id = r.j.ligacaoId; ch.status = 'chamando'; desenhar(); acompanhar();
        });
      }, function (err) {
        G.chamada = null;
        st.aviso = { tipo: 'erro', texto: err && err.name === 'NotAllowedError' ? 'O navegador bloqueou o microfone. Clique no cadeado ao lado do endereço do Kommo e permita o microfone.' : 'Não consegui usar o microfone deste computador.' };
        desenhar();
      }).catch(function () { limparMidia(ch); G.chamada = null; st.aviso = { tipo: 'erro', texto: 'Não consegui preparar a ligação. Recarregue a página e tente de novo.' }; desenhar(); });
    }
    function acompanhar() {
      var ch = G.chamada; if (!ch || ch.poll) return;
      var falhas = 0;
      ch.poll = setInterval(function () {
        if (!G.chamada || G.chamada !== ch || !ch.id) { clearInterval(ch.poll); return; }
        ponte('GET', '/ligacao/chamada/' + encodeURIComponent(ch.id)).then(function (r) {
          if (!r.ok) { if (++falhas > 20) encerrarLocal(ch, null); return; }
          falhas = 0; var e = r.j; var antes = ch.status;
          if (e.sdpResposta && !ch.sdpAplicada && ch.pc) {
            ch.sdpAplicada = true;
            ch.pc.setRemoteDescription({ type: 'answer', sdp: e.sdpResposta }).catch(function () { ch.erro = 'A Meta mandou uma resposta de áudio que o navegador não aceitou.'; });
          }
          if (e.status === 'tocando' && ch.status !== 'tocando' && !ch.atendida) ch.status = 'tocando';
          if (e.status === 'em_ligacao' && !ch.atendida) { ch.status = 'em_ligacao'; ch.atendida = Date.now(); }
          if (e.status === 'encerrada') { encerrarLocal(ch, e); return; }
          // sem resposta da Meta em 25 s: o webhook não chegou (configuração do n8n?) — encerra pra não pendurar
          if (!ch.sdpAplicada && Date.now() - ch.inicio > 25000 && !ch.fim) { ch.erro = 'A Meta não respondeu a tempo.'; desligar(); return; }
          // a Meta não documenta quanto tempo toca: depois de 60 s sem atender, desliga (e conta como sem atender)
          if (!ch.atendida && Date.now() - ch.inicio > 65000 && !ch.fim) { ch.erro = 'Tocou por 1 minuto e ninguém atendeu.'; desligar(); return; }
          // redesenha só quando muda: redesenhar a cada segundo engoliria o clique em Desligar
          if (ch.status !== antes) desenhar();
        });
      }, 1000);
    }
    function desligar() {
      var ch = G.chamada; if (!ch || ch.fim) return;
      ch.fim = Date.now(); ch.status = 'encerrando'; limparMidia(ch); desenhar();
      if (ch.id) ponte('POST', '/ligacao/chamada/' + encodeURIComponent(ch.id) + '/desligar', {});
      // o resultado chega pelo acompanhamento; se a Meta demorar a avisar, fecha a tela mesmo assim
      setTimeout(function () { if (G.chamada === ch) encerrarLocal(ch, null); }, 20000);
    }
    function encerrarLocal(ch, e) {
      if (ch.poll) clearInterval(ch.poll); ch.poll = null; limparMidia(ch);
      ch.status = 'encerrada'; ch.resultado = e ? e.resultado : null; ch.texto = e ? e.texto : null; ch.registrada = !!(e && e.registrada);
      ch.duracao = e && e.duracaoSeg != null ? e.duracaoSeg : (ch.atendida ? (Date.now() - ch.atendida) / 1000 : 0);
      st.ultimaChamada = ch; G.chamada = null; carregar();
    }
    function limparMidia(ch) {
      try { if (ch.stream) ch.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (ch.pc) ch.pc.close(); } catch (e) {}
      try { if (ch.audio) { ch.audio.srcObject = null; ch.audio.remove(); } } catch (e) {}
      try { if (ch.ctx) ch.ctx.close(); } catch (e) {}
      ch.stream = null; ch.pc = null; ch.audio = null; ch.ctx = null;
    }
    function alternarMudo() {
      var ch = G.chamada; if (!ch || !ch.stream) return;
      ch.mudo = !ch.mudo; ch.stream.getAudioTracks().forEach(function (t) { t.enabled = !ch.mudo; }); desenhar();
    }
    function medirNivel(stream) {
      // barrinhas do microfone: a SDR vê que a voz dela está saindo
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
        var ch = G.chamada; var ctx = ch.ctx = new Ctx(); var an = ctx.createAnalyser(); an.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(an);
        var buf = new Uint8Array(an.frequencyBinCount);
        (function laco() {
          if (!G.chamada || G.chamada !== ch || !ch.ctx) return;
          an.getByteFrequencyData(buf); var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i];
          ch.nivel = ch.mudo ? 0 : Math.min(1, s / buf.length / 70);
          var $b = $('.' + P + '-nivel i'); $b.each(function (k) { $(this).toggleClass('on', ch.nivel > (k + 1) / 6); });
          requestAnimationFrame(laco);
        })();
      } catch (e) {}
    }
    window.addEventListener('beforeunload', function () {
      var ch = G.chamada; var c = cfg();
      if (ch && ch.id && !ch.fim && c.slug) { try { fetch(BASE + '/api/public/widget/' + encodeURIComponent(c.slug) + '/ligacao/chamada/' + encodeURIComponent(ch.id) + '/desligar', { method: 'POST', keepalive: true, headers: { 'X-Widget-Key': c.chave, 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {} }
    });

    // ── desenho ──
    function passoAtual(p) {
      if (!p.permissao || p.permissao.estado !== 'aceita') return 1;
      if (p.combinado && p.combinado.estado === 'respondeu') return 3;
      return 2;
    }
    function trilha(p) {
      var at = passoAtual(p); var trav = p.trava && p.trava.travado;
      var nomes = ['Permissão', 'Combinar', 'Ligar'];
      return '<ol class="' + P + '-trilha">' + nomes.map(function (n, i) {
        var k = i + 1; var cls = k < at ? 'feito' : k === at ? (trav && k > 1 ? 'travado' : 'agora') : 'depois';
        return '<li class="' + P + '-trilha__' + cls + '"><span>' + (k < at ? I.ok : k) + '</span><b>' + n + '</b></li>';
      }).join('') + '</ol>';
    }
    function cabecalho(p) {
      var pac = p.paciente || {}; var nome = nomeLimpo(pac.nome);
      var perm = p.permissao || {};
      var selo = perm.estado === 'aceita' ? '<span class="' + P + '-selo ' + P + '-selo--ok">' + I.escudo + (perm.permanente ? 'Permissão sempre' : 'Permissão até ' + esc(data(perm.ate))) + '</span>'
        : perm.estado === 'pedida' ? '<span class="' + P + '-selo ' + P + '-selo--espera">Permissão pedida</span>'
        : perm.estado === 'recusada' ? '<span class="' + P + '-selo ' + P + '-selo--nao">Recusou ligações</span>'
        : perm.estado === 'caiu' ? '<span class="' + P + '-selo ' + P + '-selo--nao">Permissão acabou</span>'
        : '<span class="' + P + '-selo">Sem permissão</span>';
      return '<div class="' + P + '-cab"><div class="' + P + '-av">' + esc(iniciais(pac.nome)) + '</div><div class="' + P + '-cab__txt"><b title="' + esc(nome) + '">' + esc(nome) + '</b><small>WhatsApp ' + esc(pac.telefone || '') + (pac.numeroDeTeste ? ' · número de teste' : '') + '</small>' + selo + '</div></div>' +
        (p.modo === 'seco' ? '<div class="' + P + '-teste"><b>Modo teste.</b> O painel mostra tudo, mas só liga e só pede permissão para o número de teste.</div>' : '');
    }
    function blocoPermissao(p) {
      var perm = p.permissao; var h = '<div class="' + P + '-card">';
      var tit = { sem: 'Peça a permissão para ligar', pedida: 'Esperando o paciente permitir', recusada: 'O paciente recusou ligações', caiu: 'A permissão acabou' }[perm.estado] || 'Permissão';
      var txt = {
        sem: 'O WhatsApp só deixa a clínica ligar para quem permitiu. O paciente recebe uma mensagem com o botão <b>Permitir ligações</b>.',
        pedida: 'Pedido enviado. Quando ele tocar em <b>Permitir</b>, o próximo passo libera sozinho.',
        recusada: 'Fale por mensagem. Dá para pedir de novo mais tarde, se ele mudar de ideia no chat.',
        caiu: 'A permissão vale por alguns dias. Peça de novo — ou combine pelo chat primeiro.'
      }[perm.estado] || '';
      h += '<div class="' + P + '-card__tit">' + esc(tit) + '</div><p>' + txt + '</p>';
      if (perm.podePedir) h += '<button type="button" class="' + P + '-btn ' + P + '-btn--azul ' + P + '-pedir"' + (st.ocupado ? ' disabled' : '') + '>' + I.escudo + (st.ocupado ? 'Enviando…' : perm.estado === 'sem' ? 'Pedir permissão' : 'Pedir de novo') + '</button>';
      else if (perm.motivoNaoPode && perm.estado !== 'aceita') h += '<div class="' + P + '-nota">' + esc(perm.motivoNaoPode) + (perm.liberaEm ? ' Libera ' + esc(quando(perm.liberaEm)) + '.' : '') + '</div>';
      h += '<div class="' + P + '-mini">Pedidos nesta semana: <b>' + (perm.pedidosNaSemana || 0) + ' de 2</b> · máximo 1 por dia</div>';
      return h + '</div>';
    }
    function blocoCombinar(p) {
      var c = p.combinado || {};
      var h = '<div class="' + P + '-card"><div class="' + P + '-card__tit">Combine antes de ligar</div>';
      h += '<div class="' + P + '-balao">' + esc(c.texto || '') + '</div>';
      if (c.estado === 'esperando') h += '<div class="' + P + '-espera"><i></i><i></i><i></i> Perguntou ' + esc(relativo(c.perguntouEm)) + ' · esperando ele responder</div>';
      else if (c.estado === 'vencido') h += '<div class="' + P + '-nota">A combinação ficou velha. Pergunte de novo antes de ligar.</div>';
      h += '<div class="' + P + '-linha"><button type="button" class="' + P + '-btn ' + P + '-btn--azul ' + P + '-chat">' + I.chat + 'Escrever no chat</button><button type="button" class="' + P + '-btn ' + P + '-copiar">Copiar</button></div>';
      return h + '<div class="' + P + '-mini">Ligação combinada é ligação atendida. Sem resposta dele, o botão fica amarelo.</div></div>';
    }
    function blocoLigar(p) {
      var d = p.decisao || {}; var trav = p.trava || {}; var c = p.combinado || {};
      var h = '';
      if (trav.travado) {
        return '<div class="' + P + '-card ' + P + '-card--trava"><div class="' + P + '-card__tit">' + I.cadeado + (trav.firme ? 'Travado de vez' : 'Travado para este paciente') + '</div><p>' + esc(trav.explicacao) + '</p></div>' +
          '<div class="' + P + '-ligar"><button type="button" class="' + P + '-big ' + P + '-big--off" disabled>' + I.cadeado + '</button><span>Ligar travado</span></div>';
      }
      if (p.aberta && !G.chamada) h += '<div class="' + P + '-nota">Há uma ligação em andamento com este paciente (em outro computador?).</div>';
      var verde = d.ok; var amarelo = !d.ok && d.precisaConfirmar;
      if (st.confirmar) {
        h += '<div class="' + P + '-card ' + P + '-card--alerta"><div class="' + P + '-card__tit">Ligar sem combinar?</div><p>' + esc((st.aviso && st.aviso.texto) || d.motivo || '') + '</p>' +
          '<div class="' + P + '-linha"><button type="button" class="' + P + '-btn ' + P + '-cancelar">Voltar</button><button type="button" class="' + P + '-btn ' + P + '-btn--amarelo ' + P + '-mesmoassim">Ligar mesmo assim</button></div></div>';
        return h;
      }
      if (verde || amarelo) {
        h += '<div class="' + P + '-ligar"><button type="button" class="' + P + '-big ' + (verde ? P + '-big--verde' : P + '-big--amarelo') + ' ' + P + '-ligarbtn" title="Ligar pelo WhatsApp">' + I.tel + '</button>' +
          '<span>' + (verde ? 'Ele respondeu ' + esc(relativo(c.respondeuEm)) + ' — pode ligar' : 'Ligar sem combinar') + '</span></div>';
      } else if (d.motivo) {
        h += '<div class="' + P + '-ligar"><button type="button" class="' + P + '-big ' + P + '-big--off" disabled>' + I.tel + '</button><span>' + esc(d.motivo) + '</span></div>';
      }
      return h;
    }
    function blocoInfo(p) {
      var t = p.trava || {}; var u = p.ultima; var h = '<div class="' + P + '-info">';
      h += '<div><span>Sem atender</span><b class="' + (t.seguidas ? P + '-cor--alerta' : '') + '">' + (t.seguidas ? esc(Math.min(t.seguidas, t.limite) + ' de ' + t.limite) : '0 de ' + (t.limite || 2)) + '</b></div>';
      h += '<div><span>Última ligação</span><b>' + (u ? esc(quando(u.em)) : '—') + '</b>' + (u ? '<small>' + esc(rotuloResultado(u.resultado)) + (u.duracaoSeg ? ' · ' + esc(duracao(u.duracaoSeg)) : '') + (u.por ? ' · ' + esc(u.por) : '') + '</small>' : '') + '</div>';
      return h + '</div>';
    }
    function rotuloResultado(r) { return { atendida: 'atendida', nao_atendida: 'não atendeu', recusada: 'recusou', falhou: 'não completou' }[r] || 'em andamento'; }
    function blocoFila(p) {
      var f = st.fila || {}; var hj = p.hoje || {};
      var pct = hj.taxa == null ? null : hj.taxa; var min = hj.taxaMinima || 50;
      var h = '<div class="' + P + '-fila">';
      h += '<div class="' + P + '-hoje"><div><span>Hoje na unidade</span><b>' + (hj.total ? hj.atendidas + ' de ' + hj.total + ' atendidas' : 'nenhuma ligação ainda') + '</b></div>' +
        (pct != null ? '<div class="' + P + '-barra" title="mínimo ' + min + '%"><i style="width:' + pct + '%" class="' + (pct < min ? 'baixo' : '') + '"></i><em style="left:' + min + '%"></em></div>' : '') + '</div>';
      if (f.pausada) h += '<div class="' + P + '-pausa">' + I.cadeado + '<div><b>Fila pausada até amanhã.</b> ' + esc(f.motivo || '') + ' Ligue só pelo cartão, combinando antes.</div></div>';
      var itens = (f.itens || []).filter(function (x) { return x.leadId !== st.lead; });
      h += '<button type="button" class="' + P + '-fila__cab ' + P + '-abrefila"><span>Fila "Ligar próximo"</span><b>' + itens.length + '</b>' + I.seta + '</button>';
      if (st.abrirFila) {
        if (!itens.length) h += '<div class="' + P + '-mini">Ninguém com permissão esperando ligação agora.</div>';
        else {
          h += '<button type="button" class="' + P + '-btn ' + P + '-btn--azul ' + P + '-proximo"' + (f.pausada ? ' disabled' : '') + '>Ligar próximo: ' + esc(nomeLimpo(itens[0].nome)) + I.seta + '</button>';
          h += '<ul class="' + P + '-lista">' + itens.slice(0, 8).map(function (x) {
            return '<li><a href="/leads/detail/' + x.leadId + '">' + esc(nomeLimpo(x.nome)) + '</a><small>' + (x.permanente ? 'sempre' : 'até ' + esc(data(x.permissaoAte))) + (x.seguidas ? ' · ' + x.seguidas + ' sem atender' : '') + '</small></li>';
          }).join('') + '</ul><div class="' + P + '-mini">A fila não disca sozinha: abre o cartão e você liga, combinando antes.</div>';
        }
      }
      return h + '</div>';
    }
    function telaChamada(ch) {
      var em = ch.status === 'em_ligacao';
      var rot = { preparando: 'Abrindo o microfone…', conectando: 'Conectando…', chamando: 'Chamando…', tocando: 'Tocando no celular dele', em_ligacao: 'Em ligação', encerrando: 'Encerrando…' }[ch.status] || '';
      var outro = ch.lead !== st.lead;
      return '<div class="' + P + '-call' + (em ? ' ' + P + '-call--on' : '') + '">' +
        (outro ? '<a class="' + P + '-call__outro" href="/leads/detail/' + ch.lead + '">Em ligação com outro paciente — abrir cartão</a>' : '') +
        '<div class="' + P + '-call__av' + (em ? '' : ' ' + P + '-pulsa') + '">' + esc(iniciais(ch.nome)) + '</div>' +
        '<b class="' + P + '-call__nome">' + esc(ch.nome) + '</b><small>' + esc(ch.tel) + '</small>' +
        '<div class="' + P + '-call__st">' + esc(rot) + '</div>' +
        '<div class="' + P + '-cron">' + (em ? cron((Date.now() - ch.atendida) / 1000) : '&nbsp;') + '</div>' +
        '<div class="' + P + '-nivel" title="seu microfone"><i></i><i></i><i></i><i></i><i></i></div>' +
        '<div class="' + P + '-call__bts"><button type="button" class="' + P + '-redondo ' + P + '-mudo' + (ch.mudo ? ' on' : '') + '" title="' + (ch.mudo ? 'Tirar do mudo' : 'Mudo') + '"' + (ch.fim ? ' disabled' : '') + '>' + (ch.mudo ? I.micOff : I.mic) + '<span>' + (ch.mudo ? 'No mudo' : 'Mudo') + '</span></button>' +
        '<button type="button" class="' + P + '-redondo ' + P + '-redondo--verm ' + P + '-desligar" title="Desligar"' + (ch.fim ? ' disabled' : '') + '>' + I.desligar + '<span>Desligar</span></button></div>' +
        (em ? '' : '<div class="' + P + '-mini">Desligar antes de ele atender conta como "sem atender".</div>') +
        (p_gravar() ? '<div class="' + P + '-mini">Esta ligação pode ser gravada: avise o paciente no começo.</div>' : '') +
        '</div>';
    }
    function p_gravar() { return !!(st.painel && st.painel.gravar); }
    function telaResultado(ch) {
      var r = ch.resultado; var cls = r === 'atendida' ? 'ok' : r === 'falhou' || !r ? 'neutro' : 'alerta';
      var tit = r === 'atendida' ? 'Ligação atendida · ' + duracao(ch.duracao) : r === 'nao_atendida' ? 'Não atendeu' : r === 'recusada' ? 'Recusou a ligação' : r === 'falhou' ? 'A ligação não completou' : 'Ligação encerrada';
      return '<div class="' + P + '-res ' + P + '-res--' + cls + '"><b>' + esc(tit) + '</b>' +
        '<p>' + esc(ch.erro || ch.texto || (r ? '' : 'O resultado aparece no cartão em instantes.')) + '</p>' +
        (ch.registrada ? '<small>' + I.ok + 'Registrada no cartão</small>' : '') +
        (r === 'nao_atendida' || r === 'recusada' ? '<small>Mande uma mensagem antes de tentar de novo.</small>' : '') +
        '<button type="button" class="' + P + '-btn ' + P + '-fecharres">OK</button></div>';
    }
    function rodape() {
      var h = st.lido ? new Date(st.lido) : null;
      return '<div class="' + P + '-rodape"><span>' + (p_gravar() ? 'Gravação: ligada' : 'Gravação: desligada') + (h ? ' · conferido ' + dois(h.getHours()) + ':' + dois(h.getMinutes()) : '') + '</span><span><a href="#" class="' + P + '-recarregar">Atualizar</a> · v' + esc(VERSAO) + '</span></div>';
    }
    function html() {
      if (st.erro === 'config') return '<div class="' + P + '-card"><div class="' + P + '-card__tit">Falta configurar</div><p>Preencha o <b>código da unidade</b> e a <b>chave</b> nas configurações do widget (Configurações → Integrações → Ligar pelo WhatsApp).</p></div>' + rodape();
      if (G.chamada) return telaChamada(G.chamada);
      if (st.ultimaChamada) return telaResultado(st.ultimaChamada) + rodape();
      var p = st.painel;
      if (st.erro && !p) return '<div class="' + P + '-card ' + P + '-card--erro"><p>' + esc(st.erro) + '</p></div>' + rodape();
      if (!p) return '<div class="' + P + '-vazio"><i></i>Lendo o paciente…</div>';
      if (p.modo === 'desligado') return '<div class="' + P + '-card"><div class="' + P + '-card__tit">Ligação pelo WhatsApp desligada</div><p>Esta unidade ainda não liga pelo WhatsApp. Quem liga é a gestão, na tela de Automações.</p></div>' + rodape();
      if (!p.paciente) return '<div class="' + P + '-card ' + P + '-card--erro"><p>O contato deste cartão não tem um celular válido.</p></div>' + rodape();
      if (!p.credencial) return cabecalho(p) + '<div class="' + P + '-card ' + P + '-card--erro"><p>A unidade ainda não tem o número oficial do WhatsApp configurado no sistema.</p></div>' + rodape();
      var h = cabecalho(p) + trilha(p);
      if (st.aviso && !st.confirmar) h += '<div class="' + P + '-aviso ' + P + '-aviso--' + st.aviso.tipo + '">' + esc(st.aviso.texto) + '</div>';
      var at = passoAtual(p);
      if (at === 1) h += blocoPermissao(p);
      else { if (at === 2 && !(p.trava && p.trava.travado) && !st.confirmar) h += blocoCombinar(p); h += blocoLigar(p); }
      h += blocoInfo(p) + blocoFila(p);
      return h + rodape();
    }
    function desenhar() {
      var $p = $('.' + P + '-p'); if (!$p.length) return;
      ajustarLogo(); $p.html(html());
      $p.find('.' + P + '-recarregar').on('click', function (ev) { ev.preventDefault(); st.aviso = null; carregar(); });
      $p.find('.' + P + '-pedir').on('click', pedirPermissao);
      $p.find('.' + P + '-chat').on('click', function () { combinar('chat'); });
      $p.find('.' + P + '-copiar').on('click', function () { combinar('copiar'); });
      $p.find('.' + P + '-ligarbtn').on('click', function () {
        var d = (st.painel && st.painel.decisao) || {};
        if (d.ok) ligar(false); else { st.confirmar = true; st.aviso = { tipo: 'alerta', texto: d.motivo }; desenhar(); }
      });
      $p.find('.' + P + '-mesmoassim').on('click', function () { ligar(true); });
      $p.find('.' + P + '-cancelar').on('click', function () { st.confirmar = false; st.aviso = null; desenhar(); });
      $p.find('.' + P + '-desligar').on('click', desligar);
      $p.find('.' + P + '-mudo').on('click', alternarMudo);
      $p.find('.' + P + '-fecharres').on('click', function () { st.ultimaChamada = null; desenhar(); });
      $p.find('.' + P + '-abrefila').on('click', function () { st.abrirFila = !st.abrirFila; if (st.abrirFila) carregarFila(); desenhar(); });
      $p.find('.' + P + '-proximo').on('click', function () {
        var it = ((st.fila && st.fila.itens) || []).filter(function (x) { return x.leadId !== st.lead; })[0];
        if (it) location.href = '/leads/detail/' + it.leadId;
      });
    }
    G.render = desenhar;

    function carregarCss() { var id = P + '-css'; if (document.getElementById(id) || !CSS) return; $('<style>', { id: id, type: 'text/css' }).text(CSS).appendTo('head'); }
    function ajustarLogo() {
      var $p = $('.' + P + '-p'); if (!$p.length || !LOGO_B64) return; var $img = null;
      $p.parents().each(function () { if ($img) return; var i = $(this).find('img').filter(function () { return !$(this).closest('.' + P + '-p').length && /logo|widget|upl/i.test(this.src || ''); }).first(); if (i.length) $img = i; });
      if ($img && $img.attr('data-' + P) !== '1') $img.attr('data-' + P, '1').attr('src', 'data:image/png;base64,' + LOGO_B64).css({ objectFit: 'contain', objectPosition: 'center' });
    }

    this.callbacks = {
      render: function () {
        carregarCss();
        var area = (self.system && self.system().area) || '';
        if (area === 'lcard') self.render_template({ caption: { class_name: P + '-caption' }, body: '<div class="' + P + '-p"><div class="' + P + '-vazio"><i></i>Lendo o paciente…</div></div>', render: '' });
        return true;
      },
      init: function () { carregarCss(); return true; },
      bind_actions: function () {
        carregarCss();
        var area = (self.system && self.system().area) || '';
        if (area !== 'lcard') return true;
        if (st.timer) clearInterval(st.timer);
        st.ultimaChamada = null; carregar();
        if (G.chamada) acompanhar();
        // o painel relê sozinho: a resposta do paciente ao "Posso te ligar?" e a permissão chegam enquanto a SDR olha
        st.timer = setInterval(function () {
          if (G.chamada) return;                             // durante a ligação quem anda é o cronômetro
          if (!st.confirmar && !st.ocupado && !st.ultimaChamada && document.visibilityState !== 'hidden') carregar();
        }, 15000);
        // durante a ligação o cronômetro anda a cada segundo
        if (!G.relogio) G.relogio = setInterval(function () { if (G.chamada && G.chamada.status === 'em_ligacao' && G.render) { var $c = $('.' + P + '-cron'); if ($c.length) $c.text(cron((Date.now() - G.chamada.atendida) / 1000)); } }, 1000);
        return true;
      },
      settings: function () {},
      onSave: function () { return true; },
      destroy: function () { if (st.timer) { clearInterval(st.timer); st.timer = null; } }
    };
    return this;
  };
  return CustomWidget;
});
