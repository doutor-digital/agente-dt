import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registrarArquivosSePermitido } from './arquivos.js';
import { CofreDeArquivos, detectarTipo, ErroDeCofre, limitesDoAmbiente, nomeSeguro, validarArquivo, type EventoDoCofre } from './cofre-arquivos.js';
import { montarRotasDoCofre } from './cofre-http.js';
import { JanelaDeContagem } from './limites.js';

// ── amostras: bytes mínimos que o detector reconhece ────────────────────────────────────────────────
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-fake')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-fake')]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const DOC = Buffer.concat([OLE, Buffer.alloc(32), Buffer.from('WordDocument', 'utf16le')]);
const XLS_OLE = Buffer.concat([OLE, Buffer.alloc(32), Buffer.from('Workbook', 'utf16le')]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml'), Buffer.from('word/document.xml')]);
const ZIP_QUALQUER = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('lib/Main.class')]);
const DOC_COM_MACRO = Buffer.concat([DOC, Buffer.from('_VBA_PROJECT', 'utf16le')]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2), Buffer.from('This program cannot be run in DOS mode.'), Buffer.alloc(64)]);
const TXT = Buffer.from('Contrato de trabalho\nSalário: R$ 3.000,00\n');
const SEGREDO = 'CPF 529.982.247-25 salário 7777';
const PDF_COM_SEGREDO = Buffer.concat([PDF, Buffer.from(SEGREDO)]);

const MIN = 60_000;
const USUARIO = 'u-suzanne';
const OUTRO = 'u-intruso';

function cenario(limites: ConstructorParameters<typeof CofreDeArquivos>[0]['limites'] = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cofre-teste-'));
  const relogio = { t: Date.parse('2026-11-03T12:00:00-03:00') };
  const eventos: EventoDoCofre[] = [];
  const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre'), agora: () => relogio.t, auditar: (e) => eventos.push(e), limites });
  const arquivosNoDisco = () => {
    try {
      return readdirSync(path.join(dir, 'cofre'));
    } catch {
      return [];
    }
  };
  return { cofre, relogio, eventos, dir, arquivosNoDisco, limpar: () => rmSync(dir, { recursive: true, force: true }) };
}

/** pede, reserva e guarda: devolve o id e os tokens */
async function subir(c: ReturnType<typeof cenario>, conteudo: Buffer = PDF, nome = 'contrato.pdf', userId = USUARIO) {
  const p = c.cofre.pedirEnvio({ userId, finalidade: 'teste' });
  const r = c.cofre.reservar(p.token);
  await c.cofre.guardar(r, nome, conteudo);
  return p;
}

const codigoDe = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return e instanceof ErroDeCofre ? e.codigo : `outro:${String(e)}`;
  }
  return 'ok';
};

// ── tipo pelo conteúdo ────────────────────────────────────────────────────────────────────────────────

test('detectarTipo: cada formato aceito pelo conteúdo; executável, zip comum e planilha OLE não passam por documento', () => {
  assert.equal(detectarTipo(PDF), 'pdf');
  assert.equal(detectarTipo(PNG), 'png');
  assert.equal(detectarTipo(JPG), 'jpg');
  assert.equal(detectarTipo(DOC), 'doc');
  assert.equal(detectarTipo(DOCX), 'docx');
  assert.equal(detectarTipo(TXT), 'txt');
  assert.equal(detectarTipo(EXE), null, 'MZ + NUL: nem texto é');
  assert.equal(detectarTipo(ZIP_QUALQUER), null, '.jar/.zip renomeado');
  assert.equal(detectarTipo(XLS_OLE), null, 'OLE sem WordDocument (.xls/.msi)');
  assert.equal(detectarTipo(Buffer.concat([DOCX, Buffer.from('word/vbaProject.bin')])), null, 'docx com macro');
  assert.equal(detectarTipo(Buffer.from([0x41, 0x00, 0x42])), null, 'NUL no meio');
  assert.equal(detectarTipo(DOC_COM_MACRO), null, '.doc com projeto de macro');
  assert.equal(detectarTipo(HTML), null, 'marcação não passa por texto');
  assert.equal(detectarTipo(Buffer.from('  <svg onload=x>')), null);
  assert.equal(detectarTipo(Buffer.from('#!/bin/sh\nrm -rf /')), null);
});

test('nome com ponto que não é extensão ("Maria J. Souza", "v1.2") vale como nome; extensão de verdade continua sendo conferida', () => {
  assert.equal(validarArquivo('Contrato Maria J. Souza', PDF, 1 << 20).nome, 'Contrato-Maria-J.-Souza.pdf');
  assert.equal(validarArquivo('Contrato v1.2', PDF, 1 << 20).nome, 'Contrato-v1.2.pdf');
  assert.throws(() => validarArquivo('programa.exe', EXE, 1 << 20), /\.exe não é aceito/);
  // extensão desconhecida com conteúdo válido: manda o conteúdo (o nome guardado termina com a extensão do tipo detectado)
  assert.equal(validarArquivo('Contrato.final', PDF, 1 << 20).nome, 'Contrato.final.pdf');
  assert.equal(validarArquivo('Proposta.v2', PDF, 1 << 20).nome, 'Proposta.v2.pdf');
  // ... mas extensão conhecida que não combina com o conteúdo continua recusada
  assert.throws(() => validarArquivo('Contrato.docx', PDF, 1 << 20), /conteúdo é PDF/);
});

