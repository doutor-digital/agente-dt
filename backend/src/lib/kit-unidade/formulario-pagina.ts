/**
 * A página do formulário «nova clínica» (`/nova-clinica/<codigo>`): HTML + CSS + JS num texto só, sem arquivo estático, no molde das páginas /pausa e /aprendizados.
 *
 * Celular primeiro (pensada para 360 px de largura), claro e escuro (segue o aparelho), linguagem de dono de clínica: nenhum jargão do kit (nada de WABA, slug, token).
 * NUNCA pede segredo. Os campos [IMPORTANTE] — que viram frase dita ao paciente — levam a etiqueta «vira frase dita ao paciente — confira».
 *
 * O código do link NÃO aparece no HTML: o script lê o próprio endereço da página para chamar a API. O script é inline com `nonce` (a política de segurança
 * do conteúdo, mandada pelo controlador, só aceita ele).
 */

const ESTILO = `
:root{color-scheme:light dark;--bg:#F4F5F8;--card:#fff;--ink:#14161F;--ink2:#444857;--muted:#6B6F80;--line:#D9DCE6;--field:#fff;--acc:#2F5BEA;--acc-ink:#fff;--ok:#0B7A3E;--okbg:#E4F6EB;--err:#B3261E;--errbg:#FCE9E8;--warn:#7A5300;--warnbg:#FFF3D6}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B11;--card:#14141C;--ink:#F5F5F7;--ink2:#C7C8D1;--muted:#9A9CA8;--line:#2A2A36;--field:#1C1C26;--acc:#6C8CFF;--acc-ink:#0B0B11;--ok:#7DE0A6;--okbg:#10301F;--err:#FFB3B9;--errbg:#3A1519;--warn:#F2D27A;--warnbg:#3A2F10}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px 12px 96px}
main{max-width:560px;margin:0 auto}
.marca{font-size:13px;color:var(--muted);margin:4px 2px 0;letter-spacing:.02em}
h1{font-size:23px;line-height:1.2;margin:4px 2px 6px}
.lead{color:var(--ink2);margin:0 2px 14px;font-size:15px}
.aviso{background:var(--warnbg);color:var(--warn);border-radius:12px;padding:10px 12px;font-size:14px;margin:0 0 14px}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin:0 0 14px}
section>h2{font-size:17px;margin:0 0 2px;display:flex;gap:8px;align-items:center}
section>h2 .n{flex:none;width:24px;height:24px;border-radius:50%;background:var(--acc);color:var(--acc-ink);font-size:13px;display:grid;place-items:center}
.dica-sec{color:var(--muted);font-size:14px;margin:2px 0 6px}
.campo{margin-top:14px}
.linha .campo{margin:0}
label,.rotulo{display:block;font-weight:600;font-size:15px;margin:0 0 4px}
.ajuda{display:block;color:var(--muted);font-size:13.5px;margin:0 0 6px}
.tag{display:inline-block;background:var(--warnbg);color:var(--warn);border-radius:8px;padding:2px 8px;font-size:12.5px;font-weight:600;margin:0 0 6px}
input[type=text],input[type=email],input[type=tel],input[type=url],input[type=time],select,textarea{width:100%;min-height:46px;background:var(--field);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:inherit;font-size:16px}
textarea{min-height:76px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:3px solid color-mix(in srgb,var(--acc) 45%,transparent);border-color:var(--acc)}
.duas{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dias{display:flex;flex-wrap:wrap;gap:8px}
.dias label,.opcao{display:flex;align-items:center;gap:8px;min-height:44px;border:1px solid var(--line);border-radius:12px;padding:8px 12px;font-weight:500;background:var(--field);cursor:pointer;margin:0}
.dias label{min-width:62px;justify-content:center}
.dias input,.opcao input{width:20px;height:20px;accent-color:var(--acc);flex:none}
.opcoes{display:grid;gap:8px}
.opcao{align-items:flex-start;line-height:1.35}
.opcao input{margin-top:1px}
.linha{border:1px dashed var(--line);border-radius:12px;padding:10px;margin-top:10px;display:grid;gap:8px}
button{font:inherit;font-size:16px;min-height:46px;border-radius:12px;border:1px solid var(--line);background:var(--field);color:var(--ink);padding:10px 14px;cursor:pointer}
button.mais{margin-top:10px;width:100%;border-style:dashed}
button.tirar{justify-self:end;min-height:38px;padding:4px 12px;font-size:14px;color:var(--err)}
.enviar{position:sticky;bottom:0;margin:0 -12px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:linear-gradient(transparent,var(--bg) 28%)}
.enviar button{width:100%;background:var(--acc);color:var(--acc-ink);border:0;font-weight:700;min-height:52px}
.enviar button:disabled{opacity:.6}
.erro-campo{color:var(--err);font-size:14px;margin-top:4px;font-weight:600}
.tem-erro input,.tem-erro select,.tem-erro textarea{border-color:var(--err)}
.resumo-erro{background:var(--errbg);color:var(--err);border-radius:12px;padding:10px 12px;margin:0 0 14px;font-weight:600}
.pronto{text-align:center;padding:28px 8px}
.pronto .ok{width:64px;height:64px;border-radius:50%;background:var(--okbg);color:var(--ok);display:grid;place-items:center;font-size:34px;margin:0 auto 12px}
.pronto h2{margin:0 0 8px;justify-content:center}
.pronto p{color:var(--ink2);margin:6px 0}
[hidden]{display:none!important}
.rodape{color:var(--muted);font-size:13px;margin:16px 2px 0}
`;

