import { ToolMessage, type AIMessage, type BaseMessage } from '@langchain/core/messages';

import { looksLikeName } from '../agent/name-capture.js';
import { nomeAncoradoNaConversa } from '../agent/titulo-ancorado.js';
import type { Falha } from './checks.js';

/**
 * A "segunda volta" do banco dourado — o que o grafo da produção faz e o eval não fazia.
 *
 * Na produção (`agent/graph.ts`: agent → tools → agent, sem condição na volta) a Sofia pode começar o
 * turno só com uma ferramenta de BASTIDOR — pôr a etiqueta "Quente", gravar a Queixa, trocar o título do
 * cartão — sem texto nenhum. O grafo executa a ferramenta e chama o modelo de novo, e é NESSA chamada que
 * sai a fala para o paciente (medido em 27/11/2026, 7 dias: aplicar_tag 328/328, atualizar_titulo_lead
 * 435/435, mover_etapa 326/326 e registra_* 692/692 turnos tiveram nova chamada do modelo depois).
 *
 * O eval só olhava a PRIMEIRA chamada. Quando o modelo abria com a etiqueta, o caso saía "(sem texto)" e
 * reprovava — Boa Vista "onde fica?" em 25/11 e 27/11, Porto "quero marcar" em 26/11 — e o relatório
 * diário acusava a Sofia de ficar muda, o que na produção não acontece.
 *
 * Aqui: se a resposta não tem texto e TODAS as chamadas são de bastidor que a produção ACEITARIA, devolvemos
 * a cada uma um resultado no estilo "OK — …" e chamamos o modelo de novo, até `MAX_VOLTAS`. Nada é
 * executado. Fica de fora (o eval segue avaliando a chamada planejada, como sempre):
 *  - ferramenta cujo RESULTADO muda a fala (`consultar_horarios`, `agendar_consulta`, `pausar_ia`…);
 *  - bastidor que a produção RECUSARIA e cujo texto de recusa manda a Sofia falar outra coisa: título que
 *    não parece nome ou não está nas falas do paciente ("NÃO gravei… pergunte o nome"), e mover para as
 *    etapas 142/143 ("RECUSADO… use outra ferramenta"). Inventar um "OK" aí seria testar outra conversa.
 */

/** Bastidor fixo: etiqueta, título, etapa e a captura unificada de campos (`registrar_campo`, ligada pelo ambiente do serviço). */
const BASTIDOR_FIXO = new Set(['aplicar_tag', 'atualizar_titulo_lead', 'mover_etapa', 'registrar_campo']);
/** Etapas de ganho e perdido: a produção recusa movê-las por `mover_etapa` (agent/tools.ts). */
const ETAPAS_RECUSADAS = new Set([142, 143]);

/** Voltas EXTRAS além da primeira chamada. Um turno de bastidor que não fala em 2 voltas já é sinal de erro. */
export const MAX_VOLTAS = 2;

export interface ChamadaDeFerramenta {
  name: string;
  id?: string;
  args?: Record<string, unknown>;
}

export interface ContextoDaVolta {
  /** Nomes das ferramentas por regra de campo da unidade (`lead_field_rules.toolName`: registra_*, salvar_*, marcar_*…). */
  nomesDeCampo: ReadonlySet<string>;
  /** O que o paciente escreveu na conversa do caso — a prova que a produção exige para gravar um nome no título. */
  falasDoPaciente: readonly string[];
}

export function ehDeBastidor(nome: string, nomesDeCampo: ReadonlySet<string> = new Set()): boolean {
  return BASTIDOR_FIXO.has(nome) || nomesDeCampo.has(nome);
}

/** PURA: a produção aceitaria esta chamada de bastidor? Quando ela recusaria com um texto que muda a fala, não há volta. */
export function producaoAceitaria(c: ChamadaDeFerramenta, ctx: ContextoDaVolta): boolean {
  if (c.name === 'mover_etapa') {
    const etapa = Number(c.args?.statusId);
    return Number.isFinite(etapa) && !ETAPAS_RECUSADAS.has(etapa);
  }
  if (c.name === 'atualizar_titulo_lead') {
    const nome = typeof c.args?.nome === 'string' ? c.args.nome : '';
    // Mais rígido que a produção de propósito: lá, sem âncora nas falas, ela ainda lê o contato no Kommo — aqui não há Kommo.
    return looksLikeName(nome) && nomeAncoradoNaConversa(nome, ctx.falasDoPaciente).ancorado;
  }
  return true;
}

