/**
 * Asaas com escrita pelo claude.ai: editar cliente, editar cobrança pendente, cancelar cobrança, estornar cobrança recebida e
 * TRANSFERIR (Pix de saída) — tudo direto, sem preparar/confirmar. O que segura o dinheiro são as travas automáticas de
 * `asaas-limites.ts` (tetos por operação e por dia, lista de destinos) e o aviso no Telegram a cada transferência, estorno e
 * cancelamento. Cadastrar cliente e criar cobrança estão em `asaas-escrita.ts`.
 */
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { mascararDigitosSeguidos } from '../lib/pii.js';
import type { ContaAsaas } from './asaas.js';
import {
  cabecalhoDaConta, chaveDeOperacao, clientePorId, comAvisos, conferirTravas, consumoDoDia, contaDeEscrita, dataBR, descricaoValida, emailValido, esquecerLeituras,
  fusoDe, limitar, nomeValido, registrarIntencao, validarEndereco, podeTerGravado, sanear, telefoneValido, valorValido, vencimentoValido, ErroSemId, mostrarCliente,
  type ClienteAsaas, type CtxEscrita, type EnderecoPedido, type Quem, type Registrar,
} from './asaas-escrita.js';
import {
  acharDestino, dinheiro, EVENTO_OPERACAO, identidadeDoDestino, mascararChavePix, mostrarDestino, textoDoAviso, textoSemDestinos, type Destino, type PedidoDeDestino,
} from './asaas-limites.js';

const STATUS_PT: Record<string, string> = {
  PENDING: 'aguardando pagamento', RECEIVED: 'recebida', CONFIRMED: 'confirmada', OVERDUE: 'vencida', REFUNDED: 'estornada', RECEIVED_IN_CASH: 'recebida em dinheiro',
  REFUND_REQUESTED: 'estorno solicitado', REFUND_IN_PROGRESS: 'estorno em andamento', CHARGEBACK_REQUESTED: 'chargeback', DELETED: 'excluída',
};
const emPortugues = (s?: string) => STATUS_PT[s ?? ''] ?? s ?? 'desconhecido';

interface Pagamento {
  id: string;
  status?: string;
  value?: number;
  dueDate?: string;
  description?: string | null;
  billingType?: string;
  customer?: string;
  deleted?: boolean;
  installment?: string | null;
}

function idDaCobranca(v: unknown): string {
  const id = String(v ?? '').trim();
  if (!/^pay_[A-Za-z0-9]{6,40}$/.test(id)) throw new ErroDeEntrada('cobrancaId inválido (esperado algo como pay_080225913252; veja o id em asaas_cobrancas)');
  return id;
}

async function pagamentoPorId(c: ContaAsaas, id: string): Promise<Pagamento> {
  let p: Pagamento | null;
  try {
    p = await c.fonte.get<Pagamento>(`/payments/${id}`);
  } catch (e) {
    if ((e as { status?: number })?.status === 404) throw new ErroDeEntrada(`a cobrança ${id} não existe nesta conta do Asaas`);
    throw e;
  }
  if (!p?.id || p.deleted) throw new ErroDeEntrada(`a cobrança ${id} não existe (ou já foi excluída) nesta conta do Asaas`);
  return p;
}

/** Texto livre curto que vai ao Asaas (motivo do estorno, descrição da transferência): sem controle, sem corrida de dígitos de documento. */
function textoCurto(v: unknown, campo: string, max = 140): string | undefined {
  const t = limitar(v === undefined || v === null ? undefined : String(v), max, campo);
  if (t && mascararDigitosSeguidos(t, 11, '[x]') !== t) {
    throw new ErroDeEntrada(`${campo}: tem 11 ou mais dígitos seguidos (podem ser CPF, CNPJ ou telefone); tire o número do texto`);
  }
  return t;
}

// ----------------------------------------------------------------- editar cliente