const IMPORTANTE = '<span class="tag">vira frase dita ao paciente — confira</span>';

const DIAS = [['1', 'Seg'], ['2', 'Ter'], ['3', 'Qua'], ['4', 'Qui'], ['5', 'Sex'], ['6', 'Sáb'], ['0', 'Dom']];
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

const campo = (id: string, rotulo: string, ajuda: string, entrada: string, importante = false) =>
  `<div class="campo" data-c="${id}"><label for="${id}">${rotulo}</label>${importante ? IMPORTANTE : ''}${ajuda ? `<span class="ajuda" id="${id}-a">${ajuda}</span>` : ''}${entrada}<div class="erro-campo" role="alert" hidden></div></div>`;
const texto = (id: string, extra = '') => `<input type="text" id="${id}" data-p="${id.replace(/^f-/, '').replace(/-/g, '.')}" ${extra}>`;

function corpo(): string {
  return `
<p class="marca">Doutor Digital</p>
<h1>Cadastro da sua clínica</h1>
<div id="intro"><p class="lead">Preencha com calma, leva uns 10 minutos. Com isso a gente monta o seu sistema de atendimento. Tudo o que você escrever aqui <b>a assistente vai usar para falar com seus pacientes</b>, então confira antes de enviar.</p>
<div class="aviso"><b>Nunca</b> escreva senha, token ou código de acesso aqui. A gente não pede isso, e você não precisa mandar.</div></div>
<div id="resumo-erro" class="resumo-erro" role="alert" hidden></div>

<form id="form" novalidate autocomplete="on">

<section><h2><span class="n">1</span>Sobre você</h2>
${campo('f-quem-nome', 'Seu nome', '', texto('f-quem-nome', 'autocomplete="name" maxlength="80"'))}
${campo('f-quem-contato', 'Seu WhatsApp ou e-mail', 'Só para a gente falar com você se faltar alguma informação.', texto('f-quem-contato', 'autocomplete="email" maxlength="120"'))}
</section>

<section><h2><span class="n">2</span>Sobre a clínica</h2>
${campo('f-clinica-nome', 'Nome da clínica', 'Como o paciente conhece. Por exemplo: Doutor Hérnia Parauapebas.', texto('f-clinica-nome', 'maxlength="80"'), true)}
<div class="duas">
${campo('f-clinica-cidade', 'Cidade', '', texto('f-clinica-cidade', 'maxlength="60"'))}
${campo('f-clinica-uf', 'Estado', '', `<select id="f-clinica-uf" data-p="clinica.uf"><option value="">Escolha</option>${UFS.map((u) => `<option>${u}</option>`).join('')}</select>`)}
</div>
${campo('f-clinica-endereco', 'Endereço completo', 'Rua, número, sala, bairro, cidade e CEP. O paciente recebe exatamente isto.', '<textarea id="f-clinica-endereco" data-p="clinica.endereco" maxlength="200" autocomplete="street-address"></textarea>', true)}
${campo('f-clinica-mapa_url', 'Link do mapa (Google Maps)', 'No Google Maps, procure a clínica, toque em <b>Compartilhar</b> e copie o link. Começa com https://.', '<input type="url" id="f-clinica-mapa_url" data-p="clinica.mapa_url" inputmode="url" maxlength="300" placeholder="https://">', true)}
${campo('f-clinica-telefone', 'Telefone da clínica (opcional)', 'Com DDD.', '<input type="tel" id="f-clinica-telefone" data-p="clinica.telefone" autocomplete="tel" maxlength="20">')}
</section>

<section><h2><span class="n">3</span>Horários de atendimento</h2>
<p class="dica-sec">A assistente só oferece horário dentro do que você marcar aqui.</p>
${IMPORTANTE}
<div class="campo" data-c="f-horarios-dias"><span class="rotulo">Dias em que a clínica atende</span>
<div class="dias" id="f-horarios-dias" data-p="horarios.dias">${DIAS.map(([v, n]) => `<label><input type="checkbox" value="${v}" ${['1', '2', '3', '4', '5'].includes(v) ? 'checked' : ''}>${n}</label>`).join('')}</div>
<div class="erro-campo" role="alert" hidden></div></div>
<div class="duas">
${campo('f-horarios-inicio', 'Começa às', '', '<input type="time" id="f-horarios-inicio" data-p="horarios.inicio" value="08:00">')}
${campo('f-horarios-fim', 'Termina às', '', '<input type="time" id="f-horarios-fim" data-p="horarios.fim" value="18:00">')}
</div>
<div class="duas">
${campo('f-horarios-almoco_inicio', 'Almoço começa (opcional)', '', '<input type="time" id="f-horarios-almoco_inicio" data-p="horarios.almoco_inicio">')}
${campo('f-horarios-almoco_fim', 'Almoço termina', '', '<input type="time" id="f-horarios-almoco_fim" data-p="horarios.almoco_fim">')}
</div>
${campo('f-horarios-duracao_min', 'Duração de cada consulta', '', '<select id="f-horarios-duracao_min" data-p="horarios.duracao_min"><option value="20">20 minutos</option><option value="30" selected>30 minutos</option><option value="40">40 minutos</option><option value="45">45 minutos</option><option value="60">1 hora</option></select>')}
</section>

<section><h2><span class="n">4</span>Quem atende os pacientes</h2>
<p class="dica-sec">A assistente fala o nome dos profissionais. Escreva como o paciente conhece (com Dr. ou Dra., se for o caso).</p>
${IMPORTANTE}
<div id="lista-prof" data-p="profissionais"></div>
<div class="erro-campo" id="erro-prof" role="alert" hidden></div>
<button type="button" class="mais" id="mais-prof">+ Adicionar outra pessoa</button>
</section>

<section><h2><span class="n">5</span>Valores da consulta</h2>
<p class="dica-sec">A assistente fala estes valores para o paciente.</p>
${campo('f-valores-consulta_no_dia', 'Consulta paga no dia (R$)', 'Só o valor. Por exemplo: 350.', '<input type="text" inputmode="decimal" id="f-valores-consulta_no_dia" data-p="valores.consulta_no_dia" maxlength="12">', true)}
${campo('f-valores-consulta_antecipada', 'Consulta paga antes (R$) — opcional', 'Se você cobra menos de quem paga antecipado. Em branco se não tem.', '<input type="text" inputmode="decimal" id="f-valores-consulta_antecipada" data-p="valores.consulta_antecipada" maxlength="12">', true)}
${campo('f-valores-sinal_pix', 'Sinal para garantir o horário (R$) — opcional', 'Valor que o paciente paga por Pix na hora de marcar, e o resto no dia. Em branco se você não cobra sinal.', '<input type="text" inputmode="decimal" id="f-valores-sinal_pix" data-p="valores.sinal_pix" maxlength="12">', true)}
${campo('f-valores-chave_pix', 'Chave Pix da clínica — opcional', 'Só a chave para <b>receber</b> (CPF/CNPJ, e-mail, telefone). Nunca senha.', texto('f-valores-chave_pix', 'maxlength="120" autocomplete="off"'))}
${campo('f-valores-favorecido', 'Nome de quem recebe o Pix — opcional', 'Como aparece para o paciente (razão social ou nome).', texto('f-valores-favorecido', 'maxlength="120" autocomplete="off"'))}
</section>

<section><h2><span class="n">6</span>WhatsApp da clínica</h2>
<p class="dica-sec">É o número que os pacientes usam para falar com a clínica. A gente conecta com você depois — agora é só contar como está.</p>
<div class="campo" data-c="f-whatsapp-aplicativo"><span class="rotulo">Hoje esse número está em…</span>
<div class="opcoes" id="f-whatsapp-aplicativo" data-p="whatsapp.aplicativo">
<label class="opcao"><input type="radio" name="app" value="business">WhatsApp Business (o aplicativo verde com a letra B)</label>
<label class="opcao"><input type="radio" name="app" value="comum">WhatsApp comum</label>
<label class="opcao"><input type="radio" name="app" value="nao-sei">Não sei</label>
<label class="opcao"><input type="radio" name="app" value="sem-numero">Ainda não tenho número para a clínica</label>
</div><div class="erro-campo" role="alert" hidden></div></div>
<div id="bloco-numero">
${campo('f-whatsapp-numero', 'Número do WhatsApp da clínica', 'Com +55 e o DDD. Por exemplo: +55 94 98442-0153.', '<input type="tel" id="f-whatsapp-numero" data-p="whatsapp.numero" inputmode="tel" autocomplete="tel" maxlength="24" placeholder="+55">')}
</div>
<div class="campo" data-c="f-whatsapp-conexao"><span class="rotulo">Como você prefere usar?</span>
<div class="opcoes" id="f-whatsapp-conexao" data-p="whatsapp.conexao">
<label class="opcao"><input type="radio" name="conexao" value="coexistencia" checked>Continuar usando o celular como hoje, com a assistente ajudando ao mesmo tempo</label>
<label class="opcao"><input type="radio" name="conexao" value="numero-novo">Usar um número novo só para o sistema</label>
</div><div class="erro-campo" role="alert" hidden></div></div>
</section>

<section><h2><span class="n">7</span>Equipe que vai usar o sistema</h2>
<p class="dica-sec">Cada pessoa recebe um convite por e-mail para criar a própria senha. Use o e-mail que ela de fato lê.</p>
<div id="lista-equipe" data-p="equipe"></div>
<div class="erro-campo" id="erro-equipe" role="alert" hidden></div>
<button type="button" class="mais" id="mais-equipe">+ Adicionar outra pessoa</button>
${campo('f-celular_email', 'E-mail do aparelho da recepção — opcional', 'Se a recepção responde pelo celular da clínica, esse e-mail fica como o "usuário" dele. Diferente do e-mail das pessoas acima.', '<input type="email" id="f-celular_email" data-p="celular_email" autocomplete="off" maxlength="120">')}
</section>

<section><h2><span class="n">8</span>Se você souber</h2>
<p class="dica-sec">Não sabe? Deixe em branco — a gente descobre com você depois.</p>
${campo('f-franquia_id_company', 'Código da sua unidade no sistema da franquia', 'Aparece ao lado do nome da unidade no sistema da franquia. Só números.', '<input type="text" inputmode="numeric" id="f-franquia_id_company" data-p="franquia_id_company" maxlength="10">')}
${campo('f-meta-ad_account', 'Conta de anúncios do Facebook/Instagram', 'Começa com act_ e tem só números depois.', texto('f-meta-ad_account', 'maxlength="30" autocomplete="off" placeholder="act_"'))}
${campo('f-meta-business_manager_id', 'Número do Business Manager (Meta)', 'Só números.', '<input type="text" inputmode="numeric" id="f-meta-business_manager_id" data-p="meta.business_manager_id" maxlength="25" autocomplete="off">')}
</section>

<section><h2><span class="n">9</span>A assistente</h2>
${campo('f-sofia-nome_ia', 'Nome da assistente', 'É como ela se apresenta ao paciente.', '<input type="text" id="f-sofia-nome_ia" data-p="sofia.nome_ia" value="Sofia" maxlength="30">')}
${campo('f-sofia-tom', 'Jeito de falar', '', '<select id="f-sofia-tom" data-p="sofia.tom"><option value="friendly" selected>Amigável (o padrão)</option><option value="formal">Mais formal</option><option value="casual">Descontraído</option></select>')}
</section>

<section>
<div class="campo" data-c="f-confirmou"><label class="opcao"><input type="checkbox" id="f-confirmou" data-p="confirmou">Conferi o endereço, os valores, os horários e os nomes: a assistente vai falar isto para os pacientes.</label>
<div class="erro-campo" role="alert" hidden></div></div>
</section>

<div class="enviar"><button type="submit" id="enviar">Enviar cadastro</button></div>
</form>

<section class="pronto" id="pronto" hidden>
<div class="ok" aria-hidden="true">✓</div>
<h2>Recebemos o seu cadastro</h2>
<p>Obrigado, <b id="pronto-nome"></b>. A equipe da Doutor Digital vai conferir e falar com você.</p>
<p>Referência: <b id="pronto-ref"></b></p>
<p>Pode fechar esta página. Este link já foi usado e não abre de novo.</p>
</section>
<p class="rodape">Doutor Digital Consultoria · Esta página é só para quem recebeu o link. Seus dados são usados apenas para montar o sistema da sua clínica.</p>
`;
}

