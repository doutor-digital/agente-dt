/**
 * Preenche o «⌂ Unidade» do cartão — o campo que o modelo da primeira sessão lê. Regras em `unidade-no-cartao.ts`.
 *
 * A cada 5 minutos, por unidade:
 *  1. os cartões que MEXERAM desde a rodada anterior (novos, que mudaram de etapa, que a SDR editou), de qualquer
 *     etapa — cartão novo fica pronto em minutos, muito antes de chegar em EM TRATAMENTO;
 *  2. um pedaço do ESTOQUE: a conta inteira do cartão mais novo ao mais velho, PERDIDO fora, 4 páginas por rodada.
 *     Terminou, só volta a passar 24 h depois (pega quem alguém esvaziou e o que escapou).
 *
 * No máximo 200 gravações por unidade e rodada (em seco, 200 "gravaria"): cada gravação dispara webhook no agente
 * e no dashboard, e o estoque antigo entra aos poucos em vez de numa rajada. A gravação mexe na "última
 * atualização" do cartão — o prazo de 30 dias da CONFERIR NA FRANQUIA (franquia-move) recomeça uma vez.
 *
 * Chave `unidade-no-cartao` na tela de Automações: desligado não faz nada; "só no papel" registra o que gravaria
 * na lista "o que ela faria"; ligado grava. "Diverge" (valor posto à mão que não fala da cidade) é só registro.
 */
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoClient, type KommoLead } from '../services/kommo.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { unidadeNoCartao } from './trava-unidade-atendimento.js';
import {
  CAMPO_UNIDADE_MODELO,
  VALOR_POR_UNIDADE,
  acharCampoDoModelo,
  caberNoTeto,
  planejarUnidadeNoCartao,
  type PlanoUnidadeNoCartao,
  type ValorDaUnidade,
} from './unidade-no-cartao.js';

const ID = 'unidade-no-cartao';
const SWEEP_MS = 5 * 60_000;
const PRIMEIRA_VARREDURA_MS = 2 * 60_000;
/** Na 1ª rodada (ou depois de religar) olha a última meia hora; depois, desde a rodada anterior menos a folga. */
const JANELA_INICIAL_MS = 30 * 60_000;
const FOLGA_MS = 2 * 60_000;
const PAGINAS_RECENTES = 4;
const PAGINAS_DO_ESTOQUE_POR_RODADA = 4;
const ESTOQUE_A_CADA_MS = 24 * 3600_000;
const MAX_GRAVACOES_POR_RODADA = 200;
/** O Kommo aceita até 50 cartões num PATCH. */
const LOTE = 50;
const POR_PAGINA = 250;
const PAUSA_ENTRE_LOTES_MS = 500;
/** Fechado como perdido no Kommo. */
const PERDIDO = 143;

interface Estoque {
  /** o modo em que esta passada começou: trocar de seco pra ligado recomeça, senão o simulado ficaria sem gravar */
  seco: boolean;
  pagina: number;
  terminouEm: number;
  /** cartões já tratados nesta passada (gravados, simulados ou que falharam): a página relida pula eles */
  tratados: Set<number>;
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;
let rodando = false;
const ultimaVarredura = new Map<string, number>();
const estoques = new Map<string, Estoque>();
const avisados = new Set<string>();

const pausa = () => new Promise((r) => setTimeout(r, PAUSA_ENTRE_LOTES_MS));

function avisarUmaVez(slug: string, msg: string): void {
  if (avisados.has(`${slug}:${msg}`)) return;
  avisados.add(`${slug}:${msg}`);
  logger.warn({ unit: slug }, `${ID}: ${msg}`);
}

function valorDoCampo(lead: KommoLead, fieldId: number): string | null {
  const v = lead.custom_fields_values?.find((f) => f.field_id === fieldId)?.values?.[0]?.value;
  return v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim();
}

type Planejado = { leadId: number } & PlanoUnidadeNoCartao;

interface Resumo {
  gravados: number;
  trocados: number;
  diverge: number;
  semUnidade: number;
  erros: number;
}

/** Planeja os cartões; "diverge" vai direto pra tela (não grava nada) e não entra na fila. */
function planejar(
  unit: { id: string; slug: string },
  leads: ReadonlyArray<KommoLead>,
  regra: ValorDaUnidade,
  fieldId: number,
  resumo: Resumo,
): Planejado[] {
  const fila: Planejado[] = [];
  for (const lead of leads) {
    const noCartao = valorDoCampo(lead, fieldId);
    const atendimento = 'porAtendimento' in regra ? unidadeNoCartao(lead) : null;
    const plano = planejarUnidadeNoCartao({ regra, noCartao, atendimento });
    if (!plano) {
      if ('porAtendimento' in regra && !atendimento && !noCartao) resumo.semUnidade++;
      continue;
    }
    if (plano.acao === 'diverge') {
      resumo.diverge++;
      registrarSimulacao(unit, ID, { leadId: lead.id, acao: 'diverge', alvo: CAMPO_UNIDADE_MODELO, valor: plano.valor, noCartao: plano.noCartao, motivo: plano.motivo });
      continue;
    }
    fila.push({ leadId: lead.id, ...plano });
  }
  return fila;
}

async function gravar(
  kommo: KommoClient,
  unit: { id: string; slug: string },
  fieldId: number,
  fila: ReadonlyArray<Planejado>,
  seco: boolean,
  resumo: Resumo,
): Promise<void> {
  if (seco) {
    for (const p of fila) {
      const noCartao = p.acao === 'trocar' ? p.noCartao : undefined;
      registrarSimulacao(unit, ID, { leadId: p.leadId, acao: 'gravaria', alvo: CAMPO_UNIDADE_MODELO, valor: p.valor, noCartao, motivo: p.motivo });
    }
    return;
  }
  const corpo = (p: Planejado) => [{ field_id: fieldId, values: [{ value: p.valor }] }];
  const contar = (p: Planejado) => (p.acao === 'trocar' ? resumo.trocados++ : resumo.gravados++);
  for (let i = 0; i < fila.length; i += LOTE) {
    const lote = fila.slice(i, i + LOTE);
    try {
      await kommo.atualizarLeadsEmLote(lote.map((p) => ({ id: p.leadId, custom_fields_values: corpo(p) })));
      lote.forEach(contar);
    } catch (err) {
      // um cartão ruim (apagado, travado) derruba o PATCH inteiro: grava um a um pra isolar
      logger.warn({ err: String(err), unit: unit.slug, cartoes: lote.length }, `${ID}: lote recusado — gravando um a um`);
      for (const p of lote) {
        try {
          await kommo.gravarCamposDoLead(p.leadId, corpo(p));
          contar(p);
        } catch (e) {
          resumo.erros++;
          logger.warn({ err: String(e), unit: unit.slug, leadId: p.leadId }, `${ID}: falha ao gravar`);
        }
      }
    }
    await pausa();
  }
}

async function varrerUnidade(slug: string, regra: ValorDaUnidade): Promise<void> {
  const estado = estadoDaAutomacao(slug, ID, process.env.UNIDADE_NO_CARTAO_SLUGS);
  if (estado === 'desligado') {
    // religar recomeça do zero: a janela de 30 min e o estoque do começo
    ultimaVarredura.delete(slug);
    estoques.delete(slug);
    return;
  }
  const seco = estado === 'seco';

  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit?.kommoAccessToken) return;
  const kommo = createKommoClient(unit);

