/**
 * Vigia de vídeo pelo claude.ai (03/11/2026): a gerente analisa gravações de câmera de 10+ horas (OBS) à procura de comportamento
 * suspeito. O VÍDEO NUNCA SOBE: o claude.ai não recebe arquivo de GB e o Claude não vê vídeo, só imagem. O computador que grava roda a
 * triagem (ops/vigia-video/) e manda para cá só o PACOTE de cada gravação:
 *
 *   <VIGIA_DIR>/<camera>/<AAAA-MM-DD_HHMM>/{meta.json, eventos.json, resumo.md, folhas/evento_NNNN.jpg, clipes/evento_NNNN.mp4}
 *
 * O `meta.json` é o último arquivo a chegar e é ele que faz a gravação aparecer (envio pela metade nunca é listado).
 * Este módulo só LÊ essa pasta (monte o volume como somente leitura). Três ferramentas, só para quem está em MCP_VIDEO_EMAILS:
 *   video_gravacoes  lista as gravações (câmera, data/hora real, duração, nº de eventos, movimento por hora)
 *   video_folhas     as folhas de contato dos eventos como IMAGEM, com o horário real de cada quadro
 *   video_clipe      link temporário (HMAC, 15 a 30 min) do clipe leve do evento; o link abre numa rota pública do backend
 *
 * O id da gravação (`caixa_2026-11-03_0800`) e o número do evento vêm do modelo: são validados por expressão fechada e o
 * caminho é montado só com eles, nunca com texto do arquivo (`eventos.json` não escolhe caminho). A hora é a do relógio do
 * computador que gravou, tratada como "hora de parede" (sem fuso).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar, executarComImagens, type Conteudo } from './ferramenta.js';
import { ipDoCliente } from './limites.js';

export const RETENCAO_PADRAO_DIAS = 30;
export const LINK_PADRAO_MIN = 15;
export const LINK_MAX_MIN = 30;
const MAX_FOLHAS = 8;
const MAX_EVENTOS_NO_INDICE = 300;
const TAMANHO_MAX_JSON = 8 * 1024 * 1024;
const TAMANHO_MAX_FOLHA = 1.5 * 1024 * 1024;
const MAX_DOWNLOADS_AO_MESMO_TEMPO = 3;

const RE_CAMERA = /^[a-z0-9][a-z0-9-]{0,38}$/;
const RE_STAMP = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})$/;
const RE_GRAVACAO = /^([a-z0-9][a-z0-9-]{0,38})_(\d{4}-\d{2}-\d{2}_\d{4})$/;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

export const AVISO_VIDEO =
  'Descreva o que se VÊ (quem, onde, o que a mão faz); nunca acuse ninguém. A folha tem baixa resolução e pula segundos: "parece pegar algo" não é "pegou". Quem decide é a pessoa, vendo o clipe.';

export interface ContextoVideo {
  /** pasta com os pacotes (somente leitura) */
  dir: string;
  retencaoDias: number;
  /** origem pública do backend, sem barra no fim (https://agente-vps...) */
  urlPublica: string;
  segredo: string;
  agora: () => number;
}

/** `VIGIA_DIR` vazio = o vigia não existe neste servidor. `VIGIA_RETENCAO_DIAS` inválido volta ao padrão. */
export function contextoVideoDoAmbiente(
  amb: Record<string, string | undefined>,
  o: { urlPublica: string; segredo: string; agora?: () => number },
): ContextoVideo | null {
  const dir = amb.VIGIA_DIR?.trim();
  if (!dir) return null;
  const dias = Number(amb.VIGIA_RETENCAO_DIAS);
  return {
    dir: path.resolve(dir),
    retencaoDias: Number.isInteger(dias) && dias >= 1 && dias <= 365 ? dias : RETENCAO_PADRAO_DIAS,
    urlPublica: o.urlPublica.replace(/\/+$/, ''),
    segredo: o.segredo,
    agora: o.agora ?? Date.now,
  };
}

// ---------------------------------------------------------------- ids e caminhos

export function lerIdDaGravacao(id: string): { camera: string; stamp: string } {
  const m = RE_GRAVACAO.exec(id.trim());
  if (!m) throw new ErroDeEntrada('gravacao inválida: use o id que video_gravacoes devolveu (ex.: caixa_2026-11-03_0800)');
  return { camera: m[1]!, stamp: m[2]! };
}

