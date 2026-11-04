// ===== CONFIG (edite aqui) =====
const TEST_NUM = '5563991021043';          // 🧪 vai SEMPRE para este número (João), nunca para grupo
const DEDUPE_HORAS = 2;                    // 1 alerta por paciente (lead) por tipo a cada 2 h
const SILENCIO_INICIO = 21, SILENCIO_FIM = 7; // hora de Brasília
const JITTER_MIN_S = 20, JITTER_MAX_S = 90;   // atraso aleatório antes de cada envio
// Só estas unidades mandam para grupo. Para ligar a 2ª: some uma linha aqui (jid copiado do mapa do fluxo antigo K33m9ZYNA6R3h2j0).
const UNITS = {
  acailandia: { jid: '120363399681615902@g.us', nome: 'Açailândia', mention: '559991063655' }, // mention: só na bandeira vermelha; '' = sem menção
  // imperatriz: { jid: '...@g.us', nome: 'Imperatriz', mention: '' },
};
// Subdomínio da conta Kommo -> slug (a conta manda mais que o slug do texto). Unidade que está aqui mas não em UNITS = descartada e logada.
const SUBS = {
  doutorherniaacailandia: 'acailandia', attivacorpoementeitz: 'imperatriz', araguainadoutorhernia: 'araguaina',
  doutorherniaporto: 'porto', doutorherniabalsas: 'balsas', doutorherniacanaa: 'canaa', marabadoutorhernia: 'maraba',
  parauapebasdoutorhernia: 'parauapebas', drherniaserra: 'serra', boavistarrdoutorhernia: 'boavista',
  doutorherniarioverde2026: 'rioverde',
};
const SEGREDO = '__SEGREDO_WEBHOOK__';     // o importar.sh troca por um valor aleatório; vazio = sem checagem
const CFG = { SILENCIO_INICIO, SILENCIO_FIM };
//__COMUM__

const it = $input.first().json;
const body = it.body || {};
if (SEGREDO && !SEGREDO.startsWith('__') && String((it.query || {}).k || '') !== SEGREDO) {
  return [{ json: { decisao: 'recusado: segredo errado' } }];
}
const sd = iniciaSd($getWorkflowStaticData('global'));
const agora = Date.now();

// ---- lê o payload urlencoded do Kommo (chave achatada; cai para objeto aninhado e para qualquer [text]) ----
const get = (k, ...nest) => {
  if (body[k] !== undefined && body[k] !== '') return String(body[k]);
  try { let o = body; for (const n of nest) o = o[n]; if (o !== undefined && typeof o !== 'object') return String(o); } catch (e) {}
  return '';
};
let text = get('task[add][0][text]', 'task', 'add', 0, 'text') || get('task[update][0][text]') || String(body.text || '');
let leadId = get('task[add][0][element_id]', 'task', 'add', 0, 'element_id');
if (!text) for (const k in body) { if (/\[text\]$/.test(k) && body[k]) { text = String(body[k]); const m = k.replace(/\[text\]$/, '[element_id]'); leadId = leadId || String(body[m] || ''); break; } }
const dec = (s) => String(s).replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
text = dec(text).replace(/\s+/g, ' ').trim();
if (!text || !/ALERTA/i.test(text)) return [{ json: { decisao: 'ignorado: não é tarefa ALERTA' } }]; // maioria das tarefas do Kommo: nem entra na contagem

// ---- slug + mensagem ----
const sub = String(body['account[subdomain]'] || (body.account || {}).subdomain || '');
let slug = '', msg = text;
const m = text.match(/ALERTA\s*[·:|\-]\s*([a-z0-9_-]+)\s*[·:|\-]\s*(.+)$/i);
if (m) { slug = m[1].toLowerCase(); msg = m[2].trim(); }
else { const m2 = text.match(/ALERTA\s*[·:|\-]?\s*(.+)$/i); if (m2) msg = m2[1].trim(); }
let nome = '';
const mc = msg.match(/\[Contato:\s*([^\]]+)\]\s*/i);
if (mc) { nome = mc[1].trim(); msg = msg.replace(mc[0], '').trim(); }
const teste = /^\s*🧪/u.test(msg);
if (teste) msg = msg.replace(/^\s*🧪\s*/u, '');

// ---- classifica: só 3 tipos passam. O trecho citado da conversa ("Última mensagem: ...") sai ANTES (dado de saúde, e pode enganar o filtro) ----
const s = msg.replace(/ltima mensagem:.*$/i, '').toLowerCase();
let tipo = null;
if (/(?<!\b(?:sem|nenhum|nem)\s)(?:sina(?:l|is) de alerta|bandeira vermelha|red ?flag)|🚩/u.test(s)) tipo = 'bandeira';
else if (/agendad[ao] pela i\.?\s*a/.test(s)) tipo = 'agendada';
else if (/(aguardando\s+h[áa]|sem resposta|ningu[eé]m respond)/.test(s) && !/pagamento|entrada pendente|pix pendente/.test(s)) tipo = 'sem_resposta';
if (!tipo) { conta(sd, agora, 'fora_dos_3_tipos'); return [{ json: { decisao: 'descartado: tipo fora dos 3' } }]; }