export async function editarCliente(
  { asaas, esc }: CtxEscrita,
  quem: Quem,
  a: { unidade: string; clienteId: string; nome?: string; email?: string; telefone?: string; endereco?: EnderecoPedido; avisarCliente?: boolean },
  registrar: Registrar,
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const clienteId = String(a.clienteId ?? '').trim();
  const corpo: Record<string, unknown> = {};
  const campos: string[] = [];
  if (a.nome !== undefined) { corpo.name = nomeValido(a.nome); campos.push('nome'); }
  if (a.email?.trim()) { corpo.email = emailValido(a.email); campos.push('email'); }
  if (a.telefone?.trim()) {
    const t = telefoneValido(a.telefone);
    corpo[t.length === 11 ? 'mobilePhone' : 'phone'] = t;
    campos.push('telefone');
  }
  if (a.endereco) {
    const e = validarEndereco(a.endereco);
    Object.assign(corpo, { postalCode: e.cep, address: e.logradouro, addressNumber: e.numero, ...(e.complemento ? { complement: e.complemento } : {}), ...(e.bairro ? { province: e.bairro } : {}) });
    campos.push('endereço');
  }
  if (a.avisarCliente !== undefined) { corpo.notificationDisabled = a.avisarCliente !== true; campos.push('avisos automáticos'); }
  // a identidade (CPF/CNPJ) NÃO muda por aqui: trocar o documento de um cadastro com cobranças é decisão no painel do Asaas
  if (!campos.length) throw new ErroDeEntrada('nada para alterar: informe ao menos um de nome, email, telefone, endereco ou avisarCliente. O CPF/CNPJ não muda por aqui.');

  return comAvisos(esc, c.slug, async () => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const antes = await clientePorId(c, clienteId);
    const base = { conta: c.slug, operacao: 'editar_cliente', valor: 0, noTeto: 0, idAsaas: antes.id, campos, pediuPor: quem.id };
    let depois: ClienteAsaas | null;
    try {
      depois = await c.escrita.enviar<ClienteAsaas>('PUT', `/customers/${antes.id}`, corpo);
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      throw incerto ? new Error(`${s.message} — a alteração PODE ter sido feita: confira com asaas_cliente antes de repetir.`) : s;
    }
    registrar(EVENTO_OPERACAO, base, true);
    // o Asaas guarda celular e fixo em campos separados e a troca por um do outro tipo não apaga o antigo
    const outroTelefone = campos.includes('telefone') && (corpo.mobilePhone ? !!antes.phone : !!antes.mobilePhone);
    return {
      conta: cabecalho,
      alterado: true,
      campos,
      cliente: mostrarCliente({ ...antes, ...(depois ?? {}), id: antes.id }),
      ...(outroTelefone ? { atencao: 'o cadastro tinha outro telefone (celular ou fixo) e ele CONTINUA lá: o Asaas guarda os dois em campos separados. Confira com asaas_cliente.' } : {}),
      registro: 'Registrado com quem pediu.',
    };
  });
}

// ----------------------------------------------------------------- editar cobrança pendente

