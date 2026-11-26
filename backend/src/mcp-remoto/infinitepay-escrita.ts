/**
 * InfinitePay com escrita pelo claude.ai: CRIAR LINK DE PAGAMENTO (checkout Pix/cartão), DIRETO (sem passo de confirmação), só para quem está em
 * MCP_ESCRITA_EMAILS e só nas unidades de INFINITEPAY_ESCRITA_UNIDADES. É a ÚNICA escrita que a API da InfinitePay tem: ela não cancela link, não
 * estorna, não transfere e não tem recorrência — então nenhuma dessas ferramentas existe aqui.
 *
 * Quem protege o dinheiro, já que ninguém confirma antes (mesmo desenho do Asaas, com a tabela `infinitepay_links` como livro):
 *   - INFINITEPAY_ESCRITA_UNIDADES (falha fechada): slugs separados por vírgula; vazia ou ausente = desligada em todas; "*" e "todas" não valem.
 *     Com ela vazia a ferramenta nem aparece na sessão, e a função recusa de novo na hora de criar;
 *   - teto por link (INFINITEPAY_TETO_OPERACAO_REAIS, padrão 5000) e por dia e unidade (INFINITEPAY_TETO_DIA_REAIS, padrão 20000, no fuso de Brasília),
 *     lidos do banco DENTRO de uma trava por unidade (vale entre instâncias do servidor); vazio, 0 ou lixo = o padrão, nunca ilimitado;
 *   - limite de links por hora e unidade (INFINITEPAY_LINKS_POR_HORA, padrão 20; 0 ou lixo = criação DESLIGADA);
 *   - a INTENÇÃO é gravada ANTES de chamar a InfinitePay: queda no meio deixa o link em "intencao", que continua contando para o teto;
 *   - link igual (mesmo valor e descrição) feito há menos de 10 minutos é recusado; a referência (order_nsu) é única por unidade;
 *   - nasce com pagamento ÚNICO e validade (padrão 7 dias, no máximo 90), porque a API não cancela link;
 *   - aviso no Telegram do João a cada link acima de 50% do teto e a cada criação cuja resposta da InfinitePay não veio clara.
 * O segredo (a chave) nunca passa por aqui: a conta carrega a chamada pronta.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroInfinitepay, tirarChave, type PedidoDeLink } from '../lib/integracoes/infinitepay.js';
import { temDigitosSeguidos } from '../lib/pii.js';
import { FUSO_PADRAO, arredondar, diaLocal, dinheiro, positivo } from './asaas-limites.js';
import { executar } from './ferramenta.js';
import { resolverContaInfinitepay, reais, type ArmazemDeLinks, type ContaInfinitepay, type ContextoInfinitepay, type LinkGuardado } from './infinitepay.js';

export const LIMITES_INFINITEPAY = {
  duplicataMs: 10 * 60_000,
  horaMs: 3_600_000,
  janelaLivroMs: 36 * 3_600_000,
  porHoraPadrao: 20,
  tetoOperacaoPadrao: 5000,
  tetoDiaPadrao: 20000,
  validadePadraoDias: 7,
  validadeMaxDias: 90,
  /** mínimo da InfinitePay para qualquer pagamento */
  valorMinimo: 1,
  descricaoMax: 120,
};

// ----------------------------------------------------------------- limites (lidos a cada uso, do ambiente)

export function tetoPorLink(e: NodeJS.ProcessEnv = process.env): number {
  return positivo(e.INFINITEPAY_TETO_OPERACAO_REAIS) ?? LIMITES_INFINITEPAY.tetoOperacaoPadrao;
}

export function tetoPorDiaInfinitepay(e: NodeJS.ProcessEnv = process.env): number {
  return positivo(e.INFINITEPAY_TETO_DIA_REAIS) ?? LIMITES_INFINITEPAY.tetoDiaPadrao;
}

/** Vazio = padrão; número inteiro ≥ 0; 0 ou lixo = criação DESLIGADA (mesma regra do Asaas). */
export function linksPorHora(e: NodeJS.ProcessEnv = process.env): number {
  const bruto = e.INFINITEPAY_LINKS_POR_HORA?.trim();
  if (!bruto) return LIMITES_INFINITEPAY.porHoraPadrao;
  const n = Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Unidades em que a criação de link está LIGADA. Ausente ou vazia = desligada em todas (falha fechada); "*" não vale. */
export function unidadesComEscritaInfinitepay(e: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (e.INFINITEPAY_ESCRITA_UNIDADES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.includes('*')),
  );
}

