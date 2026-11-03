/**
 * As travas AUTOMÁTICAS da escrita do Asaas (nenhuma pede confirmação de ninguém):
 *   - teto por operação e teto por dia e conta (soma de cobranças criadas + estornos + transferências), no fuso da clínica;
 *   - lista de destinos permitidos para transferência (ASAAS_TRANSFERENCIA_DESTINOS), por conta;
 *   - o livro das operações recentes, lido da auditoria (banco) na primeira vez e mantido em memória depois.
 *
 * Fail-closed: teto vazio, 0 ou lixo = o PADRÃO (nunca "sem limite"); destinos ausentes, vazios ou ilegíveis = transferência
 * DESLIGADA. O destino só é aceito se bater EXATAMENTE (chave Pix ou conta) com um da lista; o que vai para o Asaas é o que está
 * na lista, nunca o que veio do chat. Não existe caminho para cadastrar destino pelo chat.
 */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { cnpjValido, cpfValido } from '../lib/integracoes/mascaras.js';

export const EVENTO_COBRANCA = 'asaas_cobranca_gravada';
export const EVENTO_CLIENTE = 'asaas_cliente_gravado';
/** estorno, transferência, cancelamento, edição: um evento só, com `operacao` e `noTeto` (quanto conta para o teto do dia) */
export const EVENTO_OPERACAO = 'asaas_operacao_gravada';

export const FUSO_PADRAO = 'America/Sao_Paulo';
export const PADRAO_TETOS = { operacaoReais: 5000, diaReais: 20000 };
export const JANELA_LIVRO_MS = 36 * 3_600_000;

