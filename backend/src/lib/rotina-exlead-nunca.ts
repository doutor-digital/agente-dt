/**
 * O estado da régua ex-lead (chave `ROTINA_EXLEAD_SLUGS`). Fica num arquivo à parte para o catálogo e o painel poderem perguntar sem
 * importar o worker inteiro.
 */
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';

export const ID_ROTINA_EXLEAD = 'rotina-exlead';

export const estadoDoExLead = (slug: string, raw: string | undefined = process.env.ROTINA_EXLEAD_SLUGS): Estado => estadoDaAutomacao(slug, ID_ROTINA_EXLEAD, raw);
