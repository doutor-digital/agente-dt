/**
 * Menu de suporte no WhatsApp — o serviço: recebe o webhook do Evolution (instância do agente de suporte), conduz a conversa
 * pela máquina de estados (`suporte-menu-maquina.ts`, texto fixo, sem IA) e, quando a demanda fica pronta, abre o protocolo e
 * manda UM cartão ao Telegram do João.
 *
 * LIGA/DESLIGA — variável de ambiente GLOBAL `SUPORTE_MENU` (é da rede inteira, como o `RESUMO_DIARIO_IA`; o catálogo de
 * `automacoes.ts` é por unidade): `desligado` (padrão: vazio ou valor estranho = desligado) | `seco` | `ligado`.
 *   - `seco`: processa o webhook e registra no log o que RESPONDERIA, sem enviar NADA ao WhatsApp nem ao Telegram e sem
 *     gravar nada no banco (só lê). Cada mensagem aparece como "primeira" porque ninguém recebeu resposta.
 *   - `ligado`: responde, grava e manda o cartão.
 * Mudar a variável vale no próximo deploy (o `.env` só é lido quando o contêiner sobe).
 *
 * SEGURANÇA
 *   - o webhook só aceita quem sabe `SUPORTE_MENU_SEGREDO` (`?k=` ou cabeçalho), comparado em tempo constante;
 *   - só vale evento da instância configurada, mensagem individual, não enviada por nós e recente (backlog de reconexão
 *     NUNCA é respondido: é o que mais derruba número de WhatsApp);
 *   - o texto da pessoa é DADO: nunca vira comando, consulta, prompt nem formatação (o cartão vai em texto puro);
 *   - o número aparece mascarado no log do servidor; inteiro só no cartão do Telegram (o João precisa dele para responder).
 *
 * ANTI-BAN: só responde a quem escreveu; "digitando…" antes de cada resposta; teto de conversas novas por hora e de
 * respostas por dia; sem retry (erro = registra e para); nenhuma mensagem proativa.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from './logger.js';
import {
  ESTADO_VAZIO,
  MARCA_PROTOCOLO,
  avancar,
  type Abrir,
  type Entrada,
  type Estado,
  type Passo,
  type UnidadeBasica,
  type Verificacao,
} from './suporte-menu-maquina.js';

// ─── configuração ───────────────────────────────────────────────────────────────────────────────────────

export type ModoSuporte = 'desligado' | 'seco' | 'ligado';

export function modoDoSuporte(bruto: string | undefined | null): ModoSuporte {
  const v = String(bruto ?? '').trim().toLowerCase();
  return v === 'seco' || v === 'ligado' ? v : 'desligado';
}

export interface ConfigSuporte {
  modo: ModoSuporte;
  segredo: string;
  evoUrl: string;
  evoInstancia: string;
  evoApikey: string;
  /** de onde ler os grupos de Marketing (padrão: a mesma instância do agente; pode ser outra, só para LEITURA) */
  gruposUrl: string;
  gruposInstancia: string;
  gruposApikey: string;
  novasPorHora: number;
  respostasPorDia: number;
}

export const INSTANCIA_PADRAO = 'analista-dt';
export const NOVAS_POR_HORA_PADRAO = 10;
export const RESPOSTAS_POR_DIA_PADRAO = 150;

function inteiroPositivo(v: string | undefined, padrao: number): number {
  const n = Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : padrao;
}

export function lerConfig(env: NodeJS.ProcessEnv = process.env): ConfigSuporte {
  const evoUrl = String(env.SUPORTE_EVO_URL ?? '').trim();
  const evoInstancia = String(env.SUPORTE_EVO_INSTANCIA ?? '').trim() || INSTANCIA_PADRAO;
  const evoApikey = String(env.SUPORTE_EVO_APIKEY ?? '').trim();
  return {
    modo: modoDoSuporte(env.SUPORTE_MENU),
    segredo: String(env.SUPORTE_MENU_SEGREDO ?? '').trim(),
    evoUrl,
    evoInstancia,
    evoApikey,
    gruposUrl: String(env.SUPORTE_GRUPOS_URL ?? '').trim() || evoUrl,
    gruposInstancia: String(env.SUPORTE_GRUPOS_INSTANCIA ?? '').trim() || evoInstancia,
    gruposApikey: String(env.SUPORTE_GRUPOS_APIKEY ?? '').trim() || evoApikey,
    novasPorHora: inteiroPositivo(env.SUPORTE_MENU_NOVAS_POR_HORA, NOVAS_POR_HORA_PADRAO),
    respostasPorDia: inteiroPositivo(env.SUPORTE_MENU_RESPOSTAS_POR_DIA, RESPOSTAS_POR_DIA_PADRAO),
  };
}

