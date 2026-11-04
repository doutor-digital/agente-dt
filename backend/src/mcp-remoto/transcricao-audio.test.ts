import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SegmentoWhisper } from '../services/transcription.service.js';
import { mediaLogprob } from '../lib/transcricao-modelo.js';
import { registrarArquivosSePermitido } from './arquivos.js';
import { CofreDeArquivos, detectarTipo, validarArquivo, TIPOS_DE_MIDIA } from './cofre-arquivos.js';
import {
  argsDeExtracao,
  classificarSegmento,
  criarTranscritor,
  DESTINO_TRANSCRICAO,
  escolherInicio,
  FILTRO_LIMPEZA,
  PEDACO_GPT4O_SEG,
  juntarPedacos,
  linhasComHorario,
  montarSrt,
  planejarRecorte,
  prepararSegmentos,
  registrarTranscricaoSePermitido,
  resumir,
  rotuloDeTempo,
  tempoSrt,
} from './transcricao-audio.js';

// Transcrição de áudio de câmera (04/11/2026). A OpenAI é sempre simulada; o ffmpeg é o de verdade quando existe na máquina.

const TEM_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const seg = (start: number, end: number, text: string, o: Partial<SegmentoWhisper> = {}): SegmentoWhisper => ({ start, end, text, avg_logprob: -0.3, no_speech_prob: 0.02, compression_ratio: 1.2, ...o });

// ── .srt ──────────────────────────────────────────────────────────────────────────────────────────────

