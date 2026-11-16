/**
 * O formulário público «nova clínica» de ponta a ponta no express de verdade (porta efêmera, `fetch` real): página, envio, uso único, resposta IGUAL para
 * qualquer código ruim, limite de taxa, tamanho do corpo e que nenhum dado pessoal vai ao aviso do João.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.KOMMO_SUBDOMAIN ??= 't';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@localhost:5432/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const express = (await import('express')).default;
const { ligarNovaClinica, limitesPadrao } = await import('./nova-clinica.controller.js');
const { criarConvite } = await import('../lib/kit-unidade/convites.js');
const { bancoConvitesFalso } = await import('../lib/kit-unidade/convites-falso.js');
const { respostasValidas } = await import('../lib/kit-unidade/formulario-exemplo.js');

const servidores: Server[] = [];
after(() => {
  for (const s of servidores) s.close();
});

async function subir(opcoes: { limites?: ReturnType<typeof limitesPadrao>; avisarFalha?: boolean } = {}) {
  const banco = bancoConvitesFalso();
  const avisos: string[] = [];
  const app = express();
  // o servidor de verdade tem um express.json de 1 MB DEPOIS destas rotas: aqui também, para provar que a rota usa o seu próprio teto
  ligarNovaClinica(app, {
    banco,
    avisar: async (t) => {
      avisos.push(t);
      if (opcoes.avisarFalha) throw new Error('evolution caiu');
    },
    agora: () => new Date(),
    limites: opcoes.limites ?? limitesPadrao(),
  });
  app.use(express.json({ limit: '1mb' }));
  const server = await new Promise<Server>((ok) => {
    const s = app.listen(0, '127.0.0.1', () => ok(s));
  });
  servidores.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (codigo: string, corpo: unknown, ip = '203.0.113.1', bruto?: string) =>
    fetch(`${base}/api/public/nova-clinica/${codigo}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: bruto ?? JSON.stringify(corpo) });
  const pagina = (codigo: string, ip = '203.0.113.1') => fetch(`${base}/nova-clinica/${codigo}`, { headers: { 'x-forwarded-for': ip } });
  const convite = () => criarConvite(banco, { rotulo: 'Dra. Teste', criadoPor: 'joao' });
  return { banco, avisos, post, pagina, convite };
}

const semNonce = (html: string) => html.replace(/nonce="[^"]+"/g, 'nonce=""');

test('página: 200 com o formulário, sem cache, sem indexar, política de segurança com nonce — e o código NÃO aparece no HTML', async () => {
  const s = await subir();
  const c = await s.convite();
  const r = await s.pagina(c.codigo);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Cadastro da sua clínica/);
  assert.ok(!html.includes(c.codigo));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('x-robots-tag')!, /noindex/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const csp = r.headers.get('content-security-policy')!;
  const nonce = /nonce-([^']+)'/.exec(csp)![1]!;
  assert.ok(html.includes(`nonce="${nonce}"`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('envio válido: 200 «recebido», grava, avisa o João SEM dado pessoal, e o código não vale mais', async () => {
  const s = await subir();
  const c = await s.convite();
  const r = await s.post(c.codigo, respostasValidas());
  assert.equal(r.status, 200);
  const j = (await r.json()) as { ok: boolean; referencia: string };
  assert.equal(j.ok, true);
  assert.match(j.referencia, /^[a-z0-9]{6}$/);
  assert.ok(s.banco.linhas[0]!.id.endsWith(j.referencia), 'a referência é o fim do id do formulário (o que o João usa no kit)');
  assert.equal(s.banco.linhas[0]!.respostas?.clinica.nome, 'Doutor Hérnia Serra');
  assert.equal(s.avisos.length, 1);
  assert.match(s.avisos[0]!, /Doutor Hérnia Serra \(Serra\/ES\)\. Para abrir a clínica \(do seu computador\): bash ops\/kit-unidade\/abrir-clinica-joao\.sh doutor-hernia-serra --do-formulario /);
  assert.ok(s.avisos[0]!.includes(s.banco.linhas[0]!.id));
  // nenhum dado pessoal no aviso
  for (const pii of ['clinica.example', 'celular@', '99999', '3333-4444', 'pix-teste', 'Clínica Teste Ltda', '350', '+55', 'Ana Teste', 'Gerente Teste']) assert.ok(!s.avisos[0]!.includes(pii), `vazou no aviso: ${pii}`);
  // uso único
  const de_novo = await s.post(c.codigo, respostasValidas());
  assert.equal(de_novo.status, 404);
  assert.equal((await s.pagina(c.codigo)).status, 404);
  assert.equal(s.avisos.length, 1, 'o segundo envio não avisa de novo');
});

test('o aviso ao João falhar NÃO derruba o envio (já está gravado)', async () => {
  const s = await subir({ avisarFalha: true });
  const c = await s.convite();
  const r = await s.post(c.codigo, respostasValidas());
  assert.equal(r.status, 200);
  assert.ok(s.banco.linhas[0]!.respostas);
});

test('dados inválidos: 422 com mensagem por campo em português, NÃO gasta o código, e dá para reenviar corrigido', async () => {
  const s = await subir();
  const c = await s.convite();
  const ruim = { ...respostasValidas(), clinica: { ...respostasValidas().clinica, nome: 'ab' }, confirmou: false };
  const r = await s.post(c.codigo, ruim);
  assert.equal(r.status, 422);
  const j = (await r.json()) as { campos: Record<string, string> };
  assert.match(j.campos['clinica.nome']!, /Nome da clínica/);
  assert.ok(j.campos['confirmou']);
  assert.equal(s.banco.linhas[0]!.enviadoEm, null);
  assert.equal(s.avisos.length, 0);
  assert.equal((await s.post(c.codigo, respostasValidas())).status, 200);
});

test('código errado, mal formado, vencido, usado e revogado: a MESMA resposta (status e corpo), na página e no envio', async () => {
  const s = await subir();
  const usado = await s.convite();
  await s.post(usado.codigo, respostasValidas());
  const revogado = await s.convite();
  await s.banco.revogar(s.banco.linhas[1]!.id, new Date());
  const vencido = await criarConvite(s.banco, { rotulo: 'v', criadoPor: 'j', agora: new Date('2020-01-01T00:00:00Z') });
  const ruins = [usado.codigo, revogado.codigo, vencido.codigo, 'A'.repeat(24), 'curto', 'x'.repeat(200)];
  const paginas = new Set<string>();
  const envios = new Set<string>();
  for (const [i, codigo] of ruins.entries()) {
    const ip = `198.51.100.${i + 1}`; // um IP por tentativa: aqui o que se mede é a resposta, não o limite
    const p = await s.pagina(codigo, ip);
    assert.equal(p.status, 404, codigo);
    paginas.add(semNonce(await p.text()));
    const e = await s.post(codigo, respostasValidas(), ip);
    assert.equal(e.status, 404, codigo);
    envios.add(await e.text());
  }
  assert.equal(paginas.size, 1, 'a página de link inválido é idêntica para todos os motivos');
  assert.equal(envios.size, 1, 'o corpo do envio recusado é idêntico para todos os motivos');
});

test('chutar códigos: depois de 10 erros o IP leva 429 — com código errado OU certo (sem oráculo) —, outro IP não é afetado', async () => {
  const s = await subir();
  const bom = await s.convite();
  for (let i = 0; i < 10; i++) assert.equal((await s.pagina('B'.repeat(24), '203.0.113.50')).status, 404);
  const r = await s.pagina('B'.repeat(24), '203.0.113.50');
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await s.pagina(bom.codigo, '203.0.113.50')).status, 429, 'bloqueado é bloqueado: o código certo também leva 429');
  assert.equal((await s.post(bom.codigo, respostasValidas(), '203.0.113.50')).status, 429);
  assert.equal((await s.pagina(bom.codigo, '203.0.113.51')).status, 200, 'outro IP segue normal');
});

test('limite de envios: conta só o envio ACEITO (quem erra o formulário e corrige não fica preso), tem folga larga para os 422 e um teto global', async () => {
  const s = await subir();
  const c = await s.convite();
  // 30 tentativas com erro (422) do mesmo IP NÃO travam: o franqueado corrige e envia
  for (let i = 0; i < 30; i++) assert.equal((await s.post(c.codigo, {}, '203.0.113.60')).status, 422, `tentativa ${i}`);
  assert.equal((await s.post(c.codigo, respostasValidas(), '203.0.113.60')).status, 200, 'depois de 30 erros, o envio certo passa');
  // 10 envios ACEITOS por hora por IP; o 11º leva 429
  for (let i = 0; i < 9; i++) {
    const outro = await s.convite();
    assert.equal((await s.post(outro.codigo, respostasValidas(), '203.0.113.61')).status, 200, `aceito ${i}`);
  }
  const dez = await s.convite();
  assert.equal((await s.post(dez.codigo, respostasValidas(), '203.0.113.61')).status, 200, '10º aceito');
  const onze = await s.convite();
  assert.equal((await s.post(onze.codigo, respostasValidas(), '203.0.113.61')).status, 429, '11º envio aceito do mesmo IP na hora');
  // QUALQUER POST (aceito ou não) tem teto de 60/h por IP: spam de 422 não passa
  const x = await s.convite();
  for (let i = 0; i < 60; i++) assert.notEqual((await s.post(x.codigo, {}, '203.0.113.62')).status, 429, `tentativa ${i}`);
  assert.equal((await s.post(x.codigo, {}, '203.0.113.62')).status, 429, '61ª tentativa');

  const g = await subir();
  // quem chuta código errado, ou erra o formulário, NÃO gasta o teto global (senão 10 IPs travariam todos os franqueados)
  const c2 = await g.convite();
  for (let i = 0; i < 150; i++) assert.equal((await g.post('Z'.repeat(24), {}, `198.51.100.${i % 250}`)).status, 404);
  for (let i = 0; i < 150; i++) assert.equal((await g.post(c2.codigo, {}, `198.51.101.${i % 250}`)).status, 422);
  // o teto é de 100 envios ACEITOS por hora, de qualquer IP
  for (let i = 0; i < 100; i++) {
    const novo = await g.convite();
    assert.equal((await g.post(novo.codigo, respostasValidas(), `192.0.2.${i % 250}`)).status, 200, `envio ${i}`);
  }
  const ultimo = await g.convite();
  assert.equal((await g.post(ultimo.codigo, respostasValidas(), '192.0.2.251')).status, 429, 'teto global: o 101º envio aceito, de qualquer IP');
});

test('429 na PÁGINA é uma tela amigável em HTML (não JSON cru), com Retry-After', async () => {
  const s = await subir();
  const bom = await s.convite();
  for (let i = 0; i < 10; i++) await s.pagina('B'.repeat(24), '203.0.113.80');
  const r = await s.pagina(bom.codigo, '203.0.113.80');
  assert.equal(r.status, 429);
  assert.match(r.headers.get('content-type')!, /text\/html/);
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  const html = await r.text();
  assert.match(html, /Muitas tentativas/);
  assert.match(html, /minuto/);
  assert.doesNotMatch(html, /muitas_tentativas|\{"erro"/);
  // o envio (API) continua respondendo JSON
  const api = await s.post(bom.codigo, respostasValidas(), '203.0.113.80');
  assert.equal(api.status, 429);
  assert.equal(((await api.json()) as { erro: string }).erro, 'muitas_tentativas');
});

test('caractere de controle em qualquer campo (ESC no link do mapa, por exemplo) é recusado com 422 e não vai para o banco', async () => {
  const s = await subir();
  const c = await s.convite();
  const ruim = respostasValidas();
  ruim.clinica.mapa_url = 'https://maps.example/x\u001b[31m';
  const r = await s.post(c.codigo, ruim);
  assert.equal(r.status, 422);
  assert.match(((await r.json()) as { campos: Record<string, string> }).campos['clinica.mapa_url']!, /caractere invisível/);
  assert.equal(s.banco.linhas[0]!.enviadoEm, null);
});

test('corpo: mais de 64 KB é 413 (o teto do servidor é 1 MB, a rota tem o dela); JSON quebrado é 400; nada do corpo é devolvido', async () => {
  const s = await subir();
  const c = await s.convite();
  const grande = await s.post(c.codigo, { lixo: 'x'.repeat(70_000) });
  assert.equal(grande.status, 413);
  assert.deepEqual(await grande.json(), { erro: 'corpo_grande_demais' });
  const quebrado = await s.post(c.codigo, null, '203.0.113.2', '{"quem": ');
  assert.equal(quebrado.status, 400);
  assert.deepEqual(await quebrado.json(), { erro: 'corpo_invalido' });
  assert.equal(s.banco.linhas[0]!.enviadoEm, null);
});

test('IP vem do FIM do X-Forwarded-For: mudar o começo do cabeçalho não escapa do limite', async () => {
  const s = await subir();
  for (let i = 0; i < 10; i++) await s.pagina('C'.repeat(24), `1.1.1.${i}, 203.0.113.70`);
  assert.equal((await s.pagina('C'.repeat(24), '8.8.8.8, 203.0.113.70')).status, 429);
});
