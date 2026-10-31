/**
 * O nono dígito do celular brasileiro — UMA regra, para o disparo (`telefoneWhatsapp`) e para o cadastro na franquia
 * (`SpineService.normalizarWhatsapp`).
 *
 * Desde 2016 todo celular do Brasil tem o 9 na frente dos MESMOS 8 dígitos, então para quem era celular o mapeamento é
 * determinístico. O que impede de errar de pessoa é a faixa: só se acrescenta o 9 quando o 1º dígito depois do DDD é 6, 7, 8
 * ou 9 (a faixa em que um celular legado começava). Começou com 2, 3, 4 ou 5 é telefone FIXO e fica como está — acrescentar o
 * 9 a ele cairia no número de outra pessoa. O DDD tem de existir (`DDDS_DO_BRASIL`): acrescentar o 9 a um DDD inventado é
 * fabricar telefone.
 *
 * Caso real (Timbó, 29/10/2026): o WhatsApp entregou o número sem o 9 (+554792919491); a IA cadastrou a paciente assim e a
 * recepção, 5 minutos depois, cadastrou a MESMA paciente com +5547992919491 — dois cadastros, e a consulta da recepção ficou
 * invisível para a IA. A comparação pelos 8 últimos dígitos (`fim8`) nunca dependeu do 9; o que faltava era gravar certo.
 *
 * Só dígitos entram e saem aqui, sem `+`. Número que não é "55 + DDD + 8" (13 dígitos, fixo, estrangeiro, lixo) volta `null`:
 * quem chama mantém o número como veio.
 */
import { DDDS_DO_BRASIL } from './ddds.js';

export function comNonoDigito(digitos: string): string | null {
  if (digitos.length !== 12 || !digitos.startsWith('55')) return null;
  if (!/[6-9]/.test(digitos[4])) return null;
  const ddd = digitos.slice(2, 4);
  if (!DDDS_DO_BRASIL.has(ddd)) return null;
  return `55${ddd}9${digitos.slice(4)}`;
}