const positivo = (bruto: string | undefined): number | null => {
  const t = bruto?.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * ASAAS_TETO_OPERACAO_REAIS (padrão 5000). Vazio, 0, negativo ou texto = o padrão, nunca "ilimitado". O nome antigo
 * (ASAAS_COBRANCA_MAX_REAIS) continua valendo como segunda opção, para o teto não subir sozinho: valor bom manda; 0 ou lixo nele
 * mantém o significado antigo (DESLIGADO) até a variável ser apagada ou trocada pela nova.
 */
export function tetoPorOperacao(e: NodeJS.ProcessEnv = process.env): number {
  const novo = positivo(e.ASAAS_TETO_OPERACAO_REAIS);
  if (novo !== null) return novo;
  const antigo = e.ASAAS_COBRANCA_MAX_REAIS?.trim();
  if (antigo) {
    // o nome antigo valia 0 = geração de boleto DESLIGADA: quem deixou 0 (ou lixo) lá continua com tudo recusado até trocar pelo nome novo
    return positivo(antigo) ?? 0;
  }
  return PADRAO_TETOS.operacaoReais;
}

/** ASAAS_TETO_DIA_REAIS (padrão 20000): cobranças criadas + estornos + transferências, por conta e por dia no fuso da clínica. */
export function tetoPorDia(e: NodeJS.ProcessEnv = process.env): number {
  return positivo(e.ASAAS_TETO_DIA_REAIS) ?? PADRAO_TETOS.diaReais;
}

// ----------------------------------------------------------------- dinheiro e dia

export const dinheiro = (n: number) => `R$ ${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
const centavos = (n: number) => Math.round(n * 100);

/** O dia civil (AAAA-MM-DD) de um instante, no fuso da clínica. */
const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatadorDoDia(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    const monta = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    try {
      f = monta(fuso);
    } catch {
      f = monta(FUSO_PADRAO);
    }
    formatadores.set(fuso, f);
  }
  return f;
}

export function diaLocal(ms: number, fuso: string = FUSO_PADRAO): string {
  return formatadorDoDia(fuso).format(new Date(ms));
}

// ----------------------------------------------------------------- o livro

export type TipoDeLancamento = 'cobranca' | 'estorno' | 'transferencia' | 'edicao';

export interface Lancamento {
  conta: string;
  tipo: TipoDeLancamento;
  /** valor da operação em reais */
  valor: number;
  /** quanto conta para o teto do dia (cobrança: o valor; estorno e transferência: o valor; edição: só o acréscimo; cancelar: 0) */
  noTeto: number;
  em: number;
  /** hash para achar operação igual feita há pouco */
  chave?: string;
  id?: string;
}

/**
 * O que foi feito nas últimas 36 h, por conta. A primeira operação de uma conta lê a auditoria (para o teto do dia e a duplicata
 * sobreviverem a um reinício); depois disso cada operação entra aqui ANTES de ir ao Asaas (resposta perdida não libera a seguinte).
 * Um processo só: duas instâncias do servidor não dividem este livro (a auditoria é relida só na subida).
 */
export class Livro {
  private itens: Lancamento[] = [];
  private lidos = new Map<string, Promise<void>>();
  constructor(private historico?: (conta: string) => Promise<Lancamento[]>) {}

  async carregar(conta: string): Promise<void> {
    if (!this.historico) return;
    let p = this.lidos.get(conta);
    if (!p) {
      // `Promise.resolve().then` pega também o erro que o leitor lance de forma síncrona
      p = Promise.resolve().then(() => this.historico!(conta)).then((rs) => {
        this.itens.push(...rs);
      });
      this.lidos.set(conta, p);
    }
    try {
      await p;
    } catch {
      this.lidos.delete(conta);
      throw new ErroDeEntrada('não consegui conferir as operações recentes desta conta (tetos e duplicata) — nada foi gravado; tente em instantes');
    }
  }

  lancar(l: Lancamento): Lancamento {
    this.itens.push(l);
    return l;
  }

  soltar(l: Lancamento): void {
    this.itens = this.itens.filter((x) => x !== l);
  }

  podar(agora: number): void {
    this.itens = this.itens.filter((x) => agora - x.em < JANELA_LIVRO_MS);
  }

  /** Quanto já conta para o teto do dia desta conta, no fuso dela. */
  somaDoDia(conta: string, agora: number, fuso: string): number {
    const hoje = diaLocal(agora, fuso);
    const cents = this.itens.filter((x) => x.conta === conta && diaLocal(x.em, fuso) === hoje).reduce((s, x) => s + centavos(x.noTeto), 0);
    return cents / 100;
  }

  cobrancasNaHora(conta: string, agora: number, horaMs: number): number {
    return this.itens.filter((x) => x.conta === conta && x.tipo === 'cobranca' && agora - x.em < horaMs).length;
  }

  igual(conta: string, chave: string, agora: number, janelaMs: number): Lancamento | undefined {
    return this.itens.find((x) => x.conta === conta && x.chave === chave && agora - x.em < janelaMs);
  }
}

/** Recusa a operação que passa do teto por operação ou do teto do dia. `noTeto` é o que ela soma ao dia. */
export function conferirTetos(o: { livro: Livro; conta: string; fuso: string; agora: number; valor: number; noTeto: number; tetoOperacao: number; tetoDia: number; o: string }): void {
  if (o.tetoOperacao <= 0) {
    throw new ErroDeEntrada('o dinheiro pelo conector está DESLIGADO nesta conta: ASAAS_COBRANCA_MAX_REAIS (nome antigo) está em 0 ou inválido. Apague a variável ou use ASAAS_TETO_OPERACAO_REAIS com o teto por operação. Nada foi feito.');
  }
  if (o.valor > o.tetoOperacao) {
    throw new ErroDeEntrada(
      `${dinheiro(o.valor)} passa do teto de ${dinheiro(o.tetoOperacao)} por operação (${o.o}): faça esta no painel do Asaas. Para subir o teto, o João muda ASAAS_TETO_OPERACAO_REAIS no servidor. Nada foi feito.`,
    );
  }
  const hoje = o.livro.somaDoDia(o.conta, o.agora, o.fuso);
  if (centavos(hoje) + centavos(o.noTeto) > centavos(o.tetoDia)) {
    throw new ErroDeEntrada(
      `passa do teto do dia desta conta: já foram ${dinheiro(hoje)} hoje (cobranças criadas + estornos + transferências) e esta soma ${dinheiro(o.noTeto)}, para um teto de ${dinheiro(o.tetoDia)}. ` +
        'Tente amanhã, faça no painel do Asaas, ou o João sobe ASAAS_TETO_DIA_REAIS no servidor. Nada foi feito.',
    );
  }
}

// ----------------------------------------------------------------- destinos de transferência

export type TipoChavePix = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
const TIPOS_CHAVE: readonly TipoChavePix[] = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'];

export interface DestinoPix {
  via: 'pix';
  apelido: string;
  nome: string;
  tipoChave: TipoChavePix;
  /** a chave como o Asaas a recebe (documento só com dígitos, e-mail em minúsculas, telefone com +55) */
  chave: string;
}

export interface DestinoConta {
  via: 'conta';
  apelido: string;
  nome: string;
  banco: string;
  agencia: string;
  conta: string;
  digito: string;
  tipoConta: 'CONTA_CORRENTE' | 'CONTA_POUPANCA';
  titular: string;
  documento: string;
  nascimento?: string;
}

export type Destino = DestinoPix | DestinoConta;

export const soDigitos = (s: string) => s.replace(/\D/g, '');

export function mascararDoc(d: string): string {
  const x = soDigitos(d);
  // só os 3 últimos dígitos-base: dá para conferir com o paciente, não dá para reconstruir o documento
  if (x.length === 11) return `***.***.${x.slice(6, 9)}-**`;
  if (x.length === 14) return `**.***.${x.slice(5, 8)}/${x.slice(8, 12)}-**`;
  return '***';
}

export function mascararEmail(e: string): string {
  const [u = '', dom = ''] = e.split('@');
  return `${u.slice(0, 1)}***@${dom}`;
}
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** A chave Pix no formato canônico do tipo, ou null se não for uma chave válida desse tipo. */
export function normalizarChave(tipo: TipoChavePix, bruto: string): string | null {
  const t = String(bruto ?? '').trim();
  if (!t) return null;
  // só o formato do próprio tipo: texto com sobra (outra frase, outra chave junto) não vira a chave por ter dígitos no meio
  if ((tipo === 'CPF' || tipo === 'CNPJ') && !/^[\d.\-/\s]+$/.test(t)) return null;
  if (tipo === 'PHONE' && !/^[\d+\-()\s]+$/.test(t)) return null;
  if (tipo === 'CPF') {
    const d = soDigitos(t);
    return d.length === 11 && cpfValido(d) ? d : null;
  }
  if (tipo === 'CNPJ') {
    const d = soDigitos(t);
    return d.length === 14 && cnpjValido(d) ? d : null;
  }
  if (tipo === 'EMAIL') return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) ? t.toLowerCase() : null;
  if (tipo === 'PHONE') {
    let d = soDigitos(t);
    if (d.length === 10 || d.length === 11) d = `55${d}`;
    return (d.length === 12 || d.length === 13) && d.startsWith('55') ? `+${d}` : null;
  }
  if (!UUID.test(t)) return null;
  const h = t.toLowerCase().replace(/-/g, '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function mascararChavePix(tipo: TipoChavePix, chave: string): string {
  if (tipo === 'CPF' || tipo === 'CNPJ') return mascararDoc(chave);
  if (tipo === 'EMAIL') return mascararEmail(chave);
  if (tipo === 'PHONE') return `+55 (${chave.slice(3, 5)}) *****-${chave.slice(-4)}`;
  return `${chave.slice(0, 8)}…`;
}

export function mostrarDestino(d: Destino) {
  return d.via === 'pix'
    ? { apelido: d.apelido, nome: d.nome, via: 'Pix', tipoDaChave: d.tipoChave, chave: mascararChavePix(d.tipoChave, d.chave) }
    : { apelido: d.apelido, nome: d.nome, via: 'conta bancária', banco: d.banco, agencia: d.agencia, conta: `***${d.conta.slice(-2)}${d.digito ? `-${d.digito}` : ''}`, titular: d.titular };
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface DestinosLidos {
  /** a transferência está LIGADA nesta conta (há ao menos um destino válido) */
  ligada: boolean;
  destinos: Destino[];
  /** entradas ignoradas e por quê (sem o conteúdo da chave) */
  problemas: string[];
}

const texto = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/**
 * ASAAS_TRANSFERENCIA_DESTINOS = JSON `{ "<slug da clínica>": [ { nome, apelido?, chave_pix, tipo_chave } | { nome, apelido?, banco, agencia, conta, conta_digito?, tipo_conta?, titular, documento, nascimento? } ] }`.
 * Ausente, vazio, JSON quebrado ou sem entrada válida para a clínica = transferência DESLIGADA nela.
 */
export function lerDestinos(slug: string, e: NodeJS.ProcessEnv = process.env): DestinosLidos {
  const vazio = (p: string[] = []): DestinosLidos => ({ ligada: false, destinos: [], problemas: p });
  const bruto = e.ASAAS_TRANSFERENCIA_DESTINOS?.trim();
  if (!bruto) return vazio();
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch {
    return vazio(['ASAAS_TRANSFERENCIA_DESTINOS não é um JSON válido: transferência desligada']);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return vazio(['ASAAS_TRANSFERENCIA_DESTINOS precisa ser um objeto { "slug-da-clinica": [destinos] }']);
  const alvo = slug.trim().toLowerCase();
  const chave = Object.keys(obj).find((k) => k.trim().toLowerCase() === alvo);
  const lista = chave ? (obj as Record<string, unknown>)[chave] : undefined;
  if (!Array.isArray(lista)) return vazio();
  const destinos: Destino[] = [];
  const problemas: string[] = [];
  const vistos = new Set<string>();
  lista.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const nome = texto(r.nome);
    const apelido = texto(r.apelido) || nome;
    const falha = (m: string) => problemas.push(`destino #${i + 1}: ${m} (ignorado)`);
    if (!nome || nome.length > 120) return falha('nome obrigatório (até 120 caracteres)');
    let d: Destino;
    if (texto(r.chave_pix)) {
      const tipo = texto(r.tipo_chave).toUpperCase() as TipoChavePix;
      if (!TIPOS_CHAVE.includes(tipo)) return falha(`tipo_chave precisa ser ${TIPOS_CHAVE.join(', ')}`);
      const norm = normalizarChave(tipo, texto(r.chave_pix));
      if (!norm) return falha(`chave_pix não é uma chave ${tipo} válida`);
      d = { via: 'pix', apelido, nome, tipoChave: tipo, chave: norm };
    } else if (texto(r.banco) || texto(r.conta)) {
      const doc = soDigitos(texto(r.documento));
      const docOk = (doc.length === 11 && cpfValido(doc)) || (doc.length === 14 && cnpjValido(doc));
      const banco = soDigitos(texto(r.banco));
      const agencia = soDigitos(texto(r.agencia));
      const conta = soDigitos(texto(r.conta));
      const titular = texto(r.titular);
      if (!/^\d{1,4}$/.test(banco) || !/^\d{1,6}$/.test(agencia) || !/^\d{1,12}$/.test(conta)) return falha('banco, agencia e conta precisam ser números');
      if (!docOk || !titular) return falha('titular e documento (CPF/CNPJ válido) do titular são obrigatórios');
      const nascimento = texto(r.nascimento);
      if (nascimento && !/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return falha('nascimento no formato AAAA-MM-DD');
      const poupanca = /poup/i.test(texto(r.tipo_conta));
      d = { via: 'conta', apelido, nome, banco, agencia, conta, digito: soDigitos(texto(r.conta_digito)), tipoConta: poupanca ? 'CONTA_POUPANCA' : 'CONTA_CORRENTE', titular, documento: doc, ...(nascimento ? { nascimento } : {}) };
    } else {
      return falha('informe chave_pix + tipo_chave, ou banco + agencia + conta');
    }
    const id = d.via === 'pix' ? `pix|${d.chave}` : `conta|${d.banco}|${d.agencia}|${d.conta}|${d.digito}`;
    if (vistos.has(id)) return falha('repetido');
    if (destinos.some((x) => semAcento(x.apelido) === semAcento(d.apelido))) return falha('apelido repetido');
    vistos.add(id);
    destinos.push(d);
  });
  return { ligada: destinos.length > 0, destinos, problemas };
}

