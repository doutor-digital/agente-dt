import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { OBJECOES_PADRAO } from './assistente-padrao.js';
import { paginaDoFormulario, scriptDoFormulario } from './formulario-pagina.js';

const html = paginaDoFormulario('NONCE123');
const texto = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('o JavaScript da página é válido, não fecha o <script> por dentro e leva as respostas da rede como DADO', () => {
  const js = scriptDoFormulario();
  assert.doesNotThrow(() => new Script(js), 'sintaxe');
  assert.ok(!/<\/script/i.test(js));
  for (const o of OBJECOES_PADRAO.filter((x) => x.resposta)) assert.ok(js.includes(o.resposta.slice(0, 40)), o.id);
});

test('aviso no topo: deixar PRONTO antes de começar o celular do WhatsApp da clínica e o acesso ao Facebook Business', () => {
  assert.match(texto, /Antes de começar, deixe pronto: 1\) o celular com o número de WhatsApp da clínica na mão; 2\) o acesso ao Facebook Business \(Meta Business\) da clínica\. É o passo que mais atrasa/);
  assert.ok(html.indexOf('Antes de começar, deixe pronto') < html.indexOf('<form'), 'vem ANTES do formulário');
});

test('seção «Assistente virtual (IA)»: opcional (sim/não), o resto escondido até «sim», campos em linguagem de dono, o que a rede já proíbe e quando chama pessoa', () => {
  assert.match(texto, /Assistente virtual \(IA\)/);
  assert.match(texto, /A clínica quer a assistente virtual\? Sim, quero a assistente Não, por enquanto não/);
  assert.match(html, /<div id="bloco-ia" hidden>/);
  for (const t of ['Nome da assistente', 'Jeito de falar', 'Pode usar emojis', 'Quando ela atende', 'A assistente atende 24 horas por dia', 'Só fora do horário da clínica', 'Só à noite e nos fins de semana', 'Outro horário', 'Saudação', 'Diferenciais da clínica', 'Primeira consulta', 'Como funciona', 'O que levar', 'Chegar com quanta antecedência', 'Formas de pagamento', 'Parcelamento', 'aceita convênio ou plano de saúde', 'Remarcação, falta e cancelamento', 'Casos que a clínica não atende', 'Respostas para as dúvidas do paciente', 'O que a assistente NUNCA pode dizer', 'A rede já proíbe', 'Prometer cura ou resultado garantido', 'Quando passar para uma pessoa', 'A rede já chama uma pessoa da equipe quando', 'Quem da equipe recebe esse atendimento', 'Perguntas frequentes']) assert.ok(texto.includes(t), `faltou na página: ${t}`);
  assert.match(texto, /Não escreva valores em reais aqui/);
  assert.match(texto, /Nunca senha nem código de acesso/);
  assert.match(texto, /Em caso de urgência, a assistente avisa a equipe na hora: isso é regra da rede/);
  assert.doesNotMatch(texto, /pronto-socorro|pronto socorro/i, 'a rede decidiu: a assistente nunca orienta pronto-socorro');
  assert.ok((html.match(/vira frase dita ao paciente — confira/g) ?? []).length >= 15, 'etiqueta em tudo que a assistente fala');
});

test('seção 1 pede o e-mail (obrigatório, vai no chamado) e separa o WhatsApp (opcional)', () => {
  assert.match(html, /id="f-quem-email" data-p="quem\.email" autocomplete="email" inputmode="email"/);
  assert.match(html, /data-p="quem\.whatsapp"/);
  assert.doesNotMatch(html, /quem\.contato/);
  assert.match(texto, /Seu e-mail Vai no chamado que você abre na franqueadora/);
  assert.match(texto, /Seu WhatsApp \(opcional\)/);
});

test('tela «Recebemos»: bloco «Próximo passo: abra um chamado na franqueadora», botão para o login (nova aba, rel=noopener), título e texto para copiar, passo a passo SEM inventar menu', () => {
  assert.match(texto, /Próximo passo: abra um chamado na franqueadora/);
  assert.match(html, /<a class="botao" id="abrir-franqueadora" href="https:\/\/app\.doutorhernia\.com\.br\/login" target="_blank" rel="noopener noreferrer">Abrir o sistema da franqueadora<\/a>/);
  assert.match(texto, /Toque em «Abrir o sistema da franqueadora» e entre com o seu login\s*\. Abra um chamado\. Cole o título e o texto/);
  for (const id of ['ch-titulo', 'ch-texto', 'copiar-titulo', 'copiar-texto']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /id="ch-titulo" class="leitura-curta" readonly/);
  assert.match(html, /id="ch-texto" class="leitura" readonly/);
  assert.match(texto, /Copiar título/);
  assert.match(texto, /Copiar texto/);
  assert.doesNotMatch(texto, /\bmenu\b/i, 'não inventa nome de menu do sistema da franqueadora');
  assert.match(html, /<section id="chamado" hidden>/, 'só aparece depois do envio');
});

test('segurança da página: todo <script> e <style> com nonce, sem handler inline, sem style inline, sem pedir segredo, sem jargão do kit', () => {
  assert.doesNotMatch(html, /<script(?![^>]*nonce)/);
  assert.doesNotMatch(html, /<style(?![^>]*nonce)/);
  assert.doesNotMatch(html, /\son(click|change|input|submit|load)=/i);
  assert.doesNotMatch(html, /\sstyle="/i);
  assert.doesNotMatch(html, /type="password"/);
  for (const jargao of [/WABA/i, /\bslug\b/i, /token_env/i, /\bKapso\b/i, /\bChatwoot\b/i, /\bwebhook\b/i, /prompt/i, /aprendizado/i, /\bfontes?\b/i]) assert.doesNotMatch(texto, jargao, String(jargao));
});
