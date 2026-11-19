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
import { ESPERAS_DA_CONFERENCIA_MS, SALVAR_NA_PAGINA_JS, comSalvarNaPagina } from './tarefas-salvar-na-pagina.js';

interface Fns {
  salvarTarefa: (x: Record<string, unknown>) => Promise<{ resposta: Record<string, unknown>; conferida: boolean; atualizou: boolean }>;
  tarefaPedida: (d: unknown, p: Record<string, unknown>) => boolean;
}
const fns = (): Fns => {
  const ctx = vm.createContext({ Date, Error, Promise, JSON });
  vm.runInContext(`${SALVAR_NA_PAGINA_JS}\nthis.salvarTarefa = salvarTarefa; this.tarefaPedida = tarefaPedida;`, ctx);
  return ctx as unknown as Fns;
};

const AGORA = '2026-11-19T15:13:55.000Z';
const PEDIDO = { id: null, conversaId: 912, tipo: 'mensagem', quandoLocal: '2026-11-19T15:18', texto: 'Oi, Maria! Passando para lembrar.', responsavelId: 4 };
const tarefa = (o: Record<string, unknown> = {}) => ({
  id: 't1', tipo: 'mensagem', conversaId: 912, quandoLocal: '2026-11-19T15:18', texto: 'Oi, Maria! Passando para lembrar.', responsavel: { id: 4, nome: 'Cleia' }, criadaEm: '2026-11-19T15:13:52.077Z', ...o,
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

test('tarefaPedida: só a tarefa pedida, criada agora há pouco — uma igual de ontem, de outra hora, de outra conversa ou de outra pessoa não prova nada', () => {
  const { tarefaPedida } = fns();
  assert.equal(tarefaPedida(lista(tarefa()), PEDIDO), true);
  assert.equal(tarefaPedida(lista(tarefa({ criadaEm: '2026-11-18T15:13:52.000Z' })), PEDIDO), false, 'igual, mas de ontem');
  assert.equal(tarefaPedida(lista(tarefa({ quandoLocal: '2026-11-19T16:00' })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ conversaId: 40 })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ tipo: 'ligacao' })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ texto: 'outro texto' })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(tarefa({ responsavel: { id: 9, nome: 'Outra' } })), PEDIDO), false);
  assert.equal(tarefaPedida(lista(), PEDIDO), false);
  assert.equal(tarefaPedida(null, PEDIDO), false);
  // sem conversa conhecida (tarefa criada pelo contato) e sem responsável escolhido: compara o que há
  assert.equal(tarefaPedida(lista(tarefa()), { ...PEDIDO, conversaId: null, responsavelId: null }), true);
});

test('tarefaPedida ao EDITAR: vale a mesma tarefa (id) já com a hora e o texto novos; a que ficou como estava não confere', () => {
  const { tarefaPedida } = fns();
  const edicao = { ...PEDIDO, id: 't1', quandoLocal: '2026-11-19T17:00', texto: 'Novo texto' };
  assert.equal(tarefaPedida(lista(tarefa({ quandoLocal: '2026-11-19T17:00', texto: 'Novo texto', criadaEm: '2026-11-10T10:00:00.000Z' })), edicao), true, 'criada há dias, mas é a editada');
  assert.equal(tarefaPedida(lista(tarefa()), edicao), false, 'ainda com a hora antiga: a edição não entrou');
  assert.equal(tarefaPedida(lista(tarefa({ id: 'outra', quandoLocal: '2026-11-19T17:00', texto: 'Novo texto' })), edicao), false);
});

test('o trecho entra na página no lugar do marcador, sem crase nem ${} (a página é um String.raw) e parseia', () => {
  const html = comSalvarNaPagina('<script>\n/*__SALVAR_JS__*/\n</script>');
  assert.ok(!html.includes('__SALVAR_JS__'));
  assert.ok(!SALVAR_NA_PAGINA_JS.includes('`') && !SALVAR_NA_PAGINA_JS.includes('${'));
  assert.doesNotThrow(() => new Function(SALVAR_NA_PAGINA_JS));
});
