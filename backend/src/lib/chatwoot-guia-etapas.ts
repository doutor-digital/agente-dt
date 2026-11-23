/**
 * «O que fazer agora» — o guia da ETAPA dentro da conversa do CRM (aprovado pelo João em 14/11/2026).
 *
 * O que aparece: na conversa aberta, logo abaixo de «Informação da conversa» (painel da direita), um cartão com os passos da Etapa em que o
 * paciente está e o botão «▶ Aula X.Y · título · duração», que abre o vídeo da aula num modal POR CIMA da conversa (sem sair do CRM). Trocou a
 * Etapa, o cartão troca sozinho. As caixinhas dos passos são só visuais: não gravam nada em lugar nenhum.
 *
 * Onde mora cada coisa:
 *  - ESTE arquivo guarda o CONTEÚDO (passos, mapa etapa → aula, aulas das telas «?»). Para mudar um texto, muda aqui — o script não é tocado;
 *    ele recebe o conteúdo já pronto, junto com o `menu.js` (`GET /funil/menu.js`, o mesmo arquivo do menu e da assistente).
 *  - O SCRIPT (`GUIA_JS`) roda na página do Chatwoot, no mesmo molde da assistente: monta tudo com textContent (nenhum conteúdo de dado entra como
 *    HTML), guarda o cartão e o modal em Shadow DOM (o CSS do Chatwoot não os atinge, nem o nosso o dele) e nunca fala com o paciente.
 *  - O interruptor é `CHATWOOT_GUIA_ETAPA` (padrão ligado; «0» desliga em até 5 min — o tempo do cache do `menu.js` no navegador —, o cartão e o «?» das telas). Aparece na aba Automações da tela
 *    Robôs como somente leitura.
 *
 * Por que o cartão fica DENTRO do item «Informação da conversa» e não como um item novo da lista do painel: os itens do painel são arrastáveis
 * (a lista é do Sortable/Vue) e um item estranho no meio dela desalinha os índices do arrastar. O cartão entra como segundo filho do EMBRULHO do
 * item (fora da lista que o Sortable enxerga) e o script o recoloca a cada segundo se o Vue reconstruir o painel. Se o painel não existe (barra
 * lateral fechada, outra tela), o cartão simplesmente não aparece — a conversa e a assistente seguem como estão.
 */

/** Os valores do atributo `etapa` das conversas (a definição de atributo do Chatwoot). Teste: o mapa cobre TODAS. */
export const ETAPAS_DO_CRM = ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Agendado', 'Confirmado', 'Compareceu', 'Fechou', 'Pós-consulta', 'Resgate', 'Perdido', 'Frio'] as const;
export type EtapaDoCrm = (typeof ETAPAS_DO_CRM)[number];

/** Sem etapa na conversa (ou etapa que o guia não conhece) vale o guia de «Novo lead». */
export const ETAPA_PADRAO_DO_GUIA: EtapaDoCrm = 'Novo lead';

/** Onde os vídeos moram (um .mp4 por aula). */
export const BASE_DOS_VIDEOS = 'https://treinamento.doutordigitalconsultoria.com/crmdoutordigital-duvidas/videos/';
/** O curso foi para dentro do «kommo-duvidas» (14/11/2026); os vídeos continuam em /crmdoutordigital-duvidas/videos/. */
export const URL_DO_CURSO = 'https://treinamento.doutordigitalconsultoria.com/kommo-duvidas/#crm-01';

export interface AulaDoGuia {
  /** «3.2» */
  num: string;
  titulo: string;
  /** o nome do arquivo, sem .mp4 */
  slug: string;
  /** «1:17» */
  duracao: string;
}

const aula = (num: string, titulo: string, slug: string, duracao: string): AulaDoGuia => ({ num, titulo, slug, duracao });

