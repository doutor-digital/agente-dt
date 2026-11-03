/**
 * Asaas com escrita pelo claude.ai, DIRETA (sem preparar/confirmar), só para quem está em MCP_ESCRITA_EMAILS e só nas contas de
 * ASAAS_ESCRITA_UNIDADES. Este arquivo tem o núcleo: validação, o estado (livro, fila, tetos), cadastrar cliente e criar cobrança
 * (boleto, Pix, cartão por link, parcelado). Editar/cancelar/estornar/transferir estão em `asaas-operacoes.ts`; as ferramentas
 * (nomes, descrições, portão) em `asaas-ferramentas.ts`; tetos e lista de destinos em `asaas-limites.ts`.
 *
 * Quem protege o dinheiro, já que ninguém confirma antes:
 *   - teto por operação (ASAAS_TETO_OPERACAO_REAIS, padrão 5000) e teto por dia e conta (ASAAS_TETO_DIA_REAIS, padrão 20000), no fuso
 *     da clínica, somando cobranças criadas + estornos + transferências, lido da auditoria (banco) — vazio ou 0 = o padrão, nunca ilimitado;
 *   - transferência só para destino da lista (ASAAS_TRANSFERENCIA_DESTINOS), lista vazia = desligada;
 *   - aviso no Telegram a cada transferência, estorno, cancelamento e cobrança acima de 50% do teto;
 *   - UMA conta por vez; duplicata (externalReference e cobrança igual em 10 min); limite de cobranças por hora (ASAAS_COBRANCAS_POR_HORA, padrão 20;
 *     0 ou lixo = criação de cobrança DESLIGADA); vencimento de hoje até 90 dias; operações uma por vez (fila);
 *   - CPF/CNPJ, e-mail e telefone saem mascarados nos registros; a chave nunca; nunca número de cartão pelo chat.
 *
 * ASAAS_ESCRITA_UNIDADES (falha fechada): slugs separados por vírgula; vazia ou ausente = desligada em todas; "*" e "todas" não valem.
 * Proibido sempre (nem existe rota): dados bancários da clínica, chaves de API, webhooks, usuários do Asaas, antecipação, empréstimo, pagar conta.
 */
import { createHash } from 'node:crypto';
import { ErroDeEntrada, somarDias, validarData } from '../franquia-mcp/travas.js';
import { limparTexto } from '../lib/integracoes/asaas-escrita.js';
import { cnpjValido, cpfValido } from '../lib/integracoes/mascaras.js';
import { mascararDigitosSeguidos, temDigitosSeguidos } from '../lib/pii.js';
import { resolverContasAsaas, type ContaAsaas, type ContextoAsaas, type EscritaAsaas } from './asaas.js';
import {
  conferirTetos, dinheiro, diaLocal, mascararDoc, mascararEmail, soDigitos, EVENTO_CLIENTE, EVENTO_COBRANCA, EVENTO_OPERACAO, FUSO_PADRAO, lerDestinos, tetoEspecificoDe, tetoPorDia, tetoPorOperacao, textoDoAviso,
  type DestinosLidos, type Livro, type Porteiro, type TetoEspecifico, type TipoDeLancamento, type TipoDeSaida,
} from './asaas-limites.js';

export { EVENTO_CLIENTE, EVENTO_COBRANCA, EVENTO_OPERACAO, dinheiro, mascararDoc, mascararEmail, soDigitos };
export const LIMITES_ASAAS = { porHoraPadrao: 20, duplicataMs: 10 * 60_000, horaMs: 3_600_000, maxDiasVencimento: 90, maxParcelas: 12 };

// ----------------------------------------------------------------- limites (lidos a cada uso, do ambiente)

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

export const SEM_CONTROLE = /[\u0000-\u001f\u007f]/;

export function nomeValido(v: unknown): string {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 120 || SEM_CONTROLE.test(n)) throw new ErroDeEntrada('nome do cliente: de 2 a 120 caracteres, sem caracteres de controle');
  return n;
}

export function emailValido(v: string): string {
  const e = v.trim().toLowerCase();
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new ErroDeEntrada('e-mail inválido');
  return e;
}