test('tempoSrt e montarSrt: formato HH:MM:SS,mmm, cues numerados, sem linha em branco nem "-->" dentro do texto', () => {
  assert.equal(tempoSrt(0), '00:00:00,000');
  assert.equal(tempoSrt(62.5), '00:01:02,500');
  assert.equal(tempoSrt(3661.0004), '01:01:01,000');
  const srt = montarSrt([
    { inicio: 0, fim: 2.5, texto: 'bom dia' },
    { inicio: 3, fim: 3, texto: 'linha 1\n\nlinha 2 --> fim' },
  ]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:02,500\nbom dia\n\n2\n00:00:03,000 --> 00:00:03,500\nlinha 1 linha 2 → fim\n');
});

// ── filtro de alucinação por segmento ───────────────────────────────────────────────────────────────

test('classificarSegmento: fala boa passa; sem fala, alucinação, outro alfabeto e baixa confiança são marcados, nunca inventados', () => {
  assert.deepEqual(classificarSegmento(seg(0, 2, ' Pode vir amanhã às duas? ')), { situacao: 'fala', texto: 'Pode vir amanhã às duas?' });
  assert.equal(classificarSegmento(seg(0, 2, 'ruído de fundo', { no_speech_prob: 0.9 })).situacao, 'sem_fala');
  assert.equal(classificarSegmento(seg(0, 2, 'talvez algo', { no_speech_prob: 0.7, avg_logprob: -1.2 })).situacao, 'sem_fala');
  assert.equal(classificarSegmento(seg(0, 2, 'sim, tudo bem', { no_speech_prob: 0.7, avg_logprob: -0.4 })).situacao, 'fala', 'só no_speech_prob médio com texto confiante não derruba');
  assert.equal(classificarSegmento(seg(0, 2, 'Legendas pela comunidade Amara.org')).situacao, 'sem_fala');
  assert.equal(classificarSegmento(seg(0, 2, 'Obrigado.', { no_speech_prob: 0.5 })).situacao, 'sem_fala', 'frase curta típica + sinal de silêncio');
  assert.equal(classificarSegmento(seg(0, 2, 'Obrigado.')).situacao, 'fala', 'o mesmo "Obrigado." com sinal limpo é fala de verdade');
  assert.equal(classificarSegmento(seg(0, 2, 'Gravação de câmera de segurança em clínica/loja; conversa entre funcionários e clientes.')).situacao, 'sem_fala', 'o Whisper devolve o prompt de contexto em trecho mudo');
  assert.equal(classificarSegmento(seg(0, 2, 'a câmera de segurança está torta')).situacao, 'fala');
  assert.equal(classificarSegmento(seg(0, 2, 'Pull atəş, улыштәш.')).situacao, 'inaudivel');
  assert.equal(classificarSegmento(seg(0, 2, 'ha ha ha ha ha ha', { compression_ratio: 3.1 })).situacao, 'inaudivel');
  assert.equal(classificarSegmento(seg(0, 2, 'sei lá o que', { avg_logprob: -1.8 })).situacao, 'inaudivel');
  const baixa = classificarSegmento(seg(0, 2, 'acho que é terça', { avg_logprob: -1.2 }));
  assert.equal(baixa.situacao, 'baixa_confianca');
  assert.equal(baixa.texto, 'acho que é terça');
});

test('prepararSegmentos e resumir: repetição em laço vira inaudível; resumo traz o % de confiança boa e tem_fala', () => {
  const segs = prepararSegmentos([
    seg(0, 2, 'bom dia'),
    seg(2, 4, 'silêncio qualquer', { no_speech_prob: 0.95 }),
    seg(4, 6, 'acho que sim', { avg_logprob: -1.2 }),
    seg(6, 8, 'tá bom'),
    seg(8, 10, 'tá bom'),
    seg(10, 12, 'tá bom'),
  ]);
  assert.deepEqual(segs.map((s) => s.situacao), ['fala', 'sem_fala', 'baixa_confianca', 'fala', 'fala', 'inaudivel']);
  assert.equal(segs[1]!.texto, '[sem fala]');
  assert.equal(segs[2]!.texto, 'acho que sim (baixa confiança)');
  assert.equal(segs[5]!.texto, '[inaudível]');
  const r = resumir(segs);
  assert.deepEqual({ ...r }, { segmentos: 6, confianca_boa: 3, baixa_confianca: 1, inaudiveis: 1, sem_fala: 1, percentual_confianca_boa: 50, tem_fala: true });
  const mudo = resumir(prepararSegmentos([seg(0, 5, 'Legendas pela comunidade Amara.org'), seg(5, 9, 'x', { no_speech_prob: 0.99 })]));
  assert.equal(mudo.tem_fala, false);
  assert.equal(mudo.percentual_confianca_boa, 0);
  assert.equal(resumir([]).tem_fala, false);
});

// ── recorte acima de 25 MB ──────────────────────────────────────────────────────────────────────────────

test('planejarRecorte e juntarPedacos: cabe inteiro = null; acima do limite corta em pedaços menores que o limite e soma os tempos', () => {
  const MB = 1024 * 1024;
  assert.equal(planejarRecorte(2 * MB, 300), null);
  assert.equal(planejarRecorte(24 * MB, 4000), null);
  const seg1 = planejarRecorte(30 * MB, 5000)!; // 6000 B/s -> 24 MB * 0,8 / ... pedaços de ~19 MB
  assert.ok(seg1 > 0 && (seg1 * (30 * MB)) / 5000 < 24 * MB, `pedaço de ${seg1}s tem de caber no limite`);
  assert.ok(planejarRecorte(30 * MB, 5000, 10 * MB)! < seg1, 'limite menor, pedaço menor');
  const juntas = juntarPedacos([
    { inicioSeg: 0, segmentos: [seg(0, 4, 'a'), seg(4, 9, 'b')] },
    { inicioSeg: 1200.5, segmentos: [seg(0, 3, 'c')] },
    { inicioSeg: 2400, segmentos: [seg(1, 2, 'd')] },
  ]);
  assert.deepEqual(juntas.map((s) => [s.start, s.end, s.text]), [[0, 4, 'a'], [4, 9, 'b'], [1200.5, 1203.5, 'c'], [2401, 2402, 'd']]);
});

// ── horário real ───────────────────────────────────────────────────────────────────────────────────────

test('horário real: inicio_gravacao + tempo do segmento; sem data usa o tempo relativo; fuso converte; data de câmera sem relógio é ignorada', () => {
  const base = escolherInicio('2026-11-04T15:40:00', undefined);
  assert.equal(base.origem, 'informado');
  assert.deepEqual(linhasComHorario([{ inicio: 295, texto: 'oi' }, { inicio: 3000, texto: 'tchau' }], base.baseMs), ['[15:44:55] oi', '[16:30:00] tchau']);
  assert.equal(rotuloDeTempo(60 * 60 * 9, base.baseMs), '[11-05 00:40:00]', 'passou da meia-noite: mostra o dia');
  assert.equal(rotuloDeTempo(252, null), '[00:04:12]');
  assert.equal(escolherInicio(undefined, undefined).origem, 'relativo');
  assert.equal(escolherInicio(undefined, '1970-01-01T00:00:00.000000Z').origem, 'relativo');
  const meta = escolherInicio(undefined, '2026-11-04T18:40:00.000000Z'); // UTC -> Brasília (UTC-3)
  assert.equal(meta.origem, 'metadados do arquivo');
  assert.equal(rotuloDeTempo(0, meta.baseMs), '[15:40:00]');
  assert.throws(() => escolherInicio('ontem à tarde', undefined), /inicio_gravacao inválido/);
});

// ── tipo e tamanho no cofre ────────────────────────────────────────────────────────────────────────────

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(40, 1)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(40, 1)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(40, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(40, 2)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(40, 3)]);
const MP3_SYNC = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(40, 2)]);

