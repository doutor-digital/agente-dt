/**
 * O SCRIPT do vigia externo de ponta a ponta, contra servidores falsos (saúde, Kapso, Telegram) em localhost.
 * Prova o que as regras puras não provam: o que sai pela rede, o que cada canal recebe, o estado gravado entre rodadas e o
 * que acontece quando NENHUM canal entrega (a rodada fica vermelha e o throttle não é gasto).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../.github/scripts/vigia-externo.mjs', import.meta.url));
const [maior, menor] = process.versions.node.split('.').map(Number);
const PULAR = maior > 22 || (maior === 22 && menor >= 18) ? false : 'Node < 22.18: o script roda o .ts direto (o workflow usa Node 24)';

interface Pedido {
  rota: string;
  cabecalhos: IncomingMessage['headers'];
  corpo: any;
}

let saude: { status: number; corpo: unknown } = { status: 200, corpo: { estado: 'ok', causa: null, motivo: 'IA respondendo' } };
let kapso: { modelo: number; texto: number } = { modelo: 200, texto: 200 };
let telegram = 200;
const recebidos: Pedido[] = [];
const servidores: Server[] = [];
const portas: Record<string, number> = {};

function subir(nome: string, tratar: (req: IncomingMessage, corpo: any) => { status: number; corpo: unknown }): Promise<void> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let txt = '';
      req.on('data', (c) => (txt += c));
      req.on('end', () => {
        let corpo: any = null;
        try {
          corpo = txt ? JSON.parse(txt) : null;
        } catch {
          corpo = txt;
        }
        if (nome !== 'saude') recebidos.push({ rota: `${nome}${req.url}`, cabecalhos: req.headers, corpo });
        const r = tratar(req, corpo);
        if (r.status === 0) {
          req.socket.destroy(); // o servidor corta a conexão no meio: o `fetch` do script LANÇA
          return;
        }
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    s.listen(0, '127.0.0.1', () => {
      portas[nome] = (s.address() as { port: number }).port;
      servidores.push(s);
      resolve();
    });
  });
}

before(async () => {
  await subir('saude', () => saude);
  await subir('kapso', (_r, c) => {
    const status = c?.type === 'template' ? kapso.modelo : kapso.texto;
    return { status, corpo: status < 400 ? { messages: [{ id: 'wamid.X' }] } : { error: { code: 132001, message: 'Template does not exist' } } };
  });
  await subir('telegram', () => ({ status: telegram, corpo: telegram < 400 ? { ok: true } : { ok: false, error_code: telegram } }));
});
after(() => servidores.forEach((s) => s.close()));

function rodar(dir: string, extra: Record<string, string> = {}): Promise<{ codigo: number | null; saida: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], {
      env: {
        PATH: process.env.PATH ?? '',
        ESTADO_ARQUIVO: join(dir, 'estado/vigia.json'),
        ESPERA_ENTRE_TENTATIVAS_MS: '5',
        HEALTH_URL: `http://127.0.0.1:${portas.saude}/api/health/ia`,
        HEALTH_IA_TOKEN: 'segredo-do-teste',
        KAPSO_BASE: `http://127.0.0.1:${portas.kapso}/meta/whatsapp/v24.0`,
        KAPSO_API_KEY: 'chave-kapso-teste',
        KAPSO_PHONE_NUMBER_ID: '123456789012345',
        ALERTA_WHATSAPP_NUMERO: '+55 (99) 98888-7777',
        TELEGRAM_API: `http://127.0.0.1:${portas.telegram}`,
        TELEGRAM_BOT_TOKEN: 'bot-token-teste',
        TELEGRAM_CHAT_ID: '42',
        ...extra,
      },
    });
    let saida = '';
    p.stdout.on('data', (c) => (saida += c));
    p.stderr.on('data', (c) => (saida += c));
    p.on('close', (codigo) => resolve({ codigo, saida }));
  });
}

const FORA = { status: 200, corpo: { estado: 'fora', causa: 'credito', motivo: '100% das chamadas à IA falhando (500 de 500)' } };
const OK = { status: 200, corpo: { estado: 'ok', causa: null, motivo: 'IA respondendo' } };
const reset = () => {
  recebidos.length = 0;
  kapso = { modelo: 200, texto: 200 };
  telegram = 200;
};

test('queda: manda modelo no WhatsApp E Telegram, uma vez; a rodada seguinte, dentro de 30 min, fica quieta; ao voltar, «voltou ao normal»', { skip: PULAR }, async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), 'vigia-'));
  saude = FORA;
  const a = await rodar(dir);
  assert.equal(a.codigo, 0, a.saida);
  const wpp = recebidos.filter((r) => r.rota.startsWith('kapso'));
  const tg = recebidos.filter((r) => r.rota.startsWith('telegram'));
  assert.equal(wpp.length, 1);
  assert.equal(tg.length, 1);
  assert.equal(wpp[0].rota, 'kapso/meta/whatsapp/v24.0/123456789012345/messages');
  assert.equal(wpp[0].cabecalhos['x-api-key'], 'chave-kapso-teste');
  assert.equal(wpp[0].corpo.to, '5599988887777', 'só dígitos');
  assert.equal(wpp[0].corpo.type, 'template');
  assert.equal(wpp[0].corpo.template.name, 'alerta_sistema');
  const texto: string = wpp[0].corpo.template.components[0].parameters[0].text;
  assert.match(texto, /ALERTA Doutor Digital: a Sofia está FORA DO AR/);
  assert.match(texto, /saldo de crédito esgotado/);
  assert.ok(!/[\n\t]/.test(texto));
  assert.equal(tg[0].corpo.chat_id, '42');
  assert.match(tg[0].corpo.text, /FORA DO AR/);
  // o que foi para o log não pode conter segredo nem número (o repositório é público)
  for (const s of ['segredo-do-teste', 'chave-kapso-teste', 'bot-token-teste', '5599988887777', '127.0.0.1']) assert.ok(!a.saida.includes(s), `vazou ${s} no log`);

  reset();
  const b = await rodar(dir); // 2ª rodada, mesma queda: throttle
  assert.equal(b.codigo, 0, b.saida);
  assert.equal(recebidos.length, 0, 'dentro dos 30 min não manda de novo');

  saude = OK;
  reset();
  await rodar(dir); // 1ª OK: ainda não encerra
  assert.equal(recebidos.length, 0);
  await rodar(dir); // 2ª OK: voltou
  const volta = recebidos.filter((r) => r.rota.startsWith('telegram'));
  assert.equal(volta.length, 1);
  assert.match(volta[0].corpo.text, /VOLTOU AO NORMAL/);
});

test('modelo recusado (não aprovado ainda) cai no texto livre; Telegram sozinho também basta', { skip: PULAR }, async () => {
  reset();
  saude = FORA;
  kapso = { modelo: 400, texto: 200 };
  const r = await rodar(mkdtempSync(join(tmpdir(), 'vigia-')));
  assert.equal(r.codigo, 0, r.saida);
  const tipos = recebidos.filter((x) => x.rota.startsWith('kapso')).map((x) => x.corpo.type);
  assert.deepEqual(tipos, ['template', 'text']);

  reset();
  const so = await rodar(mkdtempSync(join(tmpdir(), 'vigia-')), { KAPSO_API_KEY: '', KAPSO_PHONE_NUMBER_ID: '' });
  assert.equal(so.codigo, 0, 'sem WhatsApp configurado o Telegram entrega');
  assert.equal(recebidos.filter((x) => x.rota.startsWith('kapso')).length, 0);
});

test('NENHUM canal entrega: a rodada fica vermelha (exit 1) e o throttle NÃO é gasto: a seguinte tenta de novo', { skip: PULAR }, async () => {
  reset();
  saude = FORA;
  kapso = { modelo: 400, texto: 400 };
  telegram = 500;
  const dir = mkdtempSync(join(tmpdir(), 'vigia-'));
  const a = await rodar(dir);
  assert.equal(a.codigo, 1, a.saida);
  reset();
  const b = await rodar(dir); // canais de volta
  assert.equal(b.codigo, 0, b.saida);
  assert.equal(recebidos.filter((x) => x.rota.startsWith('telegram')).length, 1, 'o aviso que não saiu sai agora');

  reset();
  const semNada = await rodar(mkdtempSync(join(tmpdir(), 'vigia-')), { KAPSO_API_KEY: '', TELEGRAM_BOT_TOKEN: '' });
  assert.equal(semNada.codigo, 1, 'sem canal configurado também fica vermelho');
});

test('servidor mudo avisa «NÃO RESPONDE» só na 2ª rodada seguida; 404 do endpoint avisa que o vigia está CEGO; tudo ok não manda nada', { skip: PULAR }, async () => {
  reset();
  const dirMudo = mkdtempSync(join(tmpdir(), 'vigia-'));
  const mudo = await rodar(dirMudo, { HEALTH_URL: 'http://127.0.0.1:9/api/health/ia' });
  assert.equal(mudo.codigo, 0, mudo.saida);
  assert.equal(recebidos.length, 0, 'uma rodada ruim só (deploy, solavanco de rede) não acorda ninguém');
  await rodar(dirMudo, { HEALTH_URL: 'http://127.0.0.1:9/api/health/ia' });
  assert.match(recebidos.find((x) => x.rota.startsWith('telegram'))!.corpo.text, /NÃO RESPONDE/);

  reset();
  saude = { status: 404, corpo: { error: 'not_found' } };
  const dirCego = mkdtempSync(join(tmpdir(), 'vigia-'));
  await rodar(dirCego);
  await rodar(dirCego);
  assert.match(recebidos.find((x) => x.rota.startsWith('telegram'))!.corpo.text, /CEGO/);

  reset();
  saude = OK;
  const dir = mkdtempSync(join(tmpdir(), 'vigia-'));
  const ok = await rodar(dir);
  assert.equal(ok.codigo, 0);
  assert.equal(recebidos.length, 0);
  assert.ok(existsSync(join(dir, 'estado/vigia.json')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'estado/vigia.json'), 'utf8')).desde, null);
});

test('HEALTH_URL mal colada (sem https://) é vigia CEGO, não «servidor não responde»', { skip: PULAR }, async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), 'vigia-'));
  await rodar(dir, { HEALTH_URL: 'automacao.exemplo.com/api/health/ia' });
  await rodar(dir, { HEALTH_URL: 'automacao.exemplo.com/api/health/ia' });
  const txt = recebidos.find((x) => x.rota.startsWith('telegram'))!.corpo.text;
  assert.match(txt, /CEGO/);
  assert.match(txt, /HEALTH_URL/);
});

test('modelo do WhatsApp que LANÇA ainda tenta o texto livre, mas texto livre NUNCA prova entrega: sem Telegram a rodada fica vermelha', { skip: PULAR }, async () => {
  reset();
  saude = FORA;
  kapso = { modelo: 0, texto: 200 };
  const r = await rodar(mkdtempSync(join(tmpdir(), 'vigia-')), { TELEGRAM_BOT_TOKEN: '' });
  assert.equal(r.codigo, 1, 'a Meta aceitou o texto (200) mas pode descartá-lo fora da janela de 24 h: não é confirmação');
  assert.deepEqual(recebidos.filter((x) => x.rota.startsWith('kapso')).map((x) => x.corpo.type), ['template', 'text']);
});

test('o TESTE fica vermelho se só o texto livre passou (sem modelo aprovado e sem Telegram)', { skip: PULAR }, async () => {
  reset();
  kapso = { modelo: 400, texto: 200 };
  const r = await rodar(mkdtempSync(join(tmpdir(), 'vigia-')), { TELEGRAM_BOT_TOKEN: '', MODO_TESTE: '1' });
  assert.equal(r.codigo, 1, r.saida);
});

test('o log do Actions (público) não traz tipo de incidente, causa, status, unidade nem número', { skip: PULAR }, async () => {
  reset();
  saude = FORA;
  const r = await rodar(mkdtempSync(join(tmpdir(), 'vigia-')));
  assert.equal(r.codigo, 0, r.saida);
  for (const proibido of ['credito', 'crédito', 'fora', 'autenticacao', 'status', 'codigo', 'motivo', '5599988887777', 'inacessivel']) assert.ok(!r.saida.toLowerCase().includes(proibido.toLowerCase()), `o log trouxe «${proibido}»: ${r.saida}`);
});

test('HEALTH_URL ainda não cadastrada: sai VERDE (exit 0) com aviso, sem mandar nada e sem gastar e-mail de falha', { skip: PULAR }, async () => {
  reset();
  const dir = mkdtempSync(join(tmpdir(), 'vigia-'));
  const r = await rodar(dir, { HEALTH_URL: '' });
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /::warning::HEALTH_URL não está cadastrado/);
  assert.equal(recebidos.length, 0);
});

test('MODO_TESTE manda o aviso de teste pelos canais, sem consultar a saúde nem mexer no estado', { skip: PULAR }, async () => {
  reset();
  saude = FORA;
  const dir = mkdtempSync(join(tmpdir(), 'vigia-'));
  const r = await rodar(dir, { MODO_TESTE: '1' });
  assert.equal(r.codigo, 0, r.saida);
  assert.match(recebidos.find((x) => x.rota.startsWith('telegram'))!.corpo.text, /TESTE do vigia externo/);
  assert.ok(!existsSync(join(dir, 'estado/vigia.json')));
});
