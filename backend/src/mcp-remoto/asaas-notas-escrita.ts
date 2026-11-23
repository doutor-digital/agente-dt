/**
 * Nota fiscal de serviço (NFS-e) do Asaas pelo claude.ai: EMITIR e CANCELAR, em DOIS passos (diferente do resto da escrita do Asaas, que é
 * direta). Emitir mexe no fiscal da clínica e o cancelamento depende do prazo e das regras da prefeitura; por isso:
 *
 *   asaas_preparar_nota  → confere tudo, NÃO chama o Asaas para escrever, mostra o resumo COMPLETO e devolve um código;
 *   asaas_confirmar_nota → com o código (uso único, 15 min, só quem preparou) é que chama o Asaas: POST /v3/invoices (e …/authorize se for
 *                          emitir já) ou POST /v3/invoices/{id}/cancel.
 *
 * Regras que não se negociam aqui:
 *   - NUNCA inventar alíquota nem serviço: ISS vem da prefeitura (serviço municipal) ou da pessoa; retenção de ISS, INSS e IR só da pessoa;
 *     PIS/COFINS/CSLL só da pessoa, ou 0 se a clínica é do Simples Nacional (não se aplicam nesse regime). Faltou? Recusa e diz o quê.
 *   - Clínica sem dado fiscal no Asaas: recusa em português, sem erro cru da API.
 *   - Nota repetida da mesma cobrança: AVISA no preparar, e o confirmar recusa se aparecer nota NOVA depois do resumo.
 *   - Mesma permissão e mesmas travas de conta da escrita do Asaas (`contaDeEscrita`: lista de quem escreve, ASAAS_ESCRITA_UNIDADES, uma clínica).
 *   - Cada emissão e cada cancelamento: registro (a intenção ANTES de chamar o Asaas, o resultado depois) e aviso no Telegram.
 *
 * Não existe aqui: editar nota (PUT), cancelar só no Asaas (`cancelOnlyOnAsaas`), campos da Reforma Tributária de imóveis, nota de parcelamento.
 */
import { ErroDeEntrada, somarDias, validarData } from '../franquia-mcp/travas.js';
import { dinheiro, diaLocal, textoDoAviso } from './asaas-limites.js';
import {
  cabecalhoDaConta, clientePorId, comAvisos, contaDeEscrita, dataBR, descricaoValida, ErroSemId, fusoDe, mascararDoc, mascararEmail, melhorEsforco, podeTerGravado, sanear, valorValido,
  type ClienteAsaas, type CtxEscrita, type Quem, type Registrar,
} from './asaas-escrita.js';
import {
  acharServicoMunicipal, idDaNota, lerDadosFiscais, mostrarNota, notaVale, prefeituraCancelaPelaApi, SEM_DADO_FISCAL, STATUS_NOTA, type NotaAsaas, type ServicoMunicipal,
} from './asaas-notas.js';
import { paginar, type ContaAsaas, type ContextoAsaas } from './asaas.js';

export const EVENTO_NOTA = 'asaas_nota_gravada';
/** Quantos dias à frente a data de emissão pode ficar (nota agendada). */
export const MAX_DIAS_EMISSAO = 90;

const httpStatus = (e: unknown) => (e as { status?: number | null })?.status;
const pct = (n: number) => `${String(n).replace('.', ',')}%`;

export interface ImpostosPedidos {
  retemIss?: boolean;
  iss?: number;
  pis?: number;
  cofins?: number;
  csll?: number;
  inss?: number;
  ir?: number;
}

export interface PedidoDePreparo {
  unidade: string;
  acao: 'emitir' | 'cancelar';
  // emitir
  cobrancaId?: string;
  clienteId?: string;
  valor?: number;
  deducoes?: number;
  servico?: string;
  nomeDoServico?: string;
  descricao?: string;
  observacoes?: string;
  dataEmissao?: string;
  emitirAgora?: boolean;
  impostos?: ImpostosPedidos;
  // cancelar
  notaId?: string;
}

// ----------------------------------------------------------------- leituras de apoio

interface Pagamento {
  id: string;
  customer?: string;
  value?: number;
  status?: string;
  description?: string | null;
  deleted?: boolean;
  installment?: string | null;
}

