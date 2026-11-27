/**
 * VIGIA DA REDE — decide, a partir de números do banco, se algo quebrou, e como avisar o João sem barulho.
 *
 * Por que existe (27/11/2026): entre 26/11 21h UTC e 27/11 12h11 UTC acabou o crédito da Anthropic ("Your credit
 * balance is too low…") e da OpenAI ("429 You have no credits remaining…"). A Sofia ficou 15 h fora na rede toda,
 * mandou a frase de queda 111 vezes e ninguém foi avisado: o alerta de saldo ia por e-mail (relay que devolve 500).
 *
 * Este arquivo é só DECISÃO (puro, sem banco, sem Telegram) para dar para testar tudo com `node --test`:
 *   - `avaliar`   : observações do banco → lista de problemas (ativo ou não);
 *   - `suprimir`  : o que é consequência de outro problema não vira um segundo aviso;
 *   - `decidir`   : problema + estado salvo → avisar de novo / lembrar / dizer que voltou / ficar quieto;
 *   - `montarTexto`: o texto do Telegram (curto, pt-BR, SEM dado de paciente: só contagens e nomes de unidade).
 * O banco (leituras e estado) e o worker ficam em `vigia-rede-banco.ts`.
 *
 * REGRAS DE BARULHO (pedido do João: "não quero ser incomodado à toa"):
 *   1 aviso quando o problema começa · lembrete no máximo a cada 2 h · 1 "voltou" com a duração.
 *   O "voltou" só sai com PROVA (uma chamada boa depois do último erro), nunca por silêncio: de madrugada
 *   quase não há tráfego e "sem erro" ali não quer dizer "consertado".
 */
import { ehErroDeSaldo } from './ops-alert.js';

// ---------------------------------------------------------------------------------------------------------------
// Limiares — calibrados com o histórico real de llm_calls (30 dias) e messages (ver o PR).
// ---------------------------------------------------------------------------------------------------------------
export const LIMIARES = {
  /** Erro de saldo: uma única chamada recusada por falta de crédito já é prova (é determinístico: toda a conta cai). */
  saldoJanelaMin: 10,
  saldoMinimoChamadas: 1,
  /** IA falhando: taxa de erro (sem contar saldo) por provedor, com amostra mínima. */
  falhaJanelaMin: 15,
  falhaMinimoChamadas: 15,
  falhaTaxa: 0.3,
  /** Para dizer que voltou ao normal: amostra mínima e taxa bem abaixo do limiar (histerese). */
  falhaTaxaNormal: 0.1,
  /** IA parada: nenhuma chamada com sucesso na janela, num horário em que o normal é haver bastante. */
  paradaJanelaMin: 30,
  paradaBaselineMinimo: 20,
  paradaDiasBaseline: 7,
  /** Frase de queda: pacientes de verdade recebendo "tive uma instabilidade". */
  fraseJanelaMin: 30,
  fraseMinimoMensagens: 4,
  fraseMinimoConversas: 3,
  /** Lembrete: no máximo a cada 2 h enquanto durar. */
  lembreteMs: 2 * 60 * 60_000,
  /**
   * Lembrete não toca de madrugada (22h–7h em Brasília): o problema já foi avisado e quem dorme não conserta mais cedo
   * por ouvir de novo. Aviso de problema NOVO e o "voltou" saem a qualquer hora.
   */
  silencioDe: 22,
  silencioAte: 7,
} as const;

export type Familia = 'anthropic' | 'openai';
export const FAMILIAS: readonly Familia[] = ['anthropic', 'openai'];

/** Quem é o dono da chamada. O rótulo `provider` do banco mente (chamadas do Claude aparecem como "openai"); o modelo não. */
export function familiaDoModelo(model: string | null | undefined): Familia {
  return /^claude/i.test(String(model ?? '')) ? 'anthropic' : 'openai';
}