test('tipo pelo conteúdo: mp4/mov/m4a/wav/mp3 reconhecidos; RIFF que não é WAVE e JPEG não viram áudio; extensão da mesma família não é barrada', () => {
  assert.equal(detectarTipo(MP4), 'mp4');
  assert.equal(detectarTipo(MOV), 'mov');
  assert.equal(detectarTipo(M4A), 'm4a');
  assert.equal(detectarTipo(WAV), 'wav');
  assert.equal(detectarTipo(MP3), 'mp3');
  assert.equal(detectarTipo(MP3_SYNC), 'mp3');
  assert.equal(detectarTipo(WEBP), null);
  assert.equal(detectarTipo(Buffer.from('ID3456 protocolo do paciente\n')), 'txt', 'texto que começa com ID3 continua sendo texto');
  assert.equal(detectarTipo(Buffer.from('abcdmoov e mais texto aqui\n')), 'txt', 'texto com "moov" no byte 4 continua sendo texto');
  assert.equal(detectarTipo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
  assert.equal(validarArquivo('camera.mov', MP4, 1e9).tipo, 'mp4', '.mov com marca isom: mesmo contêiner');
  assert.equal(validarArquivo('camera.mp4', MP4, 1e9).nome, 'camera.mp4');
  assert.throws(() => validarArquivo('camera.mp3', MP4, 1e9), /diz ser \.mp3/);
  assert.throws(() => validarArquivo('camera.wav', WEBP, 1e9), /não é de um tipo aceito/);
});

function cofreDeTeste(limites: ConstructorParameters<typeof CofreDeArquivos>[0]['limites'] = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cofre-transc-'));
  const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre'), limites });
  return { cofre, dir, limpar: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cofre: vídeo/áudio só entra no envio que o pede (80 MB só para mídia); o envio comum continua em 20 MB e sem mídia', async () => {
  const c = cofreDeTeste();
  try {
    const MB = 1024 * 1024;
    const comum = c.cofre.pedirEnvio({ userId: 'u1', finalidade: 'contrato' });
    assert.equal(comum.tamanhoMaxBytes, 20 * MB);
    await assert.rejects(() => c.cofre.guardar(c.cofre.reservar(comum.token), 'camera.mp4', MP4), /Vídeo e áudio não são aceitos neste envio/);
    const midia = c.cofre.pedirEnvio({ userId: 'u1', finalidade: 'câmera', tipos: TIPOS_DE_MIDIA, destino: { tipo: DESTINO_TRANSCRICAO } });
    assert.equal(midia.tamanhoMaxBytes, 80 * MB);
    // misturar um tipo comum com mídia NÃO ganha o teto grande
    assert.equal(c.cofre.pedirEnvio({ userId: 'u2', finalidade: 'x', tipos: ['pdf', 'mp4'] }).tamanhoMaxBytes, 20 * MB);
    assert.equal(c.cofre.pedirEnvio({ userId: 'u3', finalidade: 'x', tipos: ['mp4'], tamanhoMaxBytes: 5 * MB }).tamanhoMaxBytes, 5 * MB, 'o pedido ainda pode apertar');
    // PDF num envio de mídia: recusado
    await assert.rejects(() => c.cofre.guardar(c.cofre.reservar(midia.token), 'a.pdf', Buffer.from('%PDF-1.7\n%%EOF\n')), /só aceitamos/);
  } finally {
    c.limpar();
  }
});

test('cofre: o SHA-256 é o do arquivo como enviado, aparece em ver(), e exportarParaArquivo devolve os mesmos bytes e o mesmo hash', async () => {
  const c = cofreDeTeste();
  try {
    const original = Buffer.concat([MP4, Buffer.alloc(3 * 1024 * 1024 + 123, 9)]);
    const esperado = createHash('sha256').update(original).digest('hex');
    const p = c.cofre.pedirEnvio({ userId: 'u1', finalidade: 'câmera', tipos: TIPOS_DE_MIDIA, destino: { tipo: DESTINO_TRANSCRICAO } });
    await c.cofre.guardar(c.cofre.reservar(p.token), 'cam.mp4', original);
    assert.equal(c.cofre.ver('u1', p.id).arquivo!.sha256, esperado);
    const saida = path.join(c.dir, 'saida.bin');
    const r = await c.cofre.exportarParaArquivo('u1', p.id, saida);
    assert.equal(r.sha256, esperado);
    assert.equal(r.tamanho, original.length);
    assert.ok(readFileSync(saida).equals(original), 'bytes idênticos aos enviados');
    await assert.rejects(() => c.cofre.exportarParaArquivo('u2', p.id, path.join(c.dir, 'x.bin')), /não encontrado/, 'outra pessoa não exporta');
    // pedido de transcrição não vira link de download
    assert.throws(() => c.cofre.gerarLink('u1', p.id, 10), /só segue para o sistema/);
  } finally {
    c.limpar();
  }
});

// ── o portão ────────────────────────────────────────────────────────────────────────────────────────────

async function sessao(userId: string, video: string[], arquivistas: string[] = []) {
  const c = cofreDeTeste();
  const server = new McpServer({ name: 't', version: '0' });
  const registros: any[] = [];
  const auditar = (r: any) => void registros.push(r);
  const transcritor = criarTranscritor({ modelo: 'whisper-1', cofre: c.cofre, transcrever: async () => ({ text: '', segments: [] }) });
  registrarArquivosSePermitido(server, c.cofre, userId, new Set(arquivistas), () => 'https://agente.test', auditar, new Set(video));
  const ligou = registrarTranscricaoSePermitido(server, transcritor, userId, new Set(video), auditar);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const cliente = new Client({ name: 'teste', version: '0' });
  await Promise.all([server.connect(a), cliente.connect(b)]);
  // sem nenhuma ferramenta registrada o servidor nem anuncia o recurso "tools"
  const nomes = await cliente.listTools().then((l) => l.tools.map((t) => t.name).sort(), () => [] as string[]);
  return { ligou, nomes, cliente, registros, cofre: c.cofre, limpar: c.limpar };
}

test('portão: transcrever_audio só existe para quem está em MCP_VIDEO_EMAILS; quem só está nessa lista recebe o envio de mídia e nada de documentos', async () => {
  const fora = await sessao('u-fora', ['u-gerente'], ['u-fora']);
  assert.equal(fora.ligou, false);
  assert.ok(!fora.nomes.includes('transcrever_audio'));
  assert.deepEqual(fora.nomes, ['arquivo_apagar', 'arquivo_link_temporario', 'arquivo_pedir_upload', 'arquivo_ver_envio'], 'quem já enviava documentos continua igual');
  const semNada = await sessao('u-ninguem', ['u-gerente']);
  assert.deepEqual(semNada.nomes, []);
  assert.equal((await sessao('', [''])).ligou, false, 'usuário vazio nunca entra');

  const gerente = await sessao('u-gerente', ['u-gerente']);
  assert.equal(gerente.ligou, true);
  assert.deepEqual(gerente.nomes, ['arquivo_apagar', 'arquivo_pedir_upload', 'arquivo_ver_envio', 'transcrever_audio'], 'sem link de download de documento');
  const ped: any = await gerente.cliente.callTool({ name: 'arquivo_pedir_upload', arguments: { finalidade: 'vídeo de câmera para transcrever' } });
  const dados = JSON.parse(ped.content[0].text);
  assert.equal(dados.tamanhoMaxMB, 80);
  assert.deepEqual(dados.aceita, ['mp4', 'mov', 'm4a', 'mp3', 'wav']);
  // a auditoria da transcrição guarda só os argumentos
  const t: any = await gerente.cliente.callTool({ name: 'transcrever_audio', arguments: { envio_id: dados.id } });
  assert.equal(t.isError, true, 'arquivo ainda não chegou');
  assert.match(t.content[0].text, /ainda não chegou/);
  assert.deepEqual(gerente.registros.at(-1).argumentos, { envio_id: dados.id });
  const ruim: any = await gerente.cliente.callTool({ name: 'transcrever_audio', arguments: { envio_id: dados.id, inicio_gravacao: 'ontem à tarde' } });
  assert.match(ruim.content[0].text, /inicio_gravacao inválido/, 'formato errado é recusado antes de qualquer trabalho');

  const doc2: any = await gerente.cliente.callTool({ name: 'arquivo_pedir_upload', arguments: { finalidade: 'contrato', midia: false } });
  assert.equal(JSON.parse(doc2.content[0].text).tamanhoMaxMB, 80, 'quem só está na lista de vídeo não ganha envio de documento com midia=false');
  const ambos = await sessao('u-ambos', ['u-ambos'], ['u-ambos']);
  const doc: any = await ambos.cliente.callTool({ name: 'arquivo_pedir_upload', arguments: { finalidade: 'contrato' } });
  assert.equal(JSON.parse(doc.content[0].text).tamanhoMaxMB, 20, 'sem midia=true é o envio de documento de sempre');
  assert.ok(ambos.nomes.includes('arquivo_link_temporario'));
  for (const s of [fora, semNada, gerente, ambos]) s.limpar();
});

test('um envio de documento (ou de outro destino) não pode ser transcrito', async () => {
  const s = await sessao('u-ambos', ['u-ambos'], ['u-ambos']);
  const ped: any = await s.cliente.callTool({ name: 'arquivo_pedir_upload', arguments: { finalidade: 'contrato' } });
  const id = JSON.parse(ped.content[0].text).id;
  const t: any = await s.cliente.callTool({ name: 'transcrever_audio', arguments: { envio_id: id } });
  assert.equal(t.isError, true);
  assert.match(t.content[0].text, /não foi pedido para transcrever/);
  s.limpar();
});

// ── ffmpeg de verdade + OpenAI simulada ───────────────────────────────────────────────────────────

/** Vídeo de teste: 6 s de imagem preta + áudio (tom com tremolo, baixo + chiado), com data gravada no arquivo. */
function criarVideoDeTeste(pasta: string, nome = 'cam.mp4'): string {
  const arq = path.join(pasta, nome);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=6:r=5', '-f', 'lavfi', '-i', 'sine=f=220:d=6:r=8000,tremolo=f=3:d=0.95,volume=0.05', '-f', 'lavfi', '-i', 'anoisesrc=d=6:c=white:a=0.02:r=8000', '-filter_complex', '[1:a][2:a]amix=inputs=2:duration=first:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ac', '1', '-ar', '8000', '-metadata', 'creation_time=2026-11-04T18:40:00Z', arq]);
  return arq;
}

async function subirArquivo(cofre: CofreDeArquivos, arq: string, userId = 'u1') {
  const p = cofre.pedirEnvio({ userId, finalidade: 'câmera', tipos: TIPOS_DE_MIDIA, destino: { tipo: DESTINO_TRANSCRICAO } });
  await cofre.guardar(cofre.reservar(p.token), path.basename(arq), readFileSync(arq));
  return p;
}

test('transcrição ponta a ponta (ffmpeg real, OpenAI simulada): sha do original, horário, srt, filtro de alucinação, temporários apagados, envio apagado', { skip: !TEM_FFMPEG }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'transc-teste-'));
  const tmp = path.join(base, 'tmp');
  execFileSync('mkdir', ['-p', tmp]);
  const { cofre, limpar } = cofreDeTeste();
  try {
    const arq = criarVideoDeTeste(base);
    const sha = createHash('sha256').update(readFileSync(arq)).digest('hex');
    const p = await subirArquivo(cofre, arq);
    const chamadas: Array<{ bytes: number; prompt: string }> = [];
    const transcritor = criarTranscritor({ modelo: 'whisper-1',
      cofre,
      tmpBase: tmp,
      transcrever: async (audio, o) => {
        chamadas.push({ bytes: audio.length, prompt: o.prompt ?? '' });
        return { text: 'x', segments: [seg(0, 2, 'Bom dia, pode entrar.'), seg(2, 4, 'Legendas pela comunidade Amara.org'), seg(4, 6, 'acho que é a gaveta', { avg_logprob: -1.2 })] };
      },
    });
    const r = await transcritor('u1', { envio_id: p.id, inicio_gravacao: '2026-11-04T15:44:50' });
    assert.equal(r.arquivo.sha256, sha, 'SHA-256 do original como enviado');
    assert.equal(r.arquivo.tamanhoBytes, readFileSync(arq).length);
    assert.ok(Math.abs(r.arquivo.duracaoSegundos - 6) < 0.5, `duração ${r.arquivo.duracaoSegundos}`);
    assert.equal(r.original_alterado, false);
    assert.deepEqual(r.linhas, ['[15:44:50] Bom dia, pode entrar.', '[15:44:52] [sem fala]', '[15:44:54] acho que é a gaveta (baixa confiança)']);
    assert.equal(r.horario.origem, 'informado');
    assert.equal(r.resumo.percentual_confianca_boa, 33);
    assert.equal(r.tem_fala, true);
    assert.match(r.srt, /^1\n00:00:00,000 --> 00:00:02,000\nBom dia, pode entrar\.\n\n2\n/);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0]!.prompt, '', 'sem texto de instrução (ele voltava como fala nos trechos mudos)');
    assert.ok(chamadas[0]!.bytes > 1000 && chamadas[0]!.bytes < 100_000, 'só o áudio (mp3 pequeno) vai para a OpenAI, nunca o vídeo');
    assert.equal(r.arquivo_apagado_do_cofre, true);
    assert.deepEqual(readdirSync(tmp), [], 'pasta temporária (com o vídeo decifrado) apagada');
    assert.equal(cofre.ver('u1', p.id).estado, 'apagado');

    // sem inicio_gravacao: usa a data gravada no arquivo (UTC -> Brasília) e avisa
    const p2 = await subirArquivo(cofre, arq);
    const r2 = await transcritor('u1', { envio_id: p2.id, apagar_depois: false });
    assert.equal(r2.horario.origem, 'metadados do arquivo');
    assert.match(r2.linhas[0]!, /^\[15:40:00\]/);
    assert.equal(r2.arquivo_apagado_do_cofre, false);
    assert.equal(cofre.ver('u1', p2.id).estado, 'recebido', 'apagar_depois=false mantém para testar de novo');
    // áudio mudo: o Whisper alucina e a saída diz que não há fala
    const mudo = criarTranscritor({ modelo: 'whisper-1', cofre, tmpBase: tmp, transcrever: async () => ({ text: 'x', segments: [seg(0, 5, 'Obrigado por assistir!'), seg(5, 6, '', { no_speech_prob: 0.97 })] }) });
    const r3 = await mudo('u1', { envio_id: p2.id, limpar_audio: false });
    assert.equal(r3.tem_fala, false);
    assert.match(r3.mensagem!, /não tem fala/);
    assert.equal(r3.filtro_de_limpeza, null);
  } finally {
    limpar();
    rmSync(base, { recursive: true, force: true });
  }
});