// ----------------------------------------------------------------- o livro e o armazém

export interface ItemDoLivro {
  valorCentavos: number;
  status: string;
  em: number;
  chave: string | null;
  orderNsu: string;
  url: string | null;
}

/**
 * Os links das últimas 36 h da unidade, lidos do banco naquele instante. Só calcula; não guarda estado. `falhou` (recusa certa da InfinitePay) NÃO gasta o
 * teto de VALOR do dia, mas CONTA no limite por hora: o limite por hora existe para segurar quem martela a InfinitePay (400/422/429 inclusive).
 */
export class LivroDeLinks {
  constructor(private itens: ItemDoLivro[] = []) {}

  private vivos(): ItemDoLivro[] {
    return this.itens.filter((x) => x.status !== 'falhou');
  }

  somaDoDia(agora: number, fuso: string = FUSO_PADRAO): number {
    const hoje = diaLocal(agora, fuso);
    const cents = this.vivos().filter((x) => diaLocal(x.em, fuso) === hoje).reduce((s, x) => s + x.valorCentavos, 0);
    return cents / 100;
  }

  naHora(agora: number, horaMs: number): number {
    return this.itens.filter((x) => agora - x.em < horaMs).length;
  }

  igual(chave: string, agora: number, janelaMs: number): ItemDoLivro | undefined {
    return this.vivos().find((x) => x.chave === chave && agora - x.em < janelaMs);
  }
}

export interface PedidoDeReserva {
  unidade: string;
  orderNsu: string;
  chave: string;
  valorCentavos: number;
  descricao: string;
  validoAte: Date;
  criadoPor: string;
  agora: number;
  /** recebe o livro lido DENTRO da trava; lança ErroDeEntrada para recusar */
  conferir(livro: LivroDeLinks): void;
}

export type ResultadoDaCriacao =
  | { status: 'criado'; url: string; invoiceSlug?: string }
  | { status: 'falhou'; erro: string }
  /** sem resposta clara (timeout, 5xx, resposta sem URL): o link PODE existir; fica em "intencao" e conta para o teto */
  | { status: 'intencao'; erro: string };

export interface EventoDoLink {
  evento: string;
  /** marca o link para o João conferir no app (estorno/cancelamento avisados e NÃO confirmados pela API): texto livre, visível em infinitepay_links */
  revisao?: string;
  /** só muda o status se o atual estiver em `deStatus` (ex.: pago só sai de criado/intencao) */
  paraStatus?: 'pago' | 'cancelado';
  deStatus?: string[];
  pagamento?: { invoiceSlug?: string; transactionNsu?: string; forma?: string; parcelas?: number; valorPagoCentavos?: number; reciboUrl?: string };
  liquidado?: boolean;
}

/** Tudo o que a escrita precisa do banco. A mesma interface tem a versão de produção (Prisma) e a de teste (memória). */
export interface ArmazemDeEscrita extends ArmazemDeLinks {
  /** leitura sem trava (consumo do dia; conferência prévia): o que vale é a leitura feita dentro de `reservar` */
  ler(unidade: string, agora: number): Promise<LivroDeLinks>;
  /** numa trava única por unidade: lê o livro, deixa `conferir` recusar e grava a INTENÇÃO. `orderNsu` repetido na unidade é recusado. */
  reservar(p: PedidoDeReserva): Promise<void>;
  resolver(unidade: string, orderNsu: string, r: ResultadoDaCriacao): Promise<void>;
  /** o webhook: aplica um evento; `mudou` = o status mudou (ou a liquidação foi marcada) agora, e não numa entrega anterior do mesmo aviso */
  aplicarEvento(unidade: string, orderNsu: string, e: EventoDoLink): Promise<{ mudou: boolean; atual: LinkGuardado | null }>;
}

export const FALHA_DO_BANCO_INFINITEPAY = 'não consegui conferir nem registrar o link no banco (tetos e duplicata): nada foi criado; tente em instantes';

// ----------------------------------------------------------------- estado

