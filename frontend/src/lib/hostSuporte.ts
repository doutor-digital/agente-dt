/**
 * Os endereços que abrem DIRETO no painel do suporte (só administrador geral): suporte.doutordigitalconsultoria.com e
 * chamados.doutordigitalconsultoria.com. Qualquer outro endereço (agente.*, localhost, preview da Vercel) abre o console de sempre.
 * Só o começo do nome do host conta: "suporte.evil.com" também passaria aqui, mas quem decide o que o login pode ver é a API
 * (requireSuperAdmin) e a lista de origens aceitas (FRONTEND_ORIGIN) — este teste só escolhe a tela.
 */
export const PREFIXOS_DO_HOST_DE_SUPORTE = ['suporte.', 'chamados.'] as const;

export function ehHostDoSuporte(hostname: string): boolean {
  const h = String(hostname ?? '').toLowerCase();
  return PREFIXOS_DO_HOST_DE_SUPORTE.some((p) => h.startsWith(p));
}
