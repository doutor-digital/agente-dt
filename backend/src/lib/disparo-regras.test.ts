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

test('telefone: celular com DDD vira número de WhatsApp de 13 dígitos; 13 e 11 dígitos continuam como antes', () => {
  assert.equal(telefoneWhatsapp('(63) 99102-1043'), '5563991021043');
  assert.equal(telefoneWhatsapp('+55 63 99102-1043'), '5563991021043');
  assert.equal(telefoneWhatsapp('5563991021043'), '5563991021043');
  assert.equal(telefoneWhatsapp('+55 (63) 99102-1043'), '5563991021043');
  assert.equal(telefoneWhatsapp('63 9102-1043'), null, '10 dígitos (sem 55 e sem o 9): continua recusado');
  assert.equal(telefoneWhatsapp('(63) 3421-1043'), null, 'fixo');
  assert.equal(telefoneWhatsapp('0991021043'), null);
  assert.equal(telefoneWhatsapp(null), null);
  assert.equal(telefoneWhatsapp(''), null);
  // 13 dígitos que não são celular: o 9 não está onde deveria, ou não começa com 55
  assert.equal(telefoneWhatsapp('5563891021043'), null);
  assert.equal(telefoneWhatsapp('4463991021043'), null);
});

test('telefone de 12 dígitos (55 + DDD + 8, o Kommo de contas antigas): 6, 7, 8 ou 9 na frente ganha o 9', () => {
  assert.equal(telefoneWhatsapp('556391039464'), '5563991039464', 'o número do João, como o WhatsApp o guarda');
  assert.equal(telefoneWhatsapp('+55 63 9103-9464'), '5563991039464', 'com +, espaços e hífen');
  assert.equal(telefoneWhatsapp('+55-63-9103-9464'), '5563991039464');
  assert.equal(telefoneWhatsapp('55 (63) 9103 9464'), '5563991039464');
  for (const d of ['6', '7', '8', '9']) {
    assert.equal(telefoneWhatsapp(`5563${d}1039464`), `55639${d}1039464`, `começa com ${d}: celular legado`);
  }
});

test('telefone de 12 dígitos começando com 0, 1, 2, 3, 4 ou 5 é FIXO: continua recusado (o 9 cairia no número de outra pessoa)', () => {
  for (const d of ['0', '1', '2', '3', '4', '5']) {
    assert.equal(telefoneWhatsapp(`5563${d}1039464`), null, `começa com ${d}`);
  }
  assert.equal(telefoneWhatsapp('+55 63 3421-1043'), null);
});

test('telefone de 12 dígitos: DDD inválido e tamanhos estranhos seguem recusados', () => {
  assert.equal(telefoneWhatsapp('550091039464'), null, 'DDD 00');
  assert.equal(telefoneWhatsapp('550891039464'), null, 'DDD 08');
  assert.equal(telefoneWhatsapp('551091039464'), null, 'DDD 10');
  assert.equal(telefoneWhatsapp('552091039464'), null, 'DDD 20 (não existe)');
  assert.equal(telefoneWhatsapp('446391039464'), null, '12 dígitos sem o 55 na frente');
  assert.equal(telefoneWhatsapp('55639910394640'), null, '14 dígitos');
  assert.equal(telefoneWhatsapp('5563910394'), null, '10 dígitos com 55');
  assert.equal(telefoneWhatsapp('55 63 9103'), null, 'curto demais');
});

test('a chave da pessoa é DDD + 8 últimos: o mesmo número com e sem o nono dígito dá a mesma chave', () => {
  assert.equal(chaveDaPessoa('5563991021043'), '6391021043');
  // outro DDD com o mesmo final não é a mesma pessoa
  assert.notEqual(chaveDaPessoa('5511991021043'), chaveDaPessoa('5563991021043'));
  // 12 dígitos normaliza para 13 ANTES da chave: mesma chave
  assert.equal(chaveDaPessoa(telefoneWhatsapp('556391021043') as string), chaveDaPessoa(telefoneWhatsapp('5563991021043') as string));
});

test('triagem: o mesmo número em 12 e em 13 dígitos é UMA pessoa (repetido-na-lista), e o que vai para a Meta tem 13', async () => {
  const r = await triar(
    [cand(1, 'Maria Souza', '556391021043'), cand(2, 'Joana Lima', '+55 (63) 99102-1043'), cand(3, 'Rita Alves', '63 9102-1043')],
    livre,
  );
  assert.deepEqual(r.elegiveis.map((e) => [e.nome, e.telefone, e.chave]), [['Maria', '5563991021043', '6391021043']]);
  assert.deepEqual(r.fora, { 'repetido-na-lista': 1, 'telefone-invalido': 1 });
  // e na ordem inversa também
  const r2 = await triar([cand(2, 'Joana Lima', '5563991021043'), cand(1, 'Maria Souza', '556391021043')], livre);
  assert.deepEqual(r2.elegiveis.map((e) => e.telefone), ['5563991021043']);
  assert.equal(r2.fora['repetido-na-lista'], 1);
});

test('triagem: quem está na campanha / pediu SAIR com o número de 13 dígitos é reconhecido quando o Kommo traz 12', async () => {
  const r = await triar(
    [cand(1, 'Maria Souza', '556391021043'), cand(2, 'Joana Lima', '556388880002'), cand(3, 'Rita Alves', '556388880003')],
    { ...livre, jaNaCampanha: new Set([chaveDaPessoa('5563991021043')]), pediramSair: new Set([chaveDaPessoa('5563988880002')]) },
  );
  assert.deepEqual(r.elegiveis.map((e) => [e.nome, e.telefone]), [['Rita', '5563988880003']]);
  assert.deepEqual(r.fora, { 'ja-na-campanha': 1, 'pediu-sair': 1 });
});

test('triagem: a franquia recebe o telefone de 13 dígitos mesmo quando o Kommo guarda 12', async () => {
  const vistos: string[] = [];
  await triar([cand(1, 'Maria Souza', '556391021043')], { ...livre, franquia: (e) => (vistos.push(e.telefone), 'livre') });
  assert.deepEqual(vistos, ['5563991021043']);
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
