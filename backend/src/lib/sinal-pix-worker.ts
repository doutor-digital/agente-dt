/**
 * A BAIXA do sinal por Pix, sem webhook (Sofia 2.0). Regras de criação do link em `sinal-pix.ts`.
 *
 * Os webhooks do Asaas dessas contas apontam para outro sistema (o RH/Caixa) e criar webhook é proibido neste cliente. Então, a cada 5
 * minutos, para cada unidade com sinal e links pendentes, o worker LÊ `GET /payments?billingType=PIX&dateCreated[ge]=…` (só leitura) e
 * casa pelo `payment.paymentLink === linkId`. Cobrança de outra origem (o Caixa, outro link) nunca casa.
 *
 *  - RECEIVED/CONFIRMED → o sinal vira `pago` e o cartão ganha "✓ Consulta pg antecipado" = Sim (o campo que a régua e o Valor da Consulta
 *    já leem como PROVA de pagamento: o valor passa de R$ 350 para R$ 250 pela correção que o robô do Valor da Consulta já faz) e uma NOTA
 *    "Sinal de R$ 50 pago no Asaas (pay_…)". NÃO escreve "¤ Pagamento antecipado" (é ele que dispara os modelos de WhatsApp com a chave Pix)
 *    e NÃO mexe em etapa. Escreve uma vez: só se o campo ainda não está marcado.
 *  - Link vencido há mais de 2 dias sem pagamento → `expirado` + nota para a SDR. Não cobra o paciente (a SDR decide).
 *  - Seco: decide e registra («gravaria») na tela de Automações e no log; não toca no banco nem no Kommo.
 *
 * Chave `sinal-pix` (SINAL_PIX_SLUGS): desligado não faz nada. Falha do Asaas ou do Kommo numa unidade = tenta na varredura seguinte.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import { asaasGet, ErroAsaas } from './integracoes/asaas.js';
import { fusoDaUnidade } from './fuso.js';
import { chaveDaClinica, diaCurto, diaNoFuso, ID_SINAL_PIX, somarDias, type LinhaDoSinal } from './sinal-pix.js';
import { pagouOAntecipado } from './follow-up-worker.js';
import { normalizar } from './franquia-sync.js';
import { conversaDoLeadChatwoot } from './chatwoot-lead.js';
import { contaChatwootDoAmbiente, criarContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { portaDoChatwoot } from './chatwoot-porta.js';

const SWEEP_MS = Number(process.env.SINAL_PIX_SWEEP_MS) || 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;
const MAX_PENDENTES_POR_UNIDADE = 200;
const POR_PAGINA = 100;
const MAX_PAGINAS = 30;
/** Dias depois do fim do link em que ainda se espera o pagamento (um Pix gerado no último dia pode ser pago depois). */
export const CARENCIA_DO_LINK_DIAS = 2;
/** Link pendente que passou DISTO do fim sem que dê para ler o Asaas (chave revogada, 403 permanente) deixa de ser tentado: vira expirado, sem nota. */
export const DIAS_PARA_DESISTIR = 30;
/** Chave que o Asaas recusa (401/403) não adianta tentar de 5 em 5 minutos: espera isto antes de tentar de novo. */
const ESPERA_CHAVE_RECUSADA_MS = 60 * 60_000;
const chaveRecusadaAte = new Map<string, number>();
export const CAMPO_PAGO = '✓ Consulta pg antecipado';
const STATUS_QUE_PAGAM = new Set(['RECEIVED', 'CONFIRMED']);

export interface PagamentoDoAsaas {
  id: string;
  paymentLink?: string | null;
  /** o Pix copia-e-cola de valor fixo (`POST /pix/qrCodes/static`) que originou a cobrança */
  pixQrCodeId?: string | null;
  status?: string;
  value?: number;
  billingType?: string;
}

export type Decisao =
  | { tipo: 'pago'; linha: LinhaDoSinal; paymentId: string }
  | { tipo: 'expirou'; linha: LinhaDoSinal };