export interface EstadoEscritaInfinitepay {
  agora: () => number;
  tetoLink: () => number;
  tetoDia: () => number;
  porHora: () => number;
  unidades: () => Set<string>;
  /** a URL do aviso (webhook) deste link, assinada por nós; ausente = o link nasce sem aviso automático */
  urlDoWebhook?: (unidade: string, orderNsu: string) => string;
  /** manda o aviso (Telegram); devolve se saiu. Nunca lança. */
  alertar: (texto: string) => Promise<boolean>;
  armazem: ArmazemDeEscrita;
  /** uma criação por vez POR UNIDADE neste processo; entre processos quem segura é a trava do banco */
  filas: Map<string, Promise<unknown>>;
}

const SEM_ARMAZEM: ArmazemDeEscrita = {
  async listar() {
    throw new ErroDeEntrada('o conector subiu sem o banco dos links: a criação de link está desligada');
  },
  async porOrderNsu() {
    throw new ErroDeEntrada('o conector subiu sem o banco dos links: a criação de link está desligada');
  },
  async ler() {
    throw new ErroDeEntrada('o conector subiu sem o banco dos links: a criação de link está desligada');
  },
  async reservar() {
    throw new ErroDeEntrada('o conector subiu sem o banco dos links: a criação de link está desligada');
  },
  async resolver() {
    throw new ErroDeEntrada('o conector subiu sem o banco dos links: a criação de link está desligada');
  },
  async aplicarEvento() {
    throw new ErroDeEntrada('o conector subiu sem o banco dos links: a criação de link está desligada');
  },
};

export function criarEscritaInfinitepay(
  o: Partial<Omit<EstadoEscritaInfinitepay, 'filas'>> = {},
): EstadoEscritaInfinitepay {
  return {
    agora: o.agora ?? Date.now,
    tetoLink: o.tetoLink ?? (() => tetoPorLink()),
    tetoDia: o.tetoDia ?? (() => tetoPorDiaInfinitepay()),
    porHora: o.porHora ?? (() => linksPorHora()),
    unidades: o.unidades ?? (() => unidadesComEscritaInfinitepay()),
    ...(o.urlDoWebhook ? { urlDoWebhook: o.urlDoWebhook } : {}),
    // o servidor passa o Telegram de verdade (producao.ts); sem isso o aviso não sai
    alertar: o.alertar ?? (async () => false),
    // sem armazém (nem nos testes) a escrita não anda: teto que não lê o banco não é teto
    armazem: o.armazem ?? SEM_ARMAZEM,
    filas: new Map(),
  };
}

export interface QuemInfinitepay {
  id: string;
  email?: string;
  clientId?: string;
}

// ----------------------------------------------------------------- validação

const REFERENCIA = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
/** telefone brasileiro: DDD (com ou sem parênteses) + 8 ou 9 dígitos; a barra de data não conta como separador */
const TELEFONE = /(?<!\d)\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/;
/** o marcador que sobra no lugar de uma data ou de um valor: não é separador de dígitos, então não junta o que vem antes com o que vem depois */
const SEM_DATA_NEM_VALOR = '|';
// datas (26/11/2026, 26-11-2026) e valores em dinheiro: BR (1.500,00 e 150,00), dólar (1,500.00) e simples (150.00). O ponto de um CPF ("123.456.789.01") NÃO é valor:
// o valor simples não pode ter dígito nem ponto/vírgula colados antes ou depois.
const DATAS = /(?<!\d)\d{1,2}[/-]\d{1,2}[/-]\d{4}(?!\d)|(?<!\d)\d{1,2}\/\d{1,2}\/\d{2}(?!\d)/g;
const VALORES = /(?<![\d.,])(?:\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+[.,]\d{2})(?![\d]|[.,]\d)/g;

/**
 * CPF, CNPJ ou telefone no texto? Datas ("26/11/2026") e valores em dinheiro ("150.00", "1.500,00") são tirados ANTES de olhar, porque somados davam 11 dígitos e a descrição
 * "Avaliação 26/11/2026 - 150.00" era recusada como CPF. Depois vale a regra de sempre (`temDigitosSeguidos`: 11 dígitos ou mais com até 3 separadores entre eles, o que pega
 * "CPF 123456789-01", "123 456 789 01", "123.456.789.01" e "CNPJ 12345678/0001-90") e o telefone com DDD.
 */
export function temDadoPessoal(texto: string): boolean {
  const t = texto.replace(DATAS, SEM_DATA_NEM_VALOR).replace(VALORES, SEM_DATA_NEM_VALOR);
  return temDigitosSeguidos(t, 11) || TELEFONE.test(t);
}

