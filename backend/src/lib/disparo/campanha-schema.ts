/** O formato de uma campanha de disparo, sem banco: a rota e o conector do Claude leem o MESMO schema. */
import { z } from 'zod';
import { OFERTA_MAX } from './regras.js';

export const slugDaCampanha = z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/);

const cabecalho = z.object({ tipo: z.enum(['image', 'video', 'document']), link: z.string().url().startsWith('https://'), nomeArquivo: z.string().max(120).optional() });
const porUnidade = z.record(z.object({ template: z.string().min(1).max(512).optional(), cabecalho: cabecalho.nullish() }));

/**
 * Os campos da campanha, UMA vez só, sem padrão: ausente é ausente. Quem decide o que ausente significa é `salvarCampanha`:
 * na rota PUT é "troca tudo" (volta ao padrão); no conector do Claude, atualizar é "muda só o que mandei".
 */
export const camposDaCampanha = {
  /** obrigatório ao CRIAR; ao atualizar, ausente = mantém o que está salvo */
  nome: z.string().min(2).max(120).optional(),
  template: z.string().min(1).max(512).nullish(),
  idioma: z.string().min(2).max(12).optional(),
  textoModelo: z.string().min(1).max(4096).optional(),
  variaveis: z.array(z.string().min(1).max(200)).max(10).optional(),
  cabecalho: cabecalho.nullish(),
  porUnidade: porUnidade.optional(),
  /** ausente = mantém a que está salva; null ou vazio = apaga */
  oferta: z.string().max(OFERTA_MAX).nullish(),
};

/** A rota PUT troca a campanha inteira: nome e texto do modelo são obrigatórios. */
export const campanhaSchema = z.object({ ...camposDaCampanha, nome: z.string().min(2).max(120), textoModelo: z.string().min(1).max(4096) });

/** O que chega a `salvarCampanha`: a rota manda tudo que a campanha exige; o conector manda só o que vai mudar. */
export type CampanhaEntrada = z.infer<z.ZodObject<typeof camposDaCampanha>>;
