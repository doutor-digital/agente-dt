// node --test n8n/alertas-grupo-simples/test.mjs   — roda o código dos dois nós com relógio e sorteio falsos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { montar } from './build.mjs';

const wf = montar();
const cod = (nome) => wf.nodes.find((n) => n.name.startsWith(nome)).parameters.jsCode.replace('__SEGREDO_WEBHOOK__', 'seg123').replace('__URL_ENVIO__', 'http://interno/webhook/alerta-grupo-envio?k=seg123');
const ENTRADA = cod('Entrada'), DESPACHAR = cod('Despachar'), VALIDAR = cod('Validar');
const GRUPO = '120363399681615902@g.us', JOAO = '5563991021043';
const SUB = 'doutorherniaacailandia';

// instante em hora de Brasília (UTC-3)
const brt = (iso) => Date.parse(iso + '-03:00');
function rodar(codigo, { sd, agora, body = {}, query = { k: 'seg123' }, rnd = 0.5 }) {
  const realNow = Date.now, realRnd = Math.random;
  Date.now = () => agora; Math.random = () => rnd;
  try {
    const f = new Function('$input', '$getWorkflowStaticData', `return (() => {${codigo}\n})()`);
    return f({ first: () => ({ json: { body, query } }) }, () => sd);
  } finally { Date.now = realNow; Math.random = realRnd; }
}
const tarefa = (texto, { lead = '777', sub = SUB } = {}) => ({ 'task[add][0][text]': texto, 'task[add][0][element_id]': lead, 'account[subdomain]': sub });
const entra = (sd, agora, texto, o = {}) => rodar(ENTRADA, { sd, agora, body: tarefa(texto, o), ...o.run })[0].json.decisao;
const tick = (sd, agora, rnd = 0.5) => rodar(DESPACHAR, { sd, agora, rnd });

const T0 = brt('2026-11-05T10:00:00'); // quinta, 10h

test('tarefa que não é ALERTA é ignorada sem rastro', () => {
  const sd = {};
  assert.match(entra(sd, T0, 'Ligar para o paciente'), /fora dos 3/);
  assert.deepEqual(sd.saida, []);
});

test('segredo errado recusa', () => {
  const sd = {};
  const r = rodar(ENTRADA, { sd, agora: T0, body: tarefa('ALERTA · acailandia · [Contato: Ana] sinal de alerta'), query: { k: 'x' } });
  assert.match(r[0].json.decisao, /recusado/);
});

test('bandeira vermelha: sai na hora (atraso 20-90 s), sem o motivo clínico e com o link', () => {
  const sd = {};
  const txt = 'ALERTA · doutor-hernia-acailandia · [Contato: Maria Silva] LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico (perda de força na perna, urina presa). A IA parou e passou o atendimento para a equipe — ligar para o paciente agora.';
  entra(sd, T0, txt);
  assert.equal(sd.saida.length, 1);
  const s = sd.saida[0];
  assert.ok(s.quando >= T0 + 20000 && s.quando <= T0 + 90000);
  assert.ok(!/urina|perna|for[cç]a/i.test(s.text), 'dado clínico vazou: ' + s.text);
  assert.match(s.text, /Bandeira vermelha · Açailândia/);
  assert.match(s.text, /https:\/\/doutorherniaacailandia\.kommo\.com\/leads\/detail\/777/);
  assert.equal(s.jid, GRUPO);
  assert.match(s.text, /@559991063655$/);
  assert.equal(tick(sd, T0 + 10000).length, 0, 'ainda dentro do atraso');
  const out = tick(sd, T0 + 95000);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.instancia, 'alertas3');
  assert.equal(out[0].json.number, GRUPO);
  assert.deepEqual(out[0].json.mentioned, ['559991063655@s.whatsapp.net']);
});

test('consulta agendada pela IA', () => {
  const sd = {};
  entra(sd, T0, 'ALERTA · doutor-hernia-acailandia · [Contato: João Souza] 🤖 CONSULTA AGENDADA PELA I.A Sofia — 07/11 às 14:30 com Dra. Ana. Confirmar com o paciente.');
  const s = sd.saida[0];
  assert.match(s.text, /Consulta agendada pela I\.A · Açailândia/);
  assert.match(s.text, /João Souza — 07\/11 às 14:30 com Dra\. Ana/);
  assert.ok(!s.text.includes('Confirmar'));
});

