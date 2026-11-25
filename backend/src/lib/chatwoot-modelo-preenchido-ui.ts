/**
 * «Modelo do WhatsApp com os parâmetros PREENCHIDOS» no CRM (Chatwoot) — pedido do João, 25/11/2026. Quando a atendente manda um MODELO à mão (o seletor de modelos do
 * Chatwoot na conversa), as caixinhas de {{1}}, {{2}}… já vêm sugeridas. Ela pode editar, apagar e escrever à mão. O script NUNCA envia, nunca aperta botão: só preenche.
 *
 * Como funciona (estrutura conferida no Chatwoot 4.19.1 real):
 *  - o formulário do modelo é o componente `WhatsAppTemplateParser`: um `h3` com o NOME do modelo, a prévia do corpo (`div.whitespace-pre-wrap`, com {{n}} cru enquanto as caixinhas
 *    estão vazias) e, abaixo, um `input[type=text]` por parâmetro com o placeholder «Insira o valor para <n>» (o texto vem de `$t('WHATSAPP_TEMPLATES.PARSER.VARIABLE_PLACEHOLDER')`);
 *  - o script acha o formulário pelos inputs com esse placeholder, lê o nome do modelo e o corpo (prévia, antes de preencher), pergunta ao SERVIDOR
 *    (`POST /api/public/assistente/modelo-preenchido`, com o login da PRÓPRIA pessoa, como a assistente) e preenche só os inputs VAZIOS que a pessoa não tocou
 *    (valor + evento `input`, que é o que atualiza o estado do Vue e a prévia);
 *  - o que ela já digitou nunca é sobrescrito (a resposta pode demorar: vale o estado de CADA caixinha no momento de preencher);
 *  - dica discreta: um atributo `data-dd-preenchido` nas caixinhas e na linha «Variáveis»; o texto «✨ preenchido pelo CRM — confira» é o `::after` do CSS (nenhum nó novo dentro do que o Vue controla).
 *    Se ela edita uma caixinha, a marca dela sai; quando nenhuma tem marca, a dica sai.
 *
 * Quem decide os valores é o servidor (`modelo-preenchido.ts`): modelo do CRM = a MESMA regra da régua; modelo de fora = lido pelo texto (saudação → primeiro nome; «Data e horário:» → a próxima
 * consulta); sem dado, vazio. Valem as contas todas (a conta vem da URL).
 *
 * Chave: `CHATWOOT_MODELO_PREENCHIDO=0` tira o bloco do `menu.js` (vale em até 5 min, o cache do navegador) e o servidor passa a responder vazio. Padrão: ligado.
 * Bloco INDEPENDENTE dentro do `menu.js` (`;try{ … }catch(e){}`): se falhar ao executar, o resto do menu segue.
 */

export const modeloPreenchidoLigado = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_MODELO_PREENCHIDO ?? '').trim() !== '0';