export function descricaoLimpa(bruto: string): string {
  const t = bruto.replace(/\s+/g, ' ').trim();
  if (t.length < 3) throw new ErroDeEntrada('a descrição precisa ter ao menos 3 caracteres (é o que o paciente lê na tela de pagamento)');
  if (t.length > LIMITES_INFINITEPAY.descricaoMax) throw new ErroDeEntrada(`a descrição passa de ${LIMITES_INFINITEPAY.descricaoMax} caracteres`);
  // CPF/CNPJ (11 dígitos ou mais seguidos, mesmo com ponto e traço) ou telefone com DDD; datas como "12/11/2026 15h" passam. A mensagem NÃO repete o texto: ele pode ser justamente a chave ou o CPF.
  if (temDadoPessoal(t) || /@/.test(t) || /https?:\/\//i.test(t) || /inchk_/i.test(t)) {
    throw new ErroDeEntrada('a descrição não pode ter CPF, telefone, e-mail, endereço de site nem chave (apareceria para quem abre o link). Tire esse trecho e tente de novo; nada foi criado.');
  }
  return t;
}

function valorEmCentavos(valor: number): number {
  if (!Number.isFinite(valor)) throw new ErroDeEntrada('valor inválido');
  const c = Math.round(valor * 100);
  if (Math.abs(c - valor * 100) > 1e-6) throw new ErroDeEntrada('o valor tem no máximo 2 casas decimais (centavos)');
  if (valor < LIMITES_INFINITEPAY.valorMinimo) throw new ErroDeEntrada(`a InfinitePay não aceita pagamento abaixo de ${dinheiro(LIMITES_INFINITEPAY.valorMinimo)}`);
  return c;
}

/** Fim do dia (Brasília, UTC-3 fixo) daqui a N dias, em ISO 8601 com fuso. */
export function validoAteDe(agora: number, dias: number): { iso: string; data: Date } {
  const dia = diaLocal(agora + dias * 86_400_000, FUSO_PADRAO);
  const data = new Date(`${dia}T23:59:59-03:00`);
  return { iso: `${dia}T23:59:59-03:00`, data };
}

export function chaveDeDuplicata(unidade: string, valorCentavos: number, descricao: string): string {
  return createHash('sha256').update([unidade, valorCentavos, descricao.trim().toLowerCase()].join('|')).digest('hex').slice(0, 32);
}

const referenciaNova = (agora: number) => `dd-${diaLocal(agora).replace(/-/g, '')}-${randomBytes(5).toString('hex')}`;

// ----------------------------------------------------------------- criar link

function verificar(esc: EstadoEscritaInfinitepay, livro: LivroDeLinks, o: { valor: number; chave: string }): void {
  const t = esc.agora();
  const igual = livro.igual(o.chave, t, LIMITES_INFINITEPAY.duplicataMs);
  if (igual) {
    throw new ErroDeEntrada(
      `link igual (mesmo valor e descrição) feito há menos de 10 minutos: ${igual.orderNsu}${igual.url ? ` — ${igual.url}` : ''}. Não criei outro. Se for de propósito, mude a descrição ou espere 10 minutos.`,
    );
  }
  if (esc.porHora() <= 0) throw new ErroDeEntrada('a criação de link pelo conector está DESLIGADA: configure INFINITEPAY_LINKS_POR_HORA com o limite por hora (maior que 0)');
  const naHora = livro.naHora(t, LIMITES_INFINITEPAY.horaMs);
  if (naHora >= esc.porHora()) throw new ErroDeEntrada(`limite de ${esc.porHora()} links por hora nesta unidade já foi atingido (${naHora}); tente mais tarde ou crie no app da InfinitePay`);
  const tetoLink = esc.tetoLink();
  if (o.valor > tetoLink) throw new ErroDeEntrada(`o valor ${dinheiro(o.valor)} passa do teto por link (${dinheiro(tetoLink)}). Só o João sobe o teto, no servidor (INFINITEPAY_TETO_OPERACAO_REAIS). Nada foi criado.`);
  const usado = livro.somaDoDia(t);
  const tetoDia = esc.tetoDia();
  if (arredondar(usado + o.valor) > tetoDia) {
    throw new ErroDeEntrada(`passaria do teto do dia desta unidade (${dinheiro(tetoDia)}; já usado hoje ${dinheiro(usado)}; este link ${dinheiro(o.valor)}). Só o João sobe o teto, no servidor (INFINITEPAY_TETO_DIA_REAIS). Nada foi criado.`);
  }
}