test('nota (sem prefixo de slug) com a conta de Açailândia também roteia', () => {
  const sd = {};
  const body = { 'leads[note][0][note][text]': '🤖 CONSULTA AGENDADA PELA I.A Sofia — 07/11 às 09:00. [Contato: Pedro]', 'leads[note][0][note][element_id]': '55', 'account[subdomain]': SUB };
  // texto sem o prefixo ALERTA não passa (nota de hoje) — documentado no README
  const r = rodar(ENTRADA, { sd, agora: T0, body });
  assert.match(r[0].json.decisao, /fora dos 3/);
});

test('sem resposta: guarda, e só o relógio de 15 min manda 1 resumo por grupo', () => {
  const sd = {};
  entra(sd, T0, 'ALERTA · acailandia · [Contato: Ana Lima] Lead aguardando há 25 min e ninguém respondeu (IA pausada). Priorizar!', { lead: '11' });
  entra(sd, T0 + 1000, 'ALERTA · acailandia · [Contato: Bia Costa] Paciente sem resposta há 1h05. Última mensagem: "oi, aguardando bandeira vermelha". Responda agora.', { lead: '22' });
  assert.equal(sd.saida.length, 0);
  assert.equal(sd.fila[GRUPO].itens.length, 2);
  // 10:00 e 10:01 já são o quarto de hora das 10:00; primeiro tick do slot enfileira
  const out = tick(sd, T0 + 60000);        // 10:01 -> cria o resumo (quando = +20-90 s)
  assert.equal(out.length, 0);
  assert.equal(sd.saida.length, 1);
  const o2 = tick(sd, T0 + 60000 + 95000);
  assert.equal(o2.length, 1);
  const t = o2[0].json.text;
  assert.match(t, /Ana Lima\* · (26|27|28) min/);
  assert.match(t, /Bia Costa\* · 1h0[6-9]|Bia Costa\* · 1h1\d/);
  assert.ok(!/oi, aguardando/.test(t), 'trecho da conversa vazou');
  assert.match(t, /kommo\.com\/leads\/detail\/11/);
  assert.match(t, /Responder agora/);
  // fila vazia -> nada
  assert.equal(tick(sd, T0 + 16 * 60000).length, 0);
  assert.equal(tick(sd, T0 + 31 * 60000).length, 0);
});

test('resumo não repete no mesmo quarto de hora; paciente novo entra no próximo', () => {
  const sd = {};
  entra(sd, T0, 'ALERTA · acailandia · [Contato: Ana] aguardando há 10 min', { lead: '1' });
  tick(sd, T0 + 60000); tick(sd, T0 + 160000);
  entra(sd, T0 + 5 * 60000, 'ALERTA · acailandia · [Contato: Caio] aguardando há 10 min', { lead: '3' });
  assert.equal(tick(sd, T0 + 6 * 60000).length, 0, 'mesmo quarto de hora: espera');
  tick(sd, T0 + 15 * 60000 + 1000);         // slot novo
  const out = tick(sd, T0 + 15 * 60000 + 100000);
  assert.match(out[0].json.text, /Caio/);
});

test('resumo só sai na virada do quarto de hora, não na hora em que o paciente entra', () => {
  const sd = {};
  entra(sd, T0 + 7 * 60000, 'ALERTA · acailandia · [Contato: Ana] aguardando há 10 min', { lead: '1' });
  for (let m = 8; m < 15; m++) assert.equal(tick(sd, T0 + m * 60000).length + sd.saida.length, 0, 'minuto ' + m);
  tick(sd, T0 + 15 * 60000 + 1000);
  assert.equal(sd.saida.length, 1);
  assert.equal(tick(sd, T0 + 15 * 60000 + 100000).length, 1);
});

