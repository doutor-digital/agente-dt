/**
 * ASSINATURAS (cobrança recorrente) do Asaas pelo claude.ai — pedido da Lia/Suzanne, 25/11/2026 (clientes B2B da Doutor Digital pagando todo mês).
 * Mesmo molde da cobrança (`asaas-escrita.ts`): DIRETO, sem passo de confirmação, numa clínica só, só para quem escreve, e com as MESMAS travas:
 *  - criar uma assinatura entra no livro como uma COBRANÇA do valor de uma mensalidade (teto por operação, teto do dia, limite por hora,
 *    duplicata em 10 min), com a intenção gravada antes de chamar o Asaas;
 *  - editar para um valor maior reserva só o acréscimo (como editar cobrança); cancelar entra no limite de cancelamentos por hora;
 *  - criar, editar e cancelar SEMPRE avisam o João no Telegram (é dinheiro que se repete todo mês).
 * Cliente: só um cadastro que JÁ existe (clienteId ou CPF/CNPJ); cadastrar é asaas_criar_cliente. Cartão nunca entra pelo chat.
 */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { mascararDigitosSeguidos } from '../lib/pii.js';
import { STATUS as STATUS_COBRANCA, type ContaAsaas } from './asaas.js';
import {
  cabecalhoDaConta, chaveDeOperacao, clientePorId, clientesPorDoc, comAvisos, consumoSeguro, contaDeEscrita, dataBR, decidirAviso, descricaoValida, ErroSemId,
  esquecerLeituras, fusoDe, melhorEsforco, podeTerGravado, recusarDadosDeCartao, referenciaValida, reservar, sanear, validarCpfCnpj, valorValido, vencimentoValido,
  type ClienteAsaas, type CtxEscrita, type Quem, type Registrar,
} from './asaas-escrita.js';
import { dinheiro, EVENTO_COBRANCA, EVENTO_OPERACAO, mascararDoc, textoDoAviso } from './asaas-limites.js';

export type FormaDaAssinatura = 'BOLETO' | 'PIX' | 'CARTAO' | 'CLIENTE_ESCOLHE';
const BILLING: Record<FormaDaAssinatura, string> = { BOLETO: 'BOLETO', PIX: 'PIX', CARTAO: 'CREDIT_CARD', CLIENTE_ESCOLHE: 'UNDEFINED' };
const NOME_DA_FORMA: Record<string, string> = { BOLETO: 'boleto', PIX: 'Pix', CREDIT_CARD: 'cartão (link de pagamento)', UNDEFINED: 'o cliente escolhe (boleto, Pix ou cartão)' };

export type Ciclo = 'SEMANAL' | 'QUINZENAL' | 'MENSAL' | 'BIMESTRAL' | 'TRIMESTRAL' | 'SEMESTRAL' | 'ANUAL';
export const CICLOS: readonly Ciclo[] = ['SEMANAL', 'QUINZENAL', 'MENSAL', 'BIMESTRAL', 'TRIMESTRAL', 'SEMESTRAL', 'ANUAL'];
const CICLO_ASAAS: Record<Ciclo, string> = {
  SEMANAL: 'WEEKLY', QUINZENAL: 'BIWEEKLY', MENSAL: 'MONTHLY', BIMESTRAL: 'BIMONTHLY', TRIMESTRAL: 'QUARTERLY', SEMESTRAL: 'SEMIANNUALLY', ANUAL: 'YEARLY',
};
const CICLO_PT: Record<string, string> = Object.fromEntries(Object.entries(CICLO_ASAAS).map(([pt, en]) => [en, pt.toLowerCase()]));
const STATUS_PT: Record<string, string> = { ACTIVE: 'ativa', INACTIVE: 'inativa', EXPIRED: 'encerrada' };

const semAcento = (v: unknown) => String(v).trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_');

export function formaDaAssinatura(v: unknown): FormaDaAssinatura {
  if (v === undefined || v === null || String(v).trim() === '') return 'BOLETO';
  const t = semAcento(v).replace('CREDIT_CARD', 'CARTAO').replace('UNDEFINED', 'CLIENTE_ESCOLHE').replace('A_ESCOLHER', 'CLIENTE_ESCOLHE');
  if (t === 'BOLETO' || t === 'PIX' || t === 'CARTAO' || t === 'CLIENTE_ESCOLHE') return t;
  throw new ErroDeEntrada(`forma "${String(v).slice(0, 30)}" não existe aqui: use BOLETO, PIX, CARTAO (link de pagamento) ou CLIENTE_ESCOLHE (o cliente escolhe boleto, Pix ou cartão na hora de pagar)`);
}

