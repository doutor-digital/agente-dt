/**
 * Os cartões do Kommo de um telefone: TODOS (sem corte em 8), em lotes, com o mesmo número (DDI+DDD+8 dígitos, o Kommo guarda sem o 55), o aberto não se perde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuscaDeContatosIncompleta, CONTATOS_POR_PAGINA, MAX_PAGINAS_DE_CONTATOS, leadsDoTelefone, type DadosDoKommo } from './chatwoot-campos-retroativos-kommo.js';

const funil = { id: 1, name: 'COMERCIAL', statuses: [{ id: 10, name: 'AGENDADO' }, { id: 143, name: 'PERDIDO' }] };

function kommoFalso(contatos: Array<{ id: number; telefones: string[]; leadIds: number[] }>, leads: Array<{ id: number; status_id: number }>) {
  const chamadas: string[] = [];
  const dados: DadosDoKommo = {
    kommo: {
      async buscarContatosPorTelefone(texto) {
        chamadas.push(`busca:${texto}`);
        return contatos;
      },
      async listLeadsPorIds(ids) {
        chamadas.push(`leads:${ids.length}`);
        return leads.filter((l) => ids.includes(l.id)).map((l) => ({ id: l.id, name: 'x', pipeline_id: 1, status_id: l.status_id, updated_at: l.id, loss_reason_id: l.status_id === 143 ? 7 : null }));
      },
    },
    funilDe: new Map([[1, funil]]),
    motivoDe: new Map([[7, 'Sem interesse']]),
    pausa: async (ms) => void chamadas.push(`pausa:${ms}`),
  };
  return { dados, chamadas };
}

test('um telefone com 60 cartões: o ABERTO (o 55º) não se perde — sem corte em 8 — e a leitura é em lote', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => i + 1);
  const leads = ids.map((id) => ({ id, status_id: id === 55 ? 10 : 143 }));
  const { dados, chamadas } = kommoFalso([{ id: 1, telefones: ['94988887777'], leadIds: ids }], leads);
  const r = await leadsDoTelefone(dados, '+5594988887777');
  assert.equal(r.length, 60);
  assert.deepEqual(r.find((l) => l.id === 55), { id: 55, funil: 'COMERCIAL', etapa: 'AGENDADO', statusId: 10, atualizadoEm: 55, motivoPerda: null });
  assert.equal(r.find((l) => l.id === 1)!.motivoPerda, 'Sem interesse');
  assert.deepEqual(chamadas, ['busca:88887777', 'pausa:300', 'leads:60']);
});

test('só cartões de contato com o MESMO número (sem 55 no Kommo casa; outro DDD ou lixo não)', async () => {
  const { dados } = kommoFalso(
    [
      { id: 1, telefones: ['(94) 98888-7777'], leadIds: [1] },
      { id: 2, telefones: ['+5511988887777'], leadIds: [2] },
      { id: 3, telefones: ['988887777'], leadIds: [3] },
    ],
    [{ id: 1, status_id: 10 }, { id: 2, status_id: 10 }, { id: 3, status_id: 10 }],
  );
  assert.deepEqual((await leadsDoTelefone(dados, '+5594988887777')).map((l) => l.id), [1]);
});

test('sem cartão: não faz a segunda chamada', async () => {
  const { dados, chamadas } = kommoFalso([], []);
  assert.deepEqual(await leadsDoTelefone(dados, '+5594988887777'), []);
  assert.deepEqual(chamadas, ['busca:88887777']);
});

/** Um Kommo que só entrega `CONTATOS_POR_PAGINA` por página e respeita `page`, como o de verdade. */
function kommoPaginado(todos: Array<{ id: number; telefones: string[]; leadIds: number[] }>, leads: Array<{ id: number; status_id: number }>) {
  const chamadas: string[] = [];
  const dados: DadosDoKommo = {
    kommo: {
      async buscarContatosPorTelefone(texto, limite = 50, pagina = 1) {
        chamadas.push(`busca:${texto}:p${pagina}`);
        return todos.slice((pagina - 1) * Math.min(50, limite), pagina * Math.min(50, limite));
      },
      async listLeadsPorIds(ids) {
        chamadas.push(`leads:${ids.length}`);
        return leads.filter((l) => ids.includes(l.id)).map((l) => ({ id: l.id, name: 'x', pipeline_id: 1, status_id: l.status_id, updated_at: l.id, loss_reason_id: null }));
      },
    },
    funilDe: new Map([[1, funil]]),
    motivoDe: new Map(),
    pausa: async () => undefined,
  };
  return { dados, chamadas };
}
const contatosDeOutraGente = (n: number, de = 1000) => Array.from({ length: n }, (_, i) => ({ id: de + i, telefones: ['(94) 98888-7777'.replace('94', String(11 + (i % 80)))], leadIds: [de + i] }));

test('mais de 50 contatos com os mesmos 8 dígitos: o contato CERTO que está na 2ª página é achado (antes: «sem cartão» e Perdido/Compareceu sem ver o cartão)', async () => {
  const certo = { id: 7, telefones: ['94988887777'], leadIds: [7] };
  const todos = [...contatosDeOutraGente(CONTATOS_POR_PAGINA), certo];
  const { dados, chamadas } = kommoPaginado(todos, [{ id: 7, status_id: 10 }]);
  const r = await leadsDoTelefone(dados, '+5594988887777');
  assert.deepEqual(r.map((l) => l.id), [7]);
  assert.deepEqual(chamadas.filter((c) => c.startsWith('busca')), ['busca:88887777:p1', 'busca:88887777:p2']);
});

test('exatamente 50 contatos: lê a página seguinte (vazia) para ter certeza antes de dizer «sem cartão»', async () => {
  const { dados, chamadas } = kommoPaginado(contatosDeOutraGente(CONTATOS_POR_PAGINA), []);
  assert.deepEqual(await leadsDoTelefone(dados, '+5594988887777'), []);
  assert.deepEqual(chamadas, ['busca:88887777:p1', 'busca:88887777:p2']);
});

test('a busca que continua voltando cheia depois do teto de páginas LANÇA «incompleta» (ambíguo) em vez de devolver «sem cartão»', async () => {
  const { dados } = kommoPaginado(contatosDeOutraGente(CONTATOS_POR_PAGINA * (MAX_PAGINAS_DE_CONTATOS + 2)), []);
  await assert.rejects(() => leadsDoTelefone(dados, '+5594988887777'), (e: unknown) => e instanceof BuscaDeContatosIncompleta && /pode haver contato que não vi/.test((e as Error).message));
});
