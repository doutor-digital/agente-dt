/** Datas da conversa (dia local da unidade) em instantes que o Kommo entende (epoch em segundos). */
import { instanteNoFuso } from '../franquia-mcp/normalizar.js';

/**
 * Início (00:00:00) ou fim (23:59:59) do dia `AAAA-MM-DD` no fuso da unidade, em epoch (s).
 * Acha o deslocamento do fuso naquele instante e corrige; uma segunda passada cobre a troca de horário.
 */
export function epochDoDiaLocal(data: string, fuso: string, fimDoDia = false): number {
  const hora = fimDoDia ? 'T23:59:59Z' : 'T00:00:00Z';
  const alvo = Date.parse(`${data}${hora}`);
  let t = alvo;
  for (let i = 0; i < 2; i++) {
    const comoLocal = Date.parse(`${instanteNoFuso(new Date(t), fuso)}Z`);
    t += alvo - comoLocal;
  }
  return Math.floor(t / 1000);
}

/** Hoje, no fuso da unidade, em AAAA-MM-DD. */
export function hojeNoFuso(fuso: string, agora = new Date()): string {
  return instanteNoFuso(agora, fuso).slice(0, 10);
}