const A = {
  oQueASofiaFaz: aula('2.1', 'O que a Sofia faz', 'c21-o-que-a-sofia-faz', '1:27'),
  assumirEDevolver: aula('2.2', 'Assumir e devolver para a Sofia', 'c22-assumir-e-devolver', '1:22'),
  marcarConsulta: aula('3.2', 'Marcar a consulta', 'c32-marcar-consulta', '1:17'),
  confirmouFaltou: aula('3.3', 'Confirmou, faltou, remarcou', 'c33-confirmou-faltou', '1:07'),
  compareceuFechou: aula('3.5', 'Compareceu e fechou', 'c35-compareceu-fechou', '1:14'),
  tratamento: aula('3.6', 'O funil do Tratamento', 'c36-tratamento', '1:21'),
  perdido: aula('3.7', 'Perdido', 'c37-perdido', '1:20'),
  resgateFrio: aula('3.8', 'Resgate e Frio', 'c38-resgate-frio', '0:56'),
} as const;

export interface GuiaDaEtapa {
  passos: readonly string[];
  aula: AulaDoGuia;
}

/** O conteúdo de cada etapa: o que a atendente faz agora e a aula que mostra isso. */
export const GUIA_DAS_ETAPAS: Readonly<Record<EtapaDoCrm, GuiaDaEtapa>> = {
  'Novo lead': {
    passos: ['Veja se a Sofia já respondeu (ela atende 24 h)', 'Se o paciente pediu uma pessoa, assuma: Assistente → Pausar IA', 'Responda em até 15 minutos no horário da clínica'],
    aula: A.oQueASofiaFaz,
  },
  'Sofia qualifica': {
    passos: ['A Sofia está conversando: acompanhe sem interromper', 'Se precisar assumir: Assistente → Pausar IA (eu assumo)', 'Quando marcar, confira a data na agenda da franquia'],
    aula: A.assumirEDevolver,
  },
  'Esperando humano': {
    passos: ['É sua agora: o paciente espera uma pessoa', 'Leia a nota da Sofia com o motivo', 'Responda e mude a Etapa conforme o combinado'],
    aula: A.oQueASofiaFaz,
  },
  Agendado: {
    // o robô «Pré-pagamento» (chatwoot-regua.ts) cobra quando «Pagamento antecipado» = Sim e a etiqueta «pagou-antecipado» NÃO está:
    // o campo quer dizer «vai pagar antes», não «já pagou» (23/11: o texto antigo mandava marcar quem já pagou — o robô cobraria de novo)
    // (o robô só dispara até 12 h depois de entrar em Agendado e com a Situação da consulta = Agendado; ele PERGUNTA se quer os dados do Pix — não manda a chave)
    passos: ['Confira Data, Hora (HH:MM) e Situação da consulta', 'Vai pagar antes? Marque «Pagamento antecipado»: o robô pergunta se quer o Pix', 'Pagou? Ponha a etiqueta «pagou-antecipado» e o robô para de cobrar', 'Lembretes saem sozinhos. Combinou tudo? Pode Resolver'],
    aula: A.marcarConsulta,
  },
  Confirmado: {
    passos: ['Situação da consulta: Confirmado', 'Se faltar, mude para «Não compareceu» no mesmo dia', 'Nada a combinar? Resolva'],
    aula: A.confirmouFaltou,
  },
  Compareceu: {
    passos: ['Situação: Atendido', 'Fechou? Etapa Fechou + Valor fechado', 'Não fechou? Pós-consulta + motivo'],
    aula: A.compareceuFechou,
  },
  'Pós-consulta': {
    passos: ['Preencha o «Motivo de não fechar o tratamento»', 'Os robôs mandam o «decidiu?» em 4 e 7 dias', 'Se ele decidir, mude para Fechou com o valor'],
    aula: A.compareceuFechou,
  },
  Fechou: {
    passos: ['Valor fechado (R$) preenchido', 'Funil: Tratamento · Etapa do tratamento: Entrada', 'Preencha o «Programa» para a mensagem de boas-vindas'],
    aula: A.tratamento,
  },
  Resgate: {
    passos: ['Paciente esfriou mas ainda tem chance', 'Mande uma mensagem pronta de retomada', 'Respondeu? Volte para a etapa certa'],
    aula: A.resgateFrio,
  },
  Perdido: {
    passos: ['Escolha o Motivo do não agendamento', 'Antes, 3 ligações em dias diferentes', 'Os robôs tentam de novo em 48, 96 e 120 h'],
    aula: A.perdido,
  },
  Frio: {
    passos: ['Não tem o perfil (não é dor de coluna, curiosidade)', 'Não precisa insistir', 'Pode resolver a conversa'],
    aula: A.resgateFrio,
  },
};