export async function consumoDoDiaInfinitepay(esc: EstadoEscritaInfinitepay, unidade: string) {
  const agora = esc.agora();
  const livro = await esc.armazem.ler(unidade, agora);
  const usado = livro.somaDoDia(agora);
  return {
    tetoPorLink: dinheiro(esc.tetoLink()),
    tetoDoDia: dinheiro(esc.tetoDia()),
    usadoHoje: dinheiro(usado),
    restanteHoje: dinheiro(Math.max(0, arredondar(esc.tetoDia() - usado))),
    linksPorHora: esc.porHora(),
    linksNaUltimaHora: livro.naHora(agora, LIMITES_INFINITEPAY.horaMs),
  };
}

async function umPorVez<T>(esc: EstadoEscritaInfinitepay, unidade: string, fn: () => Promise<T>): Promise<T> {
  const anterior = esc.filas.get(unidade) ?? Promise.resolve();
  const minha = anterior.catch(() => undefined).then(fn);
  const cauda = minha.catch(() => undefined);
  esc.filas.set(unidade, cauda);
  try {
    return await minha;
  } finally {
    if (esc.filas.get(unidade) === cauda) esc.filas.delete(unidade);
  }
}

export interface ArgsCriarLink {
  unidade?: string;
  valor: number;
  descricao: string;
  /** a sua referência do pedido; vira o order_nsu (única por unidade). Sem ela o conector gera uma */
  referencia?: string;
  validadeDias?: number;
  /** false = só cartão (o cartão não dá para desligar) */
  pix?: boolean;
  /** até quantas parcelas a CLÍNICA absorve a taxa (0 a 12; padrão 0: quem parcela paga a taxa do parcelamento) */
  parcelasSemTaxa?: number;
}

