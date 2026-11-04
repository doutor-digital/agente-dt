/**
 * Transcrição do áudio de gravações de câmera pelo claude.ai (04/11/2026, pedido da Suzanne via Lia, "Auditor de Câmeras"): o Claude não
 * roda Whisper no ambiente dele. O arquivo (mp4/mov/m4a/mp3/wav, até 80 MB) entra pelo cofre de envio que já existe
 * (`arquivo_pedir_upload` com midia=true → a pessoa envia → `transcrever_audio`). Aqui:
 *
 *   1. o arquivo é decifrado do cofre para um arquivo temporário (em fluxo, sem trazer 80 MB para a memória) e o SHA-256 é conferido
 *      contra o da chegada. O ORIGINAL nunca é alterado: tudo abaixo trabalha em cópias do temporário, que é apagado ao fim;
 *   2. o ffmpeg tira só o áudio (mono, 16 kHz, mp3 48 kbps) e, se `limpar_audio`, filtra ruído e nivela o volume;
 *   3. a OpenAI (whisper-1, verbose_json, idioma pt, temperatura 0) devolve segmentos com tempo e confiança; acima de 25 MB o áudio é
 *      cortado em pedaços e os tempos são somados;
 *   4. cada segmento é classificado (fala / baixa confiança / inaudível / sem fala) para NÃO inventar fala em áudio mudo ou ruidoso;
 *   5. saída: segmentos, linhas com o horário real, o .srt e o resumo de confiança.
 *
 * Uma transcrição por vez no servidor (ffmpeg + arquivo grande dividem o contêiner de 1 GB com a Sofia). Só quem está em
 * MCP_VIDEO_EMAILS enxerga a ferramenta. Áudio de funcionário é dado pessoal: a auditoria guarda só os argumentos, nunca o texto.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import type { SegmentoWhisper, TranscricaoComSegmentos } from '../services/transcription.service.js';
import { modeloDeTranscricao } from '../lib/transcricao-modelo.js';

/** com gpt-4o-transcribe (sem segmentos nativos) o áudio vai em pedaços deste tamanho: cada pedaço vira uma linha com horário */
export const PEDACO_GPT4O_SEG = 15;
import { executar } from './ferramenta.js';
import { CofreDeArquivos, ErroDeCofre } from './cofre-arquivos.js';

export const DESTINO_TRANSCRICAO = 'transcricao';

/**
 * Limpeza do áudio de câmera (costuma ser 8 kHz, baixo e ruidoso): corta o grave (highpass), tira o ruído de fundo (afftdn) e nivela o volume
 * com ganho de até 20x (dynaudnorm m=20; o padrão é 10x e a câmera grava baixo demais). Sem lowpass: em 8 kHz não serve. A ordem importa:
 * normalizar ANTES de tirar o ruído amplificaria o chiado.
 */
export const FILTRO_LIMPEZA = 'highpass=f=100,afftdn=nf=-30,dynaudnorm=f=200:g=11:m=20';
export const PROMPT_CONTEXTO = 'Gravação de câmera de segurança em clínica/loja; conversa entre funcionários e clientes em português do Brasil.';
/** mono, 16 kHz, mp3 48 kbps: ~2 MB para 5 min (a OpenAI aceita até 25 MB por arquivo) */
export const BITRATE_DO_AUDIO = '48k';
export const BYTES_POR_SEGUNDO_DO_AUDIO = 6000;
export const DURACAO_MAX_SEG = 90 * 60;
/** margem abaixo dos 25 MB da OpenAI */
export const LIMITE_OPENAI_PADRAO_BYTES = 24 * 1024 * 1024;
export const CUSTO_US_POR_MINUTO = 0.006;
const TEMPO_MAX_FFMPEG_MS = 5 * 60_000;

/** Limiares por segmento do verbose_json do Whisper (os mesmos números que o próprio Whisper usa para decidir "sem fala"/"baixa confiança"). */
export const LIMIARES = {
  /** fala improvável: sem_fala_prob alta E texto de baixa confiança... */
  semFalaProb: 0.6,
  /** ...ou sem_fala_prob tão alta que não precisa da segunda condição */
  semFalaProbCerta: 0.85,
  logprobBaixo: -1.0,
  logprobInaudivel: -1.5,
  /** texto que se repete (laço de alucinação) */
  compressaoMax: 2.4,
};

