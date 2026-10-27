import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compararComAMeta, conferirModeloNaMeta, definicaoParaAUnidade, impressaoDaOnda, podeAprovar, type Definicao } from './disparo/modelo.js';

const DEF: Definicao = { template: 'canaa_resgate_150_arte', idioma: 'pt_BR', textoModelo: 'Oi {{1}}!\nSua consulta custa R$ 150.', variaveis: ['primeiroNome'], cabecalho: { tipo: 'image', link: 'https://x.com/arte4.jpg' } };
const META_OK = [{
  name: 'canaa_resgate_150_arte', language: 'pt_BR', status: 'APPROVED',
  components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oi {{1}}!  Sua consulta custa R$ 150.' }, { type: 'FOOTER', text: 'Responda SAIR' }],
}];

test('definição: o que a campanha diz para a unidade vale; senão o padrão da campanha', () => {
  const campanha = {
    template: 'padrao', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], cabecalho: { tipo: 'image', link: 'https://x.com/padrao.jpg' },
    porUnidade: { 'doutor-hernia-canaa': { template: 'canaa_x', cabecalho: { tipo: 'image', link: 'https://x.com/arte4.jpg' } }, 'doutor-hernia-acailandia': { cabecalho: null } },
  };
  assert.deepEqual(definicaoParaAUnidade(campanha, 'doutor-hernia-canaa'), { template: 'canaa_x', idioma: 'pt_BR', textoModelo: 'Oi {{1}}', variaveis: ['primeiroNome'], cabecalho: { tipo: 'image', link: 'https://x.com/arte4.jpg' } });
  const outra = definicaoParaAUnidade(campanha, 'doutor-hernia-balsas') as Definicao;
  assert.equal(outra.template, 'padrao');
  assert.equal(outra.cabecalho?.link, 'https://x.com/padrao.jpg');
  assert.equal((definicaoParaAUnidade(campanha, 'doutor-hernia-acailandia') as Definicao).cabecalho, null, 'null na unidade tira a mídia do padrão');
  assert.ok('erro' in definicaoParaAUnidade({ ...campanha, template: null, porUnidade: {} }, 'x'));
  assert.ok('erro' in definicaoParaAUnidade({ ...campanha, porUnidade: { x: { cabecalho: { tipo: 'image', link: 'http://sem-https.com/a.jpg' } } } }, 'x'));
});

test('impressão: muda se muda o texto, a mídia ou UMA pessoa; não muda com a ordem', () => {
  const p = [{ chave: 'a', nome: 'Ana' }, { chave: 'b', nome: 'Bia' }];
  const base = impressaoDaOnda(DEF, p);
  assert.equal(impressaoDaOnda(DEF, [...p].reverse()), base);
  assert.notEqual(impressaoDaOnda({ ...DEF, textoModelo: 'outro' }, p), base);
  assert.notEqual(impressaoDaOnda({ ...DEF, cabecalho: null }, p), base);
  assert.notEqual(impressaoDaOnda(DEF, [...p, { chave: 'c', nome: 'Cris' }]), base);
  assert.notEqual(impressaoDaOnda(DEF, [{ chave: 'a', nome: 'Ana' }, { chave: 'b', nome: 'Beatriz' }]), base);
});

test('quem aprova: só e-mail da lista; sem a variável NINGUÉM aprova', () => {
  const env = { DISPARO_APROVADORES: ' Joao@Exemplo.com , outro@x.com ' } as NodeJS.ProcessEnv;
  assert.equal(podeAprovar('joao@exemplo.com', env), true);
  assert.equal(podeAprovar('intruso@x.com', env), false);
  assert.equal(podeAprovar(undefined, env), false, 'chave de serviço não tem e-mail');
  assert.equal(podeAprovar('joao@exemplo.com', {} as NodeJS.ProcessEnv), false, 'variável ausente = fechado');
  assert.equal(podeAprovar('joao@exemplo.com', { DISPARO_APROVADORES: '' } as NodeJS.ProcessEnv), false);
});

