/**
 * Os cartões do Kommo de um telefone: TODOS (sem corte em 8), em lotes, com o mesmo número (DDI+DDD+8 dígitos, o Kommo guarda sem o 55), o aberto não se perde.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadsDoTelefone, type DadosDoKommo } from './chatwoot-campos-retroativos-kommo.js';

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