/** DDD + número (10 ou 11 dígitos); o +55 na frente sai. */
export function telefoneValido(v: string): string {
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

export function limitar(v: string | undefined, max: number, campo: string): string | undefined {
  const t = v?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  if (t.length > max || SEM_CONTROLE.test(t)) throw new ErroDeEntrada(`${campo}: até ${max} caracteres, sem caracteres de controle`);
  return t;
}

/** Valida e normaliza os dados do cliente. O corpo para o Asaas só ganha o que foi informado. */
export function prepararDadosDoCliente(d: Partial<DadosDoCliente> & { cpfCnpj: string }): DadosDoCliente {
  const out: DadosDoCliente = { nome: nomeValido(d.nome), cpfCnpj: validarCpfCnpj(d.cpfCnpj) };
  if (d.email?.trim()) out.email = emailValido(d.email);
  if (d.telefone?.trim()) out.telefone = telefoneValido(d.telefone);
  if (d.endereco) out.endereco = validarEndereco(d.endereco);
  return out;
}

/** CEP de 8 dígitos, logradouro e número obrigatórios; complemento e bairro opcionais. Uma regra só, para cadastrar e para editar. */
export function validarEndereco(e: EnderecoPedido): EnderecoPedido {
  const cep = soDigitos(e.cep ?? '');
  if (cep.length !== 8) throw new ErroDeEntrada('endereço: CEP com 8 dígitos');
  const logradouro = limitar(e.logradouro, 120, 'endereço (logradouro)');
  const numero = limitar(e.numero, 20, 'endereço (número)');
  if (!logradouro || !numero) throw new ErroDeEntrada('endereço: informe CEP, logradouro e número (ou deixe o endereço de fora)');
  const complemento = limitar(e.complemento, 80, 'endereço (complemento)');
  const bairro = limitar(e.bairro, 80, 'endereço (bairro)');
  return { cep, logradouro, numero, ...(complemento ? { complemento } : {}), ...(bairro ? { bairro } : {}) };
}

export function corpoDoCliente(d: DadosDoCliente, avisar: boolean): Record<string, unknown> {
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

// ----------------------------------------------------------------- valores, datas, forma

export const dataBR = (iso: string) => iso.split('-').reverse().join('/');

export function valorValido(v: unknown): number {
  if (typeof v !== 'number' || Number.isNaN(v) || !Number.isFinite(v)) throw new ErroDeEntrada('valor: informe um número finito em reais, ex. 250 ou 250.5 (NaN e Infinity não valem)');
  if (/e/i.test(String(v))) throw new ErroDeEntrada('valor: escreva o número por extenso, sem notação científica (ex. 250.5)');
  if (v <= 0) throw new ErroDeEntrada('valor: precisa ser maior que zero');
  const centavos = Math.round(v * 100);
  if (centavos < 1) throw new ErroDeEntrada('valor: no mínimo R$ 0,01');
  if (Math.abs(centavos - v * 100) > 1e-6) throw new ErroDeEntrada('valor: no máximo 2 casas decimais');
  return centavos / 100;
}

export function vencimentoValido(v: unknown, agora: number, fuso: string): string {
  const d = validarData(String(v ?? ''), 'vencimento');
  const hoje = diaLocal(agora, fuso);
  if (d < hoje) throw new ErroDeEntrada(`vencimento ${dataBR(d)} já passou (hoje é ${dataBR(hoje)}): só com vencimento de hoje em diante`);
  const limite = somarDias(hoje, LIMITES_ASAAS.maxDiasVencimento);
  if (d > limite) throw new ErroDeEntrada(`vencimento ${dataBR(d)} passa de ${LIMITES_ASAAS.maxDiasVencimento} dias (limite ${dataBR(limite)})`);
  return d;
}

export function descricaoValida(v: unknown): string {
  const t = String(v ?? '').trim();
  if (!t) throw new ErroDeEntrada('descrição obrigatória: ela aparece na cobrança do paciente');
  if (t.length > 500) throw new ErroDeEntrada('descrição: no máximo 500 caracteres');
  // Datas ("28/10/2026 - 27/11/2026", "10/2026") não são documento: saem só da conferência dos dígitos, o texto fica igual.
  const semDatas = t.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ').replace(/\b\d{1,2}\/\d{4}\b/g, ' ');
  if (temDigitosSeguidos(semDatas, MIN_DIGITOS_DESCRICAO)) {
    throw new ErroDeEntrada(`descrição recusada: tem ${MIN_DIGITOS_DESCRICAO} ou mais dígitos seguidos (mesmo com espaço, ponto, hífen ou barra entre eles), que podem ser CPF, CNPJ ou telefone, e ela aparece na cobrança do paciente. Tire o número do texto; se for outra coisa (data, número de pedido), escreva com letras no meio.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) throw new ErroDeEntrada('descrição com caracteres de controle');
  return t;
}

export function referenciaValida(v: unknown): string | undefined {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const t = String(v).trim();
  if (t.length > 100 || SEM_CONTROLE.test(t)) throw new ErroDeEntrada('externalReference: até 100 caracteres, sem caracteres de controle');
  if (temDigitosSeguidos(t, MIN_DIGITOS_REFERENCIA)) {
    throw new ErroDeEntrada(`externalReference recusada: tem ${MIN_DIGITOS_REFERENCIA} ou mais dígitos seguidos (mesmo com espaço, ponto, hífen ou barra entre eles), que podem ser CPF, CNPJ ou telefone, e ela vai inteira para os registros. Use o número do pedido separando os blocos de dígitos com letras (ex.: PED-20261028-N123).`);
  }
  return t;
}

export type Forma = 'BOLETO' | 'PIX' | 'CARTAO';
const BILLING: Record<Forma, string> = { BOLETO: 'BOLETO', PIX: 'PIX', CARTAO: 'CREDIT_CARD' };
const NOME_DA_FORMA: Record<Forma, string> = { BOLETO: 'BOLETO', PIX: 'PIX', CARTAO: 'CARTÃO (link de pagamento)' };

/** BOLETO (padrão), PIX ou CARTAO. "A escolher" (UNDEFINED), assinatura e recorrência não existem aqui. */
export function formaValida(v: unknown): Forma {
  if (v === undefined || v === null || String(v).trim() === '') return 'BOLETO';
  const t = String(v).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace('CREDIT_CARD', 'CARTAO');
  if (t === 'BOLETO' || t === 'PIX' || t === 'CARTAO') return t;
  throw new ErroDeEntrada(`forma de pagamento "${String(v).slice(0, 30)}" não existe aqui: use BOLETO, PIX ou CARTAO (o cartão sai como link de pagamento do Asaas). "A escolher" e assinatura/recorrência não são aceitos.`);
}

export function parcelasValidas(v: unknown, forma: Forma): number {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMITES_ASAAS.maxParcelas) throw new ErroDeEntrada(`parcelas: número inteiro de 1 a ${LIMITES_ASAAS.maxParcelas}`);
  if (n > 1 && forma === 'PIX') throw new ErroDeEntrada('parcelamento não existe no Pix: use BOLETO ou CARTAO para parcelar');
  return n;
}

const CAMPOS_DE_CARTAO = /(cart|card|cvv|ccv|cvc|expir|holder|portador)/i;

/** Dados de cartão NUNCA entram pelo chat: quem paga digita no link do Asaas. Qualquer campo que pareça cartão derruba o pedido. */
export function recusarDadosDeCartao(a: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(a)) {
    if (k === 'forma') continue;
    if (CAMPOS_DE_CARTAO.test(k) && v !== undefined && v !== null && v !== '' && v !== false) {
      throw new ErroDeEntrada('número, validade, CVV ou token de cartão NUNCA entram pelo chat. Use forma "CARTAO": o conector gera o link de pagamento e o paciente digita o cartão direto no Asaas. Nada foi feito.');
    }
  }
}

/**
 * Campo que a ferramenta não declara (ex. `cardNumber`, `ccv`, `expiryMonth`, `number`): o pedido inteiro é RECUSADO, não descartado em silêncio.
 * Campo com cara de cartão ganha a mensagem do cartão. O valor nunca é repetido na mensagem.
 */
export function recusarCamposDesconhecidos(a: Record<string, unknown>, conhecidos: readonly string[]): void {
  const extras = Object.keys(a).filter((k) => !conhecidos.includes(k));
  if (!extras.length) return;
  if (extras.some((k) => CAMPOS_DE_CARTAO.test(k))) {
    throw new ErroDeEntrada('número, validade, CVV ou token de cartão NUNCA entram pelo chat. Use forma "CARTAO": o conector gera o link de pagamento e o paciente digita o cartão direto no Asaas. Nada foi feito.');
  }
  const nomes = extras.slice(0, 5).map((k) => mascararDigitosSeguidos(k, 6, '[…]').slice(0, 40));
  throw new ErroDeEntrada(`campo(s) que não existem nesta ferramenta: ${nomes.join(', ')}. Nada foi feito; use só os campos da descrição da ferramenta.`);
}

// ----------------------------------------------------------------- estado: tetos, porteiro, fila, aviso

export interface Quem {
  id: string;
  email?: string;
  /** o cliente OAuth (claude.ai…), só para constar na auditoria */
  clientId?: string;
}

/** Grava um evento na auditoria (resultado de uma operação). A intenção, que vem ANTES, é do porteiro. */
export type Registrar = (evento: string, argumentos: Record<string, unknown>, ok: boolean, erro?: string) => unknown;

export interface EstadoEscritaAsaas {
  agora: () => number;
  tetoOperacao: () => number;
  tetoDia: () => number;
  /** teto próprio de estorno e de transferência (vale o menor com o geral) */
  tetoEspecifico: (tipo: TipoDeSaida) => TetoEspecifico;
  porHora: () => number;
  /** unidades com a escrita ligada (ASAAS_ESCRITA_UNIDADES) */
  unidades: () => Set<string>;
  /** destinos de transferência permitidos da clínica (ASAAS_TRANSFERENCIA_DESTINOS) */
  destinos: (slug: string) => DestinosLidos;
  /** manda o aviso (Telegram); devolve se saiu. Nunca lança. */
  alertar: (texto: string) => Promise<boolean>;
  /** quanto esperar a linha digitável / o Pix copia-e-cola (melhor esforço) */
  esperaLinhaMs: number;
  /** lê o banco e grava a intenção numa trava única por chave do Asaas (vale entre instâncias do servidor) */
  porteiro: Porteiro;
  /** nome da conta no Asaas, por 10 min (uma leitura a menos em cada escrita) */
  nomes: Map<string, { nome: string; ate: number }>;
  /** operações uma por vez EM CADA CONTA neste processo (contas diferentes não esperam umas pelas outras); entre processos quem segura é o porteiro */
  filas: Map<string, Promise<unknown>>;
}

/** Sem porteiro (nem nos testes) a escrita não anda: tetos que não conseguem ler o banco não são tetos. */
const PORTEIRO_AUSENTE: Porteiro = {
  async reservar() {
    throw new ErroDeEntrada('o conector subiu sem o porteiro dos tetos (banco): a escrita de dinheiro está desligada');
  },
  async ler() {
    throw new ErroDeEntrada('o conector subiu sem o porteiro dos tetos (banco): a escrita de dinheiro está desligada');
  },
};

export function criarEscritaAsaas(
  o: {
    agora?: () => number;
    tetoOperacao?: () => number;
    tetoDia?: () => number;
    tetoEspecifico?: (tipo: TipoDeSaida) => TetoEspecifico;
    porHora?: () => number;
    unidades?: () => Set<string>;
    destinos?: (slug: string) => DestinosLidos;
    alertar?: (texto: string) => Promise<boolean>;
    esperaLinhaMs?: number;
    porteiro?: Porteiro;
  } = {},
): EstadoEscritaAsaas {
  return {
    agora: o.agora ?? Date.now,
    tetoOperacao: o.tetoOperacao ?? (() => tetoPorOperacao()),
    tetoDia: o.tetoDia ?? (() => tetoPorDia()),
    tetoEspecifico: o.tetoEspecifico ?? ((tipo) => tetoEspecificoDe(tipo)),
    porHora: o.porHora ?? (() => cobrancasPorHora()),
    unidades: o.unidades ?? (() => unidadesComEscrita()),
    destinos: o.destinos ?? ((slug) => lerDestinos(slug)),
    // o servidor passa o Telegram de verdade (producao.ts); sem isso o aviso não sai, e o teste de producao.ts garante a ligação
    alertar: o.alertar ?? (async () => false),
    esperaLinhaMs: o.esperaLinhaMs ?? 10_000,
    porteiro: o.porteiro ?? PORTEIRO_AUSENTE,
    nomes: new Map(),
    filas: new Map(),
  };
}

export function chaveDeDuplicata(conta: string, cliente: string, valor: number, vencimento: string, descricao: string, referencia?: string, forma: Forma = 'BOLETO', parcelas = 1): string {
  // boleto à vista mantém o hash de sempre (a duplicata achada na auditoria de antes continua valendo)
  const extra = forma === 'BOLETO' && parcelas === 1 ? [] : [forma, parcelas];
  return createHash('sha256').update([conta, cliente, Math.round(valor * 100), vencimento, descricao.trim(), referencia ?? '', ...extra].join('|')).digest('hex').slice(0, 32);
}

export function chaveDeOperacao(...partes: Array<string | number>): string {
  return createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 32);
}

export function fusoDe(c: ContaAsaas): string {
  return c.fuso || FUSO_PADRAO;
}

/** A chave do Asaas desta conta (impressão curta e irreversível, nunca a chave): contas com a mesma chave dividem tetos e trava. */
export function grupoDe(c: ContaAsaas): string {
  return c.escrita?.chaveGrupo ?? c.slug;
}

const arredondar = (n: number) => Math.round(n * 100) / 100;

/**
 * `consumoDoDia` para a RESPOSTA de uma operação que já aconteceu: é só apresentação, então um soluço do banco aqui nunca pode virar erro
 * (a pessoa acreditaria que nada foi feito e repetiria).
 */
export async function consumoSeguro(esc: EstadoEscritaAsaas, c: ContaAsaas) {
  try {
    return await consumoDoDia(esc, c);
  } catch {
    return { indisponivel: 'não consegui ler os limites agora (o banco não respondeu); a operação JÁ foi feita. Veja asaas_limites em instantes.' };
  }
}

/** Os tetos que valem (o menor entre o próprio e o geral) e quanto já foi usado hoje. */
export async function consumoDoDia(esc: EstadoEscritaAsaas, c: ContaAsaas) {
  const agora = esc.agora();
  const livro = await esc.porteiro.ler(grupoDe(c), c.slug, agora);
  const geralOp = esc.tetoOperacao();
  const geralDia = esc.tetoDia();
  const usado = livro.somaDoDia(agora, fusoDe(c));
  const saida = (tipo: TipoDeSaida) => {
    const t = esc.tetoEspecifico(tipo);
    const dia = Math.min(t.dia, geralDia);
    const usadoTipo = livro.somaDoDia(agora, fusoDe(c), tipo);
    return { tetoPorOperacao: dinheiro(Math.min(t.operacao, geralOp)), tetoDoDia: dinheiro(dia), usadoHoje: dinheiro(usadoTipo), restanteHoje: dinheiro(Math.max(0, arredondar(Math.min(dia - usadoTipo, geralDia - usado)))) };
  };
  return {
    tetoPorOperacao: dinheiro(geralOp),
    tetoDoDia: dinheiro(geralDia),
    usadoHoje: dinheiro(usado),
    restanteHoje: dinheiro(Math.max(0, arredondar(geralDia - usado))),
    estorno: saida('estorno'),
    transferencia: saida('transferencia'),
  };
}

export interface ConferenciaDeTravas {
  tipo: TipoDeLancamento;
  valor: number;
  noTeto: number;
  chave?: string;
  /** só a criação de cobrança tem limite por hora */
  hora?: boolean;
  descricaoDuplicata?: string;
  /** o que fazer se for de propósito (o texto muda: cobrança aceita mudar a descrição; transferência e estorno, não) */
  seForDeProposito?: string;
}

/** As travas sobre o livro lido do banco (duplicata, limite por hora, tetos). Lança ErroDeEntrada. */
function verificar(esc: EstadoEscritaAsaas, c: ContaAsaas, livro: Livro, o: ConferenciaDeTravas): void {
  const t = esc.agora();
  if (o.chave) {
    const igual = livro.igual(o.chave, t, LIMITES_ASAAS.duplicataMs);
    if (igual) {
      throw new ErroDeEntrada(`${o.descricaoDuplicata ?? 'operação igual'} feita há menos de 10 minutos${igual.id ? `: ${igual.id}` : ''}. Não repeti. ${o.seForDeProposito ?? 'Se for de propósito, espere 10 minutos.'}`);
    }
  }
  if (o.hora) {
    if (esc.porHora() <= 0) throw new ErroDeEntrada('a criação de cobrança pelo conector está DESLIGADA: configure ASAAS_COBRANCAS_POR_HORA com o limite por hora (maior que 0)');
    const naHora = livro.cobrancasNaHora(t, LIMITES_ASAAS.horaMs);
    if (naHora >= esc.porHora()) throw new ErroDeEntrada(`limite de ${esc.porHora()} cobranças por hora nesta conta já foi atingido (${naHora}); tente mais tarde ou crie no painel do Asaas`);
  }
  const saida = o.tipo === 'estorno' || o.tipo === 'transferencia' ? { tipo: o.tipo, teto: esc.tetoEspecifico(o.tipo) } : undefined;
  conferirTetos({ livro, fuso: fusoDe(c), agora: t, valor: o.valor, noTeto: o.noTeto, tetoOperacao: esc.tetoOperacao(), tetoDia: esc.tetoDia(), ...(saida ? { saida } : {}) });
}

/** Conferência PRÉVIA, sem trava (para recusar cedo, antes de cadastrar cliente ou gastar chamada). A que vale é a de `reservar`. */
export async function conferirTravas(esc: EstadoEscritaAsaas, c: ContaAsaas, o: ConferenciaDeTravas): Promise<void> {
  verificar(esc, c, await esc.porteiro.ler(grupoDe(c), c.slug, esc.agora()), o);
}

/**
 * A reserva que vale: dentro da trava única da chave do Asaas, relê o banco, confere tudo de novo e grava a INTENÇÃO antes de qualquer chamada
 * ao Asaas. Devolve o id da intenção, que o resultado da operação precisa repetir (é assim que a intenção "se resolve" no livro).
 */
export async function reservar(
  esc: EstadoEscritaAsaas,
  c: ContaAsaas,
  quem: Quem,
  o: ConferenciaDeTravas & { evento: string; argumentos: Record<string, unknown> },
): Promise<{ intencaoId: string; grupo: string }> {
  const grupo = grupoDe(c);
  const { intencaoId } = await esc.porteiro.reservar({
    grupo,
    conta: c.slug,
    agora: esc.agora(),
    conferir: (livro) => verificar(esc, c, livro, o),
    evento: o.evento,
    argumentos: o.argumentos,
    quem: { userId: quem.id, ...(quem.clientId ? { clientId: quem.clientId } : {}) },
  });
  return { intencaoId, grupo };
}

export function enfileirar<T>(esc: EstadoEscritaAsaas, conta: string, fn: () => Promise<T>): Promise<T> {
  const vez = (esc.filas.get(conta) ?? Promise.resolve()).then(fn);
  const cauda = vez.catch(() => undefined);
  esc.filas.set(conta, cauda);
  // a fila de uma conta parada não fica guardada para sempre
  void cauda.then(() => {
    if (esc.filas.get(conta) === cauda) esc.filas.delete(conta);
  });
  return vez;
}

/**
 * Roda `fn` na fila e, DEPOIS (fora da fila, para um Telegram lento não segurar as outras operações), manda os avisos pedidos.
 * A resposta diz se o aviso saiu — se o Telegram estiver fora, quem pediu fica sabendo.
 */
async function comPrazo(p: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function comAvisos<T extends object>(esc: EstadoEscritaAsaas, conta: string, fn: (avisar: (texto: string) => void) => Promise<T>): Promise<T & { avisoNoTelegram?: string }> {
  const textos: string[] = [];
  let resultado: T | undefined;
  let erro: unknown;
  let falhou = false;
  try {
    resultado = await enfileirar(esc, conta, () => fn((t) => textos.push(t)));
  } catch (e) {
    falhou = true;
    erro = e;
  }
  // o aviso tem prazo: um Telegram lento não pode segurar a resposta de uma operação que já terminou
  const saiu = await Promise.all(textos.map((t) => comPrazo(esc.alertar(t).catch(() => false), 5000)));
  if (falhou) throw erro;
  if (!textos.length) return resultado as T;
  return { ...(resultado as T), avisoNoTelegram: saiu.every(Boolean) ? 'enviado ao João' : 'NÃO ENVIADO (Telegram fora ou sem token): avise o João desta operação' };
}

// ----------------------------------------------------------------- Asaas: a conta e as leituras de apoio

export interface ClienteAsaas {
  id: string;
  name?: string;
  cpfCnpj?: string;
  email?: string;
  mobilePhone?: string;
  phone?: string;
  notificationDisabled?: boolean;
  deleted?: boolean;
}

export type ContaDeEscrita = ContaAsaas & { escrita: EscritaAsaas };
export type CtxEscrita = { asaas: ContextoAsaas; esc: EstadoEscritaAsaas };

export function contaDeEscrita(ctx: ContextoAsaas, esc: EstadoEscritaAsaas, unidade: unknown): ContaDeEscrita {
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
  // o nome antigo do teto (ASAAS_COBRANCA_MAX_REAIS) em 0 ou inválido é o interruptor de "desligado": vale para TODA escrita, não só as que olham o teto
  if (esc.tetoOperacao() <= 0) {
    throw new ErroDeEntrada('a escrita no Asaas está DESLIGADA: ASAAS_COBRANCA_MAX_REAIS (nome antigo) está em 0 ou inválido. Apague a variável ou use ASAAS_TETO_OPERACAO_REAIS com o teto por operação. Nada foi feito.');
  }
  return c as ContaDeEscrita;
}

/** Nome da conta como o Asaas devolve (e, se não vier, o guardado quando a chave foi salva). 401 interrompe: a chave não vale. */
export async function cabecalhoDaConta(c: ContaDeEscrita, esc?: EstadoEscritaAsaas) {
  const guardado = esc?.nomes.get(c.slug);
  let nome: string | null = guardado && guardado.ate > esc!.agora() ? guardado.nome : null;
  if (!nome) {
    try {
      const info = await c.fonte.get<{ companyName?: string; name?: string }>('/myAccount/commercialInfo');
      nome = info?.companyName || info?.name || null;
      if (nome && esc) esc.nomes.set(c.slug, { nome, ate: esc.agora() + 10 * 60_000 });
    } catch (e) {
      if ((e as { status?: number })?.status === 401) throw e;
    }
  }
  const avisos: string[] = [];
  if (!nome) nome = c.escrita.contaSalva ?? null;
  if (!nome) avisos.push('não consegui ler o nome da conta no Asaas: confira pelo final da chave');
  return { cabecalho: { unidade: c.slug, nomeDaConta: nome, chaveTermina: c.escrita.chaveFinal }, avisos };
}

export async function clientesPorDoc(c: ContaAsaas, doc: string): Promise<ClienteAsaas[]> {
  const r = await c.fonte.get<{ data?: ClienteAsaas[] }>('/customers', { cpfCnpj: doc, limit: 10 });
  const todos = (r?.data ?? []).filter((x) => !x.deleted);
  // só casa documento IGUAL (dígitos): cliente sem documento ou com outro não é "o mesmo CPF"
  const certos = todos.filter((x) => !!x.cpfCnpj && soDigitos(x.cpfCnpj) === doc);
  // o Asaas devolveu gente que não é o documento buscado: nada de adivinhar, nada de criar por cima
  if (todos.length && !certos.length) throw new ErroDeEntrada('o Asaas devolveu clientes que não batem com o CPF/CNPJ buscado: nada foi feito. Confira no painel do Asaas.');
  return certos;
}

export async function clientePorId(c: ContaAsaas, id: string): Promise<ClienteAsaas> {
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

export function mostrarCliente(x: ClienteAsaas) {
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

/** 2xx sem o id no corpo: o Asaas pode ter criado. Entra como "sem resposta" (status nulo). */
export class ErroSemId extends Error {
  readonly status = null;
}

/** O pedido pode ter chegado ao Asaas? (sem resposta ou 5xx) — aí NÃO dá para dizer que nada foi feito. */
export const podeTerGravado = (e: unknown) => {
  const status = (e as { status?: number | null })?.status;
  return status == null || status >= 500;
};

/** Erro do Asaas sem a chave, sem documento e sem e-mail, na mesma classe (entrada continua entrada). */
export function sanear(e: unknown): Error {
  const msg = limparTexto(e instanceof Error ? e.message : String(e), undefined, e instanceof ErroDeEntrada).slice(0, 400);
  return e instanceof ErroDeEntrada ? new ErroDeEntrada(msg) : new Error(msg);
}

/** A leitura (asaas_cobrancas, extrato) guarda 10 min: depois de escrever (ou de tentar) ela não pode mostrar o "antes". */
export function esquecerLeituras(asaas: ContextoAsaas, slug: string): void {
  asaas.cache.removerPrefixo(`cob|${slug}|`);
  asaas.cache.removerPrefixo(`ext|${slug}|`);
}

/** Roda `fn` até `ms`; se não vier no prazo (ou falhar), devolve null. Nunca lança. */
export async function melhorEsforco<T>(fn: () => Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const busca = fn();
    busca.catch(() => undefined);
    const prazo = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), ms);
      timer.unref?.();
    });
    return await Promise.race([busca, prazo]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- cliente

export const INSTRUCAO_AVISO_OFF = 'O Asaas NÃO vai mandar e-mail nem SMS ao cliente (cadastro com aviso desligado).';

export async function criarCliente(
  { asaas, esc }: CtxEscrita,
  quem: Quem,
  a: { unidade: string; nome: string; cpfCnpj: string; email?: string; telefone?: string; endereco?: EnderecoPedido; avisarCliente?: boolean },
  registrar: Registrar,
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const dados = prepararDadosDoCliente(a);
  const avisar = a.avisarCliente === true;
  return comAvisos(esc, c.slug, async () => {
    const { cabecalho, avisos } = await cabecalhoDaConta(c, esc);
    const base = { conta: c.slug, documento: mascararDoc(dados.cpfCnpj), pediuPor: quem.id };
    const existentes = await clientesPorDoc(c, dados.cpfCnpj);
    if (existentes.length) {
      registrar(EVENTO_CLIENTE, { ...base, jaExistia: true, clienteId: existentes[0]!.id }, true);
      return { conta: cabecalho, jaCadastrado: true, clientes: existentes.map(mostrarCliente), avisos, instrucao: `Já cadastrado: NÃO criei outro. Use o id ${existentes[0]!.id} (clienteId) para cobrar.` };
    }
    try {
      const criado = await c.escrita.enviar<ClienteAsaas>('POST', '/customers', corpoDoCliente(dados, avisar));
      if (!criado?.id) throw new ErroSemId('o Asaas respondeu ao cadastro do cliente sem o id');
      registrar(EVENTO_CLIENTE, { ...base, jaExistia: false, clienteId: criado.id, nome: abreviarNome(dados.nome), avisarCliente: avisar }, true);
      return {
        conta: cabecalho,
        cadastrado: true,
        cliente: { id: criado.id, ...mostrarDados(dados) },
        aviso: avisar ? 'cadastrado com avisos automáticos LIGADOS' : INSTRUCAO_AVISO_OFF,
        avisos,
        instrucao: `Use o id ${criado.id} (clienteId) para cobrar.`,
      };
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      registrar(EVENTO_CLIENTE, { ...base, jaExistia: false, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      throw incerto ? new Error(`${s.message} — o cadastro PODE ter sido feito: confira com asaas_cliente antes de repetir.`) : s;
    }
  });
}

// ----------------------------------------------------------------- cobrança

type Alvo = { tipo: 'existente'; cliente: ClienteAsaas } | { tipo: 'novo'; dados: DadosDoCliente };

/** Acha o cliente (por id ou por CPF/CNPJ) ou diz que será cadastrado. Mais de um cadastro com o mesmo documento: não adivinha. */
async function acharAlvo(c: ContaAsaas, p: { clienteId?: string; novo?: DadosDoCliente }): Promise<Alvo> {
  if (p.clienteId) return { tipo: 'existente', cliente: await clientePorId(c, p.clienteId) };
  const dados = p.novo!;
  const achados = await clientesPorDoc(c, dados.cpfCnpj);
  if (achados.length > 1) throw new ErroDeEntrada(`há ${achados.length} cadastros com este CPF/CNPJ no Asaas (${achados.map((x) => x.id).join(', ')}): informe qual usar em clienteId. Nada foi feito.`);
  return achados[0] ? { tipo: 'existente', cliente: achados[0] } : { tipo: 'novo', dados };
}

/** O aviso automático do Asaas é decisão: um cadastro que já existe com aviso LIGADO só recebe cobrança com avisarCliente=true. */
function decidirAviso(alvo: Alvo, avisar: boolean): { vaiAvisar: boolean; texto: string } {
  if (alvo.tipo === 'novo') return { vaiAvisar: avisar, texto: avisar ? 'O Asaas PODE mandar e-mail/SMS da cobrança ao cliente (cadastro novo com avisos ligados).' : INSTRUCAO_AVISO_OFF };
  const liga = alvo.cliente.notificationDisabled !== true;
  if (liga && !avisar) {
    throw new ErroDeEntrada(
      `o cliente ${alvo.cliente.id} já tem o aviso automático do Asaas LIGADO: a cobrança avisaria o paciente por e-mail/SMS. ` +
        'Se isso é aceitável, repita com avisarCliente=true; senão, desligue o aviso desse cliente com asaas_editar_cliente (avisarCliente=false) e repita. Nada foi feito.',
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
  /** valor TOTAL (no parcelado, a soma das parcelas) */
  valor: number;
  vencimento: string;
  descricao: string;
  externalReference?: string;
  avisarCliente?: boolean;
  /** BOLETO (padrão), PIX ou CARTAO */
  forma?: unknown;
  parcelas?: unknown;
  [campo: string]: unknown;
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
  installment?: string | null;
}

export async function criarCobranca({ asaas, esc }: CtxEscrita, quem: Quem, a: PedidoDeCobranca, registrar: Registrar) {
  recusarDadosDeCartao(a);
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const fuso = fusoDe(c);
  const forma = formaValida(a.forma);
  const parcelas = parcelasValidas(a.parcelas, forma);
  const valor = valorValido(a.valor);
  const vencimento = vencimentoValido(a.vencimento, esc.agora(), fuso);
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

  const feita = await comAvisos(esc, c.slug, async (avisarJoao) => {
    const { cabecalho, avisos } = await cabecalhoDaConta(c, esc);
    const alvo = await acharAlvo(c, { clienteId, novo });
    if (alvo.tipo === 'novo' && !a.novoCliente) {
      throw new ErroDeEntrada(`não há cliente com o documento ${mascararDoc(novo!.cpfCnpj)} nesta conta. Passe novoCliente (nome, e-mail, telefone, endereço) para cadastrar junto, ou use asaas_criar_cliente antes.`);
    }
    if (alvo.tipo === 'existente' && a.novoCliente) avisos.push('o cliente já existe: usei o cadastro existente e ignorei novoCliente');
    const aviso = decidirAviso(alvo, avisar);
    if (externalReference) {
      const emUso = await referenciaEmUso(c, externalReference);
      if (emUso) throw new ErroDeEntrada(`a externalReference "${externalReference}" já está na cobrança ${emUso}. Não criei outra.`);
    } else {
      avisos.push('sem externalReference: informe um identificador único desta cobrança (ex. o número do pedido) para a conferência de duplicata ficar mais forte');
    }
    const chavePrevia = chaveDeDuplicata(c.slug, alvo.tipo === 'existente' ? alvo.cliente.id : `novo:${alvo.dados.cpfCnpj}`, valor, vencimento, descricao, externalReference, forma, parcelas);
    const dupCobranca = { descricaoDuplicata: 'cobrança igual (mesmo cliente, valor, vencimento e descrição)', seForDeProposito: 'Se for de propósito, espere 10 minutos ou mude a descrição.' };
    await conferirTravas(esc, c, { tipo: 'cobranca', chave: chavePrevia, valor, noTeto: valor, hora: true, ...dupCobranca });
    const base = {
      conta: c.slug, valor, vencimento, forma, parcelas,
      externalReference: externalReference ? mascararDigitosSeguidos(externalReference, MIN_DIGITOS_REFERENCIA, MARCA_DOCUMENTO) : null,
      pediuPor: quem.id,
    };

    let idDoCliente: string;
    let clienteCriado = false;
    if (alvo.tipo === 'existente') idDoCliente = alvo.cliente.id;
    else {
      try {
        const criado = await c.escrita.enviar<ClienteAsaas>('POST', '/customers', corpoDoCliente(alvo.dados, avisar));
        if (!criado?.id) throw new ErroSemId('o Asaas respondeu ao cadastro do cliente sem o id');
        idDoCliente = criado.id;
        clienteCriado = true;
        registrar(EVENTO_CLIENTE, { conta: c.slug, documento: mascararDoc(alvo.dados.cpfCnpj), jaExistia: false, clienteId: idDoCliente, nome: abreviarNome(alvo.dados.nome), avisarCliente: avisar, pediuPor: quem.id, junto: 'cobranca' }, true);
      } catch (e) {
        const s = sanear(e);
        const incerto = podeTerGravado(e);
        registrar(EVENTO_CLIENTE, { conta: c.slug, documento: mascararDoc(alvo.dados.cpfCnpj), jaExistia: false, pediuPor: quem.id, junto: 'cobranca', ...(incerto ? { incerto: true } : {}) }, false, s.message);
        throw incerto
          ? new Error(`não gerei a cobrança: o cadastro do cliente ficou sem resposta e PODE ter sido feito. Confira com asaas_cliente (CPF/CNPJ) antes de repetir. (${s.message})`)
          : new ErroDeEntrada(`não cadastrei o cliente e portanto não gerei a cobrança: ${s.message}`);
      }
    }

    // a RESERVA que vale: dentro da trava da chave do Asaas, relê o banco, confere teto/duplicata/hora de novo e grava a intenção ANTES de chamar o Asaas
    // (resposta perdida, reinício ou outra instância não liberam uma 2ª). A chave usa o id do cliente (também o recém-criado): é com ela que a duplicata é achada depois
    const chaveFinal = chaveDeDuplicata(c.slug, idDoCliente, valor, vencimento, descricao, externalReference, forma, parcelas);
    let ids: { intencaoId: string; chaveAsaas: string };
    try {
      const r = await reservar(esc, c, quem, { tipo: 'cobranca', chave: chaveFinal, valor, noTeto: valor, hora: true, ...dupCobranca, evento: EVENTO_COBRANCA, argumentos: { ...base, chave: chaveFinal, clienteId: idDoCliente } });
      ids = { intencaoId: r.intencaoId, chaveAsaas: r.grupo };
    } catch (e) {
      throw new ErroDeEntrada(`${clienteCriado ? `O cliente FOI cadastrado (${idDoCliente}). ` : ''}${(e as Error).message}`);
    }
    let pag: PagamentoAsaas;
    try {
      pag = await c.escrita.enviar<PagamentoAsaas>('POST', '/payments', {
        customer: idDoCliente,
        billingType: BILLING[forma],
        dueDate: vencimento,
        description: descricao,
        ...(parcelas > 1 ? { installmentCount: parcelas, totalValue: valor } : { value: valor }),
        ...(externalReference ? { externalReference } : {}),
      });
    } catch (e) {
      const s = sanear(e);
      esquecerLeituras(asaas, c.slug);
      const incerto = podeTerGravado(e);
      // recusa definitiva do Asaas (4xx): nada foi criado, este resultado resolve a intenção SEM contar. Sem resposta ou 5xx: pode ter criado, conta.
      registrar(EVENTO_COBRANCA, { ...base, ...ids, chave: chaveFinal, clienteId: idDoCliente, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      // 5xx ou sem resposta: o Asaas pode ter criado a cobrança. Dizer "não saiu" faria a pessoa gerar outra (revisão do sênior, 30/10).
      if (incerto) {
        avisarJoao(textoDoAviso({ titulo: 'COBRANÇA COM RESULTADO INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, detalhe: 'O Asaas não confirmou: a cobrança PODE ter sido criada. Conferir no painel.' }));
        throw new Error(`${clienteCriado ? `O cliente FOI cadastrado (${idDoCliente}). ` : ''}O Asaas não confirmou a cobrança (${s.message}): ela PODE ter sido gerada. Confira com asaas_cobrancas antes de repetir.`);
      }
      throw new Error(`${clienteCriado ? `O cliente FOI cadastrado (${idDoCliente}), mas a cobrança não saiu: ` : 'A cobrança não saiu: '}${s.message}`);
    }
    esquecerLeituras(asaas, c.slug);
    if (!pag?.id) {
      // 2xx sem a cobrança no corpo: pode ter criado. Fica a reserva e o registro "incerto".
      registrar(EVENTO_COBRANCA, { ...base, ...ids, chave: chaveFinal, clienteId: idDoCliente, incerto: true }, false, 'o Asaas respondeu sem o id da cobrança');
      avisarJoao(textoDoAviso({ titulo: 'COBRANÇA COM RESULTADO INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, detalhe: 'O Asaas respondeu sem o id: a cobrança PODE ter sido criada. Conferir no painel.' }));
      throw new Error(`${clienteCriado ? `O cliente FOI cadastrado (${idDoCliente}). ` : ''}O Asaas respondeu sem o id da cobrança: ela PODE ter sido gerada. Confira com asaas_cobrancas antes de repetir.`);
    }
    // o registro que alimenta a duplicata e os tetos sai JÁ, com o id: um reinício durante a busca da linha digitável não pode escondê-lo
    registrar(EVENTO_COBRANCA, { ...base, ...ids, chave: chaveFinal, clienteId: idDoCliente, clienteCriado, cobrancaId: pag.id, status: pag.status ?? null }, true);
    // cobrança grande (mais da metade do teto por operação) avisa o João
    if (valor > esc.tetoOperacao() / 2) {
      avisarJoao(textoDoAviso({ titulo: 'COBRANÇA ACIMA DE 50% DO TETO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id: pag.id, detalhe: `${NOME_DA_FORMA[forma]}${parcelas > 1 ? ` em ${parcelas}x` : ''}, vencimento ${dataBR(vencimento)}, cliente ${idDoCliente}` }));
    }

    return {
      gerado: true,
      conta: cabecalho,
      cobranca: {
        id: pag.id,
        forma: NOME_DA_FORMA[forma],
        status: pag.status ?? null,
        valor: dinheiro(valor),
        ...(parcelas > 1 ? { parcelamento: { parcelas, idDoParcelamento: pag.installment ?? null, valorTotal: dinheiro(valor) } } : {}),
        vencimento: `${dataBR(vencimento)} (${vencimento})`,
        externalReference: externalReference ?? null,
        // cartão: este é o link em que o paciente digita o cartão (no Asaas, nunca no chat)
        linkParaPagar: pag.invoiceUrl ?? null,
        ...(forma === 'BOLETO' ? { linkDoBoleto: pag.bankSlipUrl ?? null, linhaDigitavel: pag.identificationField ?? null } : {}),
        ...(forma === 'PIX' ? { pixCopiaECola: null as string | null } : {}),
      },
      cliente: { id: idDoCliente, cadastradoAgora: clienteCriado },
      avisouOCliente: aviso.vaiAvisar,
      aviso: aviso.texto,
      avisos,
      limites: await consumoSeguro(esc, c),
      registro: 'Registrado com quem pediu.',
      // o que falta buscar DEPOIS de liberar a fila da conta (melhor esforço, até esperaLinhaMs)
      _depois: { id: pag.id, forma, temLinha: !!pag.identificationField, temLinkDoBoleto: !!pag.bankSlipUrl },
    };
  });

  // a linha digitável / o Pix copia-e-cola é melhor esforço: vem de outra rota, que pode demorar (o Asaas registra a cobrança em instantes). Fora da fila da
  // conta, para a espera não segurar as outras operações — se não vier no prazo, o link basta
  const { _depois, ...resposta } = feita;
  let atencao: string | undefined;
  if (_depois.forma === 'BOLETO') {
    if (!_depois.temLinha) {
      const linha = await melhorEsforco(() => c.fonte.get<{ identificationField?: string }>(`/payments/${_depois.id}/identificationField`).then((r) => r?.identificationField ?? null), esc.esperaLinhaMs);
      (resposta.cobranca as { linhaDigitavel?: string | null }).linhaDigitavel = linha;
    }
    if (!_depois.temLinkDoBoleto) atencao = 'o link do boleto ainda não veio (o Asaas registra o boleto em instantes): consulte com asaas_cobranca em alguns minutos';
  }
  if (_depois.forma === 'PIX') {
    const pix = await melhorEsforco(() => c.fonte.get<{ payload?: string }>(`/payments/${_depois.id}/pixQrCode`).then((r) => r?.payload ?? null), esc.esperaLinhaMs);
    (resposta.cobranca as { pixCopiaECola?: string | null }).pixCopiaECola = pix;
    if (!pix) atencao = 'o Pix copia-e-cola ainda não veio: o link para pagar já serve; consulte de novo em instantes';
  }
  return { ...resposta, ...(atencao ? { atencao } : {}) };
}

// ----------------------------------------------------------------- o que vai para a auditoria dos pedidos

/** Chave Pix digitada como destino: e-mail e chave aleatória (UUID) saem cortados, documento e telefone mascarados; apelido segue legível. */
export function mascararDestinoDoPedido(d: string): string {
  const t = d.trim();
  if (t.includes('@')) return mascararEmail(t);
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(t)) return `${t.slice(0, 8)}…`;
  return mascararDigitosSeguidos(t, 6, '[…]').slice(0, 60);
}

/** O que vai para a auditoria dos pedidos: nunca o documento, o e-mail, o telefone ou dado de cartão por inteiro. */
export function mascararPedido(entrada: Record<string, any>, conhecidos?: readonly string[]): Record<string, unknown> {
  // campo que a ferramenta não declara entra só pelo NOME (o valor pode ser um número de cartão)
  const extras = conhecidos ? Object.keys(entrada).filter((k) => !conhecidos.includes(k)) : [];
  const a = Object.fromEntries(Object.entries(entrada).filter(([k]) => !extras.includes(k)));
  const novo = a.novoCliente as { nome?: string; email?: string; telefone?: string; endereco?: unknown } | undefined;
  const { cpfCnpj, email, telefone, endereco, novoCliente, descricao, nome, externalReference, destino, contaBancaria, ...resto } = a;
  const semCartao = Object.fromEntries(Object.entries(resto).filter(([k]) => !(CAMPOS_DE_CARTAO.test(k) && k !== 'forma')));
  const tinhaCartao = Object.keys(resto).length !== Object.keys(semCartao).length;
  return {
    ...semCartao,
    ...(tinhaCartao || extras.some((k) => CAMPOS_DE_CARTAO.test(k)) ? { dadosDeCartaoRecusados: true } : {}),
    ...(extras.length ? { camposDesconhecidos: extras.slice(0, 5).map((k) => mascararDigitosSeguidos(k, 6, '[…]').slice(0, 40)) } : {}),
    ...(externalReference !== undefined ? { externalReference: mascararDigitosSeguidos(String(externalReference), MIN_DIGITOS_REFERENCIA, MARCA_DOCUMENTO) } : {}),
    ...(nome !== undefined ? { nome: abreviarNome(String(nome)) } : {}),
    ...(cpfCnpj ? { cpfCnpj: mascararDoc(String(cpfCnpj)) } : {}),
    ...(email ? { email: mascararEmail(String(email)) } : {}),
    ...(telefone ? { telefone: mascararTelefone(String(telefone)) } : {}),
    ...(endereco ? { temEndereco: true } : {}),
    // o destino (chave Pix, conta) nunca vai inteiro para o registro do pedido; o resultado registra o apelido
    ...(destino !== undefined ? { destino: mascararDestinoDoPedido(String(destino)) } : {}),
    ...(contaBancaria ? { temContaBancaria: true } : {}),
    // o texto da cobrança pode trazer o motivo do tratamento: o registro guarda só o tamanho (o texto fica no Asaas, pelo id)
    ...(descricao !== undefined ? { descricaoCaracteres: String(descricao).length } : {}),
    ...(novoCliente
      ? { novoCliente: { nome: novo?.nome ? abreviarNome(novo.nome) : undefined, ...(novo?.email ? { email: mascararEmail(novo.email) } : {}), ...(novo?.telefone ? { telefone: mascararTelefone(novo.telefone) } : {}), ...(novo?.endereco ? { temEndereco: true } : {}) } }
      : {}),
  };
}