test('Meta: modelo aprovado, texto igual (espaço não conta) e mídia batendo → ok', () => {
  assert.deepEqual(compararComAMeta(DEF, META_OK), { ok: true });
});

test('Meta: recusa modelo que não existe, que não está APPROVED ou cujo texto mudou', () => {
  assert.match((compararComAMeta(DEF, []) as { motivo: string }).motivo, /não tem o modelo/);
  assert.match((compararComAMeta(DEF, [{ ...META_OK[0]!, status: 'PENDING' }]) as { motivo: string }).motivo, /PENDING/);
  const outroTexto = [{ ...META_OK[0]!, components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Oi {{1}}! Consulta por R$ 200.' }] }];
  assert.match((compararComAMeta(DEF, outroTexto) as { motivo: string }).motivo, /texto do modelo na Meta é diferente/);
  assert.match((compararComAMeta(DEF, [{ ...META_OK[0]!, language: 'en_US' }]) as { motivo: string }).motivo, /não tem o modelo/);
});

test('Meta: o erro de 14/10 — modelo SÓ TEXTO aprovado e arte anexada (ou o contrário) — é barrado na aprovação', () => {
  const soTexto = [{ ...META_OK[0]!, components: [{ type: 'BODY', text: DEF.textoModelo }] }];
  assert.match((compararComAMeta(DEF, soTexto) as { motivo: string }).motivo, /não tem \(a Meta recusa/);
  const comMidia = (compararComAMeta({ ...DEF, cabecalho: null }, META_OK) as { motivo: string }).motivo;
  assert.match(comMidia, /cabeçalho de image e a campanha não definiu/);
  assert.match((compararComAMeta({ ...DEF, cabecalho: { tipo: 'video', link: 'https://x.com/v.mp4' } }, META_OK) as { motivo: string }).motivo, /cabeçalho do modelo é image/);
});

test('Meta: botão com URL variável e cabeçalho de texto com variável não são suportados', () => {
  const comBotao = [{ ...META_OK[0]!, components: [...META_OK[0]!.components, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.com/{{1}}' }] }] }];
  assert.match((compararComAMeta(DEF, comBotao) as { motivo: string }).motivo, /botão com variável/);
  const cabTexto = [{ ...META_OK[0]!, components: [{ type: 'HEADER', format: 'TEXT', text: 'Oi {{1}}' }, META_OK[0]!.components[1]!] }];
  assert.match((compararComAMeta({ ...DEF, cabecalho: null }, cabTexto) as { motivo: string }).motivo, /cabeçalho de texto com variável/);
});

test('conferir na Meta: sem credencial, sem WABA id, sem resposta ou com erro de rede → recusa (na dúvida, não aprova)', async () => {
  const unit = { metaPhoneNumberId: '1', metaAccessToken: 't', metaWabaId: 'w1' };
  const ok = await conferirModeloNaMeta(unit, DEF, async (url, token) => {
    assert.match(url, /\/w1\/message_templates\?name=canaa_resgate_150_arte/);
    assert.equal(token, 't');
    return { ok: true, corpo: { data: META_OK } };
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal((await conferirModeloNaMeta({ ...unit, metaAccessToken: null }, DEF, async () => ({ ok: true, corpo: { data: META_OK } }))).ok, false);
  assert.match(((await conferirModeloNaMeta({ ...unit, metaWabaId: null }, DEF, async () => ({ ok: true, corpo: { data: META_OK } }))) as { motivo: string }).motivo, /WABA id/);
  assert.equal((await conferirModeloNaMeta(unit, DEF, async () => ({ ok: false, corpo: null }))).ok, false);
  assert.equal((await conferirModeloNaMeta(unit, DEF, async () => { throw new Error('rede'); })).ok, false);
});
