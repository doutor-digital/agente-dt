// Webhook interno: só o gatilho de 1 minuto deve chamá-lo. Exige o mesmo segredo do webhook de entrada e um corpo bem formado.
const SEGREDO = '__SEGREDO_WEBHOOK__';     // o importar.sh troca por um valor aleatório
const it = $input.first().json;
const b = it.body || {};
if (!SEGREDO || SEGREDO.startsWith('__')) return [];           // sem segredo configurado: fechado
if (String((it.query || {}).k || '') !== SEGREDO) return [];
const ok = typeof b.instancia === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(b.instancia)
  && typeof b.number === 'string' && /^(\d{8,20}|[0-9-]{10,40}@g\.us)$/.test(b.number)
  && typeof b.text === 'string' && b.text.length > 0 && b.text.length < 2000;
if (!ok) return [];
return [{ json: { instancia: b.instancia, number: b.number, text: b.text, delay: Number(b.delay) || 0, linkPreview: false, mentioned: Array.isArray(b.mentioned) ? b.mentioned.slice(0, 5).map(String) : undefined } }];
