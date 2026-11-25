/**
 * Ponte etiqueta → cartão: o botão "Perdido: <motivo>" põe a etiqueta; a ponte grava etapa=Perdido + motivo, mantém os outros
 * atributos e etiquetas, tira só as `perdido-*`, e não faz nada fora das caixas do mapa ou quando a etiqueta já foi tratada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarEtiqueta, eventoDeEtiqueta, motivoNaLista, mudancaDaConversa, MOTIVO_POR_ETIQUETA, type PortasDaPonte } from './chatwoot-etiquetas.js';

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

const LISTA_DO_KOMMO = ['Sem condições financeira', 'Não interagiu', 'Informação para terceiro', 'Outra patologia', 'Clicou por engano', 'Está viajando', 'Sem interesse', 'Não deu continuidade ao atendimento', 'Vai se organizar', 'Assinou contrato', 'Plano de Saúde', 'Outra cidade', 'Não é paciente (currículo)'];

test('lista com os nomes do Kommo («Plano de Saúde», «Não deu continuidade ao atendimento»): os 4 botões gravam a opção que a tela mostra', () => {
  for (const [etiqueta, esperado] of [['perdido-sem-interesse', 'Sem interesse'], ['perdido-outra-cidade', 'Outra cidade'], ['perdido-plano-de-saude', 'Plano de Saúde'], ['perdido-nao-deu-continuidade', 'Não deu continuidade ao atendimento']] as const) {
    const m = mudancaDaConversa({ labels: [etiqueta], custom_attributes: {} }, LISTA_DO_KOMMO)!;
    assert.equal(m.motivo, esperado, etiqueta);
    assert.ok(LISTA_DO_KOMMO.includes(m.atributos.motivo_nao_agendamento as string));
  }
});

test('motivoNaLista: lista desconhecida, vazia ou sem nada parecido = o valor de sempre; a lista de sempre não muda nada', () => {
  assert.equal(motivoNaLista('Plano de saúde', undefined), 'Plano de saúde');
  assert.equal(motivoNaLista('Plano de saúde', []), 'Plano de saúde');
  assert.equal(motivoNaLista('Plano de saúde', ['Plano de saúde', 'Plano de Saúde']), 'Plano de saúde', 'o valor exato ganha');
  assert.equal(motivoNaLista('Plano de saúde', ['Sem interesse']), 'Plano de saúde');
  assert.equal(motivoNaLista('Não deu continuidade', ['Nao deu continuidade ao atendimento']), 'Nao deu continuidade ao atendimento', 'sem acento também acha');
  for (const v of Object.values(MOTIVO_POR_ETIQUETA)) assert.equal(motivoNaLista(v, ['Não interagiu', 'Não deu continuidade', 'Clicou por engano', 'Sem interesse', 'Outra cidade', 'Plano de saúde']), v);
});

test('aplicar com a lista da conta: grava o nome da lista; se ler a lista falhar, grava o valor de sempre (o botão não deixa de funcionar)', async () => {
  const chamadas: string[] = [];
  const base = { conversa: async () => ({ labels: ['perdido-plano-de-saude'], custom_attributes: {} }), gravarAtributos: async (id: number, a: Record<string, unknown>) => { chamadas.push(`attrs ${id} ${a.motivo_nao_agendamento}`); }, gravarEtiquetas: async () => {} };
  assert.equal(await aplicarEtiqueta({ conversa: 5, slug: 's' }, { ...base, opcoesDoMotivo: async () => LISTA_DO_KOMMO }, new Set()), 'gravou');
  assert.equal(await aplicarEtiqueta({ conversa: 6, slug: 's' }, { ...base, opcoesDoMotivo: async () => { throw new Error('Chatwoot fora'); } }, new Set()), 'gravou');
  assert.deepEqual(chamadas, ['attrs 5 Plano de Saúde', 'attrs 6 Plano de saúde']);
});

test('aplicar: porta que LANÇA (síncrono ou rejeitando) ao ler a lista de motivos não impede o botão de gravar', async () => {
  const chamadas: string[] = [];
  const base = { conversa: async () => ({ labels: ['perdido-sem-interesse'], custom_attributes: {} }), gravarAtributos: async (id: number, a: Record<string, unknown>) => { chamadas.push(`attrs ${id} ${a.motivo_nao_agendamento}`); }, gravarEtiquetas: async () => {} };
  assert.equal(await aplicarEtiqueta({ conversa: 7, slug: 's' }, { ...base, opcoesDoMotivo: () => { throw new Error('síncrono'); } }, new Set()), 'gravou');
  assert.equal(await aplicarEtiqueta({ conversa: 8, slug: 's' }, { ...base, opcoesDoMotivo: async () => { throw new Error('rejeita'); } }, new Set()), 'gravou');
  assert.deepEqual(chamadas, ['attrs 7 Sem interesse', 'attrs 8 Sem interesse']);
});

test('aplicar: sem etiqueta de Perdido na conversa NÃO lê a lista de motivos (nada a gravar, nada a perguntar ao Chatwoot)', async () => {
  let leu = 0;
  const p = { conversa: async () => ({ labels: ['quente'], custom_attributes: {} }), gravarAtributos: async () => {}, gravarEtiquetas: async () => {}, opcoesDoMotivo: async () => (leu++, []) };
  assert.equal(await aplicarEtiqueta({ conversa: 9, slug: 's' }, p, new Set()), 'nada');
  assert.equal(leu, 0);
});
