/**
 * O que a API aceita em `units.pipeline_intents` (a tela de unidade devolve o JSON inteiro ao salvar).
 *
 * Toda chave é um id (inteiro positivo: etapa, campo, robô), EXCETO `origem_por_texto` — a lista `[{ texto, origem, anuncio, contem }]` da
 * automação `origem-texto-pronto` — que é a ÚNICA que aceita lista. Lista em outra chave seria lida por quem espera número (ex.: a etapa do
 * `handoff_scheduling` vai para o `moveStage`), então é 400. E `origem_por_texto` tem de ser lista.
 */
import { z } from 'zod';
import { CHAVE_DA_LISTA } from './origem-texto-pronto.js';

const entradaDaLista = z.object({
  texto: z.string().min(15).max(500),
  origem: z.string().min(1).max(120),
  anuncio: z.boolean().optional(),
  // precisa estar aqui: o z.object descarta chave desconhecida, e salvar pela tela apagaria a regra do formulário
  contem: z.boolean().optional(),
});

export const pipelineIntentsSchema = z
  .record(z.string(), z.union([z.coerce.number().int().positive(), z.array(entradaDaLista).max(50)]))
  .superRefine((intents, ctx) => {
    for (const [chave, valor] of Object.entries(intents)) {
      const ehLista = Array.isArray(valor);
      if (chave === CHAVE_DA_LISTA && !ehLista) ctx.addIssue({ code: 'custom', path: [chave], message: `${chave} tem de ser uma lista de {texto, origem, anuncio, contem}` });
      if (chave !== CHAVE_DA_LISTA && ehLista) ctx.addIssue({ code: 'custom', path: [chave], message: `${chave} tem de ser um número (só ${CHAVE_DA_LISTA} aceita lista)` });
    }
  });
