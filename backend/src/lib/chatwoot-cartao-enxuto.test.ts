/**
 * Cartão enxuto por etapa: só os campos da etapa aparecem; o resto recolhe em «Mostrar todos os campos (N)»; campo preenchido nunca some; nada do Vue é apagado nem movido
 * (só um atributo na linha + um botão antes da lista); o mapa muda sem deploy; a chave desliga. DOM de mentira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://t:t@localhost:5432/t';
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { cartaoEnxutoJs, cartaoEnxutoLigado, mapaDoCartao, CARTAO_PADRAO } = await import('./chatwoot-cartao-enxuto.js');
const { montarMenuJs } = await import('../controllers/funil.controller.js');

class No {
  children: No[] = [];
  parentNode: No | null = null;
  attrs: Record<string, string> = {};
  texto = '';
  type = '';
  onclick: (() => void) | null = null;
  constructor(public tag: string, texto = '') { this.texto = texto; }
  get textContent(): string { return this.texto + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.texto = v; this.children = []; }
  get nextSibling(): No | null { const i = this.parentNode ? this.parentNode.children.indexOf(this) : -1; return i >= 0 ? (this.parentNode!.children[i + 1] ?? null) : null; }
  appendChild(n: No) { n.parentNode?.removeChild(n); n.parentNode = this; this.children.push(n); return n; }
  insertBefore(n: No, ref: No | null) { n.parentNode?.removeChild(n); n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); return n; }
  removeChild(n: No) { this.children = this.children.filter((x) => x !== n); n.parentNode = null; return n; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  contains(n: No): boolean { return n === this || this.children.some((c) => c.contains(n)); }
  todos(): No[] { return [this, ...this.children.flatMap((c) => c.todos())]; }
}

const DEFS = [
  ['etapa', 'Etapa'], ['funil', 'Funil'], ['etapa_tratamento', 'Etapa do tratamento'], ['qualificacao', 'Qualificação'], ['queixa', 'Queixa'],
  ['data_consulta', 'Data da consulta'], ['hora_consulta', 'Hora da consulta'], ['situacao_consulta', 'Situação da consulta'], ['pagamento_antecipado', 'Pagamento antecipado'],
  ['motivo_nao_agendamento', 'Motivo do não agendamento'], ['valor_tratamento', 'Valor do tratamento'], ['proxima_sessao', 'Próxima sessão'], ['data_alta', 'Data de alta'],
].map(([attribute_key, attribute_display_name]) => ({ attribute_key, attribute_display_name, attribute_model: 'conversation_attribute' }));

interface Cenario { attrs?: Record<string, unknown>; conversa?: number; caminho?: string; semStore?: boolean; semPainel?: boolean; repetido?: boolean; titulo?: string; nativoAberto?: boolean; defs?: typeof DEFS; valores?: Record<string, unknown>; cliqueFalha?: boolean; contas?: number[]; paginaGrande?: number; contagemDeBuscas?: { n: number }; env?: NodeJS.ProcessEnv }

function montar(c: Cenario = {}) {
  const conversa = c.conversa ?? 5;
  const body = new No('body'), head = new No('head');
  // a estrutura REAL do Chatwoot 4.19.1 (lida do bundle do demo): acordeão → título h5 «Informação da conversa»; lista (vuedraggable) → cada item é um div.drag-handle
  // → raiz da linha → h4 → div → span do rótulo (com o ícone de ajuda DENTRO quando o atributo tem descrição) + o valor; depois da lista, o botão NATIVO «Mostrar todos os atributos»
  const acordeao = new No('div');
  if (!c.semPainel) acordeao.appendChild(new No('button')).appendChild(new No('div')).appendChild(new No('h5', c.titulo ?? 'Informação da conversa')); // o botão do acordeão
  const corpo = acordeao.appendChild(new No('div')); // o corpo do acordeão (aberto)
  const lista = corpo.appendChild(new No('div'));
  const linhas: Record<string, No> = {};
  const defs = c.defs ?? (c.repetido ? [...DEFS, { attribute_key: 'queixa_antiga', attribute_display_name: 'Queixa', attribute_model: 'conversation_attribute' }] : DEFS);
  const nativo = { aberto: c.nativoAberto ?? true, cliques: 0 };
  const caixaNativa = new No('div');
  const botaoNativo = caixaNativa.appendChild(new No('button', nativo.aberto ? 'Mostrar menos atributos' : 'Mostrar todos os atributos'));
  const preencher = () => {
    lista.children = [];
    defs.forEach((d, i) => {
      if (!nativo.aberto && i >= 5) return; // o nativo só renderiza as 5 primeiras linhas até abrir
      const drag = lista.appendChild(new No('div'));
      const raiz = drag.appendChild(new No('div'));
      const h4 = raiz.appendChild(new No('div')).appendChild(new No('h4'));
      const rot = h4.appendChild(new No('div')).appendChild(new No('span', d.attribute_display_name + ' '));
      if (d.attribute_key === 'queixa') rot.appendChild(new No('span', '?')); // atributo com descrição: ícone de ajuda dentro do span do rótulo
      const v = (c.attrs ?? {})[d.attribute_key]; // o valor REAL da linha (um valor pode ter o texto igual ao nome de outro campo)
      raiz.appendChild(new No('div')).appendChild(new No('p', v === undefined || v === null || v === '' ? '---' : String(v)));
      linhas[d.attribute_key] = drag;
    });
  };
  for (const k of Object.keys(linhas)) delete linhas[k];
  preencher();
  botaoNativo.onclick = () => { nativo.cliques++; if (c.cliqueFalha) return; nativo.aberto = !nativo.aberto; botaoNativo.texto = nativo.aberto ? 'Mostrar menos atributos' : 'Mostrar todos os atributos'; preencher(); };
  corpo.appendChild(caixaNativa);
  for (let i = 0; i < (c.paginaGrande ?? 0); i++) body.appendChild(new No('div', 'x' + i)).appendChild(new No('span', 'texto ' + i)); // página cheia (a Chatwoot real tem milhares de nós)
  body.appendChild(new No('div', 'Outra coisa da página')).appendChild(new No('span', 'Etapa')); // o mesmo texto fora do painel não confunde
  body.appendChild(acordeao);
  let chat: unknown = { id: conversa, custom_attributes: c.attrs ?? {} };
  const estilos: No[] = [];
  const doc = {
    body, documentElement: new No('html'), head: { appendChild: (e: No) => estilos.push(e) },
    createElement: (t: string) => new No(t),
    getElementById: (id: string) => (id === 'app' && !c.semStore ? { __vue_app__: { config: { globalProperties: { $store: { getters: { getSelectedChat: undefined as unknown, 'attributes/getAttributesByModel': () => defs } }, $t: (k: string) => ({ 'CUSTOM_ATTRIBUTES.SHOW_MORE': 'Mostrar todos os atributos', 'CUSTOM_ATTRIBUTES.SHOW_LESS': 'Mostrar menos atributos' } as Record<string, string>)[k] ?? k } } } } : null),
    querySelector: (sel: string) => (sel.startsWith('style[') ? (estilos[0] ?? null) : null),
    querySelectorAll: (sel: string) => {
      // o querySelectorAll de verdade é nativo (rápido): aqui só o painel entra na varredura, a página cheia (filler) é o que ele pularia por índice
      if (sel === '[data-dd-cartao]') return acordeao.todos().filter((n) => 'data-dd-cartao' in n.attrs);
      if (sel.startsWith('h1,')) { c.contagemDeBuscas && (c.contagemDeBuscas.n += 1); return acordeao.todos().filter((n) => /^(h[1-6]|button)$/.test(n.tag)); }
      return [];
    },
    addEventListener: () => {},
  };
  const app = doc.getElementById('app') as { __vue_app__: { config: { globalProperties: { $store: { getters: Record<string, unknown> } } } } } | null;
  if (app) Object.defineProperty(app.__vue_app__.config.globalProperties.$store.getters, 'getSelectedChat', { get: () => chat, configurable: true });
  doc.getElementById = (id: string) => (id === 'app' ? app : null) as never;
  const timers: Array<{ f: () => void; ms: number }> = [];
  const win: Record<string, unknown> = {};
  win.top = win;
  const loc = { pathname: c.caminho ?? `/app/accounts/1/conversations/${conversa}` };
  class Obs { constructor(public f: () => void) { obs.push(this); } observe(_alvo?: unknown, o?: unknown) { opcoesDoObservador.push(o); } }
  const opcoesDoObservador: unknown[] = [];
  const obs: Obs[] = [];
  const js = cartaoEnxutoJs(c.env ?? ({} as NodeJS.ProcessEnv), c.contas ?? []);
  assert.ok(js);
  new Function('window', 'document', 'location', 'setTimeout', 'clearTimeout', 'MutationObserver', js)(win, doc, loc, (f: () => void, ms: number) => { timers.push({ f, ms }); return timers.length; }, () => {}, Obs);
  const rodar = () => { const t = timers.splice(0); t.forEach((x) => x.f()); };
  const ocultas = () => Object.entries(linhas).filter(([, l]) => l.attrs['data-dd-cartao'] === 'oculto').map(([k]) => k);
  const visiveis = () => Object.keys(linhas).filter((k) => !ocultas().includes(k));
  const botao = () => acordeao.todos().find((n) => 'data-dd-cartao-toggle' in n.attrs) ?? null;
  return { opcoesDoObservador, passar: () => rodar(), nativo, caixaNativa, rodar, ocultas, visiveis, botao, linhas, lista, acordeao, loc, obs, trocar: (v: unknown) => { chat = v; }, estilos, textoBotao: () => botao()?.children[0]?.textContent };
}

test('AGENDADO: só os campos da etapa (e os «sempre»); o resto recolhe e o botão conta quantos', () => {
  const t = montar({ attrs: { etapa: 'Agendado', funil: 'Comercial' } });
  t.rodar();
  assert.deepEqual(t.visiveis(), ['etapa', 'funil', 'etapa_tratamento', 'data_consulta', 'hora_consulta', 'situacao_consulta', 'pagamento_antecipado']);
  assert.deepEqual(t.ocultas(), ['qualificacao', 'queixa', 'motivo_nao_agendamento', 'valor_tratamento', 'proxima_sessao', 'data_alta']);
  assert.equal(t.textoBotao(), 'Mostrar todos os campos (6)');
  assert.equal(t.estilos.length, 1);
});

test('CAMPO PREENCHIDO NUNCA SOME: aparece mesmo fora da etapa (inclusive 0 e false de caixa desmarcada); vazio (null, "", []) continua recolhido', () => {
  const t = montar({ attrs: { etapa: 'Agendado', queixa: 'Dor na lombar', valor_tratamento: 0, motivo_nao_agendamento: '', proxima_sessao: null, data_alta: false, qualificacao: [], hora_sessao: undefined } });
  t.rodar();
  assert.ok(t.visiveis().includes('queixa'), 'queixa preenchida');
  assert.ok(t.visiveis().includes('valor_tratamento'), 'o número 0 é um valor');
  assert.ok(t.visiveis().includes('data_alta'), 'false (caixa desmarcada) é um valor registrado');
  for (const k of ['motivo_nao_agendamento', 'proxima_sessao', 'qualificacao']) assert.ok(t.ocultas().includes(k), k);
  assert.equal(t.textoBotao(), 'Mostrar todos os campos (3)');
});

test('NOVO LEAD e sem etapa: o molde de qualificação; PERDIDO: o motivo; grafia sem acento/maiúscula casa; etapa DESCONHECIDA não recolhe nada', () => {
  for (const attrs of [{ etapa: 'Novo lead' }, {}, { etapa: 'NOVO LEAD' }]) {
    const t = montar({ attrs });
    t.rodar();
    assert.ok(t.visiveis().includes('qualificacao') && t.visiveis().includes('queixa') && !t.visiveis().includes('data_consulta'), JSON.stringify(attrs));
  }
  const pos = montar({ attrs: { etapa: 'Pos-consulta' } });
  pos.rodar();
  assert.ok(pos.visiveis().includes('valor_tratamento') && !pos.visiveis().includes('data_consulta'), 'Pos-consulta (sem acento) = Pós-consulta');
  const nova = montar({ attrs: { etapa: 'Reagendado' } });
  nova.rodar();
  assert.deepEqual(nova.ocultas(), [], 'etapa que o mapa não conhece: o painel fica inteiro');
  assert.equal(nova.botao(), null);
  const p = montar({ attrs: { etapa: 'Perdido' } });
  p.rodar();
  assert.ok(p.visiveis().includes('motivo_nao_agendamento') && !p.visiveis().includes('queixa'));
});

test('TRATAMENTO: funil/etapa_tratamento mostram sessão, e Alta soma os campos de alta', () => {
  const a = montar({ attrs: { etapa: 'Fechou', funil: 'Tratamento', etapa_tratamento: 'Em tratamento' } });
  a.rodar();
  assert.ok(a.visiveis().includes('proxima_sessao') && !a.visiveis().includes('data_alta') && !a.visiveis().includes('data_consulta'));
  const b = montar({ attrs: { funil: 'Tratamento', etapa_tratamento: 'Alta' } });
  b.rodar();
  assert.ok(b.visiveis().includes('proxima_sessao') && b.visiveis().includes('data_alta'));
});

test('PAGAMENTO ANTECIPADO só onde a clínica aceita (CHATWOOT_CARTAO_SEM_ANTECIPADO = contas que não aceitam); preenchido nunca some', () => {
  const env = { CHATWOOT_CARTAO_SEM_ANTECIPADO: '3, 9' } as NodeJS.ProcessEnv;
  const timbo = montar({ attrs: { etapa: 'Agendado' }, caminho: '/app/accounts/3/conversations/5', env });
  timbo.rodar();
  assert.ok(timbo.ocultas().includes('pagamento_antecipado'));
  const parau = montar({ attrs: { etapa: 'Agendado' }, caminho: '/app/accounts/1/conversations/5', env });
  parau.rodar();
  assert.ok(parau.visiveis().includes('pagamento_antecipado'));
  const preenchido = montar({ attrs: { etapa: 'Agendado', pagamento_antecipado: true }, caminho: '/app/accounts/3/conversations/5', env });
  preenchido.rodar();
  assert.ok(preenchido.visiveis().includes('pagamento_antecipado'));
});

test('«Mostrar todos»: abre tudo (nada some), o botão vira «só os da etapa», e outra conversa volta a recolher', () => {
  const t = montar({ attrs: { etapa: 'Agendado' } });
  t.rodar();
  t.botao()!.children[0]!.onclick!();
  t.rodar();
  assert.deepEqual(t.ocultas(), []);
  assert.equal(t.textoBotao(), 'Mostrar só os campos da etapa');
  t.botao()!.children[0]!.onclick!();
  t.rodar();
  assert.equal(t.ocultas().length, 6);
  t.botao()!.children[0]!.onclick!(); t.rodar();
  assert.deepEqual(t.ocultas(), []);
  t.loc.pathname = '/app/accounts/1/conversations/6';
  t.trocar({ id: 6, custom_attributes: { etapa: 'Agendado' } });
  t.obs[0]!.f(); t.rodar();
  assert.equal(t.ocultas().length, 6, 'conversa nova: recolhido de novo');
});

test('o botão reaproveitado entre conversas continua funcionando (o clique não guarda a conversa em que nasceu)', () => {
  const t = montar({ attrs: { etapa: 'Agendado' }, conversa: 10, caminho: '/app/accounts/1/conversations/10' });
  t.rodar();
  t.loc.pathname = '/app/accounts/1/conversations/20';
  t.trocar({ id: 20, custom_attributes: { etapa: 'Agendado' } });
  t.obs[0]!.f(); t.rodar();
  t.botao()!.children[0]!.onclick!();
  t.rodar();
  assert.deepEqual(t.ocultas(), [], 'abriu mesmo depois de trocar de conversa');
});

test('dois atributos com o MESMO nome de exibição são ambíguos: nenhum deles é recolhido por engano', () => {
  const t = montar({ attrs: { etapa: 'Agendado' }, repetido: true });
  t.rodar();
  assert.ok(t.visiveis().includes('queixa') && t.visiveis().includes('queixa_antiga'), 'as duas linhas «Queixa» ficam (ou nenhuma é achada)');
});

test('estrutura REAL do Chatwoot 4.19.1: título «Informação da conversa», rótulo com ícone de ajuda dentro, linha = div.drag-handle (a que tem a borda), e o botão nativo «Mostrar todos os atributos»', () => {
  const t = montar({ attrs: { etapa: 'Agendado' }, nativoAberto: false });
  // o nativo só renderiza 5 linhas até abrir: o script abre UMA vez (o mesmo clique do usuário) e depois recolhe pelo mapa
  assert.equal(Object.keys(t.linhas).length, 5);
  t.rodar();
  assert.equal(t.nativo.cliques, 1, 'abriu o nativo uma vez');
  t.rodar(); t.rodar();
  assert.equal(t.nativo.cliques, 1, 'e só uma vez');
  assert.equal(Object.keys(t.linhas).length, 13, 'agora as 13 linhas existem');
  t.obs[0]!.f(); t.rodar();
  assert.ok(t.ocultas().includes('queixa'), 'a «Queixa» (rótulo com ícone de ajuda) foi achada e recolhida');
  assert.ok(t.visiveis().includes('data_consulta'));
  for (const k of t.ocultas()) assert.equal(t.linhas[k]!.tag, 'div', k); // a linha escondida é o item da lista (o drag-handle), não um pedaço do meio dele
  assert.equal(t.caixaNativa.getAttribute('data-dd-cartao'), 'oculto', 'o botão nativo some (o nosso manda)');
  assert.equal(t.textoBotao(), 'Mostrar todos os campos (6)');
});

test('se o nativo já está aberto não clica; se o usuário o fecha de novo na mesma carga, não brigamos com ele', () => {
  const t = montar({ attrs: { etapa: 'Agendado' }, nativoAberto: true });
  t.rodar();
  assert.equal(t.nativo.cliques, 0);
});

test('título em inglês e em português sem acento também casam; título desconhecido = não faz nada', () => {
  for (const titulo of ['Conversation Information', 'Informacoes da conversa', 'Atributos da conversa']) {
    const t = montar({ attrs: { etapa: 'Agendado' }, titulo }); t.rodar();
    assert.ok(t.ocultas().length > 0, titulo);
  }
  const t = montar({ attrs: { etapa: 'Agendado' }, titulo: 'Outra coisa' }); t.rodar();
  assert.deepEqual(t.ocultas(), []);
});

test('NADA do Vue é apagado nem movido: as mesmas linhas, na mesma ordem; o único nó novo é o botão, ANTES da lista (nunca entre as linhas)', () => {
  const t = montar({ attrs: { etapa: 'Agendado' } });
  const antes = [...t.lista.children];
  t.rodar();
  assert.deepEqual(t.lista.children, antes, 'a lista de linhas é a mesma');
  assert.equal(t.botao()!.parentNode, t.lista.parentNode);
  assert.equal(t.botao()!.nextSibling, t.lista, 'o botão vem antes da lista');
  // o Vue refaz o painel e leva o botão embora: a próxima passada o recoloca
  t.lista.parentNode!.removeChild(t.botao()!);
  t.obs[0]!.f(); t.rodar();
  assert.equal(t.botao()!.nextSibling, t.lista);
  assert.equal(t.acordeao.todos().filter((n) => 'data-dd-cartao-toggle' in n.attrs).length, 1, 'um botão só');
});

test('o que o script NÃO acha ou não pode ler: não faz nada e não quebra (sem painel, sem estado do Chatwoot, fora de conversa, etapa muda ao vivo)', () => {
  const semPainel = montar({ attrs: { etapa: 'Agendado' }, semPainel: true });
  assert.doesNotThrow(() => semPainel.rodar());
  assert.deepEqual(semPainel.ocultas(), []);
  assert.equal(semPainel.botao(), null);
  const semStore = montar({ semStore: true });
  assert.doesNotThrow(() => semStore.rodar());
  assert.deepEqual(semStore.ocultas(), []);
  const fora = montar({ attrs: { etapa: 'Agendado' }, caminho: '/app/accounts/1/dashboard' });
  fora.rodar();
  assert.deepEqual(fora.ocultas(), []);
  // a etapa muda na conversa aberta: a passada seguinte reorganiza e solta o que passou a valer
  const v = montar({ attrs: { etapa: 'Agendado' } });
  v.rodar();
  assert.ok(v.ocultas().includes('queixa'));
  v.trocar({ id: 5, custom_attributes: { etapa: 'Novo lead' } });
  v.obs[0]!.f(); v.rodar();
  assert.ok(!v.ocultas().includes('queixa') && v.ocultas().includes('data_consulta'));
});

test('o mapa muda SEM deploy (CHATWOOT_CARTAO_ETAPAS): troca o que vier, deixa o resto, etapa nova entra, chave fora do formato e JSON ruim são ignorados', () => {
  assert.deepEqual(mapaDoCartao({} as NodeJS.ProcessEnv).etapas.Agendado, CARTAO_PADRAO.etapas.Agendado);
  const m = mapaDoCartao({ CHATWOOT_CARTAO_ETAPAS: JSON.stringify({ etapas: { Agendado: ['data_consulta', 'Chave Ruim', 'hora_consulta', 3, 'x'.repeat(61)], 'Etapa Nova': ['queixa'], Perdido: [] }, sempre: ['etapa'] }) } as NodeJS.ProcessEnv);
  assert.deepEqual(m.etapas.Agendado, ['data_consulta', 'hora_consulta']);
  assert.deepEqual(m.etapas['Etapa Nova'], ['queixa']);
  assert.deepEqual(m.etapas.Perdido, [], 'lista vazia zera a etapa');
  assert.deepEqual(m.sempre, ['etapa']);
  assert.deepEqual(m.etapas.Compareceu, CARTAO_PADRAO.etapas.Compareceu, 'o resto fica como estava');
  assert.deepEqual(mapaDoCartao({ CHATWOOT_CARTAO_ETAPAS: '{json quebrado' } as NodeJS.ProcessEnv).etapas.Agendado, CARTAO_PADRAO.etapas.Agendado);
  assert.deepEqual(mapaDoCartao({ CHATWOOT_CARTAO_ETAPAS: '"texto"' } as NodeJS.ProcessEnv).etapas.Agendado, CARTAO_PADRAO.etapas.Agendado);
  assert.deepEqual(mapaDoCartao({ CHATWOOT_CARTAO_SEM_ANTECIPADO: '3,abc,-1,9' } as NodeJS.ProcessEnv).semAntecipado, [3, 9]);
  const proto = mapaDoCartao({ CHATWOOT_CARTAO_ETAPAS: '{"etapas":{"__proto__":["x"],"constructor":["y"]}}' } as NodeJS.ProcessEnv);
  assert.ok(Object.getPrototypeOf(proto.etapas) === Object.prototype && !Object.prototype.hasOwnProperty.call(proto.etapas, 'constructor'), '__proto__ e constructor são ignorados');
  // o mapa vai dentro do script (e `</script>` no JSON não escapa)
  const js = cartaoEnxutoJs({ CHATWOOT_CARTAO_ETAPAS: JSON.stringify({ etapas: { '</script><b>': ['queixa'] } }) } as NodeJS.ProcessEnv);
  assert.ok(!js.includes('</script>'));
});

test('a chave CHATWOOT_CARTAO_ENXUTO=0 tira o bloco; o menu.js leva o bloco em try próprio e PARSEIA', () => {
  assert.equal(cartaoEnxutoLigado({} as NodeJS.ProcessEnv), true);
  assert.equal(cartaoEnxutoLigado({ CHATWOOT_CARTAO_ENXUTO: ' 0 ' } as NodeJS.ProcessEnv), false);
  assert.equal(cartaoEnxutoJs({ CHATWOOT_CARTAO_ENXUTO: '0' } as NodeJS.ProcessEnv), '');
  const js = montarMenuJs('https://agente.exemplo.test');
  assert.doesNotThrow(() => new Function(js));
  assert.ok(js.includes('__cartaoEnxutoDD'));
  const i = js.indexOf('window.__cartaoEnxutoDD');
  assert.match(js.slice(js.lastIndexOf(';try{', i), i), /^;try\{\s*\(function\(\)\{/);
  assert.ok(js.includes('window.__funilMenu') && js.includes('window.__seloSofiaDD') && js.includes('window.__guiaEtapaDD'));
  assert.match(js.trimEnd(), /\}catch\(e\)\{\}$/);
  const antes = process.env.CHATWOOT_CARTAO_ENXUTO;
  process.env.CHATWOOT_CARTAO_ENXUTO = '0';
  try {
    const sem = montarMenuJs('https://agente.exemplo.test');
    assert.ok(!sem.includes('__cartaoEnxutoDD'));
    assert.doesNotThrow(() => new Function(sem));
  } finally {
    if (antes === undefined) delete process.env.CHATWOOT_CARTAO_ENXUTO; else process.env.CHATWOOT_CARTAO_ENXUTO = antes;
  }
});

test('CSS: o recolhido é só display:none por atributo (nada de apagar), claro/escuro e 44 px no celular', () => {
  const css = (cartaoEnxutoJs({} as NodeJS.ProcessEnv).match(/function css\(\)\{[\s\S]*?\n  \}/) ?? [''])[0];
  assert.ok(css.includes('[\' + ATTR + \'="oculto"]{display:none!important}'));
  assert.ok(css.includes('.dark ['));
  assert.ok(css.includes('max-width:560px') && css.includes('min-height:44px'));
});

// ── sondas do sênior (25/11) ────────────────────────────────────────────────────────────────────────────────────────────────────
test('SONDA A: o VALOR de um campo igual ao NOME de outro campo não é tomado por rótulo — a linha preenchida nunca some', () => {
  const defs = [...DEFS, { attribute_key: 'plano_de_saude', attribute_display_name: 'Plano de saúde', attribute_model: 'conversation_attribute' }];
  const t = montar({ defs, attrs: { etapa: 'Agendado', motivo_nao_agendamento: 'Plano de saúde' } });
  t.rodar();
  assert.ok(!t.ocultas().includes('motivo_nao_agendamento'), 'motivo_nao_agendamento está preenchido: não some');
  assert.ok(t.ocultas().includes('plano_de_saude'), 'e a linha «Plano de saúde» (vazia, fora da etapa) é a que recolhe');
});

test('SONDA B: o FUNIL decide primeiro — paciente que voltou como lead (funil Comercial, etapa Novo lead) mesmo com etapa_tratamento antigo fica com o molde de lead', () => {
  const t = montar({ attrs: { funil: 'Comercial', etapa: 'Novo lead', etapa_tratamento: 'Alta' } });
  t.rodar();
  assert.ok(!t.ocultas().includes('qualificacao') && !t.ocultas().includes('queixa'), 'qualificação e queixa visíveis');
  assert.ok(t.visiveis().includes('etapa_tratamento'), 'o preenchido continua à vista');
  // sem funil, o etapa_tratamento preenchido indica tratamento (como antes); funil Tratamento também
  const a = montar({ attrs: { etapa: 'Novo lead', etapa_tratamento: 'Sessão 3' } }); a.rodar();
  assert.ok(a.visiveis().includes('proxima_sessao'), 'sem funil: tratamento');
  const b = montar({ attrs: { funil: 'Tratamento', etapa: 'Fechou' } }); b.rodar();
  assert.ok(b.visiveis().includes('proxima_sessao'), 'funil Tratamento: tratamento');
});

test('SONDA C: o botão nativo só some quando está ABERTO; recolhido (inclusive se o clique falhar) fica visível — é o único caminho para as linhas 6+', () => {
  const falha = montar({ attrs: { etapa: 'Agendado' }, nativoAberto: false, cliqueFalha: true });
  falha.rodar(); falha.rodar();
  assert.equal(falha.nativo.cliques, 1, 'tentou uma vez');
  assert.equal(falha.caixaNativa.getAttribute('data-dd-cartao'), null, 'recolhido: o nativo continua visível');
  assert.equal(Object.keys(falha.linhas).length, 5);
  const ok = montar({ attrs: { etapa: 'Agendado' }, nativoAberto: false });
  ok.rodar();
  assert.equal(ok.caixaNativa.getAttribute('data-dd-cartao'), null, 'logo após o clique, antes do Vue refazer o painel, ainda recolhido-visível ou aberto-escondido: nunca escondido-recolhido');
  ok.obs[0]!.f(); ok.rodar();
  assert.equal(ok.caixaNativa.getAttribute('data-dd-cartao'), 'oculto', 'aberto: some');
});

test('contas SEM antecipado vêm do BANCO (a lista que o guia recebe) somada à variável de ambiente; sem nenhuma, todas aceitam', () => {
  assert.deepEqual(mapaDoCartao({} as NodeJS.ProcessEnv, [3, 7]).semAntecipado, [3, 7]);
  assert.deepEqual(mapaDoCartao({ CHATWOOT_CARTAO_SEM_ANTECIPADO: '9, 3' } as NodeJS.ProcessEnv, [3, 7]).semAntecipado, [3, 7, 9], 'soma sem repetir');
  assert.deepEqual(mapaDoCartao({} as NodeJS.ProcessEnv).semAntecipado, []);
  const timbo = montar({ attrs: { etapa: 'Agendado' }, caminho: '/app/accounts/3/conversations/5', contas: [3] });
  timbo.rodar();
  assert.ok(timbo.ocultas().includes('pagamento_antecipado'), 'Timbó (3) vindo do banco, sem variável de ambiente');
  const parau = montar({ attrs: { etapa: 'Agendado' }, caminho: '/app/accounts/1/conversations/5', contas: [3] });
  parau.rodar();
  assert.ok(parau.visiveis().includes('pagamento_antecipado'));
});

test('montarMenuJs entrega ao cartão a MESMA lista de contas sem antecipado que entrega ao guia', () => {
  const js = montarMenuJs('https://agente.exemplo.test', [3, 11]);
  assert.equal((js.match(/"semAntecipado":\[3,11\]/g) ?? []).length, 2, 'o guia e o cartão, os dois com [3,11]');
  assert.equal((montarMenuJs('https://agente.exemplo.test').match(/"semAntecipado":\[\]/g) ?? []).length, 2);
});

test('DESEMPENHO (só informativo): a busca do painel é DIRECIONADA — não percorre a página inteira; sem painel, cada passada é uma busca por cabeçalhos/botões', () => {
  const buscas = { n: 0 };
  const t = montar({ attrs: { etapa: 'Agendado' }, paginaGrande: 8000, contagemDeBuscas: buscas });
  const ini = performance.now();
  t.rodar();
  const primeira = performance.now() - ini;
  // INFORMATIVO (sem limite de relógio): o DOM de teste pula os 16.000 nós, então este número NÃO mede o navegador real
  console.log(`informativo (DOM falso, não mede o navegador): 1ª passada ${primeira.toFixed(2)} ms`);
  assert.ok(t.ocultas().length > 0, 'o painel foi achado e recolhido mesmo com a página cheia');
  // sem painel (sidebar fechada): cada passada é UMA busca por cabeçalhos/botões, não uma varredura
  const s = montar({ attrs: { etapa: 'Agendado' }, semPainel: true, paginaGrande: 8000, contagemDeBuscas: buscas });
  buscas.n = 0; s.rodar(); s.obs[0]!.f(); s.rodar();
  assert.ok(buscas.n >= 1 && buscas.n <= 6, 'buscas direcionadas: ' + buscas.n);
});

test('SONDA D (bloqueio do sênior): «Informação da conversa» RECOLHIDO e «Atributos do contato» aberto com nomes iguais → o script NÃO mexe no painel do contato (nada escondido, nenhum clique no nativo do contato)', () => {
  const defs = [...DEFS, { attribute_key: 'origem', attribute_display_name: 'Origem', attribute_model: 'conversation_attribute' }];
  const body = new No('body');
  const sidebar = body.appendChild(new No('div'));
  const acConversa = sidebar.appendChild(new No('div')); // recolhido: o Chatwoot não renderiza o corpo
  acConversa.appendChild(new No('button')).appendChild(new No('h5', 'Informação da conversa'));
  const acContato = sidebar.appendChild(new No('div'));
  acContato.appendChild(new No('button')).appendChild(new No('h5', 'Atributos do contato'));
  const corpo = acContato.appendChild(new No('div'));
  const lista = corpo.appendChild(new No('div'));
  const linhas: Record<string, No> = {};
  for (const [k, nome, valor] of [['origem', 'Origem', 'Instagram'], ['queixa', 'Queixa', 'Dor lombar'], ['interno', 'Interno', '---']] as const) {
    const drag = lista.appendChild(new No('div'));
    const raiz = drag.appendChild(new No('div'));
    raiz.appendChild(new No('div')).appendChild(new No('h4')).appendChild(new No('div')).appendChild(new No('span', nome + ' '));
    raiz.appendChild(new No('div')).appendChild(new No('p', valor));
    linhas[k] = drag;
  }
  let cliques = 0;
  const bn = corpo.appendChild(new No('div')).appendChild(new No('button', 'Mostrar todos os atributos'));
  bn.onclick = () => { cliques++; };
  const app = { __vue_app__: { config: { globalProperties: { $store: { getters: { getSelectedChat: { id: 5, custom_attributes: { etapa: 'Agendado' } }, 'attributes/getAttributesByModel': () => defs } }, $t: (k: string) => ({ 'CUSTOM_ATTRIBUTES.SHOW_MORE': 'Mostrar todos os atributos', 'CUSTOM_ATTRIBUTES.SHOW_LESS': 'Mostrar menos atributos' } as Record<string, string>)[k] ?? k } } } };
  const estilos: No[] = [];
  const doc = { body, documentElement: new No('html'), head: { appendChild: (e: No) => estilos.push(e) }, createElement: (t: string) => new No(t), getElementById: (id: string) => (id === 'app' ? app : null),
    querySelector: (sel: string) => (sel.startsWith('style[') ? (estilos[0] ?? null) : null),
    querySelectorAll: (sel: string) => (sel === '[data-dd-cartao]' ? body.todos().filter((n) => 'data-dd-cartao' in n.attrs) : sel.startsWith('h1,') ? body.todos().filter((n) => /^(h[1-6]|button)$/.test(n.tag)) : []),
    addEventListener: () => {} };
  const timers: Array<() => void> = []; const win: Record<string, unknown> = {}; win.top = win; class Obs { observe() {} }
  new Function('window', 'document', 'location', 'setTimeout', 'clearTimeout', 'MutationObserver', cartaoEnxutoJs({} as NodeJS.ProcessEnv))(win, doc, { pathname: '/app/accounts/1/conversations/5' }, (f: () => void) => { timers.push(f); return timers.length; }, () => {}, Obs);
  for (let i = 0; i < 5; i++) timers.splice(0).forEach((f) => f());
  assert.deepEqual(Object.entries(linhas).filter(([, l]) => 'data-dd-cartao' in l.attrs), [], 'nenhuma linha do contato foi tocada');
  assert.equal(cliques, 0, 'o nativo do contato não foi clicado');
  assert.equal(bn.parentNode!.getAttribute('data-dd-cartao'), null, 'nem escondido');
  assert.equal(acContato.todos().some((n) => 'data-dd-cartao-toggle' in n.attrs), false, 'nem o nosso botão no contato');
  assert.equal(estilos.length, 0, 'sem painel da conversa o script nem injeta CSS');
});

test('painel da conversa ABERTO com o do contato ao lado (nomes iguais): só o da conversa é recolhido; o do contato fica intacto', () => {
  const t = montar({ attrs: { etapa: 'Agendado' } });
  const lateral = new No('div');
  const ac = lateral.appendChild(new No('div'));
  ac.appendChild(new No('button')).appendChild(new No('h5', 'Atributos do contato'));
  const l = ac.appendChild(new No('div')).appendChild(new No('div'));
  const dragC = l.appendChild(new No('div')); dragC.appendChild(new No('div')).appendChild(new No('span', 'Queixa '));
  const dragD = l.appendChild(new No('div')); dragD.appendChild(new No('div')).appendChild(new No('span', 'Funil '));
  t.acordeao.parentNode!.appendChild(lateral);
  t.rodar(); t.obs[0]!.f(); t.rodar();
  assert.ok(t.ocultas().includes('queixa'), 'a Queixa da CONVERSA recolheu');
  assert.equal(dragC.getAttribute('data-dd-cartao'), null, 'a do contato não');
  assert.equal(dragD.getAttribute('data-dd-cartao'), null);
});

test('campo preenchido pelo servidor com a conversa aberta: o observador também ouve characterData (só o TEXTO do valor muda) e a linha deixa de ficar oculta na passada seguinte', () => {
  const t = montar({ attrs: { etapa: 'Agendado' } });
  t.rodar();
  assert.ok(t.opcoesDoObservador.some((o) => (o as { characterData?: boolean })?.characterData === true && (o as { subtree?: boolean }).subtree === true), 'observa characterData em toda a árvore');
  assert.ok(t.ocultas().includes('queixa'));
  // o servidor preenche a queixa: o store muda e o Vue só troca o texto do valor; o observador dispara a passada
  t.trocar({ id: 5, custom_attributes: { etapa: 'Agendado', queixa: 'Dor lombar' } });
  t.obs[0]!.f(); t.rodar();
  assert.ok(!t.ocultas().includes('queixa'), 'preenchida: nunca fica oculta');
});

test('menu.js com TODOS os blocos (guia, selo, domínio, rótulo e cartão): cada um no seu try, na ordem, e o arquivo todo PARSEIA', () => {
  const js = montarMenuJs('https://agente.exemplo.test', [3, 11], { drtimbo: 3 });
  assert.doesNotThrow(() => new Function(js));
  const marcas = ['window.__funilMenu', 'window.__guiaEtapaDD', 'window.__seloSofiaDD', 'window.__dominioContaDD', 'window.__rotuloRoboDD', 'window.__cartaoEnxutoDD'];
  const pos = marcas.map((m) => js.indexOf(m));
  assert.ok(pos.every((p) => p >= 0), 'todos os blocos estão no arquivo: ' + JSON.stringify(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, 'na ordem: menu, guia, selo, domínio, rótulo, cartão');
  for (const m of marcas.slice(1)) assert.match(js.slice(js.lastIndexOf(';try{', js.indexOf(m)), js.indexOf(m)), /^;try\{\s*\(function\(\)\{/, m + ' em bloco próprio');
  assert.ok(js.includes('"drtimbo":3'));
});
