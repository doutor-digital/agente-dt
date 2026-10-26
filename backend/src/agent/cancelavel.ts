/**
 * Só se cancela consulta FUTURA e DE PÉ. Sênior no #132: `consultaDoLead` devolve ATENDIDA como "confirmada" (só desmarcado e
 * não-compareceu viram "cancelada"), então a ferramenta cancelaria no franquia uma consulta que já aconteceu — e a Sofia diria
 * "cancelei" para quem foi atendido ontem. Passada, em andamento ou com status de encerrada: nunca.
 */
import { SpineService } from '../services/spine.service.js';

const ENCERRADOS: Record<number, string> = {
  [SpineService.SPINE_STATUS.ATENDIDO]: 'já foi ATENDIDA',
  [SpineService.SPINE_STATUS.NAO_COMPARECEU]: 'está como NÃO COMPARECEU',
  [SpineService.SPINE_STATUS.DESMARCADO]: 'já está DESMARCADA',
};

/**
 * Por que NÃO cancelar — ou null (pode). `quando`: "AAAA-MM-DDTHH:mm" local da clínica; `agoraLocal`: o mesmo formato, agora.
 * Sem `quando` não há como provar que é futura: não cancela.
 */
export function motivoDeNaoCancelar(
  c: { quando: string | null | undefined; idStatus?: number | null },
  agoraLocal: string,
): string | null {
  if (c.idStatus != null && ENCERRADOS[c.idStatus]) return `a consulta ${ENCERRADOS[c.idStatus]} na clínica`;
  if (!c.quando) return 'não sei o dia e a hora da consulta';
  if (c.quando.slice(0, 16) <= agoraLocal.slice(0, 16)) return 'a consulta já passou ou está acontecendo agora';
  return null;
}
