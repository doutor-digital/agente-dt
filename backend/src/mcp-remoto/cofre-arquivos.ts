/**
 * O "cofre de envio": guarda por poucos minutos um arquivo que uma pessoa subiu, para que OUTRO conector do claude.ai
 * (ex.: ClickSign, que só cria envelope a partir de um LINK https) consiga baixá-lo. O claude.ai não passa ao conector
 * um arquivo anexado na conversa; então a pessoa sobe aqui e o Claude entrega ao outro conector um link curto.
 *
 * O que protege o arquivo (contratos e kits de admissão trazem CPF, endereço, salário):
 *  - Pedido preso a quem pediu (`userId` do console): só ele vê, gera link e apaga. Os outros recebem "não encontrado".
 *  - Link de envio: 256 bits aleatórios, uso único (só um envio ACEITO o gasta), 30 min. A página abrir não gasta nada
 *    (visualizadores de link, como o do WhatsApp, abrem a página antes da pessoa).
 *  - Tipo conferido pelo CONTEÚDO (bytes iniciais e estrutura), nunca só pela extensão; extensão que não combina é recusada.
 *  - Link de download: outro token de 256 bits, no máximo 30 min e N baixadas; sem listagem de nada.
 *  - No disco: cifrado (AES-256-GCM) com uma chave por arquivo que só existe na memória do processo. Reiniciar o
 *    processo destrói as chaves: o que sobrou no disco não abre mais. Mesmo assim o app APAGA a pasta inteira ao desligar
 *    (SIGTERM, `apagarTudo`) e na subida (`apagarPasta`); só um kill -9/OOM deixa .bin para trás (inúteis, sem chave) até o próximo
 *    boot ou até a varredura (2 h). Por isso `ARQUIVOS_DIR` tem que ser uma pasta PRIVADA deste container, nunca um volume
 *    compartilhado: a subida do container novo apagaria os arquivos vivos do antigo.
 *  - Apagado do disco quando o último link expira, quando a pessoa manda, ou no teto de segurança (2 h), o que vier primeiro.
 *  - Nome no disco é só o id aleatório: o nome que a pessoa deu nunca vira caminho (path traversal não tem por onde entrar).
 *  - Auditoria sem conteúdo e sem nome do arquivo (o nome costuma ter o nome do paciente/funcionário).
 *
 * O estado fica na memória (processo único: `replicas: 1`). Reinício = os envios em curso somem e a pessoa pede de novo.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type TipoDeArquivo = 'pdf' | 'doc' | 'docx' | 'jpg' | 'png' | 'txt';

export const TIPOS: Record<TipoDeArquivo, { ext: string; mime: string; legivel: string }> = {
  pdf: { ext: 'pdf', mime: 'application/pdf', legivel: 'PDF' },
  doc: { ext: 'doc', mime: 'application/msword', legivel: 'Word (.doc)' },
  docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', legivel: 'Word (.docx)' },
  jpg: { ext: 'jpg', mime: 'image/jpeg', legivel: 'imagem JPEG' },
  png: { ext: 'png', mime: 'image/png', legivel: 'imagem PNG' },
  txt: { ext: 'txt', mime: 'text/plain; charset=utf-8', legivel: 'texto (.txt)' },
};

/** extensão que a pessoa pode ter escrito → o tipo que o conteúdo tem de ter */
const TIPO_DA_EXTENSAO: Record<string, TipoDeArquivo> = { pdf: 'pdf', doc: 'doc', docx: 'docx', jpg: 'jpg', jpeg: 'jpg', png: 'png', txt: 'txt' };
export const EXTENSOES_ACEITAS = Object.keys(TIPO_DA_EXTENSAO);

export const LIMITES_PADRAO = {
  /** tamanho máximo do arquivo */
  tamanhoMaxBytes: 20 * 1024 * 1024,
  /** quanto tempo o link de envio vale */
  envioValeMs: 30 * 60_000,
  /** teto de segurança: nada fica mais que isso, mesmo que ninguém peça link */
  ttlDeSegurancaMs: 2 * 3_600_000,
  linkPadraoMin: 15,
  linkMaxMin: 30,
  /** quantas vezes um link de download pode ser aberto (o ClickSign pode baixar mais de uma vez) */
  baixadasMax: 3,
  linksPorEnvio: 5,
  /** pedidos de envio vivos por pessoa */
  ativosPorUsuario: 5,
  /** envios recusados (tipo, tamanho) antes do link de envio ser queimado */
  recusasMax: 5,
  /** bytes guardados somados, de todo mundo */
  espacoTotalMaxBytes: 200 * 1024 * 1024,
  /** quanto tempo o registro de um envio apagado ainda responde "apagado" antes de sumir */
  lembrarApagadoMs: 60 * 60_000,
};
export type Limites = typeof LIMITES_PADRAO;

