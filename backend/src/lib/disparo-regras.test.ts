import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chaveDaPessoa,
  primeiroNomeSeguro,
  problemaNoModelo,
  telefoneWhatsapp,
  textoFinal,
  triar,
  valoresDasVariaveis,
  type Candidato,
  type ContextoDoPublico,
} from './disparo/regras.js';

const cand = (leadId: number, nome: string | null, tel: string | null): Candidato => ({ leadId, nome, telefoneBruto: tel });
const livre: ContextoDoPublico = { jaNaCampanha: new Set(), pediramSair: new Set(), franquia: () => 'livre' };

test('telefone: só celular com DDD vira número de WhatsApp; sem o 9 NÃO é corrigido', () => {
  assert.equal(telefoneWhatsapp('(63) 99102-1043'), '5563991021043');
  assert.equal(telefoneWhatsapp('+55 63 99102-1043'), '5563991021043');
  assert.equal(telefoneWhatsapp('5563991021043'), '5563991021043');
  assert.equal(telefoneWhatsapp('63 9102-1043'), null, '10 dígitos: faltou o 9, não adivinhar');
  assert.equal(telefoneWhatsapp('(63) 3421-1043'), null, 'fixo');
  assert.equal(telefoneWhatsapp('0991021043'), null);
  assert.equal(telefoneWhatsapp(null), null);
});

test('a chave da pessoa é DDD + 8 últimos: o mesmo número com e sem o nono dígito dá a mesma chave', () => {
  assert.equal(chaveDaPessoa('5563991021043'), '6391021043');
  // outro DDD com o mesmo final não é a mesma pessoa
  assert.notEqual(chaveDaPessoa('5511991021043'), chaveDaPessoa('5563991021043'));
});

test('nome da saudação: só a 1ª palavra, e só se for nome', () => {
  assert.equal(primeiroNomeSeguro('vânia oliveira 28/04/25 facebook'), 'Vânia');
  assert.equal(primeiroNomeSeguro("D'Ávila Santos"), "D'Ávila");
  assert.equal(primeiroNomeSeguro('Ana-Clara'), 'Ana-Clara');
  for (const ruim of ['', '   ', null, undefined, 'M', '123 Fulano', 'Paciente Novo', 'Dona José', '+5563991021043', 'Whatsapp 63']) {
    assert.equal(primeiroNomeSeguro(ruim as string), null, `"${ruim}" não serve de saudação`);
  }
});

test('triagem: cada regra tira a pessoa certa e conta o motivo', async () => {
  const candidatos = [
    cand(1, 'Maria Souza', '(63) 99102-1043'), // passa
    cand(2, 'Joana Lima', '(63) 99102-1043'), // mesmo telefone na lista
    cand(3, 'Rita Alves', null), // sem telefone
    cand(4, 'Rosa Dias', '63 3421-0000'), // fixo
    cand(5, 'Lúcia Reis', '(63) 98888-0001'), // já na campanha
    cand(6, 'Berta Cruz', '(63) 98888-0002'), // pediu SAIR
    cand(7, 'Paciente', '(63) 98888-0003'), // nome ruim
    cand(8, 'Clara Melo', '(63) 98888-0004'), // consulta futura
    cand(9, 'Dora Pires', '(63) 98888-0005'), // tratamento aberto
    cand(10, 'Elisa Nunes', '(63) 98888-0006'), // franquia fora do ar
    cand(11, 'Fátima Cunha', '(63) 98888-0007'), // passa
  ];
  const r = await triar(candidatos, {
    jaNaCampanha: new Set([chaveDaPessoa('5563988880001')]),
    pediramSair: new Set([chaveDaPessoa('5563988880002')]),
    franquia: (e) => ({ '5563988880004': 'consulta-futura', '5563988880005': 'tratamento-aberto', '5563988880006': 'indisponivel' } as const)[e.telefone as '5563988880004'] ?? 'livre',
  });
  assert.deepEqual(r.elegiveis.map((e) => e.nome), ['Maria', 'Fátima']);
  assert.deepEqual(r.fora, {
    'repetido-na-lista': 1, 'sem-telefone': 1, 'telefone-invalido': 1, 'ja-na-campanha': 1, 'pediu-sair': 1,
    'nome-invalido': 1, 'consulta-futura': 1, 'tratamento-aberto': 1, 'franquia-indisponivel': 1,
  });
});

test('franquia que não responde NUNCA vira "livre": a pessoa fica de fora', async () => {
  const r = await triar([cand(1, 'Maria Souza', '63991021043')], { ...livre, franquia: () => 'indisponivel' });
  assert.equal(r.elegiveis.length, 0);
  assert.equal(r.fora['franquia-indisponivel'], 1);
});

test('a franquia só é consultada para quem passou do resto (cada consulta custa chamadas)', async () => {
  let consultas = 0;
  await triar([cand(1, 'Maria Souza', '63991021043'), cand(2, 'Paciente', '63991021044'), cand(3, 'Rita Alves', null)], {
    ...livre,
    franquia: () => {
      consultas += 1;
      return 'livre';
    },
  });
  assert.equal(consultas, 1);
});

test('texto: variáveis na ordem, e o modelo precisa casar com o que a campanha define', () => {
  const v = valoresDasVariaveis(['primeiroNome', 'unidade', 'texto:R$ 150'], { primeiroNome: 'Maria', unidade: 'Doutor Hérnia Canaã' });
  assert.deepEqual(v, ['Maria', 'Doutor Hérnia Canaã', 'R$ 150']);
  assert.equal(textoFinal('Oi {{1}}, aqui é a {{2}}. Consulta por {{3}}.', v), 'Oi Maria, aqui é a Doutor Hérnia Canaã. Consulta por R$ 150.');
  assert.equal(problemaNoModelo('Oi {{1}}', ['primeiroNome']), null);
  assert.match(problemaNoModelo('Oi {{1}} e {{2}}', ['primeiroNome']) ?? '', /2 variável/);
  assert.match(problemaNoModelo('Oi {{2}}', ['primeiroNome']) ?? '', /sem pular/);
  assert.match(problemaNoModelo('Oi {{1}}', ['cpf']) ?? '', /desconhecida/);
  assert.match(problemaNoModelo('  ', []) ?? '', /sem texto/);
});
