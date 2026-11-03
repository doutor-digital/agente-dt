/**
 * As travas AUTOMÁTICAS da escrita do Asaas (nenhuma pede confirmação de ninguém):
 *   - teto por operação e teto por dia e CHAVE do Asaas (soma de cobranças criadas + estornos + transferências), no fuso da clínica,
 *     mais teto próprio de estorno e de transferência (vale o menor);
 *   - lista de destinos permitidos para transferência (ASAAS_TRANSFERENCIA_DESTINOS), por conta;
 *   - o porteiro: lê o banco e grava a intenção numa trava única por chave do Asaas, para as instâncias do servidor não se atropelarem.
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
/**
 * Padrões dos tetos. Geral: 5000 por operação e 20000 por dia. Estorno e transferência têm teto PRÓPRIO (500 por operação e 2000 por dia) porque
 * são o caminho de uma injeção de texto virar dinheiro saindo; vale o MENOR entre o específico e o geral. O João sobe por variável de ambiente.
 */
export const CANCELAMENTOS_POR_HORA_PADRAO = 10;
export const PADRAO_TETOS = { operacaoReais: 5000, diaReais: 20000, saidaOperacaoReais: 500, saidaDiaReais: 2000 };
export const JANELA_LIVRO_MS = 36 * 3_600_000;