async function pagamentoPorId(c: ContaAsaas, id: string): Promise<Pagamento> {
  if (!/^pay_[A-Za-z0-9]{6,40}$/.test(id)) throw new ErroDeEntrada('cobrancaId inválido (esperado algo como pay_080225913252; veja o id em asaas_cobrancas)');
  let p: Pagamento | null;
  try {
    p = await c.fonte.get<Pagamento>(`/payments/${id}`);
  } catch (e) {
    if (httpStatus(e) === 404) throw new ErroDeEntrada(`a cobrança ${id} não existe nesta conta do Asaas`);
    throw e;
  }
  if (!p?.id || p.deleted || p.status === 'DELETED') throw new ErroDeEntrada(`a cobrança ${id} não existe (ou foi excluída) nesta conta do Asaas: não há o que faturar`);
  return p;
}

async function notaPorId(c: ContaAsaas, id: string): Promise<NotaAsaas> {
  let n: NotaAsaas | null;
  try {
    n = await c.fonte.get<NotaAsaas>(`/invoices/${id}`);
  } catch (e) {
    if (httpStatus(e) === 404) throw new ErroDeEntrada(`a nota ${id} não existe nesta conta do Asaas`);
    throw e;
  }
  if (!n?.id) throw new ErroDeEntrada(`a nota ${id} não existe nesta conta do Asaas`);
  return n;
}

type Origem = { tipo: 'cobranca' | 'cliente'; id: string };

/**
 * As notas que JÁ existem e valem (tudo menos cancelada e com erro; nota de cancelamento negado continua valendo) para esta origem: da cobrança,
 * todas; do cliente (nota avulsa), as do mesmo valor com a mesma data de emissão (conferida aqui também, não só pelo filtro do Asaas). Lê todas as
 * páginas. Quem não consegue conferir não emite: nota repetida é problema fiscal.
 */
export async function notasAtivasDaOrigem(ctx: ContextoAsaas, c: ContaAsaas, origem: Origem, valor: number, dataEmissao: string): Promise<NotaAsaas[]> {
  const q = origem.tipo === 'cobranca' ? { payment: origem.id } : { customer: origem.id, 'effectiveDate[Ge]': dataEmissao, 'effectiveDate[Le]': dataEmissao };
  let lidas: { itens: NotaAsaas[]; truncado: boolean };
  try {
    lidas = await paginar<NotaAsaas>(ctx, c, '/invoices', q);
  } catch (e) {
    if (httpStatus(e) === 401) throw e;
    throw new ErroDeEntrada('não consegui conferir se já existe nota desta origem (o Asaas não respondeu à listagem): por segurança nada foi feito; tente em instantes');
  }
  if (lidas.truncado) throw new ErroDeEntrada('esta origem tem notas demais para eu conferir se já existe uma igual: por segurança nada foi feito. Confira no painel do Asaas.');
  const ativas = lidas.itens.filter((n) => notaVale(n.status));
  return origem.tipo === 'cobranca' ? ativas : ativas.filter((n) => n.effectiveDate === dataEmissao && Math.round((Number(n.value) || 0) * 100) === Math.round(valor * 100));
}

// ----------------------------------------------------------------- validação do pedido

function percentual(v: unknown, nome: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw new ErroDeEntrada(`${nome}: informe a alíquota em %, um número de 0 a 100 (ex. 2 ou 2.5)`);
  if (Math.abs(Math.round(v * 10_000) / 10_000 - v) > 1e-9) throw new ErroDeEntrada(`${nome}: no máximo 4 casas decimais`);
  return v;
}

function dataDeEmissao(a: PedidoDePreparo, hoje: string): { data: string; emitirAgora: boolean } {
  const agora = a.emitirAgora === true;
  if (a.dataEmissao === undefined || a.dataEmissao === '') {
    if (agora) return { data: hoje, emitirAgora: true };
    throw new ErroDeEntrada('informe a data de emissão (dataEmissao, AAAA-MM-DD) para AGENDAR a nota, ou emitirAgora=true para emitir hoje');
  }
  const d = validarData(String(a.dataEmissao), 'dataEmissao');
  if (agora && d !== hoje) throw new ErroDeEntrada(`emitirAgora emite HOJE (${dataBR(hoje)}); a dataEmissao pedida é ${dataBR(d)}. Use só uma das duas`);
  if (d < hoje) throw new ErroDeEntrada(`data de emissão ${dataBR(d)} já passou (hoje é ${dataBR(hoje)}): nota não se emite para trás`);
  const limite = somarDias(hoje, MAX_DIAS_EMISSAO);
  if (d > limite) throw new ErroDeEntrada(`data de emissão ${dataBR(d)} passa de ${MAX_DIAS_EMISSAO} dias (limite ${dataBR(limite)})`);
  return { data: d, emitirAgora: agora };
}