export function textoSemDestinos(slug: string): string {
  return (
    `a transferência está DESLIGADA para ${slug}: não há destino permitido cadastrado. O destino só entra pela configuração do servidor ` +
    '(o João coloca em ASAAS_TRANSFERENCIA_DESTINOS, por clínica: nome, apelido e a chave Pix com o tipo, ou banco/agência/conta do titular); não dá para cadastrar pelo chat. Nada foi feito.'
  );
}

export interface PedidoDeDestino {
  destino?: string;
  contaBancaria?: { banco?: string; agencia?: string; conta?: string; digito?: string };
}

/** Acha o destino na lista pelo que foi pedido: chave Pix EXATA, conta EXATA ou o apelido. Zero ou mais de um = recusa. */
export function acharDestino(destinos: Destino[], p: PedidoDeDestino): Destino {
  const apelidos = destinos.map((d) => d.apelido).join(', ');
  const naoAchou = () =>
    new ErroDeEntrada(`esse destino não está na lista permitida desta conta. Destinos permitidos: ${apelidos}. Destino novo só entra pela configuração do servidor (ASAAS_TRANSFERENCIA_DESTINOS), nunca pelo chat. Nada foi feito.`);
  const temConta = !!p.contaBancaria && Object.values(p.contaBancaria).some((v) => String(v ?? '').trim());
  const temDestino = !!p.destino?.trim();
  if (temConta === temDestino) throw new ErroDeEntrada('informe o destino por "destino" (chave Pix ou apelido) OU por "contaBancaria", um dos dois');
  let achados: Destino[];
  if (temConta) {
    const cb = p.contaBancaria!;
    const [banco, agencia, conta, digito] = [cb.banco, cb.agencia, cb.conta, cb.digito].map((v) => soDigitos(String(v ?? '')));
    achados = destinos.filter((d): d is DestinoConta => d.via === 'conta' && d.banco === banco && d.agencia === agencia && d.conta === conta && d.digito === (digito ?? ''));
  } else {
    const s = p.destino!.trim();
    achados = destinos.filter((d) => semAcento(d.apelido) === semAcento(s) || (d.via === 'pix' && normalizarChave(d.tipoChave, s) === d.chave));
  }
  if (achados.length === 0) throw naoAchou();
  if (achados.length > 1) throw new ErroDeEntrada('o pedido bate com mais de um destino da lista: seja mais específico (chave Pix inteira). Nada foi feito.');
  return achados[0]!;
}

/** Identidade do destino para o hash de duplicata. */
export function identidadeDoDestino(d: Destino): string {
  return d.via === 'pix' ? `pix:${d.chave}` : `conta:${d.banco}/${d.agencia}/${d.conta}-${d.digito}`;
}

// ----------------------------------------------------------------- aviso no Telegram

export interface DadosDoAviso {
  titulo: string;
  conta: string;
  nomeDaConta?: string | null;
  quem: { id: string; email?: string };
  valor?: number;
  destino?: string;
  id?: string;
  detalhe?: string;
}

export function textoDoAviso(a: DadosDoAviso): string {
  return [
    `Asaas · ${a.titulo}`,
    `Conta: ${a.conta}${a.nomeDaConta ? ` (${a.nomeDaConta})` : ''}`,
    ...(a.valor !== undefined ? [`Valor: ${dinheiro(a.valor)}`] : []),
    `Quem pediu: ${a.quem.email ? `${a.quem.email} ` : ''}(usuário ${a.quem.id})`,
    ...(a.destino ? [`Destino: ${a.destino}`] : []),
    ...(a.id ? [`Id no Asaas: ${a.id}`] : []),
    ...(a.detalhe ? [a.detalhe] : []),
  ].join('\n');
}