const positivo = (bruto: string | undefined): number | null => {
  const t = bruto?.trim();
  if (!t) return null;
  // formato brasileiro também vale: "20.000" é vinte mil (não 20) e "1.500,50" é mil e quinhentos e cinquenta centavos
  const normal = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : /^\d+,\d{1,2}$/.test(t) ? t.replace(',', '.') : t;
  const n = Number(normal);
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

/** ASAAS_TETO_DIA_REAIS (padrão 20000): cobranças criadas + estornos + transferências, por chave do Asaas e por dia no fuso da clínica. */
export function tetoPorDia(e: NodeJS.ProcessEnv = process.env): number {
  return positivo(e.ASAAS_TETO_DIA_REAIS) ?? PADRAO_TETOS.diaReais;
}

export type TipoDeSaida = 'estorno' | 'transferencia';

export interface TetoEspecifico {
  operacao: number;
  dia: number;
}

const VARIAVEIS_DA_SAIDA: Record<TipoDeSaida, { operacao: string; dia: string; nome: string }> = {
  estorno: { operacao: 'ASAAS_TETO_ESTORNO_OPERACAO_REAIS', dia: 'ASAAS_TETO_ESTORNO_DIA_REAIS', nome: 'estorno' },
  transferencia: { operacao: 'ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS', dia: 'ASAAS_TETO_TRANSFERENCIA_DIA_REAIS', nome: 'transferência' },
};

/**
 * Teto PRÓPRIO do estorno e da transferência (por operação e por dia, só da soma daquele tipo): ASAAS_TETO_ESTORNO_OPERACAO_REAIS /
 * ASAAS_TETO_ESTORNO_DIA_REAIS e ASAAS_TETO_TRANSFERENCIA_OPERACAO_REAIS / ASAAS_TETO_TRANSFERENCIA_DIA_REAIS. Padrão 500 e 2000.
 * Vazio, 0 ou lixo = o padrão (nunca ilimitado). O que vale na prática é o MENOR entre este e o geral.
 */
export function tetoEspecificoDe(tipo: TipoDeSaida, e: NodeJS.ProcessEnv = process.env): TetoEspecifico {
  const v = VARIAVEIS_DA_SAIDA[tipo];
  return { operacao: positivo(e[v.operacao]) ?? PADRAO_TETOS.saidaOperacaoReais, dia: positivo(e[v.dia]) ?? PADRAO_TETOS.saidaDiaReais };
}

/** ASAAS_CANCELAMENTOS_POR_HORA (padrão 10, por chave do Asaas): vazio, 0 ou lixo = o padrão. Cancelar é irreversível e não gasta teto de valor, então ganha teto de QUANTIDADE. */
export function cancelamentosPorHora(e: NodeJS.ProcessEnv = process.env): number {
  const n = positivo(e.ASAAS_CANCELAMENTOS_POR_HORA);
  return n !== null && Number.isInteger(n) ? n : CANCELAMENTOS_POR_HORA_PADRAO;
}

// ----------------------------------------------------------------- dinheiro e dia

export const dinheiro = (n: number) => `R$ ${new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;
const centavos = (n: number) => Math.round(n * 100);
export const arredondar = (n: number) => Math.round(n * 100) / 100;

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

// ----------------------------------------------------------------- o livro e o porteiro

export type TipoDeLancamento = 'cobranca' | 'estorno' | 'transferencia' | 'edicao' | 'cancelamento';

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
  /** a intenção gravada antes da chamada e o resultado dela têm o mesmo id */
  intencaoId?: string;
}

/**
 * As operações das últimas 36 h da chave do Asaas, LIDAS DO BANCO naquele instante (ver `Porteiro`). Só calcula; não guarda estado.
 */
export class Livro {
  constructor(private itens: Lancamento[] = []) {}

  /** Quanto já conta para o teto do dia (de um tipo só, se pedido), no fuso da clínica. */
  somaDoDia(agora: number, fuso: string, tipo?: TipoDeLancamento): number {
    const hoje = diaLocal(agora, fuso);
    const cents = this.itens.filter((x) => (!tipo || x.tipo === tipo) && diaLocal(x.em, fuso) === hoje).reduce((s, x) => s + centavos(x.noTeto), 0);
    return cents / 100;
  }

  cobrancasNaHora(agora: number, horaMs: number): number {
    return this.itens.filter((x) => x.tipo === 'cobranca' && agora - x.em < horaMs).length;
  }

  /** cancelamentos feitos na última hora (o DELETE é irreversível: tem limite de quantidade, já que não gasta teto de valor) */
  cancelamentosNaHora(agora: number, horaMs: number): number {
    return this.itens.filter((x) => x.tipo === 'cancelamento' && agora - x.em < horaMs).length;
  }

  igual(chave: string, agora: number, janelaMs: number): Lancamento | undefined {
    return this.itens.find((x) => x.chave === chave && agora - x.em < janelaMs);
  }
}

export interface PedidoDeReserva {
  /** a chave do Asaas (impressão curta, nunca a chave): contas que usam a mesma chave dividem os tetos e a trava */
  grupo: string;
  conta: string;
  /** recebe o livro lido DENTRO da trava; lança ErroDeEntrada para recusar */
  conferir(livro: Livro): void;
  agora: number;
  /** o evento de intenção (a ferramenta registrada na auditoria e os argumentos, sem dado pessoal); o porteiro acrescenta conta, grupo e intencaoId */
  evento: string;
  argumentos: Record<string, unknown>;
  quem: { userId: string; clientId?: string };
}

/**
 * Quem protege o dinheiro entre instâncias do servidor. `reservar` faz, numa trava única por chave do Asaas (em produção uma transação
 * com pg_advisory_xact_lock): (1) lê do banco as operações recentes, (2) deixa `conferir` recusar (teto por operação, teto do dia,
 * duplicata, limite por hora) e (3) grava a INTENÇÃO no mesmo banco, antes de qualquer chamada ao Asaas. Duas instâncias nunca passam
 * as duas pelo mesmo saldo do teto, e uma intenção sem resultado conta como "pode ter acontecido" (reinício no meio da chamada).
 * Se o banco não responde, nada sai.
 */
export interface Porteiro {
  reservar(p: PedidoDeReserva): Promise<{ intencaoId: string }>;
  /** leitura sem trava (consulta e conferência prévia): o que vale é a leitura feita dentro de `reservar` */
  ler(grupo: string, conta: string, agora: number): Promise<Livro>;
}

export const FALHA_DO_BANCO = 'não consegui conferir nem registrar a operação no banco (tetos e duplicata) — nada foi feito; tente em instantes';

/** Recusa a operação que passa de algum teto. `noTeto` é o que ela soma ao dia; `tipo` escolhe o teto próprio (estorno/transferência). */
export function conferirTetos(o: {
  livro: Livro;
  fuso: string;
  agora: number;
  valor: number;
  noTeto: number;
  tetoOperacao: number;
  tetoDia: number;
  /** estorno/transferência: o teto próprio (o que vale é o menor com o geral) */
  saida?: { tipo: TipoDeSaida; teto: TetoEspecifico };
}): void {
  if (o.tetoOperacao <= 0) {
    throw new ErroDeEntrada('o dinheiro pelo conector está DESLIGADO nesta conta: ASAAS_COBRANCA_MAX_REAIS (nome antigo) está em 0 ou inválido. Apague a variável ou use ASAAS_TETO_OPERACAO_REAIS com o teto por operação. Nada foi feito.');
  }
  if (o.valor > o.tetoOperacao) {
    throw new ErroDeEntrada(
      `${dinheiro(o.valor)} passa do teto de ${dinheiro(o.tetoOperacao)} por operação (ASAAS_TETO_OPERACAO_REAIS): faça esta no painel do Asaas. Para subir o teto, o João muda ASAAS_TETO_OPERACAO_REAIS no servidor. Nada foi feito.`,
    );
  }
  if (o.saida) {
    const v = VARIAVEIS_DA_SAIDA[o.saida.tipo];
    if (o.valor > o.saida.teto.operacao) {
      throw new ErroDeEntrada(`${dinheiro(o.valor)} passa do teto de ${dinheiro(o.saida.teto.operacao)} por ${v.nome} (${v.operacao}): faça esta no painel do Asaas. Para subir o teto, o João muda ${v.operacao} no servidor. Nada foi feito.`);
    }
    const doTipo = o.livro.somaDoDia(o.agora, o.fuso, o.saida.tipo);
    const tetoDoTipo = Math.min(o.saida.teto.dia, o.tetoDia);
    if (centavos(doTipo) + centavos(o.noTeto) > centavos(tetoDoTipo)) {
      throw new ErroDeEntrada(
        `passa do teto do dia para ${v.nome}: já foram ${dinheiro(doTipo)} hoje em ${v.nome} e esta soma ${dinheiro(o.noTeto)}, para um teto de ${dinheiro(tetoDoTipo)} (${v.dia}). ` +
          `Tente amanhã, faça no painel do Asaas, ou o João sobe ${v.dia} no servidor. Nada foi feito.`,
      );
    }
  }
  const hoje = o.livro.somaDoDia(o.agora, o.fuso);
  if (centavos(hoje) + centavos(o.noTeto) > centavos(o.tetoDia)) {
    throw new ErroDeEntrada(
      `passa do teto do dia desta chave do Asaas: já foram ${dinheiro(hoje)} hoje (cobranças criadas + estornos + transferências) e esta soma ${dinheiro(o.noTeto)}, para um teto de ${dinheiro(o.tetoDia)}. ` +
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
      // banco, agência, conta e dígito: SÓ dígitos, como estão. "1234-5" não vira 12345 (seria outra conta): o dígito vai em conta_digito
      const banco = texto(r.banco);
      const agencia = texto(r.agencia);
      const conta = texto(r.conta);
      const digito = texto(r.conta_digito);
      const titular = texto(r.titular);
      if (!/^\d{1,4}$/.test(banco) || !/^\d{1,6}$/.test(agencia) || !/^\d{1,12}$/.test(conta) || (digito && !/^\d{1,2}$/.test(digito))) {
        return falha('banco, agencia, conta e conta_digito precisam ser só números (sem hífen nem ponto; o dígito da conta vai em conta_digito e agência com dígito não é aceita)');
      }
      if (!docOk || !titular) return falha('titular e documento (CPF/CNPJ válido) do titular são obrigatórios');
      const nascimento = texto(r.nascimento);
      if (nascimento && !/^\d{4}-\d{2}-\d{2}$/.test(nascimento)) return falha('nascimento no formato AAAA-MM-DD');
      const poupanca = /poup/i.test(texto(r.tipo_conta));
      d = { via: 'conta', apelido, nome, banco, agencia, conta, digito, tipoConta: poupanca ? 'CONTA_POUPANCA' : 'CONTA_CORRENTE', titular, documento: doc, ...(nascimento ? { nascimento } : {}) };
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
    const [banco, agencia, conta, digito] = [cb.banco, cb.agencia, cb.conta, cb.digito].map((v) => String(v ?? '').trim());
    // só dígitos, como estão: "1234-5" nunca vira "12345" (poderia ser outra conta da lista)
    if ([banco, agencia, conta, digito].some((v) => v && !/^\d+$/.test(v!))) throw new ErroDeEntrada('contaBancaria: banco, agencia, conta e digito só com números (sem hífen nem ponto). Nada foi feito.');
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
