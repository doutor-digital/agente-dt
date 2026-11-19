/**
 * O WhatsApp da GERENTE da caixa para quem precisa avisá-la: o «lead quente parado» da régua (que nunca saiu: faltava `CHATWOOT_GERENTE_WHATSAPP`)
 * e os avisos de demora. O número mora em `crm_tarefa_zap` (tela Tarefas), o mesmo das atendentes. Arquivo à parte, com poucos imports, para a régua
 * poder usá-lo sem puxar o worker da demora (que importa a Sofia, que importa a régua).
 */
import { prisma } from '../prisma.js';
import { estadoDaAutomacao, type Estado } from '../automacoes-estado.js';
import { GERENTE_DA_CAIXA } from '../chatwoot-unidades.js';
import { AUTOMACAO_DEMORA } from './marca.js';

/** A clínica de DEMONSTRAÇÃO (conta 2 do CRM, caixa de canal API): nunca liga automação nenhuma — a demora fica DESLIGADA nela, não em seco. */
export const UNIDADES_SEM_DEMORA: ReadonlySet<string> = new Set(['clinica-demonstracao']);

export const modoDaDemora = (slug: string, env: NodeJS.ProcessEnv = process.env): Estado => (UNIDADES_SEM_DEMORA.has(slug) ? 'desligado' : estadoDaAutomacao(slug, AUTOMACAO_DEMORA, env.CHATWOOT_DEMORA_SLUGS));

/** O WhatsApp da gerente da caixa em `crm_tarefa_zap`; null = sem gerente na caixa ou sem número cadastrado. */
export async function numeroDaGerenteNoBanco(conta: number, caixa: number): Promise<string | null> {
  const gerente = GERENTE_DA_CAIXA[caixa];
  if (!gerente) return null;
  const z = await prisma.crmTarefaZap.findUnique({ where: { conta_agenteId: { conta, agenteId: gerente } } });
  return z?.telefone ?? null;
}