  const campo = acharCampoDoModelo(await kommo.listLeadCustomFieldsTyped());
  if (!campo) return avisarUmaVez(slug, `a conta não tem o campo "${CAMPO_UNIDADE_MODELO}" (ou tem dois com esse nome)`);
  if (campo.type !== 'text' && campo.type !== 'textarea') return avisarUmaVez(slug, `o campo "${CAMPO_UNIDADE_MODELO}" é do tipo ${campo.type}, não texto`);

  const resumo: Resumo = { gravados: 0, trocados: 0, diverge: 0, semUnidade: 0, erros: 0 };
  let estoque = estoques.get(slug);
  if (!estoque || estoque.seco !== seco) {
    estoque = { seco, pagina: 1, terminouEm: 0, tratados: new Set() };
    estoques.set(slug, estoque);
  }

  // 1. os que mexeram
  const inicio = Date.now();
  const desde = Math.floor(((ultimaVarredura.get(slug) ?? inicio - JANELA_INICIAL_MS) - FOLGA_MS) / 1000);
  const recentes: KommoLead[] = [];
  for (let pagina = 1; pagina <= PAGINAS_RECENTES; pagina++) {
    const lote = await kommo.listLeadsPagina(pagina, { atualizadosDesde: desde });
    recentes.push(...lote);
    if (lote.length < POR_PAGINA) break;
  }
  ultimaVarredura.set(slug, inicio);
  const { entram: daJanela } = caberNoTeto(planejar(unit, recentes, regra, campo.id, resumo), MAX_GRAVACOES_POR_RODADA);
  for (const p of daJanela) estoque.tratados.add(p.leadId);
  await gravar(kommo, unit, campo.id, daJanela, seco, resumo);
  let restante = MAX_GRAVACOES_POR_RODADA - daJanela.length;

  // 2. o estoque
  const paginaAntes = estoque.pagina;
  if (Date.now() - estoque.terminouEm >= ESTOQUE_A_CADA_MS) {
    for (let i = 0; i < PAGINAS_DO_ESTOQUE_POR_RODADA && restante > 0; i++) {
      const pagina = await kommo.listLeadsPagina(estoque.pagina);
      const candidatos = pagina.filter((l) => l.status_id !== PERDIDO && !estoque.tratados.has(l.id));
      const { entram, paginaInteira } = caberNoTeto(planejar(unit, candidatos, regra, campo.id, resumo), restante);
      for (const p of entram) estoque.tratados.add(p.leadId);
      await gravar(kommo, unit, campo.id, entram, seco, resumo);
      restante -= entram.length;
      if (!paginaInteira) break; // o resto desta página entra na próxima rodada
      if (pagina.length < POR_PAGINA) {
        estoque.pagina = 1;
        estoque.terminouEm = Date.now();
        estoque.tratados.clear();
        logger.info({ unit: slug, seco }, `${ID}: estoque inteiro conferido — volta em 24 h`);
        break;
      }
      estoque.pagina++;
    }
  }

  if (resumo.gravados || resumo.trocados || resumo.erros || MAX_GRAVACOES_POR_RODADA - restante > 0) {
    logger.info({ unit: slug, seco, ...resumo, planejados: MAX_GRAVACOES_POR_RODADA - restante, paginaDoEstoque: paginaAntes }, `${ID}: varredura`);
  }
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    for (const [slug, regra] of Object.entries(VALOR_POR_UNIDADE)) {
      await varrerUnidade(slug, regra).catch((err) => logger.warn({ err: String(err), unit: slug }, `${ID}: varredura falhou`));
    }
  } finally {
    rodando = false;
  }
}

export function startUnidadeNoCartaoWorker(): void {
  if (timer) return;
  primeira = setTimeout(() => void varrer(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrer(), SWEEP_MS);
  logger.info(`${ID}: worker iniciado`);
}

export function stopUnidadeNoCartaoWorker(): void {
  if (primeira) clearTimeout(primeira);
  if (timer) clearInterval(timer);
  primeira = null;
  timer = null;
}
