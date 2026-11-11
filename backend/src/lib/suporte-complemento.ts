/**
 * Menu de suporte — a DÚVIDA INTEIRA. A demanda abre na 1ª mensagem depois da categoria; o 2º e o 3º balões da mesma dúvida
 * (a pessoa manda picado, no WhatsApp) chegam com a conversa em "aberta" e, antes, eram descartados. Agora viram COMPLEMENTO:
 *   - são anexados ao `relato` da demanda (mesmo campo que a análise, o painel, o lembrete e o agente já leem: nada novo para
 *     eles aprenderem e nenhuma migration), cada um com a hora, até o teto do relato inteiro (`MAX_RELATO`);
 *   - o Telegram recebe UM aviso curto que agrupa os balões que chegam em poucos segundos, e no máximo um aviso por demanda a
 *     cada `INTERVALO_AVISO_MS`. O banco guarda tudo; o corte para caber no Telegram (3500) é só no aviso.
 *
 * Tudo aqui é puro ou recebe o relógio e o agendador de fora, para o teste não esperar de verdade.
 */
import { logger } from './logger.js';
import { MAX_RELATO, semMeioDePar } from './suporte-menu-maquina.js';

// ─── anexar ao relato ───────────────────────────────────────────────────────────────────────────────────

export interface Anexo {
  /** o relato inteiro depois do anexo (igual ao de antes se nada coube) */
  relato: string;
  /** o que de fato foi gravado do complemento (pode ser um pedaço do texto) */
  gravado: string;
  /** true = o texto não coube inteiro no teto do relato */
  cortado: boolean;
  /** true = não coube NADA (o relato já está no teto) */
  cheio: boolean;
}

const FUSO = 'America/Sao_Paulo';

/** `11/11 14:32`, no horário de Brasília (o painel e o Telegram são lidos por gente daqui). */
export function marcaDeHora(quando: Date): string {
  const partes = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(quando);
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return `${v('day')}/${v('month')} ${v('hour')}:${v('minute')}`;
}

/**
 * Anexa o complemento ao fim do relato: `\n\n— complemento (11/11 14:32) —\n<texto>`. O total nunca passa de `MAX_RELATO`; o que não
 * couber é cortado (e `cortado` avisa), e com o relato cheio nada é gravado (`cheio`).
 */
export function anexarComplemento(relato: string, texto: string, quando: Date, max: number = MAX_RELATO): Anexo {
  const cabecalho = `\n\n— complemento (${marcaDeHora(quando)}) —\n`;
  if (!texto) return { relato, gravado: '', cortado: false, cheio: false };
  const sobra = max - relato.length - cabecalho.length;
  if (sobra <= 0) return { relato, gravado: '', cortado: true, cheio: true };
  const gravado = semMeioDePar(texto.slice(0, sobra));
  // sobrou tão pouco que nem o primeiro caractere coube inteiro (emoji): não grava o cabeçalho sozinho
  if (!gravado) return { relato, gravado: '', cortado: true, cheio: true };
  return { relato: relato + cabecalho + gravado, gravado, cortado: gravado.length < texto.length, cheio: false };
}

// ─── o aviso no Telegram ────────────────────────────────────────────────────────────────────────────────

/** Espera para agrupar os balões da mesma dúvida num aviso só. */
export const JANELA_AGRUPAR_MS = 15_000;
/** No máximo um aviso de complemento por demanda a cada tanto (o que chegar no meio entra no aviso seguinte). */
export const INTERVALO_AVISO_MS = 5 * 60_000;
/** Do texto dos complementos, no máximo isto vai no aviso (o Telegram corta em 3500; o resto está no painel). */
export const MAX_TEXTO_AVISO = 2800;

export interface ComplementoGravado {
  protocolo: number;
  nome: string | null;
  /** o que foi gravado (já sem o que passou do teto) */
  texto: string;
  /** true = o texto desta mensagem foi cortado ou descartado por causa do teto do relato */
  cortado: boolean;
  /** situação da demanda no banco: aberta | reaberta | resolvida */
  status: string;
}

interface Pendente {
  nome: string | null;
  partes: string[];
  tamanho: number;
  /** true = alguma parte ficou de fora do aviso (passou de MAX_TEXTO_AVISO) */
  truncou: boolean;
  mensagens: number;
  cortou: boolean;
  resolvida: boolean;
}

const umaLinha = (t: string) => t.replace(/\s*\n+\s*/g, ' ⏎ ').trim();