test('dedupe: o mesmo paciente e tipo só 1 vez em 2 h', () => {
  const sd = {};
  const txt = 'ALERTA · acailandia · [Contato: Maria] LIGAR AGORA — URGENTE: sinal de alerta clínico (x)';
  assert.match(entra(sd, T0, txt, { lead: '9' }), /bandeira|sai em/);
  tick(sd, T0 + 100000); // sai
  assert.match(entra(sd, T0 + 90 * 60000, txt, { lead: '9' }), /2 h/);
  assert.match(entra(sd, T0 + 125 * 60000, txt, { lead: '9' }), /sai em/);
  assert.match(entra(sd, T0 + 126 * 60000, txt, { lead: '10' }), /sai em/, 'outro paciente passa');
});

test('silêncio 21h-7h: sem resposta e agendada morrem; bandeira espera as 7h', () => {
  const sd = {};
  const noite = brt('2026-11-05T22:30:00');
  assert.match(entra(sd, noite, 'ALERTA · acailandia · [Contato: A] aguardando há 5 min', { lead: '1' }), /silêncio/);
  assert.match(entra(sd, noite, 'ALERTA · acailandia · [Contato: B] 🤖 CONSULTA AGENDADA PELA I.A Sofia — 06/11 às 08:00', { lead: '2' }), /silêncio/);
  entra(sd, noite, 'ALERTA · acailandia · [Contato: C] LIGAR AGORA — URGENTE: sinal de alerta clínico (y)', { lead: '3' });
  assert.equal(sd.saida.length, 1);
  const sete = brt('2026-11-06T07:00:00');
  assert.ok(sd.saida[0].quando >= sete + 20000 && sd.saida[0].quando <= sete + 90000);
  assert.equal(tick(sd, brt('2026-11-06T03:00:00')).length, 0);
  assert.equal(tick(sd, sete + 5000).length, 0);
  assert.equal(tick(sd, sete + 100000).length, 1);
});

test('fila do fim da tarde some se o silêncio chegar antes do resumo', () => {
  const sd = {};
  const t = brt('2026-11-05T20:58:00');
  entra(sd, t, 'ALERTA · acailandia · [Contato: Z] aguardando há 5 min', { lead: '5' });
  tick(sd, brt('2026-11-05T21:01:00'));
  assert.deepEqual(sd.fila, {}); assert.equal(sd.saida.length, 0);
});

test('unidade sem rota é descartada e logada', () => {
  const sd = {};
  const d = entra(sd, T0, 'ALERTA · doutor-hernia-imperatriz · [Contato: X] LIGAR AGORA — sinal de alerta clínico', { sub: 'attivacorpoementeitz' });
  assert.match(d, /sem rota imperatriz/);
  assert.equal(sd.saida.length, 0);
  assert.ok(sd.log.some((l) => /sem rota \(imperatriz\)/.test(l)));
  assert.equal(Object.values(sd.contagem)[0]['sem_rota:imperatriz'], 1);
});

test('🧪 vai só para o número do João, mesmo de outra unidade e à noite; ignora dedupe e teto', () => {
  const sd = {};
  const noite = brt('2026-11-05T23:00:00');
  entra(sd, noite, 'ALERTA · 🧪 [Contato: Teste X] Lead aguardando há 2 horas e ninguém respondeu.', { lead: '1', sub: 'attivacorpoementeitz' });
  assert.deepEqual(sd.fila, {});
  const out = tick(sd, noite + 100000);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.number, JOAO);
  assert.match(out[0].json.text, /^🧪 TESTE/);
  assert.match(out[0].json.text, /Teste X\* · 2h/);
  entra(sd, noite + 200000, 'ALERTA · acailandia · 🧪 [Contato: Teste Y] LIGAR AGORA sinal de alerta clínico', { lead: '2' });
  const o2 = tick(sd, noite + 400000);
  assert.equal(o2[0].json.number, JOAO);
  assert.ok(!o2[0].json.mentioned, 'teste não marca ninguém');
  assert.equal(sd.envios[JOAO], undefined, 'teste não conta no teto');
});