/** O «?» das telas nossas (Funil, Hoje, Oportunidades, Agente): o botão do cabeçalho pede ao menu para abrir esta aula no mesmo modal. */
export const AULAS_DAS_TELAS: Readonly<Record<'funil' | 'hoje' | 'oportunidades' | 'agente', AulaDoGuia>> = {
  funil: aula('4.1', 'O Funil', 'c41-funil', '1:14'),
  hoje: aula('4.2', 'Hoje', 'c42-hoje', '1:13'),
  oportunidades: aula('4.3', 'Oportunidades', 'c43-oportunidades', '0:56'),
  agente: aula('2.4', 'A tela Agente', 'c24-tela-agente', '1:18'),
};

/** Ligado por padrão; só «0» desliga (o mesmo jeito dos outros interruptores do CRM). */
export const guiaDaEtapaLigado = (env: NodeJS.ProcessEnv = process.env): boolean => env.CHATWOOT_GUIA_ETAPA !== '0';

/** O que o script recebe: nada de segredo, nada de paciente — só texto de ensino e endereços públicos de vídeo. */
export function conteudoDoGuia(): {
  base: string;
  curso: string;
  padrao: string;
  etapas: Record<string, { passos: readonly string[]; aula: AulaDoGuia }>;
  telas: Record<string, AulaDoGuia>;
} {
  return { base: BASE_DOS_VIDEOS, curso: URL_DO_CURSO, padrao: ETAPA_PADRAO_DO_GUIA, etapas: { ...GUIA_DAS_ETAPAS }, telas: { ...AULAS_DAS_TELAS } };
}

/**
 * O JavaScript que roda na página do Chatwoot. Sem crase nem interpolação (é `String.raw`); `__AGENTE__` (a origem do servidor, em JSON) e
 * `__GUIA__` (o conteúdo, em JSON) são trocados por quem monta.
 */
