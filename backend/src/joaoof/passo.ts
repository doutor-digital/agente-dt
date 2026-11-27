/**
 * O passo periódico do Joaoof (a cada minuto, só no líder — ver `worker.ts`): entrega o resumo das 8h e das 18h (Brasília/Tocantins)
 * e, quando houver, roda o lote de triagem (fase 1b). A decisão de ENVIAR fica em `avisos.ts`; aqui só se decide QUANDO.
 */
import { offsetMinutosNoFuso, partesNoFuso } from '../lib/fuso.js';
import { entregar, chaveDoResumo, type DepsEntrega } from './avisos.js';
import { FUSO_DO_JOAO, HORAS_DO_RESUMO, type ModoJoaoof } from './config.js';
import { montarResumo } from './resumo.js';

export interface DepsPasso extends DepsEntrega {
  modo: () => ModoJoaoof;
  /** linhas de alerta do próprio Joaoof (fonte parada, teto de gasto) que sobem no resumo */
  alertas: () => Promise<string[]>;
  /** a triagem em lote (PR da leitura dos grupos); ausente = só os resumos */
  lote?: () => Promise<void>;
  registrar: (nivel: 'info' | 'warn' | 'error', dados: Record<string, unknown>, mensagem: string) => void;
}

/** Meia-noite de hoje no fuso do João, como instante UTC. */
export function inicioDoDia(agora: Date): Date {
  const p = partesNoFuso(agora, FUSO_DO_JOAO);
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia) - offsetMinutosNoFuso(agora, FUSO_DO_JOAO) * 60_000);
}

export async function enviarResumoDaHora(deps: DepsPasso, hora: 8 | 18): Promise<string> {
  const agora = deps.agora();
  // a hora inteira passa por aqui a cada minuto: quem já saiu (ou já foi decidido em seco) não custa nem uma consulta de demandas
  const antes = await deps.repo.buscarAviso('resumo', `${deps.modo() === 'seco' ? 'seco:' : ''}${chaveDoResumo(agora, hora)}`);
  if (antes && (antes.enviado || antes.seco)) return 'repetido';
  const abertas = await deps.repo.listarDemandas({ status: ['aberta', 'em_andamento'], limite: 200 });
  let feitasHoje = 0;
  if (hora === 18) {
    // o filtro vai ao banco: a lista de feitas só cresce, e um corte por quantidade esconderia as de hoje
    feitasHoje = (await deps.repo.listarDemandas({ status: ['feita'], resolvidaDesde: inicioDoDia(agora), limite: 300 })).length;
  }
  const texto = montarResumo({ agora, hora, abertas, feitasHoje, unidades: await deps.repo.unidades(), alertas: await deps.alertas() });
  if (!texto) return 'vazio';
  const r = await entregar(deps, { tipo: 'resumo', chave: chaveDoResumo(agora, hora), texto });
  deps.registrar(r === 'falhou' ? 'warn' : 'info', { hora, resultado: r, abertas: abertas.length }, 'joaoof: resumo');
  return r;
}

export async function passoDoJoaoof(deps: DepsPasso): Promise<void> {
  if (deps.modo() === 'desligado') return;
  const hora = partesNoFuso(deps.agora(), FUSO_DO_JOAO).hora;
  for (const h of HORAS_DO_RESUMO) {
    if (hora === h) await enviarResumoDaHora(deps, h);
  }
  if (deps.lote) await deps.lote();
}
