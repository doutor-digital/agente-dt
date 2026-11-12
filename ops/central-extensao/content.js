// Central do João — painel no canto do WhatsApp Web.
// Fase 1 (pausa do agente 9103): lê SÓ o número e o nome da conversa aberta.
// Fase 1b (chamados): lê a LISTA de conversas (nome, prévia da última mensagem, selo de não lida/menção) e manda ao servidor só
// as que têm menção a você ou não lida no privado. Nunca abre conversa sozinha. Na conversa aberta, só o trecho que você escolher
// ("📌 Virar chamado") sai daqui.
(function () {
  if (window.__centralJoao) return;
  window.__centralJoao = 1;

  const pedir = (tipo, corpo) => new Promise((ok) => chrome.runtime.sendMessage({ tipo, corpo }, (r) => ok(r || { ok: false, erro: 'extensão recarregada: atualize a página' })));

  // ── qual conversa está aberta ───────────────────────────────────────────────────────────────
  function conversaAberta() {
    const main = document.getElementById('main');
    if (!main) return null;
    const tituloEl = main.querySelector('header span[title]') || main.querySelector('header [dir="auto"]');
    const nome = tituloEl ? (tituloEl.getAttribute('title') || tituloEl.textContent || '').trim() : '';
    let numero = null, grupo = false;
    for (const el of main.querySelectorAll('[data-id]')) {
      const id = el.getAttribute('data-id') || '';
      if (/@g\.us/.test(id)) { grupo = true; break; }
      const m = /(?:true|false)_(\d{8,15})@c\.us/.exec(id);
      if (m) { numero = m[1]; break; }
    }
    // contato não salvo: o título é o próprio número
    if (!numero && !grupo && /^\+?[\d\s()-]{10,}$/.test(nome)) numero = nome.replace(/\D/g, '');
    return { nome: nome.slice(0, 60), nomeCompleto: nome.slice(0, 120), numero, grupo };
  }

  // ── painel ──────────────────────────────────────────────────────────────────────────────────
  const caixa = document.createElement('div');
  caixa.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:13px/1.35 system-ui,sans-serif;width:260px;padding:10px 12px';
  const topo = document.createElement('div');
  topo.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px;cursor:pointer';
  topo.textContent = 'Central do João';
  const seta = document.createElement('span'); seta.textContent = '–'; topo.appendChild(seta);
  const corpo = document.createElement('div');
  const linhaGeral = document.createElement('div');
  const btGeral = document.createElement('button');
  const linhaPessoa = document.createElement('div');
  const btPessoa = document.createElement('button');
  const aviso = document.createElement('div');
  aviso.style.cssText = 'color:#667781;font-size:12px;margin-top:6px;min-height:14px';
  const btChamado = document.createElement('button');
  const fila = document.createElement('div');
  fila.style.cssText = 'border-top:1px solid #e9edef;margin-top:8px;padding-top:6px;max-height:300px;overflow:auto';
  for (const b of [btGeral, btPessoa, btChamado]) b.style.cssText = 'display:block;width:100%;margin:4px 0 8px;padding:6px;border:0;border-radius:6px;cursor:pointer;font:600 13px system-ui,sans-serif';
  corpo.append(linhaGeral, btGeral, linhaPessoa, btPessoa, btChamado, aviso, fila);
  caixa.append(topo, corpo);
  let aberto = true;
  topo.onclick = () => { aberto = !aberto; corpo.style.display = aberto ? '' : 'none'; seta.textContent = aberto ? '–' : '+'; };
  document.body.appendChild(caixa);

  const cor = (b, pausar) => { b.style.background = pausar ? '#f15c6d' : '#00a884'; b.style.color = '#fff'; };
  let estado = null, atual = null, ocupado = false, pedido = 0;
  const chaveDe = (c) => (c ? `${c.numero}|${c.grupo}|${c.nome}` : '');

  async function atualizar() {
    if (ocupado) return;
    const minha = ++pedido;
    const conversa = conversaAberta();
    const r = await pedir('estado', { numero: conversa && conversa.numero ? conversa.numero : undefined });
    // resposta atrasada (chegou outra depois, ou a conversa mudou no meio): descarta, para nunca mostrar o estado de A no nome de B
    if (minha !== pedido || chaveDe(conversaAberta()) !== chaveDe(conversa)) return;
    atual = conversa;
    if (!r.ok) { linhaGeral.textContent = '⚠️ ' + r.erro; btGeral.style.display = btPessoa.style.display = 'none'; linhaPessoa.textContent = ''; return; }
    estado = r.dados;
    btGeral.style.display = '';
    const g = estado.geral;
    const modo = estado.modo === 'ligado' ? '' : ` (servidor: ${estado.modo})`;
    linhaGeral.textContent = (g.pausado ? '⏸ Pausado para TODOS' : '▶️ Respondendo') + modo;
    btGeral.textContent = g.pausado ? 'Retomar para todos' : 'Pausar para todos';
    cor(btGeral, !g.pausado);
    if (!atual) { linhaPessoa.textContent = 'Abra uma conversa para pausar só ela.'; btPessoa.style.display = 'none'; }
    else if (atual.grupo) { linhaPessoa.textContent = 'Grupo: a pausa é por pessoa.'; btPessoa.style.display = 'none'; }
    else if (!atual.numero || !estado.pessoa) { linhaPessoa.textContent = 'Não achei o número desta conversa.'; btPessoa.style.display = 'none'; }
    else {
      const p = estado.pessoa;
      linhaPessoa.textContent = `${atual.nome || 'Esta conversa'} (${p.final}): ` + (p.pausada ? '⏸ pausada' : '▶️ ativa');
      btPessoa.textContent = p.pausada ? 'Retomar só esta pessoa' : 'Pausar só esta pessoa';
      cor(btPessoa, !p.pausada);
      btPessoa.style.display = '';
    }
    btChamado.style.display = atual ? '' : 'none';
    const n = (estado.pausadas || []).length;
    aviso.textContent = n ? `${n} pessoa(s) pausada(s)` : '';
  }

  async function agir(tipo, corpoPedido) {
    ocupado = true; aviso.textContent = 'Gravando…';
    const r = await pedir(tipo, corpoPedido);
    ocupado = false;
    aviso.textContent = r.ok ? 'Feito.' : '⚠️ ' + r.erro;
    await atualizar();
  }
  btGeral.onclick = () => estado && agir('geral', { pausar: !estado.geral.pausado });
  btPessoa.onclick = () => {
    // a conversa mudou desde a última leitura: não age (pausaria a pessoa errada); só atualiza o painel
    const agora = conversaAberta();
    if (!estado || !estado.pessoa || !atual || !atual.numero || chaveDe(agora) !== chaveDe(atual)) { aviso.textContent = 'A conversa mudou: confira e clique de novo.'; atualizar(); return; }
    agir('pessoa', { numero: atual.numero, nome: atual.nome, pausar: !estado.pessoa.pausada });
  };


  // ── fase 1b: chamados (menções e não lidas da LISTA de conversas) ───────────────────────────
  let cfg = { mencoes: true, privado: true, grupos: false, nomes: 'joão,joao' };
  try { chrome.storage.local.get(['cfg'], (c) => { if (c && c.cfg) cfg = Object.assign(cfg, c.cfg); }); } catch (e) { /* extensão recarregada */ }
  if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((m) => { if (m.cfg && m.cfg.newValue) cfg = Object.assign(cfg, m.cfg.newValue); });

  const txt = (el) => (el ? (el.getAttribute('title') || el.textContent || '').trim() : '');
  const HORA = /^(\d{1,2}:\d{2}|ontem|hoje|yesterday|today|\d{1,2}\/\d{1,2}\/\d{2,4}|segunda|terça|quarta|quinta|sexta|sábado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(-feira)?$/i;

  function linhasDaLista() {
    const lado = document.getElementById('pane-side');
    if (!lado) return [];
    const itens = lado.querySelectorAll('[role="listitem"]');
    return [...(itens.length ? itens : lado.querySelectorAll('[role="row"]'))];
  }

  // uma linha da lista → { conversa, trecho, naoLidas, mencao, grupo } (só o que está na tela)
  function lerLinha(el) {
    const titulos = el.querySelectorAll('span[title]');
    const conversa = txt(titulos[0]);
    if (!conversa) return null;
    let naoLidas = 0, marcada = false, mencao = false;
    for (const a of el.querySelectorAll('[aria-label]')) {
      const r = a.getAttribute('aria-label') || '';
      const m = /(\d+)\s+(mensage[mn]s?\s+não\s+lidas?|unread)/i.exec(r);
      if (m) naoLidas = Math.max(naoLidas, Number(m[1]));
      else if (/não lida|unread/i.test(r)) marcada = true;
      if (/menç|mention/i.test(r)) mencao = true;
    }
    if (el.querySelector('[data-icon*="mention" i]')) mencao = true;
    if (!naoLidas && marcada) naoLidas = 1;
    // prévia: as linhas de texto da linha da lista, sem o nome, a hora e o contador
    const partes = (el.innerText || '').split('\n').map((x) => x.trim()).filter((x) => x && x !== conversa && !HORA.test(x) && !/^\d{1,4}$/.test(x) && !/^(digitando|gravando|typing|recording)/i.test(x));
    const trecho = partes.join(' ').slice(0, 400);
    const nomes = String(cfg.nomes || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const baixo = trecho.toLowerCase();
    if (naoLidas && nomes.some((n) => baixo.includes('@' + n))) mencao = true;
    // grupo: o que a extensão já viu ao você abrir a conversa; senão ícone de grupo, ou prévia "Fulano: texto" (no privado, a
    // prévia de mensagem recebida não traz quem mandou) — menos quando o "Fulano" é palavra comum ("Obs: …", "Urgente: …")
    const sabido = memo.tipos[conversa];
    const prefixo = /^~?\s?([^:]{1,40}):\s/.exec(trecho);
    const grupo = sabido ? sabido === 'g' : !!el.querySelector('[data-icon*="group" i]') || (!!prefixo && !PALAVRA_COMUM.test(prefixo[1].trim()));
    return { conversa, trecho, naoLidas, mencao, grupo };
  }

  // memória local (só neste navegador, sobrevive a recarregar a página): o que já foi mandado, o nome real de cada chamado
  // (o servidor guarda o nome mascarado) e quem é grupo ou privado (aprendido ao você abrir a conversa)
  const PALAVRA_COMUM = /^(obs|ps|ok|oi|ol[aá]|bom dia|boa tarde|boa noite|aten[cç][aã]o|importante|urgente|assunto|nota|lembrete|re|fwd|pergunta|d[uú]vida|resumo|motivo|endere[cç]o|hor[aá]rio|valor|link|data|dia|hora|local|pix|cpf|nome|telefone)$/i;
  const memo = { enviado: {}, nomes: {}, tipos: {} };
  const MAX_MEMO = 400;
  const aparar = (o) => { const k = Object.keys(o); for (const x of k.slice(0, Math.max(0, k.length - MAX_MEMO))) delete o[x]; };
  let memoPronta = false;
  try { chrome.storage.local.get(['memo1b'], (c) => { if (c && c.memo1b) Object.assign(memo, c.memo1b); memoPronta = true; }); } catch (e) { memoPronta = true; }
  function guardarMemo() { aparar(memo.enviado); aparar(memo.nomes); aparar(memo.tipos); try { chrome.storage.local.set({ memo1b: memo }); } catch (e) { /* recarregada */ } }
  const enviado = {
    get: (k) => memo.enviado[k],
    has: (k) => k in memo.enviado,
    set: (k, v) => { delete memo.enviado[k]; memo.enviado[k] = v; },
    delete: (k) => { delete memo.enviado[k]; },
  };
  let diag = '';
  async function varrer() {
    if (!memoPronta) return;
    const aberta = conversaAberta();
    if (aberta && aberta.nomeCompleto && (aberta.grupo || aberta.numero)) memo.tipos[aberta.nomeCompleto] = aberta.grupo ? 'g' : 'p';
    const linhas = linhasDaLista();
    const sinais = [], lidas = [];
    let nNao = 0, nMen = 0;
    const vistas = new Set();
    for (const el of linhas) {
      const l = lerLinha(el);
      if (!l || vistas.has(l.conversa)) continue;
      vistas.add(l.conversa);
      if (l.naoLidas) nNao++;
      if (l.mencao) nMen++;
      let tipo = null;
      if (l.mencao && cfg.mencoes) tipo = 'mencao';
      else if (l.naoLidas && (l.grupo ? cfg.grupos : cfg.privado)) tipo = 'nao_lida';
      if (tipo) {
        const ass = `${tipo}|${l.naoLidas}|${l.trecho}`;
        if (enviado.get(l.conversa) !== ass) sinais.push({ ass, sinal: { conversa: l.conversa, tipo, grupo: l.grupo, trecho: l.trecho, naoLidas: l.naoLidas } });
      } else if (enviado.has(l.conversa) && !l.naoLidas) {
        // você abriu a conversa: a "não lida" vira vista no servidor (menção só sai com Feito)
        enviado.delete(l.conversa);
        lidas.push(l.conversa);
      }
    }
    diag = `Lista: ${vistas.size} conversas na tela · ${nNao} não lidas · ${nMen} menções`;
    // o que passou do teto fica para a próxima varredura (só marca como mandado o que foi de fato)
    const lote = sinais.slice(0, 40), loteLidas = lidas.slice(0, 100);
    for (const n of lidas.slice(100)) enviado.set(n, 'lida-pendente');
    if (!lote.length && !loteLidas.length && filaCarregada) { guardarMemo(); desenharFila(); return; }
    const r = await pedir('chamados', { sinais: lote.map((x) => x.sinal), lidas: loteLidas });
    if (!r.ok) {
      // nada foi gravado: as lidas voltam para tentar de novo; os sinais seguem fora de `enviado`, então vão de novo
      for (const n of loteLidas) enviado.set(n, 'lida-pendente');
      guardarMemo();
      diag += ' · ⚠️ ' + r.erro; desenharFila(); return;
    }
    const ids = r.dados.ids || [];
    lote.forEach((x, i) => { enviado.set(x.sinal.conversa, x.ass); if (ids[i]) memo.nomes[ids[i]] = x.sinal.conversa; });
    guardarMemo();
    abertos = r.dados.abertos || [];
    filaCarregada = true;
    desenharFila();
  }

  let abertos = [], filaCarregada = false;
  const ICONE = { mencao: '@', nao_lida: '💬', manual: '📌' };

  function abrirConversa(nome) {
    for (const el of linhasDaLista()) {
      const t = el.querySelector('span[title]');
      if (txt(t) === nome) {
        const alvo = t.closest('[role="listitem"],[role="row"]') || t;
        for (const tipo of ['mousedown', 'mouseup', 'click']) alvo.dispatchEvent(new MouseEvent(tipo, { bubbles: true, cancelable: true, view: window }));
        return true;
      }
    }
    return false;
  }

  function botaozinho(rotulo, acao) {
    const b = document.createElement('button');
    b.textContent = rotulo;
    b.style.cssText = 'border:1px solid #d1d7db;background:#fff;border-radius:5px;padding:1px 7px;margin-left:4px;cursor:pointer;font:12px system-ui,sans-serif';
    b.onclick = acao;
    return b;
  }

  function desenharFila() {
    fila.textContent = '';
    const cab = document.createElement('div');
    cab.style.cssText = 'font-weight:600;margin-bottom:4px';
    cab.textContent = `📥 Chamados abertos: ${abertos.length}`;
    const d = document.createElement('div');
    d.style.cssText = 'color:#667781;font-size:11px;margin-bottom:6px';
    d.textContent = diag;
    fila.append(cab, d);
    for (const c of abertos.slice(0, 15)) {
      const item = document.createElement('div');
      item.style.cssText = 'padding:4px 0;border-bottom:1px solid #f0f2f5';
      const linha1 = document.createElement('div');
      linha1.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:4px';
      const nome = document.createElement('span');
      nome.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      nome.textContent = `${ICONE[c.tipo] || '•'} ${c.conversa}${c.naoLidas ? ` (${c.naoLidas})` : ''}`;
      const acoes = document.createElement('span');
      acoes.style.cssText = 'flex:none';
      acoes.append(
        botaozinho('Abrir', () => { if (!abrirConversa(memo.nomes[c.id] || c.conversa)) aviso.textContent = 'Não está na lista visível: busque pelo nome.'; }),
        botaozinho('Feito', async () => {
          const r = await pedir('feito', { id: c.id });
          if (!r.ok) { aviso.textContent = '⚠️ ' + r.erro; return; }
          // não mexe em `enviado`: com o selo ainda na lista, o mesmo trecho não volta (e, se voltar, o servidor ignora)
          abertos = r.dados.abertos || [];
          desenharFila();
        }),
      );
      linha1.append(nome, acoes);
      const t = document.createElement('div');
      t.style.cssText = 'color:#667781;font-size:12px;white-space:pre-wrap;word-break:break-word';
      const ultima = String(c.trecho || '').split('\n').pop() || '';
      t.textContent = ultima.length > 140 ? ultima.slice(0, 139) + '…' : ultima;
      item.append(linha1, t);
      fila.appendChild(item);
    }
    if (abertos.length > 15) { const m = document.createElement('div'); m.style.cssText = 'color:#667781;font-size:12px;margin-top:4px'; m.textContent = `+ ${abertos.length - 15} mais antigos`; fila.appendChild(m); }
  }

  // "📌 Virar chamado": o texto que você selecionou na conversa aberta, ou a última mensagem recebida
  function trechoDaConversa() {
    const main = document.getElementById('main');
    if (!main) return '';
    const sel = window.getSelection ? String(window.getSelection() || '').trim() : '';
    if (sel && window.getSelection().anchorNode && main.contains(window.getSelection().anchorNode)) return sel.slice(0, 400);
    const recebidas = main.querySelectorAll('.message-in [data-pre-plain-text]');
    const ult = recebidas[recebidas.length - 1];
    if (!ult) return '';
    const quem = (ult.getAttribute('data-pre-plain-text') || '').replace(/^\[[^\]]*\]\s*/, '').trim();
    return `${quem} ${(ult.innerText || '').trim()}`.trim().slice(0, 400);
  }
  btChamado.textContent = '📌 Virar chamado';
  btChamado.style.background = '#e7f3ff';
  btChamado.style.color = '#0b4f8a';
  btChamado.onclick = async () => {
    const c = conversaAberta();
    if (!c || !c.nomeCompleto) { aviso.textContent = 'Abra uma conversa.'; return; }
    const trecho = trechoDaConversa();
    aviso.textContent = 'Gravando…';
    const r = await pedir('chamados', { sinais: [{ conversa: c.nomeCompleto, tipo: 'manual', grupo: c.grupo, trecho }] });
    if (!r.ok) { aviso.textContent = '⚠️ ' + r.erro; return; }
    if (r.dados.ids && r.dados.ids[0]) { memo.nomes[r.dados.ids[0]] = c.nomeCompleto; guardarMemo(); }
    abertos = r.dados.abertos || [];
    filaCarregada = true;
    aviso.textContent = trecho ? 'Virou chamado.' : 'Virou chamado (sem trecho: selecione o texto antes, se quiser).';
    desenharFila();
  };

  setInterval(varrer, 20000);
  setTimeout(varrer, 4000);

  // troca de conversa: confere a cada 2 s se mudou; o estado do servidor, a cada 60 s
  let chaveAnterior = '';
  setInterval(() => {
    const c = conversaAberta();
    const k = chaveDe(c);
    if (k !== chaveAnterior) { chaveAnterior = k; atualizar(); }
  }, 2000);
  setInterval(atualizar, 60000);
  atualizar();
})();