// ---------------------------------------------------------------------------------------------------------------
// O que o banco entrega (a implementação real está em vigia-rede-banco.ts; os testes usam uma em memória)
// ---------------------------------------------------------------------------------------------------------------
export interface GrupoDeErro {
  familia: Familia;
  /** início da mensagem de erro do provedor (200 caracteres), igual para o mesmo tipo de erro */
  mensagem: string;
  chamadas: number;
  /** nomes das unidades atingidas (nome de unidade não é dado de paciente) */
  unidades: string[];
  primeiro: Date;
  ultimo: Date;
}

export interface TotaisDaFamilia {
  ok: number;
  erro: number;
}

export interface Frases {
  mensagens: number;
  conversas: number;
  unidades: string[];
}

export interface Leitura {
  errosAgrupados(agora: Date, janelaMin: number): Promise<GrupoDeErro[]>;
  totaisPorFamilia(agora: Date, janelaMin: number): Promise<Record<Familia, TotaisDaFamilia>>;
  /** última chamada com sucesso de cada provedor (nas últimas 24 h) */
  ultimoSucesso(agora: Date): Promise<Record<Familia, Date | null>>;
  /** sucessos (todos os provedores) em cada um dos N dias anteriores, na mesma hora do dia e na mesma janela */
  baselineSucessos(agora: Date, janelaMin: number, dias: number): Promise<number[]>;
  frases(agora: Date, janelaMin: number): Promise<Frases>;
}

export interface Observacao {
  agora: Date;
  /** erros dos últimos `saldoJanelaMin` min */
  errosSaldoJanela: GrupoDeErro[];
  /** erros dos últimos `falhaJanelaMin` min */
  errosFalhaJanela: GrupoDeErro[];
  totaisFalhaJanela: Record<Familia, TotaisDaFamilia>;
  totaisParadaJanela: Record<Familia, TotaisDaFamilia>;
  ultimoSucesso: Record<Familia, Date | null>;
  baseline: number[];
  frases: Frases;
}

export async function coletar(leitura: Leitura, agora: Date): Promise<Observacao> {
  const L = LIMIARES;
  const [errosSaldoJanela, errosFalhaJanela, totaisFalhaJanela, totaisParadaJanela, ultimoSucesso, baseline, frases] =
    await Promise.all([
      leitura.errosAgrupados(agora, L.saldoJanelaMin),
      leitura.errosAgrupados(agora, L.falhaJanelaMin),
      leitura.totaisPorFamilia(agora, L.falhaJanelaMin),
      leitura.totaisPorFamilia(agora, L.paradaJanelaMin),
      leitura.ultimoSucesso(agora),
      leitura.baselineSucessos(agora, L.paradaJanelaMin, L.paradaDiasBaseline),
      leitura.frases(agora, L.fraseJanelaMin),
    ]);
  return { agora, errosSaldoJanela, errosFalhaJanela, totaisFalhaJanela, totaisParadaJanela, ultimoSucesso, baseline, frases };
}

// ---------------------------------------------------------------------------------------------------------------
// Problemas
// ---------------------------------------------------------------------------------------------------------------
export type TipoDeProblema = 'credito' | 'falha' | 'parada' | 'frase';

/** O que o banco guardou de um problema (tabela vigia_alertas). */
export interface EstadoAlerta {
  chave: string;
  abertoEm: Date;
  /** última vez que o problema foi visto (no crédito, a hora do último erro) — a prova de volta tem que ser POSTERIOR a isto */
  ultimoVistoEm: Date;
  ultimoAvisoEm: Date | null;
  lembretes: number;
  resolvidoEm: Date | null;
}