/** O script da página. Sem biblioteca; o código vem do endereço (`/nova-clinica/<codigo>` → `/api/public/nova-clinica/<codigo>`). */
const SCRIPT = `
(function(){
  var $=function(s,r){return (r||document).querySelector(s)}, $$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
  var API='/api/public/nova-clinica'+location.pathname.slice('/nova-clinica'.length);
  var RASCUNHO='nova-clinica-rascunho:'+location.pathname;
  var FUNCOES_PROF=[['fisioterapeuta','Fisioterapeuta'],['medico','Médico(a)']];
  var PAPEIS=[['gerente','Responsável pela clínica'],['secretaria','Recepção / secretária'],['sdr','Atendimento de novos contatos'],['observador','Só acompanha']];
  function opts(l,v){return l.map(function(o){return '<option value="'+o[0]+'"'+(o[0]===v?' selected':'')+'>'+o[1]+'</option>'}).join('')}
  function linha(tipo,i,d){
    d=d||{};
    var el=document.createElement('div'); el.className='linha'; el.dataset.i=i;
    if(tipo==='prof'){
      el.innerHTML='<div class="campo"><label>Nome</label><input type="text" data-k="nome" maxlength="80" autocomplete="off"><div class="erro-campo" data-e="nome" role="alert" hidden></div></div>'
        +'<div class="campo"><label>É…</label><select data-k="funcao">'+opts(FUNCOES_PROF,d.funcao||'fisioterapeuta')+'</select><div class="erro-campo" data-e="funcao" role="alert" hidden></div></div>'
        +'<button type="button" class="tirar">Tirar esta pessoa</button>';
    } else {
      el.innerHTML='<div class="campo"><label>Nome</label><input type="text" data-k="nome" maxlength="80" autocomplete="off"><div class="erro-campo" data-e="nome" role="alert" hidden></div></div>'
        +'<div class="campo"><label>E-mail</label><input type="email" data-k="email" maxlength="120" autocomplete="off" inputmode="email"><div class="erro-campo" data-e="email" role="alert" hidden></div></div>'
        +'<div class="campo"><label>Papel no sistema</label><select data-k="funcao">'+opts(PAPEIS,d.funcao||'secretaria')+'</select><div class="erro-campo" data-e="funcao" role="alert" hidden></div></div>'
        +'<button type="button" class="tirar">Tirar esta pessoa</button>';
    }
    $('[data-k=nome]',el).value=d.nome||''; var em=$('[data-k=email]',el); if(em) em.value=d.email||'';
    $('.tirar',el).addEventListener('click',function(){ var L=el.parentNode; el.remove(); reindexa(L); });
    return el;
  }
  function reindexa(L){ $$('.linha',L).forEach(function(e,i){e.dataset.i=i}); }
  function addLinha(tipo,d){ var L=$(tipo==='prof'?'#lista-prof':'#lista-equipe'); L.appendChild(linha(tipo,L.children.length,d)); }
  $('#mais-prof').addEventListener('click',function(){addLinha('prof')});
  $('#mais-equipe').addEventListener('click',function(){addLinha('equipe')});
  addLinha('prof'); addLinha('equipe',{funcao:'gerente'});

  function num(v){ v=(v||'').trim(); return v===''?undefined:v; }
  function coleta(){
    var g=function(p){var e=$('[data-p="'+p+'"]'); return e?e.value.trim():''};
    var app=$('input[name=app]:checked'), con=$('input[name=conexao]:checked');
    return {
      quem:{nome:g('quem.nome'),contato:g('quem.contato')},
      clinica:{nome:g('clinica.nome'),cidade:g('clinica.cidade'),uf:g('clinica.uf'),endereco:g('clinica.endereco'),mapa_url:g('clinica.mapa_url'),telefone:g('clinica.telefone')},
      horarios:{dias:$$('#f-horarios-dias input:checked').map(function(c){return Number(c.value)}),inicio:g('horarios.inicio'),fim:g('horarios.fim'),almoco_inicio:g('horarios.almoco_inicio'),almoco_fim:g('horarios.almoco_fim'),duracao_min:Number(g('horarios.duracao_min'))},
      profissionais:$$('#lista-prof .linha').map(function(l){return {nome:$('[data-k=nome]',l).value.trim(),funcao:$('[data-k=funcao]',l).value}}),
      valores:{consulta_no_dia:g('valores.consulta_no_dia'),consulta_antecipada:g('valores.consulta_antecipada'),sinal_pix:g('valores.sinal_pix'),chave_pix:g('valores.chave_pix'),favorecido:g('valores.favorecido')},
      whatsapp:{aplicativo:app?app.value:'',numero:$('input[name=app]:checked')&&$('input[name=app]:checked').value==='sem-numero'?'':g('whatsapp.numero'),conexao:con?con.value:''},
      equipe:$$('#lista-equipe .linha').map(function(l){return {nome:$('[data-k=nome]',l).value.trim(),email:$('[data-k=email]',l).value.trim(),funcao:$('[data-k=funcao]',l).value}}),
      celular_email:g('celular_email'),
      franquia_id_company:g('franquia_id_company'),
      meta:{ad_account:g('meta.ad_account'),business_manager_id:g('meta.business_manager_id')},
      sofia:{nome_ia:g('sofia.nome_ia'),tom:g('sofia.tom')},
      confirmou:$('#f-confirmou').checked
    };
  }
  // número só aparece se a pessoa TEM número
  function atualizaNumero(){ var a=$('input[name=app]:checked'); $('#bloco-numero').hidden=!!a&&a.value==='sem-numero'; }
  $$('input[name=app]').forEach(function(r){r.addEventListener('change',atualizaNumero)});

  // rascunho no próprio aparelho (nunca vai ao servidor antes do envio); some quando o envio dá certo
  function salvaRascunho(){ try{ var d=coleta(); d.confirmou=false; localStorage.setItem(RASCUNHO,JSON.stringify(d)); }catch(e){} }
  function limpaRascunho(){ try{ localStorage.removeItem(RASCUNHO); }catch(e){} }
  function restaura(){
    try{
      var d=JSON.parse(localStorage.getItem(RASCUNHO)||'null'); if(!d) return;
      var s=function(p,v){var e=$('[data-p="'+p+'"]'); if(e&&v!==undefined&&v!==null) e.value=v};
      s('quem.nome',d.quem.nome);s('quem.contato',d.quem.contato);
      ['nome','cidade','uf','endereco','mapa_url','telefone'].forEach(function(k){s('clinica.'+k,d.clinica[k])});
      ['inicio','fim','almoco_inicio','almoco_fim','duracao_min'].forEach(function(k){s('horarios.'+k,d.horarios[k])});
      $$('#f-horarios-dias input').forEach(function(c){c.checked=d.horarios.dias.indexOf(Number(c.value))>=0});
      ['consulta_no_dia','consulta_antecipada','sinal_pix','chave_pix','favorecido'].forEach(function(k){s('valores.'+k,d.valores[k])});
      if(d.whatsapp.aplicativo){var a=$('input[name=app][value="'+d.whatsapp.aplicativo+'"]'); if(a)a.checked=true}
      if(d.whatsapp.conexao){var c=$('input[name=conexao][value="'+d.whatsapp.conexao+'"]'); if(c)c.checked=true}
      s('whatsapp.numero',d.whatsapp.numero);
      $('#lista-prof').innerHTML=''; (d.profissionais.length?d.profissionais:[{}]).forEach(function(p){addLinha('prof',p)});
      $('#lista-equipe').innerHTML=''; (d.equipe.length?d.equipe:[{funcao:'gerente'}]).forEach(function(p){addLinha('equipe',p)});
      s('celular_email',d.celular_email);s('franquia_id_company',d.franquia_id_company);s('meta.ad_account',d.meta.ad_account);s('meta.business_manager_id',d.meta.business_manager_id);
      s('sofia.nome_ia',d.sofia.nome_ia);s('sofia.tom',d.sofia.tom);
    }catch(e){}
    atualizaNumero();
  }
  restaura();
  $('#form').addEventListener('input',function(){ clearTimeout(salvaRascunho.t); salvaRascunho.t=setTimeout(salvaRascunho,600); });

  function limpaErros(){ $$('.erro-campo').forEach(function(e){e.hidden=true;e.textContent=''}); $$('.tem-erro').forEach(function(e){e.classList.remove('tem-erro')}); $('#resumo-erro').hidden=true; }
  function mostraErro(caminho,msg){
    var partes=caminho.split('.'), alvo=null;
    var lista={profissionais:'#lista-prof',equipe:'#lista-equipe'}[partes[0]];
    if(lista && partes.length>=3){ var l=$$('.linha',$(lista))[Number(partes[1])]; var e=l&&$('[data-e="'+partes[2]+'"]',l); if(e){e.textContent=msg;e.hidden=false;e.parentNode.classList.add('tem-erro');return l} }
    if(lista){ var g=$(partes[0]==='profissionais'?'#erro-prof':'#erro-equipe'); g.textContent=msg; g.hidden=false; return $(lista); }
    var el=$('[data-p="'+caminho+'"]');
    if(el){ var c=el.closest('.campo'); var er=c&&$('.erro-campo',c); if(er){er.textContent=msg;er.hidden=false;c.classList.add('tem-erro')} return el; }
    return null;
  }
  function mostraErros(campos){
    limpaErros(); var primeiro=null, n=0;
    Object.keys(campos).forEach(function(k){ var el=mostraErro(k,campos[k]); n++; if(!primeiro&&el) primeiro=el; });
    var r=$('#resumo-erro'); r.textContent=n===1?'Falta corrigir 1 item. Veja o campo marcado em vermelho.':'Faltam corrigir '+n+' itens. Veja os campos marcados em vermelho.'; r.hidden=false;
    (primeiro||r).scrollIntoView({behavior:'smooth',block:'center'});
  }

  $('#form').addEventListener('submit',function(ev){
    ev.preventDefault(); limpaErros();
    var b=$('#enviar'); b.disabled=true; b.textContent='Enviando…';
    var dados=coleta();
    fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(dados)})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {s:r.status,j:j}})})
      .then(function(x){
        if(x.s===200&&x.j.ok){ clearTimeout(salvaRascunho.t); limpaRascunho(); $('#form').hidden=true; $('#intro').hidden=true; $('#resumo-erro').hidden=true; $('#pronto-nome').textContent=dados.quem.nome; $('#pronto-ref').textContent=x.j.referencia||''; $('#pronto').hidden=false; window.scrollTo({top:0}); return; }
        if(x.s===422&&x.j.campos){ mostraErros(x.j.campos); return; }
        var r=$('#resumo-erro');
        r.textContent=x.s===429?'Muitas tentativas. Espere alguns minutos e tente de novo.':x.s===404?'Este link não está mais disponível (serve para um envio só e dura 14 dias). Se você já enviou o cadastro, está tudo certo: a Doutor Digital já recebeu. Se ainda não enviou, peça um link novo.':'Não consegui enviar agora. Seus dados continuam aqui; tente de novo em instantes.';
        r.hidden=false; r.scrollIntoView({behavior:'smooth',block:'center'});
      })
      .catch(function(){ var r=$('#resumo-erro'); r.textContent='Sem conexão. Seus dados continuam aqui; tente de novo quando a internet voltar.'; r.hidden=false; r.scrollIntoView({behavior:'smooth',block:'center'}); })
      .then(function(){ b.disabled=false; b.textContent='Enviar cadastro'; });
  });
})();
`;