const pad4 = (n: number) => String(n).padStart(4, '0');
const idDaGravacao = (camera: string, stamp: string) => `${camera}_${stamp}`;

/** Hora de parede da pasta (`2026-11-03_0800`) em ms, tratada como UTC só para fazer conta. */
function inicioDoStamp(stamp: string): number {
  const m = RE_STAMP.exec(stamp)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
}

/** `2026-11-03 08:00:35` a partir de ms de hora de parede. */
const fmtDataHora = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const fmtHora = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const fmtDuracao = (seg: number) => {
  const s = Math.max(0, Math.round(seg));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function foraDaRetencao(ctx: ContextoVideo, stamp: string): boolean {
  return inicioDoStamp(stamp) < ctx.agora() - ctx.retencaoDias * 86_400_000;
}

/**
 * O caminho real de um arquivo do pacote, que TEM de ficar dentro de `ctx.dir` depois de resolver links simbólicos.
 * Devolve null se não existir ou escapar da pasta.
 */
async function arquivoDoPacote(ctx: ContextoVideo, camera: string, stamp: string, ...resto: string[]): Promise<string | null> {
  try {
    const raiz = await fs.realpath(ctx.dir);
    const real = await fs.realpath(path.join(raiz, camera, stamp, ...resto));
    if (!real.startsWith(raiz + path.sep)) return null;
    return (await fs.stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

async function lerJson(arq: string): Promise<unknown> {
  const st = await fs.stat(arq);
  if (st.size > TAMANHO_MAX_JSON) throw new Error('arquivo grande demais');
  return JSON.parse(await fs.readFile(arq, 'utf8'));
}

// ---------------------------------------------------------------- pacote

const EventoSchema = z.object({
  id: z.number().int().min(1).max(99_999),
  inicio: z.number().min(0),
  fim: z.number().min(0),
  pico: z.number().optional(),
  segundos_com_movimento: z.number().optional(),
  quadros_seg: z.array(z.number()).max(64).optional(),
  clipe_seg: z.number().optional(),
  clipe_cortado: z.boolean().optional(),
});
const EventosSchema = z.object({
  duracao_seg: z.number().min(0),
  grade: z.string().max(10).optional(),
  movimento_por_hora: z.array(z.object({ hora: z.string().max(40), segundos: z.number() })).max(24 * 40).optional(),
  eventos: z.array(EventoSchema).max(20_000),
});
const MetaSchema = z.object({ camera: z.string(), inicio_gravacao: z.string().optional() });

type EventoDoPacote = z.infer<typeof EventoSchema>;
interface Pacote {
  id: string;
  camera: string;
  stamp: string;
  inicioMs: number;
  duracaoSeg: number;
  grade: string;
  movimentoPorHora: Array<{ hora: string; segundos: number }>;
  eventos: EventoDoPacote[];
}

/** Lê o pacote de UMA gravação. Sem `meta.json` o envio não terminou: para o conector a gravação não existe. */
async function lerPacote(ctx: ContextoVideo, camera: string, stamp: string): Promise<Pacote> {
  const id = idDaGravacao(camera, stamp);
  if (foraDaRetencao(ctx, stamp)) throw new ErroDeEntrada(`gravacao ${id} não existe (ou passou de ${ctx.retencaoDias} dias e saiu da lista)`);
  const meta = await arquivoDoPacote(ctx, camera, stamp, 'meta.json');
  const ev = await arquivoDoPacote(ctx, camera, stamp, 'eventos.json');
  if (!meta || !ev) throw new ErroDeEntrada(`gravacao ${id} não existe (ou o envio dela ainda não terminou)`);
  try {
    MetaSchema.parse(await lerJson(meta));
    const e = EventosSchema.parse(await lerJson(ev));
    return {
      id,
      camera,
      stamp,
      inicioMs: inicioDoStamp(stamp),
      duracaoSeg: e.duracao_seg,
      grade: e.grade ?? '4x3',
      movimentoPorHora: e.movimento_por_hora ?? [],
      eventos: [...e.eventos].sort((a, b) => a.id - b.id),
    };
  } catch {
    throw new Error(`o pacote da gravação ${id} está ilegível (envio incompleto ou corrompido); peça ao João para reenviar`);
  }
}

async function contarClipes(ctx: ContextoVideo, camera: string, stamp: string): Promise<number> {
  try {
    const raiz = await fs.realpath(ctx.dir);
    return (await fs.readdir(path.join(raiz, camera, stamp, 'clipes'))).filter((n) => /^evento_\d{4,5}\.mp4$/.test(n)).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- video_gravacoes

export async function listarGravacoes(ctx: ContextoVideo, a: { camera?: string; dia?: string; limite?: number }) {
  if (a.camera !== undefined && !RE_CAMERA.test(a.camera)) throw new ErroDeEntrada('camera inválida (minúsculas, números e hífen)');
  if (a.dia !== undefined && !RE_DIA.test(a.dia)) throw new ErroDeEntrada('dia inválido: use AAAA-MM-DD');
  const limite = a.limite ?? 30;

  let raiz: string;
  let cameras: string[];
  try {
    raiz = await fs.realpath(ctx.dir);
    cameras = (await fs.readdir(raiz)).filter((c) => RE_CAMERA.test(c) && (!a.camera || c === a.camera));
  } catch {
    throw new Error('a pasta de gravações não está acessível neste servidor (VIGIA_DIR); avise o João');
  }

  const achadas: Array<{ camera: string; stamp: string }> = [];
  for (const camera of cameras) {
    let stamps: string[];
    try {
      stamps = await fs.readdir(path.join(raiz, camera));
    } catch {
      continue; // não é pasta
    }
    for (const stamp of stamps) {
      if (!RE_STAMP.test(stamp) || foraDaRetencao(ctx, stamp)) continue;
      if (a.dia && !stamp.startsWith(a.dia)) continue;
      achadas.push({ camera, stamp });
    }
  }
  achadas.sort((x, y) => inicioDoStamp(y.stamp) - inicioDoStamp(x.stamp) || x.camera.localeCompare(y.camera));

  const gravacoes: unknown[] = [];
  let ilegiveis = 0;
  let pendentes = 0;
  for (const { camera, stamp } of achadas) {
    if (gravacoes.length >= limite) break;
    let p: Pacote;
    try {
      p = await lerPacote(ctx, camera, stamp);
    } catch (e) {
      if (e instanceof ErroDeEntrada) pendentes++; // sem meta.json: envio em andamento
      else ilegiveis++;
      continue;
    }
    gravacoes.push({
      id: p.id,
      camera: p.camera,
      inicio: fmtDataHora(p.inicioMs),
      fim: fmtDataHora(p.inicioMs + p.duracaoSeg * 1000),
      duracao: fmtDuracao(p.duracaoSeg),
      eventos: p.eventos.length,
      eventosComClipe: await contarClipes(ctx, camera, stamp),
      movimentoPorHora: p.movimentoPorHora.map((h) => ({ hora: h.hora.replace('T', ' '), segundosComMovimento: h.segundos })),
    });
  }
  return {
    aviso: AVISO_VIDEO,
    horaReal: 'hora do relógio do computador que gravou (sem conversão de fuso)',
    retencaoDias: ctx.retencaoDias,
    gravacoes,
    ...(ilegiveis ? { pacotesIlegiveis: ilegiveis } : {}),
    ...(pendentes ? { envioEmAndamento: pendentes } : {}),
    proximoPasso: 'video_folhas({gravacao}) sem "eventos" devolve o índice dos eventos; com até 8 ids devolve as folhas como imagem.',
  };
}

// ---------------------------------------------------------------- video_folhas

export async function lerFolhas(ctx: ContextoVideo, a: { gravacao: string; eventos?: number[]; aPartirDoEvento?: number }): Promise<Conteudo> {
  const { camera, stamp } = lerIdDaGravacao(a.gravacao);
  const p = await lerPacote(ctx, camera, stamp);
  const hora = (seg: number) => fmtHora(p.inicioMs + Math.round(seg) * 1000);
  const dia = (seg: number) => fmtDataHora(p.inicioMs + Math.round(seg) * 1000);

  if (!a.eventos || a.eventos.length === 0) {
    const de = a.aPartirDoEvento ?? 1;
    const lista = p.eventos.filter((e) => e.id >= de);
    const pagina = lista.slice(0, MAX_EVENTOS_NO_INDICE);
    const cabecalho = `${p.id}: ${p.eventos.length} eventos em ${fmtDuracao(p.duracaoSeg)} de gravação (${fmtDataHora(p.inicioMs)} a ${fmtDataHora(p.inicioMs + p.duracaoSeg * 1000)}). Colunas: id, hora real, duração em segundos, pico de movimento (0 a 1; maior = mais mexida na imagem).`;
    const linhas = pagina.map((e) => `${e.id} ${hora(e.inicio)} ${Math.round(e.fim - e.inicio)}s ${e.pico ?? '-'}`);
    const resto = lista.length - pagina.length;
    return [
      {
        type: 'text',
        text: [
          cabecalho,
          ...linhas,
          resto > 0 ? `... mais ${resto} eventos: chame de novo com aPartirDoEvento=${pagina.at(-1)!.id + 1}.` : 'Fim do índice.',
          `Para ver as folhas passe "eventos" com até ${MAX_FOLHAS} ids.`,
          AVISO_VIDEO,
        ].join('\n'),
      },
    ];
  }

  const ids = [...new Set(a.eventos)];
  if (ids.length > MAX_FOLHAS) throw new ErroDeEntrada(`peça no máximo ${MAX_FOLHAS} eventos por vez`);
  const porId = new Map(p.eventos.map((e) => [e.id, e]));
  const faltam = ids.filter((i) => !porId.has(i));
  if (faltam.length) throw new ErroDeEntrada(`${p.id} não tem o(s) evento(s) ${faltam.join(', ')} (vão de 1 a ${p.eventos.at(-1)?.id ?? 0})`);

  const [colunas] = p.grade.split('x');
  const saida: Conteudo = [
    {
      type: 'text',
      text: `${p.id}: folhas de contato (grade ${p.grade}; os quadros seguem da esquerda para a direita, de cima para baixo). ${AVISO_VIDEO}`,
    },
  ];
  for (const id of ids) {
    const e = porId.get(id)!;
    const quadros = (e.quadros_seg ?? []).map((s) => hora(s));
    const cab = `Evento ${id}: ${dia(e.inicio)} a ${hora(e.fim)} (${Math.round(e.fim - e.inicio)} s), pico de movimento ${e.pico ?? '-'}.${e.clipe_cortado ? ' O clipe é só o começo do evento.' : ''}`;
    const arq = await arquivoDoPacote(ctx, camera, stamp, 'folhas', `evento_${pad4(id)}.jpg`);
    let imagem: Buffer | null = null;
    if (arq && (await fs.stat(arq)).size <= TAMANHO_MAX_FOLHA) imagem = await fs.readFile(arq);
    if (!imagem) {
      saida.push({ type: 'text', text: `${cab}\n(a folha deste evento não está disponível)` });
      continue;
    }
    saida.push({ type: 'text', text: `${cab}\nHorário de cada quadro (${colunas} por linha): ${quadros.join(', ')}` });
    saida.push({ type: 'image', data: imagem.toString('base64'), mimeType: 'image/jpeg' });
  }
  return saida;
}

// ---------------------------------------------------------------- video_clipe: link assinado

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const assinar = (ctx: ContextoVideo, parte: string) => createHmac('sha256', ctx.segredo).update(`vigia-clipe:${parte}`).digest();

/** `gravacao|evento|vence(s)|quem` assinado com HMAC. `quem` só serve à auditoria (o link é de quem o tem). */
export function criarTokenDoClipe(ctx: ContextoVideo, gravacao: string, evento: number, minutos: number, quem: string): { token: string; venceEm: number } {
  const venceEm = ctx.agora() + minutos * 60_000;
  const parte = b64u(`${gravacao}|${evento}|${Math.floor(venceEm / 1000)}|${quem}`);
  return { token: `${parte}.${b64u(assinar(ctx, parte))}`, venceEm };
}

export function lerTokenDoClipe(ctx: ContextoVideo, token: string): { camera: string; stamp: string; gravacao: string; evento: number; quem: string } | null {
  const [parte, sig, resto] = token.split('.');
  if (!parte || !sig || resto !== undefined || parte.length > 400 || sig.length > 100) return null;
  const esperado = assinar(ctx, parte);
  const recebido = Buffer.from(sig, 'base64url');
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return null;
  const [gravacao, evento, vence, ...quem] = Buffer.from(parte, 'base64url').toString('utf8').split('|');
  const m = gravacao ? RE_GRAVACAO.exec(gravacao) : null;
  const n = Number(evento);
  const venceMs = Number(vence) * 1000;
  // o teto de 30 min vale também aqui: um token assinado com validade longa (bug futuro, segredo vazado) não passa
  if (!m || !Number.isInteger(n) || n < 1 || n > 99_999 || !Number.isFinite(venceMs)) return null;
  if (venceMs < ctx.agora() || venceMs > ctx.agora() + LINK_MAX_MIN * 60_000 + 60_000) return null;
  return { camera: m[1]!, stamp: m[2]!, gravacao: gravacao!, evento: n, quem: quem.join('|') };
}

export async function linkDoClipe(ctx: ContextoVideo, quem: string, a: { gravacao: string; evento: number; minutos?: number }) {
  const { camera, stamp } = lerIdDaGravacao(a.gravacao);
  const p = await lerPacote(ctx, camera, stamp);
  const e = p.eventos.find((x) => x.id === a.evento);
  if (!e) throw new ErroDeEntrada(`${p.id} não tem o evento ${a.evento}`);
  const arq = await arquivoDoPacote(ctx, camera, stamp, 'clipes', `evento_${pad4(a.evento)}.mp4`);
  if (!arq) throw new ErroDeEntrada(`o evento ${a.evento} de ${p.id} não tem clipe`);
  const minutos = Math.min(LINK_MAX_MIN, Math.max(1, Math.round(a.minutos ?? LINK_PADRAO_MIN)));
  const { token, venceEm } = criarTokenDoClipe(ctx, p.id, a.evento, minutos, quem);
  const tamanho = (await fs.stat(arq)).size;
  return {
    url: `${ctx.urlPublica}/vigia/clipe/${token}/${p.id}_evento${pad4(a.evento)}.mp4`,
    valeMinutos: minutos,
    venceEm: new Date(venceEm).toISOString(),
    evento: { id: a.evento, inicio: fmtDataHora(p.inicioMs + Math.round(e.inicio) * 1000), fim: fmtHora(p.inicioMs + Math.round(e.fim) * 1000), clipeSegundos: e.clipe_seg ?? null, clipeCortado: e.clipe_cortado ?? false },
    tamanhoMB: Math.round((tamanho / 1_048_576) * 10) / 10,
    comoUsar: 'Entregue o link à pessoa para abrir no navegador (480p, sem áudio). Quem abre não precisa de senha: não repita o link além do necessário.',
    aviso: AVISO_VIDEO,
  };
}

// ---------------------------------------------------------------- a rota pública do clipe

export interface AcessoAoClipe {
  quem: string;
  gravacao: string;
  evento: number;
  ip: string;
  agente?: string;
}

const NAO_ENCONTRADO = 'Link inválido ou vencido. Peça um novo ao Claude (video_clipe).';

/**
 * GET /vigia/clipe/:token/:nome — o clipe, com suporte a Range (o navegador pula no vídeo). Toda falha devolve a MESMA
 * resposta (404): quem não tem um link válido não aprende nada. O `:nome` é só para o player mostrar um título.
 */
export function montarRotaDoClipe(app: Express, ctx: ContextoVideo, aoBaixar?: (a: AcessoAoClipe) => void): void {
  let ativos = 0;
  app.get('/vigia/clipe/:token/:nome', async (req: Request, res: Response) => {
    const negar = () => void res.status(404).set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).type('text/plain; charset=utf-8').send(NAO_ENCONTRADO);
    const t = lerTokenDoClipe(ctx, String(req.params.token ?? ''));
    if (!t || foraDaRetencao(ctx, t.stamp)) return negar();
    const arq = await arquivoDoPacote(ctx, t.camera, t.stamp, 'clipes', `evento_${pad4(t.evento)}.mp4`);
    if (!arq) return negar();
    if (ativos >= MAX_DOWNLOADS_AO_MESMO_TEMPO) {
      res.status(503).set('Retry-After', '10').type('text/plain; charset=utf-8').send('Muitos clipes abertos ao mesmo tempo. Tente de novo em instantes.');
      return;
    }
    ativos++;
    let liberado = false;
    const liberar = () => {
      if (!liberado) {
        liberado = true;
        ativos--;
      }
    };
    res.on('close', liberar);
    try {
      aoBaixar?.({ quem: t.quem, gravacao: t.gravacao, evento: t.evento, ip: ipDoCliente(req), agente: String(req.headers['user-agent'] ?? '').slice(0, 200) || undefined });
    } catch {
      // auditoria que falha não derruba o download
    }
    res.sendFile(
      arq,
      {
        dotfiles: 'deny',
        cacheControl: false,
        lastModified: false,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Disposition': 'inline',
          'Cache-Control': 'private, no-store',
          'X-Robots-Tag': 'noindex',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        },
      },
      (err) => {
        liberar();
        if (err && !res.headersSent) negar();
      },
    );
  });
}

// ---------------------------------------------------------------- as ferramentas

const ler = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registrarFerramentasVideo(server: McpServer, ctx: ContextoVideo, quem: string, auditar: Auditar): void {
  server.registerTool(
    'video_gravacoes',
    {
      title: 'Vigia de vídeo: gravações',
      description:
        'Lista as gravações de câmera já analisadas (triagem de movimento feita no computador que grava; o vídeo inteiro nunca sobe): id, câmera, data e hora real de início e fim, duração, número de eventos (trechos com movimento), quantos têm clipe e os segundos de movimento por hora do relógio (mostra atividade em horário que deveria estar vazio). Mais recentes primeiro. ' +
        `Só as dos últimos ${ctx.retencaoDias} dias. Roteiro: video_gravacoes → video_folhas (índice, depois as folhas em lotes) → nota de 0 a 3 por evento → video_clipe dos de nota 2 ou 3. ${AVISO_VIDEO}`,
      inputSchema: {
        camera: z.string().optional().describe('só esta câmera, ex. "caixa"'),
        dia: z.string().optional().describe('só este dia, AAAA-MM-DD'),
        limite: z.number().int().min(1).max(100).optional().describe('padrão 30'),
      },
      annotations: ler,
    },
    ((a: { camera?: string; dia?: string; limite?: number }) => executar('video_gravacoes', a, auditar, () => listarGravacoes(ctx, a))) as never,
  );
  server.registerTool(
    'video_folhas',
    {
      title: 'Vigia de vídeo: folhas de contato',
      description:
        `Sem "eventos": o ÍNDICE dos eventos da gravação (id, hora real, duração, pico de movimento), até ${MAX_EVENTOS_NO_INDICE} por chamada. ` +
        `Com "eventos" (até ${MAX_FOLHAS} ids): a folha de contato de cada um COMO IMAGEM (grade de 12 quadros, da esquerda para a direita e de cima para baixo) mais o horário real de cada quadro. ` +
        'Olhe em lotes de 8, dê nota 0 (normal), 1 (atípico, provavelmente inocente), 2 (suspeito, ver de perto) ou 3 (muito suspeito) e peça o clipe só dos de nota 2 ou 3. ' +
        AVISO_VIDEO,
      inputSchema: {
        gravacao: z.string().describe('id devolvido por video_gravacoes, ex. "caixa_2026-11-03_0800"'),
        eventos: z.array(z.number().int().min(1).max(99_999)).max(MAX_FOLHAS).optional().describe(`até ${MAX_FOLHAS} ids de evento; omita para o índice`),
        aPartirDoEvento: z.number().int().min(1).optional().describe('no índice: continuar a partir deste id'),
      },
      annotations: ler,
    },
    ((a: { gravacao: string; eventos?: number[]; aPartirDoEvento?: number }) => executarComImagens('video_folhas', a, auditar, () => lerFolhas(ctx, a))) as never,
  );
  server.registerTool(
    'video_clipe',
    {
      title: 'Vigia de vídeo: clipe do evento',
      description:
        `Link temporário (vale ${LINK_PADRAO_MIN} min; no máximo ${LINK_MAX_MIN}) do clipe leve do evento (480p, sem áudio), para a pessoa ABRIR NO NAVEGADOR e ver com os próprios olhos. Use só nos eventos de nota 2 ou 3. O Claude não vê vídeo: entregue o link e descreva só o que as folhas mostraram. ` +
        AVISO_VIDEO,
      inputSchema: {
        gravacao: z.string().describe('id devolvido por video_gravacoes'),
        evento: z.number().int().min(1).max(99_999),
        minutos: z.number().int().min(1).max(LINK_MAX_MIN).optional().describe(`validade do link, padrão ${LINK_PADRAO_MIN}`),
      },
      annotations: ler,
    },
    ((a: { gravacao: string; evento: number; minutos?: number }) => executar('video_clipe', a, auditar, () => linkDoClipe(ctx, quem, a))) as never,
  );
}

/** O portão: só quem está na lista (`MCP_VIDEO_EMAILS`, já convertida em ids de usuário) enxerga as ferramentas. */
export function registrarVideoSePermitido(
  server: McpServer,
  ctx: ContextoVideo | null,
  userId: string,
  permitidos: ReadonlySet<string>,
  auditar: Auditar,
): boolean {
  if (!ctx || !userId || !permitidos.has(userId)) return false;
  registrarFerramentasVideo(server, ctx, userId, auditar);
  return true;
}