interface ImpostosDefinidos {
  taxes: Record<string, unknown>;
  /** cada imposto com o valor e DE ONDE ele veio (para a pessoa conferir antes de aprovar) */
  mostrar: Record<string, { valor: string; origem: string }>;
  avisos: string[];
}

/** Monta o `taxes` do Asaas SÓ com o que a pessoa informou ou o que o cadastro da clínica/da prefeitura determina. Faltou: recusa e diz o quê. */
function definirImpostos(p: ImpostosPedidos, servico: ServicoMunicipal | null, simples: boolean | null): ImpostosDefinidos {
  const faltam: string[] = [];
  const avisos: string[] = [];
  const mostrar: ImpostosDefinidos['mostrar'] = {};
  const taxes: Record<string, unknown> = {};
  const informado = 'informado por quem pediu';

  if (typeof p.retemIss !== 'boolean') faltam.push('retemIss (o tomador retém o ISS? sim ou não)');
  else {
    taxes.retainIss = p.retemIss;
    mostrar.retemIss = { valor: p.retemIss ? 'sim' : 'não', origem: informado };
  }

  const issDaPrefeitura = servico?.iss ?? null;
  if (p.iss !== undefined) {
    const v = percentual(p.iss, 'iss');
    taxes.iss = v;
    mostrar.iss = { valor: pct(v), origem: informado };
    if (issDaPrefeitura !== null && Math.abs(issDaPrefeitura - v) > 1e-9) avisos.push(`o ISS informado (${pct(v)}) é DIFERENTE da alíquota cadastrada na prefeitura para este serviço (${pct(issDaPrefeitura)}): confira antes de aprovar`);
  } else if (issDaPrefeitura !== null) {
    taxes.iss = issDaPrefeitura;
    mostrar.iss = { valor: pct(issDaPrefeitura), origem: 'cadastro do serviço na prefeitura (Asaas)' };
  } else faltam.push('iss (alíquota do ISS em %; a prefeitura desta conta não informa)');

  for (const [chave, rotulo] of [['inss', 'INSS'], ['ir', 'IR']] as const) {
    if (p[chave] === undefined) faltam.push(`${chave} (alíquota de ${rotulo} em %; se não há retenção, informe 0)`);
    else {
      const v = percentual(p[chave], chave);
      taxes[chave] = v;
      mostrar[chave] = { valor: pct(v), origem: informado };
    }
  }

  for (const [chave, rotulo] of [['pis', 'PIS'], ['cofins', 'COFINS'], ['csll', 'CSLL']] as const) {
    if (p[chave] !== undefined) {
      const v = percentual(p[chave], chave);
      if (simples === true && v !== 0) throw new ErroDeEntrada(`${rotulo}: a clínica é do Simples Nacional, regime em que ${rotulo} não se aplica: informe 0 ou deixe de fora. Nada foi preparado.`);
      taxes[chave] = v;
      mostrar[chave] = { valor: pct(v), origem: informado };
    } else if (simples === true) {
      taxes[chave] = 0;
      mostrar[chave] = { valor: pct(0), origem: 'Simples Nacional (cadastro fiscal da clínica): sem PIS/COFINS/CSLL' };
    } else faltam.push(`${chave} (alíquota de ${rotulo} em %; a clínica ${simples === false ? 'não é do Simples Nacional' : 'não tem o regime identificado no cadastro fiscal'}, então não dá para presumir 0)`);
  }

  if (faltam.length) {
    throw new ErroDeEntrada(
      `faltam dados fiscais que eu NÃO posso supor: ${faltam.join('; ')}. Pergunte à pessoa (ou à contabilidade da clínica) e prepare de novo, dentro de "impostos". Nada foi preparado.`,
    );
  }
  return { taxes, mostrar, avisos };
}

// ----------------------------------------------------------------- preparar

export async function prepararNota({ asaas, esc }: CtxEscrita, quem: Quem, a: PedidoDePreparo) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  return a.acao === 'cancelar' ? prepararCancelamento({ asaas, esc }, c, quem, a) : prepararEmissao({ asaas, esc }, c, quem, a);
}

type Conta = ReturnType<typeof contaDeEscrita>;

