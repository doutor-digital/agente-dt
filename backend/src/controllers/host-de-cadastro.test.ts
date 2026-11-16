/**
 * cadastro.doutordigitalconsultoria.com serve SÓ o formulário. Provado em duas camadas: (1) o servidor (express real, cabeçalho Host de verdade): outras rotas do agente NÃO respondem por
 * esse host; (2) o label do Traefik no docker-compose (Host && PathPrefix, roteador próprio, regra da API intacta).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.KOMMO_SUBDOMAIN ??= 't';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@localhost:5432/z';
process.env.SESSION_JWT_SECRET ??= 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const express = (await import('express')).default;
const { HOST_DE_CADASTRO, ligarNovaClinica, limitesPadrao, somenteCadastroNoHostDeCadastro } = await import('./nova-clinica.controller.js');
const { criarConvite } = await import('../lib/kit-unidade/convites.js');
const { bancoConvitesFalso } = await import('../lib/kit-unidade/convites-falso.js');
const { respostasValidas } = await import('../lib/kit-unidade/formulario-exemplo.js');

const servidores: Server[] = [];
after(() => servidores.forEach((s) => s.close()));

async function subir() {
  const banco = bancoConvitesFalso();
  const tocou: string[] = [];
  const app = express();
  app.use(somenteCadastroNoHostDeCadastro()); // PRIMEIRA, como no server.ts
  ligarNovaClinica(app, { banco, avisar: async () => {}, agora: () => new Date(), limites: limitesPadrao() });
  // «o resto do agente»: qualquer rota que NÃO seja o formulário (a API, os painéis, a pausa…); registra se alguém chegou nela
  app.all('/{*resto}', (req, res) => { tocou.push(`${req.method} ${req.path}`); res.json({ ok: 'rota do agente' }); });
  const server = await new Promise<Server>((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  servidores.push(server);
  const porta = (server.address() as AddressInfo).port;
  const chamar = (host: string, metodo: string, caminho: string, corpo?: unknown) =>
    new Promise<{ status: number; texto: string }>((ok, erro) => {
      const dados = corpo === undefined ? undefined : JSON.stringify(corpo);
      const r = request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho, headers: { host, ...(dados ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dados) } : {}) } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => ok({ status: res.statusCode!, texto: t }));
      });
      r.on('error', erro);
      if (dados) r.write(dados);
      r.end();
    });
  return { banco, tocou, chamar };
}

test('no host de cadastro, outras rotas do agente NÃO respondem (404), e nem chegam ao handler', async () => {
  const s = await subir();
  const rotas: Array<[string, string]> = [['GET', '/api/health'], ['GET', '/api/units'], ['POST', '/api/auth/login'], ['GET', '/pausa/doutor-hernia-serra'], ['GET', '/aprendizados/x'], ['GET', '/funil'], ['GET', '/mcp'], ['GET', '/'], ['DELETE', '/api/public/nova-clinica/abc'], ['PUT', '/nova-clinica/abc'], ['GET', '/api/public/nova-clinica/abc'], ['POST', '/nova-clinica/abc'], ['GET', '/nova-clinica/'], ['GET', '/nova-clinica/abc/extra'], ['GET', '/nova-clinica'], ['GET', '/docs/qualquer']];
  for (const [m, c] of rotas) {
    const r = await s.chamar(HOST_DE_CADASTRO, m, c, m === 'POST' || m === 'PUT' ? {} : undefined);
    assert.equal(r.status, 404, `${m} ${c}`);
    assert.doesNotMatch(r.texto, /rota do agente/, `${m} ${c}`);
  }
  assert.deepEqual(s.tocou, [], 'nenhuma rota do agente foi alcançada pelo host de cadastro');
});

test('no host de cadastro o formulário FUNCIONA (página e envio); maiúscula e porta no Host não escapam da regra', async () => {
  const s = await subir();
  const c = await criarConvite(s.banco, { rotulo: 'x', criadoPor: 'j' });
  const pagina = await s.chamar(HOST_DE_CADASTRO, 'GET', `/nova-clinica/${c.codigo}`);
  assert.equal(pagina.status, 200);
  assert.match(pagina.texto, /Cadastro da sua clínica/);
  const envio = await s.chamar(HOST_DE_CADASTRO, 'POST', `/api/public/nova-clinica/${c.codigo}`, respostasValidas());
  assert.equal(envio.status, 200, envio.texto);
  for (const host of ['CADASTRO.DoutorDigitalConsultoria.com', `${HOST_DE_CADASTRO}:443`]) assert.equal((await s.chamar(host, 'GET', '/api/health')).status, 404, host);
  assert.deepEqual(s.tocou, []);
});

test('nos OUTROS hosts nada muda: a API e o formulário seguem como estavam', async () => {
  const s = await subir();
  const c = await criarConvite(s.banco, { rotulo: 'x', criadoPor: 'j' });
  for (const host of ['agente-vps.doutordigitalconsultoria.com', 'automacao.doutordigitalconsultoria.com', 'franquia.doutordigitalconsultoria.com', '127.0.0.1']) {
    assert.equal((await s.chamar(host, 'GET', '/api/health')).status, 200, host);
    assert.equal((await s.chamar(host, 'GET', `/nova-clinica/${c.codigo}`)).status, 200, host);
  }
  assert.ok(s.tocou.length >= 4);
});

test('docker-compose: roteador PRÓPRIO do Traefik com Host + PathPrefix (só /nova-clinica/ e /api/public/nova-clinica/); a regra da API não ganhou o host de cadastro', () => {
  const compose = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docker-compose.yml'), 'utf8');
  const label = (nome: string) => compose.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`- traefik.http.routers.${nome}.`));
  const novo = label('ddagentcadastro');
  assert.ok(novo.includes('- traefik.http.routers.ddagentcadastro.rule=Host(`cadastro.doutordigitalconsultoria.com`) && (PathPrefix(`/nova-clinica/`) || PathPrefix(`/api/public/nova-clinica/`))'), novo.join('\n'));
  assert.ok(novo.includes('- traefik.http.routers.ddagentcadastro.entrypoints=websecure'));
  assert.ok(novo.includes('- traefik.http.routers.ddagentcadastro.tls.certresolver=letsencryptresolver'));
  assert.ok(novo.includes('- traefik.http.routers.ddagentcadastro.service=ddagent'), 'aponta para o MESMO serviço (porta 8080)');
  // a regra que serve a API/painéis continua como era: o host de cadastro NÃO entrou nela (senão serviria tudo)
  const antiga = label('ddagent').find((l) => l.includes('.rule='))!;
  assert.ok(antiga.includes('Host(`${AGENT_DOMAIN}`)') && antiga.includes('automacao.doutordigitalconsultoria.com') && antiga.includes('franquia.doutordigitalconsultoria.com'));
  assert.ok(!antiga.includes('cadastro.'), 'o host de cadastro não pode estar na regra ampla');
  // o domínio vai LITERAL (variável que falta no .env viraria Host(``) e derrubaria o roteamento)
  assert.ok(!novo.some((l) => l.includes('${')));
  assert.equal(HOST_DE_CADASTRO, 'cadastro.doutordigitalconsultoria.com');
});