/** Compara o segredo em tempo constante (hash dos dois lados: tamanhos diferentes não vazam). Sem segredo configurado = recusa tudo. */
export function segredoConfere(config: ConfigSuporte, recebido: unknown): boolean {
  if (!config.segredo || typeof recebido !== 'string' || !recebido) return false;
  const a = createHash('sha256').update(config.segredo).digest();
  const b = createHash('sha256').update(recebido).digest();
  return timingSafeEqual(a, b);
}

// ─── o que chega do Evolution ───────────────────────────────────────────────────────────────────────────

export interface Recebida {
  id: string;
  jid: string;
  jidAlt: string | null;
  texto: string;
  semTexto: boolean;
  tipoMidia: 'audio' | 'imagem' | 'outro' | null;
  nomePerfil: string | null;
}

export type Extracao = { ok: true; msg: Recebida } | { ok: false; motivo: string };

/** Mensagem mais velha que isto é histórico (reconexão): nunca é respondida. */
export const IDADE_MAXIMA_S = 10 * 60;

const TIPOS_DE_MIDIA: Readonly<Record<string, 'audio' | 'imagem' | 'outro'>> = {
  audioMessage: 'audio',
  pttMessage: 'audio',
  imageMessage: 'imagem',
  videoMessage: 'outro',
  documentMessage: 'outro',
  documentWithCaptionMessage: 'outro',
  stickerMessage: 'outro',
  contactMessage: 'outro',
  locationMessage: 'outro',
};

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Lê o corpo do webhook (Evolution v2, `messages.upsert`) sem confiar em nada: qualquer coisa fora do formato vira "ignorar". */
export function extrairMensagem(corpo: unknown, config: ConfigSuporte, agoraS: number = Math.floor(Date.now() / 1000)): Extracao {
  if (!ehObj(corpo)) return { ok: false, motivo: 'corpo inválido' };
  const evento = texto(corpo.event).toLowerCase().replace(/_/g, '.');
  if (evento !== 'messages.upsert') return { ok: false, motivo: 'evento ignorado' };
  if (texto(corpo.instance) !== config.evoInstancia) return { ok: false, motivo: 'outra instância' };
  const dado = Array.isArray(corpo.data) ? corpo.data[0] : corpo.data;
  if (!ehObj(dado) || !ehObj(dado.key)) return { ok: false, motivo: 'sem mensagem' };
  const key = dado.key;
  if (key.fromMe === true) return { ok: false, motivo: 'mensagem nossa' };
  const jid = texto(key.remoteJid);
  if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) return { ok: false, motivo: 'não é conversa individual' };
  const id = texto(key.id);
  if (!id || id.length > 128) return { ok: false, motivo: 'sem id' };
  const ts = Number(dado.messageTimestamp);
  if (Number.isFinite(ts) && ts > 0 && agoraS - ts > IDADE_MAXIMA_S) return { ok: false, motivo: 'mensagem antiga (histórico)' };

  const msg = ehObj(dado.message) ? dado.message : {};
  const tipo = texto(dado.messageType);
  const ext = ehObj(msg.extendedTextMessage) ? msg.extendedTextMessage : {};
  const legenda = (k: string) => (ehObj(msg[k]) ? texto((msg[k] as Obj).caption) : '');
  const botao = ehObj(msg.buttonsResponseMessage) ? texto((msg.buttonsResponseMessage as Obj).selectedDisplayText) : '';
  const lista = ehObj(msg.listResponseMessage) ? texto((msg.listResponseMessage as Obj).title) : '';
  const conteudo = texto(msg.conversation) || texto(ext.text) || legenda('imageMessage') || legenda('videoMessage') || legenda('documentMessage') || botao || lista;

  const tipoMidia = TIPOS_DE_MIDIA[tipo] ?? Object.keys(msg).map((k) => TIPOS_DE_MIDIA[k]).find(Boolean) ?? null;
  if (!conteudo && !tipoMidia) return { ok: false, motivo: 'sem conteúdo útil (reação, apagada ou sistema)' };

  const alt = texto(key.remoteJidAlt) || texto(key.senderPn) || texto(dado.senderPn);
  return {
    ok: true,
    msg: {
      id,
      jid,
      jidAlt: alt || null,
      texto: conteudo,
      semTexto: !conteudo,
      tipoMidia: conteudo ? null : tipoMidia,
      nomePerfil: texto(dado.pushName).trim() || null,
    },
  };
}