async function prepararEmissao({ asaas, esc }: CtxEscrita, c: Conta, quem: Quem, a: PedidoDePreparo) {
  if (a.notaId !== undefined) throw new ErroDeEntrada('notaId é só para cancelar; para emitir informe cobrancaId OU clienteId');
  if (!!a.cobrancaId === !!a.clienteId) throw new ErroDeEntrada('informe de onde sai a nota: cobrancaId (pay_…) OU clienteId (cus_…, nota avulsa), um dos dois');

  // 1. a clínica pode emitir? sem dado fiscal, nem começa
  const dados = await lerDadosFiscais(c);
  if (!dados) throw new ErroDeEntrada(SEM_DADO_FISCAL);
  const { cabecalho, avisos: avisosDaConta } = await cabecalhoDaConta(c, esc);
  const avisos: string[] = [...avisosDaConta];
  if (!dados.acessoDaPrefeitura.certificado && !dados.acessoDaPrefeitura.senha && !dados.acessoDaPrefeitura.token) {
    avisos.push('nenhum acesso à prefeitura (certificado, senha ou token) consta como enviado no cadastro fiscal: o Asaas pode recusar a emissão');
  }

  // 2. de onde sai a nota e quem é o tomador
  let origem: Origem;
  let tomador: ClienteAsaas;
  let valorBase: number | undefined;
  let descricaoBase: string | undefined;
  let aCobranca: Pagamento | undefined;
  if (a.cobrancaId) {
    aCobranca = await pagamentoPorId(c, a.cobrancaId.trim());
    origem = { tipo: 'cobranca', id: aCobranca.id };
    if (!aCobranca.customer) throw new ErroDeEntrada(`a cobrança ${aCobranca.id} não tem cliente no Asaas: não há tomador para a nota`);
    tomador = await clientePorId(c, aCobranca.customer);
    valorBase = Number(aCobranca.value);
    descricaoBase = aCobranca.description ?? undefined;
    if (aCobranca.status === 'REFUNDED' || aCobranca.status === 'REFUND_REQUESTED' || aCobranca.status === 'REFUND_IN_PROGRESS') avisos.push(`a cobrança está "${aCobranca.status}": confirme com a pessoa que a nota deve sair mesmo assim`);
    if (aCobranca.installment) avisos.push('esta cobrança é uma parcela de um parcelamento: a nota sai só para o valor informado aqui, não para o parcelamento inteiro');
  } else {
    tomador = await clientePorId(c, a.clienteId!.trim());
    origem = { tipo: 'cliente', id: tomador.id };
  }
  if (!tomador.cpfCnpj) avisos.push('o tomador não tem CPF/CNPJ no cadastro do Asaas: a prefeitura costuma recusar nota sem documento do tomador');
  if (!tomador.address || !tomador.postalCode) avisos.push('o cadastro do tomador não tem endereço completo no Asaas: algumas prefeituras exigem');

  // 3. valores e textos
  const valor = a.valor !== undefined ? valorValido(a.valor) : valorBase !== undefined && Number.isFinite(valorBase) ? valorValido(valorBase) : undefined;
  if (valor === undefined) throw new ErroDeEntrada('informe o valor da nota (valor, em reais): nota avulsa não tem cobrança de onde copiar');
  if (a.valor !== undefined && valorBase !== undefined && Math.round(valor * 100) !== Math.round(valorBase * 100)) {
    avisos.push(`o valor da nota (${dinheiro(valor)}) é DIFERENTE do valor da cobrança (${dinheiro(valorBase)})`);
  }
  const deducoes = a.deducoes === undefined || a.deducoes === 0 ? 0 : valorValido(a.deducoes);
  if (deducoes >= valor) throw new ErroDeEntrada(`as deduções (${dinheiro(deducoes)}) precisam ser menores que o valor da nota (${dinheiro(valor)})`);
  const textoDaDescricao = a.descricao ?? descricaoBase;
  if (!textoDaDescricao?.trim()) throw new ErroDeEntrada('informe a descrição dos serviços (descricao): é o texto que sai na nota fiscal');
  let descricao: string;
  try {
    descricao = descricaoValida(textoDaDescricao);
  } catch (e) {
    throw a.descricao === undefined ? new ErroDeEntrada(`a descrição da cobrança não serve para a nota (${(e as Error).message}). Informe a descrição dos serviços em "descricao".`) : e;
  }
  const observacoes = a.observacoes?.trim() ? descricaoValida(a.observacoes) : '';
  const hoje = diaLocal(esc.agora(), fusoDe(c));
  const emissao = dataDeEmissao(a, hoje);

  // 4. serviço municipal: o da lista da prefeitura, ou o código informado à mão quando não há lista. Nunca um palpite.
  if (!a.servico?.trim()) throw new ErroDeEntrada('informe o serviço municipal (servico): o id, o código ou parte do nome. Veja as opções com asaas_dados_fiscais');
  const achado = await acharServicoMunicipal(asaas, c, a.servico);
  let servicoNoCorpo: Record<string, unknown>;
  let servicoMostrado: Record<string, unknown>;
  if (achado) {
    servicoNoCorpo = { municipalServiceId: achado.id, municipalServiceName: achado.descricao };
    servicoMostrado = { id: achado.id, descricao: achado.descricao, issCadastradoNaPrefeitura: achado.iss === null ? null : pct(achado.iss), origem: 'lista de serviços da prefeitura (Asaas)' };
  } else {
    const codigo = a.servico.trim();
    if (!/^[0-9][0-9.]{0,15}$/.test(codigo)) {
      throw new ErroDeEntrada('esta conta não tem a lista de serviços municipais (prefeitura ou Portal Nacional): em "servico" informe o CÓDIGO do serviço (só números e pontos, ex. 4.01) e, se quiser, o nome em "nomeDoServico". Nada foi preparado.');
    }
    const nome = a.nomeDoServico?.trim() || codigo;
    servicoNoCorpo = { municipalServiceCode: codigo, municipalServiceName: nome };
    servicoMostrado = { codigo, nome, origem: 'código informado por quem pediu (esta conta não tem lista da prefeitura)' };
  }

  // 5. impostos: só o que veio da pessoa ou do cadastro; nunca inventado
  const imp = definirImpostos(a.impostos ?? {}, achado, dados.simplesNacional);
  avisos.push(...imp.avisos);

  // 6. nota repetida?
  const jaExistem = await notasAtivasDaOrigem(asaas, c, origem, valor, emissao.data);
  if (jaExistem.length) {
    const quais = jaExistem.map((n) => `${n.id} (${STATUS_NOTA[n.status ?? ''] ?? n.status}${n.number ? `, nº ${n.number}` : ''}, ${dinheiro(Number(n.value) || 0)}, emissão ${n.effectiveDate ? dataBR(n.effectiveDate) : '?'})`).join('; ');
    avisos.unshift(`ATENÇÃO, NOTA REPETIDA: ${origem.tipo === 'cobranca' ? 'esta cobrança' : 'este cliente, neste valor e nesta data,'} JÁ TEM nota fiscal ativa: ${quais}. Emitir de novo gera uma SEGUNDA nota. Só confirme se a pessoa quer isso mesmo.`);
  }

  const corpo: Record<string, unknown> = {
    ...(origem.tipo === 'cobranca' ? { payment: origem.id } : { customer: origem.id }),
    serviceDescription: descricao,
    observations: observacoes,
    value: valor,
    deductions: deducoes,
    effectiveDate: emissao.data,
    ...servicoNoCorpo,
    taxes: imp.taxes,
  };
  const resumo = {
    acao: 'EMITIR nota fiscal de serviço (NFS-e)',
    clinica: cabecalho,
    regimeDaClinica: dados.simplesNacional === true ? 'Simples Nacional' : dados.simplesNacional === false ? 'regime normal (fora do Simples Nacional)' : 'não identificado no cadastro fiscal',
    tomador: {
      id: tomador.id,
      nome: tomador.name ?? null,
      documento: tomador.cpfCnpj ? mascararDoc(tomador.cpfCnpj) : null,
      ...(tomador.email ? { email: mascararEmail(tomador.email) } : {}),
      enderecoCadastrado: !!(tomador.address && tomador.postalCode),
    },
    origem: origem.tipo === 'cobranca' ? { cobranca: origem.id, valorDaCobranca: valorBase ?? null, statusDaCobranca: aCobranca?.status ?? null } : { notaAvulsaParaOCliente: origem.id },
    valorDaNota: dinheiro(valor),
    deducoes: dinheiro(deducoes),
    baseDeCalculoDoIss: dinheiro(valor - deducoes),
    servicoMunicipal: servicoMostrado,
    impostos: imp.mostrar,
    descricaoDosServicos: descricao,
    observacoes: observacoes || null,
    dataDeEmissao: dataBR(emissao.data),
    quandoSai: emissao.emitirAgora
      ? 'AGORA: o Asaas agenda a nota e já pede a emissão à prefeitura; a prefeitura pode levar alguns minutos para autorizar'
      : `AGENDADA: o Asaas emite sozinho em ${dataBR(emissao.data)} (até lá a nota pode ser cancelada)`,
  };
  const { codigo, expiraEm } = esc.notas.guardar({
    usuario: quem.id, unidade: c.slug, acao: 'emitir', resumo, corpo, emitirAgora: emissao.emitirAgora, origem, valor, dataEmissao: emissao.data, jaExistiam: jaExistem.map((n) => n.id),
  });
  return {
    unidade: c.slug,
    acao: 'emitir',
    resumo,
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `NADA foi emitido nem gravado no Asaas ainda. Mostre o resumo COMPLETO e os avisos à pessoa e, só se ela aprovar, chame asaas_confirmar_nota com confirmacao="${codigo}" (vale 15 minutos, uma vez, só para você).`,
  };
}