export type Situacao = 'fala' | 'baixa_confianca' | 'inaudivel' | 'sem_fala';

export const TEXTO_SEM_FALA = '[sem fala]';
export const TEXTO_INAUDIVEL = '[inaudível]';

// ---------------------------------------------------------------- classificação do segmento

/** O que o Whisper escreve quando ouve silêncio/ruído: créditos de legenda e despedidas de vídeo. */
const FRASES_FORTES = [/amara\.org/, /legendas? pel[ao]s? comunidade/, /legendado por/, /tradu[cç][aã]o e legendas/, /obrigad[oa] por assistir/, /inscreva-?se (no|em) (o )?(nosso )?canal/, /thanks for watching/, /subtitles by/];
const FRASES_FRACAS = [/^(obrigad[oa]|tchau|ate (mais|logo)|ok|ta|ne|ah|hum|uh|eh)$/, /^musica$/];

const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** o prompt de contexto sem acento, para reconhecer o eco dele na resposta */
const PROMPT_SEM_ACENTO = semAcento(PROMPT_CONTEXTO);

function alfabetoLatino(texto: string): boolean {
  const letras = texto.replace(/[^\p{L}]/gu, '');
  if (letras.length === 0) return true;
  return letras.replace(/[^\p{Script=Latin}]/gu, '').length / letras.length >= 0.8;
}

export interface Classificado {
  situacao: Situacao;
  texto: string;
  motivo?: string;
}

/**
 * Decide o que fazer com UM segmento do Whisper. Em dúvida entre "texto talvez inventado" e "marcar", marca: o Auditor descreve o que ouve,
 * e fala que não existiu em gravação de funcionário é pior que um trecho em branco.
 */
export function classificarSegmento(s: Pick<SegmentoWhisper, 'text' | 'avg_logprob' | 'no_speech_prob' | 'compression_ratio'>): Classificado {
  const texto = (s.text ?? '').replace(/\s+/g, ' ').trim();
  const limpo = semAcento(texto);
  const sem = (motivo: string): Classificado => ({ situacao: 'sem_fala', texto: TEXTO_SEM_FALA, motivo });
  const ina = (motivo: string): Classificado => ({ situacao: 'inaudivel', texto: TEXTO_INAUDIVEL, motivo });
  if (!limpo.replace(/[. ]/g, '')) return sem('segmento vazio');
  // o Whisper às vezes devolve o próprio prompt de contexto em trecho mudo
  if (limpo.length >= 25 && PROMPT_SEM_ACENTO.includes(limpo.replace(/\.+$/, ''))) return sem('eco do texto de contexto (o modelo não ouviu fala)');
  if (FRASES_FORTES.some((r) => r.test(limpo))) return sem('frase típica de alucinação do Whisper em silêncio/ruído');
  if ((s.no_speech_prob >= LIMIARES.semFalaProbCerta) || (s.no_speech_prob >= LIMIARES.semFalaProb && s.avg_logprob < LIMIARES.logprobBaixo)) return sem('fala improvável (o modelo ouviu silêncio ou ruído)');
  if (FRASES_FRACAS.some((r) => r.test(limpo.replace(/\.+$/, ''))) && (s.no_speech_prob >= 0.3 || s.avg_logprob < -0.7)) return sem('frase curta típica de alucinação, com sinal de silêncio');
  if (!alfabetoLatino(texto)) return ina('texto em outro alfabeto (alucinação)');
  if (s.compression_ratio > LIMIARES.compressaoMax) return ina('texto repetitivo (alucinação)');
  if (s.avg_logprob < LIMIARES.logprobInaudivel) return ina('confiança muito baixa');
  if (s.avg_logprob < LIMIARES.logprobBaixo) return { situacao: 'baixa_confianca', texto, motivo: 'confiança baixa: confira ouvindo o original' };
  return { situacao: 'fala', texto };
}

