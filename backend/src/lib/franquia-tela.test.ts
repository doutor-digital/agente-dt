/**
 * Leitura da tela de edição do atendimento da franquia.
 *
 * O que estes testes prendem: a tela traz "01/01/1900" como "sem data" (virar data de 1900 no cartão seria
 * lixo); "Selecione" não é uma escolha; página que não é a de edição (sessão caída, redirecionamento para o
 * login) tem que dar null — e não "tudo vazio", que o robô leria como "a franquia está sem nada".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessaoTela, abrirSessaoTela, montarAvisoDaTela, dataDaTela, ehTelaDeEdicao, ehTelaDeLogin, lerAtendimentoDaTela } from './franquia-tela.js';

const OPCOES_PAGAMENTO = ['Selecione', 'DINHEIRO', 'CARTÃO DE DÉBITO', 'CRÉDITO 2X', 'PIX'];
function opcoes(lista: string[], marcada: string | null): string {
  return lista.map((o, i) => `<option value="${i}"${o === marcada ? ' selected' : ''}>${o}</option>`).join('');
}

/** O mesmo desenho da tela real (colhido na Serra em 02/10/2026): selects e inputs com name. */
function tela(over: { pagamento?: string | null; retorno?: string; motivo?: string; perfil?: string; tratamento?: string | null } = {}): string {
  return `<html><body><form>
    <select class="form-select" name="id_status"><option value="42" selected>ATENDIDO</option></select>
    <input type="text" class="form-control" name="return_at" value="${over.retorno ?? '01/01/1900 00:00'}">
    <select class="form-select" name="id_form_payment" id="x">${opcoes(OPCOES_PAGAMENTO, over.pagamento ?? null)}</select>
    <select class="form-select" name="id_future_treatment">${opcoes(['Selecione', 'PROTOCOLO 01 MÊS', 'PROTOCOLO 03 MESES'], over.tratamento ?? null)}</select>
    <input type="text" inputmode="text" class="form-control-plaintext" name="client_profile" id="client_profile" value="${over.perfil ?? ''}">
    <input type="text" inputmode="text" class="form-control-plaintext" name="reason_refusal" id="id_reason" value="${over.motivo ?? ''}">
  </form></body></html>`;
}

test('tela vazia: nenhum campo vem preenchido, e a data 01/01/1900 não vira data', () => {
  const a = lerAtendimentoDaTela(tela())!;
  assert.deepEqual(a, { retornoLocal: null, formaPagamento: null, tratamentoFuturo: null, perfil: null, motivoNaoRealizar: null });
});

test('tela preenchida: lê a opção marcada, o texto livre e a data', () => {
  const a = lerAtendimentoDaTela(tela({ pagamento: 'CRÉDITO 2X', retorno: '15/10/2026 14:30', motivo: 'Achou caro &amp; vai pensar', perfil: 'Analítico', tratamento: 'PROTOCOLO 03 MESES' }))!;
  assert.equal(a.formaPagamento, 'CRÉDITO 2X');
  assert.equal(a.retornoLocal, '2026-10-15T14:30');
  assert.equal(a.motivoNaoRealizar, 'Achou caro & vai pensar');
  assert.equal(a.perfil, 'Analítico');
  assert.equal(a.tratamentoFuturo, 'PROTOCOLO 03 MESES');
});

test('"Selecione" marcado conta como vazio', () => {
  assert.equal(lerAtendimentoDaTela(tela({ pagamento: 'Selecione' }))!.formaPagamento, null);
});

test('página que não é a de edição dá null — nunca "tudo vazio"', () => {
  assert.equal(ehTelaDeEdicao('<html><form action="/login"><input name="email"></form></html>'), false);
  assert.equal(lerAtendimentoDaTela('<html><form action="/login"><input name="email"></form></html>'), null);
  assert.equal(lerAtendimentoDaTela(''), null);
});