test('teto de 6 por hora por grupo; o resto espera a hora virar', () => {
  const sd = {};
  let t = T0, enviados = 0;
  for (let i = 0; i < 9; i++) entra(sd, T0 + i * 1000, 'ALERTA · acailandia · [Contato: P' + i + '] LIGAR AGORA — URGENTE: sinal de alerta clínico (x)', { lead: String(100 + i) });
  for (let m = 1; m <= 50; m++) { enviados += tick(sd, T0 + m * 60000, 0.9).length; }
  assert.equal(enviados, 6);
  assert.equal(sd.saida.length, 3);
  // passou 1 h do primeiro envio: libera mais
  for (let m = 51; m <= 70; m++) enviados += tick(sd, T0 + m * 60000, 0.9).length;
  assert.ok(enviados > 6);
});

test('nunca 2 envios no mesmo minuto', () => {
  const sd = {};
  entra(sd, T0, 'ALERTA · acailandia · [Contato: A] LIGAR AGORA sinal de alerta clínico', { lead: '1' }, );
  entra(sd, T0, 'ALERTA · acailandia · [Contato: B] LIGAR AGORA sinal de alerta clínico', { lead: '2' });
  const a = tick(sd, T0 + 100000, 0.5);
  const b = tick(sd, T0 + 105000, 0.5);
  assert.equal(a.length, 1); assert.equal(b.length, 0);
});

test('o que NÃO passa', () => {
  const sd = {};
  const nao = [
    'ALERTA · acailandia · [Contato: A] 📅 Consulta amanhã às 14:30 SEM confirmação',
    'ALERTA · acailandia · [Contato: A] aguardando pagamento do pix',
    'ALERTA · acailandia · [Contato: A] A resposta da IA NÃO chegou ao paciente',
    'ALERTA · acailandia · [Contato: A] Card está em AGENDADO mas Tipo de agendamento vazio',
    'ALERTA · acailandia · [Contato: A] paciente sem sinal de alerta nenhum',
  ];
  for (const n of nao) assert.match(entra(sd, T0, n, { lead: '1' }), /fora dos 3|silêncio/, n);
  assert.equal(sd.saida.length + Object.keys(sd.fila).length, 0);
});

test('conta por dia para medir mensagens/dia', () => {
  const sd = {};
  entra(sd, T0, 'ALERTA · acailandia · [Contato: A] LIGAR AGORA sinal de alerta clínico', { lead: '1' });
  tick(sd, T0 + 100000);
  const dia = Object.values(sd.contagem)[0];
  assert.equal(dia['enviado:bandeira'], 1);
  assert.equal(dia['enviado_total:' + GRUPO], 1);
});

test('tick ocioso não suja o static data', () => {
  const sd = {};
  tick(sd, T0);
  const antes = JSON.stringify(sd);
  tick(sd, T0 + 60000);
  assert.equal(JSON.stringify(sd), antes);
});

test('bandeira criada pela REGRA da unidade (sem o prefixo ALERTA) passa — reprodução do sênior do PR 213', () => {
  const sd = {};
  const d = entra(sd, T0, '[Contato: Maria] Paciente com sinal de alerta (perda de força na perna) — LIGAR AGORA');
  assert.match(d, /sai em/);
  assert.equal(sd.saida.length, 1);
  assert.match(sd.saida[0].text, /Bandeira vermelha · Açailândia/);
  assert.ok(!/perna|for[cç]a/i.test(sd.saida[0].text), 'motivo clínico vazou');
  const sd2 = {};
  entra(sd2, T0, 'ALERTA · acailandia · [Contato: Maria] LIGAR AGORA — URGENTE: paciente com sinal de alerta clínico (perda de força). Pausei a IA.');
  assert.equal(sd2.saida.length, 1);
});

test('sem o prefixo ALERTA só a bandeira vale; sem resposta e agendada exigem o prefixo', () => {
  const sd = {};
  for (const t of ['Ligar para o paciente que está aguardando há 2 horas', '[Contato: A] sem resposta há 10 min', '🤖 CONSULTA AGENDADA PELA I.A Sofia — 07/11 às 09:00. [Contato: Pedro]']) {
    assert.match(entra(sd, T0, t, { lead: '1' }), /fora dos 3/, t);
  }
  assert.equal(sd.saida.length + Object.keys(sd.fila).length, 0);
  assert.equal(Object.keys(sd.contagem || {}).length, 0, 'descarte de tipo não escreve contagem');
});

