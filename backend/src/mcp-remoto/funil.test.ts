import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chaveTelefone, compareceu, cruzarFunil, type LeadDoFunil } from './funil.js';

const lead = (id: number, telefone: string | null, extra: Partial<LeadDoFunil> = {}): LeadDoFunil => ({
  id,
  criadoEm: '2026-09-01',
  origem: 'Instagram',
  telefones: telefone ? [telefone] : [],
  idClientVinculo: null,
  ...extra,
});

test('telefone casa com e sem DDI e com e sem o 9', () => {
  assert.equal(chaveTelefone('+55 (41) 99999-8888'), chaveTelefone('4199998888'));
  assert.equal(chaveTelefone('5541999998888'), '4199998888');
  assert.equal(chaveTelefone('123'), null);
});

test('compareceu: Atendido sim, Não compareceu não', () => {
  assert.equal(compareceu({ nomePaciente: 'x', dia: 'd', status: 'Atendido' }), true);
  assert.equal(compareceu({ nomePaciente: 'x', dia: 'd', status: 'Não compareceu' }), false);
  assert.equal(compareceu({ nomePaciente: 'x', dia: 'd', status: 'qualquer', idStatus: 42 }), true);
  assert.equal(compareceu({ nomePaciente: 'x', dia: 'd', status: 'Desmarcado' }), false);
});

test('funil completo: telefone → paciente → agenda pelo nome → tratamento pelo idClient', () => {
  const f = cruzarFunil({
    leads: [lead(1, '5541999998888'), lead(2, '5541977776666'), lead(3, null), lead(4, '5511911112222', { origem: 'Site' })],
    pacientes: [
      { idClient: 10, nome: 'Ana Souza', telefone: '41999998888' },
      { idClient: 20, nome: 'Bruno Lima', telefone: '+55 41 97777-6666' },
    ],
    agenda: [
      { nomePaciente: 'ANA SOUZA', dia: '2026-09-05', status: 'Atendido' },
      { nomePaciente: 'Bruno Lima', dia: '2026-09-06', status: 'Não compareceu' },
    ],
    tratamentos: [{ idClient: 10, criado: '2026-09-05', preco: 1800 }],
  });
  assert.equal(f.leads, 4);
  assert.equal(f.viraramPaciente, 2);
  assert.equal(f.agendaram, 2);
  assert.equal(f.compareceram, 1);
  assert.equal(f.fecharamTratamento, 1);
  assert.equal(f.valorDosTratamentos, 1800);
  assert.deepEqual(f.cobertura, { comTelefoneOuVinculo: 3, semTelefoneNemVinculo: 1, semCasamento: 2 });
  assert.deepEqual(f.taxas, { pacientePorLead: 50, agendouPorLead: 50, compareceuPorAgendou: 50, tratamentoPorCompareceu: 100 });
  assert.deepEqual(f.porOrigem.Site, { leads: 1, viraramPaciente: 0, agendaram: 0, compareceram: 0, fecharamTratamento: 0 });
});

test('sem telefone, o vínculo do sincronizador casa', () => {
  const f = cruzarFunil({
    leads: [lead(1, null, { idClientVinculo: 10 })],
    pacientes: [{ idClient: 10, nome: 'Ana', telefone: null }],
    agenda: [],
    tratamentos: [],
  });
  assert.equal(f.viraramPaciente, 1);
  assert.deepEqual(f.casadoPor, { telefone: 0, vinculo: 1 });
});

test('consulta e tratamento ANTERIORES à criação do lead não contam (outro ciclo)', () => {
  const f = cruzarFunil({
    leads: [lead(1, '41999998888', { criadoEm: '2026-09-10' })],
    pacientes: [{ idClient: 10, nome: 'Ana', telefone: '41999998888' }],
    agenda: [{ nomePaciente: 'Ana', dia: '2026-08-01', status: 'Atendido' }],
    tratamentos: [{ idClient: 10, criado: '2026-08-02', preco: 900 }],
  });
  assert.equal(f.viraramPaciente, 1);
  assert.equal(f.agendaram, 0);
  assert.equal(f.fecharamTratamento, 0);
});

test('telefone repetido entre dois pacientes não casa ninguém (ambíguo)', () => {
  const f = cruzarFunil({
    leads: [lead(1, '41999998888')],
    pacientes: [
      { idClient: 10, nome: 'Ana', telefone: '41999998888' },
      { idClient: 11, nome: 'Mãe da Ana', telefone: '41999998888' },
    ],
    agenda: [],
    tratamentos: [],
  });
  assert.equal(f.viraramPaciente, 0);
  assert.equal(f.cobertura.semCasamento, 1);
});

