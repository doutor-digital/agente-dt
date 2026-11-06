/**
 * O worker da caixa "Leads de entrada" (regras em `entrada-automatica.ts`). Roda a cada `ENTRADA_SWEEP_MS` (3 min) e fica de
 * olho só nas contas Kommo em que alguma unidade ligou `entrada-automatica` ou `entrada-estoque` na tela de Automações
 * (padrão: desligado; "só no papel" decide e mostra na tela, sem escrever nada).
 *
 * A caixa é da CONTA, não da unidade: unidades que dividem um Kommo (Imperatriz tem quatro) olham a mesma caixa. O estado da conta é o
 * mais cauteloso entre as unidades que ligaram: todas "ligado" = ligado; qualquer "só no papel" = só no papel. Unidade sem token
 * não conta (a irmã de um Kommo dividido não guarda credencial).
 *
 * Roda dentro do supervisor de líder único (`worker-lease.ts`): uma réplica só varre. Sem isso, duas réplicas aceitariam o mesmo lead.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { contaDividida } from './crm-compartilhado.js';
import { ID_ENTRADA, ID_ESTOQUE, configDoAmbiente, memoriaNova, rodarConta, type MemoriaDaConta } from './entrada-automatica.js';

const SWEEP_MS = Number(process.env.ENTRADA_SWEEP_MS) || 3 * 60_000;
const PRIMEIRA_VARREDURA_MS = 90_000;

const estadoRecente = (slug: string) => estadoDaAutomacao(slug, ID_ENTRADA, process.env.ENTRADA_AUTOMATICA_SLUGS);
const estadoEstoque = (slug: string) => estadoDaAutomacao(slug, ID_ESTOQUE, process.env.ENTRADA_ESTOQUE_SLUGS);

/**
 * Uma caixa, vários estados: ignora quem está desligado; todos ligados = ligado; qualquer "só no papel" entre os que ligaram
 * deixa a conta em "só no papel" (escrever só porque UMA unidade pediu seria ir além do que a outra confirmou).
 */
export function estadoDaConta(estados: readonly Estado[]): Estado {
  const ligadas = estados.filter((e) => e !== 'desligado');
  if (ligadas.length === 0) return 'desligado';
  return ligadas.every((e) => e === 'ligado') ? 'ligado' : 'seco';
}

/** As unidades por conta Kommo (subdomínio), por slug — COM e sem token: o estado de quem não guarda credencial também vale. */
export function agruparPorConta<T extends { slug: string; kommoSubdomain: string | null }>(units: readonly T[]): Map<string, T[]> {
  const contas = new Map<string, T[]>();
  for (const u of [...units].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const conta = u.kommoSubdomain?.trim().toLowerCase();
    if (!conta) continue;
    contas.set(conta, [...(contas.get(conta) ?? []), u]);
  }
  return contas;
}

const memorias = new Map<string, MemoriaDaConta>();
let rodando = false;
/** O worker foi parado (perdeu a liderança, SIGTERM): a rodada em andamento não escreve mais. */
let parado = false;

const avisados = new Set<string>();
function avisarUmaVez(conta: string, texto: string): void {
  if (avisados.has(`${conta}:${texto}`)) return;
  avisados.add(`${conta}:${texto}`);
  logger.warn({ conta }, `entrada-automatica: ${texto}`);
}

export async function varrerEntrada(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const units = await prisma.unit.findMany({ where: { isActive: true }, orderBy: { slug: 'asc' } });
    const cfg = configDoAmbiente();
    for (const [conta, membros] of agruparPorConta(units)) {
      const recente = estadoDaConta(membros.map((u) => estadoRecente(u.slug)));
      const estoque = estadoDaConta(membros.map((u) => estadoEstoque(u.slug)));
      if (recente === 'desligado' && estoque === 'desligado') continue;
      // quem fala com o Kommo: a unidade que ligou alguma das duas e guarda o token (senão, qualquer uma com token)
      const comToken = membros.filter((u) => !!u.kommoAccessToken);
      const dona: Unit | undefined =
        comToken.find((u) => estadoRecente(u.slug) !== 'desligado' || estadoEstoque(u.slug) !== 'desligado') ?? comToken[0];
      if (!dona) {
        avisarUmaVez(conta, 'ligada, mas nenhuma unidade da conta guarda o token do Kommo');
        continue;
      }
      // Kommo dividido entre clínicas (Petrópolis × Caxias antes da separação): a caixa não diz de qual unidade é o lead, e
      // vincular/aceitar no cartão da outra clínica não tem volta. Não mexe.
      if (await contaDividida(membros).catch(() => null)) {
        avisarUmaVez(conta, 'o Kommo é dividido entre unidades (unit_crm_compartilhado): a caixa não diz de quem é o lead — não mexo');
        continue;
      }
      const memoria = memorias.get(conta) ?? memoriaNova();
      memorias.set(conta, memoria);
      try {
        const resumo = await rodarConta(createKommoClientSemFreio(dona), {
          unit: { id: dona.id, slug: dona.slug },
          recente,
          estoque,
          agora: Math.floor(Date.now() / 1000),
          cfg,
          memoria,
          registrar: ({ automacao, ...s }) => registrarSimulacao(dona, automacao, s),
          cancelado: () => parado,
        });
        const mexeu = resumo.vinculados + resumo.aceitos + resumo.vincularia + resumo.aceitaria + resumo.ambiguos + resumo.erros;
        logger.info({ conta, recente, estoque, ...resumo }, mexeu > 0 ? 'entrada-automatica: rodada' : 'entrada-automatica: rodada sem novidade');
        if (resumo.listaTruncada) logger.warn({ conta, lidos: resumo.lidos }, 'entrada-automatica: a caixa tem mais leads do que o teto de páginas — o resto entra quando a fila andar');
      } catch (err) {
        logger.warn({ err: String(err), conta }, 'entrada-automatica: a conta falhou');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'entrada-automatica: a rodada falhou');
  } finally {
    rodando = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let primeira: NodeJS.Timeout | null = null;

export function startEntradaAutomaticaWorker(): void {
  if (timer) return;
  parado = false;
  primeira = setTimeout(() => void varrerEntrada(), PRIMEIRA_VARREDURA_MS);
  timer = setInterval(() => void varrerEntrada(), SWEEP_MS);
  const cfg = configDoAmbiente();
  logger.info({ sweepMs: SWEEP_MS, janelaMin: cfg.janelaS / 60, esperaMin: cfg.esperaS / 60, maxAvaliacoes: cfg.maxAvaliacoes, maxEscritas: cfg.maxEscritas }, 'entrada-automatica worker iniciado');
}

export function stopEntradaAutomaticaWorker(): void {
  parado = true;
  if (timer) clearInterval(timer);
  if (primeira) clearTimeout(primeira);
  timer = null;
  primeira = null;
}