export function cicloValido(v: unknown): Ciclo {
  if (v === undefined || v === null || String(v).trim() === '') return 'MENSAL';
  const t = semAcento(v);
  const achado = (CICLOS as readonly string[]).includes(t) ? (t as Ciclo) : (Object.entries(CICLO_ASAAS).find(([, en]) => en === t)?.[0] as Ciclo | undefined);
  if (!achado) throw new ErroDeEntrada(`ciclo "${String(v).slice(0, 20)}" não existe: use ${CICLOS.join(', ')}`);
  return achado;
}

function idDaAssinatura(v: unknown): string {
  const id = String(v ?? '').trim();
  if (!/^sub_[A-Za-z0-9]{6,40}$/.test(id)) throw new ErroDeEntrada('assinaturaId inválido (esperado algo como sub_VXJBYgP2u0eO; veja em asaas_assinaturas)');
  return id;
}

interface AssinaturaAsaas {
  id: string;
  customer?: string;
  billingType?: string;
  cycle?: string;
  value?: number;
  nextDueDate?: string;
  endDate?: string | null;
  description?: string | null;
  status?: string;
  externalReference?: string | null;
  deleted?: boolean;
  dateCreated?: string;
}

interface CobrancaDaAssinatura {
  id: string;
  status?: string;
  value?: number;
  dueDate?: string;
  billingType?: string;
  invoiceUrl?: string | null;
  bankSlipUrl?: string | null;
  deleted?: boolean;
}

function mostrarAssinatura(s: AssinaturaAsaas) {
  return {
    id: s.id,
    status: STATUS_PT[s.status ?? ''] ?? s.status ?? 'desconhecido',
    valor: dinheiro(s.value ?? 0),
    ciclo: CICLO_PT[s.cycle ?? ''] ?? s.cycle ?? null,
    forma: NOME_DA_FORMA[s.billingType ?? ''] ?? s.billingType ?? null,
    proximoVencimento: s.nextDueDate ? `${dataBR(s.nextDueDate)} (${s.nextDueDate})` : null,
    ...(s.endDate ? { termina: dataBR(s.endDate) } : {}),
    descricao: s.description ?? null,
    clienteId: s.customer ?? null,
    ...(s.externalReference ? { externalReference: s.externalReference } : {}),
    ...(s.dateCreated ? { criadaEm: dataBR(s.dateCreated.slice(0, 10)) } : {}),
  };
}

function mostrarCobranca(p: CobrancaDaAssinatura) {
  return {
    id: p.id,
    status: STATUS_COBRANCA[p.status ?? ''] ?? p.status ?? 'desconhecido',
    valor: dinheiro(p.value ?? 0),
    vencimento: p.dueDate ? `${dataBR(p.dueDate)} (${p.dueDate})` : null,
    linkParaPagar: p.invoiceUrl ?? null,
    ...(p.bankSlipUrl ? { linkDoBoleto: p.bankSlipUrl } : {}),
  };
}

async function assinaturaPorId(c: ContaAsaas, id: string): Promise<AssinaturaAsaas> {
  let s: AssinaturaAsaas | null;
  try {
    s = await c.fonte.get<AssinaturaAsaas>(`/subscriptions/${id}`);
  } catch (e) {
    if ((e as { status?: number })?.status === 404) throw new ErroDeEntrada(`a assinatura ${id} não existe nesta conta do Asaas`);
    throw e;
  }
  if (!s?.id || s.deleted) throw new ErroDeEntrada(`a assinatura ${id} não existe (ou já foi cancelada) nesta conta do Asaas`);
  return s;
}

async function cobrancasDaAssinatura(c: ContaAsaas, id: string, limite = 12): Promise<CobrancaDaAssinatura[]> {
  const r = await c.fonte.get<{ data?: CobrancaDaAssinatura[] }>(`/subscriptions/${id}/payments`, { limit: limite });
  return (r?.data ?? []).filter((p) => !p.deleted);
}

