/**
 * A Magalhães Advocacia tem UMA unidade: slug `magalhaes-advocacia` (criada em 24/10/2026, conta Kommo magalhaesadv2025).
 * O seed antigo usava `advocacia-magalhaes` e criaria uma SEGUNDA unidade; a tag de data de entrada (graph.ts) usava o slug errado
 * e nunca valeu. O slug mora aqui, num lugar só, para o seed, o grafo e os testes não divergirem de novo.
 */
export const SLUG_MAGALHAES = 'magalhaes-advocacia';
export const KOMMO_SUBDOMAIN_MAGALHAES = 'magalhaesadv2025';