/** PURA: a resposta precisa de outra volta? Só sem texto, com chamadas, todas de bastidor aceito e com id (sem id não há como responder a chamada). */
export function precisaDeOutraVolta(
  texto: string,
  chamadas: readonly ChamadaDeFerramenta[],
  ctx: ContextoDaVolta,
): boolean {
  if (texto.trim() !== '') return false;
  if (chamadas.length === 0) return false;
  return chamadas.every(
    (c) =>
      ehDeBastidor(c.name, ctx.nomesDeCampo) &&
      typeof c.id === 'string' &&
      c.id.length > 0 &&
      producaoAceitaria(c, ctx),
  );
}

/** PURA: um resultado no estilo "OK — …" da produção (agent/tools.ts), sem executar nada e sem citar teste. */
export function resultadoSimulado(c: ChamadaDeFerramenta): string {
  if (c.name === 'aplicar_tag') return 'OK — tag aplicada no lead.';
  if (c.name === 'mover_etapa') return 'OK — lead movido de etapa.';
  if (c.name === 'atualizar_titulo_lead') return 'OK — título atualizado.';
  return 'OK — campo gravado no cartão.';
}

/** As respostas de ferramenta que fecham as chamadas de bastidor, na ordem em que vieram. */
export function respostasSimuladas(chamadas: readonly ChamadaDeFerramenta[]): ToolMessage[] {
  return chamadas.map(
    (c) => new ToolMessage({ content: resultadoSimulado(c), tool_call_id: c.id as string, name: c.name }),
  );
}

export interface ResultadoDasVoltas {
  /** A última resposta do modelo — a que vira a fala avaliada. */
  resposta: AIMessage;
  /** As chamadas de bastidor das voltas anteriores (para contar como "ferramentas chamadas"). */
  anteriores: ChamadaDeFerramenta[];
  voltas: number;
}

/**
 * Chama o modelo e, enquanto a resposta for só bastidor aceito, devolve os resultados e chama de novo.
 * `mensagens` é estendida no lugar (como o estado do grafo da produção).
 */
export async function invocarComVoltas(
  invocar: (m: BaseMessage[]) => Promise<AIMessage>,
  mensagens: BaseMessage[],
  ctx: ContextoDaVolta,
  textoDe: (content: unknown) => string,
): Promise<ResultadoDasVoltas> {
  let resposta = await invocar(mensagens);
  const anteriores: ChamadaDeFerramenta[] = [];
  let voltas = 0;
  while (voltas < MAX_VOLTAS) {
    const chamadas = (resposta.tool_calls ?? []) as ChamadaDeFerramenta[];
    if (!precisaDeOutraVolta(textoDe(resposta.content), chamadas, ctx)) break;
    anteriores.push(...chamadas);
    mensagens.push(resposta, ...respostasSimuladas(chamadas));
    resposta = await invocar(mensagens);
    voltas++;
  }
  return { resposta, anteriores, voltas };
}

/**
 * PURA: depois de uma volta, a Sofia terminou sem falar? A conferência `resposta_vazia` (checks.ts) só olha
 * "sem texto E sem chamada" — e as chamadas somadas das voltas a escondiam. Sem esta regra, a Sofia muda de
 * verdade (29 de 1384 turnos com bastidor em 7 dias na produção) passaria como aprovada.
 */
export function vaziaDepoisDaVolta(
  voltas: number,
  textoFinal: string,
  chamadasFinais: readonly ChamadaDeFerramenta[],
  nomesDeCampo: ReadonlySet<string>,
): Falha | null {
  if (voltas === 0) return null;
  if (textoFinal.trim() !== '') return null;
  // Terminou numa ferramenta de verdade (consultar_horarios…): é a chamada planejada que se avalia, como sempre.
  if (chamadasFinais.some((c) => !ehDeBastidor(c.name, nomesDeCampo))) return null;
  return {
    regra: 'resposta_vazia',
    detalhe: `a IA fez ${voltas} volta(s) só com ferramentas de bastidor e terminou sem falar nada ao paciente`,
  };
}