export async function criarLink(ctx: ContextoInfinitepay, esc: EstadoEscritaInfinitepay, quem: QuemInfinitepay, a: ArgsCriarLink) {
  const conta = resolverContaInfinitepay(ctx, a.unidade);
  if (!esc.unidades().has(conta.slug)) {
    throw new ErroDeEntrada(`a criação de link da InfinitePay não está ligada na unidade ${conta.slug} (INFINITEPAY_ESCRITA_UNIDADES no servidor; só o João liga). Nada foi criado.`);
  }
  if (!conta.fonte.criarLink) throw new ErroDeEntrada('esta conta não tem a criação de link configurada');
  const criar = conta.fonte.criarLink;
  const descricao = descricaoLimpa(a.descricao);
  const centavos = valorEmCentavos(a.valor);
  const valor = centavos / 100;
  const dias = a.validadeDias ?? LIMITES_INFINITEPAY.validadePadraoDias;
  if (!Number.isInteger(dias) || dias < 1 || dias > LIMITES_INFINITEPAY.validadeMaxDias) throw new ErroDeEntrada(`validadeDias vai de 1 a ${LIMITES_INFINITEPAY.validadeMaxDias} (a API não cancela link, então ele precisa vencer)`);
  const parcelas = a.parcelasSemTaxa ?? 0;
  if (!Number.isInteger(parcelas) || parcelas < 0 || parcelas > 12) throw new ErroDeEntrada('parcelasSemTaxa vai de 0 a 12');
  if (a.referencia !== undefined && !REFERENCIA.test(a.referencia.trim())) throw new ErroDeEntrada('referencia: use letras, números, "-" e "_" (até 60), sem espaço');
  // a referência vai no endereço do aviso (log do proxy), no Telegram e no painel da InfinitePay: nada de CPF ou telefone
  if (a.referencia !== undefined && temDigitosSeguidos(a.referencia, 10)) throw new ErroDeEntrada('referencia: não use CPF, telefone ou outro número longo (10 dígitos seguidos ou mais); ela aparece em avisos e no painel da InfinitePay');
  const agora = esc.agora();
  const orderNsu = a.referencia?.trim() || referenciaNova(agora);
  const chave = chaveDeDuplicata(conta.slug, centavos, descricao);
  const { iso: validoAte, data: validoAteData } = validoAteDe(agora, dias);
  const criadoPor = quem.email || `usuario:${quem.id}`;

  return umPorVez(esc, conta.slug, async () => {
    // a reserva que vale: dentro da trava da unidade, relê o banco, confere tudo e grava a INTENÇÃO antes de qualquer chamada à InfinitePay
    await esc.armazem.reservar({
      unidade: conta.slug, orderNsu, chave, valorCentavos: centavos, descricao, validoAte: validoAteData, criadoPor, agora,
      conferir: (livro) => verificar(esc, livro, { valor, chave }),
    });
    const webhookUrl = esc.urlDoWebhook?.(conta.slug, orderNsu);
    const pedido: PedidoDeLink = {
      orderNsu,
      itens: [{ quantidade: 1, precoCentavos: centavos, descricao }],
      ...(webhookUrl ? { webhookUrl } : {}),
      validoAte,
      pagamentoUnico: true,
      pix: a.pix !== false,
      parcelasSemTaxa: parcelas,
    };
    let url: string;
    let invoiceSlug: string | undefined;
    try {
      const r = await criar(pedido);
      url = r.url;
      invoiceSlug = r.slug;
    } catch (e) {
      const status = e instanceof ErroInfinitepay ? e.status : null;
      const msg = e instanceof Error ? e.message : String(e);
      // 400/401/403/404/422/429: a InfinitePay recusou (ou mandou esperar) e o link não existe. Qualquer outra coisa (timeout, 5xx, resposta sem URL) deixa dúvida.
      const recusa = status !== null && [400, 401, 403, 404, 422, 429].includes(status);
      await esc.armazem.resolver(conta.slug, orderNsu, recusa ? { status: 'falhou', erro: msg.slice(0, 300) } : { status: 'intencao', erro: msg.slice(0, 300) }).catch(() => undefined);
      if (!recusa) {
        void esc.alertar(`⚠️ InfinitePay (${conta.nome}): criei o link ${orderNsu} de ${dinheiro(valor)} e a resposta não veio clara (${msg.slice(0, 120)}). Ele PODE existir. Confira no app antes de repetir.`).catch(() => false);
        throw new ErroDeEntrada(`${msg} Referência ${orderNsu} (${dinheiro(valor)}): o link pode ter sido criado; confira no app da InfinitePay antes de repetir.`);
      }
      throw new ErroDeEntrada(`${msg} Nada foi criado.`);
    }
    // o link JÁ existe na InfinitePay: se o banco falhar ao anotar a URL, a URL não pode se perder (vai no aviso do João e na resposta)
    const anotou = await esc.armazem.resolver(conta.slug, orderNsu, { status: 'criado', url, ...(invoiceSlug ? { invoiceSlug } : {}) }).then(() => true, () => false);
    if (!anotou) void esc.alertar(`⚠️ InfinitePay (${conta.nome}): criei o link ${orderNsu} de ${dinheiro(valor)} mas o banco não anotou a URL: ${url}. Ele conta no teto como intenção.`).catch(() => false);
    if (valor > esc.tetoLink() / 2) {
      void esc.alertar(`🔗 InfinitePay (${conta.nome}): link de ${dinheiro(valor)} criado por ${criadoPor} (acima de 50% do teto de ${dinheiro(esc.tetoLink())}). Ref ${orderNsu}.`).catch(() => false);
    }
    const consumo = await consumoDoDiaInfinitepay(esc, conta.slug).catch(() => ({ indisponivel: 'não consegui ler os limites agora; o link JÁ foi criado.' }));
    return {
      unidade: conta.slug,
      criado: true,
      url,
      orderNsu,
      valor: reais(centavos),
      descricao,
      validoAte,
      pagamentoUnico: true,
      formas: a.pix === false ? ['cartão'] : ['cartão', 'Pix'],
      parcelasSemTaxaParaAClinica: parcelas,
      avisoAutomatico: webhookUrl ? 'a InfinitePay avisa o conector quando pagar; veja o status em infinitepay_links' : 'sem aviso automático de pagamento (o conector não tem endereço público configurado); confira no app',
      aviso: 'A InfinitePay não deixa cancelar link pela API: este vale até a data acima (ou até o primeiro pagamento). Para estornar um pagamento, só pelo app ou pela Conta Web da InfinitePay.',
      ...(anotou ? {} : { atencao: 'O link foi criado, mas NÃO consegui anotar a URL no banco (infinitepay_links vai mostrá-lo sem URL, como intencao). Guarde esta URL; o João foi avisado.' }),
      consumoDoDia: consumo,
    };
  });
}

// ----------------------------------------------------------------- registro