test('dataDaTela: formatos e o sem-data da franquia', () => {
  assert.equal(dataDaTela('02/10/2026 09:05'), '2026-10-02T09:05');
  assert.equal(dataDaTela('02/10/2026'), '2026-10-02T00:00');
  assert.equal(dataDaTela('01/01/1900 00:00'), null);
  assert.equal(dataDaTela('31/13/2026 10:00'), null);
  assert.equal(dataDaTela(null), null);
  assert.equal(dataDaTela('ontem'), null);
});

function respostaFalsa(html: string, status = 200, cookies: string[] = []): Response {
  const h = new Headers();
  return { status, text: async () => html, headers: Object.assign(h, { getSetCookie: () => cookies }) } as unknown as Response;
}

const PAGINA_DE_LOGIN = '<html><form action="/login"><input name="email"><input type="password" name="password"></form></html>';

test('entidades: &amp; decodifica por último (o texto "&lt;" digitado não vira "<") e número absurdo não derruba a leitura', () => {
  assert.equal(lerAtendimentoDaTela(tela({ motivo: 'a &amp;lt;b&amp;gt; &amp; c' }))!.motivoNaoRealizar, 'a &lt;b&gt; & c');
  assert.equal(lerAtendimentoDaTela(tela({ motivo: 'x &#99999999999; y' }))!.motivoNaoRealizar, 'x &#99999999999; y');
});

test('value= não casa com data-value= ; textarea também é lido', () => {
  const html = tela().replace('name="reason_refusal" id="id_reason" value=""', 'name="reason_refusal" data-value="mascara" id="id_reason" value="Achou caro"');
  assert.equal(lerAtendimentoDaTela(html)!.motivoNaoRealizar, 'Achou caro');
  const comTextarea = tela().replace(/<input[^>]*name="reason_refusal"[^>]*>/, '<textarea name="reason_refusal" id="id_reason">Vai viajar</textarea>');
  assert.equal(lerAtendimentoDaTela(comTextarea)!.motivoNaoRealizar, 'Vai viajar');
});

test('tela de login é reconhecida; a de edição não é login', () => {
  assert.equal(ehTelaDeLogin(PAGINA_DE_LOGIN), true);
  assert.equal(ehTelaDeLogin(tela()), false);
  assert.equal(ehTelaDeLogin('<html>404 não encontrado</html>'), false);
});

test('sessão: 3 telas de login seguidas = a sessão caiu, e a varredura desiste em vez de insistir', async () => {
  const chamadas: string[] = [];
  const falso = (async (url: string) => { chamadas.push(String(url)); return respostaFalsa(PAGINA_DE_LOGIN); }) as unknown as typeof fetch;
  const s = new SessaoTela('u', 'p', falso);
  for (let i = 0; i < 3; i++) assert.equal(await s.lerAtendimento(100 + i), null);
  assert.equal(s.quebrada, true);
  const antes = chamadas.length;
  assert.equal(await s.lerAtendimento(999), null);
  assert.equal(chamadas.length, antes, 'quebrada não faz mais requisição');
});

test('sessão: atendimento que não abre (404, apagado, de outra unidade) NÃO derruba a sessão', async () => {
  const falso = (async () => respostaFalsa('<html>404</html>', 404)) as unknown as typeof fetch;
  const s = new SessaoTela('u', 'p', falso);
  for (let i = 0; i < 10; i++) assert.equal(await s.lerAtendimento(i), null);
  assert.equal(s.quebrada, false);
});

test('sessão: 5 páginas que abrem mas não têm o formulário = layout mudou (e é diferente de sessão caída)', async () => {
  const falso = (async () => respostaFalsa('<html>' + 'x'.repeat(100) + '</html>')) as unknown as typeof fetch;
  const s = new SessaoTela('u', 'p', falso);
  for (let i = 0; i < 5; i++) assert.equal(await s.lerAtendimento(i), null);
  assert.equal(s.layoutMudou, true);
  assert.equal(s.quebrada, false, 'não é login: a sessão está boa');
});