test('tipo falso: .exe renomeado para .pdf é recusado (e o motivo diz o que o arquivo é)', () => {
  assert.throws(() => validarArquivo('contrato.pdf', EXE, 1 << 20), (e: unknown) => e instanceof ErroDeCofre && e.codigo === 'tipo' && e.status === 415);
  // o inverso: PDF verdadeiro com nome de imagem; texto com nome de PDF; extensão fora da lista
  assert.throws(() => validarArquivo('foto.png', PDF, 1 << 20), /conteúdo é PDF/);
  assert.throws(() => validarArquivo('contrato.pdf', TXT, 1 << 20), /conteúdo é texto/);
  assert.throws(() => validarArquivo('setup.exe', EXE, 1 << 20), /\.exe não é aceito/);
  assert.throws(() => validarArquivo('x.html', Buffer.from('<script>'), 1 << 20), /\.html não é aceito/);
  assert.throws(() => validarArquivo('vazio.pdf', Buffer.alloc(0), 1 << 20), /vazio/);
  // casos certos
  assert.equal(validarArquivo('Contrato.PDF', PDF, 1 << 20).tipo, 'pdf');
  assert.equal(validarArquivo('foto.jpeg', JPG, 1 << 20).nome, 'foto.jpg');
  assert.equal(validarArquivo('sem-extensao', PNG, 1 << 20).nome, 'sem-extensao.png');
});

test('pasta do cofre: falha única ao criar não fica gravada para sempre, e pasta que já existia não tem a permissão mudada', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora permissão de pasta');
  const base = mkdtempSync(path.join(tmpdir(), 'cofre-pasta-'));
  try {
    // 1) a pasta-pai não deixa criar; depois a permissão é corrigida e o cofre volta a funcionar sem reiniciar
    chmodSync(base, 0o500);
    const cofre = new CofreDeArquivos({ dir: path.join(base, 'novo', 'cofre') });
    const p = cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    const err = await cofre.guardar(cofre.reservar(p.token), 'a.pdf', PDF).catch((e) => e);
    assert.ok(err instanceof Error && !(err instanceof ErroDeCofre));
    chmodSync(base, 0o700);
    await cofre.guardar(cofre.reservar(p.token), 'a.pdf', PDF);
    // 2) pasta existente (ex.: ARQUIVOS_DIR=/tmp compartilhada): o app não mexe na permissão dela
    const alheia = mkdtempSync(path.join(base, 'alheia-'));
    chmodSync(alheia, 0o755);
    const cofre2 = new CofreDeArquivos({ dir: alheia });
    const q = cofre2.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    await cofre2.guardar(cofre2.reservar(q.token), 'a.pdf', PDF);
    assert.equal(statSync(alheia).mode & 0o777, 0o755);
  } finally {
    chmodSync(base, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

test('arquivo maior que o limite é recusado (com 413), sem guardar nada', async () => {
  const c = cenario({ tamanhoMaxBytes: 1024 });
  try {
    const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    const r = c.cofre.reservar(p.token);
    const grande = Buffer.concat([PDF, Buffer.alloc(2000)]);
    await assert.rejects(c.cofre.guardar(r, 'a.pdf', grande), (e: unknown) => e instanceof ErroDeCofre && e.codigo === 'tamanho' && e.status === 413);
    assert.deepEqual(c.arquivosNoDisco(), []);
    // o link continua valendo para uma nova tentativa com arquivo menor
    await c.cofre.guardar(c.cofre.reservar(p.token), 'a.pdf', PDF);
    assert.equal(c.arquivosNoDisco().length, 1);
  } finally {
    c.limpar();
  }
});

test('path traversal: o nome da pessoa nunca vira pasta nem sai com .., e o arquivo no disco só tem o id aleatório', async () => {
  const casos: Array<[string, string]> = [
    ['../../etc/passwd.pdf', 'passwd.pdf'],
    ['..\\..\\Windows\\win.ini.pdf', 'win.ini.pdf'],
    ['a/b/../../c.pdf', 'c.pdf'],
    ['/etc/shadow.pdf', 'shadow.pdf'],
    ['....pdf', 'arquivo.pdf'],
    ['..pdf', 'arquivo.pdf'],
    ['Contrato João (v1).PDF', 'Contrato-Joao-v1.pdf'],
    ['con;trato"x<script>.pdf', 'con-trato-x-script.pdf'],
    ['%2e%2e%2fsegredo.pdf', '2e-2e-2fsegredo.pdf'],
  ];
  for (const [entrada, esperado] of casos) assert.equal(nomeSeguro(entrada, 'pdf'), esperado, entrada);
  assert.match(nomeSeguro('x'.repeat(500), 'pdf'), /^x{60}\.pdf$/);

  const c = cenario();
  try {
    await subir(c, PDF, '../../etc/passwd.pdf');
    const nomes = c.arquivosNoDisco();
    assert.equal(nomes.length, 1);
    assert.match(nomes[0]!, /^[0-9a-f]{32}\.bin$/);
    assert.deepEqual(readdirSync(c.dir).sort(), ['cofre'], 'nada escapou da pasta do cofre');
  } finally {
    c.limpar();
  }
});

// ── token de envio ────────────────────────────────────────────────────────────────────────────────────

test('token de envio: aleatório de 256 bits, uso único (reutilizado é recusado) e expira em 30 min', async () => {
  const c = cenario();
  try {
    const a = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    const b = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.token, b.token);
    assert.notEqual(a.id, b.id);
    // abrir a página não gasta o link
    c.cofre.inspecionarEnvio(a.token);
    c.cofre.inspecionarEnvio(a.token);
    await c.cofre.guardar(c.cofre.reservar(a.token), 'a.pdf', PDF);
    assert.equal(await codigoDe(() => c.cofre.reservar(a.token)), 'usado', 'reutilizado');
    assert.equal(await codigoDe(() => c.cofre.inspecionarEnvio(a.token)), 'usado');
    // vencido
    c.relogio.t += 30 * MIN + 1;
    assert.equal(await codigoDe(() => c.cofre.reservar(b.token)), 'expirado');
    // inventado / formato errado
    assert.equal(await codigoDe(() => c.cofre.reservar('x'.repeat(43))), 'invalido');
    assert.equal(await codigoDe(() => c.cofre.reservar('curto')), 'invalido');
    assert.equal(await codigoDe(() => c.cofre.reservar('../../etc/passwd')), 'invalido');
  } finally {
    c.limpar();
  }
});

test('dois envios ao mesmo tempo no mesmo link: o segundo é barrado; 5 recusas queimam o link', async () => {
  const c = cenario();
  try {
    const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    const r = c.cofre.reservar(p.token);
    assert.equal(await codigoDe(() => c.cofre.reservar(p.token)), 'ocupado');
    c.cofre.liberar(r); // interrompido: conta como 1 recusa
    for (let i = 0; i < 3; i++) {
      await assert.rejects(c.cofre.guardar(c.cofre.reservar(p.token), 'x.pdf', EXE));
    }
    assert.equal(await codigoDe(() => c.cofre.inspecionarEnvio(p.token)), 'ok', '4 recusas: ainda vale');
    await assert.rejects(c.cofre.guardar(c.cofre.reservar(p.token), 'x.pdf', EXE)); // a 5ª
    assert.equal(await codigoDe(() => c.cofre.reservar(p.token)), 'expirado', 'link queimado pelas recusas');
  } finally {
    c.limpar();
  }
});

// ── dono: só quem pediu ──────────────────────────────────────────────────────────────────────────────

test('outro usuário não vê, não gera link e não apaga: recebe o mesmo "não encontrado" de um id inventado', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    for (const fn of [() => c.cofre.ver(OUTRO, p.id), () => c.cofre.gerarLink(OUTRO, p.id, 15), () => c.cofre.apagar(OUTRO, p.id), () => c.cofre.ver(USUARIO, 'inventado123')]) {
      assert.equal(await codigoDe(fn), 'nao_encontrado');
    }
    assert.equal(c.cofre.ver(USUARIO, p.id).estado, 'recebido');
  } finally {
    c.limpar();
  }
});

