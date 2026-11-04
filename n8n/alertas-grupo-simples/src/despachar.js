// ===== CONFIG (edite aqui) =====
const INSTANCIA = 'alertas3';              // << ÚNICO lugar da instância da Evolution. Trocar o remetente = trocar esta linha.
const TETO_POR_HORA = 6;                   // mensagens por hora, por grupo
const SILENCIO_INICIO = 21, SILENCIO_FIM = 7; // hora de Brasília
const INTERVALO_MIN_S = 20;                // folga mínima entre dois envios quaisquer deste remetente
const DIGEST_MIN = 15;                     // resumo de "sem resposta" a cada 15 min (relógio: :00 :15 :30 :45)
const JITTER_MIN_S = 20, JITTER_MAX_S = 90;
const MAX_LINHAS = 8;                      // pacientes listados por resumo
const FILA_MAX_HORAS = 6;                  // paciente na fila há mais que isto sai da lista (não vira alerta velho)
const CFG = { SILENCIO_INICIO, SILENCIO_FIM };
//__COMUM__

// Roda a cada minuto. Muda o estado AQUI, de uma vez, e termina rápido: o n8n grava o static data inteiro no fim da
// execução, então uma execução longa (Wait) sobrescreveria o que outra gravou no meio. Por isso o atraso aleatório é um
// horário (`quando`) e não um nó Wait.
const sd = iniciaSd($getWorkflowStaticData('global'));
const agora = Date.now();
const silencio = emSilencio(agora, CFG);

// ---- limpeza (só grava se algo saiu) ----
for (const j of Object.keys(sd.envios)) {
  const v = sd.envios[j].filter((t) => agora - t < HORA);
  if (!v.length) delete sd.envios[j]; else if (v.length !== sd.envios[j].length) sd.envios[j] = v;
}
for (const d of Object.keys(sd.contagem)) if (agora - Date.parse(d + 'T12:00:00Z') > 10 * 24 * HORA) delete sd.contagem[d];
const vivas = sd.saida.filter((x) => !(x.expira && x.expira < agora));
if (vivas.length !== sd.saida.length) {
  for (const x of sd.saida) if (!vivas.includes(x)) { conta(sd, agora, `expirou:${x.tipo}`); registra(sd, agora, `EXPIROU ${x.tipo} p/ ${x.jid}`); }
  sd.saida = vivas;
}

// ---- resumo "sem resposta": 1 por grupo por janela de 15 min; nada se a lista estiver vazia ----
const cab = (n) => [`⏱️ *Sem resposta · ${n}*`, `⏱️ *Pacientes esperando · ${n}*`, `⏱️ *Aguardando atendimento · ${n}*`][rand(0, 2)];
const slot = Math.floor(agora / (DIGEST_MIN * MIN));
const noInicioDoSlot = agora - slot * DIGEST_MIN * MIN < 5 * MIN; // o resumo só sai nos primeiros minutos de :00 :15 :30 :45
for (const jid of Object.keys(sd.fila)) {
  const f = sd.fila[jid];
  const novos = f.itens.filter((i) => agora - i.desde < FILA_MAX_HORAS * HORA);
  if (novos.length !== f.itens.length) f.itens = novos;
  if (!f.itens.length) { delete sd.fila[jid]; continue; }
  if (silencio) { conta(sd, agora, 'silencio:sem_resposta'); registra(sd, agora, `fila ${f.nome} descartada no silêncio (${f.itens.length})`); delete sd.fila[jid]; continue; }
  if (!noInicioDoSlot || sd.ultimoSlot[jid] === slot) continue; // fora da hora do resumo, ou este quarto de hora já saiu
  sd.ultimoSlot[jid] = slot;
  sd.saida.push({ id: `d${agora}`, jid, tipo: 'sem_resposta', teste: false, digest: true, nome: f.nome, itens: f.itens, quando: agora + rand(JITTER_MIN_S, JITTER_MAX_S) * 1000, expira: agora + 40 * MIN });
  delete sd.fila[jid];
}

// ---- no silêncio, o que não é teste nem bandeira guardada morre ----
if (silencio) {
  const ficam = sd.saida.filter((x) => x.teste || x.tipo === 'bandeira');
  if (ficam.length !== sd.saida.length) {
    for (const x of sd.saida) if (!ficam.includes(x)) { conta(sd, agora, `silencio:${x.tipo}`); registra(sd, agora, `descartado no silêncio ${x.tipo}`); }
    sd.saida = ficam;
  }
}

// ---- um envio por vez (e um por minuto, pelo relógio do gatilho) ----
if (agora - sd.ultimoEnvio < INTERVALO_MIN_S * 1000) return [];
const noTeto = (x) => !x.teste && (sd.envios[x.jid] || []).length >= TETO_POR_HORA;
const prontas = sd.saida.filter((x) => x.quando <= agora && (x.teste || !silencio));
const pronta = prontas
  .filter((x) => !noTeto(x))
  .sort((a, b) => (a.tipo === 'bandeira' ? 0 : 1) - (b.tipo === 'bandeira' ? 0 : 1) || a.quando - b.quando)[0];
if (!pronta) {
  if (prontas.some(noTeto) && sd.tetoLog !== Math.floor(agora / HORA)) { // 1 linha por hora, não por minuto
    sd.tetoLog = Math.floor(agora / HORA);
    registra(sd, agora, `teto de ${TETO_POR_HORA}/h atingido: ${prontas.filter(noTeto).length} esperando`);
  }
  return [];
}

sd.saida = sd.saida.filter((x) => x !== pronta);
let text = pronta.text;
if (pronta.digest) {
  const linhas = pronta.itens.slice(0, MAX_LINHAS).map((i) => `• *${i.nome}* · ${humanizar(agora - i.desde)}${i.link ? `\n   ${i.link}` : ''}`);
  const mais = pronta.itens.length - MAX_LINHAS;
  text = `${cab(pronta.nome)}\n${linhas.join('\n')}${mais > 0 ? `\n+ ${mais} outros` : ''}\n\nResponder agora.`;
}
if (pronta.teste) text = `🧪 TESTE\n${text}`;
const out = { instancia: INSTANCIA, number: pronta.jid, text, delay: rand(1500, 4000), linkPreview: false };
if (pronta.mention) out.mentioned = [`${pronta.mention}@s.whatsapp.net`];
if (!pronta.teste) { (sd.envios[pronta.jid] = sd.envios[pronta.jid] || []).push(agora); conta(sd, agora, `enviado:${pronta.tipo}`); conta(sd, agora, `enviado_total:${pronta.jid}`); }
sd.ultimoEnvio = agora;
registra(sd, agora, `ENVIA ${pronta.tipo}${pronta.teste ? ' [TESTE]' : ''} p/ ${pronta.jid} (${text.length} car.)`);
return [{ json: out }];
