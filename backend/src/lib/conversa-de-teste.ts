/**
 * Conversa livre de TESTE com a Sofia, na página pública `/aprendizados/:slug` (pedido de 12/11/2026: a dona de Timbó quer
 * testar como no playground do console, sem ser super admin).
 *
 * O que mora aqui são as travas de custo e de forma. O isolamento (agenda fictícia, nada para Kommo/franquia/Asaas/WhatsApp)
 * vem de `rodarTesteDaSofia` (playground.controller.ts): as ferramentas dele são simuladas.
 *  - teto de respostas por unidade por dia (env `APRENDIZADOS_CONVERSA_MAX_POR_DIA`, padrão 60; 0 = conversa desligada);
 *  - no máximo `MAX_EM_ANDAMENTO` respostas ao mesmo tempo por unidade (o teto não vale se 50 pedidos entram juntos);
 *  - o histórico vem do navegador (nada fica no banco): aqui ele é conferido e encurtado.
 * Contadores em memória do processo: reinício zera, o que só dá folga (mesmo molde das prévias).
 */
import { diaDe } from './aprendizados-unidade.js';

export const MAX_RESPOSTAS_TESTE_PADRAO = 60;
/** Mensagens (paciente + Sofia) que a conversa leva: 20 turnos. O navegador guarda o mesmo tanto. */
export const MAX_MENSAGENS_DA_CONVERSA = 40;
export const MAX_CARACTERES_DA_FALA = 600;
/** Uma fala da Sofia devolvida pelo navegador entra cortada neste tamanho: o histórico é contexto, e resposta de WhatsApp é curta. */
export const MAX_CARACTERES_DA_RESPOSTA = 1500;
/**
 * Teto do histórico INTEIRO que vem do navegador (letras somadas): sem ele, 40 mensagens de 600 + 1500 letras seriam ~42 mil
 * letras reenviadas ao modelo a cada resposta. Estourou, saem os turnos mais antigos (a última fala do paciente fica sempre).
 */
export const MAX_TOTAL_DO_HISTORICO = 14_000;
export const MAX_EM_ANDAMENTO = 2;

/** Teto diário por unidade. Lido a cada chamada: a env muda sem recompilar (e o teste troca). */
export function maxRespostasTeste(): number {
  const bruto = process.env.APRENDIZADOS_CONVERSA_MAX_POR_DIA;
  if (bruto == null || bruto.trim() === '') return MAX_RESPOSTAS_TESTE_PADRAO;
  const n = Number(bruto);
  return Number.isInteger(n) && n >= 0 ? n : MAX_RESPOSTAS_TESTE_PADRAO;
}

export type Fala = { role: 'user' | 'assistant'; content: string };

/**
 * Confere e encurta o histórico que o navegador mandou. Fica com as últimas `MAX_MENSAGENS_DA_CONVERSA`, começa numa fala
 * do paciente e termina numa fala do paciente (é a ela que a Sofia vai responder).
 */
export function prepararHistorico(bruto: ReadonlyArray<{ role: string; content: string }>): { ok: true; messages: Fala[] } | { ok: false; erro: string } {
  const falas: Fala[] = [];
  for (const m of bruto) {
    if (m.role !== 'user' && m.role !== 'assistant') return { ok: false, erro: 'pedido inválido' };
    const content = m.content.trim();
    if (!content) continue;
    // fala do paciente longa demais: recusa (a página limita a digitação). Fala da Sofia longa: corta, nunca recusa — senão uma
    // resposta grande, guardada no navegador, travaria toda a conversa até o "Recomeçar".
    if (m.role === 'user' && content.length > MAX_CARACTERES_DA_FALA) {
      return { ok: false, erro: `Fala longa demais: até ${MAX_CARACTERES_DA_FALA} letras.` };
    }
    falas.push({ role: m.role, content: m.role === 'user' ? content : content.slice(0, MAX_CARACTERES_DA_RESPOSTA) });
  }
  const fim = falas.slice(-MAX_MENSAGENS_DA_CONVERSA);
  let total = fim.reduce((n, f) => n + f.content.length, 0);
  while (fim.length > 1 && total > MAX_TOTAL_DO_HISTORICO) total -= fim.shift()!.content.length;
  while (fim.length > 0 && fim[0].role !== 'user') fim.shift();
  if (fim.length === 0 || fim[fim.length - 1].role !== 'user') return { ok: false, erro: 'Escreva uma fala de paciente para a Sofia responder.' };
  return { ok: true, messages: fim };
}