test('transcrição: áudio acima do limite é cortado em pedaços e os tempos são somados; só uma por vez; arquivo sem som é recusado', { skip: !TEM_FFMPEG }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'transc-teste-'));
  const { cofre, limpar } = cofreDeTeste();
  try {
    const arq = criarVideoDeTeste(base);
    const p = await subirArquivo(cofre, arq);
    const tamanhos: number[] = [];
    let soltar!: () => void;
    const trava = new Promise<void>((res) => (soltar = res));
    const transcritor = criarTranscritor({ modelo: 'whisper-1',
      cofre,
      tmpBase: base,
      limiteOpenAiBytes: 12_000, // força o recorte (o mp3 de 6 s tem ~36 KB)
      transcrever: async (audio) => {
        tamanhos.push(audio.length);
        await trava;
        return { text: 'x', segments: [seg(0, 1, `pedaço ${tamanhos.length}`)] };
      },
    });
    const emAndamento = transcritor('u1', { envio_id: p.id, inicio_gravacao: '2026-11-04T10:00:00', apagar_depois: false });
    await new Promise((res) => setTimeout(res, 800));
    await assert.rejects(() => transcritor('u1', { envio_id: p.id }), /já há uma transcrição em andamento/);
    soltar();
    const r = await emAndamento;
    assert.ok(r.pedacos_enviados_a_openai >= 2, `esperava 2+ pedaços, veio ${r.pedacos_enviados_a_openai}`);
    assert.ok(tamanhos.every((t) => t <= 12_000), `cada pedaço abaixo do limite: ${tamanhos}`);
    const inicios = r.segmentos.map((s) => s.inicio);
    assert.equal(inicios[0], 0);
    assert.ok(inicios.every((v, i) => i === 0 || v > inicios[i - 1]!), `tempos crescentes e somados: ${inicios}`);
    assert.ok(inicios.at(-1)! < 7 && inicios.at(-1)! > 4, `o último pedaço começa perto do fim (soma das durações reais dos pedaços): ${inicios}`);

    // vídeo sem faixa de áudio
    const mudo = path.join(base, 'mudo.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=2:r=5', '-c:v', 'libx264', '-preset', 'ultrafast', mudo]);
    const p2 = await subirArquivo(cofre, mudo);
    const t2 = criarTranscritor({ modelo: 'whisper-1', cofre, tmpBase: base, transcrever: async () => ({ text: '', segments: [] }) });
    await assert.rejects(() => t2('u1', { envio_id: p2.id }), /não tem faixa de áudio/);
  } finally {
    limpar();
    rmSync(base, { recursive: true, force: true });
  }
});

