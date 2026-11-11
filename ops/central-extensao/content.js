// Central do João — painel no canto do WhatsApp Web. Lê SÓ o número e o nome da conversa aberta (nenhuma mensagem sai daqui).
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
    return { nome: nome.slice(0, 60), numero, grupo };
  }

  // ── painel ──────────────────────────────────────────────────────────────────────────────────
  const caixa = document.createElement('div');
  caixa.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;background:#fff;color:#111b21;border:1px solid #d1d7db;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.15);font:13px/1.35 system-ui,sans-serif;width:260px;padding:10px 12px';
  const topo = document.createElement('div');
  topo.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:6px;cursor:pointer';
  topo.textContent = 'Agente 9103';
  const seta = document.createElement('span'); seta.textContent = '–'; topo.appendChild(seta);
  const corpo = document.createElement('div');
  const linhaGeral = document.createElement('div');
  const btGeral = document.createElement('button');
  const linhaPessoa = document.createElement('div');
  const btPessoa = document.createElement('button');
  const aviso = document.createElement('div');
  aviso.style.cssText = 'color:#667781;font-size:12px;margin-top:6px;min-height:14px';
  for (const b of [btGeral, btPessoa]) b.style.cssText = 'display:block;width:100%;margin:4px 0 8px;padding:6px;border:0;border-radius:6px;cursor:pointer;font:600 13px system-ui,sans-serif';
  corpo.append(linhaGeral, btGeral, linhaPessoa, btPessoa, aviso);
  caixa.append(topo, corpo);
  let aberto = true;
  topo.onclick = () => { aberto = !aberto; corpo.style.display = aberto ? '' : 'none'; seta.textContent = aberto ? '–' : '+'; };
  document.body.appendChild(caixa);

  const cor = (b, pausar) => { b.style.background = pausar ? '#f15c6d' : '#00a884'; b.style.color = '#fff'; };
  let estado = null, atual = null, ocupado = false;

  async function atualizar() {
    if (ocupado) return;
    atual = conversaAberta();
    const r = await pedir('estado', { numero: atual && atual.numero ? atual.numero : undefined });
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
  btPessoa.onclick = () => estado && estado.pessoa && atual && atual.numero && agir('pessoa', { numero: atual.numero, nome: atual.nome, pausar: !estado.pessoa.pausada });

  // troca de conversa: confere a cada 2 s se mudou; o estado do servidor, a cada 60 s
  let chaveAnterior = '';
  setInterval(() => {
    const c = conversaAberta();
    const k = c ? `${c.numero}|${c.grupo}|${c.nome}` : '';
    if (k !== chaveAnterior) { chaveAnterior = k; atualizar(); }
  }, 2000);
  setInterval(atualizar, 60000);
  atualizar();
})();