const CANCELAVEIS = new Set(['AUTHORIZED', 'SCHEDULED']);
const POR_QUE_NAO_CANCELA: Record<string, string> = {
  SYNCHRONIZED: 'está sendo enviada à prefeitura: espere o resultado (asaas_nota) antes de cancelar',
  PROCESSING_CANCELLATION: 'já está com o cancelamento em andamento: espere a resposta da prefeitura (asaas_nota)',
  CANCELED: 'já está cancelada',
  CANCELLATION_DENIED: 'teve o cancelamento NEGADO pela prefeitura: pedir de novo costuma dar o mesmo resultado; o caminho é o portal da prefeitura',
  ERROR: 'deu erro na emissão: ela não foi emitida, então não há o que cancelar',
};

async function prepararCancelamento({ esc }: CtxEscrita, c: Conta, quem: Quem, a: PedidoDePreparo) {
  const extras = (['cobrancaId', 'clienteId', 'valor', 'deducoes', 'servico', 'nomeDoServico', 'descricao', 'observacoes', 'dataEmissao', 'emitirAgora', 'impostos'] as const).filter((k) => a[k] !== undefined);
  if (extras.length) throw new ErroDeEntrada(`para cancelar informe só a notaId; estes campos são de emissão e não valem aqui: ${extras.join(', ')}`);
  const id = idDaNota(a.notaId);
  const { cabecalho, avisos: avisosDaConta } = await cabecalhoDaConta(c, esc);
  const nota = await notaPorId(c, id);
  const status = nota.status ?? '';
  if (!CANCELAVEIS.has(status)) {
    throw new ErroDeEntrada(`a nota ${id} ${POR_QUE_NAO_CANCELA[status] ?? `está com o status "${status || 'desconhecido'}", que não permite cancelar`}. Nada foi preparado.`);
  }
  const avisos: string[] = [...avisosDaConta];
  const cancelaPelaApi = status === 'AUTHORIZED' ? await prefeituraCancelaPelaApi(c) : null;
  if (cancelaPelaApi === false) avisos.push('a prefeitura desta conta NÃO aceita cancelamento automático pela integração: o Asaas deve recusar, e o cancelamento terá de ser feito no portal da prefeitura');
  if (status === 'AUTHORIZED') {
    avisos.push('nota JÁ EMITIDA: o cancelamento depende das regras e do prazo da prefeitura; pode ficar "em processamento" e ser NEGADO, e a nota continua valendo até a prefeitura aceitar');
    if (nota.effectiveDate) {
      const dias = Math.floor((Date.parse(diaLocal(esc.agora(), fusoDe(c))) - Date.parse(nota.effectiveDate)) / 86_400_000);
      if (dias > 0) avisos.push(`a nota foi emitida há ${dias} dia${dias === 1 ? '' : 's'}: confira o prazo de cancelamento da prefeitura`);
    }
  }
  let nomeDoTomador: string | null = null;
  if (nota.customer) nomeDoTomador = (await melhorEsforco(() => clientePorId(c, nota.customer!), 5000))?.name ?? null;
  const resumo = {
    acao: 'CANCELAR nota fiscal de serviço (NFS-e)',
    clinica: cabecalho,
    nota: mostrarNota(nota, nomeDoTomador, false),
    statusAtual: STATUS_NOTA[status] ?? status,
  };
  const { codigo, expiraEm } = esc.notas.guardar({ usuario: quem.id, unidade: c.slug, acao: 'cancelar', resumo, notaId: id, statusAntes: status, valor: Number(nota.value) || 0 });
  return {
    unidade: c.slug,
    acao: 'cancelar',
    resumo,
    avisos,
    confirmacao: codigo,
    expiraEm,
    instrucao: `NADA foi cancelado ainda. Mostre o resumo e os avisos à pessoa e, só se ela aprovar, chame asaas_confirmar_nota com confirmacao="${codigo}" (vale 15 minutos, uma vez, só para você).`,
  };
}