/**
 * Casa os links pendentes com os pagamentos lidos. Puro. Um link só quita com cobrança DELE (`paymentLink` igual), com status de dinheiro
 * que entrou e valor pelo menos igual ao do sinal.
 */
export function conciliar(pendentes: readonly LinhaDoSinal[], pagamentos: readonly PagamentoDoAsaas[], hoje: string, leituraCompleta = true): Decisao[] {
  const porLink = new Map<string, PagamentoDoAsaas>();
  for (const p of pagamentos) {
    if (!p.id || !STATUS_QUE_PAGAM.has(String(p.status))) continue;
    if (p.billingType && p.billingType !== 'PIX') continue;
    // o sinal é um link de pagamento (antes de 11/11) ou um Pix copia-e-cola de valor fixo: casa pelo id de quem originou a cobrança
    for (const origem of [p.paymentLink, p.pixQrCodeId]) {
      if (origem && !porLink.has(String(origem))) porLink.set(String(origem), p);
    }
  }
  const saida: Decisao[] = [];
  for (const linha of pendentes) {
    if (linha.status !== 'pendente') continue;
    const p = porLink.get(linha.linkId);
    if (p && Math.round(Number(p.value ?? 0) * 100) >= linha.valorCentavos) {
      saida.push({ tipo: 'pago', linha, paymentId: p.id });
    } else if (leituraCompleta && somarDias(linha.venceEm, CARENCIA_DO_LINK_DIAS) < hoje) {
      // só vence com a leitura COMPLETA: se faltou página, o pagamento pode estar justamente nas que não vieram
      saida.push({ tipo: 'expirou', linha });
    }
  }
  return saida;
}

type Leitor = (caminho: string, query: Record<string, string | number | undefined>) => Promise<unknown>;

/**
 * Os pagamentos PIX com dinheiro entrado desde `desde` (AAAA-MM-DD), paginado. Só leitura. `completa` = false quando o teto de páginas cortou a
 * leitura (conta muito movimentada): quem concilia então só dá baixa, nunca declara link vencido.
 */
export async function pagamentosDesde(ler: Leitor, desde: string): Promise<{ pagamentos: PagamentoDoAsaas[]; completa: boolean }> {
  const todos: PagamentoDoAsaas[] = [];
  let completa = true;
  for (const status of ['RECEIVED', 'CONFIRMED']) {
    for (let pagina = 0; ; pagina++) {
      if (pagina >= MAX_PAGINAS) {
        completa = false;
        break;
      }
      const r = (await ler('/payments', { billingType: 'PIX', status, 'dateCreated[ge]': desde, limit: POR_PAGINA, offset: pagina * POR_PAGINA })) as { data?: PagamentoDoAsaas[]; hasMore?: boolean } | null;
      todos.push(...(r?.data ?? []));
      if (!r?.hasMore) break;
    }
  }
  return { pagamentos: todos, completa };
}