test('dois leads da mesma pessoa contam UMA vez nas etapas da franquia', () => {
  const f = cruzarFunil({
    leads: [lead(1, '41999998888'), lead(2, '41999998888')],
    pacientes: [{ idClient: 10, nome: 'Ana', telefone: '41999998888' }],
    agenda: [{ nomePaciente: 'Ana', dia: '2026-09-05', status: 'Atendido' }],
    tratamentos: [],
  });
  assert.equal(f.leads, 2);
  assert.equal(f.compareceram, 1);
});

test('dois leads da mesma pessoa: vale o MAIS ANTIGO (origem e início da contagem), mesmo vindo fora de ordem', () => {
  const f = cruzarFunil({
    // o Kommo devolve o mais novo primeiro
    leads: [lead(2, '41999998888', { criadoEm: '2026-09-20', origem: 'Indicação' }), lead(1, '41999998888', { criadoEm: '2026-09-02', origem: 'Meta' })],
    pacientes: [{ idClient: 10, nome: 'Ana', telefone: '41999998888' }],
    agenda: [{ nomePaciente: 'Ana', dia: '2026-09-05', status: 'Atendido' }],
    tratamentos: [],
  });
  assert.equal(f.compareceram, 1); // a consulta de 05/09 conta, a partir do lead de 02/09
  assert.equal(f.porOrigem.Meta?.compareceram, 1);
  assert.equal(f.porOrigem['Indicação']?.compareceram, 0);
  assert.equal(f.pacientesComMaisDeUmLead, 1);
});

test('homônimos: dois pacientes com o mesmo nome não herdam a agenda um do outro', () => {
  const f = cruzarFunil({
    leads: [lead(1, '41999998888')],
    pacientes: [
      { idClient: 10, nome: 'Maria da Silva', telefone: '41999998888' },
      { idClient: 11, nome: 'MARIA DA SILVA', telefone: '41911112222' },
    ],
    agenda: [{ nomePaciente: 'Maria da Silva', dia: '2026-09-05', status: 'Atendido' }],
    tratamentos: [{ idClient: 10, criado: '2026-09-06', preco: 500 }],
  });
  assert.equal(f.viraramPaciente, 1);
  assert.equal(f.compareceram, 0); // não dá pra saber de qual Maria é a consulta
  assert.equal(f.fecharamTratamento, 1); // tratamento é pelo idClient: esse dá
  assert.equal(f.homonimosSemAgenda, 1);
});

test('lead com dois números (contato fixo + WhatsApp da conversa) casa por qualquer um', () => {
  const f = cruzarFunil({
    leads: [lead(1, null, { telefones: ['4133334444', '41999998888'] })],
    pacientes: [{ idClient: 10, nome: 'Ana', telefone: '41999998888' }],
    agenda: [],
    tratamentos: [],
  });
  assert.equal(f.viraramPaciente, 1);
});

test('mesmo nome com o MESMO telefone é cadastro duplicado, não homônimo: a agenda conta', () => {
  const f = cruzarFunil({
    leads: [lead(1, '41999998888')],
    pacientes: [
      { idClient: 10, nome: 'Ana Souza', telefone: '41999998888' },
      { idClient: 11, nome: 'ANA SOUZA', telefone: '+55 41 99999-8888' },
    ],
    agenda: [{ nomePaciente: 'Ana Souza', dia: '2026-09-05', status: 'Atendido' }],
    tratamentos: [{ idClient: 11, criado: '2026-09-06', preco: 700 }], // no OUTRO cadastro dela
  });
  assert.equal(f.viraramPaciente, 1);
  assert.equal(f.compareceram, 1);
  assert.equal(f.fecharamTratamento, 1);
  assert.equal(f.homonimosSemAgenda, 0);
});

test('homônimo antigo (fora da lista de pacientes) é pego pela agenda anterior ao cadastro', () => {
  const f = cruzarFunil({
    leads: [lead(1, '41999998888', { criadoEm: '2026-09-01' })],
    pacientes: [{ idClient: 10, nome: 'Maria da Silva', telefone: '41999998888', criadoEm: '2026-09-02' }],
    agenda: [
      { nomePaciente: 'Maria da Silva', dia: '2026-03-10', status: 'Atendido' }, // outra Maria, de março
      { nomePaciente: 'Maria da Silva', dia: '2026-09-05', status: 'Atendido' },
    ],
    tratamentos: [],
  });
  assert.equal(f.compareceram, 0);
  assert.equal(f.homonimosSemAgenda, 1);
});