/** `…9464`: o que vai para o log do servidor. */
export function mascarar(jid: string): string {
  const d = String(jid).split('@')[0]!.replace(/\D/g, '');
  return d.length >= 4 ? `…${d.slice(-4)}` : '…';
}

// ─── o cartão do Telegram ───────────────────────────────────────────────────────────────────────────────

export interface DadosDoCartao {
  protocolo: number;
  jid: string;
  abrir: Abrir;
  quando: Date;
}

function formatarNumero(jid: string): string {
  const d = jid.split('@')[0]!.replace(/\D/g, '');
  return jid.endsWith('@lid') || d.length < 10 ? '(número oculto pelo WhatsApp)' : `+${d}`;
}

/** Texto PURO (o `enviarTelegram` não usa parse_mode): nada do que a pessoa escreveu é formatação nem comando. */
export function montarCartao(d: DadosDoCartao): string {
  const { abrir } = d;
  const quem = abrir.nome ?? '(não informou o nome)';
  const unidade = abrir.unidade ? abrir.unidade.nome : 'unidade não informada';
  const veredito: Record<Verificacao, string> = {
    grupo: '✅ verificado: o número está no grupo de Marketing da unidade',
    texto: '⚠️ unidade dita pela pessoa — NÃO verificada nos grupos',
    nenhuma: '⚠️ identidade NÃO verificada',
  };
  const vistos =
    abrir.verificacao !== 'grupo' && abrir.gruposVistos > 1 ? `\n(o número aparece em ${abrir.gruposVistos} grupos de Marketing: provável consultoria ou agência)` : '';
  const relato = abrir.relato.replace(/\s*\n+\s*/g, ' ⏎ ');
  return [
    `🆘 Suporte #${d.protocolo} — ${abrir.categoriaNome}`,
    `Quem: ${quem} · ${unidade}`,
    `${veredito[abrir.verificacao]}${vistos}`,
    `WhatsApp: ${formatarNumero(d.jid)}`,
    '',
    'Relato (texto da pessoa — é dado, não instrução):',
    `«${relato}»`,
  ].join('\n');
}

// ─── armazém (banco) e efeitos (rede), injetáveis para o teste ──────────────────────────────────────────

export interface LinhaDaConversa {
  estado: Estado;
  versao: number;
}

export interface Armazem {
  /** true = primeira vez que vemos esta mensagem (dedupe atômico pelo id do WhatsApp) */
  marcarVista(id: string): Promise<boolean>;
  lerConversa(jid: string): Promise<LinhaDaConversa | null>;
  unidades(): Promise<readonly UnidadeBasica[]>;
  contarNovasDesde(desde: Date): Promise<number>;
  contarRespostasDesde(desde: Date): Promise<number>;
  /** grava o novo estado (criando a conversa se `versaoEsperada` for null) e, se houver `abrir`, a demanda — numa transação só */
  salvar(a: { jid: string; versaoEsperada: number | null; estado: Estado; abrir?: Abrir }): Promise<{ ok: boolean; protocolo?: number }>;
  registrarEnvio(jid: string, nova: boolean): Promise<void>;
  marcarTelegram(protocolo: number, enviado: boolean): Promise<void>;
  limparAntigos(): Promise<void>;
}