test('gerarLink antes do arquivo chegar é recusado', async () => {
  const c = cenario();
  try {
    const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    assert.equal(c.cofre.ver(USUARIO, p.id).estado, 'aguardando_envio');
    assert.equal(await codigoDe(() => c.cofre.gerarLink(USUARIO, p.id, 15)), 'estado');
  } finally {
    c.limpar();
  }
});

test('no máximo 5 pedidos vivos por pessoa', () => {
  const c = cenario();
  try {
    for (let i = 0; i < 5; i++) c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    assert.throws(() => c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' }), /em andamento/);
    c.cofre.pedirEnvio({ userId: OUTRO, finalidade: 'teste' }); // a cota é por pessoa
  } finally {
    c.limpar();
  }
});

// ── download: expira, apaga, conta ──────────────────────────────────────────────────────────────────

test('link de download expira e o arquivo some do DISCO (no acesso, sem esperar o worker)', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    assert.equal(c.arquivosNoDisco().length, 1);
    const l = c.cofre.gerarLink(USUARIO, p.id, 10);
    const a = await c.cofre.baixar(l.token, true);
    assert.equal((await a.ler()).equals(PDF), true);
    c.relogio.t += 10 * MIN;
    assert.equal(await codigoDe(() => c.cofre.baixar(l.token, true)), 'expirado');
    await new Promise((r) => setTimeout(r, 30)); // o unlink é assíncrono
    assert.deepEqual(c.arquivosNoDisco(), [], 'apagado do disco');
    assert.equal(c.cofre.ver(USUARIO, p.id).estado, 'apagado');
    assert.equal(await codigoDe(() => c.cofre.gerarLink(USUARIO, p.id, 5)), 'estado');
  } finally {
    c.limpar();
  }
});

test('minutos: padrão 15, máximo 30 (mais que isso é cortado em 30) e nunca passa do teto do envio', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    const t0 = c.relogio.t;
    assert.equal(c.cofre.gerarLink(USUARIO, p.id, undefined).expiraEm - t0, 15 * MIN);
    assert.equal(c.cofre.gerarLink(USUARIO, p.id, 999).expiraEm - t0, 30 * MIN);
    assert.equal(c.cofre.gerarLink(USUARIO, p.id, 0).expiraEm - t0, 1 * MIN);
    c.relogio.t += 115 * MIN; // faltam 5 min para o teto de 2 h (o envio nasceu em t0)
    // o arquivo já teria sido apagado: todos os links expiraram em ≤ 30 min
    assert.equal(await codigoDe(() => c.cofre.gerarLink(USUARIO, p.id, 30)), 'estado');
  } finally {
    c.limpar();
  }
});