/** O cliente que JÁ existe, por id (cus_…) ou por CPF/CNPJ. Nenhum ou mais de um cadastro com o documento: não adivinha. */
async function clienteExistente(c: ContaAsaas, a: { clienteId?: string; cpfCnpj?: string }): Promise<ClienteAsaas> {
  const clienteId = a.clienteId?.trim();
  if (!!clienteId === !!a.cpfCnpj?.trim()) throw new ErroDeEntrada('informe o cliente por clienteId (cus_…) OU por cpfCnpj, um dos dois');
  if (clienteId) return clientePorId(c, clienteId);
  const doc = validarCpfCnpj(a.cpfCnpj);
  const achados = await clientesPorDoc(c, doc);
  if (!achados.length) throw new ErroDeEntrada(`não há cliente com o documento ${mascararDoc(doc)} nesta conta do Asaas: cadastre antes com asaas_criar_cliente. Nada foi feito.`);
  if (achados.length > 1) throw new ErroDeEntrada(`há ${achados.length} cadastros com este CPF/CNPJ no Asaas (${achados.map((x) => x.id).join(', ')}): informe qual usar em clienteId. Nada foi feito.`);
  return achados[0]!;
}

// ----------------------------------------------------------------- consultar

export async function asaasAssinaturas({ asaas, esc }: CtxEscrita, a: { unidade: string; assinaturaId?: string; clienteId?: string; cpfCnpj?: string; status?: string }) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const { cabecalho, avisos } = await cabecalhoDaConta(c, esc);
  if (a.assinaturaId?.trim()) {
    const s = await assinaturaPorId(c, idDaAssinatura(a.assinaturaId));
    const cobrancas = await cobrancasDaAssinatura(c, s.id);
    return { conta: cabecalho, assinatura: mostrarAssinatura(s), cobrancas: cobrancas.map(mostrarCobranca), avisos };
  }
  let cliente: ClienteAsaas | undefined;
  if (a.clienteId?.trim() || a.cpfCnpj?.trim()) cliente = await clienteExistente(c, a);
  const status = a.status ? semAcento(a.status) : undefined;
  const statusAsaas = status ? ({ ATIVA: 'ACTIVE', INATIVA: 'INACTIVE', ENCERRADA: 'EXPIRED' } as Record<string, string>)[status] ?? status : undefined;
  if (statusAsaas && !['ACTIVE', 'INACTIVE', 'EXPIRED'].includes(statusAsaas)) throw new ErroDeEntrada('status: use ATIVA, INATIVA ou ENCERRADA');
  const r = await c.fonte.get<{ data?: AssinaturaAsaas[]; totalCount?: number }>('/subscriptions', {
    ...(cliente ? { customer: cliente.id } : {}),
    ...(statusAsaas ? { status: statusAsaas } : {}),
    limit: 50,
  });
  const lista = (r?.data ?? []).filter((s) => !s.deleted);
  return {
    conta: cabecalho,
    ...(cliente ? { cliente: { id: cliente.id, nome: cliente.name ?? null } } : {}),
    total: r?.totalCount ?? lista.length,
    assinaturas: lista.map(mostrarAssinatura),
    ...(!lista.length ? { instrucao: 'nenhuma assinatura encontrada com esse filtro' } : {}),
    avisos,
  };
}

// ----------------------------------------------------------------- criar

export interface PedidoDeAssinatura {
  unidade: string;
  clienteId?: string;
  cpfCnpj?: string;
  valor: number;
  ciclo?: unknown;
  primeiroVencimento: string;
  descricao: string;
  forma?: unknown;
  externalReference?: string;
  avisarCliente?: boolean;
  permitirOutraIgual?: boolean;
  [campo: string]: unknown;
}

