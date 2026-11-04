// ===== CONFIG (edite aqui) =====
const INSTANCIA = 'alertas3';              // << ÚNICO lugar da instância da Evolution. Fixa: o corpo da chamada NUNCA escolhe a instância.
const SEGREDO_ENVIO = '__SEGREDO_ENVIO__'; // segredo PRÓPRIO deste webhook (o importar.sh gera); NÃO é o que vai na URL do Kommo
const DELAY_MAX_MS = 5000;                 // teto do "digitando…"
//__CONFIG__

// Webhook interno: só o gatilho de 1 minuto deve chamá-lo. Mesmo que o segredo vaze, ele só consegue mandar texto
// (até 2000 car.) para os grupos de UNITS e para o número de teste, pela instância fixa acima, com menção só de quem está em UNITS.
const it = $input.first().json;
const b = it.body || {};
if (!SEGREDO_ENVIO || SEGREDO_ENVIO.startsWith('__')) return [];   // sem segredo configurado: fechado
if (String((it.query || {}).k || '') !== SEGREDO_ENVIO) return [];
const jidsPermitidos = new Set([TEST_NUM, ...Object.values(UNITS).map((u) => u.jid).filter(Boolean)]);
const mencoesPermitidas = new Set(Object.values(UNITS).map((u) => u.mention).filter(Boolean).map((n) => `${n}@s.whatsapp.net`));
if (typeof b.number !== 'string' || !jidsPermitidos.has(b.number)) return [];
if (typeof b.text !== 'string' || !b.text.length || b.text.length >= 2000) return [];
const mentioned = Array.isArray(b.mentioned) ? b.mentioned.map(String).filter((m) => mencoesPermitidas.has(m)).slice(0, 3) : [];
return [{ json: {
  instancia: INSTANCIA, number: b.number, text: b.text,
  delay: Math.min(Math.max(Number(b.delay) || 0, 0), DELAY_MAX_MS),
  linkPreview: false, mentioned: mentioned.length ? mentioned : undefined,
} }];