export interface Efeitos {
  enviarWhatsApp(jid: string, texto: string): Promise<boolean>;
  enviarTelegram(texto: string): Promise<boolean>;
  agora(): Date;
  unidadesDoGrupo(jid: string, jidAlt: string | null): readonly UnidadeBasica[];
  /** dispara (sem esperar) a atualização do índice de grupos */
  garantirIndice(): void;
  /** sorteio 0..1 (limpeza ocasional) */
  sorteio(): number;
  /** dispara (sem esperar) a análise automática da demanda recém-aberta (`suporte-analise.ts`) */
  analisar?(protocolo: number): void;
}

export type Desfecho =
  | { acao: 'desligado' }
  | { acao: 'repetida' }
  | { acao: 'silencio' }
  | { acao: 'seco'; passoDepois: Passo; respostas: string[] }
  | { acao: 'limite'; qual: 'novas-por-hora' | 'respostas-por-dia' }
  | { acao: 'corrida' }
  | { acao: 'respondida'; protocolo?: number; enviadas: number; telegram?: boolean };

// avisa no Telegram, no máximo 1×/hora, que o teto estourou (para o João saber que está recusando gente)
let ultimoAvisoDeLimite = 0;
export function _zerarAvisoDeLimiteParaTeste(): void {
  ultimoAvisoDeLimite = 0;
}

const H = 60 * 60_000;

export async function processarMensagem(msg: Recebida, config: ConfigSuporte, armazem: Armazem, ef: Efeitos): Promise<Desfecho> {
  if (config.modo === 'desligado') return { acao: 'desligado' };
  const agora = ef.agora();
  const ligado = config.modo === 'ligado';

  ef.garantirIndice();

  if (ligado && !(await armazem.marcarVista(msg.id))) return { acao: 'repetida' };

  const linha = await armazem.lerConversa(msg.jid);
  const estado = linha?.estado ?? ESTADO_VAZIO;
  const entrada: Entrada = { texto: msg.texto, semTexto: msg.semTexto, tipoMidia: msg.tipoMidia };
  const r = avancar(estado, entrada, {
    agora,
    unidades: await armazem.unidades(),
    unidadesDoGrupo: ef.unidadesDoGrupo(msg.jid, msg.jidAlt),
    nomePerfil: msg.nomePerfil,
  });

  if (!ligado) {
    logger.info(
      { numero: mascarar(msg.jid), passoAntes: estado.passo, passoDepois: r.estado.passo, abriria: Boolean(r.abrir), respostas: r.respostas },
      'suporte-menu (seco): responderia',
    );
    return { acao: 'seco', passoDepois: r.estado.passo, respostas: r.respostas };
  }

  if (r.silencio || r.respostas.length === 0) return { acao: 'silencio' };

  // tetos anti-ban: passou do limite, ignora (não avança o estado nem responde)
  const estourou = async (qual: 'novas-por-hora' | 'respostas-por-dia'): Promise<Desfecho> => {
    logger.warn({ numero: mascarar(msg.jid), qual }, 'suporte-menu: teto atingido — mensagem ignorada');
    if (agora.getTime() - ultimoAvisoDeLimite > H) {
      ultimoAvisoDeLimite = agora.getTime();
      await ef.enviarTelegram(`⚠️ Menu de suporte: o teto de ${qual === 'novas-por-hora' ? 'conversas novas por hora' : 'respostas por dia'} foi atingido. Mensagens novas estão sendo ignoradas até liberar.`);
    }
    return { acao: 'limite', qual };
  };
  if (r.nova && (await armazem.contarNovasDesde(new Date(agora.getTime() - H))) >= config.novasPorHora) return estourou('novas-por-hora');
  if ((await armazem.contarRespostasDesde(new Date(agora.getTime() - 24 * H))) + r.respostas.length > config.respostasPorDia) return estourou('respostas-por-dia');

  const salvo = await armazem.salvar({ jid: msg.jid, versaoEsperada: linha ? linha.versao : null, estado: r.estado, abrir: r.abrir });
  if (!salvo.ok) {
    logger.info({ numero: mascarar(msg.jid) }, 'suporte-menu: outra mensagem da mesma conversa passou na frente — ignorada');
    return { acao: 'corrida' };
  }

  // responde, uma de cada vez; o 1º erro para tudo (sem retry cego)
  let enviadas = 0;
  for (const [i, bruto] of r.respostas.entries()) {
    const textoFinal = salvo.protocolo != null ? bruto.split(MARCA_PROTOCOLO).join(String(salvo.protocolo)) : bruto;
    const ok = await ef.enviarWhatsApp(msg.jid, textoFinal);
    if (!ok) {
      logger.warn({ numero: mascarar(msg.jid), indice: i }, 'suporte-menu: o WhatsApp recusou a resposta — parei por aqui');
      break;
    }
    enviadas += 1;
    await armazem.registrarEnvio(msg.jid, i === 0 && r.nova);
  }

  // o cartão do João sai mesmo se a resposta à pessoa falhou: a demanda existe e alguém precisa vê-la
  let telegram: boolean | undefined;
  if (r.abrir && salvo.protocolo != null) {
    telegram = await ef.enviarTelegram(montarCartao({ protocolo: salvo.protocolo, jid: msg.jid, abrir: r.abrir, quando: agora }));
    await armazem.marcarTelegram(salvo.protocolo, telegram);
    if (!telegram) logger.warn({ protocolo: salvo.protocolo }, 'suporte-menu: o cartão NÃO chegou ao Telegram — a demanda está só no banco');
    // a análise roda à parte: o webhook não espera a IA (pode levar até 1 min)
    ef.analisar?.(salvo.protocolo);
  }

  if (ef.sorteio() < 0.01) await armazem.limparAntigos().catch((err: unknown) => logger.warn({ err: String(err) }, 'suporte-menu: limpeza falhou'));

  return { acao: 'respondida', protocolo: salvo.protocolo, enviadas, telegram };
}