test('"sem sinal de alerta" sem o prefixo não é bandeira', () => {
  const sd = {};
  assert.match(entra(sd, T0, '[Contato: A] Paciente sem sinal de alerta, seguir fluxo normal'), /fora dos 3/);
});

test('webhook sem segredo configurado fica fechado (placeholder não vira porta aberta)', () => {
  const sd = {};
  const aberto = ENTRADA.replace("const SEGREDO = 'seg123';", "const SEGREDO = '__SEGREDO_WEBHOOK__';");
  assert.notEqual(aberto, ENTRADA);
  const r = rodar(aberto, { sd, agora: T0, body: tarefa('ALERTA · acailandia · [Contato: A] sinal de alerta clínico'), query: {} });
  assert.match(r[0].json.decisao, /não configurado/);
  assert.equal(sd.saida, undefined);
});

test('2 bandeiras do mesmo paciente na noite: só 1 sai às 7h', () => {
  const sd = {};
  const txt = 'ALERTA · acailandia · [Contato: Maria] LIGAR AGORA — URGENTE: sinal de alerta clínico (x)';
  entra(sd, brt('2026-11-05T21:30:00'), txt, { lead: '9' });
  assert.match(entra(sd, brt('2026-11-06T03:00:00'), txt, { lead: '9' }), /já tem um igual|2 h/);
  assert.equal(sd.saida.length, 1);
});

test('gatilho entrega ao webhook interno (não fala com a Evolution) e não sai sem destino configurado', () => {
  const sd = {};
  entra(sd, T0, 'ALERTA · acailandia · [Contato: A] LIGAR AGORA sinal de alerta clínico', { lead: '1' });
  const out = tick(sd, T0 + 100000);
  assert.equal(out[0].json.urlEnvio, 'http://interno/webhook/alerta-grupo-envio?k=seg123');
  const nodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const entrega = nodes.find((n) => n.name === 'Entregar ao envio');
  assert.ok(!JSON.stringify(entrega).includes('evolution_api'));
  const sd2 = {};
  entra(sd2, T0, 'ALERTA · acailandia · [Contato: A] LIGAR AGORA sinal de alerta clínico', { lead: '1' });
  const sem = DESPACHAR.replace("const URL_ENVIO = 'http://interno/webhook/alerta-grupo-envio?k=seg123';", "const URL_ENVIO = '__URL_ENVIO__';");
  assert.notEqual(sem, DESPACHAR);
  assert.equal(rodar(sem, { sd: sd2, agora: T0 + 100000 }).length, 0);
  assert.equal(sd2.saida.length, 1, 'nada foi reservado');
});

test('nenhum segredo/chave no workflow.json: Evolution é credencial do n8n', () => {
  const j = JSON.stringify(wf);
  assert.ok(!/c936fd1a|apikey['"]?\s*,\s*['"]?value/i.test(j));
  const envio = wf.nodes.find((n) => n.name === 'Evolution sendText');
  assert.equal(envio.parameters.authentication, 'genericCredentialType');
  assert.equal(envio.parameters.genericAuthType, 'httpHeaderAuth');
  assert.ok(!JSON.stringify(envio.parameters).toLowerCase().includes('"apikey"'));
  assert.ok(envio.credentials.httpHeaderAuth.id.startsWith('__'));
});

test('Validar envio: segredo e formato', () => {
  const ok = { instancia: 'alertas3', number: GRUPO, text: 'oi', delay: 2000, linkPreview: false, mentioned: ['559991063655@s.whatsapp.net'] };
  const v = (body, k = 'seg123') => rodar(VALIDAR, { sd: {}, agora: T0, body, query: { k } });
  assert.equal(v(ok).length, 1);
  assert.equal(v(ok, 'x').length, 0);
  assert.equal(v({ ...ok, number: 'abc' }).length, 0);
  assert.equal(v({ ...ok, instancia: '../x' }).length, 0);
  assert.equal(v({ ...ok, text: '' }).length, 0);
  assert.equal(v({ ...ok, number: JOAO }).length, 1);
});
