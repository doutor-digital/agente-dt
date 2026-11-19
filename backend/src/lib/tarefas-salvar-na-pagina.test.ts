/**
 * «Failed to fetch» com a tarefa CRIADA (19/11/2026, duas vezes na gravação do vídeo). Roda o JavaScript da página DE VERDADE (`vm`) com um servidor de mentira:
 *  - a releitura da lista depois de salvar que cai NÃO vira erro do agendamento (esse era o buraco: ela ficava no mesmo try do POST);
 *  - POST sem resposta não vira «erro»: a tela LÊ a lista, vê que a tarefa entrou e diz que deu certo — sem mandar o POST de novo (não duplica);
 *  - POST sem resposta e tarefa fora da lista: «não consegui confirmar», com a ordem de conferir a lista antes de tentar de novo;
 *  - erro de verdade (o servidor respondeu recusando) continua erro e não confere nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ESPERAS_DA_CONFERENCIA_MS, ESTADOS_QUE_PROVAM, JANELA_DA_PROVA_MS, SALVAR_NA_PAGINA_JS, TEMPO_DA_ESCRITA_MS, TEMPO_DA_LEITURA_NA_CONFERENCIA_MS, comSalvarNaPagina } from './tarefas-salvar-na-pagina.js';

interface Fns {
  gravarEAtualizar: (gravar: () => Promise<unknown>, atualizar: () => Promise<unknown>) => Promise<{ resposta: unknown; atualizou: boolean }>;
  buscar: (fetchFn: unknown, url: string, opcoes: unknown, ms: number) => Promise<{ r: { ok: boolean; status: number }; j: Record<string, unknown> }>;
  salvarTarefa: (x: Record<string, unknown>) => Promise<{ resposta: Record<string, unknown>; conferida: boolean; atualizou: boolean }>;
  tarefaPedida: (d: unknown, p: Record<string, unknown>) => boolean;
}
const fns = (): Fns => {
  const ctx = vm.createContext({ Date, Error, Promise, JSON, Object, setTimeout, clearTimeout, AbortController });
  vm.runInContext(`${SALVAR_NA_PAGINA_JS}\nthis.salvarTarefa = salvarTarefa; this.tarefaPedida = tarefaPedida; this.buscar = buscar; this.gravarEAtualizar = gravarEAtualizar;`, ctx);
  return ctx as unknown as Fns;
};

const AGORA = '2026-11-19T15:13:55.000Z';
const PEDIDO = { id: null, conversaId: 912, tipo: 'mensagem', quandoLocal: '2026-11-19T15:18', texto: 'Oi, Maria! Passando para lembrar.', responsavelId: 4, criadoPor: 'cleia@clinica.com' };
const tarefa = (o: Record<string, unknown> = {}) => ({
  id: 't1', estado: 'pendente', tipo: 'mensagem', conversaId: 912, quandoLocal: '2026-11-19T15:18', texto: 'Oi, Maria! Passando para lembrar.', responsavel: { id: 4, nome: 'Cleia' }, criadaEm: '2026-11-19T15:13:52.077Z', criadoPor: 'cleia@clinica.com', ...o,
});
const lista = (...t: unknown[]) => ({ agora: AGORA, tarefas: t });
const semResposta = () => new TypeError('Failed to fetch');
const recusa = (status: number, msg: string) => Object.assign(new Error(msg), { status });

function mundo(o: { enviar?: () => Promise<unknown>; listar?: Array<() => Promise<unknown>>; atualizar?: () => Promise<unknown> } = {}) {
  const chamadas = { enviar: 0, listar: 0, atualizar: 0, esperas: [] as number[] };
  const filaListar = [...(o.listar ?? [])];
  return {
    chamadas,
    x: (pedido: Record<string, unknown> = PEDIDO) => ({
      enviar: async () => {
        chamadas.enviar++;
        return o.enviar ? o.enviar() : { ok: true, id: 't1' };
      },
      listar: async () => {
        chamadas.listar++;
        const f = filaListar.shift();
        if (!f) throw semResposta();
        return f();
      },
      confere: (d: unknown) => fns().tarefaPedida(d, pedido),
      espera: async (ms: number) => void chamadas.esperas.push(ms),
      atualizar: async () => {
        chamadas.atualizar++;
        if (o.atualizar) await o.atualizar();
      },
    }),
  };
}

test('REPRODUÇÃO do bug: o POST deu certo e a releitura da lista caiu — a tarefa está criada, a tela NÃO pode dizer «Failed to fetch»', async () => {
  const m = mundo({ atualizar: async () => Promise.reject(semResposta()) });
  const r = await fns().salvarTarefa(m.x());
  assert.equal(r.atualizou, false, 'só avisa que a lista não atualizou');
  assert.deepEqual(r.resposta, { ok: true, id: 't1' });
  assert.deepEqual([m.chamadas.enviar, m.chamadas.listar], [1, 0], 'e o pedido foi mandado UMA vez');
});

test('tudo certo: um POST, a lista atualiza, nada é conferido à toa', async () => {
  const m = mundo();
  const r = await fns().salvarTarefa(m.x());
  assert.deepEqual([r.atualizou, r.conferida], [true, false]);
  assert.deepEqual([m.chamadas.enviar, m.chamadas.listar, m.chamadas.atualizar], [1, 0, 1]);
});

test('o servidor RESPONDEU recusando (horário passado, janela de 24 h…): é erro de verdade, nada é conferido nem atualizado', async () => {
  const m = mundo({ enviar: async () => Promise.reject(recusa(422, 'esse horário já passou')) });
  await assert.rejects(fns().salvarTarefa(m.x()), (e: Error & { status?: number }) => e.status === 422 && e.message === 'esse horário já passou');
  assert.deepEqual([m.chamadas.enviar, m.chamadas.listar, m.chamadas.atualizar], [1, 0, 0]);
  // 401 (sessão) e 5xx também são respostas: não são «sem resposta»
  const m2 = mundo({ enviar: async () => Promise.reject(recusa(502, 'não consegui ler')) });
  await assert.rejects(fns().salvarTarefa(m2.x()));
  assert.equal(m2.chamadas.listar, 0);
});

test('POST SEM resposta mas a tarefa entrou: a tela confere a lista, diz que deu certo e NÃO manda o pedido de novo (não duplica)', async () => {
  const m = mundo({ enviar: async () => Promise.reject(semResposta()), listar: [async () => lista(), async () => lista(tarefa())] });
  const r = await fns().salvarTarefa(m.x());
  assert.equal(r.conferida, true);
  assert.equal(r.atualizou, true);
  assert.equal(m.chamadas.enviar, 1, 'um POST só, por maior que seja a dúvida');
  assert.deepEqual(m.chamadas.esperas, ESPERAS_DA_CONFERENCIA_MS.slice(0, 2), 'esperou antes de cada conferência');
});

test('a conferência também aguenta a rede ainda ruim (a leitura da lista cai uma vez e depois vem)', async () => {
  const m = mundo({ enviar: async () => Promise.reject(semResposta()), listar: [async () => Promise.reject(semResposta()), async () => lista(tarefa())] });
  const r = await fns().salvarTarefa(m.x());
  assert.equal(r.conferida, true);
  assert.equal(m.chamadas.enviar, 1);
});

test('POST sem resposta e a tarefa NÃO aparece: «não consegui confirmar», mandando conferir a lista — e nada é atualizado como se tivesse dado certo', async () => {
  const m = mundo({ enviar: async () => Promise.reject(semResposta()), listar: [async () => lista(), async () => lista(), async () => lista()] });
  await assert.rejects(fns().salvarTarefa(m.x()), (e: Error & { incerto?: boolean }) => e.incerto === true && /Não consegui confirmar se a tarefa foi agendada/.test(e.message) && /Confira a lista antes de tentar de novo/.test(e.message) && !/Failed to fetch/.test(e.message));
  assert.equal(m.chamadas.enviar, 1, 'não reenvia sozinho');
  assert.deepEqual(m.chamadas.esperas, ESPERAS_DA_CONFERENCIA_MS);
  assert.equal(m.chamadas.atualizar, 0);
});

// ── como a conferência reconhece a tarefa ────────────────────────────────────────────────────────────

test('tarefaPedida: só a tarefa pedida, criada agora há pouco POR MIM — uma igual de ontem, de outra hora, conversa, pessoa ou de uma colega não prova nada', () => {
  const { tarefaPedida } = fns();
  assert.equal(tarefaPedida(lista(tarefa()), PEDIDO), true);
  assert.equal(tarefaPedida(lista(tarefa({ criadaEm: '2026-11-18T15:13:52.000Z' })), PEDIDO), false, 'igual, mas de ontem');
  assert.equal(tarefaPedida(lista(tarefa({ quandoLocal: '2026-11-19T16:00' })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ conversaId: 40 })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ tipo: 'ligacao' })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ texto: 'outro texto' })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ responsavel: { id: 9, nome: 'Outra' } })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ criadoPor: 'colega@clinica.com' })), PEDIDO), false, 'a tarefa igual da colega não prova a minha');
  assert.equal(tarefaPedida(lista(), PEDIDO), false);
  assert.equal(tarefaPedida(null, PEDIDO), false);
  // sem conversa conhecida (tarefa criada pelo contato) e sem responsável escolhido: compara o que há
  assert.equal(tarefaPedida(lista(tarefa()), { ...PEDIDO, conversaId: null, responsavelId: null }), true);
});

test('tarefaPedida ao EDITAR: vale a mesma tarefa (id) já com o que mudou; sem nada que a lista mostre mudado, a edição não é conferível (nunca dá «está lá» à toa)', () => {
  const { tarefaPedida } = fns();
  const edicao = { ...PEDIDO, id: 't1', verificavel: true, quandoLocal: '2026-11-19T17:00', texto: 'Novo texto' };
  assert.equal(tarefaPedida(lista(tarefa({ quandoLocal: '2026-11-19T17:00', texto: 'Novo texto', criadaEm: '2026-11-10T10:00:00.000Z' })), edicao), true, 'criada há dias, mas é a editada');
  assert.equal(tarefaPedida(lista(tarefa()), edicao), false, 'ainda com a hora antiga: a edição não entrou');
  assert.equal(tarefaPedida(lista(tarefa({ id: 'outra', quandoLocal: '2026-11-19T17:00', texto: 'Novo texto' })), edicao), false);
  // só o responsável mudou: a lista mostra o responsável, então confere por ele — e a edição que NÃO entrou (responsável antigo) não passa
  const soResp = { ...PEDIDO, id: 't1', verificavel: true, responsavelId: 9 };
  assert.equal(tarefaPedida(lista(tarefa({ responsavel: { id: 9, nome: 'Outra' } })), soResp), true);
  assert.equal(tarefaPedida(lista(tarefa()), soResp), false, 'o responsável continua o antigo: a edição não entrou');
  // salvou sem mudar hora, texto nem responsável (ou só o modelo): nada a provar
  assert.equal(tarefaPedida(lista(tarefa()), { ...PEDIDO, id: 't1', verificavel: false }), false);
});

// ── a chamada com tempo máximo ───────────────────────────────────────────────────────────────────────

const resp = (ok: boolean, status: number, corpo: unknown) => ({ ok, status, json: async () => corpo });

test('buscar: resposta do servidor passa inteira (inclusive a recusa — quem decide é o status)', async () => {
  const { buscar } = fns();
  const x = await buscar(async () => resp(false, 422, { error: 'esse horário já passou' }), '/api/x', { method: 'POST' }, 1000);
  assert.deepEqual([x.r.ok, x.r.status, x.j.error], [false, 422, 'esse horário já passou']);
  const y = await buscar(async () => ({ ok: true, status: 200, json: async () => Promise.reject(new Error('corpo vazio')) }), '/api/x', {}, 1000);
  assert.equal(JSON.stringify(y.j), '{}', 'corpo que não é JSON não derruba uma resposta ok');
});

test('buscar: a rede que cai vira erro SEM status e com texto de gente — nunca o «Failed to fetch» cru do navegador', async () => {
  const { buscar } = fns();
  await assert.rejects(buscar(async () => Promise.reject(new TypeError('Failed to fetch')), '/api/x', {}, 1000), (e: Error & { status?: number; semResposta?: boolean }) => e.status === undefined && e.semResposta === true && /Sem resposta do servidor/.test(e.message) && !/Failed to fetch/.test(e.message));
});

test('buscar: o servidor que não responde dentro do tempo é cortado (o «Salvando…» não fica preso), inclusive quando trava depois dos cabeçalhos', async () => {
  const { buscar } = fns();
  const trava = (_u: string, o: { signal: AbortSignal }) => new Promise((_ok, no) => o.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(buscar(trava, '/api/x', {}, 30), (e: Error & { semResposta?: boolean }) => e.semResposta === true);
  const travaNoCorpo = async (_u: string, o: { signal: AbortSignal }) => ({ ok: true, status: 200, json: () => new Promise((_ok, no) => o.signal.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')))) });
  await assert.rejects(buscar(travaNoCorpo, '/api/x', {}, 30), (e: Error & { semResposta?: boolean }) => e.semResposta === true, 'o corte vale também para ler o corpo');
});

test('o trecho entra na página no lugar do marcador, sem crase nem ${} (a página é um String.raw) e parseia', () => {
  const html = comSalvarNaPagina('<script>\n/*__SALVAR_JS__*/\n</script>');
  assert.ok(!html.includes('__SALVAR_JS__'));
  assert.ok(!SALVAR_NA_PAGINA_JS.includes('`') && !SALVAR_NA_PAGINA_JS.includes('${'));
  assert.doesNotThrow(() => new Function(SALVAR_NA_PAGINA_JS));
});

