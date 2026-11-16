/**
 * A página do formulário «nova clínica» (`/nova-clinica/<codigo>`): HTML + CSS + JS num texto só, sem arquivo estático, no molde das páginas /pausa e /aprendizados.
 *
 * Celular primeiro (pensada para 360 px de largura), claro e escuro (segue o aparelho), linguagem de dono de clínica: nenhum jargão do kit (nada de WABA, slug, token).
 * NUNCA pede segredo. Os campos [IMPORTANTE] — que viram frase dita ao paciente — levam a etiqueta «vira frase dita ao paciente — confira».
 *
 * O código do link NÃO aparece no HTML: o script lê o próprio endereço da página para chamar a API. O script é inline com `nonce` (a política de segurança
 * do conteúdo, mandada pelo controlador, só aceita ele).
 *
 * A seção «Assistente virtual (IA)» é OPCIONAL: só com «sim» ela aparece e vira obrigatória. As respostas de objeção já vêm preenchidas com o padrão da rede Doutor Hérnia (assistente-padrao.ts)
 * e são editáveis. Depois do envio a tela «Recebemos» entrega o chamado para a franqueadora (título e texto prontos para copiar).
 */
import { MAX_OBJECOES_EXTRAS, MAX_RESPOSTA_OBJECAO, NUNCA_DA_REDE, OBJECOES_PADRAO, PASSA_PARA_PESSOA_DA_REDE, QUANDO_ATENDE } from './assistente-padrao.js';
import { URL_DA_FRANQUEADORA } from './chamado-franqueadora.js';

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
.linha textarea{min-height:112px}
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
.aviso-pronto{background:var(--okbg);color:var(--ok)}
.aviso-pronto b{color:inherit}
.topo-ia{margin-top:12px}
h3{font-size:15.5px;margin:20px 0 2px;padding-top:12px;border-top:1px solid var(--line)}
.fixo{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:8px 0;font-size:14px}
.fixo b{display:block;margin-bottom:4px}
.fixo ul{margin:0;padding-left:18px;color:var(--ink2)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
button.chip{min-height:38px;padding:4px 12px;font-size:14px;border-radius:999px}
a.botao{display:block;text-align:center;text-decoration:none;background:var(--acc);color:var(--acc-ink);font-weight:700;border-radius:12px;padding:14px;margin:12px 0}
.passos{margin:8px 0 0;padding-left:20px;color:var(--ink2)}
.passos li{margin:4px 0}
button.copiar{margin-top:6px;width:100%}
.copiado{color:var(--ok);font-size:14px;font-weight:600;min-height:20px}
textarea.leitura{min-height:220px;font-size:14px}
textarea.leitura-curta{min-height:64px;font-size:14px}
`;

const IMPORTANTE = '<span class="tag">vira frase dita ao paciente — confira</span>';

const DIAS = [['1', 'Seg'], ['2', 'Ter'], ['3', 'Qua'], ['4', 'Qui'], ['5', 'Sex'], ['6', 'Sáb'], ['0', 'Dom']];
const UFS = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

const campo = (id: string, rotulo: string, ajuda: string, entrada: string, importante = false) =>
  `<div class="campo" data-c="${id}"><label for="${id}">${rotulo}</label>${importante ? IMPORTANTE : ''}${ajuda ? `<span class="ajuda" id="${id}-a">${ajuda}</span>` : ''}${entrada}<div class="erro-campo" role="alert" hidden></div></div>`;
const texto = (id: string, extra = '') => `<input type="text" id="${id}" data-p="${id.replace(/^f-/, '').replace(/-/g, '.')}" ${extra}>`;

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** JSON dentro de <script>: `<` vira \u003c (nada de «</script>» vindo de dado). */
const json = (x: unknown) => JSON.stringify(x).replace(/</g, '\\u003c');
const lista = (itens: readonly string[]) => `<ul>${itens.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
const area = (id: string, p: string, max: number, extra = '') => `<textarea id="${id}" data-p="${p}" maxlength="${max}" ${extra}></textarea>`;
const radios = (nome: string, p: string, itens: ReadonlyArray<readonly [string, string]>, padrao?: string) =>
  `<div class="opcoes" id="f-ia-${nome}" data-p="${p}">${itens.map(([v, t]) => `<label class="opcao"><input type="radio" name="${nome}" value="${v}"${v === padrao ? ' checked' : ''}>${esc(t)}</label>`).join('')}</div>`;

/** A seção «Assistente virtual (IA)»: opcional; só com «sim» o resto aparece. */
function secaoAssistente(): string {
  return `<section id="sec-ia"><h2><span class="n">9</span>Assistente virtual (IA)</h2>
<p class="dica-sec">Uma assistente que responde os seus pacientes no WhatsApp, 24 horas, no jeito da rede Doutor Hérnia. É opcional: só responda o resto se a clínica quiser.</p>
<div class="campo" data-c="f-ia-quer"><span class="rotulo">A clínica quer a assistente virtual?</span>
${radios('quer', 'assistente.quer', [['sim', 'Sim, quero a assistente'], ['nao', 'Não, por enquanto não']])}
<div class="erro-campo" role="alert" hidden></div></div>
<div id="bloco-ia" hidden>
<p class="dica-sec topo-ia">Quanto mais completo, menos mal-entendido com o paciente. O que você escrever aqui a assistente usa como <b>informação e jeito de falar</b>. As regras da rede sempre valem por cima (preço só o do cadastro, nada de diagnóstico, promessa de cura ou desconto).</p>

<h3>Como ela fala</h3>
${campo('f-ia-nome', 'Nome da assistente', 'É como ela se apresenta ao paciente.', '<input type="text" id="f-ia-nome" data-p="assistente.nome_ia" value="Sofia" maxlength="30">')}
${campo('f-ia-tom', 'Jeito de falar', '', '<select id="f-ia-tom" data-p="assistente.tom"><option value="proximo" selected>Próximo e simpático</option><option value="formal">Mais formal</option></select>')}
<div class="campo" data-c="f-ia-emoji"><span class="rotulo">Pode usar emojis?</span>${radios('emoji', 'assistente.emoji', [['sim', 'Sim (até 1 por mensagem, o padrão da rede)'], ['pouco', 'Pouco: só de vez em quando'], ['nao', 'Não usar emojis']], 'pouco')}<div class="erro-campo" role="alert" hidden></div></div>

<h3>Quando ela atende</h3>
<div class="campo" data-c="f-ia-quando"><span class="rotulo">Em quais horários a assistente responde?</span>${radios('quando', 'assistente.quando_atende', QUANDO_ATENDE as unknown as Array<readonly [string, string]>, 'sempre')}<div class="erro-campo" role="alert" hidden></div></div>
<div id="bloco-quando-detalhe" hidden>${campo('f-ia-quando-detalhe', 'Quais horários?', 'Por exemplo: de segunda a sexta das 18h às 8h, e sábado o dia todo. A gente configura isso com você na hora de ligar a assistente.', '<input type="text" id="f-ia-quando-detalhe" data-p="assistente.quando_atende_detalhe" maxlength="200">')}</div>

<h3>Como a clínica quer ser apresentada</h3>
${campo('f-ia-saudacao', 'Saudação', 'Como a assistente se apresenta e fala da clínica. Por exemplo: «Oi! Aqui é a Sofia, da Doutor Hérnia Serra, especialista em coluna sem cirurgia.»', area('f-ia-saudacao', 'assistente.saudacao', 300), true)}
${campo('f-ia-diferenciais', 'Diferenciais da clínica (opcional)', 'O que a clínica tem de melhor: equipamentos, experiência, método…', area('f-ia-diferenciais', 'assistente.diferenciais', 500), true)}

<h3>Primeira consulta</h3>
${campo('f-ia-pc-como', 'Como funciona', 'O que acontece do começo ao fim, em poucas frases.', area('f-ia-pc-como', 'assistente.primeira_consulta.como_funciona', 500), true)}
${campo('f-ia-pc-duracao', 'Quanto tempo dura (opcional)', '', '<input type="text" id="f-ia-pc-duracao" data-p="assistente.primeira_consulta.duracao" maxlength="100" placeholder="Ex.: cerca de 40 minutos">', true)}
${campo('f-ia-pc-levar', 'O que levar', 'Exames, documentos. Se não precisa de nada, escreva «nada».', '<input type="text" id="f-ia-pc-levar" data-p="assistente.primeira_consulta.o_que_levar" maxlength="300">', true)}
${campo('f-ia-pc-chegada', 'Chegar com quanta antecedência', '', '<input type="text" id="f-ia-pc-chegada" data-p="assistente.primeira_consulta.chegada" maxlength="100" placeholder="Ex.: 15 minutos antes">', true)}

<h3>Pagamento</h3>
<p class="dica-sec">Não escreva valores em reais aqui: o preço da consulta fica na seção 5, e a assistente só fala o que está lá.</p>
${campo('f-ia-pg-formas', 'Formas de pagamento', 'Pix, cartão, dinheiro…', '<input type="text" id="f-ia-pg-formas" data-p="assistente.pagamento.formas" maxlength="300">', true)}
${campo('f-ia-pg-parcela', 'Parcelamento (opcional)', 'Se parcela, em quantas vezes e em quais formas.', '<input type="text" id="f-ia-pg-parcela" data-p="assistente.pagamento.parcelamento" maxlength="300">', true)}
<div class="campo" data-c="f-ia-convenio"><span class="rotulo">A clínica aceita convênio ou plano de saúde?</span>${IMPORTANTE}${radios('convenio', 'assistente.pagamento.convenio', [['nao', 'Não: o atendimento é particular'], ['sim', 'Sim, aceita convênio'], ['reembolso', 'Não é credenciada, mas dá o recibo para pedir reembolso']])}<div class="erro-campo" role="alert" hidden></div></div>
<div id="bloco-convenio-quais" hidden>${campo('f-ia-pg-quais', 'Quais convênios (ou como funciona o reembolso)', '', '<input type="text" id="f-ia-pg-quais" data-p="assistente.pagamento.convenio_quais" maxlength="200">', true)}</div>
${campo('f-ia-pg-remarca', 'Remarcação, falta e cancelamento', 'Quantas horas antes avisar, se cobra, como remarcar.', area('f-ia-pg-remarca', 'assistente.pagamento.remarcacao', 400), true)}

<h3>Quem a clínica não atende</h3>
${campo('f-ia-nao-atende', 'Casos que a clínica não atende (opcional)', 'Por exemplo: crianças menores de 12 anos. Em caso de urgência, a assistente avisa a equipe na hora: isso é regra da rede.', area('f-ia-nao-atende', 'assistente.nao_atende', 400), true)}

<h3>Respostas para as dúvidas do paciente</h3>
<p class="dica-sec">Já deixamos preenchido o que a rede Doutor Hérnia usa. Edite só se a sua clínica fala diferente: a assistente adapta a frase, volta sempre para a dor e oferece dois horários que existem de verdade. O que está entre [colchetes] a assistente troca pelo valor ou horário certo. Até ${MAX_RESPOSTA_OBJECAO} letras cada uma.</p>
${IMPORTANTE}
<div id="lista-obj"></div>
<div class="erro-campo" id="erro-obj" role="alert" hidden></div>
<button type="button" class="mais" id="mais-obj">+ Adicionar outra dúvida (até ${MAX_OBJECOES_EXTRAS})</button>

<h3>O que a assistente NUNCA pode dizer</h3>
<div class="fixo"><b>A rede já proíbe (você não precisa escrever):</b>${lista(NUNCA_DA_REDE)}</div>
${campo('f-ia-nunca', 'Mais alguma coisa que a assistente nunca deve dizer ou prometer (opcional)', '', area('f-ia-nunca', 'assistente.nunca_extra', 300))}

<h3>Quando passar para uma pessoa</h3>
<div class="fixo"><b>A rede já chama uma pessoa da equipe quando:</b>${lista(PASSA_PARA_PESSOA_DA_REDE)}</div>
${campo('f-ia-passar', 'Outras situações em que a assistente deve chamar uma pessoa (opcional)', '', area('f-ia-passar', 'assistente.passar_extra', 300))}
${campo('f-ia-recebe-nome', 'Quem da equipe recebe esse atendimento', 'O nome da pessoa (ou do setor) que assume a conversa.', '<input type="text" id="f-ia-recebe-nome" data-p="assistente.quem_recebe.nome" maxlength="80">')}
${campo('f-ia-recebe-contato', 'Contato dessa pessoa (opcional)', 'Só e-mail ou telefone da equipe. Nunca senha nem código de acesso.', '<input type="text" id="f-ia-recebe-contato" data-p="assistente.quem_recebe.contato" maxlength="80" autocomplete="off">')}

<h3>Perguntas frequentes</h3>
<p class="dica-sec">Perguntas que os pacientes sempre fazem, com a resposta da clínica. Até 10.</p>
${IMPORTANTE}
<div id="lista-faq"></div>
<div class="erro-campo" id="erro-faq" role="alert" hidden></div>
<div class="chips" id="chips-faq" aria-label="Sugestões de perguntas"></div>
<button type="button" class="mais" id="mais-faq">+ Adicionar outra pergunta</button>
</div>
</section>`;
}

function corpo(): string {
  return `
<p class="marca">Doutor Digital</p>
<h1>Cadastro da sua clínica</h1>
<div id="intro"><p class="lead">Preencha com calma, leva uns 10 minutos. Com isso a gente monta o seu sistema de atendimento. Tudo o que você escrever aqui <b>a assistente vai usar para falar com seus pacientes</b>, então confira antes de enviar.</p>
<div class="aviso aviso-pronto"><b>Antes de começar, deixe pronto:</b><br>1) o <b>celular com o número de WhatsApp da clínica</b> na mão;<br>2) o <b>acesso ao Facebook Business</b> (Meta Business) da clínica.<br>É o passo que mais atrasa a montagem do seu sistema.</div>
<div class="aviso"><b>Nunca</b> escreva senha, token ou código de acesso aqui. A gente não pede isso, e você não precisa mandar.</div></div>
<div id="resumo-erro" class="resumo-erro" role="alert" hidden></div>

<form id="form" novalidate autocomplete="on">

<section><h2><span class="n">1</span>Sobre você</h2>
${campo('f-quem-nome', 'Seu nome', '', texto('f-quem-nome', 'autocomplete="name" maxlength="80"'))}
${campo('f-quem-email', 'Seu e-mail', 'Vai no chamado que você abre na franqueadora, no final. Use o e-mail que você lê.', '<input type="email" id="f-quem-email" data-p="quem.email" autocomplete="email" inputmode="email" maxlength="120">')}
${campo('f-quem-whatsapp', 'Seu WhatsApp (opcional)', 'Só para a gente falar com você se faltar alguma informação. Com DDD.', '<input type="tel" id="f-quem-whatsapp" data-p="quem.whatsapp" autocomplete="tel" maxlength="20">')}
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

${secaoAssistente()}

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
</section>
<section id="chamado" hidden>
<h2><span class="n">▶</span>Próximo passo: abra um chamado na franqueadora</h2>
<p class="dica-sec">Para ligar o seu sistema à agenda da franquia, a Doutor Digital precisa de um <b>acesso técnico (token)</b> que só a franqueadora libera, e só quem é franqueado(a) consegue pedir. Leva 2 minutos:</p>
<ol class="passos"><li>Toque em <b>«Abrir o sistema da franqueadora»</b> e <b>entre com o seu login</b>.</li><li><b>Abra um chamado.</b></li><li><b>Cole o título e o texto</b> que estão logo abaixo (toque em «Copiar»).</li></ol>
<a class="botao" id="abrir-franqueadora" href="${URL_DA_FRANQUEADORA}" target="_blank" rel="noopener noreferrer">Abrir o sistema da franqueadora</a>
<div class="campo"><label for="ch-titulo">Título do chamado</label><textarea id="ch-titulo" class="leitura-curta" readonly rows="2"></textarea><button type="button" class="copiar" id="copiar-titulo">Copiar título</button></div>
<div class="campo"><label for="ch-texto">Texto do chamado</label><textarea id="ch-texto" class="leitura" readonly></textarea><button type="button" class="copiar" id="copiar-texto">Copiar texto</button></div>
<div class="copiado" id="copiado" role="status"></div>
<p class="dica-sec">Pode fechar esta página depois de abrir o chamado. Este link já foi usado e não abre de novo.</p>
</section>
<p class="rodape">Doutor Digital Consultoria · Esta página é só para quem recebeu o link. Seus dados são usados apenas para montar o sistema da sua clínica.</p>
`;
}

/** O script da página. Sem biblioteca; o código vem do endereço (`/nova-clinica/<codigo>` → `/api/public/nova-clinica/<codigo>`). */
/** O JavaScript da página (exportado para o teste conferir a sintaxe e o conteúdo). */
export function scriptDoFormulario(): string {
  const dados = json({ obj: OBJECOES_PADRAO, max: MAX_OBJECOES_EXTRAS, faqSugestoes: ['Tem estacionamento?', 'A clínica tem acessibilidade (rampa, elevador)?', 'Vocês dão nota fiscal ou recibo?', 'Atende criança, idoso ou gestante?', 'Atende aos sábados?'] });
  return `
(function(){
  var $=function(s,r){return (r||document).querySelector(s)}, $$=function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
  var D=${dados};
  var API='/api/public/nova-clinica'+location.pathname.slice('/nova-clinica'.length);
  var RASCUNHO='nova-clinica-rascunho:'+location.pathname;
  var FUNCOES_PROF=[['fisioterapeuta','Fisioterapeuta'],['medico','Médico(a)']];
  var PAPEIS=[['gerente','Responsável pela clínica'],['secretaria','Recepção / secretária'],['sdr','Atendimento de novos contatos'],['observador','Só acompanha']];
  function opts(l,v){return l.map(function(o){return '<option value="'+o[0]+'"'+(o[0]===v?' selected':'')+'>'+o[1]+'</option>'}).join('')}
  function el(tag,cls,html){var e=document.createElement(tag); if(cls) e.className=cls; if(html!==undefined) e.innerHTML=html; return e}
  var ERRO=function(k){return '<div class="erro-campo" data-e="'+k+'" role="alert" hidden></div>'};
  function reindexa(L){ $$('.linha',L).forEach(function(e,i){e.dataset.i=i}); }
  function tirar(l){ var b=el('button','tirar','Tirar'); b.type='button'; b.addEventListener('click',function(){ var L=l.parentNode; l.remove(); reindexa(L); }); return b; }

  // profissionais e equipe
  function linha(tipo,i,d){
    d=d||{};
    var l=el('div','linha'); l.dataset.i=i;
    if(tipo==='prof'){
      l.innerHTML='<div class="campo"><label>Nome</label><input type="text" data-k="nome" maxlength="80" autocomplete="off">'+ERRO('nome')+'</div>'
        +'<div class="campo"><label>É…</label><select data-k="funcao">'+opts(FUNCOES_PROF,d.funcao||'fisioterapeuta')+'</select>'+ERRO('funcao')+'</div>';
    } else {
      l.innerHTML='<div class="campo"><label>Nome</label><input type="text" data-k="nome" maxlength="80" autocomplete="off">'+ERRO('nome')+'</div>'
        +'<div class="campo"><label>E-mail</label><input type="email" data-k="email" maxlength="120" autocomplete="off" inputmode="email">'+ERRO('email')+'</div>'
        +'<div class="campo"><label>Papel no sistema</label><select data-k="funcao">'+opts(PAPEIS,d.funcao||'secretaria')+'</select>'+ERRO('funcao')+'</div>';
    }
    $('[data-k=nome]',l).value=d.nome||''; var em=$('[data-k=email]',l); if(em) em.value=d.email||'';
    var t=tirar(l); t.textContent='Tirar esta pessoa'; l.appendChild(t);
    return l;
  }
  function addLinha(tipo,d){ var L=$(tipo==='prof'?'#lista-prof':'#lista-equipe'); L.appendChild(linha(tipo,L.children.length,d)); }
  $('#mais-prof').addEventListener('click',function(){addLinha('prof')});
  $('#mais-equipe').addEventListener('click',function(){addLinha('equipe')});
  addLinha('prof'); addLinha('equipe',{funcao:'gerente'});

  // objeções: as da rede (preenchidas, editáveis) e até D.max do dono
  function linhaObj(o,extra){
    var l=el('div','linha'); l.dataset.id=extra?'outra':o.id;
    if(extra){
      l.innerHTML='<div class="campo"><label>O que o paciente diz</label><input type="text" data-k="gatilho" maxlength="80" autocomplete="off">'+ERRO('gatilho')+'</div>'
        +'<div class="campo"><label>Resposta da assistente</label><textarea data-k="resposta" maxlength="${MAX_RESPOSTA_OBJECAO}" rows="3"></textarea>'+ERRO('resposta')+'</div>';
      $('[data-k=gatilho]',l).value=(o&&o.gatilho)||''; $('[data-k=resposta]',l).value=(o&&o.resposta)||'';
      l.appendChild(tirar(l));
    } else {
      l.innerHTML='<div class="campo"><label></label>'+(o.dica?'<span class="ajuda"></span>':'')+'<textarea data-k="resposta" maxlength="${MAX_RESPOSTA_OBJECAO}" rows="3"></textarea>'+ERRO('resposta')+'</div>';
      $('label',l).textContent='Se o paciente disser: «'+o.gatilho+'»'; if(o.dica) $('.ajuda',l).textContent=o.dica;
      $('[data-k=resposta]',l).value=o.resposta;
    }
    return l;
  }
  function extrasObj(){ return $$('#lista-obj .linha').filter(function(l){return l.dataset.id==='outra'}).length; }
  D.obj.forEach(function(o){ $('#lista-obj').appendChild(linhaObj(o,false)); });
  $('#mais-obj').addEventListener('click',function(){ if(extrasObj()>=D.max) return; $('#lista-obj').appendChild(linhaObj(null,true)); });

  // perguntas frequentes
  function linhaFaq(d){
    d=d||{};
    var l=el('div','linha',
      '<div class="campo"><label>Pergunta</label><input type="text" data-k="pergunta" maxlength="120" autocomplete="off">'+ERRO('pergunta')+'</div>'
      +'<div class="campo"><label>Resposta da clínica</label><textarea data-k="resposta" maxlength="300" rows="3"></textarea>'+ERRO('resposta')+'</div>');
    $('[data-k=pergunta]',l).value=d.pergunta||''; $('[data-k=resposta]',l).value=d.resposta||'';
    l.appendChild(tirar(l));
    return l;
  }
  function addFaq(d){ var L=$('#lista-faq'); if(L.children.length>=10) return; L.appendChild(linhaFaq(d)); }
  $('#mais-faq').addEventListener('click',function(){addFaq()});
  D.faqSugestoes.forEach(function(t){ var b=el('button','chip',t); b.type='button'; b.addEventListener('click',function(){ addFaq({pergunta:t}); var u=$$('#lista-faq .linha'); var x=u[u.length-1]; if(x) $('[data-k=resposta]',x).focus(); }); $('#chips-faq').appendChild(b); });

  // partes que aparecem conforme a escolha
  function rb(n){ var e=$('input[name='+n+']:checked'); return e?e.value:undefined; }
  function atualiza(){
    var a=$('input[name=app]:checked'); $('#bloco-numero').hidden=!!a&&a.value==='sem-numero';
    $('#bloco-ia').hidden=rb('quer')!=='sim';
    $('#bloco-quando-detalhe').hidden=rb('quando')!=='personalizado';
    var c=rb('convenio'); $('#bloco-convenio-quais').hidden=!(c==='sim'||c==='reembolso');
  }
  $$('input[type=radio]').forEach(function(r){r.addEventListener('change',atualiza)});

  function gv(p){var e=$('[data-p="'+p+'"]'); return e?e.value.trim():''}
  function coletaIA(){
    var q=rb('quer');
    if(q===undefined) return {};
    if(q==='nao') return {quer:false};
    return {
      quer:true, nome_ia:gv('assistente.nome_ia'), tom:gv('assistente.tom'), emoji:rb('emoji'), quando_atende:rb('quando'), quando_atende_detalhe:rb('quando')==='personalizado'?gv('assistente.quando_atende_detalhe'):'',
      saudacao:gv('assistente.saudacao'), diferenciais:gv('assistente.diferenciais'),
      primeira_consulta:{como_funciona:gv('assistente.primeira_consulta.como_funciona'),duracao:gv('assistente.primeira_consulta.duracao'),o_que_levar:gv('assistente.primeira_consulta.o_que_levar'),chegada:gv('assistente.primeira_consulta.chegada')},
      pagamento:{formas:gv('assistente.pagamento.formas'),parcelamento:gv('assistente.pagamento.parcelamento'),convenio:rb('convenio'),convenio_quais:(rb('convenio')==='sim'||rb('convenio')==='reembolso')?gv('assistente.pagamento.convenio_quais'):'',remarcacao:gv('assistente.pagamento.remarcacao')},
      nao_atende:gv('assistente.nao_atende'),
      objecoes:$$('#lista-obj .linha').map(function(l){ var o={id:l.dataset.id,resposta:$('[data-k=resposta]',l).value.trim()}; if(o.id==='outra') o.gatilho=$('[data-k=gatilho]',l).value.trim(); return o; }),
      nunca_extra:gv('assistente.nunca_extra'), passar_extra:gv('assistente.passar_extra'),
      quem_recebe:{nome:gv('assistente.quem_recebe.nome'),contato:gv('assistente.quem_recebe.contato')},
      faq:$$('#lista-faq .linha').map(function(l){return {pergunta:$('[data-k=pergunta]',l).value.trim(),resposta:$('[data-k=resposta]',l).value.trim()}})
    };
  }
  function coleta(){
    var g=gv;
    var app=$('input[name=app]:checked'), con=$('input[name=conexao]:checked');
    return {
      quem:{nome:g('quem.nome'),email:g('quem.email'),whatsapp:g('quem.whatsapp')},
      clinica:{nome:g('clinica.nome'),cidade:g('clinica.cidade'),uf:g('clinica.uf'),endereco:g('clinica.endereco'),mapa_url:g('clinica.mapa_url'),telefone:g('clinica.telefone')},
      horarios:{dias:$$('#f-horarios-dias input:checked').map(function(c){return Number(c.value)}),inicio:g('horarios.inicio'),fim:g('horarios.fim'),almoco_inicio:g('horarios.almoco_inicio'),almoco_fim:g('horarios.almoco_fim'),duracao_min:Number(g('horarios.duracao_min'))},
      profissionais:$$('#lista-prof .linha').map(function(l){return {nome:$('[data-k=nome]',l).value.trim(),funcao:$('[data-k=funcao]',l).value}}),
      valores:{consulta_no_dia:g('valores.consulta_no_dia'),consulta_antecipada:g('valores.consulta_antecipada'),sinal_pix:g('valores.sinal_pix'),chave_pix:g('valores.chave_pix'),favorecido:g('valores.favorecido')},
      whatsapp:{aplicativo:app?app.value:'',numero:app&&app.value==='sem-numero'?'':g('whatsapp.numero'),conexao:con?con.value:''},
      equipe:$$('#lista-equipe .linha').map(function(l){return {nome:$('[data-k=nome]',l).value.trim(),email:$('[data-k=email]',l).value.trim(),funcao:$('[data-k=funcao]',l).value}}),
      celular_email:g('celular_email'),
      franquia_id_company:g('franquia_id_company'),
      meta:{ad_account:g('meta.ad_account'),business_manager_id:g('meta.business_manager_id')},
      assistente:coletaIA(),
      confirmou:$('#f-confirmou').checked
    };
  }

  // rascunho no próprio aparelho (nunca vai ao servidor antes do envio); some quando o envio dá certo
  function salvaRascunho(){ try{ var d=coleta(); d.confirmou=false; localStorage.setItem(RASCUNHO,JSON.stringify(d)); }catch(e){} }
  function limpaRascunho(){ try{ localStorage.removeItem(RASCUNHO); }catch(e){} }
  function marca(nome,v){ if(v===undefined||v===null) return; var e=$('input[name='+nome+'][value="'+v+'"]'); if(e) e.checked=true; }
  function aplicaIA(a){
    if(!a||a.quer===undefined) return;
    marca('quer',a.quer?'sim':'nao');
    if(!a.quer) return;
    var s=function(p,v){var e=$('[data-p="'+p+'"]'); if(e&&v!==undefined&&v!==null) e.value=v};
    s('assistente.nome_ia',a.nome_ia); s('assistente.tom',a.tom); marca('emoji',a.emoji); marca('quando',a.quando_atende); s('assistente.quando_atende_detalhe',a.quando_atende_detalhe);
    s('assistente.saudacao',a.saudacao); s('assistente.diferenciais',a.diferenciais);
    var pc=a.primeira_consulta||{}; ['como_funciona','duracao','o_que_levar','chegada'].forEach(function(k){s('assistente.primeira_consulta.'+k,pc[k])});
    var pg=a.pagamento||{}; ['formas','parcelamento','convenio_quais','remarcacao'].forEach(function(k){s('assistente.pagamento.'+k,pg[k])}); marca('convenio',pg.convenio);
    s('assistente.nao_atende',a.nao_atende); s('assistente.nunca_extra',a.nunca_extra); s('assistente.passar_extra',a.passar_extra);
    var qr=a.quem_recebe||{}; s('assistente.quem_recebe.nome',qr.nome); s('assistente.quem_recebe.contato',qr.contato);
    $('#lista-obj').innerHTML=''; D.obj.forEach(function(o){ var salvo=(a.objecoes||[]).filter(function(x){return x.id===o.id})[0]; var c={id:o.id,gatilho:o.gatilho,dica:o.dica,resposta:salvo&&salvo.resposta!==undefined?salvo.resposta:o.resposta}; $('#lista-obj').appendChild(linhaObj(c,false)); });
    (a.objecoes||[]).filter(function(x){return x.id==='outra'}).slice(0,D.max).forEach(function(x){ $('#lista-obj').appendChild(linhaObj(x,true)); });
    $('#lista-faq').innerHTML=''; (a.faq||[]).slice(0,10).forEach(function(f){ addFaq(f); });
  }
  function restaura(){
    try{
      var d=JSON.parse(localStorage.getItem(RASCUNHO)||'null'); if(!d) return;
      var s=function(p,v){var e=$('[data-p="'+p+'"]'); if(e&&v!==undefined&&v!==null) e.value=v};
      s('quem.nome',d.quem.nome);s('quem.email',d.quem.email);s('quem.whatsapp',d.quem.whatsapp);
      ['nome','cidade','uf','endereco','mapa_url','telefone'].forEach(function(k){s('clinica.'+k,d.clinica[k])});
      ['inicio','fim','almoco_inicio','almoco_fim','duracao_min'].forEach(function(k){s('horarios.'+k,d.horarios[k])});
      $$('#f-horarios-dias input').forEach(function(c){c.checked=d.horarios.dias.indexOf(Number(c.value))>=0});
      ['consulta_no_dia','consulta_antecipada','sinal_pix','chave_pix','favorecido'].forEach(function(k){s('valores.'+k,d.valores[k])});
      marca('app',d.whatsapp.aplicativo); marca('conexao',d.whatsapp.conexao); s('whatsapp.numero',d.whatsapp.numero);
      $('#lista-prof').innerHTML=''; (d.profissionais.length?d.profissionais:[{}]).forEach(function(p){addLinha('prof',p)});
      $('#lista-equipe').innerHTML=''; (d.equipe.length?d.equipe:[{funcao:'gerente'}]).forEach(function(p){addLinha('equipe',p)});
      s('celular_email',d.celular_email);s('franquia_id_company',d.franquia_id_company);s('meta.ad_account',d.meta.ad_account);s('meta.business_manager_id',d.meta.business_manager_id);
      aplicaIA(d.assistente);
    }catch(e){}
    atualiza();
  }
  restaura();
  $('#form').addEventListener('input',function(){ clearTimeout(salvaRascunho.t); salvaRascunho.t=setTimeout(salvaRascunho,600); });
  $('#form').addEventListener('click',function(ev){ if(ev.target.closest&&ev.target.closest('button')){ clearTimeout(salvaRascunho.t); salvaRascunho.t=setTimeout(salvaRascunho,600); } });

  function limpaErros(){ $$('.erro-campo').forEach(function(e){e.hidden=true;e.textContent=''}); $$('.tem-erro').forEach(function(e){e.classList.remove('tem-erro')}); $('#resumo-erro').hidden=true; }
  var LISTAS={'profissionais':['#lista-prof','#erro-prof',1],'equipe':['#lista-equipe','#erro-equipe',1],'assistente.objecoes':['#lista-obj','#erro-obj',2],'assistente.faq':['#lista-faq','#erro-faq',2]};
  function mostraErro(caminho,msg){
    var partes=caminho.split('.');
    var chave=partes[0]==='assistente'&&partes.length>1?partes[0]+'.'+partes[1]:partes[0];
    var L=LISTAS[chave];
    if(L){
      var off=L[2];
      if(partes.length>off+1){ var l=$$('.linha',$(L[0]))[Number(partes[off])]; var e=l&&$('[data-e="'+partes[off+1]+'"]',l); if(e){e.textContent=msg;e.hidden=false;e.parentNode.classList.add('tem-erro');return l} }
      var g=$(L[1]); g.textContent=msg; g.hidden=false; return $(L[0]);
    }
    var alvo=$('[data-p="'+caminho+'"]');
    if(alvo){ var c=alvo.closest('.campo'); var er=c&&$('.erro-campo',c); if(er){er.textContent=msg;er.hidden=false;c.classList.add('tem-erro')} return alvo; }
    return null;
  }
  function mostraErros(campos){
    limpaErros(); var primeiro=null, n=0;
    Object.keys(campos).forEach(function(k){ var e=mostraErro(k,campos[k]); n++; if(!primeiro&&e) primeiro=e; });
    var r=$('#resumo-erro'); r.textContent=n===1?'Falta corrigir 1 item. Veja o campo marcado em vermelho.':'Faltam corrigir '+n+' itens. Veja os campos marcados em vermelho.'; r.hidden=false;
    (primeiro||r).scrollIntoView({behavior:'smooth',block:'center'});
  }

  // copiar título e texto do chamado
  function copia(idCampo,rotulo){
    var c=$(idCampo), aviso=$('#copiado');
    function ok(){ aviso.textContent=rotulo+' copiado. Agora é só colar no chamado.'; }
    function plano(){ c.focus(); c.select(); try{ if(document.execCommand('copy')) ok(); else aviso.textContent='Não consegui copiar sozinho: o texto está selecionado, use «Copiar» do seu celular.'; }catch(e){ aviso.textContent='Não consegui copiar sozinho: o texto está selecionado, use «Copiar» do seu celular.'; } }
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(c.value).then(ok,plano); else plano();
  }
  $('#copiar-titulo').addEventListener('click',function(){copia('#ch-titulo','Título')});
  $('#copiar-texto').addEventListener('click',function(){copia('#ch-texto','Texto')});

  $('#form').addEventListener('submit',function(ev){
    ev.preventDefault(); limpaErros();
    var b=$('#enviar'); b.disabled=true; b.textContent='Enviando…';
    var dados=coleta();
    fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(dados)})
      .then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {s:r.status,j:j}})})
      .then(function(x){
        if(x.s===200&&x.j.ok){
          clearTimeout(salvaRascunho.t); limpaRascunho(); $('#form').hidden=true; $('#intro').hidden=true; $('#resumo-erro').hidden=true;
          $('#pronto-nome').textContent=dados.quem.nome; $('#pronto-ref').textContent=x.j.referencia||''; $('#pronto').hidden=false;
          if(x.j.chamado){ $('#ch-titulo').value=x.j.chamado.titulo; $('#ch-texto').value=x.j.chamado.texto; $('#chamado').hidden=false; }
          window.scrollTo({top:0}); return;
        }
        if(x.s===422&&x.j.campos){ mostraErros(x.j.campos); return; }
        var r=$('#resumo-erro');
        r.textContent=x.s===429?'Muitas tentativas. Espere alguns minutos e tente de novo.':x.s===404?'Este link não está mais disponível (serve para um envio só e dura 14 dias). Se você já enviou o cadastro, está tudo certo: a Doutor Digital já recebeu. Se ainda não enviou, peça um link novo.':'Não consegui enviar agora. Seus dados continuam aqui; tente de novo em instantes.';
        r.hidden=false; r.scrollIntoView({behavior:'smooth',block:'center'});
      })
      .catch(function(){ var r=$('#resumo-erro'); r.textContent='Sem conexão. Seus dados continuam aqui; tente de novo quando a internet voltar.'; r.hidden=false; r.scrollIntoView({behavior:'smooth',block:'center'}); })
      .then(function(){ b.disabled=false; b.textContent='Enviar cadastro'; });
  });
  atualiza();
})();
`;
}

const CABECA = (titulo: string) =>
  `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>${titulo}</title>`;

export function paginaDoFormulario(nonce: string): string {
  return `${CABECA('Cadastro da sua clínica · Doutor Digital')}<style nonce="${nonce}">${ESTILO}</style></head><body><main>${corpo()}</main><script nonce="${nonce}">${scriptDoFormulario()}</script></body></html>`;
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
