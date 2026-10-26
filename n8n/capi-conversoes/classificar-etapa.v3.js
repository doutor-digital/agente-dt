// ═══ ETAPA DA KOMMO → EVENTOS DA META (v3, cadeia com backfill + "pediu horário") ═══
// v2 (08/09/2026): todo lead QUENTE gera Lead; ao AGENDAR sai Lead (se ainda não saiu) + AddToCart;
// COMPARECEU = InitiateCheckout; GANHO = Purchase. Nunca em dobro: o event_id é determinístico
// (evento + lead) e o UNIQUE de capi_envios segura o repetido.
//
// O que a v3 acrescenta (decisão do João, 26/10/2026, revoga "Lead só com Quente" de 24/09):
//  - LeadSubmitted TAMBÉM quando o cartão leva a etiqueta "IA · Pediu horário" (cfg.pediuHorario.tag), que o
//    backend do agente põe quando a Sofia acha horário confirmado para oferecer. Só em etapa pré-agendamento
//    (cfg.preAgendado): de AGENDADO em diante a cadeia já emite o Lead.
//  - MESMO event_id do Quente (`quente-<id>`): quem chegar primeiro manda, o outro não duplica.
//  - Etiqueta de exclusão ("Alerta · Mora fora", "Fora do escopo") anula o sinal: não é lead para a campanha.
//  - event_time do "pediu horário" = quando o cartão foi atualizado (updated_at), nunca depois de agora; o
//    "Montar evento" ainda confere os 7 dias contra a hora do clique.
//  - cfg.pediuHorario.modo: 'desligado' (como a v2) | 'seco' (decide e grava 'simulado', NÃO chama a Meta) | 'ligado'.
//
// Nada muda para Quente/AGENDADO/COMPARECEU/GANHO: o caminho `via: 'quente'` é a v2 byte a byte.
const cfg = $('Config').first().json.cfg;
const pc = cfg.pediuHorario || { modo: 'desligado' };

function corpo(j) {
  if (!j) return {};
  if (typeof j === 'string') { try { return JSON.parse(j); } catch (e) { return {}; } }
  if (typeof j.data === 'string') { try { return JSON.parse(j.data); } catch (e) { return j; } }
  return j;
}

// "IA · Pediu horário" == "ia pediu horario": caixa, acento e pontuação não podem esconder a etiqueta.
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const NOME = { quente: 'LeadSubmitted', agendado: 'AddToCart', compareceu: 'InitiateCheckout', ganho: 'Purchase' };
const agora = Math.floor(Date.now() / 1000);
const saida = [];

for (const item of $input.all()) {
  const lead = corpo(item.json);
  if (!lead || !lead.id) continue;

  const campos = new Map();
  for (const f of (lead.custom_fields_values || [])) campos.set(Number(f.field_id), (f.values || [])[0] || {});
  const clid = (campos.get(cfg.cfCtwaClid) || {}).value || null;
  const quente = Number((campos.get(cfg.cfQualificacao) || {}).enum_id) === cfg.enumQuente;
  const status = String(lead.status_id);

  const tags = new Set((((lead._embedded || {}).tags) || []).map((t) => norm(t && t.name)));
  const pediu = pc.modo !== 'desligado'
    && !!pc.tag && tags.has(norm(pc.tag))
    && !(pc.tagsExcluir || []).some((x) => tags.has(norm(x)));

  let eventos = [];
  let via = 'quente';
  if (cfg.cadeia && cfg.cadeia[status]) eventos = [...cfg.cadeia[status]];
  else if ((cfg.preAgendado || [cfg.statusQualificacao]).includes(status)) {
    if (quente) eventos = ['quente'];
    else if (pediu) { eventos = ['quente']; via = 'pediu_horario'; }
  }

  // A hora do pedido é a do cartão; nunca no futuro (relógio da Kommo adiantado) e nunca fora de segundos inteiros.
  const atualizado = Number(lead.updated_at) || agora;
  const horaDoPedido = Math.min(agora, atualizado);

  for (const ev of eventos) {
    saida.push({ json: {
      event_name: NOME[ev],
      event_id: ev + '-' + lead.id,
      event_time: via === 'pediu_horario' ? horaDoPedido : agora,
      ctwa_clid: clid,
      kommo_lead_id: String(lead.id),
      pipeline_id: String(lead.pipeline_id),
      telefone: null,
      wamid: null,
      valor: ev === 'ganho' ? Number(lead.price || 0) : null,
      via,
      // modo seco só vale para o caminho NOVO: o Quente de sempre continua indo à Meta.
      _seco: via === 'pediu_horario' && pc.modo === 'seco',
    }});
  }
}

return saida;
