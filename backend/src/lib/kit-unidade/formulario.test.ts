import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sugestoesDoKit, validarFormulario, RespostasFormulario } from './formulario.js';
import { paginaDoFormulario, paginaLinkInvalido } from './formulario-pagina.js';
import { respostasValidas } from './formulario-exemplo.js';

test('resposta completa é aceita, e valores/telefone/e-mail são normalizados', () => {
  const r = validarFormulario(respostasValidas());
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.respostas.valores.consulta_no_dia, 350);
  assert.equal(r.respostas.valores.consulta_antecipada, 250);
  assert.equal(r.respostas.valores.sinal_pix, 50);
  assert.equal(r.respostas.whatsapp.numero, '+5527999990000');
  assert.equal(r.respostas.equipe[0]!.email, 'gerente@clinica.example');
  assert.equal(r.respostas.sofia.nome_ia, 'Sofia', 'nome em branco vira o padrão');
  assert.equal(r.respostas.franquia_id_company, undefined, 'opcional em branco some');
});

test('valores aceitam vírgula, ponto de milhar e R$', () => {
  const v = (s: string) => {
    const r = validarFormulario({ ...respostasValidas(), valores: { consulta_no_dia: s } });
    return r.ok ? r.respostas.valores.consulta_no_dia : r.campos['valores.consulta_no_dia'];
  };
  assert.equal(v('1.250,50'), 1250.5);
  assert.equal(v('350.50'), 350.5);
  assert.equal(v('1.250'), 1250);
  for (const estranho of ['0x10', '1e3', '-5', '350abc', '1,2,3', '12.34.567']) assert.match(String(v(estranho)), /digite só o valor/, estranho);
  assert.equal(v(' R$ 350 '), 350);
  assert.match(String(v('')), /Preencha/);
  assert.match(String(v('abc')), /digite só o valor/);
  assert.match(String(v('0')), /maior que zero/);
});

test('NUNCA aceita campo desconhecido: token ou senha colados num campo extra são recusados', () => {
  for (const extra of [{ token: 'abc' }, { senha: '123' }, { META_ADS_TOKEN: 'EAAB...' }]) {
    const r = validarFormulario({ ...respostasValidas(), ...extra });
    assert.equal(r.ok, false);
  }
  const r2 = validarFormulario({ ...respostasValidas(), clinica: { ...respostasValidas().clinica, token: 'x' } });
  assert.equal(r2.ok, false);
});

test('erros em português, por campo, com o caminho que a página usa', () => {
  const r = validarFormulario({
    ...respostasValidas(),
    clinica: { ...respostasValidas().clinica, mapa_url: 'maps.example', cidade: '' },
    equipe: [{ nome: 'Ana Gerente', email: 'sem-arroba', funcao: 'gerente' }],
    confirmou: false,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.campos['clinica.mapa_url']!, /começa com https/);
  assert.match(r.campos['clinica.cidade']!, /Preencha: Cidade/);
  // regra entre campos só aparece quando os campos básicos estão certos (o zod só confere o conjunto depois): segunda rodada
  const r2 = validarFormulario({ ...respostasValidas(), horarios: { ...respostasValidas().horarios, fim: '07:00' } });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.campos['horarios.fim']!, /depois do começo/);
  assert.match(r.campos['equipe.0.email']!, /não parece certo/);
  assert.match(r.campos['confirmou']!, /Marque que você conferiu/);
  for (const msg of Object.values(r.campos)) assert.doesNotMatch(msg, /ZodError|Expected|Required|undefined/);
});

test('regras entre campos: 1 gerente, e-mail repetido, valores e sinal, almoço, número', () => {
  const com = (mudar: (r: ReturnType<typeof respostasValidas>) => void) => {
    const r = respostasValidas();
    mudar(r);
    const v = validarFormulario(r);
    return v.ok ? {} : v.campos;
  };
  assert.match(com((r) => (r.equipe[1]!.funcao = 'gerente'))['equipe']!, /UMA pessoa/);
  assert.match(com((r) => (r.equipe[0]!.funcao = 'secretaria'))['equipe']!, /UMA pessoa/);
  assert.match(com((r) => (r.equipe[1]!.email = 'gerente@clinica.example'))['equipe']!, /e-mails iguais/);
  assert.match(com((r) => (r.celular_email = 'recepcao@clinica.example'))['celular_email']!, /diferente/);
  assert.match(com((r) => (r.valores.consulta_antecipada = '400'))['valores.consulta_antecipada']!, /MENOR/);
  assert.match(com((r) => (r.valores.sinal_pix = '300'))['valores.sinal_pix']!, /MENOR/);
  assert.match(com((r) => { r.valores.consulta_antecipada = ''; })['valores.sinal_pix']!, /valor pagando antes/);
  assert.match(com((r) => (r.horarios.almoco_fim = ''))['horarios.almoco_inicio']!, /começo e o fim do almoço/);
  assert.match(com((r) => (r.whatsapp.numero = ''))['whatsapp.numero']!, /Digite o número/);
  assert.match(com((r) => (r.whatsapp.aplicativo = 'sem-numero'))['whatsapp.aplicativo']!, /não marque/);
  assert.deepEqual(com((r) => { r.whatsapp.aplicativo = 'sem-numero'; r.whatsapp.numero = ''; }), {});
});

