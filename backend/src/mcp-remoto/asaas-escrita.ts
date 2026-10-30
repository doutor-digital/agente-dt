/**
 * Asaas com escrita pelo claude.ai — DUAS ações só, para quem está em MCP_ESCRITA_EMAILS, sempre em DOIS passos:
 *   1. cadastrar cliente  (asaas_preparar_cliente  → asaas_confirmar_cliente)
 *   2. gerar BOLETO       (asaas_preparar_cobranca → asaas_confirmar_cobranca)
 * O `*_preparar` não grava nada: mostra a conta (nome e final da chave), o que vai acontecer e devolve um código de
 * 15 minutos, de uso único, preso a quem pediu. O `*_confirmar` com o código grava. Sem código, nada muda.
 *
 * NÃO existe aqui (e o cliente HTTP de escrita nem tem como): cancelar, excluir ou estornar cobrança, editar valor ou
 * vencimento, Pix, cartão, parcelamento, assinatura, transferência, saque, antecipação, alterar ou excluir cliente.
 *
 * LIGAR/DESLIGAR (falha fechada): a escrita nasce DESLIGADA. ASAAS_ESCRITA_UNIDADES = slugs separados por vírgula das unidades em que
 * ela vale (ex. "doutor-hernia-serra,doutor-hernia-maraba"); vazia ou ausente = desligada em todas; "*" e "todas" NÃO valem como
 * curinga. ASAAS_COBRANCA_MAX_REAIS=0 ou ASAAS_COBRANCAS_POR_HORA=0 (ou valor que não é número) = boleto DESLIGADO, nunca "sem limite".
 * Só quem está em MCP_ESCRITA_EMAILS vê as ferramentas. O cliente HTTP só aceita POST em /customers e /payments.
 *
 * Dinheiro de verdade, paciente de verdade. Travas: UMA conta por vez ("todas" é recusado); teto por cobrança
 * (ASAAS_COBRANCA_MAX_REAIS, padrão 5000) e por hora e conta (ASAAS_COBRANCAS_POR_HORA, padrão 20); vencimento de hoje até o limite de dias
 * (LIMITES_ASAAS.maxDiasVencimento, a fonte única); cobrança igual (mesmo cliente, valor, vencimento, descrição) em 10 min é recusada com o id da existente; o aviso
 * do Asaas ao cliente é decisão (`avisarCliente`, padrão NÃO). CPF/CNPJ, e-mail e telefone saem mascarados; a chave nunca.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada, somarDias, validarData } from '../franquia-mcp/travas.js';
import { limparTexto } from '../lib/integracoes/asaas-escrita.js';
import { mascararDigitosSeguidos, temDigitosSeguidos } from '../lib/pii.js';
import { resolverContasAsaas, type ContaAsaas, type ContextoAsaas, type EscritaAsaas } from './asaas.js';
import { executar } from './ferramenta.js';

export const EVENTO_COBRANCA = 'asaas_cobranca_gravada';
export const EVENTO_CLIENTE = 'asaas_cliente_gravado';
export const LIMITES_ASAAS = { tetoPadraoReais: 5000, porHoraPadrao: 20, validadeMs: 15 * 60_000, duplicataMs: 10 * 60_000, horaMs: 3_600_000, maxDiasVencimento: 90 };
const FUSO = 'America/Sao_Paulo';

// ----------------------------------------------------------------- limites (lidos a cada uso, do ambiente)

/**
 * Variável ausente ou vazia = o padrão. Valor 0 = DESLIGADO (recusa tudo). Valor que não é número (ou é negativo) também
 * desliga: configuração torta não pode virar licença para cobrar.
 */
export function tetoDaCobranca(e: NodeJS.ProcessEnv = process.env): number {
  const bruto = e.ASAAS_COBRANCA_MAX_REAIS?.trim();
  if (!bruto) return LIMITES_ASAAS.tetoPadraoReais;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function cobrancasPorHora(e: NodeJS.ProcessEnv = process.env): number {
  const bruto = e.ASAAS_COBRANCAS_POR_HORA?.trim();
  if (!bruto) return LIMITES_ASAAS.porHoraPadrao;
  const n = Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Unidades em que a escrita do Asaas está LIGADA: slugs separados por vírgula em ASAAS_ESCRITA_UNIDADES. Ausente ou vazia =
 * desligada em todas (falha fechada). "*" não é aceito: cada unidade se liga pelo nome.
 */
export function unidadesComEscrita(e: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (e.ASAAS_ESCRITA_UNIDADES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.includes('*')),
  );
}

// ----------------------------------------------------------------- validação e máscaras

const soDigitos = (s: string) => s.replace(/\D/g, '');

function cpfValido(d: string): boolean {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(d[n])) return false;
  }
  return true;
}

function cnpjValido(d: string): boolean {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  for (const n of [12, 13]) {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * pesos[i]!;
    const r = soma % 11;
    if ((r < 2 ? 0 : 11 - r) !== Number(d[n])) return false;
  }
  return true;
}

/** CPF (11) ou CNPJ (14) com dígitos verificadores certos; devolve só os dígitos. */
export function validarCpfCnpj(bruto: unknown): string {
  const d = soDigitos(String(bruto ?? ''));
  if (d.length === 11) {
    if (!cpfValido(d)) throw new ErroDeEntrada('CPF inválido (dígitos verificadores não conferem). Nada foi preparado.');
    return d;
  }
  if (d.length === 14) {
    if (!cnpjValido(d)) throw new ErroDeEntrada('CNPJ inválido (dígitos verificadores não conferem). Nada foi preparado.');
    return d;
  }
  throw new ErroDeEntrada('CPF/CNPJ inválido: informe 11 dígitos (CPF) ou 14 (CNPJ). Nada foi preparado.');
}

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