test('limite de baixadas: a 4ª é recusada; HEAD (contar=false) não gasta baixada', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    assert.equal(l.baixadasMax, 3);
    await c.cofre.baixar(l.token, false); // HEAD
    await c.cofre.baixar(l.token, false);
    for (let i = 0; i < 3; i++) await c.cofre.baixar(l.token, true);
    assert.equal(await codigoDe(() => c.cofre.baixar(l.token, true)), 'expirado');
    assert.equal(c.cofre.ver(USUARIO, p.id).links[0]!.ativo, false);
    // outro link do mesmo arquivo tem o seu contador e o seu token
    const l2 = c.cofre.gerarLink(USUARIO, p.id, 15);
    assert.notEqual(l2.token, l.token);
    await c.cofre.baixar(l2.token, true);
  } finally {
    c.limpar();
  }
});

test('baixadas simultâneas não furam o limite (conta antes de ler)', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => c.cofre.baixar(l.token, true).then((a) => a.ler())));
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 3);
  } finally {
    c.limpar();
  }
});

test('teto de segurança de 2 h: sem ninguém pedir link, o worker apaga o arquivo do disco; antes disso não', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    c.relogio.t += 119 * MIN;
    await c.cofre.varrer();
    assert.equal(c.arquivosNoDisco().length, 1);
    c.relogio.t += 2 * MIN;
    await c.cofre.varrer();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(c.arquivosNoDisco(), []);
    assert.equal(c.cofre.ver(USUARIO, p.id).estado, 'apagado');
    assert.ok(c.eventos.some((e) => e.evento === 'apagado' && e.detalhe?.motivo === 'teto-de-seguranca'));
    // e o registro some da memória depois de lembrar 10 min
    c.relogio.t += 61 * MIN;
    assert.equal(await codigoDe(() => c.cofre.ver(USUARIO, p.id)), 'nao_encontrado');
  } finally {
    c.limpar();
  }
});

test('o worker apaga arquivo órfão (sobra de outro processo) só depois do prazo, e ignora o que não é do cofre', async () => {
  const c = cenario();
  try {
    await subir(c); // cria a pasta
    const pasta = path.join(c.dir, 'cofre');
    const orfao = path.join(pasta, 'a'.repeat(32) + '.bin');
    const alheio = path.join(pasta, 'leia-me.txt');
    writeFileSync(orfao, 'x');
    writeFileSync(alheio, 'x');
    const feito = await c.cofre.varrer();
    assert.equal(feito.orfaosApagados, 0, 'recente: pode ser de outro container no deploy');
    c.relogio.t += 2 * 3_600_000 + Date.now() - c.relogio.t + 1000; // o relógio do teste passa o mtime real do arquivo
    const depois = await c.cofre.varrer();
    assert.equal(depois.orfaosApagados, 1);
    assert.deepEqual(readdirSync(pasta).filter((n) => n === 'leia-me.txt'), ['leia-me.txt']);
  } finally {
    c.limpar();
  }
});

test('baixada que não entregou volta: arquivo sumido do disco não gasta o limite e responde como "não encontrado"', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    const pasta = path.join(c.dir, 'cofre');
    const [n] = c.arquivosNoDisco();
    const guardado = readFileSync(path.join(pasta, n!));
    rmSync(path.join(pasta, n!));
    for (let i = 0; i < 5; i++) assert.equal(await codigoDe(() => c.cofre.baixar(l.token, true)), 'expirado');
    assert.equal(c.cofre.ver(USUARIO, p.id).links[0]!.baixadas, 0, 'nenhuma baixada foi gasta');
    writeFileSync(path.join(pasta, n!), guardado, { mode: 0o600 });
    assert.equal((await (await c.cofre.baixar(l.token, true)).ler()).equals(PDF), true);
  } finally {
    c.limpar();
  }
});

test('apagar no meio de uma leitura em andamento não derruba o download com erro de decifragem', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    const lendo = c.cofre.baixar(l.token, true);
    c.cofre.apagar(USUARIO, p.id); // zera a chave original enquanto a leitura corre
    const r = await lendo.then(
      (a) => a.ler(),
      (e) => e,
    );
    assert.ok(Buffer.isBuffer(r) ? r.equals(PDF) : r instanceof ErroDeCofre, 'ou entregou inteiro ou negou limpo, nunca outro erro');
  } finally {
    c.limpar();
  }
});

test('falha nossa ao gravar (disco) não deixa pedaço no disco e não gasta as tentativas da pessoa', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignora permissão de pasta');
  const c = cenario();
  try {
    await subir(c); // cria a pasta
    const pasta = path.join(c.dir, 'cofre');
    const q = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
    chmodSync(pasta, 0o500);
    try {
      for (let i = 0; i < 7; i++) {
        const err = await c.cofre.guardar(c.cofre.reservar(q.token), 'a.pdf', PDF).catch((e) => e);
        assert.ok(err instanceof Error && !(err instanceof ErroDeCofre), 'erro interno, não recusa');
      }
    } finally {
      chmodSync(pasta, 0o700);
    }
    assert.equal(c.arquivosNoDisco().length, 1, 'só o primeiro envio ficou');
    await c.cofre.guardar(c.cofre.reservar(q.token), 'a.pdf', PDF); // 7 falhas nossas e o link ainda serve
    assert.equal(c.arquivosNoDisco().length, 2);
  } finally {
    chmodSync(path.join(c.dir, 'cofre'), 0o700);
    c.limpar();
  }
});

