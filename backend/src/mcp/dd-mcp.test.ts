import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * O dd-mcp só serve se o Claude Code conseguir conversar com ele por stdio. Este teste
 * sobe o processo de verdade e faz o aperto de mão: se o handshake quebrar — SDK novo,
 * import errado, algo escrito no stdout que não seja JSON-RPC — ele cai aqui, e não na
 * máquina do João no meio de uma conversa.
 *
 * Nada de rede: o teste para no tools/list, que é respondido sem tocar na API. A senha
 * vai vazia e a URL aponta pra uma porta morta justamente pra que uma chamada acidental
 * à produção falhe em vez de acontecer.
 */

const SERVIDOR = fileURLToPath(new URL('./dd-mcp.ts', import.meta.url));
const RAIZ = fileURLToPath(new URL('../../', import.meta.url));

interface Resposta { id?: number; result?: { tools?: unknown[] }; error?: unknown }

/** Manda as linhas JSON-RPC e devolve a resposta do id pedido. */
async function perguntar(linhas: string[], idEsperado: number): Promise<Resposta> {
  const proc = spawn(process.execPath, ['--import', 'tsx', SERVIDOR], {
    cwd: RAIZ,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DD_API_URL: 'http://127.0.0.1:1',
      DD_EMAIL: '',
      DD_SENHA: '',
    },
  });

  try {
    return await new Promise<Resposta>((resolve, reject) => {
      const relogio = setTimeout(
        () => reject(new Error(`o servidor não respondeu o id ${idEsperado} a tempo. stderr: ${erro.slice(0, 800)}`)),
        30_000,
      );
      let buffer = '';
      let erro = '';
      proc.stderr.on('data', (c: Buffer) => { erro += c.toString(); });
      proc.on('error', (e) => { clearTimeout(relogio); reject(e); });
      proc.on('exit', (code) => {
        clearTimeout(relogio);
        reject(new Error(`servidor saiu (${code}) sem responder o id ${idEsperado}. stderr: ${erro.slice(0, 800)}`));
      });
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        // Uma mensagem JSON-RPC por linha — é assim que o transporte stdio recorta.
        let corte = buffer.indexOf('\n');
        while (corte !== -1) {
          const linha = buffer.slice(0, corte).trim();
          buffer = buffer.slice(corte + 1);
          if (linha) {
            const msg = JSON.parse(linha) as Resposta;
            if (msg.id === idEsperado) {
              clearTimeout(relogio as NodeJS.Timeout);
              resolve(msg);
              return;
            }
          }
          corte = buffer.indexOf('\n');
        }
      });
      proc.stdin.write(linhas.map((l) => `${l}\n`).join(''));
    });
  } finally {
    proc.kill('SIGKILL');
  }
}

const INICIALIZAR = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'teste', version: '1' } },
});
const LISTAR = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

test('o servidor responde o handshake e anuncia as 3 ferramentas do cérebro', { timeout: 60_000 }, async () => {
  const resp = await perguntar([INICIALIZAR, LISTAR], 2);

  assert.equal(resp.error, undefined, 'tools/list não pode voltar com erro');
  const tools = resp.result?.tools as Array<{ name: string; description?: string; inputSchema?: unknown }> | undefined;
  assert.ok(Array.isArray(tools), 'tools/list deve devolver uma lista');

  // Os nomes são contrato: mudar um quebra o prompt de quem já usa a ferramenta.
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['cerebro_paciente', 'cerebro_panorama', 'cerebro_unidades'],
  );

  for (const t of tools) {
    // Sem inputSchema o cliente não sabe montar a chamada e a ferramenta vira enfeite.
    assert.ok(t.inputSchema, `${t.name} precisa de inputSchema`);
    assert.equal((t.inputSchema as { type?: string }).type, 'object', `${t.name}: inputSchema deve ser um objeto`);
    assert.ok(t.description && t.description.length > 20, `${t.name} precisa de uma descrição que explique o uso`);
  }
});

test('o initialize se apresenta como dd-cerebro', { timeout: 60_000 }, async () => {
  const resp = await perguntar([INICIALIZAR], 1);
  const info = (resp.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
  assert.equal(info?.name, 'dd-cerebro');
});