test('sessão: leitura boa zera a contagem de falhas', async () => {
  let n = 0;
  const falso = (async () => respostaFalsa(n++ === 0 ? PAGINA_DE_LOGIN : tela({ pagamento: 'PIX' }))) as unknown as typeof fetch;
  const s = new SessaoTela('u', 'p', falso);
  assert.equal(await s.lerAtendimento(1), null);
  assert.equal((await s.lerAtendimento(2))?.formaPagamento, 'PIX');
  assert.equal(s.quebrada, false);
});

test('abrirSessaoTela: sem login no ambiente ou unidade fora do mapa não faz requisição nenhuma', async () => {
  let pediu = 0;
  const falso = (async () => { pediu++; return respostaFalsa(''); }) as unknown as typeof fetch;
  assert.equal(await abrirSessaoTela('doutor-hernia-serra', {}, falso), null);
  assert.equal(await abrirSessaoTela('unidade-que-nao-existe', { FRANQUIA_TELA_USER: 'u', FRANQUIA_TELA_PASS: 'p' }, falso), null);
  assert.equal(pediu, 0);
});

test('abrirSessaoTela: login que não abre a agenda dá null', async () => {
  const falso = (async () => respostaFalsa('<html>senha errada</html>')) as unknown as typeof fetch;
  assert.equal(await abrirSessaoTela('doutor-hernia-serra', { FRANQUIA_TELA_USER: 'u', FRANQUIA_TELA_PASS: 'p' }, falso), null);
});

test('aviso do WhatsApp: título com a unidade, causa, efeito e o que fazer — e cada problema tem o seu texto', () => {
  const sessao = montarAvisoDaTela('Açailândia', 'sessao');
  assert.match(sessao, /^🚨 \*Robô da franquia perdeu a sessão\* — Açailândia/);
  for (const trecho of ['*O que houve:*', '*Provável causa:*', '*Efeito agora:*', '*O que fazer:*', 'FRANQUIA_TELA_PASS']) assert.ok(sessao.includes(trecho), trecho);
  assert.notEqual(sessao, montarAvisoDaTela('Açailândia', 'layout'));
  assert.notEqual(sessao, montarAvisoDaTela('Açailândia', 'entrar'));
  assert.ok(montarAvisoDaTela('Serra', 'layout').includes('franquia-tela.ts'));
});

test('a página real tem DOIS selects id_form_payment: o 1º quebrado (erros de PHP, nada marcado), o 2º com o valor — lê o 2º', () => {
  const quebrado = '<select class="form-control select2" name="id_form_payment"><option value="NULL">Selecione</option>'
    + '<option value="1" \n<div style="border:1px solid #990000"><h4>A PHP Error was encountered</h4><p>Message: Trying to get property \'id_form_payment\' of non-object</p></div>>DINHEIRO</option></select>';
  const limpo = '<select class="form-control select2" name="id_form_payment"><option value="NULL">Selecione</option><option value="1" >DINHEIRO</option><option value="15" selected>CRÉDITO 12X</option></select>';
  const html = tela().replace(/<select class="form-select" name="id_form_payment"[\s\S]*?<\/select>/, quebrado + limpo);
  assert.equal(lerAtendimentoDaTela(html)!.formaPagamento, 'CRÉDITO 12X');
  // e na ordem inversa também
  assert.equal(lerAtendimentoDaTela(tela().replace(/<select class="form-select" name="id_form_payment"[\s\S]*?<\/select>/, limpo + quebrado))!.formaPagamento, 'CRÉDITO 12X');
  // nenhum marcado em nenhum dos dois: continua vazio
  assert.equal(lerAtendimentoDaTela(tela().replace(/<select class="form-select" name="id_form_payment"[\s\S]*?<\/select>/, quebrado + quebrado))!.formaPagamento, null);
});