test('só prova o pedido a tarefa que EXISTE: idêntica cancelada, falhada ou barrada (de um pedido anterior) NÃO vira «conferi»; feita, pendente, enviando e aguardando valem', () => {
  const { tarefaPedida } = fns();
  for (const estado of ['cancelada', 'falhou', 'barrada']) assert.equal(tarefaPedida(lista(tarefa({ estado })), PEDIDO), false, estado);
  for (const estado of ESTADOS_QUE_PROVAM) assert.equal(tarefaPedida(lista(tarefa({ estado })), PEDIDO), true, estado);
  assert.deepEqual([...ESTADOS_QUE_PROVAM].sort(), ['aguardando', 'enviando', 'feita', 'pendente']);
});

test('e a tela, de ponta a ponta: POST sem resposta + só a cancelada idêntica na lista = «não consegui confirmar» (nunca «conferi»)', async () => {
  const m = mundo({ enviar: async () => Promise.reject(semResposta()), listar: [async () => lista(tarefa({ estado: 'cancelada' })), async () => lista(tarefa({ estado: 'cancelada' })), async () => lista(tarefa({ estado: 'falhou' }))] });
  await assert.rejects(fns().salvarTarefa(m.x()), (e: Error & { incerto?: boolean }) => e.incerto === true);
  assert.equal(m.chamadas.enviar, 1);
});

test('o pior caso da conferência cabe na janela em que a tarefa ainda vale como «criada agora há pouco»', () => {
  const pior = TEMPO_DA_ESCRITA_MS + ESPERAS_DA_CONFERENCIA_MS.reduce((a, b) => a + b, 0) + ESPERAS_DA_CONFERENCIA_MS.length * TEMPO_DA_LEITURA_NA_CONFERENCIA_MS;
  assert.ok(pior < JANELA_DA_PROVA_MS, `${pior} ms deve ser menor que ${JANELA_DA_PROVA_MS} ms`);
});

test('gravarEAtualizar: a gravação que falha lança; a atualização que falha só vira atualizou:false (cancelar, confirmar, feita, resultado, WhatsApp das atendentes)', async () => {
  const { gravarEAtualizar } = fns();
  const ok = await gravarEAtualizar(async () => ({ ok: true }), async () => Promise.reject(semResposta()));
  assert.equal(ok.atualizou, false);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.resposta)), { ok: true });
  let atualizou = 0;
  await assert.rejects(gravarEAtualizar(async () => Promise.reject(recusa(409, 'a tarefa mudou')), async () => void atualizou++), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(atualizou, 0);
});
