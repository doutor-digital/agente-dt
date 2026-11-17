/**
 * QUEM APROVA e QUANTO CABE, por unidade, no disparo pelo CRM.
 *
 *  - Aprovar um disparo é decisão de rede: por padrão SÓ administrador da Doutor Digital (a mesma lista do kit de unidade: `KIT_ADMINS_DD`,
 *    com o padrão de `lerAdminsDD`). Com o ajuste `gerenteAprova` da unidade ligado, a administradora da clínica (papel «administrator» NA
 *    CONTA dela, conferido pelo Chatwoot) também aprova. Desligado de fábrica. O e-mail vem do perfil que o Chatwoot devolve para o login —
 *    nunca do que o navegador diz.
 *  - O teto do NÚMERO (TIER da Meta): o teto por 24 h do motor nunca passa dele. É a Doutor Digital quem informa (a unidade não escolhe).
 */
import { prisma } from '../../prisma.js';
import { lerAdminsDD } from '../../kit-unidade/fase2.js';
import type { Freios } from '../freios.js';

export interface AjusteDaUnidade {
  gerenteAprova: boolean;
  tierDoNumero: string | null;
}
export const AJUSTE_DE_FABRICA: AjusteDaUnidade = { gerenteAprova: false, tierDoNumero: null };

export async function ajusteDaUnidade(unitId: string): Promise<AjusteDaUnidade> {
  const a = await prisma.chatwootDisparoAjuste.findUnique({ where: { unitId } });
  return a ? { gerenteAprova: a.gerenteAprova === true, tierDoNumero: a.tierDoNumero ?? null } : AJUSTE_DE_FABRICA;
}

export async function gravarAjuste(unitId: string, dados: Partial<AjusteDaUnidade>, por: string): Promise<AjusteDaUnidade> {
  const a = await prisma.chatwootDisparoAjuste.upsert({
    where: { unitId },
    create: { unitId, gerenteAprova: dados.gerenteAprova ?? false, tierDoNumero: dados.tierDoNumero ?? null, atualizadoPor: por.slice(0, 120) },
    update: { ...(dados.gerenteAprova !== undefined ? { gerenteAprova: dados.gerenteAprova } : {}), ...(dados.tierDoNumero !== undefined ? { tierDoNumero: dados.tierDoNumero } : {}), atualizadoPor: por.slice(0, 120) },
  });
  return { gerenteAprova: a.gerenteAprova, tierDoNumero: a.tierDoNumero };
}

/** Os e-mails dos administradores da Doutor Digital (minúsculos). */
export function administradoresDD(env: NodeJS.ProcessEnv = process.env): string[] {
  return lerAdminsDD(env.KIT_ADMINS_DD).lista.map((e) => e.trim().toLowerCase());
}

export const ehAdministradorDD = (email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean =>
  !!email && administradoresDD(env).includes(email.trim().toLowerCase());

export type QuemAprova = { ok: true; como: 'administrador-dd' | 'administradora-da-clinica' } | { ok: false; motivo: string };

/** `papel` = o papel da pessoa NESTA conta do CRM (`administrator` | `agent`), do perfil conferido pelo Chatwoot. */
export function quemAprova(pessoa: { email: string | null | undefined; papel: string | null | undefined }, ajuste: AjusteDaUnidade, env: NodeJS.ProcessEnv = process.env): QuemAprova {
  if (ehAdministradorDD(pessoa.email, env)) return { ok: true, como: 'administrador-dd' };
  if (ajuste.gerenteAprova && pessoa.papel === 'administrator') return { ok: true, como: 'administradora-da-clinica' };
  return {
    ok: false,
    motivo: ajuste.gerenteAprova
      ? 'só a administração da Doutor Digital ou a administradora da clínica aprova um disparo'
      : 'só a administração da Doutor Digital aprova um disparo (a clínica pode pedir para liberar a aprovação pela administradora)',
  };
}

/** «TIER_250» → 250 · «TIER_1K» → 1000 · «TIER_100K» → 100000 · «TIER_UNLIMITED» ou lixo → `null` (sem teto próprio). */
export function tetoDoTier(tier: string | null | undefined): number | null {
  const m = /^TIER_(\d{1,7})(K|M)?$/i.exec((tier ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2]?.toUpperCase() === 'M' ? 1_000_000 : m[2] ? 1_000 : 1);
  return n > 0 ? n : null;
}

export const tierValido = (tier: unknown): tier is string => typeof tier === 'string' && /^TIER_(\d{1,7})(K|M)?$/i.test(tier.trim());

/** Os freios do ambiente com o teto do número: o teto por hora e por 24 h nunca passam do TIER (as demais regras são as do motor, intactas). */
export function freiosComOTier(f: Freios, tier: string | null | undefined): Freios {
  const teto = tetoDoTier(tier);
  return teto === null ? f : { ...f, tetoPorDia: Math.min(f.tetoPorDia, teto), tetoPorHora: Math.min(f.tetoPorHora, teto) };
}