export class ErroDeCofre extends Error {
  constructor(
    readonly codigo: 'invalido' | 'usado' | 'expirado' | 'ocupado' | 'tipo' | 'tamanho' | 'cheio' | 'limite' | 'nao_encontrado' | 'estado',
    mensagem: string,
    readonly status: number,
  ) {
    super(mensagem);
  }
}

export interface EventoDoCofre {
  evento:
    | 'upload_pedido'
    | 'upload_recebido'
    | 'upload_recusado'
    | 'link_gerado'
    | 'download'
    | 'download_negado'
    | 'apagado';
  /** id do envio (aleatório, não é segredo) */
  envio: string;
  userId: string;
  /** só metadados: nunca conteúdo e nunca o nome do arquivo */
  detalhe?: Record<string, string | number | boolean | undefined>;
  ip?: string;
  agente?: string;
}

// ── detecção de tipo pelo conteúdo ─────────────────────────────────────────────────────────────────────────────

const comeca = (b: Buffer, ...bytes: number[]) => b.length >= bytes.length && bytes.every((v, i) => b[i] === v);

/**
 * O tipo que o CONTEÚDO tem, ou null. Não é antivírus: confere que o arquivo é o que diz ser.
 *  - PDF: "%PDF-" no começo.  JPEG: FF D8 FF.  PNG: assinatura de 8 bytes.
 *  - .doc: contêiner OLE2 COM o fluxo "WordDocument" (o mesmo contêiner serve .xls, .ppt e .msi) e SEM projeto de macro (_VBA_PROJECT).
 *  - .docx: ZIP com "[Content_Types].xml" e "word/" (não aceita .zip/.jar/.xlsx renomeados) e sem macro (vbaProject.bin).
 *  - texto: sem byte de controle nenhum além de tab, quebras de linha e form feed (executável tem NUL logo no começo), e que, depois de
 *    tirar o BOM UTF-8 e qualquer quantidade de espaços/quebras de linha do começo, não comece como marcação (`<`: HTML/SVG/XML)
 *    nem como script (`#!`). Texto só entra com a extensão .txt (ou sem extensão): ver `validarArquivo`. O download sai como
 *    text/plain com `nosniff`.
 */
