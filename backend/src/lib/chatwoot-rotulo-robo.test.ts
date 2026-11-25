/**
 * Rótulo «🤖 Robô · modelo automático» / «✨ Sofia (IA)» / «👤 <nome>» acima do balão de saída: detecta pelo ESTADO do Chatwoot (sender, tipo, template_params), nunca pelo texto; não marca
 * paciente, atividade nem nota privada; só põe um atributo no contêiner (nada de nó novo no que o Vue controla); sai sozinho; chave desliga.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { rotuloRoboJs, conectoresDoRotulo, rotuloDoRoboLigado, CONECTORES_PADRAO } = await import('./chatwoot-rotulo-robo.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');

class El {
  attrs: Record<string, string> = {};
  filhos: El[] = [];
  textContent = '';
  constructor(public id = '') {}
  getAttribute(k: string) { return k === 'id' ? this.id : (this.attrs[k] ?? null); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  hasAttribute(k: string) { return k in this.attrs; }
  appendChild(n: El) { this.filhos.push(n); return n; }
}

interface Msg { id: number; message_type: number; private?: boolean; sender?: { id?: number; type?: string; name?: string; available_name?: string } | null; sender_type?: string; additional_attributes?: unknown; content_attributes?: unknown; content?: string }

function montar(o: { conversa?: number; caminho?: string; mensagens?: Msg[] | null; env?: NodeJS.ProcessEnv; semStore?: boolean; presentes?: number[]; usarDataId?: boolean }) {
  const conversa = o.conversa ?? 77;
  const mensagens = o.mensagens ?? [];
  const presentes = o.presentes ?? mensagens.map((m) => m.id);
  const nos = new Map<number, El>(presentes.map((id) => [id, new El(o.usarDataId ? '' : 'message' + id)]));
  if (o.usarDataId) for (const [id, n] of nos) n.attrs['data-message-id'] = String(id);
  const estilos: El[] = [];
  let chat: unknown = { id: conversa, messages: mensagens };
  const doc = {
    documentElement: {},
    head: { appendChild: (e: El) => estilos.push(e) },
    createElement: () => new El(),
    querySelector: (sel: string) => {
      const m = /^\[data-message-id="(\d+)"\]$/.exec(sel);
      if (m) return [...nos.values()].find((n) => n.attrs['data-message-id'] === m[1]) ?? null;
      if (sel.startsWith('style[')) return estilos[0] ?? null;
      return null;
    },
    querySelectorAll: (sel: string) => (sel === '[data-dd-rotulo]' ? [...nos.values()].filter((n) => 'data-dd-rotulo' in n.attrs) : []),
    getElementById: (id: string) => {
      if (id === 'app') return o.semStore ? {} : { __vue_app__: { config: { globalProperties: { $store: { getters: { get getSelectedChat() { return chat; } } } } } } };
      const m = /^message(\d+)$/.exec(id);
      return m ? ([...nos.entries()].find(([k]) => k === Number(m[1]))?.[1] ?? null) : null;
    },
    addEventListener: () => {},
  };
  const timers: Array<() => void> = [];
  const win: Record<string, unknown> = {};
  win.top = win;
  const loc = { pathname: o.caminho ?? '/app/accounts/1/conversations/' + conversa };
  class Obs { constructor(public f: () => void) { obs.push(this); } observe() {} }
  const obs: Obs[] = [];
  const js = rotuloRoboJs(o.env ?? ({} as NodeJS.ProcessEnv));
  assert.ok(js);
  new Function('window', 'document', 'location', 'setTimeout', 'MutationObserver', js)(win, doc, loc, (f: () => void) => { timers.push(f); return 1; }, Obs);
  const rodar = () => { const t = timers.splice(0); t.forEach((f) => f()); };
  return { nos, estilos, rodar, trocarChat: (c: unknown) => { chat = c; }, loc, obs, marca: (id: number) => nos.get(id)?.attrs['data-dd-rotulo'] };
}

const CONECTOR = 2;
const ROBO_SOFIA = { id: 1, name: 'Sofia', type: 'agent_bot' };
const EQUIPE = { id: 9, name: 'Bianca', type: 'user' };
const marcaNome = (t: ReturnType<typeof montar>, id: number) => t.nos.get(id)?.attrs['data-dd-nome'];
const CELULAR = { id: 7, name: '📱 Celular da unidade', type: 'user' };

test('Sofia (AgentBot) → «sofia»; «modelo automático» SÓ com template_params (conector ou sem remetente); conector SEM marca mostra o NOME dele; decide pelo estado, nunca pelo texto', () => {
  const t = montar({
    mensagens: [
      { id: 1, message_type: 1, sender: ROBO_SOFIA, content: 'Olá! Aqui é a Sofia.' },
      { id: 2, message_type: 1, sender: { id: CONECTOR, name: '🤖 Robô automático', type: 'user' }, additional_attributes: { template_params: { name: 'consulta_lembrete_vespera' } }, content: 'Lembrete: sua consulta é amanhã.' },
      { id: 3, message_type: 1, sender: null, additional_attributes: { template_params: { name: 'consulta_lembrete_vespera' } }, content: 'modelo sem pessoa por trás' },
      { id: 4, message_type: 3, sender: { id: 98, type: 'agent_bot' }, additional_attributes: { template_params: {} } },
      { id: 5, message_type: 1, sender: { id: 99, name: '🤖 Robô automático', type: 'user' }, additional_attributes: { template_params: {} }, content: 'conector de uma clínica nova (nome padrão do usuário), modelo' },
    ],
  });
  t.rodar();
  assert.deepEqual([1, 2, 3, 4, 5].map(t.marca), ['sofia', 'robo', 'robo', 'sofia', 'robo']);
  assert.equal(montar({ mensagens: [{ id: 3, message_type: 1, sender: EQUIPE, additional_attributes: { template_params: { name: 'x' } } }] }).marca(3), undefined, 'antes de rodar nada é marcado (o rodar é quem decide)');
  assert.equal(t.estilos.length, 1, 'o CSS entra uma vez, no <head>');
  assert.ok(t.estilos[0]!.textContent.includes('🤖 Robô · modelo automático') && t.estilos[0]!.textContent.includes('🤖 Robô · mensagem automática') && t.estilos[0]!.textContent.includes('✨ Sofia (IA)') && t.estilos[0]!.textContent.includes('attr(data-dd-nome)'));
});

test('conector de uma clínica NOVA (id desconhecido): reconhecido pelo nome «Conector…» ou «🤖…», no nome de exibição ou no cadastro; pessoa com outro nome continua gente', () => {
  const tp = { template_params: { name: 'x' } };
  const t = montar({
    mensagens: [
      { id: 40, message_type: 1, sender: { id: 31, type: 'user', name: 'Conector Timbó' }, additional_attributes: tp },
      { id: 41, message_type: 1, sender: { id: 32, type: 'user', name: 'Robô automático', available_name: '🤖 Robô automático' }, additional_attributes: tp },
      { id: 42, message_type: 1, sender: { id: 33, type: 'user', name: '🤖 Robô automático', available_name: 'Robô automático' }, additional_attributes: tp },
      { id: 43, message_type: 1, sender: { id: 34, type: 'user', name: 'Conceição Silva' }, additional_attributes: tp },
    ],
  });
  t.rodar();
  assert.deepEqual([40, 41, 42, 43].map(t.marca), ['robo', 'robo', 'robo', 'gente']);
});

test('SONDA DO SÊNIOR 1: a Sofia publicada pelo CONECTOR NUNCA vira «modelo automático» — com a marca dd_sofia é «sofia»; SEM marca (histórico antigo) mostra o nome do conector, sem adivinhar', () => {
  const conector = { id: CONECTOR, type: 'user', name: '🤖 Robô automático' };
  const t = montar({
    mensagens: [
      { id: 1, message_type: 1, sender: conector, content_attributes: { dd_sofia: true }, content: 'Oi! Aqui é a Sofia' },
      { id: 2, message_type: 1, sender: conector, content: 'texto antigo da Sofia, sem marca' },
      { id: 3, message_type: 1, sender: conector, additional_attributes: { template_params: { name: 'x' } }, content: 'modelo da régua' },
      { id: 4, message_type: 1, sender: { id: 99, type: 'user', name: 'Conector Timbó' }, content: 'conector de clínica nova, sem marca' },
    ],
  });
  t.rodar();
  assert.deepEqual([1, 2, 3, 4].map(t.marca), ['sofia', 'gente', 'robo', 'gente']);
  assert.equal(marcaNome(t, 2), '🤖 Robô automático', 'sem marca: o NOME do conector, nunca «modelo»');
  assert.equal(marcaNome(t, 4), '👤 Conector Timbó');
  assert.equal(marcaNome(t, 1), undefined);
});

test('SONDA DO SÊNIOR 2: a espera fixa da demora (content_attributes.demora_espera) é «mensagem automática» pelo robô E pelo conector — nunca «Sofia (IA)»; e sem remetente nem marca (CSAT, automação nativa) não leva rótulo', () => {
  const t = montar({
    mensagens: [
      { id: 1, message_type: 1, sender: ROBO_SOFIA, content_attributes: { demora_espera: true }, content: 'Já já alguém da equipe te responde.' },
      { id: 2, message_type: 1, sender: { id: CONECTOR, type: 'user', name: '🤖 Robô automático' }, content_attributes: { demora_espera: true }, content: 'Já já alguém da equipe te responde.' },
      { id: 3, message_type: 1, sender: ROBO_SOFIA, content: 'resposta da Sofia' },
      { id: 4, message_type: 3, sender: null, content: 'Avalie o atendimento (CSAT)' },
      { id: 5, message_type: 1, sender: null, content: 'mensagem de automação do Chatwoot' },
    ],
  });
  t.rodar();
  assert.deepEqual([1, 2, 3, 4, 5].map(t.marca), ['auto', 'auto', 'sofia', undefined, undefined]);
  assert.ok(t.estilos[0]!.textContent.includes('[data-dd-rotulo="auto"]::before{content:"🤖 Robô · mensagem automática"}'));
});

test('um contêiner repetido por uma citação («responder a») não rouba o rótulo: vale o id «message<id>»', () => {
  const t = montar({ mensagens: [{ id: 10, message_type: 1, sender: ROBO_SOFIA }], usarDataId: true });
  const citacao = new El('');
  citacao.attrs['data-message-id'] = '10';
  // o contêiner de verdade tem id message10; a citação só repete o número
  t.nos.get(10)!.id = 'message10';
  const original = t.nos.get(10)!;
  t.nos.set(999, citacao);
  t.rodar();
  assert.equal(original.attrs['data-dd-rotulo'], 'sofia');
  assert.equal(citacao.attrs['data-dd-rotulo'], undefined);
});

test('NÃO marca: paciente, atividade, nota privada (nem a da Sofia/conector), remetente desconhecido, nem texto parecido', () => {
  const t = montar({
    mensagens: [
      { id: 12, message_type: 0, sender: { id: 500, type: 'contact' }, content: 'oi' },
      { id: 13, message_type: 2, sender: null, content: 'Conversa atribuída' },
      { id: 14, message_type: 1, private: true, sender: ROBO_SOFIA, content: '🙋 Sofia passou esta conversa' },
      { id: 15, message_type: 1, private: true, sender: { id: CONECTOR, type: 'user' }, content: 'nota' },
      { id: 16, message_type: 0, sender: ROBO_SOFIA, content: 'mensagem recebida marcada como bot' },
      { id: 17, message_type: 1, sender: { id: 500, type: 'contact' }, content: 'sender de contato com tipo de saída' },
      { id: 19, message_type: 1, sender: null, content: '🤖 Robô · modelo automático (texto igual ao rótulo, sem remetente nem modelo)' },
      { id: 20, message_type: 1, private: true, sender: EQUIPE, content: 'nota privada da equipe' },
    ],
  });
  t.rodar();
  for (const id of [12, 13, 14, 15, 16, 17, 19, 20]) assert.equal(t.marca(id), undefined, 'mensagem ' + id);
});

test('GENTE: quem respondeu aparece pelo NOME do remetente (available_name antes de name), inclusive o modelo mandado por pessoa e o eco do celular; só o nome, nunca papel inventado', () => {
  const t = montar({
    mensagens: [
      { id: 30, message_type: 1, sender: { id: 9, type: 'user', name: 'Bianca Souza', available_name: 'Bianca' }, content: 'oi' },
      { id: 31, message_type: 1, sender: { id: 10, type: 'user', name: 'Maria Gerente' }, content: 'oi' },
      { id: 32, message_type: 1, sender: { id: 9, type: 'user', name: 'Bianca' }, additional_attributes: { template_params: { name: 'x' } }, content: 'modelo pelo botão' },
      { id: 33, message_type: 1, sender: { id: 7, type: 'user', name: '📱 Celular da unidade' }, content: 'eco do celular' },
      { id: 34, message_type: 1, sender: { id: 11, type: 'user', name: '  Ana   Paula   ' }, content: 'oi' },
      { id: 35, message_type: 1, sender: { id: 12, type: 'user', name: '' }, content: 'sem nome: sem rótulo (não invento)' },
      { id: 36, message_type: 1, sender: { id: 13, type: 'user', name: 'Fulana com um sobrenome absurdamente comprido para caber em qualquer balão' }, content: 'oi' },
    ],
  });
  t.rodar();
  assert.deepEqual([30, 31, 32, 33, 34, 35, 36].map(t.marca), ['gente', 'gente', 'gente', 'gente', 'gente', undefined, 'gente']);
  assert.equal(marcaNome(t, 30), '👤 Bianca');
  assert.equal(marcaNome(t, 31), '👤 Maria Gerente', 'só o nome: nada de «SDR» ou «Gerente» que o Chatwoot não entrega');
  assert.equal(marcaNome(t, 32), '👤 Bianca');
  assert.equal(marcaNome(t, 33), '📱 Celular da unidade', 'o eco do celular traz o 📱 no nome: sem 👤');
  assert.equal(marcaNome(t, 34), '👤 Ana Paula');
  assert.ok((marcaNome(t, 36) ?? '').length <= 45, 'nome cortado em 40 letras');
  // robô e Sofia não levam nome
  const u = montar({ mensagens: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }, { id: 2, message_type: 1, sender: { id: CONECTOR, type: 'user', name: '🤖 Robô automático' }, additional_attributes: { template_params: {} } }] });
  u.rodar();
  assert.equal(marcaNome(u, 1), undefined);
  assert.equal(marcaNome(u, 2), undefined);
  // quando o Vue reaproveita o contêiner de gente para a Sofia, o nome sai
  const v = montar({ mensagens: [{ id: 1, message_type: 1, sender: EQUIPE }] });
  v.rodar();
  assert.equal(marcaNome(v, 1), '👤 Bianca');
  v.trocarChat({ id: 77, messages: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }] });
  v.obs[0]!.f(); v.rodar();
  assert.equal(v.marca(1), 'sofia');
  assert.equal(marcaNome(v, 1), undefined);
});

test('ECO DO CELULAR (conferido no CRM real): saída SEM remetente com content_attributes.external_echo = «📱 Celular da unidade»; sem o echo continua sem rótulo; nota privada nunca', () => {
  const t = montar({
    mensagens: [
      { id: 40, message_type: 1, sender: null, content_attributes: { external_echo: true }, content: 'resposta pelo aparelho' },
      { id: 41, message_type: 1, content_attributes: { external_echo: true }, content: 'sem o campo sender' },
      { id: 42, message_type: 1, sender: null, content_attributes: {}, content: 'sem echo' },
      { id: 43, message_type: 1, private: true, sender: null, content_attributes: { external_echo: true }, content: 'privada' },
      { id: 44, message_type: 0, sender: null, content_attributes: { external_echo: true }, content: 'entrada' },
    ],
  });
  t.rodar();
  assert.deepEqual([40, 41, 42, 43, 44].map(t.marca), ['gente', 'gente', undefined, undefined, undefined]);
  assert.equal(marcaNome(t, 40), '📱 Celular da unidade');
});

test('só põe um ATRIBUTO no contêiner existente (nenhum nó novo dentro do que o Vue controla); acha pelo id «message<id>» e pelo data-message-id', () => {
  const a = montar({ mensagens: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }] });
  a.rodar();
  assert.equal(a.nos.get(1)!.filhos.length, 0, 'nada de nó novo');
  assert.equal(a.marca(1), 'sofia');
  const b = montar({ mensagens: [{ id: 5, message_type: 1, sender: ROBO_SOFIA }], usarDataId: true });
  b.rodar();
  assert.equal(b.marca(5), 'sofia');
});

test('o rótulo SAI quando a mensagem deixa de ser marcável (contêiner reaproveitado pelo Vue) e quando a conversa abre sem estado; trocar de conversa limpa', () => {
  const t = montar({ mensagens: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }, { id: 2, message_type: 1, sender: EQUIPE }] });
  t.rodar();
  assert.equal(t.marca(1), 'sofia');
  // o Vue reaproveitou o contêiner 1 para uma mensagem da equipe
  t.trocarChat({ id: 77, messages: [{ id: 1, message_type: 0, sender: { id: 500, type: 'contact' } }, { id: 2, message_type: 1, sender: EQUIPE }] });
  t.obs[0]!.f(); t.rodar();
  assert.equal(t.marca(1), undefined);
  // outra conversa abre (a URL muda, o estado ainda é da anterior): nada é marcado e o que sobrou sai
  t.trocarChat({ id: 77, messages: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }] });
  t.obs[0]!.f(); t.rodar();
  assert.equal(t.marca(1), 'sofia');
  t.loc.pathname = '/app/accounts/1/conversations/78';
  t.obs[0]!.f(); t.rodar();
  assert.equal(t.marca(1), undefined, 'a conversa 78 não tem estado carregado: sem rótulo, nada marcado por engano');
});

test('sem store do Chatwoot, fora de conversa (lista, contatos) ou mensagem fora da tela (virtualizada): não marca e não quebra', () => {
  const sem = montar({ mensagens: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }], semStore: true });
  assert.doesNotThrow(() => sem.rodar());
  assert.equal(sem.marca(1), undefined);
  const lista = montar({ mensagens: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }], caminho: '/app/accounts/1/dashboard' });
  lista.rodar();
  assert.equal(lista.marca(1), undefined);
  const fora = montar({ mensagens: [{ id: 1, message_type: 1, sender: ROBO_SOFIA }], presentes: [] });
  assert.doesNotThrow(() => fora.rodar());
});

test('o conector vem do padrão (2 e 14) + CHATWOOT_CONECTORES_IDS (soma; lixo ignorado); a chave CHATWOOT_ROTULO_ROBO=0 tira o bloco', () => {
  assert.deepEqual([...CONECTORES_PADRAO], [2, 14]);
  assert.deepEqual(conectoresDoRotulo({} as NodeJS.ProcessEnv), [2, 14]);
  assert.deepEqual(conectoresDoRotulo({ CHATWOOT_CONECTORES_IDS: '21, 5,abc,-3,14,2.5' } as NodeJS.ProcessEnv), [2, 5, 14, 21]);
  const t = montar({ mensagens: [{ id: 1, message_type: 1, sender: { id: 21, type: 'user' }, additional_attributes: { template_params: {} } }], env: { CHATWOOT_CONECTORES_IDS: '21' } as NodeJS.ProcessEnv });
  t.rodar();
  assert.equal(t.marca(1), 'robo');
  assert.equal(rotuloDoRoboLigado({} as NodeJS.ProcessEnv), true);
  assert.equal(rotuloDoRoboLigado({ CHATWOOT_ROTULO_ROBO: ' 0 ' } as NodeJS.ProcessEnv), false);
  assert.equal(rotuloRoboJs({ CHATWOOT_ROTULO_ROBO: '0' } as NodeJS.ProcessEnv), '');
});

test('menu.js: o rótulo está no arquivo, em bloco próprio com try, e o arquivo todo PARSEIA; com a chave em 0 o bloco some', () => {
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('__rotuloRoboDD'));
  const i = js.indexOf('window.__rotuloRoboDD');
  assert.match(js.slice(js.lastIndexOf(';try{', i), i), /^;try\{\s*\(function\(\)\{/);
  assert.ok(js.includes('window.__funilMenu') && js.includes('window.__seloSofiaDD') && js.includes('window.__guiaEtapaDD'), 'os outros blocos continuam');
  const antes = process.env.CHATWOOT_ROTULO_ROBO;
  process.env.CHATWOOT_ROTULO_ROBO = '0';
  try {
    const sem = montarMenuJs('https://agente.exemplo.test');
    assert.ok(!sem.includes('__rotuloRoboDD'));
    assert.doesNotThrow(() => new Function(sem));
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_ROTULO_ROBO; else process.env.CHATWOOT_ROTULO_ROBO = antes;
  }
});

test('menu.js com TODOS os blocos (guia sem antecipado, domínio da clínica e rótulo): cada um no seu try, na ordem, e o arquivo todo PARSEIA (resolução do conflito com #451/#457)', () => {
  const js = montarMenuJs('https://agente.exemplo.test', [3, 11], { drtimbo: 3 });
  assert.doesNotThrow(() => new Function(js));
  const marcas = ['window.__funilMenu', 'window.__guiaEtapaDD', 'window.__seloSofiaDD', 'window.__dominioContaDD', 'window.__rotuloRoboDD'];
  const pos = marcas.map((m) => js.indexOf(m));
  assert.ok(pos.every((p) => p >= 0), 'todos os blocos estão no arquivo: ' + JSON.stringify(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'na ordem de sempre: menu, guia, selo, domínio, rótulo');
  for (const m of marcas.slice(1)) assert.match(js.slice(js.lastIndexOf(';try{', js.indexOf(m)), js.indexOf(m)), /^;try\{\s*\(function\(\)\{/, m + ' em bloco próprio');
  assert.ok(js.includes('"semAntecipado":[3,11]'), 'a lista do guia chegou');
  assert.ok(js.includes('"drtimbo":3'), 'o mapa de domínios chegou');
});

test('CSS: claro e escuro (.dark), 400 px; o rótulo é ::before (não existe nó novo); a mensagem sem tipo marcável não ganha margem', () => {
  const css = (rotuloRoboJs({} as NodeJS.ProcessEnv).match(/function css\(\)\{[\s\S]*?\n  \}/) ?? [''])[0];
  assert.ok(css.includes("::before"));
  assert.ok(css.includes('.dark ['), 'tema escuro');
  assert.ok(css.includes('="gente"]::before{content:attr('), 'o nome vem do atributo (nada de HTML)');
  assert.ok(css.includes('max-width:560px'), 'celular');
  assert.ok(css.includes("'[' + ATTR + ']{position:relative;margin-top:22px!important}'"), 'a margem só vale com o atributo');
});