const CABECA = (titulo: string) =>
  `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>${titulo}</title>`;

export function paginaDoFormulario(nonce: string): string {
  return `${CABECA('Cadastro da sua clínica · Doutor Digital')}<style nonce="${nonce}">${ESTILO}</style></head><body><main>${corpo()}</main><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

/** O 429 de quem abriu o link: uma tela amigável (o JSON cru assustaria o dono da clínica). */
export function paginaMuitasTentativas(nonce: string, esperarSeg: number): string {
  const min = Math.max(1, Math.ceil(esperarSeg / 60));
  return `${CABECA('Tente de novo em alguns minutos · Doutor Digital')}<style nonce="${nonce}">${ESTILO}</style></head><body><main>
<p class="marca">Doutor Digital</p><h1>Muitas tentativas</h1>
<section><p>Esta página recebeu muitos acessos seguidos. Espere cerca de <b>${min} minuto${min > 1 ? 's' : ''}</b> e abra o link de novo.</p>
<p>Se o problema continuar, fale com a Doutor Digital.</p></section>
</main></body></html>`;
}

/** A MESMA página para código errado, vencido, já usado ou revogado: quem chuta não descobre qual deles existe. */
export function paginaLinkInvalido(nonce: string): string {
  return `${CABECA('Link indisponível · Doutor Digital')}<style nonce="${nonce}">${ESTILO}</style></head><body><main>
<p class="marca">Doutor Digital</p><h1>Este link não está disponível</h1>
<section><p>Ele serve para <b>um envio só</b> e vale por 14 dias.</p>
<p>Se você já enviou o cadastro, está tudo certo: a Doutor Digital já recebeu. Se ainda não enviou, peça um link novo para a Doutor Digital.</p></section>
</main></body></html>`;
}