test('apagar: some do disco na hora e o link para de funcionar', async () => {
  const c = cenario();
  try {
    const p = await subir(c);
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    assert.equal(c.cofre.apagar(USUARIO, p.id), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(c.arquivosNoDisco(), []);
    assert.equal(await codigoDe(() => c.cofre.baixar(l.token, true)), 'expirado');
    assert.equal(c.cofre.apagar(USUARIO, p.id), false);
  } finally {
    c.limpar();
  }
});

// ── disco ─────────────────────────────────────────────────────────────────────────────────────────────

test('no disco: cifrado (o texto do arquivo não aparece), arquivo 0600, pasta 0700, e a chave some junto com o envio', async () => {
  const c = cenario();
  try {
    const p = await subir(c, PDF_COM_SEGREDO);
    const pasta = path.join(c.dir, 'cofre');
    const [nome] = c.arquivosNoDisco();
    const bruto = readFileSync(path.join(pasta, nome!));
    assert.equal(bruto.includes(Buffer.from(SEGREDO)), false, 'texto puro no disco');
    assert.equal(bruto.includes(Buffer.from('%PDF')), false);
    assert.equal(statSync(path.join(pasta, nome!)).mode & 0o777, 0o600);
    assert.equal(statSync(pasta).mode & 0o777, 0o700);
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    assert.equal((await (await c.cofre.baixar(l.token, true)).ler()).equals(PDF_COM_SEGREDO), true, 'volta igual');
    // adulterar o arquivo no disco: a leitura falha (GCM autentica)
    writeFileSync(path.join(pasta, nome!), Buffer.concat([bruto.subarray(0, 40), Buffer.from('lixo')]));
    await assert.rejects((await c.cofre.baixar(l.token, false)).ler());
  } finally {
    c.limpar();
  }
});

test('auditoria: registra pedido, envio, link, baixada e apagado, SEM conteúdo e SEM o nome do arquivo', async () => {
  const c = cenario();
  try {
    const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'contrato do fulano' });
    await c.cofre.guardar(c.cofre.reservar(p.token), 'Contrato Maria da Silva CPF 52998224725.pdf', PDF_COM_SEGREDO, { ip: '203.0.113.9', agente: 'ClickSign/1.0' });
    const l = c.cofre.gerarLink(USUARIO, p.id, 15);
    await c.cofre.baixar(l.token, true, { ip: '198.51.100.7', agente: 'ClickSign/1.0' });
    c.cofre.apagar(USUARIO, p.id);
    assert.deepEqual(c.eventos.map((e) => e.evento), ['upload_pedido', 'upload_recebido', 'link_gerado', 'download', 'apagado']);
    const texto = JSON.stringify(c.eventos);
    for (const proibido of ['Maria', 'Silva', '52998224725', 'SEGREDO', SEGREDO, p.token, l.token, '529.982']) assert.equal(texto.includes(proibido), false, proibido);
    assert.equal(c.eventos[3]!.ip, '198.51.100.7');
    assert.equal(c.eventos.every((e) => e.userId === USUARIO && e.envio === p.id), true);
  } finally {
    c.limpar();
  }
});

test('limitesDoAmbiente: valor inválido ou fora da faixa volta ao padrão, nunca a "sem limite"', () => {
  assert.deepEqual(limitesDoAmbiente({}), {});
  assert.deepEqual(limitesDoAmbiente({ ARQUIVOS_TAMANHO_MAX_MB: '5', ARQUIVOS_BAIXADAS_MAX: '2' }), { tamanhoMaxBytes: 5 * 1024 * 1024, baixadasMax: 2 });
  for (const ruim of ['0', '-1', '21', '999999', 'abc', '', '1.5']) {
    assert.deepEqual(limitesDoAmbiente({ ARQUIVOS_TAMANHO_MAX_MB: ruim, ARQUIVOS_BAIXADAS_MAX: ruim === '21' ? '11' : ruim }), {}, ruim);
  }
});

// ── HTTP de verdade ───────────────────────────────────────────────────────────────────────────────────

async function comServidor<T>(c: ReturnType<typeof cenario>, fn: (url: string) => Promise<T>, tentativas?: JanelaDeContagem): Promise<T> {
  const app = express();
  // o mesmo parser global do server.ts: o envio (octet-stream) tem que passar por ele sem ser tocado
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  montarRotasDoCofre(app, c.cofre, { tentativasPorIp: tentativas });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
}