const reais = (centavos: number) => `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;

export const notaDoPagamento = (l: LinhaDoSinal, paymentId: string) => `💸 Sinal de ${reais(l.valorCentavos)} pago no Asaas (${paymentId}). O restante é pago no dia da consulta.`;
export const notaDoVencimento = (l: LinhaDoSinal) =>
  `⏳ O link do sinal de ${reais(l.valorCentavos)} venceu em ${diaCurto(l.venceEm)} sem pagamento. Nada foi cobrado do paciente: a SDR decide (novo link, pagar no dia ou liberar o horário).`;

/** O valor "Sim" para o tipo do campo na conta: caixa de seleção ou lista; outro tipo = não sabe gravar (null). */
export function valoresDoSim(campo: { type: string; enums: Array<{ id: number; value: string }> }): Array<Record<string, unknown>> | null {
  if (campo.type === 'checkbox') return [{ value: true }];
  if (campo.type === 'select' || campo.type === 'radiobutton') {
    const sim = campo.enums.find((e) => normalizar(e.value) === 'sim');
    return sim ? [{ enum_id: sim.id }] : null;
  }
  return null;
}

export interface DepsDaBaixa {
  kommo: Pick<KommoClient, 'getLead' | 'listarCamposDoCartao' | 'gravarCamposDoLead' | 'addLeadNote'>;
}

/**
 * Pago: marca "✓ Consulta pg antecipado" (se ainda não está) e deixa a nota. Lança se o Kommo falhar (quem chama tenta de novo na próxima
 * varredura). Cartão que não existe mais (apagado/fundido) não trava a fila: devolve false.
 */
export async function marcarPagoNoCartao(deps: DepsDaBaixa, leadId: number, nota: string): Promise<boolean> {
  const lead = await deps.kommo.getLead(leadId).catch((err: unknown) => {
    if (/\b404\b|not found/i.test(String(err))) return null;
    throw err;
  });
  if (!lead) return false;
  if (!pagouOAntecipado(lead.custom_fields_values?.map((c) => ({ field_name: (c as { field_name?: string }).field_name, values: c.values })))) {
    const campos = await deps.kommo.listarCamposDoCartao();
    const campo = campos.find((c) => normalizar(c.name) === normalizar(CAMPO_PAGO));
    const valores = campo ? valoresDoSim(campo) : null;
    if (campo && valores) await deps.kommo.gravarCamposDoLead(leadId, [{ field_id: campo.id, values: valores }]);
    else logger.warn({ leadId, campo: CAMPO_PAGO, tipo: campo?.type ?? null }, 'sinal-pix: não sei marcar o campo de pagamento neste cartão — só a nota');
  }
  await deps.kommo.addLeadNote(leadId, nota);
  return true;
}

/** Etiqueta que a régua do Chatwoot já lê como «pagou antes» (no lugar do «✓ Consulta pg antecipado» do Kommo). */
export const ETIQUETA_PAGOU = 'pagou-antecipado';

/** A baixa de um sinal de conversa do Chatwoot (chave sintética de `chatwoot-lead.ts`): etiqueta + nota, sem Kommo. */
export interface BaixaNoChatwoot {
  /** soma a etiqueta, preservando as outras (o Chatwoot substitui a lista inteira) */
  etiqueta(conversa: number, etiqueta: string): Promise<void>;
  nota(conversa: number, texto: string): Promise<void>;
}

export async function baixarNoChatwoot(deps: BaixaNoChatwoot, conversa: number, nota: string, pago: boolean): Promise<void> {
  // NÃO mexe em `pagamento_antecipado` nem na etapa: é esse atributo que dispara a mensagem com a chave Pix na régua
  if (pago) await deps.etiqueta(conversa, ETIQUETA_PAGOU);
  await deps.nota(conversa, nota);
}

function baixaDoChatwootDoAmbiente(): BaixaNoChatwoot | null {
  const conta = contaChatwootDoAmbiente();
  if (!conta) return null;
  const chat = portaDoChatwoot(criarContextoChatwoot(conta));
  return { etiqueta: (conversa, etiqueta) => chat.adicionarEtiquetas(conversa, [etiqueta]), nota: (conversa, texto) => chat.nota(conversa, texto) };
}

export async function notaNoCartao(deps: DepsDaBaixa, leadId: number, nota: string): Promise<void> {
  await deps.kommo.addLeadNote(leadId, nota);
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;

const estado = (slug: string) => estadoDaAutomacao(slug, ID_SINAL_PIX, process.env.SINAL_PIX_SLUGS);

export async function varrerUnidade(unit: Unit, seco: boolean, chatwoot: BaixaNoChatwoot | null = baixaDoChatwootDoAmbiente()): Promise<void> {
  // Pendentes + os que já mudaram de status mas ainda não deixaram a nota no cartão (o Kommo falhou na vez anterior).
  const linhas = (await prisma.sinalPix.findMany({
    where: { unitId: unit.id, OR: [{ status: 'pendente' }, { status: { in: ['pago', 'expirado'] }, avisadoEm: null }] },
    orderBy: { criadoEm: 'asc' },
    take: MAX_PENDENTES_POR_UNIDADE,
  })) as LinhaDoSinal[];
  if (linhas.length === 0) return;
  const hoje = diaNoFuso(new Date(), fusoDaUnidade(unit));

  // Pendente que já passou da hora de desistir sai da fila (a leitura do Asaas pode estar falhando para sempre): expirado, sem nota.
  const velhas = linhas.filter((l) => l.status === 'pendente' && somarDias(l.venceEm, DIAS_PARA_DESISTIR) < hoje);
  for (const l of velhas) {
    if (seco) continue;
    await prisma.sinalPix.updateMany({ where: { id: l.id, status: 'pendente' }, data: { status: 'expirado', avisadoEm: new Date() } }).catch(() => undefined);
    logger.warn({ unit: unit.slug, leadId: l.leadId, linkId: l.linkId }, `${ID_SINAL_PIX}: link pendente há mais de ${DIAS_PARA_DESISTIR} dias do fim — desisti dele`);
  }
  const pendentes = linhas.filter((l) => l.status === 'pendente' && !velhas.includes(l));
  let decisoes: Decisao[] = [];
  if (pendentes.length > 0) {
    const conta = await chaveDaClinica({ id: unit.id, slug: unit.slug });
    if (!conta) {
      logger.warn({ unit: unit.slug, pendentes: pendentes.length }, `${ID_SINAL_PIX}: a unidade tem sinais pendentes mas não tem chave do Asaas — nada a ler`);
    } else if ((chaveRecusadaAte.get(conta.unitId) ?? 0) > Date.now()) {
      // chave recusada há pouco: não insiste de 5 em 5 minutos (os cartões já pagos/vencidos abaixo seguem sendo atualizados)
    } else {
      const menor = pendentes.reduce((m, l) => (l.criadoEm < m ? l.criadoEm : m), pendentes[0]!.criadoEm);
      const desde = menor.toISOString().slice(0, 10);
      let lidos: Awaited<ReturnType<typeof pagamentosDesde>> | null = null;
      try {
        lidos = await pagamentosDesde((caminho, query) => asaasGet(conta.unitId, conta.chave, caminho, query), somarDias(desde, -1));
      } catch (err) {
        if (!(err instanceof ErroAsaas && (err.status === 401 || err.status === 403))) throw err;
        chaveRecusadaAte.set(conta.unitId, Date.now() + ESPERA_CHAVE_RECUSADA_MS);
        logger.warn({ unit: unit.slug, status: err.status }, `${ID_SINAL_PIX}: o Asaas recusou a chave — espero 1 h antes de tentar de novo (links pendentes ficam sem baixa até lá)`);
      }
      if (lidos) {
        if (!lidos.completa) logger.warn({ unit: unit.slug }, `${ID_SINAL_PIX}: leitura do Asaas cortada no teto de páginas — só dá baixa nesta varredura, não vence link`);
        decisoes = conciliar(pendentes, lidos.pagamentos, hoje, lidos.completa);
      }
    }
  }

  const kommo = createKommoClient(unit);
  const aplicar = async (linha: LinhaDoSinal, nota: string, pago: boolean) => {
    const leadId = Number(linha.leadId);
    const conversa = conversaDoLeadChatwoot(leadId);
    if (conversa !== null) {
      // sinal de uma conversa do Chatwoot: não existe cartão no Kommo para esse id. Sem o Chatwoot no ambiente, tenta na próxima varredura.
      if (!chatwoot) throw new Error('sinal de conversa do Chatwoot, mas o Chatwoot não está configurado neste servidor');
      await baixarNoChatwoot(chatwoot, conversa, nota, pago);
    } else if (pago) await marcarPagoNoCartao({ kommo }, leadId, nota);
    else await notaNoCartao({ kommo }, leadId, nota);
    await prisma.sinalPix.update({ where: { id: linha.id }, data: { avisadoEm: new Date() } });
  };

  for (const d of decisoes) {
    const leadId = Number(d.linha.leadId);
    if (seco) {
      registrarSimulacao(unit, ID_SINAL_PIX, d.tipo === 'pago'
        ? { leadId, acao: 'gravaria', alvo: CAMPO_PAGO, valor: 'Sim', motivo: `sinal pago no Asaas (${d.paymentId}); nota no cartão` }
        : { leadId, acao: 'gravaria', alvo: 'Nota: sinal vencido', valor: notaDoVencimento(d.linha), motivo: 'link do sinal venceu sem pagamento' });
      continue;
    }
    try {
      // O banco primeiro (o dinheiro entrou: isso é fato); o cartão depois, e `avisadoEm` só quando o cartão foi atualizado.
      // O status só muda uma vez: `updateMany` condicionado a `pendente` (duas cópias do servidor no deploy não duplicam a nota).
      if (d.tipo === 'pago') {
        const mudou = await prisma.sinalPix.updateMany({ where: { id: d.linha.id, status: 'pendente' }, data: { status: 'pago', paymentId: d.paymentId, pagoEm: new Date() } });
        if (mudou.count !== 1) continue;
        await aplicar(d.linha, notaDoPagamento(d.linha, d.paymentId), true);
        logger.info({ unit: unit.slug, leadId, paymentId: d.paymentId }, `${ID_SINAL_PIX}: sinal pago — cartão atualizado`);
      } else {
        const mudou = await prisma.sinalPix.updateMany({ where: { id: d.linha.id, status: 'pendente' }, data: { status: 'expirado' } });
        if (mudou.count !== 1) continue;
        await aplicar(d.linha, notaDoVencimento(d.linha), false);
        logger.info({ unit: unit.slug, leadId, linkId: d.linha.linkId }, `${ID_SINAL_PIX}: link vencido sem pagamento — nota no cartão`);
      }
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, `${ID_SINAL_PIX}: falha ao atualizar o cartão — tenta na próxima varredura`);
    }
  }

  // Cartões que já mudaram de status e ficaram sem nota (Kommo fora do ar na vez anterior).
  for (const l of linhas.filter((x) => x.status !== 'pendente')) {
    if (seco) continue;
    try {
      await aplicar(l, l.status === 'pago' ? notaDoPagamento(l, l.paymentId ?? '') : notaDoVencimento(l), l.status === 'pago');
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId: l.leadId }, `${ID_SINAL_PIX}: o cartão ainda não aceitou a nota do sinal`);
    }
  }
}

/**
 * As unidades com sinal a baixar (pendente, ou pago/vencido ainda sem nota no cartão), INDEPENDENTE da flag `sinalPixCentavos`: desligar o sinal
 * numa unidade não pode deixar um Pix já enviado sem baixa. O interruptor geral continua sendo a automação `sinal-pix` (SINAL_PIX_SLUGS / seco).
 */
export async function unidadesComBaixaPendente(): Promise<Unit[]> {
  const comSinal = await prisma.sinalPix.findMany({
    where: { OR: [{ status: 'pendente' }, { status: { in: ['pago', 'expirado'] }, avisadoEm: null }] },
    distinct: ['unitId'],
    select: { unitId: true },
  });
  if (comSinal.length === 0) return [];
  return prisma.unit.findMany({ where: { isActive: true, id: { in: comSinal.map((l) => l.unitId) } }, orderBy: { id: 'asc' } });
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await unidadesComBaixaPendente();
    for (const unit of units) {
      const e = estado(unit.slug);
      if (e === 'desligado' || !unit.kommoAccessToken) continue;
      await varrerUnidade(unit, e === 'seco').catch((err) => logger.warn({ err: String(err), unit: unit.slug }, `${ID_SINAL_PIX}: varredura falhou`));
    }
  } finally {
    rodando = false;
  }
}

export function startSinalPixWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(`${ID_SINAL_PIX}: worker iniciado`);
}

export function stopSinalPixWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
