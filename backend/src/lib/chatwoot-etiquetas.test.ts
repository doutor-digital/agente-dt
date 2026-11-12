/**
 * Ponte etiqueta → cartão: o botão "Perdido: <motivo>" põe a etiqueta; a ponte grava etapa=Perdido + motivo, mantém os outros
 * atributos e etiquetas, tira só as `perdido-*`, e não faz nada fora das caixas do mapa ou quando a etiqueta já foi tratada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarEtiqueta, eventoDeEtiqueta, mudancaDaConversa, MOTIVO_POR_ETIQUETA, type PortasDaPonte } from './chatwoot-etiquetas.js';

const CAIXAS = { 2: 'doutor-hernia-parauapebas' };

test('evento: só conversation_updated, de caixa do mapa, com etiqueta de Perdido', () => {
  const base = { event: 'conversation_updated', id: 17, inbox_id: 2, labels: ['quente', 'perdido-outra-cidade'] };
  assert.deepEqual(eventoDeEtiqueta(base, CAIXAS), { conversa: 17, slug: 'doutor-hernia-parauapebas' });
  assert.equal(eventoDeEtiqueta({ ...base, event: 'message_created' }, CAIXAS), null);
  assert.equal(eventoDeEtiqueta({ ...base, inbox_id: 9 }, CAIXAS), null);
  assert.equal(eventoDeEtiqueta({ ...base, labels: ['quente'] }, CAIXAS), null);
  assert.equal(eventoDeEtiqueta({ ...base, labels: undefined }, CAIXAS), null);
  assert.equal(eventoDeEtiqueta({ ...base, id: 'x' }, CAIXAS), null);
});

test('mudança: etapa + motivo por cima dos atributos atuais; sai só a etiqueta de comando', () => {
  const m = mudancaDaConversa({
    labels: ['quente', 'perdido-plano-de-saude', 'respondeu-pelo-celular'],
    custom_attributes: { etapa: 'Sofia qualifica', data_consulta: '2026-11-20' },
  });
  assert.deepEqual(m, {
    atributos: { etapa: 'Perdido', data_consulta: '2026-11-20', motivo_nao_agendamento: 'Plano de saúde' },
    etiquetas: ['quente', 'respondeu-pelo-celular'],
    motivo: 'Plano de saúde',
  });
});

test('mudança: duas etiquetas de Perdido → vale a última, as duas saem', () => {
  const m = mudancaDaConversa({ labels: ['perdido-sem-interesse', 'perdido-outra-cidade'], custom_attributes: null });
  assert.equal(m?.motivo, 'Outra cidade');
  assert.deepEqual(m?.etiquetas, []);
});

test('mudança: sem etiqueta de Perdido (já tratada) → null', () => {
  assert.equal(mudancaDaConversa({ labels: ['quente'], custom_attributes: { etapa: 'Perdido' } }), null);
  assert.equal(mudancaDaConversa(null), null);
});

test('os 4 motivos batem com a lista do atributo motivo_nao_agendamento', () => {
  const lista = ['Não interagiu', 'Não deu continuidade', 'Clicou por engano', 'Sem interesse', 'Outra cidade', 'Vai se organizar',
    'Informação para terceiro', 'Outra patologia', 'Plano de saúde', 'Currículo', 'Sem condições', 'Viajando', 'Fornecedor/propaganda'];
  for (const v of Object.values(MOTIVO_POR_ETIQUETA)) assert.ok(lista.includes(v), v);
});

function portas(conv: any) {
  const chamadas: string[] = [];
  const p: PortasDaPonte = {
    conversa: async () => conv,
    gravarAtributos: async (id, a) => { chamadas.push(`attrs ${id} ${JSON.stringify(a)}`); },
    gravarEtiquetas: async (id, e) => { chamadas.push(`labels ${id} ${e.join(',')}`); },
  };
  return { p, chamadas };
}

test('aplicar: grava atributos e depois etiquetas', async () => {
  const { p, chamadas } = portas({ labels: ['perdido-sem-interesse', 'quente'], custom_attributes: { etapa: 'Novo lead' } });
  assert.equal(await aplicarEtiqueta({ conversa: 5, slug: 's' }, p, new Set()), 'gravou');
  assert.deepEqual(chamadas, [
    'attrs 5 {"etapa":"Perdido","motivo_nao_agendamento":"Sem interesse"}',
    'labels 5 quente',
  ]);
});

test('aplicar: leitura fresca sem a etiqueta → nada gravado', async () => {
  const { p, chamadas } = portas({ labels: [], custom_attributes: { etapa: 'Perdido' } });
  assert.equal(await aplicarEtiqueta({ conversa: 5, slug: 's' }, p, new Set()), 'nada');
  assert.deepEqual(chamadas, []);
});

test('aplicar: mesma conversa em andamento → ocupado, sem gravar', async () => {
  const { p, chamadas } = portas({ labels: ['perdido-sem-interesse'], custom_attributes: {} });
  assert.equal(await aplicarEtiqueta({ conversa: 5, slug: 's' }, p, new Set([5])), 'ocupado');
  assert.deepEqual(chamadas, []);
});