/** Só vê a ferramenta quem escreve, e só se alguma unidade tem a criação ligada: fora disso ela nem existe na sessão (e a função recusa de novo ao chamar). */
export function registrarEscritaInfinitepaySePermitido(
  server: McpServer,
  ctx: ContextoInfinitepay,
  esc: EstadoEscritaInfinitepay,
  usuario: string,
  escritores: ReadonlySet<string>,
  auditar: Auditar,
  quem: { email?: string; clientId?: string } = {},
): boolean {
  if (!escritores.has(usuario)) return false;
  if (esc.unidades().size === 0) return false;
  const eles: QuemInfinitepay = { id: usuario, ...(quem.email ? { email: quem.email } : {}), ...(quem.clientId ? { clientId: quem.clientId } : {}) };
  registrarEscritaInfinitepay(server, ctx, esc, eles, auditar);
  return true;
}

/** A auditoria guarda os argumentos como vieram: texto livre (descrição, referência) pode trazer a chave ou um CPF colado por engano, então passa por limpeza antes. */
export function auditarSemSegredo(auditar: Auditar): Auditar {
  const limpa = (v: unknown): unknown => (typeof v === 'string' ? temDadoPessoal(v) || /@/.test(v) ? '[removido: continha número longo ou e-mail]' : tirarChave(v) : v);
  return (r) => {
    const a = r.argumentos && typeof r.argumentos === 'object' ? Object.fromEntries(Object.entries(r.argumentos as Record<string, unknown>).map(([k, v]) => [k, limpa(v)])) : r.argumentos;
    auditar({ ...r, argumentos: a, ...(r.erro ? { erro: tirarChave(r.erro) } : {}) });
  };
}

export function registrarEscritaInfinitepay(server: McpServer, ctx: ContextoInfinitepay, esc: EstadoEscritaInfinitepay, quem: QuemInfinitepay, auditarBruto: Auditar): void {
  const auditar = auditarSemSegredo(auditarBruto);
  server.registerTool(
    'infinitepay_criar_link',
    {
      title: 'Criar link de pagamento (InfinitePay)',
      description:
        'Cria um LINK DE PAGAMENTO (checkout com Pix e cartão em até 12x) na InfinitePay de UMA unidade, DIRETO, sem passo de confirmação: confira valor e ' +
        'descrição com a pessoa ANTES de chamar. Só existe nas unidades que o João ligou. O link nasce com pagamento ÚNICO e validade (padrão 7 dias, ' +
        'até 90), porque a API da InfinitePay NÃO cancela link nem estorna pagamento (isso é só pelo app). Mínimo R$ 1,00. Travas automáticas: teto por ' +
        'link (padrão R$ 5.000) e por dia e unidade (padrão R$ 20.000), links por hora, link igual em 10 minutos recusado, aviso no Telegram do João. ' +
        'A descrição aparece para quem abre o link: sem CPF, telefone nem e-mail. Devolve a URL para mandar ao paciente. O pagamento é avisado ao ' +
        'conector pelo webhook da InfinitePay; veja em infinitepay_links.',
      inputSchema: {
        unidade: z.string().optional().describe('unidade com InfinitePay e criação ligada (slug ou nome curto); opcional se só houver uma'),
        valor: z.number().min(1).max(1_000_000).describe('valor em reais (ex.: 150 ou 150.50), no máximo 2 casas'),
        descricao: z.string().min(3).max(LIMITES_INFINITEPAY.descricaoMax).describe('o que está sendo cobrado (aparece na tela de pagamento); sem CPF, telefone, e-mail ou site'),
        referencia: z.string().optional().describe('a sua referência do pedido (letras, números, - e _); vira o order_nsu e é única por unidade. Sem ela o conector gera uma'),
        validadeDias: z.number().int().min(1).max(LIMITES_INFINITEPAY.validadeMaxDias).optional().describe('dias de validade do link (padrão 7)'),
        pix: z.boolean().optional().describe('false = só cartão (o cartão não dá para desligar); padrão: Pix e cartão'),
        parcelasSemTaxa: z.number().int().min(0).max(12).optional().describe('até quantas parcelas a CLÍNICA absorve a taxa (0 a 12; padrão 0: quem parcela paga a taxa do parcelamento)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => executar('infinitepay_criar_link', args, auditar, () => criarLink(ctx, esc, quem, args as ArgsCriarLink)),
  );
}

export type { ContaInfinitepay };