// ----------------------------------------------------------------- confirmar

export async function confirmarNota({ asaas, esc }: CtxEscrita, quem: Quem, a: { confirmacao: string }, registrar: Registrar) {
  const p = esc.notas.tirar(a.confirmacao, quem.id);
  // a conta de novo: se a escrita foi desligada (ou a clínica saiu do conector) desde o resumo, nada é gravado
  const c = contaDeEscrita(asaas, esc, p.unidade);
  return comAvisos(esc, c.slug, async (avisar) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const aviso = (titulo: string, extra: { valor?: number; id?: string; detalhe?: string }) => textoDoAviso({ titulo, conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, ...extra });
    // o registro é gravado ANTES de chamar o Asaas: sem ele, a nota não sai
    const intencao = async (base: Record<string, unknown>) => {
      const gravou = await Promise.resolve(registrar(EVENTO_NOTA, { ...base, fase: 'intencao' }, true));
      if (gravou === false) throw new ErroDeEntrada('não consegui gravar o registro da operação (banco): nada foi feito no Asaas. Prepare de novo em instantes.');
    };

    if (p.acao === 'emitir') {
      const origem = p.origem!;
      // a data aprovada no resumo não pode ter ficado para trás (resumo às 23h50, confirmação à 00h05)
      const hoje = diaLocal(esc.agora(), fusoDe(c));
      if (p.dataEmissao! < hoje) throw new ErroDeEntrada(`a data de emissão aprovada (${dataBR(p.dataEmissao!)}) já passou (hoje é ${dataBR(hoje)}): não emiti. Prepare de novo. Nada foi feito.`);
      // outra nota apareceu desde o resumo? então a pessoa aprovou outra situação
      const agora = await notasAtivasDaOrigem(asaas, c, origem, p.valor!, p.dataEmissao!);
      const novas = agora.filter((n) => !(p.jaExistiam ?? []).includes(n.id));
      if (novas.length) throw new ErroDeEntrada(`desde o resumo apareceu outra nota ativa para esta origem (${novas.map((n) => n.id).join(', ')}): não emiti. Veja com asaas_notas e prepare de novo. Nada foi feito.`);
      const referencia = `dd-nf-${a.confirmacao.trim().toLowerCase()}`;
      const base = { conta: c.slug, operacao: 'emitir_nota', origemTipo: origem.tipo, ...(origem.tipo === 'cobranca' ? { cobrancaId: origem.id } : { clienteId: origem.id }), valor: p.valor, dataEmissao: p.dataEmissao, emitirAgora: p.emitirAgora === true, referencia, pediuPor: quem.id };
      await intencao(base);
      let criada: NotaAsaas | null = null;
      try {
        criada = await c.escrita.enviar<NotaAsaas>('POST', '/invoices', { ...p.corpo!, externalReference: referencia });
        if (!criada?.id) throw new ErroSemId('o Asaas respondeu ao agendamento da nota sem o id');
      } catch (e) {
        const s = sanear(e);
        const incerto = podeTerGravado(e);
        // a referência é única deste pedido: se o Asaas gravou, ela acha a nota
        if (incerto) criada = (await melhorEsforco(() => c.fonte.get<{ data?: NotaAsaas[] }>('/invoices', { externalReference: referencia, limit: 5 }), 8000))?.data?.find((n) => !!n.id) ?? null;
        if (!criada) {
          registrar(EVENTO_NOTA, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
          if (incerto) avisar(aviso('NOTA FISCAL COM RESULTADO INCERTO', { ...(p.valor !== undefined ? { valor: p.valor } : {}), detalhe: 'O Asaas não confirmou o agendamento: a nota PODE ter sido criada. Conferir no painel.' }));
          throw incerto ? new Error(`${s.message} — a nota PODE ter sido criada: confira com asaas_notas antes de repetir.`) : s;
        }
      }
      let status = criada.status;
      let falhaAoEmitir: string | undefined;
      if (p.emitirAgora) {
        try {
          const r = await c.escrita.enviar<NotaAsaas>('POST', `/invoices/${criada.id}/authorize`);
          status = r?.status ?? status;
        } catch (e) {
          falhaAoEmitir = sanear(e).message;
        }
      }
      registrar(EVENTO_NOTA, { ...base, idAsaas: criada.id, status: status ?? null, ...(falhaAoEmitir ? { emissaoImediataFalhou: true } : {}) }, true, falhaAoEmitir);
      avisar(
        aviso(p.emitirAgora && !falhaAoEmitir ? 'NOTA FISCAL: EMISSÃO PEDIDA' : 'NOTA FISCAL AGENDADA', {
          ...(p.valor !== undefined ? { valor: p.valor } : {}),
          id: criada.id,
          detalhe: `${origem.tipo === 'cobranca' ? `cobrança ${origem.id}` : `cliente ${origem.id}`} · emissão ${p.dataEmissao ? dataBR(p.dataEmissao) : '?'}${falhaAoEmitir ? ' · a emissão imediata FALHOU, a nota ficou agendada' : ''}`,
        }),
      );
      const tomador = (await melhorEsforco(() => clienteDaNota(c, criada!, origem), 4000)) ?? null;
      return {
        conta: cabecalho,
        notaCriada: true,
        nota: mostrarNota({ ...criada, status }, tomador, false),
        ...(falhaAoEmitir
          ? { atencao: `a nota foi AGENDADA para hoje, mas o pedido de emissão imediata falhou (${falhaAoEmitir}). O Asaas deve emiti-la sozinho na data; confira com asaas_nota. NÃO emita de novo.` }
          : { aviso: 'Quem autoriza a nota é a prefeitura, e isso pode levar um tempo: confira o status e os links do PDF/XML com asaas_nota.' }),
        registro: 'Registrado com quem pediu e quem aprovou o resumo.',
      };
    }

    // cancelar
    const id = p.notaId!;
    const atual = await notaPorId(c, id);
    if (atual.status !== p.statusAntes) {
      throw new ErroDeEntrada(`a nota ${id} mudou de status desde o resumo (era "${STATUS_NOTA[p.statusAntes ?? ''] ?? p.statusAntes}", agora é "${STATUS_NOTA[atual.status ?? ''] ?? atual.status}"): não cancelei. Prepare de novo. Nada foi feito.`);
    }
    const base = { conta: c.slug, operacao: 'cancelar_nota', notaId: id, valor: p.valor, statusAntes: p.statusAntes, pediuPor: quem.id };
    await intencao(base);
    let r: NotaAsaas | null = null;
    try {
      r = await c.escrita.enviar<NotaAsaas>('POST', `/invoices/${id}/cancel`);
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      // sem resposta: a nota diz se o pedido chegou
      if (incerto) {
        const lida = await melhorEsforco(() => notaPorId(c, id), 8000);
        if (lida && (lida.status === 'PROCESSING_CANCELLATION' || lida.status === 'CANCELED')) r = lida;
      }
      if (!r) {
        registrar(EVENTO_NOTA, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
        if (incerto) avisar(aviso('CANCELAMENTO DE NOTA COM RESULTADO INCERTO', { ...(p.valor ? { valor: p.valor } : {}), id, detalhe: 'O Asaas não confirmou: o cancelamento PODE ter sido pedido. Conferir no painel.' }));
        throw incerto ? new Error(`${s.message} — o cancelamento PODE ter sido pedido: confira com asaas_nota antes de repetir.`) : s;
      }
    }
    const statusAgora = r?.status ?? null;
    registrar(EVENTO_NOTA, { ...base, idAsaas: id, status: statusAgora }, true);
    avisar(aviso('NOTA FISCAL: CANCELAMENTO PEDIDO', { ...(p.valor ? { valor: p.valor } : {}), id, detalhe: `status agora: ${statusAgora ?? '?'} · antes: ${p.statusAntes}` }));
    return {
      conta: cabecalho,
      cancelamentoPedido: true,
      nota: { id, statusAntes: STATUS_NOTA[p.statusAntes ?? ''] ?? p.statusAntes, statusAgora: STATUS_NOTA[statusAgora ?? ''] ?? statusAgora, valor: p.valor ? dinheiro(p.valor) : null },
      aviso:
        statusAgora === 'CANCELED'
          ? 'Nota cancelada.'
          : 'O cancelamento depende da prefeitura: confira o resultado com asaas_nota. Se ficar "cancelamento negado", a nota continua valendo e o caminho é o portal da prefeitura.',
      registro: 'Registrado com quem pediu e quem aprovou o resumo.',
    };
  });
}

async function clienteDaNota(c: ContaAsaas, n: NotaAsaas, origem: Origem): Promise<string | null> {
  const id = n.customer ?? (origem.tipo === 'cliente' ? origem.id : undefined);
  return id ? ((await c.fonte.get<{ name?: string }>(`/customers/${id}`))?.name ?? null) : null;
}