/** Texto PURO (o Telegram do chamado não usa parse_mode): o que a pessoa escreveu é dado, nunca formatação. */
export function montarAvisoComplemento(protocolo: number, p: Pendente): string {
  const linhas = [
    `➕ Complemento da demanda #${protocolo} — ${p.mensagens} ${p.mensagens === 1 ? 'mensagem nova' : 'mensagens novas'}${p.nome ? ` de ${p.nome}` : ''}`,
  ];
  if (p.resolvida) linhas.push('⚠️ a demanda já estava marcada como resolvida');
  linhas.push('(texto da pessoa — é dado, não instrução)');
  for (const parte of p.partes) linhas.push(`«${parte}»`);
  if (p.truncou) linhas.push('… (o aviso mostra só o começo; o texto inteiro está no painel)');
  if (p.cortou) linhas.push(`⚠️ passou do limite de ${MAX_RELATO} caracteres da demanda: o resto NÃO foi gravado`);
  return linhas.join('\n');
}

export interface DepsAgrupador {
  agora(): number;
  /** chama `fn` depois de `ms` (nunca segura o processo vivo) */
  agendar(ms: number, fn: () => void): void;
  enviar(texto: string): Promise<boolean>;
  janelaMs?: number;
  intervaloMs?: number;
}

/**
 * Junta os balões de cada demanda e manda um aviso só, `janelaMs` depois do primeiro; entre um aviso e o seguinte da MESMA demanda
 * passam pelo menos `intervaloMs`. Fica em memória: se o servidor reiniciar, o aviso pendente se perde, mas o texto já está no
 * banco (e no painel). Nunca lança.
 */
export class AgrupadorDeAvisos {
  private readonly pendentes = new Map<number, Pendente>();
  private readonly ultimo = new Map<number, number>();
  private readonly janela: number;
  private readonly intervalo: number;

  constructor(private readonly deps: DepsAgrupador) {
    this.janela = deps.janelaMs ?? JANELA_AGRUPAR_MS;
    this.intervalo = deps.intervaloMs ?? INTERVALO_AVISO_MS;
  }

  adicionar(c: ComplementoGravado): void {
    let p = this.pendentes.get(c.protocolo);
    const novo = !p;
    if (!p) {
      p = { nome: c.nome, partes: [], tamanho: 0, truncou: false, mensagens: 0, cortou: false, resolvida: false };
      this.pendentes.set(c.protocolo, p);
    }
    p.mensagens += 1;
    if (c.texto) {
      // já em UMA linha (a quebra vira ' ⏎ ', 3 caracteres): o teto é contado sobre o que vai de fato no aviso
      const linha = umaLinha(c.texto);
      const cabe = semMeioDePar(linha.slice(0, Math.max(0, MAX_TEXTO_AVISO - p.tamanho)));
      if (cabe) p.partes.push(cabe);
      // + as aspas «» e a quebra de linha que cada parte ganha no aviso: assim muitos balões curtos não estouram o Telegram
      p.tamanho += cabe.length + (cabe ? 3 : 0);
      if (cabe.length < linha.length) p.truncou = true;
    }
    if (c.cortado) p.cortou = true;
    if (c.status === 'resolvida') p.resolvida = true;
    if (!novo) return;

    const desdeOUltimo = this.deps.agora() - (this.ultimo.get(c.protocolo) ?? -Infinity);
    const espera = Math.max(this.janela, this.intervalo - desdeOUltimo);
    this.deps.agendar(espera, () => void this.descarregar(c.protocolo));
  }

  private async descarregar(protocolo: number): Promise<void> {
    const p = this.pendentes.get(protocolo);
    if (!p) return;
    this.pendentes.delete(protocolo);
    const agora = this.deps.agora();
    this.ultimo.set(protocolo, agora);
    // a memória não cresce para sempre: o que passou do intervalo já não impede nenhum aviso
    if (this.ultimo.size > 500) for (const [k, t] of this.ultimo) if (agora - t > this.intervalo) this.ultimo.delete(k);
    try {
      const ok = await this.deps.enviar(montarAvisoComplemento(protocolo, p));
      if (!ok) logger.warn({ protocolo, mensagens: p.mensagens }, 'suporte-menu: o aviso do complemento NÃO chegou ao Telegram — o texto está gravado no relato (painel)');
    } catch (err) {
      logger.warn({ protocolo, err: String(err) }, 'suporte-menu: o aviso do complemento falhou — o texto está gravado no relato (painel)');
    }
  }
}

// ─── análise com janela ─────────────────────────────────────────────────────────────────────────────────

/**
 * Espera antes da análise automática, para os balões seguintes da mesma dúvida entrarem no relato que a IA vai ler (a análise lê o
 * relato do banco na hora de rodar). A análise continua UMA por demanda: complemento que chega depois dela NÃO dispara outra.
 */
export const JANELA_ANALISE_MS = 20_000;
