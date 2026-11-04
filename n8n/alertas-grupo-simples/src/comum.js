// ===== AUXILIARES (iguais nos dois nós; o build cola este bloco nos dois) =====
const MIN = 60 * 1000;
const HORA = 60 * MIN;
const BRT = -3 * HORA; // America/Sao_Paulo = UTC-3 (sem horário de verão desde 2019)
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
// Relógio de parede de Brasília: campos UTC de uma data deslocada em -3h.
const brt = (ts) => {
  const d = new Date(ts + BRT);
  const p2 = (n) => String(n).padStart(2, '0');
  return { hora: d.getUTCHours(), dia: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` };
};
const emSilencio = (ts, c) => { const h = brt(ts).hora; return h >= c.SILENCIO_INICIO || h < c.SILENCIO_FIM; };
// Próximo SILENCIO_FIM:00 (hora de Brasília) a partir de ts.
const proximoFimDoSilencio = (ts, c) => {
  const l = new Date(ts + BRT);
  let alvo = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), c.SILENCIO_FIM, 0, 0);
  if (alvo <= ts + BRT) alvo += 24 * HORA;
  return alvo - BRT;
};
// Só atribui o que falta: o n8n marca o static data como "mudou" a cada atribuição, e queremos gravar só quando há mudança de verdade.
const iniciaSd = (sd) => {
  const pad = { fila: {}, saida: [], dedupe: {}, envios: {}, ultimoSlot: {}, contagem: {}, log: [], ultimoEnvio: 0, tetoLog: 0 };
  for (const k in pad) if (sd[k] === undefined) sd[k] = pad[k];
  return sd;
};
const conta = (sd, ts, chave) => {
  const d = brt(ts).dia;
  sd.contagem[d] = sd.contagem[d] || {};
  sd.contagem[d][chave] = (sd.contagem[d][chave] || 0) + 1;
};
const registra = (sd, ts, linha) => {
  const p = brt(ts);
  sd.log.push(`${p.dia} ${String(p.hora).padStart(2, '0')}:${String(new Date(ts).getUTCMinutes()).padStart(2, '0')} ${linha}`);
  if (sd.log.length > 120) sd.log.splice(0, sd.log.length - 120);
};
// "há 25 min" / "há 1h05" / "há 2h" / "há 3 horas" -> ms (0 se não achar).
const esperaEmMs = (t) => {
  const mh = String(t).match(/h[áa]\s+(\d+)\s*h(?:oras?)?(?:\s*e?\s*(\d{1,2})(?!\d))?/i);
  if (mh) return (Number(mh[1]) * 60 + Number(mh[2] || 0)) * MIN;
  const mm = String(t).match(/h[áa]\s+(\d+)\s*(?:min|minutos?)\b/i);
  return mm ? Number(mm[1]) * MIN : 0;
};
const humanizar = (ms) => {
  const min = Math.max(0, Math.round(ms / MIN));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`;
};