export async function editarCobranca(
  { asaas, esc }: CtxEscrita,
  quem: Quem,
  a: { unidade: string; cobrancaId: string; valor?: number; vencimento?: string; descricao?: string },
  registrar: Registrar,
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const id = idDaCobranca(a.cobrancaId);
  const corpo: Record<string, unknown> = {};
  const campos: string[] = [];
  const novoValor = a.valor === undefined ? undefined : valorValido(a.valor);
  if (novoValor !== undefined) { corpo.value = novoValor; campos.push('valor'); }
  if (a.vencimento !== undefined) { corpo.dueDate = vencimentoValido(a.vencimento, esc.agora(), fusoDe(c)); campos.push('vencimento'); }
  if (a.descricao !== undefined) { corpo.description = descricaoValida(a.descricao); campos.push('descrição'); }
  if (!campos.length) throw new ErroDeEntrada('nada para alterar: informe ao menos um de valor, vencimento ou descricao');

  return comAvisos(esc, c.slug, async (avisar) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const atual = await pagamentoPorId(c, id);
    if (atual.status !== 'PENDING') {
      throw new ErroDeEntrada(`só cobrança PENDENTE (aguardando pagamento) pode ser editada; a ${id} está "${emPortugues(atual.status)}". ${atual.status === 'OVERDUE' ? 'Cancele e crie outra com o novo vencimento.' : 'Nada foi feito.'}`);
    }
    // o teto vale para o valor novo; ao dia só soma o que AUMENTOU
    const acrescimo = novoValor !== undefined ? Math.max(0, Math.round((novoValor - (atual.value ?? 0)) * 100) / 100) : 0;
    // só mexer em vencimento ou descrição não envolve dinheiro novo: não depende dos tetos (mas ainda lê o livro, que o registro usa)
    // (diminuir o valor de uma cobrança que já passa do teto também não envolve dinheiro novo)
    if (acrescimo > 0) await conferirTravas(esc, c, { valor: novoValor!, noTeto: acrescimo });
    else await esc.livro.carregar(c.slug);
    const reserva = acrescimo > 0 ? esc.livro.lancar({ conta: c.slug, tipo: 'edicao', valor: novoValor!, noTeto: acrescimo, em: esc.agora(), id }) : null;
    const base = { conta: c.slug, operacao: 'editar_cobranca', valor: novoValor ?? 0, noTeto: acrescimo, idAsaas: id, campos, pediuPor: quem.id };
    let depois: Pagamento | null;
    try {
      depois = await c.escrita.enviar<Pagamento>('PUT', `/payments/${id}`, corpo);
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      esquecerLeituras(asaas, c.slug);
      if (!incerto && reserva) esc.livro.soltar(reserva);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      throw incerto ? new Error(`${s.message} — a alteração PODE ter sido feita: confira com asaas_cobranca antes de repetir.`) : s;
    }
    esquecerLeituras(asaas, c.slug);
    registrar(EVENTO_OPERACAO, { ...base, status: depois?.status ?? null }, true);
    if (novoValor !== undefined && novoValor > esc.tetoOperacao() / 2) {
      avisar(textoDoAviso({ titulo: 'COBRANÇA EDITADA PARA VALOR ACIMA DE 50% DO TETO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor: novoValor, id, detalhe: `valor anterior ${dinheiro(atual.value ?? 0)}` }));
    }
    return {
      conta: cabecalho,
      alterada: true,
      campos,
      cobranca: { id, status: emPortugues(depois?.status ?? atual.status), valor: dinheiro(depois?.value ?? novoValor ?? atual.value ?? 0), vencimento: depois?.dueDate ?? (corpo.dueDate as string | undefined) ?? atual.dueDate ?? null },
      ...(atual.installment ? { atencao: 'esta cobrança é parcela de um parcelamento: só ela foi alterada, as outras parcelas ficam como estavam' } : {}),
      limites: consumoDoDia(esc, c),
      registro: 'Registrado com quem pediu.',
    };
  });
}

// ----------------------------------------------------------------- cancelar cobrança

export async function cancelarCobranca({ asaas, esc }: CtxEscrita, quem: Quem, a: { unidade: string; cobrancaId: string }, registrar: Registrar) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const id = idDaCobranca(a.cobrancaId);
  return comAvisos(esc, c.slug, async (avisar) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const atual = await pagamentoPorId(c, id);
    if (atual.status !== 'PENDING' && atual.status !== 'OVERDUE') {
      const paga = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(atual.status ?? '');
      throw new ErroDeEntrada(
        `a cobrança ${id} está "${emPortugues(atual.status)}" e não pode ser cancelada.` + (paga ? ' Ela já foi paga: para devolver o dinheiro use asaas_estornar_cobranca.' : ' Nada foi feito.'),
      );
    }
    const valor = atual.value ?? 0;
    const base = { conta: c.slug, operacao: 'cancelar_cobranca', valor, noTeto: 0, idAsaas: id, statusAntes: atual.status, pediuPor: quem.id };
    const detalhe = `${atual.billingType ?? ''} · vencimento ${atual.dueDate ? dataBR(atual.dueDate) : '?'} · cliente ${atual.customer ?? '?'}`.trim();
    let r: { deleted?: boolean; id?: string } | null;
    try {
      r = await c.escrita.enviar<{ deleted?: boolean; id?: string }>('DELETE', `/payments/${id}`);
    } catch (e) {
      const s = sanear(e);
      const incerto = podeTerGravado(e);
      esquecerLeituras(asaas, c.slug);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      if (incerto) avisar(textoDoAviso({ titulo: 'CANCELAMENTO COM RESULTADO INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id, detalhe: 'O Asaas não confirmou. Conferir no painel.' }));
      throw incerto ? new Error(`${s.message} — o cancelamento PODE ter sido feito: confira com asaas_cobranca antes de repetir.`) : s;
    }
    esquecerLeituras(asaas, c.slug);
    if (r?.deleted === false) {
      registrar(EVENTO_OPERACAO, base, false, 'o Asaas respondeu deleted=false');
      throw new ErroDeEntrada('o Asaas não excluiu a cobrança (resposta deleted=false). Nada mudou: confira com asaas_cobranca.');
    }
    registrar(EVENTO_OPERACAO, { ...base, resultado: 'cancelada' }, true);
    avisar(textoDoAviso({ titulo: 'COBRANÇA CANCELADA', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id, detalhe }));
    return { conta: cabecalho, cancelada: true, cobranca: { id, valor: dinheiro(valor), statusAntes: emPortugues(atual.status) }, registro: 'Registrado com quem pediu.' };
  });
}

// ----------------------------------------------------------------- estornar cobrança recebida

export async function estornarCobranca(
  { asaas, esc }: CtxEscrita,
  quem: Quem,
  a: { unidade: string; cobrancaId: string; valor?: number; motivo?: string },
  registrar: Registrar,
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const id = idDaCobranca(a.cobrancaId);
  const parcial = a.valor === undefined ? undefined : valorValido(a.valor);
  const motivo = textoCurto(a.motivo, 'motivo');
  return comAvisos(esc, c.slug, async (avisar) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const atual = await pagamentoPorId(c, id);
    if (atual.status !== 'RECEIVED' && atual.status !== 'CONFIRMED') {
      throw new ErroDeEntrada(
        `a cobrança ${id} está "${emPortugues(atual.status)}": só cobrança RECEBIDA ou CONFIRMADA pode ser estornada.` +
          (atual.status === 'PENDING' || atual.status === 'OVERDUE' ? ' Como ainda não foi paga, o caminho é asaas_cancelar_cobranca.' : ' Nada foi feito.'),
      );
    }
    const total = atual.value ?? 0;
    const valor = parcial ?? total;
    if (valor > total) throw new ErroDeEntrada(`o estorno de ${dinheiro(valor)} passa do valor da cobrança (${dinheiro(total)}). Nada foi feito.`);
    const chave = chaveDeOperacao(c.slug, 'estorno', id, Math.round(valor * 100));
    await conferirTravas(esc, c, { chave, valor, noTeto: valor, descricaoDuplicata: `estorno igual da cobrança ${id}` });
    const reserva = esc.livro.lancar({ conta: c.slug, tipo: 'estorno', valor, noTeto: valor, em: esc.agora(), chave, id });
    const base = { conta: c.slug, operacao: 'estornar_cobranca', valor, noTeto: valor, idAsaas: id, parcial: parcial !== undefined && parcial < total, chave, pediuPor: quem.id };
    try {
      await registrarIntencao(registrar, EVENTO_OPERACAO, base);
    } catch (e) {
      esc.livro.soltar(reserva);
      throw e;
    }
    const detalhe = `${parcial !== undefined && parcial < total ? `ESTORNO PARCIAL (cobrança de ${dinheiro(total)})` : 'ESTORNO TOTAL'}${motivo ? ` · motivo: ${motivo}` : ''}`;
    let r: Pagamento;
    try {
      r = await c.escrita.enviar<Pagamento>('POST', `/payments/${id}/refund`, { ...(parcial !== undefined && parcial < total ? { value: parcial } : {}), ...(motivo ? { description: motivo } : {}) });
      if (!r?.id) throw new ErroSemId('o Asaas respondeu ao estorno sem o id da cobrança');
    } catch (e) {
      const s = sanear(e);
      esquecerLeituras(asaas, c.slug);
      const incerto = podeTerGravado(e);
      if (!incerto) esc.livro.soltar(reserva);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      if (incerto) {
        avisar(textoDoAviso({ titulo: 'ESTORNO COM RESULTADO INCERTO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id, detalhe: 'O Asaas não confirmou: o estorno PODE ter sido feito. Conferir no painel.' }));
        throw new Error(`${s.message} — o estorno PODE ter sido feito: confira com asaas_cobranca antes de repetir.`);
      }
      throw s;
    }
    esquecerLeituras(asaas, c.slug);
    registrar(EVENTO_OPERACAO, { ...base, status: r.status ?? null }, true);
    avisar(textoDoAviso({ titulo: 'ESTORNO', conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, id, detalhe }));
    return {
      conta: cabecalho,
      estornado: true,
      cobranca: { id, valorEstornado: dinheiro(valor), valorDaCobranca: dinheiro(total), statusAgora: emPortugues(r.status), estornoParcial: base.parcial },
      aviso: 'O estorno pode levar algum tempo para concluir no Asaas: confira o status com asaas_cobranca.',
      limites: consumoDoDia(esc, c),
      registro: 'Registrado com quem pediu.',
    };
  });
}

// ----------------------------------------------------------------- transferir (Pix de saída)

interface Transferencia {
  id?: string;
  status?: string;
  value?: number;
  failReason?: string | null;
  scheduleDate?: string | null;
}

function corpoDaTransferencia(d: Destino, valor: number, descricao?: string): Record<string, unknown> {
  // o destino vai como ESTÁ NA LISTA do servidor, nunca como veio do chat
  const base = { value: valor, ...(descricao ? { description: descricao } : {}) };
  if (d.via === 'pix') return { ...base, pixAddressKey: d.chave, pixAddressKeyType: d.tipoChave };
  return {
    ...base,
    // explícito: sem isto o Asaas pode tratar como TED (outro prazo, outra tarifa); o conector fala em "Pix de saída"
    operationType: 'PIX',
    bankAccount: {
      bank: { code: d.banco },
      accountName: d.nome,
      ownerName: d.titular,
      cpfCnpj: d.documento,
      ...(d.nascimento ? { ownerBirthDate: d.nascimento } : {}),
      agency: d.agencia,
      account: d.conta,
      ...(d.digito ? { accountDigit: d.digito } : {}),
      bankAccountType: d.tipoConta,
    },
  };
}

export async function transferir(
  { asaas, esc }: CtxEscrita,
  quem: Quem,
  a: PedidoDeDestino & { unidade: string; valor: number; descricao?: string },
  registrar: Registrar,
) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  const lidos = esc.destinos(c.slug);
  if (!lidos.ligada) throw new ErroDeEntrada(textoSemDestinos(c.slug) + (lidos.problemas.length ? ` (problemas na configuração: ${lidos.problemas.join('; ')})` : ''));
  const destino = acharDestino(lidos.destinos, a);
  const valor = valorValido(a.valor);
  const descricao = textoCurto(a.descricao, 'descrição');
  const mostrar = destino.via === 'pix' ? `${destino.apelido} (${destino.tipoChave} ${mascararChavePix(destino.tipoChave, destino.chave)})` : `${destino.apelido} (banco ${destino.banco}, ag ${destino.agencia})`;

  return comAvisos(esc, c.slug, async (avisar) => {
    const { cabecalho } = await cabecalhoDaConta(c, esc);
    const chave = chaveDeOperacao(c.slug, 'transferencia', identidadeDoDestino(destino), Math.round(valor * 100), descricao ?? '');
    await conferirTravas(esc, c, { chave, valor, noTeto: valor, descricaoDuplicata: `transferência igual para ${destino.apelido}` });
    // o saldo é conferido antes só para dar uma resposta clara; quem manda é o Asaas (leitura que falha não trava)
    const saldo = await c.fonte.get<{ balance?: number }>('/finance/balance').then((r) => r?.balance, (e) => { if ((e as { status?: number })?.status === 401) throw e; return undefined; });
    if (typeof saldo === 'number' && saldo < valor) throw new ErroDeEntrada(`saldo insuficiente na conta: ${dinheiro(saldo)} disponível para uma transferência de ${dinheiro(valor)}. Nada foi feito.`);
    const reserva = esc.livro.lancar({ conta: c.slug, tipo: 'transferencia', valor, noTeto: valor, em: esc.agora(), chave });
    const base = { conta: c.slug, operacao: 'transferir', valor, noTeto: valor, destino: destino.apelido, via: destino.via, chave, pediuPor: quem.id };
    try {
      await registrarIntencao(registrar, EVENTO_OPERACAO, base);
    } catch (e) {
      esc.livro.soltar(reserva);
      throw e;
    }
    const aviso = (titulo: string, extra?: string) => textoDoAviso({ titulo, conta: c.slug, nomeDaConta: cabecalho.nomeDaConta, quem, valor, destino: mostrar, ...(extra ? { detalhe: extra } : {}) });
    let r: Transferencia;
    try {
      r = await c.escrita.enviar<Transferencia>('POST', '/transfers', corpoDaTransferencia(destino, valor, descricao));
    } catch (e) {
      const s = sanear(e);
      esquecerLeituras(asaas, c.slug);
      const incerto = podeTerGravado(e);
      if (!incerto) esc.livro.soltar(reserva);
      registrar(EVENTO_OPERACAO, { ...base, ...(incerto ? { incerto: true } : {}) }, false, s.message);
      if (incerto) {
        avisar(aviso('TRANSFERÊNCIA COM RESULTADO INCERTO', 'O Asaas não confirmou: o dinheiro PODE ter saído. Conferir no painel.'));
        throw new Error(`${s.message} — a transferência PODE ter sido feita: confira o extrato (asaas_extrato) antes de repetir.`);
      }
      throw s;
    }
    esquecerLeituras(asaas, c.slug);
    if (!r?.id) {
      registrar(EVENTO_OPERACAO, { ...base, incerto: true }, false, 'o Asaas respondeu sem o id da transferência');
      avisar(aviso('TRANSFERÊNCIA COM RESULTADO INCERTO', 'O Asaas respondeu sem o id: o dinheiro PODE ter saído. Conferir no painel.'));
      throw new Error('O Asaas respondeu sem o id da transferência: ela PODE ter sido feita. Confira o extrato (asaas_extrato) antes de repetir.');
    }
    reserva.id = r.id;
    if (r.status === 'FAILED' || r.status === 'CANCELLED') {
      esc.livro.soltar(reserva);
      registrar(EVENTO_OPERACAO, { ...base, idAsaas: r.id, status: r.status }, false, `transferência ${r.status}: ${r.failReason ?? 'sem motivo informado'}`);
      throw new ErroDeEntrada(`o Asaas não fez a transferência (${r.status}): ${sanear(new Error(String(r.failReason ?? 'sem motivo informado'))).message}`);
    }
    registrar(EVENTO_OPERACAO, { ...base, idAsaas: r.id, status: r.status ?? null }, true);
    avisar(aviso('TRANSFERÊNCIA', `id ${r.id} · status ${r.status ?? '?'}${descricao ? ` · ${descricao}` : ''}`));
    return {
      conta: cabecalho,
      transferido: true,
      transferencia: { id: r.id, status: r.status ?? null, valor: dinheiro(valor), destino: mostrarDestino(destino), descricao: descricao ?? null },
      aviso: 'Confirme o status no extrato (asaas_extrato): o Asaas pode deixar a transferência pendente de autorização ou de processamento.',
      limites: consumoDoDia(esc, c),
      registro: 'Registrado com quem pediu.',
    };
  });
}

// ----------------------------------------------------------------- limites e destinos (consulta)

export async function limitesEDestinos({ asaas, esc }: CtxEscrita, a: { unidade: string }) {
  const c = contaDeEscrita(asaas, esc, a.unidade);
  await esc.livro.carregar(c.slug);
  const lidos = esc.destinos(c.slug);
  return {
    unidade: c.slug,
    escritaLigada: true,
    limites: consumoDoDia(esc, c),
    transferencia: lidos.ligada
      ? { ligada: true, destinosPermitidos: lidos.destinos.map(mostrarDestino), problemasNaConfiguracao: lidos.problemas }
      : { ligada: false, motivo: textoSemDestinos(c.slug), problemasNaConfiguracao: lidos.problemas },
    naoExiste: 'alterar dados bancários da clínica, chaves de API, webhooks, usuários do Asaas, antecipação, empréstimo e pagar contas (boleto de terceiros); cadastrar destino de transferência pelo chat',
  };
}