test('limpeza do áudio: o filtro roda no ffmpeg de verdade, sem lowpass, e sobe o volume de um áudio baixo (8 kHz) em relação ao sem limpeza', { skip: !TEM_FFMPEG }, () => {
  assert.ok(!FILTRO_LIMPEZA.includes('lowpass'), 'em 8 kHz o lowpass de 7 kHz não serve');
  assert.match(FILTRO_LIMPEZA, /highpass=f=100.*afftdn.*dynaudnorm/);
  const base = mkdtempSync(path.join(tmpdir(), 'filtro-teste-'));
  try {
    const arq = criarVideoDeTeste(base);
    const volume = (saida: string) => {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-i', saida, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1]);
    };
    const limpo = path.join(base, 'limpo.mp3');
    const cru = path.join(base, 'cru.mp3');
    execFileSync('ffmpeg', argsDeExtracao(arq, limpo, true));
    execFileSync('ffmpeg', argsDeExtracao(arq, cru, false));
    assert.ok(existsSync(limpo) && existsSync(cru));
    const [vLimpo, vCru] = [volume(limpo), volume(cru)];
    assert.ok(Number.isFinite(vLimpo) && Number.isFinite(vCru));
    assert.ok(vLimpo > vCru + 6, `limpo ${vLimpo} dB deve ser bem mais alto que cru ${vCru} dB`);
    // saída do extrator: mono, 16 kHz
    const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=channels,sample_rate', '-of', 'csv=p=0', limpo], { encoding: 'utf8' }).trim();
    assert.equal(info, '16000,1');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});


test('gpt-4o-transcribe (padrão): sem prompt, cada pedaço curto vira um segmento com o tempo do pedaço', { skip: !TEM_FFMPEG }, async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'transc-gpt4o-'));
  const tmp = path.join(base, 'tmp');
  execFileSync('mkdir', ['-p', tmp]);
  const { cofre, limpar } = cofreDeTeste();
  try {
    const arq = criarVideoDeTeste(base);
    const p = await subirArquivo(cofre, arq);
    const chamadas: Array<{ prompt?: string; duracaoSeg?: number; modelo?: string }> = [];
    const transcritor = criarTranscritor({
      cofre,
      tmpBase: tmp,
      modelo: 'gpt-4o-transcribe',
      transcrever: async (_audio, o) => {
        chamadas.push({ prompt: o.prompt, duracaoSeg: o.duracaoSeg, modelo: o.modelo });
        return { text: 'Bom dia, pode entrar.', segments: [seg(0, o.duracaoSeg ?? 0, 'Bom dia, pode entrar.')] };
      },
    });
    const r = await transcritor('u1', { envio_id: p.id, inicio_gravacao: '2026-11-04T15:44:50' });
    assert.equal(r.modelo, 'gpt-4o-transcribe');
    assert.ok(chamadas.length >= 1);
    assert.equal(chamadas[0]!.prompt, undefined, 'nenhum texto de instrução vai para a OpenAI');
    assert.equal(chamadas[0]!.modelo, 'gpt-4o-transcribe');
    assert.ok((chamadas[0]!.duracaoSeg ?? 0) > 0 && (chamadas[0]!.duracaoSeg ?? 99) <= PEDACO_GPT4O_SEG + 1, `duração do pedaço ${chamadas[0]!.duracaoSeg}`);
    assert.deepEqual(r.linhas, ['[15:44:50] Bom dia, pode entrar.']);
  } finally {
    limpar();
  }
});

test('mediaLogprob: média dos tokens; sem tokens = -1 (confiança desconhecida)', () => {
  assert.equal(mediaLogprob([{ logprob: -0.2 }, { logprob: -0.4 }]), -0.30000000000000004);
  assert.equal(mediaLogprob([]), -1);
  assert.equal(mediaLogprob(undefined), -1);
});