export function detectarTipo(b: Buffer): TipoDeArquivo | null {
  if (comeca(b, 0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf';
  if (comeca(b, 0xff, 0xd8, 0xff)) return 'jpg';
  if (comeca(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (comeca(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    return b.includes(Buffer.from('WordDocument', 'utf16le')) && !b.includes(Buffer.from('_VBA_PROJECT', 'utf16le')) ? 'doc' : null;
  }
  if (comeca(b, 0x50, 0x4b, 0x03, 0x04)) {
    return b.includes('[Content_Types].xml') && b.includes('word/') && !b.includes('vbaProject.bin') ? 'docx' : null;
  }
  if (b.length > 0 && ehTexto(b) && !comecaComoMarcacaoOuScript(b)) return 'txt';
  return null;
}

/** O primeiro conteúdo de verdade (depois do BOM UTF-8 e de espaços/quebras de linha, sem limite de quantidade) é `<` ou `#!`? */
function comecaComoMarcacaoOuScript(b: Buffer): boolean {
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0c || b[i] === 0x0d)) i++;
  return b[i] === 0x3c || (b[i] === 0x23 && b[i + 1] === 0x21);
}

function ehTexto(b: Buffer): boolean {
  for (const v of b) {
    if (v < 0x20 && v !== 0x09 && v !== 0x0a && v !== 0x0c && v !== 0x0d) return false;
    if (v === 0x7f) return false;
  }
  return true;
}

/**
 * O nome que fica guardado e vai no caminho do link: só letras, números, ponto, hífen e sublinhado; sem pasta, sem
 * acento, sem `..`; a extensão é SEMPRE a do tipo detectado (a que a pessoa escreveu não manda).
 */
export function nomeSeguro(bruto: string | undefined, tipo: TipoDeArquivo): string {
  let base = (bruto ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  base = base.split(/[\\/]/).pop() ?? '';
  base = base.replace(new RegExp(`\\.(${EXTENSOES_ACEITAS.join('|')})$`, 'i'), '');
  base = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 60)
    .replace(/[._-]+$/g, '');
  return `${base || 'arquivo'}.${TIPOS[tipo].ext}`;
}

/** Confere nome + conteúdo. Devolve o tipo e o nome a guardar, ou lança a razão da recusa (em português, para a pessoa). */
export function validarArquivo(nomeOriginal: string | undefined, conteudo: Buffer, tamanhoMax: number): { tipo: TipoDeArquivo; nome: string } {
  if (conteudo.length === 0) throw new ErroDeCofre('tipo', 'O arquivo está vazio.', 400);
  if (conteudo.length > tamanhoMax) throw new ErroDeCofre('tamanho', `O arquivo passa do limite de ${Math.floor(tamanhoMax / 1024 / 1024)} MB.`, 413);
  const ultimo = (nomeOriginal ?? '').split(/[\\/]/).pop() ?? '';
  const ponto = ultimo.lastIndexOf('.');
  // só vale como extensão o que parece uma ("pdf", "docx"); "Maria J. Souza" e "v1.2" são nome, não extensão
  const depois = ponto > 0 ? ultimo.slice(ponto + 1).toLowerCase() : '';
  const ext = /^[a-z][a-z0-9]{1,4}$/.test(depois) ? depois : '';
  const extConhecida = Object.hasOwn(TIPO_DA_EXTENSAO, ext);
  const tipo = detectarTipo(conteudo);
  if (!tipo) {
    if (ext && !extConhecida) {
      throw new ErroDeCofre('tipo', `Arquivo .${ext.slice(0, 10)} não é aceito. Aceitamos: ${EXTENSOES_ACEITAS.map((e) => `.${e}`).join(' ')}.`, 415);
    }
    throw new ErroDeCofre('tipo', 'O conteúdo do arquivo não é de um tipo aceito (PDF, Word, JPG, PNG ou texto). Confira se não está corrompido.', 415);
  }
  // Texto é o formato mais fácil de disfarçar (virus.js, run.ps1, a.bat são "texto"): só entra como .txt ou sem extensão nenhuma.
  // Aqui a extensão é lida sem a folga de cima: qualquer sufixo alfanumérico depois do último ponto conta.
  if (tipo === 'txt') {
    // começa por letra: "Relatorio 03.11" e "notas v1.2" são nome com ponto, não extensão (e o nome guardado termina em .txt de qualquer jeito)
    const sufixo = depois && /^[a-z][a-z0-9_-]{0,9}$/.test(depois) ? depois : '';
    if (sufixo && sufixo !== 'txt' && !Object.hasOwn(TIPO_DA_EXTENSAO, sufixo)) {
      throw new ErroDeCofre('tipo', `Arquivos de texto só são aceitos como .txt (este é .${sufixo}). Se for um documento, envie em PDF ou Word.`, 415);
    }
  }
  // "Contrato.final" com PDF de verdade dentro: manda o conteúdo (a extensão guardada é a do tipo detectado). Só uma extensão
  // CONHECIDA que não combina com o conteúdo é recusada ("contrato.pdf" que é texto/executável).
  if (ext && extConhecida && TIPO_DA_EXTENSAO[ext] !== tipo) {
    throw new ErroDeCofre('tipo', `O arquivo diz ser .${ext}, mas o conteúdo é ${TIPOS[tipo].legivel}. Salve de novo no formato certo.`, 415);
  }
  return { tipo, nome: nomeSeguro(ultimo, tipo) };
}

// ── o cofre ────────────────────────────────────────────────────────────────────────────────────────────────────

const FATIA = 1024 * 1024;

/** `write` pode gravar menos do que o pedido (disco quase cheio, sinal): insiste até gravar tudo ou falhar. Devolve quantos bytes gravou. */
async function escreverTudo(f: FileHandle, buf: Buffer, posicao: number): Promise<number> {
  let feito = 0;
  while (feito < buf.length) {
    const { bytesWritten } = await f.write(buf, feito, buf.length - feito, posicao + feito);
    if (bytesWritten <= 0) throw new Error('escrita parou no meio');
    feito += bytesWritten;
  }
  return feito;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const novoToken = () => randomBytes(32).toString('base64url'); // 256 bits, 43 caracteres
export const FORMATO_DO_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface Link {
  hash: string;
  expiraEm: number;
  baixadas: number;
  max: number;
}

interface Envio {
  id: string;
  dono: string;
  finalidade: string;
  criadoEm: number;
  /** teto duro: depois disto nada resta */
  apagarEm: number;
  tokenHash: string;
  estado: 'aguardando' | 'enviando' | 'recebido' | 'apagado';
  recusas: number;
  usadoEm?: number;
  apagadoEm?: number;
  arquivo?: { nome: string; tipo: TipoDeArquivo; tamanho: number; recebidoEm: number; chave: Buffer; caminho: string };
  links: Link[];
}

export interface Reserva {
  readonly envioId: string;
}

export interface VisaoDoEnvio {
  id: string;
  estado: 'aguardando_envio' | 'recebido' | 'apagado';
  finalidade: string;
  envioValeAte: number | null;
  apagaAte: number;
  arquivo?: { nome: string; tipo: string; tamanhoBytes: number; recebidoEm: number };
  links: Array<{ expiraEm: number; baixadas: number; maximo: number; ativo: boolean }>;
}

export interface OpcoesDoCofre {
  dir: string;
  agora?: () => number;
  auditar?: (e: EventoDoCofre) => void;
  limites?: Partial<Limites>;
  log?: { warn(o: object, m?: string): void };
}

export class CofreDeArquivos {
  readonly limites: Limites;
  readonly dir: string;
  private envios = new Map<string, Envio>();
  /** arquivos cujo apagamento falhou: a varredura tenta de novo (sem esperar o prazo dos órfãos) */
  private paraApagar = new Set<string>();
  private porTokenDeEnvio = new Map<string, string>();
  private porTokenDeLink = new Map<string, string>();
  /** o relógio do cofre (os testes o controlam) */
  readonly agora: () => number;
  private pronto: Promise<void> | undefined;
  /** depois do desligamento nada novo entra */
  private encerrado = false;

  constructor(private o: OpcoesDoCofre) {
    this.limites = { ...LIMITES_PADRAO, ...o.limites };
    this.dir = o.dir;
    this.agora = o.agora ?? Date.now;
  }

  /** Cria a pasta (só do dono do processo). Chamada sozinha antes de qualquer gravação. */
  private garantirPasta(): Promise<void> {
    this.pronto ??= mkdir(this.dir, { recursive: true, mode: 0o700 })
      // só aperta a permissão de pasta que NÓS criamos (ARQUIVOS_DIR pode apontar para uma pasta que já existe e é de outros)
      .then((criada) => (criada ? chmod(this.dir, 0o700) : undefined))
      .catch((err) => {
        this.pronto = undefined; // falha de uma vez só (disco, permissão corrigida depois) não pode ficar gravada para sempre
        throw err;
      });
    return this.pronto;
  }

  private auditar(e: EventoDoCofre, req?: { ip?: string; agente?: string }) {
    try {
      this.o.auditar?.({ ...e, ...(req?.ip ? { ip: req.ip } : {}), ...(req?.agente ? { agente: req.agente.slice(0, 120) } : {}) });
    } catch {
      // auditoria que falha não derruba o arquivo
    }
  }

  // ── pedido de envio ──────────────────────────────────────────────────────────────────────────────────────────

  pedirEnvio(a: { userId: string; finalidade: string }): { id: string; token: string; validoAte: number } {
    this.varrerMemoria();
    const vivos = [...this.envios.values()].filter((e) => e.dono === a.userId && e.estado !== 'apagado').length;
    if (vivos >= this.limites.ativosPorUsuario) {
      throw new ErroDeCofre('limite', `Você já tem ${vivos} envios em andamento. Use ou apague (arquivo_apagar) algum antes de pedir outro; eles somem sozinhos em até ${Math.round(this.limites.ttlDeSegurancaMs / 3_600_000)} h.`, 429);
    }
    const t = this.agora();
    const id = randomBytes(16).toString('hex');
    const token = novoToken();
    const tokenHash = sha256(token);
    this.envios.set(id, {
      id,
      dono: a.userId,
      finalidade: a.finalidade,
      criadoEm: t,
      apagarEm: t + this.limites.ttlDeSegurancaMs,
      tokenHash,
      estado: 'aguardando',
      recusas: 0,
      links: [],
    });
    this.porTokenDeEnvio.set(tokenHash, id);
    this.auditar({ evento: 'upload_pedido', envio: id, userId: a.userId });
    return { id, token, validoAte: t + this.limites.envioValeMs };
  }

  /** O que a página de envio precisa saber. Não gasta o link. */
  inspecionarEnvio(token: string): { finalidade: string } {
    return { finalidade: this.envioDoToken(token).finalidade };
  }

  private envioDoToken(token: string): Envio {
    if (!FORMATO_DO_TOKEN.test(token)) throw new ErroDeCofre('invalido', 'Este link de envio não existe.', 404);
    const id = this.porTokenDeEnvio.get(sha256(token));
    const e = id ? this.envios.get(id) : undefined;
    if (!e) throw new ErroDeCofre('invalido', 'Este link de envio não existe ou já foi apagado. Se o sistema foi atualizado há pouco, os envios em andamento se perdem: peça um novo link no Claude.', 404);
    if (e.estado === 'apagado') throw new ErroDeCofre('expirado', 'Este link de envio venceu ou foi encerrado. Peça um novo no Claude.', 410);
    if (e.estado === 'recebido' || e.usadoEm) throw new ErroDeCofre('usado', 'Este link de envio já foi usado. Peça um novo no Claude.', 410);
    if (this.agora() >= e.criadoEm + this.limites.envioValeMs) throw new ErroDeCofre('expirado', 'Este link de envio venceu. Peça um novo no Claude.', 410);
    return e;
  }

  /** Separa o envio (uma vez só, mesmo com duas abas ao mesmo tempo). Depois: `guardar` ou `liberar`. */
  reservar(token: string): Reserva {
    this.varrerMemoria();
    if (this.encerrado) throw new ErroDeCofre('estado', 'O sistema está sendo atualizado. Peça um novo link no Claude em um minuto.', 503);
    const e = this.envioDoToken(token);
    if (e.estado === 'enviando') throw new ErroDeCofre('ocupado', 'Já há um envio em andamento neste link.', 409);
    // o teto conta o que está guardado MAIS o que os envios em andamento ainda podem trazer (cada um até o tamanho máximo)
    const emAndamento = [...this.envios.values()].filter((x) => x.estado === 'enviando').length;
    if (this.bytesGuardados() + (emAndamento + 1) * this.limites.tamanhoMaxBytes > this.limites.espacoTotalMaxBytes) throw new ErroDeCofre('cheio', 'O cofre está cheio no momento. Tente de novo em alguns minutos.', 503);
    e.estado = 'enviando';
    return { envioId: e.id };
  }

  /** O envio não chegou a ser guardado (cortou, passou do tamanho): o link continua valendo, até `recusasMax` falhas. */
  liberar(r: Reserva, motivo?: string, req?: { ip?: string; agente?: string }, culpaDoEnvio = true): void {
    const e = this.envios.get(r.envioId);
    if (!e || e.estado !== 'enviando') return;
    // falha NOSSA (disco) não gasta as tentativas da pessoa
    if (culpaDoEnvio) e.recusas += 1;
    e.estado = 'aguardando';
    this.auditar({ evento: 'upload_recusado', envio: e.id, userId: e.dono, detalhe: { motivo: motivo ?? 'interrompido', recusas: e.recusas } }, req);
    if (e.recusas >= this.limites.recusasMax) {
      e.usadoEm = this.agora(); // queimado: precisa pedir outro
      this.apagarEnvio(e, 'recusas');
    }
  }

  /** Confere (tipo, tamanho), cifra, grava e queima o link de envio. Lança ErroDeCofre se recusar (e então libera a reserva). */
  async guardar(r: Reserva, nomeOriginal: string | undefined, conteudo: Buffer, req?: { ip?: string; agente?: string }): Promise<{ nome: string; tipo: TipoDeArquivo; tamanho: number }> {
    const e = this.envios.get(r.envioId);
    if (!e || e.estado !== 'enviando') throw new ErroDeCofre('estado', 'Este envio não está mais aberto.', 409);
    let caminho: string | undefined;
    try {
      const { tipo, nome } = validarArquivo(nomeOriginal, conteudo, this.limites.tamanhoMaxBytes);
      await this.garantirPasta();
      if (this.encerrado) throw new ErroDeCofre('estado', 'O sistema está sendo atualizado. Peça um novo link no Claude em um minuto.', 503);
      const chave = randomBytes(32);
      const iv = randomBytes(12);
      const cifra = createCipheriv('aes-256-gcm', chave, iv);
      cifra.setAAD(Buffer.from(e.id));
      caminho = path.join(this.dir, `${e.id}.bin`); // o nome no disco é só o id aleatório
      // formato: iv (12) + tag (16) + cifrado. A tag só existe no fim: reserva o lugar dela e volta para preencher (sem 2ª cópia do arquivo na memória)
      const f = await open(caminho, 'wx', 0o600);
      try {
        let pos = 0;
        pos += await escreverTudo(f, iv, pos);
        pos += await escreverTudo(f, Buffer.alloc(16), pos);
        for (let de = 0; de < conteudo.length; de += FATIA) {
          pos += await escreverTudo(f, cifra.update(conteudo.subarray(de, de + FATIA)), pos); // em fatias: sem 2ª cópia inteira na memória
        }
        pos += await escreverTudo(f, cifra.final(), pos);
        await escreverTudo(f, cifra.getAuthTag(), 12);
      } finally {
        await f.close();
      }
      if (e.estado !== 'enviando') {
        // apagado enquanto gravava (varredura): não deixa arquivo órfão
        await unlink(caminho).catch(() => undefined);
        throw new ErroDeCofre('estado', 'Este envio não está mais aberto.', 409);
      }
      e.arquivo = { nome, tipo, tamanho: conteudo.length, recebidoEm: this.agora(), chave, caminho };
      e.estado = 'recebido';
      e.usadoEm = this.agora();
      this.auditar({ evento: 'upload_recebido', envio: e.id, userId: e.dono, detalhe: { tipo, tamanho: conteudo.length } }, req);
      return { nome, tipo, tamanho: conteudo.length };
    } catch (err) {
      if (err instanceof ErroDeCofre && err.codigo === 'estado') throw err;
      if (!(err instanceof ErroDeCofre) && caminho) await unlink(caminho).catch(() => undefined); // disco cheio: não deixa pedaço
      this.liberar(r, err instanceof ErroDeCofre ? err.codigo : 'erro-interno', req, err instanceof ErroDeCofre);
      throw err;
    }
  }

  // ── o que o dono faz depois ──────────────────────────────────────────────────────────────────────────────────

  /** Quem não é o dono recebe o MESMO erro de quem digitou um id que não existe. */
  private doDono(userId: string, id: string): Envio {
    this.varrerMemoria();
    const e = this.envios.get(id);
    if (!e || e.dono !== userId) throw new ErroDeCofre('nao_encontrado', 'Envio não encontrado (venceu, foi apagado ou o sistema foi atualizado nesse meio-tempo, o que apaga os envios em andamento). Peça um novo com arquivo_pedir_upload.', 404);
    return e;
  }

  ver(userId: string, id: string): VisaoDoEnvio {
    const e = this.doDono(userId, id);
    const t = this.agora();
    return {
      id: e.id,
      estado: e.estado === 'apagado' ? 'apagado' : e.arquivo ? 'recebido' : 'aguardando_envio',
      finalidade: e.finalidade,
      envioValeAte: e.estado === 'aguardando' || e.estado === 'enviando' ? e.criadoEm + this.limites.envioValeMs : null,
      apagaAte: e.apagarEm,
      ...(e.arquivo && e.estado !== 'apagado' ? { arquivo: { nome: e.arquivo.nome, tipo: TIPOS[e.arquivo.tipo].mime, tamanhoBytes: e.arquivo.tamanho, recebidoEm: e.arquivo.recebidoEm } } : {}),
      links: e.links.map((l) => ({ expiraEm: l.expiraEm, baixadas: l.baixadas, maximo: l.max, ativo: t < l.expiraEm && l.baixadas < l.max })),
    };
  }

  gerarLink(userId: string, id: string, minutos: number | undefined): { token: string; nome: string; expiraEm: number; baixadasMax: number } {
    const e = this.doDono(userId, id);
    if (e.estado !== 'recebido' || !e.arquivo) {
      throw new ErroDeCofre('estado', e.estado === 'apagado' ? 'O arquivo já foi apagado. Peça um novo envio.' : 'O arquivo ainda não chegou. Espere a pessoa enviar (arquivo_ver_envio).', 409);
    }
    if (e.links.length >= this.limites.linksPorEnvio) throw new ErroDeCofre('limite', `Este arquivo já teve ${e.links.length} links. Apague-o e peça um novo envio.`, 429);
    const min = Math.min(Math.max(Math.floor(minutos ?? this.limites.linkPadraoMin), 1), this.limites.linkMaxMin);
    const t = this.agora();
    const expiraEm = Math.min(t + min * 60_000, e.apagarEm);
    const token = novoToken();
    const hash = sha256(token);
    e.links.push({ hash, expiraEm, baixadas: 0, max: this.limites.baixadasMax });
    this.porTokenDeLink.set(hash, e.id);
    this.auditar({ evento: 'link_gerado', envio: e.id, userId: userId, detalhe: { minutos: Math.round((expiraEm - t) / 60_000), baixadasMax: this.limites.baixadasMax } });
    return { token, nome: e.arquivo.nome, expiraEm, baixadasMax: this.limites.baixadasMax };
  }

  apagar(userId: string, id: string): boolean {
    const e = this.doDono(userId, id);
    if (e.estado === 'apagado') return false;
    this.apagarEnvio(e, 'pedido');
    return true;
  }

  // ── o download (rota pública) ────────────────────────────────────────────────────────────────────────────────

  /**
   * Abre o arquivo para quem tem o link. `contar: false` serve o HEAD (só metadados, sem gastar uma baixada).
   * Qualquer problema (token inexistente, vencido, esgotado, arquivo sumido) vira o mesmo "não encontrado".
   */
  async baixar(token: string, contar: boolean, req?: { ip?: string; agente?: string }): Promise<{ nome: string; mime: string; tamanho: number; ler: () => Promise<Buffer> }> {
    this.varrerMemoria();
    // Para fora tudo é o mesmo 404. Por dentro: 'invalido' = esse token não existe (conta na sondagem por IP); 'expirado' = o token
    // é de um link conhecido que venceu/esgotou (um conector legítimo que repete a busca não pode se bloquear).
    const negar = (envioId: string, dono: string, motivo: string): never => {
      this.auditar({ evento: 'download_negado', envio: envioId, userId: dono, detalhe: { motivo } }, req);
      throw new ErroDeCofre('expirado', 'Arquivo não encontrado.', 404);
    };
    if (!FORMATO_DO_TOKEN.test(token)) throw new ErroDeCofre('invalido', 'Arquivo não encontrado.', 404);
    const hash = sha256(token);
    const id = this.porTokenDeLink.get(hash);
    const e = id ? this.envios.get(id) : undefined;
    const link = e?.links.find((l) => l.hash === hash);
    if (!e || !link) throw new ErroDeCofre('invalido', 'Arquivo não encontrado.', 404);
    if (e.estado !== 'recebido' || !e.arquivo) return negar(e.id, e.dono, 'apagado');
    if (this.agora() >= link.expiraEm) return negar(e.id, e.dono, 'expirado');
    if (link.baixadas >= link.max) return negar(e.id, e.dono, 'limite');
    const a = e.arquivo;
    const meta = { nome: a.nome, mime: TIPOS[a.tipo].mime, tamanho: a.tamanho };
    if (!contar) return { ...meta, ler: () => this.lerCifrado(e, a) };
    link.baixadas += 1; // conta ANTES de ler: baixadas ao mesmo tempo não passam do limite
    try {
      const dados = await this.lerCifrado(e, a);
      this.auditar({ evento: 'download', envio: e.id, userId: e.dono, detalhe: { baixada: link.baixadas, de: link.max, tamanho: a.tamanho } }, req);
      return { ...meta, ler: async () => dados };
    } catch {
      // não entregou (arquivo sumiu, apagado no meio da leitura): a baixada volta
      link.baixadas -= 1;
      return negar(e.id, e.dono, 'leitura-falhou');
    }
  }

  private async lerCifrado(e: Envio, a: NonNullable<Envio['arquivo']>): Promise<Buffer> {
    const chave = Buffer.from(a.chave); // cópia: se o envio for apagado no meio da leitura, a chave original é zerada
    try {
      const bruto = await readFile(a.caminho);
      const dec = createDecipheriv('aes-256-gcm', chave, bruto.subarray(0, 12));
      dec.setAAD(Buffer.from(e.id));
      dec.setAuthTag(bruto.subarray(12, 28));
      return Buffer.concat([dec.update(bruto.subarray(28)), dec.final()]);
    } finally {
      chave.fill(0);
    }
  }

  // ── limpeza ──────────────────────────────────────────────────────────────────────────────────────────────────

  private apagarEnvio(e: Envio, motivo: string): void {
    const caminho = e.arquivo?.caminho;
    const tinhaArquivo = Boolean(caminho);
    if (e.estado === 'apagado') return;
    e.estado = 'apagado';
    e.apagadoEm = this.agora();
    // os tokens continuam apontando para o registro "apagado" por alguns minutos: quem tenta de novo ouve "venceu" (e a
    // auditoria registra a tentativa) em vez de "não existe". Saem junto com o registro.
    if (e.arquivo) {
      e.arquivo.chave.fill(0); // a chave some da memória; o arquivo, se sobrar, não abre mais
      e.arquivo = undefined;
    }
    if (caminho) {
      unlink(caminho).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return;
        this.paraApagar.add(caminho);
        this.o.log?.warn({ err, envio: e.id }, 'cofre: não consegui apagar o arquivo; a varredura tenta de novo');
      });
    }
    this.auditar({ evento: 'apagado', envio: e.id, userId: e.dono, detalhe: { motivo, tinhaArquivo } });
  }

  /**
   * Aplica os prazos na memória e dispara a remoção dos arquivos. Chamada em todo acesso (o prazo vale na hora, não
   * quando o worker passar) e pelo worker.
   */
  varrerMemoria(): void {
    const t = this.agora();
    for (const e of [...this.envios.values()]) {
      if (e.estado === 'apagado') {
        if (t - (e.apagadoEm ?? t) > this.limites.lembrarApagadoMs) {
          this.envios.delete(e.id);
          this.porTokenDeEnvio.delete(e.tokenHash);
          for (const l of e.links) this.porTokenDeLink.delete(l.hash);
        }
        continue;
      }
      if (t >= e.apagarEm) this.apagarEnvio(e, 'teto-de-seguranca');
      else if (e.estado === 'recebido' && e.links.length > 0 && e.links.every((l) => t >= l.expiraEm)) this.apagarEnvio(e, 'link-expirou');
      else if ((e.estado === 'aguardando') && t >= e.criadoEm + this.limites.envioValeMs && !e.usadoEm) {
        // ninguém enviou a tempo: não há arquivo; fecha o pedido
        this.apagarEnvio(e, 'envio-venceu');
      }
    }
  }

  /** O worker: prazos + arquivos órfãos no disco (sobras de um processo anterior, que as chaves já não abrem). */
  async varrer(): Promise<{ orfaosApagados: number }> {
    this.varrerMemoria();
    let orfaosApagados = 0;
    for (const caminho of [...this.paraApagar]) {
      try {
        await unlink(caminho);
        this.paraApagar.delete(caminho);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.paraApagar.delete(caminho);
      }
    }
    let nomes: string[];
    try {
      nomes = await readdir(this.dir);
    } catch {
      return { orfaosApagados };
    }
    const conhecidos = new Set([...this.envios.values()].filter((e) => e.arquivo).map((e) => path.basename(e.arquivo!.caminho)));
    const t = this.agora();
    for (const n of nomes) {
      if (!/^[0-9a-f]{32}\.bin$/.test(n) || conhecidos.has(n)) continue;
      const caminho = path.join(this.dir, n);
      try {
        const s = await stat(caminho);
        // rede de segurança (a subida já apagou a pasta): sobra de kill -9/OOM, arquivo que nenhum envio daqui reclama e que já passou do teto
        if (t - s.mtimeMs > this.limites.ttlDeSegurancaMs) {
          await unlink(caminho);
          orfaosApagados += 1;
        }
      } catch {
        // sumiu no meio: ótimo
      }
    }
    return { orfaosApagados };
  }

  private bytesGuardados(): number {
    let n = 0;
    for (const e of this.envios.values()) n += e.arquivo?.tamanho ?? 0;
    return n;
  }

  /**
   * Desligamento: invalida tudo e ESPERA os arquivos saírem do disco (o container antigo fica no Swarm, parado, com a pasta dele; o
   * que sobra ali fica guardado até o Swarm limpar a tarefa). Devolve quantos arquivos apagou.
   */
  async apagarTudo(): Promise<number> {
    this.encerrado = true; // um envio que estava gravando não cria arquivo depois da limpeza
    for (const e of this.envios.values()) this.apagarEnvio(e, 'desligamento');
    return this.apagarPasta();
  }

  /**
   * Apaga da pasta TODOS os arquivos do cofre (nome = 32 hex + .bin), aguardando. Na subida: a chave de qualquer arquivo que já
   * estivesse aqui morreu com o processo anterior, então é lixo cifrado. Não toca em arquivo com outro nome. Não use numa pasta compartilhada.
   */
  async apagarPasta(): Promise<number> {
    let nomes: string[];
    try {
      nomes = await readdir(this.dir);
    } catch {
      return 0;
    }
    let apagados = 0;
    for (const n of nomes) {
      if (!/^[0-9a-f]{32}\.bin$/.test(n)) continue;
      const caminho = path.join(this.dir, n);
      try {
        await unlink(caminho);
        this.paraApagar.delete(caminho);
        apagados += 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.paraApagar.delete(caminho);
        else this.o.log?.warn({ err }, 'cofre: não consegui apagar um arquivo da pasta; a varredura tenta de novo');
      }
    }
    return apagados;
  }
}

/** Os limites vindos do ambiente (sem segredo). Valor inválido = o padrão, nunca "sem limite". */
export function limitesDoAmbiente(amb: Record<string, string | undefined>): Partial<Limites> {
  const inteiro = (v: string | undefined, min: number, max: number) => {
    const n = Number(v);
    return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  };
  const out: Partial<Limites> = {};
  const mb = inteiro(amb.ARQUIVOS_TAMANHO_MAX_MB, 1, 20);
  if (mb) out.tamanhoMaxBytes = mb * 1024 * 1024;
  const baixadas = inteiro(amb.ARQUIVOS_BAIXADAS_MAX, 1, 10);
  if (baixadas) out.baixadasMax = baixadas;
  return out;
}