export async function criarAssinatura({ asaas, esc }: CtxEscrita, quem: Quem, a: PedidoDeAssinatura, registrar: Registrar) {
  recusarDadosDeCartao(a);
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const forma = formaDaAssinatura(a.forma);
  const ciclo = cicloValido(a.ciclo);
  const valor = valorValido(a.valor);
  const vencimento = vencimentoValido(a.primeiroVencimento, esc.agora(), fusoDe(c));
  const descricao = descricaoValida(a.descricao);
  const externalReference = referenciaValida(a.externalReference);
  const avisar = a.avisarCliente === true;

  const feita = await comAvisos(esc, c.slug, async (avisarJoao) => {
    const { cabecalho, avisos } = await cabecalhoDaConta(c, esc);
    const cliente = await clienteExistente(c, a);
    const aviso = decidirAviso({ tipo: 'existente', cliente }, avisar);
    // assinatura ATIVA igual (mesmo valor e ciclo) para o mesmo cliente: quase sempre é a mesma pedida duas vezes
    const ativas = await c.fonte.get<{ data?: AssinaturaAsaas[] }>('/subscriptions', { customer: cliente.id, status: 'ACTIVE', limit: 50 });
    const igual = (ativas?.data ?? []).find((s) => !s.deleted && Math.round((s.value ?? 0) * 100) === Math.round(valor * 100) && s.cycle === CICLO_ASAAS[ciclo]);
    if (igual && a.permitirOutraIgual !== true) {
      throw new ErroDeEntrada(
        `o cliente ${cliente.id} JÁ tem a assinatura ATIVA ${igual.id} de ${dinheiro(valor)} ${ciclo.toLowerCase()} (próximo vencimento ${igual.nextDueDate ? dataBR(igual.nextDueDate) : '?'}). ` +
          'Não criei outra. Se é mesmo uma segunda assinatura, repita com permitirOutraIgual=true.',
      );
    }
    const chave = chaveDeOperacao('assinatura', c.slug, cliente.id, Math.round(valor * 100), CICLO_ASAAS[ciclo], vencimento, descricao.trim(), externalReference ?? '', BILLING[forma]);
    const base = {
      conta: c.slug, assinatura: true, valor, ciclo, primeiroVencimento: vencimento, forma, clienteId: cliente.id,
      externalReference: externalReference ? mascararDigitosSeguidos(externalReference, 10, '[documento]') : null,
      pediuPor: quem.id,
    };
    // a mensalidade entra no livro como uma COBRANÇA: mesmos tetos, mesmo limite por hora e a mesma duplicata em 10 min; intenção gravada ANTES do Asaas
    const r = await reservar(esc, c, quem, {
      tipo: 'cobranca', chave, valor, noTeto: valor, hora: true,
      descricaoDuplicata: 'assinatura igual (mesmo cliente, valor, ciclo, 1º vencimento e descrição)', seForDeProposito: 'Se for de propósito, espere 10 minutos ou mude a descrição.',
      evento: EVENTO_COBRANCA, argumentos: { ...base, chave },
    });
    const ids = { intencaoId: r.intencaoId, chaveAsaas: r.grupo };
    let s: AssinaturaAsaas;
    try {
      s = await c.escrita.enviar<AssinaturaAsaas>('POST', '/subscriptions', {
        customer: cliente.id,
        billingType: BILLING[forma],
        value: valor,
        nextDueDate: vencimento,
        cycle: CICLO_ASAAS[ciclo],
        description: descricao,
        ...(externalReference ? { externalReference } : {}),
      });
    } catch (e) {
      const s2 = sanear(e);
      esquecerLeituras(asaas, c.slug);
      const incerto = podeTerGravado(e);
      registrar(EVENTO_COBRANCA, { ...base, ...ids, chave, ...(incerto ? { incerto: true } : {}) }, false, s2.message);
      if (incerto) {
        avisarJoao(textoDoAviso({ titulo: 'ASSINATURA COM RESULTADO INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, detalhe: 'O Asaas não confirmou: a assinatura PODE ter sido criada. Conferir no painel.' }));
        throw new Error(`O Asaas não confirmou a assinatura (${s2.message}): ela PODE ter sido criada. Confira com asaas_assinaturas (clienteId ${cliente.id}) antes de repetir.`);
      }
      throw new Error(`A assinatura não foi criada: ${s2.message}`);
    }
    esquecerLeituras(asaas, c.slug);
    if (!s?.id) {
      registrar(EVENTO_COBRANCA, { ...base, ...ids, chave, incerto: true }, false, 'o Asaas respondeu sem o id da assinatura');
      avisarJoao(textoDoAviso({ titulo: 'ASSINATURA COM RESULTADO INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, detalhe: 'O Asaas respondeu sem o id. Conferir no painel.' }));
      throw new ErroSemId(`O Asaas respondeu sem o id da assinatura: ela PODE ter sido criada. Confira com asaas_assinaturas (clienteId ${cliente.id}) antes de repetir.`);
    }
    registrar(EVENTO_COBRANCA, { ...base, ...ids, chave, idAsaas: s.id, status: s.status ?? null }, true);
    avisarJoao(textoDoAviso({
      titulo: 'ASSINATURA CRIADA', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id: s.id,
      detalhe: `${ciclo.toLowerCase()}, 1º vencimento ${dataBR(vencimento)}, ${NOME_DA_FORMA[BILLING[forma]]}, cliente ${cliente.id}`,
    }));
    return {
      criada: true,
      conta: cabecalho,
      assinatura: mostrarAssinatura({ ...s, customer: cliente.id, value: s.value ?? valor, cycle: s.cycle ?? CICLO_ASAAS[ciclo], nextDueDate: s.nextDueDate ?? vencimento, billingType: s.billingType ?? BILLING[forma], description: s.description ?? descricao }),
      cliente: { id: cliente.id, nome: cliente.name ?? null },
      avisouOCliente: aviso.vaiAvisar,
      aviso: aviso.texto,
      ...(igual ? { atencao: `o cliente já tinha a assinatura ativa ${igual.id} igual; criei OUTRA porque permitirOutraIgual=true` } : {}),
      avisos,
      limites: await consumoSeguro(esc, c),
      registro: 'Registrado com quem pediu. O João foi avisado no Telegram.',
      _id: s.id,
    };
  });

  // a 1ª cobrança o Asaas gera junto com a assinatura: o link para pagar é melhor esforço, fora da fila da conta
  const { _id, ...resposta } = feita;
  const primeiras = await melhorEsforco(() => cobrancasDaAssinatura(c, _id, 3), esc.esperaLinhaMs);
  const primeira = primeiras?.sort((x, y) => String(x.dueDate).localeCompare(String(y.dueDate)))[0];
  return {
    ...resposta,
    ...(primeira
      ? { primeiraCobranca: mostrarCobranca(primeira) }
      : { atencao: 'a 1ª cobrança ainda não apareceu (o Asaas gera em instantes): consulte com asaas_assinaturas (assinaturaId) para pegar o link de pagamento' }),
  };
}

// ----------------------------------------------------------------- editar

export async function editarAssinatura(
  { asaas, esc }: CtxEscrita,
  quem: Quem,
  a: { unidade: string; assinaturaId: string; valor?: number; proximoVencimento?: string; descricao?: string; forma?: unknown; ciclo?: unknown; atualizarCobrancasPendentes?: boolean },
  registrar: Registrar,
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const id = idDaAssinatura(a.assinaturaId);
  const corpo: Record<string, unknown> = {};
  const campos: string[] = [];
  const novoValor = a.valor === undefined ? undefined : valorValido(a.valor);
  if (novoValor !== undefined) { corpo.value = novoValor; campos.push('valor'); }
  if (a.proximoVencimento !== undefined) { corpo.nextDueDate = vencimentoValido(a.proximoVencimento, esc.agora(), fusoDe(c)); campos.push('próximo vencimento'); }
  if (a.descricao !== undefined) { corpo.description = descricaoValida(a.descricao); campos.push('descrição'); }
  if (a.forma !== undefined) { corpo.billingType = BILLING[formaDaAssinatura(a.forma)]; campos.push('forma'); }
  if (a.ciclo !== undefined) { corpo.cycle = CICLO_ASAAS[cicloValido(a.ciclo)]; campos.push('ciclo'); }
  if (!campos.length) throw new ErroDeEntrada('nada para alterar: informe ao menos um de valor, proximoVencimento, descricao, forma ou ciclo');
  const pendentes = a.atualizarCobrancasPendentes === true;
  corpo.updatePendingPayments = pendentes;

  return comAvisos(esc, c.slug, async (avisarJoao) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const atual = await assinaturaPorId(c, id);
    const acrescimo = novoValor !== undefined ? Math.max(0, Math.round((novoValor - (atual.value ?? 0)) * 100) / 100) : 0;
    const base0 = { conta: c.slug, operacao: 'editar_assinatura', valor: novoValor ?? 0, noTeto: acrescimo, idAsaas: id, campos, atualizarCobrancasPendentes: pendentes, pediuPor: quem.id };
    let ids: Record<string, unknown> = {};
    if (acrescimo > 0) {
      const r = await reservar(esc, c, quem, { tipo: 'edicao', valor: novoValor!, noTeto: acrescimo, evento: EVENTO_OPERACAO, argumentos: base0 });
      ids = { intencaoId: r.intencaoId, chaveAsaas: r.grupo };
    }
    const base = { ...base0, ...ids };
    let depois: AssinaturaAsaas | null;
    try {
      depois = await c.escrita.enviar<AssinaturaAsaas>('PUT', `/subscriptions/${id}`, corpo);
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      esquecerLeituras(asaas, c.slug);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      throw incerto ? new Error(`${s.message} — a alteração PODE ter sido feita: confira com asaas_assinaturas antes de repetir.`) : s;
    }
    esquecerLeituras(asaas, c.slug);
    registrar(EVENTO_OPERACAO, { ...base, status: depois?.status ?? null }, true);
    avisarJoao(textoDoAviso({
      titulo: 'ASSINATURA EDITADA', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor: novoValor ?? atual.value ?? 0, id,
      detalhe: `campos: ${campos.join(', ')}${novoValor !== undefined ? ` (valor anterior ${dinheiro(atual.value ?? 0)})` : ''}; cobranças pendentes ${pendentes ? 'ATUALIZADAS' : 'mantidas'}`,
    }));
    return {
      conta: cabecalho,
      alterada: true,
      campos,
      assinatura: mostrarAssinatura({ ...atual, ...(depois ?? {}), id }),
      cobrancasPendentes: pendentes
        ? 'as cobranças já geradas e ainda não pagas também mudaram'
        : 'as cobranças JÁ geradas ficaram como estavam; vale para as próximas (para mudar as já geradas, repita com atualizarCobrancasPendentes=true ou use asaas_editar_cobranca)',
      limites: await consumoSeguro(esc, c),
      registro: 'Registrado com quem pediu. O João foi avisado no Telegram.',
    };
  });
}

// ----------------------------------------------------------------- cancelar

export async function cancelarAssinatura({ asaas, esc }: CtxEscrita, quem: Quem, a: { unidade: string; assinaturaId: string }, registrar: Registrar) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const id = idDaAssinatura(a.assinaturaId);
  return comAvisos(esc, c.slug, async (avisarJoao) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const atual = await assinaturaPorId(c, id);
    const valor = atual.value ?? 0;
    const base0 = { conta: c.slug, operacao: 'cancelar_assinatura', valor, noTeto: 0, idAsaas: id, statusAntes: atual.status ?? null, pediuPor: quem.id };
    // limite de QUANTIDADE de cancelamentos por hora (o mesmo das cobranças), com a intenção gravada antes
    const reserva = await reservar(esc, c, quem, { tipo: 'cancelamento', valor, noTeto: 0, evento: EVENTO_OPERACAO, argumentos: base0 });
    const base = { ...base0, intencaoId: reserva.intencaoId, chaveAsaas: reserva.grupo };
    const detalhe = `${CICLO_PT[atual.cycle ?? ''] ?? atual.cycle ?? ''} · cliente ${atual.customer ?? '?'} · ${atual.description ?? ''}`.slice(0, 200);
    let r: { deleted?: boolean } | null;
    try {
      r = await c.escrita.enviar<{ deleted?: boolean }>('DELETE', `/subscriptions/${id}`);
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      esquecerLeituras(asaas, c.slug);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      if (incerto) avisarJoao(textoDoAviso({ titulo: 'CANCELAMENTO DE ASSINATURA INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id, detalhe: 'O Asaas não confirmou. Conferir no painel.' }));
      throw incerto ? new Error(`${s.message} — o cancelamento PODE ter sido feito: confira com asaas_assinaturas antes de repetir.`) : s;
    }
    esquecerLeituras(asaas, c.slug);
    if (r?.deleted === false) {
      registrar(EVENTO_OPERACAO, base, false, 'o Asaas respondeu deleted=false');
      throw new ErroDeEntrada('o Asaas não cancelou a assinatura (resposta deleted=false). Nada mudou: confira com asaas_assinaturas.');
    }
    registrar(EVENTO_OPERACAO, { ...base, resultado: 'cancelada' }, true);
    avisarJoao(textoDoAviso({ titulo: 'ASSINATURA CANCELADA', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id, detalhe }));
    return {
      conta: cabecalho,
      cancelada: true,
      assinatura: { id, valor: dinheiro(valor), ciclo: CICLO_PT[atual.cycle ?? ''] ?? atual.cycle ?? null, statusAntes: STATUS_PT[atual.status ?? ''] ?? atual.status ?? null },
      instrucao: 'Não sai mais cobrança nova desta assinatura. O Asaas apaga junto as cobranças dela ainda NÃO pagas; as já pagas ficam. Confira com asaas_cobrancas.',
      registro: 'Registrado com quem pediu. O João foi avisado no Telegram.',
    };
  });
}