// String.raw: o que está aqui é o JavaScript que o navegador recebe. Sem crases nem «${» aqui dentro.
const MODELO_JS = String.raw`(function(){
  if (window.top !== window || window.__modeloPreenchidoDD) return; window.__modeloPreenchidoDD = 1;
  var AGENTE = __AGENTE__, ATTR = 'data-dd-preenchido', ESTILO = 'data-dd-preenchido-estilo', espera = null;
  var estado = new WeakMap(), tocadas = new WeakSet();

  function css(){
    return 'input[' + ATTR + ']{box-shadow:inset 0 0 0 1px rgba(124,58,237,.6)!important}'
      + 'p[' + ATTR + ']::after{content:" ✨ preenchido pelo CRM — confira";font-weight:500;font-size:12px;color:#6d28d9;margin-left:6px}'
      + '.dark p[' + ATTR + ']::after{color:#c4b5fd}.dark input[' + ATTR + ']{box-shadow:inset 0 0 0 1px rgba(167,139,250,.65)!important}';
  }
  function garantirEstilo(){
    if (document.querySelector('style[' + ESTILO + ']')) return;
    var st = document.createElement('style'); st.setAttribute(ESTILO, '1'); st.textContent = css();
    (document.head || document.documentElement).appendChild(st);
  }

  function sessao(){
    var m = document.cookie.match(/(?:^|; )cw_d_session_info=([^;]*)/); if (!m) return null;
    try { var j = JSON.parse(decodeURIComponent(m[1])); return j['access-token'] && j.client && j.uid ? { token: j['access-token'], client: j.client, uid: j.uid } : null; } catch (e) { return null; }
  }
  function contaDaUrl(){ var m = String(location.pathname).match(/\/accounts\/(\d+)/); return m ? m[1] : null; }
  function conversaDaUrl(){ var m = String(location.pathname).match(/\/conversations\/(\d+)/); return m ? Number(m[1]) : null; }

  // «Insira o valor para {variable}» (o texto da língua da pessoa): o que vem antes e depois da variável, para tirar a CHAVE do placeholder
  var moldeGuardado = null; // só guarda o que veio do $t (o app ainda pode não ter carregado a língua)
  function moldeDoPlaceholder(){
    if (moldeGuardado) return moldeGuardado;
    try {
      var app = document.getElementById('app'), g = app && app.__vue_app__ && app.__vue_app__.config.globalProperties;
      if (g && typeof g.$t === 'function') { var t = String(g.$t('WHATSAPP_TEMPLATES.PARSER.VARIABLE_PLACEHOLDER', { variable: '\u0001' })); var i = t.indexOf('\u0001'); if (i >= 0) return (moldeGuardado = { antes: t.slice(0, i), depois: t.slice(i + 1) }); }
    } catch (e) {}
    return { antes: '', depois: '' };
  }
  function chaveDoInput(inp, molde){
    var p = String(inp.getAttribute('placeholder') || '');
    if (!molde.antes && !molde.depois) { var m = p.match(/(\S+)\s*$/); return m ? m[1] : null; }
    if (p.indexOf(molde.antes) !== 0 || (molde.depois && p.lastIndexOf(molde.depois) !== p.length - molde.depois.length)) return null;
    var c = p.slice(molde.antes.length, molde.depois ? p.length - molde.depois.length : p.length).trim();
    return c && c.length <= 40 ? c : null;
  }

  // o formulário do modelo: o menor ancestral das caixinhas que tem o h3 com o nome do modelo
  function formularios(){
    var molde = moldeDoPlaceholder(), achados = [], vistos = [];
    var inputs = document.querySelectorAll('input[type="text"][placeholder]');
    for (var i = 0; i < inputs.length; i++) {
      var chave = chaveDoInput(inputs[i], molde); if (!chave) continue;
      var raiz = inputs[i].parentNode, h3 = null;
      for (var n = 0; n < 12 && raiz && !h3; n++) { h3 = raiz.querySelector && raiz.querySelector('h3'); if (!h3) raiz = raiz.parentNode; }
      if (!h3 || !raiz) continue;
      var nome = String(h3.textContent || '').trim();
      if (!/^[a-z0-9_]{1,200}$/.test(nome)) continue;
      var idx = vistos.indexOf(raiz);
      if (idx < 0) { vistos.push(raiz); achados.push({ raiz: raiz, nome: nome, caixas: [] }); idx = achados.length - 1; }
      achados[idx].caixas.push({ chave: chave, input: inputs[i] });
    }
    return achados;
  }
  // o corpo do modelo, como a prévia mostra (com {{n}} cru enquanto as caixinhas estão vazias): o ÚLTIMO bloco de texto com quebra de linha do formulário
  function corpoDaPrevia(raiz){
    var blocos = raiz.querySelectorAll('div[class*="whitespace-pre-wrap"]'), t = '';
    for (var i = 0; i < blocos.length; i++) if (!blocos[i].querySelector('input')) t = String(blocos[i].textContent || '');
    return t.slice(0, 4000);
  }
  function linhaDaDica(caixas){
    var pai = caixas[0] && caixas[0].input.parentNode && caixas[0].input.parentNode.parentNode && caixas[0].input.parentNode.parentNode.parentNode;
    return pai && pai.querySelector ? pai.querySelector('p') : null;
  }
  function limparMarcas(f){
    for (var i = 0; i < f.caixas.length; i++) f.caixas[i].input.removeAttribute(ATTR);
    var p = linhaDaDica(f.caixas); if (p) p.removeAttribute(ATTR);
  }

  function preencher(f, valores){
    var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set, algum = false;
    for (var i = 0; i < f.caixas.length; i++) {
      var c = f.caixas[i], v = valores[c.chave];
      // só a caixinha VAZIA que a pessoa não tocou; a resposta pode ter chegado depois de ela digitar
      if (typeof v !== 'string' || !v || c.input.value !== '' || tocadas.has(c.input) || !document.body.contains(c.input)) continue;
      set.call(c.input, v);
      c.input.dispatchEvent(new Event('input', { bubbles: true })); // é o que atualiza o estado do Vue (e a prévia)
      c.input.setAttribute(ATTR, '1'); algum = true;
    }
    if (algum) { var p = linhaDaDica(f.caixas); if (p) p.setAttribute(ATTR, '1'); }
  }

  function pedir(f, st, conversa, s){
    var conta = contaDaUrl();
    fetch(AGENTE + '/api/public/assistente/modelo-preenchido' + (conta ? '?conta=' + conta : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CW-Token': s.token, 'X-CW-Client': s.client, 'X-CW-Uid': s.uid },
      body: JSON.stringify({ conversa: conversa, modelo: f.nome, corpo: st.corpo })
    }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      if (!j || !j.valores || estado.get(f.caixas[0].input) !== st) return; // outro modelo (ou outra conversa) apareceu enquanto esperava: esta resposta não vale
      garantirEstilo(); preencher(f, j.valores);
    }).catch(function(){});
  }

  function passar(){
    espera = null;
    // SAI CEDO quando o seletor de modelos não está aberto (a página muda o tempo todo): uma busca só, pelo começo do placeholder dos parâmetros
    var molde = moldeDoPlaceholder();
    if (molde.antes && !document.querySelector('input[type="text"][placeholder^="' + molde.antes.replace(/"/g, '\\"') + '"]')) return;
    var conversa = conversaDaUrl(), s = conversa ? sessao() : null; if (!conversa || !s) return;
    var fs = formularios();
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i], marca = f.caixas[0].input, st = estado.get(marca);
      if (st && st.nome === f.nome && st.conversa === conversa) continue; // este formulário já foi atendido
      if (st) limparMarcas(f); // o mesmo formulário passou a ser de OUTRO modelo (o Vue reaproveita as caixinhas): tira as marcas velhas
      st = { nome: f.nome, conversa: conversa, corpo: corpoDaPrevia(f.raiz) };
      estado.set(marca, st);
      pedir(f, st, conversa, s);
    }
  }
  // a pessoa digitou (evento de verdade, não o nosso): essa caixinha é DELA; sem caixinha marcada, a dica sai
  document.addEventListener('input', function(e){
    var t = e.target; if (!e.isTrusted || !t || t.tagName !== 'INPUT') return;
    tocadas.add(t);
    if (!t.hasAttribute(ATTR)) return;
    t.removeAttribute(ATTR);
    var f = formularios().filter(function(x){ return x.caixas.some(function(c){ return c.input === t; }); })[0];
    if (f && !f.caixas.some(function(c){ return c.input.hasAttribute(ATTR); })) { var p = linhaDaDica(f.caixas); if (p) p.removeAttribute(ATTR); }
  }, true);

  // freio curto: o formulário aparece e a pessoa ainda não digitou; o Vue mexe muito na tela
  function agendar(){ if (!espera) espera = setTimeout(passar, 150); }
  new MutationObserver(agendar).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', agendar);
  agendar();
})();`;

/** O JavaScript do bloco, pronto para ir no `menu.js`; vazio quando `CHATWOOT_MODELO_PREENCHIDO=0`. */
export function modeloPreenchidoJs(agente: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!modeloPreenchidoLigado(env)) return '';
  return MODELO_JS.split('__AGENTE__').join(JSON.stringify(agente));
}