/** Como a página conta o que a Sofia "fez" no teste (ferramenta simulada → frase simples). */
export function descreverAcao(a: { tool: string; args: Record<string, unknown>; result: string }): string {
  switch (a.tool) {
    case 'consultar_horarios':
      return 'Consultou a agenda (fictícia)';
    case 'agendar_consulta':
      return /CONSULTA MARCADA/.test(a.result)
        ? `Marcaria a consulta ${String(a.args.data ?? '')} ${String(a.args.hora ?? '')} (de mentira)`.replace(/\s+/g, ' ')
        : 'Tentou marcar, o horário não estava livre';
    case 'cadastrar_paciente':
      return 'Cadastraria o paciente (de mentira)';
    case 'buscar_paciente':
      return 'Procurou o cadastro do paciente (de mentira)';
    case 'gerar_sinal_pix':
      return 'Geraria o Pix do sinal (link de exemplo)';
    case 'pausar_ia':
      return 'Pararia de responder e chamaria a equipe';
    case 'resumir_lead_para_sdr':
      return 'Deixaria um resumo para a equipe';
    case 'mover_etapa':
      return 'Moveria o cartão de etapa';
    case 'aplicar_tag':
      return 'Poria uma etiqueta no cartão';
    case 'atualizar_titulo_lead':
      return 'Trocaria o nome do cartão';
    case 'remarcar_consulta':
      return 'Remarcaria a consulta (de mentira)';
    case 'cancelar_consulta':
      return 'Cancelaria a consulta (de mentira)';
    default:
      return `Simulou a ferramenta ${a.tool} (de mentira)`;
  }
}

// ── teto de respostas por unidade por dia ──
const respostas = new Map<string, { dia: string; n: number }>();

/** Conta uma resposta e diz se ainda cabe hoje. */
export function cabeResposta(slug: string, tz: string, agora: Date = new Date()): boolean {
  const dia = diaDe(agora, tz);
  const teto = maxRespostasTeste();
  const r = respostas.get(slug);
  if (!r || r.dia !== dia) {
    if (teto < 1) return false;
    respostas.set(slug, { dia, n: 1 });
    return true;
  }
  if (r.n >= teto) return false;
  r.n += 1;
  return true;
}

/** Devolve a resposta que não chegou a ser mostrada (modelo falhou): erro nosso não gasta o teto dela. */
export function devolverResposta(slug: string, tz: string, agora: Date = new Date()): void {
  const r = respostas.get(slug);
  if (r && r.dia === diaDe(agora, tz) && r.n > 0) r.n -= 1;
}

/** Respostas que restam hoje (para a página mostrar). */
export function respostasRestantes(slug: string, tz: string, agora: Date = new Date()): number {
  const teto = maxRespostasTeste();
  const r = respostas.get(slug);
  if (!r || r.dia !== diaDe(agora, tz)) return teto;
  return Math.max(0, teto - r.n);
}

// ── respostas ao mesmo tempo por unidade ──
const emAndamento = new Map<string, number>();

export function entrarEmAndamento(slug: string): boolean {
  const n = emAndamento.get(slug) ?? 0;
  if (n >= MAX_EM_ANDAMENTO) return false;
  emAndamento.set(slug, n + 1);
  return true;
}

export function sairDeAndamento(slug: string): void {
  const n = (emAndamento.get(slug) ?? 0) - 1;
  if (n > 0) emAndamento.set(slug, n);
  else emAndamento.delete(slug);
}

/** Só para teste. */
export function zerarConversasDeTeste(): void {
  respostas.clear();
  emAndamento.clear();
}