// ─── envio pelo Evolution ───────────────────────────────────────────────────────────────────────────────

/** Só HTTPS (o `apikey` vai no cabeçalho). Sem URL/chave configuradas, não envia. */
export function criarEnviadorEvolution(config: ConfigSuporte, buscar: typeof fetch = globalThis.fetch, sorteio: () => number = Math.random) {
  return async (jid: string, textoEnviar: string): Promise<boolean> => {
    if (!config.evoUrl.startsWith('https://') || !config.evoApikey) {
      logger.warn('suporte-menu: SUPORTE_EVO_URL (https) ou SUPORTE_EVO_APIKEY ausente — nada enviado');
      return false;
    }
    try {
      const r = await buscar(`${config.evoUrl.replace(/\/+$/, '')}/message/sendText/${encodeURIComponent(config.evoInstancia)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.evoApikey },
        // `delay` = o "digitando…" que o Evolution mostra antes de entregar (1,2–3 s)
        body: JSON.stringify({ number: jid, text: textoEnviar, delay: 1200 + Math.floor(sorteio() * 1800) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) logger.warn({ status: r.status }, 'suporte-menu: o Evolution recusou o envio');
      return r.ok;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.name : 'erro' }, 'suporte-menu: falha de rede ao enviar');
      return false;
    }
  };
}

// ─── uma conversa por vez ───────────────────────────────────────────────────────────────────────────────

const filas = new Map<string, Promise<unknown>>();

/** Duas mensagens seguidas da mesma pessoa são processadas em ordem (a trava otimista do banco cobre o caso de várias réplicas). */
export function emFila<T>(chave: string, tarefa: () => Promise<T>): Promise<T> {
  const anterior = filas.get(chave) ?? Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  // a fila guarda uma cópia que nunca rejeita (o erro vai para quem chamou, não vira "unhandled rejection")
  const guarda: Promise<unknown> = atual
    .catch(() => undefined)
    .finally(() => {
      if (filas.get(chave) === guarda) filas.delete(chave);
    });
  filas.set(chave, guarda);
  return atual;
}