export interface Problema {
  chave: string;
  tipo: TipoDeProblema;
  familia?: Familia;
  ativo: boolean;
  /** quando começou (primeiro erro da janela), para o "desde" do aviso */
  inicioEm: Date;
  /** a hora do último sinal do problema (crédito: o último erro; os outros: agora) */
  vistoEm: Date;
  unidades: string[];
  /** contagens para o texto (nunca texto de paciente) */
  numeros: Record<string, number | string>;
  /** há prova de que voltou? (só é consultado com o problema inativo e aberto) */
  podeFechar: (estado: EstadoAlerta) => boolean;
  /** consequência de outro problema ativo: não gera aviso próprio */
  suprimidoPor?: string;
}

const maisRecente = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);
const maisAntigo = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

function unirUnidades(grupos: GrupoDeErro[]): string[] {
  return [...new Set(grupos.flatMap((g) => g.unidades))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

const mediana = (xs: number[]): number => {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
};

export function avaliar(obs: Observacao): Problema[] {
  const L = LIMIARES;
  const { agora } = obs;
  const problemas: Problema[] = [];

  // 1. CRÉDITO (um por provedor). A conta decide pelo TEXTO do erro, não pelo rótulo `provider`.
  for (const familia of FAMILIAS) {
    const grupos = obs.errosSaldoJanela.filter((g) => g.familia === familia && ehErroDeSaldo(g.mensagem));
    const chamadas = grupos.reduce((s, g) => s + g.chamadas, 0);
    const ativo = chamadas >= L.saldoMinimoChamadas;
    const ultimoErro = grupos.length ? grupos.map((g) => g.ultimo).reduce(maisRecente) : agora;
    const primeiro = grupos.length ? grupos.map((g) => g.primeiro).reduce(maisAntigo) : agora;
    problemas.push({
      chave: `credito:${familia}`,
      tipo: 'credito',
      familia,
      ativo,
      inicioEm: primeiro,
      vistoEm: ultimoErro,
      unidades: unirUnidades(grupos),
      numeros: { chamadas, janelaMin: L.saldoJanelaMin },
      // voltou = uma chamada boa DEPOIS do último erro de saldo que o vigia viu
      podeFechar: (e) => {
        const s = obs.ultimoSucesso[familia];
        return s !== null && s.getTime() > e.ultimoVistoEm.getTime();
      },
    });
  }

  // 2. IA FALHANDO (um por provedor): taxa de erro SEM contar o saldo, que já tem aviso próprio.
  for (const familia of FAMILIAS) {
    const saldo = obs.errosFalhaJanela.filter((g) => g.familia === familia && ehErroDeSaldo(g.mensagem));
    const outros = obs.errosFalhaJanela.filter((g) => g.familia === familia && !ehErroDeSaldo(g.mensagem));
    const saldoN = saldo.reduce((s, g) => s + g.chamadas, 0);
    const erros = outros.reduce((s, g) => s + g.chamadas, 0);
    const t = obs.totaisFalhaJanela[familia];
    const total = Math.max(0, t.ok + t.erro - saldoN);
    const taxa = total > 0 ? erros / total : 0;
    const ativo = total >= L.falhaMinimoChamadas && taxa >= L.falhaTaxa;
    const normal = total >= L.falhaMinimoChamadas && taxa < L.falhaTaxaNormal;
    problemas.push({
      chave: `falha:${familia}`,
      tipo: 'falha',
      familia,
      ativo,
      inicioEm: outros.length ? outros.map((g) => g.primeiro).reduce(maisAntigo) : agora,
      vistoEm: agora,
      unidades: unirUnidades(outros),
      numeros: {
        erros,
        total,
        pct: Math.round(taxa * 100),
        janelaMin: L.falhaJanelaMin,
        classe: classeDominante(outros),
      },
      podeFechar: () => normal,
    });
  }

  // 3. IA PARADA: zero sucesso na janela, num horário em que o normal (mediana dos mesmos 30 min dos 7 dias anteriores) é haver tráfego.
  {
    const sucessos = FAMILIAS.reduce((s, f) => s + obs.totaisParadaJanela[f].ok, 0);
    const normal = mediana(obs.baseline);
    const ativo = sucessos === 0 && normal >= L.paradaBaselineMinimo;
    problemas.push({
      chave: 'parada',
      tipo: 'parada',
      ativo,
      inicioEm: new Date(agora.getTime() - L.paradaJanelaMin * 60_000),
      vistoEm: agora,
      unidades: [],
      numeros: { janelaMin: L.paradaJanelaMin, normal: Math.round(normal) },
      podeFechar: () => sucessos >= 1,
    });
  }

  // 4. FRASE DE QUEDA: o paciente está lendo "tive uma instabilidade".
  {
    const f = obs.frases;
    const sucessos = FAMILIAS.reduce((s, fa) => s + obs.totaisParadaJanela[fa].ok, 0);
    const ativo = f.mensagens >= L.fraseMinimoMensagens && f.conversas >= L.fraseMinimoConversas;
    problemas.push({
      chave: 'frase',
      tipo: 'frase',
      ativo,
      inicioEm: new Date(agora.getTime() - L.fraseJanelaMin * 60_000),
      vistoEm: agora,
      unidades: f.unidades,
      numeros: { mensagens: f.mensagens, conversas: f.conversas, janelaMin: L.fraseJanelaMin },
      // voltou = nenhuma frase na janela E a IA está respondendo (sem tráfego, silêncio não prova nada)
      podeFechar: () => f.mensagens === 0 && sucessos >= 1,
    });
  }

  return problemas;
}

/**
 * Causa e consequência não viram dois avisos:
 *   saldo do provedor X  → cobre "IA falhando" do mesmo provedor;
 *   saldo ou IA falhando → cobrem "IA parada" e "frase de queda" (são o efeito).
 * Sem causa conhecida, parada e frase avisam sozinhas — aí são a única pista.
 */
export function suprimir(problemas: Problema[]): Problema[] {
  const causa = (p: Problema) => p.ativo && (p.tipo === 'credito' || p.tipo === 'falha');
  const credito = new Map(problemas.filter((p) => p.ativo && p.tipo === 'credito').map((p) => [p.familia, p.chave]));
  const primeiraCausa = problemas.find(causa);
  return problemas.map((p) => {
    if (!p.ativo) return p;
    if (p.tipo === 'falha' && credito.has(p.familia)) return { ...p, suprimidoPor: credito.get(p.familia) };
    if ((p.tipo === 'parada' || p.tipo === 'frase') && primeiraCausa) return { ...p, suprimidoPor: primeiraCausa.chave };
    return p;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Decisão por problema
// ---------------------------------------------------------------------------------------------------------------
export type Acao = 'novo' | 'lembrete' | 'voltou' | 'atualizar' | 'absorver' | 'nada';

/**
 * - `novo`      : problema ativo sem aviso entregue (abre o estado, se ainda não existe);
 * - `lembrete`  : ativo, avisado há ≥ 2 h;
 * - `voltou`    : aberto, inativo e com prova de que voltou;
 * - `atualizar` : ativo, já avisado, dentro da janela de silêncio (só renova o "visto em");
 * - `absorver`  : aberto mas agora é consequência de outro aviso: fecha sem falar;
 * - `nada`      : nada a fazer.
 */
export function decidir(p: Problema, estado: EstadoAlerta | null, agora: Date, lembreteMs: number = LIMIARES.lembreteMs): Acao {
  const aberto = estado !== null && estado.resolvidoEm === null;
  if (!aberto) return p.ativo && !p.suprimidoPor ? 'novo' : 'nada';

  if (p.suprimidoPor) return 'absorver';
  if (p.ativo) {
    if (estado.ultimoAvisoEm === null) return 'novo';
    return agora.getTime() - estado.ultimoAvisoEm.getTime() >= lembreteMs ? 'lembrete' : 'atualizar';
  }
  if (!p.podeFechar(estado)) return 'nada';
  // Nunca chegou a ser avisado: fechar em silêncio (dizer "voltou" de algo que o João nunca soube é barulho).
  return estado.ultimoAvisoEm === null ? 'absorver' : 'voltou';
}

// ---------------------------------------------------------------------------------------------------------------
// Texto do Telegram
// ---------------------------------------------------------------------------------------------------------------
const NOME_DA_CONTA: Record<Familia, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI' };
const ONDE_PAGAR: Record<Familia, string> = {
  anthropic: 'console.anthropic.com → Plans & Billing',
  openai: 'platform.openai.com → Billing',
};

/** Classe do erro em português, sem repetir texto do provedor (que não tem por que ir para o Telegram). */
export function classeDominante(grupos: GrupoDeErro[]): string {
  if (!grupos.length) return 'erro desconhecido';
  const maior = [...grupos].sort((a, b) => b.chamadas - a.chamadas)[0].mensagem.toLowerCase();
  if (/\b(401|403)\b|api key|unauthor|forbidden|not scoped|permission|authentication/.test(maior)) return 'chave recusada pelo provedor (401/403)';
  if (/\b429\b|rate.?limit|too many requests/.test(maior)) return 'limite de uso do provedor (429)';
  if (/\b(500|502|503|504|529)\b|overloaded|unavailable|bad gateway/.test(maior)) return 'provedor instável ou sobrecarregado (5xx)';
  if (/timeout|timed out|abort|econn|enotfound|fetch failed|network/.test(maior)) return 'timeout ou falha de rede';
  if (/\b400\b|invalid_request|invalid body|not valid json/.test(maior)) return 'pedido recusado pelo provedor (400)';
  return 'erro desconhecido';
}

const FUSO = 'America/Sao_Paulo';

/** "18:55" se for no mesmo dia (em Brasília) de `ref`, senão "26/11 18:55". */
export function horaBrasilia(d: Date, ref: Date): string {
  const dia = (x: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' }).format(x);
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return dia(d) === dia(ref) ? hora : `${dia(d)} ${hora}`;
}

/** Hora cheia (0–23) em Brasília. */
function horaDeBrasilia(d: Date): number {
  return Number(new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', hour12: false }).format(d)) % 24;
}

/** Lembrete de madrugada não sai (ver `LIMIARES.silencioDe`). */
export function emSilencioNoturno(d: Date): boolean {
  const h = horaDeBrasilia(d);
  return h >= LIMIARES.silencioDe || h < LIMIARES.silencioAte;
}

export function duracao(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function listaDeUnidades(unidades: string[], max = 6): string {
  if (!unidades.length) return '';
  const vistas = unidades.slice(0, max).join(', ');
  return unidades.length > max ? `${vistas} e mais ${unidades.length - max}` : vistas;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export interface ContextoDoTexto {
  agora: Date;
  /** quando o problema começou (do estado salvo, ou do primeiro erro) */
  desde: Date;
  /** frase de queda nos últimos 30 min (entra no aviso de saldo: é o dano ao paciente) */
  frases?: Frases;
}

export function montarTexto(p: Problema, tipo: 'novo' | 'lembrete' | 'voltou', ctx: ContextoDoTexto): string {
  const desde = horaBrasilia(ctx.desde, ctx.agora);
  const dur = duracao(ctx.agora.getTime() - ctx.desde.getTime());
  const und = p.unidades.length ? `${plural(p.unidades.length, 'unidade', 'unidades')}: ${listaDeUnidades(p.unidades)}` : '';
  const fam = p.familia ? NOME_DA_CONTA[p.familia] : '';

  if (p.tipo === 'credito' && p.familia) {
    const o = ONDE_PAGAR[p.familia];
    if (tipo === 'voltou') return `✅ Voltou: crédito da ${fam}. Ficou ${dur} fora (desde ${desde}, normalizou às ${horaBrasilia(ctx.agora, ctx.agora)}).`;
    const dano =
      ctx.frases && ctx.frases.mensagens > 0
        ? ` Pacientes já receberam a frase de queda ${ctx.frases.mensagens}x (${plural(ctx.frases.conversas, 'conversa', 'conversas')}) nos últimos ${LIMIARES.fraseJanelaMin} min.`
        : '';
    if (tipo === 'lembrete') {
      return `🔴 Ainda sem crédito na ${fam}: já são ${dur} (desde ${desde}).${dano} Pague em ${o} e ligue a recarga automática.`;
    }
    return [
      `🔴 SOFIA SEM CRÉDITO — ${fam}`,
      `Desde ${desde}: ${plural(Number(p.numeros.chamadas), 'chamada recusada', 'chamadas recusadas')} por falta de saldo nos últimos ${p.numeros.janelaMin} min.${und ? ` ${und}.` : ''}${dano}`,
      `O que fazer: pague em ${o} e ligue a recarga automática.`,
    ].join('\n');
  }

  if (p.tipo === 'falha' && p.familia) {
    const base = `${p.numeros.pct}% das chamadas à ${fam} falharam nos últimos ${p.numeros.janelaMin} min (${p.numeros.erros} de ${p.numeros.total}). Erro mais comum: ${p.numeros.classe}.`;
    if (tipo === 'voltou') return `✅ Voltou ao normal: chamadas à ${fam}. Ficou ${dur} com falha (desde ${desde}).`;
    if (tipo === 'lembrete') return `🟠 IA ainda falhando na ${fam} há ${dur} (desde ${desde}). ${base}`;
    return [
      `🟠 IA FALHANDO — ${fam}`,
      `Desde ${desde}. ${base}${und ? ` ${und}.` : ''}`,
      'O que fazer: abrir o console → Execuções (ou llm_calls) e ver o erro; se for 401/403, a chave foi trocada ou revogada.',
    ].join('\n');
  }

  if (p.tipo === 'parada') {
    if (tipo === 'voltou') return `✅ Voltou: a Sofia respondeu de novo. Ficou ${dur} sem nenhuma resposta da IA (desde ${desde}).`;
    const base = `nenhuma chamada da IA deu certo nos últimos ${p.numeros.janelaMin} min (nesse horário o normal é ~${p.numeros.normal}).`;
    if (tipo === 'lembrete') return `🔴 Sofia ainda parada há ${dur} (desde ${desde}): ${base}`;
    return [
      '🔴 SOFIA PARADA',
      `Desde ${desde}: ${base} Não há erro de saldo nem de provedor registrado.`,
      'O que fazer: ver se o backend está de pé e se as mensagens estão chegando (webhook do Kapso/Evolution).',
    ].join('\n');
  }

  // frase de queda
  if (tipo === 'voltou') return `✅ Voltou: a frase de queda parou de sair. Durou ${dur} (desde ${desde}).`;
  const base = `${plural(Number(p.numeros.mensagens), 'vez', 'vezes')} nos últimos ${p.numeros.janelaMin} min, para ${plural(Number(p.numeros.conversas), 'paciente', 'pacientes')}${und ? ` (${und})` : ''}.`;
  if (tipo === 'lembrete') return `🟠 A frase de queda continua saindo há ${dur} (desde ${desde}): ${base}`;
  return [
    '🟠 SOFIA MANDANDO A FRASE DE QUEDA',
    `"Tive uma instabilidade…" saiu ${base} Sem causa de saldo ou de provedor identificada.`,
    'O que fazer: abrir o console → Execuções e ver o erro da IA nessas conversas.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Uma rodada
// ---------------------------------------------------------------------------------------------------------------
export interface EstadoStore {
  listar(): Promise<EstadoAlerta[]>;
  abrir(chave: string, abertoEm: Date, vistoEm: Date): Promise<void>;
  visto(chave: string, vistoEm: Date): Promise<void>;
  /** registra um aviso entregue; `lembrete` incrementa o contador */
  avisou(chave: string, quando: Date, lembrete: boolean): Promise<void>;
  fechar(chave: string, quando: Date): Promise<void>;
}

export interface DepsDaRodada {
  leitura: Leitura;
  store: EstadoStore;
  /** true = o Telegram aceitou */
  enviar: (texto: string) => Promise<boolean>;
  agora?: Date;
  lembreteMs?: number;
}

export interface RegistroDeAviso {
  chave: string;
  acao: Acao;
  texto?: string;
  entregue?: boolean;
}

/**
 * Roda a vigilância uma vez e devolve o que decidiu (os testes e a simulação leem isto). Erro de leitura não muda estado.
 *
 * Lembretes saem JUNTOS: se mais de um problema está aberto, é UMA mensagem com todos (dois alarmes de saldo não viram
 * dois toques no celular), e só fora do silêncio noturno.
 */
export async function rodarVigia(deps: DepsDaRodada): Promise<RegistroDeAviso[]> {
  const agora = deps.agora ?? new Date();
  const obs = await coletar(deps.leitura, agora);
  const problemas = suprimir(avaliar(obs));
  const estados = new Map((await deps.store.listar()).map((e) => [e.chave, e]));
  const saida: RegistroDeAviso[] = [];
  const emAberto: Problema[] = []; // ativos, avisados e sem consequência de outro: candidatos ao lembrete conjunto
  let lembreteDevido = false;

  for (const p of problemas) {
    const estado = estados.get(p.chave) ?? null;
    const acao = decidir(p, estado, agora, deps.lembreteMs);
    if (acao === 'nada') continue;

    if (acao === 'atualizar' || acao === 'lembrete') {
      await deps.store.visto(p.chave, p.vistoEm);
      emAberto.push(p);
      if (acao === 'lembrete') lembreteDevido = true;
      continue;
    }
    if (acao === 'absorver') {
      await deps.store.fechar(p.chave, agora);
      saida.push({ chave: p.chave, acao });
      continue;
    }

    const aberto = estado !== null && estado.resolvidoEm === null;
    if (acao === 'novo' && !aberto) await deps.store.abrir(p.chave, p.inicioEm, p.vistoEm);
    if (p.ativo && acao !== 'voltou') await deps.store.visto(p.chave, p.vistoEm);

    const desde = estado && !estado.resolvidoEm ? estado.abertoEm : p.inicioEm;
    const texto = montarTexto(p, acao, { agora, desde, frases: obs.frases });
    const entregue = await deps.enviar(texto);
    saida.push({ chave: p.chave, acao, texto, entregue });
    if (!entregue) continue; // não marca: a próxima rodada tenta de novo

    if (acao === 'voltou') await deps.store.fechar(p.chave, agora);
    else await deps.store.avisou(p.chave, agora, false);
  }

  if (lembreteDevido && !emSilencioNoturno(agora)) {
    const junto = emAberto.length > 1;
    const linhas = emAberto.map((p) => {
      const desde = estados.get(p.chave)?.abertoEm ?? p.inicioEm;
      // no lembrete conjunto o dano (frase de queda) entra UMA vez no fim, não repetido em cada linha
      return montarTexto(p, 'lembrete', { agora, desde, frases: junto ? undefined : obs.frases });
    });
    const f = obs.frases;
    const dano = junto && f.mensagens > 0 ? `\nPacientes receberam a frase de queda ${f.mensagens}x (${plural(f.conversas, 'conversa', 'conversas')}) nos últimos ${LIMIARES.fraseJanelaMin} min.` : '';
    const texto = junto ? `🔔 Continuam abertos (${linhas.length}):\n${linhas.map((l) => `• ${l}`).join('\n')}${dano}` : linhas[0];
    const entregue = await deps.enviar(texto);
    saida.push({ chave: emAberto.map((p) => p.chave).join('+'), acao: 'lembrete', texto, entregue });
    if (entregue) for (const p of emAberto) await deps.store.avisou(p.chave, agora, true);
  }
  return saida;
}