const GUIA_JS = String.raw`(function(){
  if (window.top !== window || window.__guiaEtapaDD) return; window.__guiaEtapaDD = 1;
  var AGENTE = __AGENTE__, CFG = __GUIA__;
  var ST = { conversa: null, etapa: undefined, buscando: false, ultimaBusca: 0, host: null, raiz: null, feitos: {} };
  var MD = { host: null, voltarPara: null, paraVideo: true };
  // o modal precisa ficar ACIMA do painel das telas do menu (Hoje, Funil…; z-index 2147483000 em funil.controller.ts), senão o «?» abre o vídeo por baixo da tela
  var Z_CARTAO = 1, Z_MODAL = 2147483200;

  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function contaDaUrl(){ var m = location.pathname.match(/\/accounts\/(\d+)/); return m ? m[1] : null; }
  function conversaDaUrl(){ var m = location.pathname.match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }
  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  var NS = 'http://www.w3.org/2000/svg';
  // ícone de traço no estilo lucide (o CRM usa i-lucide-*): montado com createElementNS, sem HTML
  function icone(formas){
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    formas.forEach(function(f){ var n = document.createElementNS(NS, f[0]); Object.keys(f[1]).forEach(function(k){ n.setAttribute(k, f[1][k]); }); svg.appendChild(n); });
    return svg;
  }
  function iconePlay(){ return icone([['circle', { cx: '12', cy: '12', r: '10' }], ['polygon', { points: '10 8 16 12 10 16 10 8' }]]); }
  function iconeX(){ return icone([['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]]); }

  // ── estilos: a mesma fonte, as mesmas cores (variáveis do próprio Chatwoot, que viram sozinhas no modo escuro), o mesmo contorno e raio
  // das outras seções do painel. Dentro do Shadow DOM: o CSS do Chatwoot não entra e o nosso não vaza.
  var FONTE = 'Inter,-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Tahoma,Arial,sans-serif';
  var CSS_CARTAO = ':host{display:block;margin:12px 0 0;font:400 14px/20px ' + FONTE + ';color:rgb(var(--slate-12,28 32 36))}'
    + '*{box-sizing:border-box}'
    + '.cab{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px;background:rgb(var(--slate-2,249 249 251));outline:1px solid rgb(var(--border-weak,234 234 234));border-radius:8px 8px 0 0}'
    + '.cab h5{margin:0;font:500 14px/20px ' + FONTE + ';color:rgb(var(--slate-12,28 32 36))}'
    + '.cab small{font-size:12px;line-height:16px;color:rgb(var(--slate-11,96 100 108));text-align:right}'
    + '.corpo{margin-top:1px;outline:1px solid rgb(var(--border-weak,234 234 234));border-radius:0 0 8px 8px;background:rgb(var(--surface-1,254 254 254));overflow:hidden}'
    + '.passo{display:flex;gap:8px;align-items:flex-start;margin:0;padding:8px 16px;border-bottom:1px solid rgb(var(--border-weak,234 234 234) / .5);cursor:pointer}'
    + '.passo input{flex:none;width:14px;height:14px;margin:3px 0 0;accent-color:rgb(var(--blue-9,39 129 246))}'
    + '.passo span{font-size:14px;line-height:20px}'
    + '.passo.feito span{color:rgb(var(--slate-11,96 100 108));text-decoration:line-through}'
    + '.aula{display:flex;align-items:center;gap:8px;width:100%;margin:0;padding:8px 16px;border:0;border-bottom:1px solid rgb(var(--border-weak,234 234 234) / .5);background:transparent;color:rgb(var(--slate-12,28 32 36));font:400 14px/20px ' + FONTE + ';text-align:left;cursor:pointer}'
    + '.aula:hover{background:rgb(var(--slate-9,139 141 152) / .1)}'
    + '.aula svg{flex:none;color:rgb(var(--slate-11,96 100 108))}'
    + '.aula .t{flex:1;min-width:0}.aula .d{flex:none;font-size:12px;color:rgb(var(--slate-11,96 100 108))}'
    + '.mais{padding:8px 16px}.mais a{font-size:13px;line-height:20px;color:rgb(var(--blue-11,8 109 224));text-decoration:none}.mais a:hover{text-decoration:underline}'
    + 'input:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid rgb(var(--blue-9,39 129 246));outline-offset:-2px}';
  var CSS_MODAL = ':host{all:initial}*{box-sizing:border-box}'
    + '.veu{position:fixed;inset:0;display:grid;place-items:center;padding:16px;background:rgb(0 0 0 / .5);font:400 14px/20px ' + FONTE + '}'
    + '.modal{width:min(860px,100%);overflow:hidden;border-radius:12px;background:rgb(var(--surface-2,255 255 255));color:rgb(var(--slate-12,28 32 36));outline:1px solid rgb(var(--border-weak,234 234 234));box-shadow:0 8px 32px rgb(0 0 0 / .25)}'
    + '.mcab{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid rgb(var(--border-weak,234 234 234))}'
    + '.mcab h5{flex:1;margin:0;font:500 14px/20px ' + FONTE + '}'
    + '.fechar{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:rgb(var(--slate-11,96 100 108));cursor:pointer}'
    + '.fechar:hover{background:rgb(var(--slate-9,139 141 152) / .1)}'
    + 'video{display:block;width:100%;max-height:70vh;background:#000}'
    + '.erro{padding:24px;text-align:center}.erro a{color:rgb(var(--blue-11,8 109 224))}'
    + 'button:focus-visible,a:focus-visible{outline:2px solid rgb(var(--blue-9,39 129 246));outline-offset:2px}';

  // ── o modal do vídeo (por cima da conversa; Esc, o X e o clique fora fecham) ───────────────────────────────────────
  function fecharModal(){
    if (!MD.host) return;
    try { var v = MD.host.shadowRoot && MD.host.shadowRoot.querySelector('video'); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } } catch (e) {}
    MD.host.remove(); MD.host = null;
    document.removeEventListener('keydown', teclaDoModal, true);
    var volta = MD.voltarPara; MD.voltarPara = null;
    try { if (volta && volta.isConnected) volta.focus(); } catch (e) {}
  }
  function teclaDoModal(ev){
    if (ev.key === 'Escape' || ev.key === 'Esc') { ev.stopImmediatePropagation(); ev.preventDefault(); fecharModal(); return; }
    // o modal é «modal» de verdade: o Tab não escapa para a conversa por baixo (alterna entre o botão de fechar e o vídeo)
    if (ev.key === 'Tab' && MD.host) {
      ev.preventDefault();
      var r = MD.host.shadowRoot, alvo = MD.paraVideo ? r.querySelector('video') : r.querySelector('.fechar');
      MD.paraVideo = !MD.paraVideo;
      try { if (alvo) alvo.focus(); } catch (e) {}
    }
  }
  function abrirAula(a, origem){
    if (!a || typeof a.slug !== 'string' || !/^[a-z0-9-]+$/.test(a.slug)) return;
    fecharModal();
    MD.voltarPara = origem || null; MD.paraVideo = true;
    var host = el('div'); host.setAttribute('data-guia-modal', '1');
    host.style.cssText = 'position:fixed;inset:0;z-index:' + Z_MODAL;
    var raiz = host.attachShadow({ mode: 'open' });
    var st = el('style'); st.textContent = CSS_MODAL; raiz.appendChild(st);
    var cx = el('div');
    var veu = el('div', 'veu'), modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Aula ' + a.num + ': ' + a.titulo);
    var cab = el('div', 'mcab'); cab.appendChild(el('h5', null, 'Aula ' + a.num + ' · ' + a.titulo));
    var fechar = el('button', 'fechar'); fechar.type = 'button'; fechar.title = 'Fechar'; fechar.setAttribute('aria-label', 'Fechar o vídeo'); fechar.appendChild(iconeX()); cab.appendChild(fechar); modal.appendChild(cab);
    var url = CFG.base + a.slug + '.mp4';
    var v = el('video'); v.controls = true; v.autoplay = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.src = url;
    v.addEventListener('error', function(){
      var e = el('div', 'erro'); e.appendChild(el('p', null, 'Não consegui abrir o vídeo aqui.'));
      var l = el('a', null, 'Abrir o vídeo em outra aba'); l.href = url; l.target = '_blank'; l.rel = 'noopener'; e.appendChild(l);
      if (v.parentNode) v.parentNode.replaceChild(e, v);
    });
    modal.appendChild(v);
    veu.appendChild(modal); cx.appendChild(veu); raiz.appendChild(cx);
    fechar.addEventListener('click', fecharModal);
    veu.addEventListener('mousedown', function(ev){ if (ev.target === veu) fecharModal(); });
    document.body.appendChild(host); MD.host = host;
    document.addEventListener('keydown', teclaDoModal, true);
    try { fechar.focus(); } catch (e) {}
  }

  // ── o cartão «O que fazer agora» ──────────────────────────────────────────────────────────────────────────────────
  function guiaDaEtapa(etapa){
    var e = String(etapa || '').trim();
    var g = CFG.etapas[e];
    if (g) return { g: g, rotulo: e };
    return { g: CFG.etapas[CFG.padrao], rotulo: e ? e + ' · guia geral' : 'Sem etapa' };
  }
  function desenhar(){
    if (!ST.raiz) return;
    var r = ST.raiz; r.textContent = '';
    var st = el('style'); st.textContent = CSS_CARTAO; r.appendChild(st);
    var d = guiaDaEtapa(ST.etapa);
    var chave = ST.conversa + '|' + String(ST.etapa || '');
    var feitos = ST.feitos[chave] || (ST.feitos[chave] = {});
    var cx = el('div'); cx.setAttribute('aria-live', 'polite');
    var cab = el('div', 'cab'); cab.appendChild(el('h5', null, 'O que fazer agora')); cab.appendChild(el('small', null, d.rotulo)); cx.appendChild(cab);
    var corpo = el('div', 'corpo');
    d.g.passos.forEach(function(p, i){
      var l = el('label', 'passo' + (feitos[i] ? ' feito' : '')); var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!feitos[i];
      cb.addEventListener('change', function(){ feitos[i] = cb.checked; l.className = 'passo' + (cb.checked ? ' feito' : ''); });
      l.appendChild(cb); l.appendChild(el('span', null, p)); corpo.appendChild(l);
    });
    var a = d.g.aula;
    var b = el('button', 'aula'); b.type = 'button'; b.setAttribute('aria-label', 'Ver a aula ' + a.num + ': ' + a.titulo + ' (' + a.duracao + ')');
    b.appendChild(iconePlay()); b.appendChild(el('span', 't', 'Aula ' + a.num + ' · ' + a.titulo)); b.appendChild(el('span', 'd', a.duracao));
    b.addEventListener('click', function(){ abrirAula(a, b); });
    corpo.appendChild(b);
    var mais = el('div', 'mais'); var ln = el('a', null, 'Ver o curso inteiro'); ln.href = CFG.curso; ln.target = '_blank'; ln.rel = 'noopener'; mais.appendChild(ln); corpo.appendChild(mais);
    cx.appendChild(corpo); r.appendChild(cx);
  }

  // O item «Informação da conversa» do painel da direita. O cartão entra como 2º filho do embrulho do item (fora da lista arrastável).
  function embrulhoDaInformacao(){
    var bs = document.querySelectorAll('.list-group button');
    for (var i = 0; i < bs.length; i++) {
      if (/Informação da conversa|Conversation Information/i.test(bs[i].textContent || '')) {
        var sec = bs[i].closest('.text-sm'); if (sec && sec.parentElement) return sec.parentElement;
      }
    }
    return null;
  }
  function tirarCartao(){ if (ST.host) { ST.host.remove(); ST.host = null; ST.raiz = null; } }
  function garantirCartao(){
    var emb = embrulhoDaInformacao();
    if (!emb) { tirarCartao(); return; }
    if (!ST.host) {
      ST.host = el('div'); ST.host.setAttribute('data-guia-etapa', '1'); ST.host.style.cssText = 'position:relative;z-index:' + Z_CARTAO;
      ST.raiz = ST.host.attachShadow({ mode: 'open' });
    }
    if (ST.host.parentElement !== emb) emb.appendChild(ST.host);
    if (!ST.raiz.firstChild) desenhar();
  }

  // ── a etapa da conversa aberta (a cada poucos segundos e logo depois de um clique no painel) ──────────────────────
  function buscarEtapa(){
    var s = sessao(), conta = contaDaUrl(), c = ST.conversa;
    if (!s || !conta || !c || ST.buscando) return;
    ST.buscando = true; ST.ultimaBusca = Date.now();
    fetch('/api/v1/accounts/' + conta + '/conversations/' + c, { headers: { 'access-token': s.token, client: s.client, uid: s.uid } })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){
        if (ST.conversa !== c) return;
        var etapa = String(((j && j.custom_attributes) || {}).etapa || '').trim();
        if (etapa !== ST.etapa) { ST.etapa = etapa; garantirCartao(); desenhar(); }
      })
      .catch(function(){})
      .then(function(){ ST.buscando = false; });
  }
  function logoDepois(ms){ setTimeout(function(){ ST.ultimaBusca = 0; }, ms); }
  document.addEventListener('click', function(ev){
    var t = ev.target; if (!t || !t.closest || !t.closest('.list-group, [role="listbox"], [role="option"]')) return;
    logoDepois(900); logoDepois(2800);
  }, true);

  // ── o «?» das telas nossas pede a aula pelo menu (as telas rodam em iframe do nosso servidor) ─────────────────────
  window.addEventListener('message', function(ev){
    if (ev.origin !== AGENTE) return;
    var d = ev.data; if (!d || d.event !== 'guia:tela' || typeof d.tela !== 'string') return;
    if (Object.prototype.hasOwnProperty.call(CFG.telas, d.tela)) abrirAula(CFG.telas[d.tela], null);
  });

  setInterval(function(){
    var logada = !!sessao() && /\/app\/accounts\//.test(location.pathname);
    var c = logada ? conversaDaUrl() : null;
    if (!c) { tirarCartao(); ST.conversa = null; ST.etapa = undefined; return; }
    if (c !== ST.conversa) { ST.conversa = c; ST.etapa = undefined; ST.ultimaBusca = 0; ST.feitos = {}; tirarCartao(); }
    if (ST.etapa !== undefined) garantirCartao();
    if (document.visibilityState === 'visible' && Date.now() - ST.ultimaBusca >= 4000) buscarEtapa();
  }, 1000);
})();`;

/** O JavaScript do guia, pronto para ir no `menu.js`; vazio quando `CHATWOOT_GUIA_ETAPA=0`. `agenteJson` = a origem do servidor em JSON. */
export function guiaJs(agenteJson: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!guiaDaEtapaLigado(env)) return '';
  return GUIA_JS.split('__AGENTE__').join(agenteJson).split('__GUIA__').join(JSON.stringify(conteudoDoGuia()));
}