const enviar = (url: string, token: string, corpo: Buffer, nome = 'contrato.pdf') =>
  fetch(`${url}/arquivos/enviar/${token}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Nome-Arquivo': encodeURIComponent(nome) }, body: corpo });

test('HTTP ponta a ponta: página (sem gastar o link, sem cache, sem indexar) → envio → download direto com nome e tipo → 4ª baixada 404', async () => {
  const c = cenario();
  try {
    await comServidor(c, async (url) => {
      const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'contrato de admissão da Maria' });
      for (let i = 0; i < 2; i++) {
        const pg = await fetch(`${url}/arquivos/enviar/${p.token}`);
        assert.equal(pg.status, 200);
        assert.match(pg.headers.get('cache-control')!, /no-store/);
        assert.match(pg.headers.get('x-robots-tag')!, /noindex/);
        assert.match(pg.headers.get('content-security-policy')!, /script-src 'nonce-[^']+'/);
        assert.equal(pg.headers.get('referrer-policy'), 'no-referrer');
        const html = await pg.text();
        assert.match(html, /contrato de admissão da Maria/);
        assert.match(html, /<input id="arquivo" type="file"/);
        assert.doesNotMatch(html, new RegExp(p.token), 'a página não repete o token');
      }
      const ok = await enviar(url, p.token, PDF_COM_SEGREDO, 'Contrato Maria.pdf');
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { ok: true, nome: 'Contrato-Maria.pdf', tamanho: PDF_COM_SEGREDO.length });
      // reutilizar o link de envio
      const de_novo = await enviar(url, p.token, PDF);
      assert.equal(de_novo.status, 410);
      const pagina = await fetch(`${url}/arquivos/enviar/${p.token}`);
      assert.equal(pagina.status, 410);
      assert.doesNotMatch(await pagina.text(), /type="file"/);

      const l = c.cofre.gerarLink(USUARIO, p.id, 15);
      const caminho = `${url}/arquivos/baixar/${l.token}/${l.nome}`;
      const head = await fetch(caminho, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-type'), 'application/pdf');
      for (let i = 0; i < 3; i++) {
        const r = await fetch(caminho);
        assert.equal(r.status, 200);
        assert.equal(r.headers.get('content-type'), 'application/pdf');
        assert.equal(r.headers.get('content-disposition'), 'attachment; filename="Contrato-Maria.pdf"');
        assert.equal(r.headers.get('content-length'), String(PDF_COM_SEGREDO.length));
        assert.match(r.headers.get('cache-control')!, /no-store/);
        assert.match(r.headers.get('x-robots-tag')!, /noindex/);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(Buffer.from(await r.arrayBuffer()).equals(PDF_COM_SEGREDO), true);
      }
      const quarta = await fetch(caminho);
      assert.equal(quarta.status, 404);
      assert.equal(await quarta.text(), 'Arquivo não encontrado.');
    });
  } finally {
    c.limpar();
  }
});

test('HTTP: tipo falso (exe como .pdf) → 415 e o link de envio continua valendo; arquivo grande → 413', async () => {
  const c = cenario({ tamanhoMaxBytes: 4096 });
  try {
    await comServidor(c, async (url) => {
      const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
      const falso = await enviar(url, p.token, EXE, 'contrato.pdf');
      assert.equal(falso.status, 415);
      assert.match(((await falso.json()) as { erro: string }).erro, /conteúdo/);
      assert.deepEqual(c.arquivosNoDisco(), []);
      // declarado no Content-Length
      const grande = await enviar(url, p.token, Buffer.concat([PDF, Buffer.alloc(5000)]));
      assert.equal(grande.status, 413);
      assert.deepEqual(c.arquivosNoDisco(), []);
      // sem Content-Length (chunked): o servidor conta os bytes
      const parte = Buffer.concat([PDF, Buffer.alloc(3000)]);
      const fluxo = new ReadableStream({
        start(ctl) {
          ctl.enqueue(parte);
          ctl.enqueue(parte);
          ctl.close();
        },
      });
      const chunked = await fetch(`${url}/arquivos/enviar/${p.token}`, { method: 'PUT', body: fluxo, duplex: 'half', headers: { 'Content-Type': 'application/octet-stream', 'X-Nome-Arquivo': 'a.pdf' } } as RequestInit);
      assert.equal(chunked.status, 413);
      assert.deepEqual(c.arquivosNoDisco(), []);
      // o bom ainda passa
      const bom = await enviar(url, p.token, PDF);
      assert.equal(bom.status, 200);
    });
  } finally {
    c.limpar();
  }
});

test('HTTP: no limite padrão, 20 MB passam inteiros e 20 MB + 1 byte são recusados', async () => {
  const c = cenario();
  try {
    await comServidor(c, async (url) => {
      const MAX = 20 * 1024 * 1024;
      const exato = Buffer.concat([PDF, Buffer.alloc(MAX - PDF.length, 0x61)]);
      const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
      const ok = await enviar(url, p.token, exato);
      assert.equal(ok.status, 200);
      const l = c.cofre.gerarLink(USUARIO, p.id, 5);
      const volta = Buffer.from(await (await fetch(`${url}/arquivos/baixar/${l.token}/${l.nome}`)).arrayBuffer());
      assert.equal(volta.length, MAX);
      assert.equal(volta.equals(exato), true);
      const q = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
      const passou = await enviar(url, q.token, Buffer.concat([exato, Buffer.from('a')])).catch(() => ({ status: 413 }));
      assert.equal(passou.status, 413);
      assert.equal(c.arquivosNoDisco().length, 1, 'só o primeiro ficou');
    });
  } finally {
    c.limpar();
  }
});

test('HTTP: link de envio vencido, inventado e malformado não guardam nada; JSON no envio não passa', async () => {
  const c = cenario();
  try {
    await comServidor(c, async (url) => {
      const p = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'teste' });
      c.relogio.t += 31 * MIN;
      assert.equal((await enviar(url, p.token, PDF)).status, 410);
      assert.equal((await enviar(url, 'Z'.repeat(43), PDF)).status, 404);
      assert.equal((await enviar(url, 'curto', PDF)).status, 404);
      assert.equal((await fetch(`${url}/arquivos/enviar/${p.token}`)).status, 410);
      assert.deepEqual(c.arquivosNoDisco(), []);
    });
  } finally {
    c.limpar();
  }
});

test('HTTP: link de download expirado → 404 e o arquivo some do disco', async () => {
  const c = cenario();
  try {
    await comServidor(c, async (url) => {
      const p = await subir(c);
      const l = c.cofre.gerarLink(USUARIO, p.id, 5);
      assert.equal((await fetch(`${url}/arquivos/baixar/${l.token}/${l.nome}`)).status, 200);
      c.relogio.t += 5 * MIN;
      assert.equal((await fetch(`${url}/arquivos/baixar/${l.token}/${l.nome}`)).status, 404);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(c.arquivosNoDisco(), []);
    });
  } finally {
    c.limpar();
  }
});

test('HTTP: não existe listagem nem índice, em nenhuma rota nem método', async () => {
  const c = cenario();
  try {
    await comServidor(c, async (url) => {
      await subir(c);
      for (const rota of ['/arquivos', '/arquivos/', '/arquivos/enviar', '/arquivos/enviar/', '/arquivos/baixar', '/arquivos/baixar/', '/arquivos/baixar//', '/arquivos/baixar/%2e%2e', '/arquivos/baixar/../', '/arquivos/*', '/arquivos/baixar/x/y/z']) {
        for (const metodo of ['GET', 'POST', 'PUT', 'DELETE']) {
          const r = await fetch(`${url}${rota}`, { method: metodo, ...(metodo === 'GET' ? {} : { body: 'x', headers: { 'Content-Type': 'application/octet-stream' } }) });
          assert.equal(r.status, 404, `${metodo} ${rota} → ${r.status}`);
        }
      }
      // token de ENVIO no caminho de download (e vice-versa) não abre nada
      const p2 = c.cofre.pedirEnvio({ userId: USUARIO, finalidade: 'x' });
      assert.equal((await fetch(`${url}/arquivos/baixar/${p2.token}/a.pdf`)).status, 404);
      // nem o id do envio, nem o nome do arquivo no disco
      assert.equal((await fetch(`${url}/arquivos/baixar/${p2.id}/a.pdf`)).status, 404);
      for (const n of c.arquivosNoDisco()) assert.equal((await fetch(`${url}/arquivos/baixar/${n}/a.pdf`)).status, 404);
    });
  } finally {
    c.limpar();
  }
});

test('HTTP: um conector legítimo repetindo a busca de um link vencido/esgotado não se bloqueia (só token inexistente conta)', async () => {
  const c = cenario();
  try {
    await comServidor(
      c,
      async (url) => {
        const p = await subir(c);
        const l = c.cofre.gerarLink(USUARIO, p.id, 5);
        for (let i = 0; i < 3; i++) assert.equal((await fetch(`${url}/arquivos/baixar/${l.token}/${l.nome}`)).status, 200);
        for (let i = 0; i < 8; i++) assert.equal((await fetch(`${url}/arquivos/baixar/${l.token}/${l.nome}`)).status, 404, 'esgotado, mas não 429');
        c.relogio.t += 6 * MIN;
        for (let i = 0; i < 8; i++) assert.equal((await fetch(`${url}/arquivos/baixar/${l.token}/${l.nome}`)).status, 404, 'vencido, mas não 429');
      },
      new JanelaDeContagem(3, 10 * 60_000),
    );
  } finally {
    c.limpar();
  }
});

test('HTTP: sondagem de tokens é cortada por IP com 429', async () => {
  const c = cenario();
  try {
    await comServidor(
      c,
      async (url) => {
        const estados: number[] = [];
        for (let i = 0; i < 5; i++) estados.push((await fetch(`${url}/arquivos/baixar/${'A'.repeat(42)}${i}/a.pdf`)).status);
        assert.deepEqual(estados, [404, 404, 404, 429, 429]);
      },
      new JanelaDeContagem(3, 10 * 60_000),
    );
  } finally {
    c.limpar();
  }
});

// ── ferramentas do MCP ────────────────────────────────────────────────────────────────────────────────

async function sessao(c: ReturnType<typeof cenario>, usuario: string, permitidos: Set<string>) {
  const server = new McpServer({ name: 't', version: '0' });
  const registrou = registrarArquivosSePermitido(server, c.cofre, usuario, permitidos, () => 'https://agente.exemplo.com/', () => undefined);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  const nomes = (await cliente.listTools().catch(() => ({ tools: [] }))).tools.map((t) => t.name).sort();
  const chamar = async (name: string, args: Record<string, unknown>) => {
    const r = (await cliente.callTool({ name, arguments: args }).catch((e) => ({ isError: true, content: [{ type: 'text', text: String(e) }] }))) as { isError?: boolean; content: Array<{ text: string }> };
    return { erro: Boolean(r.isError), texto: r.content[0]!.text, json: r.isError ? undefined : (JSON.parse(r.content[0]!.text) as Record<string, any>) };
  };
  return { registrou, nomes, chamar };
}

test('usuário sem permissão não pede upload: as ferramentas nem existem na sessão dele', async () => {
  const c = cenario();
  try {
    const fora = await sessao(c, 'u-fora', new Set([USUARIO]));
    assert.equal(fora.registrou, false);
    assert.deepEqual(fora.nomes, []);
    const r = await fora.chamar('arquivo_pedir_upload', { finalidade: 'contrato' });
    assert.equal(r.erro, true);
    const vazia = await sessao(c, USUARIO, new Set());
    assert.equal(vazia.registrou, false, 'sem lista, ninguém usa');
    assert.deepEqual(vazia.nomes, []);
    assert.equal(c.eventos.length, 0, 'nenhum envio foi aberto');
    const dentro = await sessao(c, USUARIO, new Set([USUARIO]));
    assert.deepEqual(dentro.nomes, ['arquivo_apagar', 'arquivo_link_temporario', 'arquivo_pedir_upload', 'arquivo_ver_envio']);
  } finally {
    c.limpar();
  }
});

test('fluxo pelas ferramentas: pedir → (a pessoa sobe) → ver → link temporário → apagar; outro usuário não alcança o id', async () => {
  const c = cenario();
  try {
    const s = await sessao(c, USUARIO, new Set([USUARIO, OUTRO]));
    const pedido = await s.chamar('arquivo_pedir_upload', { finalidade: 'contrato de admissão para o ClickSign' });
    assert.equal(pedido.erro, false);
    const link = String(pedido.json!.linkDeEnvio);
    assert.match(link, /^https:\/\/agente\.exemplo\.com\/arquivos\/enviar\/[A-Za-z0-9_-]{43}$/);
    const id = String(pedido.json!.id);

    assert.equal((await s.chamar('arquivo_ver_envio', { id })).json!.estado, 'aguardando_envio');
    assert.equal((await s.chamar('arquivo_link_temporario', { id })).erro, true, 'ainda não chegou');

    const token = link.split('/').pop()!;
    await c.cofre.guardar(c.cofre.reservar(token), 'Contrato Maria.pdf', PDF);

    const visto = await s.chamar('arquivo_ver_envio', { id });
    assert.equal(visto.json!.estado, 'recebido');
    assert.deepEqual(visto.json!.arquivo, { nome: 'Contrato-Maria.pdf', tipo: 'application/pdf', tamanhoBytes: PDF.length, recebidoEm: visto.json!.arquivo.recebidoEm });
    assert.equal(visto.texto.includes('%PDF'), false, 'sem conteúdo');

    const outro = await sessao(c, OUTRO, new Set([OUTRO]));
    assert.equal((await outro.chamar('arquivo_ver_envio', { id })).erro, true);
    assert.equal((await outro.chamar('arquivo_link_temporario', { id })).erro, true);
    assert.equal((await outro.chamar('arquivo_apagar', { id })).erro, true);

    const l = await s.chamar('arquivo_link_temporario', { id });
    assert.match(String(l.json!.url), /^https:\/\/agente\.exemplo\.com\/arquivos\/baixar\/[A-Za-z0-9_-]{43}\/Contrato-Maria\.pdf$/);
    assert.equal(l.json!.expiraEmMinutos, 15);
    assert.equal(l.json!.baixadasMaximas, 3);
    // minutos acima do máximo é recusado já na entrada
    assert.equal((await s.chamar('arquivo_link_temporario', { id, minutos: 31 })).erro, true);
    assert.equal((await s.chamar('arquivo_link_temporario', { id, minutos: 30 })).json!.expiraEmMinutos, 30);

    assert.equal((await s.chamar('arquivo_apagar', { id })).json!.apagado, true);
    assert.equal((await s.chamar('arquivo_ver_envio', { id })).json!.estado, 'apagado');
  } finally {
    c.limpar();
  }
});

test('auditoria da ferramenta: a finalidade (que cita nome de gente) não vai para o registro, e o link não vira argumento', async () => {
  const c = cenario();
  try {
    const server = new McpServer({ name: 't', version: '0' });
    const registros: Array<{ ferramenta: string; argumentos: unknown; erro?: string }> = [];
    registrarArquivosSePermitido(server, c.cofre, USUARIO, new Set([USUARIO]), () => 'https://agente.exemplo.com', (r) => void registros.push(r));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const cliente = new Client({ name: 'teste', version: '0' });
    await Promise.all([server.connect(a), cliente.connect(b)]);
    await cliente.callTool({ name: 'arquivo_pedir_upload', arguments: { finalidade: 'contrato de admissão da Maria Aparecida Souza' } });
    assert.equal(registros.length, 1);
    assert.equal(JSON.stringify(registros[0]).includes('Maria'), false);
    assert.equal(JSON.stringify(registros[0]).includes('/arquivos/enviar/'), false);
  } finally {
    c.limpar();
  }
});

test('producao.ts liga as ferramentas SÓ pelo portão testado e as rotas públicas uma vez', () => {
  const src = readFileSync(new URL('./producao.ts', import.meta.url), 'utf8');
  assert.equal(src.match(/registrarArquivosSePermitido\(/g)?.length, 1);
  assert.match(src, /registrarArquivosSePermitido\(server, cofre, quem\.userId, arquivistas,/);
  assert.equal(src.match(/\bregistrarArquivos\(/g), null);
  assert.equal(src.match(/montarRotasDoCofre\(/g)?.length, 1);
  assert.match(src, /cofre\.varrer\(\)/);
});

test('servidor.ts ensina o fluxo ao claude.ai (pedir → ver → link → ClickSign) e avisa que o link expira', () => {
  const src = readFileSync(new URL('./servidor.ts', import.meta.url), 'utf8');
  for (const trecho of ['arquivo_pedir_upload', 'arquivo_ver_envio', 'arquivo_link_temporario', 'create_envelope_with_file_url', 'arquivo_apagar', 'expira']) assert.ok(src.includes(trecho), trecho);
});