/** "Maria da Silva Souza" → "Maria S.": o registro precisa de quem, não do nome inteiro. */
export function abreviarNome(n: string): string {
  const p = n.trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1]![0]}.` : (p[0] ?? '');
}

export function mascararTelefone(t: string): string {
  let d = soDigitos(t);
  // com DDI (55 + DDD + 8 ou 9 dígitos) os dois primeiros dígitos não são o DDD
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length >= 8 ? `(${d.slice(0, 2)}) *****-${d.slice(-4)}` : '*****';
}

/**
 * Quantos dígitos seguidos (com ou sem espaço, ponto, hífen e barra entre eles) já bastam para recusar o texto. A regra mora em
 * `lib/pii.ts` (UMA só): aqui só se escolhe o limite de cada campo.
 *  - descrição: 11 (CPF, celular com DDD, CNPJ, número com DDI). Ela vai para o boleto do paciente; a auditoria guarda só o tamanho.
 *  - externalReference: 10 (inclui telefone fixo com DDD). Ela vai INTEIRA para a auditoria, então é mais estrita.
 * Na dúvida recusa: um número de pedido longo (ex. aaaammddNNN, 11 dígitos) também cai aqui; a mensagem diz o motivo e como contornar,
 * sem repetir o valor.
 */
export const MIN_DIGITOS_DESCRICAO = 11;
export const MIN_DIGITOS_REFERENCIA = 10;
const MARCA_DOCUMENTO = '[documento]';

const SEM_CONTROLE = /[\u0000-\u001f\u007f]/;

function nomeValido(v: unknown): string {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 120 || SEM_CONTROLE.test(n)) throw new ErroDeEntrada('nome do cliente: de 2 a 120 caracteres, sem caracteres de controle');
  return n;
}

function emailValido(v: string): string {
  const e = v.trim().toLowerCase();
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new ErroDeEntrada('e-mail inválido');
  return e;
}

/** DDD + número (10 ou 11 dígitos); o +55 na frente sai. */
function telefoneValido(v: string): string {
  let d = soDigitos(v);
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) throw new ErroDeEntrada('telefone inválido: use DDD + número (10 ou 11 dígitos)');
  return d;
}

export interface EnderecoPedido {
  cep: string;
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro?: string;
}

export interface DadosDoCliente {
  nome: string;
  cpfCnpj: string;
  email?: string;
  telefone?: string;
  endereco?: EnderecoPedido;
}

function limitar(v: string | undefined, max: number, campo: string): string | undefined {
  const t = v?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length > max || SEM_CONTROLE.test(t)) throw new ErroDeEntrada(`${campo}: até ${max} caracteres, sem caracteres de controle`);
  return t;
}

/** Valida e normaliza os dados do cliente. O corpo para o Asaas só ganha o que foi informado. */
function prepararDadosDoCliente(d: Partial<DadosDoCliente> & { cpfCnpj: string }): DadosDoCliente {
  const out: DadosDoCliente = { nome: nomeValido(d.nome), cpfCnpj: validarCpfCnpj(d.cpfCnpj) };
  if (d.email?.trim()) out.email = emailValido(d.email);
  if (d.telefone?.trim()) out.telefone = telefoneValido(d.telefone);
  if (d.endereco) {
    const cep = soDigitos(d.endereco.cep ?? '');
    if (cep.length !== 8) throw new ErroDeEntrada('endereço: CEP com 8 dígitos');
    const logradouro = limitar(d.endereco.logradouro, 120, 'endereço (logradouro)');
    const numero = limitar(d.endereco.numero, 20, 'endereço (número)');
    if (!logradouro || !numero) throw new ErroDeEntrada('endereço: informe CEP, logradouro e número (ou deixe o endereço de fora)');
    const complemento = limitar(d.endereco.complemento, 80, 'endereço (complemento)');
    const bairro = limitar(d.endereco.bairro, 80, 'endereço (bairro)');
    out.endereco = { cep, logradouro, numero, ...(complemento ? { complemento } : {}), ...(bairro ? { bairro } : {}) };
  }
  return out;
}

function corpoDoCliente(d: DadosDoCliente, avisar: boolean): Record<string, unknown> {
  return {
    name: d.nome,
    cpfCnpj: d.cpfCnpj,
    ...(d.email ? { email: d.email } : {}),
    ...(d.telefone ? (d.telefone.length === 11 ? { mobilePhone: d.telefone } : { phone: d.telefone }) : {}),
    ...(d.endereco
      ? { postalCode: d.endereco.cep, address: d.endereco.logradouro, addressNumber: d.endereco.numero, ...(d.endereco.complemento ? { complement: d.endereco.complemento } : {}), ...(d.endereco.bairro ? { province: d.endereco.bairro } : {}) }
      : {}),
    // o aviso do Asaas ao cliente é decisão de quem pede; o padrão é NÃO avisar
    notificationDisabled: !avisar,
  };
}

const dinheiro = (n: number) => `R$ ${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
const dataBR = (iso: string) => iso.split('-').reverse().join('/');

function hojeLocal(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

function valorValido(v: unknown, teto: number): number {
  if (teto <= 0) throw new ErroDeEntrada('a geração de boleto pelo conector está DESLIGADA: configure ASAAS_COBRANCA_MAX_REAIS com o teto por cobrança (maior que 0). Nada foi preparado.');
  if (typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v)) throw new ErroDeEntrada('valor: informe um número finito em reais, ex. 250 ou 250.5 (NaN e Infinity não valem)');
  if (/e/i.test(String(v))) throw new ErroDeEntrada('valor: escreva o número por extenso, sem notação científica (ex. 250.5)');
  if (v <= 0) throw new ErroDeEntrada('valor: precisa ser maior que zero');
  const centavos = Math.round(v * 100);
  if (centavos < 1) throw new ErroDeEntrada('valor: no mínimo R$ 0,01');
  if (Math.abs(centavos - v * 100) > 1e-6) throw new ErroDeEntrada('valor: no máximo 2 casas decimais');
  if (v > teto) throw new ErroDeEntrada(`${dinheiro(v)} passa do teto de ${dinheiro(teto)} por cobrança no conector: gere esta cobrança direto no painel do Asaas.`);
  return centavos / 100;
}

function vencimentoValido(v: unknown, agora: number): string {
  const d = validarData(String(v ?? ''), 'vencimento');
  const hoje = hojeLocal(agora);
  if (d < hoje) throw new ErroDeEntrada(`vencimento ${dataBR(d)} já passou (hoje é ${dataBR(hoje)}): boleto só com vencimento de hoje em diante`);
  const limite = somarDias(hoje, LIMITES_ASAAS.maxDiasVencimento);
  if (d > limite) throw new ErroDeEntrada(`vencimento ${dataBR(d)} passa de ${LIMITES_ASAAS.maxDiasVencimento} dias (limite ${dataBR(limite)})`);
  return d;
}

function descricaoValida(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) throw new ErroDeEntrada('descrição obrigatória: ela aparece no boleto do paciente');
  if (t.length > 500) throw new ErroDeEntrada('descrição: no máximo 500 caracteres');
  // Datas ("28/10/2026 - 27/11/2026", "10/2026") não são documento: saem só da conferência dos dígitos, o texto fica igual.
  const semDatas = t.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ').replace(/\b\d{1,2}\/\d{4}\b/g, ' ');
  if (temDigitosSeguidos(semDatas, MIN_DIGITOS_DESCRICAO)) {
    throw new ErroDeEntrada(`descrição recusada: tem ${MIN_DIGITOS_DESCRICAO} ou mais dígitos seguidos (mesmo com espaço, ponto, hífen ou barra entre eles), que podem ser CPF, CNPJ ou telefone, e ela aparece no boleto do paciente. Tire o número do texto; se for outra coisa (data, número de pedido), escreva com letras no meio.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) throw new ErroDeEntrada('descrição com caracteres de controle');
  return t;
}

function referenciaValida(v: unknown): string | undefined {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const t = String(v).trim();
  if (t.length > 100 || SEM_CONTROLE.test(t)) throw new ErroDeEntrada('externalReference: até 100 caracteres, sem caracteres de controle');
  if (temDigitosSeguidos(t, MIN_DIGITOS_REFERENCIA)) {
    throw new ErroDeEntrada(`externalReference recusada: tem ${MIN_DIGITOS_REFERENCIA} ou mais dígitos seguidos (mesmo com espaço, ponto, hífen ou barra entre eles), que podem ser CPF, CNPJ ou telefone, e ela vai inteira para os registros. Use o número do pedido separando os blocos de dígitos com letras (ex.: PED-20261028-N123).`);
  }
  return t;
}

/** Só boleto, à vista, avulso: Pix, cartão, UNDEFINED, parcelamento e assinatura são recusados. */
function recusarForaDoEscopo(a: { formaDePagamento?: unknown; billingType?: unknown; parcelas?: unknown; installmentCount?: unknown; recorrencia?: unknown; assinatura?: unknown }): void {
  for (const forma of [a.formaDePagamento, a.billingType]) {
    if (forma !== undefined && forma !== null && String(forma).trim().toUpperCase() !== 'BOLETO') {
      throw new ErroDeEntrada(`forma de pagamento "${String(forma)}" não é permitida: este conector gera SOMENTE boleto (BOLETO). Pix, cartão e "a escolher" se fazem no painel do Asaas.`);
    }
  }
  for (const parcelas of [a.parcelas, a.installmentCount]) {
    if (parcelas !== undefined && parcelas !== null && Number(parcelas) !== 1) throw new ErroDeEntrada('parcelamento não é permitido: o conector gera um boleto à vista. Parcelar se faz no painel do Asaas.');
  }
  for (const x of [a.recorrencia, a.assinatura]) {
    if (x !== undefined && x !== null && x !== false && String(x).toLowerCase() !== 'false') throw new ErroDeEntrada('assinatura/cobrança recorrente não é permitida: o conector gera um boleto avulso.');
  }
}

// ----------------------------------------------------------------- estado: códigos, histórico e limites

interface PendenteCliente {
  tipo: 'cliente';
  usuario: string;
  unidade: string;
  dados: DadosDoCliente;
  avisar: boolean;
  /** o final da chave que a prévia mostrou (só para exibir) e a impressão da chave inteira (é ela que o confirmar compara) */
  chaveTermina: string;
  chaveImpressao: string;
  criadoEm: number;
}

interface PendenteCobranca {
  tipo: 'cobranca';
  usuario: string;
  unidade: string;
  /** cliente que já existia (id) OU o CPF/CNPJ do cliente a conferir/cadastrar */
  clienteId?: string;
  novo?: DadosDoCliente;
  avisar: boolean;
  valor: number;
  vencimento: string;
  descricao: string;
  externalReference?: string;
  chaveTermina: string;
  chaveImpressao: string;
  criadoEm: number;
}

type Pendente = PendenteCliente | PendenteCobranca;
type SemData<T> = T extends unknown ? Omit<T, 'criadoEm'> : never;

/** Pedidos preparados à espera do ok. Em memória: reinício = preparar de novo (e o código antigo morre junto). */
export class PendentesAsaas {
  private itens = new Map<string, Pendente>();
  constructor(private agora: () => number = Date.now) {}
  guardar(p: SemData<Pendente>): { codigo: string; expiraEm: string } {
    for (const [k, v] of this.itens) if (this.agora() - v.criadoEm > LIMITES_ASAAS.validadeMs) this.itens.delete(k);
    let codigo: string;
    do codigo = randomBytes(6).toString('hex').toUpperCase();
    while (this.itens.has(codigo));
    const criadoEm = this.agora();
    this.itens.set(codigo, { ...p, criadoEm } as Pendente);
    return { codigo, expiraEm: new Date(criadoEm + LIMITES_ASAAS.validadeMs).toISOString() };
  }
  tirar<T extends Pendente['tipo']>(codigo: string, usuario: string, tipo: T): Extract<Pendente, { tipo: T }> {
    const k = codigo.trim().toUpperCase();
    const p = this.itens.get(k);
    if (!p) throw new ErroDeEntrada('código já usado ou desconhecido: confira com asaas_cobrancas / asaas_cliente se o primeiro uso gravou antes de preparar de novo');
    if (p.usuario !== usuario) throw new ErroDeEntrada('este código foi gerado por outro usuário');
    if (p.tipo !== tipo) throw new ErroDeEntrada(`este código é de ${p.tipo === 'cliente' ? 'cadastro de cliente (asaas_confirmar_cliente)' : 'boleto (asaas_confirmar_cobranca)'}`);
    this.itens.delete(k);
    if (this.agora() - p.criadoEm > LIMITES_ASAAS.validadeMs) throw new ErroDeEntrada('o código venceu (15 minutos): prepare de novo');
    return p as Extract<Pendente, { tipo: T }>;
  }
}

export interface RegistroDeCobranca {
  conta: string;
  /** hash de conta+cliente+valor+vencimento+descrição(+referência) */
  chave: string;
  em: number;
  cobrancaId?: string;
}

export interface EstadoEscritaAsaas {
  pendentes: PendentesAsaas;
  agora: () => number;
  tetoReais: () => number;
  porHora: () => number;
  /** unidades com a escrita ligada (ASAAS_ESCRITA_UNIDADES) */
  unidades: () => Set<string>;
  /** quanto esperar a linha digitável (melhor esforço) */
  esperaLinhaMs: number;
  /** cobranças criadas nesta subida e as lidas da auditoria (para o teto e a duplicata sobreviverem a um reinício) */
  cobrancas: RegistroDeCobranca[];
  historico?: (conta: string) => Promise<RegistroDeCobranca[]>;
  historicoLido: Map<string, Promise<void>>;
  /** confirmações uma por vez: duas juntas passariam as duas pelo freio antes de qualquer uma ser contada */
  fila: Promise<unknown>;
}

export function criarEscritaAsaas(
  o: { agora?: () => number; tetoReais?: () => number; porHora?: () => number; unidades?: () => Set<string>; esperaLinhaMs?: number; historico?: (conta: string) => Promise<RegistroDeCobranca[]> } = {},
): EstadoEscritaAsaas {
  const agora = o.agora ?? Date.now;
  return {
    pendentes: new PendentesAsaas(agora),
    agora,
    tetoReais: o.tetoReais ?? (() => tetoDaCobranca()),
    porHora: o.porHora ?? (() => cobrancasPorHora()),
    unidades: o.unidades ?? (() => unidadesComEscrita()),
    esperaLinhaMs: o.esperaLinhaMs ?? 10_000,
    cobrancas: [],
    historico: o.historico,
    historicoLido: new Map(),
    fila: Promise.resolve(),
  };
}

async function garantirHistorico(esc: EstadoEscritaAsaas, conta: string): Promise<void> {
  if (!esc.historico) return;
  let p = esc.historicoLido.get(conta);
  if (!p) {
    p = esc.historico(conta).then((rs) => {
      esc.cobrancas.push(...rs);
    });
    esc.historicoLido.set(conta, p);
  }
  try {
    await p;
  } catch {
    esc.historicoLido.delete(conta);
    throw new ErroDeEntrada('não consegui conferir as cobranças recentes (teto por hora e duplicata) — nada foi gravado; tente em instantes');
  }
}

export function chaveDeDuplicata(conta: string, cliente: string, valor: number, vencimento: string, descricao: string, referencia?: string): string {
  return createHash('sha256').update([conta, cliente, Math.round(valor * 100), vencimento, descricao.trim(), referencia ?? ''].join('|')).digest('hex').slice(0, 32);
}

/** Por que NÃO pode gerar mais um boleto agora (teto por hora ou cobrança igual há pouco), ou null. */
async function freio(esc: EstadoEscritaAsaas, conta: string, chave: string): Promise<string | null> {
  await garantirHistorico(esc, conta);
  const t = esc.agora();
  esc.cobrancas = esc.cobrancas.filter((r) => t - r.em < LIMITES_ASAAS.horaMs);
  const igual = esc.cobrancas.find((r) => r.conta === conta && r.chave === chave && t - r.em < LIMITES_ASAAS.duplicataMs);
  if (igual) return `cobrança igual (mesmo cliente, valor, vencimento e descrição) criada há menos de 10 minutos${igual.cobrancaId ? `: ${igual.cobrancaId}` : ''}. Não criei outra.`;
  const naHora = esc.cobrancas.filter((r) => r.conta === conta).length;
  if (esc.porHora() <= 0) return 'a geração de boleto pelo conector está DESLIGADA: configure ASAAS_COBRANCAS_POR_HORA com o limite por hora (maior que 0)';
  if (naHora >= esc.porHora()) return `limite de ${esc.porHora()} cobranças por hora nesta conta já foi atingido (${naHora}); tente mais tarde ou gere no painel do Asaas`;
  return null;
}

// ----------------------------------------------------------------- Asaas: leituras de apoio

interface ClienteAsaas {
  id: string;
  name?: string;
  cpfCnpj?: string;
  email?: string;
  mobilePhone?: string;
  phone?: string;
  notificationDisabled?: boolean;
  deleted?: boolean;
}

function contaDeEscrita(ctx: ContextoAsaas, esc: EstadoEscritaAsaas, unidade: unknown): ContaAsaas & { escrita: EscritaAsaas } {
  const pedido = String(unidade ?? '').trim();
  if (!pedido) throw new ErroDeEntrada('informe a unidade (UMA): a escrita no Asaas precisa de uma conta só');
  if (pedido.toLowerCase() === 'todas' || /[,;]/.test(pedido)) throw new ErroDeEntrada('escrita no Asaas é numa conta só: informe UMA unidade ("todas" não vale para gravar)');
  const [c, ...resto] = resolverContasAsaas(ctx, pedido);
  if (!c || resto.length) throw new ErroDeEntrada('escrita no Asaas é numa conta só: informe UMA unidade');
  if (!esc.unidades().has(c.slug.toLowerCase())) {
    throw new ErroDeEntrada(
      `a escrita no Asaas está DESLIGADA para ${c.slug}: configure ASAAS_ESCRITA_UNIDADES com o slug dela (lista separada por vírgula; vazio = desligado em todas; "*" não vale). Nada foi feito.`,
    );
  }
  if (!c.escrita) throw new ErroDeEntrada(`a conta do Asaas de ${c.slug} não está liberada para escrita neste conector`);
  return c as ContaAsaas & { escrita: EscritaAsaas };
}

/**
 * A chave da conta pode ter sido trocada no painel entre a prévia e o ok: o resumo que a pessoa aprovou era de OUTRA conta.
 * Compara a impressão (sha256) da chave INTEIRA, não o final de 4 caracteres, que duas chaves podem ter igual. O final só aparece na mensagem.
 */
function conferirChave(c: { slug: string; escrita: EscritaAsaas }, p: { chaveTermina: string; chaveImpressao: string }): void {
  if (c.escrita.chaveImpressao !== p.chaveImpressao) {
    throw new ErroDeEntrada(`a chave do Asaas de ${c.slug} mudou desde a prévia (final aprovado ${p.chaveTermina}, agora ${c.escrita.chaveFinal}; pode mudar mesmo com o final igual): nada foi gravado; prepare de novo e confira a conta.`);
  }
}

/** Nome da conta como o Asaas devolve (e, se não vier, o guardado quando a chave foi salva). 401 interrompe: a chave não vale. */
async function cabecalhoDaConta(c: ContaAsaas & { escrita: EscritaAsaas }) {
  let nome: string | null = null;
  try {
    const info = await c.fonte.get<{ companyName?: string; name?: string }>('/myAccount/commercialInfo');
    nome = info?.companyName || info?.name || null;
  } catch (e) {
    if ((e as { status?: number })?.status === 401) throw e;
  }
  const avisos: string[] = [];
  if (!nome) nome = c.escrita.contaSalva ?? null;
  if (!nome) avisos.push('não consegui ler o nome da conta no Asaas: confira pelo final da chave');
  return { cabecalho: { unidade: c.slug, nomeDaConta: nome, chaveTermina: c.escrita.chaveFinal }, avisos };
}

async function clientesPorDoc(c: ContaAsaas, doc: string): Promise<ClienteAsaas[]> {
  const r = await c.fonte.get<{ data?: ClienteAsaas[] }>('/customers', { cpfCnpj: doc, limit: 10 });
  const todos = (r?.data ?? []).filter((x) => !x.deleted);
  // só casa documento IGUAL (dígitos): cliente sem documento ou com outro não é "o mesmo CPF"
  const certos = todos.filter((x) => !!x.cpfCnpj && soDigitos(x.cpfCnpj) === doc);
  // o Asaas devolveu gente que não é o documento buscado: nada de adivinhar, nada de criar por cima
  if (todos.length && !certos.length) throw new ErroDeEntrada('o Asaas devolveu clientes que não batem com o CPF/CNPJ buscado: nada foi preparado. Confira no painel do Asaas.');
  return certos;
}

async function clientePorId(c: ContaAsaas, id: string): Promise<ClienteAsaas> {
  if (!/^cus_[A-Za-z0-9]{6,40}$/.test(id)) throw new ErroDeEntrada('clienteId inválido (esperado algo como cus_000005401844)');
  let x: ClienteAsaas | null;
  try {
    x = await c.fonte.get<ClienteAsaas>(`/customers/${id}`);
  } catch (e) {
    if ((e as { status?: number })?.status === 404) throw new ErroDeEntrada(`o cliente ${id} não existe nesta conta do Asaas`);
    throw e;
  }
  if (!x?.id || x.deleted) throw new ErroDeEntrada(`o cliente ${id} não existe nesta conta do Asaas`);
  return x;
}

function mostrarCliente(x: ClienteAsaas) {
  const celular = x.mobilePhone || x.phone;
  return {
    id: x.id,
    nome: x.name ?? null,
    documento: x.cpfCnpj ? mascararDoc(x.cpfCnpj) : null,
    ...(x.email ? { email: mascararEmail(x.email) } : {}),
    ...(celular ? { celular: mascararTelefone(celular) } : {}),
    avisosAutomaticos: x.notificationDisabled === true ? 'desligados' : 'ligados',
  };
}

function mostrarDados(d: DadosDoCliente) {
  return {
    nome: d.nome,
    documento: mascararDoc(d.cpfCnpj),
    ...(d.email ? { email: mascararEmail(d.email) } : {}),
    ...(d.telefone ? { celular: mascararTelefone(d.telefone) } : {}),
    ...(d.endereco ? { endereco: `${d.endereco.logradouro}, ${d.endereco.numero}${d.endereco.bairro ? ` — ${d.endereco.bairro}` : ''} (CEP ${d.endereco.cep.slice(0, 5)}-***)` } : {}),
  };
}

async function referenciaEmUso(c: ContaAsaas, ref: string): Promise<string | null> {
  const r = await c.fonte.get<{ data?: Array<{ id: string; deleted?: boolean }> }>('/payments', { externalReference: ref, limit: 20 });
  return (r?.data ?? []).find((p) => !p.deleted)?.id ?? null;
}

// ----------------------------------------------------------------- cliente

type CtxEscrita = { asaas: ContextoAsaas; esc: EstadoEscritaAsaas };

const INSTRUCAO_AVISO_OFF = 'O Asaas NÃO vai mandar e-mail nem SMS ao cliente (cadastro com aviso desligado).';

export async function prepararCliente(
  { asaas, esc }: CtxEscrita,
  usuario: string,
  a: { unidade: string; nome: string; cpfCnpj: string; email?: string; telefone?: string; endereco?: EnderecoPedido; avisarCliente?: boolean },
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const dados = prepararDadosDoCliente(a);
  const avisar = a.avisarCliente === true;
  const { cabecalho, avisos } = await cabecalhoDaConta(c);
  const existentes = await clientesPorDoc(c, dados.cpfCnpj);
  if (existentes.length) {
    return {
      conta: cabecalho,
      acao: 'CADASTRAR CLIENTE',
      jaCadastrado: true,
      clientes: existentes.map(mostrarCliente),
      avisos,
      confirmacao: null,
      instrucao: `Já cadastrado: NÃO criei outro. Use o id ${existentes.map((x) => x.id).join(' ou ')} em asaas_preparar_cobranca (clienteId). Nada a confirmar.`,
    };
  }
  const { codigo, expiraEm } = esc.pendentes.guardar({ tipo: 'cliente', usuario, unidade: c.slug, dados, avisar, chaveTermina: c.escrita.chaveFinal, chaveImpressao: c.escrita.chaveImpressao });
  return {
    conta: cabecalho,
    acao: 'CADASTRAR CLIENTE',
    jaCadastrado: false,
    cliente: mostrarDados(dados),
    aviso: { avisarCliente: avisar, vaiAvisar: avisar, texto: avisar ? 'O Asaas PODE mandar e-mail/SMS de cobrança a este cliente (avisos ligados).' : INSTRUCAO_AVISO_OFF },
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `Nada foi gravado ainda. Mostre este resumo à pessoa (conta, nome e documento) e, se ela aprovar, chame asaas_confirmar_cliente com confirmacao="${codigo}" (vale 15 minutos, uma vez).`,
  };
}

/** O POST pode ter chegado ao Asaas? (sem resposta ou 5xx) — aí NÃO dá para dizer que nada foi criado. */
/** 2xx sem o id no corpo: o Asaas pode ter criado. Entra como "sem resposta" (status nulo). */
class ErroSemId extends Error {
  readonly status = null;
}

const podeTerGravado = (e: unknown) => {
  const status = (e as { status?: number | null })?.status;
  return status == null || status >= 500;
};

type Registrar = (evento: string, argumentos: Record<string, unknown>, ok: boolean, erro?: string) => void;

function enfileirar<T>(esc: EstadoEscritaAsaas, fn: () => Promise<T>): Promise<T> {
  const vez = esc.fila.then(fn);
  esc.fila = vez.catch(() => undefined);
  return vez;
}

/** Erro do Asaas sem a chave, sem documento e sem e-mail, na mesma classe (entrada continua entrada). */
function sanear(e: unknown): Error {
  const msg = limparTexto(e instanceof Error ? e.message : String(e), undefined, e instanceof ErroDeEntrada).slice(0, 400);
  return e instanceof ErroDeEntrada ? new ErroDeEntrada(msg) : new Error(msg);
}

export function confirmarCliente({ asaas, esc }: CtxEscrita, usuario: string, a: { confirmacao: string }, registrar: Registrar) {
  return enfileirar(esc, async () => {
    const p = esc.pendentes.tirar(a.confirmacao, usuario, 'cliente');
    const c = contaDeEscrita(asaas, esc, p.unidade);
    conferirChave(c, p);
    // de novo, agora: se alguém cadastrou nesse meio tempo, não cria outro
    const existentes = await clientesPorDoc(c, p.dados.cpfCnpj);
    const base = { conta: c.slug, documento: mascararDoc(p.dados.cpfCnpj), pediuPor: p.usuario, confirmadoPor: usuario };
    if (existentes.length) {
      registrar(EVENTO_CLIENTE, { ...base, jaExistia: true, clienteId: existentes[0]!.id }, true);
      return { jaCadastrado: true, clientes: existentes.map(mostrarCliente), instrucao: `Já existia: NÃO criei outro. Use ${existentes[0]!.id} na cobrança.`, registro: 'Registrado com quem pediu e confirmou.' };
    }
    try {
      const criado = await c.escrita.post<ClienteAsaas>('/customers', corpoDoCliente(p.dados, p.avisar));
      if (!criado?.id) throw new ErroSemId('o Asaas respondeu ao cadastro do cliente sem o id');
      registrar(EVENTO_CLIENTE, { ...base, jaExistia: false, clienteId: criado.id, nome: abreviarNome(p.dados.nome), avisarCliente: p.avisar }, true);
      return {
        cadastrado: true,
        cliente: { id: criado.id, nome: p.dados.nome, documento: mascararDoc(p.dados.cpfCnpj) },
        aviso: p.avisar ? 'cadastrado com avisos automáticos LIGADOS' : INSTRUCAO_AVISO_OFF,
        instrucao: `Use o id ${criado.id} em asaas_preparar_cobranca (clienteId) para gerar o boleto.`,
        registro: 'Registrado com quem pediu e confirmou.',
      };
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      registrar(EVENTO_CLIENTE, { ...base, jaExistia: false, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      throw incerto ? new Error(`${s.message} — o cadastro PODE ter sido feito: confira com asaas_cliente antes de repetir.`) : s;
    }
  });
}

// ----------------------------------------------------------------- cobrança (boleto)

type Alvo = { tipo: 'existente'; cliente: ClienteAsaas } | { tipo: 'novo'; dados: DadosDoCliente };

/** Acha o cliente (por id ou por CPF/CNPJ) ou diz que será cadastrado. Mais de um cadastro com o mesmo documento: não adivinha. */
async function acharAlvo(c: ContaAsaas, p: { clienteId?: string; novo?: DadosDoCliente }): Promise<Alvo> {
  if (p.clienteId) return { tipo: 'existente', cliente: await clientePorId(c, p.clienteId) };
  const dados = p.novo!;
  const achados = await clientesPorDoc(c, dados.cpfCnpj);
  if (achados.length > 1) throw new ErroDeEntrada(`há ${achados.length} cadastros com este CPF/CNPJ no Asaas (${achados.map((x) => x.id).join(', ')}): informe qual usar em clienteId. Nada foi feito.`);
  return achados[0] ? { tipo: 'existente', cliente: achados[0] } : { tipo: 'novo', dados };
}

/** O aviso automático do Asaas é decisão: não dá para desligar num cadastro que já existe (o conector não edita cliente), então recusa. */
function decidirAviso(alvo: Alvo, avisar: boolean): { vaiAvisar: boolean; texto: string } {
  if (alvo.tipo === 'novo') return { vaiAvisar: avisar, texto: avisar ? 'O Asaas PODE mandar e-mail/SMS da cobrança ao cliente (cadastro novo com avisos ligados).' : INSTRUCAO_AVISO_OFF };
  const liga = alvo.cliente.notificationDisabled !== true;
  if (liga && !avisar) {
    throw new ErroDeEntrada(
      `o cliente ${alvo.cliente.id} já tem o aviso automático do Asaas LIGADO e o conector não altera cadastro: o boleto avisaria o paciente por e-mail/SMS. ` +
        'Se isso é aceitável, repita com avisarCliente=true; senão, desligue o aviso no painel do Asaas ou gere por lá. Nada foi preparado.',
    );
  }
  return liga
    ? { vaiAvisar: true, texto: 'O Asaas VAI mandar e-mail/SMS da cobrança a este cliente (cadastro com avisos ligados; você aceitou com avisarCliente=true).' }
    : { vaiAvisar: false, texto: avisar ? 'Este cadastro tem os avisos desligados: o Asaas NÃO vai avisar o cliente (apesar de avisarCliente=true).' : INSTRUCAO_AVISO_OFF };
}

export interface PedidoDeCobranca {
  unidade: string;
  clienteId?: string;
  cpfCnpj?: string;
  novoCliente?: { nome: string; email?: string; telefone?: string; endereco?: EnderecoPedido };
  valor: number;
  vencimento: string;
  descricao: string;
  externalReference?: string;
  avisarCliente?: boolean;
  formaDePagamento?: unknown;
  billingType?: unknown;
  parcelas?: unknown;
  installmentCount?: unknown;
  recorrencia?: unknown;
  assinatura?: unknown;
}

export async function prepararCobranca({ asaas, esc }: CtxEscrita, usuario: string, a: PedidoDeCobranca) {
  recusarForaDoEscopo(a);
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const valor = valorValido(a.valor, esc.tetoReais());
  const vencimento = vencimentoValido(a.vencimento, esc.agora());
  const descricao = descricaoValida(a.descricao);
  const externalReference = referenciaValida(a.externalReference);
  const avisar = a.avisarCliente === true;
  const clienteId = a.clienteId?.trim();
  if (!!clienteId === !!a.cpfCnpj?.trim()) throw new ErroDeEntrada('informe o cliente por clienteId (cus_…) OU por cpfCnpj, um dos dois');
  let novo: DadosDoCliente | undefined;
  if (!clienteId) {
    const doc = validarCpfCnpj(a.cpfCnpj);
    novo = a.novoCliente ? prepararDadosDoCliente({ ...a.novoCliente, cpfCnpj: doc }) : { nome: '', cpfCnpj: doc };
  }

  const { cabecalho, avisos } = await cabecalhoDaConta(c);
  const alvo = await acharAlvo(c, { clienteId, novo });
  if (alvo.tipo === 'novo' && !a.novoCliente) {
    throw new ErroDeEntrada(`não há cliente com o documento ${mascararDoc(novo!.cpfCnpj)} nesta conta. Passe novoCliente (nome, e-mail, telefone, endereço) para cadastrar junto, ou use asaas_preparar_cliente antes.`);
  }
  if (alvo.tipo === 'existente' && a.novoCliente) avisos.push('o cliente já existe: usei o cadastro existente e ignorei novoCliente');
  const aviso = decidirAviso(alvo, avisar);
  if (externalReference) {
    const emUso = await referenciaEmUso(c, externalReference);
    if (emUso) throw new ErroDeEntrada(`a externalReference "${externalReference}" já está na cobrança ${emUso}. Não criei outra.`);
  } else {
    avisos.push('sem externalReference: informe um identificador único deste boleto (ex. o número do pedido) para a conferência de duplicata ficar mais forte');
  }
  const chave = chaveDeDuplicata(c.slug, alvo.tipo === 'existente' ? alvo.cliente.id : `novo:${alvo.dados.cpfCnpj}`, valor, vencimento, descricao, externalReference);
  const barrado = await freio(esc, c.slug, chave);
  if (barrado) throw new ErroDeEntrada(`${barrado}`);
  const naHora = esc.cobrancas.filter((r) => r.conta === c.slug).length;

  const { codigo, expiraEm } = esc.pendentes.guardar({
    tipo: 'cobranca',
    usuario,
    unidade: c.slug,
    ...(alvo.tipo === 'existente' ? { clienteId: alvo.cliente.id } : { novo: alvo.dados }),
    avisar,
    valor,
    vencimento,
    descricao,
    chaveTermina: c.escrita.chaveFinal,
    chaveImpressao: c.escrita.chaveImpressao,
    ...(externalReference ? { externalReference } : {}),
  });
  return {
    conta: cabecalho,
    acao: 'GERAR BOLETO',
    cliente: alvo.tipo === 'existente' ? { situacao: 'já cadastrado', ...mostrarCliente(alvo.cliente) } : { situacao: 'SERÁ CADASTRADO agora (passo 1 do mesmo resumo)', ...mostrarDados(alvo.dados) },
    boleto: { forma: 'BOLETO (à vista, avulso)', valor: dinheiro(valor), vencimento: `${dataBR(vencimento)} (${vencimento})`, descricao, externalReference: externalReference ?? null },
    aviso: { avisarCliente: avisar, vaiAvisar: aviso.vaiAvisar, texto: aviso.texto },
    limites: { tetoPorCobranca: dinheiro(esc.tetoReais()), cobrancasNaUltimaHora: naHora, limitePorHora: esc.porHora() },
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `Nada foi gravado ainda. Mostre este resumo à pessoa (conta, cliente, valor, vencimento, descrição e se o cliente será avisado) e, se ela aprovar, chame asaas_confirmar_cobranca com confirmacao="${codigo}" (vale 15 minutos, uma vez).`,
  };
}

interface PagamentoAsaas {
  id: string;
  status?: string;
  value?: number;
  dueDate?: string;
  bankSlipUrl?: string | null;
  invoiceUrl?: string | null;
  identificationField?: string | null;
  nossoNumero?: string | null;
  externalReference?: string | null;
}

export function confirmarCobranca({ asaas, esc }: CtxEscrita, usuario: string, a: { confirmacao: string }, registrar: Registrar) {
  return enfileirar(esc, async () => {
    const p = esc.pendentes.tirar(a.confirmacao, usuario, 'cobranca');
    const c = contaDeEscrita(asaas, esc, p.unidade);
    conferirChave(c, p);
    // as travas valem de novo, agora: o teto pode ter mudado e o dia virado desde a prévia
    valorValido(p.valor, esc.tetoReais());
    vencimentoValido(p.vencimento, esc.agora());
    const alvo = await acharAlvo(c, { clienteId: p.clienteId, novo: p.novo });
    const aviso = decidirAviso(alvo, p.avisar);
    if (p.externalReference) {
      const emUso = await referenciaEmUso(c, p.externalReference);
      if (emUso) throw new ErroDeEntrada(`a externalReference "${p.externalReference}" já está na cobrança ${emUso}. Não criei outra.`);
    }
    const chave = chaveDeDuplicata(c.slug, alvo.tipo === 'existente' ? alvo.cliente.id : `novo:${alvo.dados.cpfCnpj}`, p.valor, p.vencimento, p.descricao, p.externalReference);
    const barrado = await freio(esc, c.slug, chave);
    if (barrado) throw new ErroDeEntrada(`não gerei: ${barrado}`);
    const base = { conta: c.slug, valor: p.valor, vencimento: p.vencimento, externalReference: p.externalReference ? mascararDigitosSeguidos(p.externalReference, MIN_DIGITOS_REFERENCIA, MARCA_DOCUMENTO) : null, pediuPor: p.usuario, confirmadoPor: usuario };

    let clienteId: string;
    let clienteCriado = false;
    if (alvo.tipo === 'existente') clienteId = alvo.cliente.id;
    else {
      try {
        const criado = await c.escrita.post<ClienteAsaas>('/customers', corpoDoCliente(alvo.dados, p.avisar));
        if (!criado?.id) throw new ErroSemId('o Asaas respondeu ao cadastro do cliente sem o id');
        clienteId = criado.id;
        clienteCriado = true;
        registrar(EVENTO_CLIENTE, { conta: c.slug, documento: mascararDoc(alvo.dados.cpfCnpj), jaExistia: false, clienteId, nome: abreviarNome(alvo.dados.nome), avisarCliente: p.avisar, pediuPor: p.usuario, confirmadoPor: usuario, junto: 'cobranca' }, true);
      } catch (e) {
        const s = sanear(e);
        const incerto = podeTerGravado(e);
        registrar(EVENTO_CLIENTE, { conta: c.slug, documento: mascararDoc(alvo.dados.cpfCnpj), jaExistia: false, pediuPor: p.usuario, confirmadoPor: usuario, junto: 'cobranca', ...(incerto ? { incerto: true } : {}) }, false, s.message);
        throw incerto
          ? new Error(`não gerei o boleto: o cadastro do cliente ficou sem resposta e PODE ter sido feito. Confira com asaas_cliente (CPF/CNPJ) antes de repetir. (${s.message})`)
          : new ErroDeEntrada(`não cadastrei o cliente e portanto não gerei o boleto: ${s.message}`);
      }
    }

    // a leitura (asaas_cobrancas, extrato) guarda 10 min: depois de escrever (ou de tentar) ela não pode mostrar o "antes" a quem for conferir
    const esquecerLeituras = () => {
      asaas.cache.removerPrefixo(`cob|${c.slug}|`);
      asaas.cache.removerPrefixo(`ext|${c.slug}|`);
    };
    // conta ANTES de chamar: resposta perdida com a cobrança já criada não pode liberar uma 2ª
    // a chave do registro usa o id do cliente (também o recém-criado): é com ela que a duplicata é achada depois de um reinício
    const chaveFinal = chaveDeDuplicata(c.slug, clienteId, p.valor, p.vencimento, p.descricao, p.externalReference);
    const reserva: RegistroDeCobranca = { conta: c.slug, chave: chaveFinal, em: esc.agora() };
    esc.cobrancas.push(reserva);
    let pag: PagamentoAsaas;
    try {
      pag = await c.escrita.post<PagamentoAsaas>('/payments', {
        customer: clienteId,
        billingType: 'BOLETO',
        value: p.valor,
        dueDate: p.vencimento,
        description: p.descricao,
        ...(p.externalReference ? { externalReference: p.externalReference } : {}),
      });
    } catch (e) {
      const s = sanear(e);
      esquecerLeituras();
      const incerto = podeTerGravado(e);
      // recusa definitiva do Asaas (4xx): nada foi criado, libera a reserva. Sem resposta ou 5xx: pode ter criado, a reserva fica.
      if (!incerto) esc.cobrancas = esc.cobrancas.filter((r) => r !== reserva);
      registrar(EVENTO_COBRANCA, { ...base, chave: chaveFinal, clienteId, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      // 5xx ou sem resposta: o Asaas pode ter criado o boleto. Dizer "não saiu" faria a pessoa gerar outro (revisão do sênior, 30/10).
      if (incerto) {
        throw new Error(`${clienteCriado ? `O cliente FOI cadastrado (${clienteId}). ` : ''}O Asaas não confirmou o boleto (${s.message}): ele PODE ter sido gerado. Confira com asaas_cobrancas antes de repetir.`);
      }
      throw new Error(`${clienteCriado ? `O cliente FOI cadastrado (${clienteId}), mas o boleto não saiu: ` : 'O boleto não saiu: '}${s.message}`);
    }
    esquecerLeituras();
    if (!pag?.id) {
      // 2xx sem a cobrança no corpo: pode ter criado. Fica a reserva e o registro "incerto".
      registrar(EVENTO_COBRANCA, { ...base, chave: chaveFinal, clienteId, incerto: true }, false, 'o Asaas respondeu sem o id da cobrança');
      throw new Error(`${clienteCriado ? `O cliente FOI cadastrado (${clienteId}). ` : ''}O Asaas respondeu sem o id da cobrança: o boleto PODE ter sido gerado. Confira com asaas_cobrancas antes de repetir.`);
    }
    reserva.cobrancaId = pag.id;
    // o registro que alimenta a duplicata e o teto sai JÁ, com o id: um reinício durante a busca da linha digitável não pode escondê-lo
    registrar(EVENTO_COBRANCA, { ...base, chave: chaveFinal, clienteId, clienteCriado, cobrancaId: pag.id, status: pag.status ?? null }, true);
    // a linha digitável é melhor esforço: vem de outra rota, que pode demorar (o Asaas registra o boleto em instantes) — se não vier no prazo, o link basta
    let linha = pag.identificationField ?? null;
    if (!linha) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const busca = c.fonte.get<{ identificationField?: string }>(`/payments/${pag.id}/identificationField`).then((r) => r?.identificationField ?? null);
        busca.catch(() => undefined);
        const prazo = new Promise<null>((res) => {
          timer = setTimeout(() => res(null), esc.esperaLinhaMs);
          timer.unref?.();
        });
        linha = await Promise.race([busca, prazo]);
      } catch {
        linha = null;
      } finally {
        clearTimeout(timer);
      }
    }
    return {
      gerado: true,
      conta: c.slug,
      cobranca: {
        id: pag.id,
        status: pag.status ?? null,
        valor: dinheiro(p.valor),
        vencimento: `${dataBR(p.vencimento)} (${p.vencimento})`,
        externalReference: p.externalReference ?? null,
        linkDoBoleto: pag.bankSlipUrl ?? null,
        linkDaFatura: pag.invoiceUrl ?? null,
        linhaDigitavel: linha,
      },
      cliente: { id: clienteId, cadastradoAgora: clienteCriado },
      avisouOCliente: aviso.vaiAvisar,
      aviso: aviso.texto,
      ...(pag.bankSlipUrl ? {} : { atencao: 'o link do boleto ainda não veio (o Asaas registra o boleto em instantes): consulte com asaas_cobrancas em alguns minutos' }),
      registro: 'Registrado com quem pediu e quem confirmou.',
    };
  });
}

// ----------------------------------------------------------------- ferramentas

/** O que vai para a auditoria nos passos "preparar": nunca o documento, o e-mail ou o telefone por inteiro. */
function mascararPedido(a: Record<string, any>): Record<string, unknown> {
  const novo = a.novoCliente as { nome?: string; email?: string; telefone?: string; endereco?: unknown } | undefined;
  const { cpfCnpj, email, telefone, endereco, novoCliente, descricao, nome, externalReference, ...resto } = a;
  return {
    ...resto,
    ...(externalReference !== undefined ? { externalReference: mascararDigitosSeguidos(String(externalReference), MIN_DIGITOS_REFERENCIA, MARCA_DOCUMENTO) } : {}),
    ...(nome !== undefined ? { nome: abreviarNome(String(nome)) } : {}),
    ...(cpfCnpj ? { cpfCnpj: mascararDoc(String(cpfCnpj)) } : {}),
    ...(email ? { email: mascararEmail(String(email)) } : {}),
    ...(telefone ? { telefone: mascararTelefone(String(telefone)) } : {}),
    ...(endereco ? { temEndereco: true } : {}),
    // o texto do boleto pode trazer o motivo do tratamento: o registro guarda só o tamanho (o texto fica no Asaas, pelo id)
    ...(descricao !== undefined ? { descricaoCaracteres: String(descricao).length } : {}),
    ...(novoCliente
      ? { novoCliente: { nome: novo?.nome ? abreviarNome(novo.nome) : undefined, ...(novo?.email ? { email: mascararEmail(novo.email) } : {}), ...(novo?.telefone ? { telefone: mascararTelefone(novo.telefone) } : {}), ...(novo?.endereco ? { temEndereco: true } : {}) } }
      : {}),
  };
}

/** `executar` com a mensagem de erro limpa (sem chave, documento ou e-mail) e os argumentos mascarados no registro. */
function executarSeguro(nome: string, argumentos: unknown, auditar: Auditar, fn: () => Promise<unknown>) {
  return executar(nome, argumentos, auditar, async () => {
    try {
      return await fn();
    } catch (e) {
      throw sanear(e);
    }
  });
}

const endereco = z.object({
  cep: z.string().describe('8 dígitos'),
  logradouro: z.string(),
  numero: z.string(),
  complemento: z.string().optional(),
  bairro: z.string().optional(),
});
const excecoes = z.union([z.string(), z.number(), z.boolean()]).optional();

export function registrarEscritaAsaas(server: McpServer, asaas: ContextoAsaas, esc: EstadoEscritaAsaas, usuario: string, auditar: Auditar): void {
  const ctx: CtxEscrita = { asaas, esc };
  const registrar: Registrar = (evento, argumentos, ok, erro) => auditar({ ferramenta: evento, argumentos, ok, ms: 0, ...(erro ? { erro } : {}) });
  const unidade = z.string().min(1).describe('UMA clínica: slug ou nome curto ("serra"). "todas" não vale para gravar.');
  const avisarCliente = z.boolean().optional().describe('o Asaas pode mandar e-mail/SMS da cobrança ao cliente? Padrão NÃO (false). Só true se a pessoa pediu.');

  server.registerTool(
    'asaas_preparar_cliente',
    {
      title: 'Preparar cadastro de cliente (Asaas)',
      description:
        'PASSO 1 de 2 para CADASTRAR um cliente no Asaas de UMA clínica. NÃO grava nada: confere se o CPF/CNPJ já está cadastrado (se estiver, ' +
        'devolve o id existente e NÃO cria outro), mostra a conta (nome e final da chave) e o que será criado, e devolve um código. Mostre o resumo ' +
        'à pessoa e só chame asaas_confirmar_cliente se ela aprovar. O cliente é criado SEM aviso automático, a menos que avisarCliente=true.',
      inputSchema: {
        unidade,
        nome: z.string().min(2).max(120),
        cpfCnpj: z.string().min(11).describe('CPF (11 dígitos) ou CNPJ (14), com ou sem pontuação; os dígitos verificadores são conferidos'),
        email: z.string().optional(),
        telefone: z.string().optional().describe('DDD + número'),
        endereco: endereco.optional(),
        avisarCliente,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_preparar_cliente', mascararPedido(args), auditar, () => prepararCliente(ctx, usuario, args)),
  );
  server.registerTool(
    'asaas_confirmar_cliente',
    {
      title: 'Confirmar cadastro de cliente (Asaas)',
      description: 'PASSO 2 de 2: cadastra no Asaas o cliente preparado, com o código de asaas_preparar_cliente. Só depois que a pessoa aprovou o resumo. Vale 15 minutos e uma vez.',
      inputSchema: { confirmacao: z.string().min(4).max(16) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_confirmar_cliente', args, auditar, () => confirmarCliente(ctx, usuario, args, registrar)),
  );
  server.registerTool(
    'asaas_preparar_cobranca',
    {
      title: 'Preparar boleto (Asaas)',
      description:
        'PASSO 1 de 2 para GERAR UM BOLETO no Asaas de UMA clínica (SOMENTE boleto, à vista: sem Pix, cartão, parcelamento ou assinatura). NÃO grava: ' +
        'mostra a conta (nome e final da chave), o cliente, valor, vencimento, descrição e se o cliente será avisado pelo Asaas, e devolve um código. ' +
        'Cliente: clienteId (cus_…) OU cpfCnpj de quem já existe; se o CPF/CNPJ não existe, passe novoCliente para cadastrar junto (no mesmo resumo). ' +
        `Valor > 0 até o teto do conector (padrão R$ 5.000); vencimento de hoje a +${LIMITES_ASAAS.maxDiasVencimento} dias; descrição obrigatória (aparece no boleto). Informe sempre ` +
        'externalReference, um identificador ÚNICO deste boleto (ex. nº do pedido; NÃO reutilize para outro boleto), para evitar duplicata. Mostre o resumo à pessoa e só chame asaas_confirmar_cobranca se ela aprovar.',
      inputSchema: {
        unidade,
        clienteId: z.string().optional(),
        cpfCnpj: z.string().optional(),
        novoCliente: z.object({ nome: z.string(), email: z.string().optional(), telefone: z.string().optional(), endereco: endereco.optional() }).optional(),
        valor: z.number().describe('em reais, até 2 casas'),
        vencimento: z.string().describe(`AAAA-MM-DD, de hoje até ${LIMITES_ASAAS.maxDiasVencimento} dias`),
        descricao: z.string().min(1).max(500),
        externalReference: z.string().max(100).optional(),
        avisarCliente,
        formaDePagamento: excecoes.describe('só aceita BOLETO; qualquer outra é recusada'),
        billingType: excecoes.describe('só aceita BOLETO; qualquer outra é recusada'),
        parcelas: excecoes.describe('parcelamento é recusado'),
        installmentCount: excecoes.describe('parcelamento é recusado'),
        recorrencia: excecoes.describe('assinatura é recusada'),
        assinatura: excecoes.describe('assinatura é recusada'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_preparar_cobranca', mascararPedido(args), auditar, () => prepararCobranca(ctx, usuario, args)),
  );
  server.registerTool(
    'asaas_confirmar_cobranca',
    {
      title: 'Confirmar boleto (Asaas)',
      description:
        'PASSO 2 de 2: gera no Asaas o boleto preparado (e cadastra o cliente, se o resumo dizia que seria cadastrado), com o código de asaas_preparar_cobranca. ' +
        'Só depois que a pessoa aprovou o resumo. Vale 15 minutos e uma vez. Devolve o link do boleto, o link da fatura, a linha digitável e o id. ' +
        'Se a resposta for erro de rede, NÃO repita às cegas: confira com asaas_cobrancas antes.',
      inputSchema: { confirmacao: z.string().min(4).max(16) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => executarSeguro('asaas_confirmar_cobranca', args, auditar, () => confirmarCobranca(ctx, usuario, args, registrar)),
  );
}

/**
 * O portão de quem escreve: só quem está na lista de escrita (MCP_ESCRITA_EMAILS, já resolvida em ids) ganha as quatro ferramentas.
 * Fora da lista elas nem existem na sessão — não aparecem e não podem ser chamadas. Devolve se registrou.
 */
export function registrarEscritaAsaasSePermitido(
  server: McpServer,
  asaas: ContextoAsaas,
  esc: EstadoEscritaAsaas,
  usuario: string,
  escritores: ReadonlySet<string>,
  auditar: Auditar,
): boolean {
  if (!escritores.has(usuario)) return false;
  registrarEscritaAsaas(server, asaas, esc, usuario, auditar);
  return true;
}