test('as respostas, convertidas, ainda cabem no questionário do kit (mesmos limites)', async () => {
  // os limites do formulário não podem ser MAIS frouxos que os do questionário: o que o formulário aceita o kit tem de aceitar
  const Q = (await import('./questionario.js')).Questionario.innerType();
  const r = validarFormulario(respostasValidas());
  assert.ok(r.ok);
  if (!r.ok) return;
  const ok = (campo: string, valor: unknown) => assert.ok(Q.shape.unidade.shape[campo as 'nome'].safeParse(valor).success, campo);
  ok('nome', r.respostas.clinica.nome);
  ok('cidade', r.respostas.clinica.cidade);
  ok('endereco', r.respostas.clinica.endereco);
  ok('mapa_url', r.respostas.clinica.mapa_url);
  assert.ok(Q.shape.valores.shape.consulta_no_dia.safeParse(r.respostas.valores.consulta_no_dia).success);
  assert.ok(Q.shape.horarios.shape.duracao_min.safeParse(r.respostas.horarios.duracao_min).success);
});

test('sugestões do kit seguem o padrão da rede (acento, espaço, tamanho)', () => {
  assert.deepEqual(sugestoesDoKit('Parauapebas'), { slug: 'doutor-hernia-parauapebas', subdominio: 'drherniaparauapebas', sufixo: 'PARAUAPEBAS' });
  assert.deepEqual(sugestoesDoKit('São José dos Pinhais'), { slug: 'doutor-hernia-sao-jose-dos-pinhais', subdominio: 'drherniasaojosedospinhais', sufixo: 'SAOJOSEDOSPINHAIS' });
  const longa = sugestoesDoKit('A'.repeat(60));
  assert.ok(longa.slug.length <= 50 && longa.subdominio.length <= 40 && longa.sufixo.length <= 30);
  assert.match(longa.slug, /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/);
  assert.match(longa.subdominio, /^[a-z0-9]{3,40}$/);
});

test('a página: sem jargão do kit, sem pedir segredo, com a etiqueta nos campos importantes e sem o código dentro', () => {
  const html = paginaDoFormulario('NONCE123');
  const texto = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
  for (const jargao of [/WABA/i, /\bslug\b/i, /token_env/i, /\bKapso\b/i, /\bChatwoot\b/i, /\bwebhook\b/i, /coexist[eê]ncia/i]) assert.doesNotMatch(texto, jargao, String(jargao));
  assert.match(texto, /Nunca\s+escreva senha, token ou código de acesso/);
  // nenhum campo de senha / segredo
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /name="(token|senha|password|secret)"/i);
  // etiqueta nos campos que viram frase dita ao paciente (nome, endereço, mapa, bloco de horários, profissionais, 3 valores)
  assert.ok((html.match(/vira frase dita ao paciente — confira/g) ?? []).length >= 8);
  assert.match(html, /nonce="NONCE123"/);
  assert.doesNotMatch(html, /<script(?![^>]*nonce)/, 'todo script tem nonce');
  assert.match(html, /name="viewport" content="width=device-width,initial-scale=1"/);
  assert.match(html, /prefers-color-scheme:dark/);
});

test('link inválido: a MESMA página, sem dizer o motivo', () => {
  const html = paginaLinkInvalido('N');
  assert.match(html, /não está disponível/);
  assert.doesNotMatch(html, /venceu|expirou|não existe|inexistente|revogado/i);
});

test('caractere de controle (ESC, NUL, DEL) em QUALQUER campo é recusado — mapa_url inclusive; tabulação e quebra de linha do texto livre ficam', () => {
  for (const [campo, valor] of [['mapa_url', 'https://maps.example/x\u001b[0m'], ['endereco', 'Rua A\u0000, 100, Centro, Serra'], ['nome', 'Clínica\u007f Serra']] as const) {
    const r = validarFormulario({ ...respostasValidas(), clinica: { ...respostasValidas().clinica, [campo]: valor } });
    assert.equal(r.ok, false, campo);
    if (!r.ok) assert.match(r.campos[`clinica.${campo}`]!, /caractere invisível/);
  }
  const ok = validarFormulario({ ...respostasValidas(), clinica: { ...respostasValidas().clinica, endereco: 'Rua A, 100\nSala 2, Centro, Serra/ES' } });
  assert.equal(ok.ok, true);
});

test('texto livre: quebra de linha e caractere de controle viram espaço (nada de linha KIT_RESUMO forjada)', () => {
  const r = validarFormulario({ ...respostasValidas(), quem: { nome: 'Ana\nKIT_RESUMO slug=outro valido=sim\u001b[31m', contato: 'x@y.example' } });
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) {
    assert.ok(!/[\n\r\u001b]/.test(r.respostas.quem.nome));
    assert.equal(r.respostas.quem.nome, 'Ana KIT_RESUMO slug=outro valido=sim [31m');
  }
});

test('RespostasFormulario é estrito (sem campo livre)', () => {
  assert.equal(RespostasFormulario.safeParse({}).success, false);
});