// ---- rota: conta Kommo primeiro, depois slug do texto ----
let chave = SUBS[sub] || null;
if (!chave && slug) chave = Object.keys(UNITS).find((k) => slug === k || slug.includes(k)) || slug;
const u = chave && UNITS[chave] && UNITS[chave].jid ? UNITS[chave] : null;
if (!u && !teste) {
  conta(sd, agora, `sem_rota:${chave || sub || slug || '?'}`);
  registra(sd, agora, `DESCARTADO sem rota (${chave || sub || slug || '?'}) tipo=${tipo} lead=${leadId || '-'}`);
  return [{ json: { decisao: 'descartado: unidade sem rota ' + (chave || '?') } }];
}
const unidadeNome = u ? u.nome : (chave || 'teste');
const link = leadId ? `https://${sub || 'doutorherniaacailandia'}.kommo.com/leads/detail/${leadId}` : '';
const quem = nome || 'paciente';
const jid = teste ? TEST_NUM : u.jid;

// ---- anti-volume: dedupe por paciente+tipo (🧪 não entra) ----
const dk = `${tipo}:${jid}:${leadId || nome.toLowerCase()}`;
for (const k in sd.dedupe) if (agora - sd.dedupe[k] > 3 * HORA) delete sd.dedupe[k];
if (!teste && (leadId || nome)) {
  if (sd.dedupe[dk] && agora - sd.dedupe[dk] < DEDUPE_HORAS * HORA) {
    conta(sd, agora, `dedupe:${tipo}`);
    registra(sd, agora, `dedupe ${tipo} ${quem}`);
    return [{ json: { decisao: 'descartado: já avisado nas últimas 2 h' } }];
  }
}
// silêncio: bandeira fica guardada até 7h; as outras morrem à noite
const silencio = !teste && emSilencio(agora, CFG);
if (silencio && tipo !== 'bandeira') {
  conta(sd, agora, `silencio:${tipo}`);
  registra(sd, agora, `descartado no silêncio ${tipo} ${quem}`);
  return [{ json: { decisao: 'descartado: silêncio 21h–7h' } }];
}
if (leadId || nome) sd.dedupe[dk] = agora;

// ---- enfileira ----
if (tipo === 'sem_resposta') {
  const desde = agora - esperaEmMs(msg);
  if (teste) { // 🧪: não espera os 15 min — vira já uma mensagem de um item só, para ver o formato final
    sd.saida.push({ id: `t${agora}`, jid, tipo, teste: true, digest: true, nome: unidadeNome, itens: [{ nome: quem, desde, link }], quando: agora + rand(JITTER_MIN_S, JITTER_MAX_S) * 1000, expira: agora + 30 * MIN });
  } else {
    const f = (sd.fila[jid] = sd.fila[jid] || { nome: unidadeNome, itens: [] });
    f.nome = unidadeNome;
    if (f.itens.some((i) => i.id === (leadId || nome))) return [{ json: { decisao: 'já na fila' } }];
    f.itens.push({ id: leadId || nome, nome: quem, desde, link });
  }
  conta(sd, agora, `entrou:${tipo}`);
  registra(sd, agora, `fila ${tipo} ${quem} (${unidadeNome})${teste ? ' [TESTE]' : ''}`);
  return [{ json: { decisao: teste ? 'teste: sai em ~1-2 min para o João' : 'guardado para o resumo de 15 min' } }];
}
let corpo;
if (tipo === 'bandeira') {
  corpo = `🚩 *Bandeira vermelha · ${unidadeNome}*\n👤 ${quem} — sinal de alerta. Ligar agora.${link ? `\n🔗 ${link}` : ''}`;
} else {
  const det = ((msg.replace(/\s*Confirmar com o paciente\.?/i, '').match(/agendad[ao] pela i\.?\s*a(?:\s*sofia)?\s*[—:\-]\s*(.+)$/i) || [])[1] || '').replace(/[.\s]+$/, '');
  corpo = `🤖 *Consulta agendada pela I.A · ${unidadeNome}*\n👤 ${quem}${det ? ` — ${det.slice(0, 80)}` : ''}${link ? `\n🔗 ${link}` : ''}`;
}
let quando = agora + rand(JITTER_MIN_S, JITTER_MAX_S) * 1000;
if (silencio) quando = proximoFimDoSilencio(agora, CFG) + rand(JITTER_MIN_S, JITTER_MAX_S) * 1000;
const mencao = tipo === 'bandeira' && u && u.mention && !teste ? u.mention : '';
if (mencao) corpo += `\n\n@${mencao}`;
sd.saida.push({ id: `${tipo[0]}${agora}`, jid, tipo, teste, quando, expira: quando + (tipo === 'bandeira' ? 14 * HORA : 3 * HORA), text: corpo, mention: mencao });
conta(sd, agora, `entrou:${tipo}`);
registra(sd, agora, `saida ${tipo} ${quem} (${unidadeNome})${teste ? ' [TESTE]' : ''} p/ ${new Date(quando).toISOString()}`);
return [{ json: { decisao: silencio ? 'bandeira guardada até 7h' : `${tipo}: sai em ~${Math.round((quando - agora) / 1000)} s (próximo minuto do relógio)` } }];
