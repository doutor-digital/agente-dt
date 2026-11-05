/**
 * O miolo do Copiloto, sem rede e sem banco: monta o prompt, pergunta ao modelo (injetado), lê a resposta sem
 * confiar nela e passa as sugestões pelo portão. O controlador só liga isto ao Kommo e à OpenAI.
 */
import type { PerfilDaUnidade } from './perfil-da-unidade.js';
import type { ContextoDoCartao } from './contexto.js';
import type { PapelDeQuemUsa } from './mapa-de-campos.js';
import { anonimizar } from './anonimizar.js';
import { filtrarResposta } from './filtro-da-resposta.js';
import { interpretarResposta, montarPrompt, type FalaParaIa, type TurnoDoHistorico } from './prompt.js';
import { triarSugestoes, type SugestaoAceita, type SugestaoRecusada } from './triagem.js';

export interface ChamadaAoModelo {
  system: string;
  user: string;
}
export interface RespostaDoModelo {
  texto: string;
  promptTokens: number;
  completionTokens: number;
}
export type ChamarModelo = (p: ChamadaAoModelo) => Promise<RespostaDoModelo>;

export interface EntradaDoCopiloto {
  ctx: ContextoDoCartao;
  conversa: FalaParaIa[];
  pergunta: string;
  historico?: TurnoDoHistorico[];
  papel?: PapelDeQuemUsa;
  /** Nomes do paciente (título do cartão, contato): trocados por [paciente] em TUDO que vai para a IA. */
  nomes?: string[];
  /** Como a unidade funciona hoje (Sofia, movimentação, sincronização). */
  perfil?: PerfilDaUnidade | null;
}
export interface SaidaDoCopiloto {
  resposta: string;
  sugestoes: SugestaoAceita[];
  naoSugeri: SugestaoRecusada[];
  etapa: string | null;
  aviso?: string;
}

const SEM_RESPOSTA = 'Não consegui responder agora. Tente de novo em instantes.';

export async function responderAoCopiloto(chamar: ChamarModelo, e: EntradaDoCopiloto): Promise<{ saida: SaidaDoCopiloto; uso: { promptTokens: number; completionTokens: number } }> {
  const limpar = (t: string) => anonimizar(t, e.nomes ?? []);
  const prompt = montarPrompt({ ctx: e.ctx, papel: e.papel, conversa: e.conversa, historico: e.historico, pergunta: e.pergunta, limpar, perfil: e.perfil });
  const r = await chamar(prompt);
  const uso = { promptTokens: r.promptTokens, completionTokens: r.completionTokens };
  const lida = interpretarResposta(r.texto, prompt.codigos);
  const avisoEtapa = e.ctx.etapa ? undefined : 'Esta etapa não está no padrão da rede, então não sugiro campos.';
  if (!lida) return { saida: { resposta: SEM_RESPOSTA, sugestoes: [], naoSugeri: [], etapa: e.ctx.etapaNome, aviso: avisoEtapa }, uso };
  // sem etapa conhecida o portão recusa tudo (não há "campos da etapa"): é o comportamento certo
  const { aceitas, recusadas } = triarSugestoes(lida.sugestoes, e.ctx, e.papel ?? 'sdr');
  return { saida: { resposta: filtrarResposta(lida.resposta, e.ctx, e.papel ?? 'sdr'), sugestoes: aceitas, naoSugeri: recusadas, etapa: e.ctx.etapaNome, aviso: avisoEtapa }, uso };
}