export interface SegmentoSaida {
  inicio: number;
  fim: number;
  texto: string;
  situacao: Situacao;
  motivo?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Classifica todos e derruba a repetição em laço (o mesmo texto 3+ vezes seguidas: fica o primeiro, o resto vira inaudível). */
export function prepararSegmentos(brutos: SegmentoWhisper[]): SegmentoSaida[] {
  const out: SegmentoSaida[] = [];
  let ultimo = '';
  let seguidas = 0;
  for (const b of brutos) {
    let c = classificarSegmento(b);
    if (c.situacao === 'fala' || c.situacao === 'baixa_confianca') {
      const chave = semAcento(c.texto);
      seguidas = chave === ultimo ? seguidas + 1 : 1;
      ultimo = chave;
      if (seguidas >= 3) c = { situacao: 'inaudivel', texto: TEXTO_INAUDIVEL, motivo: 'texto repetido várias vezes seguidas (alucinação)' };
    } else {
      ultimo = '';
      seguidas = 0;
    }
    out.push({ inicio: r2(b.start), fim: r2(b.end), texto: c.situacao === 'baixa_confianca' ? `${c.texto} (baixa confiança)` : c.texto, situacao: c.situacao, ...(c.motivo ? { motivo: c.motivo } : {}) });
  }
  return out;
}

export interface Resumo {
  segmentos: number;
  confianca_boa: number;
  baixa_confianca: number;
  inaudiveis: number;
  sem_fala: number;
  /** % dos segmentos com fala de confiança boa (sobre todos os segmentos) */
  percentual_confianca_boa: number;
  tem_fala: boolean;
}

export function resumir(segs: SegmentoSaida[]): Resumo {
  const n = (s: Situacao) => segs.filter((x) => x.situacao === s).length;
  const boa = n('fala');
  return {
    segmentos: segs.length,
    confianca_boa: boa,
    baixa_confianca: n('baixa_confianca'),
    inaudiveis: n('inaudivel'),
    sem_fala: n('sem_fala'),
    percentual_confianca_boa: segs.length ? Math.round((boa / segs.length) * 100) : 0,
    tem_fala: boa + n('baixa_confianca') > 0,
  };
}

// ---------------------------------------------------------------- tempo, .srt, horário real

const dois = (n: number) => String(n).padStart(2, '0');

/** 00:01:02,500 (formato do .srt) */
export function tempoSrt(seg: number): string {
  const ms = Math.max(0, Math.round(seg * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${dois(h)}:${dois(m)}:${dois(s)},${String(ms % 1000).padStart(3, '0')}`;
}

/** O .srt a partir dos segmentos. Texto sem linha em branco (quebraria o cue) e sem "-->". */
export function montarSrt(segs: ReadonlyArray<Pick<SegmentoSaida, 'inicio' | 'fim' | 'texto'>>): string {
  return segs
    .map((s, i) => {
      const fim = s.fim > s.inicio ? s.fim : s.inicio + 0.5;
      const texto = s.texto.replace(/-->/g, '→').replace(/\s*\n\s*/g, ' ').trim();
      return `${i + 1}\n${tempoSrt(s.inicio)} --> ${tempoSrt(fim)}\n${texto}\n`;
    })
    .join('\n');
}

export type OrigemDoHorario = 'informado' | 'metadados do arquivo' | 'relativo';

const RE_SEM_FUSO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * O início da gravação como "hora de parede" em ms (conta feita em UTC, como no vigia de vídeo). Sem fuso na data = já é a hora do
 * relógio de quem gravou; com fuso (Z, -03:00) converte para America/Sao_Paulo. Data impossível ou anterior a 2000 (câmera sem relógio) é ignorada.
 */
export function horaDeParede(iso: string | undefined): number | null {
  const t = iso?.trim();
  if (!t) return null;
  const m = RE_SEM_FUSO.exec(t);
  let ms: number;
  if (m) {
    ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
    const conferido = new Date(ms);
    if (conferido.getUTCMonth() !== +m[2]! - 1 || conferido.getUTCDate() !== +m[3]!) return null;
  } else {
    const abs = Date.parse(t);
    if (!Number.isFinite(abs)) return null;
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(abs))
        .map((x) => [x.type, x.value]),
    );
    ms = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  }
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) ? ms : null;
}

export function escolherInicio(informado: string | undefined, metadados: string | undefined): { baseMs: number | null; origem: OrigemDoHorario } {
  if (informado?.trim()) {
    const ms = horaDeParede(informado);
    if (ms === null) throw new ErroDeEntrada('inicio_gravacao inválido: use data e hora, ex. 2026-11-04T15:40:00');
    return { baseMs: ms, origem: 'informado' };
  }
  const ms = horaDeParede(metadados);
  return ms === null ? { baseMs: null, origem: 'relativo' } : { baseMs: ms, origem: 'metadados do arquivo' };
}

/** `[15:44:55]` (horário real) ou `[00:04:12]` (tempo desde o início, quando não há horário). Se a gravação passa da meia-noite, `[11-05 00:01:02]`. */
export function rotuloDeTempo(seg: number, baseMs: number | null): string {
  const s = Math.max(0, Math.floor(seg));
  if (baseMs === null) return `[${dois(Math.floor(s / 3600))}:${dois(Math.floor((s % 3600) / 60))}:${dois(s % 60)}]`;
  const iso = new Date(baseMs + s * 1000).toISOString();
  const outroDia = iso.slice(0, 10) !== new Date(baseMs).toISOString().slice(0, 10);
  return `[${outroDia ? `${iso.slice(5, 10)} ` : ''}${iso.slice(11, 19)}]`;
}

export function linhasComHorario(segs: ReadonlyArray<Pick<SegmentoSaida, 'inicio' | 'texto'>>, baseMs: number | null): string[] {
  return segs.map((s) => `${rotuloDeTempo(s.inicio, baseMs)} ${s.texto}`);
}

// ---------------------------------------------------------------- recorte (áudio acima do limite da OpenAI)

/** Quantos segundos por pedaço, ou null se cabe inteiro. Pedaços de ~80% do limite, sempre com margem. */
export function planejarRecorte(tamanhoBytes: number, duracaoSeg: number, limiteBytes = LIMITE_OPENAI_PADRAO_BYTES): number | null {
  if (tamanhoBytes <= limiteBytes) return null;
  const bytesPorSeg = tamanhoBytes / Math.max(1, duracaoSeg);
  return Math.max(1, Math.floor((limiteBytes * 0.8) / bytesPorSeg));
}

/** Junta as transcrições dos pedaços somando o começo de cada um aos tempos. */
export function juntarPedacos(partes: ReadonlyArray<{ inicioSeg: number; segmentos: SegmentoWhisper[] }>): SegmentoWhisper[] {
  return partes.flatMap((p) => p.segmentos.map((s) => ({ ...s, start: s.start + p.inicioSeg, end: s.end + p.inicioSeg })));
}

// ---------------------------------------------------------------- ffmpeg / ffprobe

interface Executados {
  stdout: string;
  stderr: string;
}

function rodarFerramenta(bin: string, args: string[], timeoutMs = TEMPO_MAX_FFMPEG_MS): Promise<Executados> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      if ((err as { killed?: boolean }).killed) return reject(new ErroDeEntrada('o processamento do áudio demorou demais e foi interrompido; tente com limpar_audio=false ou com um trecho menor'));
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${path.basename(bin)} não está instalado neste servidor; avise o João (a imagem do backend precisa do ffmpeg)`));
      const fim = String(stderr || err.message).trim().split('\n').slice(-2).join(' ').slice(0, 300);
      reject(new ErroDeEntrada(`não consegui ler o áudio do arquivo (${fim || 'erro do ffmpeg'}). Confira se o vídeo toca e tem som.`));
    });
  });
}

interface Sonda {
  duracaoSeg: number;
  temAudio: boolean;
  criadoEm?: string;
}

export async function sondar(ffprobe: string, arquivo: string): Promise<Sonda> {
  const { stdout } = await rodarFerramenta(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', arquivo], 60_000);
  let j: { format?: { duration?: string; tags?: Record<string, string> }; streams?: Array<{ codec_type?: string; tags?: Record<string, string> }> };
  try {
    j = JSON.parse(stdout);
  } catch {
    throw new ErroDeEntrada('não consegui ler o arquivo como vídeo/áudio (formato inválido)');
  }
  const duracao = Number(j.format?.duration);
  const tags = { ...(j.streams ?? []).reduce<Record<string, string>>((a, s) => ({ ...a, ...(s.tags ?? {}) }), {}), ...(j.format?.tags ?? {}) };
  const criado = Object.entries(tags).find(([k]) => k.toLowerCase() === 'creation_time')?.[1];
  return { duracaoSeg: Number.isFinite(duracao) ? duracao : 0, temAudio: (j.streams ?? []).some((s) => s.codec_type === 'audio'), ...(criado ? { criadoEm: criado } : {}) };
}

export function argsDeExtracao(entrada: string, saida: string, limpar: boolean): string[] {
  return [
    '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', entrada,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    ...(limpar ? ['-af', FILTRO_LIMPEZA] : []),
    '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', BITRATE_DO_AUDIO, '-threads', '1',
    saida,
  ];
}

// ---------------------------------------------------------------- a transcrição

export interface DepsTranscricao {
  cofre: CofreDeArquivos;
  /** chama a OpenAI com UM pedaço de áudio já em memória (a produção usa `transcreverComSegmentos`) */
  transcrever: (audio: Buffer, o: { ext: string; prompt?: string; duracaoSeg?: number; modelo?: string }) => Promise<TranscricaoComSegmentos>;
  /** modelo da OpenAI (padrão: TRANSCRICAO_MODELO ou gpt-4o-transcribe) */
  modelo?: string;
  ffmpeg?: string;
  ffprobe?: string;
  /** onde ficam os temporários (padrão: tmp do sistema) */
  tmpBase?: string;
  limiteOpenAiBytes?: number;
  log?: { warn(o: object, m?: string): void };
}

export interface ArgsTranscricao {
  envio_id: string;
  limpar_audio?: boolean;
  inicio_gravacao?: string;
  apagar_depois?: boolean;
}

const PREFIXO_TMP = 'dd-transcricao-';

/** Apaga temporários de uma execução que morreu no meio (kill -9/OOM). Chamada na subida do servidor. */
export async function limparTemporarios(tmpBase = tmpdir()): Promise<number> {
  let n = 0;
  for (const nome of await readdir(tmpBase).catch(() => [] as string[])) {
    if (!nome.startsWith(PREFIXO_TMP)) continue;
    await rm(path.join(tmpBase, nome), { recursive: true, force: true }).then(() => n++).catch(() => undefined);
  }
  return n;
}

export function criarTranscritor(deps: DepsTranscricao) {
  const ffmpeg = deps.ffmpeg ?? process.env.FFMPEG_PATH?.trim() ?? 'ffmpeg';
  const ffprobe = deps.ffprobe ?? process.env.FFPROBE_PATH?.trim() ?? 'ffprobe';
  const limiteOpenAi = deps.limiteOpenAiBytes ?? LIMITE_OPENAI_PADRAO_BYTES;
  /** uma transcrição por vez no servidor inteiro (memória do contêiner) */
  let ocupado = false;

  return async function transcreverEnvio(userId: string, a: ArgsTranscricao) {
    if (ocupado) throw new ErroDeEntrada('já há uma transcrição em andamento neste servidor; espere ela terminar e repita (uma por vez)');
    ocupado = true;
    const limpar = a.limpar_audio ?? true;
    const apagarDepois = a.apagar_depois ?? true;
    let dir: string | undefined;
    try {
      if (a.inicio_gravacao?.trim()) escolherInicio(a.inicio_gravacao, undefined); // formato errado: recusa antes de decifrar 80 MB
      dir = await mkdtemp(path.join(deps.tmpBase ?? tmpdir(), PREFIXO_TMP));
      // confere de quem é e para que serve ANTES de decifrar qualquer coisa
      let destino;
      try {
        destino = deps.cofre.destinoDe(userId, a.envio_id);
      } catch (e) {
        if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
        throw e;
      }
      if (destino?.tipo !== DESTINO_TRANSCRICAO) throw new ErroDeEntrada('esse envio não foi pedido para transcrever: peça um novo com arquivo_pedir_upload usando midia=true');
      const entrada = path.join(dir, 'entrada');
      let original;
      try {
        original = await deps.cofre.exportarParaArquivo(userId, a.envio_id, entrada);
      } catch (e) {
        if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
        throw e;
      }

      const sonda = await sondar(ffprobe, entrada);
      if (!(sonda.duracaoSeg > 0)) throw new ErroDeEntrada('não consegui saber a duração do arquivo (cabeçalho incompleto ou arquivo cortado); peça para exportar de novo');
      if (!sonda.temAudio) throw new ErroDeEntrada('o arquivo não tem faixa de áudio (é só imagem); não há o que transcrever');
      if (sonda.duracaoSeg > DURACAO_MAX_SEG) throw new ErroDeEntrada(`o arquivo tem ${Math.round(sonda.duracaoSeg / 60)} min; o máximo por vez é ${DURACAO_MAX_SEG / 60} min (corte em trechos)`);
      const inicio = escolherInicio(a.inicio_gravacao, sonda.criadoEm);

      const audio = path.join(dir, 'audio.mp3');
      await rodarFerramenta(ffmpeg, argsDeExtracao(entrada, audio, limpar));
      await rm(entrada, { force: true }); // o temporário do original sai assim que o áudio existe (o original segue intacto no cofre)

      const bytes = (await stat(audio)).size;
      const modelo = deps.modelo ?? modeloDeTranscricao();
      const porTamanho = planejarRecorte(bytes, sonda.duracaoSeg, limiteOpenAi);
      // gpt-4o-transcribe não devolve tempos: pedaços curtos SEMPRE (o tempo de cada linha = começo do pedaço)
      const corte = modelo === 'whisper-1' ? porTamanho : Math.min(porTamanho ?? PEDACO_GPT4O_SEG, PEDACO_GPT4O_SEG);
      const pedacos: Array<{ arquivo: string; inicioSeg: number; duracaoSeg: number }> = [];
      if (corte === null) {
        pedacos.push({ arquivo: audio, inicioSeg: 0, duracaoSeg: sonda.duracaoSeg });
      } else {
        await rodarFerramenta(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', audio, '-f', 'segment', '-segment_time', String(corte), '-c', 'copy', path.join(dir, 'parte-%03d.mp3')]);
        let acumulado = 0;
        for (const nome of (await readdir(dir)).filter((n) => /^parte-\d{3}\.mp3$/.test(n)).sort()) {
          const arquivo = path.join(dir, nome);
          const dur = (await sondar(ffprobe, arquivo)).duracaoSeg;
          pedacos.push({ arquivo, inicioSeg: acumulado, duracaoSeg: dur });
          acumulado += dur; // duração real de cada pedaço: o corte cai no quadro mais próximo
        }
      }

      const partes: Array<{ inicioSeg: number; segmentos: SegmentoWhisper[] }> = [];
      for (const p of pedacos) {
        const buf = await readFile(p.arquivo);
        // sem texto de instrução: ele voltava como fala nos trechos mudos (relato da Lia, 04/11)
        const r = await deps.transcrever(buf, { ext: 'mp3', duracaoSeg: p.duracaoSeg, modelo });
        partes.push({ inicioSeg: p.inicioSeg, segmentos: r.segments });
      }

      const segs = prepararSegmentos(juntarPedacos(partes));
      const resumo = resumir(segs);
      const duracaoSeg = r2(sonda.duracaoSeg);
      let apagado = false;
      if (apagarDepois) {
        try {
          apagado = deps.cofre.apagar(userId, a.envio_id);
        } catch (e) {
          deps.log?.warn({ err: e }, 'transcrição: não consegui apagar o envio do cofre');
        }
      }
      return {
        arquivo: { nome: original.nome, tipo: original.tipo, tamanhoBytes: original.tamanho, sha256: original.sha256, duracaoSegundos: duracaoSeg, duracao: `${dois(Math.floor(duracaoSeg / 3600))}:${dois(Math.floor((duracaoSeg % 3600) / 60))}:${dois(Math.floor(duracaoSeg % 60))}` },
        original_alterado: false,
        provas: 'sha256 é o do arquivo exatamente como foi enviado (calculado na chegada e conferido de novo na leitura); a transcrição trabalha numa cópia do áudio',
        idioma: 'pt',
        modelo,
        limpar_audio: limpar,
        filtro_de_limpeza: limpar ? FILTRO_LIMPEZA : null,
        pedacos_enviados_a_openai: pedacos.length,
        horario: inicio.origem === 'relativo'
          ? { origem: 'relativo', aviso: 'Sem horário real: nem inicio_gravacao nem a data dentro do arquivo. Os tempos são desde o começo do arquivo; passe inicio_gravacao (ex. 2026-11-04T15:40:00) para ter o horário da gravação.' }
          : { origem: inicio.origem, inicio: new Date(inicio.baseMs!).toISOString().slice(0, 19), ...(inicio.origem === 'metadados do arquivo' ? { aviso: 'Horário lido da data gravada no arquivo; relógio de câmera costuma estar errado: confira.' } : {}) },
        tem_fala: resumo.tem_fala,
        ...(resumo.tem_fala ? {} : { mensagem: 'Este trecho não tem fala detectável (silêncio, ruído ou música). Nada foi inventado.' }),
        resumo,
        linhas: linhasComHorario(segs, inicio.baseMs),
        segmentos: segs,
        srt: montarSrt(segs),
        custo_estimado_usd: Math.round((sonda.duracaoSeg / 60) * CUSTO_US_POR_MINUTO * 1000) / 1000,
        arquivo_apagado_do_cofre: apagado,
        ...(apagado ? {} : { aviso_cofre: 'O arquivo continua guardado (cifrado) até no máximo 2 h; apague com arquivo_apagar quando terminar.' }),
        aviso: AVISO_TRANSCRICAO,
      };
    } finally {
      ocupado = false;
      if (dir) await rm(dir, { recursive: true, force: true }).catch((err) => deps.log?.warn({ err }, 'transcrição: não consegui apagar a pasta temporária'));
    }
  };
}

export const AVISO_TRANSCRICAO =
  'Transcrição APROXIMADA de áudio de câmera (costuma ser ruim). Transcreva e descreva o que se ouve; nunca acuse ninguém. Trecho importante deve ser conferido ouvindo o original. [inaudível] e [sem fala] são marcas de propósito: não preencha esses trechos.';

// ---------------------------------------------------------------- a ferramenta

export function registrarTranscricao(server: McpServer, transcrever: ReturnType<typeof criarTranscritor>, userId: string, auditar: Auditar): void {
  server.registerTool(
    'transcrever_audio',
    {
      title: 'Transcrever o áudio de um vídeo de câmera',
      description:
        'PASSO 3 de 3 para transcrever o áudio de um vídeo/áudio de câmera (iCSee etc.) quando você não consegue rodar Whisper. Fluxo: ' +
        '1) arquivo_pedir_upload com midia=true e finalidade "vídeo de câmera para transcrever" (aceita .mp4 .mov .m4a .mp3 .wav, até 80 MB; conferido pelo conteúdo); ' +
        '2) a pessoa abre o link e envia o arquivo (confira com arquivo_ver_envio); 3) transcrever_audio com o envio_id. ' +
        'Devolve: nome, tamanho, duração e o SHA-256 do arquivo ORIGINAL como foi enviado (o original não é alterado); segmentos [{inicio, fim, texto, situacao}] em português; ' +
        'linhas "[15:44:55] texto" com o HORÁRIO REAL (passe inicio_gravacao, ex. 2026-11-04T15:40:00; sem ele usa a data gravada no arquivo, e sem nenhuma das duas mostra o tempo desde o começo); o .srt pronto; e um resumo com o % de trechos de confiança boa. ' +
        'Áudio de câmera costuma ser RUIM: a transcrição é APROXIMADA e trecho importante deve ser conferido ouvindo o original. ' +
        'Trecho sem fala vem como [sem fala] e trecho que não dá para entender como [inaudível] ou "(baixa confiança)": NUNCA preencha esses trechos nem adivinhe o que foi dito. Se tem_fala for false, diga que não há fala. ' +
        'Não separa quem fala (não diz quem é quem). É dado pessoal de funcionário (LGPD): transcreva e descreva, nunca acuse. ' +
        'limpar_audio (padrão true) filtra ruído e nivela o volume antes de transcrever; use false para comparar. O arquivo é apagado do servidor logo depois (apagar_depois=false para manter e testar de novo). Uma transcrição por vez. Custo ~US$ 0,006 por minuto de áudio.',
      inputSchema: {
        envio_id: z.string().trim().min(8).max(64).describe('o id devolvido por arquivo_pedir_upload (com midia=true); o arquivo já tem que ter chegado'),
        limpar_audio: z.boolean().optional().describe('filtrar ruído e nivelar o volume antes de transcrever (padrão true)'),
        inicio_gravacao: z.string().trim().max(40).optional().describe('data e hora em que a gravação COMEÇOU, ex. 2026-11-04T15:40:00 (hora do relógio da câmera/loja); dá o horário real de cada fala'),
        apagar_depois: z.boolean().optional().describe('apagar o arquivo do servidor ao terminar (padrão true)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    // só os argumentos vão para a auditoria; nunca o texto transcrito
    (args) => executar('transcrever_audio', args, auditar, () => transcrever(userId, args)),
  );
}

/** O portão: só quem está em MCP_VIDEO_EMAILS (já convertida em ids de usuário) enxerga a ferramenta; fora dela ela não existe na sessão. */
export function registrarTranscricaoSePermitido(
  server: McpServer,
  transcrever: ReturnType<typeof criarTranscritor>,
  userId: string,
  permitidos: ReadonlySet<string>,
  auditar: Auditar,
): boolean {
  if (!userId || !permitidos.has(userId)) return false;
  registrarTranscricao(server, transcrever, userId, auditar);
  return true;
}
